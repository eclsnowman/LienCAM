import { describe, expect, it, vi } from 'vitest'

import type { PartMesh } from '../../cam3d/kernel/types'
import type { Cam3dClient } from '../../cam3d/worker/client'
import type {
  FeedrateOverride,
  FixedStockItem,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  SceneStock,
  Setup,
} from '../../types'
import { buildFrames } from '../../components/simulation/SimulationPanel'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'
import {
  MACHINE_RAPID_RATE,
  TOOL_CUT_RATE,
  OVERRIDE_CUT_RATE,
  hierarchyTool,
  operationOverride,
} from './feedHierarchyFixtures'

const mesh: PartMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: [0, 0, 0], max: [100, 100, 10] },
  source: 'fixture',
}

function roleOnlyAdaptiveClient(): Cam3dClient {
  return {
    generateAdaptiveRough: async () => ({
      ir: {
        moves: [
          { t: 'rapid' as const, x: 0, y: 0, z: 10, role: 'rapid' as const },
          { t: 'feed' as const, x: 100, y: 0, z: 10, role: 'cut' as const },
        ],
        meta: {
          strategyId: 'adaptive_rough',
          cutterId: 'sim4-tool',
          params: { floorZ: 0 },
        },
      },
    }),
  } as unknown as Cam3dClient
}

async function generateFixtureMoves(feedrateOverride?: FeedrateOverride) {
  vi.resetModules()
  const tool = hierarchyTool()
  const client = roleOnlyAdaptiveClient()
  vi.doMock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>(),
    acquirePartMesh: vi.fn().mockResolvedValue(mesh),
  }))
  vi.doMock('../../lib/stlCache', async (importOriginal) => typedMock<typeof import('../../lib/stlCache')>({
    ...await importOriginal<typeof import('../../lib/stlCache')>(),
    loadCachedSTL: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  }))
  vi.doMock('../../cam3d/integration/appClient', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...await importOriginal<typeof import('../../cam3d/integration/appClient')>(),
    getCam3dClient: () => client,
  }))

  const localStorage = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', {
    localStorage,
    __cncViewport: {
      getStockBounds: () => ({
        min: { x: 0, y: 0, z: 0 },
        max: { x: 100, y: 100, z: 10 },
      }),
    },
  })

  try {
    const { useCamStore } = await import('../../store')
    const fixedStock: FixedStockItem = {
      id: 'stock-sim4', name: 'SIM-4 stock', width: 100, height: 100, depth: 10,
      position: { x: 0, y: 0, z: 0 },
    }
    const sceneStock: SceneStock = {
      mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 10, fixedStocks: [fixedStock],
    }
    const physicalStock: PhysicalStock = {
      id: fixedStock.id,
      name: fixedStock.name,
      mode: 'explicit',
      bounds: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 100, y: 100, z: 10 },
        size: { x: 100, y: 100, z: 10 },
        center: { x: 50, y: 50, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 },
    }
    const geometry: ImportedGeometry = {
      id: 'geo-sim4', name: 'SIM-4 block', filename: 'sim4.stl',
      type: 'mesh', format: 'stl',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 10 },
        size: { x: 100, y: 100, z: 10 }, center: { x: 50, y: 50, z: 5 },
      },
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      loaded: true,
      stockId: fixedStock.id,
    }
    const operation: Operation = {
      id: 'op-sim4',
      name: 'SIM-4 adaptive feed hierarchy',
      type: 'adaptive_3d',
      enabled: true,
      status: 'pending',
      toolId: tool.id,
      geometrySelections: [geometry.id],
      heights: {
        clearanceHeight: 20,
        clearanceHeightMode: 'absolute',
        retractHeight: 12,
        feedHeight: 12,
        topHeight: 0,
        topHeightMode: 'model_top',
        bottomHeight: 0,
        bottomHeightMode: 'model_bottom',
      },
      passes: {
        stepdown: 3, stepover: 0.4, stockToLeave: 0, finishPasses: 0, springPasses: 0,
      },
      linking: {
        entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
        leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
      },
      params: { cellSize: 1 },
      ...(feedrateOverride !== undefined ? { feedrateOverride } : {}),
    }
    // Every op needs a valid Smart Height V2 authority to compute at all
    // (commit 2e5678b7). adaptive_3d's default 'current_material' variant
    // roughs from the proven stock top down to the target surface (the
    // mesh's own bottom, z 0 here) regardless of the legacy heights above,
    // which is exactly the bottomZ === 0 this test already asserts.
    const stampedOperation = stampSmartHeightAuthority(operation, {
      setupId: 'setup-sim4',
      geometryIds: [geometry.id],
    })
    const setup: Setup = {
      id: 'setup-sim4',
      name: 'SIM-4 setup',
      wcs: {
        id: 'wcs-sim4', label: 'G54', fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        zAxis: { x: 0, y: 0, z: 1 },
        stockId: fixedStock.id,
      },
      stock: {
        type: 'rectangular', offsetX: 0, offsetY: 0,
        offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
      },
      operations: [stampedOperation],
      notes: '',
    }

    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        id: 'project-sim4',
        geometry: [geometry],
        setups: [setup],
        stocks: [physicalStock],
        sceneStock,
        toolLibrary: [tool],
        activeSetupId: setup.id,
      },
      toolLibrary: [tool],
      toolpathBatch: null,
    }))

    await useCamStore.getState().computeOperationToolpath(setup.id, stampedOperation.id)
    const stored = useCamStore.getState().project.setups[0].operations[0]
    if (stored.status !== 'ready' || !stored.toolpathMoves) {
      throw new Error(stored.errorMessage ?? `SIM-4 store compute ended in ${stored.status}`)
    }
    return {
      moves: stored.toolpathMoves,
      heightTruth: { bottomZ: stored.resolvedHeights?.machine.bottom },
    }
  } finally {
    vi.doUnmock('../../cam3d/integration/parallel3dOperation')
    vi.doUnmock('../../lib/stlCache')
    vi.doUnmock('../../cam3d/integration/appClient')
    vi.unstubAllGlobals()
    vi.resetModules()
  }
}

describe('SIM-4 3D operation feed hierarchy reaches simulation frames', () => {
  it('carries machine, tool, and operation rates from adaptive_3d into frames', async () => {
    const tool = hierarchyTool()
    const toolRates = resolveFeedrates(tool, undefined, MACHINE_RAPID_RATE)
    const overrideRates = resolveFeedrates(tool, operationOverride, MACHINE_RAPID_RATE)

    expect(toolRates.feedRate).toBe(TOOL_CUT_RATE)
    expect(overrideRates.feedRate).toBe(OVERRIDE_CUT_RATE)

    const toolResult = await generateFixtureMoves()
    const overrideResult = await generateFixtureMoves(operationOverride)

    expect(toolResult.heightTruth.bottomZ).toBe(0)
    expect(overrideResult.heightTruth.bottomZ).toBe(0)
    expect(toolResult.moves[1].feed).toBe(toolRates.feedRate)
    expect(overrideResult.moves[1].feed).toBe(overrideRates.feedRate)

    const toolFrames = buildFrames(toolResult.moves, MACHINE_RAPID_RATE).frames
    const overrideFrames = buildFrames(overrideResult.moves, MACHINE_RAPID_RATE).frames

    expect(toolFrames.map(frame => frame.speedMmPerMin)).toEqual([TOOL_CUT_RATE])
    expect(overrideFrames.map(frame => frame.speedMmPerMin)).toEqual([OVERRIDE_CUT_RATE])
    expect(toolFrames[0].durationMs).toBeCloseTo(7500, 9)
    expect(overrideFrames[0].durationMs).toBeCloseTo(6666.666666666667, 9)
  })

  it('fails loud when a cutting move reaches frame build without a finite positive feed', () => {
    for (const invalidFeed of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const moves = [
        { x: 0, y: 0, z: 0, type: 'rapid', role: 'rapid' },
        {
          x: 10,
          y: 0,
          z: 0,
          type: 'feed',
          role: 'cut',
          ...(invalidFeed === undefined ? {} : { feed: invalidFeed }),
        },
      ]

      expect(
        () => buildFrames(moves, MACHINE_RAPID_RATE),
        `invalid feed ${String(invalidFeed)} must be refused`,
      ).toThrow(/move 1.*cut.*finite positive feed/i)
    }
  })
})
