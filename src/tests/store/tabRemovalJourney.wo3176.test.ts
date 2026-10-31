// WO-3221 (WO-3176 Brief B): Create tab removal contour, through the
// application's own seams.
//
// Source tabbed Contour -> Generate -> Create tab removal contour -> review ->
// Generate -> remaining stock -> Post Process. Every case presses the store's
// OWN actions: computeOperationToolpath (the real toolpathWorker.ts run
// in-process, as WO-3220's journey does), reviewContourTabRemoval /
// createContourTabRemoval (what the Properties panel calls), undo/redo,
// buildProjectFileSnapshot -> loadProjectFromFile, and postProject.
//
// The analytic fixture is the brief's: 100 x 60 x 6 stock (world bottom 0,
// top 6), a closed 60 x 30 inner part profiled from outside, four box tabs
// W = 8, height 1.5, a 6 mm flat end mill, source bottom 0. The material left
// is worked out HERE from the published moves by swept discs (the cutter's
// footprint along every segment, its lowest Z over a point) - not by the
// planner's own tab intervals. At the channel center a straight box lift of
// W = 8 with R = 3 leaves a 2 mm tangential web (never 8 mm); a triangular tab
// with its 45 degree ramps leaves 1.0 mm there, not its 1.5 mm top.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildProjectFileSnapshot, getOperationStockDomain, useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { postProject } from '../../lib/post/postProject'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { parseGcode } from '../../lib/gcode/parse'
import type { ContourParams, ContourTabRemovalTarget, WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'

const R = 3
const TAB_WIDTH = 8
const TAB_HEIGHT = 1.5
const STOCK_TOP = 6
const ORIGIN_Z = 6

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

type P = { x: number; y: number }
const PART: P[] = [{ x: -30, y: -15 }, { x: 30, y: -15 }, { x: 30, y: 15 }, { x: -30, y: 15 }]

function part(): ImportedGeometry {
  return {
    id: 'part', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -30, y: -15, z: 0 }, { x: 30, y: 15, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{ id: 'outline', closed: true, type: 'contour', layerId: 'L1', area: 1800, points: PART }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

function mill(extra: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-1', name: '6 mm end mill', type: 'flat_end_mill',
    diameter: 2 * R, fluteLength: 30, shankDiameter: 6, overallLength: 80,
    lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...extra,
  } as unknown as Tool
}

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

/** The source: WCS-relative heights (origin at the stock top), bottom at world `bottom`. */
function sourceOp(bottom = 0, extra: Partial<ContourParams> = {}): Operation {
  const heights: HeightParams = {
    clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
    topHeight: STOCK_TOP - ORIGIN_Z, topHeightMode: 'absolute', bottomHeight: bottom - ORIGIN_Z, bottomHeightMode: 'absolute',
  }
  const params = {
    geometryId: 'part', loopIds: [], side: 'outer', direction: 'climb',
    tabs: true, tabWidth: TAB_WIDTH, tabHeight: TAB_HEIGHT, tabCount: 4, ...extra,
  }
  const passes: PassParams = { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
  const smartHeight = smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights, params, geometryIds: ['part'] })
  // Through the stock, plus an authored breakthrough allowance below its bottom.
  if (bottom < 0) {
    const intent = smartHeight.intent as { machining: { end: { value: { allowanceMm: number } } } }
    intent.machining.end.value.allowanceMm = -bottom
  }
  return {
    id: 'src', name: 'Outline profile', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking: LINKING, params, smartHeight,
  } as unknown as Operation
}

function install(op: Operation = sourceOp(), setupExtra: Partial<Setup> = {}): void {
  const stocks = [{
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -50, y: -30, z: 0 }, { x: 50, y: 30, z: STOCK_TOP }),
    position: { x: -50, y: -30, z: 0 },
  } as unknown as PhysicalStock]
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -50, y: -30, z: ORIGIN_Z },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [op], notes: 'Screws through the skeleton, two each side', holdingMethod: 'screws',
    ...setupExtra,
  } as unknown as Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 100, fixedHeight: 60, fixedDepth: 6, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [mill()],
    toolpathBatch: null,
    consoleEvents: [],
    projectHistory: [],
    projectFuture: [],
    project: {
      ...s.project, geometry: [part()], stocks, setups: [setup], sceneStock,
      activeSetupId: 'setup-1', activeOperationId: 'src',
      modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    } as Project,
  }))
}

// ── The worker wire: real toolpathWorker.ts, in-process ─────────────────────

let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null

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

const store = () => useCamStore.getState()
const ops = () => store().project.setups[0].operations
const opById = (id: string) => ops().find((candidate) => candidate.id === id)!

async function generate(id: string): Promise<Operation> {
  await store().computeOperationToolpath('setup-1', id)
  return opById(id)
}

async function generateReady(id: string): Promise<Operation> {
  const op = await generate(id)
  expect(op.status, op.errorMessage).toBe('ready')
  return op
}

function create(): string {
  const outcome = store().createContourTabRemoval('setup-1', 'src')
  if (!outcome.ok) throw new Error(`create refused: ${outcome.reason}`)
  return outcome.operationId
}

// ── Independent oracle: swept discs over the published moves ────────────────

/** The moves as straight pieces; arcs are walked in 64 chords (sagitta < 0.01 mm at R <= 50). */
function pieces(moves: readonly ToolpathMove[]): Array<{ a: Vec3; b: Vec3 }> {
  const out: Array<{ a: Vec3; b: Vec3 }> = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if ((b.type === 'arc_cw' || b.type === 'arc_ccw') && b.cx !== undefined && b.cy !== undefined) {
      const r = Math.hypot(a.x - b.cx, a.y - b.cy)
      const a0 = Math.atan2(a.y - b.cy, a.x - b.cx)
      let a1 = Math.atan2(b.y - b.cy, b.x - b.cx)
      if (b.type === 'arc_ccw' && a1 <= a0) a1 += 2 * Math.PI
      if (b.type === 'arc_cw' && a1 >= a0) a1 -= 2 * Math.PI
      let prev: Vec3 = { x: a.x, y: a.y, z: a.z }
      for (let k = 1; k <= 64; k++) {
        const t = k / 64, ang = a0 + (a1 - a0) * t
        const next = { x: b.cx + r * Math.cos(ang), y: b.cy + r * Math.sin(ang), z: a.z + (b.z - a.z) * t }
        out.push({ a: prev, b: next })
        prev = next
      }
    } else {
      out.push({ a: { x: a.x, y: a.y, z: a.z }, b: { x: b.x, y: b.y, z: b.z } })
    }
  }
  return out
}

/** Top of the material left over XY point p: the lowest Z any cutter disc of
 *  radius R reached over it (Z linear along each piece), or the stock top. */
function materialTop(p: P, moves: readonly ToolpathMove[]): number {
  let top = STOCK_TOP
  for (const { a, b } of pieces(moves)) {
    const dx = b.x - a.x, dy = b.y - a.y
    const fx = a.x - p.x, fy = a.y - p.y
    const qa = dx * dx + dy * dy, qb = 2 * (fx * dx + fy * dy), qc = fx * fx + fy * fy - R * R
    let t0: number, t1: number
    if (qa < 1e-12) {
      if (qc > 1e-12) continue
      t0 = 0; t1 = 1
    } else {
      const disc = qb * qb - 4 * qa * qc
      if (disc < 0) continue
      const s = Math.sqrt(disc)
      t0 = Math.max(0, (-qb - s) / (2 * qa)); t1 = Math.min(1, (-qb + s) / (2 * qa))
      if (t0 > t1) continue
    }
    top = Math.min(top, a.z + (b.z - a.z) * t0, a.z + (b.z - a.z) * t1)
  }
  return top
}

/** Point at signed arc distance d from `center` along the closed source finish path. */
function along(path: P[], center: P, d: number): P {
  const n = path.length
  const cumulative = [0]
  for (let i = 0; i < n; i++) {
    const a = path[i], b = path[(i + 1) % n]
    cumulative.push(cumulative[i] + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const total = cumulative[n]
  let best = { s: 0, dist: Infinity }
  for (let i = 0; i < n; i++) {
    const a = path[i], b = path[(i + 1) % n]
    const len = cumulative[i + 1] - cumulative[i]
    const t = len < 1e-12 ? 0 : Math.max(0, Math.min(1, ((center.x - a.x) * (b.x - a.x) + (center.y - a.y) * (b.y - a.y)) / (len * len)))
    const dist = Math.hypot(a.x + (b.x - a.x) * t - center.x, a.y + (b.y - a.y) * t - center.y)
    if (dist < best.dist) best = { s: cumulative[i] + t * len, dist }
  }
  let s = (((best.s + d) % total) + total) % total
  for (let i = 0; i < n; i++) {
    const len = cumulative[i + 1] - cumulative[i]
    if (s <= len) {
      const a = path[i], b = path[(i + 1) % n]
      return { x: a.x + (b.x - a.x) * (s / len), y: a.y + (b.y - a.y) * (s / len) }
    }
    s -= len
  }
  return path[0]
}

function webProfile(path: P[], target: ContourTabRemovalTarget, moves: readonly ToolpathMove[]) {
  return Object.fromEntries([-1.1, -0.9, 0, 0.9, 1.1].map((d) => [d, materialTop(along(path, target.center, d), moves)]))
}

/** Every Z the posted program feeds or rapids to, in the work frame. */
function postedZ(gcode: string): number[] {
  return parseGcode(gcode).segments.map((seg) => seg.to.z)
}

function post(selected?: string[]) {
  const current = store()
  return postProject({ ...current.project, toolLibrary: current.toolLibrary }, current.project.setups, UCCNC_CONFIG, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'WO-3221', ext: 'nc',
    ...(selected ? { selectedOpIds: { 'setup-1': selected } } : {}),
    modelRefsVerifiedSinceLoad: current.modelRefsVerifiedSinceLoad,
  })
}

describe('WO-3221 Create tab removal contour: source -> Generate -> create -> Generate -> stock -> post', () => {
  it('box tabs, bottom 0: the source leaves 2 mm webs, the separate cleanup removes them, the source is unchanged', async () => {
    install()
    const source = await generateReady('src')
    const sourceBefore = structuredClone(source)
    const path = source.contourTabPreview!.loops[0].path
    expect(source.contourTabPreview!.tabTopZ).toBe(TAB_HEIGHT)

    // Review: all four tabs, the setup's actual holding method and note.
    const review = store().reviewContourTabRemoval('setup-1', 'src')
    expect(review.ok).toBe(true)
    if (!review.ok) return
    expect(review.targets.map((t) => t.label)).toEqual(['outline#0', 'outline#1', 'outline#2', 'outline#3'])
    expect(review).toMatchObject({ loopIds: ['outline'], holdingMethod: 'screws', notes: 'Screws through the skeleton, two each side' })

    // Retained webs on the source output, by swept discs.
    for (const target of review.targets) {
      const web = webProfile(path, target, source.toolpathMoves!)
      expect(web[0], target.label).toBeCloseTo(TAB_HEIGHT, 6)
      expect(web[-0.9], target.label).toBeCloseTo(TAB_HEIGHT, 6)
      expect(web[0.9], target.label).toBeCloseTo(TAB_HEIGHT, 6)
      expect(web[-1.1], target.label).toBeLessThanOrEqual(1e-9)
      expect(web[1.1], target.label).toBeLessThanOrEqual(1e-9)
    }

    // The shared remaining stock before the cleanup sees material over every tab.
    expect(await store().readContourTabRemovalMaterial('setup-1', 'src')).toEqual({ status: 'ready', retained: 4, count: 4 })

    // Create: one new operation after the source; the source is not written.
    const historyBefore = store().projectHistory.length
    const cleanupId = create()
    expect(store().projectHistory.length).toBe(historyBefore + 1)
    expect(ops().map((op) => op.id)).toEqual(['src', cleanupId])
    expect(opById('src')).toEqual(sourceBefore)
    const cleanupDraft = opById(cleanupId)
    expect(cleanupDraft.name).toBe('Outline profile - tab removal')
    expect(cleanupDraft.params).toMatchObject({ tabs: false, loopIds: ['outline'], side: 'outer', direction: 'climb' })
    expect(cleanupDraft.passes).toMatchObject({ stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, stepdown: 2 })

    const cleanup = await generateReady(cleanupId)
    expect(opById('src')).toEqual(sourceBefore)
    const zs = cleanup.toolpathMoves!.map((m) => m.z)
    expect(Math.min(...zs)).toBeCloseTo(0, 9)
    // No tab lift is left in the cleanup: every move at a depth below the tab
    // top keeps going down or stays, never lifts to the tab top mid-loop.
    const both = [...source.toolpathMoves!, ...cleanup.toolpathMoves!]
    for (const target of review.targets) {
      const web = webProfile(path, target, both)
      for (const [d, top] of Object.entries(web)) expect(top, `${target.label} at ${d} mm`).toBeLessThanOrEqual(1e-9)
    }

    // Cut stock: the shared remaining stock after both shows no material above the bottom at any tab.
    const { authority, frame, finalOperationId } = getOperationStockDomain('setup-1', DERIVED_STOCK_ID)
    for (let attempt = 0; ; attempt++) {
      const reads = review.targets.map((target) => authority.readBeforeAndQuery(
        { beforeOperationId: finalOperationId, frame, maxCellMm: Number.MAX_VALUE },
        { kind: 'highest-material', frame, bounds: { minX: target.center.x - 0.25, maxX: target.center.x + 0.25,
          minY: target.center.y - 0.25, maxY: target.center.y + 0.25, minZ: 0, maxZ: STOCK_TOP } }))
      if (reads.some(({ read }) => read.status === 'recomputing') && attempt < 200) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        continue
      }
      for (const { read, query } of reads) {
        expect(read.status).toBe('ready')
        expect(query?.status).toBe('ready')
        const value = (query as { value?: unknown }).value
        expect(value === undefined || (typeof value === 'number' && value <= 1e-6), String(value)).toBe(true)
      }
      break
    }

    // Post: both operations, the cleanup's bottom mapped through the saved WCS once.
    const posted = post()
    expect(posted.ok, JSON.stringify(posted.diagnostics)).toBe(true)
    const z = postedZ(posted.combined!.gcode)
    expect(Math.min(...z)).toBeCloseTo(0 - ORIGIN_Z, 6)
    const cleanupOnly = post([cleanupId])
    expect(cleanupOnly.ok).toBe(true)
    expect(Math.min(...postedZ(cleanupOnly.combined!.gcode))).toBeCloseTo(0 - ORIGIN_Z, 6)
  })

  it('triangular tabs use their true 45 degree profile: 1.0 mm left at the channel center, removed by the cleanup', async () => {
    install(sourceOp(0, { tabShape: 'triangular' }))
    const source = await generateReady('src')
    const path = source.contourTabPreview!.loops[0].path
    const review = store().reviewContourTabRemoval('setup-1', 'src')
    if (!review.ok) throw new Error(review.reason)
    for (const target of review.targets) {
      // Flat top 8 - 2 x 1.5 = 5 mm; the disc at the center reaches 3 mm each
      // way, 0.5 mm down each ramp: 1.5 - 0.5 = 1.0 mm (a flat box oracle says 1.5).
      expect(webProfile(path, target, source.toolpathMoves!)[0], target.label).toBeCloseTo(1.0, 6)
    }
    const cleanup = await generateReady(create())
    const both = [...source.toolpathMoves!, ...cleanup.toolpathMoves!]
    for (const target of review.targets) {
      for (const top of Object.values(webProfile(path, target, both))) expect(top).toBeLessThanOrEqual(1e-9)
    }
  })

  it('source bottom -0.2: the cleanup keeps -0.2 and posts it as Z-6.2 in the work frame', async () => {
    install(sourceOp(-0.2))
    await generateReady('src')
    const cleanup = await generateReady(create())
    expect(Math.min(...cleanup.toolpathMoves!.map((m) => m.z))).toBeCloseTo(-0.2, 9)
    const posted = post()
    expect(posted.ok).toBe(true)
    expect(Math.min(...postedZ(posted.combined!.gcode))).toBeCloseTo(-0.2 - ORIGIN_Z, 6)
  })
})

describe('WO-3221 the cleanup goes stale with its source, and never posts stale motion', () => {
  async function readyPair(): Promise<string> {
    install()
    await generateReady('src')
    const id = create()
    await generateReady(id)
    expect(post().ok).toBe(true)
    return id
  }

  async function expectStaleThenRefused(id: string, errorText: RegExp): Promise<void> {
    expect(opById(id).status).toBe('outdated')
    expect(opById(id).toolpathMoves).toBeUndefined()
    expect(post().ok).toBe(false)
    const regenerated = await generate(id)
    expect(regenerated.status).toBe('error')
    expect(regenerated.errorMessage).toMatch(errorText)
    expect(regenerated.toolpathMoves).toBeUndefined()
    expect(store().consoleEvents.filter((event) => event.message === regenerated.errorMessage)).toHaveLength(1)
  }

  it('changed tabs: stale, then one line, no substitute motion', async () => {
    const id = await readyPair()
    store().updateOperation('setup-1', 'src', { params: { ...opById('src').params, tabCount: 3 } })
    await expectStaleThenRefused(id, /changed its outline, tabs, heights or tool/)
  })

  it('changed cutter diameter or hand: stale, then refused', async () => {
    const id = await readyPair()
    store().updateTool('tool-1', { diameter: 5 })
    await expectStaleThenRefused(id, /changed its outline, tabs, heights or tool/)
    const again = await readyPairFresh()
    store().updateTool('tool-1', { cutHand: 'left' } as Partial<Tool>)
    await expectStaleThenRefused(again, /changed its outline, tabs, heights or tool/)
  })

  async function readyPairFresh(): Promise<string> { return readyPair() }

  it('reorder above the source: stale, then refused until it is moved back', async () => {
    const id = await readyPair()
    store().reorderOperations('setup-1', 1, 0)
    expect(ops().map((op) => op.id)).toEqual([id, 'src'])
    await expectStaleThenRefused(id, /above the tabbed contour/)
    store().reorderOperations('setup-1', 0, 1)
    await generateReady('src')
    await generateReady(id)
  })

  it('suppressed source: stale, then refused', async () => {
    const id = await readyPair()
    store().updateOperation('setup-1', 'src', { enabled: false })
    await expectStaleThenRefused(id, /is suppressed/)
  })

  it('deleted source: stale, then refused; deleting the cleanup never touches the source tabs', async () => {
    const id = await readyPair()
    const sourceParams = structuredClone(opById('src').params)
    store().removeOperation('setup-1', 'src')
    await expectStaleThenRefused(id, /no longer exists/)
    store().undo()
    expect(opById('src').params).toEqual(sourceParams)
    store().removeOperation('setup-1', id)
    expect(ops().map((op) => op.id)).toEqual(['src'])
    expect(opById('src').params).toEqual(sourceParams)
  })

  it('stock, WCS or placement change: stale; regenerating is allowed (same source, new frame)', async () => {
    const id = await readyPair()
    store().updateSetup('setup-1', { wcs: { origin: { x: -50, y: -30, z: 5.5 } } })
    expect(opById(id).status).not.toBe('ready')
    expect(post().ok).toBe(false)
    await generateReady('src')
    await generateReady(id)
    expect(post().ok).toBe(true)
  })

  it('a missing or malformed binding is one line and no motion, never an unbound contour', async () => {
    const id = await readyPair()
    store().updateOperation('setup-1', id, { params: { ...opById(id).params, tabRemovalSource: { version: 1, sourceOperationId: 'src' } } })
    const refused = await generate(id)
    expect(refused.status).toBe('error')
    expect(refused.errorMessage).toMatch(/link to its source cannot be read/)
    expect(refused.toolpathMoves).toBeUndefined()
  })

  it('a source edit while the cleanup is computing does not publish the old result', async () => {
    const id = await readyPair()
    const pending = store().computeOperationToolpath('setup-1', id)
    store().updateOperation('setup-1', 'src', { params: { ...opById('src').params, tabWidth: 9 } })
    await pending
    expect(opById(id).status).not.toBe('ready')
    expect(post([id]).ok).toBe(false)
  })
})

describe('WO-3221 creation, undo, save and refusals', () => {
  it('two of four tabs selected: nothing is created and the reason is selective removal', async () => {
    install()
    await generateReady('src')
    const review = store().reviewContourTabRemoval('setup-1', 'src')
    if (!review.ok) throw new Error(review.reason)
    const two = review.targets.slice(0, 2).map((t) => t.label)
    expect(store().createContourTabRemoval('setup-1', 'src', two)).toEqual({ ok: false, reason: 'selective' })
    expect(ops().map((op) => op.id)).toEqual(['src'])
  })

  it('before Generate, or with the source changed since, nothing is created', async () => {
    install()
    expect(store().createContourTabRemoval('setup-1', 'src')).toEqual({ ok: false, reason: 'generate-first' })
    await generateReady('src')
    store().updateOperation('setup-1', 'src', { params: { ...opById('src').params, tabCount: 3 } })
    expect(store().createContourTabRemoval('setup-1', 'src')).toEqual({ ok: false, reason: 'stale' })
    expect(ops()).toHaveLength(1)
  })

  it('one undo removes just the cleanup; redo brings it back with its binding', async () => {
    install()
    await generateReady('src')
    const sourceParams = structuredClone(opById('src').params)
    const id = create()
    const binding = structuredClone((opById(id).params as unknown as ContourParams).tabRemovalSource)
    store().undo()
    expect(ops().map((op) => op.id)).toEqual(['src'])
    expect(opById('src').params).toEqual(sourceParams)
    store().redo()
    expect(ops().map((op) => op.id)).toEqual(['src', id])
    expect((opById(id).params as unknown as ContourParams).tabRemovalSource).toEqual(binding)
  })

  it('save and reopen keep the binding verbatim; the reopened pair generates and posts', async () => {
    install()
    await generateReady('src')
    const id = create()
    await generateReady(id)
    const st = store()
    const binding = structuredClone((opById(id).params as unknown as ContourParams).tabRemovalSource)
    const file = buildProjectFileSnapshot(st.project, st.toolLibrary, st.toolLibraries, st.holders)
    await st.loadProjectFromFile(JSON.stringify(file))
    const setupId = store().project.setups[0].id
    const reopened = store().project.setups[0].operations
    expect(reopened.map((op) => op.id)).toEqual(['src', id])
    expect((reopened[1].params as unknown as ContourParams).tabRemovalSource).toEqual(binding)
    for (const opId of ['src', id]) {
      if (store().project.setups[0].operations.find((op) => op.id === opId)!.status !== 'ready') {
        await store().computeOperationToolpath(setupId, opId)
      }
    }
    expect(store().project.setups[0].operations.map((op) => op.status)).toEqual(['ready', 'ready'])
  })

  it('a file whose source tabs were changed outside the app reopens with the cleanup outdated, not posted', async () => {
    install()
    await generateReady('src')
    const id = create()
    await generateReady(id)
    const st = store()
    const file = buildProjectFileSnapshot(st.project, st.toolLibrary, st.toolLibraries, st.holders)
    const fileSource = file.setups[0].operations.find((op) => op.id === 'src')!
    fileSource.params = { ...fileSource.params, tabCount: 3 }
    await st.loadProjectFromFile(JSON.stringify(file))
    const reopened = store().project.setups[0].operations.find((op) => op.id === id)!
    expect(reopened.status).not.toBe('ready')
    expect(post([id]).ok).toBe(false)
  })

  it('a contour without a binding stays an ordinary contour (older projects unchanged)', async () => {
    install(sourceOp(0, { tabs: false }))
    const op = await generateReady('src')
    expect((op as Operation & { dependsOnPredecessors?: boolean }).dependsOnPredecessors).toBeUndefined()
    expect(store().reviewContourTabRemoval('setup-1', 'src')).toEqual({ ok: false, reason: 'tabs-off' })
  })
})
