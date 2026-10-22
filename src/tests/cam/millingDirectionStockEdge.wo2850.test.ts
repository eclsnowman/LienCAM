import { expect, it } from 'vitest'
import { planChain } from '../benchmark/chainRunner'
import { ARC_JOIN_TOLERANCE_DEG, pathMetrics } from '../benchmark/metrics'
import { CHAINS } from '../benchmark/registry'
import type { ToolpathMove } from '../../types'

/** WO-3062: a move as the tool travels it -- its entry and exit headings (a line's chord;
 *  an arc's end tangents) and, for an arc, its own signed sweep (+ G3 left, - G2 right). */
function headings(a: ToolpathMove, b: ToolpathMove) {
  if ((b.type !== 'arc_cw' && b.type !== 'arc_ccw') || b.cx === undefined || b.cy === undefined) {
    const dx = b.x - a.x, dy = b.y - a.y
    return { entry: [dx, dy], exit: [dx, dy], arc: false, turn: 0, degenerate: Math.hypot(dx, dy) <= 1e-9 }
  }
  const side = b.type === 'arc_cw' ? -1 : 1
  const r0x = a.x - b.cx, r0y = a.y - b.cy, r1x = b.x - b.cx, r1y = b.y - b.cy
  const a0 = Math.atan2(r0y, r0x)
  let a1 = Math.atan2(r1y, r1x)
  if (side < 0) { while (a1 > a0) a1 -= 2 * Math.PI } else { while (a1 < a0) a1 += 2 * Math.PI }
  const sweep = Math.abs(a1 - a0) < 1e-12 ? 2 * Math.PI : Math.abs(a1 - a0)
  return { entry: [-side * r0y, side * r0x], exit: [-side * r1y, side * r1x], arc: true, turn: side * sweep,
    degenerate: Math.hypot(r0x, r0y) <= 1e-9 || Math.hypot(r1x, r1y) <= 1e-9 }
}

it('WO-2850 production boss rough preserves milling direction without stock-edge wobble', async () => {
  const chain = CHAINS.find(c => c.id === 'boss-taper-step-rough-finish')!
  const { steps: [rough] } = await planChain({ ...chain, steps: chain.steps.slice(0, 1) })
  const metrics = pathMetrics(rough.moves)
  // Sign changes of small (< 5 deg) turns between consecutive cut moves at one Z. WO-3062:
  // the turns are read as the stick reads them (metrics.ts flipMetrics, WO-3036/WO-3056):
  // tangent to tangent across a join, an arc is one turn of its own sweep, a join touching
  // an arc turns only past ARC_JOIN_TOLERANCE_DEG, and a full reversal reads as +180 deg.
  // Reading an arc as its chord scored the arc's own curvature as heading wobble.
  const arcEps = ARC_JOIN_TOLERANCE_DEG * Math.PI / 180
  let small = 0, sign = 0
  const turn = (angle: number, floor: number): void => {
    if (Math.abs(angle) <= floor) return
    if (sign && Math.sign(angle) !== sign && Math.abs(angle) < 5 * Math.PI / 180) small++
    sign = Math.sign(angle)
  }
  for (let i = 2; i < rough.moves.length; i++) {
    const [a, b, c] = rough.moves.slice(i - 2, i + 1)
    if (c.type === 'rapid' || c.role !== 'cut' || Math.abs(c.z - b.z) >= 1e-6) {
      sign = 0
      continue
    }
    const before = headings(a, b), here = headings(b, c)
    if (!before.degenerate && !here.degenerate) {
      const [ex, ey] = before.exit, [nx, ny] = here.entry
      const raw = Math.atan2(ex * ny - ey * nx, ex * nx + ey * ny)
      turn(Math.abs(raw) > Math.PI - arcEps ? Math.PI : raw, before.arc || here.arc ? arcEps : 1e-12)
    }
    if (here.arc && !here.degenerate) turn(here.turn, 1e-12)
  }
  console.log('WO-2850 production boss', JSON.stringify({ ...metrics, small, cycleMs: rough.cutTimeMs }))
  // The original WO-2169 limits, not repinned to a new baseline.
  expect.soft(metrics.flipRatePct).toBeLessThanOrEqual(10)
  expect.soft(small).toBeLessThanOrEqual(40)
  expect(metrics.retracts).toBeLessThanOrEqual(4)
  expect(rough.cutTimeMs).toBeLessThan(391739 * .7)
}, 300_000)
