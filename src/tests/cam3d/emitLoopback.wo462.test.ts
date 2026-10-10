// WO-462: a loopback pass must be emittable in 3D.
//
// WO-438 gave the 2D planner a routed keep-down ride and emits it as a LOOPBACK. The
// 3D emitter mapped that pass onto a FEED move carrying role 'rapid' -- a shape the L6
// boundary refuses, because a move at cutting depth with no resolvable commanded rate
// must never reach a machine (toToolpathMoves.ts). Every Adaptive 3D operation whose
// plan contained a loopback therefore died with
//
//   irToToolpathMoves: non-rapid move N has rapid role and no explicit feed.
//
// The fix is the ROLE, not the contract: 'stepover' -- the same at-depth, bounded-bite
// category this emitter already gives the jumpType-1 keep-down link. It resolves through
// IR_ROLE_TO_RATE to the operation's cutting feed, which is the conservative rate for a
// ride bounded at ONE ENGAGE-BAND BITE (4-7x tighter than the cutting-role cap). The
// contract itself is untouched, and the last test here pins that it still refuses the
// old shape.
import { describe, expect, it, vi } from 'vitest'

import type { AdaptivePass } from '../../cam3d/rough/engineEntry'
import { emitLevelPasses, type EmitContext } from '../../cam3d/rough/emit'
import { irToToolpathMoves, type ResolvedIrFeedrates } from '../../cam3d/ir/toToolpathMoves'
import type { IrMove } from '../../cam3d/ir/types'
import { ZDexelField, removeSweep } from '../../cam3d/stock'
import type { CutterSpec } from '../../cam3d/kernel/types'

const CUTTER: CutterSpec = { kind: 'flat', diameter: 6 }
const BOUNDS = { minX: 0, minY: 0, minZ: 0, maxX: 60, maxY: 60, maxZ: 16 }
const HEIGHTS = { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 }
const Z = 12

const FEEDS: ResolvedIrFeedrates = {
  feedRate: 900,
  plungeRate: 120,
  rampRate: 300,
  leadInRate: 450,
  leadOutRate: 450,
  finishRate: 600,
}

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

// entry -> cut out to A -> loopback A -> B (the turnaround) -> cut on from B.
const A = { x: 25, y: 30 }
const B = { x: 25, y: 34 }
const PASSES: AdaptivePass[] = [
  { type: 'entry', point: { x: 15, y: 30 }, radius: 1.5, mode: 'helix' },
  { type: 'cut', points: [{ x: 15, y: 30 }, A] },
  { type: 'loopback', points: [A, { x: 27, y: 32 }, B] },
  { type: 'cut', points: [B, { x: 15, y: 34 }] },
]

/** A block with the whole loopback corridor already carved away at Z -- the ground the
 *  planner's traverse bound says a loopback rides over. */
function clearedStock(): ZDexelField {
  const stock = ZDexelField.fromBox(BOUNDS, 0.5)
  removeSweep(stock, { x0: 12, y0: 30, z0: Z, x1: 29, y1: 30, z1: Z }, CUTTER)
  removeSweep(stock, { x0: 29, y0: 30, z0: Z, x1: 29, y1: 34, z1: Z }, CUTTER)
  removeSweep(stock, { x0: 29, y0: 34, z0: Z, x1: 12, y1: 34, z1: Z }, CUTTER)
  return stock
}

const loopbackMoves = (moves: readonly IrMove[]): IrMove[] =>
  moves.filter((m) => m.role === 'stepover')

describe('WO-462 a loopback is emittable in 3D', () => {
  it('emits the ride as a feed at depth whose rate the L6 boundary can resolve', () => {
    const moves = emitLevelPasses(PASSES, Z, HEIGHTS, ctxWith(clearedStock()))
    const ride = loopbackMoves(moves)
    expect(ride.map((m) => [m.x, m.y])).toEqual([[27, 32], [25, 34]])
    for (const m of ride) {
      // Not a rapid: it may meet its terminal engage bite, so it is commanded motion.
      expect(m.t).toBe('feed')
      // Held at the cutting depth -- this is WO-438's keep-down property, not a lift.
      expect(m.z).toBe(Z)
    }

    // THE DEFECT, converted: the whole level goes through the boundary without throwing,
    // and the ride posts at the operation's cutting feed.
    const posted = irToToolpathMoves({ moves, meta: { strategyId: 's', cutterId: 'c' } }, FEEDS)
    const postedRide = posted.filter((m) => m.role === 'stepover')
    expect(postedRide).toHaveLength(2)
    for (const m of postedRide) {
      expect(m.type).toBe('feed')
      expect(m.feed).toBe(FEEDS.feedRate)
    }
  })

  it('leaves no feed move carrying a rapid role anywhere in the level', () => {
    const moves = emitLevelPasses(PASSES, Z, HEIGHTS, ctxWith(clearedStock()))
    expect(moves.filter((m) => m.t !== 'rapid' && m.role === 'rapid')).toEqual([])
  })

  it('names the ride when the live field disagrees with the planner bound', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A full block: the "already-cleared" ground is solid stock, so the ride ploughs.
      emitLevelPasses(PASSES, Z, HEIGHTS, ctxWith(ZDexelField.fromBox(BOUNDS, 0.5)))
      const said = warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('[loopback]'))
      expect(said).toHaveLength(1)
      expect(said[0]).toContain('WO-462')
    } finally {
      warn.mockRestore()
    }
  })

  it('stays quiet over ground the live field shows cleared', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      emitLevelPasses(PASSES, Z, HEIGHTS, ctxWith(clearedStock()))
      expect(warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('[loopback]'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('the boundary still refuses the shape this WO replaced (contract untouched)', () => {
    const oldShape: IrMove[] = [
      { t: 'rapid', x: 0, y: 0, z: 20, role: 'rapid' },
      { t: 'feed', x: 5, y: 0, z: Z, role: 'rapid' },
    ]
    expect(() =>
      irToToolpathMoves({ moves: oldShape, meta: { strategyId: 's', cutterId: 'c' } }, FEEDS),
    ).toThrow(/non-rapid move 1 has rapid role and no explicit feed/)
  })
})
