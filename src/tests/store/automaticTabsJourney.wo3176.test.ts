// WO-3220 (WO-3176 Brief A2): Suggest tab locations -> preview -> Apply ->
// Generate -> Post, through the application's own seams.
//
// Every case presses the store's OWN actions: computeOperationToolpath (the
// real toolpathWorker.ts run in-process, exactly as WO-3218's journey does),
// suggestContourTabLocations / applyContourTabSuggestions (what the Properties
// panel calls), undo/redo, buildProjectFileSnapshot -> loadProjectFromFile, and
// postProject. Nothing hands buildContourToolpath a payload of its own.
//
// Expected positions come from the geometry worked out HERE: the 100 x 20 mm
// part profiled from outside with a 6 mm cutter gives a 106 x 26 mm finish
// rectangle whose hard corners every suggested center must clear by
// W/2 + R + 0.25 = 7.25 mm of arc. Tab lifts are read off the published moves
// and the posted G-code, never from the suggestion itself.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildProjectFileSnapshot, useCamStore, type ContourTabSuggestion } from '../../store'
import { importGeometryFile } from '../../lib/import/importGeometryFile'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { pointAtFraction, polylineCumulative } from '../../lib/viewport/tabPlacement'
import { postProject } from '../../lib/post/postProject'
import { operationRegenerationInputsKey } from '../../lib/cam/generationFingerprint'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { parseGcode } from '../../lib/gcode/parse'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'

const TAB_HEIGHT = 1.5
const TAB_WIDTH = 8
const STOCK_DEPTH = 10
const R = 3
const MARGIN = TAB_WIDTH / 2 + R + 0.25

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

type P = { x: number; y: number }
const RECT: P[] = [{ x: -50, y: -10 }, { x: 50, y: -10 }, { x: 50, y: 10 }, { x: -50, y: 10 }]
/** A 100 x 40 part with a 40 x 26 mm notch cut into its top edge (concave U). */
const NOTCHED: P[] = [
  { x: -50, y: -20 }, { x: 50, y: -20 }, { x: 50, y: 20 }, { x: 20, y: 20 },
  { x: 20, y: -6 }, { x: -20, y: -6 }, { x: -20, y: 20 }, { x: -50, y: 20 },
]

function rounded(w: number, h: number, r: number, perCorner = 8): P[] {
  const out: P[] = []
  const corners = [
    { cx: w / 2 - r, cy: -h / 2 + r, a0: -Math.PI / 2 },
    { cx: w / 2 - r, cy: h / 2 - r, a0: 0 },
    { cx: -w / 2 + r, cy: h / 2 - r, a0: Math.PI / 2 },
    { cx: -w / 2 + r, cy: -h / 2 + r, a0: Math.PI },
  ]
  for (const c of corners) {
    for (let i = 0; i <= perCorner; i++) {
      const a = c.a0 + (Math.PI / 2) * (i / perCorner)
      out.push({ x: c.cx + r * Math.cos(a), y: c.cy + r * Math.sin(a) })
    }
  }
  return out
}

interface Loop { id: string; points: P[] }

function part(loops: Loop[]): ImportedGeometry {
  const xs = loops.flatMap((l) => l.points.map((p) => p.x)), ys = loops.flatMap((l) => l.points.map((p) => p.y))
  return {
    id: 'part', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: Math.min(...xs), y: Math.min(...ys), z: 0 }, { x: Math.max(...xs), y: Math.max(...ys), z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: loops.map((l) => ({ id: l.id, closed: true, type: 'contour', layerId: 'L1', area: 1, points: l.points })),
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

function clamp(min: Vec3, max: Vec3): ImportedGeometry {
  return {
    id: 'clamp', name: 'Clamp', filename: 'clamp.dxf', type: 'curves_2d', format: 'dxf', workholding: true,
    boundingBox: bbox(min, max), position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [], layers2d: [],
  } as unknown as ImportedGeometry
}

function mill(cutHand?: 'left'): Tool {
  return {
    id: 'tool-1', name: '6 mm end mill', type: 'flat_end_mill',
    diameter: 2 * R, fluteLength: 30, shankDiameter: 6, overallLength: 80,
    lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    ...(cutHand ? { cutHand } : {}),
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
  } as unknown as Tool
}

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function contourOp(extra: Record<string, unknown> = {}, passes: Partial<PassParams> = {}): Operation {
  const heights: HeightParams = {
    clearanceHeight: 30, clearanceHeightMode: 'absolute', retractHeight: 25, feedHeight: 22,
    topHeight: STOCK_DEPTH - 6, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
  }
  const params = {
    geometryId: 'part', loopIds: [], side: 'outer', direction: 'climb',
    tabs: true, tabWidth: TAB_WIDTH, tabHeight: TAB_HEIGHT, tabCount: 6, ...extra,
  }
  const allPasses: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0, ...passes }
  return {
    id: 'op-1', name: 'Outline profile', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes: allPasses, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights, params, geometryIds: ['part'] }),
  } as unknown as Operation
}

interface Scene {
  loops?: Loop[]
  op?: Operation
  tool?: Tool
  extraGeometry?: ImportedGeometry[]
  /** Replaces the seeded DXF-shaped part (the import and mesh cases bring their own). */
  geometry?: ImportedGeometry[]
}

function install({ loops = [{ id: 'outline', points: RECT }], op = contourOp(), tool = mill(), extraGeometry = [], geometry }: Scene = {}): void {
  const stocks = [{
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -80, y: -40, z: 0 }, { x: 80, y: 40, z: STOCK_DEPTH }),
    position: { x: -80, y: -40, z: 0 },
  } as unknown as PhysicalStock]
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -80, y: -40, z: 6 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [op], notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 160, fixedHeight: 80, fixedDepth: 10, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    toolpathBatch: null,
    consoleEvents: [],
    projectHistory: [],
    projectFuture: [],
    project: {
      ...s.project, geometry: [...(geometry ?? [part(loops)]), ...extraGeometry], stocks, setups: [setup], sceneStock,
      activeSetupId: 'setup-1', activeOperationId: 'op-1',
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

const store = () => useCamStore.getState()
const op = () => store().project.setups[0].operations[0]
const lastContourRequest = () => [...workerRequests].reverse().find((r) => r.type === 'COMPUTE_CONTOUR')

async function generate(): Promise<void> {
  await store().computeOperationToolpath('setup-1', 'op-1')
  expect(op().status, op().errorMessage).toBe('ready')
}

function suggest(): ContourTabSuggestion {
  const outcome = store().suggestContourTabLocations('setup-1', 'op-1')
  if (!outcome.ok) throw new Error(`suggest refused: ${outcome.reason}`)
  return outcome.suggestion
}

/** Sharp corners (>= 45 deg turn) of a closed path, as arc distances from path[0]. */
function cornerDistances(path: P[]): number[] {
  const { cumulative } = polylineCumulative(path)
  return path.flatMap((b, i) => {
    const a = path[(i + path.length - 1) % path.length], c = path[(i + 1) % path.length]
    const turn = Math.abs(Math.atan2((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x),
      (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)))
    return turn >= Math.PI / 4 - 1e-9 ? [cumulative[i]] : []
  })
}

/** Every vertex where the path turns at all, as arc distances from path[0]. */
function turningDistances(path: P[]): number[] {
  const { cumulative } = polylineCumulative(path)
  return path.flatMap((b, i) => {
    const a = path[(i + path.length - 1) % path.length], c = path[(i + 1) % path.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    return Math.abs(cross) > 1e-9 ? [cumulative[i]] : []
  })
}

const circular = (a: number, b: number, length: number) => {
  const d = Math.abs((((a - b) % length) + length) % length)
  return Math.min(d, length - d)
}

/** Each held-level feed run at the tab top Z: its XY midpoint (one per tab per pass). */
function tabLiftMidpoints(moves: readonly { type: string; x: number; y: number; z: number }[], topZ: number): P[] {
  const out: P[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type !== 'feed' || a.type === 'rapid') continue
    if (Math.abs(a.z - topZ) < 1e-6 && Math.abs(b.z - topZ) < 1e-6 && Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) {
      out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    }
  }
  return out
}

const near = (p: P, centers: P[], tol: number) => centers.some((c) => Math.hypot(p.x - c.x, p.y - c.y) <= tol)

function suggestedPoints(s: ContourTabSuggestion): P[] {
  const preview = op().contourTabPreview!
  return s.loops.flatMap((loop) => {
    const path = preview.loops.find((l) => l.loopId === loop.loopId)!.path
    return loop.fractions.map((f) => pointAtFraction(path, f))
  })
}

/** The rectangle plus a second outline, an 8 x 8 mm block, boxed in by four
 *  clamps 0.3 mm clear of the cutter on every side: no corridor on the block
 *  survives, while the rectangle's bottom edge stays free (mixed Apply K). */
function installBoxedBlock(): void {
  const BLOCK: P[] = [{ x: -4, y: 26 }, { x: 4, y: 26 }, { x: 4, y: 34 }, { x: -4, y: 34 }]
  const boxIn = (id: string, min: Vec3, max: Vec3) => ({ ...clamp(min, max), id, name: id })
  install({
    loops: [{ id: 'outline', points: RECT }, { id: 'block', points: BLOCK }],
    extraGeometry: [
      boxIn('clamp-w', { x: -20, y: 17, z: 0 }, { x: -10.3, y: 45, z: 12 }),
      boxIn('clamp-e', { x: 10.3, y: 17, z: 0 }, { x: 20, y: 45, z: 12 }),
      boxIn('clamp-s', { x: -10.3, y: 17, z: 0 }, { x: 10.3, y: 19.7, z: 12 }),
      boxIn('clamp-n', { x: -10.3, y: 40.3, z: 0 }, { x: 10.3, y: 45, z: 12 }),
    ],
  })
}

/** Apply has written `s`: Generate sends exactly those fractions through the
 *  worker, the published moves lift at exactly those centers, and the posted
 *  program holds the tab-top Z (work frame) over the same spans. */
async function expectAppliedTabsCutAndPosted(s: ContourTabSuggestion): Promise<void> {
  // A loop the accepted plan found nothing on is written as 'none' (no tabs).
  const applied = Object.fromEntries(s.loops.filter((l) => !l.skipped)
    .map((l) => [l.loopId, l.fractions.length > 0 ? l.fractions : 'none']))
  workerRequests = []
  await generate()
  const sent = (lastContourRequest()!.payload as { params: { tabLocations?: Record<string, number[] | 'none'> } }).params
  expect(sent.tabLocations).toEqual(applied)

  const centers = suggestedPoints(s)
  const topZ = op().contourTabPreview!.tabTopZ
  expect(topZ).toBe(TAB_HEIGHT)
  const lifts = tabLiftMidpoints(op().toolpathMoves as ToolpathMove[], topZ)
  expect(lifts.length).toBeGreaterThanOrEqual(centers.length)
  for (const lift of lifts) expect(near(lift, centers, 1e-3)).toBe(true)
  for (const c of centers) expect(near(c, lifts, 1e-3)).toBe(true)

  // Posted program: the tab-top Z (work frame: world Z - origin 6) is held over the same spans.
  const current = store()
  const posted = postProject({ ...current.project, toolLibrary: current.toolLibrary }, current.project.setups, UCCNC_CONFIG, {
    mode: 'combined', pauseBetweenSetups: false, baseName: 'WO-3220', ext: 'nc', selectedOpIds: { 'setup-1': ['op-1'] },
    modelRefsVerifiedSinceLoad: current.modelRefsVerifiedSinceLoad,
  })
  const program = parseGcode(posted.combined!.gcode)
  const origin = current.project.setups[0].wcs.origin
  expect(program.segments.length).toBeGreaterThan(0)
  const workMoves = [
    { type: 'rapid', ...program.segments[0].from },
    ...program.segments.map((seg) => ({ type: seg.kind === 'rapid' ? 'rapid' : 'feed', ...seg.to })),
  ].map((m) => ({ type: m.type, x: m.x + origin.x, y: m.y + origin.y, z: m.z }))
  const postedLifts = tabLiftMidpoints(workMoves, topZ - origin.z)
  expect(postedLifts.length).toBe(lifts.length)
  for (const lift of postedLifts) expect(near(lift, centers, 1e-3)).toBe(true)
}

// ── Tier 2 sources: the real DXF importer and a modeled body's mesh ─────────

type Pairs = Array<[number | string, string]>
function dxf(pairs: Pairs): string {
  return [[0, 'SECTION'], [2, 'ENTITIES'], ...pairs, [0, 'ENDSEC'], [0, 'EOF']]
    .map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}
/** The notched plate as one closed LWPOLYLINE, plus a 4 mm hole whose wall is 0.1 mm off the bottom edge. */
const NOTCHED_PLATE_DXF = dxf([
  [0, 'LWPOLYLINE'], [8, 'Cut'], [90, `${NOTCHED.length}`], [70, '1'],
  ...NOTCHED.flatMap((p): Pairs => [[10, `${p.x}`], [20, `${p.y}`]]),
  [0, 'CIRCLE'], [8, 'Cut'], [10, '0'], [20, '-17.9'], [40, '2'],
])

/** Import a DXF through importGeometryFile -> the store's own addGeometry, and
 *  answer the import's stock prompt with this Setup's stock as the operator does. */
async function importDxf(name: string, text: string): Promise<ImportedGeometry> {
  const before = new Set(store().project.geometry.map((g) => g.id))
  // importGeometryFile reads the viewport handle off window; this suite runs in node.
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  if (!hadWindow) g.window = {}
  try {
    const done = importGeometryFile(new File([text], name, { type: 'application/dxf' }),
      { importBrepGeometry: async () => {}, addGeometry: (geo) => store().addGeometry(geo) })
    for (let i = 0; i < 200 && !store().importStockChoice; i++) await new Promise((r) => setTimeout(r, 0))
    expect(store().importStockChoice?.stocks.map((st) => st.id)).toEqual([DERIVED_STOCK_ID])
    store().resolveImportStockChoice({ kind: 'stock', stockId: DERIVED_STOCK_ID })
    await done
  } finally {
    if (!hadWindow) delete g.window
  }
  const added = store().project.geometry.filter((geo) => !before.has(geo.id))
  expect(added).toHaveLength(1)
  return added[0]
}

/** Point op-1 at a geometry the way the operation's geometry picker does. */
function bindOperationTo(geometryId: string, loopIds: string[]): void {
  const params = { ...op().params, geometryId, loopIds }
  store().updateOperation('setup-1', 'op-1', {
    params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights: op().heights, params, geometryIds: [geometryId] }),
  } as Partial<Operation>)
}

/** A closed prism (walls + caps) of a polygon, z0..z1: what a modeled body tessellates to. */
function prismMesh(pts: P[], z0: number, z1: number): { positions: number[]; indices: number[] } {
  const positions: number[] = [], indices: number[] = []
  const n = pts.length
  for (const p of pts) positions.push(p.x, p.y, z0, p.x, p.y, z1)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    indices.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1)
  }
  return { positions, indices }
}

function modelBody(id: string, pts: P[]): ImportedGeometry {
  const mesh = prismMesh(pts, 0, STOCK_DEPTH)
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  const min = { x: Math.min(...xs), y: Math.min(...ys), z: 0 }, max = { x: Math.max(...xs), y: Math.max(...ys), z: STOCK_DEPTH }
  return {
    id, name: 'Notched body', filename: '', type: 'model', format: 'model',
    boundingBox: bbox(min, max), position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true, modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices, edgePositions: [], edgeOffsets: [],
        bbox: { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] },
      },
    },
  } as unknown as ImportedGeometry
}

/** The concave-notch acceptance, shared by every source: clear of every hard corner, applied, cut and posted. */
async function expectNotchSuggestionCut(loopId: string): Promise<ContourTabSuggestion> {
  const s = suggest()
  const loop = s.loops.find((l) => l.loopId === loopId)!
  expect(loop.fractions.length).toBeGreaterThan(0)
  expect(s.found).toBe(loop.fractions.length)
  expect(Object.keys(loop.reasons)).toContain('sharp-corner-or-short-span')
  const preview = op().contourTabPreview!.loops.find((l) => l.loopId === loopId)!
  // An outside profile rounds the convex corners; the notch's two inner corners stay sharp.
  const corners = cornerDistances(preview.path)
  expect(corners.length).toBe(2)
  for (const d of loop.distances) {
    for (const c of corners) expect(circular(d, c, preview.perimeter)).toBeGreaterThanOrEqual(MARGIN - 1e-6)
  }
  const applied = store().applyContourTabSuggestions('setup-1', 'op-1', s)
  expect(applied).toEqual({ ok: true, applied: s.found, loopIds: [loopId], noneLoopIds: [] })
  expect(op().params.tabLocations).toEqual({ [loopId]: loop.fractions })
  await expectAppliedTabsCutAndPosted(s)
  return s
}

describe('WO-3220: Suggest tab locations through the production seams', () => {
  it('rectangle: suggestions clear every hard corner, Apply writes them, Generate and Post cut them', async () => {
    install()
    await generate()
    expect(op().params.tabLocations).toBeUndefined()
    const preview = op().contourTabPreview!
    expect(preview.sourceKey).toBeTruthy()
    const path = preview.loops[0].path
    const L = preview.loops[0].perimeter
    // An outside profile rounds each convex corner with the cutter radius.
    expect(L).toBeCloseTo(2 * (100 + 20) + 2 * Math.PI * R, 1)

    const s = suggest()
    expect(s.requested).toBe(6)
    expect(s.found).toBe(6)
    // No tab corridor reaches into a corner arc (every turning vertex is
    // more than W/2 of arc from each suggested center).
    const turning = turningDistances(path)
    expect(turning.length).toBeGreaterThan(4)
    for (const d of s.loops[0].distances) {
      for (const v of turning) expect(circular(d, v, L)).toBeGreaterThan(TAB_WIDTH / 2)
    }
    // Suggest writes nothing.
    expect(op().params.tabLocations).toBeUndefined()
    expect(op().status).toBe('ready')

    const applied = store().applyContourTabSuggestions('setup-1', 'op-1', s)
    expect(applied).toEqual({ ok: true, applied: 6, loopIds: ['outline'], noneLoopIds: [] })
    expect(op().params.tabLocations).toEqual({ outline: s.loops[0].fractions })
    expect(op().status).toBe('pending')
    expect(op().toolpathMoves).toBeUndefined()

    await expectAppliedTabsCutAndPosted(s)
  })

  it('round rectangle: tessellated arcs make no artificial corners; every suggestion is found', async () => {
    install({ loops: [{ id: 'outline', points: rounded(100, 30, 6) }] })
    await generate()
    const s = suggest()
    expect(s.found).toBe(6)
    expect(s.loops[0].diagnostics).toEqual([])
    const path = op().contourTabPreview!.loops[0].path
    // The offset of a filleted rectangle has no sharp corner at all.
    expect(cornerDistances(path)).toEqual([])
  })

  it('concave notch: no suggested corridor reaches across to the opposite wall', async () => {
    install({ loops: [{ id: 'outline', points: NOTCHED }] })
    await generate()
    const s = suggest()
    expect(s.found).toBeGreaterThan(0)
    expect(Object.keys(s.loops[0].reasons)).toContain('sharp-corner-or-short-span')
    const path = op().contourTabPreview!.loops[0].path
    const L = op().contourTabPreview!.loops[0].perimeter
    const corners = cornerDistances(path)
    for (const d of s.loops[0].distances) {
      for (const c of corners) expect(circular(d, c, L)).toBeGreaterThanOrEqual(MARGIN - 1e-6)
    }
  })

  it('island: a hole near the outline is avoided; the hole loop itself is a hole ring, not a second part', async () => {
    // A 4 mm round hole whose wall comes within 0.1 mm of the bottom edge, centred on x = 0.
    const hole = Array.from({ length: 24 }, (_, i) => ({
      x: 2 * Math.cos((2 * Math.PI * i) / 24), y: -10 + 2.1 + 2 * Math.sin((2 * Math.PI * i) / 24),
    }))
    install({ loops: [{ id: 'outline', points: RECT }, { id: 'hole', points: hole }], op: contourOp({ loopIds: ['outline'] }) })
    await generate()
    const s = suggest()
    expect(s.loops.map((l) => l.loopId)).toEqual(['outline'])
    expect(Object.keys(s.loops[0].reasons)).toContain('source-ring:hole')
    for (const p of suggestedPoints(s)) {
      if (p.y < 0) expect(Math.abs(p.x)).toBeGreaterThan(2)
    }
  })

  it('clamp beside the bottom edge: no tab is suggested over it, and the clamp is named as the reason', async () => {
    // Finish path bottom edge at y = -13; a clamp whose face is 3.3 mm off it (cutter edge 0.3 mm clear).
    install({ extraGeometry: [clamp({ x: -10, y: -30, z: 0 }, { x: 10, y: -16.3, z: 12 })] })
    await generate()
    const s = suggest()
    expect(Object.keys(s.loops[0].reasons).some((r) => r.startsWith('fixture:'))).toBe(true)
    for (const p of suggestedPoints(s)) {
      if (p.y < 0) expect(Math.abs(p.x) > 10 + TAB_WIDTH / 2 - 1e-6).toBe(true)
    }
    // Without the clamp the same request does put a tab on that stretch.
    install()
    await generate()
    const open = suggestedPoints(suggest())
    expect(open.some((p) => p.y < 0 && Math.abs(p.x) <= 10 + TAB_WIDTH / 2)).toBe(true)
  })

  it('hand-placed loops are never touched; only loops without locations are seeded', async () => {
    install({ loops: [{ id: 'outline', points: RECT }, { id: 'second', points: RECT.map((p) => ({ x: p.x, y: p.y + 30 })) }],
      op: contourOp({ tabLocations: { second: [0.9, 0.125, 0.5] } }) })
    await generate()
    const before = JSON.stringify(op().params.tabLocations)
    const s = suggest()
    expect(s.loops.find((l) => l.loopId === 'second')!.skipped).toBe('hand-placed')
    expect(store().applyContourTabSuggestions('setup-1', 'op-1', s).ok).toBe(true)
    const after = op().params.tabLocations as Record<string, number[]>
    expect(JSON.stringify(after.second)).toBe(JSON.stringify(JSON.parse(before).second))
    expect(after.outline).toEqual(s.loops.find((l) => l.loopId === 'outline')!.fractions)

    // Every loop hand-placed: one line, nothing written.
    const snapshot = JSON.stringify(op())
    expect(store().suggestContourTabLocations('setup-1', 'op-1')).toEqual({ ok: false, reason: 'all-hand-placed' })
    expect(JSON.stringify(op())).toBe(snapshot)
  })

  it('mixed Apply K: an outline whose suggestion found nothing gets no tabs, never the even-spacing fallback', async () => {
    // Fix round 2 (audit FAIL, src/store/index.ts applyContourTabSuggestions with
    // src/lib/cam/contour2d.ts tabLocations read): a second outline, an 8 x 8 mm
    // block, is boxed in by four clamps 0.3 mm clear of the cutter on every side,
    // so no corridor on it survives, while the rectangle's bottom edge stays free.
    // The plan the preview shows (and Apply K accepts) is tabs on the rectangle
    // only; the cut and the posted program must be exactly that plan.
    installBoxedBlock()
    await generate()
    const s = suggest()
    const rect = s.loops.find((l) => l.loopId === 'outline')!, block = s.loops.find((l) => l.loopId === 'block')!
    expect(rect.fractions.length).toBeGreaterThan(0)
    expect(block.fractions).toEqual([])
    expect(s.found).toBeLessThan(s.requested)
    const outcome = store().applyContourTabSuggestions('setup-1', 'op-1', s)
    expect(outcome.ok).toBe(true)
    await expectAppliedTabsCutAndPosted(s)
    expect(outcome).toEqual({ ok: true, applied: rect.fractions.length, loopIds: ['outline'], noneLoopIds: ['block'] })
    const appliedMap = { outline: rect.fractions, block: 'none' }
    expect(op().params.tabLocations).toEqual(appliedMap)
    // The block's finish path (x -7..7, y 23..37) is cut at full depth all round.
    const topZ = op().contourTabPreview!.tabTopZ
    const onBlock = tabLiftMidpoints(op().toolpathMoves as ToolpathMove[], topZ).filter((p) => p.y > 17)
    expect(onBlock).toEqual([])

    // 'none' is an input of the result: dropping it is a different regeneration key.
    const st = store()
    const setup = st.project.setups[0]
    const withoutNone = { ...op(), params: { ...op().params, tabLocations: { outline: rect.fractions } } }
    expect(operationRegenerationInputsKey(st.project, setup, withoutNone, (id) => st.toolLibrary.find((t) => t.id === id)))
      .not.toBe(operationRegenerationInputsKey(st.project, setup, op(), (id) => st.toolLibrary.find((t) => t.id === id)))
    // A fresh Suggest leaves both outlines alone: neither is reseeded.
    expect(store().suggestContourTabLocations('setup-1', 'op-1')).toEqual({ ok: false, reason: 'all-hand-placed' })

    // Save and reopen keep 'none' (verbatim JSON), and the reopened cut has no block tabs.
    const file = buildProjectFileSnapshot(st.project, st.toolLibrary, st.toolLibraries, st.holders)
    expect((file.setups[0].operations[0].params as { tabLocations?: unknown }).tabLocations).toEqual(appliedMap)
    await st.loadProjectFromFile(JSON.stringify(file))
    expect(op().params.tabLocations).toEqual(appliedMap)
    await store().computeOperationToolpath(store().project.setups[0].id, op().id)
    expect(tabLiftMidpoints(op().toolpathMoves as ToolpathMove[], topZ).filter((p) => p.y > 17)).toEqual([])
    expect(tabLiftMidpoints(op().toolpathMoves as ToolpathMove[], topZ).length).toBeGreaterThanOrEqual(rect.fractions.length)
  })

  it('mixed Apply K: undo and redo restore the map with its none entry as one step', async () => {
    installBoxedBlock()
    await generate()
    const readyParams = JSON.stringify(op().params)
    const s = suggest()
    expect(store().applyContourTabSuggestions('setup-1', 'op-1', s).ok).toBe(true)
    const applied = JSON.stringify(op().params.tabLocations)
    expect(JSON.parse(applied).block).toBe('none')
    store().undo()
    expect(JSON.stringify(op().params)).toBe(readyParams)
    store().redo()
    expect(JSON.stringify(op().params.tabLocations)).toBe(applied)
  })

  it('undo and redo restore the map and the current/stale state as one step', async () => {
    install()
    await generate()
    const readyParams = JSON.stringify(op().params)
    const s = suggest()
    store().applyContourTabSuggestions('setup-1', 'op-1', s)
    const applied = JSON.stringify(op().params.tabLocations)
    store().undo()
    // History never keeps generated moves (pushHistory strips them), so the
    // undone operation is not current until it is generated again.
    expect(op().params.tabLocations).toBeUndefined()
    expect(JSON.stringify(op().params)).toBe(readyParams)
    expect(op().status).not.toBe('ready')
    store().redo()
    expect(JSON.stringify(op().params.tabLocations)).toBe(applied)
    expect(op().status).not.toBe('ready')
    // Undo again and regenerate: the same inputs suggest the same locations.
    store().undo()
    await generate()
    expect(op().params.tabLocations).toBeUndefined()
    expect(suggest().loops[0].fractions).toEqual(s.loops[0].fractions)
  })

  it('save and reopen keeps the applied map; the preview is not saved and is derived again', async () => {
    install()
    await generate()
    const s = suggest()
    store().applyContourTabSuggestions('setup-1', 'op-1', s)
    await generate()
    const st = store()
    const file = buildProjectFileSnapshot(st.project, st.toolLibrary, st.toolLibraries, st.holders)
    const fileOp = file.setups[0].operations[0]
    expect(fileOp.contourTabPreview).toBeUndefined()
    expect((fileOp.params as { tabLocations?: unknown }).tabLocations).toEqual({ outline: s.loops[0].fractions })
    await st.loadProjectFromFile(JSON.stringify(file))
    expect(op().params.tabLocations).toEqual({ outline: s.loops[0].fractions })
    // Reopened loops have hand locations now: Suggest leaves them alone.
    await store().computeOperationToolpath(store().project.setups[0].id, op().id)
    expect(store().suggestContourTabLocations(store().project.setups[0].id, op().id))
      .toEqual({ ok: false, reason: 'all-hand-placed' })
  })

  it('count override: a new tab count is suggested without regenerating', async () => {
    install()
    await generate()
    store().updateOperation('setup-1', 'op-1', { params: { ...op().params, tabCount: 3 } })
    const s = suggest()
    expect(s.requested).toBe(3)
    expect(s.found).toBe(3)
  })

  it('moved WCS, other tool, deleted source: the preview is stale and nothing is written', async () => {
    for (const change of [
      () => useCamStore.setState((st) => ({ project: { ...st.project, setups: st.project.setups.map((setup) => ({
        ...setup, wcs: { ...setup.wcs, origin: { ...setup.wcs.origin, x: setup.wcs.origin.x + 5 } } })) } })),
      () => useCamStore.setState((st) => ({ toolLibrary: st.toolLibrary.map((t) => ({ ...t, diameter: 4 })) })),
      () => useCamStore.setState((st) => ({ project: { ...st.project, geometry: [] } })),
    ]) {
      install()
      await generate()
      const s = suggest()
      change()
      const snapshot = JSON.stringify(op())
      expect(store().suggestContourTabLocations('setup-1', 'op-1')).toEqual({ ok: false, reason: 'stale' })
      expect(store().applyContourTabSuggestions('setup-1', 'op-1', s)).toEqual({ ok: false, reason: 'stale' })
      expect(JSON.stringify(op())).toBe(snapshot)
    }
  })

  it('a reviewed suggestion that no longer matches is recomputed, not written', async () => {
    install()
    await generate()
    const s = suggest()
    store().updateOperation('setup-1', 'op-1', { params: { ...op().params, tabWidth: 12 } })
    const snapshot = JSON.stringify(op())
    const outcome = store().applyContourTabSuggestions('setup-1', 'op-1', s)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('changed')
    expect(outcome.recomputed!.width).toBe(12)
    expect(JSON.stringify(op())).toBe(snapshot)
  })

  it('cancel: suggesting and walking away leaves the operation unchanged', async () => {
    install()
    await generate()
    const snapshot = JSON.stringify(store().project)
    suggest()
    expect(JSON.stringify(store().project)).toBe(snapshot)
  })

  it('left-hand tool: suggestions land on the same physical spans as the right-hand cut', async () => {
    install()
    await generate()
    const right = suggestedPoints(suggest())
    install({ tool: mill('left') })
    await generate()
    const leftPath = op().contourTabPreview!.loops[0].path
    const s = suggest()
    expect(s.found).toBe(6)
    const left = suggestedPoints(s)
    expect(leftPath).not.toEqual(undefined)
    for (const p of left) expect(near(p, right, 0.5)).toBe(true)
  })

  it('roughing, open and tabs-off contours get one line and no suggestion', async () => {
    install({ op: contourOp({}, { stockToLeave: 0.5, finishPasses: 1 }) })
    expect(store().suggestContourTabLocations('setup-1', 'op-1')).toEqual({ ok: false, reason: 'roughing' })
    install({ op: contourOp({ pathType: 'open' }) })
    expect(store().suggestContourTabLocations('setup-1', 'op-1')).toEqual({ ok: false, reason: 'open' })
    install({ op: contourOp({ tabs: false }) })
    expect(store().suggestContourTabLocations('setup-1', 'op-1')).toEqual({ ok: false, reason: 'tabs-off' })
    install()
    expect(store().suggestContourTabLocations('setup-1', 'op-1')).toEqual({ ok: false, reason: 'generate-first' })
  })

  // Recorded once with main's store (WO3220_RECORD_BASELINE=1, src/store and
  // src/types checked out from main); every later run must emit the same moves.
  it('even, disabled and hand-placed triangular seam-crossing tabs emit exactly the main baseline', async () => {
    const baselinePath = 'src/tests/evidence/WO-3220/legacy-baseline.json'
    const scenes: Record<string, Operation> = {
      even: contourOp(),
      disabled: contourOp({ tabs: false }),
      triangularSeam: contourOp({ tabShape: 'triangular', tabLocations: { outline: [0.001, 0.5] } }),
    }
    const emitted: Record<string, unknown> = {}
    for (const [name, scene] of Object.entries(scenes)) {
      install({ op: scene })
      await generate()
      emitted[name] = op().toolpathMoves
    }
    if (process.env.WO3220_RECORD_BASELINE === '1') writeFileSync(baselinePath, JSON.stringify(emitted))
    expect(existsSync(baselinePath)).toBe(true)
    expect(JSON.parse(JSON.stringify(emitted))).toEqual(JSON.parse(readFileSync(baselinePath, 'utf8')))
  })

  it('real DXF import: a notched plate with a hole, through importGeometryFile, is suggested, applied, cut and posted', async () => {
    install({ geometry: [], op: contourOp({ geometryId: 'not-imported-yet' }) })
    const geo = await importDxf('notched-plate.dxf', NOTCHED_PLATE_DXF)
    expect(geo.format).toBe('dxf')
    const loops = geo.loops ?? []
    expect(loops).toHaveLength(2)
    const outline = loops.find((l) => l.type === 'contour')!
    const hole = loops.find((l) => l.type === 'hole')!
    expect(outline.closed && hole.closed).toBe(true)
    bindOperationTo(geo.id, [outline.id])
    await generate()
    const s = await expectNotchSuggestionCut(outline.id)
    // The imported hole is a hole ring of the part (not a second target), and
    // no tab sits over the 0.1 mm web beside it.
    expect(s.loops.map((l) => l.loopId)).toEqual([outline.id])
    expect(Object.keys(s.loops[0].reasons)).toContain(`source-ring:${hole.id}`)
    for (const p of suggestedPoints(s)) if (p.y < 0) expect(Math.abs(p.x)).toBeGreaterThan(2)
    // Save/reopen keeps the applied map on the imported loop id.
    const st = store()
    const file = buildProjectFileSnapshot(st.project, st.toolLibrary, st.toolLibraries, st.holders)
    await st.loadProjectFromFile(JSON.stringify(file))
    expect(op().params.tabLocations).toEqual({ [outline.id]: s.loops[0].fractions })
  })

  it('model/mesh closed profile: a modeled body derives its outline, which is suggested, applied, cut and posted', async () => {
    install({ geometry: [modelBody('body', NOTCHED)], op: contourOp({ geometryId: 'body' }) })
    bindOperationTo('body', [])
    await generate()
    // The profile came off the body's mesh (deriveModelBodyProfile), not from stored loops.
    expect(store().project.geometry.find((g) => g.id === 'body')!.loops ?? []).toEqual([])
    const preview = op().contourTabPreview!
    expect(preview.loops).toHaveLength(1)
    const loopId = preview.loops[0].loopId
    const s = await expectNotchSuggestionCut(loopId)
    // The same physical spans as the identical outline drawn as curves.
    const meshPoints = suggestedPoints(s)
    install({ loops: [{ id: 'outline', points: NOTCHED }] })
    await generate()
    const curvePoints = suggestedPoints(suggest())
    expect(meshPoints).toHaveLength(curvePoints.length)
    for (const p of meshPoints) expect(near(p, curvePoints, 0.05)).toBe(true)
  })
})
