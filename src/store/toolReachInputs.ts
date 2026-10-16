import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// WO-1571: what a toolpath request carries so the worker trims the cut to the
// tool's reach (WO-1565) instead of refusing it.
//
// The worker's moves are in the project world frame: loops are world XY and
// every height is resolved to world Z (heights + wcsOrigin.z). The stock block
// is world too. So the part is the operation's model body display tessellation
// baked into world through the ONE placement seam every model-body derive uses
// (resolveModelReferenceFrame) - the same frame the derived profile the moves
// follow was built in, tilted or not, whatever work origin the setup uses.

import type { ImportedGeometry, ModelItemPlacementRecord, Tool, ToolHolder, ToolpathMove, Vec3 } from '../types'
import type { ClearanceMesh } from '../lib/cam/holderClearance'
import {
  clearanceAllowanceMmOf, trimToolpathToToolReachFor3d,
  type HolderClearanceStockBox, type OperationReachShortfall, type ToolReachInputs,
} from '../lib/cam/holderClearanceGate'
import {
  applyStockOperation, createStockState, type StockState, type StockStateCutter,
} from '../lib/cam/stockState'
import { toolpathMovesToLinearSweeps } from '../cam3d/rough/replayStock'
import type { LinearMove } from '../cam3d/stock'
import { drillPointCompensationMm } from '../lib/cam/smartHeights/drillBore'
import { worldBakedMesh } from '../lib/cam/booleanMeshModel'
import { resolveModelReferenceFrame } from '../lib/cam/modelReferenceFrame'
import { isModelOriginGeometry } from '../lib/cam/modelOrigin'

/** Must equal src/doc/documentHolder.ts's LEGACY_MODEL_ITEM_ID (modelOrigin.ts keeps the same copy). */
const LEGACY_MODEL_ITEM_ID = 'legacy'

/** An unreadable part: the gate says "the part shape could not be read" and keeps the tool clear of the stock. */
const UNREADABLE_PART: ClearanceMesh = { positions: [], indices: [] }

export interface ToolReachInputsSource {
  /** The operation's params; `clearanceAllowanceMm` is the Shank clearance field (WO-1566). */
  readonly params: unknown
  /** The geometry the operation computes from, as the store resolved it. */
  readonly geoSources: readonly ImportedGeometry[]
  readonly modelItemPlacements: readonly ModelItemPlacementRecord[] | undefined
  /** WO-1582: what the earlier operations of the setup left (remainingStockBefore). */
  readonly remainingStock?: StockState
  /** WO-1625: true when nothing precedes this operation in its setup - the
   *  stock as loaded IS the remaining stock, not a stand-in for it. */
  readonly noEarlierOperations?: boolean
  /** WO-1683: the setup's WCS label (e.g. 'G54'), so a stop the worker reports
   *  can name its frame. Absent: the stop is said without one. */
  readonly wcsLabel?: string
}

/**
 * Every request the store sends the toolpath worker carries the clearance, so
 * the worker always trims rather than refuses. The part rides along when the
 * operation computes from a model body; a 2D job from DXF or sketch geometry
 * has none and is trimmed against the stock. WO-1582: the remaining stock rides
 * along when an earlier operation of the setup left a result to replay; without
 * one the gate says the stock as loaded was used whenever that shapes a stop.
 */
export function resolveToolReachInputs(source: ToolReachInputsSource): ToolReachInputs {
  const clearanceAllowanceMm = clearanceAllowanceMmOf(source.params)
  const remaining = source.remainingStock ? { remainingStock: source.remainingStock } : {}
  const noEarlier = source.noEarlierOperations ? { noEarlierOperations: true } : {}
  const wcsLabel = source.wcsLabel !== undefined ? { wcsLabel: source.wcsLabel } : {}
  const bodies = source.geoSources.filter(isModelOriginGeometry)
  if (bodies.length === 0) return { clearanceAllowanceMm, ...remaining, ...noEarlier, ...wcsLabel }
  const clearancePart = partMeshInWorld(bodies, source.modelItemPlacements ?? [])
  return { clearanceAllowanceMm, clearancePart, ...remaining, ...noEarlier, ...wcsLabel }
}

// ── WO-1678: the one seam every 3D strategy's moves leave through ───────────
//
// The 2D worker trims every request to the tool's reach (toolpathWorker.ts). The
// 3D strategies compute in their part's display-local frame instead, so their
// moves come back here - every one of them, rough and finish alike, straight
// after the strategy - and are trimmed with the same function, against the same
// three obstacles (the part, what the earlier operations left, the workholding),
// with the same console words. No strategy carries a reach check of its own and
// nothing is refused: what the assembly cannot reach is left uncut and said.
//
// The part is always an obstacle, stock or no stock, exactly as 2D's
// resolveToolReachInputs hands it: a declared stock smaller than the part (or
// off it) must never hide the part from the check.

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
  })
  return {
    moves: [...reach.moves],
    notices: [...reach.notices],
    uncheckedLimits: [...reach.uncheckedLimits],
    trimmed: reach.stops.length > 0,
    ...(reach.shortfall ? { shortfall: reach.shortfall } : {}),
  }
}

// ── WO-1582: the material the earlier operations left ───────────────────────
//
// Every operation's stored moves are world-placed, and so is the stock block,
// so the height field is built straight in the moves' world frame.

/** One earlier operation of the setup, as the store holds it. */
export interface PrecedingOperationResult {
  readonly enabled: boolean
  readonly status: string
  readonly toolpathMoves: readonly ToolpathMove[] | undefined
  readonly tool: Tool | undefined
}

export interface RemainingStock {
  readonly stock: StockState
  /** How many earlier operations' moves were replayed into it (at least one). */
  readonly operationsReplayed: number
}

/** 0.2 mm columns; a stock too big for the budget coarsens and the state records it.
 *  WO-2530: the reach trim keeps the clearance plus 0.7 of a column from what is
 *  left, so a neck inside a pilot hole needs fine columns - at 0.2 mm a 1.2 mm
 *  neck threading M6 in a 5 mm hole (0.4 mm real gap) clears its 0.25 mm allowance. */
const REMAINING_STOCK_CELL_MM = 0.2
const REMAINING_STOCK_MAX_COLUMNS = 1_000_000
const BASE_STOCK_CACHE_SIZE = 4

const baseStocks = new Map<string, StockState>()
/** Per earlier result: the state it was replayed onto, with which cutter, and what came out. */
const replayed = new WeakMap<readonly ToolpathMove[], { before: StockState; cutterKey: string; after: StockState }>()

/**
 * The height-field cutter an earlier operation's tool removes material as.
 * Wherever the field cannot follow the tool the choice leaves material in
 * rather than taking it out: the reach trim may then stop short, never rub.
 * A bull nose replays as a ball of its diameter (it removes at least that).
 * WO-2530: a drill, spot drill or center drill replays as a flat of its
 * diameter lifted by its point length - the hole it leaves is counted down to
 * where it reaches full diameter, and the tip cone below stays solid.
 * Chamfer and V tools, thread mills and the undercut tools (lollipop, dovetail,
 * slitting saw) are not replayed: a pointed side is not a flat or a ball, and
 * a height field cannot hold what an undercut leaves.
 */
export function stockCutterOf(tool: Tool | undefined): ReplayCutter | undefined {
  if (!tool || !(tool.diameter > 0) || !Number.isFinite(tool.diameter)) return undefined
  switch (tool.type) {
    case 'flat_end_mill':
    case 'face_mill':
      return { cutter: { kind: 'flat', diameter: tool.diameter }, liftMm: 0 }
    case 'ball_end_mill':
    case 'bull_nose':
      return { cutter: { kind: 'ball', diameter: tool.diameter }, liftMm: 0 }
    case 'drill':
    case 'spot_drill':
    case 'center_drill': {
      const liftMm = drillPointLengthMm(tool)
      return liftMm === undefined ? undefined : { cutter: { kind: 'flat', diameter: tool.diameter }, liftMm }
    }
    default:
      return undefined
  }
}

/** How far a replayed cutter's flat sits above the moves' tip Z. */
export interface ReplayCutter {
  readonly cutter: StockStateCutter
  readonly liftMm: number
}

/** A drill's tip-to-full-diameter length; a 180 deg (flat) point has none.
 *  Undefined when the tool's point cannot be read: the hole is then not counted. */
function drillPointLengthMm(tool: Tool): number | undefined {
  if (tool.angleFromAxisDeg === 90) return 0
  try {
    return drillPointCompensationMm(tool)
  } catch {
    return undefined
  }
}

/** The sweep with both ends raised: a drill's flat replays where its full diameter is. */
function liftedSweep(move: LinearMove, liftMm: number): LinearMove {
  return { ...move, z0: move.z0 + liftMm, z1: move.z1 + liftMm }
}

function baseStockFor(block: { min: Vec3; max: Vec3 }): StockState {
  const key = [block.min.x, block.min.y, block.min.z, block.max.x, block.max.y, block.max.z].join(',')
  const cached = baseStocks.get(key)
  if (cached) return cached
  const stock = createStockState(
    { minX: block.min.x, minY: block.min.y, minZ: block.min.z, maxX: block.max.x, maxY: block.max.y, maxZ: block.max.z },
    REMAINING_STOCK_CELL_MM,
    REMAINING_STOCK_MAX_COLUMNS,
  )
  if (baseStocks.size >= BASE_STOCK_CACHE_SIZE) {
    const oldest = baseStocks.keys().next()
    if (!oldest.done) baseStocks.delete(oldest.value)
  }
  baseStocks.set(key, stock)
  return stock
}

/**
 * The stock block with the cutting moves of every enabled, generated earlier
 * operation taken out of it, in setup order. Operations with no result,
 * suppressed ones, and tools the field cannot follow contribute nothing;
 * undefined when nothing contributed (the gate then uses the stock as loaded
 * and says so). Each earlier result is replayed once and reused while the state
 * it was replayed onto is unchanged, so a compute costs one replay per NEW
 * earlier result, not one per earlier operation.
 */
export function remainingStockBefore(
  preceding: readonly PrecedingOperationResult[],
  stockBlock: { min: Vec3; max: Vec3 } | undefined,
): RemainingStock | undefined {
  if (!stockBlock) return undefined
  let stock: StockState | undefined
  let operationsReplayed = 0
  for (const operation of preceding) {
    const moves = operation.toolpathMoves
    if (!operation.enabled || operation.status !== 'ready' || !moves || moves.length === 0) continue
    const replay = stockCutterOf(operation.tool)
    if (!replay) continue
    const { cutter, liftMm } = replay
    try {
      const before = stock ?? baseStockFor(stockBlock)
      const cutterKey = `${cutter.kind}:${cutter.diameter}:${liftMm}`
      const cached = replayed.get(moves)
      let after: StockState
      if (cached && cached.before === before && cached.cutterKey === cutterKey) {
        after = cached.after
      } else {
        const sweeps = toolpathMovesToLinearSweeps(moves, before.resolutionMm / 4)
        const lifted = liftMm > 0 ? sweeps.map((move) => liftedSweep(move, liftMm)) : sweeps
        after = applyStockOperation(before, lifted.map((move) => ({ move, cutter })))
        replayed.set(moves, { before, cutterKey, after })
      }
      stock = after
      operationsReplayed++
    } catch (err) {
      // A result the replay cannot read contributes nothing; it is never why a compute fails.
      console.warn(operatorText('toolReachInputs1'), err)
    }
  }
  return stock && operationsReplayed > 0 ? { stock, operationsReplayed } : undefined
}

function partMeshInWorld(
  bodies: readonly ImportedGeometry[],
  placements: readonly ModelItemPlacementRecord[],
): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const body of bodies) {
    const display = body.modelBody?.display
    if (!display || display.positions.length < 9 || display.indices.length < 3) return UNREADABLE_PART
    let mesh
    try {
      const frame = resolveModelReferenceFrame(
        placements, body.modelItemId ?? LEGACY_MODEL_ITEM_ID, body.modelBody?.ref.bodyId,
      )
      mesh = worldBakedMesh(display.positions, display.indices, frame)
    } catch {
      return UNREADABLE_PART
    }
    const base = positions.length / 3
    for (let i = 0; i < mesh.positions.length; i++) positions.push(mesh.positions[i])
    for (let i = 0; i < mesh.indices.length; i++) indices.push(mesh.indices[i] + base)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}
