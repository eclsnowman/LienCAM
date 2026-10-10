// @vitest-environment jsdom
//
// WO-1174: the store resolves a V-carve operation's planes through Smart
// Height V2 and posts COMPUTE_VCARVE with Material Start and Cutter End set
// by the formula, never by the stale panel heights.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildVCarveToolpath, ensureVCarveClipperReady } from '../../lib/cam/vcarve2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { VCarveWorkerPayload } from '../../lib/cam/types'
import { buildVCarveSmartHeightIntent } from '../../lib/cam/smartHeights'
import { useCamStore } from '../../store'
import type {
  BoundingBox, HeightIntentV1, ImportedGeometry, Operation, PhysicalStock, Project, SceneStock, Setup, Tool, Vec3, WCS,
} from '../../types'

const NEVER_WIRED_3D = '__never_wired_3d' as Operation['type']

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
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
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, stockId: stock.id,
    loops: [
      {
        id: 'rect-1', layerId: 'paths',
        points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 0, y: 10 }],
        closed: true, type: 'closed', area: 400,
      },
      {
        id: 'line-1', layerId: 'paths',
        points: [{ x: 0, y: 20 }, { x: 20, y: 20 }],
        closed: false, type: 'open', area: 0,
      },
    ],
    layers2d: [{ id: 'paths', name: 'Paths', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
}

const tool: Tool = {
  id: 'vbit-1', name: '90 degree V-bit', type: 'v_bit', diameter: 12,
  tipDiameter: 0, angleFromAxisDeg: 45,
  fluteLength: 10, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300, depthOfCut: 2, stepover: 1 } },
} as Tool

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 22, provenance: 'user' },
}

function operation(flatDepth: { kind: 'explicit'; depthMm: number } | { kind: 'tool_limit' }, startDepthMm = 0): Operation {
  return {
    id: 'vcarve-1', name: 'V-carve 1', type: 'vcarve', enabled: true, status: 'pending',
    toolId: tool.id, geometrySelections: ['rect-1'],
    heights: {
      // Deliberately stale panel planes. V2 owns the dispatched planes.
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: 999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildVCarveSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: safety,
        datumReference: 'wcs_plane', datumOffsetMm: 12,
        startDepthMm, flatDepth,
        scope: { geometryIds: ['drawing-1'], loopIds: ['rect-1'] },
      }),
    },
    passes: { stepdown: 0, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: 'drawing-1', loopIds: ['rect-1'], role: 'carve',
      flatDepthMm: flatDepth.kind === 'explicit' ? flatDepth.depthMm : undefined,
      startDepthMm, allowanceMm: 0,
      flatClearing: { mode: 'vbit', stepoverMm: 0.5 },
      tolerance: 0.01, heightReference: 'wcs_plane', planeOffset: 12,
    },
  } as unknown as Operation
}

function setup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: stock.id,
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

describe('V-carve Smart Height V2 store dispatch', () => {
  let originalWorker: typeof Worker | undefined
  let requests: Array<{ type: string; payload: VCarveWorkerPayload }>

  beforeEach(async () => {
    await ensureVCarveClipperReady()
    await ensureClipperReady()
    requests = []
    originalWorker = globalThis.Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage(data: { type: string; payload: VCarveWorkerPayload }): void {
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

  it('dispatches COMPUTE_VCARVE with Material Start and Cutter End from the flat depth', async () => {
    const op = operation({ kind: 'explicit', depthMm: 2 })
    load(op)

    const plan = await useCamStore.getState().previewOperationSmartHeightPlan('setup-1', op)
    expect(plan.machining.materialStart.wcsMm).toBeCloseTo(12, 9)
    expect(plan.machining.cutterCenterEnd?.wcsMm).toBeCloseTo(10, 9)
    expect(requests).toHaveLength(0)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_VCARVE')
    expect(requests[0].payload.heights).toMatchObject({
      topHeight: 12, bottomHeight: 10, feedHeight: 22, retractHeight: 25, clearanceHeight: 30,
    })
    expect(requests[0].payload.params).toMatchObject({ role: 'carve', flatDepthMm: 2 })
    // The payload the store built runs the real engine to a real toolpath.
    const moves = buildVCarveToolpath(requests[0].payload)
    const zs = moves.filter(m => m.type === 'feed').map(m => m.z)
    expect(Math.min(...zs)).toBeCloseTo(10, 9)
    expect(Math.max(...zs)).toBeLessThanOrEqual(12 + 1e-9)
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights?.wcs)
      .toMatchObject({ top: 12, bottom: 10 })
  })

  it('tool limit and start depth: Cutter End is the bit limit below the lowered start', async () => {
    const op = operation({ kind: 'tool_limit' }, 1)
    load(op)
    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(1)
    // 12 mm 90 deg bit: 6 mm at full diameter; start 1 below the 12 datum.
    expect(requests[0].payload.heights.topHeight).toBeCloseTo(11, 9)
    expect(requests[0].payload.heights.bottomHeight).toBeCloseTo(5, 9)
  })

  it('refuses when the carved outline is no longer a closed loop', async () => {
    const op = operation({ kind: 'explicit', depthMm: 2 })
    const drawing = load(op)
    drawing.loops = [{
      id: 'rect-1', layerId: 'paths', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      closed: false, type: 'open', area: 0,
    }]
    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0].errorMessage)
      .toMatch(/rect-1.*no longer a closed loop|outlines changed/)
  })

  it('still refuses the families that have no compute path', async () => {
    const op = { ...operation({ kind: 'tool_limit' }), type: NEVER_WIRED_3D } as Operation
    load(op)
    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0].errorMessage)
      .toMatch(/unsupported operation type|no live Smart Height/)
  })
})
