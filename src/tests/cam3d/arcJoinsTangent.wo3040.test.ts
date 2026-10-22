// WO-3040: 3D adaptive arc joins are tangent (behind a switch).
//
// the operator 2026-10-21 18:05 UTC (Mission Control): "Paths must be tangent to their
// leading and trailing moves (other than obvious exceptions like vertical lifts,
// wall follows which require following part geometry which is not tangent, loop
// backs with lead-in/lead-out disabled, etc.)". WO-3036 measured that the
// adaptive smoother (src/cam3d/rough/smoothPath.ts) fits arcs within a POSITION
// tolerance only, so every join between two fitted moves jogs 0.3-5 deg.
//
// With ADAPTIVE_ARC_JOIN_POLICY.tangentJoins on, these tests judge the fitted
// path join by join, reading each move's heading tangent to tangent (an arc by
// its radius at that end, as WO-3036's stick reads it):
//   - a join is TANGENT when the heading turns by no more than JOIN_TANGENT_DEG;
//   - the exceptions keep the corner the planner drew: a vertex where the dense
//     planner path itself turns more than TANGENT_CORNER_DEG (a loop back, a
//     pass meeting a link, a wall corner); a join beside a move that changes Z
//     (a ramp, a plunge, a lift); and a turn too tight for an arc of the fit's
//     0.2 mm smallest radius within the tolerance (a line meets a line there,
//     turning as the planner drew it);
//   - every join where the planner's own path turns less than TIGHT_FROM_DEG is
//     tangent, with no exception;
//   - the fitted path stays within the fit tolerance (tolerance / 4) of the
//     dense planner path, both ways: no new gouge, no lost material.
// The switch ships ON since WO-3050 (the operator's yes on the before/after); with it
// off the fit is collapsePolyline, unchanged (P0 parity in src/tests/evidence/WO-3040/).
import { afterAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { ADAPTIVE_ARC_JOIN_POLICY, TANGENT_CORNER_DEG, smoothAdaptiveIr } from '../../cam3d/rough/smoothPath'
import type { IrMove } from '../../cam3d/ir/types'
import { planChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/alpha3Registry'
import { pathMetrics } from '../benchmark/metrics'
import type { ToolpathMove } from '../../types'

// The fitter's real inputs on the production route, recorded on the way past.
const recorded = vi.hoisted(() => ({ calls: [] as { tolerance: number; input: IrMove[]; output: IrMove[] }[] }))
vi.mock('../../cam3d/rough/smoothPath', async () => {
  const actual = await vi.importActual<typeof import('../../cam3d/rough/smoothPath')>('../../cam3d/rough/smoothPath')
  const { typedMock } = await import('../support/typedMock')
  return typedMock<typeof import('../../cam3d/rough/smoothPath')>({
    ...actual,
    smoothAdaptiveIr: (moves, tolerance, ...rest) => {
      const result = actual.smoothAdaptiveIr(moves, tolerance, ...rest)
      recorded.calls.push({ tolerance, input: [...moves], output: result.moves })
      return result
    },
  })
})

/** A join turning by no more than this, degrees, is tangent. */
const JOIN_TANGENT_DEG = 0.01
/** Below this planner turn, degrees, every join is tangent: no arc is too tight there. */
const TIGHT_FROM_DEG = 10
const fitToleranceOf = (tolerance: number) => Math.max(0.002, tolerance * 0.25)

interface Heading { x: number; y: number }
const unit = (x: number, y: number): Heading | null => {
  const l = Math.hypot(x, y)
  return l > 1e-9 ? { x: x / l, y: y / l } : null
}
const turnDeg = (a: Heading, b: Heading) =>
  (Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)) * 180) / Math.PI

/** Entry and exit heading of an in-plane feed or arc move (null for anything else). */
function headings(from: IrMove, move: IrMove): { entry: Heading; exit: Heading } | null {
  if (Math.abs(move.z - from.z) > 1e-9) return null
  if (move.t === 'arc') {
    const cx = from.x + (move.i ?? 0)
    const cy = from.y + (move.j ?? 0)
    const side = move.cw ? -1 : 1
    const entry = unit(-side * (from.y - cy), side * (from.x - cx))
    const exit = unit(-side * (move.y - cy), side * (move.x - cx))
    return entry && exit ? { entry, exit } : null
  }
  if (move.t !== 'feed') return null
  const d = unit(move.x - from.x, move.y - from.y)
  return d ? { entry: d, exit: d } : null
}

interface Join { at: number; kink: number; lines: boolean }
/** Every join between two consecutive in-plane moves, with the heading change there. */
function joins(moves: readonly IrMove[]): Join[] {
  const out: Join[] = []
  for (let k = 1; k + 1 < moves.length; k++) {
    const a = headings(moves[k - 1], moves[k])
    const b = headings(moves[k], moves[k + 1])
    if (a && b) out.push({ at: k, kink: turnDeg(a.exit, b.entry), lines: moves[k].t === 'feed' && moves[k + 1].t === 'feed' })
  }
  return out
}

/** Sample points along a move list (arcs walked), every `step` mm or closer. */
function samples(moves: readonly IrMove[], step: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let k = 1; k < moves.length; k++) {
    const from = moves[k - 1]
    const move = moves[k]
    if (move.t === 'arc') {
      const cx = from.x + (move.i ?? 0)
      const cy = from.y + (move.j ?? 0)
      const r = Math.hypot(from.x - cx, from.y - cy)
      const a0 = Math.atan2(from.y - cy, from.x - cx)
      let sweep = Math.atan2(move.y - cy, move.x - cx) - a0
      if (move.cw) { while (sweep > 0) sweep -= 2 * Math.PI } else { while (sweep < 0) sweep += 2 * Math.PI }
      const count = Math.max(2, Math.ceil((Math.abs(sweep) * r) / step))
      for (let i = 0; i <= count; i++) out.push({ x: cx + r * Math.cos(a0 + (sweep * i) / count), y: cy + r * Math.sin(a0 + (sweep * i) / count) })
    } else {
      const count = Math.max(1, Math.ceil(Math.hypot(move.x - from.x, move.y - from.y) / step))
      for (let i = 0; i <= count; i++) out.push({ x: from.x + ((move.x - from.x) * i) / count, y: from.y + ((move.y - from.y) * i) / count })
    }
  }
  return out
}

/** XY distance from q to the segment a-b. */
function segmentDistanceXY(q: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0
  return Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy)
}

/** Largest XY distance from any of `points` to the nearest of the move lists `paths`. */
function worstDistance(points: readonly { x: number; y: number }[], ...paths: (readonly IrMove[])[]): number {
  // Segments of the paths, arcs walked finely, bucketed on a grid for speed.
  const pts: { x: number; y: number }[] = []
  const joined: boolean[] = []
  for (const path of paths) {
    const walked = samples(path, 0.01)
    walked.forEach((p, k) => { pts.push(p); joined.push(k > 0) })
  }
  const cell = 0.5
  const grid = new Map<string, number[]>()
  for (let k = 0; k + 1 < pts.length; k++) {
    if (!joined[k + 1]) continue
    const x0 = Math.floor(Math.min(pts[k].x, pts[k + 1].x) / cell), x1 = Math.floor(Math.max(pts[k].x, pts[k + 1].x) / cell)
    const y0 = Math.floor(Math.min(pts[k].y, pts[k + 1].y) / cell), y1 = Math.floor(Math.max(pts[k].y, pts[k + 1].y) / cell)
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const key = `${gx},${gy}`
      const list = grid.get(key) ?? []
      list.push(k)
      grid.set(key, list)
    }
  }
  let worst = 0
  for (const p of points) {
    let best = Infinity
    const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const k of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
        const a = pts[k], b = pts[k + 1]
        const ex = b.x - a.x, ey = b.y - a.y
        const l2 = ex * ex + ey * ey
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0
        best = Math.min(best, Math.hypot(p.x - a.x - t * ex, p.y - a.y - t * ey))
      }
    }
    worst = Math.max(worst, best)
  }
  return worst
}

/** The dense path's own turn at each of its points, degrees (NaN where a neighbour leaves the plane). */
function denseTurns(input: readonly IrMove[]): Map<string, number> {
  const out = new Map<string, number>()
  for (let k = 1; k + 1 < input.length; k++) {
    let p = k - 1
    while (p > 0 && Math.hypot(input[p].x - input[k].x, input[p].y - input[k].y) <= 1e-9) p--
    let q = k + 1
    while (q + 1 < input.length && Math.hypot(input[q].x - input[k].x, input[q].y - input[k].y) <= 1e-9) q++
    const flat = Math.abs(input[p].z - input[k].z) <= 1e-9 && Math.abs(input[q].z - input[k].z) <= 1e-9
    const a = unit(input[k].x - input[p].x, input[k].y - input[p].y)
    const b = unit(input[q].x - input[k].x, input[q].y - input[k].y)
    const key = `${input[k].x},${input[k].y},${input[k].z}`
    const turn = flat && a && b && input[k].t === 'feed' && input[q].t === 'feed' ? turnDeg(a, b) : Number.NaN
    // A point the path passes twice keeps its sharpest turn.
    if (!(out.get(key)! >= turn)) out.set(key, turn)
  }
  return out
}

/**
 * Is a line-to-line kink too tight for a fillet of the fit's smallest radius
 * (0.2 mm) passing within half the fit tolerance of the corner? The fit rounds a
 * corner with tangent length d = min(half of either simplified segment,
 * (fit / 2) / tan(turn / 4)) and radius d / tan(turn / 2); each output line is
 * at most its simplified segment and at least half of it, so half the output
 * line is a lower bound on the half-segment the fit had.
 */
function tooTightToRound(output: readonly IrMove[], join: Join, fit: number): boolean {
  const p = output[join.at]
  const before = Math.hypot(p.x - output[join.at - 1].x, p.y - output[join.at - 1].y)
  const after = Math.hypot(output[join.at + 1].x - p.x, output[join.at + 1].y - p.y)
  const turn = (join.kink * Math.PI) / 180
  const d = Math.min(before / 2, after / 2, fit / 2 / Math.tan(turn / 4))
  return d / Math.tan(turn / 2) < 0.2
}

/** Classify every non-tangent join of a fitted path against the dense path it came from. */
function judge(input: readonly IrMove[], output: readonly IrMove[], tolerance = 0.05) {
  const turns = denseTurns(input)
  const counts = { joins: 0, tangent: 0, corner: 0, offPlane: 0, tight: 0, runChange: 0 }
  const unexplained: string[] = []
  for (const join of joins(output)) {
    counts.joins++
    if (join.kink <= JOIN_TANGENT_DEG) { counts.tangent++; continue }
    const p = output[join.at]
    const turn = turns.get(`${p.x},${p.y},${p.z}`)
    if (turn === undefined) unexplained.push(`a ${join.kink.toFixed(3)} deg kink at (${p.x}, ${p.y}) where the planner drew no vertex`)
    else if (Number.isNaN(turn)) counts.offPlane++
    else if (turn > TANGENT_CORNER_DEG) counts.corner++
    // A feed or role change between two lines stays sharp (no fillet moves it).
    else if (join.lines && (output[join.at].f !== output[join.at + 1].f || output[join.at].role !== output[join.at + 1].role)) counts.runChange++
    else if (turn >= TIGHT_FROM_DEG && join.lines && tooTightToRound(output, join, fitToleranceOf(tolerance))) counts.tight++
    else unexplained.push(`a ${join.kink.toFixed(3)} deg kink at (${p.x}, ${p.y}) where the planner turns ${turn.toFixed(3)} deg`)
  }
  return { counts, unexplained }
}

const feedMove = (x: number, y: number, z: number, role: IrMove['role'] = 'cut'): IrMove => ({ t: 'feed', x, y, z, f: 800, role })

/** A dense, slightly noisy sampling of a smooth closed-loop pass (the shape adaptive cuts). */
function smoothPass(): IrMove[] {
  const moves: IrMove[] = [{ t: 'rapid', x: 13, y: 0, z: 5, role: 'rapid' }, { t: 'feed', x: 13, y: 0, z: -1, f: 300, role: 'plunge' }]
  for (let i = 1; i <= 600; i++) {
    const a = (i / 600) * 2 * Math.PI
    // A trochoid-like lobe, sampled every ~0.15 mm, wobbling 2 um.
    const r = 10 + 3 * Math.cos(3 * a) + 0.002 * Math.sin(37 * i)
    moves.push(feedMove(r * Math.cos(a), r * Math.sin(a), -1))
  }
  moves.push({ t: 'rapid', x: moves[moves.length - 1].x, y: moves[moves.length - 1].y, z: 5, role: 'rapid' })
  return moves
}

describe('WO-3040 adaptive arc joins are tangent', () => {
  afterAll(() => { ADAPTIVE_ARC_JOIN_POLICY.tangentJoins = true })

  it('ships with the switch on (WO-3050)', () => {
    expect(ADAPTIVE_ARC_JOIN_POLICY.tangentJoins).toBe(true)
  })

  it('a dense smooth pass: every join tangent, within the fit tolerance both ways, fewer moves', () => {
    ADAPTIVE_ARC_JOIN_POLICY.tangentJoins = true
    const input = smoothPass()
    const tolerance = 0.05
    const output = smoothAdaptiveIr(input, tolerance).moves
    const verdict = judge(input, output)
    expect(verdict.unexplained).toEqual([])
    expect(verdict.counts.joins).toBeGreaterThan(10)
    expect(verdict.counts.tangent).toBe(verdict.counts.joins)
    expect(output.length).toBeLessThan(input.length / 4)
    const fit = fitToleranceOf(tolerance)
    expect(worstDistance(input.slice(1, -1), output.slice(1, -1))).toBeLessThanOrEqual(fit + 1e-6)
    expect(worstDistance(samples(output.slice(1, -1), 0.02), input.slice(1, -1))).toBeLessThanOrEqual(fit + 1e-6)
  })

  it('a polygon coarser than the tolerance is rounded at every vertex, inside the tolerance', () => {
    ADAPTIVE_ARC_JOIN_POLICY.tangentJoins = true
    // A 24-gon of radius 1.5 mm: its chords sag 0.013 mm off the circle, more
    // than the 0.0125 mm fit tolerance, so no arc through its vertices fits.
    const input: IrMove[] = [{ t: 'rapid', x: 1.5, y: 0, z: 5, role: 'rapid' }, { t: 'feed', x: 1.5, y: 0, z: -1, f: 300, role: 'plunge' }]
    for (let i = 1; i <= 24; i++) input.push(feedMove(1.5 * Math.cos((i * Math.PI) / 12), 1.5 * Math.sin((i * Math.PI) / 12), -1))
    const output = smoothAdaptiveIr(input, 0.05).moves
    const verdict = judge(input, output)
    expect(verdict.unexplained).toEqual([])
    expect(verdict.counts.tangent).toBe(verdict.counts.joins)
    expect(worstDistance(input.slice(1), output.slice(1))).toBeLessThanOrEqual(fitToleranceOf(0.05) + 1e-6)
    expect(worstDistance(samples(output.slice(1), 0.01), input.slice(1))).toBeLessThanOrEqual(fitToleranceOf(0.05) + 1e-6)
  })

  // WO-3040 fix round 1 (astra audit of 8542ed52): a fillet at a coarse corner
  // where the feed or role changes carried F800 / cut 0.095 mm into the F100
  // stepover. A feed or role change stays exactly where the planner put it:
  // every fitted move, end and middle, lies within the fit tolerance of an
  // input move with its own feed and role.
  it('never carries a feed or role across the point where the planner changes it', () => {
    ADAPTIVE_ARC_JOIN_POLICY.tangentJoins = true
    const tolerance = 0.05
    const fit = fitToleranceOf(tolerance)
    const audit: IrMove[] = [
      { t: 'rapid', x: 0, y: 0, z: 0 },
      { t: 'feed', x: 10, y: 0, z: 0, f: 800, role: 'cut' },
      { t: 'feed', x: 20, y: Math.tan(Math.PI / 12) * 10, z: 0, f: 100, role: 'stepover' },
    ]
    // A polygon coarser than the tolerance, its feed and role changing at every
    // other vertex.
    const ring: IrMove[] = [{ t: 'rapid', x: 20, y: 0, z: 0 }]
    for (let i = 1; i <= 24; i++) {
      const a = (i / 24) * 2 * Math.PI
      ring.push(i % 2 ? feedMove(20 * Math.cos(a), 20 * Math.sin(a), 0) : { ...feedMove(20 * Math.cos(a), 20 * Math.sin(a), 0, 'stepover'), f: 300 })
    }
    for (const input of [audit, ring]) {
      const output = smoothAdaptiveIr(input, tolerance).moves
      // The audit's corner: cut ends exactly at (10, 0), stepover starts there.
      if (input === audit) {
        const lastCut = output.map(m => m.role).lastIndexOf('cut')
        expect([output[lastCut].x, output[lastCut].y]).toEqual([10, 0])
        expect(output[lastCut + 1]).toMatchObject({ f: 100, role: 'stepover' })
      }
      for (let k = 1; k < output.length; k++) {
        const move = output[k]
        if (move.t === 'rapid') continue
        const own = input.flatMap((m, i) => (i > 0 && m.t !== 'rapid' && m.f === move.f && m.role === move.role ? [[input[i - 1], m]] : []))
        const points = samples([output[k - 1], move], 0.01).slice(1)
        const wrong = points.filter(q => !own.some(([a, b]) => segmentDistanceXY(q, a, b) <= fit + 1e-9))
        expect(wrong, `${move.role} F${move.f} move ${k} leaves its own run`).toEqual([])
      }
    }
  })

  it('keeps the corners the planner drew and is tangent everywhere else, across a role change', () => {
    ADAPTIVE_ARC_JOIN_POLICY.tangentJoins = true
    // A smooth bend (cut, then the same curve continuing as a stepover), then a
    // 90 deg corner, then a straight.
    const input: IrMove[] = [{ t: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }, { t: 'feed', x: 0, y: 0, z: -1, f: 300, role: 'plunge' }]
    for (let i = 1; i <= 120; i++) {
      const a = (i / 120) * (Math.PI / 2)
      input.push(feedMove(8 * Math.sin(a), 8 - 8 * Math.cos(a), -1, i <= 60 ? 'cut' : 'stepover'))
    }
    for (let i = 1; i <= 20; i++) input.push(feedMove(8 - i * 0.25, 8, -1, 'stepover'))
    const output = smoothAdaptiveIr(input, 0.05).moves
    const verdict = judge(input, output)
    expect(verdict.unexplained).toEqual([])
    expect(verdict.counts.corner).toBe(1)
    expect(verdict.counts.tangent).toBe(verdict.counts.joins - 1)
    // The role change is still where the planner put it.
    const change = output.findIndex(move => move.role === 'stepover')
    expect(Math.hypot(output[change - 1].x - 8 * Math.sin(Math.PI / 4), output[change - 1].y - (8 - 8 * Math.cos(Math.PI / 4)))).toBeLessThan(1e-9)
  })

  it('form-sphere default (production route): no kink below 10 deg, every other kink a named exception, within tolerance', async () => {
    ADAPTIVE_ARC_JOIN_POLICY.tangentJoins = true
    recorded.calls.length = 0
    const chain = alpha3Chains().find(c => c.id === 'form-sphere-default')!
    const planned = await planChain({ ...chain, steps: chain.steps.filter(step => step.type === 'adaptive_3d').slice(0, 1) })
    const step = planned.steps[0]
    expect(step.status).toBe('ready')
    // The published path is the fitted one (the retained-model gate accepted it
    // rather than falling back to the raw planner path): its arcs are the fit's.
    expect(recorded.calls.length).toBeGreaterThan(0)
    const publishedArcs = step.moves.filter(move => move.type === 'arc_cw' || move.type === 'arc_ccw').length
    expect(publishedArcs).toBeGreaterThan(0)
    expect(publishedArcs).toBe(recorded.calls.reduce((sum, call) => sum + call.output.filter(move => move.t === 'arc').length, 0))

    const totals = { joins: 0, tangent: 0, corner: 0, offPlane: 0, tight: 0 }
    for (const call of recorded.calls) {
      const verdict = judge(call.input, call.output, call.tolerance)
      expect(verdict.unexplained).toEqual([])
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += verdict.counts[key]
      // Within the fit tolerance of the dense path, both ways, plane by plane.
      const fit = fitToleranceOf(call.tolerance)
      const byZ = (moves: readonly IrMove[]) => {
        const groups = new Map<number, IrMove[][]>()
        let run: IrMove[] = []
        const flush = () => { if (run.length > 1) groups.set(run[0].z, [...(groups.get(run[0].z) ?? []), run]); run = [] }
        for (const move of moves) {
          if ((move.t === 'feed' || move.t === 'arc') && run.length && Math.abs(move.z - run[0].z) <= 1e-9) run.push(move)
          else { flush(); run = [move] }
        }
        flush()
        return groups
      }
      const inputByZ = byZ(call.input)
      const outputByZ = byZ(call.output)
      for (const [z, runs] of outputByZ) {
        const reference = inputByZ.get(z)
        expect(reference, `fitted moves at z ${z} the planner never drew`).toBeDefined()
        for (const run of runs) expect(worstDistance(samples(run, 0.02), ...reference!)).toBeLessThanOrEqual(fit + 1e-6)
      }
      for (const [z, runs] of inputByZ) {
        const fitted = outputByZ.get(z)
        expect(fitted, `planner moves at z ${z} the fit dropped`).toBeDefined()
        for (const run of runs) expect(worstDistance(run, ...fitted!)).toBeLessThanOrEqual(fit + 1e-6)
      }
    }
    // Every join where the planner turns under 10 deg is tangent; the corners
    // over 30 deg and the off-plane joins keep the planner's corner; the tight
    // 10-30 deg turns are a small share (87 of 2,796 joins, 3.1 %, when written).
    expect(totals.tangent).toBeGreaterThan(0.75 * totals.joins)
    expect(totals.tight).toBeLessThan(0.04 * totals.joins)

    // The published path (world coordinates) reads the same: no join between two
    // in-plane moves jogs by more than 0.01 deg and less than 10 deg, except
    // where the feed or role changes (kept sharp, counted above).
    const published = step.moves.map((move: ToolpathMove, index: number, all: ToolpathMove[]): IrMove => move.type === 'arc_cw' || move.type === 'arc_ccw'
      ? { t: 'arc', x: move.x, y: move.y, z: move.z, i: move.cx! - all[index - 1].x, j: move.cy! - all[index - 1].y, cw: move.type === 'arc_cw' }
      : { t: move.type, x: move.x, y: move.y, z: move.z })
    const runChange = (k: number) => step.moves[k].feed !== step.moves[k + 1].feed || step.moves[k].role !== step.moves[k + 1].role
    const jogs = joins(published).filter(join => join.kink > JOIN_TANGENT_DEG && join.kink < TIGHT_FROM_DEG && !runChange(join.at))
    expect(jogs.map(join => `${join.kink.toFixed(3)} deg at move ${join.at}`)).toEqual([])
    expect(pathMetrics(step.moves).turns).toBeGreaterThan(0)
  }, 1_800_000)

  it('the committed ON/OFF comparison holds cycle time, safety and part metrics (src/tests/evidence/WO-3040/)', () => {
    const record = JSON.parse(readFileSync('src/tests/evidence/WO-3040/compare.json', 'utf8')) as {
      rows: { row: string; off: Record<string, number>; on: Record<string, number> }[]
    }
    expect(new Set(record.rows.map(row => row.row.split('/')[0]))).toEqual(new Set(['form-box-default', 'form-sphere-default', 'form-torus-default']))
    for (const { row, off, on } of record.rows) {
      // Safety and part metrics hold; cycle time and flip rate hold or improve.
      for (const key of Object.keys(off).filter(name => name.startsWith('M-SAFE-') || name.startsWith('M-PART-'))) {
        expect(on[key], `${row} ${key}`).toBe(off[key])
      }
      // A rest row that plans nothing on either side (form-sphere tool 2) has no time or flips.
      if (off.cutTimeMs === undefined) {
        expect(on.cutTimeMs, row).toBeUndefined()
        continue
      }
      expect(on.cutTimeMs, row).toBeLessThanOrEqual(off.cutTimeMs)
      expect(on.flipRatePct, row).toBeLessThanOrEqual(off.flipRatePct)
      // Where the published path carries the fit's arcs, no join jogs under 10 deg.
      // A row whose published path has no arc at all was re-sampled into lines
      // downstream of the fit (the holder-clearance trim, src/lib/cam/
      // holderClearance.ts:2089), so the fit's joins never reach the machine there.
      if (on.arcMoves > 0) expect(on.smallJoinKinks, row).toBe(0)
    }
  })
})
