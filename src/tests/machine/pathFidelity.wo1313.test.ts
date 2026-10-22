import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analysePathFidelity,
  type PathFidelitySample,
} from '../../lib/machine/pathFidelity'
import { pathFidelityEvidenceJson } from '../../lib/machine/machineSession'
import type { QueuedMove } from '../../lib/machine/controller'

const ROOT = process.cwd()
const EVIDENCE = join(ROOT, 'src', 'tests', 'evidence', 'WO-1313')
// The program run 4 executed: Setup 2 of MACHINE-SESSION-TWO-SETUP/two-setup.camproject
// as built at 30e61edc35 (WO-1921). That fixture is rebuilt through the product
// when the CAM changes (WO-3056), so the replay keeps the captured run's own
// program, extracted mechanically, instead of following the rebuilt one.
const PROJECT = join(EVIDENCE, 'two-setup-run4-program.json')

type Vec3 = { x: number; y: number; z: number }
type FixtureMove = Vec3 & { type: 'rapid' | 'feed'; feed?: number }
type StatusFrame = {
  t: number
  state: string
  machinePos: Vec3
  workPos: Vec3
  executingMoveId: number | null
}

function setup2Moves(): QueuedMove[] {
  const project = JSON.parse(readFileSync(PROJECT, 'utf8')) as {
    machine: { rapidRate: number }
    setups: Array<{
      name: string
      wcs: { origin: Vec3 }
      operations: Array<{ toolpathMoves: FixtureMove[] }>
    }>
  }
  const setup = project.setups.find((candidate) => candidate.name === 'Setup 2')!
  return setup.operations[0].toolpathMoves.map((move, index) => ({
    // The program owns a spindle-start action at id 1. Motion therefore uses
    // ids 2..135, exactly as the captured controller frames do.
    id: index + 2,
    kind: 'line' as const,
    to: {
      x: move.x - setup.wcs.origin.x,
      y: move.y - setup.wcs.origin.y,
      z: move.z - setup.wcs.origin.z,
    },
    feedMmMin: move.type === 'rapid' ? project.machine.rapidRate : move.feed!,
    ...(move.type === 'rapid' ? { rapid: true as const } : {}),
  }))
}

function capturedRun4(): PathFidelitySample[] {
  const rows: StatusFrame[] = []
  for (const line of readFileSync(
    join(EVIDENCE, 'capture-2026-09-10-run4', 'ws-frames.ndjson'),
    'utf8',
  ).split('\n')) {
    if (!line) continue
    const frame = JSON.parse(line) as { t: number; dir: string; payload: string }
    if (frame.dir !== 'rx') continue
    const payload = JSON.parse(frame.payload) as { t?: string; v?: Omit<StatusFrame, 't'> }
    if (payload.t === 'status' && payload.v?.machinePos && payload.v.workPos) {
      rows.push({ t: frame.t, ...payload.v })
    }
  }
  const firstRun = rows.findIndex((row) => row.state === 'run')
  let lastRun = firstRun
  for (let i = firstRun; i < rows.length; i++) if (rows[i].state === 'run') lastRun = i
  // Include the cached pre-start frame and the first stable idle frame after
  // completion, matching the session recorder's lifecycle boundaries.
  return rows.slice(Math.max(0, firstRun - 1), Math.min(rows.length, lastRun + 2)).map((row) => ({
    atMs: row.t,
    machinePos: row.machinePos,
    workPos: row.workPos,
    executingMoveId: row.executingMoveId,
  }))
}

describe('WO-1313 controller-frame replay', () => {
  const score = (samples: PathFidelitySample[]) => analysePathFidelity({
    moves: setup2Moves(),
    startPos: samples[0].workPos!,
    samples,
    reportsExecutingMoveId: true,
    toleranceMm: 0.03,
    commandedFrame: 'work',
    maxPhysicalTravelMmMin: Math.hypot(9000, 10000, 8000),
  })

  it('scores captured run 4 clean in the controller-reported G54 frame', () => {
    const samples = capturedRun4()
    const report = score(samples)

    expect(samples.length).toBeGreaterThan(1700)
    expect(report.thresholdMm).toBeCloseTo(0.09, 8)
    expect(report.verdict, JSON.stringify({
      counts: report.samples,
      faults: report.evidence?.filter((row) => row.measurementFault !== null),
    })).toBe('clean')
    expect(report.worst?.deviationMm ?? Infinity).toBeLessThan(0.09)
    expect(report.samples.attributed).toBeGreaterThan(1700)
    expect(report.samples.measurementFault).toBe(0)
    expect(report.headline).not.toMatch(/109\.023|51\.62|Check the part/)
    expect(report.headline).not.toMatch(/physically impossible|measurement fault/)
    expect(report.evidence?.every((row) => row.activeOffset !== null)).toBe(true)
    expect(report.evidence?.[100].activeOffset?.x).toBeCloseTo(188.7325, 6)
    expect(report.evidence?.[100].activeOffset?.y).toBeCloseTo(397.655, 6)
    expect(report.evidence?.[100].activeOffset?.z).toBeCloseTo(66.57, 6)
  })

  it('gives one program one clean verdict across normal, overrun-id, and G55 runs', () => {
    const normal = capturedRun4()
    const overrunIds = normal.map((sample, index) => ({
      ...sample,
      executingMoveId: index === 700 ? 136 : index === 701 ? 137 : sample.executingMoveId,
    }))
    const g55 = normal.map((sample) => ({
      ...sample,
      machinePos: sample.machinePos === null ? null : {
        x: sample.machinePos.x + 100,
        y: sample.machinePos.y,
        z: sample.machinePos.z + 43.43,
      },
    }))

    const reports = [score(normal), score(overrunIds), score(g55)]
    expect(reports.map((report) => report.verdict)).toEqual(['clean', 'clean', 'clean'])
    expect(reports.map((report) => report.samples.outOfRange)).toEqual([0, 2, 0])
    // WO-2681: the out-of-range count is off the operator's line.
    expect(reports[1].headline).not.toMatch(/out-of-range|matched by path continuity/)
    expect(reports[2].evidence?.[100].activeOffset?.x).toBeCloseTo(288.7325, 6)
    expect(reports[2].evidence?.[100].activeOffset?.z).toBeCloseTo(110, 6)
    expect(reports[2].samples.measurementFault).toBe(0)
    for (const report of reports) {
      expect(report.worst?.deviationMm).toBeCloseTo(reports[0].worst!.deviationMm, 9)
    }
  })

  it('still detects a real work-frame departure under a G55 active offset', () => {
    const samples: PathFidelitySample[] = Array.from({ length: 8 }, (_, index) => ({
      atMs: index * 100,
      machinePos: { x: 100 + index, y: 1, z: 43.43 },
      workPos: { x: index, y: 1, z: 0 },
      executingMoveId: 1,
    }))
    const report = analysePathFidelity({
      moves: [{ id: 1, kind: 'line', to: { x: 10, y: 0, z: 0 }, feedMmMin: 1000 }],
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      maxPhysicalTravelMmMin: 1000,
    })

    expect(report.samples.measurementFault).toBe(0)
    expect(report.verdict).toBe('divergence')
    expect(report.worst?.deviationMm).toBeCloseTo(1, 8)
    expect(report.evidence?.every((row) => row.activeOffset?.x === 100)).toBe(true)
    expect(report.evidence?.every((row) => row.activeOffset?.z === 43.43)).toBe(true)
  })

  it('always discloses that executing-move ids do not prove order or direction', () => {
    const report = score(capturedRun4())

    expect(report.samples.outOfRange).toBe(0)
    expect(report.limits.join(' ')).toMatch(/id is only a hint/i)
    expect(report.limits.join(' ')).toMatch(/does not prove.*named order or direction/i)
    expect(report.limits.join(' ')).not.toMatch(/either side of the named move/i)
  })

  it('calls physically impossible position telemetry a measurement fault, never a part fault', () => {
    const samples: PathFidelitySample[] = [0, 50, 100, 150, 0].map((x, index) => ({
      atMs: index * 100,
      machinePos: { x, y: 0, z: 0 },
      workPos: { x, y: 0, z: 0 },
      executingMoveId: 1,
    }))
    const report = analysePathFidelity({
      moves: [{ id: 1, kind: 'line', to: { x: 100, y: 0, z: 0 }, feedMmMin: 1000 }],
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      maxPhysicalTravelMmMin: 1000,
    })

    expect(report.verdict).toBe('unknown')
    expect(report.samples.measurementFault).toBeGreaterThan(0)
    expect(report.headline).toMatch(/measurement is faulty/)
    expect(report.headline).not.toMatch(/Check the part/)
  })

  it('still fails a physically plausible sustained real excursion', () => {
    const samples: PathFidelitySample[] = Array.from({ length: 8 }, (_, index) => ({
      atMs: index * 100,
      machinePos: { x: index, y: 1, z: 0 },
      workPos: { x: index, y: 1, z: 0 },
      executingMoveId: 1,
    }))
    const report = analysePathFidelity({
      moves: [{ id: 1, kind: 'line', to: { x: 10, y: 0, z: 0 }, feedMmMin: 1000 }],
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
      maxPhysicalTravelMmMin: 1000,
    })

    expect(report.samples.measurementFault).toBe(0)
    expect(report.verdict).toBe('divergence')
    expect(report.worst?.deviationMm).toBeCloseTo(1, 8)
    expect(report.headline).toMatch(/Check the part/)
  })

  it('serializes every judged frame with reported position, id, and commanded segment', () => {
    const samples: PathFidelitySample[] = Array.from({ length: 4 }, (_, index) => ({
      atMs: index * 100,
      machinePos: { x: index, y: 1, z: 0 },
      workPos: { x: index, y: 1, z: 0 },
      executingMoveId: 1,
    }))
    const report = analysePathFidelity({
      moves: [{ id: 1, kind: 'line', to: { x: 10, y: 0, z: 0 }, feedMmMin: 1000 }],
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: 0.03,
      commandedFrame: 'work',
    })
    const saved = JSON.parse(pathFidelityEvidenceJson(report)) as {
      format: string
      samples: Array<Record<string, unknown>>
    }

    expect(saved.format).toBe('liencam-path-fidelity-evidence')
    expect(saved.samples).toHaveLength(4)
    expect(saved.samples[0]).toMatchObject({
      atMs: 0,
      reportedMoveId: 1,
      commandedMoveId: 1,
      machinePos: { x: 0, y: 1, z: 0 },
      commandedSegment: { from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } },
    })
  })
})
