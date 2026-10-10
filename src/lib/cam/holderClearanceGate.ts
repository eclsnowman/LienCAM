// WO-276: the one place a computed toolpath is proved clear of the tool holder
// and shank before it leaves the worker.
//
// The arithmetic already exists (holderClearance.ts, WO-263) and the stock
// primitive already exists (stockState.ts, WO-262). This module is ONLY the
// assembly: build the raw stock block, ask the existing check, and turn its
// report into words a machinist can act on. It owns no collision arithmetic.
//
// HONEST LIMIT, repeated in every message it produces: the block is the stock
// as loaded. Nothing in the app yet remembers what earlier operations removed
// (that is gap 2; WO-274 is its first half). The block is the most material
// that can ever be there, so this can warn about a collision a previous
// operation would have cleared - it can never miss one that is real.

import type { Tool, ToolHolder, ToolpathMove } from '../../types'
import { formatPosition, positionNumber } from '../machine/positionFrames'
import {
  buildSolidColumns,
  checkHolderAndShankClearance,
  toolNeckBand,
  trimToolpathToAssemblyReach,
  type ClearanceComponent,
  type ClearanceMesh,
  type HolderClearanceReport,
  type ReachStop,
  type SolidColumns,
} from './holderClearance'
import { createStockState, type StockState } from './stockState'
import type { ToolpathStockBlock } from './types'

export type HolderClearanceGateStatus = 'clear' | 'collision' | 'not-checked'

export interface HolderClearanceGateResult {
  /** 'clear' means nothing the check has data for was found to collide -
   *  including a tool with no holder or no stickout defined, WO-1626: that is
   *  the operator's decision, not ours to flag, so it is a quiet 'clear', not
   *  'not-checked'. 'not-checked' is reserved for a reason nobody chose: a
   *  missing stock block, an unreadable holder segment, an invalid shank
   *  profile, or a path the check genuinely could not run. */
  readonly status: HolderClearanceGateStatus
  /** Machinist-facing text. Always present for 'collision' and 'not-checked'. */
  readonly message?: string
  /** The underlying WO-263 report, absent only when there was nothing to
   *  check at all (no moves). */
  readonly report?: HolderClearanceReport
}

export interface HolderClearanceGateInput {
  /** Operation label used to open the message, e.g. "Pocket". */
  readonly operation: string
  readonly moves: readonly ToolpathMove[]
  readonly tool: Tool
  readonly holder?: ToolHolder
  readonly stockBlock?: ToolpathStockBlock
}

/**
 * WO-278. The same stock block in the cam3d spelling (`Box3`: flat minX..maxZ).
 * Declared STRUCTURALLY rather than imported: src/lib/cam sits below src/cam3d
 * and must not depend on it, and a cam3d `Box3` satisfies this shape as-is.
 */
export interface HolderClearanceStockBox {
  readonly minX: number
  readonly minY: number
  readonly minZ: number
  readonly maxX: number
  readonly maxY: number
  readonly maxZ: number
}

export interface HolderClearanceGate3dInput {
  /** Operation label used to open the message, e.g. "Adaptive 3D". */
  readonly operation: string
  readonly moves: readonly ToolpathMove[]
  readonly tool: Tool
  readonly holder?: ToolHolder
  /**
   * Stock block in the SAME frame as `moves`. The 3D operations compute in the
   * part's display-local frame, so the caller resolves the block into that
   * frame; absent means "no resolvable stock" and is reported as NOT CHECKED.
   */
  readonly stockBounds?: HolderClearanceStockBox
}

// The z-dexel grid is rebuilt per clearance query by isStockRegionEmpty, so the
// column count is the cost driver. The block is UNIFORM (no operation has cut
// it yet), so its top is the same in every column and a coarse grid loses no
// information about material - the only thing resolution must buy is that a
// queried component footprint always covers at least one column CENTRE
// (maxTraverseIntrusion tests centres). A square grid of pitch c has a largest
// empty circle of radius 0.707c, so c <= 0.9 * smallest component radius is
// comfortably sufficient.
const CELL_FRACTION_OF_SMALLEST_RADIUS = 0.9
const MAX_STOCK_COLUMNS = 65_536

// Reach pre-check margin. Stock tops are stored as f32 and the check lowers a
// queried assembly bottom by one micron, so a clearance proof needs more than
// zero: a fixed millimetre-scale floor plus a relative term for large machine
// coordinates.
const REACH_MARGIN_MM = 1e-3
const REACH_MARGIN_RELATIVE = 1e-6

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

function mm(value: number): string {
  return value.toFixed(3)
}

/** "COMPUTE_THREAD_MILL" -> "Thread mill". Derived, never hand-listed, so a
 *  strategy added to the worker names itself correctly on day one. */
export function operationLabelForRequestType(requestType: string): string {
  const words = requestType.replace(/^COMPUTE_/, '').toLowerCase().replace(/_/g, ' ').trim()
  if (words === '') return 'Operation'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Radius of the narrowest component the check can query, used to size the
 *  grid. Holder segments are queried at their widest diameter (holderClearance
 *  does that conservatively), so that is the diameter to measure here too. */
function smallestComponentRadiusMm(tool: Tool, holder: ToolHolder | undefined): number | undefined {
  const radii: number[] = []
  if (isPositiveFinite(tool.shankDiameter)) radii.push(tool.shankDiameter / 2)
  const neck = isPositiveFinite(tool.shankDiameter) ? toolNeckBand(tool) : undefined
  if (neck) radii.push(neck.diameterMm / 2)
  for (const segment of holder?.segments ?? []) {
    const widest = Math.max(segment.lowerDiameter, segment.upperDiameter)
    if (isPositiveFinite(widest)) radii.push(widest / 2)
  }
  return radii.length > 0 ? Math.min(...radii) : undefined
}

function largestComponentRadiusMm(tool: Tool, holder: ToolHolder | undefined): number {
  let largest = isPositiveFinite(tool.shankDiameter) ? tool.shankDiameter / 2 : 0
  for (const segment of holder?.segments ?? []) {
    const widest = Math.max(segment.lowerDiameter, segment.upperDiameter)
    if (isPositiveFinite(widest)) largest = Math.max(largest, widest / 2)
  }
  return largest
}

/** Height above the tool tip of the LOWEST assembly component the check can
 *  query. Deliberately over-inclusive (it counts a shank that the check may
 *  decide is fully buried in the holder): a lower value only makes the reach
 *  pre-check less willing to declare clearance. */
function lowestComponentOffsetMm(tool: Tool, holder: ToolHolder | undefined): number | undefined {
  const offsets: number[] = []
  if (isPositiveFinite(tool.fluteLength) && isPositiveFinite(tool.shankDiameter)) {
    offsets.push(toolNeckBand(tool)?.bottomMm ?? tool.fluteLength)
  }
  if (holder && holder.segments.length > 0 && isPositiveFinite(tool.lengthBelowHolder)) {
    offsets.push(tool.lengthBelowHolder)
  }
  return offsets.length > 0 ? Math.min(...offsets) : undefined
}

/** A one-column stand-in. checkHolderAndShankClearance never touches the stock
 *  when it is handed no moves, but it does require one; this keeps the
 *  status-only call (holder profile / stickout / shank profile) free. */
function statusOnlyStock(block: ToolpathStockBlock) {
  const widest = Math.max(block.max.x - block.min.x, block.max.y - block.min.y)
  return createStockState(
    {
      minX: block.min.x, minY: block.min.y, minZ: block.min.z,
      maxX: block.max.x, maxY: block.max.y, maxZ: block.max.z,
    },
    widest,
    1,
  )
}

function isUsableBlock(block: ToolpathStockBlock | undefined): block is ToolpathStockBlock {
  if (!block) return false
  const values = [block.min.x, block.min.y, block.min.z, block.max.x, block.max.y, block.max.z]
  if (!values.every((value) => Number.isFinite(value))) return false
  return block.max.x > block.min.x && block.max.y > block.min.y && block.max.z > block.min.z
}

/** XY window the grid has to cover: everywhere a component footprint can reach,
 *  clipped to the block. Arc moves bulge past their endpoints, so an arc is
 *  bounded by its centre plus its radius. Null means the path never passes over
 *  the block at all. */
function gridWindow(
  block: ToolpathStockBlock,
  moves: readonly ToolpathMove[],
  reachMm: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const move of moves) {
    if (!Number.isFinite(move.x) || !Number.isFinite(move.y)) continue
    let x0 = move.x
    let x1 = move.x
    let y0 = move.y
    let y1 = move.y
    if ((move.type === 'arc_cw' || move.type === 'arc_ccw') &&
        Number.isFinite(move.cx) && Number.isFinite(move.cy)) {
      const radius = Math.hypot(move.x - (move.cx as number), move.y - (move.cy as number))
      x0 = (move.cx as number) - radius
      x1 = (move.cx as number) + radius
      y0 = (move.cy as number) - radius
      y1 = (move.cy as number) + radius
    }
    minX = Math.min(minX, x0)
    maxX = Math.max(maxX, x1)
    minY = Math.min(minY, y0)
    maxY = Math.max(maxY, y1)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null

  const windowMinX = Math.max(block.min.x, minX - reachMm)
  const windowMaxX = Math.min(block.max.x, maxX + reachMm)
  const windowMinY = Math.max(block.min.y, minY - reachMm)
  const windowMaxY = Math.min(block.max.y, maxY + reachMm)
  if (!(windowMaxX > windowMinX) || !(windowMaxY > windowMinY)) return null
  return { minX: windowMinX, minY: windowMinY, maxX: windowMaxX, maxY: windowMaxY }
}

/** The check's own warnings are whole sentences; they read as one clause here. */
function asClause(reason: string): string {
  return reason.charAt(0).toLowerCase() + reason.slice(1)
}

function notChecked(
  operation: string,
  reasons: readonly string[],
  report?: HolderClearanceReport,
): HolderClearanceGateResult {
  const listed = reasons.length > 0 ? reasons.map(asClause).join(' ') : 'the inputs it needs are missing.'
  return {
    status: 'not-checked',
    message:
      `${operation}: holder crash check did not run - ${listed} ` +
      'This operation has not been proved clear of the holder or the shank.',
    ...(report ? { report } : {}),
  }
}

const COMPONENT_NAMES: Record<ClearanceComponent, string> = {
  holder: 'holder',
  neck: 'neck',
  shank: 'shank',
}

function componentPhrase(components: readonly ClearanceComponent[]): string {
  const names = components.map((component) => `the ${COMPONENT_NAMES[component]}`)
  if (names.length <= 1) return names[0] ?? 'the tool assembly'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Turn a report with collisions into the refusal a machinist can act on: which
 * component touched, at which move, and the change that fixes it (WO-081: a
 * refusal carries its action, it does not name a button).
 */
function collisionMessage(
  operation: string,
  report: HolderClearanceReport,
  tool: Tool,
  block: ToolpathStockBlock,
  moveCount: number,
): string {
  const first = report.collisions[0]
  const hit = new Set<ClearanceComponent>()
  let deepestZ = Number.POSITIVE_INFINITY
  for (const collision of report.collisions) {
    for (const component of collision.components) hit.add(component)
    if (collision.move.z < deepestZ) deepestZ = collision.move.z
  }
  const hitComponents = [...hit].sort()
  const depthBelowTop = block.max.z - deepestZ

  const fixes: string[] = []
  if (hitComponents.includes('holder') && isPositiveFinite(tool.lengthBelowHolder)) {
    fixes.push(
      `set the tool's stickout below the holder past ${mm(depthBelowTop)} mm ` +
      `(it is ${mm(tool.lengthBelowHolder)} mm now) or fit a shorter holder`,
    )
  }
  if (hitComponents.includes('shank') && isPositiveFinite(tool.fluteLength)) {
    fixes.push(
      `use a tool whose flutes run past ${mm(depthBelowTop)} mm ` +
      `(they are ${mm(tool.fluteLength)} mm now)`,
    )
  }
  const neck = toolNeckBand(tool)
  if (hitComponents.includes('neck') && neck) {
    fixes.push(
      `use a tool whose neck starts more than ${mm(depthBelowTop)} mm above its tip ` +
      `(it starts ${mm(neck.bottomMm)} mm up now)`,
    )
  }
  const reachLimits = [
    hitComponents.includes('holder') ? tool.lengthBelowHolder : undefined,
    hitComponents.includes('shank') ? (neck ? neck.topMm : tool.fluteLength) : undefined,
    hitComponents.includes('neck') ? neck?.bottomMm : undefined,
  ].filter(isPositiveFinite)
  if (reachLimits.length > 0) {
    fixes.push(`keep this pass within ${mm(Math.min(...reachLimits))} mm of the top of the stock`)
  }

  return (
    `${operation}: ${componentPhrase(hitComponents)} would hit the stock. ` +
    `Move ${first.moveIndex + 1} of ${moveCount} (X ${mm(first.move.x)} Y ${mm(first.move.y)} ` +
    `Z ${mm(first.move.z)}) drives ${componentPhrase(first.components)} into the block; ` +
    `${report.collisions.length} of ${moveCount} moves collide, the deepest ` +
    `${mm(depthBelowTop)} mm below the top of the stock. ` +
    (fixes.length > 0 ? `Fix it on the machine: ${fixes.join(', or ')}. ` : '') +
    'Checked against the stock block as loaded - this check knows the block, ' +
    'not the machined shape, so it cannot know what an earlier operation already cut away.'
  )
}

/**
 * Prove a computed toolpath clear of the holder and shank, or refuse it by
 * name. Called once per computed toolpath in toolpathWorker.ts.
 */
export function checkHolderClearanceForToolpath({
  operation,
  moves,
  tool,
  holder,
  stockBlock,
}: HolderClearanceGateInput): HolderClearanceGateResult {
  // No moves: there is nothing that could hit anything. Not a silent pass -
  // there is genuinely no toolpath to judge.
  if (moves.length === 0) return { status: 'clear' }

  if (!isUsableBlock(stockBlock)) {
    return notChecked(operation, [
      stockBlock
        ? 'the stock block bounds are not usable (they must be finite with a positive size on every axis).'
        : 'this setup has no resolvable stock block to check against.',
    ])
  }

  // Statuses and warnings come from the real check, never from a guess here.
  // Asking it with no moves costs nothing and keeps one source of truth for
  // what "checked" means. WO-1626: an undefined holder or stickout carries no
  // warning (it is the operator's choice, not ours to report) - only a genuine
  // problem (an invalid holder segment, an invalid shank profile) does, so a
  // non-empty warning list is exactly the signal that the check could not run
  // for a reason nobody chose.
  const statusReport = checkHolderAndShankClearance({
    stock: statusOnlyStock(stockBlock),
    moves: [],
    tool,
    holder,
  })
  if (statusReport.warnings.length > 0) {
    return notChecked(operation, statusReport.warnings, statusReport)
  }

  // Reach pre-check. The block is uniform, so if the LOWEST component the check
  // could query never gets below the block top, nothing can touch it - proved in
  // one pass over the moves instead of a z-dexel query per move. Iterated, not
  // spread into Math.min: a real toolpath runs to six figures of moves and a
  // spread of that many arguments overflows the stack.
  const lowestOffset = lowestComponentOffsetMm(tool, holder)
  let lowestTipZ = Number.POSITIVE_INFINITY
  for (const move of moves) {
    if (!Number.isFinite(move.x) || !Number.isFinite(move.y) || !Number.isFinite(move.z)) {
      // The clearance query fails loud on a non-finite coordinate. A defective
      // move is not this guard's verdict to give: say the check did not run.
      return notChecked(operation, ['the computed path carries a non-finite coordinate.'], statusReport)
    }
    if (move.z < lowestTipZ) lowestTipZ = move.z
  }
  if (lowestOffset !== undefined && Number.isFinite(lowestTipZ)) {
    const lowestAssemblyZ = lowestTipZ + lowestOffset
    const margin = REACH_MARGIN_MM +
      REACH_MARGIN_RELATIVE * Math.max(Math.abs(lowestAssemblyZ), Math.abs(stockBlock.max.z))
    if (lowestAssemblyZ - stockBlock.max.z >= margin) {
      // No warnings survived the check above, so there is nothing left to say:
      // either every component that has data is proved clear, or a component
      // has none because the operator never defined it.
      return { status: 'clear', report: statusReport }
    }
  }

  const smallestRadius = smallestComponentRadiusMm(tool, holder)
  if (smallestRadius === undefined) {
    return notChecked(
      operation,
      ['the tool and holder carry no usable shank or holder diameter.'],
      statusReport,
    )
  }

  const window = gridWindow(stockBlock, moves, largestComponentRadiusMm(tool, holder))
  if (!window) {
    // The whole path is clear of the block in XY: no column of material can be
    // under any component.
    return { status: 'clear', report: statusReport }
  }

  const stock = createStockState(
    {
      minX: window.minX, minY: window.minY, minZ: stockBlock.min.z,
      maxX: window.maxX, maxY: window.maxY, maxZ: stockBlock.max.z,
    },
    CELL_FRACTION_OF_SMALLEST_RADIUS * smallestRadius,
    MAX_STOCK_COLUMNS,
  )
  if (stock.resolutionMm > smallestRadius) {
    // Coarsened past the point where a footprint is guaranteed to cover a
    // column centre. Say so rather than report a clearance the grid cannot
    // support.
    return notChecked(operation, [
      `the machined area (${mm(window.maxX - window.minX)} x ${mm(window.maxY - window.minY)} mm) ` +
      `is too large to check at the ${mm(smallestRadius)} mm resolution this tool and holder need.`,
    ], statusReport)
  }

  const report = checkHolderAndShankClearance({ stock, moves, tool, holder })
  if (report.collisions.length > 0) {
    return {
      status: 'collision',
      message: collisionMessage(operation, report, tool, stockBlock, moves.length),
      report,
    }
  }
  // report.warnings is the same list statusReport.warnings already was (a
  // holder or a shank's validity depends only on the tool and the holder, not
  // on the moves), so it is empty here too: nothing found, nothing to say.
  return { status: 'clear', report }
}

// ── WO-1565: trim the path to the tool's reach ───────────────────────────────

/** Default clearance kept between the neck, shank or holder and the part or the
 *  remaining stock when the operation does not set one. */
// Operator 2026-09-15: "We want to set the default minimum clearance to 0.25mm, A good rule of thumb for
// relieved shank endmills is 0.25mm to 0.5mm based on my research."
export const DEFAULT_CLEARANCE_ALLOWANCE_MM = 0.25

/**
 * WO-1566. The operation types that show the "Shank clearance" field.
 *
 * WO-1678: this is a list of where the FIELD shows, not of what is trimmed.
 * Every operation - these and the 3D strategies alike - is trimmed to the tool's
 * reach at one seam (the 2D worker, and the store's trimToToolReachInPartFrame
 * for the 3D strategies), and an operation that does not show the field is
 * trimmed at the default clearance, which `clearanceAllowanceMmOf` reads.
 */
export const CLEARANCE_TRIM_OP_TYPES: ReadonlySet<string> = new Set([
  'contour_2d', 'pocket_2d', 'adaptive_clearing_2d', 'drill', 'bore',
  'chamfer', 'face', 'engrave', 'vcarve', 'thread_mill',
])

/**
 * WO-1566. Read the operator's shank clearance off an operation's params.
 * Structural, like the compute seam that consumes it: the dialog and the
 * Properties panel persist `params.clearanceAllowanceMm` (a plain number,
 * mm); the worker payload carries it as `clearanceAllowanceMm`. Absent (an
 * operation authored before this field existed) or invalid reads as the
 * default - the same rule `trimToolpathToToolReach` applies below, kept here
 * so the UI and the gate never disagree about what an unset operation means.
 */
export function clearanceAllowanceMmOf(params: unknown): number {
  const value = (params as { clearanceAllowanceMm?: unknown } | undefined)?.clearanceAllowanceMm
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_CLEARANCE_ALLOWANCE_MM
}

/**
 * What a toolpath request carries so the worker can keep the non-cutting tool
 * assembly clear of the part and the remaining stock. Read structurally from the
 * payload. WO-1571: a request carrying the part OR the clearance is trimmed -
 * the store sends the clearance on every request, so a 2D job with no model
 * body is trimmed against the stock. A request carrying neither (a hand-built
 * payload) keeps the stock-as-loaded refusal check above, unchanged.
 */
export interface ToolReachInputs {
  /** Operation-resolved plunge rate for an inserted reach-trim re-entry. */
  readonly plungeRate?: number
  /** The part as a triangle mesh, in the SAME frame as the moves. */
  readonly clearancePart?: ClearanceMesh
  /** Material left by earlier operations, in the SAME frame as the moves. Absent
   *  = the stock as loaded is used, and the console says so. */
  readonly remainingStock?: StockState
  /** WO-1625: true when nothing precedes this operation in its setup, so the
   *  stock as loaded IS the remaining stock - not a stand-in for it, and the
   *  console does not caveat it as one. Absent/false keeps today's caveat. */
  readonly noEarlierOperations?: boolean
  /** Operator-set clearance, mm. Absent or invalid = DEFAULT_CLEARANCE_ALLOWANCE_MM. */
  readonly clearanceAllowanceMm?: number
  /** WO-1575. Vises, jaws and clamps, one triangle mesh each, in the SAME frame as
   *  the moves. Nothing of the tool - cutter included - comes within the allowance. */
  readonly workholding?: readonly ClearanceMesh[]
  /** WO-1678. The surface tolerance the strategy was asked to hold against the
   *  part, mm. A 3D finish follows the part to this tolerance by design, so the
   *  cutter's contact with the part is judged to it rather than to the finer
   *  default; absent = the default. */
  readonly partToleranceMm?: number
  /** WO-1683. The WCS the moves are relative to (e.g. 'G54'), so a stop's
   *  position can name its frame (formatPosition). Absent when the caller does
   *  not carry one (the 2D worker's request payload may not) - the stop is
   *  then said without a frame rather than guessing one. */
  readonly wcsLabel?: string
}

export type { ClearanceMesh }

/**
 * WO-1575. Whether a request is trimmed to the tool's reach rather than taking the
 * stock-as-loaded refusal: it carries the part, the clearance, or workholding.
 * The one rule the 2D worker and the 3D operations both apply.
 */
export function wantsToolReachTrim(inputs: ToolReachInputs): boolean {
  return inputs.clearancePart !== undefined ||
    inputs.clearanceAllowanceMm !== undefined ||
    (inputs.workholding?.length ?? 0) > 0
}

export interface ToolReachGateInput extends HolderClearanceGateInput, ToolReachInputs {}

/**
 * WO-1683: the fact a reach-trimmed operation carries on itself (its tree row
 * and its own panel) - never only in the console. `reachedZ` and `askedZ` are
 * the deepest Z the trimmed path actually reaches and the deepest Z the
 * untrimmed strategy output asked for, in the moves' own frame; `uncutMm` is
 * the total cutting path length every stop of this generation left uncut.
 */
export interface OperationReachShortfall {
  readonly reachedZ: number
  readonly askedZ: number
  readonly uncutMm: number
}

export interface ToolReachGateResult {
  readonly moves: readonly ToolpathMove[]
  /** Plain sentences for the app console: one summary line per generate when
   *  something stopped, and every limit of the check that shaped a stop (an
   *  unreadable part is always said). */
  readonly notices: readonly string[]
  readonly stops: readonly ReachStop[]
  readonly allowanceMm: number
  /** WO-1571: limits of a check that stopped nothing, for the developer console. */
  readonly uncheckedLimits: readonly string[]
  /** WO-1683: absent when nothing was trimmed. */
  readonly shortfall?: OperationReachShortfall
}

function isUsableStockState(stock: StockState | undefined): stock is StockState {
  if (!stock || !(stock.resolutionMm > 0) || !(stock.nx > 0) || !(stock.ny > 0)) return false
  if (!stock.topZ || stock.topZ.length !== stock.nx * stock.ny) return false
  const { minX, minY, maxX, maxY } = stock.bounds
  return [minX, minY, maxX, maxY, stock.bottomZ].every((value) => Number.isFinite(value))
}

// holderClearance.ts's default part column pitch. The cutter-to-part check lets
// the cutter's side come sqrt(1/2) x the pitch into a column before it calls it
// a cut (and its bottom sqrt(2) x the pitch), so a strategy that holds the part
// to a tolerance t is judged to t by a pitch of t x sqrt(2).
const DEFAULT_PART_CELL_MM = 0.05

function partCellMm(partToleranceMm: number | undefined): number {
  if (partToleranceMm === undefined || !Number.isFinite(partToleranceMm) || partToleranceMm <= 0) {
    return DEFAULT_PART_CELL_MM
  }
  return Math.max(DEFAULT_PART_CELL_MM, partToleranceMm * Math.SQRT2)
}

/** WO-1683: a stop's position, framed through the one formatter (positionFrames.ts)
 *  when the caller knows the WCS the moves are relative to; said without a frame
 *  (never a guessed one) when it does not. */
function place(point: { x: number; y: number; z: number }, wcsLabel: string | undefined): string {
  if (wcsLabel === undefined) return `X ${point.x.toFixed(2)} Y ${point.y.toFixed(2)} Z ${point.z.toFixed(2)}`
  return formatPosition({ wcs: wcsLabel, work: point, withMachine: false })
}

/**
 * WO-1566: the stop notice names the allowance the operator SET. Two decimals
 * turned a set 0.125 into "0.13". Six decimals prints every value the fields
 * can store exactly (an inch-typed draft resolves to at most 5 mm decimals)
 * while still trimming float noise like 0.25400000000000005. Trailing zeros
 * strip, so 0.5 reads "0.5".
 */
function formatAllowanceMm(allowanceMm: number): string {
  return String(Number(allowanceMm.toFixed(6)))
}

/** The deepest Z among the CUTTING moves (never a rapid) of a path; undefined
 *  when the path carries no cutting move with a finite Z. */
function deepestCutZ(moves: readonly ToolpathMove[]): number | undefined {
  let deepest = Number.POSITIVE_INFINITY
  for (const move of moves) {
    if (move.type === 'rapid' || !Number.isFinite(move.z)) continue
    if (move.z < deepest) deepest = move.z
  }
  return Number.isFinite(deepest) ? deepest : undefined
}

/**
 * WO-1683: reduce every stop of one generate to the ONE fact the operation
 * carries on itself - how far it actually got against what it was asked for,
 * and how much cutting path that left uncut in total.
 */
function reachShortfallOf(
  untrimmedMoves: readonly ToolpathMove[],
  trimmedMoves: readonly ToolpathMove[],
  stops: readonly ReachStop[],
): OperationReachShortfall | undefined {
  if (stops.length === 0) return undefined
  const askedZ = deepestCutZ(untrimmedMoves)
  const reachedZ = deepestCutZ(trimmedMoves)
  if (askedZ === undefined || reachedZ === undefined) return undefined
  const uncutMm = stops.reduce((sum, stop) => sum + stop.uncutMm, 0)
  return { reachedZ, askedZ, uncutMm }
}

/**
 * WO-1683: every stop of one generate, said as ONE console line (not one per
 * stop) - the first stop's position and reason, the total shortfall against
 * what was asked, the remedy. Every position names its frame when the caller
 * supplied one.
 */
function stoppedShortSummary(
  operation: string,
  stops: readonly ReachStop[],
  shortfall: OperationReachShortfall,
  allowanceMm: number,
  stockLabel: string,
  wcsLabel: string | undefined,
): string {
  const first = stops[0]
  const fixture = first.blocker.obstacle === 'workholding'
  const obstacle = fixture
    ? 'the workholding'
    : first.blocker.obstacle === 'part'
      ? 'the part'
      : stockLabel
  const reason = first.blocker.component === 'cutter' && !fixture
    ? 'the cutter would cut into the part above or beside this cut'
    : `the ${first.blocker.component} would come within ${formatAllowanceMm(allowanceMm)} mm of ${obstacle}`
  const where = first.stoppedAt
    ? `cut stopped at ${place(first.stoppedAt, wcsLabel)}`
    : 'the path could not be started where it begins'
  const rest = first.resumedAt
    ? `up to ${place(first.resumedAt, wcsLabel)}, where it picks up again`
    : 'to the end of the path'
  const remedy = fixture
    ? 'a setup that holds the part clear of this spot cuts the rest'
    : first.blocker.component === 'cutter'
      ? 'a cutter that fits beside the part cuts the rest'
      : 'a tool with a longer reach cuts the rest'
  const stopCount = stops.length > 1 ? ` (${stops.length} stops)` : ''
  return (
    `${operation}: ${where} - ${reason}${stopCount}. ${shortfall.uncutMm.toFixed(1)} mm of cutting path ` +
    `was left uncut, ${rest}; reached Z ${positionNumber(shortfall.reachedZ)} of Z ` +
    `${positionNumber(shortfall.askedZ)} asked; ${remedy}.`
  )
}

/**
 * WO-1565. Trim a computed toolpath to what the tool assembly reaches: the
 * cutting head may work under an overhang, the neck, shank and holder never come
 * within the allowance of the part or the remaining stock. Nothing is refused;
 * every stop is said in words.
 */
export function trimToolpathToToolReach(input: ToolReachGateInput): ToolReachGateResult {
  const { operation, moves, tool, holder, stockBlock } = input
  const requested = input.clearanceAllowanceMm
  const allowanceMm = requested !== undefined && Number.isFinite(requested) && requested >= 0
    ? requested
    : DEFAULT_CLEARANCE_ALLOWANCE_MM
  const notices: string[] = []
  const caveats: string[] = []
  if (moves.length === 0) return { moves, notices, stops: [], allowanceMm, uncheckedLimits: [] }

  const part = input.clearancePart ? buildSolidColumns(input.clearancePart, partCellMm(input.partToleranceMm)) : null
  if (input.clearancePart && !part) {
    notices.push(`${operation}: the part shape could not be read, so the tool was kept clear of the stock only.`)
  }
  const workholding: SolidColumns[] = []
  for (const mesh of input.workholding ?? []) {
    const columns = buildSolidColumns(mesh)
    if (columns) workholding.push(columns)
    else notices.push(`${operation}: a workholding shape could not be read, so the tool was not kept clear of it.`)
  }

  let stock: StockState | undefined
  let stockLabel = 'the remaining stock'
  if (isUsableStockState(input.remainingStock)) {
    stock = input.remainingStock
  } else if (isUsableBlock(stockBlock)) {
    const reach = largestComponentRadiusMm(tool, holder) + allowanceMm
    const window = gridWindow(stockBlock, moves, reach)
    const smallest = smallestComponentRadiusMm(tool, holder)
    if (window && smallest !== undefined) {
      stock = createStockState(
        {
          minX: window.minX, minY: window.minY, minZ: stockBlock.min.z,
          maxX: window.maxX, maxY: window.maxY, maxZ: stockBlock.max.z,
        },
        CELL_FRACTION_OF_SMALLEST_RADIUS * smallest,
        MAX_STOCK_COLUMNS,
      )
    }
    if (input.noEarlierOperations) {
      // WO-1625: nothing precedes this operation in its setup, so the stock as
      // loaded IS the remaining stock - there is nothing to caveat.
      stockLabel = 'the stock'
    } else {
      stockLabel = 'the stock as loaded'
      caveats.push(
        `${operation}: the tool was kept clear of the stock as loaded - this operation was not told what ` +
        'earlier operations removed, so it may stop short of material that is already gone.',
      )
    }
  } else if (part) {
    caveats.push(`${operation}: no stock was known, so the tool was kept clear of the part only.`)
  } else if (workholding.length > 0) {
    caveats.push(`${operation}: neither the part nor the stock was known, so the tool was kept clear of the workholding only.`)
  } else {
    caveats.push(`${operation}: neither the part nor the stock was known, so the tool reach was not checked.`)
  }

  const result = trimToolpathToAssemblyReach({
    moves, tool, holder, part, stock, workholding, allowanceMm, plungeRate: input.plungeRate,
  })
  for (const warning of result.warnings) caveats.push(`${operation}: ${asClause(warning)}`)
  const shortfall = reachShortfallOf(moves, result.moves, result.stops)
  // WO-1571: every operation in the app now takes this path, so a caveat is said
  // on the app console only beside the stop it qualifies. A path nothing stopped
  // leaves the console quiet and hands its caveats to the developer console.
  // WO-1683: every stop of this generate is ONE console line, not one per stop.
  const stopSummary = shortfall
    ? [stoppedShortSummary(operation, result.stops, shortfall, allowanceMm, stockLabel, input.wcsLabel)]
    : []
  if (stopSummary.length > 0) notices.push(...caveats, ...stopSummary)
  return {
    moves: result.moves,
    notices,
    stops: result.stops,
    allowanceMm,
    uncheckedLimits: stopSummary.length > 0 ? [] : caveats,
    ...(shortfall ? { shortfall } : {}),
  }
}

/**
 * WO-1575. The 3D operations' spelling of trimToolpathToToolReach: the same trim,
 * the same words, with the block as loaded given as a cam3d box (flat
 * minX..maxZ, in the part's display-local frame the moves live in).
 */
export function trimToolpathToToolReachFor3d(
  input: HolderClearanceGate3dInput & ToolReachInputs,
): ToolReachGateResult {
  const { stockBounds, ...rest } = input
  return trimToolpathToToolReach({
    ...rest,
    ...(stockBounds !== undefined
      ? {
          stockBlock: {
            min: { x: stockBounds.minX, y: stockBounds.minY, z: stockBounds.minZ },
            max: { x: stockBounds.maxX, y: stockBounds.maxY, z: stockBounds.maxZ },
          },
        }
      : {}),
  })
}
