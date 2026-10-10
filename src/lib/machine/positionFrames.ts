// WO-1667: EVERY POSITION A ROW STATES NAMES ITS COORDINATE SYSTEM.
//
// Operator ruling 2026-09-17 at the machine: "When you're describing dimensions, I need
// you to tell me what coordinate system you're describing them in." The
// `G28 Z18` row said "ending at ... Z-110 in work coordinates" - true, and it
// was machine Z 0, the bottom of travel, which nobody reading the row could
// see. So a position is never a bare number: it is "G54 Z -110", and whenever
// the move is a rapid, a home/reference word, a probe target or a machine
// coordinate move, the machine value sits beside it: "G54 Z -110 (machine Z 0)".
//
// This is the ONE place such a sentence is built. Console rows, the Probing
// panel, park and setter rows and the path check all call it; the audit test
// (src/tests/machine/positionFrames.wo1667.test.ts) fails on a route that
// builds its own.

export type PositionAxisKey = 'x' | 'y' | 'z'
export type PositionPoint = Partial<Record<PositionAxisKey, number | null>>

export interface FramedPosition {
  /** The work system the work value is in ('G54'..'G59'); null when unknown. */
  wcs?: string | null
  /** The position in `wcs` work coordinates. */
  work?: PositionPoint | null
  /** The same position in machine coordinates. */
  machine?: PositionPoint | null
  /** The work origin in machine coordinates: machine = work + offset. Fills
   *  whichever of `work` / `machine` was not given. */
  offset?: PositionPoint | null
  /** Which axes to state, in X-Y-Z order. Default: every axis with a value. */
  axes?: readonly PositionAxisKey[]
  /** Put the machine value beside the work value. Default true: a caller that
   *  knows the move is an ordinary feed move in work coordinates turns it off. */
  withMachine?: boolean
  /** Number formatting (units, precision). Default: mm, up to 4 decimals. */
  format?: (mm: number) => string
}

const AXES: readonly PositionAxisKey[] = ['x', 'y', 'z']

/** Up to four decimals, no trailing zeros, never "-0". */
export function positionNumber(mm: number): string {
  const rounded = Number(mm.toFixed(4))
  return (Object.is(rounded, -0) ? 0 : rounded).toString()
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * "G54 Z -110 (machine Z 0)", "G54 X 10 Y 20 Z -5 (machine X 748 Y 744.5 Z 105)",
 * "G54 X 10 Y 20" (work only, `withMachine: false`) or "machine Z 0" (no work
 * frame known). Returns '' when no stated axis has a value.
 */
export function formatPosition(position: FramedPosition): string {
  const fmt = position.format ?? positionNumber
  const offset = position.offset ?? null
  const wcs = position.wcs ?? null
  const workOf = (axis: PositionAxisKey): number | null => {
    const stated = position.work?.[axis]
    if (finite(stated)) return stated
    const machine = position.machine?.[axis]
    const o = offset?.[axis]
    return finite(machine) && finite(o) ? machine - o : null
  }
  const machineOf = (axis: PositionAxisKey): number | null => {
    const stated = position.machine?.[axis]
    if (finite(stated)) return stated
    const work = position.work?.[axis]
    const o = offset?.[axis]
    return finite(work) && finite(o) ? work + o : null
  }
  const axes = (position.axes ?? AXES).filter((axis) => AXES.includes(axis))
  const ordered = AXES.filter((axis) => axes.includes(axis))
  const workPart = wcs === null
    ? []
    : ordered.filter((axis) => workOf(axis) !== null).map((axis) => `${axis.toUpperCase()} ${fmt(workOf(axis)!)}`)
  const machinePart = ordered.filter((axis) => machineOf(axis) !== null)
    .map((axis) => `${axis.toUpperCase()} ${fmt(machineOf(axis)!)}`)
  if (workPart.length === 0) return machinePart.length === 0 ? '' : `machine ${machinePart.join(' ')}`
  const work = `${wcs} ${workPart.join(' ')}`
  if (position.withMachine === false || machinePart.length === 0) return work
  return `${work} (machine ${machinePart.join(' ')})`
}

/** The axes along which a sequence of points actually changes, in X-Y-Z order;
 *  every axis when none does (a row still has to say where the tool is). */
export function movedAxes(points: readonly PositionPoint[], toleranceMm = 1e-6): PositionAxisKey[] {
  const moved = AXES.filter((axis) => {
    const values = points.map((p) => p[axis]).filter(finite)
    return values.some((v) => Math.abs(v - values[0]) > toleranceMm)
  })
  return moved.length === 0 ? [...AXES] : moved
}
