// OPT-IN outside-in ("side entry") isolation test. Proves the clearedSeed param is:
//   - a strict NO-OP when absent / explicitly undefined (byte-identical OFF path),
//   - a working outside-in first entry (mode 'side', frontier grows inward) when the
//     seed abuts the machinable region,
//   - deterministic, and
//   - a no-op again when the seed does NOT abut the region (closed pocket).

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, intersection, netArea, type Loop, type Loops } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

describe('processFeature side entry (opt-in outside-in)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  const feat = { boundary: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }] as Loop }
  const params = { toolRadius: 3, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0 }
  // Rectangle covering everything with y<=15 (the square's inward-offset cut region spans
  // ~y 3..37), pre-clearing its bottom band and abutting the frontier near y~15.
  const clearedSeed: Loops = [[{ x: -20, y: -20 }, { x: 60, y: -20 }, { x: 60, y: 15 }, { x: -20, y: 15 }]]

  it('OFF: default interior entry (no clearedSeed)', () => {
    const res = processFeature(feat, params)
    expect(res.startPoint).not.toBeNull()
    expect(res.entries.length).toBeGreaterThanOrEqual(1)
    expect(res.entries[0].mode).not.toBe('side')
  }, 60_000)

  it('OFF byte-identical with explicit undefined', () => {
    const a = processFeature(feat, params)
    const b = processFeature(feat, { ...params, clearedSeed: undefined })
    expect(b).toEqual(a)
  }, 60_000)

  it('ON: side entry over clearedSeed', () => {
    const res = processFeature(feat, { ...params, clearedSeed })
    expect(res.entries[0].mode).toBe('side')
    expect(res.startPoint).not.toBeNull()
    expect(res.passes.some(p => p.type === 'cut')).toBe(true)

    const covered = netArea(intersection(res.cleared, res.cutRegion))
    const total = Math.abs(netArea(res.cutRegion))
    const ratio = covered / total
    console.log('side-entry coverage', ratio)
    expect(covered).toBeGreaterThanOrEqual(0.95 * total)
  }, 60_000)

  it('ON: deterministic', () => {
    const runA = processFeature(feat, { ...params, clearedSeed })
    const runB = processFeature(feat, { ...params, clearedSeed })
    expect(runA).toEqual(runB)
  }, 60_000)

  it('ON but non-abutting => no-op', () => {
    const clearedSeed2: Loops = [[{ x: -120, y: -120 }, { x: -80, y: -120 }, { x: -80, y: -90 }, { x: -120, y: -90 }]]
    const res = processFeature(feat, { ...params, clearedSeed: clearedSeed2 })
    expect(res.entries[0].mode).not.toBe('side')
  }, 60_000)
})
