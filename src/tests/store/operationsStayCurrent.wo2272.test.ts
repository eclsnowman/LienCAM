// WO-2272: operations stay current once they compute; Regen All leaves them
// current; Post Process takes them.
//
// The fresh-PC journey (WO-2249) built six operations on one setup - Face,
// Adaptive, Contour, Drill, Pocket, 3D Finish - and saw them read "outdated"
// right after computing, the status bar stuck on "Compute pending", Regen All
// leave operations outdated, and Post Process refuse them as out of date.
//
// Every case drives the store's production actions: addOperation,
// computeOperationToolpath (what a new operation runs on create, and the
// operation's own Compute), computeAllToolpaths (Regen All), updateOperation;
// then the App status-bar derivation and buildPostInput + validateOpsCurrent.
// The REAL toolpathWorker.ts runs every 2D operation in-process; the only
// stand-ins are the Worker thread (node has none) and the 3D engine call
// (computeParallel3dMoves / acquirePartMesh), whose moves come back over the
// stock so the 3D Finish reads what the 2D operations before it removed.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
// This node suite must import the picker without a window or page address.
import { DEMO_EXAMPLES } from '../../components/modals/DemoExamplePickerModal'
import { useCamStore } from '../../store'
import { buildPostInput } from '../../lib/post/buildPostInput'
import { validateOpsCurrent } from '../../lib/post/validate'
import { Cam3dClient } from '../../cam3d/worker/client'
import type { PartMesh } from '../../cam3d/kernel/types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
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

vi.mock('../../lib/stlCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stlCache')>()
  return typedMock<typeof import('../../lib/stlCache')>({ ...actual, loadCachedSTL: engine.loadCachedSTL })
})

vi.mock('../../cam3d/integration/appClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  return typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...actual,
    getCam3dClient: () => new Cam3dClient({
      postMessage: () => {}, terminate: () => {}, onmessage: null, onerror: null,
    }),
    disposeCam3dClient: vi.fn(),
  })
})

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

/** The part outline, a pocket and a hole, drawn on the plate top. */
function sketch(): ImportedGeometry {
  return {
    id: 'sketch', name: 'Journey sketch', filename: 'journey.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 10, y: 10, z: PLATE_TOP }, { x: 70, y: 50, z: PLATE_TOP }),
    position: { x: 0, y: 0, z: PLATE_TOP }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: STOCK_ID, stockIdLocked: true,
    loops: [
      { id: 'outline', closed: true, type: 'contour', layerId: 'L1', area: 2400, points: rect(10, 10, 70, 50) },
      { id: 'pocket', closed: true, type: 'contour', layerId: 'L1', area: 200, points: rect(20, 20, 40, 30) },
      { id: 'hole', closed: true, type: 'hole', layerId: 'L1', area: Math.PI * 9, points: circle(55, 30, 3) },
    ],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

/** The model the 3D Finish runs over. */
function model(): ImportedGeometry {
  return {
    id: 'model', name: 'Journey model', filename: 'model.stl', type: 'mesh', format: 'stl',
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

const END_MILL = tool({ id: 'end-mill', name: 'Journey 6mm end mill' })
const DRILL = tool({ id: 'drill', name: 'Journey 5mm drill', type: 'drill', diameter: 5 })
const BALL = tool({ id: 'ball', name: 'Journey 6mm ball', type: 'ball_end_mill' })

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
  depthMm = 3,
): Operation {
  const geometryIds = [type === 'parallel_3d' ? 'model' : 'sketch']
  return {
    id, name, type, enabled: true, status: 'pending', toolId,
    geometrySelections: type === 'parallel_3d' ? ['model'] : [],
    heights: HEIGHTS, passes: PASSES, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture(type, {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds, stockId: STOCK_ID, explicitDepthMm: depthMm,
    }),
  } as unknown as Operation
}

/** The journey's six operations, in its order. */
function journeyOperations(): Operation[] {
  return [
    op('face', 'Journey Face', 'face', END_MILL.id, { boundarySource: 'stock', stepover: 4, direction: 'climb' }, 1),
    op('adaptive', 'Journey Adaptive', 'adaptive_clearing_2d', END_MILL.id, {
      geometryId: 'sketch', loopIds: ['pocket'], optimalLoad: 1, direction: 'climb',
    }),
    { ...op('contour', 'Journey Contour', 'contour_2d', END_MILL.id, {
      geometryId: 'sketch', loopIds: ['outline'], side: 'outer', direction: 'climb', tabs: false,
    }), passes: { ...PASSES, finishPasses: 1 } },
    op('drill', 'Journey Drill', 'drill', DRILL.id, {
      geometryId: 'sketch', loopIds: ['hole'], cycleType: 'simple', peckDepth: 2, chipBreakRetract: 1,
      dwell: 0, retractMode: 'retract', sortStrategy: 'none', perHoleDepth: false,
    }),
    op('pocket', 'Journey Pocket', 'pocket_2d', END_MILL.id, {
      geometryId: 'sketch', loopIds: ['pocket'], stepover: 3, direction: 'climb',
    }),
    op('finish3d', 'Journey 3D Finish', 'parallel_3d', BALL.id, { stepover: 1, tolerance: 0.05 }),
  ]
}

/** An empty setup on an explicit 80 x 60 x 20 plate (world Z 0..20, G54 on its top). */
function installEmptySetup(): void {
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
      ...s.project, id: 'project-wo2272', geometry: [sketch(), model()], stocks: [stock], setups: [setup],
      sceneStock, activeSetupId: SETUP_ID, activeOperationId: null, nests: [], modelItemPlacements: [],
    } as Project,
  }))
}

// ── The worker wire: real toolpathWorker.ts, in-process, one request at a time ──

let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerQueue: Promise<void> = Promise.resolve()

// The status bar's own label derivation. App.tsx registers a dev seed on
// `window` at import, so it is imported once a window exists.
let statusBarLabel: typeof import('../../App').statusBarLabel

beforeAll(async () => {
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  if (g.window === undefined) g.window = {}
  statusBarLabel = (await import('../../App')).statusBarLabel
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

/** A 3D result over the model top that starts and ends at Clearance, as the
 *  real strategies do (CAM-17: Post checks that anchor). */
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
  engine.loadCachedSTL.mockResolvedValue(new ArrayBuffer(8))
  engine.acquirePartMesh.mockResolvedValue(mesh)
  engine.computeParallel3dMoves.mockImplementation(async (input) => ({ moves: finishMoves(input), computeTimeMs: 1 }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  installEmptySetup()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useCamStore.setState({ toolpathBatch: null })
})

// ── Reading the result ───────────────────────────────────────────────────────

const operations = () => useCamStore.getState().project.setups[0].operations
const statusById = () => Object.fromEntries(operations().map((o) => [o.id, o.status]))
const ALL_READY = {
  face: 'ready', adaptive: 'ready', contour: 'ready', drill: 'ready', pocket: 'ready', finish3d: 'ready',
}

function postDiagnostics() {
  const state = useCamStore.getState()
  const project = { ...state.project, toolLibrary: state.toolLibrary }
  return validateOpsCurrent(buildPostInput(project, project.setups[0]).setup.operations)
}

/** The journey: each operation is created and computes on create, then the next. */
async function createLikeTheJourney(): Promise<void> {
  for (const operation of journeyOperations()) {
    useCamStore.getState().addOperation(SETUP_ID, operation)
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, operation.id)
  }
  const errors = operations().filter((o) => o.status === 'error').map((o) => `${o.name}: ${o.errorMessage}`)
  expect(errors).toEqual([])
}

describe('WO-2272 operations stay current after they compute', () => {
  it('imports the demo catalog without a browser page address (WO-2457)', () => {
    expect((globalThis as unknown as { window: { location?: unknown } }).window.location).toBeUndefined()
    expect(DEMO_EXAMPLES.length).toBeGreaterThan(0)
    expect(DEMO_EXAMPLES.every((example) => typeof example.url === 'string')).toBe(true)
  })

  it('one Regen All leaves all six ready, the status bar Ready and Post with no OP_OUTDATED', async () => {
    await createLikeTheJourney()
    // The later operations were built on what the earlier ones removed.
    expect(operations().slice(1).map((o) => [o.id, (o as { dependsOnPredecessors?: boolean }).dependsOnPredecessors]))
      .toEqual([['adaptive', true], ['contour', true], ['drill', true], ['pocket', true], ['finish3d', true]])

    await useCamStore.getState().computeAllToolpaths()

    expect(statusById()).toEqual(ALL_READY)
    expect(statusBarLabel(useCamStore.getState())).toBe('Ready')
    expect(postDiagnostics().filter((d) => d.code === 'OP_OUTDATED')).toEqual([])
  })

  it('computing the first operation again with the same inputs leaves the five after it ready', async () => {
    await createLikeTheJourney()
    expect(statusById()).toEqual(ALL_READY)
    const before = Object.fromEntries(operations().map((o) => [o.id, o.generationFingerprint]))

    const run = useCamStore.getState().computeOperationToolpath(SETUP_ID, 'face')
    // While the Face computes, the operations after it keep their results.
    expect(operations().find((o) => o.id === 'face')!.status).toBe('computing')
    expect(operations().slice(1).map((o) => o.status)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready'])
    await run

    expect(statusById()).toEqual(ALL_READY)
    expect(Object.fromEntries(operations().map((o) => [o.id, o.generationFingerprint]))).toEqual(before)
    expect(statusBarLabel(useCamStore.getState())).toBe('Ready')
    expect(postDiagnostics().filter((d) => d.code === 'OP_OUTDATED')).toEqual([])
  })

  it('a real change to the first operation still outdates every operation built on it', async () => {
    await createLikeTheJourney()
    expect(statusById()).toEqual(ALL_READY)

    const face = operations().find((o) => o.id === 'face')!
    useCamStore.getState().updateOperation(SETUP_ID, 'face', { passes: { ...face.passes, stepdown: 0.5 } })

    expect(operations().slice(1).map((o) => [o.id, o.status])).toEqual([
      ['adaptive', 'outdated'], ['contour', 'outdated'], ['drill', 'outdated'],
      ['pocket', 'outdated'], ['finish3d', 'outdated'],
    ])
    expect(postDiagnostics().filter((d) => d.code === 'OP_OUTDATED').length).toBeGreaterThanOrEqual(1)
  })

  it('Regen All pressed while an operation is still computing still ends with every operation ready', async () => {
    // The journey pressed Regen All a second after creating the 3D Finish,
    // whose compute-on-create was still running.
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    engine.computeParallel3dMoves.mockImplementationOnce(async (input) => {
      await held
      return { moves: finishMoves(input), computeTimeMs: 1 }
    })
    for (const operation of journeyOperations()) useCamStore.getState().addOperation(SETUP_ID, operation)
    const onCreate = useCamStore.getState().computeOperationToolpath(SETUP_ID, 'finish3d')
    await vi.waitFor(() => expect(operations().find((o) => o.id === 'finish3d')!.status).toBe('computing'))

    const regenAll = useCamStore.getState().computeAllToolpaths()
    release()
    await Promise.all([onCreate, regenAll])
    await vi.waitFor(() => expect(useCamStore.getState().toolpathBatch).toBeNull())

    expect(statusById()).toEqual(ALL_READY)
    expect(statusBarLabel(useCamStore.getState())).toBe('Ready')
    expect(postDiagnostics().filter((d) => d.code === 'OP_OUTDATED')).toEqual([])
  })
})
