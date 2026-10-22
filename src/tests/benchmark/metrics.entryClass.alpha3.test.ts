import { describe, expect, it } from 'vitest'
import { bounds, control, move, tool } from './alpha3CollectorControls'
import { ZDexelField } from '../../cam3d/stock'

describe('WO-2902 entries at entry stock state', () => {
  it('classes outside, cleared, helix, ramp and full-feed plunge as 1/2/3/4/X', () => {
    const park = (x: number, y: number, z: number) => move(x, y, z, { type: 'rapid', role: 'rapid' })
    const outside = control([park(-3, 5, -1), move(5, 5, -1)])
    expect(outside.observations.entries[0].class).toBe('outside')
    const helix = control([park(5, 5, 0), move(5, 5, -1, { type: 'arc_ccw', cx: 6, cy: 5, role: 'helix', feed: 200 })])
    expect(helix.observations.entries[0].class).toBe('helix')
    expect(helix.metrics['M-ENTRY-2']).toBeCloseTo(Math.atan(1 / (2 * Math.PI)) * 180 / Math.PI, 6)
    expect(control([park(5, 5, 0), move(15, 5, -1, { role: 'ramp', feed: 200 })]).observations.entries[0].class).toBe('ramp')
    const plunge = [park(5, 5, 0), move(5, 5, -1, { role: 'plunge' })]
    expect(control(plunge).observations.entries[0].class).toBe('X')
    expect(control(plunge).metrics['M-ENTRY-1']).toBe(1)
    const field = ZDexelField.fromBox(bounds, 0.1); field.top.fill(-2)
    const clear = control(plunge, { stock: { field, bounds, cutter: { kind: 'flat', diameter: 2 } } })
    expect(clear.observations.entries[0].class).toBe('cleared')
    expect(clear.metrics['M-ENTRY-1']).toBe(0)
  })
  it('detects a solid straight descent even when the planner labels it as a continuing cut', () => {
    const path = [move(5, 5, 0, { type: 'rapid', role: 'rapid' }), move(10, 5, -1), move(10, 5, -2)]
    expect(control(path).metrics['M-ENTRY-1']).toBe(1)
  })
  it('scores a documented slow plunge only with centre-cutting and alternative-fit evidence; excludes drills', () => {
    const plunge = [move(5, 5, 0, { type: 'rapid', role: 'rapid' }), move(5, 5, -1, { role: 'plunge', feed: 100 })]
    expect(control(plunge).observations.entries[0].class).toBe('X')
    const slow = control(plunge, { centreCutting: true, alternativesFit: false })
    expect(slow.observations.entries[0].class).toBe('plunge')
    expect(slow.metrics['M-ENTRY-1']).toBe(0)
    expect(slow.metrics['M-ENTRY-6']).toBe(0.1)
    expect(control(plunge.map(m => ({ ...m, feed: 1000 })), { tool: { ...tool, type: 'drill' } }).metrics['M-ENTRY-1']).toBe(0)
  })
})
