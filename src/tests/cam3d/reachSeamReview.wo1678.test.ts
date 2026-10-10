// WO-1678 REVIEW (opus, safety path) - reproduce the one tool-reach seam per
// strategy through the store's own generate action, never a hand-built payload.
//
// Scene (same as the order's own test, re-derived here): a 16 x 16 mm cavity
// 25 mm deep in a 40 x 40 x 30 mm block; the stock is the block. A 6 mm cutter
// sticks out 15 mm below a 20 mm holder, so over the block the tip may go no
// lower than Z 30 - 15 + 0.25 = 15.25 (the holder is wider than the cavity, so
// it always overhangs solid). A 40 mm stickout reaches the floor.
//
// What this file adds over the order's tests:
//  1. EVERY move is checked - rapids, plunges, ramps, helixes, links, retracts -
//     not only the fed cutting moves inside the cavity, and against a holder
//     disc computed here from the tool and the block.
//  2. Adaptive 3D through the store (the order's store test covers the finishes only).
//  3. Ramp and helix entries.
//  4. Workholding (a toe clamp over the cavity) for the finishes whose store
//     trim was deleted (waterline, scallop, pencil).
//  5. Generate All gives the same program as generating each operation alone.
//  6. A rest rough after a trimmed rough.
//
// Coordinates: G54 = world (WCS origin 0,0,0); Z up; the block top is Z 30.

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
import { cancelAllSerializedCam3dComputes } from '../../store/toolpathBatchScheduler'
import { smartHeightAuthorityFixture, stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { pocketBox } from '../../cam3d/fixtures'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types'
import type { WaterlineSlicer } from '../../cam3d/kernel/oclWaterline'
import type { Ring } from '../../cam3d/geom2d'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, ImportedGeometry, LinkingParams, Operation, PhysicalStock, Project, SceneStock, Setup,
  Tool, ToolHolder, ToolpathMove, Vec3, WCS,
} from '../../types'

// ── The block, the cavity, the tools ─────────────────────────────────────────

const OUTER = { x: 40, y: 40, z: 30 }
const CAVITY = { x: 16, y: 16, depth: 25 }
const TOP_Z = OUTER.z
const FLOOR_Z = OUTER.z - CAVITY.depth
const ALLOWANCE = 0.25
const SHORT = 15
const LONG = 40
const HOLDER_RADIUS = 10
/** Lowest tip the holder allows while it overhangs the block: from the tool and the block alone. */
const REACH_FLOOR_Z = TOP_Z - SHORT + ALLOWANCE
/** The trim bisects its stops; a stop may land this far past the exact boundary. */
const STOP_TOL = 0.05

const C0 = { x: (OUTER.x - CAVITY.x) / 2, y: (OUTER.y - CAVITY.y) / 2 }
const C1 = { x: C0.x + CAVITY.x, y: C0.y + CAVITY.y }

const HOLDER: ToolHolder = { id: 'holder-1', name: 'ER20', segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }] }

function mill(id: string, stickout: number, type: 'ball_end_mill' | 'flat_end_mill' = 'ball_end_mill'): Tool {
  return {
    id, name: `6 mm ${type} ${stickout} out`, type,
    diameter: 6, fluteLength: 40, shankDiameter: 6, overallLength: 80,
    lengthBelowHolder: stickout, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 5, stepover: 2 } },
  } as unknown as Tool
}

const PLUNGE: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const RAMP: LinkingParams = { ...PLUNGE, entryType: 'ramp_linear', rampAngle: 5, rampLength: 6 }
const HELIX: LinkingParams = { ...PLUNGE, entryType: 'ramp_helical', rampAngle: 5, rampLength: 0 }

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const PART_ID = 'block'
const STOCK_ID = 'stock-block'

function part(): ImportedGeometry {
  return {
    id: PART_ID, name: 'Block', filename: 'block.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: OUTER.x, y: OUTER.y, z: OUTER.z }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId: STOCK_ID,
  } as unknown as ImportedGeometry
}

// A toe clamp over the right of the cavity: X 25..29, across the whole block in Y,
// underside Z 34 (4 mm above the part top), top Z 38.
const CLAMP = { minX: 25, maxX: 29, minY: -5, maxY: 45, minZ: 34, maxZ: 38 }

function clamp(): ImportedGeometry {
  const sx = CLAMP.maxX - CLAMP.minX, sy = CLAMP.maxY - CLAMP.minY, sz = CLAMP.maxZ - CLAMP.minZ
  return {
    id: 'toe-clamp', name: 'Toe clamp', filename: 'clamp.stl', type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: -sx / 2, y: -sy / 2, z: 0 }, { x: sx / 2, y: sy / 2, z: sz }),
    position: { x: (CLAMP.minX + CLAMP.maxX) / 2, y: (CLAMP.minY + CLAMP.maxY) / 2, z: CLAMP.minZ },
    rotation: { x: 0, y: 0, z: 0 }, loaded: true, workholding: true,
  } as unknown as ImportedGeometry
}

function boxStl(size: Vec3): ArrayBuffer {
  const c = (i: number): Vec3 => ({ x: i & 1 ? size.x : 0, y: i & 2 ? size.y : 0, z: i & 4 ? size.z : 0 })
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

const OUTLINE_ID = 'cavity-outline'

function cavityOutline(): ImportedGeometry {
  return {
    id: OUTLINE_ID, name: 'Cavity outline', filename: 'cavity.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: C0.x, y: C0.y, z: 0 }, { x: C1.x, y: C1.y, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, stockId: STOCK_ID,
    loops: [{
      id: 'cavity-loop', closed: true, type: 'contour', layerId: 'L1', area: CAVITY.x * CAVITY.y,
      points: [{ x: C0.x, y: C0.y }, { x: C1.x, y: C0.y }, { x: C1.x, y: C1.y }, { x: C0.x, y: C1.y }],
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

/** A 2D pocket of the cavity to its floor with the given tool: the earlier operation a finish follows. */
function pocketOp(toolId: string): Operation {
  const heights = {
    clearanceHeight: 50, clearanceHeightMode: 'absolute', retractHeight: 40, feedHeight: 32,
    topHeight: TOP_Z, topHeightMode: 'absolute', bottomHeight: FLOOR_Z, bottomHeightMode: 'absolute',
  }
  const params = {
    geometryId: OUTLINE_ID, loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
    fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
    helixDiameter: 0, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
  }
  return {
    id: 'pocket', name: 'Cavity pocket', type: 'pocket_2d', enabled: true, status: 'pending', toolId,
    geometrySelections: [OUTLINE_ID], heights,
    passes: { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: PLUNGE, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', {
      setupId: 'setup-1', heights: heights as never, params, geometryIds: [OUTLINE_ID], stockId: STOCK_ID,
      explicitDepthMm: -FLOOR_Z,
    }),
  } as unknown as Operation
}

function op3d(id: string, type: Operation['type'], params: Record<string, unknown>, toolId = 'tool-short', linking = PLUNGE): Operation {
  return stampSmartHeightAuthority({
    id, name: `${type} ${id}`, type, enabled: true, status: 'pending', toolId,
    geometrySelections: [PART_ID],
    heights: {
      clearanceHeight: 50, clearanceHeightMode: 'absolute', retractHeight: 40, feedHeight: 32,
      topHeight: 0, topHeightMode: 'model_top', bottomHeight: 0, bottomHeightMode: 'model_bottom',
    },
    passes: { stepdown: 3, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking,
    params,
  } as unknown as Operation, { setupId: 'setup-1', geometryIds: [PART_ID], stockId: STOCK_ID }) as Operation
}

const TOOLS = [
  mill('tool-short', SHORT), mill('tool-long', LONG),
  mill('flat-short', SHORT, 'flat_end_mill'), mill('flat-long', LONG, 'flat_end_mill'),
]

function install(ops: Operation[], options: { clamp?: boolean } = {}): void {
  cam3d.partMesh = pocketBox(OUTER, CAVITY)
  cache.stl.clear()
  cache.stl.set('toe-clamp', boxStl({ x: CLAMP.maxX - CLAMP.minX, y: CLAMP.maxY - CLAMP.minY, z: CLAMP.maxZ - CLAMP.minZ }))
  const fixedStock = { id: STOCK_ID, name: 'Block stock', width: OUTER.x, height: OUTER.y, depth: OUTER.z, position: { x: 0, y: 0, z: 0 } }
  const stock = {
    id: STOCK_ID, name: 'Block stock', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: OUTER.x, y: OUTER.y, z: OUTER.z }), position: { x: 0, y: 0, z: 0 },
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
    toolLibrary: [...TOOLS], holders: [HOLDER], toolpathBatch: null, consoleEvents: [],
    project: {
      ...s.project, geometry: options.clamp ? [part(), cavityOutline(), clamp()] : [part(), cavityOutline()], stocks: [stock], setups: [setup],
      sceneStock: {
        mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: OUTER.x, fixedHeight: OUTER.y,
        fixedDepth: OUTER.z, fixedStocks: [fixedStock],
      } as unknown as SceneStock,
      toolLibrary: [...TOOLS], activeSetupId: 'setup-1', activeOperationId: ops[0].id,
      modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    } as Project,
  }))
}

// ── The wires: the real 2D worker and a real cam3d kernel, in-process ───────

const cavitySlicer: WaterlineSlicer = {
  name: 'fake-cavity',
  async slice(_mesh: PartMesh, cutter: CutterSpec, z: number): Promise<Ring[]> {
    if (z > TOP_Z || z < FLOOR_Z) return []
    const r = cutter.diameter / 2
    return [new Float64Array([C0.x + r, C0.y + r, C1.x - r, C0.y + r, C1.x - r, C1.y - r, C0.x + r, C1.y - r])]
  },
}

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
  }, { slicer: cavitySlicer })
  return new Cam3dClient(fakeWorker)
}

let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let client: Cam3dClient

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
  cancelAllSerializedCam3dComputes()
  activeShim = null
  client = makeClient()
  cam3d.client = client
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { /* no thread */ }
  })
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(async () => {
  cancelAllSerializedCam3dComputes()
  await client.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── Reading the result ───────────────────────────────────────────────────────

const opById = (id: string) => useCamStore.getState().project.setups[0].operations.find((op) => op.id === id)!
const linesFor = (id: string) => useCamStore.getState().consoleEvents
  .filter((e) => e.source === 'toolpath' && e.entityRef?.kind === 'op' && e.entityRef.id === id)
  .map((e) => e.message)

async function generate(id: string): Promise<Operation> {
  await useCamStore.getState().computeOperationToolpath('setup-1', id)
  const op = opById(id)
  expect(op.status, op.errorMessage).toBe('ready')
  return op
}

interface Sample { x: number; y: number; z: number; type: string; role: string | undefined; index: number }

/** Every tip position along EVERY move - rapid, plunge, ramp, helix, link, retract - 0.1 mm apart. */
function allSamples(moves: readonly ToolpathMove[]): Sample[] {
  const out: Sample[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.1))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push({
        x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
        type: b.type, role: b.role, index: i,
      })
    }
  }
  return out
}

/** XY distance from a point to a rectangle (0 inside). */
function rectDistance(x: number, y: number, r: { minX: number; maxX: number; minY: number; maxY: number }): number {
  return Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minY - y, 0, y - r.maxY))
}

const BLOCK = { minX: 0, maxX: OUTER.x, minY: 0, maxY: OUTER.y }

/** Smallest gap between a 6 mm ball end mill (tip at p, body up to tip + 40) and the clamp box. */
function ballToolGapToClamp(p: { x: number; y: number; z: number }): number {
  const dxy = rectDistance(p.x, p.y, CLAMP)
  const centreZ = p.z + 3
  const dzBall = Math.max(CLAMP.minZ - centreZ, 0, centreZ - CLAMP.maxZ)
  const ball = Math.hypot(dxy, dzBall) - 3
  const dzBody = Math.max(CLAMP.minZ - (p.z + LONG), 0, centreZ - CLAMP.maxZ)
  const body = Math.hypot(dxy, dzBody) - 3
  return Math.min(ball, body)
}

/**
 * Tip positions (any move) where the 20 mm holder, 15 mm up, would come within
 * the allowance of the block: the holder disc overhangs solid (it is wider than
 * the cavity) and its bottom is below the block top + allowance.
 */
function holderViolations(moves: readonly ToolpathMove[], stickout = SHORT): Sample[] {
  return allSamples(moves).filter((p) =>
    rectDistance(p.x, p.y, BLOCK) < HOLDER_RADIUS + ALLOWANCE &&
    p.z + stickout < TOP_Z + ALLOWANCE - STOP_TOL)
}

/** Deepest tip inside the cavity footprint, over every move. */
function deepestInCavity(moves: readonly ToolpathMove[], feedOnly = true): number | undefined {
  const zs = allSamples(moves)
    .filter((p) => (!feedOnly || p.type !== 'rapid') && p.x > C0.x && p.x < C1.x && p.y > C0.y && p.y < C1.y)
    .map((p) => p.z)
  return zs.length > 0 ? Math.min(...zs) : undefined
}

const stopLines = (lines: readonly string[]) => lines.filter((line) => /cut stopped at|could not be started/.test(line))

function show(samples: readonly Sample[]): string {
  return samples.slice(0, 5).map((p) =>
    `move ${p.index} ${p.type}/${p.role ?? '-'} at X ${p.x.toFixed(2)} Y ${p.y.toFixed(2)} Z ${p.z.toFixed(2)}`).join('\n')
}

// ── The strategies ───────────────────────────────────────────────────────────

type Case = [label: string, type: Operation['type'], params: Record<string, unknown>, short: string, long: string]

const STRATEGIES: Case[] = [
  ['parallel_3d', 'parallel_3d', { stepover: 2, angleDeg: 0, tolerance: 0.1, surfaceStockToLeave: 0, useStockBoundary: false }, 'tool-short', 'tool-long'],
  ['waterline_3d', 'waterline_3d', { stepdown: 2, tolerance: 0.1, stockToLeave: 0, useStockBoundary: false }, 'tool-short', 'tool-long'],
  ['scallop_3d', 'scallop_3d', { scallopHeight: 0.5, tolerance: 0.1, stockToLeave: 0, useStockBoundary: false }, 'tool-short', 'tool-long'],
  ['pencil_3d', 'pencil_3d', { tolerance: 0.1, stockToLeave: 0, useStockBoundary: false }, 'tool-short', 'tool-long'],
  ['steep_shallow_3d', 'steep_shallow_3d', { stepover: 2, angleDeg: 0, tolerance: 0.1, stockToLeave: 0, useStockBoundary: false }, 'tool-short', 'tool-long'],
  ['adaptive_3d', 'adaptive_3d', { maxStepdown: 3, stepover: 0.4, tolerance: 0.2, helixDiameter: 3, cellSize: 0.5 }, 'flat-short', 'flat-long'],
]

const report: string[] = []

describe('WO-1678 review: a holder that would meet the block below the reach floor', () => {
  for (const [label, type, params, short] of STRATEGIES) {
    it(`${label}: no move of any kind puts the holder below the reach floor; the cut is trimmed there and said`, { timeout: 180_000 }, async () => {
      install([op3d('op', type, params, short)])
      const op = await generate('op')
      const moves = op.toolpathMoves ?? []
      const bad = holderViolations(moves)
      const deepest = deepestInCavity(moves)
      const stops = stopLines(linesFor('op'))
      report.push(`${label} short: ${moves.length} moves, deepest fed cut in cavity Z ${deepest?.toFixed(2) ?? 'none'}, ${stops.length} stop line(s), ${bad.length} holder violation(s)`)
      expect(bad.length, show(bad)).toBe(0)
      expect(stops.length, linesFor('op').join('\n')).toBeGreaterThan(0)
      if (deepest !== undefined) expect(Math.abs(deepest - REACH_FLOOR_Z), `${label} deepest`).toBeLessThan(1)
    })
  }
})

describe('WO-1678 review: the same job with a tool that reaches is left alone', () => {
  for (const [label, type, params, , long] of STRATEGIES) {
    it(`${label}: nothing is trimmed and the cavity is cut below the short tool's floor`, { timeout: 180_000 }, async () => {
      install([op3d('op', type, params, long)])
      const op = await generate('op')
      const moves = op.toolpathMoves ?? []
      const deepest = deepestInCavity(moves)
      report.push(`${label} long: ${moves.length} moves, deepest fed cut in cavity Z ${deepest?.toFixed(2) ?? 'none'}`)
      expect(stopLines(linesFor('op')), linesFor('op').join('\n')).toEqual([])
      expect(deepest).toBeDefined()
      expect(deepest!).toBeLessThan(REACH_FLOOR_Z - 5)
      expect(holderViolations(moves, LONG)).toEqual([])
    })
  }
})

describe('WO-1678 review: ramp and helix entries pass through the seam too', () => {
  const entries: [string, LinkingParams][] = [['ramp', RAMP], ['helix', HELIX]]
  const which = STRATEGIES.filter(([label]) => ['parallel_3d', 'waterline_3d', 'adaptive_3d'].includes(label))
  for (const [entryName, linking] of entries) {
    for (const [label, type, params, short] of which) {
      it(`${label} with a ${entryName} entry: no entry, link or retract below the reach floor`, { timeout: 180_000 }, async () => {
        install([op3d('op', type, params, short, linking)])
        const op = await generate('op')
        const moves = op.toolpathMoves ?? []
        const bad = holderViolations(moves)
        report.push(`${label} ${entryName}: ${moves.length} moves, ${bad.length} holder violation(s)`)
        expect(bad.length, show(bad)).toBe(0)
      })
    }
  }
})

describe('WO-1678 review: workholding still stops the finishes whose store trim was deleted', () => {
  const which = STRATEGIES.filter(([label]) => ['parallel_3d', 'waterline_3d', 'scallop_3d', 'pencil_3d', 'steep_shallow_3d'].includes(label))
  for (const [label, type, params, , long] of which) {
    it(`${label}: no tool body within the clearance of the clamp, the rest still cut, and said`, { timeout: 180_000 }, async () => {
      install([op3d('op', type, params, long)], { clamp: true })
      const op = await generate('op')
      const moves = op.toolpathMoves ?? []
      // The 6 mm ball: a sphere of radius 3 centred 3 above the tip, then a 6 mm
      // body straight up to the holder at tip + 40 (above the clamp). Every part of it
      // keeps the allowance from the clamp box - exact 3D gaps, computed here.
      const bad = allSamples(moves).filter((p) => ballToolGapToClamp(p) < ALLOWANCE - STOP_TOL)
      const lines = linesFor('op')
      const fixtureStops = lines.filter((line) => /of the workholding/.test(line) && /cut stopped at|could not be started/.test(line))
      report.push(`${label} clamp: ${moves.length} moves, ${fixtureStops.length} workholding stop(s), ${bad.length} clamp violation(s)`)
      const around = bad.length > 0
        ? moves.slice(Math.max(0, bad[0].index - 4), bad[0].index + 3)
          .map((m, k) => `  [${Math.max(0, bad[0].index - 4) + k}] ${m.type}/${m.role ?? '-'} X ${m.x.toFixed(3)} Y ${m.y.toFixed(3)} Z ${m.z.toFixed(3)}`).join('\n')
        : ''
      expect(bad.length, `${show(bad)}\n${around}\n${lines.join('\n')}`).toBe(0)
      expect(fixtureStops.length, lines.join('\n')).toBeGreaterThan(0)
      // The cavity left of the clamp is still cut.
      expect(allSamples(moves).some((p) => p.type !== 'rapid' && p.z < TOP_Z - 1 && p.x < CLAMP.minX - 4)).toBe(true)
    })
  }
})

describe('WO-1678 review: a finish after an earlier operation (links lowered over removed stock after the seam)', () => {
  const which = STRATEGIES.filter(([label]) => ['parallel_3d', 'waterline_3d', 'scallop_3d', 'pencil_3d'].includes(label))
  for (const [label, type, params, short] of which) {
    it(`${label} after a long-reach pocket: no lowered link, entry or retract puts the short tool's holder below the reach floor`, { timeout: 180_000 }, async () => {
      install([pocketOp('tool-long'), op3d('op', type, params, short)])
      await generate('pocket')
      const op = await generate('op')
      const moves = op.toolpathMoves ?? []
      const bad = holderViolations(moves)
      const lowRapids = allSamples(moves).filter((p) => p.type === 'rapid' && p.z < 32 - 0.01).length
      report.push(`${label} after pocket: ${moves.length} moves, ${stopLines(linesFor('op')).length} stop line(s), ${lowRapids} low rapid sample(s), ${bad.length} holder violation(s)`)
      expect(bad.length, show(bad)).toBe(0)
    })
  }
})

describe('WO-1678 review: Generate All gives the same trimmed program as generating alone', () => {
  for (const [label, type, params, short] of STRATEGIES) {
    it(`${label}: identical moves and stop lines`, { timeout: 240_000 }, async () => {
      install([op3d('op', type, params, short)])
      const single = await generate('op')
      const singleMoves = single.toolpathMoves
      const singleStops = stopLines(linesFor('op'))

      install([op3d('op', type, params, short)])
      await useCamStore.getState().computeAllToolpaths()
      const batch = opById('op')
      expect(batch.status, batch.errorMessage).toBe('ready')
      expect(batch.toolpathMoves).toEqual(singleMoves)
      expect(stopLines(linesFor('op'))).toEqual(singleStops)
    })
  }
})

// REVIEW FAIL reproducer. The Adaptive 3D worker carves its retained stock field
// from the moves the STRATEGY planned (src/store/index.ts:6355, carvedStockHandle).
// The seam then trims those moves (src/store/index.ts:6379), but the store still
// records the untrimmed carve as what this rough left (src/store/index.ts:6461-6478,
// adaptive3dRetainedField). The next adaptive rough starts from that field
// (resolveRestStart) and believes the material the trim left - here Z 15.25 down to
// the Z 5 floor of the cavity - is already gone: it plans nothing there (in this
// scene it errors "nothing to rough"; with other material to rough it would come
// back ready and silently skip the cavity, and a finish after it would meet a
// 10 mm wall of stock at full depth). Before WO-1678 the short rough refused
// outright, so no field was retained and the rest rough planned from the block.
describe('WO-1678 review: a rest rough after a rough the seam trimmed', () => {
  const adaptive = STRATEGIES.find(([label]) => label === 'adaptive_3d')!
  it('the long-reach rest rough cuts the cavity material the short rough left below its reach floor', { timeout: 240_000 }, async () => {
    const [, type, params] = adaptive
    install([op3d('rough', type, params, 'flat-short'), op3d('rest', type, params, 'flat-long')])
    const rough = await generate('rough')
    expect(stopLines(linesFor('rough')).length).toBeGreaterThan(0)
    const roughDeepest = deepestInCavity(rough.toolpathMoves ?? [])
    await useCamStore.getState().computeOperationToolpath('setup-1', 'rest')
    const rest = opById('rest')
    const restDeepest = deepestInCavity(rest.toolpathMoves ?? [])
    report.push(`adaptive rough then rest: rough deepest Z ${roughDeepest?.toFixed(2) ?? 'none'}, rest ${rest.status} ` +
      `deepest Z ${restDeepest?.toFixed(2) ?? 'none'}${rest.errorMessage ? ` (${rest.errorMessage})` : ''}`)
    expect(rest.status, rest.errorMessage).toBe('ready')
    // The short rough stopped at the reach floor, so material stands in the cavity
    // from Z 15.25 down to the floor. The rest rough, whose tool reaches, must cut it.
    expect(roughDeepest!).toBeGreaterThan(REACH_FLOOR_Z - 0.3)
    expect(restDeepest, 'the rest rough never went below the short rough\'s reach floor').toBeDefined()
    expect(restDeepest!).toBeLessThan(REACH_FLOOR_Z - 5)
  })

  it('control: the same rest rough, with the rough before it not generated, cuts the cavity', { timeout: 240_000 }, async () => {
    const [, type, params] = adaptive
    install([op3d('rough', type, params, 'flat-short'), op3d('rest', type, params, 'flat-long')])
    const rest = await generate('rest')
    const restDeepest = deepestInCavity(rest.toolpathMoves ?? [])
    report.push(`adaptive rest alone: deepest Z ${restDeepest?.toFixed(2) ?? 'none'}`)
    expect(restDeepest!).toBeLessThan(REACH_FLOOR_Z - 5)
  })

  it('control: after a rough that was NOT trimmed, the rest rough has nothing left (the field is true)', { timeout: 240_000 }, async () => {
    const [, type, params] = adaptive
    install([op3d('rough', type, params, 'flat-long'), op3d('rest', type, params, 'flat-long')])
    await generate('rough')
    expect(stopLines(linesFor('rough'))).toEqual([])
    await useCamStore.getState().computeOperationToolpath('setup-1', 'rest')
    const rest = opById('rest')
    report.push(`adaptive untrimmed rough then rest: rest ${rest.status}${rest.errorMessage ? ` (${rest.errorMessage.slice(0, 60)})` : ''}`)
  })
})

afterAll(() => {
  // eslint-disable-next-line no-console
  process.stdout.write(`\n[WO-1678 review]\n${report.join('\n')}\n`)
})
