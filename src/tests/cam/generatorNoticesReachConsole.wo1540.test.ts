// WO-1540: what a toolpath generator substituted or left out reaches the app console.
//
// Before this order every generator that changed what it produced said so on the browser
// developer console only (console.log / console.warn); no toolpath worker result carried a
// message, so the operator received a plunge instead of the helix he asked for, or a
// different stepover, and was never told. These tests drive the REAL chain:
//
//   store.computeOperationToolpath -> real payload -> REAL toolpathWorker.ts self.onmessage
//   -> real builder -> the worker's own TOOLPATH_COMPLETE -> the store's real onmessage
//   -> app console (consoleEvents)
//
// The only stand-in is the Worker thread itself: node has none, so the stub hands each
// posted request to the real worker module in-process and relays what it posts back.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// Before the store import on purpose: the store transitively imports the modules mocked
// below, and a typedMock binding imported after it is not yet initialized when the hoisted
// factories run (see holderClearance3d.wo278.test.ts).
import { typedMock } from '../support/typedMock'
import { useCamStore } from '../../store'
import { buildBoreToolpath } from '../../lib/cam/bore2d'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { wave } from '../../cam3d/fixtures'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import { xyBoundsRing } from '../../cam3d/integration/parallel3dOperation'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { ToolpathMove } from '../../types'
import type {
  ImportedGeometry, FixedStockItem, SceneStock, PhysicalStock, Setup, Operation, Tool,
  HeightParams, PassParams, LinkingParams,
} from '../../types'
import type { BoreWorkerPayload, WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

// ── 3D: the store's parallel_3d path loads a mesh and calls the adapter. Both are stood
// in for ONLY in the store-wire test below (the adapter's own notice is proven real in the
// test before it); by default they pass straight through to the real modules.

const integration = vi.hoisted(() => ({
  acquirePartMesh: null as null | ((...args: unknown[]) => Promise<unknown>),
  computeParallel3dMoves: null as null | ((...args: unknown[]) => Promise<unknown>),
  loadCachedSTL: null as null | ((...args: unknown[]) => Promise<unknown>),
}))

vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()
  return typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
    ...actual,
    acquirePartMesh: ((...args: Parameters<typeof actual.acquirePartMesh>) =>
      integration.acquirePartMesh ? integration.acquirePartMesh(...args) : actual.acquirePartMesh(...args)
    ) as typeof actual.acquirePartMesh,
    computeParallel3dMoves: ((...args: Parameters<typeof actual.computeParallel3dMoves>) =>
      integration.computeParallel3dMoves ? integration.computeParallel3dMoves(...args) : actual.computeParallel3dMoves(...args)
    ) as typeof actual.computeParallel3dMoves,
  })
})

vi.mock('../../lib/stlCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stlCache')>()
  return typedMock<typeof import('../../lib/stlCache')>({
    ...actual,
    loadCachedSTL: ((...args: Parameters<typeof actual.loadCachedSTL>) =>
      integration.loadCachedSTL ? integration.loadCachedSTL(...args) : actual.loadCachedSTL(...args)
    ) as typeof actual.loadCachedSTL,
  })
})

// ── The worker wire: real toolpathWorker.ts, in-process ─────────────────────────────────

type WorkerSelf = {
  postMessage: (msg: WorkerResponseMsg) => void
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let deliver: ((msg: WorkerResponseMsg) => void) | null = null
const workerSelf: WorkerSelf = {
  postMessage: (msg) => { deliver?.(msg) },
  onmessage: null,
}
const dispatched: WorkerRequestMsg[] = []

class InProcessToolpathWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { /* the real module is already loaded */ }
  postMessage(request: WorkerRequestMsg): void {
    dispatched.push(request)
    deliver = (msg) => this.onmessage?.({ data: msg })
    void workerSelf.onmessage!({ data: request })
  }
  terminate(): void { /* no thread to stop */ }
}

// ── Scene ───────────────────────────────────────────────────────────────────────────────

type LoopData = NonNullable<ImportedGeometry['loops']>[number]

const heights: HeightParams = {
  clearanceHeight: 25, clearanceHeightMode: 'absolute',
  retractHeight: 17, feedHeight: 13,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -2, bottomHeightMode: 'absolute',
}

function circleLoop(id: string, diameter: number, cx: number, cy: number, n = 64): LoopData {
  const r = diameter / 2
  return {
    id, layerId: 'L1', closed: true, type: 'contour', area: Math.PI * r * r,
    points: Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
    }),
  } as LoopData
}

function rectLoop(id: string, x0: number, y0: number, x1: number, y1: number): LoopData {
  return {
    id, layerId: 'L1', closed: true, type: 'contour', area: (x1 - x0) * (y1 - y0),
    points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  } as LoopData
}

function geometry(loops: LoopData[]): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 60, z: 0 },
      size: { x: 60, y: 60, z: 0 }, center: { x: 30, y: 30, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, loops,
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as ImportedGeometry
}

function tool(diameter: number): Tool {
  return {
    id: 'tool-1', name: `${diameter} mm end mill`, type: 'flat_end_mill',
    diameter, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 } },
  } as unknown as Tool
}

function install(geo: ImportedGeometry, op: Operation, toolDiameter: number): void {
  const stock: FixedStockItem = {
    id: 'stock-1', name: 'Stock', width: 60, height: 60, depth: 12, position: { x: 0, y: 0, z: 0 },
  }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: 60, fixedHeight: 60, fixedDepth: 12, fixedStocks: [stock],
  }
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 60, z: 12 },
      size: { x: 60, y: 60, z: 12 }, center: { x: 30, y: 30, z: 6 },
    },
    position: { x: 0, y: 0, z: 0 },
  }
  const setup: Setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations: [op],
    notes: '',
  } as Setup
  useCamStore.setState(s => ({
    project: {
      ...s.project,
      geometry: [{ ...geo, stockId: stock.id }],
      setups: [setup],
      sceneStock,
      stocks: [physicalStock],
      activeSetupId: 'setup-1',
      activeOperationId: op.id,
    },
    toolLibrary: [tool(toolDiameter)],
    toolpathBatch: null,
    consoleEvents: [],
  }))
}

// Bore: a 12.00 mm hole with an 11.92 mm cutter leaves a 0.04 mm tool-centre orbit,
// below bore2d's 0.05 mm helix threshold.
function boreOp(entryType: LinkingParams['entryType']): Operation {
  const passes: PassParams = { stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  const linking: LinkingParams = {
    entryType, rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
    retractType: 'full', transitionType: 'safe_height',
  }
  const params = { geometryId: 'geo-1', loopIds: ['bore-1'], direction: 'climb', sortStrategy: 'none', targetDiameter: 12 }
  return {
    id: 'op-bore', name: 'Tight bore', type: 'bore', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking, params,
    smartHeight: smartHeightAuthorityFixture('bore', { setupId: 'setup-1', heights, params, geometryIds: ['geo-1'] }),
  } as unknown as Operation
}

function adaptiveOp(stepover: number): Operation {
  const passes: PassParams = { stepdown: 5, stepover, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  const linking: LinkingParams = {
    entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
    retractType: 'full', transitionType: 'safe_height',
  }
  const params = {
    geometryId: 'geo-1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.7,
    stepDistance: 0.4, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
  }
  return {
    id: 'op-ac', name: 'Pocket clear', type: 'adaptive_clearing_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking, params,
    smartHeight: smartHeightAuthorityFixture('adaptive_clearing_2d', {
      setupId: 'setup-1', heights, params, geometryIds: ['geo-1'],
    }),
  } as unknown as Operation
}

const toolpathLines = () => useCamStore.getState().consoleEvents.filter(e => e.source === 'toolpath')
const theOp = () => useCamStore.getState().project.setups[0].operations[0]

async function generate(opId: string): Promise<void> {
  await useCamStore.getState().computeOperationToolpath('setup-1', opId)
}

describe('WO-1540: generator notices reach the app console', () => {
  beforeAll(async () => {
    ;(globalThis as { self?: unknown }).self = workerSelf
    await import('../../lib/cam/toolpathWorker')
    expect(typeof workerSelf.onmessage).toBe('function')
  })
  afterAll(() => {
    delete (globalThis as { self?: unknown }).self
    vi.unstubAllGlobals()
  })
  beforeEach(() => {
    dispatched.length = 0
    vi.stubGlobal('Worker', InProcessToolpathWorker)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  it('a Bore with a helical entry on an orbit too small to helix: one warning naming the operation and the plunge; moves unchanged', async () => {
    install(geometry([circleLoop('bore-1', 12, 30, 30)]), boreOp('ramp_helical'), 11.92)

    await generate('op-bore')

    expect(theOp().status, theOp().errorMessage).toBe('ready')
    const lines = toolpathLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('warning')
    expect(lines[0].entityRef).toEqual({ kind: 'op', id: 'op-bore' })
    expect(lines[0].message).toContain('"Tight bore"')
    expect(lines[0].message).toMatch(/straight plunge/)

    // The moves are the builder's own, exactly as a builder that says nothing produces them.
    const request = dispatched.find(r => r.type === 'COMPUTE_BORE')!
    const silent = buildBoreToolpath(request.payload as BoreWorkerPayload)
    expect(theOp().toolpathMoves).toEqual(silent)
    expect(silent.some(m => m.role === 'helix')).toBe(false)
  })

  it('regenerating the unchanged Bore does not add a second identical line', async () => {
    install(geometry([circleLoop('bore-1', 12, 30, 30)]), boreOp('ramp_helical'), 11.92)

    await generate('op-bore')
    await generate('op-bore')

    expect(dispatched.filter(r => r.type === 'COMPUTE_BORE')).toHaveLength(2)
    expect(toolpathLines()).toHaveLength(1)
  })

  it('an operation with nothing to report writes no console line', async () => {
    install(geometry([circleLoop('bore-1', 12, 30, 30)]), boreOp('plunge'), 11.92)

    await generate('op-bore')

    expect(theOp().status, theOp().errorMessage).toBe('ready')
    expect(theOp().toolpathMoves?.length ?? 0).toBeGreaterThan(0)
    expect(toolpathLines()).toHaveLength(0)
  })

  it('adaptive clearing with an unusable stepover: one warning saying which stepover was used instead; regenerating adds nothing', async () => {
    install(geometry([rectLoop('pocket', 10, 10, 40, 30)]), adaptiveOp(0), 6)

    await generate('op-ac')

    expect(theOp().status, theOp().errorMessage).toBe('ready')
    const stepoverLines = toolpathLines().filter(e => /stepover/.test(e.message))
    expect(stepoverLines).toHaveLength(1)
    expect(stepoverLines[0].severity).toBe('warning')
    expect(stepoverLines[0].message).toContain('"Pocket clear"')
    // 40% of the 6 mm tool.
    expect(stepoverLines[0].message).toMatch(/2\.40 mm/)

    const before = toolpathLines().length
    await generate('op-ac')
    expect(toolpathLines()).toHaveLength(before)
  }, 60_000)
})

// ── 3D parallel finish: the stock-edge overrun notice ───────────────────────────────────

function inProcessCam3dClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest) },
    terminate(): void {},
  }
  const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent)
  })
  return new Cam3dClient(fakeWorker)
}

const WAVE_SIZE = 20
const WAVE_MESH: PartMesh = wave(WAVE_SIZE, 25)
const WAVE_HEIGHTS = { clearanceZ: 25, retractZ: 16, feedZ: 16, topZ: 15, bottomZ: 0, stockTopZ: 15 }
const FLAT6 = tool(6)

function parallelOp(): Operation {
  const opHeights: HeightParams = {
    clearanceHeight: 20, clearanceHeightMode: 'absolute', retractHeight: 10,
    feedHeight: 8, topHeight: 0, topHeightMode: 'stock_top',
    bottomHeight: -3, bottomHeightMode: 'absolute',
  }
  return {
    id: 'op-par', name: 'Wave finish', type: 'parallel_3d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: ['geo-3d'], heights: opHeights,
    passes: { stepdown: 2, stepover: 1.6, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
      leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params: {},
    smartHeight: smartHeightAuthorityFixture('parallel_3d', { geometryIds: ['geo-3d'] }),
  } as unknown as Operation
}

function install3d(op: Operation): void {
  const geo3d: ImportedGeometry = {
    id: 'geo-3d', name: 'Solid', filename: 'solid.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
      size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
  } as ImportedGeometry
  install(geo3d, op, 6)
}

describe('WO-1540: a 3D parallel finish whose stock-edge overrun was withheld says so', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The store constructs its cam3d client (a Worker) before calling the adapter; the
    // adapter stand-in below never talks to it, so a silent thread is enough.
    vi.stubGlobal('Worker', class {
      onmessage: unknown = null
      onerror: unknown = null
      postMessage(): void {}
      terminate(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    })
    integration.acquirePartMesh = null
    integration.computeParallel3dMoves = null
    integration.loadCachedSTL = null
  })
  afterAll(() => {
    integration.acquirePartMesh = null
    integration.computeParallel3dMoves = null
    integration.loadCachedSTL = null
  })

  it('the real adapter returns one overrun notice for an unconfirmed boundary, none once it is vouched as stock; the store writes it once across regenerations', async () => {
    const { computeParallel3dMoves } = await vi.importActual<typeof import('../../cam3d/integration/parallel3dOperation')>(
      '../../cam3d/integration/parallel3dOperation',
    )
    const params = { stepover: 2, angleDeg: 0, tolerance: 0.1, useStockBoundary: false }
    const boundary = [xyBoundsRing({ minX: 2, minY: 2, maxX: WAVE_SIZE - 2, maxY: WAVE_SIZE - 2 })]

    const unvouched = await computeParallel3dMoves({
      partMesh: WAVE_MESH, tool: FLAT6, params, resolvedHeights: WAVE_HEIGHTS,
      client: inProcessCam3dClient(), boundary,
    })
    expect(unvouched.notices).toHaveLength(1)
    expect(unvouched.notices![0]).toMatch(/stock-edge overrun was not applied/)

    const vouched = await computeParallel3dMoves({
      partMesh: WAVE_MESH, tool: FLAT6, params, resolvedHeights: WAVE_HEIGHTS,
      client: inProcessCam3dClient(), boundary, boundaryKind: 'stock',
    })
    expect(vouched.notices).toBeUndefined()

    // The store's real parallel_3d path, handed that adapter result.
    const terminalMove: ToolpathMove = { type: 'feed', x: 1, y: 1, z: -1, feed: 300, role: 'cut' }
    integration.loadCachedSTL = async () => new ArrayBuffer(8)
    integration.acquirePartMesh = async () => ({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]),
      indices: new Uint32Array([0, 1, 2]),
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      source: 'stl',
    } satisfies PartMesh)
    integration.computeParallel3dMoves = async () => ({
      moves: [terminalMove], computeTimeMs: 1, notices: unvouched.notices,
    })
    install3d(parallelOp())

    for (let run = 0; run < 2; run++) {
      await useCamStore.getState().computeOperationToolpath('setup-1', 'op-par')
      await vi.waitFor(() => expect(['ready', 'error']).toContain(theOp().status), { timeout: 10_000 })
      expect(theOp().status, theOp().errorMessage).toBe('ready')
    }

    const lines = toolpathLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('warning')
    expect(lines[0].entityRef).toEqual({ kind: 'op', id: 'op-par' })
    expect(lines[0].message).toContain('"Wave finish"')
    expect(lines[0].message).toMatch(/stock-edge overrun was not applied/)
  }, 120_000)
})
