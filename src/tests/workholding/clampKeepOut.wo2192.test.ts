// WO-2192 (workholding assemblies, slice 5): CAM keeps clear of a clamp placed
// on a stock edge - where the edge puts it, only in the setup it is placed in -
// through the slice 3 path (no new CAM rule), and sliding it along the edge
// outdates only that setup's operations.
//
// Production route (WO-2177's harness): the clamp is made, placed and slid by
// the store's own actions (makeClamp, placeClamp, moveClampOnEdge) and every
// program comes from the store's own generate action (computeOperationToolpath)
// with the REAL toolpathWorker.ts run in-process. The STL cache is the only
// stand-in (node has no IndexedDB); it serves real STL bytes.
//
// SCENE (worked out by hand): the stock is X -60..60, Y -40..40, Z 0..10; its
// edge runs counter-clockwise from (-60,-40), 400 mm round. A 40 x 20 pocket
// (X -20..20, Y -10..10) is cut from Z 10 to Z 5 with a 6 mm end mill, so with
// nothing in the way the cutter centre reaches X 17. The clamp body is 8 x 40 x
// 20 (8 along the edge, 40 across it). Placed at fraction 0.4 (160 mm round:
// the right side at Y 0, the edge running +Y) with its origin 26 mm INSIDE the
// edge (offset -26 -> X 34) it covers X 14..54, Y -4..4, resting on the stock
// top (Z 10..30) - across the pocket's +X end, so no cutting move may come
// within 3 + 0.25 mm of it: level with it the cut stops by X 10.75. Slid to 0.475
// (190 mm: Y 30) it covers Y 26..34, clear of the pocket, which is cut to X 17.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const cache = vi.hoisted(() => ({ stl: new Map<string, ArrayBuffer>() }))

vi.mock('../../lib/stlCache', async (importOriginal) => typedMock<typeof import('../../lib/stlCache')>({
  ...await importOriginal<typeof import('../../lib/stlCache')>(),
  loadCachedSTL: vi.fn(async (id: string) => cache.stl.get(id) ?? null),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...await importOriginal<typeof import('../../lib/stepCache')>(),
  loadCachedStepDisplay: vi.fn(async () => null),
}))

import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolHolder, ToolpathMove, Vec3, WCS,
} from '../../types'

const CUTTER_RADIUS = 3
const ALLOWANCE = 0.25
const BODY = { x: 8, y: 40, z: 20 }

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** A binary STL of an axis-aligned box, off-centre in the file so the display recentring runs. */
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
    for (let v = 0; v < 3; v++) {
      const p = c(tris[t * 3 + v])
      view.setFloat32(84 + 50 * t + 12 + v * 12, p.x, true)
      view.setFloat32(84 + 50 * t + 16 + v * 12, p.y, true)
      view.setFloat32(84 + 50 * t + 20 + v * 12, p.z, true)
    }
  }
  return buffer
}

function body(id: string, name: string, x: number): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: -BODY.x / 2, y: -BODY.y / 2, z: 0 }, { x: BODY.x / 2, y: BODY.y / 2, z: BODY.z }),
    position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, workholding: true,
  } as unknown as ImportedGeometry
}

function pocketOutline(): ImportedGeometry {
  return {
    id: 'pocket-outline', name: 'Pocket outline', filename: 'pocket.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -20, y: -10, z: 0 }, { x: 20, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: 'pocket-loop', closed: true, type: 'contour', layerId: 'L1', area: 800,
      points: [{ x: -20, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 10 }, { x: -20, y: 10 }],
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

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

function pocketOp(id: string, setupId: string): Operation {
  const heights: HeightParams = {
    clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
    topHeight: 10, topHeightMode: 'absolute', bottomHeight: 5, bottomHeightMode: 'absolute',
  }
  const params = {
    geometryId: 'pocket-outline', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
    fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
    helixDiameter: 0, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
  }
  const passes: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id, name: `Pocket ${setupId}`, type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: ['pocket-outline'], heights, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', { setupId, heights, params, geometryIds: ['pocket-outline'] }),
  } as unknown as Operation
}

function setup(id: string, opId: string): Setup {
  return {
    id, name: id,
    wcs: {
      id: `wcs-${id}`, label: 'G54', fixtureOffset: 54, origin: { x: -60, y: -40, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [pocketOp(opId, id)], notes: '',
  } as unknown as Setup
}

let clampId = ''

/** Two setups with the same pocket; one clamp on the stock's right edge, in setup-a only. */
function install(): void {
  const stock = {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -60, y: -40, z: 0 }, { x: 60, y: 40, z: 10 }),
    position: { x: -60, y: -40, z: 0 },
  } as unknown as PhysicalStock
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 120, fixedHeight: 80, fixedDepth: 10, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [MILL],
    holders: [HOLDER],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project,
      geometry: [pocketOutline(), body('clamp-body', 'Strap clamp', -200)],
      stocks: [stock], setups: [setup('setup-a', 'op-a'), setup('setup-b', 'op-b')], sceneStock,
      workholding: undefined,
      activeSetupId: 'setup-a', activeOperationId: 'op-a',
      modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    } as Project,
  }))
  const definitionId = useCamStore.getState().makeClamp('clamp-body')
  expect(definitionId).not.toBeNull()
  const placed = useCamStore.getState().placeClamp({
    definitionId: definitionId!, target: { kind: 'stock', id: DERIVED_STOCK_ID, loopId: 'outline' },
    fraction: 0.4, normalOffsetMm: -26, setupId: 'setup-a',
  })
  expect(placed).not.toBeNull()
  clampId = placed!
}

/** Distance in XY from (x, y) to the footprint X x0..x1, Y y0..y1. */
function xyDistanceToBox(x: number, y: number, x0: number, x1: number, y0: number, y1: number): number {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1))
}

// ── The worker wire: real toolpathWorker.ts, in-process ─────────────────────

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
  cache.stl.set('clamp-body', boxStl(BODY))
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
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

const opIn = (setupId: string) => useCamStore.getState().project.setups.find((s) => s.id === setupId)!.operations[0]

async function generate(setupId: string): Promise<ToolpathMove[]> {
  const op = opIn(setupId)
  await useCamStore.getState().computeOperationToolpath(setupId, op.id)
  expect(opIn(setupId).status, opIn(setupId).errorMessage).toBe('ready')
  return opIn(setupId).toolpathMoves ?? []
}

/** Every position along the cutting moves below the body tops, 0.1 mm apart. */
function cuttingSamples(moves: readonly ToolpathMove[]): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type === 'rapid') continue
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.1))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
      if (p.z < BODY.z) out.push(p)
    }
  }
  return out
}

const maxX = (samples: readonly { x: number }[]) => Math.max(...samples.map((p) => p.x))

describe('WO-2192: CAM keeps clear of a clamp where its edge puts it', () => {
  it('on the right edge at Y 0 the pocket stops short of the clamp at X 14; slid to Y 30 it cuts to X 17 and keeps clear', async () => {
    install()
    const near = cuttingSamples(await generate('setup-a'))
    expect(near.length).toBeGreaterThan(0)
    for (const p of near) expect(xyDistanceToBox(p.x, p.y, 14, 54, -4, 4)).toBeGreaterThanOrEqual(CUTTER_RADIUS + ALLOWANCE - 0.02)
    // Level with the clamp (|Y| <= 4) the cut stops 3.25 short of its face at X 14; without it, X 17.
    expect(maxX(near.filter((p) => Math.abs(p.y) <= 4))).toBeLessThanOrEqual(14 - CUTTER_RADIUS - ALLOWANCE + 0.02)
    expect(maxX(near)).toBeLessThan(16.9)

    useCamStore.getState().moveClampOnEdge(clampId, { fraction: 0.475 })
    const slid = cuttingSamples(await generate('setup-a'))
    for (const p of slid) expect(xyDistanceToBox(p.x, p.y, 14, 54, 26, 34)).toBeGreaterThanOrEqual(CUTTER_RADIUS + ALLOWANCE - 0.02)
    expect(maxX(slid)).toBeGreaterThan(16.9)
  })

  it('a setup the clamp is not placed in cuts the whole pocket', async () => {
    install()
    expect(maxX(cuttingSamples(await generate('setup-b')))).toBeGreaterThan(16.9)
  })

  it('sliding the clamp outdates the operations of its setup and no other', async () => {
    install()
    await generate('setup-a')
    await generate('setup-b')
    useCamStore.getState().moveClampOnEdge(clampId, { fraction: 0.475 })
    expect(opIn('setup-a').status).toBe('outdated')
    expect(opIn('setup-b').status).toBe('ready')
  })
})
