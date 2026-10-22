import type { OperationType } from '../types'
import type { KernelPlan, PlanningInput } from './planning'
import { parameterSchema } from './schema'
import { operationMetadata } from './metadata'
import { validateOperation, type KnowledgeDeclaration, type ValidationInput } from './validation'

/** The adapter belongs to the caller; the registry imports no workers, store or DOM. */
export type CurrentPlanningAdapter = (input: PlanningInput) => Promise<KernelPlan>
export function describeOperation(id: OperationType) {
  const surface = id.endsWith('_3d')
  const closedRegions = ['pocket_2d', 'adaptive_clearing_2d', 'vcarve'].includes(id)
  const knowledge: KnowledgeDeclaration = {
    required: surface ? ['surface-height', 'tool-geometry'] : ['planar-contours', 'parameter-depth', 'tool-geometry'],
    optional: surface ? ['normals-slope', 'curvature', 'stock-state', 'obstacles', 'prior-toolpaths', 'feature-identity']
      : ['closure-orientation', 'nesting-islands', 'stock-state', 'obstacles', 'prior-toolpaths', 'feature-identity'],
    closedRegions,
  }
  return {
    id, knowledge, ...operationMetadata[id],
    schema: () => parameterSchema(id),
    validate: (input: ValidationInput) => validateOperation(knowledge, input),
    plan: (input: PlanningInput, current: CurrentPlanningAdapter) => {
      if (input.operation.type !== id) throw new Error(`Planner ${id} received ${input.operation.type}`)
      return current(input)
    },
  }
}
