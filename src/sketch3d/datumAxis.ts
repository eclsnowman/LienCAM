// Axis datums (WO-2222, Construct: Axis). A straight line in model space, made from a pick:
//  - 'cylinder':   through a cylindrical face or hole (its axis); a flat face gives its normal
//                  through its centre, the one axis a flat face has.
//  - 'edge':       along a straight edge.
//  - 'two-points': through two vertices, first to second.
//
// Same DAG shape as the face-plane datum (datumPlane.ts's header): every picked face lives in the
// node's `refs` (so ElementMap resolution and degraded status come for free), the body features
// owning those faces are its `consumes` (so a rebuild of the body re-runs the axis), and the line
// itself is WRITTEN by this node's own executor.
//
// References are faces only, because faces are what the ElementMap tracks: an edge is named by its
// two faces `(A^B)` and a vertex by the faces its edges touch (stable-id-spec's edge grammar). On a
// rebuild the line is recomputed from those faces -- an edge between two flat faces is exactly
// their line of intersection, a vertex among three flat faces exactly their common point. Where the
// faces pin less than that (a curved neighbour, an imported id), the rest of the position comes
// from the last good line, moved the least distance that satisfies every face that still speaks.
//
// `lastGoodAxis` is the UNFLIPPED line; datumAxisLine() applies `definition.flip`. Keeping the flip
// out of the stored line means a Flip edit changes one boolean and the rebuild's direction
// continuity (a kernel axis has no preferred sign) never fights it.

import type { DagNodeInput, ElementMap, FeatureDag, FeatureOp, FeatureRef } from '../doc'
import type { Diag, StableId, SurfaceType, Vec3 } from '../geom/geom-service'
import { vAdd, vCross, vDot, vLength, vScale, vSub, vUnit } from './planeMath'

const PREFIX = 'datum:'
const MIN_LENGTH = 1e-9
/** Two face normals closer than this to parallel have no line of intersection. */
const PARALLEL_CROSS_MIN = 1e-6
/** Length an axis is drawn when nothing picked gives it one. */
export const DEFAULT_AXIS_LENGTH = 40

export type AxisDefinitionKind = 'cylinder' | 'edge' | 'two-points'

export interface AxisDefinition extends Record<string, unknown> {
  kind: AxisDefinitionKind
  /** Reverses the axis direction (the right-hand sense a Revolve or Plane at angle turns by). */
  flip: boolean
}

/** A bounded piece of the axis: from `origin` along unit `dir` for `length` mm. The line itself is
 *  infinite; the segment is what the viewport draws and where a two-point axis ends. */
export interface AxisLine extends Record<string, unknown> {
  origin: Vec3
  dir: Vec3
  length: number
}

export interface AxisDatumPayload extends Record<string, unknown> {
  datumType: 'axis'
  payloadSchema: 1
  name: string
  definition: AxisDefinition
  /** The unflipped line the last rebuild made (see this file's header). */
  lastGoodAxis?: AxisLine
}

/** Ref roles: which picked element a face reference belongs to. */
export type AxisRefRole = 'axisFace' | 'edgeFace' | 'pointA' | 'pointB'

const ROLES: readonly AxisRefRole[] = ['axisFace', 'edgeFace', 'pointA', 'pointB']

function finiteVec(v: unknown): v is Vec3 {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.x === 'number' && typeof o.y === 'number' && typeof o.z === 'number' &&
    Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z)
}

export function isFiniteAxisLine(line: unknown): line is AxisLine {
  if (line === null || typeof line !== 'object') return false
  const l = line as Record<string, unknown>
  return finiteVec(l.origin) && finiteVec(l.dir) && vLength(l.dir) > MIN_LENGTH &&
    typeof l.length === 'number' && Number.isFinite(l.length) && l.length >= 0
}

export function isAxisDatumPayload(payload: Record<string, unknown>): payload is AxisDatumPayload {
  if (payload.datumType !== 'axis' || payload.payloadSchema !== 1) return false
  if (typeof payload.name !== 'string' || payload.name.length === 0) return false
  const d = payload.definition
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return false
  const def = d as Record<string, unknown>
  if (typeof def.flip !== 'boolean') return false
  return def.kind === 'cylinder' || def.kind === 'edge' || def.kind === 'two-points'
}

/** Is `id` a live axis datum node in `dag`? */
export function isAxisDatumNode(dag: FeatureDag, id: string): boolean {
  const node = dag.getNode(id)
  return node !== undefined && node.kind === 'datum' && isAxisDatumPayload(node.payload)
}

/** The line as its consumers use it: the stored line with the flip applied. A flipped axis keeps the
 *  same segment and runs the other way. */
export function flipAxisLine(line: AxisLine): AxisLine {
  return { origin: vAdd(line.origin, vScale(line.dir, line.length)), dir: vScale(line.dir, -1), length: line.length }
}

export function datumAxisLine(payload: AxisDatumPayload): AxisLine | undefined {
  const line = payload.lastGoodAxis
  if (!isFiniteAxisLine(line)) return undefined
  return payload.definition.flip ? flipAxisLine(line) : line
}

/** An axis datum node's line (flip applied), or undefined when `id` is not a resolved axis datum. */
export function axisLineOfNode(dag: FeatureDag, id: string): AxisLine | undefined {
  const node = dag.getNode(id)
  if (node === undefined || node.kind !== 'datum' || !isAxisDatumPayload(node.payload)) return undefined
  return datumAxisLine(node.payload)
}

/** The picked geometry the axis math reads for one face -- the frozen contract's snapshot fields plus
 *  the worker's analytic `axisPoint` for a cylinder when the host can supply it. */
export interface AxisFaceGeometry {
  surfaceType: SurfaceType
  centroid: Vec3
  normal?: Vec3
  axis?: Vec3
  /** any point on a cylinder's axis */
  axisPoint?: Vec3
  /** a cylinder's radius, when the host can supply it (WO-2223: the tangent plane) */
  radius?: number
}

export type AxisFace = { role: AxisRefRole; geometry: AxisFaceGeometry }

export type AxisLineResult = { ok: true; axis: AxisLine } | { ok: false; reason: string }

interface PlaneConstraint {
  normal: Vec3
  offset: number
}

function planeConstraintOf(geometry: AxisFaceGeometry): PlaneConstraint | undefined {
  if (geometry.surfaceType !== 'plane' || !finiteVec(geometry.normal) || vLength(geometry.normal) < MIN_LENGTH) return undefined
  const normal = vUnit(geometry.normal)
  return { normal, offset: vDot(normal, geometry.centroid) }
}

/** The point nearest `start` that lies on every plane given (dependent planes are skipped). Exact for
 *  three independent planes; two give their line, one its plane. Pure Gram-Schmidt: no matrix. */
export function nearestPointOnPlanes(start: Vec3, planes: readonly PlaneConstraint[]): Vec3 {
  const basis: PlaneConstraint[] = []
  for (const plane of planes) {
    let n = plane.normal
    let c = plane.offset
    for (const b of basis) {
      const k = vDot(n, b.normal)
      n = vSub(n, vScale(b.normal, k))
      c -= b.offset * k
    }
    const len = vLength(n)
    if (len < PARALLEL_CROSS_MIN) continue
    basis.push({ normal: vScale(n, 1 / len), offset: c / len })
  }
  let p = start
  for (const b of basis) p = vAdd(p, vScale(b.normal, b.offset - vDot(b.normal, start)))
  return p
}

function alignTo(dir: Vec3, prior: AxisLine | undefined): Vec3 {
  return prior !== undefined && vDot(dir, prior.dir) < 0 ? vScale(dir, -1) : dir
}

function centredLine(centre: Vec3, dir: Vec3, length: number): AxisLine {
  return { origin: vSub(centre, vScale(dir, length / 2)), dir, length }
}

function lineCentre(line: AxisLine): Vec3 {
  return vAdd(line.origin, vScale(line.dir, line.length / 2))
}

/**
 * The axis (unflipped) the picked faces make now. `prior` is the last good line: it keeps the
 * direction's sign across rebuilds, keeps the drawn length, and supplies whatever position the
 * faces do not pin. The ONE rule the executor, the dialog's preview and Apply all use.
 */
export function computeAxisLine(kind: AxisDefinitionKind, faces: readonly AxisFace[], prior?: AxisLine): AxisLineResult {
  const of = (role: AxisRefRole) => faces.filter((face) => face.role === role).map((face) => face.geometry)
  const length = prior?.length ?? DEFAULT_AXIS_LENGTH

  if (kind === 'cylinder') {
    const face = of('axisFace')[0]
    if (face === undefined) return { ok: false, reason: 'no face picked' }
    if (finiteVec(face.axis) && vLength(face.axis) > MIN_LENGTH) {
      const dir = alignTo(vUnit(face.axis), prior)
      const onAxis = finiteVec(face.axisPoint) ? face.axisPoint : face.centroid
      // the face's centre, moved square onto the axis: the drawn piece sits in the hole
      const centre = vAdd(onAxis, vScale(dir, vDot(vSub(face.centroid, onAxis), dir)))
      return { ok: true, axis: centredLine(centre, dir, length) }
    }
    const plane = planeConstraintOf(face)
    if (plane !== undefined) return { ok: true, axis: centredLine(face.centroid, alignTo(plane.normal, prior), length) }
    if (prior !== undefined) return { ok: true, axis: prior }
    return { ok: false, reason: 'the face has no axis' }
  }

  if (kind === 'edge') {
    const edgeFaces = of('edgeFace')
    const planes = edgeFaces.flatMap((face) => planeConstraintOf(face) ?? [])
    const axial = edgeFaces.find((face) => finiteVec(face.axis) && vLength(face.axis) > MIN_LENGTH)
    let dir: Vec3 | undefined
    for (let i = 0; i < planes.length && dir === undefined; i++) {
      for (let j = i + 1; j < planes.length && dir === undefined; j++) {
        const cross = vCross(planes[i].normal, planes[j].normal)
        if (vLength(cross) > PARALLEL_CROSS_MIN) dir = vUnit(cross)
      }
    }
    // a straight edge on a cylinder runs along its axis (a flat on a round shaft)
    if (dir === undefined && axial !== undefined && planes.length > 0) dir = vUnit(axial.axis as Vec3)
    if (dir === undefined) {
      if (prior !== undefined) return { ok: true, axis: prior }
      return { ok: false, reason: 'the edge faces do not meet in a line' }
    }
    dir = alignTo(dir, prior)
    const start = prior !== undefined
      ? lineCentre(prior)
      : vScale(edgeFaces.reduce((sum, face) => vAdd(sum, face.centroid), { x: 0, y: 0, z: 0 }), 1 / Math.max(1, edgeFaces.length))
    return { ok: true, axis: centredLine(nearestPointOnPlanes(start, planes), dir, length) }
  }

  // two points: each vertex rides its own flat faces from where it was last
  if (prior === undefined) return { ok: false, reason: 'the two points were never picked' }
  const planesOf = (role: AxisRefRole) => of(role).flatMap((face) => planeConstraintOf(face) ?? [])
  const a = nearestPointOnPlanes(prior.origin, planesOf('pointA'))
  const b = nearestPointOnPlanes(vAdd(prior.origin, vScale(prior.dir, prior.length)), planesOf('pointB'))
  const ab = vSub(b, a)
  const span = vLength(ab)
  if (!(span > MIN_LENGTH)) return { ok: false, reason: 'the two points are the same point' }
  return { ok: true, axis: { origin: a, dir: vScale(ab, 1 / span), length: span } }
}

/** A datum axis node id (the shared `datum:` namespace every datum uses). */
export function datumAxisNodeId(id: string): string {
  return `${PREFIX}${id}`
}

export interface AxisFaceRefInput {
  role: AxisRefRole
  faceId: StableId
}

/** The DagNodeInput for a new axis datum, without inserting it. `seed` is the line the pick made
 *  (unflipped); the executor recomputes from the faces on every rebuild, continuing from it. */
export function buildAxisDatumNodeInput(opts: {
  id: string
  name: string
  definition: AxisDefinition
  faces: readonly AxisFaceRefInput[]
  ownerIds: readonly string[]
  seed: AxisLine
}): { nodeId: string; input: DagNodeInput } {
  const nodeId = datumAxisNodeId(opts.id)
  const payload: AxisDatumPayload = {
    datumType: 'axis',
    payloadSchema: 1,
    name: opts.name,
    definition: { kind: opts.definition.kind, flip: opts.definition.flip },
    lastGoodAxis: opts.seed,
  }
  return {
    nodeId,
    input: {
      id: nodeId,
      kind: 'datum',
      consumes: [...new Set(opts.ownerIds)],
      refs: axisFaceRefs(opts.faces),
      payload,
    },
  }
}

/** One face ref per (role, face): the same face under two roles (a vertex on both ends' faces) stays
 *  two refs so each point keeps its own set. */
export function axisFaceRefs(faces: readonly AxisFaceRefInput[]): FeatureRef[] {
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

function failure(nodeId: string, reason: string): { ok: false; diagnostics: Diag[] } {
  return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { id: nodeId, reason } }] }
}

/** How the executor reads a resolved face. The workbench passes one that adds the worker's analytic
 *  cylinder axis point; without it the ElementMap's own snapshot is used. */
export type AxisFaceGeometryLookup = (liveFaceId: StableId) => Promise<AxisFaceGeometry | undefined> | AxisFaceGeometry | undefined

/**
 * The FeatureOp for axis datums. Resolves each face ref, recomputes the line, writes lastGoodAxis.
 * A lost face writes nothing (the last good line stays, and the scheduler marks the node degraded
 * from the same ref), exactly as a face-plane datum does.
 */
export function makeDatumAxisExecutor(dag: FeatureDag, map: ElementMap, lookup?: AxisFaceGeometryLookup): FeatureOp {
  return async (node) => {
    if (node.kind !== 'datum' || node.payload.datumType !== 'axis') return { ok: true, diagnostics: [] }
    const payload = node.payload
    if (!isAxisDatumPayload(payload)) return failure(node.id, 'axis payload is malformed or uses an unsupported schema')
    const faces: AxisFace[] = []
    const diagnostics: Diag[] = []
    for (const ref of node.refs) {
      const role = ROLES.find((r) => r === ref.role)
      if (role === undefined || ref.kind !== 'single-face') continue
      const res = map.resolve(ref.id, 'single-face')
      if (res.status === 'lost' || res.boundTo.length === 0) return { ok: true, diagnostics: [] }
      const liveId = res.boundTo[0]
      if (res.status === 'fallback') diagnostics.push({ code: 'REFERENCE_FALLBACK', severity: 'warning', params: { id: ref.id, boundTo: liveId } })
      const geometry = (lookup === undefined ? undefined : await lookup(liveId)) ?? map.snapshotOf(liveId)
      if (geometry === undefined) return failure(node.id, `face '${liveId}' has no captured geometry`)
      faces.push({ role, geometry })
    }
    const prior = isFiniteAxisLine(payload.lastGoodAxis) ? payload.lastGoodAxis : undefined
    const result = computeAxisLine(payload.definition.kind, faces, prior)
    if (!result.ok) return failure(node.id, `axis refused: ${result.reason}`)
    dag.setPayload(node.id, { ...payload, lastGoodAxis: result.axis })
    return { ok: true, diagnostics }
  }
}
