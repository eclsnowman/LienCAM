// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildContourSmartHeightIntent,
  deriveContourFeatureBindings,
} from '../../lib/cam/smartHeights'
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

function cylinderGeometry(positionZ = 2, lowFloor = 1): ImportedGeometry {
  return {
    id: 'part-1', name: 'Part 1', filename: 'part.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: 10, y: 10, z: 0 }, { x: 60, y: 50, z: 10 }),
    position: { x: 10, y: 10, z: positionZ }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, stockId: stock.id, loopsVersion: 3,
    loops: [
      {
        id: 'boss-high', layerId: 'cylinders', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }],
        closed: true, type: 'contour', area: 12.5,
      },
      {
        id: 'bore-low', layerId: 'cylinders', points: [{ x: 10, y: 10 }, { x: 12, y: 10 }, { x: 10, y: 12 }],
        closed: true, type: 'hole', area: 2,
      },
    ],
    layers2d: [{
      id: 'cylinders', name: 'Cylinders', color: '#fff', visible: true, frame: 'geometry_local',
      cylinders: [
        { center: [2, 2], diameter: 5, topZ: 10, bottomZ: 4, through: false, kind: 'boss', loopId: 'boss-high' },
        { center: [11, 11], diameter: 2, topZ: 10, bottomZ: lowFloor, through: false, kind: 'bore', loopId: 'bore-low' },
      ],
    }],
  } as ImportedGeometry
}

const safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 22, provenance: 'user' },
}

function operation(geometry: ImportedGeometry): Operation {
  const derived = deriveContourFeatureBindings([geometry], ['boss-high', 'bore-low'])
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  return {
    id: 'contour-1', name: 'Contour 1', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: ['boss-high', 'bore-low'],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: -999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildContourSmartHeightIntent({
        setupId: 'setup-1',
        safetyIntent,
        mode: 'selected_feature',
        features: derived.bindings.map(binding => binding.feature),
      }),
    },
    passes: {
      stepdown: 2, stepover: 2, stockToLeave: 0,
      floorStockToLeave: 0.5, finishPasses: 1, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: geometry.id,
      loopIds: ['boss-high', 'bore-low'],
      side: 'outer', direction: 'climb', tabs: false,
    },
  } as unknown as Operation
}

function setup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 }, stockId: stock.id,
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

describe('Contour Smart Height V2 store authority', () => {
  let originalWorker: typeof Worker | undefined
  let requests: Array<{ type: string; payload: Record<string, unknown> }>

  beforeEach(() => {
    requests = []
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

  function load(geometry: ImportedGeometry, op: Operation): void {
    useCamStore.setState(state => ({
      toolLibrary: [tool],
      project: {
        ...state.project,
        geometry: [geometry],
        stocks: [stock],
        sceneStock,
        setups: [setup(op)],
        activeSetupId: 'setup-1',
      } as Project,
    }))
  }

  it('previews current stock and exact mixed feature floors', () => {
    const geometry = cylinderGeometry()
    const op = operation(geometry)
    load(geometry, op)

    const preview = useCamStore.getState().previewContourSmartHeights('setup-1', op)

    expect(preview.wcs).toMatchObject({
      clearance: 30, retract: 25, feed: 22, top: 20, bottom: 3.5,
    })
  })

  it('dispatches the same envelope, per-loop endpoints, and zero worker allowance', async () => {
    const geometry = cylinderGeometry()
    const op = operation(geometry)
    load(geometry, op)
    const preview = useCamStore.getState().previewContourSmartHeights('setup-1', op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    const computed = useCamStore.getState().project.setups[0].operations[0]
    expect(computed.errorMessage).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_CONTOUR')
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 20, bottomHeight: 3.5 })
    expect(requests[0].payload.loopBottoms).toEqual({ 'boss-high': 6.5, 'bore-low': 3.5 })
    expect(requests[0].payload.passes).toMatchObject({ floorStockToLeave: 0 })
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights).toEqual(preview)
  })

  it('re-resolves placement without changing feature identity', () => {
    const authoredGeometry = cylinderGeometry(2)
    const op = operation(authoredGeometry)
    const movedGeometry = cylinderGeometry(5)
    load(movedGeometry, op)

    const preview = useCamStore.getState().previewContourSmartHeights('setup-1', op)
    expect(preview.wcs.bottom).toBe(6.5)
  })

  it('resolves an explicit endpoint from current material without using a Top-minus-depth default', () => {
    const geometry = cylinderGeometry()
    const op = operation(geometry)
    op.smartHeight = {
      kind: 'smart_v2',
      intent: buildContourSmartHeightIntent({
        setupId: 'setup-1', safetyIntent, mode: 'explicit_depth',
        geometryIds: [geometry.id], explicitTargetWcsMm: 5,
      }),
    }
    load(geometry, op)

    const preview = useCamStore.getState().previewContourSmartHeights('setup-1', op)
    expect(preview.wcs).toMatchObject({ top: 20, bottom: 5.5 })
  })

  it('resolves through-stock against the proven Setup stock and applies allowance once', () => {
    const geometry = cylinderGeometry()
    const op = operation(geometry)
    op.smartHeight = {
      kind: 'smart_v2',
      intent: buildContourSmartHeightIntent({
        setupId: 'setup-1', safetyIntent, mode: 'through_stock',
        geometryIds: [geometry.id], throughAllowanceMm: 0.2,
      }),
    }
    load(geometry, op)

    const preview = useCamStore.getState().previewContourSmartHeights('setup-1', op)
    expect(preview.wcs).toMatchObject({ top: 20, bottom: 0.3 })
  })

  it('refuses a target whose owning stock is not proven to match the Setup', () => {
    const geometry = { ...cylinderGeometry(), stockId: undefined } as ImportedGeometry
    const op = operation(cylinderGeometry())
    load(geometry, op)

    expect(() => useCamStore.getState().previewContourSmartHeights('setup-1', op))
      .toThrow(/belongs to stock 'unassigned'/)
  })

  it('refuses changed feature facts under the old stable identity', () => {
    const authoredGeometry = cylinderGeometry(2, 1)
    const op = operation(authoredGeometry)
    load(cylinderGeometry(2, 0.5), op)

    expect(() => useCamStore.getState().previewContourSmartHeights('setup-1', op))
      .toThrow(/selected-feature identity is stale/)
  })

  it('refuses a non-V2 Contour authority through the shared repair boundary', () => {
    const geometry = cylinderGeometry()
    const op = operation(geometry)
    op.smartHeight = { kind: 'obsolete_height_authority' } as unknown as Operation['smartHeight']
    load(geometry, op)

    expect(() => useCamStore.getState().previewContourSmartHeights('setup-1', op))
      .toThrow(/no valid Smart Height V2/)
  })
})
