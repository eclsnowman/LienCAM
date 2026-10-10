// WO-1217 -- the benchmark metric collectors.
//
// Every metric here was paid for by a defect this project actually shipped, and
// each one is measured from the moves the APPLICATION produced (Rule 6): the
// collectors take `Operation.toolpathMoves` and the app's own
// `computeTimeMs` / `estimatedCutTimeMs` / `diagnostics`, never a hand-built
// payload and never an engine's internal picture.
//
// Nothing in this file knows the name of a part, a tool or an operation.

import { removeSweep, type Box3, type ZDexelField } from '../../cam3d/stock'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types'
import { measurePathEngagement } from '../../cam3d/rough'
import { replaySagittaFor, toolpathMovesToLinearSweeps } from '../../cam3d/rough/replayStock'
import type { IrMove, IrMoveRole } from '../../cam3d/ir/types'
import {
  effectiveMoveMotion,
  effectiveMoveRole,
  isStockCuttingRole,
  type MoveMotion,
} from '../../lib/cam/stockCuttingRoles'
import type { MoveRole, ToolpathMove } from '../../types'
import { notApplicable, type MetricValue } from './metricRegistry'

/**
 * WHAT REMOVES STOCK IS NOT DECIDED HERE.
 *
 * This file used to carry a private `CUTTING_ROLES` set, and it omitted
 * `stepover` while the application's exhaustive authority
 * (`src/lib/cam/stockCuttingRoles.ts`) says `stepover: true` -- "a stepover
 * advances the cutter into fresh stock -- it cuts". The adaptive emitter emits
 * those moves throughout a rough (`src/cam3d/rough/emit.ts`), so the benchmark
 * was dropping real cutting motion out of `cutMoves` / `cutLengthMm` AND out of
 * the stock-to-leave assert: a stepover that left less than the required
 * allowance, without breaking the finished surface, could not fail the run.
 *
 * There is now exactly one answer to "does this move cut?", and it is the
 * production one. A benchmark that disagrees with the simulator about what
 * removes material is measuring a different machine.
 */
function isCutting(move: ToolpathMove): boolean {
  // `effectiveMoveRole` applies the app's own default for an unlabelled move
  // (an untyped rapid is 'rapid', anything else is 'cut'), so an unlabelled
  // feed move still counts as cutting and the gouge check never skips it.
  return isStockCuttingRole(effectiveMoveRole(move))
}

/**
 * HOW A MOVE TRAVELS IS NOT DECIDED HERE EITHER.
 *
 * This file used to carry a private `MOVE_MOTION_BY_ROLE` table, and its `link`
 * members drive `links`, `feedLinkMoves`, `keepDownRides`, `liftedLinks` and the
 * flip-run boundaries -- the very numbers this benchmark exists to defend ("we
 * did better on ours avoiding repositions"). A private table can be exhaustive
 * over `MoveRole` and still not be production truth.
 *
 * The pass/link/air classification now lives beside the cutting authority in
 * `src/lib/cam/stockCuttingRoles.ts`, where a load-time check also holds the two
 * tables to each other (traverse motion never cuts; a programmed pass always
 * does). `effectiveMoveMotion` applies the app's own default for an unlabelled
 * move, the same one `effectiveMoveRole` applies.
 */

/**
 * Cutting moves that ENTER material rather than advance through it. An entry helix
 * removes a full disc by design, so a single one of them is heavier than any steady
 * cut and would swamp the engagement statistic the radial cap is a promise about.
 * They are counted separately, never hidden.
 */
const ENTRY_CUT_ROLES: ReadonlySet<MoveRole> = new Set<MoveRole>(['helix', 'ramp', 'plunge'])

/** A rise smaller than this is numerical noise, not a lift, mm. */
const LIFT_EPS = 1e-4

/** XY motion smaller than this is not a reposition, mm. */
const XY_EPS = 1e-6

/** Arc chord length used when expanding an arc move into samples, mm. */
const ARC_CHORD_MM = 0.2

/**
 * Two cutting moves are at the same Z level when their z agree to this, mm.
 * Four decimals: a constant-Z strategy emits one identical z per level, so this
 * only has to absorb f64 noise, and no real level spacing this project uses
 * comes anywhere near 0.0001 mm.
 */
const Z_LEVEL_EPS = 1e-4

/** A Z level needs this many turns before its flip rate is quoted -- a
 *  three-segment level reporting 100% is noise, not a finding. */
const MIN_TURNS_PER_Z = 20

function motionOf(move: ToolpathMove): MoveMotion {
  return effectiveMoveMotion(move)
}

/** A cutting move that advances through material rather than entering it. */
function isLateralCut(move: ToolpathMove): boolean {
  return isCutting(move) && !(move.role !== undefined && ENTRY_CUT_ROLES.has(move.role))
}

/**
 * Is this move a programmed PASS, as opposed to the motion that links two of
 * them? Link classification asks this, not "does it cut": a stepover cuts AND
 * carries the tool from one pass to the next, so it must still close a link
 * run, or `keepDownRides` -- the number Operator named as our advantage -- reads 0
 * on every adaptive rough and defends nothing. The two questions were
 * accidentally the same while `stepover` was mis-classified as non-cutting;
 * they are separate now and answered separately.
 */
function isPassMove(move: ToolpathMove): boolean {
  return motionOf(move) === 'pass'
}

/**
 * A lateral cut ON A PROGRAMMED PASS -- the steering the flip rate is about.
 * A stepover cuts and is lateral, but it is the move BETWEEN two passes; a
 * heading measured across it is not an in-pass steering decision, and the
 * reference band WO-1214 quotes was measured over `cut` moves only
 * (`src/tests/evidence/WO-1211/capture.mjs`). It therefore breaks the run,
 * like any other link, while still counting as cut length and being tested for
 * stock-to-leave.
 */
function isPassCut(move: ToolpathMove): boolean {
  return isLateralCut(move) && motionOf(move) === 'pass'
}

function isAir(move: ToolpathMove): boolean {
  return move.type === 'rapid' || motionOf(move) === 'air'
}

function segLength(a: Point3, b: Point3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

/**
 * True travelled length of one move, mm. An arc is measured along the ARC: the
 * engine emits hundreds of G2/G3 moves on a curved wall and scoring them as
 * chords would quietly understate every distance metric on exactly the paths
 * WO-1211 taught it to fit arcs to.
 */
function moveLength(from: Point3, move: ToolpathMove): number {
  const to: Point3 = { x: move.x, y: move.y, z: move.z }
  if ((move.type !== 'arc_cw' && move.type !== 'arc_ccw') ||
      typeof move.cx !== 'number' || typeof move.cy !== 'number') {
    return segLength(from, to)
  }
  const radius = Math.hypot(from.x - move.cx, from.y - move.cy)
  const sweep = arcSweep(from, to, move.cx, move.cy, move.type === 'arc_cw')
  return Math.hypot(radius * sweep, to.z - from.z)
}

/** Absolute swept angle of an arc, radians, in the emitted direction. */
function arcSweep(from: Point3, to: Point3, cx: number, cy: number, clockwise: boolean): number {
  const a0 = Math.atan2(from.y - cy, from.x - cx)
  let a1 = Math.atan2(to.y - cy, to.x - cx)
  if (clockwise) {
    while (a1 > a0) a1 -= 2 * Math.PI
  } else {
    while (a1 < a0) a1 += 2 * Math.PI
  }
  // A full circle emitted as a single word arrives with equal endpoints.
  const sweep = Math.abs(a1 - a0)
  return sweep < 1e-12 ? 2 * Math.PI : sweep
}

export interface Point3 { x: number; y: number; z: number }

/**
 * A tool-tip sample.
 * - `cutting`  : the move it came from engages material.
 * - `endpoint` : it IS a point the engine emitted, not one this file interpolated.
 * - `steep`    : the move it came from is closer to vertical than
 *                `STEEP_SEGMENT_DEG` from horizontal.
 */
export interface SamplePoint extends Point3 {
  cutting: boolean
  endpoint: boolean
  steep: boolean
}

/**
 * A move inclined more steeply than this from horizontal is a plunge or a wall
 * descent, and the axial drop test is not valid ACROSS it -- only AT its ends.
 *
 * Why, measured on the H-pocket and the terraces: the drop-cutter CL over a step
 * taller than the tool radius is DISCONTINUOUS. At a tool radius from the edge the
 * ball sits on the lower face; a hair closer and it is pushed up onto the edge. The
 * engine bridges that jump with near-vertical moves, which is correct, and the CL
 * arc approaching it has a VERTICAL TANGENT, so any chord near it deviates hard.
 * Interpolating along those moves and testing pointwise reported up to 9.3 mm of
 * "gouge" on a path that removes nothing (0.91 mm at 80 deg, 0.20 mm at 45 deg).
 *
 * 45 deg is the line: a floor, a terrace, a shallow slope and the top of a dome are
 * all tested sample by sample, while wall descents and plunges are tested only where
 * the engine itself made a claim. A plunge that ends below the floor is still caught,
 * because its endpoint always is.
 */
export const STEEP_SEGMENT_DEG = 45

/** Path shape, linking and engagement -- everything readable off the moves alone. */
export interface PathMetrics {
  moves: number
  cutMoves: number
  flownDistanceMm: number
  cutLengthMm: number
  rapidDistanceMm: number
  /** Runs of linking motion BETWEEN two programmed passes -- rapids, loop-backs
   *  and stepovers. The lead-in to the first pass and the final retract are not
   *  links: nothing links to them. */
  links: number
  /** Links that rose above both of the passes they join -- a lift-and-re-enter. */
  liftedLinks: number
  /** Links that stayed down. Operator ruling 2026-09-05: "We did better on ours avoiding
   *  repositions." This is the number that defends that, and it is HIGHER-is-better. */
  keepDownRides: number
  /** Traverse-rate moves that climb: a retract, counted move by move. */
  retracts: number
  /** Traverse-rate moves that translate in XY: a reposition in air. A rapid count
   *  alone cannot see a feed-rate link, which is why feedLinkMoves is separate. */
  rapidRepositions: number
  /** Feed-rate link moves -- stepover and loop_back. A stepover also removes
   *  stock (the production authority says so), so it is BOTH counted here and
   *  included in cutMoves / cutLengthMm; the two counts answer different
   *  questions and neither is a subset of the other. */
  feedLinkMoves: number
  /**
   * Cutting moves that ENTER material rather than advance through it (helix,
   * ramp, plunge), and their travelled length. Counted separately because an
   * entry takes a full disc by design: it is not a radial bite and it is
   * excluded from the engagement measure, so without these two cells a change
   * that doubled the entry work would leave no trace on the scorecard.
   */
  entryCutMoves: number
  entryCutLengthMm: number
  /** Consecutive segment pairs that turned at all, counted per Z (see flips). */
  turns: number
  /**
   * Turns whose signed heading delta changed sign against the previous turn --
   * WO-1214's definition, verbatim -- counted PER Z. deg/mm provably does not
   * discriminate (Fusion runs 0.2-4.7% flips at 2.8-4.1 deg/mm while we run
   * 30-35% at 3.3-4.9); the flip rate does, and the reference is quoted per
   * cutting level, so a pair is only ever compared when BOTH its segments cut
   * at the same z. A pair straddling two levels is not a steering decision at
   * all and must never be blessed as one.
   */
  flips: number
  flipRatePct: number
  /**
   * The worst and best flip rate of any single Z level carrying at least
   * MIN_TURNS_PER_Z turns -- exactly the band WO-1214 quotes the reference in
   * ("Fusion, cutting levels: flip rate 0.2% - 4.7%"). The turn floor keeps a
   * three-segment level from reporting 100%.
   */
  worstZFlipRatePct: number
  bestZFlipRatePct: number
  /** How many Z levels cleared the turn floor and therefore back that band. */
  scoredZLevels: number
  maxFlipDeg: number
  p95FlipDeg: number
  /** Distinct cut z values, quantised to 1e-3 mm. Not the same thing as the
   *  strategy's level count, which arrives from its own diagnostics. */
  distinctCutZValues: number
}

/**
 * Read the path metrics off one operation's moves.
 *
 * `startPoint` is where the tool stands when the operation begins; the first
 * move's length is measured from it. Passing undefined starts from the first
 * move's own endpoint, which drops that one length -- deliberate, because the
 * app leaves the previous operation's end position implicit.
 */
export function pathMetrics(moves: readonly ToolpathMove[], startPoint?: Point3): PathMetrics {
  let flown = 0
  let cutLength = 0
  let rapidDistance = 0
  let retracts = 0
  let rapidRepositions = 0
  let feedLinkMoves = 0
  let cutMoves = 0
  let entryCutMoves = 0
  let entryCutLengthMm = 0
  const zLevels = new Set<number>()

  let from: Point3 | undefined = startPoint
  for (const move of moves) {
    const to: Point3 = { x: move.x, y: move.y, z: move.z }
    const length = from ? moveLength(from, move) : 0
    flown += length
    const cutting = isCutting(move)
    if (cutting) {
      cutMoves++
      cutLength += length
      zLevels.add(Math.round(move.z * 1e3))
      if (!isLateralCut(move)) {
        entryCutMoves++
        entryCutLengthMm += length
      }
    }
    if (isAir(move)) {
      rapidDistance += length
      if (from && move.z - from.z > LIFT_EPS) retracts++
      if (from && Math.hypot(move.x - from.x, move.y - from.y) > XY_EPS) rapidRepositions++
    }
    if (motionOf(move) === 'link') feedLinkMoves++
    from = to
  }

  const linking = linkMetrics(moves, startPoint)
  const flip = flipMetrics(moves, startPoint)

  return {
    moves: moves.length,
    cutMoves,
    flownDistanceMm: flown,
    cutLengthMm: cutLength,
    rapidDistanceMm: rapidDistance,
    links: linking.links,
    liftedLinks: linking.liftedLinks,
    keepDownRides: linking.keepDownRides,
    retracts,
    rapidRepositions,
    feedLinkMoves,
    entryCutMoves,
    entryCutLengthMm,
    turns: flip.turns,
    flips: flip.flips,
    flipRatePct: flip.turns ? (flip.flips / flip.turns) * 100 : 0,
    worstZFlipRatePct: flip.worstZFlipRatePct,
    bestZFlipRatePct: flip.bestZFlipRatePct,
    scoredZLevels: flip.scoredZLevels,
    maxFlipDeg: flip.maxFlipDeg,
    p95FlipDeg: flip.p95FlipDeg,
    distinctCutZValues: zLevels.size,
  }
}

/**
 * Classify every run of linking motion that sits BETWEEN two programmed passes.
 * A run whose highest point stays at or below the higher of the two passes it
 * joins never left the work -- that is a keep-down ride (WO-1194 made those
 * deliberate and Operator likes the result). A run that climbed above both is a
 * lift-and-re-enter.
 *
 * The anchors are passes, not "cutting moves": a stepover removes stock and is
 * counted as cut length everywhere else in this file, but it is the linking
 * move itself and must stay INSIDE the run it belongs to.
 */
function linkMetrics(
  moves: readonly ToolpathMove[],
  startPoint?: Point3,
): { links: number; liftedLinks: number; keepDownRides: number } {
  let links = 0
  let liftedLinks = 0
  let keepDownRides = 0
  let lastCutZ: number | undefined
  let runMaxZ = Number.NEGATIVE_INFINITY
  let runLength = 0

  let from: Point3 | undefined = startPoint
  for (const move of moves) {
    if (isPassMove(move)) {
      if (lastCutZ !== undefined && runLength > 0) {
        links++
        // The anchor z's bound the ride: a link that never rose above the higher
        // of them stayed on the work.
        if (runMaxZ > Math.max(lastCutZ, move.z) + LIFT_EPS) liftedLinks++
        else keepDownRides++
      }
      lastCutZ = move.z
      runMaxZ = Number.NEGATIVE_INFINITY
      runLength = 0
    } else {
      runLength++
      if (from) runMaxZ = Math.max(runMaxZ, from.z)
      runMaxZ = Math.max(runMaxZ, move.z)
    }
    from = { x: move.x, y: move.y, z: move.z }
  }
  return { links, liftedLinks, keepDownRides }
}

/**
 * Flips, PER Z -- WO-1214's definition, verbatim, and its grouping.
 *
 * A flip is the sign change of the signed heading delta between consecutive
 * segment pairs. WO-1214 measured the reference "per Z" and quotes it as a band
 * across cutting levels (Fusion 0.2-4.7%, us 30-35%), so the grouping is the Z
 * the tool is cutting at -- NOT a maximal run of cutting moves. The two are not
 * the same thing: `plunge` is a cutting role, so a maximal cutting run walks
 * straight through a plunge and compares a heading on one level against a
 * heading on the next one down. That pair is not a steering decision and a
 * baseline that blesses it is measuring nothing.
 *
 * A pair therefore counts only when all three of its points are LATERAL cuts ON
 * A PASS (entry moves -- helix, ramp, plunge -- steer by design and change z;
 * a stepover cuts, but it is the move BETWEEN two passes, not steering within
 * one), sit at the same quantised z, and are consecutive in the emitted path. A
 * run breaking for any reason -- a link, a rapid, an entry move, a change of
 * level -- resets the remembered sign, so the first turn after a break is a
 * turn and never a flip. That is exactly the rule
 * `src/tests/evidence/WO-1211/capture.mjs` used to produce the numbers WO-1214
 * is quoting (it grouped on `role === 'cut'`), generalised from one role to any
 * lateral cutting move on a pass.
 */
function flipMetrics(
  moves: readonly ToolpathMove[],
  startPoint?: Point3,
): {
  turns: number
  flips: number
  worstZFlipRatePct: number
  bestZFlipRatePct: number
  scoredZLevels: number
  maxFlipDeg: number
  p95FlipDeg: number
} {
  interface ZBucket { turns: number; flips: number }
  const byZ = new Map<number, ZBucket>()
  const flipDegrees: number[] = []

  let run: Point3[] = []
  let runKey: number | undefined
  let from: Point3 | undefined = startPoint

  const levelKey = (z: number): number => Math.round(z / Z_LEVEL_EPS)

  const closeRun = (): void => {
    if (runKey !== undefined && run.length >= 3) {
      let bucket = byZ.get(runKey)
      if (!bucket) {
        bucket = { turns: 0, flips: 0 }
        byZ.set(runKey, bucket)
      }
      // WO-1928: a closed run (it ends where it began) is a ring, and a ring has
      // no seam. Its last point repeats its first, so drop the repeat and let
      // the walk wrap: the turn at the start vertex and the pair that spans the
      // start count like any other, so the count no longer depends on where the
      // ring starts. An open run keeps the plain first-to-last walk.
      const first = run[0]
      const last = run[run.length - 1]
      const closed =
        run.length >= 4 && Math.hypot(last.x - first.x, last.y - first.y) <= XY_EPS
      const pts = closed ? run.slice(0, -1) : run
      const count = pts.length
      const turnCount = closed ? count : count - 2
      // Turn t sits at vertex t+1 (mod count); the last turn of a ring is at the start.
      const signs: number[] = []
      const degrees: number[] = []
      for (let t = 0; t < turnCount; t++) {
        const p = pts[t]
        const a = pts[(t + 1) % count]
        const b = pts[(t + 2) % count]
        const ax = a.x - p.x
        const ay = a.y - p.y
        const bx = b.x - a.x
        const by = b.y - a.y
        if (Math.hypot(ax, ay) <= 1e-9 || Math.hypot(bx, by) <= 1e-9) continue
        const angle = Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
        if (Math.abs(angle) <= 1e-12) continue
        signs.push(Math.sign(angle))
        degrees.push((Math.abs(angle) * 180) / Math.PI)
      }
      // A new run never inherits the previous run's heading, even at the same z.
      bucket.turns += signs.length
      for (let i = closed ? 0 : 1; i < signs.length; i++) {
        const before = signs[(i - 1 + signs.length) % signs.length]
        if (signs[i] !== before) {
          bucket.flips++
          flipDegrees.push(degrees[i])
        }
      }
    }
    run = []
    runKey = undefined
  }

  for (const move of moves) {
    const to: Point3 = { x: move.x, y: move.y, z: move.z }
    if (!isPassCut(move)) {
      closeRun()
      from = to
      continue
    }
    const key = levelKey(move.z)
    if (runKey !== undefined && key !== runKey) closeRun()
    if (run.length === 0) {
      runKey = key
      // Anchor on where the tool already stands, but ONLY if it stands at this
      // level: a heading measured from a point at another z is the cross-level
      // pair this grouping exists to refuse.
      if (from && levelKey(from.z) === key) run.push(from)
    }
    run.push(to)
    from = to
  }
  closeRun()

  let turns = 0
  let flips = 0
  let worstZFlipRatePct = 0
  let bestZFlipRatePct = Number.POSITIVE_INFINITY
  let scoredZLevels = 0
  for (const bucket of byZ.values()) {
    turns += bucket.turns
    flips += bucket.flips
    if (bucket.turns < MIN_TURNS_PER_Z) continue
    const rate = (bucket.flips / bucket.turns) * 100
    worstZFlipRatePct = Math.max(worstZFlipRatePct, rate)
    bestZFlipRatePct = Math.min(bestZFlipRatePct, rate)
    scoredZLevels++
  }

  flipDegrees.sort((a, b) => a - b)
  return {
    turns,
    flips,
    worstZFlipRatePct,
    bestZFlipRatePct: scoredZLevels > 0 ? bestZFlipRatePct : 0,
    scoredZLevels,
    maxFlipDeg: flipDegrees.at(-1) ?? 0,
    p95FlipDeg: flipDegrees.length
      ? flipDegrees[Math.floor(0.95 * (flipDegrees.length - 1))]
      : 0,
  }
}

/**
 * Expand the whole path into tool-tip sample points at no more than `spacing`
 * apart, arcs included (an arc sampled as its chord would hide the very dip the
 * gouge check exists to find). Every point carries the z the tool is at, which
 * is what the surface check compares against.
 */
export function samplePath(
  moves: readonly ToolpathMove[],
  spacing: number,
  startPoint?: Point3,
): SamplePoint[] {
  const out: SamplePoint[] = []
  const steepLimit = Math.tan((STEEP_SEGMENT_DEG * Math.PI) / 180)
  let from: Point3 | undefined = startPoint
  if (from) out.push({ ...from, cutting: false, endpoint: true, steep: false })
  for (const move of moves) {
    const to: Point3 = { x: move.x, y: move.y, z: move.z }
    const cutting = isCutting(move)
    if (!from) {
      out.push({ ...to, cutting, endpoint: true, steep: false })
      from = to
      continue
    }
    const lateral = Math.hypot(to.x - from.x, to.y - from.y)
    const rise = Math.abs(to.z - from.z)
    const steep = rise > 1e-9 && rise > lateral * steepLimit
    if ((move.type === 'arc_cw' || move.type === 'arc_ccw') &&
        typeof move.cx === 'number' && typeof move.cy === 'number') {
      pushArcSamples(out, from, to, move.cx, move.cy, move.type === 'arc_cw', cutting, steep)
    } else {
      const length = segLength(from, to)
      const steps = Math.max(1, Math.ceil(length / spacing))
      for (let k = 1; k <= steps; k++) {
        const t = k / steps
        out.push({
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          z: from.z + (to.z - from.z) * t,
          cutting,
          endpoint: k === steps,
          steep,
        })
      }
    }
    from = to
  }
  return out
}

function pushArcSamples(
  out: SamplePoint[],
  from: Point3,
  to: Point3,
  cx: number,
  cy: number,
  clockwise: boolean,
  cutting: boolean,
  steep: boolean,
): void {
  const radius = Math.hypot(from.x - cx, from.y - cy)
  const a0 = Math.atan2(from.y - cy, from.x - cx)
  const sweep = arcSweep(from, to, cx, cy, clockwise)
  const signed = clockwise ? -sweep : sweep
  const steps = Math.max(1, Math.ceil((radius * sweep) / ARC_CHORD_MM))
  for (let k = 1; k <= steps; k++) {
    const t = k / steps
    const angle = a0 + signed * t
    out.push({
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      z: from.z + (to.z - from.z) * t,
      cutting,
      endpoint: k === steps,
      steep,
    })
  }
}

/** The safety floor, plus the one clearance number that falls out of the same pass. */
export interface SurfaceMetrics {
  /**
   * Deepest the tool went below the part surface over EVERY move, cutting or
   * not, mm. 0 means it never did. This is the gouge assert: a link that dips
   * into the part is a gouge exactly as a cut that does.
   */
  maxGougeMm: number
  /**
   * Least material left standing under a CUTTING move, mm -- cutting by the
   * production authority, so a stepover is in here: it advances the cutter into
   * fresh stock and a stepover that eats the allowance must fail the assert.
   * This is what stock-to-leave is a promise about; a non-cutting link riding
   * above the part is not, which is why the two numbers are separate (the
   * H-pocket rough rides links 0.05 mm over the block top -- correct behaviour
   * that would otherwise read as a 0.3 mm stock-to-leave violation).
   */
  minCutMarginMm: number
  /**
   * Least clearance a NON-CUTTING move had over the part, mm. Not an assert --
   * a metric, and higher is better: a link skimming a whisker above a finished
   * surface is one thermal expansion away from a witness mark.
   *
   * NaN when no non-cutting sample stood over the part at all (a pass whose
   * every sample cuts, e.g. a pure rough with no link over the work): see
   * NO_LINK_CLEARANCE_SAMPLE_REASON and `linkClearanceMetric`. NaN is "nothing
   * to measure", not "measured 0" -- 0 is the WORST value this higher-is-better
   * metric can show, and folding an absent sample into it read two rows that
   * measured nothing as having gotten worse (WO-1880, from WO-1877 finding H1).
   */
  minLinkClearanceMm: number
  /** Samples that stood over the part surface at all (the check's teeth). */
  samplesOverPart: number
  cutSamplesOverPart: number
  /** Interpolated samples inside near-vertical moves, skipped BY NAME and never
   *  silently: see STEEP_SEGMENT_DEG. Their moves' own endpoints are still tested. */
  steepInteriorSamplesSkipped: number
}

/**
 * Drop the tool onto the part at every sample point and compare with where the
 * tool actually was.
 *
 * The cutter is SHRUNK laterally by `shrinkMm` before the drop. That is not a
 * fudge, it is the difference between grazing and gouging: an exact drop-cutter
 * test treats a vertical wall as surface, so a pass merely TANGENT to a wall --
 * the correct path -- reads as a gouge the full height of that wall. Measured on
 * the H-pocket, a 3 mm ball sitting 0.07 mm past tangency to the 12 mm wall (well
 * inside the operation's own 0.1 mm chordal tolerance) reported a 9.3 mm axial
 * dip. Callers therefore pass the operation's own declared tolerance, and the
 * shrunken cutter still catches anything that eats more of the wall than that.
 */
export async function surfaceMetrics(input: {
  mesh: PartMesh
  cutter: CutterSpec
  samples: readonly SamplePoint[]
  shrinkMm: number
}): Promise<SurfaceMetrics> {
  const { mesh, cutter, samples, shrinkMm } = input
  if (cutter.kind !== 'flat' && cutter.kind !== 'ball') {
    throw new Error(
      `benchmark surfaceMetrics: no exact drop for a ${cutter.kind} cutter -- the ` +
        'gouge assert must never be silently skipped (ADR-0003).',
    )
  }
  const shrunkDiameter = cutter.diameter - 2 * shrinkMm
  if (!(shrunkDiameter > 0)) {
    throw new Error(`benchmark surfaceMetrics: shrink ${shrinkMm} mm eats the whole cutter.`)
  }
  // Below every surface: the drop's miss policy returns the seed, and a seed
  // this far down can never be mistaken for a contact.
  const zSeed = mesh.bounds.min[2] - 1e4

  const kernel = new BvhKernel()
  const meshHandle = kernel.uploadMesh(mesh)
  const cutterHandle = kernel.makeCutter({ kind: cutter.kind, diameter: shrunkDiameter })
  try {
    let maxGouge = 0
    let minCutMargin = Number.POSITIVE_INFINITY
    let minLinkClearance = Number.POSITIVE_INFINITY
    let samplesOverPart = 0
    let cutSamplesOverPart = 0
    let steepInteriorSamplesSkipped = 0
    // Chunked so a long path does not build one enormous Float64Array.
    const CHUNK = 20_000
    for (let start = 0; start < samples.length; start += CHUNK) {
      const slice = samples.slice(start, start + CHUNK)
      const xy = new Float64Array(slice.length * 2)
      for (let i = 0; i < slice.length; i++) {
        xy[i * 2] = slice[i].x
        xy[i * 2 + 1] = slice[i].y
      }
      const dropped = await kernel.dropPath(meshHandle, cutterHandle, xy, zSeed)
      for (let i = 0; i < slice.length; i++) {
        if (slice[i].steep && !slice[i].endpoint) {
          steepInteriorSamplesSkipped++
          continue
        }
        const contact = dropped[i]
        if (contact <= zSeed) continue // nothing under the cutter here
        samplesOverPart++
        const margin = slice[i].z - contact
        if (slice[i].cutting) {
          cutSamplesOverPart++
          if (margin < minCutMargin) minCutMargin = margin
        } else if (margin < minLinkClearance) {
          minLinkClearance = margin
        }
        if (-margin > maxGouge) maxGouge = -margin
      }
    }
    return {
      maxGougeMm: maxGouge,
      minCutMarginMm: Number.isFinite(minCutMargin) ? minCutMargin : 0,
      minLinkClearanceMm: Number.isFinite(minLinkClearance) ? minLinkClearance : Number.NaN,
      samplesOverPart,
      cutSamplesOverPart,
      steepInteriorSamplesSkipped,
    }
  } finally {
    kernel.releaseCutter(cutterHandle)
    kernel.releaseMesh(meshHandle)
  }
}

/**
 * WHY MINLINKCLEARANCEMM STAYS `number`, NOT `MetricValue`, ON `SurfaceMetrics`:
 * `surfaceMetrics` is a collector, and other collector consumers (e.g.
 * `collectorTruth.test.ts`) read `.minLinkClearanceMm` as a plain number.
 * NaN is the in-band "unmeasured" sentinel; this function is where a caller
 * that has to put the value on a scorecard row converts it to the registry's
 * reasoned-absence shape.
 */
export const NO_LINK_CLEARANCE_SAMPLE_REASON = 'no non-cutting sample over the part'

/**
 * `minLinkClearanceMm`, in the scorecard's reasoned-absence shape: the number
 * itself when at least one non-cutting sample stood over the part, or an
 * explicit not-applicable with `NO_LINK_CLEARANCE_SAMPLE_REASON` when none did.
 * A row whose every sample cuts measured nothing standing off the part, and a
 * higher-is-better metric must never report that as 0 -- the worst value it
 * could otherwise show (WO-1880, from WO-1877 finding H1).
 */
export function linkClearanceMetric(minLinkClearanceMm: number): MetricValue {
  return Number.isNaN(minLinkClearanceMm) ? notApplicable(NO_LINK_CLEARANCE_SAMPLE_REASON) : minLinkClearanceMm
}

/**
 * Coverage, simulated. A smoother path that misses material is worse than a
 * rough one, so the scorecard has to know what is still standing.
 *
 * The field is the chain's own accounting, carried from one operation to the
 * next: it starts as the stock block and every operation's moves are swept out
 * of it with the production `removeSweep`. `uncutAreaMm2` is the footprint still
 * standing above the part surface after this operation, and `machinedAreaMm2` is
 * the footprint this operation lowered.
 */
export interface CoverageMetrics {
  uncutAreaMm2: number
  machinedAreaMm2: number
  removedVolumeMm3: number
}

/** Material above the surface by less than this is scallop, not uncut stock, mm. */
export const UNCUT_TOLERANCE_MM = 0.2

export function carveCoverage(input: {
  field: ZDexelField
  /** Part surface z per column, in the same grid as `field`. */
  surfaceZ: Float64Array
  cutter: CutterSpec
  moves: readonly ToolpathMove[]
}): CoverageMetrics {
  const { field, surfaceZ, cutter, moves } = input
  if (cutter.kind !== 'flat' && cutter.kind !== 'ball') {
    throw new Error(`benchmark carveCoverage: removeSweep models flat and ball only, not ${cutter.kind}.`)
  }
  const before = Float32Array.from(field.top)
  let removedVolumeMm3 = 0
  // ARCS ARE REPLAYED AS ARCS, and the conversion is the PRODUCTION one.
  //
  // This loop used to carve one straight sweep per move, from the previous
  // endpoint to this one. On a path the engine deliberately fits arcs to
  // (WO-1211) that quietly cuts the corner: a quarter circle replayed as its
  // endpoint chord removes 141.4 mm^3 where the arc removes 153.2 mm^3 -- an 8%
  // under-read, on exactly the moves this project is trying to improve. The
  // smoke rough paths are 28% arc moves (669 of 2395 on the H-pocket), so this
  // was not a corner case.
  //
  // `toolpathMovesToLinearSweeps` is the app's own persisted-moves -> sweeps
  // converter (it handles the absolute cx/cy -> start-relative i/j centre
  // conversion and walks the arc to a bounded sagitta), and `replaySagittaFor`
  // is the sagitta bound the production replay uses for a field of this cell
  // size. It also applies the shared `isStockCuttingRole` authority, so a rapid
  // or a loop-back advances the cursor without carving -- the same rule the
  // simulator and rest machining use, rather than a private one.
  for (const sweep of toolpathMovesToLinearSweeps(moves, replaySagittaFor(field))) {
    removedVolumeMm3 += removeSweep(field, sweep, cutter).removedVolumeMm3
  }
  const cellArea = field.cell * field.cell
  let uncutColumns = 0
  let machinedColumns = 0
  for (let index = 0; index < field.top.length; index++) {
    const surface = surfaceZ[index]
    if (Number.isFinite(surface) && field.top[index] > surface + UNCUT_TOLERANCE_MM) uncutColumns++
    if (field.top[index] < before[index] - 1e-6) machinedColumns++
  }
  return {
    uncutAreaMm2: uncutColumns * cellArea,
    machinedAreaMm2: machinedColumns * cellArea,
    removedVolumeMm3,
  }
}

// ---------------------------------------------------------------------------
// RADIAL ENGAGEMENT -- measured by the engine's own measure, not by ours.
// ---------------------------------------------------------------------------
//
// The metric the work order asks for is SUSTAINED RADIAL ENGAGEMENT: the width
// of material the cutter is actually taking, as a fraction of what it would take
// cutting a full-width slot at the same axial depth. This harness used to report
// an engaged CROSS-SECTION in mm^2 (removed volume over travelled length) and
// compare it to `stepover x diameter x maxStepdown`. That is a different
// quantity: it scales with how deep the level is, so a change that halves the
// stepdown halves the number without the cutter's radial bite moving at all, and
// on a ball nose it is not even proportional to the radial width.
//
// `measurePathEngagement` (src/cam3d/rough/pathEngagement.ts) is the engine's own
// answer, and the one adaptive rough refuses a side-entry job on: it replays the
// path into a fresh stock field, divides each move's fresh volume by the FULL-SLOT
// cross-section for this cutter at this level's slab depth, and reports the peak
// over a 2 mm sustained window so a sub-cell sliver cannot forge a spike. Using it
// means the benchmark and the engine cannot disagree about what engagement means.

/**
 * App move role -> IR move role, total by construction.
 *
 * `measurePathEngagement` speaks IR. The app's `MoveRole` is a superset of
 * `IrMoveRole`, so the four extra roles need a stated meaning; typing the table
 * as `Record<MoveRole, IrMoveRole>` makes adding a role to the app union without
 * classifying it here a COMPILE ERROR, exactly as `STOCK_CUTTING_BY_ROLE` does
 * for the carve authority.
 *
 * Only the LATERAL cut roles ('cut', 'finish', 'stepover') are measured; every
 * other role is still replayed, so the stock state stays physical, and it ends
 * the contiguous run being averaged.
 */
const MOVE_ROLE_TO_IR_ROLE = {
  cut: 'cut',
  finish: 'finish',
  stepover: 'stepover',
  lead_in: 'lead_in',
  lead_out: 'lead_out',
  plunge: 'plunge',
  ramp: 'ramp',
  // A helix is an entry that takes a full disc by design. IR has no helix role;
  // 'ramp' is the entry role with the same treatment -- replayed, never counted
  // as a lateral bite, and it breaks the run. Letting it into the lateral set
  // would make every comparison against the cap meaningless.
  helix: 'ramp',
  // A wall follow travels laterally at depth taking a skim: that is what
  // 'finish' means to this measure.
  wall_follow: 'finish',
  rapid: 'rapid',
  fast_traverse: 'rapid',
  // A loop-back rides between cuts without removing material (the shared
  // STOCK_CUTTING_BY_ROLE table says so); 'rapid' is the IR role that is
  // replayed but never measured.
  loop_back: 'rapid',
} as const satisfies Record<MoveRole, IrMoveRole>

/**
 * The app's persisted moves as IR, for the engine's own engagement measure.
 * The arc centre conversion is the exact inverse of `irToToolpathMoves`: the app
 * stores an ABSOLUTE cx/cy, IR carries the offset from the arc START, and the
 * arc start is the previous move's endpoint. Fails loud rather than guessing.
 */
export function toIrMoves(moves: readonly ToolpathMove[]): IrMove[] {
  const out: IrMove[] = []
  let prev: Point3 | undefined
  for (const move of moves) {
    const role = MOVE_ROLE_TO_IR_ROLE[effectiveMoveRole(move)]
    if (move.type === 'arc_cw' || move.type === 'arc_ccw') {
      if (prev === undefined) {
        throw new Error('benchmark toIrMoves: an arc cannot be the first move -- its centre is relative to the arc start.')
      }
      if (move.cx === undefined || move.cy === undefined) {
        throw new Error('benchmark toIrMoves: arc move is missing its absolute cx/cy centre.')
      }
      out.push({
        t: 'arc',
        x: move.x, y: move.y, z: move.z,
        i: move.cx - prev.x, j: move.cy - prev.y,
        cw: move.type === 'arc_cw',
        role,
      })
    } else {
      out.push({ t: move.type === 'rapid' ? 'rapid' : 'feed', x: move.x, y: move.y, z: move.z, role })
    }
    prev = { x: move.x, y: move.y, z: move.z }
  }
  return out
}

export interface RadialEngagementMetrics {
  /** Worst sustained window, as a fraction of a full-width slot. 1.0 == full slot. */
  peakEngagementFraction: number
  /** 95th percentile of the same windows, weighted by cutting LENGTH. */
  p95EngagementFraction: number
  /** The cap this path was measured against -- echoed so the table can quote it. */
  engagementCapFraction: number
  /** Cutting length whose sustained window sat over that cap, mm. */
  engagementOverCapLengthMm: number
  /** That length as a percentage of the measured lateral cutting length. */
  engagementOverCapPct: number
  /** Lateral cutting length the measure saw at all, mm (the check's teeth). */
  measuredCuttingLengthMm: number
}

/**
 * Accounting threshold used to ENUMERATE every measured window rather than to
 * judge one. `measurePathEngagement` reports a window through `onOverCap` when
 * its fraction exceeds the threshold it is given, so a threshold below any
 * fraction a real cut can produce reports all of them. The windows it does not
 * report removed no fresh material at all (fraction exactly 0, air over ground
 * already cleared); their length is recovered from `cuttingLengthMm`, which is
 * what makes the percentile below the P95 of EVERY measured window and not just
 * of the non-zero ones. The cap the caller actually cares about is applied to the
 * enumerated windows, with the same `fraction > cap` arithmetic the function
 * itself uses -- pinned by a test.
 */
const ENGAGEMENT_ENUMERATE_THRESHOLD = 1e-12

/**
 * Sustained radial engagement over an emitted toolpath, measured by the engine.
 *
 * `stockBounds` is the UNCUT stock box: the measure replays the path from fresh
 * stock, which is right for the first operation of a chain and wrong for a later
 * one. That is why the registry only declares a cap on operations the promise
 * belongs to; a step with no declared cap is not measured rather than being
 * given a number that is quietly measured against the wrong stock.
 */
export function measureRadialEngagement(input: {
  moves: readonly ToolpathMove[]
  stockBounds: Box3
  /** Cell size of the replay field, mm. */
  cellMm: number
  cutter: CutterSpec
  /** What the strategy promises, as a fraction of a full-width slot. */
  capFraction: number
}): RadialEngagementMetrics {
  const windows: { lengthMm: number; fraction: number }[] = []
  const measured = measurePathEngagement(
    toIrMoves(input.moves),
    input.stockBounds,
    input.cellMm,
    input.cutter,
    {
      capFraction: ENGAGEMENT_ENUMERATE_THRESHOLD,
      onOverCap: (hit) => windows.push({ lengthMm: hit.lengthMm, fraction: hit.fraction }),
    },
  )
  let overCapLengthMm = 0
  for (const window of windows) {
    if (window.fraction > input.capFraction) overCapLengthMm += window.lengthMm
  }
  return {
    peakEngagementFraction: measured.peakFraction,
    p95EngagementFraction: lengthWeightedP95(windows, measured.cuttingLengthMm),
    engagementCapFraction: input.capFraction,
    engagementOverCapLengthMm: overCapLengthMm,
    engagementOverCapPct:
      measured.cuttingLengthMm > 0 ? (overCapLengthMm / measured.cuttingLengthMm) * 100 : 0,
    measuredCuttingLengthMm: measured.cuttingLengthMm,
  }
}

/**
 * The engagement fraction at the 95th percentile of measured cutting LENGTH --
 * length-weighted, because a millimetre of path is the unit that matters and a
 * move is not. `totalLengthMm` includes the zero-engagement windows the
 * enumeration does not report; they sit at the bottom of the distribution.
 *
 * Deterministic: the sort key is the fraction alone and V8's sort is stable, so
 * equal fractions keep path order and two runs give the same answer.
 */
function lengthWeightedP95(
  windows: readonly { lengthMm: number; fraction: number }[],
  totalLengthMm: number,
): number {
  if (!(totalLengthMm > 0)) return 0
  const sorted = [...windows].sort((a, b) => a.fraction - b.fraction)
  const target = 0.95 * totalLengthMm
  let cumulative = totalLengthMm - windows.reduce((sum, window) => sum + window.lengthMm, 0)
  if (cumulative >= target) return 0
  for (const window of sorted) {
    cumulative += window.lengthMm
    if (cumulative >= target) return window.fraction
  }
  return sorted.at(-1)?.fraction ?? 0
}

/**
 * Part surface z at every column centre of `field`, for the coverage comparison.
 * A zero-width flat cutter is a point probe, so this is the surface itself and
 * not a cutter-location field. Columns over nothing get NaN.
 */
export async function surfaceHeightField(mesh: PartMesh, field: ZDexelField): Promise<Float64Array> {
  const kernel = new BvhKernel()
  const meshHandle = kernel.uploadMesh(mesh)
  // The smallest diameter the kernel accepts; at 1e-6 mm the footprint is a
  // point for every purpose in a 0.4 mm grid.
  const cutterHandle = kernel.makeCutter({ kind: 'flat', diameter: 1e-6 })
  const zSeed = mesh.bounds.min[2] - 1e4
  try {
    const out = new Float64Array(field.top.length)
    const dropped = await kernel.dropGrid(meshHandle, cutterHandle, {
      x0: field.originX + field.cell / 2,
      y0: field.originY + field.cell / 2,
      nx: field.nx,
      ny: field.ny,
      dx: field.cell,
      dy: field.cell,
      zSeed,
    })
    for (let index = 0; index < out.length; index++) {
      out[index] = dropped[index] <= zSeed ? Number.NaN : dropped[index]
    }
    return out
  } finally {
    kernel.releaseCutter(cutterHandle)
    kernel.releaseMesh(meshHandle)
  }
}

/** The stock block a part is machined from, as the registry's margins describe it. */
export function stockBoxFor(
  mesh: PartMesh,
  margin: { xy: number; zTop: number },
): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } {
  return {
    minX: mesh.bounds.min[0] - margin.xy,
    minY: mesh.bounds.min[1] - margin.xy,
    minZ: mesh.bounds.min[2],
    maxX: mesh.bounds.max[0] + margin.xy,
    maxY: mesh.bounds.max[1] + margin.xy,
    maxZ: mesh.bounds.max[2] + margin.zTop,
  }
}
