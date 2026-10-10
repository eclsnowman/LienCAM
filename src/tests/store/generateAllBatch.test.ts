import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Imported BEFORE the store/toolpathBatchScheduler/cam3d imports below on
// purpose: those transitively import the modules this file mocks, which
// triggers the mock factories during THEIR static-import resolution. A
// `typedMock` import placed after them left a factory closing over a binding
// not yet initialized - "Cannot access '__vi_import_N__' before
// initialization" - because vi.mock's hoisted factory ran while resolving an
// EARLIER import, ahead of this one (see holderClearance3d.wo278.test.ts).
import { typedMock } from '../support/typedMock'
import { useCamStore } from '../../store'
import { cancelAllSerializedCam3dComputes } from '../../store/toolpathBatchScheduler'
import { Cam3dClient } from '../../cam3d/worker/client'
import type {
  FixedStockItem,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  Project,
  SceneStock,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'
import type { PartMesh } from '../../cam3d/kernel/types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

const integration = vi.hoisted(() => ({
  acquirePartMesh: vi.fn(),
  computeParallel3dMoves: vi.fn(),
  computeSteepShallow3dMoves: vi.fn(),
  computeAdaptive3dMoves: vi.fn(),
  loadCachedSTL: vi.fn(),
  disposeCam3dClient: vi.fn(),
  disposeModelWorker: vi.fn(),
  schedulerReject: false,
}))

vi.mock('../../store/toolpathBatchScheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/toolpathBatchScheduler')>()
  return typedMock<typeof import('../../store/toolpathBatchScheduler')>({
    ...actual,
    // Kept genuinely generic (matching the real export's own `<T>`) rather than
    // widened to `unknown` - a non-generic stand-in would make the promise this
    // wrapper returns untraceable back to the caller's own T.
    runSerializedCam3dCompute: <T,>(
      key: string,
      run: (context: { isCancelled: () => boolean }) => Promise<T>,
    ): Promise<T> => integration.schedulerReject
      ? Promise.reject(new Error('injected scheduler rejection'))
      : actual.runSerializedCam3dCompute(key, run),
  })
})

vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()
  return typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...actual,
    acquirePartMesh: integration.acquirePartMesh,
    computeParallel3dMoves: integration.computeParallel3dMoves,
  })
})

vi.mock('../../cam3d/integration/adaptive3dOperation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/adaptive3dOperation')>()
  return typedMock<typeof import('../../cam3d/integration/adaptive3dOperation')>({
    ...actual,
    computeAdaptive3dMoves: integration.computeAdaptive3dMoves,
  })
})

vi.mock('../../cam3d/integration/steepShallow3dOperation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/steepShallow3dOperation')>()
  return typedMock<typeof import('../../cam3d/integration/steepShallow3dOperation')>({
    ...actual,
    computeSteepShallow3dMoves: integration.computeSteepShallow3dMoves,
  })
})

vi.mock('../../lib/stlCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stlCache')>()
  return typedMock<typeof import('../../lib/stlCache')>({
    ...actual,
    loadCachedSTL: integration.loadCachedSTL,
  })
})

vi.mock('../../cam3d/integration/appClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  return typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...actual,
    // A genuine Cam3dClient over a no-op WorkerLike - see
    // adaptive3dInternalModel.test.ts for the reasoning.
    getCam3dClient: () => new Cam3dClient({
      postMessage: () => {},
      terminate: () => {},
      onmessage: null,
      onerror: null,
    }),
    disposeCam3dClient: integration.disposeCam3dClient,
  })
})

vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()
  return typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
    ...actual,
    disposeModelWorker: integration.disposeModelWorker,
  })
})

const terminalMove: ToolpathMove = {
  type: 'feed', x: 1, y: 1, z: -1, feed: 300, role: 'cut',
}

class MockWorker {
  static instances: MockWorker[] = []
  static autoComplete = true
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string; filename?: string; lineno?: number; error?: Error }) => void) | null = null
  posted: unknown[] = []
  terminated = false

  constructor(_url: unknown, _opts?: unknown) {
    MockWorker.instances.push(this)
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
    if (MockWorker.autoComplete) {
      queueMicrotask(() => this.complete())
    }
  }

  complete(): void {
    this.onmessage?.({
      data: { type: 'TOOLPATH_COMPLETE', moves: [terminalMove], computeTimeMs: 1 },
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const mesh: PartMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  source: 'stl',
}

function makeTool(id = 'tool-1', diameter = 4): Tool {
  return {
    id, name: id, type: 'flat_endmill', diameter, fluteLength: 12,
    shankDiameter: diameter, overallLength: 50, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 1.6 },
    },
  } as unknown as Tool
}

const stock: FixedStockItem = {
  id: 'stock-1', name: 'Stock', width: 100, height: 100, depth: 12,
  position: { x: 0, y: 0, z: 0 },
}

const sceneStock: SceneStock = {
  mode: 'fixed', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [stock],
}

const physicalStock: PhysicalStock = {
  id: stock.id, name: stock.name, mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 12 },
    size: { x: 100, y: 100, z: 12 }, center: { x: 50, y: 50, z: 6 },
  },
  position: { x: 0, y: 0, z: 0 },
}

function make2dGeometry(): ImportedGeometry {
  return {
    id: 'geo-2d', name: 'Plate', filename: 'plate.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 1 },
      size: { x: 20, y: 20, z: 1 }, center: { x: 10, y: 10, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: 'loop-1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    stockId: stock.id,
  }
}

function make3dGeometry(): ImportedGeometry {
  return {
    id: 'geo-3d', name: 'Solid', filename: 'solid.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, stockId: stock.id,
  }
}

function baseOperation(id: string, type: Operation['type']): Operation {
  return {
    id, name: id, type, enabled: true, status: 'pending', toolId: 'tool-1',
    geometrySelections: type === 'parallel_3d' || type === 'adaptive_3d' ||
      type === 'waterline_3d' || type === 'steep_shallow_3d' ? ['geo-3d'] : [],
    heights: {
      clearanceHeight: 20, clearanceHeightMode: 'absolute', retractHeight: 10,
      feedHeight: 8, topHeight: 0, topHeightMode: 'stock_top',
      bottomHeight: -3, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 1.6, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params: type === 'contour_2d'
      ? { geometryId: 'geo-2d', loopIds: [], side: 'outer', direction: 'climb', tabs: false }
      : {},
    // Smart Height V2 is the only runtime authority (2e5678b7); without an
    // envelope compute refuses before the batch ever dispatches (ADR-0040).
    smartHeight: smartHeightAuthorityFixture(type, { geometryIds: type === 'contour_2d' ? ['geo-2d'] : ['geo-3d'] }),
  } as Operation
}

function makeSetup(operations: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 5 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 }, stockId: stock.id,
    },
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0,
      offsetZBottom: 0, material: 'aluminum',
    } as Setup['stock'],
    operations,
    notes: '',
  }
}

function install(operations: Operation[], tools = [makeTool()]): void {
  useCamStore.setState((state) => ({
    project: {
      ...state.project,
      id: 'project-test',
      geometry: [make2dGeometry(), make3dGeometry()],
      setups: [makeSetup(operations)],
      stocks: [physicalStock],
      sceneStock,
      activeSetupId: 'setup-1',
    },
    toolLibrary: tools,
    toolpathBatch: null,
    consoleEvents: [],
    consoleReadThroughId: 0,
  }))
}

function operation(id: string): Operation {
  return useCamStore.getState().project.setups[0].operations.find((op) => op.id === id)!
}

function batchFinishEvents() {
  return useCamStore.getState().consoleEvents.filter(
    (event) => event.source === 'batch' && event.message.startsWith('Toolpath batch finished'),
  )
}

function observeBatchClears() {
  let clears = 0
  const unsubscribe = useCamStore.subscribe((next, previous) => {
    if (previous.toolpathBatch && !next.toolpathBatch) clears++
  })
  return { get clears() { return clears }, unsubscribe }
}

async function flushMicrotasks(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  MockWorker.instances = []
  MockWorker.autoComplete = true
  vi.stubGlobal('Worker', MockWorker)
  integration.loadCachedSTL.mockResolvedValue(new ArrayBuffer(8))
  integration.acquirePartMesh.mockResolvedValue(mesh)
  integration.computeParallel3dMoves.mockResolvedValue({ moves: [terminalMove], computeTimeMs: 1 })
  integration.computeSteepShallow3dMoves.mockResolvedValue({ moves: [terminalMove], computeTimeMs: 1 })
  integration.computeAdaptive3dMoves.mockResolvedValue({
    moves: [terminalMove], computeTimeMs: 1, carvedStock: undefined, carvedStockWarning: undefined,
    // CAM-16/CAM-17 height truth (43268e904): the adaptive_3d result now
    // reports the heights it ACTUALLY cut at, and the store feeds them
    // straight into worldPlaceResolvedHeights before snapshotting the
    // envelope. A mock without this resolves to undefined there and the owner
    // op lands in 'error' -- which is the store behaving correctly on a
    // malformed result, not the batch logic under test failing. Mirror
    // baseOperation's declared heights so the truth agrees with the intent.
    heightTruth: { clearanceZ: 20, retractZ: 10, feedZ: 8, topZ: 0, bottomZ: -3 },
  })
  integration.schedulerReject = false
  cancelAllSerializedCam3dComputes()
})

afterEach(() => {
  cancelAllSerializedCam3dComputes()
  useCamStore.setState({ toolpathBatch: null, consoleEvents: [], consoleReadThroughId: 0 })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Generate All batch ownership through the real store', () => {
  it('runs mixed 2D plus the CAM3D families, serializes CAM3D, and clears once', async () => {
    const parallelGate = deferred<{
      moves: ToolpathMove[]
      computeTimeMs: number
    }>()
    integration.computeParallel3dMoves.mockReturnValueOnce(parallelGate.promise)
    install([
      baseOperation('parallel', 'parallel_3d'),
      baseOperation('adaptive', 'adaptive_3d'),
      baseOperation('contour', 'contour_2d'),
      baseOperation('steep-shallow', 'steep_shallow_3d'),
    ])
    const clears = observeBatchClears()

    const run = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()

    expect(integration.computeParallel3dMoves).toHaveBeenCalledOnce()
    expect(integration.computeAdaptive3dMoves).not.toHaveBeenCalled()
    // WO-2656: the contour comes after both 3D operations in its setup, so it
    // waits for their results instead of computing while they are held.
    expect(MockWorker.instances).toHaveLength(0)
    expect(operation('contour').status).toBe('pending')
    expect(useCamStore.getState().toolpathBatch).toMatchObject({ total: 4, completed: 0 })

    parallelGate.resolve({ moves: [terminalMove], computeTimeMs: 1 })
    await run

    expect(MockWorker.instances).toHaveLength(1)
    expect(integration.computeAdaptive3dMoves).toHaveBeenCalledOnce()
    expect(integration.computeSteepShallow3dMoves).toHaveBeenCalledOnce()
    expect(['parallel', 'adaptive', 'steep-shallow', 'contour'].map((id) => operation(id).status)).toEqual([
      'ready', 'ready', 'ready', 'ready',
    ])
    expect(useCamStore.getState().toolpathBatch).toBeNull()
    expect(clears.clears).toBe(1)
    expect(batchFinishEvents()).toHaveLength(1)
    expect(batchFinishEvents()[0].message).toContain('4 operations')
    clears.unsubscribe()
  })

  it('refuses an overlapping Regen All without replacing the active batch token', async () => {
    const gate = deferred<{ moves: ToolpathMove[]; computeTimeMs: number }>()
    integration.computeParallel3dMoves.mockReturnValueOnce(gate.promise)
    install([baseOperation('parallel', 'parallel_3d')])

    const firstRun = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    const firstBatch = useCamStore.getState().toolpathBatch!
    const overlappingRun = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    try {
      expect(useCamStore.getState().toolpathBatch).toEqual(firstBatch)
      expect(integration.computeParallel3dMoves).toHaveBeenCalledOnce()
    } finally {
      gate.resolve({ moves: [terminalMove], computeTimeMs: 1 })
      await Promise.all([firstRun, overlappingRun])
    }
    expect(batchFinishEvents()).toHaveLength(1)
  })

  it('preserves an active batch token between operation dispatch states', async () => {
    install([baseOperation('parallel', 'parallel_3d')])
    const activeBatch = { id: 'existing-batch', total: 1, completed: 0 }
    useCamStore.setState({ toolpathBatch: activeBatch })

    await useCamStore.getState().computeAllToolpaths()

    expect(useCamStore.getState().toolpathBatch).toEqual(activeBatch)
    expect(integration.computeParallel3dMoves).not.toHaveBeenCalled()
    expect(batchFinishEvents()).toHaveLength(0)
  })

  it('counts a real 3D validation failure once and clears its batch', async () => {
    const invalid = baseOperation('parallel', 'parallel_3d')
    invalid.geometrySelections = []
    install([invalid])
    const clears = observeBatchClears()

    await useCamStore.getState().computeAllToolpaths()

    expect(operation('parallel').status).toBe('error')
    expect(operation('parallel').errorMessage).toMatch(/no source geometry/i)
    expect(useCamStore.getState().toolpathBatch).toBeNull()
    expect(clears.clears).toBe(1)
    expect(batchFinishEvents()).toHaveLength(1)
    clears.unsubscribe()
  })

  it('settles active 3D cancellation exactly once', async () => {
    integration.computeParallel3dMoves.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const error = new Error('cancelled')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      }),
    )
    install([baseOperation('parallel', 'parallel_3d')])
    const clears = observeBatchClears()

    const run = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    useCamStore.getState().cancelParallel3dCompute('parallel')
    await run

    expect(operation('parallel').status).toBe('pending')
    expect(clears.clears).toBe(1)
    expect(batchFinishEvents()).toHaveLength(1)
    clears.unsubscribe()
  })

  it('cancels a queued 3D owner without running it or blocking the lane', async () => {
    const parallelGate = deferred<{ moves: ToolpathMove[]; computeTimeMs: number }>()
    integration.computeParallel3dMoves.mockReturnValueOnce(parallelGate.promise)
    install([
      baseOperation('parallel', 'parallel_3d'),
      baseOperation('adaptive', 'adaptive_3d'),
    ])
    const clears = observeBatchClears()

    const run = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    expect(operation('adaptive').status).toBe('computing')
    useCamStore.getState().cancelAdaptive3dCompute('adaptive')
    parallelGate.resolve({ moves: [terminalMove], computeTimeMs: 1 })
    await run

    expect(integration.computeAdaptive3dMoves).not.toHaveBeenCalled()
    expect(operation('adaptive').status).toBe('pending')
    expect(clears.clears).toBe(1)
    expect(batchFinishEvents()).toHaveLength(1)
    clears.unsubscribe()
  })

  it('deduplicates duplicate dispatch of the same 3D op within its batch token', async () => {
    const gate = deferred<{ moves: ToolpathMove[]; computeTimeMs: number }>()
    integration.computeParallel3dMoves.mockReturnValueOnce(gate.promise)
    install([baseOperation('parallel', 'parallel_3d')])
    const clears = observeBatchClears()

    const run = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    const batchId = useCamStore.getState().toolpathBatch!.id
    const duplicate = useCamStore.getState().computeOperationToolpath('setup-1', 'parallel', batchId)
    await flushMicrotasks()

    expect(integration.computeParallel3dMoves).toHaveBeenCalledOnce()
    expect(useCamStore.getState().toolpathBatch?.completed).toBe(0)
    gate.resolve({ moves: [terminalMove], computeTimeMs: 1 })
    await Promise.all([run, duplicate])

    expect(clears.clears).toBe(1)
    expect(batchFinishEvents()).toHaveLength(1)
    clears.unsubscribe()
  })

  it('ignores a stale terminal callback from an old batch token', async () => {
    MockWorker.autoComplete = false
    install([baseOperation('contour', 'contour_2d')])

    const oldRun = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    const oldBatch = useCamStore.getState().toolpathBatch!
    const replacement = { id: 'replacement-batch', total: 2, completed: 0 }
    useCamStore.setState({ toolpathBatch: replacement })

    MockWorker.instances[0].complete()
    await oldRun

    expect(oldBatch.id).not.toBe(replacement.id)
    expect(useCamStore.getState().toolpathBatch).toEqual(replacement)
    expect(batchFinishEvents()).toHaveLength(0)
  })

  it('excludes enabled degraded operations from total and dispatch', async () => {
    const degraded = baseOperation('degraded', 'parallel_3d')
    degraded.status = 'degraded'
    degraded.errorMessage = 'preserve degraded reason'
    install([baseOperation('contour', 'contour_2d'), degraded])

    await useCamStore.getState().computeAllToolpaths()

    const start = useCamStore.getState().consoleEvents.find(
      (event) => event.source === 'batch' && event.message.startsWith('Computing toolpaths'),
    )
    expect(start?.message).toContain('1 operation')
    expect(integration.computeParallel3dMoves).not.toHaveBeenCalled()
    expect(operation('degraded')).toMatchObject({
      status: 'degraded', errorMessage: 'preserve degraded reason',
    })
    expect(useCamStore.getState().toolpathBatch).toBeNull()
    expect(batchFinishEvents()).toHaveLength(1)
  })

  it('re-resolves queued 3D inputs after edits made while waiting', async () => {
    const gate = deferred<{ moves: ToolpathMove[]; computeTimeMs: number }>()
    integration.computeParallel3dMoves.mockReturnValueOnce(gate.promise)
    const adaptive = baseOperation('adaptive', 'adaptive_3d')
    install([baseOperation('parallel', 'parallel_3d'), adaptive], [
      makeTool('tool-1', 4), makeTool('tool-2', 8),
    ])

    const run = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    useCamStore.getState().updateOperation('setup-1', 'adaptive', { toolId: 'tool-2' })
    gate.resolve({ moves: [terminalMove], computeTimeMs: 1 })
    await run

    expect(integration.computeAdaptive3dMoves).toHaveBeenCalledOnce()
    expect(integration.computeAdaptive3dMoves.mock.calls[0][0].tool.id).toBe('tool-2')
    expect(useCamStore.getState().toolpathBatch).toBeNull()
  })

  it('invalidates late 3D writes when project identity changes with reused op ids', async () => {
    integration.computeParallel3dMoves.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const error = new Error('old project cancelled')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      }),
    )
    install([baseOperation('parallel', 'parallel_3d')])

    const run = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    const outgoing = useCamStore.getState().project
    const replacementOp = baseOperation('parallel', 'parallel_3d')
    const replacement: Project = {
      ...outgoing,
      id: 'replacement-project',
      setups: [makeSetup([replacementOp])],
    }
    useCamStore.getState().setProject(replacement)
    await run

    expect(useCamStore.getState().project.id).toBe('replacement-project')
    expect(operation('parallel').status).toBe('pending')
    expect(useCamStore.getState().toolpathBatch).toBeNull()
    expect(integration.disposeCam3dClient).toHaveBeenCalled()
  })

  it('turns an unexpected scheduler rejection into a structured terminal op error', async () => {
    integration.schedulerReject = true
    install([baseOperation('parallel', 'parallel_3d')])

    await useCamStore.getState().computeAllToolpaths()

    expect(operation('parallel')).toMatchObject({
      status: 'error',
      errorMessage: 'injected scheduler rejection',
    })
    expect(useCamStore.getState().toolpathBatch).toBeNull()
    expect(batchFinishEvents()).toHaveLength(1)
  })

  it('restarts only the CAM3D client when compute progress goes silent', async () => {
    vi.useFakeTimers()
    integration.computeParallel3dMoves.mockReturnValueOnce(new Promise(() => {}))
    install([baseOperation('parallel', 'parallel_3d')])

    const run = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(180_000)
    await run

    expect(operation('parallel').status).toBe('error')
    expect(operation('parallel').errorMessage).toMatch(/stalled.*generating the 3D finish path/i)
    expect(integration.disposeCam3dClient).toHaveBeenCalledOnce()
    expect(integration.disposeModelWorker).not.toHaveBeenCalled()
    expect(useCamStore.getState().toolpathBatch).toBeNull()
  })

  it('recovers a silent preprocessing job, errors its owner, and runs the next 3D job', async () => {
    vi.useFakeTimers()
    integration.acquirePartMesh
      .mockReturnValueOnce(new Promise<PartMesh>(() => {}))
      .mockResolvedValueOnce(mesh)
    install([
      baseOperation('parallel', 'parallel_3d'),
      baseOperation('adaptive', 'adaptive_3d'),
    ])
    const clears = observeBatchClears()

    const run = useCamStore.getState().computeAllToolpaths()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(600_000)
    await run

    expect(operation('parallel').status).toBe('error')
    expect(operation('parallel').errorMessage).toMatch(/stalled.*loading and tessellating/i)
    expect(integration.disposeModelWorker).toHaveBeenCalledOnce()
    expect(operation('adaptive').status).toBe('ready')
    expect(useCamStore.getState().toolpathBatch).toBeNull()
    expect(clears.clears).toBe(1)
    expect(batchFinishEvents()).toHaveLength(1)
    clears.unsubscribe()
  })
})
