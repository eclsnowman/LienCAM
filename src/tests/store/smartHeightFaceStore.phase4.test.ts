// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFaceSmartHeightIntent } from '../../lib/cam/smartHeights'
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

const safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 20, provenance: 'user' },
}

const stock: PhysicalStock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 80, z: 20 }),
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const target: ImportedGeometry = {
  id: 'target-1', name: 'Target', filename: 'target.step', type: 'brep', format: 'step',
  boundingBox: bbox({ x: 10, y: 10, z: 0 }, { x: 60, y: 50, z: 10 }),
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  loaded: true, stockId: stock.id, loops: [], layers2d: [],
} as ImportedGeometry

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

function faceOp(variant: 'explicit_depth' | 'target_face'): Operation {
  const params: Record<string, unknown> = {
    boundarySource: 'stock', geometryId: '__stock__', loopIds: [],
    stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
    pattern: 'zigzag', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
    passExtension: 0, chipThinning: false, bothSidesPerLevel: false,
    floorStockToLeave: 99, finishPass: false, entryType: 'plunge', leadInRadius: 0,
    leadOutRadius: 0, keepToolDown: false, maxStayDownDistance: 0,
    extendBeforeRetract: false, transition: 'direct', tolerance: 0.05,
    ...(variant === 'target_face'
      ? { targetPlaneGeo: { geoId: target.id, faceIndex: 7, localZ: 10 } }
      : {}),
  }
  const intent = variant === 'target_face'
    ? buildFaceSmartHeightIntent({
        setupId: 'setup-1', safetyIntent, mode: 'target_face', geometryIds: [target.id],
      })
    : buildFaceSmartHeightIntent({
        setupId: 'setup-1', safetyIntent, mode: 'explicit_depth',
        stockId: stock.id, explicitTargetWcsMm: 10,
      })
  return {
    id: 'face-1', name: 'Face 1', type: 'face', enabled: true, status: 'pending',
    toolId: tool.id, geometrySelections: [],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: -999, bottomHeightMode: 'absolute',
    },
    smartHeight: { kind: 'smart_v2', intent },
    passes: {
      stepdown: 2, stepover: 2, stockToLeave: 0,
      floorStockToLeave: variant === 'target_face' ? 1 : 2,
      finishPasses: 0, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params,
  } as Operation
}

function setup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 5 },
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

describe('Face Smart Height V2 store integration', () => {
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

  function load(op: Operation, geometry: ImportedGeometry[] = [target], stocks = [stock]): void {
    useCamStore.setState(state => ({
      toolLibrary: [tool],
      project: {
        ...state.project,
        geometry,
        stocks,
        sceneStock,
        setups: [setup(op)],
        activeSetupId: 'setup-1',
      } as Project,
      toolpathBatch: null,
    }))
  }

  it('previews and dispatches one identical explicit-depth plan', async () => {
    const op = faceOp('explicit_depth')
    load(op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    // WO-2953: the synchronous preview reads the shared remaining-stock state,
    // which is only ready once the compute above has settled it.
    const preview = useCamStore.getState().previewFaceSmartHeights('setup-1', op)

    const payload = requests[0].payload as {
      heights: Record<string, number>
      passes: Record<string, number>
      params: Record<string, number>
    }
    expect(requests[0].type).toBe('COMPUTE_FACE')
    expect(payload.heights).toMatchObject({
      clearanceHeight: 30, retractHeight: 25, feedHeight: 20,
      topHeight: 15, bottomHeight: 12,
    })
    expect(payload.passes.floorStockToLeave).toBe(0)
    expect(payload.params.floorStockToLeave).toBe(0)
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights).toEqual(preview)
  })

  it('re-resolves a durable selected target face and applies allowance once', async () => {
    const op = faceOp('target_face')
    load(op)
    const preview = useCamStore.getState().previewFaceSmartHeights('setup-1', op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    const heights = requests[0].payload.heights as Record<string, number>
    expect(heights).toMatchObject({ topHeight: 15, bottomHeight: 6 })
    expect(preview.wcs.bottom).toBe(6)
    expect(preview.machine.bottom).toBe(11)
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights).toEqual(preview)
  })

  it('re-resolves the selected target plane after its geometry moves', () => {
    const op = faceOp('target_face')
    load(op, [{ ...target, position: { x: 0, y: 0, z: 3 } }])

    const preview = useCamStore.getState().previewFaceSmartHeights('setup-1', op)

    expect(preview.wcs.bottom).toBe(9)
    expect(preview.machine.bottom).toBe(14)
  })

  it('refuses the same missing stock in preview and dispatch before a worker exists', async () => {
    const op = faceOp('explicit_depth')
    load(op, [target], [])
    expect(() => useCamStore.getState().previewFaceSmartHeights('setup-1', op))
      .toThrow(/cannot prove that stock 'stock-1' is the active Setup stock|cannot resolve proven bounds/)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0]).toMatchObject({
      status: 'error',
      errorMessage: expect.stringMatching(/cannot prove that stock 'stock-1' is the active Setup stock|cannot resolve proven bounds/),
    })
  })

  it('refuses target-face mode when the durable target-plane binding is absent', () => {
    const op = faceOp('target_face')
    delete (op.params as Record<string, unknown>).targetPlaneGeo
    load(op)
    expect(() => useCamStore.getState().previewFaceSmartHeights('setup-1', op))
      .toThrow(/no durable target-plane selection/)
  })

  it('refuses a non-V2 Face authority before worker dispatch', async () => {
    const op = faceOp('explicit_depth')
    op.smartHeight = { kind: 'obsolete_height_authority' } as unknown as Operation['smartHeight']
    op.heights = {
      clearanceHeight: 30, clearanceHeightMode: 'absolute',
      retractHeight: 25, feedHeight: 20,
      topHeight: 15, topHeightMode: 'stock_top',
      bottomHeight: 10, bottomHeightMode: 'absolute',
    }
    load(op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0]).toMatchObject({
      status: 'error',
      errorMessage: expect.stringMatching(/no valid Smart Height V2/),
    })
  })
})
