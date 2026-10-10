// WO-1176: the store's waterline_3d runtime -- dispatch resolves the Smart
// Height plan and hands the bridge the resolved local planes and the strategy
// params; preview resolves the same plan without computing; a poisoned slicer
// library recycles the shared cam3d client; cancel returns the op to pending.
// Same harness shape as cam3dStockProvenance.wo140.test.ts: the bridge and the
// STL cache are module-mocked, the client is a genuine Cam3dClient over a no-op
// worker (never reached, because the bridge is mocked).

import { describe, expect, it, vi } from 'vitest'
import type {
  FixedStockItem, ImportedGeometry, Operation, PhysicalStock, SceneStock, Setup, Tool, ToolpathMove,
} from '../../types'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'
import { buildWaterline3dSmartIntent } from '../../lib/cam/smartHeights'
import { Cam3dClient } from '../../cam3d/worker/client'
import { typedMock } from '../support/typedMock'

const TOOL: Tool = {
  id: 'tool-wo1176', name: 'WO-1176 ball mill', type: 'ball_end_mill', diameter: 6, fluteLength: 20,
  shankDiameter: 6, overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: {},
}

const STOCK: FixedStockItem = { id: 'stock-a', name: 'stock-a', width: 20, height: 20, depth: 12, position: { x: 0, y: 0, z: 0 } }
const PHYSICAL: PhysicalStock = {
  id: STOCK.id, name: STOCK.name, mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 12 },
    size: { x: 20, y: 20, z: 12 }, center: { x: 10, y: 10, z: 6 },
  },
  position: { x: 0, y: 0, z: 0 },
}

function operation(finishDepthMm?: number, params: Record<string, unknown> = {}): Operation {
  return {
    id: 'op-waterline', name: 'Waterline', type: 'waterline_3d', enabled: true, status: 'pending', toolId: TOOL.id,
    geometrySelections: ['geo-wo1176'],
    heights: {
      clearanceHeight: 20, clearanceHeightMode: 'absolute', retractHeight: 15, feedHeight: 10,
      topHeight: 0, topHeightMode: 'model_top', bottomHeight: 0, bottomHeightMode: 'model_bottom',
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: { stepdown: 0.6, tolerance: 0.05, stockToLeave: 0.2, minSlopeDeg: 43, order: 'region', useStockBoundary: true, ...params },
    smartHeight: {
      kind: 'smart_v2' as const,
      intent: buildWaterline3dSmartIntent({
        setupId: 'setup-wo1176', geometryIds: ['geo-wo1176'], safetyIntent: defaultHeightIntent(), finishDepthMm,
      }),
    },
  }
}

async function harness(opts: {
  finishDepthMm?: number
  computeImpl?: (args: Record<string, unknown>) => Promise<{ moves: ToolpathMove[]; computeTimeMs: number }>
}) {
  vi.resetModules()
  const partMesh = {
    positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 6]),
    indices: new Uint32Array([0, 1, 2]),
    bounds: { min: [0, 0, 0], max: [4, 4, 6] },
    source: 'stl' as const,
  }
  const terminalMove: ToolpathMove = { type: 'rapid', x: 0, y: 0, z: 20, role: 'rapid' }
  const acquirePartMesh = vi.fn().mockResolvedValue(partMesh)
  const computeWaterline3dMoves = vi.fn().mockImplementation(
    opts.computeImpl ?? (async () => ({ moves: [terminalMove], computeTimeMs: 1 })),
  )
  const disposeCam3dClient = vi.fn()
  vi.doMock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()
    return typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({ ...actual, acquirePartMesh })
  })
  vi.doMock('../../cam3d/integration/waterline3dOperation', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../cam3d/integration/waterline3dOperation')>()
    return typedMock<typeof import('../../cam3d/integration/waterline3dOperation')>({ ...actual, computeWaterline3dMoves })
  })
  vi.doMock('../../lib/stlCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/stlCache')>()
    return typedMock<typeof import('../../lib/stlCache')>({
      ...actual, loadCachedSTL: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    })
  })
  vi.doMock('../../cam3d/integration/appClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
    return typedMock<typeof import('../../cam3d/integration/appClient')>({
      ...actual,
      getCam3dClient: () => new Cam3dClient({ postMessage: () => {}, terminate: () => {}, onmessage: null, onerror: null }),
      disposeCam3dClient,
    })
  })
  const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', {
    localStorage,
    __cncViewport: { getStockBounds: vi.fn(() => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 12 } })) },
  })
  const { useCamStore } = await import('../../store')
  const geometry: ImportedGeometry = {
    id: 'geo-wo1176', name: 'WO-1176 part', filename: 'wo1176.stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 4, z: 6 }, size: { x: 4, y: 4, z: 6 }, center: { x: 2, y: 2, z: 3 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId: STOCK.id,
  }
  const op = operation(opts.finishDepthMm)
  const setup: Setup = {
    id: 'setup-wo1176', name: 'WO-1176 setup',
    wcs: {
      id: 'wcs-wo1176', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK.id,
      originBinding: { kind: 'stock_corner', stockId: STOCK.id, cornerRow: 0, cornerCol: 0, cornerFace: 'top' },
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [op], notes: '',
  }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 50, fixedHeight: 20, fixedDepth: 30, fixedStocks: [STOCK],
  }
  useCamStore.setState((state) => ({
    project: {
      ...state.project, id: 'project-wo1176', geometry: [geometry], setups: [setup], stocks: [PHYSICAL],
      sceneStock, toolLibrary: [TOOL], activeSetupId: setup.id,
    },
    toolLibrary: [TOOL],
    toolpathBatch: null,
  }))
  const cleanup = () => {
    vi.doUnmock('../../cam3d/integration/parallel3dOperation')
    vi.doUnmock('../../cam3d/integration/waterline3dOperation')
    vi.doUnmock('../../lib/stlCache')
    vi.doUnmock('../../cam3d/integration/appClient')
    vi.unstubAllGlobals()
  }
  return { useCamStore, setup, op, computeWaterline3dMoves, disposeCam3dClient, cleanup }
}

describe('WO-1176 waterline_3d store runtime', () => {
  it('dispatches the bridge with resolved local planes, the stock boundary and the read params', async () => {
    const h = await harness({})
    try {
      await h.useCamStore.getState().computeOperationToolpath(h.setup.id, h.op.id)
      expect(h.computeWaterline3dMoves).toHaveBeenCalledOnce()
      const args = h.computeWaterline3dMoves.mock.calls[0][0]
      // Full-surface variant: Material Start = model top (6), Cutter End = model bottom (0);
      // With the stock proven, the untouched Feed and Retract stay stock top + 5 (WO-1616).
      expect(args.resolvedHeights).toMatchObject({ topZ: 6, bottomZ: 0, feedZ: 17, retractZ: 17, clearanceZ: 27, stockTopZ: 12 })
      expect(args.params).toMatchObject({ stepdown: 0.6, tolerance: 0.05, stockToLeave: 0.2, minSlopeDeg: 43, order: 'region', finishDepth: undefined })
      expect(Array.from(args.boundary[0])).toEqual([0, 0, 20, 0, 20, 20, 0, 20])
      expect(args.tool.id).toBe(TOOL.id)
      const saved = h.useCamStore.getState().project.setups[0].operations[0]
      expect(saved.status).toBe('ready')
      expect(saved.resolvedHeightPlan?.policy).toEqual({ operationType: 'waterline_3d', variant: 'target_surface' })
      expect(saved.generationFingerprint).toBeTruthy()
    } finally {
      h.cleanup()
    }
  })

  it('clamps the band with a finish-depth limit and previews the same plan without computing', async () => {
    const h = await harness({ finishDepthMm: 2 })
    try {
      const preview = await h.useCamStore.getState().previewWaterline3dSmartHeights(h.setup.id, h.op)
      expect(h.computeWaterline3dMoves).not.toHaveBeenCalled()
      expect(preview.machine.top).toBe(6)
      expect(preview.machine.bottom).toBe(4)
      const plan = await h.useCamStore.getState().previewOperationSmartHeightPlan(h.setup.id, h.op)
      expect(plan.policy).toEqual({ operationType: 'waterline_3d', variant: 'bounded_surface' })
      await h.useCamStore.getState().computeOperationToolpath(h.setup.id, h.op.id)
      const args = h.computeWaterline3dMoves.mock.calls[0][0]
      expect(args.resolvedHeights).toMatchObject({ topZ: 6, bottomZ: 4 })
      expect(args.params.finishDepth).toBe(2)
      // The dispatch snapshot adds the tool id to the dependency list; the planes are the preview's.
      const saved = h.useCamStore.getState().project.setups[0].operations[0].resolvedHeights
      expect(saved?.machine).toEqual(preview.machine)
      expect(saved?.wcs).toEqual(preview.wcs)
    } finally {
      h.cleanup()
    }
  })

  it('recycles the cam3d client when the slicer library is poisoned, and lands the op on error by name', async () => {
    const h = await harness({
      computeImpl: async () => {
        const err = new Error('waterline: the slicing library ran out of memory at z=3')
        err.name = 'OclModulePoisoned'
        throw err
      },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await h.useCamStore.getState().computeOperationToolpath(h.setup.id, h.op.id)
      expect(h.disposeCam3dClient).toHaveBeenCalledOnce()
      const saved = h.useCamStore.getState().project.setups[0].operations[0]
      expect(saved.status).toBe('error')
      expect(saved.errorMessage).toMatch(/ran out of memory/)
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('Restarting the 3D worker'))).toBe(true)
    } finally {
      errorSpy.mockRestore()
      h.cleanup()
    }
  })

  it('returns a cancelled compute to pending', async () => {
    const h = await harness({
      computeImpl: async (args) => {
        const signal = args.signal as AbortSignal
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
          setTimeout(resolve, 5_000)
        })
        return { moves: [], computeTimeMs: 1 }
      },
    })
    try {
      const run = h.useCamStore.getState().computeOperationToolpath(h.setup.id, h.op.id)
      await vi.waitFor(() => expect(h.computeWaterline3dMoves).toHaveBeenCalledOnce())
      h.useCamStore.getState().cancelWaterline3dCompute(h.op.id)
      await run
      expect(h.useCamStore.getState().project.setups[0].operations[0].status).toBe('pending')
    } finally {
      h.cleanup()
    }
  })
})
