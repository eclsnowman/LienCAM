// Datum-plane features share one DAG/executor surface. Face planes resolve a
// stable face through ElementMap; base planes carry a constant genesis frame;
// explicit offset planes consume another datum and derive a parallel frame.
//
// Two audit-note requirements from SKC-7.audit.json this file exists to
// satisfy exactly:
//  1. Stable-ID refs live in the node's `refs: FeatureRef[]` field, NEVER in
//     payload -- RegenScheduler's dirty-closure walks `consumes` edges and
//     FeatureDag.regenerate()/ElementMap.resolve read `refs` only. A
//     face-plane datum therefore ALSO structurally `consumes` the feature
//     node that owns the referenced face (same "consumes the producer,
//     refs the stable id" shape src/tests/doc/persist/persist.test.ts's
//     fillet fixture already uses) -- refs alone do not participate in
//     RegenScheduler.downstreamClosure, only `consumes` does.
//  2. The PlaneFrame is computed and WRITTEN by this node's own FeatureOp
//     executor (mirrors sketch3d/regen.ts's makeSketch3dExecutor payload-
//     write pattern exactly) -- FeatureDag.regenerate() itself never writes
//     payload, it only resolves refs into degraded/diagnostics/
//     lastGoodBoundTo. Both facts mean the executor below independently
//     calls `map.resolve()` a second time (cheap, pure, deterministic) --
//     it cannot wait for dag.regenerate()'s OWN resolution because that
//     runs AFTER the whole executor loop, once per RegenScheduler.pass().

import type { Command, DagNodeInput, ElementMap, FeatureDag, FeatureOp, FeatureRef } from '../doc'
import type { Diag, StableId } from '../geom/geom-service'
import { compareIds } from '../doc/stable-id'
import { computeXDir } from './xDirPolicy'
import type { PlaneFrame } from './planeMath'
import { vScale, vUnit } from './planeMath'
import { makeAngledPlaneFrame, makeAxisAngledPlaneFrame, makeMidplaneFrame, makeOffsetPlaneFrame, type AngledPlaneHinge, type ReferencePlaneMathResult } from './referencePlaneMath'
import { axisLineOfNode, isAxisDatumPayload, type AxisFaceGeometryLookup, type AxisLine } from './datumAxis'
import { isPickedPlaneDefinition, isPickedPlaneKind, runPickedPlane, type PickedPlaneDefinition, type PickedPlaneState } from './datumConstruct'

const PREFIX = 'datum:'

/** A face-plane datum's FeatureDag node id -- namespaced so it can never
 *  collide with a bare feature/parameter/sketch id (mirrors sketch3d/
 *  regen.ts's sketch3dNodeId `sketch3d:` convention exactly). */
export function datumPlaneNodeId(id: string): string {
  return `${PREFIX}${id}`
}

/** Inverse of datumPlaneNodeId; undefined if `id` is not a datum-plane node id. */
export function datumPlaneIdFromNodeId(id: string): string | undefined {
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : undefined
}

/** V1 only implements the deterministic projected-model-X policy (Q7,
 *  recon's own recommendation) -- edge-based xDir requires an explicit user
 *  pick, which is out of this WO's scope. The union shape is kept (rather
 *  than a bare boolean) so a later WO can add 'edge' without a payload
 *  migration. */
export type XDirHint = { kind: 'projected-model-x' }

/** Config-only payload (audit note 1): NEVER carries the face stable-ID --
 *  that lives exclusively in the node's `refs`. `lastGoodFrame` is retained
 *  across a 'lost' resolution (never cleared) so a degraded sketch keeps a
 *  real last-known plane for display/repair, matching stable-id-spec's
 *  "degraded beats guessing" rule and docs/3d/SKETCH-PLANE-SYSTEM-RECON.md's
 *  failure-mode table. */
export interface DatumPlanePayload extends Record<string, unknown> {
  datumType: 'plane'
  planeKind: 'face-plane'
  flipNormal: boolean
  xDirHint: XDirHint
  lastGoodFrame?: PlaneFrame
}

/**
 * WO SKC-15: the three permanent world planes (Operator A1/A2 -- "why can I not just start on a plane
 * like the xy, xz, zy planes?"). Structurally a datum plane like any other, so every existing
 * frame reader (regen.ts's planeFrameOf, the workbench's sketch-entry paths) resolves one with no
 * change; but it has NO `refs` and its frame is a CONSTANT, never recomputed from a face snapshot.
 *
 * `lastGoodFrame` carries that constant under the SAME field name a face-plane uses, deliberately:
 * "the frame this plane resolved to" is the question every consumer asks, and a base plane can
 * always answer it. Inventing a second field would give the workbench two ways to ask.
 */
export interface BasePlaneDatumPayload extends Record<string, unknown> {
  datumType: 'plane'
  planeKind: 'base-plane'
  basePlane: BasePlaneKind
  lastGoodFrame: PlaneFrame
}

export type BasePlaneKind = 'xy' | 'xz' | 'yz'

export interface OffsetPlaneDefinition extends Record<string, unknown> {
  kind: 'offset'
  distance: number
  flipNormal: boolean
}

/** Halfway between two planes (parallel, or halving the angle where they meet): the node consumes both. */
export interface MidplaneDefinition extends Record<string, unknown> {
  kind: 'midplane'
  flipNormal: boolean
}

/** The parent plane turned by an angle about its own X or Y axis, or about an axis datum (WO-2222:
 *  hinge 'axis' -- the node then also consumes that axis datum). */
export interface AngledPlaneDefinition extends Record<string, unknown> {
  kind: 'angle'
  angleDeg: number
  hinge: AngledPlaneHinge | 'axis'
  flipNormal: boolean
}

/** WO-2223: planes made from picks (three points, two edges, tangent to a face) are construction
 *  planes too -- they consume the bodies they were picked on, never a parent plane
 *  (datumConstruct.ts). */
export type ConstructionPlaneDefinition = OffsetPlaneDefinition | MidplaneDefinition | AngledPlaneDefinition | PickedPlaneDefinition

/** The construction planes whose frame comes from parent planes (offset, midplane, at angle). */
export type ParentPlaneDefinition = OffsetPlaneDefinition | MidplaneDefinition | AngledPlaneDefinition

export function isParentPlaneDefinition(definition: ConstructionPlaneDefinition): definition is ParentPlaneDefinition {
  return !isPickedPlaneKind(definition.kind)
}

/** How many parent PLANES a construction plane of each kind consumes (an axis hinge is one more;
 *  a picked plane takes none). */
export function constructionPlaneParentCount(definition: ConstructionPlaneDefinition): number {
  if (isPickedPlaneKind(definition.kind)) return 0
  return definition.kind === 'midplane' ? 2 : 1
}

/** The order a construction plane reads its parents in. A FeatureDag keeps `consumes` as a set (it
 *  serializes them sorted), so a Midplane takes its two parents in that same sorted id order: the
 *  plane it builds never depends on which one was picked first, and a reload rebuilds it the same. */
export function constructionPlaneParentOrder(definition: ConstructionPlaneDefinition, parentIds: readonly string[]): string[] {
  return definition.kind === 'midplane' ? [...parentIds].sort(compareIds) : [...parentIds]
}

/** A construction plane's frame from its parents' frames (in constructionPlaneParentOrder): the ONE rule the regen executor, the
 *  dialog's preview and its Apply check all use. */
export function constructionPlaneFrame(
  definition: ConstructionPlaneDefinition,
  parents: readonly PlaneFrame[],
  priorFrame?: PlaneFrame,
  hingeAxis?: Pick<AxisLine, 'origin' | 'dir'>,
): ReferencePlaneMathResult {
  const prior = priorFrame === undefined ? {} : { priorFrame }
  // a picked plane's frame comes from its faces (datumConstruct.ts), never from parent planes
  if (!isParentPlaneDefinition(definition)) return { ok: false, reason: 'non-finite-parent-frame' }
  if (definition.kind === 'midplane') return makeMidplaneFrame(parents[0], parents[1], { flipNormal: definition.flipNormal, ...prior })
  if (definition.kind === 'angle') {
    const hinge = definition.hinge
    if (hinge !== 'axis') return makeAngledPlaneFrame(parents[0], definition.angleDeg, hinge, { flipNormal: definition.flipNormal })
    if (hingeAxis === undefined) return { ok: false, reason: 'non-finite-parent-frame' }
    return makeAxisAngledPlaneFrame(parents[0], hingeAxis, definition.angleDeg, { flipNormal: definition.flipNormal })
  }
  return makeOffsetPlaneFrame(parents[0], definition.distance, { flipNormal: definition.flipNormal, ...prior })
}

/** The user-facing construction-plane payload (offset, midplane or angled; the planeKind keeps its
 * first name). The parent planes are the node's `consumes` edges, never copied into payload. */
export interface OffsetPlaneDatumPayload extends Record<string, unknown> {
  datumType: 'plane'
  planeKind: 'offset-plane'
  payloadSchema: 1
  name: string
  definition: ConstructionPlaneDefinition
  lastGoodFrame?: PlaneFrame
  /** WO-2223: a picked plane's last good pick (unflipped), what its next rebuild continues from */
  lastGoodPick?: PickedPlaneState
}

export type AnyDatumPlanePayload = DatumPlanePayload | BasePlaneDatumPayload | OffsetPlaneDatumPayload

/**
 * Any plane datum -- face-bound or base. This is what a FRAME READER wants: it asks "does this
 * node resolve to a sketch plane?", and both kinds answer yes through `lastGoodFrame`.
 *
 * WO SKC-15 widened this from the face-plane-only check SKC-5 shipped. Every pre-SKC-15 call site
 * (regen.ts:256, SolidsWorkbenchPage's three frame lookups) is a frame reader and wanted the wider
 * question all along. The one call site that genuinely meant "face-plane" -- makeDatumPlaneExecutor,
 * which resolves a single-face ref -- now uses isFacePlaneDatumPayload below, so a base plane can
 * never fall into the ref-resolution path and report a bogus "no single-face ref" failure.
 */
export function isDatumPlanePayload(payload: Record<string, unknown>): payload is AnyDatumPlanePayload {
  return payload.datumType === 'plane' &&
    (payload.planeKind === 'face-plane' || payload.planeKind === 'base-plane' || payload.planeKind === 'offset-plane')
}

/** Narrow: a face-bound datum plane, the only kind whose frame is recomputed from a resolved face. */
export function isFacePlaneDatumPayload(payload: Record<string, unknown>): payload is DatumPlanePayload {
  return payload.datumType === 'plane' && payload.planeKind === 'face-plane'
}

/** Narrow: one of the three permanent world planes. */
export function isBasePlaneDatumPayload(payload: Record<string, unknown>): payload is BasePlaneDatumPayload {
  return payload.datumType === 'plane' && payload.planeKind === 'base-plane'
}

export function isOffsetPlaneDatumPayload(payload: Record<string, unknown>): payload is OffsetPlaneDatumPayload {
  if (payload.datumType !== 'plane' || payload.planeKind !== 'offset-plane' || payload.payloadSchema !== 1) return false
  if (typeof payload.name !== 'string' || payload.name.length === 0) return false
  const definition = payload.definition
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) return false
  const d = definition as Record<string, unknown>
  if (typeof d.flipNormal !== 'boolean') return false
  if (d.kind === 'offset') return typeof d.distance === 'number'
  if (d.kind === 'midplane') return true
  if (d.kind === 'angle') return typeof d.angleDeg === 'number' && (d.hinge === 'x' || d.hinge === 'y' || d.hinge === 'axis')
  return isPickedPlaneDefinition(d)
}

/** WO SKC-15: the Origin triad node's payload. Kind 'datum', not sketchable -- a reference item. */
export interface OriginDatumPayload extends Record<string, unknown> {
  datumType: 'origin'
}

export function isOriginDatumPayload(payload: Record<string, unknown>): payload is OriginDatumPayload {
  return payload.datumType === 'origin'
}

function planeFrameFromSnapshot(
  snap: { centroid: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } },
  opts: { flipNormal: boolean; priorFrame?: PlaneFrame },
): PlaneFrame {
  const n0 = vUnit(snap.normal)
  const normal = opts.flipNormal ? vScale(n0, -1) : n0
  const xDir = computeXDir(normal, opts.priorFrame)
  return { origin: { ...snap.centroid }, normal, xDir }
}

/** Creates a new face-plane datum node consuming `ownerId` (the feature that
 *  owns `faceId`) with a single `single-face` ref -- the DAG shape audit
 *  note 1 requires. Throws (via FeatureDag.insertNode) if `id` already
 *  exists; this is CREATE, not create-or-update (mirrors insertNode's own
 *  contract, unlike sketch3d/regen.ts's commitSketch3dDocument which is
 *  deliberately upsert for a different reason -- a datum's face binding is
 *  set once at creation and only ever changed via reattachFacePlaneDatum's
 *  explicit repair path, never silently re-upserted). */
/** WO UI-16 (Q-14): the DagNodeInput a fresh face-plane datum would insert,
 *  WITHOUT inserting it -- lets a caller run the SAME node shape through
 *  `history.execute` (bundled with another node into one CompositeCommand,
 *  e.g. SolidsWorkbenchPage's sketch-on-face entry) instead of always
 *  bypassing CommandHistory. createFacePlaneDatumNode below is now a thin
 *  wrapper: `dag.insertNode(buildFacePlaneDatumNodeInput(...).input)`, so
 *  every existing direct-insert caller (tests, the reattach-free path) is
 *  byte-identical. */
export function buildFacePlaneDatumNodeInput(
  opts: { id: string; ownerId: string; faceId: StableId; flipNormal?: boolean },
): { nodeId: string; input: DagNodeInput } {
  const nodeId = datumPlaneNodeId(opts.id)
  const payload: DatumPlanePayload = {
    datumType: 'plane',
    planeKind: 'face-plane',
    flipNormal: opts.flipNormal ?? false,
    xDirHint: { kind: 'projected-model-x' },
  }
  return {
    nodeId,
    input: {
      id: nodeId,
      kind: 'datum',
      consumes: [opts.ownerId],
      refs: [{ id: opts.faceId, kind: 'single-face', role: 'supportFace', elementType: 'face' }],
      payload,
    },
  }
}

export function createFacePlaneDatumNode(
  dag: FeatureDag,
  opts: { id: string; ownerId: string; faceId: StableId; flipNormal?: boolean },
): string {
  const { nodeId, input } = buildFacePlaneDatumNodeInput(opts)
  dag.insertNode(input)
  return nodeId
}

/** Build a first-class Offset Plane node without mutating the DAG. Its source
 * is an ordinary datum dependency so dirty closure and replay need no special
 * mechanism. */
export function buildOffsetPlaneDatumNodeInput(
  opts: { id: string; parentPlaneNodeId: string; distance: number; flipNormal?: boolean; name?: string },
): { nodeId: string; input: DagNodeInput } {
  return buildConstructionPlaneDatumNodeInput({
    id: opts.id,
    parentPlaneNodeIds: [opts.parentPlaneNodeId],
    definition: { kind: 'offset', distance: opts.distance, flipNormal: opts.flipNormal ?? false },
    name: opts.name ?? `Offset Plane ${opts.id}`,
  })
}

/** Any construction plane's node (offset, midplane, angled), without mutating the DAG. */
export function buildConstructionPlaneDatumNodeInput(
  opts: { id: string; parentPlaneNodeIds: readonly string[]; definition: ConstructionPlaneDefinition; name: string },
): { nodeId: string; input: DagNodeInput } {
  const nodeId = datumPlaneNodeId(opts.id)
  const payload: OffsetPlaneDatumPayload = {
    datumType: 'plane',
    planeKind: 'offset-plane',
    payloadSchema: 1,
    name: opts.name,
    definition: opts.definition,
  }
  return {
    nodeId,
    input: {
      id: nodeId,
      kind: 'datum',
      consumes: [...opts.parentPlaneNodeIds],
      refs: [],
      payload,
    },
  }
}

export function createOffsetPlaneDatumNode(
  dag: FeatureDag,
  opts: { id: string; parentPlaneNodeId: string; distance: number; flipNormal?: boolean; name?: string },
): string {
  const { nodeId, input } = buildOffsetPlaneDatumNodeInput(opts)
  dag.insertNode(input)
  return nodeId
}

/** Minimal reattach (Q5 V1 scope, docs/3d/SKETCH-PLANE-SYSTEM-RECON.md
 *  "repair flow"): re-point a degraded (or still-live) face-plane datum at a
 *  freshly-picked face, WITHOUT touching lastGoodFrame here -- the next
 *  regen pass's executor recomputes it fresh from the new face's snapshot,
 *  using the OLD lastGoodFrame only as xDir-continuity input (computeXDir's
 *  own prior-frame preservation), never as a value this function itself
 *  needs to reason about. Caller is responsible for scheduler.markDirty(id)
 *  + scheduler.run(executor) afterward (same division of labor as every
 *  other dag mutator in this codebase -- mutation and scheduling are always
 *  two separate calls). Throws if `datumNodeId` is not a live 'datum' node. */
export function reattachFacePlaneDatum(dag: FeatureDag, datumNodeId: string, opts: { ownerId: string; faceId: StableId }): void {
  const node = dag.getNode(datumNodeId)
  if (node === undefined || node.kind !== 'datum') {
    throw new Error(`reattachFacePlaneDatum: '${datumNodeId}' is not a live datum node.`)
  }
  dag.setConsumes(datumNodeId, [opts.ownerId])
  dag.setRefs(datumNodeId, [{ id: opts.faceId, kind: 'single-face', role: 'supportFace', elementType: 'face' }])
}

/**
 * WO-1414 (BUG-489/BUG-490 shared cause): the SAME re-point reattachFacePlaneDatum performs, as one
 * undo-tracked Command instead of a raw, non-transactional pair of writes. do() calls
 * dag.setConsumes FIRST -- which throws DagCycleError BEFORE mutating anything when the pick is
 * cyclic (dag.ts's own guard, unchanged) -- so a refused pick here refuses the exact same way: no
 * consumes write, no refs write, nothing pushed onto CommandHistory (CommandHistory.execute only
 * pushes after do() returns cleanly). A successful do() then rewrites refs too and captures both
 * prior values, so undo() restores the datum's exact pre-pick consumes/refs in one step -- the
 * caller (SolidsWorkbenchPage's Reattach click handler) is what makes this ONE history entry with
 * the downstream sketch reprojection via CommandHistory.coalesceIntoLast.
 */
export class ReattachFacePlaneCommand implements Command {
  readonly label = 'reattachFacePlane'
  private readonly datumNodeId: string
  private readonly ownerId: string
  private readonly faceId: StableId
  private priorConsumes: string[] | undefined
  private priorRefs: FeatureRef[] | undefined

  constructor(datumNodeId: string, opts: { ownerId: string; faceId: StableId }) {
    this.datumNodeId = datumNodeId
    this.ownerId = opts.ownerId
    this.faceId = opts.faceId
  }

  do(dag: FeatureDag): void {
    const node = dag.getNode(this.datumNodeId)
    if (node === undefined || node.kind !== 'datum') {
      throw new Error(`ReattachFacePlaneCommand: '${this.datumNodeId}' is not a live datum node.`)
    }
    this.priorConsumes = dag.setConsumes(this.datumNodeId, [this.ownerId])
    this.priorRefs = dag.setRefs(this.datumNodeId, [{ id: this.faceId, kind: 'single-face', role: 'supportFace', elementType: 'face' }])
  }

  undo(dag: FeatureDag): void {
    if (this.priorConsumes === undefined || this.priorRefs === undefined) {
      throw new Error(`ReattachFacePlaneCommand.undo: '${this.datumNodeId}' was never reattached (do() has not run yet).`)
    }
    dag.setRefs(this.datumNodeId, this.priorRefs)
    dag.setConsumes(this.datumNodeId, this.priorConsumes)
  }

  serialize(): unknown {
    return { type: 'reattachFacePlane', datumNodeId: this.datumNodeId, ownerId: this.ownerId, faceId: this.faceId }
  }
}

/**
 * WO-1414: folds the regen executor's OWN direct frame write (makeDatumPlaneExecutor's
 * `dag.setPayload`, run OUTSIDE any Command -- see this module's header on why the executor writes
 * payload itself) into the SAME undo-tracked transaction as ReattachFacePlaneCommand. Without this,
 * Undo would revert refs/consumes back to the pre-pick reference but leave `lastGoodFrame` at
 * whatever the LATEST successful regen wrote -- correct while the ref stays resolvable, but WRONG the
 * moment Undo lands back on a lost/unresolvable ref: makeDatumPlaneExecutor's own 'lost' branch
 * deliberately never touches `lastGoodFrame` (degraded-beats-guessing), so nothing else would ever
 * restore the frame that was live before this repair.
 *
 * Mirrors workbenchSketchDocumentPort.ts's SketchStepCommand exactly: constructed AFTER the mutation
 * is already live in the dag, so CommandHistory.execute()'s own synchronous do() call is a deliberate
 * no-op (`alreadyApplied`); only a later redo() actually re-applies `after`.
 */
export class DatumFrameReplayCommand implements Command {
  readonly label = 'reattachFacePlaneFrame'
  private readonly id: string
  private readonly before: Record<string, unknown>
  private readonly after: Record<string, unknown>
  private alreadyApplied = true

  constructor(id: string, before: Record<string, unknown>, after: Record<string, unknown>) {
    this.id = id
    this.before = before
    this.after = after
  }

  do(dag: FeatureDag): void {
    if (this.alreadyApplied) {
      this.alreadyApplied = false
      return
    }
    dag.setPayload(this.id, this.after)
  }

  undo(dag: FeatureDag): void {
    dag.setPayload(this.id, this.before)
    this.alreadyApplied = false
  }

  serialize(): unknown {
    return { type: 'reattachFacePlaneFrame', id: this.id }
  }
}

function refFailure(nodeId: string, reason: string): { ok: false; diagnostics: Diag[] } {
  return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { id: nodeId, reason } }] }
}

/**
 * Builds the FeatureOp a RegenScheduler.run() pass drives for datum planes.
 * Face planes resolve their stable face; offset planes evaluate their parent
 * datum frame. Both write a fresh PlaneFrame through the executor, never from
 * FeatureDag.regenerate().
 *
 * A 'lost' ref returns ok:true with NO payload write (lastGoodFrame is
 * deliberately left exactly as it was) -- this node's own `refs` still names
 * the lost id, so the scheduler's post-loop `dag.regenerate(map)` +
 * `finalize()` mark THIS node 'degraded' from that SAME ref a moment later,
 * with no extra bookkeeping needed here. Returning ok:false here instead
 * would be wrong: ok:false means "kernel op failed", which would surface as
 * a DIFFERENT (harsher) status than the honest "reference unresolved,
 * degraded" the scheduler already derives for free from `refs`.
 */
export function makeDatumPlaneExecutor(dag: FeatureDag, map: ElementMap, lookup?: AxisFaceGeometryLookup): FeatureOp {
  return async (node) => {
    if (node.kind !== 'datum') return { ok: true, diagnostics: [] }
    const payload = node.payload
    // WO SKC-15: a base plane's frame is a constant and the Origin has none -- neither has a
    // single-face ref to resolve, so both are no-ops here. Gated on the NARROW predicate: were this
    // still the widened isDatumPlanePayload, a base plane would fall through to the ref lookup below
    // and report `refFailure('face-plane datum has no single-face ref')` on every regen pass.
    if (payload.datumType === 'plane' && payload.planeKind === 'offset-plane' && !isOffsetPlaneDatumPayload(payload)) {
      return refFailure(node.id, 'offset plane payload is malformed or uses an unsupported schema')
    }
    // WO-2223: a picked plane (three points, two edges, tangent) re-reads its faces
    if (isOffsetPlaneDatumPayload(payload) && !isParentPlaneDefinition(payload.definition)) {
      const definition = payload.definition
      return runPickedPlane(dag, map, { id: node.id, refs: node.refs, payload: { ...payload, definition } }, lookup)
    }
    if (isOffsetPlaneDatumPayload(payload) && isParentPlaneDefinition(payload.definition)) {
      const definition = payload.definition
      const want = constructionPlaneParentCount(definition)
      // WO-2222: an axis-hinged plane at angle consumes its axis datum beside its plane
      const axisIds = node.consumes.filter((id) => { const n = dag.getNode(id); return n !== undefined && n.kind === 'datum' && isAxisDatumPayload(n.payload) })
      const planeIds = node.consumes.filter((id) => !axisIds.includes(id))
      const wantsAxis = definition.kind === 'angle' && definition.hinge === 'axis'
      if (planeIds.length !== want) {
        return refFailure(node.id, want === 1 ? 'offset plane must consume exactly one parent plane' : `a ${definition.kind} plane must consume exactly ${want} parent planes`)
      }
      if (axisIds.length !== (wantsAxis ? 1 : 0)) {
        return refFailure(node.id, wantsAxis ? 'a plane at angle about an axis must consume exactly one axis' : 'this plane does not turn about an axis')
      }
      let hingeAxis: AxisLine | undefined
      if (wantsAxis) {
        hingeAxis = axisLineOfNode(dag, axisIds[0])
        if (hingeAxis === undefined) return refFailure(node.id, `axis '${axisIds[0]}' has no resolved line`)
      }
      if (node.refs.length !== 0) return refFailure(node.id, 'offset plane must not carry topology refs')
      const frames: PlaneFrame[] = []
      for (const parentId of constructionPlaneParentOrder(definition, planeIds)) {
        const parent = dag.getNode(parentId)
        if (parent === undefined || parent.kind !== 'datum' || !isDatumPlanePayload(parent.payload)) {
          return refFailure(node.id, `offset plane parent '${parentId}' is not a datum plane`)
        }
        if (parent.payload.lastGoodFrame === undefined) {
          return refFailure(node.id, `offset plane parent '${parentId}' has no resolved frame`)
        }
        frames.push(parent.payload.lastGoodFrame)
      }
      const result = constructionPlaneFrame(definition, frames, payload.lastGoodFrame, hingeAxis)
      if (!result.ok) return refFailure(node.id, `offset plane frame refused: ${result.reason}`)
      dag.setPayload(node.id, { ...payload, lastGoodFrame: result.frame })
      return { ok: true, diagnostics: [] }
    }

    if (!isFacePlaneDatumPayload(payload)) return { ok: true, diagnostics: [] }

    const ref = node.refs.find((r) => r.kind === 'single-face' && (r.role === undefined || r.role === 'supportFace'))
    if (ref === undefined) return refFailure(node.id, 'face-plane datum has no single-face ref')

    const res = map.resolve(ref.id, ref.kind)
    if (res.status === 'lost' || res.boundTo.length === 0) {
      return { ok: true, diagnostics: [] }
    }

    const liveFaceId = res.boundTo[0]
    const snap = map.snapshotOf(liveFaceId)
    if (snap === undefined || snap.surfaceType !== 'plane' || snap.normal === undefined) {
      return refFailure(node.id, `referenced face '${liveFaceId}' is not planar (or has no captured normal)`)
    }

    const frame = planeFrameFromSnapshot(
      { centroid: snap.centroid, normal: snap.normal },
      { flipNormal: payload.flipNormal, priorFrame: payload.lastGoodFrame },
    )
    const nextPayload: DatumPlanePayload = { ...payload, lastGoodFrame: frame }
    dag.setPayload(node.id, nextPayload)

    const diagnostics: Diag[] =
      res.status === 'fallback' ? [{ code: 'REFERENCE_FALLBACK', severity: 'warning', params: { id: ref.id, boundTo: liveFaceId } }] : []
    return { ok: true, diagnostics }
  }
}
