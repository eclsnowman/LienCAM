import type { Operation, OperationType } from '../types'
import type { PlanMetadata } from './contracts/plan'
import { editOperation } from './schema'
import { defaultHeights, defaultPasses, defaultLinking } from './parameterDefaults'
import { OPERATION_REGISTRY } from './registry'
import type { CurrentPlanningAdapter } from './operationDefinition'
import type { PlanningInput } from './planning'
import type { ValidationInput } from './validation'

/** Identity comes from the caller: no random ids, browser, store or implicit active setup. */
export function createOperation(type: OperationType,
  identity: Pick<Operation, 'id' | 'name' | 'toolId'>,
  overrides: Partial<Pick<Operation, 'params' | 'heights' | 'passes' | 'linking' | 'geometrySelections' | 'smartHeight'>> & PlanMetadata = {},
): Operation {
  return {
    ...identity, type, enabled: true, status: 'pending', geometrySelections: [],
    heights: structuredClone(defaultHeights), passes: structuredClone(defaultPasses), linking: structuredClone(defaultLinking),
    ...structuredClone(overrides),
    params: { ...OPERATION_REGISTRY[type].schema().defaults, ...structuredClone(overrides.params ?? {}) },
  }
}

/** Current adapter performs its existing height/geometry resolution and refusals once. */
export function createHeadlessPlanner(current: CurrentPlanningAdapter) {
  return {
    create: createOperation,
    edit: editOperation,
    validate: (type: OperationType, input: ValidationInput) => OPERATION_REGISTRY[type].validate(input),
    plan: (input: PlanningInput) => OPERATION_REGISTRY[input.operation.type].plan(input, current),
  }
}
