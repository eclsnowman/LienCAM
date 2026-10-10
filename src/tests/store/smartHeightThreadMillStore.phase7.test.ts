// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildThreadMillSmartHeightIntent,
  deriveThreadMillFeatureBindings,
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

function threadGeometry(kind: 'bore' | 'boss', floorZ = 4): ImportedGeometry {
  const loopId = `${kind}-1`
  return {
    id: 'part-1', name: 'Part 1', filename: 'part.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 30, z: 10 }),
    position: { x: 0, y: 0, z: 2 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, stockId: stock.id,
    loops: [{
      id: loopId, layerId: 'threads', points: circlePoints(10, 10, 5),
      closed: true, type: kind === 'bore' ? 'contour' : 'hole', area: Math.PI * 25,
    }],
    layers2d: [{
      id: 'threads', name: 'Threads', color: '#fff', visible: true, frame: 'geometry_local',
      cylinders: [{
        center: [10, 10], diameter: 10, topZ: 10, bottomZ: floorZ,
        through: false, kind, loopId,
      }],
    }],
  } as ImportedGeometry
}

const tool: Tool = {
  id: 'thread-tool', name: 'Thread mill', type: 'thread_mill', diameter: 3,
  fluteLength: 12, shankDiameter: 3, overallLength: 50, numberOfFlutes: 3,
  neckDiameter: 2, shoulderLength: 20,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 8000, feedRate: 300, plungeRate: 120, depthOfCut: 2, stepover: 1 } },
} as Tool

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 22, provenance: 'user' },
}

function operation(
  geometry: ImportedGeometry,
  kind: 'internal' | 'external',
  reference: 'top' | 'base' = 'top',
): Operation {
  const loopId = kind === 'internal' ? 'bore-1' : 'boss-1'
  const derived = deriveThreadMillFeatureBindings([geometry], [loopId])
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  const features = derived.bindings.map(binding => ({
    loopId: binding.loopId,
    featureKind: binding.featureKind,
    feature: binding.feature,
    topMachineMm: binding.topMm + geometry.position.z,
    floorMachineMm: binding.floorMm + geometry.position.z,
    fingerprint: binding.evidenceFingerprint,
  }))
  return {
    id: 'thread-1', name: 'Thread Mill 1', type: 'thread_mill', enabled: true, status: 'pending',
    toolId: tool.id, geometrySelections: [loopId],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: -999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildThreadMillSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: safety, source: 'detected_feature',
        threadKind: kind, externalReference: reference, threadDepthMm: 5, features,
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
    params: {
      geometryId: geometry.id, loopIds: [loopId], geometrySource: 'cylinder',
      threadKind: kind, externalReference: reference,
      majorDiameter: 10, pitch: 1.5, handedness: 'right', cutDirection: 'climb',
      roughingPasses: 1, radialStepover: 0.2, springPasses: 0,
      leadInOut: 'arc', compensation: 'computer',
      heightReference: 'geometry_face', planeOffset: 0, threadDepth: 5,
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

describe('Thread Mill Smart Height V2 store dispatch', () => {
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
        geometry: [geometry], stocks: [stock], sceneStock,
        setups: [setup(op)], activeSetupId: 'setup-1',
      } as Project,
    }))
  }

  it('previews and dispatches the same detected internal thread band', async () => {
    const geometry = threadGeometry('bore')
    const op = operation(geometry, 'internal')
    load(geometry, op)

    const preview = useCamStore.getState().previewThreadMillSmartHeights('setup-1', op)
    expect(preview.wcs).toMatchObject({ top: 12, bottom: 7 })
    expect(requests).toHaveLength(0)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_THREAD_MILL')
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 12, bottomHeight: 7 })
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights?.wcs)
      .toMatchObject({ top: 12, bottom: 7 })
  })

  it('dispatches an external base-referenced thread upward as an ordered worker band', async () => {
    const geometry = threadGeometry('boss')
    const op = operation(geometry, 'external', 'base')
    // These legacy fields intentionally disagree with V2. Dispatch must
    // compile the worker strategy from V2 rather than accepting stale mirrors.
    Object.assign(op.params, {
      threadKind: 'internal',
      externalReference: 'top',
      threadDepth: 1,
      geometrySource: 'loop',
    })
    load(geometry, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 11, bottomHeight: 6 })
    expect(requests[0].payload.params).toMatchObject({
      threadKind: 'external', externalReference: 'base', threadDepth: 5, geometrySource: 'cylinder',
    })
  })

  it('dispatches a plain-loop explicit WCS band without cylinder evidence', async () => {
    const geometry = threadGeometry('bore')
    const op = operation(geometry, 'internal')
    op.smartHeight = {
      kind: 'smart_v2',
      intent: buildThreadMillSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: safety, source: 'explicit_band',
        threadKind: 'internal', threadDepthMm: 5,
        geometryIds: [geometry.id], datumReference: 'wcs_plane', planeOffsetMm: 12,
      }),
    }
    ;(op.params as unknown as { geometrySource: string }).geometrySource = 'loop'
    load(geometry, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 12, bottomHeight: 7 })
  })

  it('refuses changed cylinder topology before worker dispatch', async () => {
    const authored = threadGeometry('bore', 4)
    const op = operation(authored, 'internal')
    load(threadGeometry('bore', 3), op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0].errorMessage)
      .toMatch(/cylinder scope changed|feature identity is stale/)
  })
})
