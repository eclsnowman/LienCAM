import { describe, expect, it } from 'vitest'

import {
  applyStockOperation,
  createStockState,
  deserializeStockState,
  isStockRegionEmpty,
  serializeStockState,
  type StockCut,
} from '../../lib/cam/stockState'

const BOX = { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 10, maxZ: 10 }

describe('WO-262 stock state between operations', () => {
  it('applies a known flat cut without mutating the incoming stock', () => {
    const initial = createStockState(BOX, 1)
    const cut: StockCut = {
      move: { x0: 5, y0: 5, z0: 4, x1: 15, y1: 5, z1: 4 },
      cutter: { kind: 'flat', diameter: 4 },
    }

    const remaining = applyStockOperation(initial, [cut])

    expect(initial.topZ.every((top) => top === 10)).toBe(true)
    expect(remaining.topZ[5 * remaining.nx + 10]).toBe(4)
    expect(remaining.topZ[7 * remaining.nx + 10]).toBe(10)
    expect(remaining.requestedResolutionMm).toBe(1)
    expect(remaining.resolutionMm).toBe(1)
    expect(remaining.warnings).toEqual([])
  })

  it('answers empty-region queries correctly on both sides of a cut boundary', () => {
    const remaining = applyStockOperation(createStockState(BOX, 1), [
      {
        move: { x0: 5, y0: 5, z0: 4, x1: 15, y1: 5, z1: 4 },
        cutter: { kind: 'flat', diameter: 4 },
      },
    ])

    expect(
      isStockRegionEmpty(remaining, {
        kind: 'box',
        bounds: { minX: 10.49, minY: 6.49, minZ: 4, maxX: 10.51, maxY: 6.51, maxZ: 10 },
      }),
    ).toBe(true)
    expect(
      isStockRegionEmpty(remaining, {
        kind: 'box',
        bounds: { minX: 10.49, minY: 7.49, minZ: 4, maxX: 10.51, maxY: 7.51, maxZ: 10 },
      }),
    ).toBe(false)
  })

  it('catches WO-142: a cleared centerline can still have stock in the cutter sweep', () => {
    const stock = createStockState(
      { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 25, maxZ: 10 },
      0.5,
    )
    const afterPreviousPass = applyStockOperation(stock, [
      {
        move: { x0: 5, y0: 10, z0: 0, x1: 35, y1: 10, z1: 0 },
        cutter: { kind: 'flat', diameter: 6 },
      },
    ])
    const transverseLink = { x0: 35, y0: 10, z0: 0, x1: 35, y1: 11, z1: 0 }

    expect(
      isStockRegionEmpty(afterPreviousPass, {
        kind: 'box',
        bounds: { minX: 34.9, minY: 10, minZ: 0, maxX: 35.1, maxY: 11, maxZ: 10 },
      }),
      'the 1 mm link centerline lies inside the previous 3 mm cleared corridor',
    ).toBe(true)
    expect(
      isStockRegionEmpty(afterPreviousPass, {
        kind: 'swept-cutter',
        move: transverseLink,
        cutter: { kind: 'flat', diameter: 6 },
      }),
      'the cutter far edge reaches 4 mm from the pass and intersects standing stock',
    ).toBe(false)
  })

  it('serializes and reloads with byte-identical tops and identical query answers', () => {
    const remaining = applyStockOperation(createStockState(BOX, 0.5), [
      {
        move: { x0: 4, y0: 5, z0: 3, x1: 16, y1: 5, z1: 3 },
        cutter: { kind: 'ball', diameter: 3 },
      },
    ])
    const query = {
      kind: 'swept-cutter' as const,
      move: { x0: 7, y0: 5, z0: 3, x1: 13, y1: 5, z1: 3 },
      cutter: { kind: 'ball' as const, diameter: 3 },
    }

    const reloaded = deserializeStockState(serializeStockState(remaining))

    expect(Array.from(reloaded.topZ)).toEqual(Array.from(remaining.topZ))
    expect(reloaded).toMatchObject({
      schemaVersion: 1,
      representation: 'z-dexel',
      bounds: remaining.bounds,
      requestedResolutionMm: 0.5,
      resolutionMm: 0.5,
      nx: remaining.nx,
      ny: remaining.ny,
      bottomZ: remaining.bottomZ,
    })
    expect(isStockRegionEmpty(reloaded, query)).toBe(isStockRegionEmpty(remaining, query))
  })

  it('reports effective resolution when the column budget forces coarsening', () => {
    const state = createStockState(BOX, 0.1, 100)

    expect(state.requestedResolutionMm).toBe(0.1)
    expect(state.resolutionMm).toBeGreaterThan(0.1)
    expect(state.nx * state.ny).toBeLessThanOrEqual(100)
    expect(state.warnings).toHaveLength(1)
    expect(state.warnings[0]).toContain('forced coarsening')
  })
})
