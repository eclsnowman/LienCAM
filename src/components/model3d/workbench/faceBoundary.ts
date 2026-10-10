// Shared model-projection extraction over the SAME tessellated CachedBody edge data
// measure/measureLogic.ts's edgePoints() already reads (viewport3d's shared
// GeometryCache output) -- no new kernel query. A face's boundary edges are
// exactly the edges whose stable-ID names it as an operand (the
// `(faceA<AND>faceB)` two-face-join grammar docs/stable-id-spec.md defines,
// parsed via doc/stable-id.ts's parseStableId -- the SAME depth-aware parser
// measureLogic.ts's axisFaceForEdge already uses instead of a hand-rolled
// regex).
//
// The explicit Project / Use path consumes the named all-loop and open-edge
// results below. The outer-only wrapper remains solely for legacy external-ref
// reattachment; new face sketches never extract or insert a boundary on entry.

import type { CachedBody } from '../../../viewport3d'
import type { StableId, Vec3 } from '../../../geom/geom-service'
import { parseStableId } from '../../../doc/stable-id'
import { edgeIdCollisions, type EdgeIdCollision } from '../measure/edgeIdCollisions'

const SNAP_DIGITS = 4 // mm-scale tessellation continuity tolerance (1e-4 mm)

function vertexKey(p: Vec3): string {
  return `${p.x.toFixed(SNAP_DIGITS)},${p.y.toFixed(SNAP_DIGITS)},${p.z.toFixed(SNAP_DIGITS)}`
}

/** Every tessellated polyline point of `edgeId`, in mesh order (plain Vec3 --
 *  mirrors measure/measureLogic.ts's edgePoints exactly, minus the THREE.js
 *  wrapper, since this module's output crosses into src/sketch3d/**, which
 *  stays THREE-free). */
function edgeWorldPoints(body: CachedBody, edgeId: StableId): Vec3[] {
  const e = body.edgeIds.indexOf(edgeId)
  if (e === -1) return []
  const start = body.edgeOffsets[e]
  const end = body.edgeOffsets[e + 1]
  const pts: Vec3[] = []
  for (let p = start; p < end; p++) {
    pts.push({ x: body.edgePositions[p * 3], y: body.edgePositions[p * 3 + 1], z: body.edgePositions[p * 3 + 2] })
  }
  return pts
}

type ProjectToLocal = (p: Vec3) => { x: number; y: number }

const DEGENERATE_EPS = 1e-9

function finiteVec3(p: Vec3): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

function finiteVec2(p: { x: number; y: number }): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y)
}

function distinctPointCount2D(points: ReadonlyArray<{ x: number; y: number }>): number {
  const distinct: Array<{ x: number; y: number }> = []
  for (const point of points) {
    if (!distinct.some((other) => Math.hypot(point.x - other.x, point.y - other.y) <= DEGENERATE_EPS)) distinct.push(point)
  }
  return distinct.length
}

function distinctPointCount3D(points: readonly Vec3[]): number {
  const distinct: Vec3[] = []
  for (const point of points) {
    if (!distinct.some((other) => Math.hypot(point.x - other.x, point.y - other.y, point.z - other.z) <= DEGENERATE_EPS)) distinct.push(point)
  }
  return distinct.length
}

/** Runtime refusal census. Tests derive exhaustive fixtures from this value. */
export const EDGE_POLYLINE_REFUSAL_REASONS = [
  'edge-not-found',
  'edge-id-collision',
  'non-finite-point',
  'degenerate-edge',
  'collapsed-projection',
] as const

export type EdgePolylineRefusalReason = (typeof EDGE_POLYLINE_REFUSAL_REASONS)[number]

export type EdgePolylineResult =
  | { ok: true; points: Vec3[] }
  | { ok: false; reason: Exclude<EdgePolylineRefusalReason, 'edge-id-collision'> }
  | { ok: false; reason: 'edge-id-collision'; collisions: EdgeIdCollision[] }

/**
 * One cached edge polyline in world space. The result is safe to turn into an
 * open sketch path: it refuses duplicate stable IDs, non-finite cache data,
 * and paths that have fewer than two distinct points after projection.
 */
export function edgePolyline(
  body: CachedBody,
  edgeId: StableId,
  projectToLocal: ProjectToLocal,
): EdgePolylineResult {
  const collisions = edgeIdCollisions(body.edgeIds, [edgeId])
  if (collisions.length > 0) return { ok: false, reason: 'edge-id-collision', collisions }
  const points = edgeWorldPoints(body, edgeId)
  if (points.length === 0) return { ok: false, reason: 'edge-not-found' }
  if (!points.every(finiteVec3)) return { ok: false, reason: 'non-finite-point' }
  if (points.length < 2 || distinctPointCount3D(points) < 2) return { ok: false, reason: 'degenerate-edge' }
  const projected = points.map(projectToLocal)
  if (!projected.every(finiteVec2)) return { ok: false, reason: 'non-finite-point' }
  if (distinctPointCount2D(projected) < 2) return { ok: false, reason: 'collapsed-projection' }
  return { ok: true, points }
}

/** Every edge id in `body` whose stable-ID names `faceId` as one of its two
 *  adjacent faces (docs/stable-id-spec.md's edge grammar). */
function edgesOfFace(body: CachedBody, faceId: StableId): StableId[] {
  return body.edgeIds.filter((edgeId) => {
    const parsed = parseStableId(edgeId)
    return parsed.kind === 'edge' && parsed.operands.some((op) => op.raw === faceId)
  })
}

interface EdgeSeg {
  edgeId: StableId
  points: Vec3[]
}

/** Chains edge polylines sharing endpoints into closed loops. Returns []
 *  (never throws) if any vertex has degree != 2 -- see this file's header. */
function chainIntoLoops(segs: EdgeSeg[]): Vec3[][] {
  if (segs.length === 0) return []
  const adjacency = new Map<string, Array<{ segIndex: number; end: 0 | 1 }>>()
  for (let i = 0; i < segs.length; i++) {
    const pts = segs[i].points
    if (pts.length < 2) return []
    ;([0, 1] as const).forEach((end) => {
      const key = vertexKey(end === 0 ? pts[0] : pts[pts.length - 1])
      const list = adjacency.get(key)
      const ref = { segIndex: i, end }
      if (list) list.push(ref)
      else adjacency.set(key, [ref])
    })
  }
  for (const refs of adjacency.values()) {
    if (refs.length !== 2) return []
  }

  const visited = new Set<number>()
  const loops: Vec3[][] = []
  const orderedStart = [...segs.keys()].sort((a, b) => (segs[a].edgeId < segs[b].edgeId ? -1 : segs[a].edgeId > segs[b].edgeId ? 1 : 0))

  for (const startIdx of orderedStart) {
    if (visited.has(startIdx)) continue
    const loop: Vec3[] = []
    const loopStartKey = vertexKey(segs[startIdx].points[0])
    let currentIdx = startIdx
    let forward = true
    for (;;) {
      visited.add(currentIdx)
      const pts = segs[currentIdx].points
      const ordered = forward ? pts : [...pts].reverse()
      // Avoid a duplicated shared vertex at each join.
      loop.push(...(loop.length === 0 ? ordered : ordered.slice(1)))
      const atKey = vertexKey(ordered[ordered.length - 1])
      if (atKey === loopStartKey) break
      const next = (adjacency.get(atKey) ?? []).filter((r) => r.segIndex !== currentIdx)
      if (next.length !== 1) return [] // malformed -- bail honestly, no partial loop
      currentIdx = next[0].segIndex
      forward = next[0].end === 0
    }
    // The walk above closes back to loopStartKey but leaves that repeated
    // closing point on the array (each segment's slice(1) still includes
    // its own final point) -- drop it so the loop is closed-but-not-
    // repeating-the-first-point, matching this function's own contract.
    if (loop.length > 1 && vertexKey(loop[loop.length - 1]) === loopStartKey) loop.pop()
    loops.push(loop)
  }
  return loops
}

function shoelaceArea2D(loop: Array<{ x: number; y: number }>): number {
  let sum = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/**
 * Outcome of {@link faceOuterBoundaryLoop} -- a DISCRIMINATED result (GEO-16
 * Fold 1), never a bare `undefined`, so the caller can tell a HARMFUL refusal
 * (an edge-id collision on this face's boundary, which must be surfaced to the
 * user) apart from a benign "no clean loop" (a tessellation artifact for an
 * auxiliary nice-to-have, which stays silent). GEO-15-R1 held this exact gap:
 * `faceOuterBoundaryLoop` refused a collision via the same bare `undefined` the
 * unclean-loop path returns, so the caller could not name the cause and the
 * positive fixture could not fail if the guard were removed.
 */
export type FaceBoundaryResult =
  | { ok: true; loop: Vec3[] }
  | { ok: false; reason: 'edge-id-collision'; collisions: EdgeIdCollision[] }
  | { ok: false; reason: 'no-clean-loop' }

/** Runtime refusal census. Tests derive exhaustive fixtures from this value. */
export const FACE_BOUNDARY_LOOPS_REFUSAL_REASONS = [
  'edge-id-collision',
  'no-boundary-edges',
  'non-finite-point',
  'degenerate-edge',
  'unchainable-face',
  'degenerate-face-loop',
  'collapsed-projection',
] as const

export type FaceBoundaryLoopsRefusalReason = (typeof FACE_BOUNDARY_LOOPS_REFUSAL_REASONS)[number]

export type FaceBoundaryLoopsResult =
  | { ok: true; loops: Vec3[][] }
  | { ok: false; reason: 'edge-id-collision'; collisions: EdgeIdCollision[] }
  | { ok: false; reason: Exclude<FaceBoundaryLoopsRefusalReason, 'edge-id-collision'> }

/**
 * Every clean boundary loop of a picked face, outer loop first. Unlike the
 * legacy outer-only wrapper below, this preserves holes for atomic projection.
 * Any malformed member refuses the whole face; partial loop groups are never
 * returned.
 */
export function faceBoundaryLoops(
  body: CachedBody,
  faceId: StableId,
  projectToLocal: ProjectToLocal,
): FaceBoundaryLoopsResult {
  const boundaryIds = edgesOfFace(body, faceId)
  if (boundaryIds.length === 0) return { ok: false, reason: 'no-boundary-edges' }
  const collisions = edgeIdCollisions(body.edgeIds, boundaryIds)
  if (collisions.length > 0) return { ok: false, reason: 'edge-id-collision', collisions }

  const segs: EdgeSeg[] = []
  for (const edgeId of boundaryIds) {
    const points = edgeWorldPoints(body, edgeId)
    if (!points.every(finiteVec3)) return { ok: false, reason: 'non-finite-point' }
    if (points.length < 2 || distinctPointCount3D(points) < 2) return { ok: false, reason: 'degenerate-edge' }
    segs.push({ edgeId, points })
  }

  const loops = chainIntoLoops(segs)
  if (loops.length === 0) return { ok: false, reason: 'unchainable-face' }

  const withArea: Array<{ loop: Vec3[]; area: number; order: number }> = []
  for (let order = 0; order < loops.length; order++) {
    const loop = loops[order]
    if (distinctPointCount3D(loop) < 3) return { ok: false, reason: 'degenerate-face-loop' }
    const projected = loop.map(projectToLocal)
    if (!projected.every(finiteVec2)) return { ok: false, reason: 'non-finite-point' }
    if (distinctPointCount2D(projected) < 3) return { ok: false, reason: 'collapsed-projection' }
    const area = Math.abs(shoelaceArea2D(projected))
    if (!Number.isFinite(area)) return { ok: false, reason: 'non-finite-point' }
    if (area <= DEGENERATE_EPS) return { ok: false, reason: 'collapsed-projection' }
    withArea.push({ loop, area, order })
  }

  withArea.sort((a, b) => b.area - a.area || a.order - b.order)
  return { ok: true, loops: withArea.map((entry) => entry.loop) }
}

/** The picked face's OUTER boundary loop (world-space, closed -- first point
 *  not duplicated at the end), as a {@link FaceBoundaryResult}. `projectToLocal`
 *  (typically planeMath.ts's worldToLocal bound to the resolved frame) is used
 *  only to pick the largest-area loop when a face has more than one (an island
 *  hole) -- V1 (Q3) wants the perimeter only, never hole loops. */
export function faceOuterBoundaryLoop(body: CachedBody, faceId: StableId, projectToLocal: (p: Vec3) => { x: number; y: number }): FaceBoundaryResult {
  const result = faceBoundaryLoops(body, faceId, projectToLocal)
  if (result.ok) return { ok: true, loop: result.loops[0] }
  if (result.reason === 'edge-id-collision') return result
  // Preserve the legacy reattach contract: every benign extraction failure remains
  // the single silent `no-clean-loop` result at this compatibility seam.
  return { ok: false, reason: 'no-clean-loop' }
}
