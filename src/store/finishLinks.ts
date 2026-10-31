// WO-3085: unchanged finish-link calculations, shared by the page fallback and postprocess worker.
import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
import type { Operation, Tool, ToolpathMove } from '../types'
import type { StockState } from '../lib/cam/stockState'
import type { ClearanceMesh } from '../lib/cam/holderClearance'
import { clearanceAllowanceMmOf } from '../lib/cam/holderClearanceGate'
import { lowerFinishLinksOverRemovedStock } from '../cam3d/integration/finishLinksOverRemovedStock'
import { dropFinishRunsEarlierSweepsReached, rapidAirFeedsOverRemovedStock } from '../cam3d/integration/airFeedOverRemovedStock'
import { resolveFeedrates } from '../lib/cam/feedrates'

export function lowerFinishLinksAfterEarlierOperations(input: {
  op: Operation
  tool: Tool
  moves: ToolpathMove[]
  /** What the earlier operations left, in the moves' frame (earlierMaterialInPartFrame). */
  remaining: StockState | undefined
  preceding?: Parameters<typeof rapidAirFeedsOverRemovedStock>[0]['preceding']
  clearanceZ: number
  workholding: readonly ClearanceMesh[]
  operationLabel: string
}): { moves: ToolpathMove[]; dependsOnEarlierOperations: boolean } {
  const { op, tool, moves, remaining } = input
  const unchanged = { moves, dependsOnEarlierOperations: false }
  if (!remaining) return unchanged
  try {
    // WO-3136 (owner D5): only where the earlier, bigger tool could not reach - the
    // runs it already finished to this finish's tolerance are left out, and the
    // links that replace them are lowered below with the finish's own.
    const tolerance = (op.params as { tolerance?: unknown }).tolerance
    const reached = dropFinishRunsEarlierSweepsReached({
      moves, tool, remaining, preceding: input.preceding, clearanceZ: input.clearanceZ,
      toleranceMm: typeof tolerance === 'number' ? tolerance : 0,
      plungeFeed: resolveFeedrates(tool, op.feedrateOverride).plungeRate,
    })
    const lowered = lowerFinishLinksOverRemovedStock({
      moves: reached.moves, tool, remaining, clearanceZ: input.clearanceZ,
      ...(input.workholding.length > 0
        ? { workholding: input.workholding, workholdingAllowanceMm: clearanceAllowanceMmOf(op.params) }
        : {}),
    })
    if (lowered.candidates > 0) {
      console.info(
        operatorText('index40', { value1: String(input.operationLabel), value2: String(lowered.lowered), value3: String(lowered.candidates) }),
      )
    }
    // WO-1641: and no fed move travels through material that is already gone.
    const air = rapidAirFeedsOverRemovedStock({
      moves: lowered.moves, tool, remaining, preceding: input.preceding,
    })
    if (air.rapided > 0) {
      console.info(
        operatorText('index41', { value1: String(input.operationLabel), value2: String(air.rapided), value3: String(air.candidates) }),
      )
    }
    // Each change is only safe given what the earlier operations removed.
    return { moves: air.moves, dependsOnEarlierOperations: reached.dropped > 0 || lowered.lowered > 0 || air.rapided > 0 }
  } catch (err) {
    console.warn(operatorText('index42', { value1: String(input.operationLabel) }), err)
    return unchanged
  }
}

