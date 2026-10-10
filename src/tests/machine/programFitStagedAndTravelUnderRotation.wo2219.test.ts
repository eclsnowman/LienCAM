// WO-2219 (resumed): the two checks the first attempt could not reach, now
// wired - the bridge file route's staged fit subject (`stagedGeometryProgramPath`)
// and the load refusal (`firstStepOutsideTravel`) - measured where the
// controller runs the program in a ROTATED work offset
// (docs/design/WCS-ROTATION.md: machine = O + Rot(R)(work), CCW positive).
// Numbers are Operator's table (X 0..738, Y 0..724.5) and the rehearsal's 40 mm
// square in G55, as in programFitUnderRotation.wo2219.test.ts.
import { afterEach, describe, expect, it } from 'vitest'
import type { WCS } from '../../types'
import {
  deriveAxisEnvelopeFromHome,
  ENVELOPE_FIT_TOLERANCE_MM,
  fitProgramToEnvelope,
  type MachineEnvelope,
} from '../../lib/machine/machineEnvelope'
import { interpretGcodeProgram } from '../../lib/gcode/interpret'
import {
  buildStraightLineProgram,
  describeTravelOffence,
  firstStepOutsideTravel,
} from '../../lib/program/buildMachineProgram'
import {
  armPathFidelityFromMoves,
  clearPathFidelity,
  stagedGeometryProgramPath,
} from '../../lib/machine/machineSession'
import type { MachineProgram, QueuedMove } from '../../lib/machine/controller'

const SQUARE = [
  'G21 G90 G55', 'G0 Z20', 'G0 X0 Y0', 'G1 Z5 F1000', 'G1 X0 Y20 F1500', 'G2 X20 Y40 I20 J0',
  'G1 X40 Y40', 'G1 X40 Y0', 'G1 X0 Y0', 'G0 Z20', 'M30',
].join('\n') + '\n'

const TABLE: MachineEnvelope = {
  x: deriveAxisEnvelopeFromHome({ travelMm: 738, homesToward: 'max', homePositionMm: 738 }),
  y: deriveAxisEnvelopeFromHome({ travelMm: 724.5, homesToward: 'max', homePositionMm: 724.5 }),
  z: deriveAxisEnvelopeFromHome({ travelMm: 128.9, homesToward: 'max', homePositionMm: 128.9 }),
}

const G55 = { x: 400, y: 400, z: 60 }
const G55_NEAR_EDGE = { x: 690, y: 400, z: 60 }

/** The square as the bridge's geometry door stages it: the production reader
 *  then the production builder (the same two steps WO-1630's test uses). */
function stagedSquare(): { program: MachineProgram; steps: QueuedMove[] } {
  const interpreted = interpretGcodeProgram(SQUARE, {
    dialect: 'uccnc',
    sessionWcs: 'G55',
    initialPosition: { x: 0, y: 0, z: 0 },
    machineUnits: 'mm',
    workOffsets: { G55 },
  })
  if (!interpreted.ok) throw new Error(interpreted.refusal.message)
  const moves = interpreted.program.stages.flatMap((stage) => stage.moves)
  const frame = {
    id: 'wo2219-g55', label: 'G55', fixtureOffset: 55, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  } as WCS
  const built = buildStraightLineProgram(moves, frame, 3000, { opId: 'wo2219', setupId: 'wo2219' })
  if (!built.ok) throw new Error(built.reason)
  const steps = built.program.steps.filter(
    (step): step is QueuedMove => step.kind === 'line' || step.kind === 'arc',
  )
  return { program: built.program, steps }
}

describe('WO-2219 staged (bridge file) route: the held start is not a program point', () => {
  afterEach(() => { clearPathFidelity() })

  // The capture's numbers: after a file load the arming start is the tool's
  // workPos in the frame active at load - G54's (656.77, 663.18) - and the
  // first staged line `G0 Z20` leaves X and Y to it.
  const HELD_START = { x: 656.77, y: 663.18, z: 30 }

  it('workBounds are the square alone, not the held tool position', () => {
    const { steps } = stagedSquare()
    expect(steps[0].kind === 'line' && steps[0].to.x).toBeUndefined()
    armPathFidelityFromMoves(steps, 'work', HELD_START)
    const staged = stagedGeometryProgramPath()!
    expect(staged.workBounds).toEqual({ min: { x: 0, y: 0, z: 5 }, max: { x: 40, y: 40, z: 20 } })
    expect(staged.workXYPoints.length).toBeGreaterThan(0)
    expect(staged.workXYPoints.every((p) => p.x >= 0 && p.x <= 40 && p.y >= 0 && p.y <= 40)).toBe(true)
    // The drawn path still starts where the tool is (display, unchanged).
    expect(staged.moves[0]).toMatchObject({ x: 656.77, y: 663.18, z: 20 })
  })

  it('0 deg: the square in G55 X400 Y400 fits - no false PARTLY OUTSIDE (main: X 400..1056.8)', () => {
    armPathFidelityFromMoves(stagedSquare().steps, 'work', HELD_START)
    const staged = stagedGeometryProgramPath()!
    const fit = fitProgramToEnvelope(staged.workBounds, G55, TABLE, undefined, staged.machineAxisRanges)
    expect(fit?.state).toBe('inside')
    expect(fit!.axes.find((a) => a.axis === 'x')).toMatchObject({ programMin: 400, programMax: 440 })
    expect(fit!.axes.find((a) => a.axis === 'y')).toMatchObject({ programMin: 400, programMax: 440 })
  })

  it('30 deg: fits, measured turned from the staged points (main: X 400..855.0)', () => {
    armPathFidelityFromMoves(stagedSquare().steps, 'work', { x: 454.97, y: 112.03, z: 30 })
    const staged = stagedGeometryProgramPath()!
    const fit = fitProgramToEnvelope(
      staged.workBounds, G55, TABLE, undefined, staged.machineAxisRanges,
      { degrees: 30, workPoints: staged.workXYPoints, workArcs: staged.workArcs },
    )
    expect(fit?.state).toBe('inside')
    const x = fit!.axes.find((a) => a.axis === 'x')!
    // The arc (centre (20, 20), r 20) turned: centre X 7.321 - 20 = -12.679.
    // No arc END gets there - (0, 20) turns to X -10 - so this is the bulge.
    expect(x.programMin).toBeCloseTo(387.321, 3)
    expect(x.programMax).toBeCloseTo(434.641, 3) // (40, 0) turned: X 34.641
    expect(staged.workArcs).toEqual([{ from: { x: 0, y: 20 }, to: { x: 20, y: 40 }, centre: { x: 20, y: 20 }, clockwise: true }])
  })

  it('-30 deg at G55 X690: the turned corner is reported with the true machine number', () => {
    armPathFidelityFromMoves(stagedSquare().steps, 'work', HELD_START)
    const staged = stagedGeometryProgramPath()!
    const fit = fitProgramToEnvelope(
      staged.workBounds, G55_NEAR_EDGE, TABLE, undefined, staged.machineAxisRanges,
      { degrees: -30, workPoints: staged.workXYPoints, workArcs: staged.workArcs },
    )
    expect(fit?.state).toBe('partial')
    expect(fit!.axes.find((a) => a.axis === 'x')!.programMax).toBeCloseTo(744.641, 3)
  })

  it('an axis the program never commands keeps its held value, as before', () => {
    const steps: QueuedMove[] = [
      { id: 1, kind: 'line', to: { x: 0, y: 0 }, feedMmMin: 3000, rapid: true },
      { id: 2, kind: 'line', to: { x: 40, y: 40 }, feedMmMin: 1000 },
    ]
    armPathFidelityFromMoves(steps, 'work', HELD_START)
    expect(stagedGeometryProgramPath()!.workBounds).toEqual({ min: { x: 0, y: 0, z: 30 }, max: { x: 40, y: 40, z: 30 } })
  })
})

describe('WO-2219 firstStepOutsideTravel (the load refusal) under a rotated work offset', () => {
  const AT_700 = { x: 700, y: 400, z: 60 }

  it('0 deg: unchanged - the square at X700 runs to 740 and is refused; 0 equals no argument', () => {
    const { program } = stagedSquare()
    const plain = firstStepOutsideTravel(program, AT_700, TABLE)
    expect(plain).toMatchObject({ axis: 'x', reachesMm: 740 })
    expect(firstStepOutsideTravel(program, AT_700, TABLE, ENVELOPE_FIT_TOLERANCE_MM, 0)).toEqual(plain)
  })

  it('+30 deg at X700: it really reaches X 734.64 - fits, not refused', () => {
    expect(firstStepOutsideTravel(stagedSquare().program, AT_700, TABLE, ENVELOPE_FIT_TOLERANCE_MM, 30)).toBeNull()
  })

  it('-30 deg at X690: fits unturned (690..730) but the turned (40, 40) corner reaches X 744.641 - refused with that number', () => {
    const { program } = stagedSquare()
    expect(firstStepOutsideTravel(program, G55_NEAR_EDGE, TABLE)).toBeNull()
    const offence = firstStepOutsideTravel(program, G55_NEAR_EDGE, TABLE, ENVELOPE_FIT_TOLERANCE_MM, -30)
    expect(offence).toMatchObject({ axis: 'x', bulge: false })
    expect(offence!.reachesMm).toBeCloseTo(744.641, 3)
    expect(describeTravelOffence(offence!, program)).toContain('reaches X 744.641, outside the X travel 0..738')
  })

  it('an arc is measured turned whole: its turned bulge is caught though both turned ends are inside', () => {
    // A quarter circle about (0, 0), radius 30, CCW from -45 to +45 deg: its
    // Y runs -21.2..21.2. Turned +90 deg it runs from 45 to 135 deg, through
    // 90: Y reaches 30 at the bulge while both ends stay at 21.2. Origin Y 700:
    // unturned 678.8..721.2 fits 0..724.5; turned the bulge reaches 730.
    const h = 30 * Math.SQRT1_2
    const program: MachineProgram = {
      frame: 'work', units: 'mm', index: {},
      steps: [
        { id: 1, kind: 'line', to: { x: h, y: -h, z: 0 }, feedMmMin: 3000, rapid: true },
        { id: 2, kind: 'arc', to: { x: h, y: h, z: 0 }, centre: { x: 0, y: 0, z: 0 }, clockwise: false, plane: 'xy', feedMmMin: 1000 },
      ],
    }
    const origin = { x: 400, y: 700, z: 60 }
    expect(firstStepOutsideTravel(program, origin, TABLE)).toBeNull()
    const offence = firstStepOutsideTravel(program, origin, TABLE, ENVELOPE_FIT_TOLERANCE_MM, 90)
    expect(offence).toMatchObject({ stepId: 2, kind: 'arc', axis: 'y', bulge: true })
    expect(offence!.reachesMm).toBeCloseTo(730, 6)
  })

  it('the fit measures the same turned bulge from the staged arc (ends alone would miss it)', () => {
    const h = 30 * Math.SQRT1_2
    const arc = { from: { x: h, y: -h }, to: { x: h, y: h }, centre: { x: 0, y: 0 }, clockwise: false }
    const bounds = { min: { x: h, y: -h, z: 0 }, max: { x: 30, y: h, z: 0 } }
    const origin = { x: 400, y: 700, z: 60 }
    const endsOnly = fitProgramToEnvelope(bounds, origin, TABLE, undefined, null, { degrees: 90, workPoints: [arc.from, arc.to] })
    expect(endsOnly?.state).toBe('inside')
    const withArc = fitProgramToEnvelope(bounds, origin, TABLE, undefined, null, { degrees: 90, workPoints: [arc.from, arc.to], workArcs: [arc] })
    expect(withArc?.state).toBe('partial')
    expect(withArc!.axes.find((a) => a.axis === 'y')!.programMax).toBeCloseTo(730, 6)
    // The same ends clockwise is the long way round (270 deg), through 180:
    // X reaches -30, which neither end nor the short arc does.
    const cw = fitProgramToEnvelope(bounds, origin, TABLE, undefined, null, { degrees: 0.0001, workPoints: [arc.from, arc.to], workArcs: [{ ...arc, clockwise: true }] })
    expect(cw!.axes.find((a) => a.axis === 'x')!.programMin).toBeCloseTo(370, 2)
  })

  it('a G53 line is machine coordinates and is never turned', () => {
    const program = {
      frame: 'work', units: 'mm', index: {},
      steps: [
        { id: 1, kind: 'line', to: { x: 0, y: 0, z: 0 }, feedMmMin: 3000, rapid: true, machineAbsolute: true, machineTarget: { x: 730, y: 10 } },
      ],
    } as unknown as MachineProgram
    expect(firstStepOutsideTravel(program, AT_700, TABLE, ENVELOPE_FIT_TOLERANCE_MM, 90)).toBeNull()
  })
})
