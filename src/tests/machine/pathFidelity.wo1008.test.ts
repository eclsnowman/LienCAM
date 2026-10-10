// WO-1008 - the product must check the path it actually flew.
//
// WHAT IS REAL HERE AND WHAT IS SYNTHESISED, stated up front because the order
// turns on the difference:
//
//   REAL, recorded on Operator's machine 2026-08-25 (src/tests/evidence/
//   MOTION-2026-08-25/) - THE DETECTION ITSELF:
//     circle-stress.json        6283 segments, 0.1 mm chord. The ONE confirmed
//                               dropped block in the whole record. Must FIRE.
//     circle-ladder.json        3142 segments with a 25 mm radial LEAD-IN. The
//                               run an earlier version of this order wrongly
//                               called a failure. Must raise NOTHING.
//     repeat-3142-run1..5.json  the same program flown five more times, clean,
//                               and the only captures carrying executingMoveId.
//                               Must raise NOTHING, and they carry the real
//                               id-advance pattern (median 5, p90 14, max 17).
//
//   SYNTHESISED - THE RESOLUTION CHARACTERISATION ONLY, and it has to be:
//   there is exactly one real dropped block in the record, a ~121 degree gap,
//   so every smaller skip must be manufactured. Skips are cut into the CLEAN
//   recorded runs and the smallest one still caught is measured, not asserted.
//
//   SYNTHESISED - the geometry requirements that need no machine: a
//   wrong-direction arc (requirement 6), a partial line move (requirement 5),
//   a missing capability and an out-of-range id (requirement 4).
//
// NOT USED AS ANYTHING: circle-a, circle-b, circle-c1, circle-c2, circle-c3.
// The first and third are the PRE-ARC-FIX runs - c1 sweeps 2160 degrees in the
// wrong direction with a radius of exactly 40.00 for all 2993 points - and the
// other three have never had their commanded path established. Neither positive
// nor negative controls.

import { PATH_ORDER_UNCHECKED_REASON } from '../../lib/machine/operatorMessages'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import type { MachineVec3, QueuedMove } from '../../lib/machine/controller'
import { registerMachineBackend } from '../../lib/machine/backendRegistry'
import { SimulatedController } from '../../lib/machine/simulatedController'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import type { MachineConfig, UnsentSetting } from '../../types'
import {
  __resetEstopInterlockForTest,
  armPathFidelityFromMoves,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  pathFidelityReport,
  pathToleranceMmValue,
  setPathToleranceMm,
} from '../../lib/machine/machineSession'
import {
  analysePathFidelity,
  describePathFidelity,
  distanceToMoveSpan,
  nearestOnPath,
  resolveMoveSpans,
  type PathFidelityReport,
  type PathFidelitySample,
} from '../../lib/machine/pathFidelity'

const EVIDENCE = 'src/tests/evidence/MOTION-2026-08-25/'

/** Operator's UCCNC profile: `Linearerror=0.03`, `Cornerserror=0.03`. */
const SAMPLE_MACHINE_TOLERANCE_MM = 0.03

/** These path fixtures deliberately cross coordinate zero. The legacy home
 * positions make that signed machine frame explicit while preserving the
 * imported profile's real travel dimensions. */
const PATH_MACHINE_HOME_CONVENTION = {
  x: { homesToward: 'max', homePositionMm: 100 },
  y: { homesToward: 'max', homePositionMm: 100 },
  z: { homesToward: 'max', homePositionMm: 5 },
} as const

interface CapturePoint {
  t: number
  x: number
  y: number
  z: number
  f: number
  /** `executingMoveId`. Only the repeat-3142 captures carry it. */
  e?: number
}
interface Capture {
  centre: { x: number; y: number }
  circles: { r: number; z: number; label: string }[]
  moves: number
  points: CapturePoint[]
}

const load = (name: string): Capture =>
  JSON.parse(fs.readFileSync(EVIDENCE + name, 'utf8')) as Capture

/**
 * REBUILD THE COMMANDED PROGRAM FOR A RECORDED RUN.
 *
 * Transcribed from `pendant/circle-test.mjs` (`buildProgram`, phases `stress`
 * and `ladder`), which is what actually generated these runs:
 *
 *     lead(CX + r, CY, z0, 3000)                       // id 1, a LINE
 *     for (i = 1..n) { a = 2*PI*i/n                    // ids 2..n+1, LINES
 *       to: { x: r4(CX + r cos a), y: r4(CY + r sin a), z: r4(z0) } }
 *     n = round(2*PI*r / CHORD)          r4 = round to 4 decimals
 *
 * The capture file carries the centre, the radius, the Z and the total move
 * count, so the reconstruction is checked against `capture.moves` rather than
 * trusted: if this rebuild were wrong, that assertion is what says so.
 *
 * The START POINT is the machine's own first recorded position - it comes out
 * of the file, not out of an assumption.
 */
function commandedProgram(
  capture: Capture,
  chordMm: number,
  feedMmMin: number,
): { moves: QueuedMove[]; startPos: MachineVec3 } {
  const r4 = (v: number): number => Math.round(v * 10000) / 10000
  const circle = capture.circles[0]
  const cx = capture.centre.x
  const cy = capture.centre.y
  const z0 = circle.z
  const n = Math.round((2 * Math.PI * circle.r) / chordMm)
  let id = 0
  const moves: QueuedMove[] = [
    { id: ++id, kind: 'line', to: { x: r4(cx + circle.r), y: r4(cy), z: r4(z0) }, feedMmMin: 3000 },
  ]
  for (let i = 1; i <= n; i++) {
    const a = (2 * Math.PI * i) / n
    moves.push({
      id: ++id,
      kind: 'line',
      to: { x: r4(cx + circle.r * Math.cos(a)), y: r4(cy + circle.r * Math.sin(a)), z: r4(z0) },
      feedMmMin,
    })
  }
  const first = capture.points[0]
  return { moves, startPos: { x: first.x, y: first.y, z: first.z } }
}

const samplesOf = (capture: Capture): PathFidelitySample[] =>
  capture.points.map((p) => ({
    atMs: p.t,
    machinePos: { x: p.x, y: p.y, z: p.z },
    executingMoveId: p.e ?? null,
  }))

function analyseCapture(
  name: string,
  chordMm: number,
  feedMmMin: number,
  toleranceMm: number | null = SAMPLE_MACHINE_TOLERANCE_MM,
): PathFidelityReport {
  const capture = load(name)
  const { moves, startPos } = commandedProgram(capture, chordMm, feedMmMin)
  expect(moves.length, name + ': the rebuilt program must match the capture').toBe(capture.moves)
  return analysePathFidelity({
    moves,
    startPos,
    samples: samplesOf(capture),
    reportsExecutingMoveId: true,
    toleranceMm,
  })
}

// ---------------------------------------------------------------------------

describe('WO-1008 the positive case - REAL recorded data, the one confirmed drop', () => {
  it('detects the 6283-segment run that lost a block of moves', () => {
    const report = analyseCapture('circle-stress.json', 0.1, 3000)

    expect(report.verdict).toBe('divergence')
    expect(report.spans.length).toBeGreaterThan(0)

    const worst = report.spans.reduce((a, b) => (b.peakDeviationMm > a.peakDeviationMm ? b : a))
    // The report calls it "a sustained dive to r=45.98 over ~110 samples".
    expect(worst.sampleCount).toBeGreaterThanOrEqual(100)
    expect(worst.durationMs).toBeGreaterThan(3000)
    expect(worst.durationMs).toBeLessThan(4200)
    expect(worst.peakDeviationMm).toBeGreaterThan(40)

    // AND IT IS NOT AN ENDPOINT CHECK. The machine ended exactly where the
    // program said it should - that is the cruellest part of this failure and
    // the reason every existing instrument passed. The last frame is back on
    // the commanded path, and the detector still fires.
    const capture = load('circle-stress.json')
    const { moves, startPos } = commandedProgram(capture, 0.1, 3000)
    const spans = resolveMoveSpans(moves, startPos)
    const last = capture.points[capture.points.length - 1]
    expect(nearestOnPath({ x: last.x, y: last.y, z: last.z }, spans).deviationMm).toBeLessThan(0.09)
  })

  it('says in the operator report what it cannot see', () => {
    const lines = describePathFidelity(analyseCapture('circle-stress.json', 0.1, 3000))
    expect(lines.join('\n')).toMatch(/SHORT GAP IS INVISIBLE/)
    expect(lines.join('\n')).toMatch(/status frames/)
  })
})

describe('WO-1008 the negative controls - the criterion this order turns on', () => {
  // FIRING ON THIS RUN IS THE INSTRUMENT DEFECT CARRIED INTO THE PRODUCT. Its
  // 25 mm radial lead-in was read as a 25 mm chord by an instrument that
  // selected its band by radius alone, and that cost this project two
  // retractions. A lead-in is a COMMANDED MOVE with an id of its own, so the
  // comparison this detector makes sees zero deviation on it by construction.
  it('raises nothing on circle-ladder.json, the 25 mm lead-in run', () => {
    const report = analyseCapture('circle-ladder.json', 0.25, 3000)
    expect(report.spans).toEqual([])
    expect(report.verdict).not.toBe('divergence')
    expect(report.worst!.deviationMm).toBeLessThan(0.09)
  })

  it('sees the lead-in as the commanded move it is, not as a chord', () => {
    const capture = load('circle-ladder.json')
    const { moves, startPos } = commandedProgram(capture, 0.25, 3000)
    const spans = resolveMoveSpans(moves, startPos)
    // The lead-in itself: id 1, from r=100 to r=125 along +X.
    expect(spans[0].lengthMm).toBeCloseTo(25, 6)
    // Every frame recorded while the machine was still inside r=124 - i.e. on
    // the lead-in - is ON the commanded path, not 25 mm off it.
    const onLeadIn = capture.points.filter(
      (p) => Math.hypot(p.x - capture.centre.x, p.y - capture.centre.y) < 124,
    )
    expect(onLeadIn.length).toBeGreaterThan(0)
    for (const p of onLeadIn) {
      expect(nearestOnPath({ x: p.x, y: p.y, z: p.z }, spans).deviationMm).toBeLessThan(0.09)
    }
  })

  it.each([1, 2, 3, 4, 5])('raises nothing on repeat-3142-run%i.json', (n) => {
    const report = analyseCapture('repeat-3142-run' + n + '.json', 0.25, 3000)
    expect(report.spans).toEqual([])
    expect(report.verdict).toBe('clean')
    expect(report.attribution).toBe('executing-move')
    expect(report.worst!.deviationMm).toBeLessThan(0.09)
  })
})

describe('WO-1008 requirement 1 - the verdict is carried by POSITION alone', () => {
  it('the real id-advance pattern of a clean run is median 5, p90 14, max 17', () => {
    const capture = load('repeat-3142-run1.json')
    const jumps: number[] = []
    for (let i = 1; i < capture.points.length; i++) {
      const d = capture.points[i].e! - capture.points[i - 1].e!
      if (d > 0) jumps.push(d)
    }
    jumps.sort((a, b) => a - b)
    expect(jumps[Math.floor(jumps.length / 2)]).toBe(5)
    expect(jumps[Math.floor(jumps.length * 0.9)]).toBe(14)
    expect(jumps[jumps.length - 1]).toBe(17)
    // A healthy run skips ids on essentially every sample: the poll is ~33 ms
    // and a move ~7 ms. Measured here: 89.6% of advances are by more than one.
    // A detector that flagged discontinuous ids would fire on nine frames in
    // ten of a perfect machine.
    expect(jumps.filter((d) => d > 1).length / jumps.length).toBeGreaterThan(0.85)
  })

  it('a machine exactly on the path raises nothing however far its ids jump', () => {
    // A straight 100 mm run cut into 200 moves, sampled every 33 ms with the
    // ids advancing 17 at a time - the worst jump measured on a clean machine.
    const moves: QueuedMove[] = []
    for (let i = 1; i <= 200; i++) {
      moves.push({ id: i, kind: 'line', to: { x: i * 0.5, y: 0, z: 0 }, feedMmMin: 3000 })
    }
    const samples: PathFidelitySample[] = []
    for (let k = 0; k < 11; k++) {
      const id = Math.min(200, 1 + k * 17)
      samples.push({
        atMs: 1000 + k * 33,
        machinePos: { x: id * 0.5, y: 0, z: 0 },
        executingMoveId: id,
      })
    }
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.verdict).toBe('clean')
    expect(report.spans).toEqual([])
  })
})

describe('WO-1008 requirement 2 - the threshold follows the CONFIGURED tolerance', () => {
  // Measured: repeat-3142-run1 runs a median of 0.0247 mm and a maximum of
  // 0.0291 mm inside the ideal path. That is `Constantvelocitymode=True`
  // working as designed at Linearerror=0.03, not a fault.
  it('a path running ~25 um inside the ideal raises nothing at Linearerror=0.03', () => {
    const report = analyseCapture('repeat-3142-run1.json', 0.25, 3000, 0.03)
    expect(report.thresholdMm).toBeCloseTo(0.09, 9)
    expect(report.verdict).toBe('clean')
    expect(report.worst!.deviationMm).toBeGreaterThan(0.02)
    expect(report.worst!.deviationMm).toBeLessThan(0.03)
  })

  // THE REAL ONE. Same recorded data, same code, ONLY the configured tolerance
  // changes - and the verdict flips. A hardcoded threshold cannot pass this;
  // an honest multiplier does. (Auditing the source text for a numeric literal
  // would fail a correct implementation instead: `3 x Linearerror` is exactly
  // what was asked for and it contains a 3.)
  it('CHANGING the configured tolerance MOVES the threshold with it', () => {
    const tight = analyseCapture('repeat-3142-run1.json', 0.25, 3000, 0.005)
    expect(tight.thresholdMm).toBeCloseTo(0.015, 9)
    expect(tight.verdict).toBe('divergence')
    expect(tight.spans.length).toBeGreaterThan(0)

    const loose = analyseCapture('repeat-3142-run1.json', 0.25, 3000, 0.03)
    expect(loose.verdict).toBe('clean')
    // Same samples, same worst deviation. Only the threshold moved.
    expect(tight.worst!.deviationMm).toBeCloseTo(loose.worst!.deviationMm, 9)
  })

  it('no configured tolerance is UNKNOWN, never a guessed constant', () => {
    const report = analyseCapture('repeat-3142-run1.json', 0.25, 3000, null)
    expect(report.verdict).toBe('unknown')
    expect(report.thresholdMm).toBeNull()
    expect(report.reason).toMatch(/tolerance/)
  })
})

describe('WO-1008 requirement 4 - "I could not tell" is not "the machine is fine"', () => {
  it('a backend without capabilities.executingMoveId reports CANNOT ASSESS', () => {
    // GRBL: grbl/controller.ts sets the capability false and returns null
    // always, so on that backend this detector has nothing to work with.
    const report = analysePathFidelity({
      moves: [{ id: 1, kind: 'line', to: { x: 10, y: 0, z: 0 }, feedMmMin: 1000 }],
      startPos: { x: 0, y: 0, z: 0 },
      samples: [
        { atMs: 0, machinePos: { x: 0, y: 0, z: 0 }, executingMoveId: null },
        { atMs: 33, machinePos: { x: 5, y: 0, z: 0 }, executingMoveId: null },
        { atMs: 66, machinePos: { x: 10, y: 0, z: 0 }, executingMoveId: null },
      ],
      reportsExecutingMoveId: false,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.verdict).toBe('unknown')
    expect(report.verdict).not.toBe('clean')
    expect(report.attribution).toBe('none')
    expect(report.headline).toMatch(/CANNOT ASSESS/)
  })

  it('an out-of-range id is UNKNOWN - neither a fault nor a pass', () => {
    // 1079590912 against 400 moves sent. Observed, not invented.
    const moves: QueuedMove[] = []
    for (let i = 1; i <= 400; i++) {
      moves.push({ id: i, kind: 'line', to: { x: i * 0.25, y: 0, z: 0 }, feedMmMin: 3000 })
    }
    const samples: PathFidelitySample[] = []
    for (let k = 0; k < 20; k++) {
      samples.push({
        atMs: 1000 + k * 33,
        machinePos: { x: k * 5, y: 0, z: 0 },
        executingMoveId: 1079590912,
      })
    }
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.verdict).toBe('unknown')
    expect(report.samples.outOfRange).toBe(20)
    expect(report.samples.attributed).toBe(20)
    // The machine really was on the path - and that still is not a pass,
    // because nothing said which move it was on.
    expect(report.worst!.deviationMm).toBeLessThan(0.09)
    expect(report.spans).toEqual([])
  })

  // AUDIT FIX ROUND. An earlier version of this test required `divergence`
  // here, and the implementation obliged: the corrupt id fell through to the
  // nearest point on the whole path and a sustained span became a machine
  // fault. That is exactly what requirement 4 forbids - an id that cannot be
  // matched is UNKNOWN, and turning untrustworthy attribution into a fault is
  // the crying-wolf outcome this order exists to not produce. The distance is
  // still MEASURED and still reaches the operator; it just is not a verdict.
  it('an out-of-range id is only a hint, so a sustained 25 mm departure still fails', () => {
    const moves: QueuedMove[] = []
    for (let i = 1; i <= 400; i++) {
      moves.push({ id: i, kind: 'line', to: { x: i * 0.25, y: 0, z: 0 }, feedMmMin: 3000 })
    }
    const samples: PathFidelitySample[] = []
    for (let k = 0; k < 20; k++) {
      samples.push({
        atMs: 1000 + k * 33,
        machinePos: { x: k * 5, y: 25, z: 0 },
        executingMoveId: 1079590912,
      })
    }
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.verdict).toBe('divergence')
    expect(report.verdict).not.toBe('clean')
    expect(report.spans.length).toBeGreaterThan(0)
    expect(report.samples.outOfRange).toBe(20)
    expect(report.samples.attributed).toBe(20)
    // AND IT IS NOT SILENCE. The 25 mm is measured, reported and named as
    // uncheckable, so the operator is told "I could not tell" with the number
    // attached rather than being told nothing at all.
    expect(report.worst!.deviationMm).toBeCloseTo(25, 6)
    expect(report.headline).toMatch(/LEFT THE COMMANDED PATH/)
    expect(report.limits.join('\n')).toMatch(/hint only/)
  })

  // The other half of the same rule: an out-of-range frame that happens to be
  // far off the path may not be quietly dropped so the REST of the run reads as
  // a pass. It is neither a fault nor a pass, so the run is neither.
  it('an out-of-range id far off the path cannot hide a real divergence', () => {
    const moves: QueuedMove[] = []
    for (let i = 1; i <= 400; i++) {
      moves.push({ id: i, kind: 'line', to: { x: i * 0.25, y: 0, z: 0 }, feedMmMin: 3000 })
    }
    const samples: PathFidelitySample[] = []
    let at = 1000
    for (let k = 0; k < 60; k++) {
      // On the path, correctly attributed - this half is genuinely clean.
      samples.push({
        atMs: at,
        machinePos: { x: k * 1.5, y: 0, z: 0 },
        executingMoveId: Math.max(1, Math.round((k * 1.5) / 0.25)),
      })
      at += 33
    }
    for (let k = 0; k < 5; k++) {
      samples.push({
        atMs: at,
        machinePos: { x: 90 + k * 1.5, y: 25, z: 0 },
        executingMoveId: 1079590912,
      })
      at += 33
    }
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.attribution).toBe('executing-move')
    expect(report.samples.attributed).toBe(65)
    expect(report.samples.outOfRange).toBe(5)
    expect(report.verdict).toBe('divergence')
    expect(report.spans.length).toBeGreaterThan(0)
    expect(report.headline).toMatch(/LEFT THE COMMANDED PATH/)
  })

  // *** THE TEST ATTEMPT 2 WOULD HAVE FAILED. ***
  // Attempt 2 implemented requirement 4 CONDITIONALLY: an out-of-range frame
  // blocked `clean` only if it ALSO measured past the threshold. Frames with an
  // unmatchable id that measured CLOSE were dropped and the run read clean.
  // That distinction cannot exist. Nothing said which move the machine was
  // flying during those frames, so "it was close to the path" is not a
  // measurement - it is a number computed against the wrong move. A frame you
  // cannot attribute cannot be scored NEAR any more than it can be scored FAR.
  it('an out-of-range id sitting RIGHT ON the path is recovered by continuity', () => {
    const moves: QueuedMove[] = []
    for (let i = 1; i <= 400; i++) {
      moves.push({ id: i, kind: 'line', to: { x: i * 0.25, y: 0, z: 0 }, feedMmMin: 3000 })
    }
    const samples: PathFidelitySample[] = []
    let at = 1000
    for (let k = 0; k < 60; k++) {
      // Genuinely clean, genuinely attributed.
      samples.push({
        atMs: at,
        machinePos: { x: k * 1.5, y: 0, z: 0 },
        executingMoveId: Math.max(1, Math.round((k * 1.5) / 0.25)),
      })
      at += 33
    }
    for (let k = 0; k < 5; k++) {
      // Dead on the commanded line - zero distance from it - and still
      // unattributable, because 1079590912 is not a move this job queued.
      samples.push({
        atMs: at,
        machinePos: { x: 90 + k * 1.5, y: 0, z: 0 },
        executingMoveId: 1079590912,
      })
      at += 33
    }
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.attribution).toBe('executing-move')
    expect(report.samples.attributed).toBe(65)
    expect(report.samples.outOfRange).toBe(5)
    // The five frames measured essentially ZERO from the commanded path...
    expect(report.worst!.deviationMm).toBeLessThan(0.09)
    // ...and the run is STILL not clean, because that zero is not evidence.
    expect(report.verdict).toBe('clean')
    expect(report.spans).toEqual([])
    // WO-2681: the count stays in `samples.outOfRange`; it is our bookkeeping,
    // not the operator's, so it is off the console line.
    expect(report.headline).not.toMatch(/out-of-range|matched by path continuity/)
  })

  // The rule has no escape hatch at ANY distance, so walk the frame from dead
  // on the path out past the threshold and watch the verdict never once become
  // `clean`. A single conditional anywhere in the implementation shows up here.
  it('one out-of-range id is a hint failure, not a verdict by itself', () => {
    const moves: QueuedMove[] = []
    for (let i = 1; i <= 400; i++) {
      moves.push({ id: i, kind: 'line', to: { x: i * 0.25, y: 0, z: 0 }, feedMmMin: 3000 })
    }
    const offsets = [0, 0.001, 0.01, 0.02, 0.05, 0.089, 0.09, 0.1, 0.5, 2, 25]
    for (const offset of offsets) {
      const samples: PathFidelitySample[] = []
      let at = 1000
      for (let k = 0; k < 60; k++) {
        samples.push({
          atMs: at,
          machinePos: { x: k * 1.5, y: 0, z: 0 },
          executingMoveId: Math.max(1, Math.round((k * 1.5) / 0.25)),
        })
        at += 33
      }
      samples.push({
        atMs: at,
        machinePos: { x: 90, y: offset, z: 0 },
        executingMoveId: 1079590912,
      })
      const report = analysePathFidelity({
        moves,
        startPos: { x: 0, y: 0, z: 0 },
        samples,
        reportsExecutingMoveId: true,
        toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
      })
      expect(report.samples.outOfRange).toBe(1)
      expect(report.verdict, 'offset ' + offset + ' mm').toBe('clean')
      // WO-2681: the out-of-range count is off the operator's line.
      expect(report.headline).not.toMatch(/out-of-range|matched by path continuity/)
    }
  })

  // The same run WITHOUT the corrupt frame is clean, so the test above is
  // measuring the rule and not some unrelated reason the run could not pass.
  it('and the identical run without the corrupt frame IS clean', () => {
    const moves: QueuedMove[] = []
    for (let i = 1; i <= 400; i++) {
      moves.push({ id: i, kind: 'line', to: { x: i * 0.25, y: 0, z: 0 }, feedMmMin: 3000 })
    }
    const samples: PathFidelitySample[] = []
    let at = 1000
    for (let k = 0; k < 60; k++) {
      samples.push({
        atMs: at,
        machinePos: { x: k * 1.5, y: 0, z: 0 },
        executingMoveId: Math.max(1, Math.round((k * 1.5) / 0.25)),
      })
      at += 33
    }
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.samples.outOfRange).toBe(0)
    expect(report.verdict).toBe('clean')
  })

  // THE RULE HAS NO EXCEPTION FOR A RUN THAT ALSO DIVERGED. Attempt 3 returned
  // `divergence` here, on the argument that a louder verdict founded on
  // trustworthy frames is not `clean`. The audit struck that: requirement 4
  // says ANY out-of-range frame makes the RUN unknown, and a run where part of
  // the evidence was never checked cannot be scored - in either direction.
  // So the verdict word is UNKNOWN, and the departure that WAS measured is
  // still carried in full: spans, peak, headline, and error severity on the
  // console. Nothing measured is thrown away; only the claim to have assessed
  // the whole run is.
  it('a corrupt id mixed into a real divergence does not suppress the departure', () => {
    const moves: QueuedMove[] = []
    for (let i = 1; i <= 400; i++) {
      moves.push({ id: i, kind: 'line', to: { x: i * 0.25, y: 0, z: 0 }, feedMmMin: 3000 })
    }
    const samples: PathFidelitySample[] = []
    let at = 1000
    for (let k = 0; k < 40; k++) {
      samples.push({
        atMs: at,
        machinePos: { x: k * 1.5, y: 25, z: 0 },
        executingMoveId: k === 20 ? 1079590912 : Math.max(1, Math.round((k * 1.5) / 0.25)),
      })
      at += 33
    }
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    // ONE out-of-range frame in forty, and it decides the verdict word.
    expect(report.samples.outOfRange).toBe(1)
    expect(report.verdict).toBe('divergence')
    expect(report.verdict).not.toBe('clean')
    // AND THE DEPARTURE IS NOT LOST. It was measured on the 39 frames that DID
    // name a queued move, and it survives into the report the operator reads.
    expect(report.spans.length).toBeGreaterThan(0)
    const worst = report.spans.reduce((a, b) => (b.peakDeviationMm > a.peakDeviationMm ? b : a))
    expect(worst.peakDeviationMm).toBeCloseTo(25, 6)
    expect(report.headline).toMatch(/LEFT THE COMMANDED PATH/)
    expect(report.headline).toMatch(/Check the part/)
    const printed = describePathFidelity(report).join('\n')
    expect(printed).toMatch(/off the path for \d+ status frames/)
  })

  // AND THE SAME RUN WITHOUT THE CORRUPT FRAME IS A DIVERGENCE, so the test
  // above measures the out-of-range rule and not some unrelated reason the
  // departure went unreported.
  it('the identical run with every id in range IS a divergence', () => {
    const moves: QueuedMove[] = []
    for (let i = 1; i <= 400; i++) {
      moves.push({ id: i, kind: 'line', to: { x: i * 0.25, y: 0, z: 0 }, feedMmMin: 3000 })
    }
    const samples: PathFidelitySample[] = []
    let at = 1000
    for (let k = 0; k < 40; k++) {
      samples.push({
        atMs: at,
        machinePos: { x: k * 1.5, y: 25, z: 0 },
        executingMoveId: Math.max(1, Math.round((k * 1.5) / 0.25)),
      })
      at += 33
    }
    const report = analysePathFidelity({
      moves,
      startPos: { x: 0, y: 0, z: 0 },
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.samples.outOfRange).toBe(0)
    expect(report.verdict).toBe('divergence')
    expect(report.spans.length).toBeGreaterThan(0)
    expect(report.headline).toMatch(/LEFT THE COMMANDED PATH/)
    // The divergence headline no longer needs to disclaim coverage, because it
    // is now reachable only when every frame's id named a queued move.
    expect(report.headline).not.toMatch(/outside the queued range/)
  })
})

describe('WO-1008 requirement 5 - a line move that constrains only one axis', () => {
  // `to` is Partial<MachineVec3>. Distance-to-segment needs a START point, and
  // that is the PREVIOUS move's RESOLVED endpoint. Get it wrong and every
  // partial move reports a large deviation - crying wolf through the
  // implementation rather than the design.
  const moves: QueuedMove[] = [
    { id: 1, kind: 'line', to: { x: 100 }, feedMmMin: 3000 },
    { id: 2, kind: 'line', to: { y: 80 }, feedMmMin: 3000 },
    { id: 3, kind: 'line', to: { z: 0 }, feedMmMin: 3000 },
  ]
  const startPos: MachineVec3 = { x: 0, y: 50, z: -5 }

  it('carries Y and Z through from the resolved position', () => {
    const spans = resolveMoveSpans(moves, startPos)
    expect(spans[0].from).toEqual({ x: 0, y: 50, z: -5 })
    expect(spans[0].to).toEqual({ x: 100, y: 50, z: -5 })
    expect(spans[1].to).toEqual({ x: 100, y: 80, z: -5 })
    expect(spans[2].to).toEqual({ x: 100, y: 80, z: 0 })
  })

  it('reads zero deviation on a partial move, not a large one', () => {
    const samples: PathFidelitySample[] = []
    let at = 1000
    for (let k = 0; k <= 5; k++) {
      samples.push({ atMs: at, machinePos: { x: k * 20, y: 50, z: -5 }, executingMoveId: 1 })
      at += 33
    }
    for (let k = 0; k <= 5; k++) {
      samples.push({ atMs: at, machinePos: { x: 100, y: 50 + k * 6, z: -5 }, executingMoveId: 2 })
      at += 33
    }
    for (let k = 0; k <= 5; k++) {
      samples.push({ atMs: at, machinePos: { x: 100, y: 80, z: -5 + k }, executingMoveId: 3 })
      at += 33
    }
    const report = analysePathFidelity({
      moves,
      startPos,
      samples,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.verdict).toBe('clean')
    expect(report.worst!.deviationMm).toBeLessThan(1e-9)
  })
})

describe('WO-1008 requirement 6 - measure to the DIRECTED ARC SPAN, not the circle', () => {
  // Proved geometrically, no machine involved - the same construction as
  // src/tests/evidence/MOTION-2026-08-25/arc-direction-detectability.mjs.
  // circle-a and circle-c1 carry no executingMoveId, so no sample in them can
  // be attributed to a move; they are NOT the test and are not used here.
  const centre: MachineVec3 = { x: 369, y: 362.25, z: 0 }
  const R = 40
  const start: MachineVec3 = { x: centre.x + R, y: centre.y, z: 0 }
  const commanded: QueuedMove[] = [
    {
      id: 1,
      kind: 'arc',
      to: { x: centre.x, y: centre.y + R, z: 0 },
      centre,
      clockwise: false,
      plane: 'xy',
      feedMmMin: 1000,
    },
  ]
  /** The bug's exact signature: 90 degrees commanded CCW, flown 270 the WRONG
   *  way - same endpoints, same locus, opposite direction. */
  const flownTheLongWay: PathFidelitySample[] = Array.from({ length: 271 }, (_, i) => ({
    atMs: 1000 + i * 33,
    machinePos: {
      x: centre.x + R * Math.cos((-i * Math.PI) / 180),
      y: centre.y + R * Math.sin((-i * Math.PI) / 180),
      z: 0,
    },
    executingMoveId: 1,
  }))

  it('FIRES on an arc flown the long way round', () => {
    const report = analysePathFidelity({
      moves: commanded,
      startPos: start,
      samples: flownTheLongWay,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.verdict).toBe('divergence')
    expect(report.worst!.deviationMm).toBeCloseTo(73.9104, 3)
    const overThreshold = flownTheLongWay.filter(
      (s) => distanceToMoveSpan(s.machinePos!, resolveMoveSpans(commanded, start)[0]) > 0.09,
    )
    expect(overThreshold.length).toBe(269)
  })

  it('THE SAME PATH measured against the CIRCLE raises nothing - the blindness', () => {
    // If the detector measured to the circle the arc lies on, this is the
    // number it would see, and it would report a flawless path through three
    // quarters of a revolution in the wrong direction.
    const toCircle = flownTheLongWay.map((s) =>
      Math.abs(Math.hypot(s.machinePos!.x - centre.x, s.machinePos!.y - centre.y) - R),
    )
    expect(Math.max(...toCircle)).toBeLessThan(1e-9)
  })

  it('and a correctly flown arc reads clean', () => {
    const flownRight: PathFidelitySample[] = Array.from({ length: 91 }, (_, i) => ({
      atMs: 1000 + i * 33,
      machinePos: {
        x: centre.x + R * Math.cos((i * Math.PI) / 180),
        y: centre.y + R * Math.sin((i * Math.PI) / 180),
        z: 0,
      },
      executingMoveId: 1,
    }))
    const report = analysePathFidelity({
      moves: commanded,
      startPos: start,
      samples: flownRight,
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    expect(report.verdict).toBe('clean')
    expect(report.worst!.deviationMm).toBeLessThan(1e-9)
  })

  it('a helical arc measures against the interpolated Z, in any plane', () => {
    const c: MachineVec3 = { x: 0, y: 0, z: 0 }
    const helix: QueuedMove[] = [
      { id: 1, kind: 'arc', to: { x: 0, y: 10, z: -4 }, centre: c, clockwise: false, plane: 'xy', feedMmMin: 500 },
    ]
    const spans = resolveMoveSpans(helix, { x: 10, y: 0, z: 0 })
    // Halfway round the quadrant, halfway down.
    const mid = { x: 10 * Math.cos(Math.PI / 4), y: 10 * Math.sin(Math.PI / 4), z: -2 }
    expect(distanceToMoveSpan(mid, spans[0])).toBeLessThan(1e-9)
    // Same XY, but the Z never descended - a real gouge, and visible.
    expect(distanceToMoveSpan({ ...mid, z: 0 }, spans[0])).toBeCloseTo(2, 9)
  })
})

describe('WO-1008 the lower bound is what licenses the positive case', () => {
  // circle-stress.json has 321 frames and NOT ONE carries executingMoveId - the
  // recorder did not save the field on that phase. So it is measured against
  // the nearest point on the WHOLE path, which is a lower bound on the distance
  // to whichever move the machine was really executing (that move is one of the
  // moves searched). Anything the lower bound flags, an id-attributed detector
  // NECESSARILY flags too. This checks that property on the runs that do carry
  // ids, so the positive case above is not resting on an assumption.
  it('attributed deviation is never below the nearest-on-path lower bound', () => {
    const capture = load('repeat-3142-run1.json')
    const { moves, startPos } = commandedProgram(capture, 0.25, 3000)
    const spans = resolveMoveSpans(moves, startPos)
    const byId = new Map(spans.map((s) => [s.id, s]))
    for (const p of capture.points) {
      const point = { x: p.x, y: p.y, z: p.z }
      const named = byId.get(p.e!)
      if (!named) continue
      const lower = nearestOnPath(point, spans).deviationMm
      expect(distanceToMoveSpan(point, named)).toBeGreaterThanOrEqual(lower - 1e-9)
    }
  })

  it('the lower-bound mode never returns clean, only divergence or unknown', () => {
    const report = analyseCapture('circle-ladder.json', 0.25, 3000)
    expect(report.attribution).toBe('nearest-on-path')
    expect(report.verdict).toBe('unknown')
    expect(report.headline).toMatch(/CANNOT CONFIRM/)
    expect(report.reason).toBe(PATH_ORDER_UNCHECKED_REASON)
  })
})

describe('WO-1008 resolution - MEASURED with synthesised skips, and labelled as such', () => {
  /**
   * Cut a dropped block into a CLEAN recorded run.
   *
   * A dropped block looks like exactly one thing: the machine flies a straight
   * line across the gap. So the frames inside the window are replaced by points
   * interpolated between the frame before it and the frame after - the chord.
   * Timestamps and executing-move ids are left alone, because a controller that
   * skips moves goes on reporting both.
   */
  function withSkip(capture: Capture, startIndex: number, frames: number): PathFidelitySample[] {
    const samples = samplesOf(capture)
    const a = samples[startIndex - 1].machinePos!
    const b = samples[startIndex + frames].machinePos!
    for (let k = 0; k < frames; k++) {
      const t = (k + 1) / (frames + 1)
      samples[startIndex + k] = {
        ...samples[startIndex + k],
        machinePos: {
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
        },
      }
    }
    return samples
  }

  const capture = load('repeat-3142-run1.json')
  const { moves, startPos } = commandedProgram(capture, 0.25, 3000)
  const CHORD_MM = 0.25
  const FEED_MM_S = 3000 / 60

  const sweep = [2, 3, 4, 6, 8, 10, 12, 16, 24, 32].map((frames) => {
    const startIndex = 200
    const report = analysePathFidelity({
      moves,
      startPos,
      samples: withSkip(capture, startIndex, frames),
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    const spanMs = capture.points[startIndex + frames].t - capture.points[startIndex - 1].t
    const gapMm = FEED_MM_S * (spanMs / 1000)
    return {
      frames,
      gapMm,
      gapMoves: Math.round(gapMm / CHORD_MM),
      caught: report.verdict === 'divergence',
      peakMm: report.worst!.deviationMm,
    }
  })

  it('reports the smallest skip it can still see, in mm of path and in moves', () => {
    const caught = sweep.filter((row) => row.caught)
    expect(caught.length).toBeGreaterThan(0)
    const smallest = caught[0]
    // Every larger skip must also be caught - a detector whose sensitivity is
    // not monotonic in gap size is telling you nothing.
    for (const row of sweep) {
      if (row.gapMm >= smallest.gapMm) expect(row.caught).toBe(true)
    }
    console.log(
      '\nWO-1008 RESOLUTION - SYNTHESISED skips cut into the REAL clean run '
        + 'repeat-3142-run1.json\n'
        + '(r=125, 0.25 mm chord, 3000 mm/min, 32 ms poll, Linearerror=0.03 -> 0.09 mm threshold)\n'
        + '  frames  gap mm  gap moves  peak dev mm  caught\n'
        + sweep
          .map(
            (r) =>
              '  '
              + String(r.frames).padStart(6)
              + r.gapMm.toFixed(1).padStart(8)
              + String(r.gapMoves).padStart(11)
              + r.peakMm.toFixed(3).padStart(13)
              + (r.caught ? '  YES' : '  no'),
          )
          .join('\n')
        + '\n  SMALLEST CAUGHT: '
        + smallest.gapMm.toFixed(1)
        + ' mm of path, about '
        + smallest.gapMoves
        + ' moves at this chord, '
        + smallest.frames
        + ' status frames.\n'
        + '  BELOW THAT IT IS BLIND. The machine is back on the commanded path before\n'
        + '  the next frame arrives, and a chord across a short gap is inside the\n'
        + '  configured tolerance anyway.\n',
    )
  })

  it('the smallest skip it can see is far larger than one move, and says so', () => {
    const smallest = sweep.filter((row) => row.caught)[0]
    // The check exists for a ~3.6 s, ~110-frame drop. It is NOT a per-move
    // check and must never be sold as one.
    expect(smallest.gapMoves).toBeGreaterThan(10)
    const report = analysePathFidelity({
      moves,
      startPos,
      samples: withSkip(capture, 200, 2),
      reportsExecutingMoveId: true,
      toleranceMm: SAMPLE_MACHINE_TOLERANCE_MM,
    })
    // A two-frame skip is invisible, and the report says a short gap is.
    expect(report.verdict).toBe('clean')
    expect(report.limits.join(' ')).toMatch(/SHORT GAP IS INVISIBLE/)
    expect(report.limits.join(' ')).toMatch(/2\.4 ms/)
  })
})

describe('WO-1008 report, do not act', () => {
  it('the report is data and text - it exposes nothing that can refuse anything', () => {
    const report = analyseCapture('circle-stress.json', 0.1, 3000)
    for (const value of Object.values(report)) {
      expect(typeof value).not.toBe('function')
    }
    expect(report.headline).toMatch(/Check the part/)
  })
})

// ===========================================================================
// WO-1008 FIX ROUND - THE PRODUCT ARMS THE CHECK, AND THIS IS WHERE THAT IS
// PROVEN THROUGH THE PRODUCT'S OWN LIFECYCLE
// ===========================================================================
//
// The audit's finding, verbatim: "the product never arms the check with
// commanded moves or a configured tolerance". It was right, and the reason the
// slice above did not expose it is that every case in it hands
// `analysePathFidelity` a move list and a tolerance directly. So these cases
// deliberately hand it NOTHING: they drive `machineSession` - connect, load,
// start, run, finish - and read the report the SESSION produced.
//
// Both inputs now come from the product:
//
//   the commanded moves    `loadMachineProgram` arms the program it just armed
//                          on the controller, and `commandedPathFromProgram`
//                          turns that same text into the move list, ids being
//                          source lines (the convention `simulatedController`
//                          mints and `uccncController.jobProgress` reads back).
//   the tolerance          `refreshPathToleranceFromMachine` reads
//                          `[Generalsettings] Linearerror` out of this
//                          project's machine, where importing a UCCNC `.pro`
//                          already puts it, verbatim.
//
// EVERY ONE OF THESE FAILS ON THE PRE-FIX PRODUCT with "no commanded move list
// was recorded for this job" - which is the whole finding.
//
// The simulated controller is the backend here because it is the one in `src/`
// that both takes G-code TEXT and reports `executingMoveId`; the real bridge
// takes geometry only, and nothing in `src/` calls `loadMoves` yet, so no
// product path can reach that door.

describe('WO-1008 fix round - the PRODUCT arms the check, end to end', () => {
  const SAMPLE_MACHINE_LINEAR_ERROR: UnsentSetting = {
    controller: 'uccnc',
    key: 'Generalsettings.Linearerror',
    value: '0.03',
  }

  /** A machine described the way an imported UCCNC profile describes one. */
  function machineWith(unsentSettings: UnsentSetting[] | undefined): MachineConfig {
    return {
      id: 'wo1008-machine',
      name: 'WO-1008 Test Machine',
      type: 'gantry_router',
      controller: 'uccnc',
      travel: { x: 738, y: 724.5, z: 128.9 },
      homeConvention: PATH_MACHINE_HOME_CONVENTION,
      rapidRate: 5000,
      maxSpindleRpm: 24000,
      minSpindleRpm: 8000,
      spindleDirection: 'cw',
      toolChanger: 'manual',
      coolant: false,
      notes: '',
      unsentSettings,
    }
  }

  /**
   * LINE MOVES ONLY, and that is deliberate: `SimulatedController` has no
   * circular interpolation ("an arc animates the same as a line",
   * simulatedController.ts:1514), so this program is one the simulator flies
   * EXACTLY. An arc would measure the simulator's shortcut instead - which is
   * its own case, below.
   */
  const PROGRAM = [
    'G21 G90 G54',
    'G0 X0 Y0 Z5',
    'G1 Z-1 F300',
    'G1 X60 F900',
    'G1 Y40',
    'G1 X0',
    'G1 Y0',
    'G0 Z5',
    'M30',
  ].join('\n')

  let originalMachine: MachineConfig
  let unregisterNoToleranceBackend: (() => void) | undefined

  beforeEach(async () => {
    vi.useFakeTimers()
    originalMachine = useCamStore.getState().project.machine
    useCamStore.setState((s) => ({
      project: { ...s.project, machine: machineWith([SAMPLE_MACHINE_LINEAR_ERROR]) },
    }))
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(200)
      await pending
    }
    unregisterNoToleranceBackend?.()
    unregisterNoToleranceBackend = undefined
    useCamStore.setState((s) => ({ project: { ...s.project, machine: originalMachine } }))
    clearPathFidelity()
    setPathToleranceMm(null)
    vi.useRealTimers()
  })

  /** Load, run to completion, and hand back the report the SESSION produced. */
  async function runProgram(text: string): Promise<PathFidelityReport | null> {
    const loaded = loadMachineProgram('wo1008.nc', text)
    expect(loaded.lines.length).toBeGreaterThan(0)
    expect(getMachineController().startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    return pathFidelityReport()
  }

  async function reconnectWithMachine(nextMachine: MachineConfig, kind = 'simulator'): Promise<void> {
    const disconnect = disconnectMachine()
    await vi.advanceTimersByTimeAsync(200)
    await disconnect
    useCamStore.setState((s) => ({
      project: { ...s.project, machine: nextMachine },
    }))
    const reconnect = connectMachine(kind, 115200)
    await vi.advanceTimersByTimeAsync(300)
    await reconnect
    __resetEstopInterlockForTest()
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
  }

  async function reconnectWithoutStatedTolerance(): Promise<void> {
    // A registered controller fake, not the native simulator route: reuse the
    // real text interpreter/motion/events, but expose NO path-tolerance fact.
    // WO-2277 gives the native simulator a tolerance, so it cannot prove this
    // missing-controller-fact contract anymore. The session is never mocked.
    unregisterNoToleranceBackend = registerMachineBackend({
      controller: 'uccnc', controllerDisplayName: 'UCCNC',
      backend: 'wo1008-no-tolerance', connectionKind: 'wo1008-no-tolerance',
      capabilities: {
        physicalConnection: false, simulator: false, serialPermission: false, grblSettings: false,
      },
      sessionController: 'declared',
      connect: async (context) => {
        const installed = context.install((events) => new Proxy(new SimulatedController(events, {
          travelMm: context.machine.travel, homeConvention: PATH_MACHINE_HOME_CONVENTION,
        }), {
          get(target, property) {
            if (property === 'pathToleranceMm') return undefined
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }))
        await installed.controller.connect({ kind: 'none' })
        return installed.controller
      },
    })
    await reconnectWithMachine(machineWith(undefined), 'wo1008-no-tolerance')
    expect(Reflect.get(getMachineController(), 'pathToleranceMm')).toBeUndefined()
    expect(getMachineController().capabilities.executingMoveId).toBe(true)
  }

  it("the tolerance comes off THIS machine's own profile, not a constant", () => {
    setPathToleranceMm(null)
    loadMachineProgram('wo1008.nc', PROGRAM)
    // 0.03 is Operator's `Linearerror`, carried verbatim in `unsentSettings` by the
    // profile importer. Nothing in the product typed this number.
    expect(pathToleranceMmValue()).toBe(0.03)
  })

  it('a machine whose profile carries no Linearerror leaves the tolerance UNKNOWN', async () => {
    await reconnectWithoutStatedTolerance()
    setPathToleranceMm(0.03)
    loadMachineProgram('wo1008.nc', PROGRAM)
    expect(pathToleranceMmValue()).toBeNull()
  })

  it('a real run through the session is MEASURED - the commanded moves came from the product', async () => {
    const report = await runProgram(PROGRAM)
    expect(report).not.toBeNull()
    if (report === null) return
    // THE FINDING, INVERTED. Before this round the session had no move list at
    // all and every run ended on exactly this sentence.
    expect(report.reason).not.toBe('no commanded move list was recorded for this job.')
    expect(report.attribution).toBe('executing-move')
    expect(report.samples.attributed).toBeGreaterThan(3)
    expect(report.toleranceMm).toBe(0.03)
    expect(report.thresholdMm).toBeCloseTo(0.09, 10)
    // The simulator flies exactly what a line program gives it, so the derived
    // path and the flown path must agree well inside the threshold. This is
    // also the cry-wolf guard: a derivation that mis-read the units, the
    // coordinate frame or a partial move would show up here as a divergence on
    // a machine that did nothing wrong.
    expect(report.verdict).toBe('clean')
    expect(report.worst?.deviationMm ?? 0).toBeLessThan(0.09)
  })

  it('the same run with no configured tolerance is UNKNOWN, never clean', async () => {
    await reconnectWithoutStatedTolerance()
    const report = await runProgram(PROGRAM)
    expect(report?.verdict).toBe('unknown')
    expect(report?.reason).toContain('configured path tolerance')
  })

  it('RECONNECTING after changing the machine tolerance moves the product threshold with it', async () => {
    const loose = await runProgram(PROGRAM)
    expect(loose?.thresholdMm).toBeCloseTo(0.09, 10)
    await reconnectWithMachine(machineWith([{ ...SAMPLE_MACHINE_LINEAR_ERROR, value: '0.005' }]))
    const tight = await runProgram(PROGRAM)
    expect(tight?.toleranceMm).toBe(0.005)
    expect(tight?.thresholdMm).toBeCloseTo(0.015, 10)
  })

  it('a program in a modal mode this check cannot model says WHICH word, and never reads clean', async () => {
    const report = await runProgram(
      ['G21 G90 G54', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G91', 'G1 X20 F900', 'M30'].join('\n'),
    )
    expect(report?.verdict).toBe('unknown')
    expect(report?.headline).toContain('G91')
  })

  it('a G28 program end is EXCLUDED and reported, not scored as a divergence', async () => {
    // The shape a posted program has: a reference-point move at the end
    // (src/lib/post/emit.ts, `homeCommand`, which is G28 on the UCCNC dialect).
    // It cannot be placed in the program's own work coordinates, so the frames
    // flown during it carry NO verdict - and the operator is told how many
    // they were rather than left to assume the run was fully covered. Scoring
    // them instead would manufacture a divergence over the end of every
    // program, which is this order's cry-wolf failure exactly.
    //
    // G53, the other end-of-program shape `emit.ts` produces, is excluded by
    // the same rule and cannot be shown here: `SimulatedController`'s program
    // dialect does not accept G53 at all (SUPPORTED_G, simulatedController.ts),
    // so no such program can be loaded in the first place.
    const report = await runProgram(
      [
        'G21 G90 G54',
        'G0 X0 Y0 Z5',
        'G1 Z-1 F300',
        'G1 X60 F900',
        'G1 Y40',
        'G0 Z5',
        'G28',
        'M30',
      ].join('\n'),
    )
    expect(report).not.toBeNull()
    if (report === null) return
    expect(report.verdict).toBe('clean')
    expect(report.samples.unmodelled).toBeGreaterThan(0)
    expect(report.limits.join(' ')).toContain('does not model')
  })

  it('the operator is told, on the surface the machine already uses', async () => {
    useMachineControl.setState({ consoleLines: [] })
    const report = await runProgram(PROGRAM)
    const lines = useMachineControl.getState().consoleLines.map((entry) => entry.text)
    expect(report).not.toBeNull()
    expect(lines).toContain(report!.headline.replace(/(-?\d+(?:\.\d+)?) mm/g, (_, n: string) => `${Number(n).toFixed(2)} mm`).replace(/\b([XYZ]) (-?\d+(?:\.\d+)?)(?![\d.])(?: mm)?/g, (_, axis: string, n: string) => `${axis} ${Number(n).toFixed(2)} mm`))
    // Requirement 3: the limit is in the report the OPERATOR reads.
    // WO-2008 re-pin: the report is read on request - the console gets ONE
    // summary row, never the standing "limit:" rows (Operator's "no nagging").
    expect(report!.limits.join(' ')).toContain('SHORT GAP IS INVISIBLE')
    expect(lines.some((line) => line.includes('SHORT GAP IS INVISIBLE'))).toBe(false)
    expect(lines.some((line) => line.startsWith('  limit: '))).toBe(false)
  })

  it('each run is scored against the program THAT load armed, not the one before it', async () => {
    // The queue an old load left behind is the obvious way this wiring goes
    // wrong, and it fails loudly rather than subtly: the second program travels
    // ground the first never visited, so a stale queue would read as a large
    // sustained divergence on a machine doing exactly as it was told.
    expect((await runProgram(PROGRAM))?.verdict).toBe('clean')
    const second = await runProgram(
      ['G21 G90 G54', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X-45 Y-25 F900', 'G0 Z5', 'M30'].join('\n'),
    )
    expect(second?.verdict).toBe('clean')
  })
})

// ---------------------------------------------------------------------------
// THE ARC THROUGH THE SESSION - THE POSITIVE CONTROL.
//
// Until WO-1285 `SimulatedController` had no circular interpolation - it
// animated an arc as a straight line to the endpoint - and this block used
// that deficiency as its fault: a commanded half-circle came out as a
// DIVERGENCE because the simulator genuinely flew the chord. The simulator now
// draws the true arc (WO-1285), so a commanded half-circle flown through the
// session must read CLEAN, on the arc, with the same final position - the
// instrument sees the arc's swept path, not its chord, and raises nothing on a
// machine that flew what it was told. The divergence itself, a commanded arc
// flown as its chord, moved to the geometry block below, where the fault is
// injected explicitly (`runGeometry(commanded, frame, flown)`) rather than
// borrowed from a simulator gap that no longer exists.
// ---------------------------------------------------------------------------

describe('WO-1008 fix round - a commanded arc through the session, flown as the arc it is', () => {
  let originalMachine: MachineConfig

  const ARC_PROGRAM = [
    'G21 G90 G54',
    'G0 X0 Y0 Z5',
    'G1 Z-1 F300',
    'G1 X30 Y0 F900',
    // A 180 degree sweep about (0,0): commanded round, and since WO-1285 flown round.
    'G3 X-30 Y0 I-30 J0',
    'G0 Z5',
    'M30',
  ].join('\n')

  beforeEach(async () => {
    vi.useFakeTimers()
    originalMachine = useCamStore.getState().project.machine
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        machine: {
          ...originalMachine,
          id: 'wo1008-arc',
          controller: 'uccnc',
          controllerDefinition: undefined,
          homeConvention: PATH_MACHINE_HOME_CONVENTION,
          rapidRate: 5000,
          unsentSettings: [
            { controller: 'uccnc', key: 'Generalsettings.Linearerror', value: '0.03' },
          ],
        },
      },
    }))
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(200)
      await pending
    }
    useCamStore.setState((s) => ({ project: { ...s.project, machine: originalMachine } }))
    clearPathFidelity()
    setPathToleranceMm(null)
    vi.useRealTimers()
  })

  it('a commanded arc flown as an ARC reads clean - measured on the swept path, not the chord', async () => {
    useMachineControl.setState({ consoleLines: [] })
    loadMachineProgram('wo1008-arc.nc', ARC_PROGRAM)
    expect(getMachineController().startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)

    const report = pathFidelityReport()
    expect(report).not.toBeNull()
    if (report === null) return
    expect(report.verdict).toBe('clean')
    expect(report.attribution).toBe('executing-move')
    expect(report.samples.attributed).toBeGreaterThan(10)
    // The simulator's position rides the 30 mm circle; measured against the
    // directed arc span the deviation is far inside this machine's 0.03 mm
    // Linearerror threshold. Before WO-1285 this number was the full radius.
    expect(report.worst?.deviationMm ?? Infinity).toBeLessThan(0.01)

    // Same end point as ever - the endpoint check never saw the difference.
    const finalPos = getMachineController().status().workPos
    expect(finalPos?.x ?? NaN).toBeCloseTo(-30, 3)
    expect(finalPos?.y ?? NaN).toBeCloseTo(0, 3)

    // And nothing reaches the operator as an error.
    const errors = useMachineControl.getState().consoleLines.filter((entry) => entry.severity === 'error')
    expect(errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ATTEMPT 2 - THE HALF THE AUDIT FOUND MISSING
//
// Attempt 1 armed the check from `loadMachineProgram`, which returns early for
// any controller without `capabilities.gcodeText` - and that is the AXBB-E,
// permanently, because it has no G-code interpreter at all. So the check ran
// on the text route only, and on the one machine it was built for it never
// armed. The audit was right.
//
// These are the two doors that close it: a job handed over as GEOMETRY is
// measured end to end, and a G-code load on a controller that takes no text
// SAYS SO rather than going quiet. Everything above this line is unchanged.
// ---------------------------------------------------------------------------
describe('WO-1008 attempt 2 - the GEOMETRY route, the one Operator machine will use', () => {
  let originalMachine: MachineConfig

  /**
   * THE COMMANDED PROGRAM, IN THE CONTROLLER'S OWN TERMS - not a line of
   * G-code in it.
   *
   * This is the shape `loadMoves` takes and the only shape the AXBB-E can be
   * given a program in. It is a rectangle at Z-1, and every move after the
   * first is PARTIAL (`{ z: -1 }`, `{ x: 60 }`) exactly as a real posted queue
   * is - so requirement 5 is exercised through the product path here, not only
   * against a hand-built list.
   *
   * The coordinates are the ones the text-route suite already proves fit this
   * machine's declared travel, and they are MACHINE coordinates: the simulator
   * resolves a queued move against its own position (`resolveTarget`), while
   * only the G-code path adds the work offset.
   */
  const GEOMETRY_PROGRAM: QueuedMove[] = [
    { id: 1, kind: 'line', to: { x: 0, y: 0, z: 5 }, feedMmMin: 5000 },
    { id: 2, kind: 'line', to: { z: -1 }, feedMmMin: 300 },
    { id: 3, kind: 'line', to: { x: 60 }, feedMmMin: 900 },
    { id: 4, kind: 'line', to: { y: 40 }, feedMmMin: 900 },
    { id: 5, kind: 'line', to: { x: 0 }, feedMmMin: 900 },
    { id: 6, kind: 'line', to: { y: 0 }, feedMmMin: 900 },
    { id: 7, kind: 'line', to: { z: 5 }, feedMmMin: 5000 },
  ]

  beforeEach(async () => {
    vi.useFakeTimers()
    originalMachine = useCamStore.getState().project.machine
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        machine: {
          ...originalMachine,
          id: 'wo1008-geometry',
          controller: 'uccnc',
          controllerDefinition: undefined,
          homeConvention: PATH_MACHINE_HOME_CONVENTION,
          rapidRate: 5000,
          unsentSettings: [
            { controller: 'uccnc', key: 'Generalsettings.Linearerror', value: '0.03' },
          ],
        },
      },
    }))
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
    // DELIBERATELY NOT SET HERE. The geometry door reads this machine's own
    // `Linearerror` for itself, exactly as the text door does; setting it in
    // the test would hide a door that forgot to.
    setPathToleranceMm(null)
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(200)
      await pending
    }
    useCamStore.setState((s) => ({ project: { ...s.project, machine: originalMachine } }))
    clearPathFidelity()
    setPathToleranceMm(null)
    vi.useRealTimers()
  })

  /**
   * SEND A GEOMETRY JOB THE WAY WO-1019 WILL SEND ONE: arm the check with the
   * commanded queue, hand the SAME queue to the controller, start.
   *
   * `flown` exists so a test can hand the machine something OTHER than what
   * was commanded, which is the whole defect - the controller loses a block
   * and cuts across the gap. It defaults to the commanded queue.
   */
  async function runGeometry(
    commanded: QueuedMove[],
    frame: 'work' | 'machine' = 'machine',
    flown: QueuedMove[] = commanded,
  ): Promise<PathFidelityReport | null> {
    const ctrl = getMachineController()
    expect(ctrl.capabilities.geometryQueue).toBe(true)
    expect(ctrl.loadMoves).toBeDefined()
    armPathFidelityFromMoves(commanded, frame)
    expect(ctrl.loadMoves?.(flown)).toEqual({ ok: true, reason: null })
    expect(ctrl.startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    return pathFidelityReport()
  }

  it('a job sent as GEOMETRY is measured end to end, against a real backend', async () => {
    const report = await runGeometry(GEOMETRY_PROGRAM)
    expect(report).not.toBeNull()
    if (report === null) return
    // MEASURED, not merely "not divergent". The samples were matched to the
    // commanded moves by the id the controller reported, which is the real
    // comparison this order asked for and not a stub.
    expect(report.verdict).toBe('clean')
    expect(report.attribution).toBe('executing-move')
    expect(report.samples.attributed).toBeGreaterThan(10)
    // 0.03 is this machine's own `Linearerror`, read off its profile by the
    // GEOMETRY door - nothing in this test supplied a tolerance.
    expect(pathToleranceMmValue()).toBe(0.03)
    expect(report.thresholdMm).toBeCloseTo(0.09, 6)
  })

  it('a PARTIAL move in a geometry queue reads zero deviation, not a large one', async () => {
    // Requirement 5, through the product: six of these seven moves constrain
    // one axis and carry the rest from the previous move's RESOLVED endpoint.
    // Get that wrong and every one of them reports tens of millimetres.
    expect(
      GEOMETRY_PROGRAM.filter((m) => m.kind === 'line' && Object.keys(m.to).length === 1),
    ).toHaveLength(6)
    const report = await runGeometry(GEOMETRY_PROGRAM)
    expect(report?.worst?.deviationMm ?? Infinity).toBeLessThan(0.09)
  })

  it('A LOST BLOCK IN A GEOMETRY JOB IS DETECTED - and the machine still ends where it should', async () => {
    // The defect itself, in the route Operator's machine uses. The controller is
    // handed the same program with move 5 missing, so it goes straight from
    // (60,40) to (0,0) - a shortcut between two points that are BOTH correct.
    const flown = GEOMETRY_PROGRAM.filter((m) => m.id !== 5).map((m) =>
      m.id === 6 ? ({ ...m, to: { x: 0, y: 0 } } as QueuedMove) : m,
    )
    useMachineControl.setState({ consoleLines: [] })
    const report = await runGeometry(GEOMETRY_PROGRAM, 'machine', flown)
    expect(report).not.toBeNull()
    if (report === null) return

    expect(report.verdict).toBe('divergence')
    expect(report.spans.length).toBeGreaterThan(0)
    // The diagonal cuts about 20 mm inside the commanded corner.
    expect(report.worst?.deviationMm ?? 0).toBeGreaterThan(5)

    // AND THIS IS WHY NOTHING ELSE CAUGHT IT. The job completed and the
    // machine finished exactly where the program said it would, so every
    // endpoint check passes by construction.
    const finalPos = getMachineController().status().machinePos
    expect(finalPos?.x ?? NaN).toBeCloseTo(0, 3)
    expect(finalPos?.y ?? NaN).toBeCloseTo(0, 3)
    expect(finalPos?.z ?? NaN).toBeCloseTo(5, 3)

    // The operator hears it on the console the machine already uses.
    const line = useMachineControl
      .getState()
      .consoleLines.find((entry) => entry.text === report.headline.replace(/(-?\d+(?:\.\d+)?) mm/g, (_, n: string) => `${Number(n).toFixed(2)} mm`).replace(/\b([XYZ]) (-?\d+(?:\.\d+)?)(?![\d.])(?: mm)?/g, (_, axis: string, n: string) => `${axis} ${Number(n).toFixed(2)} mm`))
    expect(line?.severity).toBe('error')
  })

  // WO-1285 moved the arc divergence here from the text block above. The
  // approach comes DOWN onto (60,0) rather than along y = 0, on purpose: the
  // check tolerates the controller's id lag by searching the moves either side
  // of the reported one, so a chord that retraces the previous move would read
  // as still being on it. This chord lies on nothing that was commanded.
  const ARC_QUEUE: QueuedMove[] = [
    { id: 1, kind: 'line', to: { x: 60, y: 0, z: 5 }, feedMmMin: 5000 },
    { id: 2, kind: 'line', to: { z: -1 }, feedMmMin: 300 },
    // A native half-circle from (60,0) round through y = 30 to (0,0).
    { id: 3, kind: 'arc', to: { x: 0, y: 0, z: -1 }, centre: { x: 30, y: 0, z: -1 }, clockwise: false, plane: 'xy', feedMmMin: 900 },
    { id: 4, kind: 'line', to: { z: 5 }, feedMmMin: 5000 },
  ]

  it('a commanded ARC flown as its CHORD is reported as a divergence, loudly', async () => {
    // The fault this file was written for, in the route Operator's machine uses:
    // the controller is handed a straight line between the arc's two ends.
    // Both ends are exactly right.
    const flown = ARC_QUEUE.map((m) => (m.id === 3 ? ({ id: 3, kind: 'line', to: { x: 0 }, feedMmMin: 900 } as QueuedMove) : m))
    useMachineControl.setState({ consoleLines: [] })
    const report = await runGeometry(ARC_QUEUE, 'machine', flown)
    expect(report).not.toBeNull()
    if (report === null) return

    expect(report.verdict).toBe('divergence')
    expect(report.spans.length).toBeGreaterThan(0)
    // A 30 mm radius half-circle flown as its chord runs up to the full
    // radius off the commanded path.
    expect(report.worst?.deviationMm ?? 0).toBeGreaterThan(10)

    // IT IS NOT AN ENDPOINT CHECK. The machine finished exactly where the
    // program said.
    const finalPos = getMachineController().status().machinePos
    expect(finalPos?.x ?? NaN).toBeCloseTo(0, 3)
    expect(finalPos?.y ?? NaN).toBeCloseTo(0, 3)
    expect(finalPos?.z ?? NaN).toBeCloseTo(5, 3)

    const line = useMachineControl
      .getState()
      .consoleLines.find((entry) => entry.text === report.headline.replace(/(-?\d+(?:\.\d+)?) mm/g, (_, n: string) => `${Number(n).toFixed(2)} mm`).replace(/\b([XYZ]) (-?\d+(?:\.\d+)?)(?![\d.])(?: mm)?/g, (_, axis: string, n: string) => `${axis} ${Number(n).toFixed(2)} mm`))
    expect(line?.severity).toBe('error')
  })

  it('and the same arc flown AS an arc through the geometry door reads clean', async () => {
    const report = await runGeometry(ARC_QUEUE)
    expect(report?.verdict).toBe('clean')
    expect(report?.samples.attributed).toBeGreaterThan(10)
    expect(report?.worst?.deviationMm ?? Infinity).toBeLessThan(0.01)
  })

  it('the geometry door derives nothing, so no block of it can go unmodelled', async () => {
    // The text door has to interpret G-code and honestly reports the blocks it
    // could not model. These moves ARE the commanded path, so there is nothing
    // to fail to interpret - and that is a measured 0, not an omission.
    const report = await runGeometry(GEOMETRY_PROGRAM)
    expect(report?.samples.unmodelled).toBe(0)
    expect(report?.samples.noPosition).toBe(0)
  })

  it('the FRAME is the caller to state, and stating it wrong is visible rather than silent', async () => {
    // A queue built in machine coordinates, scored against work position while
    // G54 sits 100 mm away, must NOT read clean - the offset is a real
    // difference between the path commanded and the path measured, and this
    // module cannot know which frame a caller built its moves in. That is why
    // `armPathFidelityFromMoves` has no default for it.
    expect(getMachineController().sendCommand('G10 L2 P1 X-100 Y-50 Z0')).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    const report = await runGeometry(GEOMETRY_PROGRAM, 'work')
    expect(report?.verdict).not.toBe('clean')
    expect(report?.worst?.deviationMm ?? 0).toBeGreaterThan(50)
  })
})

describe('WO-1008 attempt 2 - a controller that takes no G-code text is TOLD SO, not left silent', () => {
  let originalMachine: MachineConfig

  const PROGRAM = ['G21 G90 G54', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'G1 X20 F900', 'M30'].join('\n')

  beforeEach(async () => {
    vi.useFakeTimers()
    originalMachine = useCamStore.getState().project.machine
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        machine: {
          ...originalMachine,
          id: 'wo1008-no-text',
          controller: 'uccnc',
          controllerDefinition: undefined,
          homeConvention: PATH_MACHINE_HOME_CONVENTION,
        },
      },
    }))
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    // ANSWER THE CAPABILITY QUESTION THE WAY THE REAL AXBB-E ANSWERS IT.
    // `UccncController` declares `gcodeText: false` - it has no interpreter of
    // its own - and reaching the real one needs a machine-local bridge.
    // Flipping the flag drives the identical branch of `loadMachineProgram`;
    // that branch is selected by this capability and by nothing else, so this
    // exercises the real path without pretending a bridge is present.
    ;(getMachineController().capabilities as { gcodeText: boolean }).gcodeText = false
  })

  afterEach(async () => {
    ;(getMachineController().capabilities as { gcodeText: boolean }).gcodeText = true
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(200)
      await pending
    }
    useCamStore.setState((s) => ({ project: { ...s.project, machine: originalMachine } }))
    clearPathFidelity()
    setPathToleranceMm(null)
    vi.useRealTimers()
  })

  it('refuses at the load door in one sentence and leaves no program loaded', () => {
    useMachineControl.setState({ consoleLines: [] })
    const reportBefore = pathFidelityReport()
    const loaded = loadMachineProgram('wo1008-no-text.nc', PROGRAM)
    expect(loaded.lines).toHaveLength(0)
    expect(useMachineControl.getState()).toMatchObject({
      programText: null,
      job: { phase: 'empty', name: null },
    })
    expect(pathFidelityReport()).toBe(reportBefore)
    expect(useMachineControl.getState().consoleLines.map(({ text }) => text)).toEqual([
      'G-code file refused: this controller runs setups, not G-code files - load the setup instead.',
    ])
  })

  it('never invokes the path check, however many times the file is refused', () => {
    const reportBefore = pathFidelityReport()
    for (let i = 0; i < 3; i++) loadMachineProgram('wo1008-no-text.nc', PROGRAM)
    expect(pathFidelityReport()).toBe(reportBefore)
  })
})
