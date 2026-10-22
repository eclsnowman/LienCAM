// WO-3032 (alpha.3 A3-10b, parity): replay, the material service's source of
// truth. The stock block with the cutting moves of every enabled, ready earlier
// operation swept out of it, in setup order - today's store remainingStockBefore
// (src/store/toolReachInputs.ts) on the kernel field:
//   - a solid DexelField of the block at the replay cell and budget (today 0.2 mm,
//     1 000 000 columns; PARITY_REPLAY);
//   - each operation's persisted moves walked as linear sweeps (today's
//     toolpathMovesToLinearSweeps: every move advances the cursor, only
//     stock-cutting roles sweep, arcs walked along the arc at sagitta cell / 4);
//   - swept with the replay cutter today's stockCutterOf picks per tool type
//     (PARITY_REPLAY_CUTTER: a bull nose replays as a ball, a drill as a flat
//     lifted by its point length, anything else is not replayed);
//   - an operation whose result cannot be read contributes nothing and is
//     reported in one line, never the reason a query fails.
// Flat and ball sweeps are byte-equal to removeSweep (WO-3017), so the replayed
// columns equal today's StockState topZ byte for byte.
import type { Tool, ToolpathMove } from '../../types'
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'
import type { LinearMove, SweepShape } from './contracts'
import { DexelField, type Box3 } from './dexel'
import { PARITY_POLICY, PARITY_REPLAY_CUTTER, type MaterialPolicy } from './policy'
import { sweepMove } from './sweep'

/** Today's replay grid and arc walk, with their sources. */
export const PARITY_REPLAY = Object.freeze({
  cellMm: 0.2,
  budget: 1_000_000,
  /** Arcs are walked as chords whose sagitta stays within cell x this. */
  sagittaCells: 0.25,
  source: Object.freeze(['src/store/toolReachInputs.ts:169', 'src/store/toolReachInputs.ts:170', 'src/store/toolReachInputs.ts:278']),
})

/** One operation of the setup chain, as the store holds it (today's PrecedingOperationResult + identity). */
export interface MaterialOperation {
  readonly id: string
  /** Operation type (adaptive_3d, parallel_3d, pocket_2d, ...). */
  readonly type: string
  readonly enabled: boolean
  readonly status: string
  readonly tool: Tool | undefined
  readonly moves: readonly ToolpathMove[] | undefined
  /**
   * Drills only: tip-to-full-diameter length, supplied by the caller as today's
   * drillPointCompensationMm gives it. Absent: the kernel computes it the same way.
   */
  readonly pointLengthMm?: number
  /** MD-53 only (profile_replay ON): the tool's own sweep shape from the one tool-shape source. */
  readonly sweepShape?: SweepShape
}

/** The cutter one operation replays as, and how far its flat sits above the tip. */
export interface ReplayCutter {
  readonly shape: SweepShape
  readonly liftMm: number
  /** Stable text identity of the cutter (part of the chain fingerprint). */
  readonly key: string
}

/** Today's drillPointCompensationMm; undefined where today's throws (the hole is then not counted). */
export function drillPointLengthMm(tool: Tool): number | undefined {
  if (tool.angleFromAxisDeg === 90) return 0
  if (tool.type !== 'drill' && tool.type !== 'spot_drill' && tool.type !== 'center_drill') return 0
  const diameter = tool.diameter
  const tipDiameter = tool.tipDiameter ?? 0
  const angle = tool.angleFromAxisDeg ?? 59
  if (![diameter, tipDiameter, angle].every(Number.isFinite)) return undefined
  if (diameter <= 0 || tipDiameter < 0 || tipDiameter >= diameter || angle <= 0 || angle >= 90) return undefined
  return ((diameter - tipDiameter) / 2) / Math.tan(angle * Math.PI / 180)
}

/**
 * The replay cutter for one operation's tool: today's stockCutterOf under the
 * parity policy. Undefined when the field does not follow the tool (nothing is
 * taken out for it, so the remaining stock is never under-stated).
 */
export function replayCutterFor(operation: Pick<MaterialOperation, 'tool' | 'pointLengthMm' | 'sweepShape'>,
  policy: MaterialPolicy = PARITY_POLICY): ReplayCutter | undefined {
  const tool = operation.tool
  if (!tool || !(tool.diameter > 0) || !Number.isFinite(tool.diameter)) return undefined
  if (policy.profile_replay && operation.sweepShape) {
    return { shape: operation.sweepShape, liftMm: 0, key: `profile:${JSON.stringify(operation.sweepShape)}` }
  }
  const entry = PARITY_REPLAY_CUTTER[tool.type]
  if (!entry) return undefined
  let liftMm = 0
  if (entry.lift === 'drill point length') {
    const lift = operation.pointLengthMm ?? drillPointLengthMm(tool)
    if (lift === undefined || !Number.isFinite(lift)) return undefined
    liftMm = lift
  }
  const radius = tool.diameter / 2
  return { shape: { kind: entry.kind, radius }, liftMm, key: `${entry.kind}:${tool.diameter}:${liftMm}` }
}

interface Tip { x: number; y: number; z: number }

/** Today's forEachLinearSweep for a persisted arc (absolute centre), chords within the sagitta. */
function arcSweeps(from: Tip, move: ToolpathMove, maxSagitta: number, visit: (sweep: LinearMove) => void): void {
  const cx = move.cx!
  const cy = move.cy!
  const r = Math.hypot(from.x - cx, from.y - cy)
  const a0 = Math.atan2(from.y - cy, from.x - cx)
  let sweepAngle = Math.atan2(move.y - cy, move.x - cx) - a0
  if (move.type === 'arc_cw') {
    while (sweepAngle >= 0) sweepAngle -= 2 * Math.PI
  } else {
    while (sweepAngle <= 0) sweepAngle += 2 * Math.PI
  }
  const sagitta = Math.max(maxSagitta, 1e-4)
  const chord = r > sagitta ? 2 * Math.sqrt(2 * r * sagitta - sagitta * sagitta) : Number.POSITIVE_INFINITY
  const steps = Math.max(1, Math.ceil((Math.abs(sweepAngle) * r) / chord))
  let px = from.x
  let py = from.y
  let pz = from.z
  for (let k = 1; k <= steps; k++) {
    const t = k / steps
    const x = k === steps ? move.x : cx + r * Math.cos(a0 + sweepAngle * t)
    const y = k === steps ? move.y : cy + r * Math.sin(a0 + sweepAngle * t)
    const z = from.z + (move.z - from.z) * t
    visit({ x0: px, y0: py, z0: pz, x1: x, y1: y, z1: z })
    px = x
    py = y
    pz = z
  }
}

/**
 * The linear sweeps one move travels from `from`: a line is one sweep, an arc
 * is walked along the arc (today's forEachLinearSweep). Throws on an arc with
 * no absolute centre, as today's replay does.
 */
export function moveSweeps(from: Tip, move: ToolpathMove, maxSagitta: number, visit: (sweep: LinearMove) => void): void {
  if (move.type === 'arc_cw' || move.type === 'arc_ccw') {
    if (move.cx === undefined || move.cy === undefined) {
      throw new Error('stock replay: arc move is missing its absolute cx/cy centre.')
    }
    arcSweeps(from, move, maxSagitta, visit)
    return
  }
  visit({ x0: from.x, y0: from.y, z0: from.z, x1: move.x, y1: move.y, z1: move.z })
}

/** Today's toolpathMovesToLinearSweeps: every move advances the cursor, only stock-cutting roles sweep. */
export function cuttingSweeps(moves: readonly ToolpathMove[], maxSagitta: number): LinearMove[] {
  const sweeps: LinearMove[] = []
  let tip: Tip | undefined
  for (const move of moves) {
    const role = effectiveMoveRole(move)
    if (tip !== undefined && isStockCuttingRole(role)) moveSweeps(tip, move, maxSagitta, sweep => sweeps.push(sweep))
    tip = { x: move.x, y: move.y, z: move.z }
  }
  return sweeps
}

/** Why an operation contributed nothing to the replay, or undefined when it was replayed. */
export function notReplayedReason(operation: MaterialOperation, policy: MaterialPolicy = PARITY_POLICY): string | undefined {
  if (!operation.enabled) return 'disabled'
  if (operation.status !== 'ready') return `not computed (status ${operation.status}): treated as not cut`
  if (!operation.moves || operation.moves.length === 0) return 'no moves: treated as not cut'
  if (!replayCutterFor(operation, policy)) return `tool ${operation.tool?.type ?? 'missing'} is not replayed: its material is left in`
  return undefined
}

/**
 * Sweep one operation out of `field` in place. Returns false (field untouched)
 * when the operation contributes nothing or its result cannot be read.
 */
export function replayOperationInto(field: DexelField, operation: MaterialOperation,
  policy: MaterialPolicy = PARITY_POLICY): { replayed: boolean; note?: string } {
  const why = notReplayedReason(operation, policy)
  if (why) return { replayed: false, note: `${operation.id}: ${why}` }
  const cutter = replayCutterFor(operation, policy)!
  let sweeps: LinearMove[]
  try {
    sweeps = cuttingSweeps(operation.moves!, field.cell * PARITY_REPLAY.sagittaCells)
  } catch (err) {
    return { replayed: false, note: `${operation.id}: result could not be read (${err instanceof Error ? err.message : String(err)}): treated as not cut` }
  }
  const work = field.clone()
  try {
    for (const sweep of sweeps) {
      const lifted = cutter.liftMm > 0 ? { ...sweep, z0: sweep.z0 + cutter.liftMm, z1: sweep.z1 + cutter.liftMm } : sweep
      sweepMove(work, lifted, cutter.shape, policy.removed_definition)
    }
  } catch (err) {
    return { replayed: false, note: `${operation.id}: result could not be read (${err instanceof Error ? err.message : String(err)}): treated as not cut` }
  }
  field.top.set(work.top)
  return { replayed: true }
}

/** Replay grid options: today's 0.2 mm / 1 000 000 columns unless the caller's tolerance authority says otherwise. */
export interface ReplayGrid {
  readonly cellMm: number
  readonly budget: number
}

export const PARITY_REPLAY_GRID: ReplayGrid = Object.freeze({ cellMm: PARITY_REPLAY.cellMm, budget: PARITY_REPLAY.budget })

/** The solid stock block on the replay grid. */
export function stockField(stock: Box3, grid: ReplayGrid = PARITY_REPLAY_GRID): DexelField {
  return DexelField.fromBox(stock, grid.cellMm, grid.budget)
}
