import type { FeatureDag } from '../../doc'

/** Runtime/type source for every feature op dispatched by the workbench body
 * executor. The history role lives beside the opType so direct-edit commands
 * can derive their closed domain from this one registry instead of maintaining
 * a second hand-written list that can drift from the executor. */
export const WORKBENCH_BODY_OP_DEFINITIONS = Object.freeze([
  { opType: 'extrude', historyRole: 'feature' },
  { opType: 'revolve', historyRole: 'feature' },
  { opType: 'boolean', historyRole: 'feature' },
  { opType: 'fillet', historyRole: 'feature' },
  { opType: 'defeature', historyRole: 'direct-edit' },
  { opType: 'chamfer', historyRole: 'feature' },
  { opType: 'shell', historyRole: 'feature' },
  { opType: 'draft', historyRole: 'feature' },
  { opType: 'sweep', historyRole: 'feature' },
  { opType: 'loft', historyRole: 'feature' },
  { opType: 'hole', historyRole: 'feature' },
  // WO UI-80: push/pull (direct face offset) is a first-class modifier op --
  // consumes ONE upstream body, supersedes it, replays via client.editFeature
  // 'faceOffset'. Registered here (omission = build error at the executor's
  // `never` exhaustiveness check) so a push/pull commit lands as a real DAG
  // node, not an invisible payload.faceEdits sub-record on the owner.
  { opType: 'pushPull', historyRole: 'direct-edit' },
  // WO UI-71: resize-hole follows the same first-class history contract. Its
  // executor still uses the existing editFeature('holeDiameter') kernel path;
  // only the document representation changes from an invisible faceEdits
  // sub-record to a visible, undoable feature node.
  { opType: 'resizeHole', historyRole: 'direct-edit' },
  // Form (docs/design/FORM-ENVIRONMENT.md): a finished SubD form - payload is
  // the cage, replay sews its tessellated limit surface into a solid.
  { opType: 'form', historyRole: 'feature' },
  // WO-2171 image relief: a picture laid into a flat face of ONE consumed body
  // (payload = the picture + every control); replays through the geometry
  // worker's relief op (editFeature kind 'relief') and supersedes its owner.
  { opType: 'relief', historyRole: 'feature' },
] as const)

export type WorkbenchBodyOpType = (typeof WORKBENCH_BODY_OP_DEFINITIONS)[number]['opType']
export type DirectEditBodyOpType = Extract<
  (typeof WORKBENCH_BODY_OP_DEFINITIONS)[number],
  { historyRole: 'direct-edit' }
>['opType']

export const WORKBENCH_BODY_OP_TYPES: readonly WorkbenchBodyOpType[] = Object.freeze(
  WORKBENCH_BODY_OP_DEFINITIONS.map((definition) => definition.opType),
)

export const DIRECT_EDIT_BODY_OP_TYPES: readonly DirectEditBodyOpType[] = Object.freeze(
  WORKBENCH_BODY_OP_DEFINITIONS
    .filter((definition) => definition.historyRole === 'direct-edit')
    .map((definition) => definition.opType) as DirectEditBodyOpType[],
)

const WORKBENCH_BODY_OP_TYPE_SET: ReadonlySet<string> = new Set(WORKBENCH_BODY_OP_TYPES)
const DIRECT_EDIT_BODY_OP_TYPE_SET: ReadonlySet<string> = new Set(DIRECT_EDIT_BODY_OP_TYPES)

export function isWorkbenchBodyOpType(value: unknown): value is WorkbenchBodyOpType {
  return typeof value === 'string' && WORKBENCH_BODY_OP_TYPE_SET.has(value)
}

export function isDirectEditBodyOpType(value: unknown): value is DirectEditBodyOpType {
  return typeof value === 'string' && DIRECT_EDIT_BODY_OP_TYPE_SET.has(value)
}

export interface BodyLineageProjection {
  /** Current body-producing leaf. Visibility, color, selection, and measure
   * calls must use this id. */
  bodyId: string
  /** Original body identity displayed to the user. */
  lineageId: string
}

export type BodyTargetLineageResolution =
  | { ok: true; bodyId: string }
  | { ok: false; reason: 'lost'; candidates: [] }
  | { ok: false; reason: 'ambiguous'; candidates: string[] }

/** Whether a body-producer dependency means the consumer still contains some
 * of the producer's material. Reference-only and unrecognized edges fail
 * closed: they must never silently re-aim a persisted machining reference.
 *
 * Boolean decisions are deliberate: fuse carries target=true/tool=true; cut
 * carries target=true/tool=false; intersect carries target=true/tool=true.
 * Extrude carries only its validated Add/Remove/Intersect boolean target set,
 * never an end-condition reference that merely helped measure the feature. */
function bodyEdgeCarriesMaterial(dag: FeatureDag, consumerId: string, producerId: string): boolean {
  const node = dag.getNode(consumerId)
  if (node?.kind !== 'feature') return false

  const payload = node.payload
  switch (payload.opType) {
    case 'boolean': {
      const isTarget = payload.targetFeatureId === producerId
      const isTool = payload.toolFeatureId === producerId
      switch (payload.boolOp) {
        case 'fuse':
        case 'intersect':
          return isTarget || isTool
        case 'cut':
          return isTarget
        default:
          return false
      }
    }
    case 'extrude': {
      if (payload.boolMode !== 'add' && payload.boolMode !== 'remove' && payload.boolMode !== 'intersect') {
        return false
      }
      if (payload.targetFeatureIds !== undefined) {
        const targets = payload.targetFeatureIds
        if (
          !Array.isArray(targets) ||
          targets.length === 0 ||
          !targets.every((id): id is string => typeof id === 'string' && id.length > 0) ||
          new Set(targets).size !== targets.length ||
          targets.some((id) => !node.consumes.includes(id))
        ) {
          return false
        }
        return targets.includes(producerId)
      }
      return payload.targetFeatureId === producerId
    }
    case 'revolve':
    case 'fillet':
    case 'defeature':
    case 'chamfer':
    case 'shell':
    case 'draft':
    case 'sweep':
    case 'loft':
    case 'hole':
    case 'pushPull':
    case 'resizeHole':
    case 'form':
    case 'relief':
      return true
    default:
      return false
  }
}

/** Walk a single body-producing leaf up to its stable lineage identity: the
 * consumes DAG is the only create-vs-modify classifier (see
 * projectBodyLineages' own header comment for the full rule). Exported on its
 * own -- not just as projectBodyLineages' internal closure -- so a caller
 * that needs the SAME "which underlying solid is this really" identity for a
 * single id (not a whole live-set projection) can ask it directly instead of
 * re-deriving a parallel notion. SR-2 (armed resize-hole verdict cache): a
 * direct-edit commit (resize-hole, push/pull) supersedes its owner with a
 * NEW leaf id in the SAME render pass that starts the next recognizeFeatures
 * refresh -- keying a body-scoped cache by raw leaf id makes that cache go
 * instantly (and wrongly) empty for the new id until the async refresh
 * lands. Keying by lineageId instead is stable across that leaf-id churn
 * because both the old and new leaf share one lineage. */
export function lineageIdOf(dag: FeatureDag, bodyFeatureIds: readonly string[], leafId: string): string {
  const bodyIds = new Set(bodyFeatureIds)
  let current = leafId
  const visited = new Set<string>()
  while (true) {
    // A corrupt cycle or unclassified carrier remains visibly named by the
    // requested leaf. Never crash and never guess which parent owns identity.
    if (visited.has(current)) return leafId
    visited.add(current)
    const node = dag.getNode(current)
    const parents = [...new Set((node?.consumes ?? []).filter((id) => (
      bodyIds.has(id) && bodyEdgeCarriesMaterial(dag, current, id)
    )))]
    if (parents.length === 0) return current
    if (parents.length === 1) {
      current = parents[0]
      continue
    }

    // BooleanDialog persists the semantic target separately from consumes.
    // FeatureDag serialization sorts consumes, so array order is not a stable
    // identity carrier across save/reload. Validate the target against the
    // actual body-parent set before following it; every other multi-body op
    // must name its identity rule explicitly instead of silently picking one.
    const opType = node?.payload.opType
    const targetFeatureId = node?.payload.targetFeatureId
    if (opType === 'boolean' && typeof targetFeatureId === 'string' && parents.includes(targetFeatureId)) {
      current = targetFeatureId
      continue
    }
    // A multi-body Extrude persists its complete ordered boolean target set.
    // The first member is the identity carrier. Reference-only body parents
    // are excluded above, so an end target may coexist without invalidating the
    // carrier; every material parent must still be declared in the target set.
    const targetFeatureIds = node?.payload.targetFeatureIds
    if (
      opType === 'extrude' &&
      Array.isArray(targetFeatureIds) &&
      targetFeatureIds.length > 0 &&
      targetFeatureIds.every((id): id is string => typeof id === 'string' && id.length > 0) &&
      new Set(targetFeatureIds).size === targetFeatureIds.length &&
      targetFeatureIds.length === parents.length &&
      targetFeatureIds.every((id) => parents.includes(id))
    ) {
      current = targetFeatureIds[0]
      continue
    }
    return current
  }
}

/** Resolve a persisted body id to its sole current live descendant.
 *
 * A lineage root is intentionally insufficient here: when a later merge uses
 * the persisted body as a non-carrier tool, the result inherits the other
 * parent's displayed identity even though it still contains this body's
 * material. The consumes graph records that forward relationship. A unique
 * live descendant is therefore safe; zero is lost and more than one is
 * ambiguous. Callers must surface either refusal instead of guessing. */
export function resolveBodyTargetLineage(
  dag: FeatureDag,
  bodyFeatureIds: readonly string[],
  liveBodyIds: readonly string[],
  persistedBodyId: string,
): BodyTargetLineageResolution {
  const bodyIds = new Set(bodyFeatureIds)
  if (!bodyIds.has(persistedBodyId)) return { ok: false, reason: 'lost', candidates: [] }

  const live = [...new Set(liveBodyIds)]
  const invalidLiveId = live.find((id) => !bodyIds.has(id))
  if (invalidLiveId !== undefined) {
    throw new Error(`live body '${invalidLiveId}' is absent from the body-producer census`)
  }
  if (live.includes(persistedBodyId)) return { ok: true, bodyId: persistedBodyId }

  // A body reference follows material through body-producing features only.
  // Walking the raw DAG closure would cross BODY -> datum -> sketch -> a new
  // independent body and falsely treat that body as containing the original.
  const bodyConsumers = new Map<string, string[]>()
  for (const consumerId of bodyIds) {
    for (const producerId of dag.getNode(consumerId)?.consumes ?? []) {
      if (!bodyIds.has(producerId) || !bodyEdgeCarriesMaterial(dag, consumerId, producerId)) continue
      const consumers = bodyConsumers.get(producerId) ?? []
      consumers.push(consumerId)
      bodyConsumers.set(producerId, consumers)
    }
  }
  const descendants = new Set<string>()
  const pending = [...(bodyConsumers.get(persistedBodyId) ?? [])]
  while (pending.length > 0) {
    const consumerId = pending.pop()!
    if (descendants.has(consumerId)) continue
    descendants.add(consumerId)
    pending.push(...(bodyConsumers.get(consumerId) ?? []))
  }

  const candidates = live.filter((id) => descendants.has(id))
  if (candidates.length === 1) return { ok: true, bodyId: candidates[0] }
  if (candidates.length === 0) return { ok: false, reason: 'lost', candidates: [] }
  return { ok: false, reason: 'ambiguous', candidates }
}

/** Project current body leaves onto stable user-facing lineages.
 *
 * The consumes DAG is the only create-vs-modify classifier: a body producer
 * with no body-producing parent starts a lineage; a single-parent modifier
 * inherits that parent's original identity. Multi-body producers must carry a
 * validated semantic identity (Boolean's targetFeatureId or Extrude's first
 * persisted targetFeatureIds member), because consumes ordering is not stable
 * across serialization. Later leaves for the
 * same lineage replace earlier leaves in timeline order, while independent
 * roots remain independent rows. */
export function projectBodyLineages(
  dag: FeatureDag,
  bodyFeatureIds: readonly string[],
  liveBodyIds: readonly string[],
): BodyLineageProjection[] {
  const bodyIds = new Set(bodyFeatureIds)
  const byLineage = new Map<string, BodyLineageProjection>()
  for (const bodyId of liveBodyIds) {
    if (!bodyIds.has(bodyId)) throw new Error(`live body '${bodyId}' is absent from the body-producer census`)
    const lineageId = lineageIdOf(dag, bodyFeatureIds, bodyId)
    byLineage.set(lineageId, { bodyId, lineageId })
  }
  return [...byLineage.values()]
}

/** The user-facing label of a feature node: its payload `name`, else the node
 *  id. Shared by the workbench (hover readouts, body rows) and the headless
 *  model-body replay (IMPORT-FANOUT-HEADLESS) so both derive a body's CAM-row
 *  name identically. Lifted verbatim from SolidsWorkbenchPage.tsx. */
export function featureLabel(dag: FeatureDag, id: string): string {
  const node = dag.getNode(id)
  const name = node?.payload.name
  return typeof name === 'string' && name.length > 0 ? name : id
}

/** Body-producing feature nodes (extrude/revolve/boolean results, plus the
 *  DAG's own 'import' and 'meshImport' kinds) that are neither suppressed nor
 *  rolled back -- the selectable/exportable body pool. Lifted verbatim from
 *  SolidsWorkbenchPage.tsx (WO UI-7 / INT-6A / MSH-3 wiring) so the workbench
 *  regen gather and the headless model-body replay share ONE census and can
 *  never drift. */
export function bodyFeatureIds(dag: FeatureDag): string[] {
  return dag.nodeIds().filter((id) => {
    const node = dag.getNode(id)
    if (node === undefined) return false
    // An imported body is body-producing exactly like a 'feature' opType node
    // (selectable/push-pullable/exportable), just under the DAG's OWN dedicated
    // 'import' kind (dag.ts's DAG_NODE_KINDS) rather than 'feature'+opType; a
    // 'meshImport' node (a prismatic STL rebuilt as a solid) is a body producer
    // too. All three branches apply the SAME suppressed/rolled-back liveness gate.
    if (node.kind !== 'feature' && node.kind !== 'import' && node.kind !== 'meshImport') return false
    if (node.kind === 'feature' && !isWorkbenchBodyOpType(node.payload.opType)) return false
    return !dag.isEffectivelySuppressed(id) && !dag.isRolledBack(id)
  })
}

/** WO UI-14A (C1): the LEAF-ONLY subset of bodyFeatureIds(dag) -- a body id is
 *  LIVE iff no other still-present body-producing node that ACTUALLY produced a
 *  body (`hasBody`) consumes it, AND it produced a body itself. The raw
 *  bodyFeatureIds(dag) superset still includes a superseded ancestor (its kernel
 *  handle/tessellation are kept alive for fast undo) which a raycast could
 *  wrongly resolve to; a legitimately-refused node (e.g. DRAFT_FAILED) sits in
 *  the dag with its consumes edge but never bound a handle. Every pick-candidate
 *  call site AND the headless model-body replay must use this, never the raw
 *  superset. Lifted verbatim from SolidsWorkbenchPage.tsx. */
export function liveBodyFeatureIds(dag: FeatureDag, hasBody: (id: string) => boolean): string[] {
  const ids = bodyFeatureIds(dag)
  const bodyIdSet = new Set(ids)
  const superseded = new Set<string>()
  for (const id of ids) {
    if (!hasBody(id)) continue
    // Walk the entire body-producing ancestry. A dress-up op disposes its direct
    // input handle after success, so a chain F1 -> F2 -> F3 can have handles only
    // for F1 and F3; stopping at bodyless F2 would incorrectly resurrect F1 as a
    // second live row/pick candidate. A failed child has no handle and never
    // starts this traversal, preserving the valid-owner fallback.
    const pending = [...(dag.getNode(id)?.consumes ?? [])]
    while (pending.length > 0) {
      const producer = pending.pop()!
      if (!bodyIdSet.has(producer) || superseded.has(producer)) continue
      superseded.add(producer)
      pending.push(...(dag.getNode(producer)?.consumes ?? []))
    }
  }
  // hasBody(id) is REQUIRED in the returned set itself, not just while building
  // the superseded set above -- a node that legitimately refused at the kernel
  // (e.g. DRAFT_FAILED on replay) is never superseded by anything, so without
  // this term it survived the filter with no body handle at all.
  return ids.filter((id) => hasBody(id) && !superseded.has(id))
}
