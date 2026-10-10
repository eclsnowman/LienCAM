import type { HeightIntentV1 } from '../../../types'
import type { ResolvedParallel3dHeights } from '../../../cam3d/integration/parallel3dOperation'
import {
  bindUnprovenStockTopSafety,
  buildParallel3dEvidenceContext, buildParallel3dSmartIntent, parallel3dHeightDraftFromIntent,
  type Parallel3dEvidenceInput, type Parallel3dIntentInput,
} from './parallel3d'
import type { HeightEvidenceContext, OperationHeightIntentV2, ResolvedHeightPlanV2 } from './types'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'

export type Pencil3dIntentInput = Parallel3dIntentInput
export type Pencil3dEvidenceInput = Parallel3dEvidenceInput

export class Pencil3dSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal
  constructor(refusal: SmartHeightRefusal) {
    super(`Pencil 3D Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'Pencil3dSmartHeightError'
    this.refusal = refusal
  }
}

export function buildPencil3dSmartIntent(input: Pencil3dIntentInput): OperationHeightIntentV2 {
  const base = buildParallel3dSmartIntent(input)
  if (base.policy.operationType !== 'parallel_3d') {
    throw new Error('Parallel Smart Height builder returned the wrong operation family.')
  }
  return { ...base, policy: { operationType: 'pencil_3d', variant: base.policy.variant } }
}

export function pencil3dHeightDraftFromIntent(intent: OperationHeightIntentV2): {
  mode: 'target_surface' | 'bounded_surface'; finishDepthMm?: number;
} {
  if (intent.policy.operationType !== 'pencil_3d') {
    throw new Error('Cannot edit a non-Pencil Smart Height intent as Pencil 3D.')
  }
  return parallel3dHeightDraftFromIntent({ ...intent, policy: { ...intent.policy, operationType: 'parallel_3d' } })
}

export function buildPencil3dEvidenceContext(input: Pencil3dEvidenceInput): HeightEvidenceContext {
  return { ...buildParallel3dEvidenceContext(input), operationType: 'pencil_3d' }
}

export function resolvePencil3dSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  geometryIds: string[]
  geometryPositionZ: number
  stockTopMachineMm?: number
}): {
  plan: ResolvedHeightPlanV2
  localHeights: ResolvedParallel3dHeights
  snapshotIntent: HeightIntentV1
  dependencyIds: string[]
  finishDepthMm?: number
} {
  if (input.intent.policy.operationType !== 'pencil_3d' || input.evidence.operationType !== 'pencil_3d') {
    throw new Pencil3dSmartHeightError({
      code: 'policy_mismatch', message: 'Pencil 3D received another operation family\'s height authority.',
    })
  }
  const scope = input.intent.machining.scope.value
  if (scope.kind !== 'whole_target' || scope.geometryIds.length !== input.geometryIds.length ||
      scope.geometryIds.some((id, index) => id !== input.geometryIds[index])) {
    throw new Pencil3dSmartHeightError({
      code: 'policy_mismatch', message: 'Pencil 3D height scope no longer matches its target geometry.',
    })
  }
  const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(input.intent, input.evidence), input.evidence)
  if (!result.ok) throw new Pencil3dSmartHeightError(result.refusal)
  const plan = result.plan, end = plan.machining.cutterCenterEnd
  if (!end) throw new Pencil3dSmartHeightError({ code: 'invalid_evidence', message: 'Pencil 3D resolved no Target End.' })
  const local = (machineMm: number) => machineMm - input.geometryPositionZ
  const topMachine = plan.machining.materialStart.machineMm
  const inferred = (machineMm: number) => ({
    reference: 'wcs_plane' as const, offset: machineMm - input.evidence.wcsOriginMachineMm,
    provenance: 'inferred' as const,
  })
  const draft = pencil3dHeightDraftFromIntent(input.intent)
  return {
    plan,
    localHeights: {
      clearanceZ: local(plan.safety.clearance.machineMm), retractZ: local(plan.safety.retract.machineMm),
      feedZ: local(plan.safety.feed.machineMm), topZ: local(topMachine), bottomZ: local(end.machineMm),
      ...(input.stockTopMachineMm === undefined ? {} : { stockTopZ: local(input.stockTopMachineMm) }),
    },
    snapshotIntent: {
      version: 1, clearance: inferred(plan.safety.clearance.machineMm),
      retract: inferred(plan.safety.retract.machineMm), feed: inferred(plan.safety.feed.machineMm),
      top: inferred(topMachine), bottom: inferred(end.machineMm),
    },
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) => ids.indexOf(id) === index),
    ...(draft.finishDepthMm === undefined ? {} : { finishDepthMm: Math.max(0, topMachine - end.machineMm) }),
  }
}
