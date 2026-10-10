import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analysePathFidelity,
  pathFidelityConsoleLines,
  type PathFidelityFrameChange,
  type PathFidelitySample,
} from '../../lib/machine/pathFidelity'
import type { QueuedMove } from '../../lib/machine/controller'

const CAPTURE = join(
  process.cwd(),
  'src', 'tests', 'evidence', 'WO-1312', 'machine-2026-09-10',
  'session-b-from-connect.ws-frames.ndjson',
)

const boundaryMoves: QueuedMove[] = [
  { id: 1, kind: 'line', to: { x: 10, y: 0, z: 0 }, feedMmMin: 1000 },
  { id: 2, kind: 'line', to: { x: 0, y: 0, z: 0 }, feedMmMin: 1000 },
]

const boundaryChange: PathFidelityFrameChange = {
  atMs: 300,
  firstMoveId: 2,
  fromFrame: 'G54',
  toFrame: 'G55',
}

function syntheticBoundary(handMoveMm = 0): PathFidelitySample[] {
  return [
    { atMs: 0, machinePos: { x: 0, y: 0, z: 0 }, workPos: { x: 0, y: 0, z: 0 }, executingMoveId: 1 },
    { atMs: 100, machinePos: { x: 5, y: 0, z: 0 }, workPos: { x: 5, y: 0, z: 0 }, executingMoveId: 1 },
    { atMs: 200, machinePos: { x: 10, y: 0, z: 0 }, workPos: { x: 10, y: 0, z: 0 }, executingMoveId: 1 },
    ...[300, 400, 500].map((atMs) => ({
      atMs,
      machinePos: { x: 10 + handMoveMm, y: 0, z: 0 },
      workPos: { x: -90 + handMoveMm, y: 0, z: 0 },
      executingMoveId: 1,
    })),
    { atMs: 600, machinePos: { x: 55, y: 0, z: 0 }, workPos: { x: -45, y: 0, z: 0 }, executingMoveId: 2 },
    { atMs: 700, machinePos: { x: 100, y: 0, z: 0 }, workPos: { x: 0, y: 0, z: 0 }, executingMoveId: 2 },
  ]
}

function score(samples: PathFidelitySample[], frameChanges = [boundaryChange]) {
  return analysePathFidelity({
    moves: boundaryMoves,
    startPos: { x: 0, y: 0, z: 0 },
    samples,
    reportsExecutingMoveId: true,
    toleranceMm: 0.03,
    commandedFrame: 'work',
    frameChanges,
  })
}

describe('WO-1333 frame-boundary reference', () => {
  it('removes only the confirmed G54 to G55 coordinate jump', () => {
    const samples = syntheticBoundary()
    const withoutBoundary = score(samples, [])
    const report = score(samples)

    expect(withoutBoundary.verdict).toBe('divergence')
    expect(withoutBoundary.worst?.deviationMm).toBeCloseTo(90, 8)
    expect(report.verdict).toBe('clean')
    expect(report.worst?.deviationMm).toBeCloseTo(0, 8)
    expect(report.spans).toEqual([])
  })

  it('derives the shift when the new-frame status beats the selection receipt', () => {
    const samples = syntheticBoundary()
    samples.splice(3, 0,
      { atMs: 275, machinePos: { x: 10, y: 0, z: 0 }, workPos: { x: 10, y: 0, z: 0 }, executingMoveId: 1 },
    )
    samples.splice(5, 0,
      { atMs: 350, machinePos: { x: 10, y: 0, z: 0 }, workPos: { x: 10, y: 0, z: 0 }, executingMoveId: 1 },
    )
    const report = score(samples, [{
      ...boundaryChange,
      // Selection starts at 250. An old frame arrives at 275, G55 at 300, then
      // one stale old frame at 350; the hypothetical receipt resolves at 375.
      atMs: 250,
    }])

    expect(report.verdict).toBe('clean')
    expect(report.worst?.deviationMm).toBeCloseTo(0, 8)
    expect(report.spans).toEqual([])
  })

  it('still reports a real 5 mm departure while the new frame is selected', () => {
    const report = score(syntheticBoundary(5))

    expect(report.verdict).toBe('divergence')
    expect(report.worst?.deviationMm).toBeCloseTo(5, 8)
    expect(report.spans[0].peakDeviationMm).toBeCloseTo(5, 8)
    expect(report.headline).toMatch(/5\.00 mm off/)
    const consoleLines = pathFidelityConsoleLines(report)
    expect(consoleLines[0].severity).toBe('error')
    expect(consoleLines.filter((line) => line.text.startsWith('  limit: ')))
      .toHaveLength(report.limits.length)
    expect(consoleLines.filter((line) => line.text.startsWith('  limit: '))
      .every((line) => line.severity === 'info')).toBe(true)
  })
})

type WireFrame = { t: number; dir: string; payload: string }
type StatusPayload = {
  t?: string
  v?: {
    state: string
    machinePos: { x: number; y: number; z: number }
    workPos: { x: number; y: number; z: number }
    executingMoveId: number | null
  }
  m?: string
  a?: { moves?: QueuedMove[]; wcs?: string }
}

function recordedTwoSetupRun(): {
  moves: QueuedMove[]
  samples: PathFidelitySample[]
  frameChange: PathFidelityFrameChange
} {
  const frames = readFileSync(CAPTURE, 'utf8').trim().split('\n').map((line) => {
    const wire = JSON.parse(line) as WireFrame
    return { ...wire, decoded: JSON.parse(wire.payload) as StatusPayload }
  })
  const loads = frames
    .filter((frame) => frame.dir === 'tx' && frame.decoded.m === 'loadMoves')
    .map((frame) => frame.decoded.a?.moves)
    .filter((moves): moves is QueuedMove[] => moves !== undefined)
    .slice(-2)
  const events = frames.filter((frame) => frame.dir === 'rx' && frame.decoded.t === 'jobEvent')
  const stage1Start = events.find((frame) => frame.decoded.v?.state === undefined && frame.payload.includes('started'))!.t
  const completed = events.filter((frame) => frame.payload.includes('completed'))
  const stage1End = completed[0].t
  const stage2Start = events.filter((frame) => frame.payload.includes('started'))[1].t
  const stage2End = completed[1].t
  const statuses = frames.filter((frame) => frame.dir === 'rx' && frame.decoded.t === 'status')
  const pick = (from: number, to: number) => statuses.filter((frame) => frame.t >= from && frame.t <= to)
  const first = pick(stage1Start - 100, stage1End + 100)
  const second = pick(stage2Start - 100, stage2End + 100)
  const firstBase = first[0].t
  const secondBase = second[0].t
  const secondOffset = first.at(-1)!.t - firstBase + 32
  const samples = [...first.map((frame) => ({ frame, atMs: frame.t - firstBase })),
    ...second.map((frame) => ({ frame, atMs: frame.t - secondBase + secondOffset }))]
    .map(({ frame, atMs }) => ({
      atMs,
      machinePos: frame.decoded.v!.machinePos,
      workPos: frame.decoded.v!.workPos,
      executingMoveId: frame.decoded.v!.executingMoveId,
    }))
  return {
    moves: loads.flat(),
    samples,
    frameChange: {
      atMs: secondOffset,
      firstMoveId: loads[1][0].id,
      fromFrame: 'G54',
      toFrame: 'G55',
    },
  }
}

describe('WO-1333 recorded board replay', () => {
  it('gives the two stages one clean verdict with no boundary excursion', () => {
    const fixture = recordedTwoSetupRun()
    const report = analysePathFidelity({
      moves: fixture.moves,
      startPos: fixture.samples[0].workPos!,
      samples: fixture.samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      frameChanges: [fixture.frameChange],
      maxPhysicalTravelMmMin: Math.hypot(9000, 10000, 8000),
    })

    expect(fixture.samples.length).toBeGreaterThan(1700)
    expect(report.verdict, JSON.stringify({ counts: report.samples, spans: report.spans })).toBe('clean')
    expect(report.spans).toEqual([])
    expect(report.worst?.deviationMm ?? Infinity).toBeLessThan(0.09)
    expect(report.worst).toEqual(expect.objectContaining({ deviationMm: expect.any(Number) }))
  })
})
