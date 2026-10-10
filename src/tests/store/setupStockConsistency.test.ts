// ADR 0026 one-stock-per-setup: the PURE checker setupStockConsistency resolves
// the owning stock of every op in a setup and reports the distinct set, ok=false
// when a setup mixes more than one stock. It reuses the compute-path resolvers
// (resolveOwningStock + effectiveStockIdForCompute for nest seeds) and SKIPS ops
// with no resolvable stock (owned by the existing no-stock guards).

import { describe, it, expect } from 'vitest'
import { setupStockConsistency } from '../../store/stockAssignment'
import type {
  ImportedGeometry, PhysicalStock, BoundingBox, Vec3,
  Setup, Operation, WCS, HeightParams, PassParams, LinkingParams, NestRecord,
} from '../../types'

// -- Fixtures -----------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  } as ImportedGeometry
}

function explicitStock(id: string, name: string): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 1.5, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

function makeOp(id: string, geometryId: string | undefined): Operation {
  return {
    id, name: `Op ${id}`, type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: geometryId === undefined ? {} : { geometryId },
  }
}

function makeWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
}

function makeSetup(name: string, ops: Operation[]): Setup {
  return {
    id: 'setup-1', name, wcs: makeWcs(),
    stock: {} as Setup['stock'],
    operations: ops, notes: '',
  }
}

// =============================================================================

describe('setupStockConsistency (ADR 0026)', () => {
  it('a single-stock setup is ok with the one resolved stock id', () => {
    const geoA = makeGeo({ id: 'geo-a', stockId: 'stock-a' })
    const geoB = makeGeo({ id: 'geo-b', stockId: 'stock-a' })
    const stocks = [explicitStock('stock-a', 'Plate A')]
    const setup = makeSetup('Setup 1', [
      makeOp('op-a', 'geo-a'),
      makeOp('op-b', 'geo-b'),
    ])
    const r = setupStockConsistency(setup, [geoA, geoB], stocks)
    expect(r.ok).toBe(true)
    expect(r.stockIds).toEqual(['stock-a'])
    expect(r.reason).toBeUndefined()
  })

  it('a setup mixing two stocks is NOT ok, names both stocks in stockIds + reason', () => {
    const geoA = makeGeo({ id: 'geo-a', stockId: 'stock-a' })
    const geoB = makeGeo({ id: 'geo-b', stockId: 'stock-b' })
    const stocks = [explicitStock('stock-a', 'Plate A'), explicitStock('stock-b', 'Plate B')]
    const setup = makeSetup('Mixed', [
      makeOp('op-a', 'geo-a'),
      makeOp('op-b', 'geo-b'),
    ])
    const r = setupStockConsistency(setup, [geoA, geoB], stocks)
    expect(r.ok).toBe(false)
    expect(new Set(r.stockIds)).toEqual(new Set(['stock-a', 'stock-b']))
    expect(r.reason).toMatch(/Mixed/)
    expect(r.reason).toMatch(/Plate A/)
    expect(r.reason).toMatch(/Plate B/)
    expect(r.reason).toMatch(/separate setups/)
  })

  it('a nest seed op resolves to the owning nest bound stock and counts as that stock', () => {
    // The seed is deliberately no-stock (stockId undefined + ownerNestId); its cut
    // stock is the nest's boundStockId. A normal part on the SAME bound sheet must
    // make the setup single-stock (ok), proving the seed resolved via the nest.
    const seed = makeGeo({ id: 'seed-1', stockId: undefined, stockIdLocked: true, ownerNestId: 'nest-1' })
    const part = makeGeo({ id: 'geo-x', stockId: 'sheet-1' })
    const stocks = [explicitStock('sheet-1', 'Sheet 1')]
    const nests = [{ id: 'nest-1', boundStockId: 'sheet-1' } as unknown as NestRecord]
    const setup = makeSetup('Nest setup', [
      makeOp('op-seed', 'seed-1'),
      makeOp('op-part', 'geo-x'),
    ])
    const r = setupStockConsistency(setup, [seed, part], stocks, nests)
    expect(r.ok).toBe(true)
    expect(r.stockIds).toEqual(['sheet-1'])
  })

  it('a nest seed and a part on a DIFFERENT stock makes the setup multi-stock', () => {
    const seed = makeGeo({ id: 'seed-1', stockId: undefined, stockIdLocked: true, ownerNestId: 'nest-1' })
    const part = makeGeo({ id: 'geo-x', stockId: 'stock-other' })
    const stocks = [explicitStock('sheet-1', 'Sheet 1'), explicitStock('stock-other', 'Other')]
    const nests = [{ id: 'nest-1', boundStockId: 'sheet-1' } as unknown as NestRecord]
    const setup = makeSetup('Nest mixed', [
      makeOp('op-seed', 'seed-1'),
      makeOp('op-part', 'geo-x'),
    ])
    const r = setupStockConsistency(setup, [seed, part], stocks, nests)
    expect(r.ok).toBe(false)
    expect(new Set(r.stockIds)).toEqual(new Set(['sheet-1', 'stock-other']))
  })

  it('ops with no resolvable stock are SKIPPED (do not crash, do not count)', () => {
    const geoA = makeGeo({ id: 'geo-a', stockId: 'stock-a' })
    const dangling = makeGeo({ id: 'geo-d', stockId: 'ghost' }) // points at no stock
    const noGeoSel = makeOp('op-none', undefined)               // no geometryId
    const missing = makeOp('op-missing', 'geo-does-not-exist')  // geometry absent
    const stocks = [explicitStock('stock-a', 'Plate A')]
    const setup = makeSetup('Skips', [
      makeOp('op-a', 'geo-a'),
      makeOp('op-d', 'geo-d'),
      noGeoSel,
      missing,
    ])
    const r = setupStockConsistency(setup, [geoA, dangling], stocks)
    // Only geo-a resolved; the dangling/none/missing ops were skipped -> single stock.
    expect(r.ok).toBe(true)
    expect(r.stockIds).toEqual(['stock-a'])
  })

  it('disabled ops are ignored', () => {
    const geoA = makeGeo({ id: 'geo-a', stockId: 'stock-a' })
    const geoB = makeGeo({ id: 'geo-b', stockId: 'stock-b' })
    const stocks = [explicitStock('stock-a', 'Plate A'), explicitStock('stock-b', 'Plate B')]
    const disabledB = { ...makeOp('op-b', 'geo-b'), enabled: false }
    const setup = makeSetup('Disabled', [makeOp('op-a', 'geo-a'), disabledB])
    const r = setupStockConsistency(setup, [geoA, geoB], stocks)
    // op-b would have made it multi-stock, but it is disabled -> single stock.
    expect(r.ok).toBe(true)
    expect(r.stockIds).toEqual(['stock-a'])
  })
})
