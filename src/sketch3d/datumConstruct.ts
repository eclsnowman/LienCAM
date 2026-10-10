// Construct, second wave (WO-2223): planes made from picks, and the Point datum.
//
// Picked planes -- through three points, through two edges, tangent to a cylindrical face -- are
// construction planes like Offset / Midplane / At angle (datumPlane.ts's OffsetPlaneDatumPayload,
// planeKind 'offset-plane'), so every plane reader (the sheet glyph, New sketch, a plane an Offset
// plane or Extrude can start from, the tree's hide eye) takes them as they are. What differs is
// where the frame comes from: not from parent planes but from picked geometry, held the way the
// axis datum holds it (datumAxis.ts's header): every picked face lives in the node's `refs`, the
// body features owning those faces are its `consumes`, and the node's own executor recomputes the
// frame on every rebuild, continuing from the last good pick state (`lastGoodPick`).
//
// The Point datum (datumType 'point') is the same shape: a vertex, a circle's centre, or where an
// edge (or a round edge's centre line) meets a plane. The plane is a datum plane the node consumes
// (World XY and every construction plane) or a flat face it references.
//
// Rule 11: every pick makes what it can. A round edge picked where an edge is wanted gives its
// centre line (as the Axis tool does); a flat face picked for a tangent plane gives the face's own
// plane; a curved face that is not a cylinder gives the plane square to it where it was clicked,
// held there. Only geometry that cannot make the thing refuses: three points on one line, two
// edges on one line, an edge that runs parallel to its plane.

import type { DagNodeInput, ElementMap, FeatureDag, FeatureOp, FeatureRef } from '../doc'
import type { Diag, StableId, Vec3 } from '../geom/geom-service'
import type { PlaneFrame } from './planeMath'
import { vAdd, vCross, vDot, vLength, vScale, vSub, vUnit } from './planeMath'
import {
  computeAxisLine,
  isFiniteAxisLine,
  nearestPointOnPlanes,
  type AxisFace,
  type AxisFaceGeometry,
  type AxisFaceGeometryLookup,
  type AxisLine,
} from './datumAxis'

const PREFIX = 'datum:'
const MIN_LENGTH = 1e-9
/** Cross products shorter than this (on unit inputs) count as parallel. */
const PARALLEL_MIN = 1e-6

// ------------------------------------------------------------------ shared

/** How a picked edge becomes a line: along a straight edge, or a round edge's centre line. */
export type ConstructLineKind = 'edge' | 'cylinder'

/** Ref roles: which picked element a face reference belongs to. */
export type ConstructRefRole = 'pointA' | 'pointB' | 'pointC' | 'lineA' | 'lineB' | 'tangentFace' | 'pointFace' | 'planeFace'

const ROLES: readonly ConstructRefRole[] = ['pointA', 'pointB', 'pointC', 'lineA', 'lineB', 'tangentFace', 'pointFace', 'planeFace']

export type ConstructFace = { role: ConstructRefRole; geometry: AxisFaceGeometry }

export interface ConstructFaceRefInput {
  role: ConstructRefRole
  faceId: StableId
}

function finiteVec(v: unknown): v is Vec3 {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number' &&
    Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z)
}

function hasAxis(g: AxisFaceGeometry): g is AxisFaceGeometry & { axis: Vec3 } {
  return g.surfaceType !== 'plane' && finiteVec(g.axis) && vLength(g.axis) > MIN_LENGTH
}

interface Plane { normal: Vec3; offset: number }

function planeOf(g: AxisFaceGeometry): Plane | undefined {
  if (g.surfaceType !== 'plane' || !finiteVec(g.normal) || vLength(g.normal) < MIN_LENGTH) return undefined
  const normal = vUnit(g.normal)
  return { normal, offset: vDot(normal, g.centroid) }
}

function alignTo(dir: Vec3, prior: Vec3 | undefined): Vec3 {
  return prior !== undefined && vDot(dir, prior) < 0 ? vScale(dir, -1) : dir
}

/** The component of `v` square to unit `axis`. */
function across(v: Vec3, axis: Vec3): Vec3 {
  return vSub(v, vScale(axis, vDot(v, axis)))
}

/** One face ref per (role, face): the same face under two roles stays two refs. */
export function constructFaceRefs(faces: readonly ConstructFaceRefInput[]): FeatureRef[] {
  const seen = new Set<string>()
  const refs: FeatureRef[] = []
  for (const face of faces) {
    const key = `${face.role}\u0000${face.faceId}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ id: face.faceId, kind: 'single-face', role: face.role, elementType: 'face' })
  }
  return refs
}

/** A line from the faces of one picked edge, continuing from its last good line. */
function lineFrom(kind: ConstructLineKind, faces: readonly AxisFaceGeometry[], prior: AxisLine | undefined): { ok: true; line: AxisLine } | { ok: false; reason: string } {
  const role = kind === 'cylinder' ? 'axisFace' as const : 'edgeFace' as const
  const made = computeAxisLine(kind, faces.map((geometry): AxisFace => ({ role, geometry })), prior)
  if (made.ok) return { ok: true, line: made.axis }
  if (prior !== undefined) return { ok: true, line: prior }
  return { ok: false, reason: made.reason }
}

function lineCentre(line: AxisLine): Vec3 {
  return vAdd(line.origin, vScale(line.dir, line.length / 2))
}

/** Where a line meets a plane; undefined when it runs parallel to it. */
export function lineMeetsPlane(line: Pick<AxisLine, 'origin' | 'dir'>, plane: Pick<PlaneFrame, 'origin' | 'normal'>): Vec3 | undefined {
  const n = vUnit(plane.normal)
  const d = vUnit(line.dir)
  const denom = vDot(d, n)
  if (Math.abs(denom) < PARALLEL_MIN) return undefined
  const t = vDot(vSub(plane.origin, line.origin), n) / denom
  return vAdd(line.origin, vScale(d, t))
}

// ------------------------------------------------------------------ picked planes

export type PickedPlaneKind = 'three-points' | 'two-edges' | 'tangent'

export interface PickedPlaneDefinition extends Record<string, unknown> {
  kind: PickedPlaneKind
  flipNormal: boolean
  /** two edges: how each picked edge became a line (fixed at the pick) */
  lineKinds?: [ConstructLineKind, ConstructLineKind]
}

export function isPickedPlaneKind(kind: unknown): kind is PickedPlaneKind {
  return kind === 'three-points' || kind === 'two-edges' || kind === 'tangent'
}

/** What a picked plane continues from on the next rebuild (all unflipped). */
export type PickedPlaneState =
  | { kind: 'three-points'; points: [Vec3, Vec3, Vec3] }
  | { kind: 'two-edges'; lines: [AxisLine, AxisLine] }
  /** `point` touches the face; `radial` is the plane's unflipped normal; `axis` the face's axis
   *  (the plane's X); `centre` the axis point square to `point` (point = centre + radius * radial). */
  | { kind: 'tangent'; point: Vec3; radial: Vec3; axis: Vec3; centre: Vec3 }

export function isPickedPlaneState(state: unknown): state is PickedPlaneState {
  if (state === null || typeof state !== 'object') return false
  const s = state as Record<string, unknown>
  if (s.kind === 'three-points') return Array.isArray(s.points) && s.points.length === 3 && s.points.every(finiteVec)
  if (s.kind === 'two-edges') return Array.isArray(s.lines) && s.lines.length === 2 && s.lines.every(isFiniteAxisLine)
  if (s.kind === 'tangent') return finiteVec(s.point) && finiteVec(s.radial) && finiteVec(s.axis) && finiteVec(s.centre)
  return false
}

export function isPickedPlaneDefinition(d: Record<string, unknown>): d is PickedPlaneDefinition {
  if (!isPickedPlaneKind(d.kind) || typeof d.flipNormal !== 'boolean') return false
  if (d.kind !== 'two-edges') return true
  const kinds = d.lineKinds
  return Array.isArray(kinds) && kinds.length === 2 && kinds.every((k) => k === 'edge' || k === 'cylinder')
}

export type PickedPlaneResult = { ok: true; state: PickedPlaneState; frame: PlaneFrame } | { ok: false; reason: string }

/** The frame a pick state makes (flip applied). The ONE rule the pick's preview, Apply and the
 *  executor share. */
export function pickedPlaneFrame(state: PickedPlaneState, flipNormal: boolean): { ok: true; frame: PlaneFrame } | { ok: false; reason: string } {
  const flip = (frame: PlaneFrame): PlaneFrame => (flipNormal ? { ...frame, normal: vScale(frame.normal, -1) } : frame)
  if (state.kind === 'three-points') {
    const [a, b, c] = state.points
    const ab = vSub(b, a)
    const n = vCross(ab, vSub(c, a))
    if (!(vLength(ab) > MIN_LENGTH) || !(vLength(n) > PARALLEL_MIN * vLength(ab) * Math.max(vLength(vSub(c, a)), MIN_LENGTH))) {
      return { ok: false, reason: 'the three points are on one line' }
    }
    const origin = vScale(vAdd(vAdd(a, b), c), 1 / 3)
    return { ok: true, frame: flip({ origin, normal: vUnit(n), xDir: vUnit(ab) }) }
  }
  if (state.kind === 'two-edges') {
    const [la, lb] = state.lines
    const da = vUnit(la.dir)
    const ca = lineCentre(la)
    const cb = lineCentre(lb)
    let n = vCross(da, vUnit(lb.dir))
    if (vLength(n) < PARALLEL_MIN) {
      // parallel edges: the plane that holds both
      n = vCross(da, vSub(cb, ca))
      if (vLength(n) < PARALLEL_MIN) return { ok: false, reason: 'the two edges are on one line' }
    }
    const normal = vUnit(n)
    // holds the first edge; where the edges do not meet (skew) it runs parallel to the second
    const mid = vScale(vAdd(ca, cb), 0.5)
    const origin = vSub(mid, vScale(normal, vDot(vSub(mid, ca), normal)))
    return { ok: true, frame: flip({ origin, normal, xDir: da }) }
  }
  return { ok: true, frame: flip({ origin: state.point, normal: vUnit(state.radial), xDir: vUnit(state.axis) }) }
}

/**
 * The pick state the faces make now, continuing from `prior` (the last good state, or the seed the
 * pick made). Faces pin what they can; the prior supplies the rest, moved the least distance.
 */
export function computePickedPlane(definition: PickedPlaneDefinition, faces: readonly ConstructFace[], prior: PickedPlaneState): PickedPlaneResult {
  const of = (role: ConstructRefRole) => faces.filter((face) => face.role === role).map((face) => face.geometry)
  const flatsOf = (role: ConstructRefRole) => of(role).flatMap((g) => planeOf(g) ?? [])
  let state: PickedPlaneState
  if (definition.kind === 'three-points') {
    if (prior.kind !== 'three-points') return { ok: false, reason: 'the three points were never picked' }
    const roles: ConstructRefRole[] = ['pointA', 'pointB', 'pointC']
    state = { kind: 'three-points', points: prior.points.map((p, i) => nearestPointOnPlanes(p, flatsOf(roles[i]))) as [Vec3, Vec3, Vec3] }
  } else if (definition.kind === 'two-edges') {
    if (prior.kind !== 'two-edges') return { ok: false, reason: 'the two edges were never picked' }
    const kinds = definition.lineKinds ?? ['edge', 'edge']
    const a = lineFrom(kinds[0], of('lineA'), prior.lines[0])
    const b = lineFrom(kinds[1], of('lineB'), prior.lines[1])
    if (!a.ok) return a
    if (!b.ok) return b
    state = { kind: 'two-edges', lines: [a.line, b.line] }
  } else {
    if (prior.kind !== 'tangent') return { ok: false, reason: 'the face was never picked' }
    state = tangentState(of('tangentFace')[0], prior)
  }
  const framed = pickedPlaneFrame(state, definition.flipNormal)
  return framed.ok ? { ok: true, state, frame: framed.frame } : framed
}

/** The tangent plane's touch on `face`, continuing from `prior`. A cylinder keeps the angle it
 *  touches at; a flat face gives its own plane; anything else holds where it was picked. */
function tangentState(face: AxisFaceGeometry | undefined, prior: Extract<PickedPlaneState, { kind: 'tangent' }>): Extract<PickedPlaneState, { kind: 'tangent' }> {
  if (face === undefined) return prior
  const flat = planeOf(face)
  if (flat !== undefined) {
    const radial = alignTo(flat.normal, prior.radial)
    const point = nearestPointOnPlanes(prior.point, [flat])
    const xAcross = across(prior.axis, radial)
    const axis = vLength(xAcross) > PARALLEL_MIN ? vUnit(xAcross) : vUnit(across(Math.abs(radial.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }, radial))
    return { kind: 'tangent', point, radial, axis, centre: point }
  }
  if (face.surfaceType !== 'cylinder' || !hasAxis(face)) return prior
  const axis = alignTo(vUnit(face.axis), prior.axis)
  const radialAcross = across(prior.radial, axis)
  if (vLength(radialAcross) < PARALLEL_MIN) return prior
  const radial = vUnit(radialAcross)
  const onAxis = finiteVec(face.axisPoint) ? face.axisPoint : face.centroid
  const centre = vAdd(onAxis, vScale(axis, vDot(vSub(prior.point, onAxis), axis)))
  const radius = typeof face.radius === 'number' && Number.isFinite(face.radius) && face.radius > 0
    ? face.radius
    : vLength(across(vSub(prior.point, prior.centre), vUnit(prior.axis)))
  return { kind: 'tangent', point: vAdd(centre, vScale(radial, radius)), radial, axis, centre }
}

/** The tangent state a click on a face makes (the seed): `hit` is the clicked point on it. */
export function tangentSeed(face: AxisFaceGeometry, hit: Vec3, fallbackNormal?: Vec3): Extract<PickedPlaneState, { kind: 'tangent' }> | undefined {
  const flat = planeOf(face)
  if (flat !== undefined) {
    const point = nearestPointOnPlanes(hit, [flat])
    const axis = vUnit(across(Math.abs(flat.normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }, flat.normal))
    return { kind: 'tangent', point, radial: flat.normal, axis, centre: point }
  }
  if (face.surfaceType === 'cylinder' && hasAxis(face)) {
    const axis = vUnit(face.axis)
    const onAxis = finiteVec(face.axisPoint) ? face.axisPoint : face.centroid
    const centre = vAdd(onAxis, vScale(axis, vDot(vSub(hit, onAxis), axis)))
    const out = vSub(hit, centre)
    if (vLength(out) > MIN_LENGTH) {
      const radial = vUnit(out)
      const radius = typeof face.radius === 'number' && face.radius > 0 ? face.radius : vLength(out)
      return { kind: 'tangent', point: vAdd(centre, vScale(radial, radius)), radial, axis, centre }
    }
  }
  // any other surface: square to it where it was clicked, held there
  if (fallbackNormal === undefined || !(vLength(fallbackNormal) > MIN_LENGTH)) return undefined
  const radial = vUnit(fallbackNormal)
  const axis = vUnit(across(Math.abs(radial.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }, radial))
  return { kind: 'tangent', point: hit, radial, axis, centre: hit }
}

/** A picked plane's node, without inserting it. `seed` is what the pick made; the executor
 *  recomputes from the faces on every rebuild. */
export function buildPickedPlaneDatumNodeInput(opts: {
  id: string
  name: string
  definition: PickedPlaneDefinition
  faces: readonly ConstructFaceRefInput[]
  ownerIds: readonly string[]
  seed: PickedPlaneState
}): { nodeId: string; input: DagNodeInput } {
  const nodeId = `${PREFIX}${opts.id}`
  const framed = pickedPlaneFrame(opts.seed, opts.definition.flipNormal)
  const definition: PickedPlaneDefinition = {
    kind: opts.definition.kind,
    flipNormal: opts.definition.flipNormal,
    ...(opts.definition.lineKinds === undefined ? {} : { lineKinds: [...opts.definition.lineKinds] as [ConstructLineKind, ConstructLineKind] }),
  }
  return {
    nodeId,
    input: {
      id: nodeId,
      kind: 'datum',
      consumes: [...new Set(opts.ownerIds)],
      refs: constructFaceRefs(opts.faces),
      payload: {
        datumType: 'plane',
        planeKind: 'offset-plane',
        payloadSchema: 1,
        name: opts.name,
        definition,
        lastGoodPick: opts.seed,
        ...(framed.ok ? { lastGoodFrame: framed.frame } : {}),
      },
    },
  }
}

// ------------------------------------------------------------------ point datum

export type PointDefinitionKind = 'vertex' | 'circle-centre' | 'edge-plane'

export interface PointDefinition extends Record<string, unknown> {
  kind: PointDefinitionKind
  /** edge meets plane: how the picked edge became a line (fixed at the pick) */
  lineKind?: ConstructLineKind
}

export interface PointDatumPayload extends Record<string, unknown> {
  datumType: 'point'
  payloadSchema: 1
  name: string
  definition: PointDefinition
  lastGoodPoint?: Vec3
  /** edge meets plane: the edge's line as last built (continuity for the next rebuild) */
  lastGoodLine?: AxisLine
}

export function isPointDatumPayload(payload: Record<string, unknown>): payload is PointDatumPayload {
  if (payload.datumType !== 'point' || payload.payloadSchema !== 1) return false
  if (typeof payload.name !== 'string' || payload.name.length === 0) return false
  const d = payload.definition
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return false
  const def = d as Record<string, unknown>
  if (def.kind === 'edge-plane') return def.lineKind === 'edge' || def.lineKind === 'cylinder'
  return def.kind === 'vertex' || def.kind === 'circle-centre'
}

/** A point datum node's point, or undefined when `id` is not a resolved point datum. */
export function pointOfNode(dag: FeatureDag, id: string): Vec3 | undefined {
  const node = dag.getNode(id)
  if (node === undefined || node.kind !== 'datum' || !isPointDatumPayload(node.payload)) return undefined
  return finiteVec(node.payload.lastGoodPoint) ? node.payload.lastGoodPoint : undefined
}

/** Where a circle's centre is, from the faces of its round edge (or a round / flat face):
 *  a round face's axis meets the flat face beside it; a round face alone gives its axis point
 *  nearest `start`; flat faces alone hold `start` on them. */
export function circleCentre(faces: readonly AxisFaceGeometry[], start: Vec3): Vec3 {
  const flats = faces.flatMap((g) => planeOf(g) ?? [])
  const round = faces.find((g) => hasAxis(g) && finiteVec(g.axisPoint))
  if (round !== undefined && hasAxis(round)) {
    const line = { origin: round.axisPoint as Vec3, dir: vUnit(round.axis) }
    for (const flat of flats) {
      const met = lineMeetsPlane(line, { origin: vScale(flat.normal, flat.offset), normal: flat.normal })
      if (met !== undefined) return met
    }
    return vAdd(line.origin, vScale(line.dir, vDot(vSub(start, line.origin), line.dir)))
  }
  return nearestPointOnPlanes(start, flats)
}

export type PointResult = { ok: true; point: Vec3; line?: AxisLine } | { ok: false; reason: string }

/**
 * The point the faces (and, for edge meets plane, the plane) make now, continuing from the last
 * good point. The ONE rule the pick, Apply and the executor share.
 */
export function computeDatumPoint(
  definition: PointDefinition,
  faces: readonly ConstructFace[],
  prior: { point?: Vec3; line?: AxisLine },
  plane?: Pick<PlaneFrame, 'origin' | 'normal'>,
): PointResult {
  const of = (role: ConstructRefRole) => faces.filter((face) => face.role === role).map((face) => face.geometry)
  if (definition.kind === 'vertex') {
    if (prior.point === undefined) return { ok: false, reason: 'the vertex was never picked' }
    return { ok: true, point: nearestPointOnPlanes(prior.point, of('pointFace').flatMap((g) => planeOf(g) ?? [])) }
  }
  if (definition.kind === 'circle-centre') {
    const pointFaces = of('pointFace')
    const start = prior.point ?? pointFaces[0]?.centroid
    if (start === undefined) return { ok: false, reason: 'the circle was never picked' }
    return { ok: true, point: circleCentre(pointFaces, start) }
  }
  const line = lineFrom(definition.lineKind ?? 'edge', of('lineA'), prior.line)
  if (!line.ok) return line
  const facePlane = of('planeFace').flatMap((g) => planeOf(g) ?? [])[0]
  const target = plane ?? (facePlane === undefined ? undefined : { origin: vScale(facePlane.normal, facePlane.offset), normal: facePlane.normal })
  if (target === undefined) return { ok: false, reason: 'no plane to meet' }
  const met = lineMeetsPlane(line.line, target)
  if (met === undefined) return { ok: false, reason: 'the edge runs parallel to the plane - they never meet' }
  return { ok: true, point: met, line: line.line }
}

export function buildPointDatumNodeInput(opts: {
  id: string
  name: string
  definition: PointDefinition
  faces: readonly ConstructFaceRefInput[]
  /** the body features owning the faces, and (edge meets plane) the datum plane it meets */
  consumes: readonly string[]
  seed: Vec3
  seedLine?: AxisLine
}): { nodeId: string; input: DagNodeInput } {
  const nodeId = `${PREFIX}${opts.id}`
  const payload: PointDatumPayload = {
    datumType: 'point',
    payloadSchema: 1,
    name: opts.name,
    definition: { kind: opts.definition.kind, ...(opts.definition.lineKind === undefined ? {} : { lineKind: opts.definition.lineKind }) },
    lastGoodPoint: opts.seed,
    ...(opts.seedLine === undefined ? {} : { lastGoodLine: opts.seedLine }),
  }
  return {
    nodeId,
    input: { id: nodeId, kind: 'datum', consumes: [...new Set(opts.consumes)], refs: constructFaceRefs(opts.faces), payload },
  }
}

// ------------------------------------------------------------------ executors

function failure(nodeId: string, reason: string): { ok: false; diagnostics: Diag[] } {
  return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { id: nodeId, reason } }] }
}

/** Resolves every role-tagged face ref. `lost` when any is gone: the caller writes nothing and the
 *  scheduler marks the node degraded from the same ref (degraded beats guessing). */
async function resolveFaces(
  nodeId: string,
  refs: readonly FeatureRef[],
  map: ElementMap,
  lookup: AxisFaceGeometryLookup | undefined,
): Promise<{ kind: 'ok'; faces: ConstructFace[]; diagnostics: Diag[] } | { kind: 'lost' } | { kind: 'failed'; result: { ok: false; diagnostics: Diag[] } }> {
  const faces: ConstructFace[] = []
  const diagnostics: Diag[] = []
  for (const ref of refs) {
    const role = ROLES.find((r) => r === ref.role)
    if (role === undefined || ref.kind !== 'single-face') continue
    const res = map.resolve(ref.id, 'single-face')
    if (res.status === 'lost' || res.boundTo.length === 0) return { kind: 'lost' }
    const liveId = res.boundTo[0]
    if (res.status === 'fallback') diagnostics.push({ code: 'REFERENCE_FALLBACK', severity: 'warning', params: { id: ref.id, boundTo: liveId } })
    const geometry = (lookup === undefined ? undefined : await lookup(liveId)) ?? map.snapshotOf(liveId)
    if (geometry === undefined) return { kind: 'failed', result: failure(nodeId, `face '${liveId}' has no captured geometry`) }
    faces.push({ role, geometry })
  }
  return { kind: 'ok', faces, diagnostics }
}

/** Recompute a picked plane (called by makeDatumPlaneExecutor for the picked kinds). */
export async function runPickedPlane(
  dag: FeatureDag,
  map: ElementMap,
  node: { id: string; refs: readonly FeatureRef[]; payload: Record<string, unknown> & { definition: PickedPlaneDefinition } },
  lookup?: AxisFaceGeometryLookup,
): Promise<{ ok: boolean; diagnostics: Diag[] }> {
  const prior = node.payload.lastGoodPick
  if (!isPickedPlaneState(prior) || prior.kind !== node.payload.definition.kind) return failure(node.id, 'the plane has no pick to build from')
  const resolved = await resolveFaces(node.id, node.refs, map, lookup)
  if (resolved.kind === 'lost') return { ok: true, diagnostics: [] }
  if (resolved.kind === 'failed') return resolved.result
  const made = computePickedPlane(node.payload.definition, resolved.faces, prior)
  if (!made.ok) return failure(node.id, `plane refused: ${made.reason}`)
  dag.setPayload(node.id, { ...node.payload, lastGoodPick: made.state, lastGoodFrame: made.frame })
  return { ok: true, diagnostics: resolved.diagnostics }
}

/** The plane frame a point's consumed datum plane resolves to (World XY, a construction plane...). */
function consumedPlaneFrame(dag: FeatureDag, consumes: readonly string[]): { id: string; frame?: PlaneFrame } | undefined {
  for (const id of consumes) {
    const node = dag.getNode(id)
    if (node === undefined || node.kind !== 'datum' || node.payload.datumType !== 'plane') continue
    const frame = node.payload.lastGoodFrame as PlaneFrame | undefined
    return { id, ...(frame !== undefined && finiteVec(frame.origin) && finiteVec(frame.normal) ? { frame } : {}) }
  }
  return undefined
}

/** The FeatureOp for point datums: resolves the faces (and the plane it meets), writes the point. */
export function makeDatumPointExecutor(dag: FeatureDag, map: ElementMap, lookup?: AxisFaceGeometryLookup): FeatureOp {
  return async (node) => {
    if (node.kind !== 'datum' || node.payload.datumType !== 'point') return { ok: true, diagnostics: [] }
    const payload = node.payload
    if (!isPointDatumPayload(payload)) return failure(node.id, 'point payload is malformed or uses an unsupported schema')
    const resolved = await resolveFaces(node.id, node.refs, map, lookup)
    if (resolved.kind === 'lost') return { ok: true, diagnostics: [] }
    if (resolved.kind === 'failed') return resolved.result
    let plane: PlaneFrame | undefined
    if (payload.definition.kind === 'edge-plane') {
      const consumed = consumedPlaneFrame(dag, node.consumes)
      if (consumed !== undefined) {
        if (consumed.frame === undefined) return failure(node.id, `plane '${consumed.id}' has no resolved frame`)
        plane = consumed.frame
      }
    }
    const prior = {
      ...(finiteVec(payload.lastGoodPoint) ? { point: payload.lastGoodPoint } : {}),
      ...(isFiniteAxisLine(payload.lastGoodLine) ? { line: payload.lastGoodLine } : {}),
    }
    const made = computeDatumPoint(payload.definition, resolved.faces, prior, plane)
    if (!made.ok) return failure(node.id, `point refused: ${made.reason}`)
    dag.setPayload(node.id, { ...payload, lastGoodPoint: made.point, ...(made.line === undefined ? {} : { lastGoodLine: made.line }) })
    return { ok: true, diagnostics: resolved.diagnostics }
  }
}
