import type { Operation, Project, Setup, Tool, ToolpathMove } from '../types'

export type EngineId = 'current' | 'kernel' | 'both'
export interface PlanningInput {
  operation: Operation
  setup: Setup
  project: Project
  tool: Tool
}
export interface KernelPlan {
  moves: ToolpathMove[]
  resolvedHeights: NonNullable<Operation['resolvedHeights']>
  resolvedHeightPlan: NonNullable<Operation['resolvedHeightPlan']>
  computeTimeMs: number
}
export type KernelPlanner = (input: PlanningInput) => Promise<KernelPlan>
export type KernelPlanners = Readonly<Partial<Record<Operation['type'], KernelPlanner>>>

// No production registrations until each family has its own parity proof.
export const kernelPlanners: KernelPlanners = Object.freeze({})
export const engineByType: Readonly<Partial<Record<Operation['type'], EngineId>>> = Object.freeze({})

/** Shared selection for fingerprinting and fully composed worker registries. */
export function createEngineSelector(
  registered: readonly Operation['type'][],
  setting: () => unknown = () => undefined,
  overrides: Readonly<Partial<Record<Operation['type'], EngineId>>> = engineByType,
): (type: Operation['type']) => EngineId {
  return type => {
    const requested = overrides[type] ?? setting()
    if (!registered.includes(type)) return 'current'
    return requested === 'kernel' || requested === 'both' ? requested : 'current'
  }
}

/** Pure policy: no store, UI, worker, environment reads or mutable singleton. */
export function createEngineRouter(
  planners: KernelPlanners,
  setting: () => unknown = () => undefined,
  overrides: Readonly<Partial<Record<Operation['type'], EngineId>>> = engineByType,
) {
  const engineId = createEngineSelector((Object.keys(planners) as Operation['type'][]).filter(type => !!planners[type]), setting, overrides)
  return {
    engineId,
    async plan(
      input: PlanningInput,
      current: () => Promise<void>,
      publish: (plan: KernelPlan) => void,
      compare: (plan: KernelPlan) => void,
    ): Promise<void> {
      const selected = engineId(input.operation.type)
      if (selected === 'current') return current()
      const plan = await planners[input.operation.type]!(input)
      if (selected === 'kernel') publish(plan)
      else {
        // CI comparison retains the current engine's authoritative output.
        await current()
        compare(plan)
      }
    },
  }
}
