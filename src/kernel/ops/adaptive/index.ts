// WO-3018 (alpha.3 A3-27 part a): the one adaptive operation in the kernel.
//
// Two registry records (adaptive_clearing_2d and adaptive_3d, REQ-FW-12) over ONE planner.
// The planner reaches today's engine only through the facade its composition supplies
// (REQ-OP-adaptive-4): the LGPL engine stays its own separately loaded module and nothing
// of it moves into the kernel. The numbers that engine reads are the policy record in
// ./policy. Production registrations stay empty (planning.ts): the switch stays `current`,
// and `both` runs the kernel route beside the current one only to record equality.
import type { ToolpathMove } from '../../../types'
import type { EngineId, KernelPlan, PlanningInput } from '../../planning'
import { ADAPTIVE_POLICY } from './policy'

export * from './policy'

export type AdaptiveOperationType = 'adaptive_clearing_2d' | 'adaptive_3d'

export interface AdaptiveOperationRecord {
  readonly type: AdaptiveOperationType
  /** MD-22: the input mode of the one operation; both share one parameter set and policy. */
  readonly inputMode: '2.5d' | '3d'
  /** The worker lane today's engine runs this alias on. */
  readonly lane: 'toolpath-worker' | 'cam3d-worker'
}

export const ADAPTIVE_OPERATION_RECORDS: Readonly<Record<AdaptiveOperationType, AdaptiveOperationRecord>> = Object.freeze({
  adaptive_clearing_2d: Object.freeze({ type: 'adaptive_clearing_2d', inputMode: '2.5d', lane: 'toolpath-worker' }),
  adaptive_3d: Object.freeze({ type: 'adaptive_3d', inputMode: '3d', lane: 'cam3d-worker' }),
})

/** REQ-OP-adaptive-4. `run` is today's complete route for one prepared request, including
 *  the postprocessing the current engine applies before it publishes (reach and holder
 *  trim, workholding, notices). The kernel never reimplements any of it. */
export interface AdaptiveEngineFacade<Request> {
  run(request: Request): Promise<{ moves: ToolpathMove[] }>
}

export interface ResolvedAdaptiveInput<Request> {
  request: Request
  resolvedHeights: KernelPlan['resolvedHeights']
  resolvedHeightPlan: KernelPlan['resolvedHeightPlan']
}

export interface AdaptivePlannerDependencies<Request> {
  /** The request the store already prepared; the kernel derives no geometry or stock. */
  resolve(input: PlanningInput): Promise<ResolvedAdaptiveInput<Request>>
  /** Throw on a stale or foreign request; called at every asynchronous boundary. */
  assertCurrent(resolved: ResolvedAdaptiveInput<Request>, input: PlanningInput): void
  engine: AdaptiveEngineFacade<Request>
  now?: () => number
}

export interface AdaptiveKernelPlan extends KernelPlan {
  policyVersion: string
}

/** The one implementation behind both records. No catch and no fallback: an explicit
 *  kernel request either succeeds or refuses with the engine's own error. */
export function createAdaptivePlanner<Request>(
  record: AdaptiveOperationRecord,
  dependencies: AdaptivePlannerDependencies<Request>,
): (input: PlanningInput) => Promise<AdaptiveKernelPlan> {
  const { resolve, assertCurrent, engine } = dependencies
  if (ADAPTIVE_OPERATION_RECORDS[record.type] !== record) {
    throw new Error('Adaptive kernel: the record must be one of ADAPTIVE_OPERATION_RECORDS.')
  }
  if (typeof resolve !== 'function' || typeof assertCurrent !== 'function' || typeof engine?.run !== 'function') {
    throw new Error('Adaptive kernel: a complete resolver, currency assertion and engine facade are required.')
  }
  const now = dependencies.now ?? (() => performance.now())
  return async input => {
    if (input.operation.type !== record.type) {
      throw new Error(`Adaptive kernel: the ${record.type} record cannot plan a ${input.operation.type} operation.`)
    }
    const started = now()
    const resolved = await resolve(input)
    if (!resolved.resolvedHeights || !resolved.resolvedHeightPlan) {
      throw new Error('Adaptive kernel: the resolver must supply both resolved height metadata objects.')
    }
    assertCurrent(resolved, input)
    const resolvedHeights = structuredClone(resolved.resolvedHeights)
    const resolvedHeightPlan = structuredClone(resolved.resolvedHeightPlan)
    const { moves } = await engine.run(resolved.request)
    assertCurrent(resolved, input)
    return { moves, resolvedHeights, resolvedHeightPlan, computeTimeMs: now() - started, policyVersion: ADAPTIVE_POLICY.version }
  }
}

/** What `both` records beside the current engine's authoritative output. */
export interface AdaptiveShadowRecord {
  engine: 'both'
  type: AdaptiveOperationType
  policyVersion: string
  equal: boolean
  moveCount: number
  computeTimeMs: number
}

export function adaptiveShadowRecord(
  type: AdaptiveOperationType,
  current: readonly ToolpathMove[],
  plan: AdaptiveKernelPlan,
): AdaptiveShadowRecord {
  return {
    engine: 'both', type, policyVersion: plan.policyVersion,
    equal: JSON.stringify(current) === JSON.stringify(plan.moves),
    moveCount: plan.moves.length, computeTimeMs: plan.computeTimeMs,
  }
}

/** The store's envelope for a 2.5D adaptive request; it sends one only after its own
 *  dispatch preparation is complete. Payload XY and move XYZ are world/mm. */
export interface AdaptivePilotEnvelope {
  engine: Exclude<EngineId, 'current'>
  input: PlanningInput
  resolvedHeights: KernelPlan['resolvedHeights']
  resolvedHeightPlan: KernelPlan['resolvedHeightPlan']
}
