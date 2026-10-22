// restAir2d.ts - WO-1888: a 2D pass never cuts air an earlier operation of the
// same setup already emptied.
//
// Operator ruling 2026-09-17: "Rest is not an operation type. Rest is a methodology. It
// avoids having to air machine where material was already removed." The 3D
// finishes have had that methodology since WO-1641 (airFeedOverRemovedStock.ts)
// and Facing since WO-1820. This is the same methodology for the 2D pocket and
// contour engines, off the SAME stock source: the StockState the store already
// replays out of the earlier operations' own results (remainingStockBefore,
// WO-1582) and already puts on every 2D worker request for the reach trim. No
// second stock model is built and nothing is refused - with no earlier
// operation the store sends no remaining stock, this never runs, and the output
// is the output it always was.
//
// Two things happen, both provable from the remaining material alone:
//
//  1. A whole PASS whose every move is air - its plunge, ramp or helix entry
//     included - is dropped. The unit is the pass, never part of one: a block is
//     only dropped when it starts at a pass boundary and the next kept move is a
//     rapid, so no kept feed move ever starts from a place the tool is no longer
//     at.
//  2. A feed-rate LINK (a stepover, a loop-back) that is air runs at rapid
//     instead, endpoints untouched - the WO-1641 treatment, for the case where
//     the pass on either side of it still cuts.
//
// The rapids AROUND a dropped pass are left exactly as the engine routed them.
// pocket2d routes rapids around islands (rapidTo(..., clearanceZ) chains), and
// collapsing such a chain onto its last point would cut the routed corner. What
// the drop adds instead is a straight lift: when the tool is below the retract
// plane where the dropped pass began, it goes straight up to it first, which is
// safe from any position, and the engine's own retract-plane traverse takes it
// from there.
//
// Leaving those rapids where they are does NOT leave them where they GO. A
// rapid names an absolute point, so the first one after a dropped pass keeps
// its target but inherits a new START - the place the dropped pass began
// instead of the place it ended - and therefore sweeps a line the engine never
// planned. Where the retract plane sits above the stock that line is air by
// construction, but the app's own Smart heights can put retract and feed BELOW
// the stock top (a retract just above an earlier operation's floor, WO-1609),
// and then the inherited line is a rapid traverse through standing material.
// So the drop proves that line the same way it proves the pass: the swept
// footprint along it, at the lowest Z the traverse can reach, over the
// remaining material. It cannot be proved air, the pass is KEPT and the
// operation cuts air it did not have to - which is the cost side of "missing
// stock is not an option".
//
// "Missing stock is not an option" decides every tie: the cutter footprint is
// tested as its bounding SQUARE, every dexel column the square touches counts,
// and an arc's swept path is not the chord between its endpoints so an arc is
// never judged air at all. Each of those errs toward cutting air that is already
// gone, never toward skipping metal that is still there.

import type { Tool, ToolpathMove } from '../../types'
import type { StockState } from './stockState'
import { highestMaterialOver } from './smartHeights/earlierMaterial'
import { effectiveMoveMotion, effectiveMoveRole, isStockCuttingRole } from './stockCuttingRoles'
import { floorHop } from './moves'

/**
 * How far BELOW the tool a column's material top may read and still count as
 * air, mm. Small on purpose: it absorbs the float32 the dexel field stores its
 * column tops in, nothing more. A pass that skims real material - 0.2 mm left
 * standing at a wall, a floor an earlier op stopped short of - reads material
 * above the cutter and is kept. The conservatism this module needs in XY is
 * bought by the square footprint and by counting every touched column, not by
 * padding this number.
 */
const AIR_TOLERANCE_MM = 1e-3

export interface RestAir2dInput {
  /** The finished 2D toolpath, in the same frame as `remaining` (world). */
  readonly moves: readonly ToolpathMove[]
  readonly tool: Tool
  /** What the earlier operations of the setup left. Same frame as the moves. */
  readonly remaining: StockState
  /** The operation's retract plane (world Z) - where a skipped pass lifts to. */
  readonly retractZ: number
  /** WO-2835: the operation's floor-hop height (mm). An air link at one constant depth runs
   *  as the blended hop (moves/ floorHop) instead of a rapid along the floor. 0 or absent:
   *  the single rapid at depth it always was. */
  readonly floorHopMm?: number
}

export interface RestAir2dResult {
  moves: ToolpathMove[]
  /** Programmed passes in the input path. */
  passes: number
  /** Of those, the ones the remaining material proved air end to end. */
  skippedPasses: number
  /** Feed-rate links demoted to rapid because they only cross emptied space. */
  rapidedLinks: number
  /** Cutting distance the skip removed, mm. */
  cutLengthRemovedMm: number
}

/**
 * The radius of the cutter's swept footprint, or undefined for a tool whose
 * footprint a bounding square around the tip does not describe (a V-bit's
 * flank, a dovetail's undercut). Those tools are left alone entirely.
 */
function sweptRadiusOf(tool: Tool): number | undefined {
  if (!(tool.diameter > 0) || !Number.isFinite(tool.diameter)) return undefined
  switch (tool.type) {
    case 'flat_end_mill':
    case 'face_mill':
    case 'ball_end_mill':
    case 'bull_nose':
      return tool.diameter / 2
    default:
      return undefined
  }
}

/**
 * Nothing the remaining material holds under the cutter footprint reaches `z`.
 *
 * The footprint is the cutter's bounding SQUARE grown by one dexel cell. The
 * pad is not decoration: the field lowers a column when the sweep covers its
 * CENTRE, so a wall skin thinner than a cell - the 0.2 mm a roughing pass left
 * standing, on a 0.5 mm grid - is quantized out of the field entirely, and the
 * pass that was meant to take it would read as air. One cell of reach puts the
 * still-solid column just outside the pocket back under the tool, and the pass
 * is kept. Measured on the WO-1888 fixture: without the pad the whole wall ring
 * of a finishing pocket read air.
 */
function clearsMaterialAt(
  remaining: StockState,
  x: number,
  y: number,
  z: number,
  radius: number,
): boolean {
  const reach = radius + remaining.resolutionMm
  const top = highestMaterialOver(remaining, {
    minX: x - reach, minY: y - reach, maxX: x + reach, maxY: y + reach,
  })
  // Off the block entirely: none of this stock is under the tool.
  if (top === undefined) return true
  return z + AIR_TOLERANCE_MM >= top
}

function segmentIsAir(
  remaining: StockState,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  radius: number,
  step: number,
): boolean {
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z
  const length = Math.hypot(dx, dy, dz)
  const samples = Math.max(1, Math.ceil(length / step))
  for (let sample = 0; sample <= samples; sample++) {
    const t = sample / samples
    if (!clearsMaterialAt(remaining, start.x + dx * t, start.y + dy * t, start.z + dz * t, radius)) {
      return false
    }
  }
  return true
}

/**
 * The lift a drop starting after `from` would insert, or undefined when the
 * tool already stands at or above the retract plane. One definition, used both
 * by the guard that decides the drop and by the emitter, so the Z the guard
 * proves is the Z the emitter travels.
 */
function liftZFor(from: { z: number }, retractZ: number): number | undefined {
  return Number.isFinite(retractZ) && from.z < retractZ - 1e-9 ? retractZ : undefined
}

/**
 * The rapid traverse a drop would hand the engine's next rapid is air.
 *
 * A rapid is not interpolated the way a feed is - the controller may finish Z
 * before XY, or after it - so the only Z this can rely on along the whole XY
 * line is the LOWER of the two ends. Checked there, with the same square
 * footprint and one-cell pad the passes are checked with.
 */
function traverseIsAir(
  remaining: StockState,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  radius: number,
  step: number,
): boolean {
  const z = Math.min(from.z, to.z)
  return segmentIsAir(
    remaining, { x: from.x, y: from.y, z }, { x: to.x, y: to.y, z }, radius, step,
  )
}

function isPassMotion(move: ToolpathMove): boolean {
  return effectiveMoveMotion(move) === 'pass'
}

/**
 * The toolpath with every air-only pass dropped and every air-only feed link
 * demoted to rapid. Passes that touch any remaining material come back exactly
 * as they went in, as does every rapid.
 */
export function skipAirOnlyPasses(input: RestAir2dInput): RestAir2dResult {
  const { moves, tool, remaining, retractZ } = input
  const unchanged: RestAir2dResult = {
    moves: [...moves], passes: 0, skippedPasses: 0, rapidedLinks: 0, cutLengthRemovedMm: 0,
  }
  const radius = sweptRadiusOf(tool)
  if (radius === undefined || moves.length === 0) return unchanged

  const step = Math.max(remaining.resolutionMm / 2, 1e-3)

  // Every programmed pass in the input, so the console line can say "n of m".
  let passes = 0
  for (let index = 0; index < moves.length; index++) {
    if (isPassMotion(moves[index]) && (index === 0 || !isPassMotion(moves[index - 1]))) passes++
  }

  // Air, move by move. Index 0 has no start point, and an arc's swept path is
  // not the straight line between its endpoints - neither is ever judged air.
  const air = new Array<boolean>(moves.length).fill(false)
  const cuts = new Array<boolean>(moves.length).fill(false)
  for (let index = 1; index < moves.length; index++) {
    const move = moves[index]
    cuts[index] = isStockCuttingRole(effectiveMoveRole(move))
    if (!cuts[index] || move.type !== 'feed') continue
    air[index] = segmentIsAir(remaining, moves[index - 1], move, radius, step)
  }

  // Air-only cutting blocks that are whole passes and can be left safely.
  const dropEndAt = new Map<number, number>()
  let skippedPasses = 0
  let cutLengthRemovedMm = 0
  let blockStart = -1
  for (let index = 1; index <= moves.length; index++) {
    const droppable = index < moves.length && cuts[index] && air[index]
    if (droppable) {
      if (blockStart < 0) blockStart = index
      continue
    }
    if (blockStart < 0) continue
    const first = blockStart
    const last = index - 1
    blockStart = -1

    // A block that carries no programmed pass is a bare link - rule 2's job.
    let blockPasses = 0
    for (let at = first; at <= last; at++) {
      if (isPassMotion(moves[at]) && (at === first || !isPassMotion(moves[at - 1]))) blockPasses++
    }
    if (blockPasses === 0) continue
    // Never start inside a pass: the part of it already cut would be orphaned.
    if (isPassMotion(moves[first]) && isPassMotion(moves[first - 1])) continue
    // The next kept move must be positioned absolutely. A feed move would
    // otherwise start from wherever the drop left the tool and cut a line the
    // engine never planned.
    if (last < moves.length - 1 && moves[last + 1].type !== 'rapid') continue
    // ...and that rapid, absolute target and all, would travel a line it never
    // travelled before: from where the dropped pass BEGAN (lifted to the
    // retract plane when the drop lifts) instead of from where it ended. Prove
    // that line air over the remaining material, or keep the pass. Unproved
    // means kept: a rapid through standing stock is the one outcome worse than
    // cutting air.
    if (last < moves.length - 1) {
      const from = moves[first - 1]
      const startZ = liftZFor(from, retractZ) ?? from.z
      if (!traverseIsAir(
        remaining, { x: from.x, y: from.y, z: startZ }, moves[last + 1], radius, step,
      )) continue
    }

    dropEndAt.set(first, last)
    skippedPasses += blockPasses
    for (let at = first; at <= last; at++) {
      const from = moves[at - 1]
      const to = moves[at]
      cutLengthRemovedMm += Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
    }
  }

  /**
   * This air link may run at rapid instead of at feed.
   *
   * `air[]` proved the link as the FEED it is: sampled along the interpolated
   * line, where X, Y and Z advance together. A rapid makes no such promise - a
   * link that steps over while rising or dropping can be at its lower Z
   * anywhere along its XY. Same rule as the traverse a drop re-routes: prove it
   * at the lower end or leave the link cutting air at feed rate. A link at one
   * constant depth - which is nearly all of them - is unaffected either way.
   */
  const airLinkAt = (index: number): boolean => {
    const move = moves[index]
    if (!air[index] || move.type !== 'feed' || effectiveMoveMotion(move) !== 'link') return false
    return traverseIsAir(remaining, moves[index - 1], move, radius, step)
  }

  let hasAirLink = false
  for (let index = 1; index < moves.length; index++) {
    if (airLinkAt(index)) { hasAirLink = true; break }
  }
  if (skippedPasses === 0 && !hasAirLink) return { ...unchanged, passes }

  const out: ToolpathMove[] = []
  let rapidedLinks = 0
  let index = 0
  while (index < moves.length) {
    const end = dropEndAt.get(index)
    if (end !== undefined) {
      // The tool is where the move before the block left it. Lift straight to
      // the retract plane when it is down in the cut; a vertical lift is safe
      // from anywhere, and the engine's own rapids traverse from there.
      const from = moves[index - 1]
      const liftZ = liftZFor(from, retractZ)
      if (liftZ !== undefined) {
        out.push({ type: 'rapid', x: from.x, y: from.y, z: liftZ, role: 'rapid' })
      }
      index = end + 1
      continue
    }
    const move = moves[index]
    if (airLinkAt(index)) {
      // WO-2835: a link at one depth whose start is where the tool stands hops over the
      // floor. The line is proven air at that depth, and the remaining stock is a height
      // field, so everything above the line is air too.
      const from = out[out.length - 1]
      const prior = moves[index - 1]
      const hop = input.floorHopMm ?? 0
      if (hop > 0 && from && from.x === prior.x && from.y === prior.y && from.z === prior.z
        && Math.abs(from.z - move.z) <= 1e-9) {
        floorHop(out, from, move, move.z, Math.min(hop, Math.max(0, input.retractZ - move.z)), true)
      } else {
        out.push({ type: 'rapid', x: move.x, y: move.y, z: move.z, role: 'rapid' })
      }
      rapidedLinks++
    } else {
      out.push(move)
    }
    index++
  }

  return { moves: out, passes, skippedPasses, rapidedLinks, cutLengthRemovedMm }
}

/**
 * Rule 1 as the 2D engines call it: hand it the finished path and whatever the
 * request carried, get back the path with the air passes gone. A request with
 * no remaining stock (nothing earlier in the setup, or a stock the replay could
 * not read) comes straight back out - this is never why a compute fails, and
 * never why one changes shape.
 */
export function applyRestAir2d(
  operation: string,
  moves: ToolpathMove[],
  tool: Tool,
  remaining: StockState | undefined,
  retractZ: number,
  /** The engine's operator-console channel (WO-1540), when it has one. A skip
   *  the operator cannot see is a toolpath that silently got shorter. */
  notify?: (message: string) => void,
  /** WO-2835: the operation's floor-hop height (moves/ resolveFloorHopMm). */
  floorHopMm = 0,
): ToolpathMove[] {
  if (!remaining) return moves
  try {
    const result = skipAirOnlyPasses({ moves, tool, remaining, retractZ, floorHopMm })
    if (result.skippedPasses > 0) {
      const which = result.skippedPasses === result.passes
        ? `every pass (${result.passes}) had`
        : `${result.skippedPasses} of the ${result.passes} passes had`
      const said =
        `${operation}: ${which} nothing to cut - earlier operations in this setup already took ` +
        'that material out - so they were skipped along with their plunge. ' +
        `${result.cutLengthRemovedMm.toFixed(1)} mm less cutting.`
      if (notify) notify(said)
      else console.info(`${said} (WO-1888)`)
    }
    if (result.rapidedLinks > 0) {
      console.info(
        `${operation}: ${result.rapidedLinks} link(s) run at rapid - they only cross space ` +
          'earlier operations already emptied (WO-1888).',
      )
    }
    return result.moves
  } catch (err) {
    console.warn(`${operation}: every pass was kept; earlier operations' material could not be read.`, err)
    return moves
  }
}
