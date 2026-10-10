// Stage 3 derivation layer (ADR 0018 D4/D5): convert picked B-rep entities into
// the exact inputs the existing 2D operations consume -- Loop2D-shaped loops in
// world XY plus a machining-plane Z. Pure worker-side geometry: every function
// takes the loaded oc module + a resident TopoDS_Shape, so Node tests can call
// them directly (src/tests/brep/derive.test.ts).
//
// Conventions (matched to the house importers, see path2d.ts joinSegments and
// stlProjection.ts): closed contour = CCW / signed area > 0, closed hole = CW /
// signed area < 0, open chain = type 'open'; Loop2D.area = |signed area|;
// closed loops do NOT repeat the first point at the end.
//
// Rejections are typed ModelCoreErrors (ADR 0003) whose message names WHY
// (surface type, normal direction, z spread) so the UI can show them.
//
// Binding quirks honored here are documented in ./vendor/README.md -- notably:
// no C++ default args (Message_ProgressRange is mandatory), BRepTools_WireExplorer
// is NOT bound (wires are re-chained by endpoint matching), and degenerate edges
// have no 3D curve (BRep_Tool.Degenerated check before BRepAdaptor_Curve).
import type { OcctModelModule } from './loader'
import type {
  TopoDS_Shape,
  TopoDS_Edge,
  TopoDS_Face,
  TopAbs_ShapeEnum,
} from './vendor/occt-model.js'
import { indexSubshapes, ModelCoreError } from './core'
import type {
  DerivedLoop,
  DerivedLoopsResult,
  HoleFeature,
  CylinderFeature,
  PrismaticRoughTargetFacts,
} from './types'

// Sampling deflections for derived loops: 0.02 mm curvature deflection matches
// the importer/projection simplification scale (projectionTolerance default).
const LIN_DEFLECTION = 0.02
const ANG_DEFLECTION = 0.2 // rad

/** Endpoint-matching tolerance when re-chaining the edges of a B-rep wire (exact vertices). */
const WIRE_CHAIN_TOL = 1e-6
/** Endpoint-matching tolerance for section edges (computed intersections). */
const SECTION_CHAIN_TOL = 1e-4
/** Max Z spread for an edge set to count as a Z=const machining plane. */
const COPLANAR_TOL = 1e-4
/** |dir.Z()| must be within this of 1 for an axis/normal to count as Z-parallel. */
const Z_PARALLEL_TOL = 1e-6
/** bottomZ within this of the solid bbox bottom => hole counts as through. */
const THROUGH_TOL = 1e-3
/** Face/level tolerance for the Smart Height prismatic classifier. */
const PRISMATIC_TOL = 1e-5

type P3 = [number, number, number]

/**
 * An orthonormal cutting-plane frame in MODEL coordinates. {origin, xAxis, yAxis}
 * span the plane; `normal` is its outward direction (== xAxis cross yAxis for a
 * right-handed frame). Section loops are flattened into this frame's (u,v) so the
 * resulting 2D loops are correct for an ARBITRARY plane, not just a horizontal one.
 */
export interface SectionPlane {
  origin: [number, number, number]
  xAxis: [number, number, number]
  yAxis: [number, number, number]
  normal: [number, number, number]
}

/**
 * Project a 3D model point P onto a plane frame, returning its in-plane (u,v):
 * u = (P - O) . xAxis, v = (P - O) . yAxis. Pure (no OCCT); unit-tested. Item 2's
 * viewport unflatten mirrors this exactly via O + xAxis*u + yAxis*v (see unflattenUV).
 */
export function flattenToPlaneUV(
  p: P3,
  origin: P3,
  xAxis: P3,
  yAxis: P3,
): [number, number] {
  const dx = p[0] - origin[0]
  const dy = p[1] - origin[1]
  const dz = p[2] - origin[2]
  const u = dx * xAxis[0] + dy * xAxis[1] + dz * xAxis[2]
  const v = dx * yAxis[0] + dy * yAxis[1] + dz * yAxis[2]
  return [u, v]
}

/** Inverse of flattenToPlaneUV for an orthonormal frame: P = O + xAxis*u + yAxis*v. */
export function unflattenUV(
  u: number,
  v: number,
  origin: P3,
  xAxis: P3,
  yAxis: P3,
): P3 {
  return [
    origin[0] + xAxis[0] * u + yAxis[0] * v,
    origin[1] + xAxis[1] * u + yAxis[1] * v,
    origin[2] + xAxis[2] * u + yAxis[2] * v,
  ]
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Human-readable GeomAbs_SurfaceType name for rejection messages. */
function surfaceTypeName(oc: OcctModelModule, t: unknown): string {
  const e = oc.GeomAbs_SurfaceType
  const names: [unknown, string][] = [
    [e.GeomAbs_Plane, 'Plane'],
    [e.GeomAbs_Cylinder, 'Cylinder'],
    [e.GeomAbs_Cone, 'Cone'],
    [e.GeomAbs_Sphere, 'Sphere'],
    [e.GeomAbs_Torus, 'Torus'],
    [e.GeomAbs_BezierSurface, 'BezierSurface'],
    [e.GeomAbs_BSplineSurface, 'BSplineSurface'],
    [e.GeomAbs_SurfaceOfRevolution, 'SurfaceOfRevolution'],
    [e.GeomAbs_SurfaceOfExtrusion, 'SurfaceOfExtrusion'],
    [e.GeomAbs_OffsetSurface, 'OffsetSurface'],
  ]
  for (const [member, name] of names) if (t === member) return name
  return 'OtherSurface'
}

function dist3(a: P3, b: P3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Shoelace signed area over [x, y] of 3D points. Positive = CCW. */
function signedArea(pts: P3[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return a / 2
}

/**
 * Sample one edge into a world-space polyline (BRepAdaptor_Curve applies the edge
 * location). Returns null for degenerate edges (no 3D curve; vendor README 12).
 */
function sampleEdge(oc: OcctModelModule, edge: TopoDS_Edge): P3[] | null {
  if (oc.BRep_Tool.Degenerated(edge)) return null
  const curve = new oc.BRepAdaptor_Curve_2(edge)
  // Ctor arg order: ANGULAR deflection FIRST (vendor README gotcha 11).
  const sampler = new oc.GCPnts_TangentialDeflection_2(
    curve,
    ANG_DEFLECTION,
    LIN_DEFLECTION,
    2, // minimum number of points
    1e-9, // parameter tolerance
    1e-7, // minimum length
  )
  const out: P3[] = []
  const nb = sampler.NbPoints()
  for (let n = 1; n <= nb; n++) {
    const p = sampler.Value(n)
    out.push([p.X(), p.Y(), p.Z()])
    p.delete()
  }
  sampler.delete()
  curve.delete()
  return out.length >= 2 ? out : null
}

interface Chain {
  points: P3[]
  closed: boolean
}

/**
 * Chain polylines into longer chains by greedy endpoint matching (within tol),
 * reversing pieces as needed -- the BRepTools_WireExplorer replacement (the class
 * is not bound in this build). A chain whose two ends meet becomes closed and
 * drops the duplicate last point (house Loop2D convention).
 */
function chainPolylines(polys: P3[][], tol: number): Chain[] {
  const used = new Array<boolean>(polys.length).fill(false)
  const chains: Chain[] = []
  const last = (c: P3[]) => c[c.length - 1]

  for (let seed = 0; seed < polys.length; seed++) {
    if (used[seed]) continue
    used[seed] = true
    let chain = [...polys[seed]]

    let extended = true
    while (extended) {
      extended = false
      for (let i = 0; i < polys.length; i++) {
        if (used[i]) continue
        const p = polys[i]
        if (dist3(last(chain), p[0]) <= tol) {
          chain = [...chain, ...p.slice(1)]
        } else if (dist3(last(chain), last(p)) <= tol) {
          chain = [...chain, ...[...p].reverse().slice(1)]
        } else if (dist3(p[p.length - 1], chain[0]) <= tol) {
          chain = [...p.slice(0, -1), ...chain]
        } else if (dist3(p[0], chain[0]) <= tol) {
          chain = [...[...p].reverse().slice(0, -1), ...chain]
        } else {
          continue
        }
        used[i] = true
        extended = true
        break
      }
    }

    const closed = chain.length > 3 && dist3(chain[0], last(chain)) <= tol
    if (closed) chain.pop()
    chains.push({ points: chain, closed })
  }
  return chains
}

/** Convert a chain to a DerivedLoop, enforcing the house winding for its type. */
function chainToLoop(chain: Chain, type: DerivedLoop['type']): DerivedLoop {
  let pts = chain.points
  let area = 0
  if (chain.closed) {
    const signed = signedArea(pts)
    area = Math.abs(signed)
    const wantCCW = type === 'contour'
    if ((signed > 0) !== wantCCW) pts = [...pts].reverse()
  }
  return {
    points: pts.map((p) => ({ x: p[0], y: p[1] })),
    closed: chain.closed,
    type: chain.closed ? type : 'open',
    area,
  }
}

function freeAll(list: { delete(): void }[]): void {
  for (const s of list) s.delete()
}

/** Unique subshapes of a type under a root (TopExp_Explorer + IsSame dedup). */
function uniqueSubshapes(
  oc: OcctModelModule,
  root: TopoDS_Shape,
  type: TopAbs_ShapeEnum,
): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = []
  const ex = new oc.TopExp_Explorer_2(
    root,
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

/** Tight world bbox of any shape (AddOptimal + SetGap(0), vendor README 14). */
function shapeBBox(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
): { min: P3; max: P3 } {
  const box = new oc.Bnd_Box_1()
  oc.BRepBndLib.AddOptimal(shape, box, false, false)
  box.SetGap(0)
  const cmin = box.CornerMin()
  const cmax = box.CornerMax()
  const out = {
    min: [cmin.X(), cmin.Y(), cmin.Z()] as P3,
    max: [cmax.X(), cmax.Y(), cmax.Z()] as P3,
  }
  cmin.delete()
  cmax.delete()
  box.delete()
  return out
}

// ---------------------------------------------------------------------------
// 1. planarFaceLoops
// ---------------------------------------------------------------------------

/**
 * Boundary loops of a planar, Z-normal face: outer wire -> closed 'contour'
 * loop (CCW), every other wire -> 'hole' loop (CW), plus the plane Z.
 *
 * Typed rejections (ADR 0003): non-planar surface (names the GeomAbs type),
 * plane normal not parallel to +/-Z (v1 machining plane is world XY only).
 */
export function planarFaceLoops(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
  faceIndex: number,
): DerivedLoopsResult {
  const { faces, edges } = indexSubshapes(oc, shape)
  try {
    if (faceIndex < 0 || faceIndex >= faces.length) {
      throw new ModelCoreError(
        'derive-face-loops',
        `face index ${faceIndex} out of range (shape has ${faces.length} faces)`,
      )
    }
    const face = faces[faceIndex]

    const surf = new oc.BRepAdaptor_Surface_2(face, true)
    let z: number
    try {
      const t = surf.GetType()
      if (t !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        throw new ModelCoreError(
          'derive-face-loops',
          `face ${faceIndex} is a ${surfaceTypeName(oc, t)} surface, not a Plane; ` +
            `only planar faces can drive 2D operations (ADR 0018 D5)`,
        )
      }
      const pln = surf.Plane()
      const ax = pln.Axis()
      const dir = ax.Direction()
      const loc = pln.Location()
      const nz = dir.Z()
      const planeZ = loc.Z()
      loc.delete()
      dir.delete()
      ax.delete()
      pln.delete()
      if (Math.abs(Math.abs(nz) - 1) > Z_PARALLEL_TOL) {
        throw new ModelCoreError(
          'derive-face-loops',
          `face ${faceIndex} is planar but its normal (z component ${nz.toFixed(6)}) ` +
            `is not parallel to +/-Z; v1 derives loops only on world-XY machining planes`,
        )
      }
      z = planeZ
    } finally {
      surf.delete()
    }

    const outer = oc.BRepTools.OuterWire(face)
    const wires = uniqueSubshapes(
      oc,
      face,
      oc.TopAbs_ShapeEnum.TopAbs_WIRE as TopAbs_ShapeEnum,
    )
    const loops: DerivedLoop[] = []
    try {
      for (const wire of wires) {
        const isOuter = outer.IsSame(wire)
        const loop = wireToLoop(oc, wire, faceIndex, isOuter ? 'contour' : 'hole')
        if (isOuter) loops.unshift(loop)
        else loops.push(loop)
      }
    } finally {
      freeAll(wires)
      outer.delete()
    }

    return { loops, z }
  } finally {
    freeAll(faces)
    freeAll(edges)
  }
}

/** Chain one wire's edges into exactly one closed loop (fail-loud otherwise). */
function wireToLoop(
  oc: OcctModelModule,
  wire: TopoDS_Shape,
  faceIndex: number,
  type: 'contour' | 'hole',
): DerivedLoop {
  const wireEdges = uniqueSubshapes(
    oc,
    wire,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum,
  )
  try {
    const polys: P3[][] = []
    for (const e of wireEdges) {
      const edge = oc.TopoDS.Edge_1(e)
      const poly = sampleEdge(oc, edge)
      edge.delete()
      if (poly) polys.push(poly)
    }
    const chains = chainPolylines(polys, WIRE_CHAIN_TOL)
    if (chains.length !== 1 || !chains[0].closed) {
      throw new ModelCoreError(
        'derive-face-loops',
        `face ${faceIndex}: a boundary wire chained into ${chains.length} chain(s) ` +
          `(closed: ${chains.map((c) => c.closed).join(',')}) instead of one closed loop`,
      )
    }
    return chainToLoop(chains[0], type)
  } finally {
    freeAll(wireEdges)
  }
}

// ---------------------------------------------------------------------------
// 2. edgeChainLoops
// ---------------------------------------------------------------------------

/**
 * Chain picked edges (stable edge indices, ADR 0018 D3) into loops, grouped by
 * the Z=const plane each chained loop lives at. A pick that spans several Z
 * planes (e.g. boss top rims at different heights) yields ONE result PER plane,
 * each carrying that plane's loops + its own Z -- the store lands one derived
 * layer per group so each contour cuts to its own height.
 *
 * Coplanarity is validated PER chained loop, not globally: each loop's own
 * sampled-point z spread must be <= COPLANAR_TOL, else a typed rejection naming
 * the z spread (a single TILTED loop still fails loud, scoped to that loop --
 * ADR 0003). Loops within COPLANAR_TOL of each other in Z are grouped together;
 * each group's Z is the mean of all its sampled points (so the common
 * single-plane pick returns one group whose z == the old global (zMin+zMax)/2).
 * Chains whose ends meet become closed CCW 'contour' loops; the rest stay open
 * (type 'open', house convention).
 */
export function edgeChainLoops(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
  edgeIndices: number[],
): DerivedLoopsResult[] {
  if (edgeIndices.length === 0) {
    throw new ModelCoreError('derive-edge-loops', 'no edges selected')
  }
  const { faces, edges } = indexSubshapes(oc, shape)
  try {
    const polys: P3[][] = []
    for (const idx of edgeIndices) {
      if (idx < 0 || idx >= edges.length) {
        throw new ModelCoreError(
          'derive-edge-loops',
          `edge index ${idx} out of range (shape has ${edges.length} edges)`,
        )
      }
      const poly = sampleEdge(oc, edges[idx])
      if (!poly) {
        throw new ModelCoreError(
          'derive-edge-loops',
          `edge ${idx} is degenerate (no 3D curve) and cannot drive a 2D loop`,
        )
      }
      polys.push(poly)
    }

    // Chain FIRST, then validate + group by Z per chained loop. Each chain's own
    // points carry the Z to test (chainPolylines drops the duplicate closing
    // point but keeps every sampled vertex, so the spread is exact).
    const chains = chainPolylines(polys, WIRE_CHAIN_TOL)

    // Accumulate per Z-plane group: zMin/zMax span all the group's points so the
    // group z (mean) equals the legacy global mean when there is one group.
    interface ZGroup { zMin: number; zMax: number; loops: DerivedLoop[] }
    const groups: ZGroup[] = []
    for (const c of chains) {
      let zMin = Infinity
      let zMax = -Infinity
      for (const p of c.points) {
        if (p[2] < zMin) zMin = p[2]
        if (p[2] > zMax) zMax = p[2]
      }
      const spread = zMax - zMin
      if (spread > COPLANAR_TOL) {
        throw new ModelCoreError(
          'derive-edge-loops',
          `a chained loop is not coplanar in a Z=const plane: z spans ` +
            `${zMin.toFixed(4)}..${zMax.toFixed(4)} mm (spread ${spread.toFixed(4)} > ${COPLANAR_TOL})`,
        )
      }
      const loopZ = (zMin + zMax) / 2
      const g = groups.find((gr) => Math.abs((gr.zMin + gr.zMax) / 2 - loopZ) <= COPLANAR_TOL)
      if (g) {
        if (zMin < g.zMin) g.zMin = zMin
        if (zMax > g.zMax) g.zMax = zMax
        g.loops.push(chainToLoop(c, 'contour'))
      } else {
        groups.push({ zMin, zMax, loops: [chainToLoop(c, 'contour')] })
      }
    }
    return groups.map((g) => ({ loops: g.loops, z: (g.zMin + g.zMax) / 2 }))
  } finally {
    freeAll(faces)
    freeAll(edges)
  }
}

// ---------------------------------------------------------------------------
// 3. holeFeatures
// ---------------------------------------------------------------------------

/**
 * Scan faces for Z-axis cylindrical HOLES. Coaxial cylinder faces (seam-split
 * walls share axis + radius) are grouped into one hole.
 *
 * Boss-vs-hole test: the oriented surface normal of a hole wall points TOWARD
 * the axis. We evaluate D1 at mid-(u,v), take n = D1U x D1V (flipped when the
 * face is REVERSED -- same orientation rule as the tessellator), and compare it
 * with the radial direction from the axis to the evaluated point: dot < 0 =>
 * inward normal => hole; dot > 0 => boss, skipped.
 *
 * `through` = the hole's bottom reaches the solid bbox bottom within THROUGH_TOL.
 * LIMITATION (documented in the HoleFeature type): a hole opening into an
 * internal void above bbox-bottom is reported as through=false.
 */
/** One coaxial vertical-cylinder group (seam-split walls merged), pre-`through`. */
interface VerticalCylinderGroup {
  cx: number
  cy: number
  r: number
  topZ: number
  bottomZ: number
  kind: 'bore' | 'boss'
}

/**
 * Scan faces for Z-axis cylindrical features (bores AND bosses) and merge the
 * coaxial seam-split walls (same axis + radius) of each into one group. This is
 * the shared core behind both holeFeatures (bores only) and cylinderFeatures
 * (bores + bosses). The bore-vs-boss test, vertical-axis guard, coaxial grouping
 * and topZ/bottomZ bbox merge are exactly the rules holeFeatures used to apply
 * inline; the only change is bosses are now KEPT (tagged kind='boss') instead of
 * skipped, so the bore subset is provably identical to the old holeFeatures.
 *
 * `kind` = the oriented surface normal vs the radial direction: an inward normal
 * (dot < 0) is a bore wall, an outward normal (dot >= 0) is a boss wall. The
 * grouping key is prefixed with kind so bore groups can never merge with a boss
 * group (and the bore grouping is byte-identical to before -- bosses, formerly
 * skipped, never touched any group).
 */
function collectVerticalCylinders(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
  opts?: { faceIndices?: number[] },
  where = 'derive-cylinders',
): VerticalCylinderGroup[] {
  const { faces, edges } = indexSubshapes(oc, shape)
  try {
    const subset = opts?.faceIndices
    const groups = new Map<string, VerticalCylinderGroup>()

    const scan = (face: TopoDS_Face, i: number): void => {
      const surf = new oc.BRepAdaptor_Surface_2(face, true)
      try {
        if (surf.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return

        const cyl = surf.Cylinder()
        const ax = cyl.Axis()
        const adir = ax.Direction()
        const aloc = ax.Location()
        const axisInfo = {
          dz: adir.Z(),
          lx: aloc.X(),
          ly: aloc.Y(),
          lz: aloc.Z(),
          dx: adir.X(),
          dy: adir.Y(),
          r: cyl.Radius(),
        }
        aloc.delete()
        adir.delete()
        ax.delete()
        cyl.delete()

        // Axis must be parallel to +/-Z (vertical drill axis).
        if (Math.abs(Math.abs(axisInfo.dz) - 1) > Z_PARALLEL_TOL) return

        // Oriented surface normal at mid-(u,v) vs radial direction.
        const u = (surf.FirstUParameter() + surf.LastUParameter()) / 2
        const v = (surf.FirstVParameter() + surf.LastVParameter()) / 2
        const p = new oc.gp_Pnt_1()
        const d1u = new oc.gp_Vec_1()
        const d1v = new oc.gp_Vec_1()
        surf.D1(u, v, p, d1u, d1v)
        let nx = d1u.Y() * d1v.Z() - d1u.Z() * d1v.Y()
        let ny = d1u.Z() * d1v.X() - d1u.X() * d1v.Z()
        let nz = d1u.X() * d1v.Y() - d1u.Y() * d1v.X()
        const px = p.X()
        const py = p.Y()
        const pz = p.Z()
        p.delete()
        d1u.delete()
        d1v.delete()
        if (face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) {
          nx = -nx
          ny = -ny
          nz = -nz
        }
        // Radial vector from the axis to the surface point (project out axis dir).
        const wx = px - axisInfo.lx
        const wy = py - axisInfo.ly
        const wz = pz - axisInfo.lz
        const t = wx * axisInfo.dx + wy * axisInfo.dy + wz * axisInfo.dz
        const rx = wx - t * axisInfo.dx
        const ry = wy - t * axisInfo.dy
        const rz = wz - t * axisInfo.dz
        const dot = nx * rx + ny * ry + nz * rz
        // inward normal => bore wall; outward normal => boss / outer wall.
        const kind: 'bore' | 'boss' = dot < 0 ? 'bore' : 'boss'

        // Z extent of this wall from the face's own tight bbox.
        const fb = shapeBBox(oc, face)

        // Axis is Z-parallel, so the axis (x, y) is z-independent -> grouping key.
        // kind prefix keeps a coaxial bore + boss (same r) from merging.
        const key = `${kind}:${axisInfo.lx.toFixed(4)},${axisInfo.ly.toFixed(4)},${axisInfo.r.toFixed(4)}`
        const g = groups.get(key)
        if (g) {
          g.topZ = Math.max(g.topZ, fb.max[2])
          g.bottomZ = Math.min(g.bottomZ, fb.min[2])
        } else {
          groups.set(key, {
            cx: axisInfo.lx,
            cy: axisInfo.ly,
            r: axisInfo.r,
            topZ: fb.max[2],
            bottomZ: fb.min[2],
            kind,
          })
        }
        void i
      } finally {
        surf.delete()
      }
    }

    if (subset) {
      for (const idx of subset) {
        if (idx < 0 || idx >= faces.length) {
          throw new ModelCoreError(
            where,
            `face index ${idx} out of range (shape has ${faces.length} faces)`,
          )
        }
        scan(faces[idx], idx)
      }
    } else {
      faces.forEach((f, i) => scan(f, i))
    }

    return [...groups.values()]
  } finally {
    freeAll(faces)
    freeAll(edges)
  }
}

export function holeFeatures(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
  opts?: { faceIndices?: number[] },
): HoleFeature[] {
  const bboxAll = shapeBBox(oc, shape)
  const holes: HoleFeature[] = []
  for (const g of collectVerticalCylinders(oc, shape, opts, 'derive-holes')) {
    if (g.kind !== 'bore') continue // bosses excluded (identical to old behavior)
    holes.push({
      center: [g.cx, g.cy],
      diameter: 2 * g.r,
      topZ: g.topZ,
      bottomZ: g.bottomZ,
      through: g.bottomZ <= bboxAll.min[2] + THROUGH_TOL,
    })
  }
  return holes
}

/**
 * All vertical cylindrical features (bores AND bosses), each tagged with `kind`.
 * Shares collectVerticalCylinders with holeFeatures, so for the bore subset the
 * center/diameter/topZ/bottomZ/through are computed identically. Bosses carry the
 * same fields plus kind='boss'. Honors opts.faceIndices (subset + bounds check)
 * exactly like holeFeatures. Non-vertical or non-cylindrical picked faces simply
 * produce no group; the store surfaces that as a fail-loud (ADR 0003).
 */
export function cylinderFeatures(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
  opts?: { faceIndices?: number[] },
): CylinderFeature[] {
  const bboxAll = shapeBBox(oc, shape)
  return collectVerticalCylinders(oc, shape, opts, 'derive-cylinders').map((g) => ({
    center: [g.cx, g.cy] as [number, number],
    diameter: 2 * g.r,
    topZ: g.topZ,
    bottomZ: g.bottomZ,
    through: g.bottomZ <= bboxAll.min[2] + THROUGH_TOL,
    kind: g.kind,
  }))
}

// ---------------------------------------------------------------------------
// 4. sectionAtPlane / sectionAtZ
// ---------------------------------------------------------------------------

/**
 * Exact planar section of the B-rep against an ARBITRARY plane (BRepAlgoAPI_Section
 * vs gp_Pln built from the frame's origin + normal). Sampled 3D section points are
 * flattened into the plane's orthonormal (u,v) BEFORE chaining, so all downstream
 * chaining / winding / containment math (which reads p[0],p[1]) is frame-correct
 * for any orientation -- not just horizontal.
 *
 * Section edges are chained by endpoints (SECTION_CHAIN_TOL -- intersection
 * endpoints are computed, not exact vertices). Closed loops get contour/hole by
 * containment nesting parity (even depth = contour CCW, odd = hole CW -- same
 * outermost-CCW rule the slicer's winding produces). Open fragments that
 * genuinely cannot close are kept as 'open' loops and counted in a console.warn.
 *
 * The returned `z` is the signed distance of the frame origin along its normal
 * (origin . normal). For the axis-aligned horizontal frame {O=[0,0,z],
 * X=[1,0,0], Y=[0,1,0], N=[0,0,1]} this equals z, keeping the legacy scalar.
 */
export function sectionAtPlane(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
  frame: SectionPlane,
): DerivedLoopsResult {
  const { origin: O, xAxis: X, yAxis: Y, normal: N } = frame
  const origin = new oc.gp_Pnt_3(O[0], O[1], O[2])
  const normal = new oc.gp_Dir_4(N[0], N[1], N[2])
  const plane = new oc.gp_Pln_3(origin, normal)
  const section = new oc.BRepAlgoAPI_Section_5(shape, plane, false)
  const progress = new oc.Message_ProgressRange_1()
  // Representative scalar for naming/back-compat: origin projected onto the normal.
  const zScalar = O[0] * N[0] + O[1] * N[1] + O[2] * N[2]
  let result: TopoDS_Shape | null = null
  try {
    section.Build(progress)
    if (!section.IsDone()) {
      throw new ModelCoreError(
        'derive-section',
        `BRepAlgoAPI_Section failed at plane origin=[${O.join(',')}] normal=[${N.join(',')}]`,
      )
    }
    result = section.Shape()

    const sectionEdges = uniqueSubshapes(
      oc,
      result,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum,
    )
    // Polylines are flattened into plane (u,v) as [u, v, 0]; chaining/winding/
    // containment (all reading p[0],p[1]) then operate in the plane frame.
    const polys: P3[][] = []
    try {
      for (const e of sectionEdges) {
        const edge = oc.TopoDS.Edge_1(e)
        const poly = sampleEdge(oc, edge)
        edge.delete()
        if (poly) {
          polys.push(
            poly.map((p): P3 => {
              const [u, v] = flattenToPlaneUV(p, O, X, Y)
              return [u, v, 0]
            }),
          )
        }
      }
    } finally {
      freeAll(sectionEdges)
    }

    const chains = chainPolylines(polys, SECTION_CHAIN_TOL)
    const closed = chains.filter((c) => c.closed && c.points.length >= 3)
    const open = chains.filter((c) => !c.closed)
    if (open.length > 0) {
      console.warn(
        `[derive] sectionAtPlane z=${zScalar}: ${open.length} open fragment(s) could not be closed ` +
          `(tol ${SECTION_CHAIN_TOL})`,
      )
    }

    // Containment nesting parity over the closed set (centroid-in-polygon),
    // counted only against STRICTLY LARGER loops -- same fix
    // modelBodyDerive.ts's reclassifyLoopsByNesting already applies to this
    // identical computation. A hole centered on the block's own centroid (the
    // ordinary case) puts the outer loop's centroid inside the tiny hole too;
    // a plain mutual/bidirectional test would count that and misclassify the
    // outer boundary itself as a hole. Comparing area first means only the
    // genuinely enclosing loop can ever count.
    const areas = closed.map((c) => polygonArea(c.points))
    const loops: DerivedLoop[] = closed.map((c, i) => {
      const [cx, cy] = polygonCentroid(c.points)
      let depth = 0
      for (let j = 0; j < closed.length; j++) {
        if (j === i || areas[j] <= areas[i]) continue
        if (pointInPolygon(cx, cy, closed[j].points)) depth++
      }
      return chainToLoop(c, depth % 2 === 0 ? 'contour' : 'hole')
    })
    for (const c of open) loops.push(chainToLoop(c, 'contour')) // -> type 'open'

    return { loops, z: zScalar }
  } finally {
    result?.delete()
    progress.delete()
    section.delete()
    plane.delete()
    normal.delete()
    origin.delete()
  }
}

/**
 * Exact planar section of the B-rep at height z. Thin wrapper over sectionAtPlane
 * with the axis-aligned horizontal frame {O=[0,0,z], X=[1,0,0], Y=[0,1,0],
 * N=[0,0,1]}; for that frame u=x, v=y and origin.normal=z, so output is
 * byte-identical to the previous direct implementation. Signature unchanged so
 * existing callers/tests are untouched.
 */
export function sectionAtZ(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
  z: number,
): DerivedLoopsResult {
  return sectionAtPlane(oc, shape, {
    origin: [0, 0, z],
    xAxis: [1, 0, 0],
    yAxis: [0, 1, 0],
    normal: [0, 0, 1],
  })
}

/** Area centroid of a closed polygon's XY projection. */
function polygonCentroid(pts: P3[]): [number, number] {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    const cross = pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    a += cross
    cx += (pts[i][0] + pts[j][0]) * cross
    cy += (pts[i][1] + pts[j][1]) * cross
  }
  if (Math.abs(a) < 1e-12) return [pts[0][0], pts[0][1]]
  a /= 2
  return [cx / (6 * a), cy / (6 * a)]
}

/** Absolute area of a closed polygon's XY projection (shoelace). */
function polygonArea(pts: P3[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return Math.abs(a) / 2
}

/** Ray-cast point-in-polygon on the XY projection. */
function pointInPolygon(x: number, y: number, pts: P3[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0]
    const yi = pts[i][1]
    const xj = pts[j][0]
    const yj = pts[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// ---------------------------------------------------------------------------
// 5. prismaticRoughTargetFacts
// ---------------------------------------------------------------------------

interface UpwardPlanarFace {
  faceIndex: number
  z: number
  outer: DerivedLoop
  loops: DerivedLoop[]
}

function loopContainsLoop(outer: DerivedLoop, inner: DerivedLoop): boolean {
  const polygon = outer.points.map(point => [point.x, point.y, 0] as P3)
  return inner.points.every(point => pointInPolygon(point.x, point.y, polygon))
}

function uniqueLevels(values: number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right)
  const result: number[] = []
  for (const value of sorted) {
    if (result.length === 0 || Math.abs(value - result[result.length - 1]) > PRISMATIC_TOL) {
      result.push(value)
    }
  }
  return result
}

/**
 * Classify a resident B-rep for the deliberately narrow Smart Height bridge
 * supported by scalar Pocket/Adaptive 2D workers: one lower upward deck plus
 * optional fully nested higher top faces. Every face is accounted for. A
 * non-planar/non-vertical face, internal underside, multiple solid, cavity
 * floor, split deck, or non-nested tier remains visible as a named fact rather
 * than being flattened into a guessed Z.
 */
export function prismaticRoughTargetFacts(
  oc: OcctModelModule,
  shape: TopoDS_Shape,
): PrismaticRoughTargetFacts {
  const bounds = shapeBBox(oc, shape)
  const solids = uniqueSubshapes(
    oc,
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID as TopAbs_ShapeEnum,
  )
  const solidCount = solids.length
  freeAll(solids)

  const { faces, edges } = indexSubshapes(oc, shape)
  const upward: UpwardPlanarFace[] = []
  const unclassifiedFaceIds: string[] = []
  let hasSlopedFaces = false
  let hasUndercuts = false
  try {
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
      const face = faces[faceIndex]
      const faceId = `face:${faceIndex}`
      const orientation = face.Orientation_1()
      const orientationSign = orientation === oc.TopAbs_Orientation.TopAbs_REVERSED
        ? -1
        : orientation === oc.TopAbs_Orientation.TopAbs_FORWARD
          ? 1
          : 0
      if (orientationSign === 0) {
        unclassifiedFaceIds.push(faceId)
        continue
      }

      const surface = new oc.BRepAdaptor_Surface_2(face, true)
      try {
        const type = surface.GetType()
        if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
          const plane = surface.Plane()
          const axis = plane.Axis()
          const direction = axis.Direction()
          const location = plane.Location()
          const nz = direction.Z() * orientationSign
          const z = location.Z()
          location.delete()
          direction.delete()
          axis.delete()
          plane.delete()

          if (Math.abs(nz) <= PRISMATIC_TOL) continue
          if (Math.abs(Math.abs(nz) - 1) > PRISMATIC_TOL) {
            hasSlopedFaces = true
            continue
          }
          if (nz < 0) {
            if (z > bounds.min[2] + PRISMATIC_TOL) hasUndercuts = true
            continue
          }

          try {
            const result = planarFaceLoops(oc, shape, faceIndex)
            const contours = result.loops.filter(loop => loop.type === 'contour' && loop.closed)
            if (contours.length !== 1 || result.loops.some(loop => !loop.closed)) {
              unclassifiedFaceIds.push(faceId)
              continue
            }
            upward.push({
              faceIndex,
              z: result.z,
              outer: contours[0],
              loops: result.loops,
            })
          } catch {
            unclassifiedFaceIds.push(faceId)
          }
          continue
        }

        if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
          const cylinder = surface.Cylinder()
          const axis = cylinder.Axis()
          const direction = axis.Direction()
          const axisZ = direction.Z()
          direction.delete()
          axis.delete()
          cylinder.delete()
          if (Math.abs(Math.abs(axisZ) - 1) > Z_PARALLEL_TOL) hasSlopedFaces = true
          continue
        }

        // Cones, spheres, splines, and every other surface are outside the
        // complete prismatic representation even if their tessellation looks
        // nearly vertical.
        hasSlopedFaces = true
        unclassifiedFaceIds.push(faceId)
      } finally {
        surface.delete()
      }
    }
  } finally {
    freeAll(faces)
    freeAll(edges)
  }

  const levels = uniqueLevels(upward.map(face => face.z))
  if (solidCount !== 1) unclassifiedFaceIds.push(`solid-count:${solidCount}`)
  if (upward.length === 0) unclassifiedFaceIds.push('deck:none')

  let roughFloorZ: number | undefined
  let keepOutRegions: PrismaticRoughTargetFacts['keepOutRegions'] = []
  if (upward.length > 0) {
    const minimumZ = Math.min(...upward.map(face => face.z))
    const deckCandidates = upward.filter(face => Math.abs(face.z - minimumZ) <= PRISMATIC_TOL)
    if (deckCandidates.length !== 1) {
      unclassifiedFaceIds.push(`deck-candidates:${deckCandidates.map(face => face.faceIndex).join(',')}`)
    } else {
      const deck = deckCandidates[0]
      const higher = upward.filter(face => face.z > minimumZ + PRISMATIC_TOL)
      const allNested = higher.every(face => loopContainsLoop(deck.outer, face.outer))
      const higherAreSimple = higher.every(face => face.loops.length === 1)
      if (!allNested || !higherAreSimple) {
        unclassifiedFaceIds.push('deck:non-nested-or-complex-higher-region')
      } else {
        roughFloorZ = minimumZ
        keepOutRegions = higher.map(face => ({
          faceIndex: face.faceIndex,
          loop: face.outer,
          targetTopZ: face.z,
        }))
      }
    }
  }

  return {
    bounds,
    solidCount,
    ...(roughFloorZ === undefined ? {} : { roughFloorZ }),
    keepOutRegions,
    classification: {
      allFacesClassified: unclassifiedFaceIds.length === 0,
      hasSlopedFaces,
      hasUndercuts,
      // If a valid common deck exists, report that exact candidate. Otherwise
      // preserve all upward levels so the consumer can diagnose the conflict.
      deckLevelsZ: roughFloorZ === undefined ? levels : [roughFloorZ],
      unclassifiedFaceIds,
    },
  }
}
