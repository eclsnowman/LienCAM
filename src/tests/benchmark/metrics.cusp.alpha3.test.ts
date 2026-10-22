import { describe, expect, it } from 'vitest'
import { crossSectionCusps, impliedCusp } from './metrics.alpha3'
import { move } from './alpha3CollectorControls'

describe('WO-2902 cross-section cusp', () => {
  it('matches a ball R at actual spacing s on a flat, independently of programmed settings', () => {
    const path = [0, 1, 2, 3].flatMap(x => [move(x, 0, 0, { type: 'rapid', role: 'rapid' }), move(x, 10, 0)])
    const measured = crossSectionCusps(path, 3)!
    expect(measured.samples).toBeGreaterThan(10)
    expect(measured.max).toBeCloseTo(3 - Math.sqrt(9 - 0.25), 12)
    expect(measured.mean).toBeCloseTo(measured.max, 12)
    expect(crossSectionCusps(path.map(m => ({ ...m, x: m.x * 2 })), 3)!.max).toBeGreaterThan(measured.max)
  })
  it('is invariant under swapping axes and measures growth on a slope', () => {
    const flat = [0, 1, 2, 3].flatMap(x => [move(x, 0, 0, { type: 'rapid', role: 'rapid' }), move(x, 10, 0)])
    expect(crossSectionCusps(flat.map(m => ({ ...m, x: m.y, y: m.x })), 3)).toEqual(crossSectionCusps(flat, 3))
    expect(crossSectionCusps(flat.map(m => ({ ...m, z: m.x })), 3)!.max).toBeCloseTo(impliedCusp(3, Math.sqrt(2))!, 12)
    expect(impliedCusp(3, 7)).toBeUndefined()
    expect(crossSectionCusps(flat.slice(0, 2), 3)).toBeUndefined()
  })
})
