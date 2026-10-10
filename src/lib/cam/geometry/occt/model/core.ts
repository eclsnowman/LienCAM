// Pure model-worker core: STEP read + heal, stable subshape indexing, tessellation.
// Every function takes the loaded oc module so Node tests can call them without a
// Worker (see src/tests/brep/model-core.test.ts). Binding quirks are documented in
// ./vendor/README.md -- notably: no C++ default args (Message_ProgressRange is
// mandatory), TopTools_IndexedMapOfShape is unusable (use TopExp_Explorer + IsSame
// dedup), and Poly_PolygonOnTriangulation is NOT bound (edge polylines come from
// BRepAdaptor_Curve + GCPnts_TangentialDeflection instead).
import type { OcctModelModule } from './loader'
import type {
  TopoDS_Shape,
  TopoDS_Face,
  TopoDS_Edge,
  TopAbs_ShapeEnum,
} from './vendor/occt-model.js'
import type { BrepModelPayload } from './types'

/** Typed error per ADR 0003: `where` names the failing stage. */
export class ModelCoreError extends Error {
  where: string

  constructor(where: string, message: string) {
    super(message)
    this.name = 'ModelCoreError'
    this.where = where
  }
}

export type ModelPhase = 'read' | 'heal' | 'mesh'

export interface TessellateOptions {
  /** BRepMesh linear deflection, mm. Default 0.1. */
  linearDeflection?: number
  /** BRepMesh angular deflection, radians. Default 0.5. */
  angularDeflection?: number
}

export interface TessellationResult {
  mesh: BrepModelPayload['mesh']
  edges: BrepModelPayload['edges']
  bbox: BrepModelPayload['bbox']
  faceTypes: BrepModelPayload['faceTypes']
}

/** Embind enums are singleton objects; the numeric lives at `.value`. */
function enumNumeric(e: unknown): number {
  return (e as { value: number }).value
}

let memfsCounter = 0

/**
 * Unique subshapes of a type in TopExp_Explorer DFS first-encounter order with
 * IsSame dedup -- the SAME order TopExp::MapShapes uses internally. This order IS
 * the ADR 0018 D3 stable subshape identity contract (smoke test GATE B proves
 * determinism across reads). Caller owns the returned wrappers (.delete()).
 */
function uniqueSubshapes(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
  type: TopAbs_ShapeEnum,
): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = []
  // d.ts quirk: enum members are typed {} while parameters want the enum alias.
  const ex = new oc.TopExp_Explorer_2(
    shape,
    type,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum,
  )
  for (; ex.More(); ex.Next()) {
    const s = ex.Current()
    if (out.some((u) => u.IsSame(s))) s.delete()
    else out.push(s)
  }
  ex.delete()
  return out
}

function freeAll(list: { delete(): void }[]): void {
  for (const s of list) s.delete()
}

/**
 * Write STEP bytes into MEMFS, read + transfer (STEPControl_Reader), heal
 * (ShapeFix_Shape). Returns the HEALED shape (caller owns it) plus its solid count.
 * Throws ModelCoreError with `.where` on every failure path.
 */
export function readStepShape(
  oc: OcctModelModule,
  bytes: ArrayBuffer | Uint8Array,
  fileName: string,
  onPhase?: (phase: ModelPhase) => void,
): { shape: TopoDS_Shape; solidCount: number } {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  // Unique MEMFS path per call; STEP input has no read-from-ArrayBuffer binding.
  const memPath = `/model-import-${memfsCounter++}.step`

  onPhase?.('read')
  oc.FS.writeFile(memPath, data)
  const reader = new oc.STEPControl_Reader_1()
  let raw: TopoDS_Shape
  try {
    const status = reader.ReadFile(memPath)
    if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      throw new ModelCoreError(
        'step-read',
        `STEP read failed for "${fileName}": IFSelect status is not RetDone`,
      )
    }
    // ocjs has no C++ default args: Message_ProgressRange must be constructed.
    const progress = new oc.Message_ProgressRange_1()
    const nRoots = reader.TransferRoots(progress)
    progress.delete()
    if (nRoots < 1) {
      throw new ModelCoreError(
        'step-transfer',
        `STEP transfer produced zero roots for "${fileName}"`,
      )
    }
    raw = reader.OneShape()
  } finally {
    reader.delete()
    try {
      oc.FS.unlink(memPath)
    } catch {
      // MEMFS cleanup is best-effort; never mask the real error.
    }
  }

  let healed: TopoDS_Shape
  try {
    if (raw.IsNull()) {
      throw new ModelCoreError('step-shape', `STEP produced a null shape for "${fileName}"`)
    }
    onPhase?.('heal')
    const fixer = new oc.ShapeFix_Shape_2(raw)
    const progress = new oc.Message_ProgressRange_1()
    try {
      fixer.Perform(progress)
      healed = fixer.Shape()
    } finally {
      progress.delete()
      fixer.delete()
    }
  } finally {
    raw.delete()
  }

  if (healed.IsNull()) {
    healed.delete()
    throw new ModelCoreError('heal', `ShapeFix produced a null shape for "${fileName}"`)
  }

  const solids = uniqueSubshapes(
    oc,
    healed,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID as TopAbs_ShapeEnum,
  )
  const solidCount = solids.length
  freeAll(solids)

  return { shape: healed, solidCount }
}

/**
 * Stable subshape index (ADR 0018 D3): faces and edges in TopExp_Explorer DFS
 * first-encounter order with IsSame dedup. Array index == subshape id. The
 * caller owns every returned wrapper (.delete()).
 */
export function indexSubshapes(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
): { faces: TopoDS_Face[]; edges: TopoDS_Edge[] } {
  const faces: TopoDS_Face[] = []
  for (const s of uniqueSubshapes(
    oc,
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum,
  )) {
    faces.push(oc.TopoDS.Face_1(s)) // downcast copy keeps orientation + location
    s.delete()
  }
  const edges: TopoDS_Edge[] = []
  for (const s of uniqueSubshapes(
    oc,
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum,
  )) {
    edges.push(oc.TopoDS.Edge_1(s))
    s.delete()
  }
  return { faces, edges }
}

/**
 * Mesh the whole shape once (BRepMesh_IncrementalMesh), then build merged JS-heap
 * buffers: per-face triangle ranges (positions/normals/indices + faceRanges),
 * per-edge polylines (GCPnts_TangentialDeflection -- Poly_PolygonOnTriangulation
 * is not bound in this build), bbox (BRepBndLib) and per-face surface types
 * (BRepAdaptor_Surface). Face/edge array order defines the payload index (D3).
 */
export function tessellate(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
  faces: TopoDS_Face[],
  edges: TopoDS_Edge[],
  opts: TessellateOptions = {},
): TessellationResult {
  const linearDeflection = opts.linearDeflection ?? 0.1
  const angularDeflection = opts.angularDeflection ?? 0.5

  // --- mesh the whole shape once (meshing happens in the constructor) ---
  const mesher = new oc.BRepMesh_IncrementalMesh_2(
    shape,
    linearDeflection,
    false,
    angularDeflection,
    false,
  )
  const meshDone = mesher.IsDone()
  mesher.delete()
  if (!meshDone) {
    throw new ModelCoreError('mesh', 'BRepMesh_IncrementalMesh reported not done')
  }

  // --- per-face triangulation -> merged buffers ---
  const positions: number[] = []
  const indices: number[] = []
  const faceRanges = new Uint32Array(faces.length * 2)
  const faceTypes = new Uint8Array(faces.length)

  for (let i = 0; i < faces.length; i++) {
    const face = faces[i]
    const firstIndexOffset = indices.length

    // Surface classification (D5 groundwork).
    const surf = new oc.BRepAdaptor_Surface_2(face, true)
    faceTypes[i] = enumNumeric(surf.GetType())
    surf.delete()

    const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED
    const loc = new oc.TopLoc_Location_1()
    // Poly_MeshPurpose enum is not bound; undefined marshals to 0 (NONE) and
    // returns the active triangulation (vendor/README.md gotcha 3).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = oc.BRep_Tool.Triangulation(face, loc, undefined as any)
    try {
      if (handle.IsNull()) {
        throw new ModelCoreError('mesh', `face ${i} has no triangulation after meshing`)
      }
      const tri = handle.get()
      const nbNodes = tri.NbNodes()
      const nbTriangles = tri.NbTriangles()
      const vertexBase = positions.length / 3

      // Nodes are stored in face-local coordinates; apply the TopLoc transform.
      const identity = loc.IsIdentity()
      const trsf = identity ? null : loc.Transformation()
      for (let n = 1; n <= nbNodes; n++) {
        const p = tri.Node(n) // returned gp_Pnt is a copy we own
        if (trsf) p.Transform(trsf)
        positions.push(p.X(), p.Y(), p.Z())
        p.delete()
      }
      trsf?.delete()

      for (let t = 1; t <= nbTriangles; t++) {
        const pt = tri.Triangle(t)
        const n1 = vertexBase + pt.Value(1) - 1
        const n2 = vertexBase + pt.Value(2) - 1
        const n3 = vertexBase + pt.Value(3) - 1
        pt.delete()
        // REVERSED face: flip winding so the cross-product normal points outward.
        if (reversed) indices.push(n1, n3, n2)
        else indices.push(n1, n2, n3)
      }
    } finally {
      handle.delete()
      loc.delete()
    }

    faceRanges[2 * i] = firstIndexOffset
    faceRanges[2 * i + 1] = indices.length - firstIndexOffset
  }

  // Per-vertex normals from corrected-winding triangles. Vertices are per-face
  // blocks (never shared across faces), so accumulation smooths within a face
  // and stays sharp across face borders.
  //
  // ANGLE-WEIGHTED accumulation (Thurmer-Wuthrich): each triangle contributes
  // its UNIT geometric normal to each of its three corners, scaled by the
  // interior angle at that corner. This removes the tessellation-density bias
  // of raw cross-product (area+sin) weighting that produced concentric ring
  // banding on curved surfaces (dome/sphere).
  const normals = new Float32Array(positions.length)
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3
    const b = indices[t + 1] * 3
    const c = indices[t + 2] * 3
    // Unit geometric normal of this triangle (CCW corrected winding above).
    const ux = positions[b] - positions[a]
    const uy = positions[b + 1] - positions[a + 1]
    const uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a]
    const vy = positions[c + 1] - positions[a + 1]
    const vz = positions[c + 2] - positions[a + 2]
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const nlen = Math.hypot(nx, ny, nz)
    if (nlen <= 1e-12) continue // degenerate triangle: contributes nothing
    nx /= nlen
    ny /= nlen
    nz /= nlen
    // Interior angle at each corner; weight = unit normal * corner angle.
    // Corner order matches the three vertices (a, b, c).
    const corners = [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ]
    for (const [p, q, r] of corners) {
      // edges p->q and p->r
      let e1x = positions[q] - positions[p]
      let e1y = positions[q + 1] - positions[p + 1]
      let e1z = positions[q + 2] - positions[p + 2]
      let e2x = positions[r] - positions[p]
      let e2y = positions[r + 1] - positions[p + 1]
      let e2z = positions[r + 2] - positions[p + 2]
      const l1 = Math.hypot(e1x, e1y, e1z)
      const l2 = Math.hypot(e2x, e2y, e2z)
      if (l1 <= 1e-12 || l2 <= 1e-12) continue // zero-length edge: weight 0
      e1x /= l1
      e1y /= l1
      e1z /= l1
      e2x /= l2
      e2y /= l2
      e2z /= l2
      let dot = e1x * e2x + e1y * e2y + e1z * e2z
      if (dot < -1) dot = -1
      else if (dot > 1) dot = 1
      const angle = Math.acos(dot)
      normals[p] += nx * angle
      normals[p + 1] += ny * angle
      normals[p + 2] += nz * angle
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const len = Math.hypot(normals[v], normals[v + 1], normals[v + 2])
    if (len > 1e-12) {
      normals[v] /= len
      normals[v + 1] /= len
      normals[v + 2] /= len
    } else {
      normals[v + 2] = 1 // degenerate fallback
    }
  }

  // --- per-edge polylines ---
  const edgePositions: number[] = []
  const edgeRanges = new Uint32Array(edges.length * 2)
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]
    const firstPointOffset = edgePositions.length / 3
    if (oc.BRep_Tool.Degenerated(edge)) {
      // Degenerate edge (e.g. a sphere pole) has no 3D curve: emit its vertex
      // twice so the range stays well-formed and draws nothing visible.
      const v = oc.TopExp.FirstVertex(edge, true)
      const p = oc.BRep_Tool.Pnt(v)
      edgePositions.push(p.X(), p.Y(), p.Z(), p.X(), p.Y(), p.Z())
      p.delete()
      v.delete()
    } else {
      const curve = new oc.BRepAdaptor_Curve_2(edge) // applies the edge location
      const sampler = new oc.GCPnts_TangentialDeflection_2(
        curve,
        angularDeflection,
        linearDeflection,
        2, // minimum number of points
        1e-9, // parameter tolerance
        1e-7, // minimum length
      )
      const nb = sampler.NbPoints()
      if (nb < 2) {
        sampler.delete()
        curve.delete()
        throw new ModelCoreError('mesh', `edge ${i} sampled fewer than 2 polyline points`)
      }
      for (let n = 1; n <= nb; n++) {
        const p = sampler.Value(n)
        edgePositions.push(p.X(), p.Y(), p.Z())
        p.delete()
      }
      sampler.delete()
      curve.delete()
    }
    edgeRanges[2 * i] = firstPointOffset
    edgeRanges[2 * i + 1] = edgePositions.length / 3 - firstPointOffset
  }

  // --- bbox (exact, not triangulation-based; gap zeroed for tight bounds) ---
  const box = new oc.Bnd_Box_1()
  oc.BRepBndLib.AddOptimal(shape, box, false, false)
  box.SetGap(0)
  const cmin = box.CornerMin()
  const cmax = box.CornerMax()
  const bbox: TessellationResult['bbox'] = {
    min: [cmin.X(), cmin.Y(), cmin.Z()],
    max: [cmax.X(), cmax.Y(), cmax.Z()],
  }
  cmin.delete()
  cmax.delete()
  box.delete()

  // All buffers below are fresh JS-heap typed arrays (never views into the wasm
  // heap), so they are safe to transfer out of the worker.
  return {
    mesh: {
      positions: new Float32Array(positions),
      normals,
      indices: new Uint32Array(indices),
      faceRanges,
    },
    edges: {
      positions: new Float32Array(edgePositions),
      edgeRanges,
    },
    bbox,
    faceTypes,
  }
}

/**
 * Full import pipeline: read + heal -> stable index -> tessellate -> payload.
 * Returns the payload AND the healed shape: the worker keeps the shape in its
 * in-heap registry (ADR 0018 D2); pure tests should .delete() it.
 */
export function buildModelPayload(
  oc: OcctModelModule,
  bytes: ArrayBuffer | Uint8Array,
  fileName: string,
  opts: TessellateOptions = {},
  onPhase?: (phase: ModelPhase) => void,
): { payload: BrepModelPayload; shape: TopoDS_Shape } {
  const { shape, solidCount } = readStepShape(oc, bytes, fileName, onPhase)
  try {
    const { faces, edges } = indexSubshapes(oc, shape)
    let result: TessellationResult
    try {
      onPhase?.('mesh')
      result = tessellate(oc, shape, faces, edges, opts)
    } finally {
      freeAll(faces)
      freeAll(edges)
    }
    const payload: BrepModelPayload = {
      faceCount: result.faceTypes.length,
      edgeCount: result.edges.edgeRanges.length / 2,
      solidCount,
      bbox: result.bbox,
      mesh: result.mesh,
      edges: result.edges,
      faceTypes: result.faceTypes,
    }
    return { payload, shape }
  } catch (err) {
    shape.delete()
    throw err
  }
}
