// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDrillBoreSmartHeightIntent,
  deriveDrillBoreFeatureBindings,
  drillPointCompensationMm,
} from '../../lib/cam/smartHeights'
import { useCamStore } from '../../store'
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

const circlePoints = (cx: number, cy: number, radius: number) =>
  Array.from({ length: 32 }, (_, index) => {
    const angle = 2 * Math.PI * index / 32
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
  })

function drillGeometry(floorZ = 4, through = false): ImportedGeometry {
  return {
    id: 'part-1', name: 'Part 1', filename: 'part.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 30, z: 10 }),
    position: { x: 0, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, stockId: stock.id,
    loops: [{
      id: 'hole-1', layerId: 'holes', points: circlePoints(10, 10, 3),
      closed: true, type: 'contour', area: Math.PI * 9,
    }],
    layers2d: [{
      id: 'holes', name: 'Holes', color: '#fff', visible: true, frame: 'geometry_local',
      holes: [{
        center: [10, 10], diameter: 6, topZ: 10, bottomZ: floorZ,
        through, loopId: 'hole-1',
      }],
    }],
  } as ImportedGeometry
}

function boreGeometry(floorZ = 4): ImportedGeometry {
  const geometry = drillGeometry(floorZ)
  return {
    ...geometry,
    loops: [{
      id: 'bore-1', layerId: 'bores', points: circlePoints(10, 10, 6),
      closed: true, type: 'contour', area: Math.PI * 36,
    }],
    layers2d: [{
      id: 'bores', name: 'Bores', color: '#fff', visible: true, frame: 'geometry_local',
      cylinders: [{
        center: [10, 10], diameter: 12, topZ: 10, bottomZ: floorZ,
        through: false, kind: 'bore', loopId: 'bore-1',
      }],
    }],
  } as ImportedGeometry
}

const drillTool: Tool = {
  id: 'drill-tool', name: '6 mm drill', type: 'drill', diameter: 6,
  fluteLength: 25, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  angleFromAxisDeg: 59, tipDiameter: 0,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 8000, feedRate: 300, plungeRate: 120, depthOfCut: 2, stepover: 1 } },
} as Tool

const boreTool: Tool = {
  ...drillTool,
  id: 'bore-tool', name: '6 mm end mill', type: 'flat_end_mill',
}

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 22, provenance: 'user' },
}

function operation(type: 'drill' | 'bore', geometry: ImportedGeometry): Operation {
  const loopId = type === 'drill' ? 'hole-1' : 'bore-1'
  const derived = deriveDrillBoreFeatureBindings([geometry], [loopId], type)
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  return {
    id: `${type}-1`, name: `${type} 1`, type, enabled: true, status: 'pending',
    toolId: type === 'drill' ? drillTool.id : boreTool.id,
    geometrySelections: [loopId],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: -999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildDrillBoreSmartHeightIntent({
        operationType: type,
        setupId: 'setup-1',
        safetyIntent: safety,
        mode: 'detected_features',
        features: derived.bindings.map(binding => ({
          loopId: binding.loopId,
          feature: binding.feature,
          topMachineMm: binding.topMm + geometry.position.z,
          floorMachineMm: binding.floorMm + geometry.position.z,
          fingerprint: binding.evidenceFingerprint,
        })),
      }),
    },
    passes: {
      stepdown: 2, stepover: 1, stockToLeave: 0,
      floorStockToLeave: 0, finishPasses: 1, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: type === 'drill' ? {
      geometryId: geometry.id, loopIds: [loopId], cycleType: 'simple',
      peckDepth: 2, chipBreakRetract: 1, dwell: 0,
      retractMode: 'retract', sortStrategy: 'none', perHoleDepth: false,
    } : {
      geometryId: geometry.id, loopIds: [loopId], direction: 'climb',
      sortStrategy: 'none', geometrySource: 'cylinder', targetDiameter: 12,
      perBoreDepth: false,
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

describe('Drill/Bore Smart Height V2 store dispatch', () => {
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
      toolLibrary: [drillTool, boreTool],
      project: {
        ...state.project,
        geometry: [geometry], stocks: [stock], sceneStock,
        setups: [setup(op)], activeSetupId: 'setup-1',
      } as Project,
    }))
  }

  it('dispatches Drill from current stock and the exact detected floor with point compensation once', async () => {
    // The hole marked through (WO-2678: a blind floor takes no point): the point is added once.
    const geometry = drillGeometry(4, true)
    const op = operation('drill', geometry)
    load(geometry, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_DRILL')
    const point = drillPointCompensationMm(drillTool)
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 20, bottomHeight: 6 - point })
    expect(requests[0].payload.holeBottoms).toEqual({ 'hole-1': 6 - point })
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights?.wcs)
      .toMatchObject({ top: 20, bottom: 6 - point })
  })

  it('WO-2678: dispatches Drill on a blind detected floor with the tip at the floor', async () => {
    const geometry = drillGeometry()
    const op = operation('drill', geometry)
    load(geometry, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests[0].payload.heights).toMatchObject({ topHeight: 20, bottomHeight: 6 })
    expect(requests[0].payload.holeBottoms).toEqual({ 'hole-1': 6 })
  })

  it('previews the same Drill envelope without mutating or dispatching the operation', () => {
    const geometry = drillGeometry()
    const op = operation('drill', geometry)
    load(geometry, op)

    const before = structuredClone(useCamStore.getState().project.setups[0].operations[0])
    const resolved = useCamStore.getState().previewDrillBoreSmartHeights('setup-1', op)

    // WO-2678: the hole is blind, so the preview's tip is its floor, as dispatched.
    expect(resolved.wcs).toMatchObject({ top: 20, bottom: 6 })
    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0]).toEqual(before)
  })

  it('dispatches Bore per-feature endpoints even when the legacy per-depth toggle is off', async () => {
    const geometry = boreGeometry()
    const op = operation('bore', geometry)
    load(geometry, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_BORE')
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 20, bottomHeight: 6 })
    expect(requests[0].payload.boreBottoms).toEqual({ 'bore-1': 6 })
  })

  it('treats a manual per-hole endpoint as exact and does not add drill-point compensation again', async () => {
    const geometry = drillGeometry()
    const op = operation('drill', geometry)
    const derived = deriveDrillBoreFeatureBindings([geometry], ['hole-1'], 'drill')
    if (!derived.ok) throw new Error(derived.refusals[0].message)
    op.smartHeight = {
      kind: 'smart_v2',
      intent: buildDrillBoreSmartHeightIntent({
        operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
        mode: 'detected_features',
        features: derived.bindings.map(binding => ({
          loopId: binding.loopId,
          feature: binding.feature,
          topMachineMm: binding.topMm + geometry.position.z,
          floorMachineMm: binding.floorMm + geometry.position.z,
          fingerprint: binding.evidenceFingerprint,
        })),
        perFeatureEndOverridesWcsMm: { 'hole-1': 5 },
      }),
    }
    load(geometry, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests[0].payload.heights).toMatchObject({ topHeight: 20, bottomHeight: 5 })
    expect(requests[0].payload.holeBottoms).toEqual({ 'hole-1': 5 })
  })

  it('dispatches explicit start/end planes without inventing detected feature endpoints', async () => {
    const geometry = drillGeometry()
    const op = operation('drill', geometry)
    op.smartHeight = {
      kind: 'smart_v2',
      intent: buildDrillBoreSmartHeightIntent({
        operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
        mode: 'explicit_depth', geometryIds: [geometry.id],
        explicitStartWcsMm: 18, explicitEndWcsMm: 3,
      }),
    }
    load(geometry, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests[0].payload.heights).toMatchObject({ topHeight: 18, bottomHeight: 3 })
    expect(requests[0].payload.holeBottoms).toBeUndefined()
  })

  it('refuses changed feature topology before worker dispatch', async () => {
    const authored = drillGeometry(4)
    const op = operation('drill', authored)
    load(drillGeometry(3), op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0].errorMessage)
      .toMatch(/feature identity is stale/)
  })
})
