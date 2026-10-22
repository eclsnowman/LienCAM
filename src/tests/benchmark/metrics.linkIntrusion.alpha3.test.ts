import { describe, expect, it } from 'vitest'
import { ZDexelField } from '../../cam3d/stock'
import { bounds, control, move } from './alpha3CollectorControls'
import { alpha3HardVerdicts, envelopeExcursion } from './metrics.alpha3'

describe('WO-2902 link intrusion', () => {
  it('measures a link through standing stock and zero through previously cleared space', () => {
    const moves = [move(2, 5, -1, { type: 'rapid', role: 'rapid' }), move(38, 5, -1, { role: 'loop_back' })]
    expect(control(moves).metrics['M-SAFE-2']).toBe(1)
    const field = ZDexelField.fromBox(bounds, 0.1); field.top.fill(-2)
    expect(control(moves, { stock: { field, bounds, cutter: { kind: 'flat', diameter: 2 } } }).metrics['M-SAFE-2']).toBe(0)
  })
  it('uses stock at the instant of a link, leaves the caller field untouched and replays arcs', () => {
    const moves = [move(2, 5, -1, { type: 'rapid', role: 'rapid' }), move(38, 5, -1), move(2, 5, -1, { role: 'loop_back' })]
    const field = ZDexelField.fromBox(bounds, 0.1), original = [...field.top]
    expect(control(moves, { stock: { field, bounds, cutter: { kind: 'flat', diameter: 2 } } }).metrics['M-SAFE-2']).toBe(0)
    expect([...field.top]).toEqual(original)
    const arc = [move(10, 5, -1, { type: 'rapid', role: 'rapid' }), move(10, 5, -1, { type: 'arc_ccw', cx: 15, cy: 5 }), move(10, 5, -1, { type: 'arc_ccw', cx: 15, cy: 5, role: 'loop_back' })]
    expect(control(arc).metrics['M-SAFE-2']).toBe(0)
  })
  it('reports reach shortfalls and never promotes a missing holder to a clearance pass', () => {
    const r = control([move(2, 5, 0, { type: 'rapid', role: 'rapid' }), move(2, 5, -5, { role: 'plunge' })])
    expect(r.metrics['M-SAFE-5']).toBe(1)
    expect(r.observations.fluteReach).toMatch(/exceeds available/)
    expect(r.metrics['M-SAFE-4']).toEqual({ value: null, reason: 'n/a: no holder geometry' })
    expect(alpha3HardVerdicts(r.metrics)['M-SAFE-5']).toBe('FAIL')
    expect(alpha3HardVerdicts(r.metrics)['M-SAFE-4']).toBe('n/a')
  })
  it('checks exact arc extrema and requires machine registration', () => {
    const box = { minX: 0, minY: 0, minZ: -10, maxX: 20, maxY: 10, maxZ: 10 }
    const moves = [move(10, 5, 0), move(10, 5, 0, { type: 'arc_ccw', cx: 16, cy: 5 })]
    expect(envelopeExcursion(moves, box)).toBeCloseTo(2, 10)
    expect(control(moves).metrics['M-SAFE-6']).toMatchObject({ value: null })
  })
  it('reports detour and lift against retained stock, without counting the following pass', () => {
    const start = [move(2, 5, 1), move(4, 5, 1)]
    const detour = control([...start, move(4, 7, 1, { role: 'loop_back' }), move(8, 7, 1, { role: 'loop_back' }), move(8, 5, 1, { role: 'loop_back' }), move(20, 5, 1)])
    expect(detour.metrics['M-LINK-4']).toBe(2)
    const lift = control([...start, move(4, 5, 3, { type: 'rapid', role: 'rapid' }), move(8, 5, 3, { type: 'rapid', role: 'rapid' }), move(20, 5, 1)])
    expect(lift.metrics['M-LINK-5']).toBe(3)
  })
})
