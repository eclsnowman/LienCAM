import type { HeightIntentV1 } from '../../../types'
import type { ResolvedParallel3dHeights } from '../../../cam3d/integration/parallel3dOperation'
import {
  bindUnprovenStockTopSafety,
  buildParallel3dEvidenceContext,
  buildParallel3dSmartIntent,
  parallel3dHeightDraftFromIntent,
  type Parallel3dEvidenceInput,
  type Parallel3dIntentInput,
} from './parallel3d'
import type { HeightEvidenceContext, OperationHeightIntentV2, ResolvedHeightPlanV2 } from './types'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'

export type Scallop3dIntentInput = Parallel3dIntentInput
export type Scallop3dEvidenceInput = Parallel3dEvidenceInput

export class Scallop3dSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Scallop 3D Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'Scallop3dSmartHeightError'
    this.refusal = refusal
  }
}

export function buildScallop3dSmartIntent(input: Scallop3dIntentInput): OperationHeightIntentV2 {
  const base = buildParallel3dSmartIntent(input)
  if (base.policy.operationType !== 'parallel_3d') {
    throw new Error('Parallel Smart Height builder returned the wrong operation family.')
  }
  return { ...base, policy: { operationType: 'scallop_3d', variant: base.policy.variant } }
}

export function scallop3dHeightDraftFromIntent(intent: OperationHeightIntentV2): {
  mode: 'target_surface' | 'bounded_surface'; finishDepthMm?: number;
} {
  if (intent.policy.operationType !== 'scallop_3d') {
    throw new Error('Cannot edit a non-Scallop Smart Height intent as Scallop 3D.')
  }
  return parallel3dHeightDraftFromIntent({
    ...intent,
    policy: { ...intent.policy, operationType: 'parallel_3d' },
  })
}

export function buildScallop3dEvidenceContext(input: Scallop3dEvidenceInput): HeightEvidenceContext {
  return { ...buildParallel3dEvidenceContext(input), operationType: 'scallop_3d' }
}

export function resolveScallop3dSmartHeights(input: {
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
  if (input.intent.policy.operationType !== 'scallop_3d' || input.evidence.operationType !== 'scallop_3d') {
    throw new Scallop3dSmartHeightError({
      code: 'policy_mismatch', message: 'Scallop 3D received another operation family\'s height authority.',
    })
  }
  const scope = input.intent.machining.scope.value
  if (scope.kind !== 'whole_target' || scope.geometryIds.length !== input.geometryIds.length ||
      scope.geometryIds.some((id, index) => id !== input.geometryIds[index])) {
    throw new Scallop3dSmartHeightError({
      code: 'policy_mismatch', message: 'Scallop 3D height scope no longer matches its target geometry.',
    })
  }
  const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(input.intent, input.evidence), input.evidence)
  if (!result.ok) throw new Scallop3dSmartHeightError(result.refusal)
  const plan = result.plan
  const end = plan.machining.cutterCenterEnd
  if (!end) throw new Scallop3dSmartHeightError({ code: 'invalid_evidence', message: 'Scallop 3D resolved no Target End.' })
  const local = (machineMm: number) => machineMm - input.geometryPositionZ
  const topMachine = plan.machining.materialStart.machineMm
  const inferred = (machineMm: number) => ({
    reference: 'wcs_plane' as const,
    offset: machineMm - input.evidence.wcsOriginMachineMm,
    provenance: 'inferred' as const,
  })
  const draft = scallop3dHeightDraftFromIntent(input.intent)
  return {
    plan,
    localHeights: {
      clearanceZ: local(plan.safety.clearance.machineMm),
      retractZ: local(plan.safety.retract.machineMm),
      feedZ: local(plan.safety.feed.machineMm),
      topZ: local(topMachine),
      bottomZ: local(end.machineMm),
      ...(input.stockTopMachineMm === undefined ? {} : { stockTopZ: local(input.stockTopMachineMm) }),
    },
    snapshotIntent: {
      version: 1,
      clearance: inferred(plan.safety.clearance.machineMm),
      retract: inferred(plan.safety.retract.machineMm),
      feed: inferred(plan.safety.feed.machineMm),
      top: inferred(topMachine),
      bottom: inferred(end.machineMm),
    },
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) => ids.indexOf(id) === index),
    ...(draft.finishDepthMm === undefined ? {} : { finishDepthMm: Math.max(0, topMachine - end.machineMm) }),
  }
}
