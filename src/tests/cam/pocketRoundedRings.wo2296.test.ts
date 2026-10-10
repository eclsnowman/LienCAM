// WO-2296: Pocket's Rounded ring corners through the production compute.
//
//   store.computeOperationToolpath -> real payload -> REAL toolpathWorker.ts
//   -> buildPocketToolpath -> the op's toolpathMoves + its cut-time estimate
//
// The only stand-in is the Worker thread (node has none): the shim hands each
// request to the real worker module in-process (as WO-1972 / WO-2291). The
// machine is Operator's (docs/machine/profiles/LienCNCV2.machine.json: 1000 mm/s^2,
// full stop over 89 deg, UCCNC line joining), so the estimate is the
// achievable-feed planner's, not distance / feed.
//
// Fixtures, 6 mm flat end mill: a 60 x 40 mm pocket (the New Operation defaults:
// inside-out, helix, Arc lead-in; and outside-in with Profile Ramp), the same with
// a square island, and Full Suite Test / Setup 1 / Pocket 2. Each runs off and on.
// On, against off:
//   - a heightmap simulation leaves no cell higher than off does (floor and walls),
//     and level by level the cut paths sweep every cell off sweeps there;
//   - ring corners are arcs (the wall ring keeps its corners: nothing outside it
//     takes what an arc there would skip);
//   - the cut-time estimate is lower;
//   - the Arc lead-in between rings is still emitted.
// Off (false) emits the very moves of an operation without the field.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'
import type {
  FixedStockItem, HeightParams, ImportedGeometry, LinkingParams, MachineConfig, Operation, PassParams,
  PhysicalStock, SceneStock, Setup, Tool, ToolpathMove, Vec2,
} from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => mem.get(k) ?? null,
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  },
  configurable: true,
})

const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../store')
const { smartHeightAuthorityFixture } = await import('../helpers/smartHeightAuthorityFixture')
const { HeightmapSimulator } = await import('../../lib/simulation/HeightmapSimulator')
const { sampleArcMovesForLinearConsumers } = await import('../../lib/cam/toolpathArcSampling')

type Handler = ((event: { data: unknown }) => void) | null
const g = globalThis as unknown as {
  window?: Record<string, unknown>
  self: { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => unknown) | null }
  Worker: unknown
}
let activeShim: { onmessage: Handler } | null = null
if (g.window === undefined) g.window = {}
g.window.__cncViewport = {
  getStockBounds: (stockId?: string) => {
    const project = useCamStore.getState().project
    const setup = project.setups[0]
    return smartHeightStockBounds(project, stockId ?? setupProvenStockId(setup, project)!)
  },
}
g.self = { postMessage: (m: unknown) => { activeShim?.onmessage?.({ data: m }) }, onmessage: null }
await import('../../lib/cam/toolpathWorker')
const workerSelf = g.self
g.Worker = class {
  onmessage: Handler = null
  onerror: Handler = null
  postMessage(data: unknown) { activeShim = this; void workerSelf.onmessage?.({ data }) }
  terminate() { activeShim = null }
}

const ericsMachine = (): MachineConfig =>
  JSON.parse(readFileSync(join(process.cwd(), 'docs/machine/profiles/LienCNCV2.machine.json'), 'utf8'))

// ── Rectangle fixtures ──────────────────────────────────────────────────────────

type LoopData = NonNullable<ImportedGeometry['loops']>[number]
const R = 3
const FEED = 1000
const STEPOVER = 2.4
const heights: HeightParams = {
  clearanceHeight: 25, clearanceHeightMode: 'absolute', retractHeight: 17, feedHeight: 13,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -4, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 2, stepover: STEPOVER, stockToLeave: 0, finishPasses: 1, springPasses: 0 }

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
const POCKET = rect(10, 10, 70, 50)
const ISLAND = rect(33, 23, 47, 37)

function tool(): Tool {
  return {
    id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
    diameter: 2 * R, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: FEED, plungeRate: 300, depthOfCut: 2, stepover: STEPOVER } },
  } as unknown as Tool
}

function geometry(withIsland: boolean): ImportedGeometry {
  const loops = [{ id: 'pocket', layerId: 'L1', closed: true, type: 'contour', area: 2400, points: POCKET } as LoopData]
  if (withIsland) loops.push({ id: 'island', layerId: 'L1', closed: true, type: 'hole', area: 196, points: ISLAND } as LoopData)
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 60, z: 0 },
      size: { x: 80, y: 60, z: 0 }, center: { x: 40, y: 30, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, loops,
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as ImportedGeometry
}

type Rounded = boolean | undefined
function pocketOp(round: Rounded, fill: 'outside_in' | 'inside_out'): Operation {
  // The New Operation defaults (by region, Arc lead-in, overlap 1, finish contour).
  const params: Record<string, unknown> = {
    geometryId: 'geo-1', loopIds: [], direction: 'climb', orderStrategy: 'by_region',
    fillStrategy: fill, floorStockToLeave: 0, finishContour: true,
    helixDiameter: 90, overlapMm: 1, stepoverLeadIn: 'arc', stayDown: false, stayDownLift: 1,
  }
  if (round !== undefined) params.roundRingCorners = round
  const linking = {
    entryType: fill === 'outside_in' ? 'ramp_linear' : 'ramp_helical', rampAngle: 3, rampLength: 0,
    leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
  } as LinkingParams
  return {
    id: 'op-pocket', name: 'Pocket', type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', { setupId: 'setup-1', heights, params, geometryIds: ['geo-1'] }),
  } as unknown as Operation
}

function installRect(op: Operation, withIsland: boolean): void {
  const stock: FixedStockItem = { id: 'stock-1', name: 'Stock', width: 120, height: 100, depth: 12, position: { x: -20, y: -20, z: 0 } }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 120, fixedHeight: 100, fixedDepth: 12, fixedStocks: [stock],
  }
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: { min: { x: -20, y: -20, z: 0 }, max: { x: 100, y: 80, z: 12 }, size: { x: 120, y: 100, z: 12 }, center: { x: 40, y: 30, z: 6 } },
    position: { x: -20, y: -20, z: 0 },
  }
  const setup: Setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: stock.id,
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' } as Setup['stock'],
    operations: [op], notes: '',
  } as Setup
  useCamStore.setState(s => ({
    project: {
      ...s.project, machine: ericsMachine(),
      geometry: [{ ...geometry(withIsland), stockId: stock.id }],
      setups: [setup], sceneStock, stocks: [physicalStock],
      activeSetupId: 'setup-1', activeOperationId: op.id, toolLibrary: [tool()],
    },
    toolLibrary: [tool()], toolpathBatch: null, consoleEvents: [],
  }))
}

interface Run { moves: ToolpathMove[]; estimateMs: number; radius: number }

async function computeOp(setupId: string, opId: string): Promise<Run> {
  await useCamStore.getState().computeOperationToolpath(setupId, opId)
  const project = useCamStore.getState().project
  const setup = project.setups.find(s => s.id === setupId)!
  const done = setup.operations.find(o => o.id === opId) as Operation & { estimatedCutTimeMs?: number; toolpathMoves?: ToolpathMove[] }
  expect(done.status, done.errorMessage).toBe('ready')
  const t = project.toolLibrary.find(x => x.id === done.toolId)!
  return { moves: done.toolpathMoves ?? [], estimateMs: done.estimatedCutTimeMs ?? NaN, radius: t.diameter / 2 }
}

async function runRect(round: Rounded, fill: 'outside_in' | 'inside_out', withIsland: boolean): Promise<Run> {
  const op = pocketOp(round, fill)
  installRect(op, withIsland)
  return computeOp('setup-1', op.id)
}

// Full Suite Test / Setup 1 / Pocket 2, after its Adaptive (the rest stock it runs on).
let fullSuiteText = ''
async function runFullSuite(round: Rounded): Promise<Run> {
  await useCamStore.getState().loadProjectFromFile(fullSuiteText)
  useCamStore.setState(s => ({ project: { ...s.project, machine: ericsMachine() } }))
  const setup = useCamStore.getState().project.setups[0]
  const pocket = setup.operations.find(o => o.name === 'Pocket 2')!
  if (round !== undefined) {
    useCamStore.getState().updateOperation(setup.id, pocket.id, {
      params: { ...(pocket.params as object), roundRingCorners: round },
    } as Partial<Operation>)
  }
  return computeOp(setup.id, pocket.id)
}

// ── Readers ─────────────────────────────────────────────────────────────────────

/** Production heightmap simulation of a run, 0.1 mm cells, every 0.05 mm of path. */
function simulate(moves: ToolpathMove[], R: number, box: { x0: number; y0: number; x1: number; y1: number }, top: number) {
  const sim = new HeightmapSimulator(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, top, top - 100, 0.1)
  const lin = sampleArcMovesForLinearConsumers(moves)
  for (let i = 1; i < lin.length; i++) {
    const a = lin[i - 1], b = lin[i]
    if (a.type === 'rapid' && b.type === 'rapid') continue
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    const n = Math.max(1, Math.ceil(len / 0.05))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      if (b.type === 'rapid') continue
      sim.carve(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, R)
    }
  }
  return sim.heights
}

function boxOf(moves: ToolpathMove[], R: number) {
  const cut = moves.filter(m => m.type !== 'rapid')
  return {
    x0: Math.min(...cut.map(m => m.x)) - R - 1, y0: Math.min(...cut.map(m => m.y)) - R - 1,
    x1: Math.max(...cut.map(m => m.x)) + R + 1, y1: Math.max(...cut.map(m => m.y)) + R + 1,
  }
}

/** Cells left higher by `on` than by `off`. */
function higherCells(off: Run, on: Run, top: number): { cells: number; worstMm: number } {
  const box = boxOf(off.moves, off.radius)
  const a = simulate(off.moves, off.radius, box, top)
  const b = simulate(on.moves, on.radius, box, top)
  let cells = 0, worst = 0
  for (let i = 0; i < a.length; i++) {
    const d = b[i] - a[i]
    if (d > 1e-4) { cells++; worst = Math.max(worst, d) }
  }
  return { cells, worstMm: worst }
}

/**
 * Level by level: cells (0.1 mm) within one tool radius of the horizontal feed
 * moves at each Z that `off` sweeps and `on` does not. The heightmap above cannot
 * see a level's walls once a deeper pass (the finish contour at final depth) cuts
 * the column, so each level is checked on its own.
 */
function levelMisses(off: Run, on: Run): { cells: number; levels: number } {
  const R = off.radius, h = 0.1
  const box = boxOf(off.moves, R)
  const nx = Math.ceil((box.x1 - box.x0) / h) + 1, ny = Math.ceil((box.y1 - box.y0) / h) + 1
  const byLevel = (moves: ToolpathMove[]) => {
    const lin = sampleArcMovesForLinearConsumers(moves)
    const out = new Map<number, Array<[ToolpathMove, ToolpathMove]>>()
    for (let i = 1; i < lin.length; i++) {
      const a = lin[i - 1], b = lin[i]
      if (b.type === 'rapid' || Math.abs(a.z - b.z) > 1e-6) continue
      const z = +b.z.toFixed(4)
      out.set(z, [...(out.get(z) ?? []), [a, b]])
    }
    return out
  }
  const stamp = (segs: Array<[ToolpathMove, ToolpathMove]>, reach: number) => {
    const grid = new Uint8Array(nx * ny)
    for (const [a, b] of segs) {
      const dx = b.x - a.x, dy = b.y - a.y, lenSq = dx * dx + dy * dy
      const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - box.x0) / h))
      const ix1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + reach - box.x0) / h))
      const iy0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - reach - box.y0) / h))
      const iy1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, b.y) + reach - box.y0) / h))
      for (let iy = iy0; iy <= iy1; iy++) {
        const y = box.y0 + iy * h
        for (let ix = ix0; ix <= ix1; ix++) {
          const x = box.x0 + ix * h
          let t = lenSq < 1e-18 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / lenSq
          t = t < 0 ? 0 : t > 1 ? 1 : t
          if (Math.hypot(a.x + t * dx - x, a.y + t * dy - y) <= reach) grid[iy * nx + ix] = 1
        }
      }
    }
    return grid
  }
  const offLevels = byLevel(off.moves), onLevels = byLevel(on.moves)
  let cells = 0
  for (const [z, segs] of offLevels) {
    const a = stamp(segs, R)
    const b = stamp(onLevels.get(z) ?? [], R + 1e-6)
    for (let i = 0; i < a.length; i++) if (a[i] && !b[i]) cells++
  }
  return { cells, levels: offLevels.size }
}

/** Cut vertices (between two horizontal cut moves at one Z) turning more than `deg`. */
function sharpCutVertices(moves: ToolpathMove[], deg: number): number {
  let n = 0
  for (let i = 1; i + 1 < moves.length; i++) {
    const a = moves[i - 1], b = moves[i], c = moves[i + 1]
    if (b.role !== 'cut' || c.role !== 'cut' || b.type !== 'feed' || c.type !== 'feed') continue
    if (Math.abs(a.z - b.z) > 1e-6 || Math.abs(b.z - c.z) > 1e-6) continue
    const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y
    if (Math.hypot(ax, ay) < 1e-6 || Math.hypot(bx, by) < 1e-6) continue
    const turn = Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by) * 180 / Math.PI
    if (turn > deg) n++
  }
  return n
}

/** Runs of 'stepover' feed moves at least `min` long: the Arc lead-in's S-curves. */
function arcLeadIns(moves: ToolpathMove[], min = 6): number {
  let runs = 0, len = 0
  for (const m of moves) {
    if (m.type === 'feed' && m.role === 'stepover') { len++; continue }
    if (len >= min) runs++
    len = 0
  }
  return runs
}

const levelsOf = (moves: ToolpathMove[]) =>
  [...new Set(moves.filter(m => m.role === 'cut').map(m => +m.z.toFixed(3)))].length

// ── Runs ────────────────────────────────────────────────────────────────────────

const runs: Record<string, { off: Run; on: Run; absent?: Run; top: number }> = {}

beforeAll(async () => {
  fullSuiteText = readFileSync(join(process.cwd(), 'Example Projects/Full Suite.camproject'), 'utf8')
  runs.rect = { absent: await runRect(undefined, 'inside_out', false), off: await runRect(false, 'inside_out', false), on: await runRect(true, 'inside_out', false), top: 0 }
  runs.rectRamp = { off: await runRect(false, 'outside_in', false), on: await runRect(true, 'outside_in', false), top: 0 }
  runs.island = { off: await runRect(false, 'inside_out', true), on: await runRect(true, 'inside_out', true), top: 0 }
  const fsAbsent = await runFullSuite(undefined)
  const fsOn = await runFullSuite(true)
  const fsTop = Math.max(...fsAbsent.moves.map(m => m.z))
  runs.fullSuite = { off: fsAbsent, on: fsOn, top: fsTop }
  console.info('[WO-2296]', JSON.stringify(Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, {
    moves: [r.off.moves.length, r.on.moves.length],
    estimateS: [+(r.off.estimateMs / 1000).toFixed(2), +(r.on.estimateMs / 1000).toFixed(2)],
    sharpVertices: [sharpCutVertices(r.off.moves, 30), sharpCutVertices(r.on.moves, 30)],
    corners5deg: [sharpCutVertices(r.off.moves, 5), sharpCutVertices(r.on.moves, 5)],
    arcLeadIns: [arcLeadIns(r.off.moves), arcLeadIns(r.on.moves)],
    levels: levelsOf(r.off.moves),
  }]))))
}, 600_000)

describe('WO-2296: off is byte-identical', () => {
  it('roundRingCorners false emits the very moves of an operation without the field', () => {
    expect(JSON.stringify(runs.rect.off.moves)).toBe(JSON.stringify(runs.rect.absent!.moves))
    expect(runs.rect.off.estimateMs).toBe(runs.rect.absent!.estimateMs)
  })
})

describe.each(['rect', 'rectRamp', 'island', 'fullSuite'])('WO-2296: Rounded ring corners on - %s', (name) => {
  it('leaves no heightmap cell higher than the sharp rings do (floor and walls)', () => {
    const r = runs[name]
    const higher = higherCells(r.off, r.on, r.top)
    expect(higher, JSON.stringify(higher)).toEqual({ cells: 0, worstMm: 0 })
  })

  it('sweeps at every level everything the sharp rings sweep there', () => {
    const r = runs[name]
    const misses = levelMisses(r.off, r.on)
    expect(misses.levels).toBeGreaterThan(1)
    expect(misses.cells).toBe(0)
  })

  it('takes ring corners as arcs: fewer cut vertices turning more than a curve sample (5 deg)', () => {
    const r = runs[name]
    expect(sharpCutVertices(r.on.moves, 5)).toBeLessThan(sharpCutVertices(r.off.moves, 5))
  })

  it('runs faster on the machine (achievable-feed estimate)', () => {
    const r = runs[name]
    expect(r.on.estimateMs).toBeLessThan(r.off.estimateMs)
  })

  it('still steps ring to ring with the Arc lead-in', () => {
    const r = runs[name]
    expect(arcLeadIns(r.on.moves)).toBeGreaterThan(0)
    expect(arcLeadIns(r.on.moves)).toBeGreaterThanOrEqual(arcLeadIns(r.off.moves) * 0.8)
  })
})

describe('WO-2296: the 60 x 40 pocket in detail', () => {
  it('keeps only the wall ring\'s corners (and the 0.4 mm-wide centre ring\'s) sharp; every other ring corner is an arc', () => {
    for (const r of [runs.rect, runs.rectRamp]) {
      const levels = levelsOf(r.on.moves)
      // Per level: the wall ring (4) and the innermost ring, a 20.4 x 0.4 mm sliver
      // with no room for an arc (4); then the finish contour at the last level (4).
      expect(sharpCutVertices(r.on.moves, 30)).toBeLessThanOrEqual(levels * 8 + 4)
      // Sharp, every one of the eight rings has four at every level.
      expect(sharpCutVertices(r.off.moves, 30)).toBeGreaterThanOrEqual(levels * 4 * 8)
    }
  })
})
