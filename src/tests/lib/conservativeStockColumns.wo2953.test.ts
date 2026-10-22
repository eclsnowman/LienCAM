import { describe, expect, it } from 'vitest'
import * as stockApi from '../../lib/cam/stockState'
import {
  applyConservativeStockOperation as apply, createConservativeStockColumns as create,
  highestConservativeStockOver as highest, isConservativeStockRegionEmpty as empty,
  createStockState, applyStockOperation, type StockCut,
} from '../../lib/cam/stockState'

const box = { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 20 }
const flat = (y = 5, z = 0, diameter = 4): StockCut => ({
  move: { x0: -5, y0: y, z0: z, x1: 15, y1: y, z1: z }, cutter: { kind: 'flat', diameter },
})
const region = (minX: number, maxX: number, minY: number, maxY: number, minZ = 0) =>
  ({ minX, maxX, minY, maxY, minZ, maxZ: 20 })

describe('WO-2953 conservative whole-cell stock', () => {
  it('never certifies the uncut 0.1 mm strip as removed (legacy negative control)', () => {
    const b = { ...box, maxX: 4, maxY: 1 }
    const cut = flat(-0.6, 0, 2)
    // With the old source in place, exercise the actual legacy representation,
    // not an import failure or hand-mutated algorithm. Same physical assertion
    // on both sources. This is backend evidence, NOT application integration.
    const remaining = typeof stockApi.createConservativeStockColumns === 'function'
      ? stockApi.applyConservativeStockOperation(stockApi.createConservativeStockColumns(b, 0.5), [cut])
      : stockApi.applyStockOperation(stockApi.createStockState(b, 0.5), [cut])
    expect(remaining.topZ[0], 'uncut y=0.4..0.5 must retain the original 20 mm top').toBe(20)
  })
  it('retains an actual 0.2 mm wall even when every center is cut', () => {
    const initial = { ...box, maxX: 4, maxY: 1 }
    const cut = flat(-0.6, 0, 2) // footprint ends at y=0.4; cell center y=.25 is cut
    const sampled = applyStockOperation(createStockState(initial, 0.5), [cut])
    expect(sampled.topZ[0]).toBe(0) // control: legacy samples cannot certify a cell
    const remaining = apply(create(initial, 0.5), [cut])
    expect(remaining.topZ[0], 'standing strip y=0.4..0.5 must not be declared removed').toBe(20)
    expect(empty(remaining, { kind: 'box', bounds: region(0.1, 3.9, 0.4, 0.6) })).toBe(false)
  })

  it('removes full cells, preserves inputs, and rounds tops upward in Float64', () => {
    const initial = create(box, 0.5)
    const after = apply(initial, [flat(5, 18.123456789)])
    const top = highest(after, region(4.2, 5.8, 4.2, 5.8))!
    expect(top).toBeGreaterThanOrEqual(18.123456789)
    expect(top).toBeLessThan(18.123456790)
    expect(initial.topZ.every(z => z === 20)).toBe(true)
    expect(Object.isFrozen(after.topZ)).toBe(true)
    expect(() => { (after.topZ as number[])[0] = -100 }).toThrow()
    expect(highest(after, region(4, 6, 7, 7.1))).toBe(20)
  })

  it('uses the farthest corner of the actual ball profile', () => {
    const initial = create({ ...box, maxX: 1, maxY: 1 }, 1)
    const cut: StockCut = { move: { x0: 0.5, y0: 0.5, z0: 2, x1: 0.5, y1: 0.5, z1: 2 }, cutter: { kind: 'ball', diameter: 4 } }
    const after = apply(initial, [cut])
    const analytical = 2 + 2 - Math.sqrt(4 - 0.5)
    expect(after.topZ[0]).toBeGreaterThanOrEqual(analytical)
    expect(after.topZ[0]).toBeCloseTo(analytical, 10)
    // Residual volume is >= analytical integral of the profile over the square.
    for (let y = 0; y <= 1; y += 0.05) for (let x = 0; x <= 1; x += 0.05) {
      const surface = 4 - Math.sqrt(4 - (x - 0.5) ** 2 - (y - 0.5) ** 2)
      expect(after.topZ[0]).toBeGreaterThanOrEqual(surface)
    }
  })

  it('keeps a cutter flank obstruction although the centerline is clear', () => {
    const remaining = apply(create(box, 0.25), [flat(5, -1, 4)])
    expect(empty(remaining, { kind: 'box', bounds: region(3, 7, 4.9, 5.1) })).toBe(true)
    expect(empty(remaining, { kind: 'swept-cutter', ...flat(6, 0, 4) })).toBe(false)
    expect(empty(remaining, { kind: 'swept-cutter', ...flat(5, 21, 4) })).toBe(true)
  })

  it('retains thin material under budget coarsening and reports effective fidelity', () => {
    const initial = create(box, 0.01, 25)
    expect(initial.nx * initial.ny).toBeLessThanOrEqual(25)
    expect(initial.resolutionMm).toBeGreaterThan(0.01)
    expect(initial.warnings).toHaveLength(1)
    const after = apply(initial, [flat(5, 0, 0.2)])
    expect(after.topZ.every(z => z === 20)).toBe(true)
    expect(empty(after, { kind: 'box', bounds: region(4.9, 5.1, 5.11, 5.12) })).toBe(false)
  })

  it('clips last cells to exact stock and preserves fractional initial Z', () => {
    const initial = create({ ...box, maxX: 1.1, maxY: 0.7, minZ: -0.123456789, maxZ: 1.123456789 }, 0.5)
    expect(initial.topZ[0]).toBe(1.123456789)
    const cut: StockCut = { move: { x0: -5, y0: 0.35, z0: -1, x1: 5, y1: 0.35, z1: -1 }, cutter: { kind: 'flat', diameter: 2 } }
    const after = apply(initial, [cut])
    expect(after.topZ.every(z => z === initial.bounds.minZ)).toBe(true)
    expect(empty(after, { kind: 'box', bounds: box })).toBe(true)
    expect(highest(after, region(20, 21, 20, 21))).toBeUndefined()
  })

  it('accounts for vertical plunges but refuses ramps, invalid cutters, NaN and unbounded precision', () => {
    const initial = create(box, 0.5)
    const cut = { move: { x0: 5, y0: 5, z0: 25, x1: 5, y1: 5, z1: 4 }, cutter: { kind: 'flat' as const, diameter: 4 } }
    expect(highest(apply(initial, [cut]), region(4.2, 5.8, 4.2, 5.8))).toBeCloseTo(4, 10)
    expect(() => apply(initial, [{ ...cut, move: { ...cut.move, x1: 8 } }])).toThrow(/ramps/)
    expect(() => apply(initial, [{ ...cut, cutter: { kind: 'flat', diameter: -1 } }])).toThrow(/finite/)
    expect(() => apply(initial, [{ ...cut, move: { ...cut.move, x0: NaN } }])).toThrow(/finite/)
    expect(() => create({ ...box, minX: 1e12, maxX: 1e12 + 10 }, 0.001)).toThrow(/numerically/)
  })

  it('never removes more volume than an analytical flat capsule', () => {
    const b = { minX: -5, minY: -5, minZ: 0, maxX: 15, maxY: 5, maxZ: 10 }
    const cut: StockCut = { move: { x0: 0, y0: 0, z0: 3, x1: 10, y1: 0, z1: 3 }, cutter: { kind: 'flat', diameter: 4 } }
    const after = apply(create(b, 0.1), [cut])
    const removed = after.topZ.reduce((v, z) => v + (10 - z) * 0.1 ** 2, 0)
    const analytic = (10 * 4 + Math.PI * 4) * 7
    expect(removed).toBeGreaterThan(analytic * 0.90)
    expect(removed).toBeLessThanOrEqual(analytic)
  })
})
