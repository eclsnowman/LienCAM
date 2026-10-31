import type { Tool, ToolpathMove, Vec3 } from '../../types'
import { readGcodeProgram, type GcodeReaderOptions } from '../../lib/gcode/reader'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles'
import type { StockStateCutter } from '../../lib/cam/stockState'
import { maxTraverseIntrusion, removeSweep, type ZDexelField } from '../../cam3d/stock'
import { replaySagittaFor, toolpathMovesToLinearSweeps } from '../../cam3d/rough/replayStock'
import { TRAVERSE_INTRUSION_TOLERANCE_MM } from '../../cam3d/rough/traverseSafety'
import { stockCutterOf } from '../../store/toolReachInputs'

/**
 * The operator's WO-096 rule is the rapid oracle, not a retract plane: travel below the
 * travel height is fine only where the in-process stock PROVES the corridor is
 * cleared. The stock is the production z-dexel (ZDexelField + removeSweep +
 * maxTraverseIntrusion, as enforceTraverseSafety uses) - never a second model.
 */
export interface StockTraverseInput {
  /** Setup stock in the moves' frame. MUTATED: cutting moves are removed as they
   * pass, so the next operation of the setup sees what this one left. */
  field: ZDexelField
  /** How the tool removes material (production stockCutterOf). Absent: removes
   * nothing, so material is left in and never assumed cut. */
  removal?: { cutter: StockStateCutter; liftMm: number }
  /** Envelope a traverse is judged with, its flat lifted like the removal's. */
  query: { cutter: StockStateCutter; liftMm: number }
  intrusionToleranceMm?: number
  /** The field samples each column at its centre, so material within half a cell
   * diagonal of the tool's edge is below what it can resolve, either way. The
   * query is narrowed by this much (the mirror of traverseSafety's proofMarginMm);
   * a traverse is flagged only for contact the field resolves. Default: cell/sqrt(2). */
  radialResolutionMm?: number
}

/** Removal = the app's remaining-stock replay cutter. Query = a ball for a ball
 * mill, otherwise a flat cylinder of the full diameter, which contains every
 * other tool's body above its tip (bull, V, chamfer, thread mill). A drill's
 * query is lifted like its removal: the point re-enters the cone it left. */
export function stockCheckCutters(tool: Tool): Pick<StockTraverseInput, 'removal' | 'query'> {
  const removal = stockCutterOf(tool)
  const cutter: StockStateCutter = { kind: tool.type === 'ball_end_mill' ? 'ball' : 'flat', diameter: tool.diameter }
  return { ...(removal ? { removal } : {}), query: { cutter, liftMm: removal?.liftMm ?? 0 } }
}

export interface ToolpathPostCheckInput {
  /** Moves and stock must already be in the SAME frame (normally world/mm). */
  moves: readonly ToolpathMove[]
  bottomZ: number
  toleranceMm?: number
  arcToleranceMm?: number
  /** Required: every traverse is judged against this stock in program order. */
  stock: StockTraverseInput
  posted?: {
    gcode: string
    readerOptions: GcodeReaderOptions
    /** Transform the source to the reader's work frame, including arc centres. */
    sourceToWork: (move: ToolpathMove) => ToolpathMove
    /** Optional operation span in the complete program; retains modal context. */
    lineRange?: { startLine: number; endLine: number }
    toleranceMm?: number
  }
}

export interface ToolpathPostIssue {
  check: 'finite' | 'rapid' | 'bottom' | 'arc' | 'post'
  moveIndex?: number
  message: string
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Ordered, directed polyline containment. Run in both directions so dropped
 * corners AND added detours fail. A collinear redundant point may disappear.
 * No nearest-point cloud comparison: returning over an earlier segment must
 * retain its position in the traversal order. */
function follows(points: readonly ToolpathMove[], path: readonly ToolpathMove[], tolerance: number, forbidRapidOverFeed = false): number | undefined {
  if (path.length === 1) {
    const missing = points.findIndex(p => distance(p, path[0]) > tolerance)
    return missing < 0 ? undefined : missing
  }
  let segment = 1
  let progress = 0
  for (let i = 0; i < points.length; i++) {
    let found = false
    while (segment < path.length) {
      const a = path[segment - 1], b = path[segment], p = points[i]
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
      const length2 = dx * dx + dy * dy + dz * dz
      const t = length2 === 0 ? 0 : Math.max(progress, Math.min(1,
        ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / length2))
      const rapidOverFeed = forbidRapidOverFeed && i > 0 && p.type === 'rapid'
        && b.type !== 'rapid' && b.role !== 'rapid'
      if (!rapidOverFeed && distance(p, { x: a.x + t * dx, y: a.y + t * dy, z: a.z + t * dz }) <= tolerance) {
        progress = t
        found = true
        break
      }
      segment++
      progress = 0
    }
    if (!found) return i
  }
  return undefined
}

/** Finite values, below-bottom and arc radius agreement: pure geometry. */
function geometryIssues(moves: readonly ToolpathMove[], bottomZ: number, tolerance: number,
  arcTolerance: number, add: (check: ToolpathPostIssue['check'], message: string, moveIndex?: number) => void): void {
  if (moves.length === 0) add('finite', 'path is empty; no generated motion was checked')
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i], prev = moves[i - 1]
    for (const key of ['x', 'y', 'z', 'a', 'b', 'c', 'feed', 'cx', 'cy', 'engagement', 'dwellMs'] as const) {
      if ((key === 'x' || key === 'y' || key === 'z' || m[key] !== undefined) && !Number.isFinite(m[key])) {
        add('finite', `${key} is not finite`, i)
      }
    }
    if (m.z < bottomZ - tolerance) add('bottom', `Z ${m.z} is below bottom ${bottomZ}`, i)
    if (m.type === 'arc_cw' || m.type === 'arc_ccw') {
      if (!prev || !Number.isFinite(m.cx) || !Number.isFinite(m.cy)) {
        add('arc', 'arc needs a preceding start and finite absolute XY centre', i)
      } else {
        const startRadius = Math.hypot(prev.x - m.cx!, prev.y - m.cy!)
        const endRadius = Math.hypot(m.x - m.cx!, m.y - m.cy!)
        if (startRadius <= tolerance || Math.abs(startRadius - endRadius) > arcTolerance) {
          add('arc', `inconsistent arc radii ${startRadius} / ${endRadius}`, i)
        }
      }
    }
  }
}

/** WO-096 replay, as enforceTraverseSafety walks it: before every traverse (a
 * rapid, or any non-cutting role such as loop_back) ask the stock, in the state
 * it is in AT THAT POINT, whether the swept corridor is clear; replay every
 * cutting move as it passes. A pure vertical LIFT is not asked: with the tip at
 * z the body already occupies everything above z + h(r), so raising it occupies
 * a strict subset of the pose it holds (traverseSafety.ts header). The first
 * move has no known start (the post's framing owns the approach). */
function stockTraverseIssues(moves: readonly ToolpathMove[], stock: StockTraverseInput, tolerance: number,
  add: (check: ToolpathPostIssue['check'], message: string, moveIndex?: number) => void): void {
  const limit = stock.intrusionToleranceMm ?? TRAVERSE_INTRUSION_TOLERANCE_MM
  const sagitta = replaySagittaFor(stock.field)
  const margin = stock.radialResolutionMm ?? stock.field.cell * Math.SQRT1_2
  const lift = stock.query.liftMm
  const query: StockStateCutter = { ...stock.query.cutter, diameter: stock.query.cutter.diameter - 2 * margin }
  if (!(query.diameter > 0)) {
    add('rapid', `stock cell ${stock.field.cell} mm cannot resolve a ${stock.query.cutter.diameter} mm tool`)
    return
  }
  for (let i = 1; i < moves.length; i++) {
    const prev = moves[i - 1], m = moves[i]
    if (isStockCuttingRole(effectiveMoveRole(m))) {
      if (!stock.removal) continue
      const { cutter, liftMm } = stock.removal
      for (const sweep of toolpathMovesToLinearSweeps([prev, m], sagitta)) {
        removeSweep(stock.field, { ...sweep, z0: sweep.z0 + liftMm, z1: sweep.z1 + liftMm }, cutter)
      }
      continue
    }
    if (Math.hypot(m.x - prev.x, m.y - prev.y) <= tolerance && m.z >= prev.z) continue // vertical lift
    const hit = maxTraverseIntrusion(stock.field,
      { x0: prev.x, y0: prev.y, z0: prev.z + lift, x1: m.x, y1: m.y, z1: m.z + lift }, query)
    if (hit.intrusionMm > limit) {
      // Witness only: how far the tool's edge reaches past the field's last clear radius.
      let clear = 0, touching = query.diameter / 2
      for (let k = 0; k < 16; k++) {
        const r = (clear + touching) / 2
        const probe = maxTraverseIntrusion(stock.field, { x0: prev.x, y0: prev.y, z0: prev.z + lift, x1: m.x, y1: m.y, z1: m.z + lift },
          { ...query, diameter: 2 * r })
        if (probe.intrusionMm > limit) touching = r; else clear = r
      }
      add('rapid', `${m.type} ${effectiveMoveRole(m)} traverse drives ${hit.intrusionMm.toFixed(3)} mm into uncleared stock, `
        + `${(stock.query.cutter.diameter / 2 - clear).toFixed(3)} mm radially inside the tool edge `
        + `(material top ${hit.materialTopZ.toFixed(3)} at X${hit.x.toFixed(3)} Y${hit.y.toFixed(3)}, tip Z${hit.tipZ.toFixed(3)})`, i)
    }
  }
}

/** Pure test oracle except for the stock it is handed (replayed in place), no
 * repairs or production side effects. Collect diagnostics rather than hiding
 * later safety checks behind the first assertion. Not a controller readback. */
export function toolpathPostCheck(input: ToolpathPostCheckInput): ToolpathPostIssue[] {
  const issues: ToolpathPostIssue[] = []
  const { moves, bottomZ, stock, posted } = input
  const tolerance = input.toleranceMm ?? 1e-6
  const arcTolerance = input.arcToleranceMm ?? 0.002 // 3-decimal post rounding budget (WO-1384)
  const add = (check: ToolpathPostIssue['check'], message: string, moveIndex?: number) => {
    issues.push({ check, ...(moveIndex === undefined ? {} : { moveIndex }), message })
  }
  for (const [name, value] of Object.entries({ bottomZ, tolerance, arcTolerance,
    intrusionTolerance: stock.intrusionToleranceMm ?? 0, radialTolerance: stock.radialResolutionMm ?? 0 })) {
    if (!Number.isFinite(value) || (name.endsWith('olerance') && value < 0)) add('finite', `${name} must be finite and tolerances nonnegative`)
  }
  if (issues.length) return issues
  geometryIssues(moves, bottomZ, tolerance, arcTolerance, add)
  // The stock replay cannot read nonfinite motion or a broken arc; that is already the finding.
  if (!issues.some(i => i.check === 'finite' || i.check === 'arc')) stockTraverseIssues(moves, stock, tolerance, add)
  if (!posted || moves.length === 0 || issues.some(i => i.check === 'finite' || i.check === 'arc')) return issues
  const postTolerance = posted.toleranceMm ?? 0.06 // default 0.05 arc-fit + rounding/sampling
  if (!Number.isFinite(postTolerance) || postTolerance <= 0) {
    add('post', 'post tolerance must be positive and finite')
    return issues
  }
  const read = readGcodeProgram(posted.gcode, posted.readerOptions)
  if (!read.ok) {
    add('post', `reader refused line ${read.refusal.line}: ${read.refusal.message}`)
    return issues
  }
  const expected = moves.map(posted.sourceToWork)
  let actual = read.program.moves.filter((_, i) => !posted.lineRange
    || (read.program.moveLines[i] >= posted.lineRange.startLine && read.program.moveLines[i] <= posted.lineRange.endLine))
  // WO-2870 (buildPostInput.ts): a ready operation whose every move is a rapid
  // has nothing left to cut and posts NO motion. Only that exact pairing passes.
  if (actual.length === 0 && moves.every(m => m.type === 'rapid')) return issues
  // The post owns approach/exit framing outside the CAM path. Only discard
  // leading/trailing RAPIDS, and only up to matching source endpoints. Never
  // trim feeds or select a convenient interior subpath after a failed match.
  while (actual.length && distance(actual[0], expected[0]) > postTolerance && actual[0].type === 'rapid') actual = actual.slice(1)
  while (actual.length && distance(actual.at(-1)!, expected.at(-1)!) > postTolerance && actual.at(-1)!.type === 'rapid') actual = actual.slice(0, -1)
  if (actual.length === 0 || expected.length === 0
    || distance(actual[0], expected[0]) > postTolerance
    || distance(actual.at(-1)!, expected.at(-1)!) > postTolerance) {
    add('post', 'posted path is missing the source start or end')
    return issues
  }
  // The reader admits the controller's arc tolerance; the test oracle also
  // enforces the caller's tighter start/end radius agreement after rounding.
  geometryIssues(actual, -Number.MAX_VALUE, tolerance, arcTolerance, (check, message, moveIndex) => {
    if (check === 'arc' || check === 'finite') add('post', `posted move ${moveIndex}: ${message}`)
  })
  const sampling = { maxChordMm: 0.1, maxAngleDeg: 1, maxSegmentsPerArc: 100_000 }
  const sourcePoints = sampleArcMovesForLinearConsumers(expected, sampling)
  const postedPoints = sampleArcMovesForLinearConsumers(actual, sampling)
  const missing = follows(sourcePoints, postedPoints, postTolerance)
  const extra = follows(postedPoints, sourcePoints, postTolerance, true)
  if (missing !== undefined) add('post', `source sample ${missing} at ${JSON.stringify(sourcePoints[missing])} is missing/reordered in posted path`)
  if (extra !== undefined) add('post', `posted sample ${extra} at ${JSON.stringify(postedPoints[extra])} deviates/reorders the source path or rapids over a feed`)
  return issues
}
