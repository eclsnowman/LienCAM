// WO-3028: 3D adaptive entries start at the material under the tool, not the
// stock top (WO-3019 items 4-5, Mission Control card A; the operator 2026-10-21 "Build
// all four").
//
// On the Form box the later helix entries started at Z45.05 (the stock top) to
// reach Z36 although the level above was cleared to Z39: 35.6 of each 53.6 mm
// ramp fed through air. The hover reading the entry used counts a column when
// the cutter disk overlaps its CELL, and the square stock's uncut corner cells
// (Z45) sit under the cutter's edge beside the corner helixes. With
// ADAPTIVE_ENTRY_POLICY.entriesAtMaterial on, the ramp starts above the
// material the cutter really meets sweeping the ring, read the way the field
// carves and the traverse guard proves; an entry whose descent and passes
// remove nothing is dropped. This test runs the stick's form-box default row
// through the production chain runner (store computeOperationToolpath) with the
// switch on and judges it with the stick's own collectors:
//   - M-AIR-2 (air time as a share of the cycle) drops from 31.6 % to <= 20 %,
//   - M-SAFE-2 = 0 (no rapid into material) and M-ENTRY-1 = 0 (no plunge at
//     cutting feed) stay hard passes,
//   - the cycle time estimate goes down.
// The switch ships ON since WO-3050 (the operator's yes on the before/after); with it
// off the path is the pre-WO-3028 path (P0 parity in src/tests/evidence/WO-3028/).
import { afterAll, describe, expect, it } from 'vitest'

import { ADAPTIVE_ENTRY_POLICY, emitLevelPasses, type EmitContext } from '../../cam3d/rough/emit'
import type { AdaptivePass } from '../../cam3d/rough/engineEntry'
import { ZDexelField, removeSweep } from '../../cam3d/stock'
import type { CutterSpec } from '../../cam3d/kernel/types'
import { planChain, scoreChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/alpha3Registry'

/** The pre-WO-3028 form-box default row (WO-3019 metrics/form-box-default.rows.json). */
const BEFORE = { airPct: 31.55413, cutTimeMs: 222519.715446 }

const CUTTER: CutterSpec = { kind: 'flat', diameter: 6 }
const HEIGHTS = { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 }
const Z = 12

function ctxWith(stock: ZDexelField): EmitContext {
  return {
    cursor: { x: 5, y: 5, z: HEIGHTS.clearanceZ },
    toolRadius: CUTTER.diameter / 2,
    stock,
    cutter: CUTTER,
    stockProven: true,
    millingDirection: 'climb',
  }
}

const value = (metric: unknown): number => {
  expect(typeof metric, JSON.stringify(metric)).toBe('number')
  return metric as number
}

describe('WO-3028 3D adaptive entries start at the material under the tool', () => {
  afterAll(() => { ADAPTIVE_ENTRY_POLICY.entriesAtMaterial = true })

  it('ships with the switch on (WO-3050)', () => {
    expect(ADAPTIVE_ENTRY_POLICY.entriesAtMaterial).toBe(true)
  })

  it('drops an entry whose descent and passes cut nothing, and keeps one that cuts', () => {
    // A 60 x 60 block, 16 tall; everything left of x = 36 already cleared to Z.
    const fresh = (): ZDexelField => {
      const stock = ZDexelField.fromBox({ minX: 0, minY: 0, minZ: 0, maxX: 60, maxY: 60, maxZ: 16 }, 0.5)
      for (let y = 0; y <= 60; y += 2) removeSweep(stock, { x0: -3, y0: y, z0: Z, x1: 33, y1: y, z1: Z }, CUTTER)
      return stock
    }
    const passes: AdaptivePass[] = [
      // A visit inside the cleared ground: nothing to cut.
      { type: 'entry', point: { x: 15, y: 30 }, radius: 1.5, mode: 'helix' },
      { type: 'cut', points: [{ x: 15, y: 30 }, { x: 20, y: 30 }] },
      { type: 'link', points: [{ x: 20, y: 30 }, { x: 20, y: 34 }], jumpType: 1 },
      { type: 'cut', points: [{ x: 20, y: 34 }, { x: 15, y: 34 }] },
      // A visit into standing stock: kept.
      { type: 'entry', point: { x: 48, y: 30 }, radius: 1.5, mode: 'helix' },
      { type: 'cut', points: [{ x: 48, y: 30 }, { x: 52, y: 30 }] },
    ]
    const off = emitLevelPasses(passes, Z, HEIGHTS, { ...ctxWith(fresh()), entriesAtMaterial: false })
    expect(off.some(m => m.x === 20 && m.y === 34)).toBe(true)

    const on = emitLevelPasses(passes, Z, HEIGHTS, { ...ctxWith(fresh()), entriesAtMaterial: true })
    // Nothing of the empty visit is left, the cutting one is emitted whole.
    expect(on.filter(m => m.x < 30 && m.role !== 'rapid').length).toBe(0)
    expect(on.some(m => m.x === 52 && m.y === 30 && m.z === Z && m.role === 'cut')).toBe(true)
    expect(on.filter(m => m.role === 'ramp').length).toBeGreaterThan(0)
  })

  it('form-box default: entries no longer feed through air, no rapid into material, no plunge at cutting feed', async () => {
    ADAPTIVE_ENTRY_POLICY.entriesAtMaterial = true
    const full = alpha3Chains().find(c => c.id === 'form-box-default')!
    const chain = { ...full, steps: full.steps.filter(step => step.type === 'adaptive_3d').slice(0, 1) }
    const planned = await planChain(chain)
    expect(planned.steps[0].status).toBe('ready')
    const scored = await scoreChain(chain, planned)
    const row = scored.rows.find(r => r.opType === 'adaptive_3d')!
    expect(row.status).toBe('ready')
    const m = row.metrics as Record<string, unknown>
    expect(value(m['M-SAFE-2'])).toBeLessThanOrEqual(1e-3)
    expect(value(m['M-ENTRY-1'])).toBe(0)
    expect(value(m['M-AIR-2'])).toBeLessThanOrEqual(20)
    expect(value(m.cutTimeMs)).toBeLessThan(BEFORE.cutTimeMs)
  }, 1_800_000)
})
