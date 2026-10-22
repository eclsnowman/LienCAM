// WO-3034 (alpha.3 A3-21): post-plan cycle time. The re-hosted copy of today's
// time model (time/runtime.ts, the store's estimatedCutTimeMs, BL-056) run on the
// planned moves, so the value equals the store's on every row (BM-EST-time).
//
// The machine is read from the machine profile the world model's machineRecord
// (src/kernel/world/machine.ts) is built from: today's model also reads per-axis
// max velocity, the stop angle and UCCNC linear unification from the controller
// definition, which the record does not carry, so the profile is the input.
import type { MachineConfig, ToolpathMove } from '../../types'
import { available, degraded, unavailable, type CycleTimeValue, type Estimate } from './contracts'
import { estimateRuntimeMsOrError } from './time/runtime'
import { machineCutTimeMotion } from './time/machineMotion'

export type CycleTimeMachine = Pick<MachineConfig, 'rapidRate' | 'controller' | 'controllerDefinition'>

export interface CycleTimeInput {
  readonly moves: readonly ToolpathMove[]
  readonly machine: CycleTimeMachine
  /** The operation's resolved fast-traverse speed, mm/min (today: resolveFeedrates). Defaults to the rapid rate. */
  readonly fastTraverseRate?: number
  /** The operation's resolved wall-finish speed, mm/min. Defaults to the rapid rate. */
  readonly finishRate?: number
}

export function estimateCycleTime(input: CycleTimeInput): Estimate<CycleTimeValue> {
  const rapidRate = input.machine.rapidRate
  const motion = machineCutTimeMotion(input.machine)
  const result = estimateRuntimeMsOrError(input.moves as ToolpathMove[], rapidRate,
    input.fastTraverseRate ?? rapidRate, input.finishRate ?? rapidRate, motion)
  const assumptions = [`rapid ${rapidRate} mm/min`,
    `fast traverse ${input.fastTraverseRate ?? rapidRate} mm/min`, `finish ${input.finishRate ?? rapidRate} mm/min`]
  if (result.error !== undefined) return unavailable(result.error, assumptions)
  if (!motion) {
    return degraded({ ms: result.ms, model: 'distance-over-feed', facts: [] },
      'the machine states no X, Y and Z acceleration: distance over feed (today\'s rule)', assumptions)
  }
  return available({ ms: result.ms, model: 'achievable-feed', facts: motion.facts ?? [] }, assumptions)
}
