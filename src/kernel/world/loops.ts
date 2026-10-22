// WO-3008 08b (A3-08 algorithm step 5): one outer / hole typing rule.
//
// Today the type a closed loop gets depends on its entry path (BL-209): STL and
// mesh-chain projections and SVG/DXF joins type by containment depth, a raster
// trace and the workholding-reduced pocket region by winding sign, OCCT derives
// by B-rep topology. MD-44 (card V07) would type every source by containment
// depth through the WO-2931 predicates and then orient each loop from its type.
// At parity (policy off) every loop keeps the type its entry path gave it.
import { locatePoint, signedArea } from '../geometry/predicates'
import type { Point } from '../geometry/contracts'
import type { WorldPolicy } from './contracts'

export type LoopType = 'contour' | 'hole' | 'open'

export interface WorldLoop {
  readonly id: string
  readonly points: readonly Point[]
  readonly closed: boolean
  readonly type: LoopType
}

/** The winding-sign rule some entry paths use today: counter-clockwise is an outline. */
export function windingType(points: readonly Point[]): 'contour' | 'hole' {
  return signedArea(points as Point[]) > 0 ? 'contour' : 'hole'
}

/**
 * Containment depth of every closed loop: how many strictly larger closed loops
 * hold its first vertex. Open loops and loops with fewer than 3 points have no depth; a zero-area closed loop of 3+ points still gets one.
 */
export function nestingDepths(loops: readonly WorldLoop[]): Array<number | undefined> {
  const closed = loops.map(loop => loop.closed && loop.points.length >= 3)
  const areas = loops.map(loop => Math.abs(signedArea(loop.points as Point[])))
  return loops.map((loop, i) => {
    if (!closed[i]) return undefined
    let depth = 0
    loops.forEach((other, j) => {
      if (j === i || !closed[j] || areas[j] <= areas[i]) return
      if (locatePoint(loop.points[0], [other.points as Point[]], 'NonZero') === 'inside') depth++
    })
    return depth
  })
}

export interface TypedLoop extends WorldLoop {
  /** The type the entry path gave (kept at parity). */
  readonly enteredAs: LoopType
}

/**
 * The one typing rule. Off (parity): each loop keeps its entry type and points.
 * On (MD-44): even depth is an outline, odd a hole, and the points are reversed
 * where needed so an outline runs counter-clockwise and a hole clockwise.
 */
export function typeLoops(loops: readonly WorldLoop[], policy: WorldPolicy): TypedLoop[] {
  if (!policy.loop_type_from_nesting) return loops.map(loop => ({ ...loop, enteredAs: loop.type }))
  const depths = nestingDepths(loops)
  return loops.map((loop, i) => {
    const depth = depths[i]
    if (depth === undefined) return { ...loop, enteredAs: loop.type }
    const type = depth % 2 === 0 ? 'contour' : 'hole'
    const ccw = signedArea(loop.points as Point[]) > 0
    const points = (type === 'contour') === ccw ? loop.points : [...loop.points].reverse()
    return { ...loop, points, type, enteredAs: loop.type }
  })
}

/** What turning MD-44 on would change, loop by loop: the card's diff list. */
export function loopTypingDiff(loops: readonly WorldLoop[]): Array<{ id: string; off: LoopType; on: LoopType; reversed: boolean }> {
  const on = typeLoops(loops, { rotated_part_placement: false, loop_type_from_nesting: true })
  return loops.flatMap((loop, i) => {
    const reversed = on[i].points !== loop.points
    return loop.type !== on[i].type || reversed ? [{ id: loop.id, off: loop.type, on: on[i].type, reversed }] : []
  })
}
