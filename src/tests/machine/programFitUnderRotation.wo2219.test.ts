// WO-2219: the program fit check (PARTLY OUTSIDE) and the load-time transfer /
// soft-limit check judge a program run in a ROTATED work offset where the
// controller runs it (docs/design/WCS-ROTATION.md: machine = O + Rot(R)(work),
// CCW positive from +Z, about the work origin). Numbers are Operator's table
// (X 0..738, Y 0..724.5) and the rehearsal's 40 mm square in G55.
import { describe, expect, it } from 'vitest'
import { createDefaultControllerDefinition, type MachineConfig } from '../../types'
import {
  deriveAxisEnvelopeFromHome,
  fitProgramToEnvelope,
  turnWorkBounds,
  turnWorkPoint,
  workXYPointsForFit,
  type MachineEnvelope,
} from '../../lib/machine/machineEnvelope'
import { buildPreviewModel } from '../../lib/machine/previewGeometry'
import { transferCheckJobFromProgram } from '../../lib/machine/programContext'
import {
  checkJobAgainstMachine,
  type TransferWorkOffset,
  type TransferWorkOffsetTable,
} from '../../lib/machine/transferCheck'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { makeMachine } from '../post/helpers'

/** The rehearsal's square-g55.nc (src/tests/evidence/WO-2217/shoot.mjs). */
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
/** The square's box fits unturned here (X 690..730 in 0..738); turned -30 deg
 *  its (40, 40) corner reaches X 690 + 40 cos 30 + 40 sin 30 = 744.641 - the
 *  number the bridge itself refused the load with in this order's capture. */
const G55_NEAR_EDGE = { x: 690, y: 400, z: 60 }

function squareFit(origin: { x: number; y: number; z: number }, degrees?: number) {
  const model = buildPreviewModel(SQUARE)
  return fitProgramToEnvelope(
    model.workBounds,
    origin,
    TABLE,
    undefined,
    model.machineCoordinateRanges,
    degrees === undefined ? undefined : { degrees, workPoints: workXYPointsForFit(model.moves) },
  )
}

describe('WO-2219 turnWorkPoint: the controller sign, pinned by numbers', () => {
  it('turns CCW about the work origin and leaves Z alone', () => {
    const turned = turnWorkPoint({ x: 40, y: 0, z: 5 }, 30)
    expect(turned.x).toBeCloseTo(34.641016, 6)
    expect(turned.y).toBeCloseTo(20, 9)
    expect(turned.z).toBe(5)
    const quarter = turnWorkPoint({ x: 30, y: 0 }, 90)
    expect(quarter.x).toBeCloseTo(0, 9)
    expect(quarter.y).toBeCloseTo(30, 9)
  })

  it('returns the very same point with no rotation', () => {
    const point = { x: 1, y: 2, z: 3 }
    expect(turnWorkPoint(point, 0)).toBe(point)
  })
})

describe('WO-2219 fitProgramToEnvelope under a rotated work offset', () => {
  it('0 deg: every verdict is exactly the unrotated one', () => {
    const plain = squareFit(G55)
    expect(squareFit(G55, 0)).toEqual(plain)
    const nearPlain = squareFit(G55_NEAR_EDGE)
    expect(squareFit(G55_NEAR_EDGE, 0)).toEqual(nearPlain)
    expect(nearPlain?.state).toBe('inside')
    // An unturned overrun is still reported exactly as before.
    const over = squareFit({ x: 710, y: 400, z: 60 })
    expect(over?.state).toBe('partial')
    expect(squareFit({ x: 710, y: 400, z: 60 }, 0)).toEqual(over)
  })

  it('the 40 mm square in G55 X400 Y400 at 30 deg fits, measured where it runs', () => {
    const fit = squareFit(G55, 30)
    expect(fit?.state).toBe('inside')
    expect(fit?.offending).toEqual([])
    const x = fit!.axes.find((a) => a.axis === 'x')!
    const y = fit!.axes.find((a) => a.axis === 'y')!
    // The square's (0,40) corner is the G2 arc (centre (20,20), r 20): its
    // leftmost turned point is at 150 deg -> X 400 + 17.32 - 10 - 20 = 387.32
    // (the turned box corner would say 380). (40,0) -> X 400 + 34.64.
    expect(x.programMin).toBeCloseTo(387.3205, 2)
    expect(x.programMax).toBeCloseTo(434.641, 3)
    // (40,40) -> Y 400 + 20 + 34.64.
    expect(y.programMin).toBeCloseTo(400, 6)
    expect(y.programMax).toBeCloseTo(454.641, 3)
  })

  it('turned corners that leave the table get the existing verdict with the true machine numbers', () => {
    const fit = squareFit(G55_NEAR_EDGE, -30)
    expect(fit?.state).toBe('partial')
    expect(fit?.offending.map((a) => a.axis)).toEqual(['x'])
    const x = fit!.offending[0]
    expect(x.programMin).toBeCloseTo(690, 6)
    expect(x.programMax).toBeCloseTo(744.641, 3)
    expect(x.machineMax).toBe(738)
  })

  it('with the program points the turned extent is exact, not the turned box', () => {
    // A 40 mm circle centred on (20, 20). Turned 45 deg its extent is still
    // 40 wide; turning the four box corners would claim 56.6.
    const points = Array.from({ length: 720 }, (_, i) => ({
      x: 20 + 20 * Math.cos((i * Math.PI) / 360),
      y: 20 + 20 * Math.sin((i * Math.PI) / 360),
    }))
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 40, z: 0 } }
    const exact = turnWorkBounds(bounds, 45, points)
    expect(exact.max.x - exact.min.x).toBeCloseTo(40, 3)
    const box = turnWorkBounds(bounds, 45)
    expect(box.max.x - box.min.x).toBeCloseTo(56.569, 3)
    // So a circle 3 mm from the edge after turning is judged inside.
    const origin = { x: 738 - 3 - exact.max.x, y: 300, z: 0 }
    const fit = fitProgramToEnvelope(bounds, origin, TABLE, undefined, null, { degrees: 45, workPoints: points })
    expect(fit?.state).toBe('inside')
  })

  it('G53 targets are machine coordinates and are never turned', () => {
    const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 40, z: 0 } }
    const fit = fitProgramToEnvelope(bounds, G55, TABLE, undefined, { x: { min: 10, max: 10 } }, { degrees: 30 })
    const x = fit!.axes.find((a) => a.axis === 'x')!
    expect(x.programMin).toBe(10)
  })

  it('points the program never commanded (the assumed start) are not turned into the fit', () => {
    // First X/Y word is X100 Y100: the assumed (0, 0) start is not a place the
    // program sends the tool, exactly as the unrotated work box excludes it.
    const model = buildPreviewModel('G21 G90 G55\nG0 Z20\nG0 X100 Y100\nG1 X140 F500\nM30\n')
    const points = workXYPointsForFit(model.moves)
    expect(points).toEqual([{ x: 100, y: 100 }, { x: 140, y: 100 }])
    expect(model.workBounds?.min.x).toBe(100)
  })
})

function sampleMachine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  const limits: Record<string, number> = { X: 738, Y: 724.5, Z: 128.9 }
  controllerDefinition.axes = controllerDefinition.axes.map((axis) => ({
    ...axis,
    softLimitMin: 0,
    softLimitMax: limits[axis.axis] ?? 100,
  }))
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
    controller: 'grbl' as const,
    key: axisSoftLimitStatementKey(axis.axis, end),
  })))
  return makeMachine({
    name: 'Rotation fixture',
    controller: 'grbl',
    travel: { x: 738, y: 724.5, z: 128.9 },
    controllerDefinition,
  })
}

function check(program: string, offsets: TransferWorkOffset | TransferWorkOffsetTable) {
  return checkJobAgainstMachine(transferCheckJobFromProgram(program), sampleMachine(), offsets)
}

const CLEAN = { refusals: [], warnings: [], notes: [] }

describe('WO-2219 transfer / soft-limit check under a rotated work offset', () => {
  it('0 deg: the square is judged exactly as before, both offset shapes', () => {
    expect(check(SQUARE, { byWcs: { G55: { ...G55, rotationDeg: 0 } } }))
      .toEqual(check(SQUARE, { byWcs: { G55 } }))
    expect(check(SQUARE, { byWcs: { G55: { x: 710, y: 400, z: 60, rotationDeg: 0 } } }))
      .toEqual(check(SQUARE, { byWcs: { G55: { x: 710, y: 400, z: 60 } } }))
    expect(check(SQUARE, { byWcs: { G55: { x: 710, y: 400, z: 60 } } }).refusals)
      .toEqual(['X program range 710..750 mm exceeds soft limits 0..738 mm.'])
    expect(check(SQUARE, { ...G55, rotationDeg: 0 })).toEqual(check(SQUARE, G55))
  })

  it('the square in G55 X400 Y400 at 30 deg is not refused', () => {
    expect(check(SQUARE, { byWcs: { G55: { ...G55, rotationDeg: 30 } } })).toEqual(CLEAN)
  })

  it('turned corners past the table are refused with the true machine numbers', () => {
    expect(check(SQUARE, { byWcs: { G55: G55_NEAR_EDGE } })).toEqual(CLEAN)
    expect(check(SQUARE, { byWcs: { G55: { ...G55_NEAR_EDGE, rotationDeg: -30 } } }).refusals)
      .toEqual(['X program range 690..744.64 mm exceeds soft limits 0..738 mm.'])
  })

  const TWO_FRAMES = 'G21 G90\nG54 G0 X10 Y10\nG55 G0 X40 Y40\nM30\n'

  it('per-frame path: a move that fits turned is not refused; unturned it would be', () => {
    const offsets = (rotationDeg?: number): TransferWorkOffsetTable => ({
      byWcs: { G54: { x: 0, y: 0, z: 0 }, G55: { x: 710, y: 400, z: 0, ...(rotationDeg === undefined ? {} : { rotationDeg }) } },
    })
    expect(check(TWO_FRAMES, offsets()).refusals)
      .toEqual(['G55 X program range 750..750 mm exceeds soft limits 0..738 mm.'])
    expect(check(TWO_FRAMES, offsets(0))).toEqual(check(TWO_FRAMES, offsets()))
    // (40, 40) turned 30 deg -> X 710 + 14.64, Y 400 + 54.64: on the table.
    expect(check(TWO_FRAMES, offsets(30))).toEqual(CLEAN)
  })

  it('per-frame path: a rotated move naming only X still moves machine Y, and is judged on Y', () => {
    const program = 'G21 G90\nG54 G0 X10 Y10\nG55 G0 X0 Y0\nG0 X30\nM30\n'
    const offsets = (rotationDeg: number): TransferWorkOffsetTable => ({
      byWcs: { G54: { x: 0, y: 0, z: 0 }, G55: { x: 400, y: 700, z: 0, rotationDeg } },
    })
    expect(check(program, offsets(0))).toEqual(CLEAN)
    // Work X30 turned 90 deg is machine Y 700 + 30 = 730, past 724.5.
    expect(check(program, offsets(90)).refusals)
      .toEqual(['G55 Y program range 700..730 mm exceeds soft limits 0..724.5 mm.'])
  })

  it('single-frame path: the same X-only move is judged on Y too', () => {
    const program = 'G21 G90 G55\nG0 X0 Y0\nG0 X30\nM30\n'
    expect(check(program, { byWcs: { G55: { x: 400, y: 700, z: 0, rotationDeg: 90 } } }).refusals)
      .toEqual(['Y program range 700..730 mm exceeds soft limits 0..724.5 mm.'])
  })
})
