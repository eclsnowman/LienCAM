// WO-2039: a bore helix posts as helical arcs.
//
// Operator's machine session 09-26: Full Suite Test / Setup 1 / Bore 3 (T19) posted
// 38,796 lines, 38,744 of them G1 chords of ~0.01 mm - the helical entry at a
// small orbit sampled at pi/16. The board ran them at its move rate (~470
// moves/s, window-bound the whole time), not at the programmed feed. The helix
// now goes out as G2/G3 with a Z word, at most half a turn per arc.
//
// Part 1 is the helix itself: generateHelixArcs against the chord helix it
// replaces. Part 2 is his file through the production Generate (the store's
// computeOperationToolpath, the same worker path the app uses) and the
// production Post (postProject with the UCCNC dialect his machine declares),
// then the posted text read back and run end to end on the simulated board.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { typedMock } from '../support/typedMock'
import type { ToolpathMove, WCS } from '../../types'
import type { ControllerEvents } from '../../lib/machine/controller'

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

const { generateHelixArcs, generateThreadHelix, HELIX_ARC_MIN_CHORD_MM } = await import('../../lib/cam/threadHelix')
const { sampleArcMovesForLinearConsumers } = await import('../../lib/cam/toolpathArcSampling')
const { useCamStore, smartHeightStockBounds, setupProvenStockId } = await import('../../store')
const { UCCNC_CONFIG } = await import('../../lib/post')
const { postProject } = await import('../../lib/post/postProject')
const { readGcodeProgram } = await import('../../lib/gcode/reader')
const { buildStraightLineProgram } = await import('../../lib/program/buildMachineProgram')
const { SimulatedController } = await import('../../lib/machine/simulatedController')

// The worker runs in-process: the store posts to a Worker shim that hands the
// request straight to toolpathWorker's onmessage, exactly as the browser would.
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

const isArc = (m: ToolpathMove) => m.type === 'arc_cw' || m.type === 'arc_ccw'

/** Distance from p to segment a-b in 3D. */
function segDist(p: ToolpathMove, a: ToolpathMove, b: ToolpathMove): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const len2 = dx * dx + dy * dy + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / len2))
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy, p.z - a.z - t * dz)
}

/** Worst distance of any point of `from` to the polyline `to`. */
function worstDistance(from: readonly ToolpathMove[], to: readonly ToolpathMove[]): number {
  let worst = 0
  for (const p of from) {
    let best = Infinity
    for (let k = 1; k < to.length; k++) best = Math.min(best, segDist(p, to[k - 1], to[k]))
    worst = Math.max(worst, best)
  }
  return worst
}

/** The arc stream as a dense polyline, sampled the way the viewer and sim do. */
function sampled(moves: ToolpathMove[]): ToolpathMove[] {
  return sampleArcMovesForLinearConsumers(moves, { maxChordMm: 0.01, maxAngleDeg: 1, maxSegmentsPerArc: 100_000 })
}

describe('WO-2039 part 1: generateHelixArcs is the chord helix, as arcs', () => {
  const CASES = [
    { name: 'small orbit, 3 deg, CCW descend (the Bore 3 shape)', radius: 0.06, angleDeg: 3, dir: 1 as const, descend: true, depth: 0.3 },
    { name: 'small orbit, 3 deg, CW descend', radius: 0.06, angleDeg: 3, dir: -1 as const, descend: true, depth: 0.3 },
    { name: 'large orbit, 3 deg, CCW ascend', radius: 2.18, angleDeg: 3, dir: 1 as const, descend: false },
    { name: 'mid orbit, 10 deg, CW descend, odd start angle', radius: 0.8, angleDeg: 10, dir: -1 as const, descend: true, startAngle: 1.234 },
  ]
  for (const c of CASES) {
    it(c.name, () => {
      const pitch = 2 * Math.PI * c.radius * Math.tan(c.angleDeg * Math.PI / 180)
      const spec = {
        cx: 65.9, cy: 56.3, radius: c.radius, pitch, bottomZ: -(c.depth ?? 2), topZ: 0, dir: c.dir,
        feed: 610, role: 'helix' as const, descend: c.descend, startAngle: c.startAngle ?? 0.4,
      }
      const chords = generateThreadHelix(spec)
      const arcs = generateHelixArcs(spec)

      // Same start, same end, exact end Z.
      expect(arcs[0]).toMatchObject({ type: 'feed', role: 'helix', feed: 610 })
      expect(arcs[0].x).toBeCloseTo(chords[0].x, 12)
      expect(arcs[0].y).toBeCloseTo(chords[0].y, 12)
      expect(arcs[0].z).toBe(chords[0].z)
      const last = arcs[arcs.length - 1], oldLast = chords[chords.length - 1]
      expect(last.x).toBeCloseTo(oldLast.x, 9)
      expect(last.y).toBeCloseTo(oldLast.y, 9)
      expect(last.z).toBe(c.descend ? -(c.depth ?? 2) : 0)

      // Every move after the start is an arc of the right sense about the orbit
      // centre, at most half a turn, never a full circle, feed and role kept.
      const want = c.dir === 1 ? 'arc_ccw' : 'arc_cw'
      for (let k = 1; k < arcs.length; k++) {
        const m = arcs[k], p = arcs[k - 1]
        expect(m.type).toBe(want)
        expect(m).toMatchObject({ cx: 65.9, cy: 56.3, feed: 610, role: 'helix' })
        expect(Math.hypot(m.x - 65.9, m.y - 56.3)).toBeCloseTo(c.radius, 12)
        const chord = Math.hypot(m.x - p.x, m.y - p.y)
        expect(chord).toBeGreaterThan(HELIX_ARC_MIN_CHORD_MM)
        // sweep <= pi  <=>  the start->end direction keeps the centre on the turning side
        const cross = (p.x - 65.9) * (m.y - 56.3) - (p.y - 56.3) * (m.x - 65.9)
        expect(Math.sign(cross) * c.dir).toBeGreaterThanOrEqual(-1e-12)
        expect(c.descend ? m.z < p.z : m.z > p.z).toBe(true)
      }

      // At least 10x fewer moves than the chord helix.
      expect(arcs.length * 10).toBeLessThanOrEqual(chords.length)

      // Sampled comparison. Every chord vertex lies ON the arc helix, and the
      // arc helix strays from the chord polyline by no more than that
      // polyline's own sagitta off the true helix (r(1 - cos(pi/32))).
      const dense = sampled(arcs)
      const oldOnNew = worstDistance(chords, dense)
      const newOffOld = worstDistance(dense.filter((_, i) => i % 7 === 0), chords)
      const sagitta = c.radius * (1 - Math.cos(Math.PI / 32))
      expect(oldOnNew).toBeLessThan(1e-3)
      expect(newOffOld).toBeLessThanOrEqual(sagitta + 1e-4)
    })
  }

  it('a sliver of helix whose chord would round to a full circle is a straight feed', () => {
    const arcs = generateHelixArcs({
      cx: 0, cy: 0, radius: 0.06, pitch: 1, bottomZ: -0.001, topZ: 0, dir: 1, feed: 610, descend: true,
    })
    expect(arcs.map(m => m.type)).toEqual(['feed', 'feed'])
    expect(arcs[1].z).toBe(-0.001)
  })
})

// ---------------------------------------------------------------------------
// Part 2: his file, through the production Generate and Post.
// ---------------------------------------------------------------------------

/** Operator's machine session 09-26, final-export.nc lines 10686-49474 (pin ed347e510). */
const BEFORE = { lines: 38_796, g1: 38_744, arcs: 24, boardSeconds: 82 }
const EVIDENCE_DIR = join(process.cwd(), 'src', 'tests', 'evidence', 'WO-2039')

interface BoreRun {
  moves: ToolpathMove[]
  gcode: string
  span: string[]
  estimatedCutTimeMs?: number
}

function motionCounts(lines: readonly string[]) {
  let g1 = 0, arcs = 0, helicalArcs = 0, g0 = 0
  let mode = ''
  for (const line of lines) {
    const code = line.replace(/\(.*?\)|;.*$/g, '').toUpperCase()
    const g = code.match(/\bG0*([0-3])\b/)
    if (g) mode = g[1]
    if (!/[XYZ]-?[\d.]/.test(code)) continue
    if (mode === '0') g0++
    else if (mode === '1') g1++
    else if (mode === '2' || mode === '3') { arcs++; if (/Z-?[\d.]/.test(code)) helicalArcs++ }
  }
  return { lines: lines.length, g0, g1, arcs, helicalArcs }
}

describe('WO-2039 part 2: Full Suite Test / Setup 1 / Bore 3 through Generate + Post', () => {
  let run: BoreRun

  beforeAll(async () => {
    const text = readFileSync(join(process.cwd(), 'Example Projects/Full Suite.camproject'), 'utf8')
    await useCamStore.getState().loadProjectFromFile(text)
    const setup = useCamStore.getState().project.setups[0]
    const bore = setup.operations.find(o => o.name === 'Bore 3')!
    await useCamStore.getState().computeOperationToolpath(setup.id, bore.id)
    const project = useCamStore.getState().project
    const op = project.setups[0].operations.find(o => o.id === bore.id)! as unknown as {
      errorMessage?: string; toolpathMoves?: ToolpathMove[]; estimatedCutTimeMs?: number
    }
    expect(op.errorMessage ?? '').toBe('')
    const posted = postProject(project, [project.setups[0]], UCCNC_CONFIG, {
      mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2039', ext: 'nc',
      selectedOpIds: { [setup.id]: [bore.id] },
    })
    expect(posted.diagnostics.filter(d => d.level === 'error')).toEqual([])
    const result = posted.files![0].result
    const lines = result.gcode.split('\n')
    const span = result.operationSpans!.find(s => s.opId === bore.id)!
    run = {
      moves: op.toolpathMoves ?? [],
      gcode: result.gcode,
      span: lines.slice(span.startLine - 1, span.endLine),
      estimatedCutTimeMs: op.estimatedCutTimeMs,
    }
    console.info('[WO-2039] Bore 3', JSON.stringify({
      moves: run.moves.length,
      roles: run.moves.reduce<Record<string, number>>((acc, m) => {
        const k = `${m.type}/${m.role ?? '-'}`
        acc[k] = (acc[k] ?? 0) + 1
        return acc
      }, {}),
      span: motionCounts(run.span), file: motionCounts(lines),
      estimatedCutTimeSec: run.estimatedCutTimeMs !== undefined ? +(run.estimatedCutTimeMs / 1000).toFixed(1) : null,
    }))
  }, 300_000)

  it('posts the helix as G2/G3 with Z, and at least 10x fewer lines than 09-26', () => {
    const helix = run.moves.filter(m => m.role === 'helix')
    expect(helix.some(isArc)).toBe(true)
    // One straight feed opens each helix (to its start point); everything else is an arc.
    const helixFeeds = helix.filter(m => m.type === 'feed').length
    const helixRuns = run.moves.filter((m, i) => m.role === 'helix' && run.moves[i - 1]?.role !== 'helix').length
    expect(helixFeeds).toBe(helixRuns)
    const counts = motionCounts(run.span)
    expect(counts.helicalArcs).toBeGreaterThan(0)
    expect(counts.lines * 10).toBeLessThanOrEqual(BEFORE.lines)
  })

  it('the posted file reads back, builds into a machine program and runs end to end on the simulated board', async () => {
    const read = readGcodeProgram(run.gcode, {
      dialect: 'uccnc', sessionWcs: 'G54', initialPosition: { x: 0, y: 0, z: 0 }, machineUnits: 'mm',
      workOffsets: { G54: { x: 0, y: 0, z: 0 } },
    })
    if (!read.ok) throw new Error(`the posted file was refused: ${read.refusal.message}`)
    const moves = read.program.moves
    // The helix reads back as arcs that step Z, not as chords.
    expect(moves.filter((m, i) => isArc(m) && i > 0 && m.z !== moves[i - 1].z).length).toBeGreaterThan(1000)
    // Held 100 mm below the work Z so the whole bore sits inside the simulated travel.
    const wcs = {
      id: 'g54', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: -100 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    } as WCS
    const built = buildStraightLineProgram(moves, wcs, 5000, { opId: 'wo2039', setupId: 'setup-1' })
    if (!built.ok) throw new Error(`the machine program was refused: ${built.reason}`)
    const steps = built.program.steps
    const lastId = steps[steps.length - 1].id

    vi.useFakeTimers()
    const noop = () => {}
    const events = new Proxy({}, { get: () => noop }) as unknown as ControllerEvents
    const HOME = { homesToward: 'min' as const, machineZeroAt: 'min' as const }
    const controller = new SimulatedController(events, {
      travelMm: { x: 738, y: 724.5, z: 128.9 }, homeConvention: { x: HOME, y: HOME, z: HOME },
    })
    try {
      await controller.connect({ kind: 'none' })
      await vi.advanceTimersByTimeAsync(2000)
      expect(controller.loadProgram(built.program)).toEqual({ ok: true, reason: null })
      expect(controller.startJob()).toBe(true)
      let simMs = 0
      while (controller.programProgress().lastCompletedId !== lastId && simMs < 600_000) {
        await vi.advanceTimersByTimeAsync(500)
        simMs += 500
      }
      expect(controller.programProgress().lastCompletedId).toBe(lastId)
      const end = moves[moves.length - 1]
      const pos = controller.status().machinePos!
      expect(pos.x).toBeCloseTo(end.x, 3)
      expect(pos.y).toBeCloseTo(end.y, 3)
      expect(pos.z).toBeCloseTo(end.z + 100, 3)
      simSummary = { steps: steps.length, arcSteps: steps.filter(st => st.kind === 'arc').length, simulatedSeconds: simMs / 1000 }
      console.info('[WO-2039] simulated board', JSON.stringify(simSummary))
    } finally {
      await controller.disconnect?.()
      vi.useRealTimers()
    }
  }, 300_000)

  afterAll(() => {
    if (process.env.WRITE_EVIDENCE !== '1' || !run) return
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(join(EVIDENCE_DIR, 'bore3-after.nc'), run.gcode)
    writeFileSync(join(EVIDENCE_DIR, 'bore3-after.json'), `${JSON.stringify({
      source: 'Example Projects/Full Suite.camproject, Setup 1, Bore 3 (T19): store computeOperationToolpath -> postProject(UCCNC_CONFIG)',
      before09_26: BEFORE,
      after: {
        span: motionCounts(run.span),
        estimatedCutTimeSec: run.estimatedCutTimeMs !== undefined ? run.estimatedCutTimeMs / 1000 : null,
        helixRuns: helixRunSummary(run.moves),
        simulatedBoard: simSummary,
      },
    }, null, 2)}
`)
  })
})

let simSummary: Record<string, number> | null = null

/** Each helix: orbit radius, Z span, arcs, turns. */
function helixRunSummary(moves: readonly ToolpathMove[]) {
  const out: Array<{ radius: number; fromZ: number; toZ: number; arcs: number; turns: number }> = []
  for (let i = 0; i < moves.length; i++) {
    if (moves[i].role !== 'helix' || moves[i - 1]?.role === 'helix') continue
    let j = i
    while (j + 1 < moves.length && moves[j + 1].role === 'helix') j++
    const arcs = moves.slice(i, j + 1).filter(isArc)
    const a = arcs[0]
    const radius = a ? Math.hypot(a.x - a.cx!, a.y - a.cy!) : 0
    let sweep = 0
    for (let k = i + 1; k <= j; k++) {
      const p = moves[k - 1], m = moves[k]
      if (!isArc(m)) continue
      sweep += 2 * Math.asin(Math.min(1, Math.hypot(m.x - p.x, m.y - p.y) / (2 * radius)))
    }
    out.push({ radius: +radius.toFixed(4), fromZ: +moves[i].z.toFixed(4), toZ: +moves[j].z.toFixed(4), arcs: arcs.length, turns: +(sweep / (2 * Math.PI)).toFixed(2) })
  }
  return out
}
