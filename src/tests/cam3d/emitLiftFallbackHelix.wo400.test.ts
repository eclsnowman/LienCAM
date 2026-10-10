// WO-400: a lift landing the planner accepted as a straight descent, but whose shaft the LIVE
// carved stock says is not clear (more than the 5%-of-cutter-face allowance, never less than
// one cell), descends via the planner's fallbackHelix instead of throwing the whole operation
// away. When the shaft IS clear the plunge is emitted exactly as before
// (byte-identical), and with no fallback the refusal is unchanged (the safety gate itself is
// never weakened).
import { describe, expect, it } from 'vitest'

import type { AdaptivePass } from '../../cam3d/rough/engineEntry'
import { emitLevelPasses, type EmitContext } from '../../cam3d/rough/emit'
import { ZDexelField, removeSweep } from '../../cam3d/stock'
import type { CutterSpec } from '../../cam3d/kernel/types'

const CUTTER: CutterSpec = { kind: 'flat', diameter: 6 }
const BOUNDS = { minX: 0, minY: 0, minZ: 0, maxX: 60, maxY: 60, maxZ: 16 }
const HEIGHTS = { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 }
const Z = 12

const ENTRY = { x: 15, y: 30 }
const LANDING = { x: 40, y: 30 }
const FALLBACK = { center: { x: 41.5, y: 30 }, radius: 1.5 }

function passes(withFallback: boolean): AdaptivePass[] {
  const link: Extract<AdaptivePass, { type: 'link' }> = {
    type: 'link',
    points: [{ x: 22, y: 30 }, LANDING],
    jumpType: 2,
  }
  if (withFallback) link.fallbackHelix = FALLBACK
  return [
    { type: 'entry', point: ENTRY, radius: 1.5, mode: 'helix' },
    { type: 'cut', points: [{ x: 15, y: 30 }, { x: 22, y: 30 }] },
    link,
    { type: 'cut', points: [LANDING, { x: 48, y: 30 }] },
  ]
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

describe('WO-400 lift landing: live stock decides between plunge and the planner fallback helix', () => {
  it('a landing shaft the live stock has NOT cleared descends via the fallback helix', () => {
    const stock = ZDexelField.fromBox(BOUNDS, 0.5)
    const moves = emitLevelPasses(passes(true), Z, HEIGHTS, ctxWith(stock))
    const landingIndex = moves.findIndex(
      (m) => m.role === 'cut' && Math.abs(m.x - 48) < 1e-9 && Math.abs(m.y - 30) < 1e-9,
    )
    expect(landingIndex).toBeGreaterThan(0)
    // Between the first cut and the second there is a helix ramp (many 'ramp' feed moves
    // spiralling to Z) and no plunge feed at the landing.
    const firstCutEnd = moves.findIndex(
      (m) => m.role === 'cut' && Math.abs(m.x - 22) < 1e-9 && Math.abs(m.y - 30) < 1e-9,
    )
    expect(firstCutEnd).toBeGreaterThan(0)
    const between = moves.slice(firstCutEnd + 1, landingIndex)
    const ramps = between.filter((m) => m.t === 'feed' && m.role === 'ramp')
    expect(ramps.length).toBeGreaterThan(24)
    expect(ramps.some((m) => Math.abs(m.z - Z) < 1e-9)).toBe(true)
    expect(between.some((m) => m.role === 'plunge' && Math.abs(m.x - LANDING.x) < 1e-9)).toBe(false)
    // The helix stays on its planned circle: every ramp point is within radius of the centre.
    for (const m of ramps) {
      const d = Math.hypot(m.x - FALLBACK.center.x, m.y - FALLBACK.center.y)
      expect(d).toBeLessThanOrEqual(FALLBACK.radius + 1e-6)
    }
  })

  it('the same landing with NO fallback still refuses loudly (gate unchanged)', () => {
    const stock = ZDexelField.fromBox(BOUNDS, 0.5)
    expect(() => emitLevelPasses(passes(false), Z, HEIGHTS, ctxWith(stock))).toThrow(
      /refusing a straight plunge through remaining stock/,
    )
  })

  it('a sliver under the cutter edge within the 5% face allowance still plunges (Operator 2026-08-19)', () => {
    // A prior pass opened the shaft 0.15 mm off the landing: a thin crescent of the
    // cutter face is still standing. That is rounding-sized, not a wall.
    const stock = ZDexelField.fromBox(BOUNDS, 0.5)
    removeSweep(stock, { x0: LANDING.x - 0.15, y0: LANDING.y, z0: 16, x1: LANDING.x - 0.15, y1: LANDING.y, z1: Z }, CUTTER)
    const moves = emitLevelPasses(passes(true), Z, HEIGHTS, ctxWith(stock))
    const plunge = moves.find((m) => m.role === 'plunge' && Math.abs(m.x - LANDING.x) < 1e-9)
    expect(plunge).toBeDefined()
    expect(moves.some((m) => m.role === 'ramp' && Math.abs(m.z - Z) < 1e-9
      && Math.hypot(m.x - FALLBACK.center.x, m.y - FALLBACK.center.y) < FALLBACK.radius + 1e-6)).toBe(false)
  })

  it('a strip of the face well over the allowance goes to the fallback helix', () => {
    const stock = ZDexelField.fromBox(BOUNDS, 0.5)
    removeSweep(stock, { x0: LANDING.x - 1.2, y0: LANDING.y, z0: 16, x1: LANDING.x - 1.2, y1: LANDING.y, z1: Z }, CUTTER)
    const moves = emitLevelPasses(passes(true), Z, HEIGHTS, ctxWith(stock))
    expect(moves.some((m) => m.role === 'plunge' && Math.abs(m.x - LANDING.x) < 1e-9)).toBe(false)
    expect(moves.some((m) => m.role === 'ramp' && Math.abs(m.z - Z) < 1e-9
      && Math.hypot(m.x - FALLBACK.center.x, m.y - FALLBACK.center.y) < FALLBACK.radius + 1e-6)).toBe(true)
  })

  it('a landing shaft the live stock HAS cleared plunges exactly as before (fallback unused)', () => {
    const cleared = (): ZDexelField => {
      const stock = ZDexelField.fromBox(BOUNDS, 0.5)
      // A prior pass already opened the landing disk down to this level.
      removeSweep(stock, { x0: LANDING.x, y0: LANDING.y, z0: 16, x1: LANDING.x, y1: LANDING.y, z1: Z }, CUTTER)
      return stock
    }
    const withFallback = emitLevelPasses(passes(true), Z, HEIGHTS, ctxWith(cleared()))
    const without = emitLevelPasses(passes(false), Z, HEIGHTS, ctxWith(cleared()))
    expect(JSON.stringify(withFallback)).toBe(JSON.stringify(without))
    expect(withFallback.some((m) => m.role === 'ramp' && Math.abs(m.z - Z) < 1e-9
      && Math.hypot(m.x - FALLBACK.center.x, m.y - FALLBACK.center.y) < FALLBACK.radius + 1e-6)).toBe(false)
  })
})
