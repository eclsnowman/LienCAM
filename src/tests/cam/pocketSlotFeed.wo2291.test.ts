// WO-2291: Pocket slows the feed where it cuts full width, through the production
// compute and the production post.
//
//   store.computeOperationToolpath -> real payload -> REAL toolpathWorker.ts
//   -> buildPocketToolpath -> the op's toolpathMoves (+ its cut-time estimate)
//   -> postProject(UCCNC_CONFIG) -> the posted G-code's F words
//
// The only stand-in is the Worker thread (node has none): the stub hands each request
// to the real worker module in-process (same harness as cornerReliefOperations.wo2287).
//
// Fixture: a 60 x 40 mm rectangular pocket, 6 mm flat end mill (cutting feed 1000),
// stepover 2.4 mm (40%), outside-in with Profile Ramp - the outside-in entries are
// Profile Ramp or Plunge; Helix belongs to inside-out, which is checked too.

import { beforeAll, describe, expect, it } from 'vitest'
import { useCamStore } from '../../store'
import { UCCNC_CONFIG } from '../../lib/post'
import { postProject } from '../../lib/post/postProject'
import { createMachiningRecipe, deserializeRecipe, serializeRecipe } from '../../lib/recipes/recipeModel'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  FixedStockItem, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  SceneStock, Setup, Tool, ToolpathMove, Vec2,
} from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

// ── The worker wire: real toolpathWorker.ts, in-process ─────────────────────────────

type WorkerSelf = {
  postMessage: (msg: WorkerResponseMsg) => void
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let deliver: ((msg: WorkerResponseMsg) => void) | null = null
const workerSelf: WorkerSelf = { postMessage: (msg) => { deliver?.(msg) }, onmessage: null }

class InProcessToolpathWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { /* the real module is already loaded */ }
  postMessage(request: WorkerRequestMsg): void {
    deliver = (msg) => this.onmessage?.({ data: msg })
    void workerSelf.onmessage!({ data: request })
  }
  terminate(): void { /* no thread to stop */ }
}

// ── Scene ───────────────────────────────────────────────────────────────────────────

type LoopData = NonNullable<ImportedGeometry['loops']>[number]

const R = 3
const FEED = 1000
const STEPOVER = 2.4
const heights: HeightParams = {
  clearanceHeight: 25, clearanceHeightMode: 'absolute',
  retractHeight: 17, feedHeight: 13,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -4, bottomHeightMode: 'absolute',
}

function linking(entryType: 'ramp_linear' | 'ramp_helical'): LinkingParams {
  return {
    entryType, rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
    retractType: 'full', transitionType: 'safe_height',
  } as LinkingParams
}

function tool(): Tool {
  return {
    id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
    diameter: 2 * R, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: FEED, plungeRate: 300, depthOfCut: 2, stepover: STEPOVER } },
  } as unknown as Tool
}

const POCKET_RECT: Vec2[] = [{ x: 10, y: 10 }, { x: 70, y: 10 }, { x: 70, y: 50 }, { x: 10, y: 50 }]

// A round pocket (r 20 about 40, 30): its rings post as G2/G3 arcs.
const POCKET_ROUND: Vec2[] = Array.from({ length: 180 }, (_, k) => ({
  x: 40 + 20 * Math.cos((2 * Math.PI * k) / 180), y: 30 + 20 * Math.sin((2 * Math.PI * k) / 180),
}))

function geometry(points: Vec2[]): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 80, y: 60, z: 0 },
      size: { x: 80, y: 60, z: 0 }, center: { x: 40, y: 30, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [{ id: 'pocket', layerId: 'L1', closed: true, type: 'contour', area: 2400, points } as LoopData],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as ImportedGeometry
}

const passes: PassParams = { stepdown: 2, stepover: STEPOVER, stockToLeave: 0, finishPasses: 1, springPasses: 0 }

function pocketOp(slotFeedPercent: number | undefined, fill: 'outside_in' | 'inside_out' = 'outside_in'): Operation {
  const params: Record<string, unknown> = {
    geometryId: 'geo-1', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
    fillStrategy: fill, floorStockToLeave: 0, finishContour: true,
    helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1,
  }
  if (slotFeedPercent !== undefined) params.slotFeedPercent = slotFeedPercent
  const link = linking(fill === 'outside_in' ? 'ramp_linear' : 'ramp_helical')
  return {
    id: 'op-pocket', name: 'Slot feed pocket', type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking: link, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', { setupId: 'setup-1', heights, params, geometryIds: ['geo-1'] }),
  } as unknown as Operation
}

function install(op: Operation, points: Vec2[]): void {
  const stock: FixedStockItem = {
    id: 'stock-1', name: 'Stock', width: 120, height: 100, depth: 12, position: { x: -20, y: -20, z: 0 },
  }
  const sceneStock: SceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: 120, fixedHeight: 100, fixedDepth: 12, fixedStocks: [stock],
  }
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: -20, y: -20, z: 0 }, max: { x: 100, y: 80, z: 12 },
      size: { x: 120, y: 100, z: 12 }, center: { x: 40, y: 30, z: 6 },
    },
    position: { x: -20, y: -20, z: 0 },
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
      geometry: [{ ...geometry(points), stockId: stock.id }],
      setups: [setup],
      sceneStock,
      stocks: [physicalStock],
      activeSetupId: 'setup-1',
      activeOperationId: op.id,
      toolLibrary: [tool()],
    },
    toolLibrary: [tool()],
    toolpathBatch: null,
    consoleEvents: [],
  }))
}

interface Run {
  moves: ToolpathMove[]
  estimateMs: number
  gcode: string[]
}

async function run(op: Operation, points: Vec2[] = POCKET_RECT): Promise<Run> {
  install(op, points)
  await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
  const project = useCamStore.getState().project
  const done = project.setups[0].operations[0] as Operation & { estimatedCutTimeMs?: number }
  expect(done.status, done.errorMessage).toBe('ready')
  const posted = postProject(project, [project.setups[0]], UCCNC_CONFIG, {
    mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2291', ext: 'nc',
    selectedOpIds: { 'setup-1': [op.id] },
  })
  expect(posted.diagnostics.filter(d => d.level === 'error')).toEqual([])
  const result = posted.files![0].result
  const lines = result.gcode.split('\n')
  const span = result.operationSpans!.find(s => s.opId === op.id)!
  return {
    moves: done.toolpathMoves ?? [],
    estimateMs: done.estimatedCutTimeMs ?? NaN,
    gcode: lines.slice(span.startLine - 1, span.endLine),
  }
}

// ── Readers ─────────────────────────────────────────────────────────────────────────

/** Horizontal cut moves with their start point. */
function cutSegments(moves: readonly ToolpathMove[]): Array<{ a: ToolpathMove; b: ToolpathMove; index: number }> {
  const out: Array<{ a: ToolpathMove; b: ToolpathMove; index: number }> = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (b.type === 'feed' && b.role === 'cut' && Math.abs(a.z - b.z) < 1e-6) out.push({ a, b, index: i })
  }
  return out
}

/** Each level's first at-depth lap: the move indices of the cuts straight after a Profile Ramp. */
function firstLaps(moves: readonly ToolpathMove[]): number[][] {
  const laps: number[][] = []
  for (let r = 0; r < moves.length; r++) {
    if (moves[r].role !== 'ramp' || moves[r + 1]?.role === 'ramp') continue
    const lap: number[] = []
    for (let i = r + 1; i < moves.length && moves[i].role === 'cut'; i++) lap.push(i)
    laps.push(lap)
  }
  return laps
}

/** Share of a run of moves' length (each from its predecessor) that runs at `feed`. */
function shareAt(moves: readonly ToolpathMove[], indices: readonly number[], feed: number): number {
  let length = 0, at = 0
  for (const i of indices) {
    const d = Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y)
    length += d
    if (moves[i].feed === feed) at += d
  }
  return at / length
}

/** Posted motion: [code, F in force, x, y, z] for every G1/G2/G3 line. */
interface PostedMotion { g: string; f: number; xy: boolean; z: boolean }
function postedMotion(lines: readonly string[]): PostedMotion[] {
  const out: PostedMotion[] = []
  let g = ''
  let f = NaN
  for (const line of lines) {
    const code = line.replace(/\(.*?\)/g, '').trim()
    const gm = /\bG0?([0-3])\b/.exec(code)
    if (gm) g = `G${gm[1]}`
    const fm = /\bF(-?[\d.]+)/.exec(code)
    if (fm) f = Number(fm[1])
    const xy = /\b[XY]-?[\d.]/.test(code)
    const z = /\bZ-?[\d.]/.test(code)
    if ((xy || z) && (g === 'G1' || g === 'G2' || g === 'G3')) out.push({ g, f, xy, z })
  }
  return out
}

// ── Runs ────────────────────────────────────────────────────────────────────────────

const ORIGINAL_WORKER = globalThis.Worker
let absent: Run, full: Run, half: Run, helixAbsent: Run, helixHalf: Run, roundAbsent: Run, roundHalf: Run

beforeAll(async () => {
  ;(globalThis as { Worker: unknown }).Worker = InProcessToolpathWorker
  ;(globalThis as { self: unknown }).self = workerSelf
  await import('../../lib/cam/toolpathWorker')
  absent = await run(pocketOp(undefined))
  full = await run(pocketOp(100))
  half = await run(pocketOp(50))
  helixAbsent = await run(pocketOp(undefined, 'inside_out'))
  helixHalf = await run(pocketOp(50, 'inside_out'))
  roundAbsent = await run(pocketOp(undefined), POCKET_ROUND)
  roundHalf = await run(pocketOp(50), POCKET_ROUND)
  ;(globalThis as { Worker: unknown }).Worker = ORIGINAL_WORKER
  const feeds = (r: Run) => [...new Set(r.moves.filter(m => m.role === 'cut').map(m => m.feed))].sort((a, b) => a! - b!)
  console.info('[WO-2291]', JSON.stringify({
    absent: { moves: absent.moves.length, estimateMs: absent.estimateMs, posted: postedMotion(absent.gcode).length },
    half: {
      moves: half.moves.length, estimateMs: half.estimateMs, posted: postedMotion(half.gcode).length,
      cutFeeds: feeds(half),
    },
    helixHalf: { moves: helixHalf.moves.length, estimateMs: helixHalf.estimateMs, cutFeeds: feeds(helixHalf) },
    round: {
      absentPosted: postedMotion(roundAbsent.gcode).length, halfPosted: postedMotion(roundHalf.gcode).length,
      absentArcs: postedMotion(roundAbsent.gcode).filter(m => m.g !== 'G1').length,
      halfArcs: postedMotion(roundHalf.gcode).filter(m => m.g !== 'G1').length,
      halfCutFeeds: feeds(roundHalf),
    },
  }))
}, 120_000)

describe('WO-2291: Slot feed 100% (and absent) changes nothing', () => {
  it('100% emits the very moves and file of an operation without the field', () => {
    expect(JSON.stringify(full.moves)).toBe(JSON.stringify(absent.moves))
    expect(full.gcode.join('\n')).toBe(absent.gcode.join('\n'))
    expect(full.estimateMs).toBe(absent.estimateMs)
  })

  it('without the field every cut runs at the cutting feed', () => {
    for (const { b } of cutSegments(absent.moves)) expect(b.feed).toBe(FEED)
  })
})

describe('WO-2291: Slot feed 50% on the 60 x 40 pocket', () => {
  it('runs the first ring after entry at 50% of the cutting feed, at every level', () => {
    const laps = firstLaps(half.moves)
    expect(laps.length).toBeGreaterThan(1)
    for (const lap of laps) {
      expect(lap.length).toBeGreaterThan(20)
      expect(half.moves[lap[0]].feed).toBe(FEED / 2)
      // The lap meets its own start at the end; until then it is a full-width slot.
      expect(shareAt(half.moves, lap, FEED / 2)).toBeGreaterThan(0.9)
    }
    // Without the setting the same laps ran at full feed.
    for (const lap of firstLaps(absent.moves)) expect(shareAt(absent.moves, lap, FEED)).toBe(1)
  })

  it('runs the interior rings at 100%: going outside-in, a ring corner is an outside corner of the stock left', () => {
    const inLap = new Set(firstLaps(half.moves).flat())
    const interior = cutSegments(half.moves).filter(({ index }) => !inLap.has(index))
    expect(interior.length).toBeGreaterThan(1000)
    for (const { b } of interior) expect(b.feed).toBe(FEED)
    // Ring 2 sits r + stepover in from the wall: its long bottom edge is y = 15.4.
    const ring2 = interior.filter(({ a, b }) => Math.abs(a.y - 15.4) < 1e-6 && Math.abs(b.y - 15.4) < 1e-6)
    expect(ring2.length).toBeGreaterThan(10)
  })

  it('keeps every cut move within [50%, 100%] and every other feed unchanged', () => {
    expect(half.moves.length).toBeGreaterThanOrEqual(absent.moves.length)
    for (const { b } of cutSegments(half.moves)) {
      expect(b.feed!).toBeGreaterThanOrEqual(FEED / 2)
      expect(b.feed!).toBeLessThanOrEqual(FEED)
    }
    const others = (moves: readonly ToolpathMove[]) => moves.filter(m => m.role !== 'cut').map(m => `${m.type}|${m.role}|${m.feed}|${m.x}|${m.y}|${m.z}`)
    expect(others(half.moves)).toEqual(others(absent.moves))
  })

  it('posts the slower feeds as F words, none outside [50%, 100%] on XY cuts', () => {
    const motion = postedMotion(half.gcode)
    const xyCutFeeds = new Set(motion.filter(m => m.xy && !m.z).map(m => m.f))
    expect(xyCutFeeds.has(FEED / 2)).toBe(true)
    expect(xyCutFeeds.has(FEED)).toBe(true)
    const absentXyFeeds = new Set(postedMotion(absent.gcode).filter(m => m.xy && !m.z).map(m => m.f))
    for (const f of xyCutFeeds) {
      if (absentXyFeeds.has(f)) continue
      expect(f).toBeGreaterThanOrEqual(FEED / 2)
      expect(f).toBeLessThanOrEqual(FEED)
    }
  })

  it('still collapses the slow and full runs (the post joins equal feeds)', () => {
    const halfPosted = postedMotion(half.gcode).length
    const absentPosted = postedMotion(absent.gcode).length
    // Each ring edge posts as one line whatever its feed: only the lap ends add lines.
    expect(halfPosted).toBeLessThan(half.moves.length / 3)
    expect(halfPosted).toBeLessThan(absentPosted * 1.2)
  })

  it('still fits arcs on a round pocket, on the slow first lap and the full-feed rings', () => {
    const arcs = (r: Run) => postedMotion(r.gcode).filter(m => m.g === 'G2' || m.g === 'G3')
    const halfArcs = arcs(roundHalf)
    expect(halfArcs.some(m => m.f === FEED / 2)).toBe(true)
    expect(halfArcs.some(m => m.f === FEED)).toBe(true)
    // The arc count barely moves: a slow run is one more arc, not a shatter into lines.
    expect(halfArcs.length).toBeGreaterThanOrEqual(arcs(roundAbsent).length)
    expect(halfArcs.length).toBeLessThan(arcs(roundAbsent).length * 1.5)
    expect(postedMotion(roundHalf.gcode).length).toBeLessThan(postedMotion(roundAbsent.gcode).length * 1.5)
  })

  it('raises the cut-time estimate', () => {
    expect(Number.isFinite(half.estimateMs)).toBe(true)
    expect(half.estimateMs).toBeGreaterThan(absent.estimateMs)
  })
})

describe('WO-2291: Slot feed 50% with inside-out and Helix', () => {
  it('slows the first ring after the helix and keeps every cut within [50%, 100%]', () => {
    const cuts = cutSegments(helixHalf.moves)
    for (const { b } of cuts) {
      expect(b.feed!).toBeGreaterThanOrEqual(FEED / 2)
      expect(b.feed!).toBeLessThanOrEqual(FEED)
    }
    const lastHelix = helixHalf.moves.findIndex((m, i) => m.role === 'helix' && helixHalf.moves[i + 1]?.role !== 'helix')
    const firstCut = cuts.find(c => c.index > lastHelix)!
    expect(firstCut.b.feed!).toBeLessThan(FEED)
    expect(cuts.some(c => c.b.feed === FEED)).toBe(true)
    expect(helixHalf.estimateMs).toBeGreaterThan(helixAbsent.estimateMs)
  })

  it('slows into each ring corner, where engagement rises above the stepover, and nowhere mid-edge', () => {
    const cuts = cutSegments(helixHalf.moves)
    // Ring corners: where the cut direction turns by more than 45 deg.
    const corners: Vec2[] = []
    for (let k = 1; k < cuts.length; k++) {
      const p = cuts[k - 1], c = cuts[k]
      if (c.index !== p.index + 1) continue
      const u = { x: p.b.x - p.a.x, y: p.b.y - p.a.y }, v = { x: c.b.x - c.a.x, y: c.b.y - c.a.y }
      const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))
      if (cos < Math.SQRT1_2) corners.push({ x: c.a.x, y: c.a.y })
    }
    const reduced = cuts.filter(({ b }) => b.feed! < FEED)
    expect(reduced.length).toBeGreaterThan(50)
    // Every slowed move ends within two tool diameters of a ring corner.
    for (const { b } of reduced) {
      const near = Math.min(...corners.map(c => Math.hypot(c.x - b.x, c.y - b.y)))
      expect(near).toBeLessThanOrEqual(4 * R + 1e-6)
    }
    // The 50% runs reach the corner itself: the move ending at a ring corner is slowest.
    const atCorner = reduced.filter(({ b }) => corners.some(c => Math.hypot(c.x - b.x, c.y - b.y) < 1e-6))
    expect(atCorner.length).toBeGreaterThan(20)
    expect(atCorner.filter(({ b }) => b.feed === FEED / 2).length / atCorner.length).toBeGreaterThan(0.8)
    // And the long straights between corners stay at full feed.
    expect(shareAt(helixHalf.moves, cuts.map(c => c.index), FEED)).toBeGreaterThan(0.6)
  })
})

describe('WO-2291: recipes carry the Slot feed', () => {
  it('round-trips slotFeedPercent through a saved recipe', () => {
    const recipe = createMachiningRecipe('Slot feed', [pocketOp(40), pocketOp(undefined)], [tool()])
    const loaded = deserializeRecipe(serializeRecipe(recipe))
    expect(loaded.operations.map(o => (o.params as { slotFeedPercent?: number }).slotFeedPercent)).toEqual([40, undefined])
  })
})
