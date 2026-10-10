// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaticRoughTargetFacts } from '../../lib/cam/geometry/occt/model/types'
import { buildPlanarRoughSmartHeightIntent } from '../../lib/cam/smartHeights'
import type {
  BoundingBox,
  HeightIntentV1,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  Project,
  SceneStock,
  Setup,
  Tool,
  Vec3,
  WCS,
} from '../../types'
import { typedMock } from '../support/typedMock'

const { derivePrismaticRoughTarget, deriveCylinders } = vi.hoisted(() => ({
  derivePrismaticRoughTarget: vi.fn<(geoId: string) => Promise<PrismaticRoughTargetFacts>>(),
  deriveCylinders: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) => typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
  ...(await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()),
  derivePrismaticRoughTarget,
  deriveCylinders,
}))

import { useCamStore } from '../../store'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    },
  }
}

const stock: PhysicalStock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 80, z: 20 }),
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const foreignStock: PhysicalStock = {
  id: 'stock-2', name: 'Stock 2', mode: 'explicit',
  bounds: bbox({ x: 200, y: 0, z: 0 }, { x: 300, y: 80, z: 20 }),
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

function target(overrides: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'target-1', name: 'Target 1', filename: 'target.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: 10, y: 10, z: 0 }, { x: 60, y: 50, z: 20 }),
    position: { x: 10, y: 10, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, stockId: stock.id, loops: [], layers2d: [],
    ...overrides,
  } as ImportedGeometry
}

function facts(): PrismaticRoughTargetFacts {
  return {
    bounds: { min: [0, 0, 0], max: [50, 40, 20] },
    solidCount: 1,
    roughFloorZ: 10,
    keepOutRegions: [{
      faceIndex: 7,
      targetTopZ: 20,
      loop: {
        points: [{ x: 15, y: 10 }, { x: 35, y: 10 }, { x: 35, y: 30 }, { x: 15, y: 30 }],
        closed: true,
        type: 'contour',
        area: 400,
      },
    }],
    classification: {
      allFacesClassified: true,
      hasSlopedFaces: false,
      hasUndercuts: false,
      deckLevelsZ: [10],
      unclassifiedFaceIds: [],
    },
  }
}

const safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 22, provenance: 'user' },
}

function operation(type: 'pocket_2d' | 'adaptive_clearing_2d' = 'pocket_2d'): Operation {
  return {
    id: `${type}-1`, name: type === 'pocket_2d' ? 'Pocket 1' : 'Adaptive 1',
    type, enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: -999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildPlanarRoughSmartHeightIntent({
        setupId: 'setup-1',
        operationType: type,
        safetyIntent,
        mode: 'stock_rough',
        stockId: stock.id,
      }),
    },
    passes: {
      stepdown: 2, stepover: 2, stockToLeave: 0,
      floorStockToLeave: 1, finishPasses: 0, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      boundarySource: 'stock', geometryId: '', loopIds: [],
      floorStockToLeave: 99,
    },
  } as unknown as Operation
}

function geometryFloorOperation(
  type: 'pocket_2d' | 'adaptive_clearing_2d' = 'pocket_2d',
): Operation {
  const op = operation(type)
  op.geometrySelections = ['floor-loop']
  op.smartHeight = {
    kind: 'smart_v2',
    intent: buildPlanarRoughSmartHeightIntent({
      setupId: 'setup-1',
      operationType: type,
      safetyIntent,
      mode: 'geometry_floor',
      geometryIds: ['target-1'],
    }),
  }
  op.params = {
    boundarySource: 'geometry',
    geometryId: 'target-1',
    loopIds: ['floor-loop'],
    heightReference: 'geometry_face',
    planeOffset: 0,
    floorStockToLeave: 99,
  } as Operation['params']
  return op
}

function boundedGeometryOperation(
  type: 'pocket_2d' | 'adaptive_clearing_2d',
  mode: 'through_stock' | 'explicit_depth',
): Operation {
  const op = geometryFloorOperation(type)
  op.passes.floorStockToLeave = 0
  op.smartHeight = {
    kind: 'smart_v2',
    intent: buildPlanarRoughSmartHeightIntent({
      setupId: 'setup-1',
      operationType: type,
      safetyIntent,
      mode,
      geometryIds: ['target-1'],
      throughAllowanceMm: mode === 'through_stock' ? 0.75 : undefined,
      explicitTargetWcsMm: mode === 'explicit_depth' ? 8 : undefined,
    }),
  }
  op.params = {
    ...op.params,
    heightReference: mode === 'through_stock' ? 'stock_bottom' : 'absolute',
    planeOffset: mode === 'through_stock' ? -0.75 : 8,
  } as Operation['params']
  return op
}

function selectedFloorTarget(): ImportedGeometry {
  return target({
    loops: [{
      id: 'floor-loop', layerId: 'floor-layer', closed: true, type: 'contour', area: 1600,
      points: [
        { x: 10, y: 10 }, { x: 50, y: 10 },
        { x: 50, y: 50 }, { x: 10, y: 50 },
      ],
    }],
    layers2d: [{
      id: 'floor-layer', name: 'Floor', color: '#00e5ff', visible: true,
      projectionPlane: {
        origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
      },
    }],
  })
}

function setup(op: Operation, stockId = stock.id): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 }, stockId,
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 80, depth: 20,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [op], notes: '',
  } as Setup
}

const sceneStock: SceneStock = {
  mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
  fixedWidth: 100, fixedHeight: 80, fixedDepth: 20, fixedStocks: [],
} as SceneStock

const tool: Tool = {
  id: 'tool-1', name: '6 mm end mill', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: {
    default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 2 },
  },
} as unknown as Tool

describe('Planar rough Smart Height V2 store evidence', () => {
  let originalWorker: typeof Worker | undefined
  let requests: Array<{ type: string; payload: Record<string, unknown> }>

  beforeEach(() => {
    requests = []
    derivePrismaticRoughTarget.mockReset()
    derivePrismaticRoughTarget.mockResolvedValue(facts())
    deriveCylinders.mockClear()
    originalWorker = globalThis.Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage(data: { type: string; payload: Record<string, unknown> }): void {
        requests.push(data)
        queueMicrotask(() => this.onmessage?.({
          data: { type: 'TOOLPATH_COMPLETE', moves: [], computeTimeMs: 1 },
        } as MessageEvent))
      }
      terminate(): void { /* no-op */ }
    }
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 } }),
    }
  })

  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = originalWorker
    delete (window as unknown as Record<string, unknown>).__cncViewport
    vi.restoreAllMocks()
  })

  function load(op: Operation, geometry: ImportedGeometry[], setupStockId = stock.id): void {
    useCamStore.setState(state => ({
      toolLibrary: [tool],
      project: {
        ...state.project,
        geometry,
        stocks: [stock, foreignStock],
        sceneStock,
        setups: [setup(op, setupStockId)],
        activeSetupId: 'setup-1',
      } as Project,
    }))
  }

  it('resolves current stock material to the proven target deck with allowance once', async () => {
    const op = operation()
    load(op, [target()])

    const preview = await useCamStore.getState()
      .previewPlanarRoughSmartHeights('setup-1', op)

    expect(preview.wcs).toMatchObject({
      clearance: 30, retract: 25, feed: 22, top: 20, bottom: 11,
    })
    expect(preview.machine.bottom).toBe(11)
    expect(derivePrismaticRoughTarget).toHaveBeenCalledTimes(1)
    expect(derivePrismaticRoughTarget).toHaveBeenCalledWith('target-1')
  })

  it('dispatches the same plan, exact keep-out loop, and zero worker allowance', async () => {
    const op = operation()
    load(op, [target()])
    const preview = await useCamStore.getState()
      .previewPlanarRoughSmartHeights('setup-1', op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_POCKET')
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 20, bottomHeight: 11 })
    expect(requests[0].payload.passes).toMatchObject({ floorStockToLeave: 0 })
    expect(requests[0].payload.loops).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'smart-height-keep-out:target-1:face:7',
        closed: true,
        type: 'hole',
      }),
    ]))
    expect(deriveCylinders).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights)
      .toEqual(preview)
  })

  it('gives Adaptive Clearing 2D the identical compiled authority', async () => {
    const op = operation('adaptive_clearing_2d')
    load(op, [target()])
    const preview = await useCamStore.getState()
      .previewPlanarRoughSmartHeights('setup-1', op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests[0].type).toBe('COMPUTE_ADAPTIVE_CLEARING')
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 20, bottomHeight: 11 })
    expect(requests[0].payload.passes).toMatchObject({ floorStockToLeave: 0 })
    expect(requests[0].payload.loops).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'smart-height-keep-out:target-1:face:7', type: 'hole' }),
    ]))
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights)
      .toEqual(preview)
  })

  it.each([
    ['pocket_2d', 'COMPUTE_POCKET'],
    ['adaptive_clearing_2d', 'COMPUTE_ADAPTIVE_CLEARING'],
  ] as const)('%s resolves and dispatches the selected geometry floor without solid compilation', async (
    type,
    requestType,
  ) => {
    const op = geometryFloorOperation(type)
    load(op, [selectedFloorTarget()])

    const preview = await useCamStore.getState()
      .previewPlanarRoughSmartHeights('setup-1', op)

    expect(preview.wcs).toMatchObject({
      clearance: 30, retract: 25, feed: 22, top: 20, bottom: 11,
    })
    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe(requestType)
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 20, bottomHeight: 11 })
    expect(requests[0].payload.passes).toMatchObject({ floorStockToLeave: 0 })
    expect(derivePrismaticRoughTarget).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights)
      .toEqual(preview)
  })

  it.each([
    ['pocket_2d', 'through_stock', 'COMPUTE_POCKET', -0.75],
    ['pocket_2d', 'explicit_depth', 'COMPUTE_POCKET', 8],
    ['adaptive_clearing_2d', 'through_stock', 'COMPUTE_ADAPTIVE_CLEARING', -0.75],
    ['adaptive_clearing_2d', 'explicit_depth', 'COMPUTE_ADAPTIVE_CLEARING', 8],
  ] as const)('%s resolves and dispatches %s from the same V2 plan', async (
    type,
    mode,
    requestType,
    expectedBottom,
  ) => {
    const op = boundedGeometryOperation(type, mode)
    load(op, [selectedFloorTarget()])

    const preview = await useCamStore.getState()
      .previewPlanarRoughSmartHeights('setup-1', op)
    expect(preview.wcs).toMatchObject({ top: 20, bottom: expectedBottom })

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe(requestType)
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 20, bottomHeight: expectedBottom })
    expect(requests[0].payload.passes).toMatchObject({ floorStockToLeave: 0 })
    expect(derivePrismaticRoughTarget).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights)
      .toEqual(preview)
  })

  it('uses V2 selected geometry evidence instead of legacy selected-face scalars', async () => {
    const op = geometryFloorOperation()
    op.heights.bottomHeightMode = 'selected_face'
    op.heights.selectedFaceZ = 7
    ;(op.params as Record<string, unknown>).heightReference = 'picked_plane'
    load(op, [selectedFloorTarget()])

    const preview = await useCamStore.getState()
      .previewPlanarRoughSmartHeights('setup-1', op)

    expect(preview.wcs).toMatchObject({ top: 20, bottom: 11 })
    expect(derivePrismaticRoughTarget).not.toHaveBeenCalled()
  })

  it('derives only complete target solids assigned to the exact intent stock', async () => {
    const op = operation()
    load(op, [
      target(),
      target({ id: 'foreign-target', name: 'Foreign', stockId: foreignStock.id }),
      target({ id: 'drawing', name: 'Drawing', type: 'curves_2d', format: 'dxf' }),
    ])

    await useCamStore.getState().previewPlanarRoughSmartHeights('setup-1', op)

    expect(derivePrismaticRoughTarget).toHaveBeenCalledTimes(1)
    expect(derivePrismaticRoughTarget).toHaveBeenCalledWith('target-1')
  })

  it('refuses an assigned mesh target instead of silently omitting it', async () => {
    const op = operation()
    load(op, [target(), target({ id: 'mesh-1', name: 'Mesh target', type: 'mesh', format: 'stl' })])

    await expect(useCamStore.getState().previewPlanarRoughSmartHeights('setup-1', op))
      .rejects.toThrow(/cannot yet prove target 'Mesh target' \(mesh\/stl\)/)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0]).toMatchObject({
      status: 'error',
      errorMessage: expect.stringMatching(/cannot yet prove target 'Mesh target' \(mesh\/stl\)/),
    })
    expect(derivePrismaticRoughTarget).not.toHaveBeenCalled()
  })

  it('refuses a stale policy whose setup no longer proves the same stock', async () => {
    const op = operation()
    load(op, [target()], foreignStock.id)

    await expect(useCamStore.getState().previewPlanarRoughSmartHeights('setup-1', op))
      .rejects.toThrow(/cannot prove that stock 'stock-1' is the active Setup stock/)
    expect(derivePrismaticRoughTarget).not.toHaveBeenCalled()
  })

  it('refuses a non-V2 planar authority before evidence compilation', async () => {
    const op = operation()
    op.smartHeight = { kind: 'obsolete_height_authority' } as unknown as Operation['smartHeight']
    load(op, [target()])

    expect(() => useCamStore.getState().previewPlanarRoughSmartHeights('setup-1', op))
      .toThrow(/no valid Smart Height V2/)
    expect(derivePrismaticRoughTarget).not.toHaveBeenCalled()
  })

  it('refuses a non-V2 planar authority before worker dispatch', async () => {
    const op = operation()
    op.smartHeight = { kind: 'obsolete_height_authority' } as unknown as Operation['smartHeight']
    op.heights = {
      clearanceHeight: 30, clearanceHeightMode: 'absolute',
      retractHeight: 25, feedHeight: 22,
      topHeight: 20, topHeightMode: 'absolute',
      bottomHeight: 10, bottomHeightMode: 'absolute',
    }
    ;(op.params as Record<string, unknown>).heightReference = 'absolute'
    ;(op.params as Record<string, unknown>).planeOffset = 0
    load(op, [target()])

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(0)
    expect(derivePrismaticRoughTarget).not.toHaveBeenCalled()
    expect(deriveCylinders).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.setups[0].operations[0]).toMatchObject({
      status: 'error',
      errorMessage: expect.stringMatching(/no valid Smart Height V2/),
    })
  })
})
