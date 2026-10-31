// WO-3085: pure reach calculation shared by the worker and the existing store API.
import type { Tool, ToolHolder, ToolpathMove } from '../types'
import type { ClearanceMesh } from '../lib/cam/holderClearance'
import type { StockState } from '../lib/cam/stockState'
import { clearanceAllowanceMmOf, trimToolpathToToolReachFor3d,
  type HolderClearanceStockBox, type OperationReachShortfall } from '../lib/cam/holderClearanceGate'

export interface ToolReachInPartFrameInput {
  /** Operation label that opens every console line, e.g. "Waterline 3D". */
  readonly operation: string
  /** The strategy's moves, in the part's display-local frame. */
  readonly moves: readonly ToolpathMove[]
  readonly tool: Tool
  /** The operation's resolved plunge rate, including its enabled override. */
  readonly plungeRate?: number
  readonly holder?: ToolHolder
  /** The block as loaded, in the same frame. Absent: the part and workholding only. */
  readonly stockBounds?: HolderClearanceStockBox
  /** The part the strategy machined, in the same frame. Always an obstacle. */
  readonly part: ClearanceMesh
  /** The strategy's surface tolerance, mm: the cutter's contact with the part is judged to it. */
  readonly partToleranceMm: number
  /** The operation's params; `clearanceAllowanceMm` is the Shank clearance (WO-1566). */
  readonly params: unknown
  /** Workholding in the same frame (`workholdingInPartFrame`). */
  readonly workholding: readonly ClearanceMesh[]
  /** What the earlier operations of the setup left, in the same frame. */
  readonly remainingStock?: StockState
  /** WO-1625: nothing precedes this operation - the block as loaded IS the remaining stock. */
  readonly noEarlierOperations?: boolean
  /** WO-1683: the setup's WCS label (e.g. 'G54'), so a stop can name its frame. */
  readonly wcsLabel?: string
  /** WO-3048: drop the visits the trim leaves with nothing to cut (adaptive_3d passes its switch). */
  readonly dropEmptyVisits?: boolean
}

export function trimToToolReachInPartFrame(input: ToolReachInPartFrameInput): {
  moves: ToolpathMove[]
  /** For the app console: one summary line per generate when something stopped,
   *  and the caveats that shaped it. */
  notices: string[]
  /** Limits of a check that stopped nothing, for the developer console. */
  uncheckedLimits: string[]
  /** The seam stopped at least one cut: the moves are not the strategy's moves. */
  trimmed: boolean
  /** WO-1683: the fact the operation itself carries when trimmed; absent otherwise. */
  shortfall?: OperationReachShortfall
} {
  const reach = trimToolpathToToolReachFor3d({
    operation: input.operation,
    moves: input.moves,
    tool: input.tool,
    plungeRate: input.plungeRate,
    ...(input.holder ? { holder: input.holder } : {}),
    ...(input.stockBounds ? { stockBounds: input.stockBounds } : {}),
    clearancePart: input.part,
    partToleranceMm: input.partToleranceMm,
    ...(input.remainingStock ? { remainingStock: input.remainingStock } : {}),
    ...(input.noEarlierOperations ? { noEarlierOperations: true } : {}),
    clearanceAllowanceMm: clearanceAllowanceMmOf(input.params),
    ...(input.workholding.length > 0 ? { workholding: input.workholding } : {}),
    ...(input.wcsLabel !== undefined ? { wcsLabel: input.wcsLabel } : {}),
    ...(input.dropEmptyVisits ? { dropEmptyVisits: true } : {}),
  })
  return {
    moves: [...reach.moves],
    notices: [...reach.notices],
    uncheckedLimits: [...reach.uncheckedLimits],
    trimmed: reach.stops.length > 0,
    ...(reach.shortfall ? { shortfall: reach.shortfall } : {}),
  }
}

