// Smart Height V2 for steep_shallow_3d. The composite finish has the same
// physical target-field contract as its two component finish strategies, but
// keeps its own operation identity so saved authority cannot be mistaken for
// a standalone Parallel or Waterline operation.

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
import {
  type HeightEvidenceContext,
  type OperationHeightIntentV2,
  type ResolvedHeightPlanV2,
} from './types'
import { resolveSmartHeightPlan, type SmartHeightRefusal } from './resolve'

export type SteepShallow3dHeightMode = 'target_surface' | 'bounded_surface'

export interface SteepShallow3dHeightDraft {
  mode: SteepShallow3dHeightMode
  finishDepthMm?: number
}

export type SteepShallow3dIntentInput = Parallel3dIntentInput
export type SteepShallow3dEvidenceInput = Parallel3dEvidenceInput

export interface ResolvedSteepShallow3dSmartHeights {
  plan: ResolvedHeightPlanV2
  localHeights: ResolvedParallel3dHeights
  snapshotIntent: HeightIntentV1
  dependencyIds: string[]
  finishDepthMm?: number
}

export class SteepShallow3dSmartHeightError extends Error {
  readonly refusal: SmartHeightRefusal

  constructor(refusal: SmartHeightRefusal) {
    super(`Steep and Shallow 3D Smart Height refused (${refusal.code}): ${refusal.message}`)
    this.name = 'SteepShallow3dSmartHeightError'
    this.refusal = refusal
  }
}

/** Author the composite operation's own target-surface authority. */
export function buildSteepShallow3dSmartIntent(
  input: SteepShallow3dIntentInput,
): OperationHeightIntentV2 {
  const parallel = buildParallel3dSmartIntent(input)
  if (parallel.policy.operationType !== 'parallel_3d') {
    throw new Error('Parallel Smart Height builder returned the wrong operation family.')
  }
  return {
    ...parallel,
    policy: {
      operationType: 'steep_shallow_3d',
      variant: parallel.policy.variant,
    },
  }
}

export function steepShallow3dHeightDraftFromIntent(
  intent: OperationHeightIntentV2,
): SteepShallow3dHeightDraft {
  if (intent.policy.operationType !== 'steep_shallow_3d') {
    throw new Error('Cannot edit a non-Steep-and-Shallow Smart Height intent as Steep and Shallow 3D.')
  }
  return parallel3dHeightDraftFromIntent({
    ...intent,
    policy: { ...intent.policy, operationType: 'parallel_3d' },
  })
}

/** Build the shared target field while retaining the composite family name. */
export function buildSteepShallow3dEvidenceContext(
  input: SteepShallow3dEvidenceInput,
): HeightEvidenceContext {
  return {
    ...buildParallel3dEvidenceContext(input),
    operationType: 'steep_shallow_3d',
  }
}

export function resolveSteepShallow3dSmartHeights(input: {
  intent: OperationHeightIntentV2
  evidence: HeightEvidenceContext
  geometryIds: string[]
  geometryPositionZ: number
  stockTopMachineMm?: number
}): ResolvedSteepShallow3dSmartHeights {
  if (input.intent.policy.operationType !== 'steep_shallow_3d' ||
      input.evidence.operationType !== 'steep_shallow_3d') {
    throw new SteepShallow3dSmartHeightError({
      code: 'policy_mismatch',
      message: 'Steep and Shallow 3D Smart Height received another operation family\'s intent or evidence.',
    })
  }
  const scope = input.intent.machining.scope.value
  if (scope.kind !== 'whole_target' || scope.geometryIds.length !== input.geometryIds.length ||
      scope.geometryIds.some((id, index) => id !== input.geometryIds[index])) {
    throw new SteepShallow3dSmartHeightError({
      code: 'policy_mismatch',
      message: 'Steep and Shallow 3D Smart Height scope no longer matches the operation target geometry.',
    })
  }
  const result = resolveSmartHeightPlan(bindUnprovenStockTopSafety(input.intent, input.evidence), input.evidence)
  if (!result.ok) throw new SteepShallow3dSmartHeightError(result.refusal)
  const plan = result.plan
  const end = plan.machining.cutterCenterEnd
  if (!end) {
    throw new SteepShallow3dSmartHeightError({
      code: 'invalid_evidence',
      message: 'Steep and Shallow 3D resolved no cutter-center Target End.',
    })
  }
  const local = (machineMm: number) => machineMm - input.geometryPositionZ
  const topMachine = plan.machining.materialStart.machineMm
  const localHeights: ResolvedParallel3dHeights = {
    clearanceZ: local(plan.safety.clearance.machineMm),
    retractZ: local(plan.safety.retract.machineMm),
    feedZ: local(plan.safety.feed.machineMm),
    topZ: local(topMachine),
    bottomZ: local(end.machineMm),
    ...(input.stockTopMachineMm === undefined
      ? {}
      : { stockTopZ: local(input.stockTopMachineMm) }),
  }
  const inferred = (machineMm: number) => ({
    reference: 'wcs_plane' as const,
    offset: machineMm - input.evidence.wcsOriginMachineMm,
    provenance: 'inferred' as const,
  })
  const draft = steepShallow3dHeightDraftFromIntent(input.intent)
  return {
    plan,
    localHeights,
    snapshotIntent: {
      version: 1,
      clearance: inferred(plan.safety.clearance.machineMm),
      retract: inferred(plan.safety.retract.machineMm),
      feed: inferred(plan.safety.feed.machineMm),
      top: inferred(topMachine),
      bottom: inferred(end.machineMm),
    },
    dependencyIds: plan.evidenceGraph.map(node => node.entityId).filter((id, index, ids) =>
      ids.indexOf(id) === index,
    ),
    ...(draft.finishDepthMm === undefined
      ? {}
      : { finishDepthMm: Math.max(0, topMachine - end.machineMm) }),
  }
}
