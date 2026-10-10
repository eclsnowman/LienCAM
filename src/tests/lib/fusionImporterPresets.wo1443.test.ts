// WO-1443: fusion import kept only the first named cutting preset, discarding
// every other preset in start-values.presets[]. Tool.feedsAndSpeeds is already
// Record<string, FeedsAndSpeeds> — the domain model supports multiple named
// presets. These tests prove importFusionTools maps every preset into its own
// entry while 'default' keeps pointing at the first preset (additive, no
// migration needed for existing single-preset imports).

import { describe, it, expect } from 'vitest'
import { importFusionTools } from '../../lib/fusionImporter'

function mkWithPresets(presets: Record<string, unknown>[]): unknown {
  return {
    description: 'flat end mill test',
    type: 'flat end mill',
    unit: 'millimeters',
    geometry: { DC: 6 },
    'start-values': { presets },
  }
}

describe('fusionImporter multi-preset import (WO-1443)', () => {
  it('two named presets: both survive as distinct, non-equal entries', () => {
    const [t] = importFusionTools([
      mkWithPresets([
        { name: 'Roughing',  n: 18000, v_f: 2000, v_f_ramp: 500,  'tool-coolant': 'flood' },
        { name: 'Finishing', n: 24000, v_f: 800,  v_f_ramp: 200,  'tool-coolant': 'mist' },
      ]),
    ]).tools

    const keys = Object.keys(t.feedsAndSpeeds)
    expect(keys.length).toBeGreaterThanOrEqual(2)

    const roughing = t.feedsAndSpeeds['Roughing']
    const finishing = t.feedsAndSpeeds['Finishing']
    expect(roughing).toBeDefined()
    expect(finishing).toBeDefined()
    expect(roughing.rpm).toBe(18000)
    expect(finishing.rpm).toBe(24000)
    expect(roughing.coolant).toBe('flood')
    expect(finishing.coolant).toBe('mist')
    expect(roughing).not.toEqual(finishing)
  })

  it('default still resolves to the first preset\'s values', () => {
    const [t] = importFusionTools([
      mkWithPresets([
        { name: 'Roughing',  n: 18000, v_f: 2000 },
        { name: 'Finishing', n: 24000, v_f: 800 },
      ]),
    ]).tools

    expect(t.feedsAndSpeeds.default).toBeDefined()
    expect(t.feedsAndSpeeds.default.rpm).toBe(18000)
    expect(t.feedsAndSpeeds.default.feedRate).toBe(2000)
  })

  it('an unnamed preset among named ones falls back to a stable preset-N key', () => {
    const [t] = importFusionTools([
      mkWithPresets([
        { name: 'Roughing', n: 18000, v_f: 2000 },
        { n: 9000, v_f: 400 },
      ]),
    ]).tools

    expect(t.feedsAndSpeeds['preset-2']).toBeDefined()
    expect(t.feedsAndSpeeds['preset-2'].rpm).toBe(9000)
  })

  it('single preset (the common case): imports exactly as before — one entry, no key churn', () => {
    const [t] = importFusionTools([
      mkWithPresets([{ name: 'Only', n: 12000, v_f: 1200 }]),
    ]).tools

    expect(Object.keys(t.feedsAndSpeeds)).toEqual(['default'])
    expect(t.feedsAndSpeeds.default.rpm).toBe(12000)
  })

  it('a preset literally named "default" does not overwrite the default alias (audit probe 1)', () => {
    const [t] = importFusionTools([
      mkWithPresets([
        { name: 'Rough',   n: 18000 },
        { name: 'default', n: 9000 },
      ]),
    ]).tools

    // 'default' must still hold the FIRST preset's values, not the second.
    expect(t.feedsAndSpeeds.default.rpm).toBe(18000)
    expect(t.feedsAndSpeeds['Rough'].rpm).toBe(18000)

    // The second preset (whose own name collided with the reserved 'default' key)
    // must still be present somewhere under its own entry, not dropped.
    const keys = Object.keys(t.feedsAndSpeeds)
    const survivors = keys.filter((k) => t.feedsAndSpeeds[k].rpm === 9000)
    expect(survivors.length).toBe(1)
    expect(keys.length).toBe(3)
  })

  it('repeated preset names each keep their own entry, none overwritten (audit probe 2)', () => {
    const [t] = importFusionTools([
      mkWithPresets([
        { name: 'Alu', n: 18000 },
        { name: 'Alu', n: 9000 },
        { name: 'Alu', n: 4000 },
      ]),
    ]).tools

    const rpms = Object.values(t.feedsAndSpeeds).map((f) => f.rpm).sort((a, b) => a - b)
    // default (aliasing the first Alu) + 3 distinct Alu entries = 4 keys, and all
    // three original rpm values (18000, 9000, 4000) must survive - none overwritten.
    expect(Object.keys(t.feedsAndSpeeds).length).toBe(4)
    expect(rpms).toEqual([4000, 9000, 18000, 18000])
    expect(t.feedsAndSpeeds.default.rpm).toBe(18000)
  })

  it('zero presets: falls back to the existing generic default feeds (unchanged)', () => {
    const [t] = importFusionTools([mkWithPresets([])]).tools

    expect(Object.keys(t.feedsAndSpeeds)).toEqual(['default'])
    expect(t.feedsAndSpeeds.default).toEqual({
      rpm: 10000,
      feedRate: 1000,
      plungeRate: 300,
      depthOfCut: 6 * 0.25,
      stepover: 6 * 0.5,
    })
  })
})
