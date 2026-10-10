// WO-409 part 2: a keep-down link (jumpType 1) the planner believes runs through cleared
// stock is measured against the LIVE carved field by the emitter. Where it would plough
// more than half a slot it is taken as pecked bites (advance <= 0.75 mm, retreat through
// the groove just cut, advance to the next bite, the last running on to the link end), so
// every 2 mm window of the published path holds at most one bite of fresh material. A link
// the live stock shows clear is emitted exactly as before (one feed, role 'stepover').
import { describe, expect, it } from 'vitest'

import type { AdaptivePass } from '../../cam3d/rough/engineEntry'
import { emitLevelPasses, type EmitContext } from '../../cam3d/rough/emit'
import { ZDexelField, removeSweep } from '../../cam3d/stock'
import type { CutterSpec } from '../../cam3d/kernel/types'

const CUTTER: CutterSpec = { kind: 'flat', diameter: 6 }
const BOUNDS = { minX: 0, minY: 0, minZ: 0, maxX: 60, maxY: 60, maxZ: 16 }
const HEIGHTS = { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 }
const Z = 12

function ctxWith(stock: ZDexelField): EmitContext {
  return {
    cursor: { x: NaN, y: NaN, z: HEIGHTS.clearanceZ },
    toolRadius: CUTTER.diameter / 2,
    stock,
    cutter: CUTTER,
    stockProven: true,
    millingDirection: 'climb',
  }
}

// entry -> cut to A -> keep-down link A -> B (2 mm) -> cut on from B.
const A = { x: 22, y: 30 }
const B = { x: 24, y: 30 }
const PASSES: AdaptivePass[] = [
  { type: 'entry', point: { x: 15, y: 30 }, radius: 1.5, mode: 'helix' },
  { type: 'cut', points: [{ x: 15, y: 30 }, A] },
  { type: 'link', points: [A, B], jumpType: 1 },
  { type: 'cut', points: [B, { x: 30, y: 30 }] },
]

const stepovers = (moves: ReturnType<typeof emitLevelPasses>) => moves.filter((m) => m.role === 'stepover')

describe('WO-409 keep-down links are pecked where the live stock says they would plough', () => {
  it('a link through standing stock becomes bites with retreats, on the same line', () => {
    const stock = ZDexelField.fromBox(BOUNDS, 0.5) // full block: the link's crescent is all material
    const moves = emitLevelPasses(PASSES, Z, HEIGHTS, ctxWith(stock))
    const so = stepovers(moves)
    // 2 mm link, 0.75 mm bites: bite 1 (0.75), back to A, bite 2 (1.5), back to A, then A -> B.
    expect(so.length).toBe(5)
    expect(so.map((m) => Number(m.x.toFixed(3)))).toEqual([22.75, 22, 23.5, 22, 24])
    for (const m of so) {
      expect(m.t).toBe('feed')
      expect(m.z).toBe(Z)
      expect(m.y).toBe(30)
    }
    // The cut after the link still starts from B.
    const after = moves[moves.indexOf(so[so.length - 1]) + 1]
    expect(after.role).toBe('cut')
    expect(after.x).toBe(30)
  })

  it('a link over stock the live field shows cleared is one plain keep-down feed (unchanged)', () => {
    const stock = ZDexelField.fromBox(BOUNDS, 0.5)
    // Clear the corridor the link runs through, down to Z, before emitting.
    removeSweep(stock, { x0: 10, y0: 30, z0: Z, x1: 35, y1: 30, z1: Z }, CUTTER)
    const moves = emitLevelPasses(PASSES, Z, HEIGHTS, ctxWith(stock))
    const so = stepovers(moves)
    expect(so.length).toBe(1)
    expect(so[0].x).toBe(B.x)
  })
})
