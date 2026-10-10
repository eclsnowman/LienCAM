// @vitest-environment jsdom
// WO-2661: Post Process "Recompute all" runs staged, upstream first.
//
// Operator (2026-10-07): "they need to run staged because we are utilizing stock
// aware machining, So a later operation cannot reasonably computer until the
// upstream does." The modal's Recompute all used to fire computeOperationToolpath
// for every enabled operation of the selected setups at once, so a Contour
// after a 3D operation ran beside it and stamped a claim built on no
// predecessor. It now runs the selected setups through Regenerate All's staged
// schedule (computeAllToolpaths).
//
// Every case clicks the REAL modal's Recompute all button. The REAL
// toolpathWorker.ts runs the 2D operations in-process; the only stand-in is
// the 3D engine call, held by the case.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { PartMesh } from '../../cam3d/kernel/types'
import { operationGenerationIsCurrent, projectOperationFingerprint } from '../../lib/cam/generationFingerprint'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { makeMachine, stampGenerationCurrent } from '../post/helpers'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'

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

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: engine.loadCachedSTL,
  removeCachedSTL: vi.fn(async () => {}),
}))

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

const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')

const PROJECT_ID = 'project-wo2661'
const SETUP_1 = 'setup-1'
const SETUP_2 = 'setup-2'
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

function sketch(): ImportedGeometry {
  return {
    id: 'sketch', name: 'Outline', filename: 'outline.svg', type: 'curves_2d', format: 'svg',
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

const END_MILL = tool({ id: 'end-mill', name: 'WO-2661 6mm end mill' })
const DRILL = tool({ id: 'drill', name: 'WO-2661 5mm drill', type: 'drill', diameter: 5 })
const BALL = tool({ id: 'ball', name: 'WO-2661 6mm ball', type: 'ball_end_mill' })

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
  setupId: string, id: string, name: string, type: Operation['type'], toolId: string, params: Record<string, unknown>,
): Operation {
  const geometryIds = [type === 'parallel_3d' ? 'model' : 'sketch']
  return {
    id, name, type, enabled: true, status: 'pending', toolId,
    geometrySelections: type === 'parallel_3d' ? ['model'] : [],
    heights: HEIGHTS, passes: PASSES, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture(type, {
      setupId, heights: HEIGHTS, params, geometryIds, stockId: STOCK_ID, explicitDepthMm: 3,
    }),
  } as unknown as Operation
}

function drill(setupId: string, id: string, name: string): Operation {
  return op(setupId, id, name, 'drill', DRILL.id, {
    geometryId: 'sketch', loopIds: ['hole'], cycleType: 'simple', peckDepth: 2, chipBreakRetract: 1,
    dwell: 0, retractMode: 'retract', sortStrategy: 'none', perHoleDepth: false,
  })
}

function setup(id: string, name: string, operations: Operation[]): Setup {
  return {
    id, name,
    wcs: {
      id: `wcs-${id}`, label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: PLATE_TOP },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations, notes: '',
  } as unknown as Setup
}

/** Setup 1: Drill -> 3D Finish -> Contour (the stock-aware order). Setup 2: a
 *  Drill. Each Drill reads "ready" with no toolpath, which is the Post Process
 *  diagnostic (OP_NO_TOOLPATH) that offers Recompute all. */
function installProject(): void {
  const stock = {
    id: STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 80, y: 60, z: PLATE_TOP }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
  const sceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 80, fixedHeight: 60, fixedDepth: PLATE_TOP,
    fixedStocks: [],
  } as unknown as SceneStock
  const setups = [
    setup(SETUP_1, 'Setup 1', [
      drill(SETUP_1, 'drill', 'Drill 1'),
      op(SETUP_1, 'finish3d', '3D Finish 2', 'parallel_3d', BALL.id, { stepover: 1, tolerance: 0.05 }),
      { ...op(SETUP_1, 'contour', 'Contour 3', 'contour_2d', END_MILL.id, {
        geometryId: 'sketch', loopIds: ['outline'], side: 'outer', direction: 'climb', tabs: false,
      }), passes: { ...PASSES, finishPasses: 1 } },
    ]),
    setup(SETUP_2, 'Setup 2', [drill(SETUP_2, 'drill-2', 'Drill 4')]),
  ]
  const current = useCamStore.getState().project
  const project = {
    ...current, id: PROJECT_ID, name: 'WO-2661', machine: makeMachine(),
    geometry: [sketch(), model()], stocks: [stock], setups,
    sceneStock, activeSetupId: SETUP_1, activeOperationId: null, nests: [], modelItemPlacements: [],
  } as unknown as Project
  for (const s of setups) {
    const first = s.operations[0]
    first.status = 'ready'
    first.toolpathMoves = []
    stampGenerationCurrent({ ...project, toolLibrary: [END_MILL, DRILL, BALL] } as Project, s, first, DRILL)
  }
  act(() => {
    useCamStore.setState({
      project, toolLibrary: [END_MILL, DRILL, BALL], toolpathBatch: null, consoleEvents: [],
    } as never)
  })
}

// ── The worker wire: real toolpathWorker.ts, in-process, one request at a time ──

let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerQueue: Promise<void> = Promise.resolve()
/** Every operation the store sent to the 2D worker, in order. */
let dispatched: string[] = []
let realSelf: unknown

beforeAll(async () => {
  realSelf = (globalThis as { self?: unknown }).self
  Object.defineProperty(globalThis, 'self', {
    value: {
      postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
      onmessage: null,
      location: window.location,
    },
    configurable: true, writable: true,
  })
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  Object.defineProperty(globalThis, 'self', { value: realSelf, configurable: true, writable: true })
})

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

const setupOps = (setupId: string) => useCamStore.getState().project.setups.find((s) => s.id === setupId)!.operations
const operation = (setupId: string, id: string) => setupOps(setupId).find((o) => o.id === id)!
const batchStarts = () => useCamStore.getState().consoleEvents
  .filter((event) => event.source === 'batch' && event.severity === 'info')
  .map((event) => event.message)

/** Lets queued promise continuations and worker replies run. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

function openModal(): void {
  render(<PostProcessModal />)
  act(() => useCamStore.getState().openModal('post-process'))
}

function clickRecomputeAll(): void {
  fireEvent.click(screen.getByRole('button', { name: /Recompute all/ }))
}

/** Rescope the modal's output to Setup 2 only, through its setup checkboxes. */
function rescopeToSetup2(): void {
  const [setup1Box, setup2Box] = Array.from(document.querySelectorAll<HTMLInputElement>('input.scope-setup-cb'))
  expect(setup1Box.checked).toBe(true)
  expect(setup2Box.checked).toBe(false)
  fireEvent.click(setup1Box)
  fireEvent.click(setup2Box)
  expect(setup1Box.checked).toBe(false)
  expect(setup2Box.checked).toBe(true)
}

let release3d: () => void = () => {}

beforeEach(() => {
  workerQueue = Promise.resolve()
  activeShim = null
  dispatched = []
  mem.clear()
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      const opId = (data as { payload?: { opId?: string } }).payload?.opId
      if (opId) dispatched.push(opId)
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
  engine.loadCachedSTL.mockResolvedValue(new ArrayBuffer(8))
  engine.acquirePartMesh.mockResolvedValue(mesh)
  let open: () => void = () => {}
  const held = new Promise<void>((resolve) => { open = resolve })
  release3d = open
  // The 3D engine is held until the case releases it, or - once the Contour has
  // replied, which happens only if it raced the 3D operation - at once.
  engine.computeParallel3dMoves.mockImplementation(async (input) => {
    await Promise.race([
      held,
      vi.waitFor(() => {
        if (operation(SETUP_1, 'contour').status !== 'ready') throw new Error('the Contour has not replied yet')
      }, { timeout: 60_000, interval: 10 }),
    ])
    return { moves: finishMoves(input), computeTimeMs: 1 }
  })
  installProject()
})

afterEach(() => {
  release3d()
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  act(() => { useCamStore.getState().closeModal(); useCamStore.setState({ toolpathBatch: null }) })
})

describe('WO-2661 Post Process Recompute all runs staged, upstream first', () => {
  it('Drill -> 3D op -> Contour: each starts after its upstream, all end ready with moves', async () => {
    const seen: string[] = []
    const last = new Map<string, string>()
    const unsubscribe = useCamStore.subscribe((state) => {
      for (const o of state.project.setups.find((s) => s.id === SETUP_1)?.operations ?? []) {
        if (last.get(o.id) === o.status) continue
        last.set(o.id, o.status)
        seen.push(`${o.id}:${o.status}`)
      }
    })
    try {
      openModal()
      clickRecomputeAll()
      await vi.waitFor(() => expect(operation(SETUP_1, 'finish3d').status).toBe('computing'))
      // The 3D operation is held. The Contour must not have started beside it.
      await settle()
      expect(operation(SETUP_1, 'contour').status).toBe('pending')
      release3d()
      await vi.waitFor(() => expect(useCamStore.getState().toolpathBatch).toBeNull(), { timeout: 10_000 })
      await vi.waitFor(() => expect(operation(SETUP_1, 'contour').status).toBe('ready'))
    } finally {
      unsubscribe()
    }

    expect(setupOps(SETUP_1).map((o) => [o.id, o.status, o.errorMessage])).toEqual([
      ['drill', 'ready', undefined], ['finish3d', 'ready', undefined], ['contour', 'ready', undefined],
    ])
    for (const o of setupOps(SETUP_1)) expect(o.toolpathMoves?.length ?? 0, o.id).toBeGreaterThan(0)
    expect(seen).toEqual([
      'drill:ready', 'finish3d:pending', 'contour:pending',
      'drill:computing', 'drill:ready', 'finish3d:computing', 'finish3d:ready', 'contour:computing', 'contour:ready',
    ])

    // The Contour's claim reads the 3D predecessor as READY.
    const state = useCamStore.getState()
    const project = { ...state.project, toolLibrary: state.toolLibrary }
    const setup1 = project.setups.find((s) => s.id === SETUP_1)!
    const contour = operation(SETUP_1, 'contour')
    const resolveTool = (toolId: string) => state.toolLibrary.find((t) => t.id === toolId)
    expect(operationGenerationIsCurrent(project, setup1, contour)).toBe(true)
    expect(contour.generationFingerprint).toBe(
      projectOperationFingerprint(project, setup1, contour, contour.resolvedHeights!, undefined, resolveTool))
    const without3dResult = {
      ...setup1,
      operations: setup1.operations.map((o) => o.id === 'finish3d' ? { ...o, status: 'outdated' as const } : o),
    }
    expect(contour.generationFingerprint).not.toBe(
      projectOperationFingerprint(project, without3dResult, contour, contour.resolvedHeights!, undefined, resolveTool))

    // One batch, the same console line Regenerate All writes; Setup 2 untouched.
    expect(batchStarts()).toHaveLength(1)
    expect(batchStarts()[0]).toMatch(/\b3\b/)
    expect(dispatched).not.toContain('drill-2')
    expect(operation(SETUP_2, 'drill-2').toolpathMoves).toEqual([])
  })

  it('a second Recompute all for another setup waits for the running batch, then runs', async () => {
    openModal()
    clickRecomputeAll()
    await vi.waitFor(() => expect(operation(SETUP_1, 'finish3d').status).toBe('computing'))
    const firstBatch = useCamStore.getState().toolpathBatch!.id

    rescopeToSetup2()
    clickRecomputeAll()
    // Regenerate All too: everything it asks for is covered by now.
    void useCamStore.getState().computeAllToolpaths()
    await settle()
    // The running batch keeps its token; Setup 2 waits behind it.
    expect(useCamStore.getState().toolpathBatch?.id).toBe(firstBatch)
    expect(dispatched).not.toContain('drill-2')

    release3d()
    await vi.waitFor(() => expect(operation(SETUP_2, 'drill-2').status).toBe('ready'), { timeout: 10_000 })
    await vi.waitFor(() => expect(useCamStore.getState().toolpathBatch).toBeNull())
    await settle()

    for (const s of [SETUP_1, SETUP_2]) {
      for (const o of setupOps(s)) {
        expect(o.status, o.id).toBe('ready')
        expect(o.toolpathMoves?.length ?? 0, o.id).toBeGreaterThan(0)
      }
    }
    // Two batches - Setup 1's three operations, then Setup 2's one - and
    // nothing ran twice: Regenerate All was covered by the two.
    expect(batchStarts()).toHaveLength(2)
    expect(batchStarts()[0]).toMatch(/\b3\b/)
    expect(batchStarts()[1]).toMatch(/\b1\b/)
    expect(dispatched).toEqual(['drill', 'contour', 'drill-2'])
  })

  it('a waiting request is dropped when the same project is reopened, never run against the reopened file', async () => {
    const savedFile = JSON.stringify(useCamStore.getState().project)
    openModal()
    clickRecomputeAll()
    await vi.waitFor(() => expect(operation(SETUP_1, 'finish3d').status).toBe('computing'))
    rescopeToSetup2()
    clickRecomputeAll()
    await settle()
    expect(dispatched).not.toContain('drill-2')

    // Reopen the saved copy of the SAME project (same id, same setup ids).
    await act(async () => {
      const store = useCamStore.getState()
      await store.loadProjectFromFile(savedFile, store.beginProjectOpen())
    })
    expect(useCamStore.getState().project.id).toBe(PROJECT_ID)
    release3d()
    await settle()
    await settle()

    // The old request belonged to the outgoing document: it starts no batch
    // and computes nothing in the reopened one.
    expect(dispatched).not.toContain('drill-2')
    expect(useCamStore.getState().toolpathBatch).toBeNull()
    expect(operation(SETUP_2, 'drill-2').status).not.toBe('computing')
    expect(operation(SETUP_2, 'drill-2').toolpathMoves ?? []).toEqual([])
  })
})
