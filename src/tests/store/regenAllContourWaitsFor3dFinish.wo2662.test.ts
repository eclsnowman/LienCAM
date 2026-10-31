// WO-2662: in Regenerate All, an operation is done only when its FINAL result
// is published, so the operations after it build on that result.
//
// Machine session (2026-10-07 4:35 PM, Full Suite): Setup 5's Contour 2 computed while
// 3D Finish 3 was still at 50%, started at "the material 3D Rough 1 left",
// and ended the batch outdated; regenerating Contour 2 alone turned it green.
// The batch's wait for 3D Finish 3 ended while a compute of 3D Finish 3 was
// still running. The route proven here: the batch's own compute of the 3D
// operation ends without a result (the operator pressed Cancel on it while it
// waited its turn) and the operator's Generate computes it again inside the
// batch. The Contour used to start as soon as the cancelled compute returned.
//
// The first case drives the store's production actions (addOperation,
// computeAllToolpaths, cancelParallel3dCompute, computeOperationToolpath) with
// the REAL toolpathWorker.ts in-process; the only stand-in is the 3D engine
// call. The second opens the shipped Full Suite file and runs the real 3D
// engines through an in-process cam3d dispatcher (WO-2656's harness).

import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import { operationGenerationIsCurrent, projectOperationFingerprint } from '../../lib/cam/generationFingerprint'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'

// The 3D engine seam: the real functions unless a case stands one in.
const engine = vi.hoisted(() => ({
  acquirePartMesh: vi.fn(),
  computeParallel3dMoves: vi.fn(),
  loadCachedSTL: vi.fn(),
}))

vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()
  return typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...actual,
    acquirePartMesh: engine.acquirePartMesh,
    computeParallel3dMoves: engine.computeParallel3dMoves,
  })
})

// In-memory binary caches (the real ones live in IndexedDB), so a loaded
// project's embedded STL/STEP bytes reach the 3D engines.
const stlBytes = new Map<string, ArrayBuffer>()
const stepBytes = new Map<string, ArrayBuffer>()
const stepDisplay = new Map<string, CachedStepDisplay>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytes.set(id, buffer) }),
  loadCachedSTL: engine.loadCachedSTL,
  removeCachedSTL: vi.fn(async (id: string) => { stlBytes.delete(id) }),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof import('../../lib/stepCache')>({
    ...actual,
    cacheStep: vi.fn(async (id: string, buffer: ArrayBuffer) => { stepBytes.set(id, buffer) }),
    loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
    removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
    cacheStepDisplay: vi.fn(async (
      id: string,
      payload: BrepModelPayload,
      sourceSha256: string,
      tessellation: StepDisplayTessellation | null,
    ) => {
      stepDisplay.set(id, {
        displayContractVersion: 1, sourceSha256, tessellation, payload, byteLength: 0, updatedAt: 0,
      })
    }),
    loadCachedStepDisplay: vi.fn(async (id: string) => stepDisplay.get(id) ?? null),
    removeCachedStepDisplay: vi.fn(async (id: string) => { stepDisplay.delete(id) }),
  })
})

// The cam3d worker runs in-process: the real BvhKernel behind the real dispatcher.
vi.mock('../../cam3d/integration/appClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  const { BvhKernel } = await import('../../cam3d/kernel/bvhKernel')
  const { Cam3dClient } = await import('../../cam3d/worker/client')
  const { Cam3dDispatcher } = await import('../../cam3d/worker/dispatcher')
  let client: InstanceType<typeof Cam3dClient> | null = null
  const make = () => {
    const kernel = new BvhKernel()
    const fakeWorker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      postMessage(message: unknown): void { dispatcher.handle(message as never) },
      terminate(): void {},
    }
    const dispatcher = new Cam3dDispatcher(kernel, (message: unknown) => {
      fakeWorker.onmessage?.({ data: message } as MessageEvent)
    })
    return new Cam3dClient(fakeWorker as never)
  }
  return typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...actual,
    getCam3dClient: () => (client ??= make()),
    disposeCam3dClient: () => { client = null },
  })
})

// STEP parts tessellate through the in-process OCCT core, not the browser model worker.
vi.mock('../../cam3d/input/stepTessellatorWorker', async () => {
  const { readFileSync } = await import('node:fs')
  const nodePath = await import('node:path')
  const { loadOcctModel } = await import('../../lib/cam/geometry/occt/model/loader')
  const { makeOcctCoreTessellator } = await import('../../cam3d/input/occtCoreTessellator')
  const wasmPath = nodePath.resolve(__dirname, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm')
  let tessellator: import('../../cam3d/input/types').StepTessellator | null = null
  const workerStepTessellator: import('../../cam3d/input/types').StepTessellator = async (bytes, params) => {
    tessellator ??= makeOcctCoreTessellator(await loadOcctModel({ wasmBinary: readFileSync(wasmPath) }))
    return tessellator(bytes, params)
  }
  return typedMock<typeof import('../../cam3d/input/stepTessellatorWorker')>({ workerStepTessellator })
})

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const realEngine = await vi.importActual<typeof import('../../cam3d/integration/parallel3dOperation')>(
  '../../cam3d/integration/parallel3dOperation')

const SETUP_ID = 'setup-1'
const STOCK_ID = 'stock-1'
const PLATE_TOP = 20

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function rect(x0: number, y0: number, x1: number, y1: number) {
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
}

function circle(cx: number, cy: number, r: number) {
  return Array.from({ length: 32 }, (_, i) => {
    const t = (2 * Math.PI * i) / 32
    return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) }
  })
}

/** The part outline and a screw hole, drawn on the plate top. */
function sketch(): ImportedGeometry {
  return {
    id: 'sketch', name: 'Medallion outline', filename: 'outline.svg', type: 'curves_2d', format: 'svg',
    boundingBox: bbox({ x: 10, y: 10, z: PLATE_TOP }, { x: 70, y: 50, z: PLATE_TOP }),
    position: { x: 0, y: 0, z: PLATE_TOP }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: STOCK_ID, stockIdLocked: true,
    loops: [
      { id: 'outline', closed: true, type: 'contour', layerId: 'L1', area: 2400, points: rect(10, 10, 70, 50) },
      { id: 'hole', closed: true, type: 'hole', layerId: 'L1', area: Math.PI * 9, points: circle(55, 30, 3) },
    ],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

/** The relief the 3D operation runs over. */
function model(): ImportedGeometry {
  return {
    id: 'model', name: 'Relief', filename: 'relief.stl', type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 60, y: 40, z: 15 }),
    position: { x: 10, y: 10, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: STOCK_ID,
  } as unknown as ImportedGeometry
}

const mesh: PartMesh = {
  positions: new Float32Array([0, 0, 0, 60, 0, 0, 0, 40, 15]),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: [0, 0, 0], max: [60, 40, 15] },
  source: 'stl',
}

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'tool', name: 'tool', type: 'flat_end_mill',
    diameter: 6, fluteLength: 25, shankDiameter: 6, overallLength: 70,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool
}

const END_MILL = tool({ id: 'end-mill', name: 'WO-2662 6mm end mill' })
const DRILL = tool({ id: 'drill', name: 'WO-2662 5mm drill', type: 'drill', diameter: 5 })
const BALL = tool({ id: 'ball', name: 'WO-2662 6mm ball', type: 'ball_end_mill' })

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

const HEIGHTS: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 10, feedHeight: 5,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -3, bottomHeightMode: 'absolute',
}

const PASSES: PassParams = { stepdown: 2, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 }

function op(
  id: string, name: string, type: Operation['type'], toolId: string, params: Record<string, unknown>,
): Operation {
  const geometryIds = [type === 'parallel_3d' ? 'model' : 'sketch']
  return {
    id, name, type, enabled: true, status: 'pending', toolId,
    geometrySelections: type === 'parallel_3d' ? ['model'] : [],
    heights: HEIGHTS, passes: PASSES, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture(type, {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds, stockId: STOCK_ID, explicitDepthMm: 3,
    }),
  } as unknown as Operation
}

/** The example's order: Drill, then the 3D operation, then the Contour. */
function reliefOperations(): Operation[] {
  return [
    op('drill', 'Drill 1', 'drill', DRILL.id, {
      geometryId: 'sketch', loopIds: ['hole'], cycleType: 'simple', peckDepth: 2, chipBreakRetract: 1,
      dwell: 0, retractMode: 'retract', sortStrategy: 'none', perHoleDepth: false,
    }),
    op('finish3d', '3D Finish 2', 'parallel_3d', BALL.id, { stepover: 1, tolerance: 0.05 }),
    { ...op('contour', 'Contour 3', 'contour_2d', END_MILL.id, {
      geometryId: 'sketch', loopIds: ['outline'], side: 'outer', direction: 'climb', tabs: false,
    }), passes: { ...PASSES, finishPasses: 1 } },
  ]
}

function installSetup(): void {
  const stock = {
    id: STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 80, y: 60, z: PLATE_TOP }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: SETUP_ID, name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: PLATE_TOP },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [], notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 80, fixedHeight: 60, fixedDepth: PLATE_TOP,
    fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [END_MILL, DRILL, BALL],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project, id: 'project-wo2662', geometry: [sketch(), model()], stocks: [stock], setups: [setup],
      sceneStock, activeSetupId: SETUP_ID, activeOperationId: null, nests: [], modelItemPlacements: [],
    } as Project,
  }))
  for (const operation of reliefOperations()) useCamStore.getState().addOperation(SETUP_ID, operation)
}

// ── The worker wire: real toolpathWorker.ts, in-process, one request at a time ──

let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerQueue: Promise<void> = Promise.resolve()

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

/** A 3D result over the relief top that starts and ends at Clearance. */
function finishMoves(input: { resolvedHeights: { clearanceZ: number } }): ToolpathMove[] {
  const clearance = input.resolvedHeights.clearanceZ
  return [
    { type: 'rapid', x: 0, y: 0, z: clearance, role: 'rapid' },
    { type: 'feed', x: 0, y: 0, z: 15, feed: 500, role: 'cut' },
    { type: 'feed', x: 60, y: 0, z: 15, feed: 500, role: 'cut' },
    { type: 'feed', x: 60, y: 40, z: 15, feed: 500, role: 'cut' },
    { type: 'rapid', x: 60, y: 40, z: clearance, role: 'rapid' },
  ] as ToolpathMove[]
}

const operations = () => useCamStore.getState().project.setups[0].operations
const operation = (id: string) => operations().find((o) => o.id === id)!

beforeEach(() => {
  workerQueue = Promise.resolve()
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerQueue = workerQueue.then(async () => {
        activeShim = this
        await workerSelf.onmessage!({ data })
      })
    }
    terminate(): void { /* no thread */ }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useCamStore.setState({ toolpathBatch: null })
})

/** Every status each operation passes through, in order, while `run` runs. */
async function recordStatuses(run: () => Promise<void>): Promise<string[]> {
  const seen: string[] = []
  const last = new Map<string, string>()
  const unsubscribe = useCamStore.subscribe((state) => {
    for (const setup of state.project.setups) {
      for (const o of setup.operations) {
        if (last.get(o.id) === o.status) continue
        last.set(o.id, o.status)
        seen.push(`${o.id}:${o.status}`)
      }
    }
  })
  try {
    await run()
  } finally {
    unsubscribe()
  }
  return seen
}

describe('WO-2662 the operation after a 3D operation waits for its final result', () => {
  let engineCalls = 0
  let releaseFirst3d = () => {}

  beforeEach(() => {
    engineCalls = 0
    const firstHeld = new Promise<void>((resolve) => { releaseFirst3d = resolve })
    engine.loadCachedSTL.mockResolvedValue(new ArrayBuffer(8))
    engine.acquirePartMesh.mockResolvedValue(mesh)
    engine.computeParallel3dMoves.mockImplementation(async (input) => {
      engineCalls += 1
      // The first 3D operation holds the CAM3D lane until the case releases it.
      if (engineCalls === 1) await firstHeld
      // The second 3D operation: held until the Contour has replied, or - when
      // the Contour correctly waits for it and so never computes first - a short while.
      else {
        await vi.waitFor(() => {
          if (operation('contour').status !== 'ready') throw new Error('the Contour has not replied yet')
        }, { timeout: 750, interval: 10 }).catch(() => {})
      }
      return { moves: finishMoves(input), computeTimeMs: 1 }
    })
    installSetup()
    // Setup 5's shape: two 3D operations, then the Contour.
    useCamStore.getState().addOperation(SETUP_ID, op('first3d', '3D Finish 1', 'parallel_3d', BALL.id, { stepover: 2, tolerance: 0.05 }))
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        setups: s.project.setups.map((setup) => ({
          ...setup,
          operations: ['drill', 'first3d', 'finish3d', 'contour'].map((id) => setup.operations.find((o) => o.id === id)!),
        })),
      },
    }))
  })

  it('Cancel then Generate on a queued 3D operation mid-batch: the Contour runs after its new result and ends ready', async () => {
    const seen = await recordStatuses(async () => {
      const batch = useCamStore.getState().computeAllToolpaths()
      // 3D Finish 1 computes; 3D Finish 2 waits its turn in the CAM3D lane.
      await vi.waitFor(() => expect(engineCalls).toBe(1))
      expect(operation('finish3d').status).toBe('computing')
      // The Properties panel's Cancel on 3D Finish 2, then its Generate.
      useCamStore.getState().cancelParallel3dCompute('finish3d')
      expect(operation('finish3d').status).toBe('pending')
      const generate = useCamStore.getState().computeOperationToolpath(SETUP_ID, 'finish3d')
      releaseFirst3d()
      await batch
      await vi.waitFor(() => expect(useCamStore.getState().toolpathBatch).toBeNull())
      await generate
    })
    process.stdout.write(`[WO-2662] status order: ${seen.join(' ')}\n`)

    expect(operations().map((o) => [o.id, o.status, o.errorMessage])).toEqual([
      ['drill', 'ready', undefined], ['first3d', 'ready', undefined],
      ['finish3d', 'ready', undefined], ['contour', 'ready', undefined],
    ])
    expect(operation('contour').toolpathMoves?.length ?? 0).toBeGreaterThan(0)
    // The Contour started only after the 3D operation's final result published.
    expect(seen.lastIndexOf('contour:computing')).toBeGreaterThan(seen.lastIndexOf('finish3d:ready'))
    expect(seen).not.toContain('contour:outdated')

    // Its claim reads the 3D predecessor as READY.
    const state = useCamStore.getState()
    const project = { ...state.project, toolLibrary: state.toolLibrary }
    const setup = project.setups[0]
    const contour = operation('contour')
    const resolveTool = (toolId: string) => state.toolLibrary.find((t) => t.id === toolId)
    expect(operationGenerationIsCurrent(project, setup, contour)).toBe(true)
    const without3dResult = {
      ...setup,
      operations: setup.operations.map((o) => o.id === 'finish3d' ? { ...o, status: 'outdated' as const } : o),
    }
    expect(contour.generationFingerprint).not.toBe(
      projectOperationFingerprint(project, without3dResult, contour, contour.resolvedHeights!, undefined, resolveTool))
  })

  it('with nothing to wait for, Regenerate All dispatches its first job after one renderer frame, waiting on no operation', async () => {
    engine.computeParallel3dMoves.mockImplementation(async (input) => ({ moves: finishMoves(input), computeTimeMs: 1 }))
    const batch = useCamStore.getState().computeAllToolpaths()
    // WO-3126: every batch dispatch, a job with nothing to wait for included,
    // first leaves the renderer one input/paint frame. It waits on nothing else:
    // the first job is computing before any operation has finished.
    expect(operation('drill').status).toBe('pending')
    await vi.waitFor(() => expect(operation('drill').status).toBe('computing'), { interval: 1 })
    expect(operations().filter((o) => o.status === 'ready')).toEqual([])
    await batch
    await vi.waitFor(() => expect(useCamStore.getState().toolpathBatch).toBeNull())
    expect(operations().map((o) => o.status)).toEqual(['ready', 'ready', 'ready', 'ready'])
  })
})

const FULL_SUITE = path.resolve(__dirname, '../../../Example Projects/Full Suite.camproject')

describe('WO-2662 Full Suite (Example Projects/Full Suite.camproject)', () => {
  beforeEach(() => {
    stlBytes.clear(); stepBytes.clear(); stepDisplay.clear(); mem.clear()
    engine.loadCachedSTL.mockImplementation(async (id: string) => stlBytes.get(id) ?? null)
    engine.acquirePartMesh.mockImplementation(realEngine.acquirePartMesh)
    engine.computeParallel3dMoves.mockImplementation(realEngine.computeParallel3dMoves)
    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())
    useCamStore.getState().newProject()
  })

  it('one Regenerate All leaves every operation ready, none outdated, Setup 5 Contour 2 built on 3D Finish 3', async () => {
    await useCamStore.getState().loadProjectFromFile(fs.readFileSync(FULL_SUITE, 'utf8'))
    vi.stubGlobal('window', {
      __cncViewport: {
        getStockBounds: (stockId?: string) => {
          const stock = useCamStore.getState().project.stocks?.find((candidate) => candidate.id === stockId)
          if (!stock || stock.mode !== 'explicit') return null
          const at = (v: Vec3) => ({ x: v.x + stock.position.x, y: v.y + stock.position.y, z: v.z + stock.position.z })
          return { min: at(stock.bounds.min), max: at(stock.bounds.max) }
        },
      },
    })
    const seen = await recordStatuses(async () => {
      await useCamStore.getState().computeAllToolpaths()
      await vi.waitFor(() => expect(useCamStore.getState().toolpathBatch).toBeNull(), { timeout: 600_000 })
    })

    const state = useCamStore.getState()
    const project = { ...state.project, toolLibrary: state.toolLibrary }
    const rows = project.setups.flatMap((setup) => setup.operations.map((o) => ({
      setup: setup.name, name: o.name, status: o.status, moves: o.toolpathMoves?.length ?? 0,
      current: operationGenerationIsCurrent(project, setup, o), error: o.errorMessage,
    })))
    process.stdout.write(`[WO-2662] Full Suite after one Regenerate All: ${JSON.stringify(rows)}\n`)
    for (const row of rows) {
      expect(row, `${row.setup} / ${row.name}`).toMatchObject({ status: 'ready', current: true, error: undefined })
      expect(row.moves, `${row.setup} / ${row.name}`).toBeGreaterThan(0)
    }
    const setup5 = project.setups.find((setup) => setup.name === 'Setup 5')!
    const id = (name: string) => setup5.operations.find((o) => o.name === name)!.id
    expect(seen.lastIndexOf(`${id('Contour 2')}:computing`)).toBeGreaterThan(seen.lastIndexOf(`${id('3D Finish 3')}:ready`))
    expect(state.consoleEvents.map((e) => e.message)).toContainEqual(
      expect.stringContaining('"Contour 2": starts at Z -5.002, the material "3D Finish 3" left'))
  }, 900_000)
})

