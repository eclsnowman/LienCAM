// WO-3020 (alpha.3 A3-11, parity): the heights service - one object both lanes
// would call, bundling the resolver, the plane-order validator, the depth
// formulas, the level builder and the plan-to-builder conversion under one
// policy. Headless: it imports only kernel files and src/types. Nothing in the
// app calls it yet (engine selector stays `current`); a family switches in P6.

import type { HeightEvidenceContext, OperationHeightIntentV2 } from './contracts'
import { resolveHeightPlan, type ResolveSmartHeightPlanResult } from './resolve'
import { planeOrderViolation } from './planeOrder'
import { buildDepthLevels } from './levels'
import { planDependencyIds, planToLocalHeights, planToWorkerHeights, roughLevelTopZ } from './builder'
import * as formulas from './formulas'
import { PARITY_POLICY, type HeightsPolicy } from './policy'

export interface HeightsService {
  readonly policy: HeightsPolicy
  /** Resolve one operation's planes: user override > operation policy > setup default. */
  resolve(intent: OperationHeightIntentV2, context: HeightEvidenceContext): ResolveSmartHeightPlanResult
  readonly planeOrderViolation: typeof planeOrderViolation
  readonly levels: typeof buildDepthLevels
  readonly formulas: typeof formulas
  readonly toWorkerHeights: typeof planToWorkerHeights
  readonly toLocalHeights: typeof planToLocalHeights
  readonly dependencyIds: typeof planDependencyIds
  roughLevelTopZ(planes: { stockBoxTopZ: number }): number
}

export function createHeightsService(policy: HeightsPolicy = PARITY_POLICY): HeightsService {
  return Object.freeze({
    policy,
    resolve: resolveHeightPlan,
    planeOrderViolation,
    levels: buildDepthLevels,
    formulas,
    toWorkerHeights: planToWorkerHeights,
    toLocalHeights: planToLocalHeights,
    dependencyIds: planDependencyIds,
    roughLevelTopZ: (planes: { stockBoxTopZ: number }) => roughLevelTopZ(policy, planes),
  })
}
