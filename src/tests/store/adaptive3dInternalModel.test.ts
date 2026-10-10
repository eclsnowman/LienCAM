import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Adaptive3dPartSourceError,
  resolveAdaptive3dPartSource,
} from '../../cam3d/integration/adaptive3dPartSource'
import { Cam3dClient } from '../../cam3d/worker/client'
import type { PartMesh } from '../../cam3d/kernel/types'
import { legacyHeightIntentForOperation } from '../../lib/cam/heightIntent'
import { buildAdaptive3dSmartIntent } from '../../lib/cam/smartHeights'
import { typedMock } from '../support/typedMock'
import type {
  ImportedGeometry,
  ModelItemPlacementRecord,
  Operation,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'

const bridge = vi.hoisted(() => ({
  acquirePartMesh: vi.fn(),
  computeAdaptive3dMoves: vi.fn(),
  loadCachedSTL: vi.fn(),
  loadCachedStep: vi.fn(),
}))

vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()
  return typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...actual,
    acquirePartMesh: bridge.acquirePartMesh,
  })
})

vi.mock('../../cam3d/integration/adaptive3dOperation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/adaptive3dOperation')>()
  return typedMock<typeof import('../../cam3d/integration/adaptive3dOperation')>({
    ...actual,
    computeAdaptive3dMoves: bridge.computeAdaptive3dMoves,
  })
})

vi.mock('../../cam3d/integration/appClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  return typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...actual,
    // A genuine Cam3dClient over a no-op WorkerLike: no real Worker spawns, but
    // the return value is a real instance (not a stand-in shape) so it type-checks
    // against the real export and satisfies the reference-identity checks
    // (restStartStockFor's `retained.client !== input.client`) callers may make.
    getCam3dClient: () => new Cam3dClient({
      postMessage: () => {},
      terminate: () => {},
      onmessage: null,
      onerror: null,
    }),
  })
})

vi.mock('../../lib/stlCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stlCache')>()
  return typedMock<typeof import('../../lib/stlCache')>({
    ...actual,
    loadCachedSTL: bridge.loadCachedSTL,
  })
})

vi.mock('../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof import('../../lib/stepCache')>({
    ...actual,
    loadCachedStep: bridge.loadCachedStep,
  })
})

const { useCamStore, getAdaptive3dCarvedStock } = await import('../../store')
const { cancelAllSerializedCam3dComputes } = await import('../../store/toolpathBatchScheduler')

const MODEL_GEO_ID = 'modelbody:feature-1'
const TOOL_ID = 'tool-1'
const SETUP_ID = 'setup-1'
const OP_ID = 'adaptive-1'

const cubePositions = [
  0, 0, 0,
  10, 0, 0,
  10, 10, 0,
  0, 10, 0,
  0, 0, 10,
  10, 0, 10,
  10, 10, 10,
  0, 10, 10,
]

const cubeIndices = [
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6,
  3, 0, 4, 3, 4, 7,
]

const placement: ModelItemPlacementRecord = {
  modelItemId: 'item-1',
  position: { x: 10, y: 20, z: 30 },
  rotation: { x: 0, y: 0, z: 90 },
}

const STOCK_ID = 'stock-1'

// Every adaptive_3d Smart Height V2 variant -- bounded_band included --
// requires 'owning_stock' evidence in its policy (OPERATION_HEIGHT_POLICIES),
// even though bounded_band's own planes never read the stock's numbers. A
// large explicit block that only needs to CONTAIN the placed part (world
// bounds x:[0,10] y:[20,30] z:[30,40] after the 90deg placement) satisfies
// the evidence requirement without affecting any resolved height.
const STOCK = {
  id: STOCK_ID,
  name: 'Stock',
  mode: 'explicit' as const,
  bounds: {
    min: { x: -50, y: -50, z: -50 },
    max: { x: 100, y: 100, z: 100 },
    size: { x: 150, y: 150, z: 150 },
    center: { x: 25, y: 25, z: 25 },
  },
  position: { x: -50, y: -50, z: -50 },
}

function modeledSolid(indices = cubeIndices): ImportedGeometry {
  return {
    id: MODEL_GEO_ID,
    name: 'Modeled Widget',
    filename: '',
    type: 'model',
    format: 'model',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 },
      center: { x: 5, y: 5, z: 5 },
    },
    modelItemId: 'item-1',
    stockId: STOCK_ID,
    modelBody: {
      ref: { bodyId: 'feature-1', stableIds: [], version: 1 },
      display: {
        positions: cubePositions,
        normals: [],
        indices,
        edgePositions: [],
        edgeOffsets: [],
        bbox: { min: [0, 0, 0], max: [10, 10, 10] },
      },
    },
  }
}

function importedStl(): ImportedGeometry {
  return {
    id: 'stl-1',
    name: 'Imported Widget',
    filename: 'widget.stl',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    position: { x: 4, y: 5, z: 6 },
    rotation: { x: 0, y: 0, z: 15 },
    boundingBox: {
      min: { x: 10, y: 20, z: 5 },
      max: { x: 14, y: 26, z: 9 },
      size: { x: 4, y: 6, z: 4 },
      center: { x: 12, y: 23, z: 7 },
    },
  }
}

const tool = {
  id: TOOL_ID,
  name: 'Flat 6mm',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 20,
  shankDiameter: 6,
  overallLength: 50,
  numberOfFlutes: 2,
} as Tool

function adaptiveOperation(): Operation {
  const heights = {
    clearanceHeight: 20,
    clearanceHeightMode: 'absolute' as const,
    retractHeight: 10,
    feedHeight: 8,
    topHeight: 0,
    topHeightMode: 'absolute' as const,
    bottomHeight: -3,
    bottomHeightMode: 'absolute' as const,
  }
  return {
    id: OP_ID,
    name: 'Adaptive modeled solid',
    type: 'adaptive_3d',
    enabled: true,
    status: 'pending',
    toolId: TOOL_ID,
    geometrySelections: [MODEL_GEO_ID],
    heights,
    passes: { stepdown: 2, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 2, rampLength: 5,
      leadInRadius: 1, leadOutRadius: 1,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: { maxStepdown: 2, stepover: 0.4, tolerance: 0.05, helixDiameter: 3 },
    // This suite has no PhysicalStock at all (setup.stock is null), so the
    // fixture's usual 'current_material' Smart Height variant would refuse
    // for want of a proven owning stock. The op's own heights are already an
    // explicit absolute Top/Bottom, so author 'bounded_band' instead -- it
    // resolves off explicit WCS planes only, matching the op's stated intent
    // without inventing a stock the test scenario deliberately has none of.
    smartHeight: {
      kind: 'smart_v2' as const,
      intent: buildAdaptive3dSmartIntent({
        setupId: SETUP_ID,
        geometryIds: [MODEL_GEO_ID],
        safetyIntent: legacyHeightIntentForOperation({
          type: 'adaptive_3d', heights, params: {},
        }),
        mode: 'bounded_band',
        boundedBand: { topWcsMm: heights.topHeight, bottomWcsMm: heights.bottomHeight },
      }),
    },
  } as Operation
}

function setupWith(op: Operation): Setup {
  return {
    id: SETUP_ID,
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    stock: null,
    operations: [op],
    notes: '',
  } as unknown as Setup
}

function install(geo: ImportedGeometry): void {
  useCamStore.setState((state) => ({
    toolLibrary: [tool],
    project: {
      ...state.project,
      geometry: [geo],
      setups: [setupWith(adaptiveOperation())],
      stocks: [STOCK],
      activeSetupId: SETUP_ID,
      modelItemPlacements: [placement],
    },
  }))
}

function currentOperation(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  cancelAllSerializedCam3dComputes()
  bridge.computeAdaptive3dMoves.mockImplementation(async (args: {
    resolvedHeights: { clearanceZ: number; retractZ: number; feedZ: number; topZ: number; bottomZ: number }
  }) => ({
    // WO-1678: above the 10 mm cube - the store's tool-reach seam trims a cut
    // that would put the cutter inside the part.
    moves: [{ type: 'feed', x: 1, y: 2, z: 13, feed: 300, role: 'cut' } as ToolpathMove],
    computeTimeMs: 1,
    carvedStock: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    },
    carvedStockWarning: undefined,
    diagnostics: undefined,
    heightTruth: args.resolvedHeights,
  }))
})

afterEach(() => {
  cancelAllSerializedCam3dComputes()
})

describe('Adaptive 3D source normalization', () => {
  it('normalizes a closed modeled solid with its canonical placement', () => {
    const resolved = resolveAdaptive3dPartSource(modeledSolid(), [placement])

    expect(resolved.partMesh.source).toBe('model')
    expect(Array.from(resolved.partMesh.positions)).toEqual(cubePositions)
    expect(Array.from(resolved.partMesh.indices)).toEqual(cubeIndices)
    expect(resolved.partMesh.bounds).toEqual({ min: [0, 0, 0], max: [10, 10, 10] })
    expect(resolved.position).toEqual(placement.position)
    expect(resolved.rotation).toEqual(placement.rotation)
  })

  it('recognizes a closed OCCT display mesh whose face vertices use separate indices', () => {
    const splitPositions: number[] = []
    const splitIndices: number[] = []
    for (const sourceIndex of cubeIndices) {
      splitIndices.push(splitIndices.length)
      splitPositions.push(
        cubePositions[sourceIndex * 3],
        cubePositions[sourceIndex * 3 + 1],
        cubePositions[sourceIndex * 3 + 2],
      )
    }
    const geo = modeledSolid(splitIndices)
    geo.modelBody!.display!.positions = splitPositions

    const resolved = resolveAdaptive3dPartSource(geo, [placement])

    expect(resolved.partMesh.source).toBe('model')
    expect(resolved.partMesh.indices).toHaveLength(cubeIndices.length)
  })

  it('refuses an open modeled mesh by name instead of dispatching a plausible surface', () => {
    expect(() => resolveAdaptive3dPartSource(modeledSolid([0, 1, 2]), [placement]))
      .toThrowError(Adaptive3dPartSourceError)
    expect(() => resolveAdaptive3dPartSource(modeledSolid([0, 1, 2]), [placement]))
      .toThrow(/Modeled Widget.*not a closed, watertight solid/)
  })

  it('preserves the existing imported STL display recentering and row pose', () => {
    const importedMesh: PartMesh = {
      positions: new Float32Array([10, 20, 5, 14, 20, 5, 10, 26, 9]),
      indices: new Uint32Array([0, 1, 2]),
      bounds: { min: [10, 20, 5], max: [14, 26, 9] },
      source: 'stl',
    }
    const geo = importedStl()
    const resolved = resolveAdaptive3dPartSource(geo, [], importedMesh)

    expect(Array.from(resolved.partMesh.positions)).toEqual([-2, -3, 0, 2, -3, 0, -2, 3, 4])
    expect(resolved.partMesh.bounds).toEqual({ min: [-2, -3, 0], max: [2, 3, 4] })
    expect(resolved.position).toEqual(geo.position)
    expect(resolved.rotation).toEqual(geo.rotation)
  })
})

describe('Adaptive 3D modeled-solid store compute', () => {
  it('uses the normalized model PartMesh for compute, moves, and carved-stock preview', async () => {
    install(modeledSolid())

    await useCamStore.getState().computeOperationToolpath(SETUP_ID, OP_ID)

    expect(bridge.acquirePartMesh).not.toHaveBeenCalled()
    expect(bridge.loadCachedSTL).not.toHaveBeenCalled()
    expect(bridge.loadCachedStep).not.toHaveBeenCalled()
    expect(bridge.computeAdaptive3dMoves).toHaveBeenCalledOnce()
    const computeArgs = bridge.computeAdaptive3dMoves.mock.calls[0][0]
    expect(computeArgs.partMesh.source).toBe('model')
    expect(Array.from(computeArgs.partMesh.positions)).toEqual(cubePositions)
    expect(currentOperation().status).toBe('ready')
    expect(currentOperation().toolpathMoves?.[0]).toMatchObject({ x: 8, y: 21, z: 43 })
    expect(getAdaptive3dCarvedStock(OP_ID)).toMatchObject({
      position: placement.position,
      rotationZDeg: 90,
    })
  })

  it('lands an open modeled source in a useful error without worker dispatch', async () => {
    install(modeledSolid([0, 1, 2]))

    await useCamStore.getState().computeOperationToolpath(SETUP_ID, OP_ID)

    expect(bridge.computeAdaptive3dMoves).not.toHaveBeenCalled()
    expect(currentOperation().status).toBe('error')
    expect(currentOperation().errorMessage).toMatch(/Modeled Widget.*not a closed, watertight solid/)
  })
})
