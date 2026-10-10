import { describe, expect, it, vi } from 'vitest'

import type {
  FixedStockItem,
  ImportedGeometry,
  Operation,
  OriginBinding,
  PhysicalStock,
  SceneStock,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { buildAdaptive3dSmartIntent } from '../../lib/cam/smartHeights'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { Cam3dClient } from '../../cam3d/worker/client'
import { typedMock } from '../support/typedMock'

const TOOL: Tool = {
  id: 'tool-wo140-provenance',
  name: 'WO-140 flat mill',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 20,
  shankDiameter: 6,
  overallLength: 50,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {},
}

function fixedStock(id: string, x: number, topZ = 12): FixedStockItem {
  return {
    id,
    name: id,
    width: 20,
    height: 20,
    depth: topZ,
    position: { x, y: 0, z: 0 },
  }
}

function physicalStock(stock: FixedStockItem): PhysicalStock {
  return {
    id: stock.id,
    name: stock.name,
    mode: 'explicit',
    bounds: {
      min: { ...stock.position },
      max: {
        x: stock.position.x + stock.width,
        y: stock.position.y + stock.height,
        z: stock.position.z + stock.depth,
      },
      size: { x: stock.width, y: stock.height, z: stock.depth },
      center: {
        x: stock.position.x + stock.width / 2,
        y: stock.position.y + stock.height / 2,
        z: stock.position.z + stock.depth / 2,
      },
    },
    position: { ...stock.position },
  }
}

function derivedStock(stock: FixedStockItem): PhysicalStock {
  return {
    ...physicalStock(stock),
    mode: 'derived',
  }
}

function operation(type: 'parallel_3d' | 'adaptive_3d', smartAdaptive = false): Operation {
  return {
    id: `op-${type}`,
    name: type,
    type,
    enabled: true,
    status: 'pending',
    toolId: TOOL.id,
    geometrySelections: ['geo-wo140-provenance'],
    heights: {
      clearanceHeight: 20,
      clearanceHeightMode: 'absolute',
      retractHeight: 15,
      feedHeight: 10,
      topHeight: 0,
      topHeightMode: 'model_top',
      bottomHeight: 0,
      bottomHeightMode: 'model_bottom',
    },
    passes: {
      stepdown: 2,
      stepover: 1,
      stockToLeave: 0,
      finishPasses: 0,
      springPasses: 0,
    },
    linking: {
      entryType: 'plunge',
      rampAngle: 3,
      rampLength: 10,
      leadInRadius: 0,
      leadOutRadius: 0,
      retractType: 'full',
      transitionType: 'safe_height',
    },
    params: type === 'parallel_3d'
      ? { useStockBoundary: true }
      : { useStockBoundary: true, sideEntry: true },
    // Every op needs a valid Smart Height V2 authority to compute at all
    // (commit 2e5678b7). parallel_3d and the plain adaptive_3d cases get the
    // smallest fixture the production intent builder accepts; the
    // smartAdaptive cases keep their hand-built intent so the specific
    // resolved-height assertions below still line up.
    smartHeight: type === 'adaptive_3d' && smartAdaptive
      ? {
        kind: 'smart_v2' as const,
        intent: buildAdaptive3dSmartIntent({
          setupId: 'setup-wo140-provenance',
          geometryIds: ['geo-wo140-provenance'],
          safetyIntent: defaultHeightIntent(),
        }),
      }
      : smartHeightAuthorityFixture(type, {
        setupId: 'setup-wo140-provenance',
        geometryIds: ['geo-wo140-provenance'],
      }),
  }
}

const STOCK_A = fixedStock('stock-a', 0)
const STOCK_B = fixedStock('stock-b', 30, 18)

const CASES: Array<{
  name: string
  setupStockId?: string
  originBinding?: OriginBinding
  geometryStockId?: string
  degenerateGeometryBounds?: boolean
  stocks: PhysicalStock[]
  fixedStocks: FixedStockItem[]
  expectedTopZ?: number
  expectedFootprint?: [minX: number, minY: number, maxX: number, maxY: number]
  smartAdaptive?: boolean
  expectedSmartRefusal?: boolean
}> = [
  {
    name: 'an authoritative PhysicalStock binding ignores stale legacy id and viewport union',
    setupStockId: STOCK_B.id,
    originBinding: {
      kind: 'stock_corner',
      stockId: STOCK_A.id,
      cornerRow: 0,
      cornerCol: 0,
      cornerFace: 'top',
    },
    stocks: [physicalStock(STOCK_A), physicalStock(STOCK_B)],
    fixedStocks: [STOCK_A, STOCK_B],
    expectedTopZ: 12,
    expectedFootprint: [0, 0, 20, 20],
  },
  {
    name: 'a manual origin ignores a stale legacy stock id',
    setupStockId: STOCK_A.id,
    originBinding: { kind: 'manual' },
    stocks: [physicalStock(STOCK_A)],
    fixedStocks: [STOCK_A],
  },
  {
    name: 'a part-feature origin with a missing feature ignores a stale legacy stock id',
    setupStockId: STOCK_A.id,
    originBinding: {
      kind: 'part_feature',
      geoId: 'missing-feature',
      featureRef: { kind: 'vertex', localPt: { x: 0, y: 0, z: 0 } },
    },
    stocks: [physicalStock(STOCK_A)],
    fixedStocks: [STOCK_A],
  },
  {
    name: 'Smart Height V2 refuses a manual origin with no proven owning stock',
    setupStockId: STOCK_A.id,
    originBinding: { kind: 'manual' },
    stocks: [physicalStock(STOCK_A)],
    fixedStocks: [STOCK_A],
    smartAdaptive: true,
    expectedSmartRefusal: true,
  },
  {
    name: 'a legacy part-feature origin infers stock from its assigned geometry',
    setupStockId: STOCK_B.id,
    originBinding: {
      kind: 'part_feature',
      geoId: 'geo-wo140-provenance',
      featureRef: { kind: 'vertex', localPt: { x: 0, y: 0, z: 0 } },
    },
    stocks: [physicalStock(STOCK_A), physicalStock(STOCK_B)],
    fixedStocks: [STOCK_A, STOCK_B],
    expectedTopZ: 12,
    expectedFootprint: [0, 0, 20, 20],
    smartAdaptive: true,
  },
  {
    name: 'a part-feature origin proves the stock explicitly confirmed with the feature',
    originBinding: {
      kind: 'part_feature',
      geoId: 'geo-wo140-provenance',
      stockId: STOCK_A.id,
      featureRef: { kind: 'vertex', localPt: { x: 0, y: 0, z: 0 } },
    },
    stocks: [physicalStock(STOCK_A)],
    fixedStocks: [STOCK_A],
    expectedTopZ: 12,
    expectedFootprint: [0, 0, 20, 20],
  },
  {
    name: 'a WCS stock that does not own the selected solid stays unproven',
    setupStockId: STOCK_A.id,
    originBinding: {
      kind: 'stock_corner',
      stockId: STOCK_A.id,
      cornerRow: 0,
      cornerCol: 0,
      cornerFace: 'top',
    },
    geometryStockId: STOCK_B.id,
    stocks: [physicalStock(STOCK_A), physicalStock(STOCK_B)],
    fixedStocks: [STOCK_A, STOCK_B],
  },
  {
    name: 'a live derived PhysicalStock is proven from its current member',
    setupStockId: STOCK_A.id,
    originBinding: {
      kind: 'stock_corner',
      stockId: STOCK_A.id,
      cornerRow: 0,
      cornerCol: 0,
      cornerFace: 'top',
    },
    stocks: [derivedStock(STOCK_A)],
    fixedStocks: [STOCK_A],
    expectedTopZ: 6,
    expectedFootprint: [0, 0, 4, 4],
  },
  {
    name: 'an empty derived PhysicalStock rejects its stored placeholder',
    setupStockId: STOCK_A.id,
    originBinding: {
      kind: 'stock_corner',
      stockId: STOCK_A.id,
      cornerRow: 0,
      cornerCol: 0,
      cornerFace: 'top',
    },
    degenerateGeometryBounds: true,
    stocks: [derivedStock(STOCK_A)],
    fixedStocks: [STOCK_A],
  },
  {
    name: 'a stale PhysicalStock id stays unproven',
    setupStockId: 'deleted-stock',
    stocks: [physicalStock(STOCK_A)],
    fixedStocks: [STOCK_A],
  },
  {
    name: 'a missing legacy fixed-stock id stays unproven',
    setupStockId: 'missing-stock',
    stocks: [],
    fixedStocks: [STOCK_A],
  },
  {
    name: 'no id with multiple PhysicalStocks stays unproven',
    stocks: [physicalStock(STOCK_A), physicalStock(STOCK_B)],
    fixedStocks: [STOCK_A, STOCK_B],
  },
  {
    name: 'the viewport group fallback alone stays unproven',
    stocks: [],
    fixedStocks: [],
  },
  {
    name: 'one exactly selected legacy fixed stock remains proven',
    setupStockId: STOCK_A.id,
    stocks: [],
    fixedStocks: [STOCK_A],
    expectedTopZ: 12,
    expectedFootprint: [0, 0, 20, 20],
  },
]

describe('WO-140 production stock provenance', () => {
  it.each(CASES)('$name', async ({
    setupStockId,
    originBinding,
    geometryStockId,
    degenerateGeometryBounds,
    stocks,
    fixedStocks,
    expectedTopZ,
    expectedFootprint,
    smartAdaptive,
    expectedSmartRefusal,
  }) => {
    vi.resetModules()

    const partMesh = {
      positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 6]),
      indices: new Uint32Array([0, 1, 2]),
      bounds: { min: [0, 0, 0], max: [4, 4, 6] },
      source: 'stl' as const,
    }
    const terminalMove: ToolpathMove = {
      type: 'rapid',
      x: 0,
      y: 0,
      z: 20,
      role: 'rapid',
    }
    const acquirePartMesh = vi.fn().mockResolvedValue(partMesh)
    const computeParallel3dMoves = vi.fn().mockImplementation(async () => ({
      moves: [terminalMove],
      computeTimeMs: 1,
    }))
    const computeAdaptive3dMoves = vi.fn().mockImplementation(async (args: {
      resolvedHeights: {
        clearanceZ: number
        retractZ: number
        feedZ: number
        topZ: number
        bottomZ: number
      }
    }) => ({
      moves: [terminalMove],
      computeTimeMs: 1,
      carvedStock: undefined,
      carvedStockWarning: undefined,
      diagnostics: undefined,
      heightTruth: args.resolvedHeights,
    }))

    vi.doMock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()
      return typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
        ...actual,
        acquirePartMesh,
        computeParallel3dMoves,
      })
    })
    vi.doMock('../../cam3d/integration/adaptive3dOperation', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../cam3d/integration/adaptive3dOperation')>()
      return typedMock<typeof import('../../cam3d/integration/adaptive3dOperation')>({
        ...actual,
        computeAdaptive3dMoves,
      })
    })
    vi.doMock('../../lib/stlCache', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../lib/stlCache')>()
      return typedMock<typeof import('../../lib/stlCache')>({
        ...actual,
        loadCachedSTL: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      })
    })
    vi.doMock('../../cam3d/integration/appClient', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
      return typedMock<typeof import('../../cam3d/integration/appClient')>({
        ...actual,
        // A genuine Cam3dClient over a no-op WorkerLike - see
        // adaptive3dInternalModel.test.ts for the reasoning.
        getCam3dClient: () => new Cam3dClient({
          postMessage: () => {},
          terminate: () => {},
          onmessage: null,
          onerror: null,
        }),
      })
    })

    const localStorage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    }
    const getStockBounds = vi.fn(() => ({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 50, y: 20, z: 30 },
    }))
    vi.stubGlobal('localStorage', localStorage)
    vi.stubGlobal('window', {
      localStorage,
      __cncViewport: { getStockBounds },
    })

    try {
      const { useCamStore } = await import('../../store')
      const geometry: ImportedGeometry = {
        id: 'geo-wo140-provenance',
        name: 'WO-140 part',
        filename: 'wo140.stl',
        type: 'mesh',
        format: 'stl',
        boundingBox: {
          min: { x: 0, y: 0, z: 0 },
          max: degenerateGeometryBounds
            ? { x: 0, y: 0, z: 0 }
            : { x: 4, y: 4, z: 6 },
          size: degenerateGeometryBounds
            ? { x: 0, y: 0, z: 0 }
            : { x: 4, y: 4, z: 6 },
          center: degenerateGeometryBounds
            ? { x: 0, y: 0, z: 0 }
            : { x: 2, y: 2, z: 3 },
        },
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        loaded: true,
        stockId: geometryStockId ?? STOCK_A.id,
      }
      const operations = [operation('parallel_3d'), operation('adaptive_3d', smartAdaptive)]
      const setup: Setup = {
        id: 'setup-wo140-provenance',
        name: 'WO-140 setup',
        wcs: {
          id: 'wcs-wo140-provenance',
          label: 'G54',
          fixtureOffset: 54,
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          zAxis: { x: 0, y: 0, z: 1 },
          stockId: setupStockId,
          ...(originBinding !== undefined ? { originBinding } : {}),
        },
        stock: {
          type: 'rectangular',
          offsetX: 0,
          offsetY: 0,
          offsetZTop: 0,
          offsetZBottom: 0,
          material: 'aluminum',
        },
        operations,
        notes: '',
      }
      const sceneStock: SceneStock = {
        mode: 'fixed',
        autoOffsetXY: 0,
        autoOffsetZTop: 0,
        fixedWidth: 50,
        fixedHeight: 20,
        fixedDepth: 30,
        fixedStocks,
      }

      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          id: 'project-wo140-provenance',
          geometry: [geometry],
          setups: [setup],
          stocks,
          sceneStock,
          toolLibrary: [TOOL],
          activeSetupId: setup.id,
        },
        toolLibrary: [TOOL],
        toolpathBatch: null,
      }))

      const smartPreview = smartAdaptive && !expectedSmartRefusal
        ? await useCamStore.getState().previewAdaptive3dSmartHeights(setup.id, operations[1])
        : undefined
      if (smartAdaptive && expectedSmartRefusal) {
        await expect(useCamStore.getState().previewAdaptive3dSmartHeights(setup.id, operations[1]))
          .rejects.toThrow(/Smart Height refused.*owning_stock/)
      }

      await useCamStore.getState().computeOperationToolpath(setup.id, operations[0].id)
      await useCamStore.getState().computeOperationToolpath(setup.id, operations[1].id)

      expect(computeParallel3dMoves).toHaveBeenCalledOnce()
      const parallelArgs = computeParallel3dMoves.mock.calls[0][0]
      expect(parallelArgs.resolvedHeights.stockTopZ).toBe(expectedTopZ)

      // Smart Height V2 is the only authority for adaptive_3d (2e5678b7), and
      // none of this fixture's variants ('current_material' via the default
      // stamp, or the hand-built smartAdaptive intent) supply remaining- or
      // initial-stock evidence of their own -- both fall back to requiring a
      // proven owning stock for Material Start. So every case here that
      // leaves parallel_3d's legacy provenance unproven (no expectedTopZ)
      // equally leaves adaptive_3d's V2 evidence unproven: adaptive_3d
      // refuses to compute, same as the dedicated "Smart Height V2
      // refuses..." case above. This generalizes what that case already
      // covers to the rest of this suite's unproven scenarios.
      if (expectedTopZ === undefined) {
        expect(computeAdaptive3dMoves).not.toHaveBeenCalled()
        expect(useCamStore.getState().project.setups[0].operations[1]).toMatchObject({
          status: 'error',
          errorMessage: expect.stringMatching(/Smart Height refused.*owning_stock/),
        })
        expect(parallelArgs.boundary).toBeUndefined()
        return
      }
      expect(computeAdaptive3dMoves).toHaveBeenCalledOnce()
      expect(computeAdaptive3dMoves.mock.calls[0][0].stockBoundsAreRealStock)
        .toBe(expectedTopZ === undefined ? undefined : true)
      expect(computeAdaptive3dMoves.mock.calls[0][0].stockBounds.maxZ)
        .toBe(expectedTopZ ?? partMesh.bounds.max[2])
      const adaptiveArgs = computeAdaptive3dMoves.mock.calls[0][0]
      if (smartAdaptive) {
        // floorIncludesAxialAllowance was a V1-vs-V2 signal flag on the
        // compute payload; 2e5678b7 dropped it because V2 is unconditional
        // now (no "did this op use V2" branch left to flag). Axial allowance
        // is applied unconditionally, with nothing left in the payload to
        // assert on that specific point, so that assertion is retired.
        // feedZ was asserted as 12.5 since this test's introduction (daa1c92a),
        // but defaultHeightIntent()'s feed plane is 'top' + 5 offset, and top
        // here resolves to stock_top (12): 12 + 5 = 17, same as retract
        // (stock_top + 5). That coincidence is correct, not a bug -- 12.5
        // never matched the formula. Updated to the real resolved value.
        expect(adaptiveArgs.resolvedHeights).toMatchObject({
          topZ: 12,
          feedZ: 17,
          retractZ: 17,
          clearanceZ: 27,
          bottomZ: 0,
        })
        expect(smartPreview).toEqual(
          useCamStore.getState().project.setups[0].operations[1].resolvedHeights,
        )
      }
      if (expectedFootprint) {
        const [minX, minY, maxX, maxY] = expectedFootprint
        expect(Array.from(parallelArgs.boundary[0])).toEqual([
          minX, minY,
          maxX, minY,
          maxX, maxY,
          minX, maxY,
        ])
        expect(adaptiveArgs.stockBounds).toMatchObject({ minX, minY, maxX, maxY })
        expect(adaptiveArgs.sideEntry).toBe(true)
      } else {
        expect(parallelArgs.boundary).toBeUndefined()
        expect(adaptiveArgs.stockBounds).toMatchObject({
          minX: -2,
          minY: -2,
          maxX: 2,
          maxY: 2,
        })
        expect(adaptiveArgs.sideEntry).toBeUndefined()
      }
    } finally {
      vi.doUnmock('../../cam3d/integration/parallel3dOperation')
      vi.doUnmock('../../cam3d/integration/adaptive3dOperation')
      vi.doUnmock('../../lib/stlCache')
      vi.doUnmock('../../cam3d/integration/appClient')
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  }, 20_000)
})
