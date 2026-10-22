// WO-3034 (alpha.3 A3-21): one post-plan estimate set for one kernel operation's
// planned moves. Read-only: the inputs are never mutated, nothing is written into
// the moves, and no estimate changes an operation's status (REQ-EST-7). Each
// estimator's wall time is returned beside the set, never inside it, so two runs
// give equal sets (A.5 determinism rule).
import type { Tool, ToolpathMove } from '../../types'
import type { Box3, SweepShape } from '../material'
import type { EstimateCost, EstimateSet } from './contracts'
import { estimateCycleTime, type CycleTimeMachine } from './cycleTime'
import { estimateCusp } from './cusp'
import { estimateEngagement } from './engagement'
import { estimateDeflectionProxy } from './deflection'

export interface OperationEstimateInput {
  readonly moves: readonly ToolpathMove[]
  readonly tool: Pick<Tool, 'diameter' | 'lengthBelowHolder' | 'numberOfFlutes'>
  /** The tool's sweep shape from the kernel material service (sweepShape / toolShape). */
  readonly shape: SweepShape
  readonly machine: CycleTimeMachine
  /** The operation's resolved speeds, mm/min (today: resolveFeedrates). */
  readonly feeds: { readonly fastTraverseRate?: number; readonly finishRate?: number; readonly feedRate?: number; readonly rpm?: number }
  readonly stockBox?: Box3
  /** The stock state's cell, mm; the engagement replay cell follows it. */
  readonly stockCellMm?: number
  readonly engagementCellMm?: number
  readonly programmedStepoverMm?: number
}

export function estimateOperation(input: OperationEstimateInput, now: () => number = () => performance.now()):
  { set: EstimateSet; cost: EstimateCost } {
  let t = now()
  const lap = () => { const end = now(), ms = end - t; t = end; return ms }
  const cycleTime = estimateCycleTime({ moves: input.moves, machine: input.machine,
    fastTraverseRate: input.feeds.fastTraverseRate, finishRate: input.feeds.finishRate })
  const cycleTimeMs = lap()
  const cusp = estimateCusp(input.moves, input.shape)
  const cuspMs = lap()
  const engagement = estimateEngagement({ moves: input.moves, shape: input.shape, stockBox: input.stockBox,
    stockCellMm: input.stockCellMm, cellMm: input.engagementCellMm, programmedStepoverMm: input.programmedStepoverMm })
  const engagementMs = lap()
  const deflection = estimateDeflectionProxy({ tool: input.tool,
    radialFraction: engagement.status === 'unavailable' ? undefined : engagement.value.peakFraction,
    axialDepthMm: engagement.status === 'unavailable' || engagement.value.maxAxialDepthMm === 0 ? undefined : engagement.value.maxAxialDepthMm,
    feedMmMin: input.feeds.feedRate, rpm: input.feeds.rpm })
  const deflectionMs = lap()
  return {
    set: Object.freeze({ mode: 'post-plan' as const, cycleTime, cusp, engagement, deflection }),
    cost: Object.freeze({ cycleTimeMs, cuspMs, engagementMs, deflectionMs }),
  }
}
