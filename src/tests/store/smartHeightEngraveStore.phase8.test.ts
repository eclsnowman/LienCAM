// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEngraveToolpath } from '../../lib/cam/engrave2d'
import type { EngraveWorkerPayload } from '../../lib/cam/types'
import { buildEngraveSmartHeightIntent } from '../../lib/cam/smartHeights'
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
  bounds: bbox({ x: -10, y: -10, z: 0 }, { x: 30, y: 30, z: 20 }),
  position: { x: -10, y: -10, z: 0 },
} as PhysicalStock

function geometry(): ImportedGeometry {
  return {
    id: 'drawing-1', name: 'Drawing 1', filename: 'drawing.dxf', type: 'dxf', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 20, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, stockId: stock.id,
    loops: [{
      id: 'line-1', layerId: 'paths',
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }],
      closed: false, type: 'open',
    }],
    layers2d: [{ id: 'paths', name: 'Paths', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
}

const tool: Tool = {
  id: 'vbit-1', name: '90 degree V-bit', type: 'v_bit', diameter: 10,
  tipDiameter: 0.5, angleFromAxisDeg: 45,
  fluteLength: 8, shankDiameter: 10, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 8000, feedRate: 300, plungeRate: 120, depthOfCut: 2, stepover: 1 } },
} as Tool

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 22, provenance: 'user' },
}

function operation(depth: { kind: 'explicit'; depthMm: number } | { kind: 'line_width'; targetLineWidthMm: number }): Operation {
  return {
    id: 'engrave-1', name: 'Engrave 1', type: 'engrave', enabled: true, status: 'pending',
    toolId: tool.id, geometrySelections: ['line-1'],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: 999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildEngraveSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: safety,
        datumReference: 'wcs_plane', datumOffsetMm: 12,
        axialOffsetMm: -0.25, depth,
        scope: {
          geometryIds: ['drawing-1'], loopIds: ['line-1'],
          includeOpen: true, includeClosed: false,
        },
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
      geometryId: 'drawing-1', loopIds: ['line-1'], includeOpen: true, includeClosed: false,
      mode: 'trace', depthModel: 'constant', side: 'center', sideOffset: 0,
      // Deliberately stale V1 mirrors. V2 must neutralize both.
      axialOffset: -7, targetLineWidth: 7, useWidthForDepth: true,
      direction: 'as_drawn', heightReference: 'stock_bottom', planeOffset: -50,
      tolerance: 0.01,
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
      type: 'rectangular', width: 40, height: 40, depth: 20,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [op], notes: '',
  } as Setup
}

const sceneStock: SceneStock = {
  mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
  fixedWidth: 40, fixedHeight: 40, fixedDepth: 20, fixedStocks: [],
} as SceneStock

describe('Engrave Smart Height V2 store dispatch', () => {
  let originalWorker: typeof Worker | undefined
  let requests: Array<{ type: string; payload: EngraveWorkerPayload }>

  beforeEach(() => {
    requests = []
    originalWorker = globalThis.Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage(data: { type: string; payload: EngraveWorkerPayload }): void {
        requests.push(data)
        queueMicrotask(() => this.onmessage?.({
          data: { type: 'TOOLPATH_COMPLETE', moves: [], computeTimeMs: 1 },
        } as MessageEvent))
      }
      terminate(): void { /* no-op */ }
    }
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      getStockBounds: () => ({ min: { x: -10, y: -10, z: 0 }, max: { x: 30, y: 30, z: 20 } }),
    }
  })

  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = originalWorker
    delete (window as unknown as Record<string, unknown>).__cncViewport
    vi.restoreAllMocks()
  })

  function load(op: Operation): ImportedGeometry {
    const drawing = geometry()
    useCamStore.setState(state => ({
      toolLibrary: [tool],
      project: {
        ...state.project,
        geometry: [drawing], stocks: [stock], sceneStock,
        setups: [setup(op)], activeSetupId: 'setup-1',
      } as Project,
    }))
    return drawing
  }

  it('uses one tip-flat-aware width formula for preview, dispatch, and worker moves', async () => {
    const op = operation({ kind: 'line_width', targetLineWidthMm: 2 })
    load(op)

    const preview = useCamStore.getState().previewEngraveSmartHeights('setup-1', op)
    expect(preview.wcs).toMatchObject({ top: 11.75, bottom: 11, feed: 22, retract: 25, clearance: 30 })
    expect(requests).toHaveLength(0)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_ENGRAVE')
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 11.75, bottomHeight: 11 })
    expect(requests[0].payload.params).toMatchObject({
      mode: 'engrave', axialOffset: 0, useWidthForDepth: false, targetLineWidth: 2,
    })
    const moves = buildEngraveToolpath(requests[0].payload)
    expect(Math.min(...moves.filter(move => move.role === 'cut').map(move => move.z))).toBeCloseTo(11, 9)
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights?.wcs)
      .toMatchObject({ top: 11.75, bottom: 11 })
  })

  it('uses the persisted explicit depth instead of stale Bottom or axial mirrors', async () => {
    const op = operation({ kind: 'explicit', depthMm: 0.4 })
    load(op)
    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    expect(requests).toHaveLength(1)
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 11.75, bottomHeight: 11.35 })
    expect(requests[0].payload.params).toMatchObject({ axialOffset: 0, useWidthForDepth: false })
  })

  it('refuses changed path scope before worker dispatch', async () => {
    const op = operation({ kind: 'explicit', depthMm: 0.4 })
    const drawing = load(op)
    drawing.loops = [{
      id: 'replacement', layerId: 'paths', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      closed: false, type: 'open', area: 0,
    }]

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0].errorMessage)
      .toMatch(/line-1.*missing|path scope changed/)
  })
})
