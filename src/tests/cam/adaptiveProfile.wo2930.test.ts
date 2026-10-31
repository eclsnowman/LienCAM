// WO-2930 measurement round: where does Adaptive Clearing 2D spend its time?
//
// Operator, 2026-10-27: "looking at where the computation takes time, finding ways
// to optomize it ... This is the longest calculation for our sample projects and
// will only get worse as user parts get larger."
//
// Every adaptive_clearing_2d operation in the shipped projects is opened through
// the store (loadProjectFromFile) and generated through the production entry
// (computeOperationToolpath -> the REAL toolpathWorker.ts, in-process; node has
// no Worker threads, so only the postMessage wire is a shim). Each operation is
// generated twice: COLD (its first generate in this process) and WARM (again,
// at once). The worker's own progress messages give the phase timeline; the
// TOOLPATH_COMPLETE message gives the worker's computeTimeMs; a SHA-256 of the
// moves is the byte-identical oracle the implementation round must keep.
//
// This test RECORDS timings. It asserts nothing about speed: it asserts only
// that the corpus is the one measured and that every generate settled.
//
// WO-2930 implementation round (exact speed-ups 1 and 2 of profile-summary.md): each
// generate also records two deterministic work counters - vertices marshalled across
// the JS/WASM boundary (clipperEngine) and column cells the reach trim visited
// (holderClearance). The fast block at the end proves both speed-ups on those
// counters, with live oracles for identical results; it never asserts wall time.
//
//   npx vitest run src/tests/cam/adaptiveProfile.wo2930.test.ts
//   WRITE_EVIDENCE=1 ...     writes src/tests/evidence/WO-2930/profile-timings.json
//   WO2930_CPU_PROFILE=1 ... also CPU-profiles the WARM generate of the three
//                            slowest operations (V8 profiler via node:inspector,
//                            the same sampler node --cpu-prof starts) into
//                            src/tests/evidence/WO-2930/profile-<n>.cpuprofile
//   WO2930_ONLY=<substring>  limits the run to matching operation names
//   WO2930_OUT=<file>        writes the census report there instead (before/after runs)
//   -t "exact speed-ups"     runs only the fast counter proofs

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Session } from 'node:inspector/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { Tool, ToolpathMove } from '../../types'
import type { StockState } from '../../lib/cam/stockState'
import {
  type Loops, type Pt, ensureEngineClipperReady, engineMarshalStats, resetEngineMarshalStats,
  difference, intersection, offsetClosed, offsetOpenRound, totalArea, diskPath,
} from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { createToolGeometry } from '../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { ADAPTIVE_POLICY } from '../../kernel/ops/adaptive/policy'
import {
  type SolidColumns, trimToolpathToAssemblyReach, reachColumnScanStats, resetReachColumnScanStats,
} from '../../lib/cam/holderClearance'
import { typedMock } from '../support/typedMock'

// Embedded STL/STEP bytes live in IndexedDB in the browser; keep them in memory
// here (the pattern of src/tests/examples/_exampleGenerate.probe.test.ts).
const stlBytes = new Map<string, ArrayBuffer>()
const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async (id: string, buffer: ArrayBuffer) => { stlBytes.set(id, buffer) }),
  loadCachedSTL: vi.fn(async (id: string) => stlBytes.get(id) ?? null),
  removeCachedSTL: vi.fn(async (id: string) => { stlBytes.delete(id) }),
}))
vi.mock('../../lib/stepCache', async (importOriginal) => typedMock<typeof import('../../lib/stepCache')>({
  ...await importOriginal<typeof import('../../lib/stepCache')>(),
  cacheStep: vi.fn(async (id: string, buffer: ArrayBuffer) => { stepBytes.set(id, buffer) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
  cacheStepDisplay: vi.fn(async () => {}),
  loadCachedStepDisplay: vi.fn(async () => null),
  removeCachedStepDisplay: vi.fn(async () => {}),
}))

const { useCamStore, smartHeightStockBounds } = await import('../../store')

const ROOT = path.resolve(__dirname, '../../..')
const EVIDENCE = path.join(ROOT, 'src/tests/evidence/WO-2930')
// examples/ and Sample Parts/ hold no adaptive_clearing_2d operation (census in
// profile-summary.md); the in-app Example Projects and the operator's own Full Suite
// file (the WO-2930 report) hold all thirteen.
const CORPUS: { label: string; file: string }[] = [
  { label: 'Example Projects/Adaptive Clearing Shapes', file: 'Example Projects/Adaptive Clearing Shapes.camproject' },
  { label: 'Example Projects/Corner Helix Bar', file: 'Example Projects/Corner Helix Bar.camproject' },
  { label: 'Example Projects/Feature Tour v0.31', file: 'Example Projects/Feature Tour v0.31 (2026-07-25).camproject' },
  { label: 'Example Projects/Full Suite', file: 'Example Projects/Full Suite.camproject' },
  { label: "Operator's Full_Suite (1) (WO-2930 report)", file: 'src/tests/evidence/WO-2930/owner-project.camproject.gz' },
]
const EXPECTED_OPS = 13
const ONLY = process.env.WO2930_ONLY

function readProject(file: string): string {
  const bytes = fs.readFileSync(path.join(ROOT, file))
  return file.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
}

// ── The wire: the real toolpathWorker in-process, every message tapped ──────

interface Tap { postedAt: number; phases: { phase: string; atMs: number }[]; complete?: { computeTimeMs: number; atMs: number }; error?: string }
let tap: Tap | null = null
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }
let createdWindow = false
let OrigWorker: unknown

function observe(m: WorkerResponseMsg): void {
  if (!tap) return
  const atMs = performance.now() - tap.postedAt
  if (m.type === 'TOOLPATH_PROGRESS') {
    const phase = m.phase ?? '(none)'
    if (tap.phases.at(-1)?.phase !== phase) tap.phases.push({ phase, atMs })
  } else if (m.type === 'TOOLPATH_COMPLETE') tap.complete = { computeTimeMs: m.computeTimeMs, atMs }
  else if (m.type === 'TOOLPATH_ERROR') tap.error = m.message
}

beforeAll(async () => {
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  createdWindow = g.window === undefined
  if (createdWindow) g.window = {}
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { observe(m); activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  if (createdWindow) delete g.window
  delete (globalThis as { self?: unknown }).self
})

// The one viewport member compute reads: stock bounds, from the store's own
// derivation. Present only while generating - project open would otherwise
// take it for a whole viewport and try to rebuild a scene on it.
function withStockBoundsViewport<T>(run: () => Promise<T>): Promise<T> {
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window
  w.__cncViewport = {
    getStockBounds: (stockId?: string) => {
      const project = useCamStore.getState().project
      const id = stockId ?? project.stocks?.[0]?.id
      return id ? smartHeightStockBounds(project, id) : null
    },
  }
  return run().finally(() => { delete w.__cncViewport })
}

beforeEach(() => {
  OrigWorker = (globalThis as { Worker?: unknown }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      activeShim = this
      if (tap && data.type === 'COMPUTE_ADAPTIVE_CLEARING') tap.postedAt = performance.now()
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { activeShim = null }
  }
  stlBytes.clear(); stepBytes.clear()
  useCamStore.getState().newProject()
})

afterEach(() => {
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
})

// ── One generate, measured ───────────────────────────────────────────────────

interface Run {
  wallMs: number; preDispatchMs: number | null; workerComputeMs: number | null
  phases: { phase: string; atMs: number }[]
  status: string; error: string | null; moves: number; movesSha256: string | null
  /** WO-2930 work counters for this generate: vertices into / out of WASM, reach-trim cells. */
  marshalToWasm: number; marshalFromWasm: number; reachCellsVisited: number
}

function sha(moves: readonly ToolpathMove[] | undefined): string | null {
  return moves ? createHash('sha256').update(JSON.stringify(moves)).digest('hex') : null
}

async function generate(setupId: string, opId: string, session?: Session, profileOut?: string): Promise<Run> {
  const t: Tap = { postedAt: NaN, phases: [] }
  tap = t
  if (session) await session.post('Profiler.start')
  resetEngineMarshalStats()
  resetReachColumnScanStats()
  const start = performance.now()
  t.postedAt = start
  await withStockBoundsViewport(() => useCamStore.getState().computeOperationToolpath(setupId, opId))
  const wallMs = performance.now() - start
  if (session && profileOut) {
    const { profile } = await session.post('Profiler.stop')
    fs.writeFileSync(profileOut, JSON.stringify(profile))
  }
  tap = null
  const marshal = engineMarshalStats()
  const reach = reachColumnScanStats()
  const op = useCamStore.getState().project.setups.find(s => s.id === setupId)!.operations.find(o => o.id === opId)!
  const round = (n: number) => Math.round(n * 10) / 10
  return {
    wallMs: round(wallMs),
    preDispatchMs: Number.isFinite(t.postedAt) && t.postedAt !== start ? round(t.postedAt - start) : null,
    workerComputeMs: t.complete?.computeTimeMs ?? null,
    phases: t.phases.map(p => ({ phase: p.phase, atMs: round(p.atMs) })),
    status: op.status ?? 'unknown',
    error: op.errorMessage ?? t.error ?? null,
    moves: op.toolpathMoves?.length ?? 0,
    movesSha256: sha(op.toolpathMoves),
    marshalToWasm: marshal.toWasm, marshalFromWasm: marshal.fromWasm, reachCellsVisited: reach.cellsVisited,
  }
}

interface OpRecord {
  project: string; setup: string; operation: string; toolDiameter: number | null
  savedComputeTimeMs: number | null; cold: Run; warm: Run; coldEqualsWarm: boolean; cpuProfile?: string
}

describe('WO-2930: Adaptive Clearing 2D timing census through the production route', () => {
  it('generates every shipped adaptive_clearing_2d operation cold and warm and records where the time goes', async () => {
    const records: OpRecord[] = []
    const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {})]
    const processStart = performance.now()
    try {
      for (const entry of CORPUS) {
        const loadStart = performance.now()
        await useCamStore.getState().loadProjectFromFile(readProject(entry.file))
        const loadMs = Math.round(performance.now() - loadStart)
        const saved = JSON.parse(readProject(entry.file)) as { setups: { operations: { id: string; computeTimeMs?: number }[] }[] }
        const savedTime = new Map(saved.setups.flatMap(s => s.operations.map(o => [o.id, o.computeTimeMs ?? null] as const)))
        const project = useCamStore.getState().project
        for (const setup of project.setups) {
          for (const op of setup.operations) {
            if (op.type !== 'adaptive_clearing_2d') continue
            if (ONLY && !op.name.includes(ONLY)) continue
            const tool = project.toolLibrary?.find(t => t.id === op.toolId) ?? useCamStore.getState().toolLibrary.find(t => t.id === op.toolId)
            const cold = await generate(setup.id, op.id)
            const warm = await generate(setup.id, op.id)
            records.push({
              project: entry.label, setup: setup.name, operation: op.name,
              toolDiameter: tool?.diameter ?? null, savedComputeTimeMs: savedTime.get(op.id) ?? null,
              cold, warm, coldEqualsWarm: cold.movesSha256 === warm.movesSha256,
            })
            process.stdout.write(`[WO-2930] ${entry.label} :: ${op.name}: cold ${cold.wallMs} ms (worker ${cold.workerComputeMs}), warm ${warm.wallMs} ms (worker ${warm.workerComputeMs}), ${cold.moves} moves, ${cold.status}; project load ${loadMs} ms; to-wasm ${warm.marshalToWasm}, reach cells ${warm.reachCellsVisited}\n`)
          }
        }
      }

      records.sort((a, b) => b.warm.wallMs - a.warm.wallMs)

      // CPU profiles of the three slowest, each over one more WARM generate.
      if (process.env.WO2930_CPU_PROFILE === '1') {
        const session = new Session()
        session.connect()
        await session.post('Profiler.enable')
        await session.post('Profiler.setSamplingInterval', { interval: 200 })
        for (const [i, rec] of records.slice(0, 3).entries()) {
          const entry = CORPUS.find(c => c.label === rec.project)!
          await useCamStore.getState().loadProjectFromFile(readProject(entry.file))
          const project = useCamStore.getState().project
          const setup = project.setups.find(s => s.name === rec.setup)!
          const op = setup.operations.find(o => o.name === rec.operation)!
          await generate(setup.id, op.id) // cold, unprofiled
          const out = path.join(EVIDENCE, `profile-${i + 1}.cpuprofile`)
          const profiled = await generate(setup.id, op.id, session, out)
          rec.cpuProfile = `${path.basename(out)} (warm ${profiled.wallMs} ms under the profiler, ${profiled.movesSha256 === rec.warm.movesSha256 ? 'same' : 'DIFFERENT'} moves)`
        }
        await session.post('Profiler.disable')
        session.disconnect()
      }
    } finally {
      for (const q of quiet) q.mockRestore()
    }

    const report = {
      wo: 'WO-2930',
      route: 'loadProjectFromFile -> computeOperationToolpath -> real toolpathWorker.ts in-process (node)',
      node: process.version, platform: `${process.platform} ${process.arch}`,
      totalMs: Math.round(performance.now() - processStart),
      over60s: records.filter(r => r.cold.wallMs > 60_000 || r.warm.wallMs > 60_000).map(r => r.operation),
      operations: records,
    }
    if (process.env.WO2930_OUT) {
      fs.writeFileSync(path.resolve(process.env.WO2930_OUT), JSON.stringify(report, null, 2) + '\n')
    } else if (process.env.WRITE_EVIDENCE === '1') {
      fs.writeFileSync(path.join(EVIDENCE, 'profile-timings.json'), JSON.stringify(report, null, 2) + '\n')
    }
    console.log(`[WO-2930] ${records.length} operations; slowest warm: ${records.slice(0, 3).map(r => `${r.operation} ${r.warm.wallMs} ms`).join(', ')}`)

    if (!ONLY) expect(records).toHaveLength(EXPECTED_OPS)
    for (const r of records) {
      // Settled: a terminal status, never left computing.
      expect(['ready', 'error'], `${r.project} :: ${r.operation}`).toContain(r.cold.status)
      expect(['ready', 'error'], `${r.project} :: ${r.operation}`).toContain(r.warm.status)
    }
  }, 1_800_000)
})

// ── WO-2930 implementation round: the two exact speed-ups, proved on counters ──
//
// Speed-up 1 (toolGeometry/clipperEngine): the box-clipped cleared polygon cutArea
// reuses for ~12 angle probes a step stays in WASM between probes, so a probe sends
// only its translated crescent across the boundary. Speed-up 2 (holderClearance): the
// reach trim skips column tiles whose highest top cannot meet the band it tests, so
// it visits fewer cells. Both must give the same answers, checked against live
// oracles here; neither is judged on wall time.

/** |shoelace area| of `loop` clipped to the half-plane (p - o).n >= 0: the reference
 *  for cutArea's left/right split (same arithmetic as toolGeometry's own helper). */
function refHalfPlaneAbsArea(loop: readonly Pt[], ox: number, oy: number, nx: number, ny: number): number {
  const n = loop.length
  if (n < 3) return 0
  let acc = 0
  let firstX = 0, firstY = 0, prevX = 0, prevY = 0, started = false
  let px = loop[n - 1].x, py = loop[n - 1].y
  let ps = (px - ox) * nx + (py - oy) * ny
  for (let i = 0; i < n; i++) {
    const cx = loop[i].x, cy = loop[i].y
    const cs = (cx - ox) * nx + (cy - oy) * ny
    if (cs >= 0) {
      if (ps < 0) {
        const t = ps / (ps - cs), ex = px + (cx - px) * t, ey = py + (cy - py) * t
        if (started) acc += prevX * ey - ex * prevY; else { firstX = ex; firstY = ey; started = true }
        prevX = ex; prevY = ey
      }
      if (started) acc += prevX * cy - cx * prevY; else { firstX = cx; firstY = cy; started = true }
      prevX = cx; prevY = cy
    } else if (ps >= 0) {
      const t = ps / (ps - cs), ex = px + (cx - px) * t, ey = py + (cy - py) * t
      if (started) acc += prevX * ey - ex * prevY; else { firstX = ex; firstY = ey; started = true }
      prevX = ex; prevY = ey
    }
    px = cx; py = cy; ps = cs
  }
  if (!started) return 0
  acc += prevX * firstY - firstX * prevY
  return Math.abs(acc) / 2
}

/** A small deterministic PRNG (mulberry32), so every run sees the same scenes. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const reachTool = (overrides: Partial<Tool>): Tool => ({
  id: 'wo2930-tool', name: 'WO-2930 tool', type: 'flat_end_mill',
  diameter: 6, fluteLength: 8, shankDiameter: 10, overallLength: 60, lengthBelowHolder: 30,
  numberOfFlutes: 2, material: 'carbide', coating: 'none', holderId: '', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
  ...overrides,
} as unknown as Tool)

/** Column spans over a 60 mm square: a floor topping at z 0 everywhere, an island to
 *  z `islandTop` over [10, 20]^2, and (seeded) scattered posts and overhangs. */
function partColumns(seed: number, islandTop = 8): SolidColumns {
  const cell = 0.5, nx = 120, ny = 120, originX = -30, originY = -30
  const rand = rng(seed)
  const spanStart = new Uint32Array(nx * ny + 1)
  const spanZ: number[] = []
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      spanStart[j * nx + i] = spanZ.length
      const x = originX + (i + 0.5) * cell, y = originY + (j + 0.5) * cell
      if (x >= 10 && x <= 20 && y >= 10 && y <= 20) { spanZ.push(-5, islandTop); continue }
      spanZ.push(-5, 0)
      if (seed > 0 && rand() < 0.008) spanZ.push(2 + rand() * 6, 9 + rand() * 4) // a floating overhang
    }
  }
  spanStart[nx * ny] = spanZ.length
  return { originX, originY, cell, nx, ny, spanStart, spanZ: Float64Array.from(spanZ) }
}

/** Remaining stock as a z-dexel: machined to its bottom except an uncut band at x < -20. */
function stockDexel(seed: number): StockState {
  const cell = 0.5, minX = -30, minY = -30, nx = 120, ny = 120
  const rand = rng(seed + 1000)
  const topZ = new Float32Array(nx * ny)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + (i + 0.5) * cell
      topZ[j * nx + i] = x < -20 ? 7 : (seed > 0 && rand() < 0.003 ? 4 + rand() * 4 : -5)
    }
  }
  return {
    schemaVersion: 1, representation: 'z-dexel',
    bounds: { minX, minY, minZ: -5, maxX: 30, maxY: 30, maxZ: 7 },
    requestedResolutionMm: cell, resolutionMm: cell, warnings: [], nx, ny, bottomZ: -5, topZ,
  } as StockState
}

/** A toe clamp on the right edge: a body to z 12 and a nose span hanging over x 22..24. */
function clampColumns(): SolidColumns {
  const cell = 0.5, nx = 30, ny = 120, originX = 15, originY = -30
  const spanStart = new Uint32Array(nx * ny + 1)
  const spanZ: number[] = []
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      spanStart[j * nx + i] = spanZ.length
      const x = originX + (i + 0.5) * cell, y = originY + (j + 0.5) * cell
      if (y < -5 || y > 5) continue
      if (x >= 24) spanZ.push(-5, 12)
      else if (x >= 22) spanZ.push(10, 12)
    }
  }
  spanStart[nx * ny] = spanZ.length
  return { originX, originY, cell, nx, ny, spanStart, spanZ: Float64Array.from(spanZ) }
}

/** Zig-zag passes at `z`, joined by rapids at clearance. `wide` passes cross the island,
 *  the uncut band and the clamp; the narrow ones stay over open floor between them. */
function zigzag(z: number, seed: number, wide: boolean): ToolpathMove[] {
  const rand = rng(seed + 2000)
  const xa = wide ? -26 : -14, xb = wide ? 26 : 4, ya = wide ? -26 : -24, yb = wide ? 26 : 4
  const moves: ToolpathMove[] = [{ type: 'rapid', role: 'rapid', x: xa, y: ya, z: 15 }]
  for (let y = ya, k = 0; y <= yb; y += 4, k++) {
    const x0 = k % 2 === 0 ? xa : xb, x1 = k % 2 === 0 ? xb : xa
    const dz = seed > 0 ? (rand() - 0.5) * 2 : 0
    moves.push({ type: 'rapid', role: 'rapid', x: x0, y, z: 15 })
    moves.push({ type: 'feed', role: 'cut', x: x0, y, z: z + dz, feed: 1000 })
    moves.push({ type: 'feed', role: 'cut', x: x1, y: y + 1, z: z + dz, feed: 1000 })
    moves.push({ type: 'rapid', role: 'rapid', x: x1, y: y + 1, z: 15 })
  }
  return moves
}

describe('WO-2930 exact speed-ups: proved on deterministic counters', () => {
  it('cutArea sends only the crescent across the WASM boundary while the cleared box is reused, with identical results', async () => {
    await ensureEngineClipperReady()
    const r = 2, arcTol = 0.01
    const tg = createToolGeometry(r, 0.2, arcTol)
    // A cleared region with thousands of edges: an open spiral swept by the tool.
    const spiral: Pt[] = []
    for (let a = 0; a < 6 * Math.PI; a += 0.05) spiral.push({ x: (1 + a * 0.8) * Math.cos(a), y: (1 + a * 0.8) * Math.sin(a) })
    const cleared: Loops = offsetOpenRound(spiral, r, arcTol)
    const clearedVerts = cleared.reduce((n, l) => n + l.length, 0)
    expect(clearedVerts).toBeGreaterThan(1000)

    // The first query fixes the box at c0; every later `from` stays well inside the
    // reuse window (|from - c0| <= 3 < BOUND_HALF - BOUND_MARGIN = 4 mm for r = 2).
    const c0: Pt = { x: 8, y: 1 }
    const h = r * ADAPTIVE_POLICY.sampling.cutAreaBoundHalfRadii
    expect(h - r * ADAPTIVE_POLICY.sampling.cutAreaBoundMarginRadii).toBeGreaterThan(3)
    const rect: Loops = [[
      { x: c0.x - h, y: c0.y - h }, { x: c0.x + h, y: c0.y - h },
      { x: c0.x + h, y: c0.y + h }, { x: c0.x - h, y: c0.y + h },
    ]]
    const local = intersection(cleared, rect) // the reference's own copy of the box clip
    const steps = Array.from({ length: 12 }, (_, k) => {
      const a = (k / 12) * 2 * Math.PI
      return { dx: 0.6 * Math.cos(a), dy: 0.6 * Math.sin(a) }
    })
    // Warm the crescent cache from c0 (this also makes the box): later probes are pure hits.
    for (const s of steps) tg.cutArea(c0, { x: c0.x + s.dx, y: c0.y + s.dy }, cleared)

    const rand = rng(7)
    const froms: Pt[] = Array.from({ length: 40 }, () => ({ x: c0.x + (rand() - 0.5) * 6, y: c0.y + (rand() - 0.5) * 6 }))
    let crescentVerts = 0
    let toWasm = 0
    let probes = 0
    for (const from of froms) {
      for (const s of steps) {
        const to = { x: from.x + s.dx, y: from.y + s.dy }
        const shape = tg.cutShape(from, to)
        crescentVerts += shape.reduce((n, l) => n + l.length, 0)
        resetEngineMarshalStats()
        const got = tg.cutArea(from, to, cleared)
        toWasm += engineMarshalStats().toWasm
        probes++
        // Live oracle: the same Clipper difference on plain loops, as cutArea did before.
        const cut = difference(shape, local)
        const area = totalArea(cut)
        const d = Math.sqrt((from.x - to.x) ** 2 + (from.y - to.y) ** 2)
        let leftArea = 0, rightArea = 0
        if (area > 0) {
          const nx = -(to.y - from.y) / d, ny = (to.x - from.x) / d
          for (const loop of cut) {
            leftArea += refHalfPlaneAbsArea(loop, from.x, from.y, nx, ny)
            rightArea += refHalfPlaneAbsArea(loop, from.x, from.y, -nx, -ny)
          }
        }
        const sum = leftArea + rightArea
        expect(got).toEqual({
          area, areaPerDist: area / d, leftArea, rightArea,
          sideBalance: sum > 0 ? (leftArea - rightArea) / sum : 0,
        })
      }
    }
    expect(tg.cacheStats().boundClips).toBe(1) // one box for the whole run
    // Before: each probe also re-sent the box's cleared polygon (local) into WASM.
    process.stdout.write(`[WO-2930] cutArea: ${probes} probes sent ${toWasm} vertices into WASM; crescents alone are ${crescentVerts}; the box polygon is ${local.reduce((n, l) => n + l.length, 0)} vertices\n`)
    expect(toWasm).toBe(crescentVerts)
  })

  it('cutArea re-clips (box moved, or a new cleared set) exactly where the plain-loop oracle does', async () => {
    await ensureEngineClipperReady()
    const r = 2, arcTol = 0.01
    const tg = createToolGeometry(r, 0.2, arcTol)
    const spiral: Pt[] = []
    for (let a = 0; a < 6 * Math.PI; a += 0.05) spiral.push({ x: (1 + a * 0.8) * Math.cos(a), y: (1 + a * 0.8) * Math.sin(a) })
    const clearedA = offsetOpenRound(spiral, r, arcTol)
    const clearedB = offsetOpenRound(spiral.slice(0, 250), r, arcTol)
    const h = r * ADAPTIVE_POLICY.sampling.cutAreaBoundHalfRadii
    const reach = h - r * ADAPTIVE_POLICY.sampling.cutAreaBoundMarginRadii
    // The oracle keeps its own box with the rule clearedNear documents: reuse while the
    // same cleared set and |from - centre| <= BOUND_HALF - BOUND_MARGIN, else clip anew at `from`.
    let ref: { cleared: Loops; cx: number; cy: number; local: Loops } | null = null
    let clips = 0
    for (let k = 0; k < 60; k++) {
      const cleared = k < 40 ? clearedA : clearedB // k = 40: a new cleared set forces a re-clip
      const from = { x: -14 + k * 0.7, y: Math.sin(k * 0.3) * 3 }
      const to = { x: from.x + 0.5 * Math.cos(k), y: from.y + 0.5 * Math.sin(k) }
      if (!ref || ref.cleared !== cleared || Math.abs(from.x - ref.cx) > reach || Math.abs(from.y - ref.cy) > reach) {
        ref = { cleared, cx: from.x, cy: from.y, local: intersection(cleared, [[
          { x: from.x - h, y: from.y - h }, { x: from.x + h, y: from.y - h },
          { x: from.x + h, y: from.y + h }, { x: from.x - h, y: from.y + h },
        ]]) }
        clips++
      }
      const area = totalArea(difference(tg.cutShape(from, to), ref.local))
      expect(tg.cutArea(from, to, cleared).area, `probe ${k}`).toBe(area)
    }
    expect(clips).toBeGreaterThan(5)
    expect(tg.cacheStats().boundClips).toBe(clips)
  })

  it('diskBite and diskBiteIn give the same areas as plain-loop Clipper calls', async () => {
    await ensureEngineClipperReady()
    const r = 2, arcTol = 0.01
    const tg = createToolGeometry(r, 0.2, arcTol)
    const spiral: Pt[] = []
    for (let a = 0; a < 6 * Math.PI; a += 0.05) spiral.push({ x: (1 + a * 0.8) * Math.cos(a), y: (1 + a * 0.8) * Math.sin(a) })
    const cleared = offsetOpenRound(spiral, r, arcTol)
    const region = offsetClosed([[{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }]], -r, arcTol)
    const c0: Pt = { x: -6, y: 4 }
    const h = r * ADAPTIVE_POLICY.sampling.cutAreaBoundHalfRadii
    const box = (c: Pt): Loops => [[
      { x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }, { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h },
    ]]
    tg.diskBiteIn(c0, cleared, region) // fixes both boxes at c0
    const clearedLocal = intersection(cleared, box(c0))
    const regionLocal = intersection(region, box(c0))
    const rand = rng(11)
    for (let k = 0; k < 60; k++) {
      const c = { x: c0.x + (rand() - 0.5) * 6, y: c0.y + (rand() - 0.5) * 6 }
      expect(tg.diskBite(c, cleared)).toBe(totalArea(difference(diskPath(c, r, arcTol), clearedLocal)))
      const reach = intersection(diskPath(c, r, arcTol), regionLocal)
      expect(tg.diskBiteIn(c, cleared, region)).toBe(reach.length === 0 ? 0 : totalArea(difference(reach, clearedLocal)))
    }
    expect(tg.cacheStats().boundClips).toBe(2) // one cleared box, one region box
    expect(tg.diskBite(c0, [])).toBe(totalArea(difference(diskPath(c0, r, arcTol), [])))
  })

  it('the reach trim visits fewer column cells with tiles and returns the same result', () => {
    const tools = [
      reachTool({ name: 'flat' }),
      reachTool({ name: 'ball', type: 'ball_end_mill' }),
      reachTool({ name: 'v-bit', type: 'v_bit', angleFromAxisDeg: 30, tipDiameter: 0.3 }),
    ]
    let plainCells = 0, tiledCells = 0, trimmedRuns = 0, runs = 0
    for (const seed of [0, 1]) {
      const part = partColumns(seed)
      const stock = stockDexel(seed)
      const workholding = [clampColumns()]
      for (const tool of tools) {
        for (const [z, wide] of [[0.5, true], [3, true], [-0.5, true], [0.5, false], [3, false]] as const) {
          const moves = zigzag(z, seed, wide)
          const input = { moves, tool, plungeRate: 300, part, stock, workholding, allowanceMm: 0.5 }
          resetReachColumnScanStats()
          const plain = trimToolpathToAssemblyReach({ ...input, columnTiles: false })
          plainCells += reachColumnScanStats().cellsVisited
          resetReachColumnScanStats()
          const tiled = trimToolpathToAssemblyReach(input)
          tiledCells += reachColumnScanStats().cellsVisited
          // Live oracle: the full scan, same call, same inputs.
          expect(tiled, `seed ${seed}, ${tool.name}, z ${z}, ${wide ? 'wide' : 'narrow'}`).toEqual(plain)
          if (plain.trimmed) trimmedRuns++
          runs++
        }
      }
    }
    // The scenes must exercise both outcomes, or "same result" proves little.
    expect(trimmedRuns).toBeGreaterThan(0)
    expect(trimmedRuns).toBeLessThan(runs)
    process.stdout.write(`[WO-2930] reach trim: ${runs} trims, ${trimmedRuns} trimmed; cells visited ${plainCells} full scan -> ${tiledCells} with tiles\n`)
    expect(tiledCells).toBeLessThan(plainCells / 2)
  })
})
