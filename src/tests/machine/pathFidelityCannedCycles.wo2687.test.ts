// WO-2687: the text-door path check reads a canned drill cycle's hole as the
// moves the controller makes for it - the 3D preview's expansion, the same one
// the simulator runs - and the analysis holds the several moves one source
// line commands as one run of spans. A real departure inside a hole still
// reads red.

import { describe, expect, it } from 'vitest'
import type { MachineVec3, QueuedMove } from '../../lib/machine/controller'
import {
  analysePathFidelity,
  commandedPathFromProgram,
  resolveMoveSpans,
  type MoveSpan,
  type PathFidelitySample,
  type ProgramFramedMove,
} from '../../lib/machine/pathFidelity'
import { SimulatedController } from '../../lib/machine/simulatedController'

const RAPID = 5000
const G54: MachineVec3 = { x: 300, y: 300, z: 60 }
const START: MachineVec3 = { x: 0, y: 0, z: 15 }

const PECK = [
  'G90 G94 G21',
  'G54',
  'G0 Z15',
  'G0 X10 Y10',
  'G98 G83 X10 Y10 Z-5 R2 Q2.5 F300',
  'X30',
  'G80',
  'G0 Z15',
  'M30',
  '',
].join('\n')

type Line = Extract<QueuedMove, { kind: 'line' }>

function linesOf(moves: readonly QueuedMove[], id: number): Line[] {
  return moves.filter((m): m is Line => m.kind === 'line' && m.id === id)
}

/** Fly the commanded moves exactly, one status frame per `stepMm` of travel at
 *  each move's feed, the way a controller reporting its executing move would. */
function fly(
  moves: readonly QueuedMove[],
  start: MachineVec3,
  displace: (id: number, frame: number) => MachineVec3 = () => ({ x: 0, y: 0, z: 0 }),
  offset: MachineVec3 = G54,
): PathFidelitySample[] {
  const samples: PathFidelitySample[] = []
  let at = 1_000
  let pos = { ...start }
  const perId = new Map<number, number>()
  for (const move of moves) {
    if (move.kind !== 'line') throw new Error(`unexpected ${move.kind}`)
    const to = { x: move.to.x ?? pos.x, y: move.to.y ?? pos.y, z: move.to.z ?? pos.z }
    const length = Math.hypot(to.x - pos.x, to.y - pos.y, to.z - pos.z)
    const steps = Math.max(1, Math.ceil(length / 0.5))
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      at += (length / steps / move.feedMmMin) * 60_000 + 1
      const frame = perId.get(move.id) ?? 0
      perId.set(move.id, frame + 1)
      const d = displace(move.id, frame)
      const work = {
        x: pos.x + (to.x - pos.x) * t + d.x,
        y: pos.y + (to.y - pos.y) * t + d.y,
        z: pos.z + (to.z - pos.z) * t + d.z,
      }
      samples.push({
        atMs: at,
        workPos: work,
        machinePos: { x: work.x + offset.x, y: work.y + offset.y, z: work.z + offset.z },
        executingMoveId: move.id,
      })
    }
    pos = to
  }
  return samples
}

describe('WO-2687: the path check reads a canned drill cycle as the moves it makes', () => {
  it('expands each G83 hole into its pecks and the G98 return, modal X repeats included', () => {
    const path = commandedPathFromProgram(PECK, { rapidFeedMmMin: RAPID, startPos: START })
    expect(path.refusal).toBeNull()
    expect(path.unmodelledMoveIds).toEqual([])
    for (const [id, x] of [[5, 10], [6, 30]] as const) {
      const moves = linesOf(path.moves, id)
      // Not one straight line to the bottom: rapid over, rapid to R, pecks, return.
      expect(moves.length, `line ${id}`).toBeGreaterThan(3)
      const zs = moves.map((m) => m.to.z!)
      expect(Math.min(...zs), `line ${id}`).toBeCloseTo(-5, 9)
      // G98: back to the Z the hole started from (the initial plane, 15).
      expect(zs[zs.length - 1], `line ${id}`).toBeCloseTo(15, 9)
      // Two Q2.5 pecks from R2 reach Z-5 (2 -> -0.5 -> -3 -> -5 is three feeds).
      const feeds = moves.filter((m) => m.feedMmMin === 300)
      expect(feeds.map((m) => m.to.z!)).toEqual([-0.5, -3, -5])
      // Rapid back to R between pecks.
      expect(zs.filter((z) => Math.abs(z - 2) < 1e-9).length).toBeGreaterThanOrEqual(feeds.length)
      expect(moves.slice(1).every((m) => m.to.x === x && m.to.y === 10), `line ${id}`).toBe(true)
    }
  })

  it('G99 returns to R, not to the initial plane', () => {
    const text = PECK.replace('G98 G83', 'G99 G83')
    const path = commandedPathFromProgram(text, { rapidFeedMmMin: RAPID, startPos: START })
    expect(path.refusal).toBeNull()
    const hole = linesOf(path.moves, 5)
    expect(hole[hole.length - 1].to.z).toBeCloseTo(2, 9)
    const next = linesOf(path.moves, 6)
    // The next hole's XY move is made at R.
    expect(next[0].to).toMatchObject({ x: 30, y: 10, z: 2 })
  })

  it('a machine that flies the expanded holes reads clean on every frame it reported', () => {
    const path = commandedPathFromProgram(PECK, { rapidFeedMmMin: RAPID, startPos: START })
    const samples = fly(path.moves, START)
    const report = analysePathFidelity({
      moves: path.moves,
      startPos: path.startPos,
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      workFrame: 'G54',
      unmodelledMoveIds: path.unmodelledMoveIds,
    })
    expect(report.verdict, report.headline).toBe('clean')
    expect(report.worst!.deviationMm).toBeLessThan(1e-9)
    expect(report.samples.attributed).toBe(samples.length)
    expect(report.samples.unmodelled).toBe(0)
  })

  it('a departure inside a canned hole is still a departure', () => {
    const path = commandedPathFromProgram(PECK, { rapidFeedMmMin: RAPID, startPos: START })
    // 2 mm off in X for a stretch of the second hole's pecks.
    const samples = fly(path.moves, START, (id, frame) =>
      id === 6 && frame >= 60 && frame < 80 ? { x: 2, y: 0, z: 0 } : { x: 0, y: 0, z: 0 })
    const report = analysePathFidelity({
      moves: path.moves,
      startPos: path.startPos,
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      workFrame: 'G54',
      unmodelledMoveIds: path.unmodelledMoveIds,
    })
    expect(report.verdict, report.headline).toBe('divergence')
    expect(report.headline).toContain('LEFT THE COMMANDED PATH')
    expect(report.worst!.deviationMm).toBeCloseTo(2, 3)
    expect(report.worst!.moveId).toBe(6)
  })

  it('a program that ends with the post\'s G28 still has its holes measured', () => {
    // Audit 10-08: the program end "home" closes with G28, which the 3D preview
    // cannot draw. Only the G28 block is unmodelled; every hole is expanded.
    const text = PECK.replace('M30', 'G28\nM30')
    const path = commandedPathFromProgram(text, { rapidFeedMmMin: RAPID, startPos: START })
    expect(path.refusal).toBeNull()
    expect(path.unmodelledMoveIds).toEqual([9, 10])
    for (const id of [5, 6]) {
      const zs = linesOf(path.moves, id).map((m) => m.to.z!)
      expect(zs.length, `line ${id}`).toBeGreaterThan(3)
      expect(Math.min(...zs), `line ${id}`).toBeCloseTo(-5, 9)
      expect(zs[zs.length - 1], `line ${id}`).toBeCloseTo(15, 9)
    }
    const report = analysePathFidelity({
      moves: path.moves,
      startPos: path.startPos,
      samples: fly(path.moves, START),
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      workFrame: 'G54',
      unmodelledMoveIds: path.unmodelledMoveIds,
    })
    expect(report.verdict, report.headline).toBe('clean')
  })

  it('a frame change or restart on a line of several moves is applied once, at its first', () => {
    const moves: QueuedMove[] = [
      { id: 1, kind: 'line', to: { x: 10, y: 0, z: 0 }, feedMmMin: 1000 },
      { id: 2, kind: 'line', to: { x: 10, y: 0, z: -2 }, feedMmMin: 1000 },
      { id: 2, kind: 'line', to: { x: 10, y: 0, z: 5 }, feedMmMin: 1000 },
    ]
    const shifted = resolveMoveSpans(moves, { x: 0, y: 0, z: 0 }, [
      { atMs: 0, firstMoveId: 2, fromFrame: 'G54', toFrame: 'G55', shift: { x: 100, y: 0, z: 0 } },
    ])
    // Both of line 2's moves start where the shifted line before them ended.
    expect(shifted[1].from.x).toBeCloseTo(10, 9)
    expect(shifted[2].from).toEqual(shifted[1].to)
    expect(shifted[2].lengthMm).toBeCloseTo(7, 9)

    const restarted = resolveMoveSpans(moves, { x: 0, y: 0, z: 0 }, [], [
      { moveId: 2, at: { x: 10, y: 0, z: 3 } },
    ])
    expect(restarted[1].from).toEqual({ x: 10, y: 0, z: 3 })
    // The second move of line 2 starts where the first ended, not at the restart.
    expect(restarted[2].from).toEqual({ x: 10, y: 0, z: -2 })
  })

  describe('fix round 1 (machine seat 10-08): the program selects its own G56 while G54 is selected', () => {
    // G54 is the machine frame (offset 0); G56 sits at X300 Y300 Z60. Home
    // parks the tool at machine 738/724.5/129.1 - G56 X438 Y424.5 Z69.1.
    const G56: MachineVec3 = { x: 300, y: 300, z: 60 }
    const HOME: MachineVec3 = { x: 738, y: 724.5, z: 129.1 }
    const program = PECK.replace('G54', 'G56')

    /** The run as the controller reports it: the start frame in G54, then -
     *  once the program's G56 line has run, before any motion - in G56. */
    function run(displace?: (id: number, frame: number) => MachineVec3): PathFidelitySample[] {
      const path = commandedPathFromProgram(program, { rapidFeedMmMin: RAPID, startPos: HOME })
      const inG56 = { x: HOME.x - G56.x, y: HOME.y - G56.y, z: HOME.z - G56.z }
      return [
        { atMs: 500, workPos: { ...HOME }, machinePos: { ...HOME }, executingMoveId: null },
        { atMs: 600, workPos: inG56, machinePos: { ...HOME }, executingMoveId: 2 },
        ...fly(path.moves.map((move) => (move.kind === 'line'
          ? { ...move, to: { x: move.to.x ?? inG56.x, y: move.to.y ?? inG56.y, z: move.to.z ?? inG56.z } }
          : move)), inG56, displace, G56),
      ]
    }

    function analyse(samples: PathFidelitySample[]) {
      const path = commandedPathFromProgram(program, { rapidFeedMmMin: RAPID, startPos: HOME })
      expect(path.refusal).toBeNull()
      return analysePathFidelity({
        moves: path.moves,
        startPos: path.startPos,
        samples,
        reportsExecutingMoveId: true,
        toleranceMm: 0.03,
        commandedFrame: 'work',
        workFrame: 'G54',
        unmodelledMoveIds: path.unmodelledMoveIds,
      })
    }

    it('reads clean, and names G56 with G56 numbers', () => {
      const report = analyse(run())
      expect(report.verdict, report.headline).toBe('clean')
      expect(report.worst!.deviationMm).toBeLessThan(1e-9)
      expect(report.worst!.at).toMatch(/^G56 /)
    })

    it('a departure inside a hole after the switch is still a departure, named in G56', () => {
      const report = analyse(run((id, frame) =>
        id === 6 && frame >= 60 && frame < 80 ? { x: 2, y: 0, z: 0 } : { x: 0, y: 0, z: 0 }))
      expect(report.verdict, report.headline).toBe('divergence')
      expect(report.headline).toContain('LEFT THE COMMANDED PATH')
      expect(report.worst!.deviationMm).toBeCloseTo(2, 3)
      expect(report.worst!.moveId).toBe(6)
      expect(report.worst!.at).toMatch(/^G56 X 32 Y 10 /)
    })

    it('a move the program has not restated since its G56 carries that axis from where the tool is', () => {
      const path = commandedPathFromProgram(program, { rapidFeedMmMin: RAPID, startPos: HOME })
      // 'G0 Z15' names Z alone: X and Y are HOME's, which G54 numbers cannot say in G56.
      expect(linesOf(path.moves, 3).map((m) => m.to)).toEqual([{ z: 15 }])
      expect((path.moves[0] as { programFrame?: string }).programFrame).toBe('G56')
      expect(linesOf(path.moves, 4).map((m) => m.to)).toEqual([{ x: 10, y: 10, z: 15 }])
    })
  })
})

// Fix round 2 (review FAIL, astra 10-08): fix round 1 marked every axis
// unknown on ANY G54..G59 word, so repeating the frame already in effect threw
// away an ordinary arc and everything after it - CANNOT ASSESS where main reads
// clean. A repeat changes nothing; after a real switch an arc starts where the
// tool is, carried across the switch the analysis observes, like any other
// axis the program has not restated.
describe('WO-2687 fix round 2: the program repeating its frame loses nothing', () => {
  /** Points along resolved spans, one per ~0.5 mm, as a controller reporting
   *  its executing line would send them. XY arcs only. */
  function trace(spans: readonly MoveSpan[]): { id: number; p: MachineVec3; ms: number }[] {
    const out: { id: number; p: MachineVec3; ms: number }[] = []
    for (const span of spans) {
      const steps = Math.max(1, Math.ceil(span.lengthMm / 0.5))
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const z = span.from.z + (span.to.z - span.from.z) * t
        let p: MachineVec3
        if (span.arc === null) {
          p = { x: span.from.x + (span.to.x - span.from.x) * t, y: span.from.y + (span.to.y - span.from.y) * t, z }
        } else {
          const c = span.arc.centre
          const a = Math.atan2(span.from.y - c.y, span.from.x - c.x) + span.arc.sweepRad * t
          p = { x: c.x + span.arc.radiusMm * Math.cos(a), y: c.y + span.arc.radiusMm * Math.sin(a), z }
        }
        out.push({ id: span.id, p, ms: (span.lengthMm / steps / (span.feedMmMin ?? RAPID)) * 60_000 + 1 })
      }
    }
    return out
  }

  function samplesOf(
    points: { id: number; p: MachineVec3; ms: number }[],
    offset: MachineVec3,
    from = 1_000,
    displace: (id: number, frame: number) => MachineVec3 = () => ({ x: 0, y: 0, z: 0 }),
  ): PathFidelitySample[] {
    let at = from
    const perId = new Map<number, number>()
    return points.map(({ id, p, ms }) => {
      at += ms
      const frame = perId.get(id) ?? 0
      perId.set(id, frame + 1)
      const d = displace(id, frame)
      const work = { x: p.x + d.x, y: p.y + d.y, z: p.z + d.z }
      return {
        atMs: at,
        workPos: work,
        machinePos: { x: work.x + offset.x, y: work.y + offset.y, z: work.z + offset.z },
        executingMoveId: id,
      }
    })
  }

  const geometry = (span: MoveSpan) => ({ id: span.id, from: span.from, to: span.to, arc: span.arc })
  const idsOf = (moves: readonly QueuedMove[]) => [...new Set(moves.map((m) => m.id))]

  function analyse(text: string, start: MachineVec3, samples: PathFidelitySample[]) {
    const path = commandedPathFromProgram(text, { rapidFeedMmMin: RAPID, startPos: start })
    return analysePathFidelity({
      moves: path.moves,
      startPos: path.startPos,
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      workFrame: 'G54',
      unmodelledMoveIds: path.unmodelledMoveIds,
      ...(path.restartsAt === undefined ? {} : { restartsAt: path.restartsAt }),
    })
  }

  it('the review\'s program: G54 selected, the program repeats G54, then an arc and a line - as main reads it', () => {
    const text = ['G21 G90 G17', 'G54', 'G3 X0 Y10 I-10 J0 F300', 'G1 X0 Y20', 'M30', ''].join('\n')
    const start: MachineVec3 = { x: 10, y: 0, z: 0 }
    const path = commandedPathFromProgram(text, { rapidFeedMmMin: RAPID, startPos: start })
    expect(path.refusal).toBeNull()
    expect(idsOf(path.moves)).toEqual([3, 4])
    expect(path.unmodelledMoveIds).toEqual([])
    const main: QueuedMove[] = [
      { id: 3, kind: 'arc', to: { x: 0, y: 10, z: 0 }, centre: { x: 0, y: 0, z: 0 }, clockwise: false, plane: 'xy', feedMmMin: 300 },
      { id: 4, kind: 'line', to: { x: 0, y: 20, z: 0 }, feedMmMin: 300 },
    ]
    const want = resolveMoveSpans(main, start)
    expect(resolveMoveSpans(path.moves, start).map(geometry)).toEqual(want.map(geometry))

    const samples = samplesOf(trace(want), G54)
    const report = analyse(text, start, samples)
    expect(report.verdict, report.headline).toBe('clean')
    expect(report.worst!.deviationMm).toBeLessThan(1e-9)
    expect(report.samples.attributed).toBe(samples.length)
    expect(report.samples.unmodelled).toBe(0)
  })

  it('the review\'s second probe: a fully stated move, a repeated G54, then an arc and a line - ids [3,4,6,7], clean', () => {
    const text = ['G21 G90 G17', 'G54', 'G0 X10 Y0 Z5', 'G1 Z0 F300', 'G54', 'G3 X0 Y10 I-10 J0', 'G1 X0 Y20', 'M30', ''].join('\n')
    const start: MachineVec3 = { x: 0, y: 0, z: 20 }
    const path = commandedPathFromProgram(text, { rapidFeedMmMin: RAPID, startPos: start })
    expect(path.refusal).toBeNull()
    expect(idsOf(path.moves)).toEqual([3, 4, 6, 7])
    expect(path.unmodelledMoveIds).toEqual([])
    const main: QueuedMove[] = [
      { id: 3, kind: 'line', to: { x: 10, y: 0, z: 5 }, feedMmMin: RAPID },
      { id: 4, kind: 'line', to: { x: 10, y: 0, z: 0 }, feedMmMin: 300 },
      { id: 6, kind: 'arc', to: { x: 0, y: 10, z: 0 }, centre: { x: 0, y: 0, z: 0 }, clockwise: false, plane: 'xy', feedMmMin: 300 },
      { id: 7, kind: 'line', to: { x: 0, y: 20, z: 0 }, feedMmMin: 300 },
    ]
    const want = resolveMoveSpans(main, start)
    expect(resolveMoveSpans(path.moves, start).map(geometry)).toEqual(want.map(geometry))
    const samples = samplesOf(trace(want), G54)
    const report = analyse(text, start, samples)
    expect(report.verdict, report.headline).toBe('clean')
    expect(report.samples.attributed).toBe(samples.length)
    expect(report.samples.unmodelled).toBe(0)
  })

  it('a G98 hole whose Z the program has not restated since its G54 returns to the Z it started from', () => {
    const text = ['G21 G90 G17', 'G54', 'G0 X10 Y10', 'G98 G81 X10 Y10 Z-5 R2 F300', 'G80', 'M30', ''].join('\n')
    const path = commandedPathFromProgram(text, { rapidFeedMmMin: RAPID, startPos: START })
    expect(path.refusal).toBeNull()
    expect(idsOf(path.moves)).toEqual([3, 4])
    expect(path.unmodelledMoveIds).toEqual([])
    const spans = resolveMoveSpans(path.moves, START)
    const hole = spans.filter((span) => span.id === 4)
    expect(Math.min(...hole.map((span) => span.to.z))).toBeCloseTo(-5, 9)
    expect(hole[hole.length - 1].to).toEqual({ x: 10, y: 10, z: 15 })
    const samples = samplesOf(trace(spans), G54)
    const report = analyse(text, START, samples)
    expect(report.verdict, report.headline).toBe('clean')
    expect(report.samples.unmodelled).toBe(0)
  })

  describe('a real switch: G56 under a selected G54, then an arc that does not restate its start', () => {
    // G54 is the machine frame; G56 sits at X5 Y0 Z-2. Line 2 leaves the tool
    // at machine 10/0/5 - G56 X5 Y0 Z7 - where the arc starts.
    const G56: MachineVec3 = { x: 5, y: 0, z: -2 }
    const start: MachineVec3 = { x: 20, y: 0, z: 5 }
    const text = ['G21 G90 G17', 'G0 X10 Y0 Z5', 'G56', 'G3 X-5 Y10 I-10 J0 F300', 'G1 X-5 Y20', 'M30', ''].join('\n')

    function run(displace?: (id: number, frame: number) => MachineVec3): PathFidelitySample[] {
      const inG54 = samplesOf(trace(resolveMoveSpans([
        { id: 2, kind: 'line', to: { x: 10, y: 0, z: 5 }, feedMmMin: RAPID },
      ], start)), { x: 0, y: 0, z: 0 })
      const at = { x: 10 - G56.x, y: 0 - G56.y, z: 5 - G56.z }
      const switched: PathFidelitySample = {
        atMs: inG54[inG54.length - 1].atMs + 50, workPos: at, machinePos: { x: 10, y: 0, z: 5 }, executingMoveId: 3,
      }
      const inG56 = samplesOf(trace(resolveMoveSpans([
        { id: 4, kind: 'arc', to: { x: -5, y: 10, z: 7 }, centre: { x: -5, y: 0, z: 7 }, clockwise: false, plane: 'xy', feedMmMin: 300 },
        { id: 5, kind: 'line', to: { x: -5, y: 20, z: 7 }, feedMmMin: 300 },
      ], at)), G56, switched.atMs, displace)
      return [...inG54, switched, ...inG56]
    }

    it('the arc and the line after it are measured, clean, named in G56', () => {
      const path = commandedPathFromProgram(text, { rapidFeedMmMin: RAPID, startPos: start })
      expect(path.refusal).toBeNull()
      expect(idsOf(path.moves)).toEqual([2, 4, 5])
      expect(path.unmodelledMoveIds).toEqual([])
      const report = analyse(text, start, run())
      expect(report.verdict, report.headline).toBe('clean')
      expect(report.worst!.deviationMm).toBeLessThan(1e-9)
      expect(report.samples.unmodelled).toBe(0)
      expect(report.worst!.at).toMatch(/^G56 /)
    })

    it('a 2 mm departure on that arc is still a departure', () => {
      const report = analyse(text, start, run((id, frame) =>
        id === 4 && frame >= 10 && frame < 20 ? { x: 2, y: 0, z: 0 } : { x: 0, y: 0, z: 0 }))
      expect(report.verdict, report.headline).toBe('divergence')
      expect(report.worst!.moveId).toBe(4)
      expect(report.worst!.deviationMm).toBeGreaterThan(1)
    })
  })

  describe('fix round 3 (review 2): after a real switch, a word equal to the number the frame left still moves the tool', () => {
    // G54 is the machine frame. Each program leaves the tool, in G54, at the
    // very numbers line 6 names, selects G56, and only then moves: the same
    // numbers in G56 are somewhere else, and the simulator goes there.
    const start: MachineVec3 = { x: 0, y: 0, z: 0 }
    const REVIEW = ['G21 G90 G17', 'G54', 'G0 X10 Y10 Z15', 'G56', 'G0 Z15', 'G98 G81 X10 Y10 Z-5 R2 F300', 'G80', 'M30', ''].join('\n')
    const CASES: { name: string; text: string; g56: MachineVec3; ids: number[] }[] = [
      { name: 'the review\'s G98 G81 hole', text: REVIEW, g56: { x: 100, y: 100, z: 0 }, ids: [6] },
      {
        name: 'a G99 G81 hole',
        text: REVIEW.replace('G98 G81', 'G99 G81'),
        g56: { x: 100, y: 100, z: 0 },
        ids: [6],
      },
      {
        name: 'a G98 G83 peck hole',
        text: REVIEW.replace('G98 G81 X10 Y10 Z-5 R2 F300', 'G98 G83 X10 Y10 Z-5 R2 Q2.5 F300'),
        g56: { x: 100, y: 100, z: 0 },
        ids: [6],
      },
      {
        // Z not restated either, and its old number equals R.
        name: 'a G98 G81 hole whose carried Z equals R',
        text: ['G21 G90 G17', 'G54', 'G0 X10 Y10 Z2', 'G56', 'G17', 'G98 G81 X10 Y10 Z-5 R2 F300', 'G80', 'M30', ''].join('\n'),
        g56: { x: 100, y: 100, z: -10 },
        ids: [6],
      },
      {
        name: 'a plain G0 and G1',
        text: ['G21 G90 G17', 'G54', 'G0 X10 Y10 Z15', 'G56', 'G0 X10 Y10', 'G1 Z-5 F300', 'M30', ''].join('\n'),
        g56: { x: 100, y: 100, z: 0 },
        ids: [5, 6],
      },
    ]

    /** The machine targets the production simulator stages for `ids`. */
    function simulated(text: string, g56: MachineVec3, ids: number[]): MachineVec3[] {
      const sim = new SimulatedController({}, { workOffsets: { G54: { x: 0, y: 0, z: 0 }, G56: g56 } })
      const outcome = sim.loadJob(text)
      expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true)
      return (sim as unknown as { pendingProgram: QueuedMove[] }).pendingProgram
        .filter((m): m is Line => m.kind === 'line' && ids.includes(m.id))
        .map((m) => m.to as MachineVec3)
    }

    /** The switch as the analysis observes it, at the move the program names G56 on. */
    const switched = (moves: readonly QueuedMove[], g56: MachineVec3) => {
      const first = moves.find((m) => (m as ProgramFramedMove).programFrame === 'G56')
      expect(first).toBeDefined()
      return [{ atMs: 1_000, firstMoveId: first!.id, fromFrame: 'G54', toFrame: 'G56', shift: { x: -g56.x, y: -g56.y, z: -g56.z } }]
    }

    it('the simulator stages the review\'s hole at machine X110 Y110: across, R, depth, back to the G98 plane', () => {
      expect(simulated(REVIEW, { x: 100, y: 100, z: 0 }, [6])).toEqual([
        { x: 110, y: 110, z: 15 }, { x: 110, y: 110, z: 2 }, { x: 110, y: 110, z: -5 }, { x: 110, y: 110, z: 15 },
      ])
    })

    for (const { name, text, g56, ids } of CASES) {
      it(`${name}: the commanded spans are the moves the simulator stages, in machine numbers`, () => {
        const path = commandedPathFromProgram(text, { rapidFeedMmMin: RAPID, startPos: start })
        expect(path.refusal).toBeNull()
        expect(path.unmodelledMoveIds).toEqual([])
        const spans = resolveMoveSpans(path.moves, start, switched(path.moves, g56)).filter((span) => ids.includes(span.id))
        const want = simulated(text, g56, ids)
        expect(spans.map((span) => span.to)).toHaveLength(want.length)
        spans.forEach((span, k) => {
          expect(span.to.x, `${name} move ${k}`).toBeCloseTo(want[k].x, 9)
          expect(span.to.y, `${name} move ${k}`).toBeCloseTo(want[k].y, 9)
          expect(span.to.z, `${name} move ${k}`).toBeCloseTo(want[k].z, 9)
        })
      })
    }

    it('the review\'s samples, flown along the simulator\'s own moves, read clean and named in G56', () => {
      const g56: MachineVec3 = { x: 100, y: 100, z: 0 }
      const inG54 = samplesOf(trace(resolveMoveSpans([
        { id: 3, kind: 'line', to: { x: 10, y: 10, z: 15 }, feedMmMin: RAPID },
      ], start)), { x: 0, y: 0, z: 0 })
      const at = { x: 10 - g56.x, y: 10 - g56.y, z: 15 - g56.z }
      const switchSample: PathFidelitySample = {
        atMs: inG54[inG54.length - 1].atMs + 50, workPos: at, machinePos: { x: 10, y: 10, z: 15 }, executingMoveId: 4,
      }
      const hole: QueuedMove[] = simulated(REVIEW, g56, [6]).map((to) => ({
        id: 6, kind: 'line', to: { x: to.x - g56.x, y: to.y - g56.y, z: to.z - g56.z }, feedMmMin: RAPID,
      }))
      const inG56 = samplesOf(trace(resolveMoveSpans(hole, at)), g56, switchSample.atMs)
      const report = analyse(REVIEW, start, [...inG54, switchSample, ...inG56])
      expect(report.verdict, report.headline).toBe('clean')
      expect(report.worst!.deviationMm).toBeLessThan(1e-9)
      expect(report.samples.unmodelled).toBe(0)
      expect(report.worst!.at).toMatch(/^G56 /)
    })
  })
})
