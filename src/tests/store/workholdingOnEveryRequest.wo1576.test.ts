// WO-1576: every operation is told where the workholding is.
//
// Every case presses the store's OWN generate action (computeOperationToolpath)
// on a project with a vise jaw marked as workholding. The jaw is an imported STL
// (the usual vise), read from the STL cache by the store the way the app reads it;
// the cache is the only stand-in (node has no IndexedDB), and it serves real STL
// bytes that the production parser reads. The 2D worker is the REAL
// toolpathWorker.ts run in-process (node has no Worker thread). The 3D operations
// run their real adapters over a real in-process cam3d kernel. Expected places are
// computed HERE from plain box geometry, never from the trim module.
//
// SCENE: a 40 x 16 mm part outline (DXF) profiled from outside at Z 5 with a 6 mm
// flat end mill: its path runs along Y = 11. A 8 x 6 x 20 mm jaw stands on the
// table centred at X 0, Y 11, so the path passes straight through it. With the
// default 0.25 mm Shank clearance the cutter centre may come no closer than
// 3 + 0.25 = 3.25 mm to the jaw: the cut along Y 11 stops at X -7.25 and X 7.25.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const cache = vi.hoisted(() => ({ stl: new Map<string, ArrayBuffer>() }))
const cam3d = vi.hoisted(() => ({ client: undefined as unknown, partMesh: undefined as PartMesh | undefined }))

vi.mock('../../lib/stlCache', async (importOriginal) => typedMock<typeof import('../../lib/stlCache')>({
  ...await importOriginal<typeof import('../../lib/stlCache')>(),
  loadCachedSTL: vi.fn(async (id: string) => cache.stl.get(id) ?? null),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...await importOriginal<typeof import('../../lib/stepCache')>(),
  loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
  loadCachedStepDisplay: vi.fn(async () => null),
}))
vi.mock('../../cam3d/integration/appClient', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/appClient')>({
  ...await importOriginal<typeof import('../../cam3d/integration/appClient')>(),
  getCam3dClient: () => cam3d.client as Cam3dClient,
}))
vi.mock('../../cam3d/integration/parallel3dOperation', async (importOriginal) => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
  ...await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>(),
  acquirePartMesh: vi.fn(async () => cam3d.partMesh!),
}))

import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { outdateOperationsForWorkholding, resolveWorkholdingObstacles } from '../../store/fixtureObstacles'
import { smartHeightAuthorityFixture, stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolHolder, ToolpathMove, Vec3, WCS,
} from '../../types'

// ── Geometry ─────────────────────────────────────────────────────────────────

const CUT_Z = 5
const CUTTER_RADIUS = 3
const ALLOWANCE = 0.25
const JAW_SIZE = { x: 8, y: 6, z: 20 }
const JAW_AT = { x: 0, y: 11, z: 0 }

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** A binary STL of an axis-aligned box - deliberately NOT centred, so the display recentring is exercised. */
function boxStl(size: Vec3, corner: Vec3 = { x: 100, y: 50, z: 7 }): ArrayBuffer {
  const c = (i: number): Vec3 => ({
    x: corner.x + (i & 1 ? size.x : 0), y: corner.y + (i & 2 ? size.y : 0), z: corner.z + (i & 4 ? size.z : 0),
  })
  const tris = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]
  const count = tris.length / 3
  const buffer = new ArrayBuffer(84 + 50 * count)
  const view = new DataView(buffer)
  view.setUint32(80, count, true)
  for (let t = 0; t < count; t++) {
    const base = 84 + 50 * t
    for (let v = 0; v < 3; v++) {
      const p = c(tris[t * 3 + v])
      view.setFloat32(base + 12 + v * 12, p.x, true)
      view.setFloat32(base + 16 + v * 12, p.y, true)
      view.setFloat32(base + 20 + v * 12, p.z, true)
    }
  }
  return buffer
}

function jaw(position: Vec3 = JAW_AT, rotation: Vec3 = { x: 0, y: 0, z: 0 }): ImportedGeometry {
  return {
    id: 'vise-jaw', name: 'Vise jaw', filename: 'jaw.stl', type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: -JAW_SIZE.x / 2, y: -JAW_SIZE.y / 2, z: 0 }, { x: JAW_SIZE.x / 2, y: JAW_SIZE.y / 2, z: JAW_SIZE.z }),
    position: { ...position }, rotation: { ...rotation }, loaded: true, workholding: true,
  } as unknown as ImportedGeometry
}

function outline(rotationZ = 0): ImportedGeometry {
  return {
    id: 'part-outline', name: 'Part outline', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -20, y: -8, z: 0 }, { x: 20, y: 8, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: rotationZ }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: 'outline-loop', closed: true, type: 'contour', layerId: 'L1', area: 640,
      points: [{ x: -20, y: -8 }, { x: 20, y: -8 }, { x: 20, y: 8 }, { x: -20, y: 8 }],
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

/** Distance from (x, y) to the jaw's footprint, jaw placed at `at` turned `turnDeg` about Z. */
function xyDistanceToJaw(x: number, y: number, at: Vec3 = JAW_AT, turnDeg = 0): number {
  const r = (-turnDeg * Math.PI) / 180
  const dx = x - at.x, dy = y - at.y
  const lx = dx * Math.cos(r) - dy * Math.sin(r)
  const ly = dx * Math.sin(r) + dy * Math.cos(r)
  return Math.hypot(Math.max(Math.abs(lx) - JAW_SIZE.x / 2, 0), Math.max(Math.abs(ly) - JAW_SIZE.y / 2, 0))
}

// ── Tools, operation, project ────────────────────────────────────────────────

const HOLDER: ToolHolder = { id: 'holder-1', name: 'ER20', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] }

const MILL: Tool = {
  id: 'tool-1', name: '6 mm end mill', type: 'flat_end_mill',
  diameter: 6, fluteLength: 30, shankDiameter: 6, overallLength: 80,
  lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  holderId: 'holder-1', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function contourOp(): Operation {
  const heights: HeightParams = {
    clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
    topHeight: 10, topHeightMode: 'absolute', bottomHeight: CUT_Z, bottomHeightMode: 'absolute',
  }
  const params = { geometryId: 'part-outline', loopIds: [], side: 'outer', direction: 'climb', tabs: false }
  const passes: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
  return {
    id: 'op-1', name: 'Outline profile', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights, params, geometryIds: ['part-outline'] }),
  } as unknown as Operation
}

function install(geometry: ImportedGeometry[], ops: Operation[]): void {
  const stock = {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -40, y: -40, z: 0 }, { x: 40, y: 40, z: 10 }),
    position: { x: -40, y: -40, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -40, y: -40, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: ops, notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 80, fixedHeight: 80, fixedDepth: 10, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [MILL],
    holders: [HOLDER],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project, geometry, stocks: [stock], setups: [setup], sceneStock,
      activeSetupId: 'setup-1', activeOperationId: ops[0].id,
      modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    } as Project,
  }))
}

// ── The worker wire: real toolpathWorker.ts, in-process ─────────────────────

let workerRequests: WorkerRequestMsg[] = []
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }

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

beforeEach(() => {
  cache.stl.clear()
  cache.stl.set('vise-jaw', boxStl(JAW_SIZE))
  workerRequests = []
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      void workerSelf.onmessage!({ data })
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
})

// ── Reading the result ───────────────────────────────────────────────────────

const opById = (id: string) => useCamStore.getState().project.setups[0].operations.find((op) => op.id === id)!
const toolpathLines = () => useCamStore.getState().consoleEvents.filter((e) => e.source === 'toolpath').map((e) => e.message)

async function generate(opId = 'op-1'): Promise<void> {
  await useCamStore.getState().computeOperationToolpath('setup-1', opId)
  expect(opById(opId).status, opById(opId).errorMessage).toBe('ready')
}

interface Stop { x: number; y: number; z: number; line: string }

function workholdingStops(lines: readonly string[] = toolpathLines()): Stop[] {
  return lines.flatMap((line) => {
    if (!/of the workholding/.test(line)) return []
    // WO-1683: a stop through the store's generate action now names its frame
    // ("cut stopped at G54 X.. Y.. Z.."); the frame word is optional here.
    const at = /cut stopped at (?:\S+ )?X (-?[\d.]+) Y (-?[\d.]+) Z (-?[\d.]+)/.exec(line)
    return at ? [{ x: Number(at[1]), y: Number(at[2]), z: Number(at[3]), line }] : []
  })
}

/** Every position along the cutting moves at or below the jaw top, 0.1 mm apart. */
function cuttingSamples(moves: readonly ToolpathMove[], belowZ = JAW_SIZE.z): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type === 'rapid') continue
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.1))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
      if (p.z < belowZ) out.push(p)
    }
  }
  return out
}

// ── 2D: the toolpath worker ──────────────────────────────────────────────────

describe('WO-1576: a 2D operation is told where the workholding is', () => {
  it('the contour through the jaw: stops before it, no cutting move within the clearance, a console line naming workholding', async () => {
    install([outline(), jaw()], [contourOp()])
    await generate()

    const request = workerRequests.find((r) => r.type === 'COMPUTE_CONTOUR')!
    const sent = (request.payload as { workholding?: { positions: ArrayLike<number> }[] }).workholding
    expect(sent?.length).toBe(1)

    const moves = opById('op-1').toolpathMoves ?? []
    const samples = cuttingSamples(moves)
    expect(samples.length).toBeGreaterThan(0)
    for (const p of samples) {
      expect(xyDistanceToJaw(p.x, p.y)).toBeGreaterThanOrEqual(CUTTER_RADIUS + ALLOWANCE - 0.02)
    }

    const stops = workholdingStops()
    expect(stops.length, toolpathLines().join('\n')).toBeGreaterThan(0)
    for (const stop of stops) {
      expect(stop.line).toContain('"Outline profile"')
      expect(Math.abs(stop.y - JAW_AT.y)).toBeLessThan(0.01)
      expect(Math.abs(Math.abs(stop.x) - (JAW_SIZE.x / 2 + CUTTER_RADIUS + ALLOWANCE))).toBeLessThan(0.15)
    }
    // The cut goes on beyond the jaw on both sides.
    expect(samples.some((p) => Math.abs(p.y - 11) < 0.01 && p.x < -8)).toBe(true)
    expect(samples.some((p) => Math.abs(p.y - 11) < 0.01 && p.x > 8)).toBe(true)
  })

  it('moving the vise 10 mm outdates the operation, and regenerating moves the stops by 10 mm', async () => {
    install([outline(), jaw()], [contourOp()])
    await generate()
    const home = workholdingStops().map(({ x, y, z }) => ({ x, y, z }))
    expect(home.length).toBeGreaterThan(0)

    useCamStore.getState().updateGeometryTransform('vise-jaw', { x: JAW_AT.x + 10, y: JAW_AT.y, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(opById('op-1').status).toBe('outdated')

    useCamStore.setState({ consoleEvents: [] })
    await generate()
    const moved = workholdingStops().map(({ x, y, z }) => ({ x, y, z }))
    expect(moved.map((s) => ({ ...s, x: Number((s.x - 10).toFixed(2)) })).sort((a, b) => a.x - b.x))
      .toEqual(home.map((s) => ({ ...s, x: Number(s.x.toFixed(2)) })).sort((a, b) => a.x - b.x))
  })

  it('part and vise turned 90 deg together: the stops stay at the same place on the jaw', async () => {
    install([outline(), jaw()], [contourOp()])
    await generate()
    const home = workholdingStops()

    // Turn the whole setup 90 deg about Z: the outline row turns, and the jaw is
    // carried round to (-11, 0) and turned with it.
    install([outline(90), jaw({ x: -JAW_AT.y, y: JAW_AT.x, z: 0 }, { x: 0, y: 0, z: 90 })], [contourOp()])
    await generate()
    const turned = workholdingStops()

    expect(home.length).toBeGreaterThan(0)
    expect(turned.length).toBe(home.length)
    // Taken back through the turn, each stop is where the unturned one was.
    const back = turned.map((s) => ({ x: Number(s.y.toFixed(1)), y: Number((-s.x).toFixed(1)), z: s.z }))
    const want = home.map((s) => ({ x: Number(s.x.toFixed(1)), y: Number(s.y.toFixed(1)), z: s.z }))
    const key = (p: { x: number; y: number }) => p.x * 1000 + p.y
    expect(back.sort((a, b) => key(a) - key(b))).toEqual(want.sort((a, b) => key(a) - key(b)))
    const samples = cuttingSamples(opById('op-1').toolpathMoves ?? [])
    for (const p of samples) {
      expect(xyDistanceToJaw(p.x, p.y, { x: -JAW_AT.y, y: JAW_AT.x, z: 0 }, 90)).toBeGreaterThanOrEqual(CUTTER_RADIUS + ALLOWANCE - 0.02)
    }
  })

  it('unmarking the vise outdates the operation and the next program runs through where it stood', async () => {
    install([outline(), jaw()], [contourOp()])
    await generate()
    useCamStore.getState().setGeometryWorkholding('vise-jaw', false)
    expect(opById('op-1').status).toBe('outdated')
    useCamStore.setState({ consoleEvents: [] })
    await generate()
    const request = workerRequests.filter((r) => r.type === 'COMPUTE_CONTOUR').at(-1)!
    expect((request.payload as { workholding?: unknown }).workholding).toBeUndefined()
    expect(workholdingStops()).toEqual([])
  })

  it('a vise whose shape is not in the cache is kept clear of as its bounding box, and the console says so', async () => {
    cache.stl.clear()
    install([outline(), jaw()], [contourOp()])
    await generate()
    expect(toolpathLines().join('\n')).toMatch(/the shape of the workholding "Vise jaw" could not be read, so the tool was kept clear of its bounding box/)
    expect(workholdingStops().length).toBeGreaterThan(0)
  })
})

describe('WO-1576: the workholding the store builds', () => {
  it('an STL jaw lands where the viewport draws it: recentred, then posed by its row', async () => {
    const { meshes, notices } = await resolveWorkholdingObstacles(
      [outline(), jaw({ x: 5, y: 6, z: 2 }, { x: 0, y: 0, z: 90 })], [],
    )
    expect(notices).toEqual([])
    expect(meshes.length).toBe(1)
    const xs: number[] = [], ys: number[] = [], zs: number[] = []
    for (let i = 0; i < meshes[0].positions.length; i += 3) {
      xs.push(meshes[0].positions[i]); ys.push(meshes[0].positions[i + 1]); zs.push(meshes[0].positions[i + 2])
    }
    // 8 x 6 turned 90 deg is 6 wide in X and 8 in Y, centred on the row position, bottom on its Z.
    expect(Math.min(...xs)).toBeCloseTo(2, 4); expect(Math.max(...xs)).toBeCloseTo(8, 4)
    expect(Math.min(...ys)).toBeCloseTo(2, 4); expect(Math.max(...ys)).toBeCloseTo(10, 4)
    expect(Math.min(...zs)).toBeCloseTo(2, 4); expect(Math.max(...zs)).toBeCloseTo(22, 4)
  })

  it('an operation that cuts the workholding row itself is not stopped by it', async () => {
    const { meshes } = await resolveWorkholdingObstacles([jaw()], [], ['vise-jaw'])
    expect(meshes).toEqual([])
  })

  it('outdating leaves operations that are not generated alone', () => {
    const setups = [{ operations: [{ id: 'a', status: 'pending' }, { id: 'b', status: 'error' }] }] as unknown as Setup[]
    expect(outdateOperationsForWorkholding(setups)).toBe(setups)
  })
})

// ── 3D: the cam3d operations ─────────────────────────────────────────────────

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest) },
    terminate(): void { /* in-process */ },
  }
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent)
  })
  return new Cam3dClient(fakeWorker)
}

void stampSmartHeightAuthority

// SCENE 3D: a 30 x 20 x 5 mm block (pocket 16 x 10, 2 deep) under a 6 mm stock
// skin, with a toe-clamp bar 6 mm wide and 4 mm thick lying across it at X 15,
// its underside at Z 8 - above the cut, so only the tool body above the flutes'
// tip meets it. Every cutting position must stay 3 + 0.25 mm off the bar's
// footprint (the 6 mm cutter reaches up past Z 12), so the cut stops at X 8.75
// and X 21.25 and picks up beyond.
const PART_ID = 'block'
const STOCK_ID = 'stock-block'
const CLAMP_SIZE = { x: 6, y: 40, z: 4 }
const CLAMP_AT = { x: 15, y: 10, z: 8 }

function clampBar(): ImportedGeometry {
  return {
    id: 'toe-clamp', name: 'Toe clamp', filename: 'clamp.stl', type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: -3, y: -20, z: 0 }, { x: 3, y: 20, z: 4 }),
    position: { ...CLAMP_AT }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, workholding: true,
  } as unknown as ImportedGeometry
}

function clampGap(x: number, y: number): number {
  return Math.hypot(
    Math.max(Math.abs(x - CLAMP_AT.x) - CLAMP_SIZE.x / 2, 0),
    Math.max(Math.abs(y - CLAMP_AT.y) - CLAMP_SIZE.y / 2, 0),
  )
}

function operation3d(id: string, type: Operation['type'], params: Record<string, unknown>): Operation {
  return stampSmartHeightAuthority({
    id, name: `${type} over the clamp`, type, enabled: true, status: 'pending', toolId: MILL.id,
    geometrySelections: [PART_ID],
    heights: {
      clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
      topHeight: 0, topHeightMode: 'model_top', bottomHeight: 0, bottomHeightMode: 'model_bottom',
    },
    passes: { stepdown: 3, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: LINKING,
    params,
  } as unknown as Operation, { setupId: 'setup-1', geometryIds: [PART_ID], stockId: STOCK_ID }) as Operation
}

async function install3d(ops: Operation[]): Promise<void> {
  const { pocketBox } = await import('../../cam3d/fixtures')
  cam3d.partMesh = pocketBox({ x: 30, y: 20, z: 5 }, { x: 16, y: 10, depth: 2 })
  cache.stl.set('toe-clamp', boxStl(CLAMP_SIZE))
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() })
  const part = {
    id: PART_ID, name: 'Block', filename: 'block.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 30, y: 20, z: 5 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId: STOCK_ID,
  } as unknown as ImportedGeometry
  const fixedStock = { id: STOCK_ID, name: 'Block stock', width: 30, height: 20, depth: 6, position: { x: 0, y: 0, z: 0 } }
  const stock = {
    id: STOCK_ID, name: 'Block stock', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 30, y: 20, z: 6 }), position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: ops, notes: '',
  } as unknown as Setup
  useCamStore.setState((s) => ({
    toolLibrary: [MILL], holders: [HOLDER], toolpathBatch: null, consoleEvents: [],
    project: {
      ...s.project, geometry: [part, clampBar()], stocks: [stock], setups: [setup],
      sceneStock: {
        mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 30, fixedHeight: 20, fixedDepth: 6,
        fixedStocks: [fixedStock],
      } as unknown as SceneStock,
      toolLibrary: [MILL], activeSetupId: 'setup-1',
    } as Project,
  }))
}

describe('WO-1576: the 3D operations are told where the workholding is', () => {
  let client: Cam3dClient
  beforeEach(() => {
    client = makeClient()
    cam3d.client = client
  })
  afterEach(async () => {
    await client.dispose()
  })

  const cases: [Operation['type'], Record<string, unknown>][] = [
    ['parallel_3d', { stepover: 1.5, angleDeg: 0, tolerance: 0.1, surfaceStockToLeave: 0, useStockBoundary: false }],
    ['adaptive_3d', { maxStepdown: 3, stepover: 0.4, tolerance: 0.2, helixDiameter: 3, cellSize: 0 }],
    ['steep_shallow_3d', { stepover: 1.5, angleDeg: 0, tolerance: 0.1, stockToLeave: 0, useStockBoundary: false }],
  ]

  for (const [type, params] of cases) {
    it(`${type}: a program trimmed at the clamp and a console line naming workholding`, { timeout: 120_000 }, async () => {
      await install3d([operation3d('op-3d', type, params)])
      await useCamStore.getState().computeOperationToolpath('setup-1', 'op-3d')
      const op = opById('op-3d')
      expect(op.status, op.errorMessage).toBe('ready')

      // A tool tip above the clamp top clears it; below, the tool body reaches it.
      const samples = cuttingSamples(op.toolpathMoves ?? [], CLAMP_AT.z + CLAMP_SIZE.z)
      expect(samples.length).toBeGreaterThan(0)
      const near = samples.filter((p) => clampGap(p.x, p.y) < CUTTER_RADIUS + ALLOWANCE - 0.05)
      expect(near.slice(0, 5), 'cutting positions within the clearance of the clamp').toEqual([])
      // The cut goes on beyond the clamp on both sides.
      expect(samples.some((p) => p.x < CLAMP_AT.x - 7)).toBe(true)
      expect(samples.some((p) => p.x > CLAMP_AT.x + 7)).toBe(true)

      const stops = workholdingStops()
      expect(stops.length, toolpathLines().join('\n')).toBeGreaterThan(0)
      for (const stop of stops) expect(stop.line).toContain(`"${type} over the clamp"`)
    })
  }
})
