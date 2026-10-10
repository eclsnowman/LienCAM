// WO-1656: disabling, enabling, reordering or editing an earlier operation
// marks every later operation that depended on it outdated in the same
// moment - for EVERY operation type, not just the 2D worker set.
//
// The 2D worker set, the parallel/steep/scallop/pencil 3D finish family and
// waterline already carried the dependsOnPredecessors stamp the generic
// freshness reconciliation (reconcileProjectPredecessorFreshness) reads -
// see src/tests/cam/operationDependencyFreshness.wo1208.test.ts and the
// "outdated immediately" assertions added to restAlwaysOn.wo1641.test.ts by
// this order. The gap this file closes: an adaptive_3d rough that started
// from a retained rest field (WO-279/WO-1619) never carried that stamp, so
// disabling the rough that carved its starting field left a stale 'ready'
// toolpath on screen instead of flipping it 'outdated' - exactly the crash
// risk Operator named (2026-09-17: "cause it to crash into material which it
// did not remove").
//
// Production compute path: the store authors each operation and
// computeOperationToolpath runs the real BvhKernel behind an in-process
// worker channel (WO-279's own pattern) - only the byte cache and the
// tessellator are stubbed. Two different box/pocket/tool geometries prove
// the same three things are true for both.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { engagementPocket } from '../../cam3d/fixtures'
import type { PartMesh } from '../../cam3d/kernel/types'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse, StockHandle } from '../../cam3d/worker/protocol'
import type {
  FixedStockItem, ImportedGeometry, Operation, PhysicalStock, SceneStock, Setup, Tool, ToolpathMove,
} from '../../types'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'

type DependencyOperation = Operation & { dependsOnPredecessors?: boolean }

function tool(id: string, diameter: number): Tool {
  return {
    id,
    name: `${diameter} mm flat`,
    type: 'flat_end_mill',
    diameter,
    fluteLength: 25,
    shankDiameter: diameter,
    overallLength: 60,
    numberOfFlutes: 3,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {
      default: { rpm: 12000, feedRate: 1200, plungeRate: 400, depthOfCut: 2, stepover: diameter * 0.4 },
    },
  }
}

function roughParams(cellSize: number, maxStepdown: number): Record<string, unknown> {
  return {
    maxStepdown, stepover: 0.4, tolerance: 0.2, helixDiameter: 2, helixAngleDeg: 10,
    cellSize, useStockBoundary: false,
  }
}

function operation(id: string, toolId: string, topZ: number, params: Record<string, unknown>, setupId: string): Operation {
  return stampSmartHeightAuthority({
    id, name: id, type: 'adaptive_3d', enabled: true, status: 'pending', toolId,
    geometrySelections: ['geo-wo1656'],
    heights: {
      clearanceHeight: topZ + 10, clearanceHeightMode: 'absolute',
      retractHeight: topZ + 2, feedHeight: topZ + 1,
      topHeight: 0, topHeightMode: 'model_top',
      bottomHeight: 0, bottomHeightMode: 'model_bottom',
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 3, rampLength: 10,
      leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params,
  }, { setupId, geometryIds: ['geo-wo1656'], stockId: 'stock-wo1656' })
}

function setup(id: string, operations: Operation[]): Setup {
  return {
    id, name: id,
    wcs: {
      id: `wcs-${id}`, label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: 'stock-wo1656',
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations,
    notes: '',
  }
}

function stockFor(size: { x: number; y: number; z: number }): FixedStockItem {
  return { id: 'stock-wo1656', name: 'WO-1656 block', width: size.x, height: size.y, depth: size.z, position: { x: 0, y: 0, z: 0 } }
}

function cuttingMoves(moves: ToolpathMove[] | undefined): ToolpathMove[] {
  return (moves ?? []).filter((m) => m.type !== 'rapid')
}

interface Scene {
  compute: (setupId: string, opId: string) => Promise<void>
  op: (setupId: string, opId: string) => DependencyOperation
  asks: { startFromStock: StockHandle | undefined }[]
  dispose: () => Promise<void>
}

/** Same harness as restWiring.wo279.test.ts: the real cam3d kernel behind an in-process worker. */
async function makeScene(mesh: PartMesh, stock: FixedStockItem, setups: Setup[], tools: Tool[]): Promise<Scene> {
  vi.resetModules()
  const kernel = new BvhKernel()
  const asks: { startFromStock: StockHandle | undefined }[] = []
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      const request = message as Cam3dRequest
      if (request.kind === 'adaptiveRough') asks.push({ startFromStock: request.startFromStock })
      dispatcher.handle(request)
    },
    terminate(): void {},
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  })
  const client = new Cam3dClient(fakeWorker)

  vi.doMock('../../cam3d/integration/appClient', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
    getCam3dClient: () => client,
  }))
  vi.doMock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
    acquirePartMesh: vi.fn(async () => mesh),
  }))
  vi.doMock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
    ...(await importOriginal<typeof import('../../lib/stepCache')>()),
    loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
  }))

  const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', { localStorage, __cncViewport: { getStockBounds: () => null } })

  const { useCamStore } = await import('../../store')

  const geometry: ImportedGeometry = {
    id: 'geo-wo1656', name: 'WO-1656 part', filename: 'wo1656.step', type: 'brep', format: 'step',
    boundingBox: {
      min: { x: mesh.bounds.min[0], y: mesh.bounds.min[1], z: mesh.bounds.min[2] },
      max: { x: mesh.bounds.max[0], y: mesh.bounds.max[1], z: mesh.bounds.max[2] },
      size: {
        x: mesh.bounds.max[0] - mesh.bounds.min[0],
        y: mesh.bounds.max[1] - mesh.bounds.min[1],
        z: mesh.bounds.max[2] - mesh.bounds.min[2],
      },
      center: {
        x: (mesh.bounds.max[0] + mesh.bounds.min[0]) / 2,
        y: (mesh.bounds.max[1] + mesh.bounds.min[1]) / 2,
        z: (mesh.bounds.max[2] + mesh.bounds.min[2]) / 2,
      },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId: stock.id,
  }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: stock.width, fixedHeight: stock.height, fixedDepth: stock.depth, fixedStocks: [stock],
  }
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: stock.width, y: stock.height, z: stock.depth },
      size: { x: stock.width, y: stock.height, z: stock.depth },
      center: { x: stock.width / 2, y: stock.height / 2, z: stock.depth / 2 },
    },
    position: { x: 0, y: 0, z: 0 },
  }

  useCamStore.setState((state) => ({
    project: {
      ...state.project, id: 'project-wo1656', geometry: [geometry], setups,
      stocks: [physicalStock], sceneStock, toolLibrary: tools, activeSetupId: setups[0].id,
    },
    toolLibrary: tools,
    toolpathBatch: null,
  }))

  return {
    compute: (setupId, opId) => useCamStore.getState().computeOperationToolpath(setupId, opId),
    op: (setupId, opId) => {
      const found = useCamStore.getState().project.setups.find((s) => s.id === setupId)
        ?.operations.find((o) => o.id === opId) as DependencyOperation | undefined
      if (!found) throw new Error(`operation ${opId} vanished from setup ${setupId}`)
      return found
    },
    asks,
    dispose: async () => { await client.dispose() },
  }
}

afterEach(() => {
  vi.doUnmock('../../cam3d/integration/appClient')
  vi.doUnmock('../../cam3d/integration/parallel3dOperation')
  vi.doUnmock('../../lib/stepCache')
  vi.unstubAllGlobals()
  vi.resetModules()
})

// The engagement fixture (WO-277's, reused from restWiring.wo279.test.ts): a
// 90 x 60 x 16 block with an H-shaped pocket joined by a 6 mm neck a rough
// tool wider than the neck provably cannot enter - so the rest pass always
// has real material to find, not just corner rounding a plain box would leave.
const EP = { x: 90, y: 60, z: 16 }

interface Project {
  name: string
  bigTool: number
  restTool: number
}

const PROJECTS: Project[] = [
  { name: '8mm rough, 3mm rest', bigTool: 8, restTool: 3 },
  { name: '6mm rough, 2mm rest', bigTool: 6, restTool: 2 },
]

describe.each(PROJECTS)('WO-1656: an adaptive_3d rest pass outdates when its rough is disabled ($name)', (project) => {
  it('outdated immediately on disable (before regenerate); regenerate plans against the full stock; the rough itself stays ready', { timeout: 300_000 }, async () => {
    const big = tool('tool-big', project.bigTool)
    const small = tool('tool-rest', project.restTool)
    const rest = setup('setup-rest', [
      operation('op-rough', big.id, EP.z, roughParams(1, 6), 'setup-rest'),
      operation('op-rest', small.id, EP.z, roughParams(1, 6), 'setup-rest'),
    ])
    const control = setup('setup-control', [
      operation('op-rest-alone', small.id, EP.z, roughParams(1, 6), 'setup-control'),
    ])
    const scene = await makeScene(engagementPocket(), stockFor(EP), [rest, control], [big, small])
    try {
      await scene.compute(rest.id, 'op-rough')
      const rough = scene.op(rest.id, 'op-rough')
      expect(rough.status, rough.errorMessage).toBe('ready')

      await scene.compute(rest.id, 'op-rest')
      const restOp = scene.op(rest.id, 'op-rest')
      expect(restOp.status, restOp.errorMessage).toBe('ready')
      // The fix this order lands: the rest pass now carries the same stamp the
      // 2D worker set and the other 3D finishes already carried.
      expect(restOp.dependsOnPredecessors).toBe(true)
      expect(scene.asks[1]?.startFromStock).toBeDefined()

      const { useCamStore } = await import('../../store')

      // THE GAP THIS ORDER CLOSES: disabling the rough must outdate the rest
      // pass in the SAME moment, with no explicit regenerate call yet.
      useCamStore.getState().updateOperation(rest.id, 'op-rough', { enabled: false })
      expect(scene.op(rest.id, 'op-rest').status, 'outdated immediately on disable, before any regenerate').toBe('outdated')
      // An operation with nothing material-removing before it is untouched by
      // a change to an operation after it.
      expect(scene.op(rest.id, 'op-rough').status).toBe('ready')

      // Regenerate: it now plans against the full stock, exactly like the
      // control run of the same operation with nothing before it.
      await scene.compute(rest.id, 'op-rest')
      const regenerated = scene.op(rest.id, 'op-rest')
      expect(regenerated.status, regenerated.errorMessage).toBe('ready')
      expect(regenerated.dependsOnPredecessors).toBeFalsy()
      const askAfterDisable = scene.asks[scene.asks.length - 1]
      expect(askAfterDisable.startFromStock, 'no handle asked for once the rough is disabled').toBeUndefined()

      await scene.compute(control.id, 'op-rest-alone')
      const alone = scene.op(control.id, 'op-rest-alone')
      expect(alone.status, alone.errorMessage).toBe('ready')
      expect(cuttingMoves(regenerated.toolpathMoves).length).toBe(cuttingMoves(alone.toolpathMoves).length)

      // Re-enable: the regenerated rest pass no longer claims a predecessor
      // dependency (it genuinely has none - it planned against the full
      // stock), so re-enabling the rough does not disturb it. This is the
      // safe direction by construction, the same asymmetry WO-279 documents
      // for the retained-field decision itself: a full-stock plan can only
      // cost air-cutting time, never drive a cutter into material the app
      // believes is gone. Parallel 3D and waterline (WO-1641) carry the same
      // asymmetry - nothing about this fix narrows it.
      useCamStore.getState().updateOperation(rest.id, 'op-rough', { enabled: true })
      expect(scene.op(rest.id, 'op-rest').status, 'a genuinely independent plan is not disturbed by re-enabling').toBe('ready')
      expect(scene.op(rest.id, 'op-rough').status, 'the rough itself is never disturbed by its dependent').toBe('ready')
    } finally {
      await scene.dispose()
    }
  })
})
