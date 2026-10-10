// CAM-BINDING Stage 2 - the "derive" half of derive-then-bind (charter's
// resolution of INT-17 Stage 3 Q2): converts a modeled body's own tessellated
// display mesh into the SAME Loop2D shape every existing 2D op builder
// already consumes, so op compute code itself does not change.
//
// IDENTITY BOUNDARY (charter Q1, INT-17A's own identity law): this module
// touches NOTHING from src/lib/cam/geometry/occt/model/ (the occt-model/STEP
// import kernel). It operates exclusively on `ModelBodyDisplay` - the
// tessellated mesh already captured from the Model kernel's own occt-wasm
// instance (via syncCamModelBodies -> modelBodyDisplayFromCached), whose
// provenance rides the Model kernel's ElementMap (ModelBodyRef.bodyId /
// .stableIds), never occt-model's {geoId,kind,index} scheme.
//
// ALGORITHM CHOICE (disclosed, not charter-mandated): the Model kernel
// (GeomService/geom-engine.ts, occt-wasm/brepjs) has no planar-section/
// profile-extraction query today (recon finding, CAM-BINDING-S2 report) -
// building one would mean porting BRepAlgoAPI_Section-equivalent logic into
// a kernel that does not expose it, a program of its own. Instead this reuses
// the EXISTING, already-proven mesh-plane-intersection algorithm
// (src/lib/geometry/stlProjection.ts's projectSTLToLoops, used today for STL
// import's default 2D projection) against the body's own tessellation -
// geometrically no different from an STL mesh, and it never touches
// occt-model. "Port, don't re-derive" (repo convention): zero new slicing
// algorithm, only new plumbing + the world-space bake documented below.
//
// WORLD-SPACE BAKE: a model row's OWN `position`/`rotation` stay identity
// forever (INT-17C: updateGeometryTransform refuses to write them for a
// model-origin row) - the body's real world pose lives in its Placement
// record instead. So unlike a normal DXF/STEP/STL geometry entry (whose
// loops get `transformLoopPoints(loops, geometry)` applied generically at
// compute time in computeOperationToolpath), a model body's loops must have
// their WORLD transform baked in HERE, using resolveModelReferenceFrame (the
// one seam, composing through resolveModelItemPlacement) - never inlined.
//
// FAIL-LOUD (ADR-0003): every failure mode below throws a named
// ModelBodyDeriveError with an actionable message - no silent fallback, no
// plausible-looking wrong result.

import type { CylinderFeature, HoleFeature, ImportedGeometry, Loop2D, Vec3 } from '../../types'
import type { GeometrySnapshot } from '../../geom'
import type { FeatureClass, FeatureVerdict } from '../../geom/geom-service'
import { isModelOriginGeometry } from './modelOrigin'
import { resolveModelReferenceFrame } from './modelReferenceFrame'
import type { ModelItemPlacementRegistryEntry } from './modelItemPlacement'
import { projectSTLToLoops, sliceAtZ, buildLoops, dp } from '../geometry/stlProjection'
import { assignStableLoopIds } from '../geometry/loopId'
import { transformLoopPoints, isTiltedOffZ, rotationMatrixXYZ, type GeoPose } from '../../store/dispatchGeo'
import { smartHeightEvidenceFingerprint } from './smartHeights/adaptive3d'

/** Replicated here verbatim -- NOT imported -- mirroring modelBodyAdapter.ts's
 *  own documented precedent (same rationale: this stays a pure module, free
 *  of any src/doc/ dependency). Must equal src/doc/documentHolder.ts's
 *  LEGACY_MODEL_ITEM_ID byte-for-byte; pinned by this file's own test. */
const LEGACY_MODEL_ITEM_ID = 'legacy'

export class ModelBodyDeriveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelBodyDeriveError'
  }
}

export interface ModelBodyDeriveResult {
  /** World-space Loop2D[], ready to feed the same downstream builders any
   *  other geometry source's loops feed (contour_2d/pocket_2d etc). */
  loops: Loop2D[]
}

// Same defaults NewOperationModal's manual STL-projection UI uses
// (Viewport.tsx / DesignTree.tsx: `appSettings.projectionToleranceDefault`),
// so a model body's derived profile is not held to a different fidelity bar
// than an STL import's. Stage 2 has no per-op UI to override these (whole-
// body granularity only - face-level picking with its own controls is
// Stage 5); a fixed, documented default is the honest v1.
const DEFAULT_SIMPLIFICATION_TOLERANCE = 0.02 // mm
const minPerimeterFor = (tol: number) => Math.max(0.1, tol * 6)

// projectSTLToLoops classifies contour-vs-hole by the SIGN of each loop's
// local signed area, which depends on the source mesh's own triangle
// winding convention. That convention is unverified for a Model-kernel
// tessellation (found live: a real occt-wasm/brepjs extrude's winding
// produced the OPPOSITE sign from this module's hand-built unit-test
// fixtures, misclassifying a simple prism's only loop as a 'hole' and
// leaving pocket2d's classifyLoops with zero outer bounds - "Pocket: the
// selected loops contain no usable closed boundary to pocket"). Rather than
// hunt down and pin one specific winding convention (fragile - the next
// kernel version, or a body built a different way, could flip it again),
// reclassify by NESTING instead: a loop whose centroid falls inside another
// loop is a hole; every other loop is an outer contour. Sign-independent,
// mirrors how occt-model's own derive.ts assigns contour/hole by nesting
// parity for the (deliberately unrelated) STEP-import path.
function pointInPolygon(pt: { x: number; y: number }, poly: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    const crosses = (yi > pt.y) !== (yj > pt.y)
    if (crosses && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function loopCentroid(points: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number } {
  let sx = 0, sy = 0
  for (const p of points) { sx += p.x; sy += p.y }
  return { x: sx / points.length, y: sy / points.length }
}
function polygonArea(points: ReadonlyArray<{ x: number; y: number }>): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    a += points[i].x * points[j].y - points[j].x * points[i].y
  }
  return Math.abs(a) / 2
}
function reclassifyLoopsByNesting(loops: readonly Loop2D[]): Loop2D[] {
  // AREA-ORDERED containment, largest first: a loop is a 'hole' only if its
  // centroid falls inside a LARGER loop. Checking only against larger loops
  // (not bidirectionally) avoids the concentric-shapes trap a plain mutual
  // "is my centroid inside yours" test falls into - a hole centered on the
  // SAME point as its outer boundary (the ordinary case: a hole drilled at
  // a part's center) would otherwise also read as "the outer loop's
  // centroid is inside the tiny hole," misclassifying the outer boundary
  // itself as a hole too.
  const byArea = [...loops].sort((a, b) => polygonArea(b.points) - polygonArea(a.points))
  return byArea.map((loop, i) => {
    const larger = byArea.slice(0, i)
    const c = loopCentroid(loop.points)
    const nested = larger.some((other) => pointInPolygon(c, other.points))
    return { ...loop, type: nested ? 'hole' : 'contour' }
  })
}

/** WO-1562: two reclassified loop sets cover the same region - same contour
 *  and hole counts, and contour and hole areas that differ by no more than
 *  simplifying `a`'s loops at `tol` could move them (perimeter x tol). The
 *  outline always contains the slice, so equal areas mean equal regions. */
function sameRegion(a: readonly Loop2D[], b: readonly Loop2D[], tol: number): boolean {
  const sum = (loops: readonly Loop2D[], type: Loop2D['type']) => {
    let count = 0, area = 0
    for (const l of loops) if (l.type === type) { count++; area += polygonArea(l.points) }
    return { count, area }
  }
  let perimeter = 0
  for (const l of a) {
    for (let i = 0; i < l.points.length; i++) {
      const p = l.points[i], n = l.points[(i + 1) % l.points.length]
      perimeter += Math.hypot(n.x - p.x, n.y - p.y)
    }
  }
  const slack = perimeter * tol
  for (const type of ['contour', 'hole'] as const) {
    const sa = sum(a, type), sb = sum(b, type)
    if (sa.count !== sb.count || Math.abs(sa.area - sb.area) > slack) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// WO-1543: a body at ANY placement. A Z-preserving Placement keeps the local
// slice + XY rotation below (bit-identical to before). Any other rotation
// (tilted, upside down) bakes the FULL placement into the mesh first, then
// cuts world Z or outlines world XY - the result the operator would get from
// applying the placement and then sectioning/outlining the placed body.
// ---------------------------------------------------------------------------

/** Display vertices placed in world: R (three.js 'XYZ', the viewport's own
 *  order - rotationMatrixXYZ) then translation, the same map
 *  worldBoundsFromLocalCorners applies to a body's bbox. */
export function placedWorldPositions(positions: ArrayLike<number>, frame: { position: Vec3; rotation: Vec3 }): Float64Array {
  const R = rotationMatrixXYZ(frame.rotation)
  const out = new Float64Array(positions.length)
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    out[i] = R.col1.x * x + R.col2.x * y + R.col3.x * z + frame.position.x
    out[i + 1] = R.col1.y * x + R.col2.y * y + R.col3.y * z + frame.position.y
    out[i + 2] = R.col1.z * x + R.col2.z * y + R.col3.z * z + frame.position.z
  }
  return out
}

type RotationMatrix = ReturnType<typeof rotationMatrixXYZ>

/** R * (x, y, z): a local vector or point turned by the Placement rotation
 *  (no translation). */
function rotateVec(R: RotationMatrix, x: number, y: number, z: number): [number, number, number] {
  return [
    R.col1.x * x + R.col2.x * y + R.col3.x * z,
    R.col1.y * x + R.col2.y * y + R.col3.y * z,
    R.col1.z * x + R.col2.z * y + R.col3.z * z,
  ]
}

/**
 * World Z range of a modeled body at its placement: the placed mesh's
 * min/max Z, or (no tessellation yet) the placed corners of its local bbox.
 * The Section at Z panel's readout for a body that is not Z-aligned.
 */
export function modelBodyWorldZRange(
  geo: ImportedGeometry,
  frame: { position: Vec3; rotation: Vec3 },
): { min: number; max: number } {
  const R = rotationMatrixXYZ(frame.rotation)
  const zOf = (x: number, y: number, z: number) => R.col1.z * x + R.col2.z * y + R.col3.z * z + frame.position.z
  let min = Infinity, max = -Infinity
  const positions = geo.modelBody?.display?.positions
  if (positions && positions.length >= 3) {
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const z = zOf(positions[i], positions[i + 1], positions[i + 2])
      if (z < min) min = z
      if (z > max) max = z
    }
  } else {
    const { min: lo, max: hi } = geo.boundingBox
    for (const x of [lo.x, hi.x]) for (const y of [lo.y, hi.y]) for (const z of [lo.z, hi.z]) {
      const wz = zOf(x, y, z)
      if (wz < min) min = wz
      if (wz > max) max = wz
    }
  }
  return { min, max }
}

/** mm: two mesh vertices closer than this are one vertex when matching the
 *  3D edges two triangles share. */
const OUTLINE_VERTEX_KEY = 1e-4
/** mm: segments within this of each other are collinear / touching. */
const OUTLINE_LINEAR_EPS = 1e-4
/** mm: how far either side of an edge the shadow-coverage probe looks. */
const OUTLINE_SIDE_PROBE = 1e-3
/** mm snap for outline vertices - stlProjection's own SNAP, so buildLoops
 *  chains outline segments exactly as it chains slice segments. */
const OUTLINE_SNAP = 0.01

/**
 * World-XY outline (the shadow seen from +Z) of a placed closed mesh, as
 * Loop2D[] in world coordinates. Winding-independent, like the rest of this
 * file: the shadow is the union of every triangle's XY projection.
 *
 * 1. Candidate edges: a mesh edge whose two triangles project to OPPOSITE
 *    sides of it is inside the shadow; every other edge (a fold, a lone
 *    edge, a neighbour seen edge-on) may lie on its boundary.
 * 2. Candidates are split wherever they cross or overlap each other.
 * 3. A piece is on the outline when the shadow covers exactly one side of it.
 * 4. The pieces chain, simplify and filter exactly like a slice does.
 */
function worldOutlineLoops(
  world: Float64Array,
  indices: ArrayLike<number>,
  tolerance: number,
  minPerimeter: number,
): Loop2D[] {
  const X = (v: number) => world[v * 3]
  const Y = (v: number) => world[v * 3 + 1]
  const vkey = (v: number) =>
    `${Math.round(world[v * 3] / OUTLINE_VERTEX_KEY)},${Math.round(world[v * 3 + 1] / OUTLINE_VERTEX_KEY)},${Math.round(world[v * 3 + 2] / OUTLINE_VERTEX_KEY)}`

  const tris: number[] = []
  const edges = new Map<string, { ax: number; ay: number; bx: number; by: number; sides: number[] }>()
  const triCount = Math.floor(indices.length / 3)
  for (let t = 0; t < triCount; t++) {
    const tv = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]]
    const [a, b, c] = tv
    const a2 = (X(b) - X(a)) * (Y(c) - Y(a)) - (Y(b) - Y(a)) * (X(c) - X(a))
    if (Math.abs(a2) < 1e-9) continue // seen edge-on: no shadow of its own
    tris.push(X(a), Y(a), X(b), Y(b), X(c), Y(c))
    for (let e = 0; e < 3; e++) {
      const p = tv[e], q = tv[(e + 1) % 3], r = tv[(e + 2) % 3]
      const kp = vkey(p), kq = vkey(q)
      if (kp === kq) continue
      const [lo, hi] = kp < kq ? [p, q] : [q, p]
      const key = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`
      let entry = edges.get(key)
      if (!entry) {
        entry = { ax: X(lo), ay: Y(lo), bx: X(hi), by: Y(hi), sides: [] }
        edges.set(key, entry)
      }
      entry.sides.push(Math.sign((X(hi) - X(lo)) * (Y(r) - Y(lo)) - (Y(hi) - Y(lo)) * (X(r) - X(lo))))
    }
  }
  if (tris.length === 0) return []

  interface Seg { ax: number; ay: number; bx: number; by: number; len: number; ts: number[] }
  const segs: Seg[] = []
  for (const e of edges.values()) {
    if (e.sides.length === 2 && e.sides[0] !== e.sides[1]) continue
    const len = Math.hypot(e.bx - e.ax, e.by - e.ay)
    if (len < OUTLINE_LINEAR_EPS) continue
    segs.push({ ax: e.ax, ay: e.ay, bx: e.bx, by: e.by, len, ts: [] })
  }

  const splitAt = (s: Seg, px: number, py: number) => {
    const t = ((px - s.ax) * (s.bx - s.ax) + (py - s.ay) * (s.by - s.ay)) / (s.len * s.len)
    const tol = OUTLINE_LINEAR_EPS / s.len
    if (t > tol && t < 1 - tol) s.ts.push(t)
  }
  const minX = (s: Seg) => Math.min(s.ax, s.bx)
  const maxX = (s: Seg) => Math.max(s.ax, s.bx)
  segs.sort((s, u) => minX(s) - minX(u))
  for (let i = 0; i < segs.length; i++) {
    const A = segs[i]
    const aMaxX = maxX(A) + OUTLINE_LINEAR_EPS
    const aMinY = Math.min(A.ay, A.by) - OUTLINE_LINEAR_EPS
    const aMaxY = Math.max(A.ay, A.by) + OUTLINE_LINEAR_EPS
    for (let j = i + 1; j < segs.length; j++) {
      const B = segs[j]
      if (minX(B) > aMaxX) break
      if (Math.max(B.ay, B.by) < aMinY || Math.min(B.ay, B.by) > aMaxY) continue
      const dax = A.bx - A.ax, day = A.by - A.ay
      const dbx = B.bx - B.ax, dby = B.by - B.ay
      const rx = B.ax - A.ax, ry = B.ay - A.ay
      const denom = dax * dby - day * dbx
      if (Math.abs(denom) <= 1e-12 * A.len * B.len) {
        // Parallel: only a collinear overlap splits anything.
        if (Math.abs(dax * ry - day * rx) / A.len > OUTLINE_LINEAR_EPS) continue
        splitAt(A, B.ax, B.ay); splitAt(A, B.bx, B.by)
        splitAt(B, A.ax, A.ay); splitAt(B, A.bx, A.by)
        continue
      }
      const t = (rx * dby - ry * dbx) / denom
      const u = (rx * day - ry * dax) / denom
      const tTol = OUTLINE_LINEAR_EPS / A.len, uTol = OUTLINE_LINEAR_EPS / B.len
      if (t < -tTol || t > 1 + tTol || u < -uTol || u > 1 + uTol) continue
      if (t > tTol && t < 1 - tTol) A.ts.push(t)
      if (u > uTol && u < 1 - uTol) B.ts.push(u)
    }
  }

  // Uniform grid over the projected triangles for the coverage probe.
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity
  for (let i = 0; i < tris.length; i += 2) {
    if (tris[i] < gx0) gx0 = tris[i]
    if (tris[i] > gx1) gx1 = tris[i]
    if (tris[i + 1] < gy0) gy0 = tris[i + 1]
    if (tris[i + 1] > gy1) gy1 = tris[i + 1]
  }
  const shadowCount = tris.length / 6
  const cellsPerSide = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(shadowCount))))
  const cw = (gx1 - gx0) / cellsPerSide || 1
  const ch = (gy1 - gy0) / cellsPerSide || 1
  const cellOf = (v: number, v0: number, size: number) => Math.min(cellsPerSide - 1, Math.max(0, Math.floor((v - v0) / size)))
  const grid: number[][] = Array.from({ length: cellsPerSide * cellsPerSide }, () => [])
  for (let k = 0; k < shadowCount; k++) {
    const o = k * 6
    const i0 = cellOf(Math.min(tris[o], tris[o + 2], tris[o + 4]), gx0, cw)
    const i1 = cellOf(Math.max(tris[o], tris[o + 2], tris[o + 4]), gx0, cw)
    const j0 = cellOf(Math.min(tris[o + 1], tris[o + 3], tris[o + 5]), gy0, ch)
    const j1 = cellOf(Math.max(tris[o + 1], tris[o + 3], tris[o + 5]), gy0, ch)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * cellsPerSide + i].push(o)
  }
  const covered = (px: number, py: number): boolean => {
    if (px < gx0 || px > gx1 || py < gy0 || py > gy1) return false
    for (const o of grid[cellOf(py, gy0, ch) * cellsPerSide + cellOf(px, gx0, cw)]) {
      const d1 = (px - tris[o + 2]) * (tris[o + 1] - tris[o + 3]) - (tris[o] - tris[o + 2]) * (py - tris[o + 3])
      const d2 = (px - tris[o + 4]) * (tris[o + 3] - tris[o + 5]) - (tris[o + 2] - tris[o + 4]) * (py - tris[o + 5])
      const d3 = (px - tris[o]) * (tris[o + 5] - tris[o + 1]) - (tris[o + 4] - tris[o]) * (py - tris[o + 1])
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0
      if (!(hasNeg && hasPos)) return true
    }
    return false
  }

  const snap = (v: number) => Math.round(v / OUTLINE_SNAP) * OUTLINE_SNAP
  const seen = new Set<string>()
  const pieces: Array<[{ x: number; y: number }, { x: number; y: number }]> = []
  for (const s of segs) {
    const ts = [0, ...s.ts.sort((a, b) => a - b), 1]
    const nx = -(s.by - s.ay) / s.len, ny = (s.bx - s.ax) / s.len
    for (let k = 0; k + 1 < ts.length; k++) {
      if ((ts[k + 1] - ts[k]) * s.len < 1e-7) continue
      const tm = (ts[k] + ts[k + 1]) / 2
      const mx = s.ax + tm * (s.bx - s.ax), my = s.ay + tm * (s.by - s.ay)
      const left = covered(mx + OUTLINE_SIDE_PROBE * nx, my + OUTLINE_SIDE_PROBE * ny)
      const right = covered(mx - OUTLINE_SIDE_PROBE * nx, my - OUTLINE_SIDE_PROBE * ny)
      if (left === right) continue
      const p = { x: snap(s.ax + ts[k] * (s.bx - s.ax)), y: snap(s.ay + ts[k] * (s.by - s.ay)) }
      const q = { x: snap(s.ax + ts[k + 1] * (s.bx - s.ax)), y: snap(s.ay + ts[k + 1] * (s.by - s.ay)) }
      const kp = `${Math.round(p.x / OUTLINE_SNAP)},${Math.round(p.y / OUTLINE_SNAP)}`
      const kq = `${Math.round(q.x / OUTLINE_SNAP)},${Math.round(q.y / OUTLINE_SNAP)}`
      if (kp === kq) continue
      const key = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`
      if (seen.has(key)) continue
      seen.add(key)
      pieces.push([p, q])
    }
  }

  const result: Loop2D[] = []
  for (const raw of buildLoops(pieces)) {
    if (raw.length < 3) continue
    const simplified = dp(raw, tolerance)
    if (simplified.length < 3) continue
    const perim = simplified.reduce((sum, p, i) => {
      const n = simplified[(i + 1) % simplified.length]
      return sum + Math.hypot(n.x - p.x, n.y - p.y)
    }, 0)
    if (perim < minPerimeter) continue
    result.push({
      id: '',
      points: simplified.map((p) => ({ x: p.x, y: p.y })),
      closed: true,
      type: 'contour', // reclassifyLoopsByNesting assigns the real type
      layerId: 'stl_proj_layer', // projectSTLToLoops' layer id, so both derives land alike
      area: polygonArea(simplified),
    })
  }
  return assignStableLoopIds(result)
}

/**
 * Derive a modeled body's whole-body profile as world-space Loop2D[].
 *
 * `placementRecords` is the project's `modelItemPlacements` array (passed
 * explicitly, mirroring resolveModelReferenceFrame's own purity contract).
 */
export function deriveModelBodyProfile(
  geo: ImportedGeometry,
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
): ModelBodyDeriveResult {
  if (!isModelOriginGeometry(geo)) {
    throw new ModelBodyDeriveError(
      `deriveModelBodyProfile: "${geo.name}" is not a modeled body (format "${geo.format}").`,
    )
  }

  const display = geo.modelBody?.display
  if (!display || display.positions.length === 0 || display.indices.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}" has no tessellated geometry yet to derive a profile from - open the ` +
        `Model tab once so it can regenerate, then try computing this operation again.`,
    )
  }

  const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const bodyId = geo.modelBody?.ref.bodyId
  let frame: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }
  try {
    frame = resolveModelReferenceFrame(placementRecords, itemId, bodyId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ModelBodyDeriveError(
      `"${geo.name}" could not resolve its world placement (${message}). ` +
        `This should not happen for a live, synced model body - re-sync (open the Model tab) and retry.`,
    )
  }

  const tol = DEFAULT_SIMPLIFICATION_TOLERANCE
  const noClosedCrossSection = () => new ModelBodyDeriveError(
    `"${geo.name}" produced no closed cross-section when derived - it may not be a ` +
      `2.5D-machinable prismatic shape, or its mesh may be open (not a closed solid).`,
  )

  // WO-1543: a Placement that tilts (or flips) the body gets the placed
  // body's world-XY outline - a near-bottom slice of a tilted body would be a
  // sliver along its lowest edge, not its profile.
  if (isTiltedOffZ(frame.rotation)) {
    const worldLoops = reclassifyLoopsByNesting(worldOutlineLoops(
      placedWorldPositions(display.positions, frame), display.indices, tol, minPerimeterFor(tol),
    ))
    if (worldLoops.length === 0) throw noClosedCrossSection()
    return { loops: worldLoops }
  }

  const positions = Float32Array.from(display.positions)
  const indices = display.indices.length > 0 ? Uint32Array.from(display.indices) : null

  const { loops: rawLocalLoops } = projectSTLToLoops(positions, indices, {
    simplificationTolerance: tol,
    minPerimeter: minPerimeterFor(tol),
  })
  const sliceLoops = reclassifyLoopsByNesting(rawLocalLoops)

  // WO-1562: a profile is cut from above, so an upright body's profile is its
  // top-down outline too - a near-bottom slice of a T with its flange on top
  // is the stem, and a tool following it cuts into the flange. A Z-only
  // rotation does not change the outline's shape, so it is taken in the local
  // frame and rotated like the slice. Where the outline and the slice are the
  // same region (every prismatic body) the slice is kept, point for point.
  // No slice at all means an open mesh, not a solid: that still refuses below.
  const outlineLoops = sliceLoops.length === 0 ? [] : reclassifyLoopsByNesting(worldOutlineLoops(
    Float64Array.from(display.positions), display.indices, tol, minPerimeterFor(tol),
  ))
  const localLoops = outlineLoops.length > 0 && !sameRegion(sliceLoops, outlineLoops, tol) ? outlineLoops : sliceLoops

  if (localLoops.length === 0) throw noClosedCrossSection()

  const pose: GeoPose = { position: frame.position, rotation: frame.rotation }
  const loops: Loop2D[] = localLoops.map((loop) => ({
    ...loop,
    points: transformLoopPoints(loop.points, pose),
  }))

  return { loops }
}

// ---------------------------------------------------------------------------
// CAM-BINDING Stage 4 (slicing): deriveModelBodySection
// ---------------------------------------------------------------------------
//
// The model-kernel counterpart of occt-model/derive.ts's sectionAtZ, extending
// the existing generic "Section at Z -> pocket" wizard flow (shipped for
// imported STEP bodies) to a modeled body. Same disclosed algorithm choice as
// deriveModelBodyProfile above: the Model kernel (GeomService/geom-engine.ts,
// occt-wasm/brepjs) has no planar-section query, so this reuses the SAME
// mesh-plane-intersection primitives (stlProjection.ts's sliceAtZ/buildLoops/
// projectSTLToLoops) against the body's own tessellation, at a CALLER-CHOSEN Z
// instead of the fixed near-bottom default deriveModelBodyProfile uses.
//
// PRECISION DISCLOSURE (honest, not hidden): occt-model's sectionAtZ is an
// EXACT B-rep intersection (BRepAlgoAPI_Section against the analytic surface).
// This is a MESH-DERIVED section - it intersects the plane against the body's
// already-tessellated triangles, so its precision is bounded by the display
// tessellation's chord tolerance (typically sub-0.01mm for the Model kernel's
// default deflection), not exact to machine epsilon. For any prismatic /
// polyhedral / lightly-curved shape this difference is far below machining
// tolerance; a section through a tight, highly-curved fillet at an oblique
// angle could show a small chord-approximation error inherited from the
// tessellation. Disclosed in the Stage 4 report's parity fixture, not silently
// assumed equivalent to the exact STEP path.
//
// WORLD-Z INPUT (unlike deriveModelBodyProfile, which has no caller-facing Z):
// `worldZ` is a WORLD-space height, per the charter's "Placement composes
// through the seam: a moved/rotated model item sections at the correct world
// Z" requirement - the wizard UI (NewOperationModal) presents and clamps the
// Z field in WORLD coordinates for a model source (unlike the STEP/brep path,
// which is geometry-LOCAL - see that file's own comment on brepZMin/brepZMax).
// A pure Z-axis Placement rotation never changes a point's Z coordinate, so
// localZ = worldZ - frame.position.z exactly for an upright body; a tilted or
// flipped body is sectioned in world space instead (WO-1543, below).
//
// FAIL-LOUD (ADR-0003, charter-named degenerate cases): Z above/below the
// body's world range, a tangent slice (grazing a flat face, zero triangle
// crossings), and an open profile (some cut edges did not chain into a closed
// loop - checked directly against the raw sliceAtZ/buildLoops output, more
// rigorous than deriveModelBodyProfile's own bare "zero loops" check) each
// throw a distinct, named ModelBodyDeriveError - never an empty-but-green op.
export interface ModelBodySectionResult {
  /** World-space Loop2D[], ready to land as a derived layer via the SAME
   *  appendGeometryProjection/appendDerivedLayer path the STEP/brep Section-
   *  at-Z flow already uses (deriveBrepLayer, 'section' kind). */
  loops: Loop2D[]
  /** Echoes the input worldZ (matches occt-model's DerivedLoopsResult.z shape
   *  so this result is plug-compatible with the existing derive-landing code). */
  z: number
}

/** Z-range/tangent tolerance (mm) - matches the coplanarity/through-hole
 *  tolerances occt-model/derive.ts uses for the same class of check. */
const SECTION_Z_EPS = 1e-3

/**
 * Derive a modeled body's exact cross-section at a WORLD Z height, as
 * world-space Loop2D[]. `placementRecords` is the project's
 * `modelItemPlacements` array, mirroring deriveModelBodyProfile's own
 * purity contract.
 */
export function deriveModelBodySection(
  geo: ImportedGeometry,
  worldZ: number,
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
): ModelBodySectionResult {
  if (!isModelOriginGeometry(geo)) {
    throw new ModelBodyDeriveError(
      `deriveModelBodySection: "${geo.name}" is not a modeled body (format "${geo.format}").`,
    )
  }

  const display = geo.modelBody?.display
  if (!display || display.positions.length === 0 || display.indices.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}" has no tessellated geometry yet to section - open the ` +
        `Model tab once so it can regenerate, then try again.`,
    )
  }

  const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const bodyId = geo.modelBody?.ref.bodyId
  let frame: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }
  try {
    frame = resolveModelReferenceFrame(placementRecords, itemId, bodyId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ModelBodyDeriveError(
      `"${geo.name}" could not resolve its world placement (${message}). ` +
        `This should not happen for a live, synced model body - re-sync (open the Model tab) and retry.`,
    )
  }

  // A Z-preserving rotation never changes Z: slice the LOCAL mesh at
  // worldZ - position.z and rotate the loops into world XY afterwards. Any
  // other Placement (tilted or upside down, WO-1543) bakes its full rotation
  // and translation into the mesh first, so the plane below is the
  // horizontal world-Z plane the operator asked for and the loops come out
  // already in world XY. `zOffset` is what separates mesh Z from world Z.
  const tilted = isTiltedOffZ(frame.rotation)
  const zOffset = tilted ? 0 : frame.position.z
  const localZ = worldZ - zOffset

  const positions = tilted
    ? Float32Array.from(placedWorldPositions(display.positions, frame))
    : Float32Array.from(display.positions)
  const indices = display.indices.length > 0 ? Uint32Array.from(display.indices) : null

  // Z bounds scanned directly from the RAW MESH, not display.bbox: matches
  // projectSTLToLoops' own defensive convention (it computes its Z extent the
  // same way, never trusting an externally-supplied bbox that could drift
  // from the actual tessellation).
  let minLocalZ = Infinity
  let maxLocalZ = -Infinity
  for (let i = 2; i < positions.length; i += 3) {
    if (positions[i] < minLocalZ) minLocalZ = positions[i]
    if (positions[i] > maxLocalZ) maxLocalZ = positions[i]
  }
  if (!Number.isFinite(minLocalZ) || maxLocalZ <= minLocalZ) {
    throw new ModelBodyDeriveError(
      `"${geo.name}" has no usable Z extent to section (degenerate or empty mesh).`,
    )
  }
  const worldMinZ = minLocalZ + zOffset
  const worldMaxZ = maxLocalZ + zOffset
  if (localZ < minLocalZ - SECTION_Z_EPS || localZ > maxLocalZ + SECTION_Z_EPS) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": section Z ${worldZ.toFixed(3)} mm is outside the body's world Z range ` +
        `[${worldMinZ.toFixed(3)}, ${worldMaxZ.toFixed(3)}] mm - pick a height within the body.`,
    )
  }

  // Degenerate-section detection: run the low-level slice/chain pair directly
  // (the same primitives projectSTLToLoops calls internally) so a tangent
  // plane (zero triangle crossings) and an open profile (some crossings never
  // chained into a closed loop) each get their OWN named refusal, rather than
  // projectSTLToLoops' higher-level wrapper silently dropping the unclosed
  // fragments and this function only noticing an empty result.
  const segs = sliceAtZ(positions, indices, localZ)
  if (segs.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": no material cross-section at Z ${worldZ.toFixed(3)} mm - this height is a ` +
        `tangent slice (grazing a flat top/bottom face) rather than cutting through the solid. ` +
        `Pick a height strictly between the body's top and bottom faces.`,
    )
  }
  const rawChains = buildLoops(segs)
  const consumedPoints = rawChains.reduce((sum, chain) => sum + chain.length, 0)
  if (consumedPoints < segs.length) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the section at Z ${worldZ.toFixed(3)} mm produced an open profile - some ` +
        `cut edges did not close into a loop (this height may pass through a non-manifold or ` +
        `degenerate part of the mesh). Pick a slightly different height.`,
    )
  }

  const tol = DEFAULT_SIMPLIFICATION_TOLERANCE
  const { loops: rawLocalLoops } = projectSTLToLoops(positions, indices, {
    simplificationTolerance: tol,
    minPerimeter: minPerimeterFor(tol),
    sliceZ: localZ,
  })
  const localLoops = reclassifyLoopsByNesting(rawLocalLoops)

  if (localLoops.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the section at Z ${worldZ.toFixed(3)} mm produced no loop large enough to ` +
        `machine (every candidate loop was below the minimum-perimeter simplification floor) - ` +
        `pick a different height.`,
    )
  }

  if (tilted) return { loops: localLoops, z: worldZ }

  const pose: GeoPose = { position: frame.position, rotation: frame.rotation }
  const loops: Loop2D[] = localLoops.map((loop) => ({
    ...loop,
    points: transformLoopPoints(loop.points, pose),
  }))

  return { loops, z: worldZ }
}

// ---------------------------------------------------------------------------
// CAM-BINDING Stage 5 (face boundaries): deriveModelBodyFace
// ---------------------------------------------------------------------------
//
// Extends the SAME identity boundary + mesh-only algorithm choice as
// deriveModelBodyProfile/deriveModelBodySection above to a single PICKED FACE
// (not the whole body, not a Z-section): given the face's ElementMap
// stableId, extracts ONLY that face's boundary as a world-space Loop2D[] -
// the geometry a machining-boundary/stock/origin ModelReference resolves to
// at compute time (never landed/cached - called fresh on every compute, same
// "always re-derive live" philosophy as deriveModelBodyProfile, because this
// is the derive half of a REFERENCE the CAM-1 badge machinery must be able to
// call stale/degraded; a landed snapshot, like Stage 4's Section-at-Z, would
// have nothing for that machinery to invalidate).
//
// FACE IDENTITY: requires ModelBodyDisplay.faceIds/triFace (CAM-BINDING
// Stage 5 addition to the persisted display payload, captured verbatim from
// the SAME live tessellation cache Stage 1 already reads - see
// modelBodyDisplay.ts). A display persisted before this stage (or before its
// owning body's first post-Stage-5 regen) lacks these arrays and is refused
// by name, never treated as "face not found".
//
// PLANAR + Z-NORMAL ONLY (matches occt-model's planarFaceLoops / ADR 0018 D5
// verbatim - "only planar faces can drive 2D operations", "plane normal not
// parallel to +/-Z (v1 machining plane is world XY only)"): checked directly
// against the face's own triangle vertices' local Z spread, not a kernel
// surface-type query (none exists for a modeled body's mesh - same disclosed
// algorithm-choice rationale as this file's other two derives).
//
// BOUNDARY EXTRACTION: a standard mesh-patch-boundary trace over the face's
// OWN triangle subset (an edge shared by exactly one triangle in the subset
// is a boundary edge; one shared by two is interior and dropped) - winding/
// sign-independent by construction (never relies on triangle orientation),
// consistent with this file's own established distrust of the Model kernel's
// unverified winding convention (see the nesting-reclassification comment
// above). Reuses stlProjection.ts's buildLoops (edge chaining) and dp
// (Douglas-Peucker simplification) - the SAME primitives already used for
// deriveModelBodyProfile/deriveModelBodySection's slice-plane extraction -
// rather than a parallel simplification implementation.
export interface ModelBodyFaceResult {
  /** World-space Loop2D[] bounding the picked face - typically one outer
   *  contour, plus 'hole' loops for any through-openings the face carries. */
  loops: Loop2D[]
  /** The face's world Z (for a wizard readout / sanity display only - the
   *  loops themselves are the authoritative result). */
  z: number
}

/** mm tolerance for "this face's vertices are coplanar at a single Z" -
 *  matches this file's SECTION_Z_EPS sibling constant/rationale. */
const FACE_Z_EPS = 1e-3
/** mm snap grid for boundary-edge vertex matching - identical value to
 *  stlProjection.ts's own SNAP constant (10 microns), so two edges that
 *  stlProjection would consider "the same vertex" are treated the same way
 *  here. Not imported (stlProjection keeps it private); duplicated as a
 *  named constant rather than a magic number, same precedent this file's
 *  LEGACY_MODEL_ITEM_ID constant already sets for "replicated, not shared". */
const FACE_BOUNDARY_SNAP = 0.01

/**
 * Derive a SINGLE PICKED FACE's boundary on a modeled body as world-space
 * Loop2D[], keyed by the face's ElementMap stableId. `placementRecords`
 * mirrors deriveModelBodyProfile/deriveModelBodySection's own purity
 * contract (the project's `modelItemPlacements` array, passed explicitly).
 */
export function deriveModelBodyFace(
  geo: ImportedGeometry,
  faceStableId: string,
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
): ModelBodyFaceResult {
  if (!isModelOriginGeometry(geo)) {
    throw new ModelBodyDeriveError(
      `deriveModelBodyFace: "${geo.name}" is not a modeled body (format "${geo.format}").`,
    )
  }

  const display = geo.modelBody?.display
  if (!display || display.positions.length === 0 || display.indices.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}" has no tessellated geometry yet to derive a face boundary from - open the ` +
        `Model tab once so it can regenerate, then try again.`,
    )
  }
  if (!display.faceIds || !display.triFace || display.faceIds.length === 0 || display.triFace.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}" has no per-face identity data yet (this body has not been re-synced since ` +
        `CAM-BINDING Stage 5 shipped) - open the Model tab once so it can regenerate, then try again.`,
    )
  }
  const faceIndex = display.faceIds.indexOf(faceStableId)
  if (faceIndex === -1) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the picked face ("${faceStableId}") no longer exists on this body's current ` +
        `tessellation - the feature that produced it may have been edited or removed.`,
    )
  }

  const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const bodyId = geo.modelBody?.ref.bodyId
  let frame: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }
  try {
    frame = resolveModelReferenceFrame(placementRecords, itemId, bodyId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ModelBodyDeriveError(
      `"${geo.name}" could not resolve its world placement (${message}). ` +
        `This should not happen for a live, synced model body - re-sync (open the Model tab) and retry.`,
    )
  }

  // WO-1561: a tilted or flipped Placement bakes the full placement into the
  // mesh first, so the face is traced in world XY exactly as on the placed
  // body; only a face that is not horizontal AS PLACED is refused. A
  // Z-preserving Placement keeps the local trace + XY rotation below.
  const tilted = isTiltedOffZ(frame.rotation)
  const positions = tilted ? placedWorldPositions(display.positions, frame) : display.positions
  const indices = display.indices
  const triFace = display.triFace
  const triCount = Math.floor(indices.length / 3)

  const faceTriangles: number[] = []
  for (let t = 0; t < triCount; t++) {
    if (triFace[t] === faceIndex) faceTriangles.push(t)
  }
  if (faceTriangles.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the picked face has no triangles in the current tessellation - re-sync ` +
        `(open the Model tab) and try picking again.`,
    )
  }

  // Planar + Z-normal check (ADR 0018 D5's rule, applied to this ONE face's
  // vertices instead of a kernel surface-type query - see file header).
  let minLocalZ = Infinity, maxLocalZ = -Infinity
  for (const t of faceTriangles) {
    for (let k = 0; k < 3; k++) {
      const vi = indices[t * 3 + k]
      const z = positions[vi * 3 + 2]
      if (z < minLocalZ) minLocalZ = z
      if (z > maxLocalZ) maxLocalZ = z
    }
  }
  if (tilted && maxLocalZ - minLocalZ > FACE_Z_EPS) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the picked face ("${faceStableId}") is not flat and horizontal as placed - its ` +
        `vertices span ${(maxLocalZ - minLocalZ).toFixed(4)} mm of world Z, so the face itself is tilted ` +
        `or curved at the body's placement. Only a planar face lying horizontal can become a machining ` +
        `boundary (ADR 0018 D5) - pick a face that is flat and level on the placed body.`,
    )
  }
  if (maxLocalZ - minLocalZ > FACE_Z_EPS) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the picked face is not a flat, horizontal (Z-normal) face - its vertices ` +
        `span ${(maxLocalZ - minLocalZ).toFixed(4)} mm of local Z. Only planar, horizontal faces ` +
        `can become a machining boundary (the same rule an imported STEP part's Pick Face already ` +
        `enforces, ADR 0018 D5) - pick a flat top/bottom/step face instead.`,
    )
  }

  // Boundary-edge extraction over this face's OWN triangle subset only (see
  // file header for the algorithm). Sign/winding-independent by construction.
  const keyOf = (x: number, y: number) => `${Math.round(x / FACE_BOUNDARY_SNAP)},${Math.round(y / FACE_BOUNDARY_SNAP)}`
  const seen = new Map<string, { ax: number; ay: number; bx: number; by: number }>()
  const bumpEdge = (i0: number, i1: number) => {
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1]
    const bx = positions[i1 * 3], by = positions[i1 * 3 + 1]
    const ka = keyOf(ax, ay), kb = keyOf(bx, by)
    if (ka === kb) return // degenerate (zero-length in-plane) edge
    const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
    if (seen.has(edgeKey)) { seen.delete(edgeKey); return } // seen twice -> interior, drop
    seen.set(edgeKey, { ax, ay, bx, by })
  }
  for (const t of faceTriangles) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2]
    bumpEdge(i0, i1)
    bumpEdge(i1, i2)
    bumpEdge(i2, i0)
  }
  const boundarySegs: Array<[{ x: number; y: number }, { x: number; y: number }]> = [...seen.values()].map(
    (e) => [{ x: e.ax, y: e.ay }, { x: e.bx, y: e.by }],
  )
  if (boundarySegs.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the picked face produced no boundary edges to trace - it may be a fully ` +
        `interior or non-manifold patch of the mesh.`,
    )
  }

  const rawChains = buildLoops(boundarySegs)
  const consumedPoints = rawChains.reduce((sum, chain) => sum + chain.length, 0)
  if (consumedPoints < boundarySegs.length) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the picked face's boundary did not close into a loop - this may be a ` +
        `non-manifold or degenerate part of the mesh. Re-sync (open the Model tab) and try again.`,
    )
  }

  const tol = DEFAULT_SIMPLIFICATION_TOLERANCE
  const minPerim = minPerimeterFor(tol)
  const rawLocalLoops: Loop2D[] = []
  for (const chain of rawChains) {
    if (chain.length < 3) continue
    const simplified = dp(chain, tol)
    if (simplified.length < 3) continue
    const perim = simplified.reduce((s, p, i) => {
      const n = simplified[(i + 1) % simplified.length]
      return s + Math.hypot(n.x - p.x, n.y - p.y)
    }, 0)
    if (perim < minPerim) continue
    rawLocalLoops.push({
      id: '',
      points: simplified.map((p) => ({ x: p.x, y: p.y })),
      closed: true,
      type: 'contour', // placeholder - reclassifyLoopsByNesting below is authoritative
      layerId: 'model_face_layer',
      area: polygonArea(simplified),
    })
  }
  if (rawLocalLoops.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the picked face produced no loop large enough to machine (every candidate ` +
        `loop was below the minimum-perimeter simplification floor).`,
    )
  }
  const localLoops = reclassifyLoopsByNesting(rawLocalLoops)

  if (tilted) return { loops: localLoops, z: (minLocalZ + maxLocalZ) / 2 }

  const pose: GeoPose = { position: frame.position, rotation: frame.rotation }
  const loops: Loop2D[] = localLoops.map((loop) => ({
    ...loop,
    points: transformLoopPoints(loop.points, pose),
  }))

  return { loops, z: (minLocalZ + maxLocalZ) / 2 + frame.position.z }
}

// ---------------------------------------------------------------------------
// CAM-DRILL-ADAPTER: deriveModelBodyDrillTargets
// ---------------------------------------------------------------------------
//
// Maps a modeled body + the Model kernel's own hole recognition
// (GeomService.recognizeFeatures / GEO-6, the SAME query resize-hole uses)
// into the drill centres / depths the existing drill builder consumes.
//
// IDENTITY BOUNDARY: never touches occt-model. Consumes FeatureVerdict[] the
// caller already obtained from the Model kernel (GeomEngine/GeomClient), so
// this module stays pure and free of any live kernel handle. Wizard + store
// compute supply the verdicts; unit tests feed real GeomEngine results.
//
// DO NOT invent a second hole detector. Eligibility for "is this a drillable
// hole" matches resize-hole's closed set (through / blind / counterbore) plus
// a finite positive diameter, then additionally requires a Z-parallel axis
// (drill ops are 2.5D plunge on XY centres).

/** Same closed hole classes UI-58 resize-hole recognizes (ResizeHoleDialog). */
export const MODEL_DRILL_HOLE_CLASSES = [
  'throughHole',
  'blindHole',
  'counterboreStack',
] as const satisfies readonly FeatureClass[]

const MODEL_DRILL_HOLE_CLASS_SET = new Set<string>(MODEL_DRILL_HOLE_CLASSES)

/** Axis must be within this of world +/-Z (cos tolerance) for 2.5D drill. */
const DRILL_AXIS_Z_DOT_MIN = 0.99

export interface ModelDrillTarget {
  /** Geometry-derived hole key from recognizeFeatures (stable across runs for
   *  identical geometry; diameter-dependent trailing segment per BK-174). */
  featureKey: string
  featureClass: (typeof MODEL_DRILL_HOLE_CLASSES)[number]
  /** World-space hole centre XY (Placement-baked). */
  centerX: number
  centerY: number
  diameter: number
  /** Normalized Model-kernel cylinder axis. Drill/Bore currently require it
   * to be world +/-Z-parallel; retained explicitly for selected-wall truth. */
  axis: [number, number, number]
  /** World-space top of the cylindrical wall / entry rim. */
  topZ: number
  /** World-space bottom of the cylindrical wall (blind floor or through exit). */
  bottomZ: number
  through: boolean
  /** ElementMap face ids that define this hole (CAM-1 re-resolution ids). */
  faceIds: string[]
  /** Placement-independent topology identity shared by wizard landing and
   * every live compute re-derive. */
  sourceIdentity: NonNullable<HoleFeature['sourceIdentity']>
}

export interface ModelBodyDrillDeriveResult {
  targets: ModelDrillTarget[]
  /** One CCW circle Loop2D per target (same 64-pt shape the STEP hole path
   *  builds) so buildDrillToolpath's centroid path works unchanged. */
  loops: Loop2D[]
  /** Parallel HoleFeature records (loopId linked by index after the caller
   *  stamps stable loop ids) for per-hole bottoms / wizard depth UI. */
  holes: HoleFeature[]
  /** Max target topZ (layer projection plane Z, matching STEP holes landing). */
  z: number
}

function parseHoleKeyCenter(featureKey: string): { x: number; y: number; z: number } | undefined {
  // Successful keys: hole:cx:cy:cz:ax:ay:az:r  (defeature.ts)
  // Refused keys:   hole-refused:cx:cy:cz:ax:ay:az (no r)
  const parts = featureKey.split(':')
  if (parts.length < 4) return undefined
  if (parts[0] !== 'hole' && parts[0] !== 'hole-refused') return undefined
  const x = Number(parts[1])
  const y = Number(parts[2])
  const z = Number(parts[3])
  if (![x, y, z].every((n) => Number.isFinite(n))) return undefined
  return { x, y, z }
}

/** A hole's own measured geometry. With `R` (a tilted or flipped Placement,
 *  WO-1561) the centre and axis come back turned by the placement rotation -
 *  translation is still the caller's - and the Z-parallel test applies to the
 *  hole AS PLACED. */
function holeLocalGeometry(verdict: FeatureVerdict, R?: RotationMatrix): {
  featureClass: (typeof MODEL_DRILL_HOLE_CLASSES)[number]
  centerX: number
  centerY: number
  centerZ: number
  diameter: number
  depth: number
  axisX: number
  axisY: number
  axisZ: number
  through: boolean
  topZ: number
  bottomZ: number
} | { refuse: string } {
  if (!MODEL_DRILL_HOLE_CLASS_SET.has(verdict.featureClass)) {
    return { refuse: `not a recognized hole class (${verdict.featureClass})` }
  }
  if (!verdict.removable) {
    return { refuse: verdict.refuseReason ?? 'recognizer refused this hole' }
  }
  const diameter = Number(verdict.params.diameter)
  if (!(Number.isFinite(diameter) && diameter > 0)) {
    return { refuse: 'recognized hole has no finite positive diameter' }
  }
  const depth = Number(verdict.params.depth)
  if (!(Number.isFinite(depth) && depth > 0)) {
    return { refuse: 'recognized hole has no finite positive depth' }
  }
  const axisX = Number(verdict.params.axisX)
  const axisY = Number(verdict.params.axisY)
  const axisZ = Number(verdict.params.axisZ)
  if (![axisX, axisY, axisZ].every((n) => Number.isFinite(n))) {
    return { refuse: 'recognized hole has no resolvable axis' }
  }
  const axisLen = Math.hypot(axisX, axisY, axisZ)
  if (!(axisLen > 0.5)) {
    return { refuse: 'recognized hole axis is degenerate' }
  }
  let nz = axisZ / axisLen
  let nx = axisX / axisLen
  let ny = axisY / axisLen
  if (R) [nx, ny, nz] = rotateVec(R, nx, ny, nz)
  if (Math.abs(nz) < DRILL_AXIS_Z_DOT_MIN) {
    return {
      refuse: R
        ? `hole axis is tilted off world Z at the body's placement (|nz|=${Math.abs(nz).toFixed(3)}); ` +
          `drill targets require a hole that is vertical as placed`
        : `hole axis is tilted off Z (|nz|=${Math.abs(nz).toFixed(3)}); drill targets require Z-parallel holes`,
    }
  }

  // Prefer explicit center params (refuseHole already exposes them); fall back
  // to the geometry-derived featureKey segments the recognizer always stamps.
  let cx = Number(verdict.params.centerX)
  let cy = Number(verdict.params.centerY)
  let cz = Number(verdict.params.centerZ)
  if (![cx, cy, cz].every((n) => Number.isFinite(n))) {
    const parsed = parseHoleKeyCenter(verdict.featureKey)
    if (!parsed) {
      return { refuse: `could not read hole centre from featureKey "${verdict.featureKey}"` }
    }
    cx = parsed.x
    cy = parsed.y
    cz = parsed.z
  }
  if (R) [cx, cy, cz] = rotateVec(R, cx, cy, cz)

  const featureClass = verdict.featureClass as (typeof MODEL_DRILL_HOLE_CLASSES)[number]
  const through = featureClass === 'throughHole'
  // Entry rim is at (cx,cy,cz); hole body extends along -axis (into material).
  // For +Z host normal: bottom = cz - depth. For -Z host (seeded from underside):
  // bottom = cz - (-1)*depth = cz + depth, then top/bottom swap via min/max.
  const along = cz - nz * depth
  const topZ = Math.max(cz, along)
  const bottomZ = Math.min(cz, along)

  return {
    featureClass,
    centerX: cx,
    centerY: cy,
    centerZ: cz,
    diameter,
    depth,
    axisX: nx,
    axisY: ny,
    axisZ: nz,
    through,
    topZ,
    bottomZ,
  }
}

function circleLoopPoints(cx: number, cy: number, radius: number, n = 64): Array<{ x: number; y: number }> {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) }
  })
}

/**
 * Derive drill targets from a modeled body using the Model kernel's prior
 * `recognizeFeatures` verdicts (caller supplies them). Pure: no store, no
 * DOM, no async kernel handle.
 *
 * Throws ModelBodyDeriveError (ADR-0003) when the body is not model-origin,
 * Placement/resolution fails, recognition found zero holes that are
 * Z-parallel as placed, or a required measured param is missing.
 */
export function deriveModelBodyDrillTargets(
  geo: ImportedGeometry,
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
  verdicts: readonly FeatureVerdict[],
): ModelBodyDrillDeriveResult {
  if (!isModelOriginGeometry(geo)) {
    throw new ModelBodyDeriveError(
      `deriveModelBodyDrillTargets: "${geo.name}" is not a modeled body (format "${geo.format}").`,
    )
  }
  if (!Array.isArray(verdicts)) {
    throw new ModelBodyDeriveError(
      `deriveModelBodyDrillTargets: recognition verdicts are required (got ${String(verdicts)}).`,
    )
  }

  const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const bodyId = geo.modelBody?.ref.bodyId
  let frame: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }
  try {
    frame = resolveModelReferenceFrame(placementRecords, itemId, bodyId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ModelBodyDeriveError(
      `"${geo.name}" could not resolve its world placement (${message}). ` +
        `Re-sync (open the Model tab) and retry.`,
    )
  }
  // WO-1561: a tilted or flipped Placement turns each hole's centre and axis
  // by the full rotation; a hole that ends up vertical drills, one that does
  // not is refused by its own key. A Z-preserving Placement keeps the XY
  // rotation below.
  const R = isTiltedOffZ(frame.rotation) ? rotationMatrixXYZ(frame.rotation) : undefined
  const pose: GeoPose = { position: frame.position, rotation: frame.rotation }
  const targets: ModelDrillTarget[] = []
  const refusals: string[] = []

  for (const verdict of verdicts) {
    if (!MODEL_DRILL_HOLE_CLASS_SET.has(verdict.featureClass)) continue
    const geom = holeLocalGeometry(verdict, R)
    if ('refuse' in geom) {
      refusals.push(`${verdict.featureKey}: ${geom.refuse}`)
      continue
    }
    let worldXY: { x: number; y: number }
    let worldAxis: [number, number, number]
    if (R) {
      worldXY = { x: geom.centerX + frame.position.x, y: geom.centerY + frame.position.y }
      worldAxis = [geom.axisX, geom.axisY, geom.axisZ]
    } else {
      ;[worldXY] = transformLoopPoints([{ x: geom.centerX, y: geom.centerY }], pose)
      const rz = frame.rotation.z * Math.PI / 180
      worldAxis = [
        geom.axisX * Math.cos(rz) - geom.axisY * Math.sin(rz),
        geom.axisX * Math.sin(rz) + geom.axisY * Math.cos(rz),
        geom.axisZ,
      ]
    }
    const topZ = geom.topZ + frame.position.z
    const bottomZ = geom.bottomZ + frame.position.z
    const faceIds = [...(verdict.faceIds ?? [])].map(String).sort()
    const sourceFingerprint = smartHeightEvidenceFingerprint({
      featureKey: verdict.featureKey,
      featureClass: geom.featureClass,
      diameter: geom.diameter,
      through: geom.through,
      faceIds,
    })
    targets.push({
      featureKey: verdict.featureKey,
      featureClass: geom.featureClass,
      centerX: worldXY.x,
      centerY: worldXY.y,
      diameter: geom.diameter,
      axis: worldAxis,
      topZ,
      bottomZ,
      through: geom.through,
      faceIds,
      sourceIdentity: {
        stableId: verdict.featureKey,
        sourceVersion: 1,
        sourceFingerprint,
        evidenceFrame: 'world',
      },
    })
  }

  // Deterministic order (matches recognizer sort by featureKey).
  targets.sort((a, b) => (a.featureKey < b.featureKey ? -1 : a.featureKey > b.featureKey ? 1 : 0))

  if (targets.length === 0) {
    const detail = refusals.length > 0
      ? ` Recognizer returned hole-class features but none were drillable: ${refusals.slice(0, 3).join('; ')}.`
      : ' Recognizer found no through, blind, or counterbore holes on this body.'
    throw new ModelBodyDeriveError(
      `"${geo.name}": no drill targets from Model hole recognition.${detail}`,
    )
  }

  const loops: Loop2D[] = targets.map((t, i) => {
    const rr = t.diameter / 2
    const points = circleLoopPoints(t.centerX, t.centerY, rr)
    return {
      id: '',
      points,
      closed: true,
      type: 'contour' as const,
      layerId: 'model_drill_holes',
      area: Math.PI * rr * rr,
      name: `Hole ${i + 1} dia ${t.diameter.toFixed(3)}`,
    }
  })

  const holes: HoleFeature[] = targets.map((t) => ({
    center: [t.centerX, t.centerY],
    diameter: t.diameter,
    topZ: t.topZ,
    bottomZ: t.bottomZ,
    through: t.through,
    sourceIdentity: { ...t.sourceIdentity },
  }))

  const z = Math.max(...targets.map((t) => t.topZ))
  return { targets, loops, holes, z }
}

// ---------------------------------------------------------------------------
// Q-87: selected modeled-body cylindrical wall -> Bore target
// ---------------------------------------------------------------------------

const MODEL_BORE_LAYER_ID = 'model_bore_target'
const MODEL_BORE_DIAMETER_TOLERANCE = 0.001

export function modelBoreLoopId(faceStableId: string): string {
  return `mbore:${faceStableId}`
}

export interface ModelBodyBoreTargetResult {
  target: ModelDrillTarget & { depth: number }
  loop: Loop2D
  cylinder: CylinderFeature
  /** Model-body-local Z values, suitable for selectedFaceZ persistence. */
  localTopZ: number
  localBottomZ: number
}

/**
 * Convert one explicitly selected Model-kernel face into the exact ephemeral
 * loop/cylinder facts the existing Bore builder consumes. The face snapshot
 * proves analytic cylindricity; the recognizer proves the wall is an internal
 * hole rather than a visually similar external boss. Nothing is persisted.
 */
export function deriveModelBodyBoreTarget(
  geo: ImportedGeometry,
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
  faceStableId: string,
  snapshot: GeometrySnapshot,
  verdicts: readonly FeatureVerdict[],
): ModelBodyBoreTargetResult {
  if (snapshot.type !== 'cylinder') {
    throw new ModelBodyDeriveError(
      `Bore: selected Model face "${faceStableId}" is not cylindrical (${snapshot.type}). ` +
        'Pick an internal cylindrical wall.',
    )
  }
  if (!Array.isArray(snapshot.axis) || snapshot.axis.length !== 3 ||
      !snapshot.axis.every(Number.isFinite)) {
    throw new ModelBodyDeriveError(
      `Bore: selected cylinder "${faceStableId}" is missing its analytic axis facts. Re-sync the model and retry.`,
    )
  }
  if (!Array.isArray(snapshot.axisPoint) || snapshot.axisPoint.length !== 3 ||
      !snapshot.axisPoint.every(Number.isFinite)) {
    throw new ModelBodyDeriveError(
      `Bore: selected cylinder "${faceStableId}" is missing its analytic axis point facts. Re-sync the model and retry.`,
    )
  }
  if (!(Number.isFinite(snapshot.radius) && Number(snapshot.radius) > 0)) {
    throw new ModelBodyDeriveError(
      `Bore: selected cylinder "${faceStableId}" is missing a finite positive radius. Re-sync the model and retry.`,
    )
  }

  const matches = verdicts.filter((verdict) =>
    (verdict.faceIds ?? []).map(String).includes(faceStableId),
  )
  if (matches.length === 0) {
    throw new ModelBodyDeriveError(
      `Bore: selected cylinder "${faceStableId}" is not proven to be an internal hole wall. ` +
        'It may be an external boss or an unrecognized/ambiguous cylinder.',
    )
  }
  if (matches.length > 1) {
    throw new ModelBodyDeriveError(
      `Bore: selected cylinder "${faceStableId}" is ambiguous - it belongs to ${matches.length} recognized features.`,
    )
  }
  const verdict = matches[0]
  if (verdict.featureClass === 'boss') {
    throw new ModelBodyDeriveError(
      `Bore: selected cylinder "${faceStableId}" is an external boss. Pick an internal cylindrical hole wall instead.`,
    )
  }
  if (!MODEL_DRILL_HOLE_CLASS_SET.has(verdict.featureClass)) {
    throw new ModelBodyDeriveError(
      `Bore: selected cylinder "${faceStableId}" is not a recognized internal hole ` +
        `(feature class ${verdict.featureClass}).`,
    )
  }

  const derived = deriveModelBodyDrillTargets(geo, placementRecords, [verdict])
  if (derived.targets.length !== 1 || derived.loops.length !== 1) {
    throw new ModelBodyDeriveError(
      `Bore: selected cylinder "${faceStableId}" did not resolve to exactly one internal hole target.`,
    )
  }
  const baseTarget = derived.targets[0]
  const snapshotDiameter = Number(snapshot.radius) * 2
  if (Math.abs(snapshotDiameter - baseTarget.diameter) > MODEL_BORE_DIAMETER_TOLERANCE) {
    throw new ModelBodyDeriveError(
      `Bore: selected wall diameter ${snapshotDiameter.toFixed(3)} does not match the recognized ` +
        `hole diameter ${baseTarget.diameter.toFixed(3)}. Pick the intended internal cylindrical wall.`,
    )
  }
  const snapshotAxisLength = Math.hypot(...snapshot.axis)
  if (!(snapshotAxisLength > 0.5)) {
    throw new ModelBodyDeriveError(`Bore: selected cylinder "${faceStableId}" has a degenerate axis.`)
  }
  const snapshotAxis: [number, number, number] = [
    snapshot.axis[0] / snapshotAxisLength,
    snapshot.axis[1] / snapshotAxisLength,
    snapshot.axis[2] / snapshotAxisLength,
  ]
  const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const frame = resolveModelReferenceFrame(placementRecords, itemId, geo.modelBody?.ref.bodyId)
  let snapshotWorldAxis: [number, number, number]
  if (isTiltedOffZ(frame.rotation)) {
    snapshotWorldAxis = rotateVec(rotationMatrixXYZ(frame.rotation), ...snapshotAxis)
  } else {
    const rz = frame.rotation.z * Math.PI / 180
    snapshotWorldAxis = [
      snapshotAxis[0] * Math.cos(rz) - snapshotAxis[1] * Math.sin(rz),
      snapshotAxis[0] * Math.sin(rz) + snapshotAxis[1] * Math.cos(rz),
      snapshotAxis[2],
    ]
  }
  const axisDot = Math.abs(
    snapshotWorldAxis[0] * baseTarget.axis[0] +
    snapshotWorldAxis[1] * baseTarget.axis[1] +
    snapshotWorldAxis[2] * baseTarget.axis[2],
  )
  if (axisDot < DRILL_AXIS_Z_DOT_MIN) {
    throw new ModelBodyDeriveError(
      `Bore: selected cylinder "${faceStableId}" axis does not match the recognized internal hole axis.`,
    )
  }

  const loopId = modelBoreLoopId(faceStableId)
  const loop: Loop2D = {
    ...derived.loops[0],
    id: loopId,
    layerId: MODEL_BORE_LAYER_ID,
    name: `Bore dia ${baseTarget.diameter.toFixed(3)}`,
  }
  const depth = baseTarget.topZ - baseTarget.bottomZ
  // baseTarget.axis is already transformed into the model item's world frame.
  // The snapshot axis above is local and is used only to cross-check identity.
  const target = { ...baseTarget, depth }
  const cylinder: CylinderFeature = {
    center: [baseTarget.centerX, baseTarget.centerY],
    diameter: baseTarget.diameter,
    topZ: baseTarget.topZ,
    bottomZ: baseTarget.bottomZ,
    through: baseTarget.through,
    kind: 'bore',
    loopId,
    sourceIdentity: { ...baseTarget.sourceIdentity },
  }
  return {
    target,
    loop,
    cylinder,
    localTopZ: baseTarget.topZ - frame.position.z,
    localBottomZ: baseTarget.bottomZ - frame.position.z,
  }
}

// ---------------------------------------------------------------------------
// WO-336: any circular feature (bore OR boss) -> Setup zero-point centre
// ---------------------------------------------------------------------------
//
// A SEPARATE, narrower derive from deriveModelBodyBoreTarget above -- that
// function (and its "external boss" refusal) is UNTOUCHED and still the ONLY
// path an actual Bore CUTTING operation (NewOperationModalBody) can take; you
// cannot bore into solid material, so a boss must never seed a Bore toolpath.
// This is used ONLY by the Setup-origin zero-point pick (store/index.ts
// resolveSetupBoreOriginPick), where "give me a centre and a top rim to zero
// on" is equally honest for a bore wall or a boss wall.
//
// ACCEPTED: an internal hole wall (delegates verbatim to
// deriveModelBodyBoreTarget) OR an external boss whose recognized feature
// class is 'boss' AND whose base-loop footprint on its host face is a FULL
// circle -- cross-checked against the wall's OWN analytic diameter
// (snapshot.radius), never read from the loop's bounding box directly (that
// bbox is only ever used as a consistency GATE against the honest analytic
// facts, exactly like deriveModelBodyBoreTarget's own diameter cross-check
// above). The centre itself always comes from the picked face's analytic
// axisPoint; the top/bottom rim comes from that SAME face's own tessellated
// triangles (real geometry, not an estimate) -- never a bounding-box guess.
//
// REFUSED, by name: a cone (its cross-section, and its centre, changes
// continuously along its axis -- there is no single point to call "the"
// centre); any recognized feature class other than a hole or 'boss' (fillet/
// chamfer/pocket/sliver/engraved text -- none has a circular centre at all);
// a cylindrical face the recognizer could not attach to any feature
// (unproven/ambiguous, same bar as a bore wall); a PARTIAL cylindrical wall
// masquerading as a boss -- e.g. a D-shaped island (round on one side, flat
// on the other) still reports surfaceType 'cylinder' for its curved face, but
// its base loop's span in the flat-cut direction is shorter than its wall's
// own diameter, which the cross-check above catches and refuses; a tilted
// Placement or a non-Z-parallel axis (same "Z0 at the rim" precondition the
// bore path already requires).
//
// OUT OF SCOPE, not a code refusal: a circular EDGE (as opposed to a face) --
// the viewport picker this module is fed by only ever resolves a FACE pick
// (SetupModal's resolveBoreFaceOwner requires `sel.isModelFace`); picking an
// edge would need new pick-target machinery the picker does not have, not a
// change to this derive.
export interface ModelBodyCircularOriginResult {
  /** which accepted path produced this result -- purely informational. */
  faceKind: 'bore' | 'boss'
  /** world-space centre X/Y. */
  center: [number, number]
  /** world-space top rim Z (Z0 target). */
  topZ: number
  /** world-space bottom Z (bore floor / boss base). */
  bottomZ: number
  diameter: number
}

/** mm tolerance for "this boss's base-loop wire bbox equals its wall's own
 *  analytic diameter in both directions" -- the full-circumference gate. Both
 *  quantities are exact B-rep facts (a wire bbox and a cylinder radius), not
 *  mesh estimates, so this can be as tight as deriveModelBodyBoreTarget's own
 *  MODEL_BORE_DIAMETER_TOLERANCE; kept as its own named constant since the
 *  two checks guard different geometry. */
const MODEL_BOSS_SPAN_TOLERANCE = 0.01 // mm

export function deriveModelBodyCircularOrigin(
  geo: ImportedGeometry,
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
  faceStableId: string,
  snapshot: GeometrySnapshot,
  verdicts: readonly FeatureVerdict[],
): ModelBodyCircularOriginResult {
  if (snapshot.type !== 'cylinder') {
    throw new ModelBodyDeriveError(
      `Zero: selected Model face "${faceStableId}" is not cylindrical (${snapshot.type}). ` +
        'Pick a bore wall or a boss (a full external cylindrical wall).',
    )
  }

  const matches = verdicts.filter((verdict) => (verdict.faceIds ?? []).map(String).includes(faceStableId))
  if (matches.length === 0) {
    throw new ModelBodyDeriveError(
      `Zero: selected cylinder "${faceStableId}" is not proven to be a recognized circular feature ` +
        '(hole or boss). It may be an unrecognized or ambiguous cylinder.',
    )
  }
  if (matches.length > 1) {
    throw new ModelBodyDeriveError(
      `Zero: selected cylinder "${faceStableId}" is ambiguous - it belongs to ${matches.length} recognized features.`,
    )
  }
  const verdict = matches[0]

  if (MODEL_DRILL_HOLE_CLASS_SET.has(verdict.featureClass)) {
    const bore = deriveModelBodyBoreTarget(geo, placementRecords, faceStableId, snapshot, verdicts)
    return {
      faceKind: 'bore',
      center: bore.cylinder.center,
      topZ: bore.cylinder.topZ,
      bottomZ: bore.cylinder.bottomZ,
      diameter: bore.cylinder.diameter,
    }
  }
  if (verdict.featureClass !== 'boss') {
    throw new ModelBodyDeriveError(
      `Zero: selected cylinder "${faceStableId}" is not a recognized bore or boss ` +
        `(feature class "${verdict.featureClass}") - no single well-defined centre.`,
    )
  }

  if (!Array.isArray(snapshot.axis) || snapshot.axis.length !== 3 ||
      !snapshot.axis.every(Number.isFinite)) {
    throw new ModelBodyDeriveError(
      `Zero: selected boss wall "${faceStableId}" is missing its analytic axis facts. Re-sync the model and retry.`,
    )
  }
  if (!Array.isArray(snapshot.axisPoint) || snapshot.axisPoint.length !== 3 ||
      !snapshot.axisPoint.every(Number.isFinite)) {
    throw new ModelBodyDeriveError(
      `Zero: selected boss wall "${faceStableId}" is missing its analytic axis point facts. Re-sync the model and retry.`,
    )
  }
  if (!(Number.isFinite(snapshot.radius) && Number(snapshot.radius) > 0)) {
    throw new ModelBodyDeriveError(
      `Zero: selected boss wall "${faceStableId}" is missing a finite positive radius. Re-sync the model and retry.`,
    )
  }
  const diameter = Number(snapshot.radius) * 2

  // Full-circumference gate: the boss's base-loop wire bbox (an honest,
  // exact B-rep fact from the recognizer, NEVER used as the centre itself)
  // must equal the wall's own analytic diameter in BOTH directions. A
  // partial wall (D-shaped island) fails this in the flat-cut direction.
  const spanX = Number(verdict.params.spanX)
  const spanY = Number(verdict.params.spanY)
  if (!Number.isFinite(spanX) || !Number.isFinite(spanY)) {
    throw new ModelBodyDeriveError(
      `Zero: selected boss "${faceStableId}" is missing its base-loop span facts. Re-sync the model and retry.`,
    )
  }

  const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const bodyId = geo.modelBody?.ref.bodyId
  let frame: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }
  try {
    frame = resolveModelReferenceFrame(placementRecords, itemId, bodyId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ModelBodyDeriveError(
      `"${geo.name}" could not resolve its world placement (${message}). ` +
        `This should not happen for a live, synced model body - re-sync (open the Model tab) and retry.`,
    )
  }
  // WO-1561: a tilted or flipped Placement turns the boss axis, axis point
  // and wall mesh by the full placement; the boss is judged AS PLACED.
  const R = isTiltedOffZ(frame.rotation) ? rotationMatrixXYZ(frame.rotation) : undefined

  const axisLen = Math.hypot(snapshot.axis[0], snapshot.axis[1], snapshot.axis[2])
  if (!(axisLen > 0.5)) {
    throw new ModelBodyDeriveError(`Zero: selected boss wall "${faceStableId}" has a degenerate axis.`)
  }
  const localAxis: [number, number, number] = [snapshot.axis[0] / axisLen, snapshot.axis[1] / axisLen, snapshot.axis[2] / axisLen]
  if (R) {
    const worldNz = rotateVec(R, ...localAxis)[2]
    if (Math.abs(worldNz) < DRILL_AXIS_Z_DOT_MIN) {
      throw new ModelBodyDeriveError(
        `Zero: selected boss "${faceStableId}" axis is tilted off world Z at the body's placement ` +
          `(|nz|=${Math.abs(worldNz).toFixed(3)}); a Setup zero point requires a circular feature that is vertical as placed.`,
      )
    }
  } else {
    // A pure Z-axis Placement rotation never changes a vector's Z component, so
    // the LOCAL axis's own Z component IS the world axis's Z component -- no
    // rotation needed to test Z-parallelism (same invariant this file's other
    // derives use for position).
    const worldAxisNz = snapshot.axis[2] / axisLen
    if (Math.abs(worldAxisNz) < DRILL_AXIS_Z_DOT_MIN) {
      throw new ModelBodyDeriveError(
        `Zero: selected boss "${faceStableId}" axis is tilted off Z (|nz|=${Math.abs(worldAxisNz).toFixed(3)}); ` +
          'a Setup zero point requires a vertical (Z-parallel) circular feature.',
      )
    }
  }

  // The recognizer measures the base loop's span along LOCAL X and Y. A full
  // circle of diameter d whose normal is the unit axis n spans d*sqrt(1-n_i^2)
  // along axis i, so a boss the body carries off its local Z (a part modelled
  // on its side, stood up by its Placement) is held to the spans a full circle
  // at that orientation has. An upright body keeps the plain d x d gate.
  const expectedSpanX = R ? diameter * Math.sqrt(Math.max(0, 1 - localAxis[0] * localAxis[0])) : diameter
  const expectedSpanY = R ? diameter * Math.sqrt(Math.max(0, 1 - localAxis[1] * localAxis[1])) : diameter
  if (Math.abs(spanX - expectedSpanX) > MODEL_BOSS_SPAN_TOLERANCE || Math.abs(spanY - expectedSpanY) > MODEL_BOSS_SPAN_TOLERANCE) {
    throw new ModelBodyDeriveError(
      `Zero: selected boss "${faceStableId}" is not a full circular wall - its base outline ` +
        `(${spanX.toFixed(3)} x ${spanY.toFixed(3)} mm) does not match its wall diameter ` +
        `${diameter.toFixed(3)} mm in both directions. Pick a fully round boss.`,
    )
  }

  // Top/bottom rim: read directly off this ONE face's own triangles in the
  // live tessellation (the same honest source deriveModelBodyFace uses for
  // its planarity check) -- never the boss verdict's own `depth` param, which
  // is a crude 2x-mean-face-offset estimate over the WHOLE island (wall +
  // top cap together), not a measurement of this wall alone.
  const display = geo.modelBody?.display
  if (!display || !display.faceIds || !display.triFace || display.faceIds.length === 0 || display.triFace.length === 0) {
    throw new ModelBodyDeriveError(
      `"${geo.name}" has no per-face identity data yet for its boss wall - open the Model tab once so it can regenerate, then try again.`,
    )
  }
  const faceIndex = display.faceIds.indexOf(faceStableId)
  if (faceIndex === -1) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the picked boss wall ("${faceStableId}") no longer exists on this body's current tessellation.`,
    )
  }
  const positions = R ? placedWorldPositions(display.positions, frame) : display.positions
  const indices = display.indices
  const triFace = display.triFace
  const triCount = Math.floor(indices.length / 3)
  let minLocalZ = Infinity
  let maxLocalZ = -Infinity
  for (let t = 0; t < triCount; t++) {
    if (triFace[t] !== faceIndex) continue
    for (let k = 0; k < 3; k++) {
      const vi = indices[t * 3 + k]
      const z = positions[vi * 3 + 2]
      if (z < minLocalZ) minLocalZ = z
      if (z > maxLocalZ) maxLocalZ = z
    }
  }
  if (!Number.isFinite(minLocalZ) || !Number.isFinite(maxLocalZ) || maxLocalZ <= minLocalZ) {
    throw new ModelBodyDeriveError(
      `"${geo.name}": the picked boss wall has no triangles in the current tessellation - re-sync ` +
        `(open the Model tab) and try picking again.`,
    )
  }

  if (R) {
    const [ax, ay] = rotateVec(R, snapshot.axisPoint[0], snapshot.axisPoint[1], snapshot.axisPoint[2])
    return {
      faceKind: 'boss',
      center: [ax + frame.position.x, ay + frame.position.y],
      topZ: maxLocalZ,
      bottomZ: minLocalZ,
      diameter,
    }
  }

  const pose: GeoPose = { position: frame.position, rotation: frame.rotation }
  const [worldXY] = transformLoopPoints([{ x: snapshot.axisPoint[0], y: snapshot.axisPoint[1] }], pose)

  return {
    faceKind: 'boss',
    center: [worldXY.x, worldXY.y],
    topZ: maxLocalZ + frame.position.z,
    bottomZ: minLocalZ + frame.position.z,
    diameter,
  }
}

// ---------------------------------------------------------------------------
// WO-366: closed circular edge -> its one unambiguous center and Z plane
// ---------------------------------------------------------------------------

const MODEL_EDGE_CLOSURE_TOLERANCE = 0.01
const MODEL_EDGE_PLANAR_TOLERANCE = 0.01
const MODEL_EDGE_CIRCLE_FIT_TOLERANCE = 0.01

export interface ModelBodyCircularEdgeOriginResult {
  center: [number, number]
  z: number
  diameter: number
  /** Center in the model body's own local frame for durable Placement tracking. */
  localCenter: Vec3
}

/** Algebraic least-squares circle fit. Undefined means the points do not
 *  define a stable circle (too few or effectively collinear). */
function fitCircle2D(
  points: ReadonlyArray<readonly [number, number]>,
): { cx: number; cy: number; radius: number } | undefined {
  if (points.length < 3) return undefined

  let sx = 0
  let sy = 0
  let sxx = 0
  let syy = 0
  let sxy = 0
  let sxq = 0
  let syq = 0
  let sq = 0
  for (const [x, y] of points) {
    const q = x * x + y * y
    sx += x
    sy += y
    sxx += x * x
    syy += y * y
    sxy += x * y
    sxq += x * q
    syq += y * q
    sq += q
  }

  // Solve x^2 + y^2 + D*x + E*y + F = 0 by Cramer's rule.
  const n = points.length
  const det =
    sxx * (syy * n - sy * sy) -
    sxy * (sxy * n - sy * sx) +
    sx * (sxy * sy - syy * sx)
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return undefined

  const b1 = -sxq
  const b2 = -syq
  const b3 = -sq
  const detD =
    b1 * (syy * n - sy * sy) -
    sxy * (b2 * n - sy * b3) +
    sx * (b2 * sy - syy * b3)
  const detE =
    sxx * (b2 * n - sy * b3) -
    b1 * (sxy * n - sy * sx) +
    sx * (sxy * b3 - b2 * sx)
  const detF =
    sxx * (syy * b3 - b2 * sy) -
    sxy * (sxy * b3 - b2 * sx) +
    b1 * (sxy * sy - syy * sx)

  const d = detD / det
  const e = detE / det
  const f = detF / det
  const cx = -d / 2
  const cy = -e / 2
  const radiusSquared = cx * cx + cy * cy - f
  if (!(radiusSquared > 0) || !Number.isFinite(radiusSquared)) return undefined
  return { cx, cy, radius: Math.sqrt(radiusSquared) }
}

/** Derive a setup origin from one modeled-body edge polyline. A circle is
 *  accepted only when the one edge is closed, horizontal, and fits one radius
 *  within tessellation tolerance. Polygons remain separate open edges and are
 *  refused before the fit. */
export function deriveModelBodyCircularEdgeOrigin(
  geo: ImportedGeometry,
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
  edgeStableId: string,
  localPoints: ReadonlyArray<readonly [number, number, number]>,
): ModelBodyCircularEdgeOriginResult {
  if (localPoints.length < 4) {
    throw new ModelBodyDeriveError(
      `Zero: selected edge "${edgeStableId}" has too few tessellated points to be a circle.`,
    )
  }

  const first = localPoints[0]
  const last = localPoints[localPoints.length - 1]
  const closureGap = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2])
  if (closureGap > MODEL_EDGE_CLOSURE_TOLERANCE) {
    throw new ModelBodyDeriveError(
      `Zero: selected edge "${edgeStableId}" is not closed - pick a full circular edge.`,
    )
  }

  const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const bodyId = geo.modelBody?.ref.bodyId
  let frame: { position: Vec3; rotation: Vec3 }
  try {
    frame = resolveModelReferenceFrame(placementRecords, itemId, bodyId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ModelBodyDeriveError(
      `"${geo.name}" could not resolve its world placement (${message}). Re-sync the Model tab and retry.`,
    )
  }
  // WO-1561: a tilted or flipped Placement places the ring in world first, so
  // the edge must be horizontal AS PLACED and the fit runs in world XY.
  const R = isTiltedOffZ(frame.rotation) ? rotationMatrixXYZ(frame.rotation) : undefined

  // Drop the duplicated closing point before fitting so it has no extra weight.
  const localRing = localPoints.slice(0, -1)
  const ring: ReadonlyArray<readonly [number, number, number]> = R
    ? localRing.map((point): [number, number, number] => {
      const [x, y, z] = rotateVec(R, point[0], point[1], point[2])
      return [x + frame.position.x, y + frame.position.y, z + frame.position.z]
    })
    : localRing
  const minZ = Math.min(...ring.map((point) => point[2]))
  const maxZ = Math.max(...ring.map((point) => point[2]))
  if (maxZ - minZ > MODEL_EDGE_PLANAR_TOLERANCE) {
    throw new ModelBodyDeriveError(R
      ? `Zero: selected edge "${edgeStableId}" is not horizontal at the body's placement - pick a circular edge that is flat as placed.`
      : `Zero: selected edge "${edgeStableId}" is not horizontal - pick a flat circular edge.`,
    )
  }

  const fit = fitCircle2D(ring.map((point): [number, number] => [point[0], point[1]]))
  if (!fit) {
    throw new ModelBodyDeriveError(
      `Zero: selected edge "${edgeStableId}" could not be resolved as a circle.`,
    )
  }
  const worstDeviation = ring.reduce((worst, point) => Math.max(
    worst,
    Math.abs(Math.hypot(point[0] - fit.cx, point[1] - fit.cy) - fit.radius),
  ), 0)
  if (worstDeviation > MODEL_EDGE_CIRCLE_FIT_TOLERANCE) {
    throw new ModelBodyDeriveError(
      `Zero: selected edge "${edgeStableId}" is closed but not circular.`,
    )
  }

  if (R) {
    // World centre on the placed ring, and its local point for Placement
    // tracking: R^T * (world - position).
    const z = (minZ + maxZ) / 2
    const dx = fit.cx - frame.position.x, dy = fit.cy - frame.position.y, dz = z - frame.position.z
    return {
      center: [fit.cx, fit.cy],
      z,
      diameter: fit.radius * 2,
      localCenter: {
        x: R.col1.x * dx + R.col1.y * dy + R.col1.z * dz,
        y: R.col2.x * dx + R.col2.y * dy + R.col2.z * dz,
        z: R.col3.x * dx + R.col3.y * dy + R.col3.z * dz,
      },
    }
  }

  const localZ = (minZ + maxZ) / 2
  const pose: GeoPose = { position: frame.position, rotation: frame.rotation }
  const [worldCenter] = transformLoopPoints([{ x: fit.cx, y: fit.cy }], pose)
  return {
    center: [worldCenter.x, worldCenter.y],
    z: localZ + frame.position.z,
    diameter: fit.radius * 2,
    localCenter: { x: fit.cx, y: fit.cy, z: localZ },
  }
}
