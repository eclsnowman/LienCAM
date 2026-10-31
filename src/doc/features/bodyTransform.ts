// WO-3244: the Body Transform feature (Model > Modify > Mirror). ONE payload
// shape and ONE replay step, shared by the live Model screen executor
// (SolidsWorkbenchPage makeReplayExecutor) and the background replay
// (lib/cam/headlessFeatureReplay runHeadlessFeature), so a reopened project's
// Regen All rebuilds exactly the body the operator mirrored.
//
// The payload is plain JSON - the source body and the mirror plane by node id,
// never a handle or a plane snapshot: the plane's CURRENT frame is read on
// every replay, so moving an offset plane moves the reflection. This slice
// replaces the source body with its reflection (`result: 'replace'`); keeping
// the source as well is a later order.
//
// Pure module: no React, no i18n. A refusal comes back as a kind the caller
// words (lib/operatorLabels bodyTransformRefusalText), so both routes say the
// same thing.

import type { BodyHandle, OpResult, PlaneDef, TransformBodyRequest, Vec3 } from '../../geom/geom-service'
import type { Command } from '../commands'
import type { DagNodeSnapshot, FeatureDag, FeatureRef } from '../dag'
import { BODY_IDENTITY_PAYLOAD_CARRIERS } from '../persist/versioning'
import { EDGE_DISAMB_MARK, EDGE_JOIN, edgeId, parseStableId, patternInstanceId, vertexId } from '../stable-id'

export const BODY_TRANSFORM_OP_TYPE = 'bodyTransform'

export interface BodyTransformPayloadV1 {
  opType: 'bodyTransform'
  version: 1
  sourceBodyId: string
  transform: { kind: 'mirror'; planeNodeId: string }
  result: 'replace'
  name: string
}

export type BodyTransformRefusal =
  | { kind: 'malformed'; nodeId: string }
  | { kind: 'sourceNotLive'; nodeId: string; sourceBodyId: string }
  | { kind: 'planeUnresolved'; nodeId: string; planeNodeId: string }
  | { kind: 'noTransform'; nodeId: string }

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The payload, or undefined when any required field is missing or wrong. */
export function parseBodyTransformPayload(payload: Record<string, unknown>): BodyTransformPayloadV1 | undefined {
  if (payload.opType !== BODY_TRANSFORM_OP_TYPE || payload.version !== 1) return undefined
  if (!nonEmpty(payload.sourceBodyId) || typeof payload.name !== 'string' || payload.result !== 'replace') return undefined
  const t = payload.transform
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return undefined
  const transform = t as Record<string, unknown>
  if (transform.kind !== 'mirror' || !nonEmpty(transform.planeNodeId)) return undefined
  return {
    opType: BODY_TRANSFORM_OP_TYPE,
    version: 1,
    sourceBodyId: payload.sourceBodyId,
    transform: { kind: 'mirror', planeNodeId: transform.planeNodeId },
    result: 'replace',
    name: payload.name,
  }
}

/** A new Mirror (replace original) payload. */
export function mirrorReplacePayload(args: { sourceBodyId: string; planeNodeId: string; name: string }): BodyTransformPayloadV1 {
  return {
    opType: BODY_TRANSFORM_OP_TYPE,
    version: 1,
    sourceBodyId: args.sourceBodyId,
    transform: { kind: 'mirror', planeNodeId: args.planeNodeId },
    result: 'replace',
    name: args.name,
  }
}

/** The node's dependencies: the source body and the plane (once each). */
export function bodyTransformConsumes(payload: Pick<BodyTransformPayloadV1, 'sourceBodyId' | 'transform'>): string[] {
  return [...new Set([payload.sourceBodyId, payload.transform.planeNodeId])]
}

/** The first proposed dependency of `featureId` that is `featureId` itself or
 *  is already built from its result - choosing it would make the feature
 *  depend on its own output (a cycle). undefined when every choice is safe. */
export function bodyTransformCyclicChoice(dag: FeatureDag, featureId: string, consumes: readonly string[]): string | undefined {
  if (!dag.has(featureId)) return undefined
  const downstream = new Set(dag.transitiveConsumersOf(featureId))
  return consumes.find((id) => id === featureId || downstream.has(id))
}

// ---------------------------------------------------------------------------
// A later feature's references across a Mirror (audit round 3: ONE resolver).
//
// A Mirror (replace) names every face of its result `<mirror>:PAT:i1:<source
// face>` (geom-engine transformBody), and an edge or vertex id is derived from
// its adjacent face ids. A feature authored on the source KEEPS its own
// references when a Mirror is inserted before it - only its body carrier moves
// (RewireReplacedBodyConsumersCommand). Every replay, the Model tab and the
// background replay alike, resolves them through each Mirror its owner chain
// passes, with that Mirror's CURRENT plane (resolveReferencesThroughMirrors).
// Nothing mapped is ever stored, so moving or re-picking the plane, or undoing
// the insert, re-resolves on the next pass instead of leaving a stale copy.
//
// The mapping is by name, never by a kernel guess: `F` -> `M:PAT:i1:F`,
// `(A^B)` -> `(M:PAT:i1:A^M:PAT:i1:B)`, and a band a modifier between the
// Mirror and the feature made from such an edge or face is renamed through it.
// Positions and directions stored in world space (hole points, a draft's pull
// and neutral plane, push/pull's normal, an edge's geometric disambiguator)
// are reflected in the plane. An id already on the mirrored result renames to
// itself, so a feature authored after the Mirror resolves unchanged.
// ---------------------------------------------------------------------------

/** Why a later feature's reference cannot follow the mirror. */
export type MirrorCarryRefusalKind =
  /** the feature keeps references the mirror has no named form for
   *  (recognized feature keys, a relief picture, an imported blend key, an
   *  op this mapping does not know) */
  | 'notCarried'
  /** a position must be reflected, but the mirror plane does not resolve now */
  | 'noPlane'
  /** the reference id is not a face, edge or vertex of the body */
  | 'badReference'

/** A reference that cannot follow a Mirror, by feature and reference. Thrown
 *  at Apply (inside the insert's CompositeCommand, so the insert unwinds and
 *  history records nothing) and returned by the replay resolver. */
export class MirrorReferenceNotCarriedError extends Error {
  readonly featureId: string
  readonly reference: string
  readonly kind: MirrorCarryRefusalKind
  readonly mirrorId: string
  constructor(featureId: string, reference: string, kind: MirrorCarryRefusalKind, mirrorId = '') {
    super(`${featureId}: reference '${reference}' cannot be carried onto the mirrored body (${kind})`)
    this.name = 'MirrorReferenceNotCarriedError'
    this.featureId = featureId
    this.reference = reference
    this.kind = kind
    this.mirrorId = mirrorId
  }
}

type Refuse = (reference: string, kind: MirrorCarryRefusalKind) => never

const SNAP_EPS = 1e-7
const EDGE_TOKEN_RE = /^m(-?\d+)_(-?\d+)_(-?\d+)_l(-?\d+)$/
const AXES: Record<string, Vec3> = { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } }

const vec = (v: unknown): Vec3 | undefined => {
  if (v === null || typeof v !== 'object') return undefined
  const { x, y, z } = v as Record<string, unknown>
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' && [x, y, z].every(Number.isFinite)
    ? { x, y, z }
    : undefined
}
const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
const along = (o: Vec3, d: Vec3, t: number): Vec3 => ({ x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t })

interface Reflector { reflectPoint(p: Vec3): Vec3; reflectVector(v: Vec3): Vec3 }

/** The mirror plane as a reflection. undefined when degenerate. */
function mirrorOf(plane: PlaneDef | undefined): Reflector | undefined {
  if (plane === undefined) return undefined
  const o = vec(plane.origin)
  const raw = vec(plane.normal)
  if (o === undefined || raw === undefined) return undefined
  const l = Math.hypot(raw.x, raw.y, raw.z)
  if (!(l > 1e-12)) return undefined
  const n = { x: raw.x / l, y: raw.y / l, z: raw.z / l }
  const reflectVector = (v: Vec3): Vec3 => {
    const d = 2 * dot3(v, n)
    return { x: v.x - d * n.x || 0, y: v.y - d * n.y || 0, z: v.z - d * n.z || 0 }
  }
  const reflectPoint = (p: Vec3): Vec3 => {
    const d = 2 * (dot3(p, n) - dot3(o, n))
    return { x: p.x - d * n.x || 0, y: p.y - d * n.y || 0, z: p.z - d * n.z || 0 }
  }
  return { reflectPoint, reflectVector }
}

/** True when `id` already names something on `mirrorId`'s result. */
function onMirrorResult(id: string, mirrorId: string): boolean {
  const mark = patternInstanceId(mirrorId, 1, '')
  for (let i = id.indexOf(mark); i >= 0; i = id.indexOf(mark, i + 1)) {
    if (i === 0 || `:(${EDGE_JOIN}`.includes(id[i - 1])) return true
  }
  return false
}

/**
 * One face, edge or vertex id renamed onto `mirrorId`'s result. `downstream`
 * holds the modifiers (and later Mirrors) between that Mirror and the feature
 * being resolved: a band they made from an edge or face is renamed through
 * it, and a face they made from no other face (a hole wall, a heal face) keeps
 * its name. An id already on the result comes back unchanged. An edge's GEO-16
 * disambiguator (mid-point + length) is reflected and re-snapped when the edge
 * moves; a seam keeps its `seam#k`. undefined when the id cannot be carried by
 * name (an orphan seam, a face a modifier made in a way this does not know, a
 * token with no plane).
 */
export function mirroredStableId(
  mirrorId: string,
  id: string,
  mirror?: Pick<Reflector, 'reflectPoint'>,
  downstream: ReadonlySet<string> = new Set(),
): string | undefined {
  const rename = (x: string): string | undefined => mirroredStableId(mirrorId, x, mirror, downstream)
  const parsed = parseStableId(id)
  if (parsed.kind === 'segments') {
    if (id.length === 0) return undefined
    const fid = parsed.featureId
    if (fid === mirrorId) return id
    if (!downstream.has(fid)) return patternInstanceId(mirrorId, 1, id)
    const op = parsed.opCode ?? ''
    const rest = id.slice(fid.length + op.length + 2)
    const wrap = (inner: string | undefined, before: string, after = ''): string | undefined =>
      inner === undefined ? undefined : `${fid}:${op}:${before}${inner}${after}`
    if (op === 'FIL' || op === 'CHM') return wrap(rename(rest), '')
    if (op === 'SHL' && rest.endsWith(':inner')) return wrap(rename(rest.slice(0, -':inner'.length)), '', ':inner')
    if (op === 'PAT' && rest.startsWith('i1:')) return wrap(rename(rest.slice(3)), 'i1:')
    if (op === 'HOL' || op === 'DELF') return id
    return onMirrorResult(id, mirrorId) ? id : undefined
  }
  const ops = parsed.operands
  if (ops.length < 2 || ops.some((o) => o.isOrphan || o.raw.length === 0)) return undefined
  const mapped: string[] = []
  for (const o of ops) {
    const m = o.isSeam ? o.raw : rename(o.raw)
    if (m === undefined) return undefined
    mapped.push(m)
  }
  if (mapped.every((m, i) => m === ops[i].raw)) return id
  const seams = ops.filter((o) => o.isSeam).map((o) => o.raw)
  const faces = mapped.filter((_, i) => !ops[i].isSeam)
  let base: string
  if (seams.length === 0) base = ops.length === 2 ? edgeId(faces[0], faces[1]) : vertexId(faces)
  else if (ops.length === 2 && faces.length === 1) base = `(${faces[0]}${EDGE_JOIN}${seams[0]})`
  else return undefined
  if (parsed.disambiguator === undefined) return base
  const m = EDGE_TOKEN_RE.exec(parsed.disambiguator)
  if (m === null || mirror === undefined) return undefined
  const mid = mirror.reflectPoint({ x: Number(m[1]) * SNAP_EPS, y: Number(m[2]) * SNAP_EPS, z: Number(m[3]) * SNAP_EPS })
  const snap = (x: number): number => Math.round(x / SNAP_EPS) || 0
  return `${base}${EDGE_DISAMB_MARK}m${snap(mid.x)}_${snap(mid.y)}_${snap(mid.z)}_l${m[4]}`
}

/** The ops whose references have an exact mirrored form. A Fillet/Chamfer
 *  holding an imported blend key does not: the key names the source's blend. */
const CARRIED_OPS: ReadonlySet<string> = new Set(['fillet', 'chamfer', 'shell', 'hole', 'draft', 'pushPull'])

/**
 * The payload and refs of a feature on the body Mirror `mirrorId` replaced,
 * resolved through that one Mirror. Only references named before the Mirror
 * move; a hole's points, a draft's pull and neutral plane and push/pull's
 * normal are reflected when the face they sit on moves. Throws
 * MirrorReferenceNotCarriedError (by feature and reference).
 */
export function carryReferencesThroughMirror(
  node: Pick<DagNodeSnapshot, 'id' | 'payload' | 'refs'>,
  mirrorId: string,
  plane: PlaneDef | undefined,
  downstream: ReadonlySet<string> = new Set(),
): { payload: Record<string, unknown>; refs: FeatureRef[] } {
  const refuse: Refuse = (reference, kind) => { throw new MirrorReferenceNotCarriedError(node.id, reference, kind, mirrorId) }
  const reflector = mirrorOf(plane)
  const needMirror = (reference: string): Reflector => reflector ?? refuse(reference, 'noPlane')
  const mapId = (id: unknown): string => {
    if (typeof id !== 'string') return refuse(String(id), 'badReference')
    const lazy = { reflectPoint: (q: Vec3) => needMirror(id).reflectPoint(q) }
    return mirroredStableId(mirrorId, id, lazy, downstream) ?? refuse(id, 'badReference')
  }
  const mapIds = (field: string, p: Record<string, unknown>): string[] => {
    const ids = p[field]
    if (!Array.isArray(ids)) return refuse(field, 'badReference')
    return ids.map(mapId)
  }
  /** the anchor face was named before the mirror, so its stored positions are too */
  const moves = (id: unknown): boolean => id !== undefined && mapId(id) !== id
  const point = (field: string, v: unknown): Vec3 => needMirror(field).reflectPoint(vec(v) ?? refuse(field, 'badReference'))
  const direction = (field: string, v: unknown): Vec3 => needMirror(field).reflectVector(vec(v) ?? refuse(field, 'badReference'))

  const p = node.payload
  const next: Record<string, unknown> = { ...p }
  const opType = typeof p.opType === 'string' ? p.opType : ''
  const refs = node.refs ?? []
  if (opType === 'fillet' || opType === 'chamfer') {
    if (p.importedFeatureKey !== undefined || p.importedFaceId !== undefined) {
      if (moves(p.importedFaceId) || p.importedFaceId === undefined) refuse(String(p.importedFeatureKey ?? p.importedFaceId), 'notCarried')
    } else {
      next.edges = mapIds('edges', p)
    }
  } else if (opType === 'shell') {
    next.removeFaces = mapIds('removeFaces', p)
  } else if (opType === 'hole') {
    const moved = moves(p.faceId)
    next.faceId = mapId(p.faceId)
    if (moved) {
      if (!Array.isArray(p.points)) refuse('points', 'badReference')
      next.points = (p.points as unknown[]).map((q) => point('points', q))
      if (p.seed !== undefined) next.seed = point('seed', p.seed)
      if (p.normal !== undefined) next.normal = direction('normal', p.normal)
    }
  } else if (opType === 'draft') {
    const moved = [...(Array.isArray(p.faces) ? p.faces : []), p.faceFrameSourceId].some(moves)
    next.faces = mapIds('faces', p)
    if (p.faceFrameSourceId !== undefined) next.faceFrameSourceId = mapId(p.faceFrameSourceId)
    if (moved) reflectDraft(p, next, needMirror('pullAxis'), refuse)
  } else if (opType === 'pushPull') {
    if (p.normal !== undefined && refs.some((r) => moves(r.id))) next.normal = direction('normal', p.normal)
  } else {
    // A feature this mapping has no named form for. Apply refuses to insert a
    // Mirror before one (assertCarriedThroughMirror), so it is only ever
    // authored on the result and resolves unchanged.
    return { payload: p, refs }
  }
  return { payload: next, refs: refs.map((r) => ({ ...r, id: mapId(r.id) })) }
}

/**
 * A draft's pull direction and neutral plane, reflected. Axis mode and
 * selected-face mode both reduce to one pull direction and one neutral plane
 * (dressUpGeometry draftPullDir/draftNeutralPlane/draftFaceNormalPlane); the
 * reflection is written as a selected-face frame - origin on the reflected
 * neutral plane, normal the reflected pull - which holds ANY direction, so a
 * plane oblique to the pull axis is carried, never refused.
 */
function reflectDraft(p: Record<string, unknown>, next: Record<string, unknown>, m: Reflector, refuse: Refuse): void {
  const offset = typeof p.offset === 'number' && Number.isFinite(p.offset) ? p.offset : undefined
  let pull: Vec3
  let origin: Vec3
  if (p.pullMode === 'face-normal') {
    const frame = p.faceFrame as { origin?: unknown; normal?: unknown } | undefined
    const o = vec(frame?.origin)
    const n = vec(frame?.normal)
    const l = n === undefined ? 0 : Math.hypot(n.x, n.y, n.z)
    // no usable frame: left as stored, so the executor names it (re-pick the face)
    if (o === undefined || n === undefined || !(l > 1e-9) || offset === undefined) return
    const s = (p.pullFlip === true ? -1 : 1) / l
    pull = { x: n.x * s, y: n.y * s, z: n.z * s }
    origin = along(o, pull, offset)
  } else {
    const axis = AXES[String(p.pullAxis)]
    if (axis === undefined || offset === undefined) return refuse('pullAxis', 'badReference')
    pull = p.pullFlip === true ? { x: -axis.x, y: -axis.y, z: -axis.z } : axis
    origin = along({ x: 0, y: 0, z: 0 }, pull, offset)
    // axis mode names no neutral face; selected-face mode would test one
    delete next.faceFrameSourceId
  }
  next.pullMode = 'face-normal'
  next.faceFrame = { origin: m.reflectPoint(origin), normal: m.reflectVector(pull) }
  next.pullFlip = false
  next.offset = 0
}

interface OwnerLink {
  id: string
  /** set when this link is a Mirror: the plane it reflects in */
  planeNodeId?: string
}

/** The bodies a feature's `ownerId` reaches, nearest first: through each
 *  modifier's ownerId and each Mirror's sourceBodyId. */
function ownerChainOf(dag: Pick<FeatureDag, 'getNode'>, node: Pick<DagNodeSnapshot, 'id' | 'payload'>): OwnerLink[] {
  const chain: OwnerLink[] = []
  const seen = new Set([node.id])
  let id = typeof node.payload.ownerId === 'string' ? node.payload.ownerId : undefined
  while (id !== undefined && !seen.has(id)) {
    seen.add(id)
    const owner = dag.getNode(id)
    if (owner === undefined || owner.kind !== 'feature') break
    const mirror = parseBodyTransformPayload(owner.payload)
    if (mirror !== undefined) {
      chain.push({ id, planeNodeId: mirror.transform.planeNodeId })
      id = mirror.sourceBodyId
    } else {
      chain.push({ id })
      id = typeof owner.payload.ownerId === 'string' ? owner.payload.ownerId : undefined
    }
  }
  return chain
}

export type MirrorReferenceResolution =
  | { ok: true; node: DagNodeSnapshot }
  | { ok: false; error: MirrorReferenceNotCarriedError }

/**
 * THE resolver both replay routes call before running a feature: the node
 * with its references resolved through every Mirror its owner chain passes,
 * farthest first, each with its plane's CURRENT frame (`resolvePlane`, the
 * same one the Mirror itself just used). The stored node is never changed. A
 * node with no Mirror upstream comes back as the same object.
 */
export function resolveReferencesThroughMirrors(
  dag: Pick<FeatureDag, 'getNode'>,
  node: DagNodeSnapshot,
  resolvePlane: (planeNodeId: string) => PlaneDef | undefined,
): MirrorReferenceResolution {
  if (node.kind !== 'feature') return { ok: true, node }
  const chain = ownerChainOf(dag, node)
  if (!chain.some((link) => link.planeNodeId !== undefined)) return { ok: true, node }
  let current = { id: node.id, payload: node.payload, refs: node.refs ?? [] }
  try {
    for (let i = chain.length - 1; i >= 0; i--) {
      const planeNodeId = chain[i].planeNodeId
      if (planeNodeId === undefined) continue
      const downstream = new Set(chain.slice(0, i).map((link) => link.id))
      current = { id: node.id, ...carryReferencesThroughMirror(current, chain[i].id, resolvePlane(planeNodeId), downstream) }
    }
  } catch (err) {
    if (err instanceof MirrorReferenceNotCarriedError) return { ok: false, error: err }
    throw err
  }
  return { ok: true, node: { ...node, payload: current.payload, refs: current.refs } }
}

// Apply checks names only; positions are reflected at replay with the plane
// where it is then. Any non-degenerate plane serves for the name check.
const NAME_CHECK_PLANE: PlaneDef = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }

/**
 * Apply-time: every later feature whose owner chain now passes through Mirror
 * `mirrorId` (it was authored on the body the Mirror replaces) must have a
 * named form on the reflection. Throws MirrorReferenceNotCarriedError by
 * feature and reference for one that does not - recognized feature keys, a
 * relief picture, an imported blend key, an op this mapping does not know -
 * so the insert unwinds and nothing is written.
 */
export function assertCarriedThroughMirror(dag: FeatureDag, mirrorId: string): void {
  const order = dag.featureOrder()
  const at = order.indexOf(mirrorId)
  if (at < 0) return
  for (const id of order.slice(at + 1)) {
    const node = dag.getNode(id)
    if (node === undefined || node.kind !== 'feature') continue
    const chain = ownerChainOf(dag, node)
    const i = chain.findIndex((link) => link.id === mirrorId)
    if (i < 0) continue
    const opType = typeof node.payload.opType === 'string' ? node.payload.opType : ''
    if (!CARRIED_OPS.has(opType)) {
      const p = node.payload
      const key = Array.isArray(p.featureKeys) ? p.featureKeys[0] : p.featureKey
      throw new MirrorReferenceNotCarriedError(id, typeof key === 'string' ? key : (node.refs[0]?.id ?? opType), 'notCarried', mirrorId)
    }
    carryReferencesThroughMirror(node, mirrorId, NAME_CHECK_PLANE, new Set(chain.slice(0, i).map((link) => link.id)))
  }
}

/**
 * A Mirror replaces its source body, so a Mirror inserted at the rollback
 * marker becomes that body's new tip. Every rolled-back feature below it that
 * worked on the source through a body carrier (BODY_IDENTITY_PAYLOAD_CARRIERS:
 * a Fillet's ownerId, a joining Extrude's targetFeatureId, a later Mirror's
 * sourceBodyId...) is moved onto the Mirror - its `consumes` edge and each
 * carrier - exactly as commands.ts InsertAtMarkerCommand already does for an
 * inserted ownerId/targetFeatureId feature. Their face/edge references and
 * stored positions are NOT rewritten: each replay resolves them through the
 * Mirror's current plane (resolveReferencesThroughMirrors). A later feature
 * that keeps a reference with no named form on the reflection refuses the
 * insert by feature and reference (assertCarriedThroughMirror). A consumer
 * naming the source by no carrier (a face sketch) keeps its edge, the same
 * rule. Run in the same CompositeCommand as the insert; all-or-nothing, and
 * undo restores each prior carrier and edge.
 */
export class RewireReplacedBodyConsumersCommand implements Command {
  readonly label = 'rewireReplacedBodyConsumers'
  private readonly featureId: string
  private readonly sourceBodyId: string
  private prior: Array<{ id: string; consumes: string[]; payload: Record<string, unknown> }> = []

  constructor(featureId: string, sourceBodyId: string) {
    this.featureId = featureId
    this.sourceBodyId = sourceBodyId
  }

  do(dag: FeatureDag): void {
    const order = dag.featureOrder()
    const at = order.indexOf(this.featureId)
    const applied: Array<{ id: string; consumes: string[]; payload: Record<string, unknown> }> = []
    try {
      for (const id of at < 0 ? [] : order.slice(at + 1)) {
        const node = dag.getNode(id)
        if (node === undefined || !node.consumes.includes(this.sourceBodyId)) continue
        const carriers = BODY_IDENTITY_PAYLOAD_CARRIERS.filter((carrier) => node.payload[carrier] === this.sourceBodyId)
        if (carriers.length === 0) continue
        const nextPayload: Record<string, unknown> = { ...node.payload }
        for (const carrier of carriers) nextPayload[carrier] = this.featureId
        const consumes = [...new Set(node.consumes.map((c) => (c === this.sourceBodyId ? this.featureId : c)))]
        const priorConsumes = dag.setConsumes(id, consumes)
        applied.push({ id, consumes: priorConsumes, payload: dag.setPayload(id, nextPayload) })
      }
      assertCarriedThroughMirror(dag, this.featureId)
    } catch (err) {
      this.restore(dag, applied)
      throw err
    }
    this.prior = applied
  }

  undo(dag: FeatureDag): void {
    this.restore(dag, this.prior)
    this.prior = []
  }

  serialize(): unknown {
    return { type: 'rewireReplacedBodyConsumers', featureId: this.featureId, sourceBodyId: this.sourceBodyId }
  }

  private restore(dag: FeatureDag, applied: Array<{ id: string; consumes: string[]; payload: Record<string, unknown> }>): void {
    for (const prior of [...applied].reverse()) {
      dag.setPayload(prior.id, prior.payload)
      dag.setConsumes(prior.id, prior.consumes)
    }
  }
}

export interface BodyTransformReplayDeps {
  client: { transformBody?(req: TransformBodyRequest): Promise<OpResult> }
  /** The live (not yet consumed) body of a body-producing node. */
  lookupLiveBody(id: string): BodyHandle | undefined
  /** The plane node's current frame; undefined when it does not resolve now. */
  resolvePlane(nodeId: string): PlaneDef | undefined
  /** The operator's words for a refusal. */
  refusalText(refusal: BodyTransformRefusal): string
}

/** Replay one Body Transform node: the kernel result for the caller to
 *  finalize, or a named refusal that leaves every body as it was. */
export async function replayBodyTransform(node: DagNodeSnapshot, deps: BodyTransformReplayDeps): Promise<OpResult> {
  const refuse = (refusal: BodyTransformRefusal): OpResult => ({
    ok: false,
    diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { id: node.id, reason: deps.refusalText(refusal) } }],
  })
  const payload = parseBodyTransformPayload(node.payload)
  if (payload === undefined) return refuse({ kind: 'malformed', nodeId: node.id })
  const planeNodeId = payload.transform.planeNodeId
  if (!node.consumes.includes(payload.sourceBodyId) || !node.consumes.includes(planeNodeId)) {
    return refuse({ kind: 'malformed', nodeId: node.id })
  }
  const body = deps.lookupLiveBody(payload.sourceBodyId)
  if (body === undefined) return refuse({ kind: 'sourceNotLive', nodeId: node.id, sourceBodyId: payload.sourceBodyId })
  const plane = deps.resolvePlane(planeNodeId)
  if (plane === undefined) return refuse({ kind: 'planeUnresolved', nodeId: node.id, planeNodeId })
  if (deps.client.transformBody === undefined) return refuse({ kind: 'noTransform', nodeId: node.id })
  return deps.client.transformBody({
    featureId: node.id,
    body,
    transform: { kind: 'mirror', plane },
    identity: 'replace',
  })
}
