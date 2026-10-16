// WO UI-4: measure suite logic. Framework-agnostic (no React) so it is unit
// testable against mock TessBuffers fixtures without a kernel, and
// integration testable against the real occt-wasm kernel for exact-value
// analytic fixtures.
//
// CONTRACT: src/geom/** is frozen/read-only for this WO (architect ruling 1).
// measure(kind) only implements 'length' | 'area' | 'volume' server-side
// (geom-engine.ts's own comment: "distance/radius/angle stay Stage-2 resolver
// work (unimplemented below)"). Those three kinds ALWAYS go through the
// kernel via `measureExact` below -- never approximated here. radius/
// diameter/distance/angle have no kernel path today (confirmed gap, filed in
// this WO's report interfaceConcerns) so they are computed from the
// tessellated mesh + GeometrySnapshot data already on the client, and every
// readout produced this way carries `approx: true` plus an honest `note`
// explaining what would remove the approximation. This is the same
// "mesh-derived, explicitly labeled" pattern INT-1 established for face area
// before BK-20 closed that particular gap (see faceArea.ts) -- reused here
// for the kinds that are still open gaps.

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import * as THREE from 'three'
import type { CachedBody } from '../../../viewport3d'
import type { BridgeVertexRef, PickHit } from '../../../viewport3d'
import type { MeasureResult, StableId } from '../../../geom/geom-service'
// NOTE: two GeometrySnapshot shapes exist in this codebase -- the frozen
// geom-service.ts contract's ({surfaceType, centroid: Vec3, normal?: Vec3,
// axis?: Vec3}) and the worker-internal one actually returned at runtime by
// GeomClient.snapshotsFor() ({type, centroid: [n,n,n], normal: [n,n,n],
// axis?: [n,n,n]} -- see src/geom/worker/internal-types.ts). This module
// consumes the REAL runtime shape (re-exported from the geom facade barrel,
// not geom-service.ts) -- using the frozen contract's type here would
// typecheck against the wrong field names/shapes and silently read
// `undefined` at runtime.
import type { GeometrySnapshot } from '../../../geom'
import { parseStableId } from '../../../doc/stable-id'
import { edgeIdCollisions, edgeIdCollisionMessage, type EdgeIdCollision } from './edgeIdCollisions'

export type MeasureExactFn = (
  bodyId: string,
  kind: MeasureResult['kind'],
  ids?: StableId[],
) => Promise<MeasureResult>

export type SnapshotLookup = Readonly<Record<StableId, GeometrySnapshot>>

export type ReadoutKind = 'length' | 'area' | 'volume' | 'radius' | 'diameter' | 'distance' | 'angle'

export interface MeasureReadout {
  label: string
  kind: ReadoutKind
  value: number
  unit: string
  /** true when this value was derived from the tessellated mesh (or a
   *  best-effort geometric fit over it) rather than the kernel's own
   *  analytic answer -- see this file's header. */
  approx: boolean
  /** Stable id(s) this readout is scoped to, shown in the panel's details
   *  fold (WO UI-4 acceptance #2). */
  ids: StableId[]
  note?: string
}

export interface MeasureFailure {
  error: string
}

export type MeasureOutcome = MeasureReadout | MeasureFailure

// WO-2142: the panel shows `note` to the operator, so it speaks his words --
// never report names, WOs or kernel query names.
const APPROX_SURFACE_NOTE = workbenchText('measureLogic.approximateMeasuredOnTheDisplayedSurface')
const APPROX_DISTANCE_NOTE = workbenchText('measureLogic.approximateClosestPointsOnTheDisplayedSurface')

export function isFailure(outcome: MeasureOutcome): outcome is MeasureFailure {
  return 'error' in outcome
}

const UNITS: Record<ReadoutKind, string> = {
  length: 'mm',
  get area() { return workbenchText('measureLogic.mm2') },
  get volume() { return workbenchText('measureLogic.mm3') },
  radius: 'mm',
  diameter: 'mm',
  distance: 'mm',
  angle: 'deg',
}

function toVec3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z)
}

/** GeometrySnapshot's centroid/normal/axis travel as [x,y,z] tuples (worker-
 *  internal type, see this file's import comment), not {x,y,z} objects. */
function toVec3FromTuple(t: readonly [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(t[0], t[1], t[2])
}

// ---------------------------------------------------------------- geometry

/** Every polyline point belonging to `edgeId`, in mesh order. Exact for a
 *  straight edge (2 points: the two topological endpoints); a curved edge's
 *  interior points are tessellation samples bounded by the tessellate()
 *  call's deflection tolerance. */
export function edgePoints(body: CachedBody, edgeId: StableId): THREE.Vector3[] {
  const e = body.edgeIds.indexOf(edgeId)
  if (e === -1) return []
  const start = body.edgeOffsets[e]
  const end = body.edgeOffsets[e + 1]
  const pts: THREE.Vector3[] = []
  for (let p = start; p < end; p++) {
    pts.push(toVec3(body.edgePositions[p * 3], body.edgePositions[p * 3 + 1], body.edgePositions[p * 3 + 2]))
  }
  return pts
}

/** True only for a straight edge -- exactly two polyline points, i.e. the
 *  tessellator emitted no interior curve samples. */
export function isStraightEdge(body: CachedBody, edgeId: StableId): boolean {
  const e = body.edgeIds.indexOf(edgeId)
  if (e === -1) return false
  return body.edgeOffsets[e + 1] - body.edgeOffsets[e] === 2
}

/** Every triangle-vertex position belonging to `faceId` (duplicates included
 *  -- callers doing a fit/average are unaffected by the duplication since
 *  every tessellated point on the face contributes equally either way). */
export function facePoints(body: CachedBody, faceId: StableId): THREE.Vector3[] {
  const index = body.geometry.getIndex()
  const position = body.geometry.getAttribute('position')
  if (index === null || position === undefined) return []
  const pts: THREE.Vector3[] = []
  for (let t = 0; t < body.triFace.length; t++) {
    const faceIndex = body.triFace[t]
    if (body.faceIds[faceIndex] !== faceId) continue
    for (let k = 0; k < 3; k++) {
      const vi = index.getX(t * 3 + k)
      pts.push(toVec3(position.getX(vi), position.getY(vi), position.getZ(vi)))
    }
  }
  return pts
}

/** Representative point set for a pick -- vertex hits collapse to their own
 *  exact position (a topological vertex, never curve-sampled). */
export function pointsForHit(body: CachedBody, hit: PickHit): THREE.Vector3[] {
  switch (hit.kind) {
    case 'vertex':
      return [toVec3(hit.point.x, hit.point.y, hit.point.z)]
    case 'edge':
      return edgePoints(body, hit.id)
    case 'face':
      return facePoints(body, hit.id)
    case 'body': {
      const position = body.geometry.getAttribute('position')
      if (position === undefined) return []
      const pts: THREE.Vector3[] = []
      for (let vi = 0; vi < position.count; vi++) pts.push(toVec3(position.getX(vi), position.getY(vi), position.getZ(vi)))
      return pts
    }
  }
}

/** Resolve the GeometrySnapshot of a cylindrical/conical/toroidal face
 *  adjacent to `edgeId`, per the stable-id-spec edge grammar
 *  `(faceIdA<join>faceIdB)` -- used to find the axis a circular rim edge
 *  revolves around when the edge itself was picked (not its wall face).
 *  Goes through the shared depth-aware parser (src/doc/stable-id.ts's
 *  parseStableId) rather than a hand-rolled regex: a greedy
 *  `/^\((.+)[\^∧](.+)\)$/` looks right for a plain two-face edge but silently
 *  mis-splits a fillet/chamfer-BAND-adjacent edge, whose operand embeds a
 *  nested edge id (and so a nested join char) -- same class of bug as
 *  BK-56's deriveHiddenEdgeIds defect, just with a regex instead of
 *  `.split()`. Returns undefined if neither adjacent face is in `snapshots`
 *  or neither has an axis (e.g. a straight edge, or a rim with no captured
 *  face geometry). */
function axisFaceForEdge(edgeId: StableId, snapshots: SnapshotLookup): GeometrySnapshot | undefined {
  const parsed = parseStableId(edgeId)
  if (parsed.kind !== 'edge' || parsed.operands.length !== 2) return undefined
  for (const operand of parsed.operands) {
    const snap = snapshots[operand.raw]
    if (snap !== undefined && snap.axis !== undefined) return snap
  }
  return undefined
}

// ------------------------------------------------------------ pure math

/** Median distance from `points` to the infinite line through `axisOrigin`
 *  along unit `axisDir` -- the mesh-derived cylinder/cone-rim radius.
 *  Median (not mean) so a handful of off-surface samples (e.g. a cone's
 *  varying true radius along its axis, or one straggler point) don't skew a
 *  single reported value as badly as an outlier-sensitive mean would. */
export function meshDerivedRadius(points: readonly THREE.Vector3[], axisOrigin: THREE.Vector3, axisDir: THREE.Vector3): number {
  if (points.length === 0) return NaN
  const dir = axisDir.clone().normalize()
  const toPoint = new THREE.Vector3()
  const distances = points.map((p) => {
    toPoint.copy(p).sub(axisOrigin)
    const along = toPoint.dot(dir)
    const closest = dir.clone().multiplyScalar(along)
    return toPoint.distanceTo(closest)
  })
  distances.sort((a, b) => a - b)
  const mid = Math.floor(distances.length / 2)
  return distances.length % 2 === 0 ? (distances[mid - 1] + distances[mid]) / 2 : distances[mid]
}

/** Minimum Euclidean distance between any point in `a` and any point in `b`.
 *  O(|a| * |b|) brute force -- fine at the point counts a single pick's face/
 *  edge/vertex point set has (tens to low thousands, never a whole-scene
 *  scan). */
export function meshDerivedMinDistance(a: readonly THREE.Vector3[], b: readonly THREE.Vector3[]): number {
  let best = Infinity
  for (const p of a) {
    for (const q of b) {
      const d = p.distanceTo(q)
      if (d < best) best = d
    }
  }
  return best
}

/** Unsigned angle between two directions, folded into [0, 90] degrees --
 *  avoids the sign ambiguity of "which way does this edge/normal point"
 *  (a picked edge has no canonical start/end, an outward face normal is the
 *  only canonical direction a face has, but two adjacent faces' outward
 *  normals read as the SUPPLEMENT of the intuitive "angle between the
 *  faces" for a convex corner). Reported honestly as "angle between
 *  normals/directions", not a signed dihedral angle -- see this WO's report. */
export function angleBetweenDirections(a: THREE.Vector3, b: THREE.Vector3): number {
  const dot = THREE.MathUtils.clamp(Math.abs(a.clone().normalize().dot(b.clone().normalize())), -1, 1)
  return THREE.MathUtils.radToDeg(Math.acos(dot))
}

// -------------------------------------------------------- single-entity

/** Measure one pick. 'length'/'area'/'volume' always resolve through the
 *  kernel (exact). 'radius'/'diameter' are attempted only for a face/edge
 *  whose GeometrySnapshot (or an adjacent face's, for an edge) carries an
 *  axis -- returns a failure (never a fabricated number) if none is found. */
export async function measureSingle(
  measureExact: MeasureExactFn,
  body: CachedBody,
  bodyId: string,
  hit: PickHit,
  snapshots: SnapshotLookup,
): Promise<MeasureOutcome[]> {
  if (hit.kind === 'body') {
    const result = await measureExact(bodyId, 'volume')
    return [{ label: workbenchText('measureLogic.volume'), kind: 'volume', value: result.value, unit: UNITS.volume, approx: false, ids: [] }]
  }

  if (hit.kind === 'vertex') {
    const ref = hit.id as BridgeVertexRef
    return [
      {
        label: workbenchText('measureLogic.vertex'),
        kind: 'distance',
        value: 0,
        unit: 'mm',
        approx: false,
        ids: [...ref.adjacentEdgeIds],
        note: workbenchText('measureLogic.positionMm', { value1: String(hit.point.x.toFixed(3)), value2: String(hit.point.y.toFixed(3)), value3: String(hit.point.z.toFixed(3)) }),
      },
    ]
  }

  const readouts: MeasureReadout[] = []

  if (hit.kind === 'edge') {
    // ICR-3 step 1 (GEO-15-R1): the edge resolvers below (edgePoints,
    // isStraightEdge, and the worker's length lookup) all resolve hit.id via a
    // first-wins scan (body.edgeIds.indexOf / edgeIdList.indexOf). If the picked
    // id collides with a twin (edgeId face-pair collapse) they would silently
    // read the WRONG physical edge. Refuse BY NAME instead, via measure's
    // structured MeasureFailure -- never a throw, never first-wins. Only the
    // picked id blocks; a collision elsewhere on the body does not.
    // This UI resolver refuses a colliding pick BEFORE calling the worker, so
    // the worker length lookup is never reached with an ambiguous id from this
    // path. The worker keeps its OWN structured (non-throwing) refusal for any
    // direct caller -- see geom-engine.ts measure('length') and census.
    const collisions = edgeIdCollisions(body.edgeIds, [hit.id])
    if (collisions.length > 0) return [{ error: edgeIdCollisionMessage(collisions) }]

    const lengthResult = await measureExact(bodyId, 'length', [hit.id])
    readouts.push({ label: workbenchText('measureLogic.length'), kind: 'length', value: lengthResult.value, unit: UNITS.length, approx: false, ids: [hit.id] })

    const axisFace = axisFaceForEdge(hit.id, snapshots)
    if (axisFace?.axis !== undefined) {
      const pts = edgePoints(body, hit.id)
      const radius = meshDerivedRadius(pts, toVec3FromTuple(axisFace.centroid), toVec3FromTuple(axisFace.axis))
      readouts.push({
        label: workbenchText('measureLogic.radius'),
        kind: 'radius',
        value: radius,
        unit: UNITS.radius,
        approx: true,
        ids: [hit.id],
        note: APPROX_SURFACE_NOTE,
      })
      readouts.push({
        label: workbenchText('measureLogic.diameter'),
        kind: 'diameter',
        value: radius * 2,
        unit: UNITS.diameter,
        approx: true,
        ids: [hit.id],
        note: APPROX_SURFACE_NOTE,
      })
    }
    return readouts
  }

  // face
  const areaResult = await measureExact(bodyId, 'area', [hit.id])
  readouts.push({ label: workbenchText('measureLogic.area'), kind: 'area', value: areaResult.value, unit: UNITS.area, approx: false, ids: [hit.id] })

  const snap = snapshots[hit.id]
  if (snap?.axis !== undefined && (snap.type === 'cylinder' || snap.type === 'cone' || snap.type === 'torus')) {
    const pts = facePoints(body, hit.id)
    const radius = meshDerivedRadius(pts, toVec3FromTuple(snap.centroid), toVec3FromTuple(snap.axis))
    readouts.push({
      label: workbenchText('measureLogic.radius'),
      kind: 'radius',
      value: radius,
      unit: UNITS.radius,
      approx: true,
      ids: [hit.id],
      note: APPROX_SURFACE_NOTE,
    })
    readouts.push({
      label: workbenchText('measureLogic.diameter'),
      kind: 'diameter',
      value: radius * 2,
      unit: UNITS.diameter,
      approx: true,
      ids: [hit.id],
      note: APPROX_SURFACE_NOTE,
    })
  }
  return readouts
}

// ------------------------------------------------------------- two-entity

export interface PickWithBody {
  bodyId: string
  body: CachedBody
  hit: PickHit
  snapshots: SnapshotLookup
}

function idsOf(hit: PickHit): StableId[] {
  return hit.kind === 'body' || hit.kind === 'vertex' ? [] : [hit.id]
}

/** ICR-3 step 1 (GEO-15-R1): structured refusal if any picked EDGE resolves to
 *  a colliding stable id on its own body -- the two-entity resolvers below
 *  (edgePoints / isStraightEdge, both first-wins body.edgeIds.indexOf) would
 *  otherwise silently compute against the wrong physical twin. Face picks are
 *  unaffected (face ids are minted uniquely, not subject to the two-face-edge
 *  collapse); body/vertex picks resolve no edge id. A collision the caller did
 *  not pick never blocks. */
function pickedEdgeCollision(...picks: PickWithBody[]): MeasureFailure | undefined {
  const collisions: EdgeIdCollision[] = []
  for (const p of picks) {
    if (p.hit.kind === 'edge') collisions.push(...edgeIdCollisions(p.body.edgeIds, [p.hit.id]))
  }
  return collisions.length > 0 ? { error: edgeIdCollisionMessage(collisions) } : undefined
}

/** Minimum distance between two picked entities. Mesh-derived (approx) in
 *  every case except vertex-to-vertex, where both point sets are single
 *  exact topological positions -- a real Euclidean distance, not a fit. */
export function measureDistance(a: PickWithBody, b: PickWithBody): MeasureOutcome {
  const collision = pickedEdgeCollision(a, b)
  if (collision !== undefined) return collision
  const ptsA = pointsForHit(a.body, a.hit)
  const ptsB = pointsForHit(b.body, b.hit)
  const value = meshDerivedMinDistance(ptsA, ptsB)
  const exact = a.hit.kind === 'vertex' && b.hit.kind === 'vertex'
  return {
    label: workbenchText('measureLogic.distance'),
    kind: 'distance',
    value,
    unit: UNITS.distance,
    approx: !exact,
    ids: [...idsOf(a.hit), ...idsOf(b.hit)],
    note: exact ? undefined : APPROX_DISTANCE_NOTE,
  }
}

/** Angle between two entities -- only defined here for face-face (both
 *  planar, using kernel-derived outward normals -- exact) and edge-edge
 *  (both straight, using their exact endpoint direction -- exact). Any other
 *  combination, or a curved edge, returns a MeasureFailure rather than a
 *  fabricated angle (matches this WO's acceptance criterion 1: angle is
 *  scoped to "where both are planar/linear"). */
export function measureAngle(a: PickWithBody, b: PickWithBody): MeasureOutcome {
  const collision = pickedEdgeCollision(a, b)
  if (collision !== undefined) return collision
  if (a.hit.kind === 'face' && b.hit.kind === 'face') {
    const snapA = a.snapshots[a.hit.id]
    const snapB = b.snapshots[b.hit.id]
    if (snapA === undefined || snapB === undefined || snapA.type !== 'plane' || snapB.type !== 'plane') {
      return { error: workbenchText('measureLogic.angleNeedsBothFacesToBePlanarWithA') }
    }
    const value = angleBetweenDirections(toVec3FromTuple(snapA.normal), toVec3FromTuple(snapB.normal))
    return {
      label: workbenchText('measureLogic.angle'),
      kind: 'angle',
      value,
      unit: UNITS.angle,
      approx: false,
      ids: [a.hit.id, b.hit.id],
      note: workbenchText('measureLogic.unsignedAngleBetweenFaceNormals090Deg'),
    }
  }
  if (a.hit.kind === 'edge' && b.hit.kind === 'edge') {
    if (!isStraightEdge(a.body, a.hit.id) || !isStraightEdge(b.body, b.hit.id)) {
      return { error: workbenchText('measureLogic.angleIsOnlyComputedBetweenStraightEdges') }
    }
    const ptsA = edgePoints(a.body, a.hit.id)
    const ptsB = edgePoints(b.body, b.hit.id)
    if (ptsA.length < 2 || ptsB.length < 2) return { error: workbenchText('measureLogic.edgeHasTooFewPointsToDeriveADirection') }
    const dirA = ptsA[ptsA.length - 1].clone().sub(ptsA[0])
    const dirB = ptsB[ptsB.length - 1].clone().sub(ptsB[0])
    const value = angleBetweenDirections(dirA, dirB)
    return {
      label: workbenchText('measureLogic.angle'),
      kind: 'angle',
      value,
      unit: UNITS.angle,
      approx: false,
      ids: [a.hit.id, b.hit.id],
      note: workbenchText('measureLogic.unsignedAngleBetweenEdgeDirections090Deg'),
    }
  }
  return { error: workbenchText('measureLogic.angleNeedsTwoFacesOrTwoStraightEdges') }
}

export function formatReadout(r: MeasureReadout): string {
  const approxTag = r.approx ? workbenchText('measureLogic.approx') : ''
  if (Number.isNaN(r.value)) return workbenchText('measureLogic.unavailable', { label: String(r.label), approxTag: String(approxTag) })
  return `${r.label}: ${r.value.toFixed(3)} ${r.unit}${approxTag}`
}
