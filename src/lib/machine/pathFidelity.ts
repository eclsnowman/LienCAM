// pathFidelity - did the machine actually fly the path it was given?
//
// WO-1008. On 2026-08-25 a program on Operator's machine silently lost a block of
// moves and cut a straight line across the gap, and EVERY instrument we had
// passed: the surviving arcs were perfectly round, the commanded feed read
// 0.98, the buffer never read as starving, `loadMoves` returned ok, `startJob`
// fired `started`, the job COMPLETED, and the machine ended exactly where the
// program said it should. That last one is the cruel part - a skip is a
// shortcut between two points that are both correct, so every endpoint check
// passes by construction.
//
// Only comparing the ACTUAL reported path against the COMMANDED path finds it,
// and that is all this module does. It REPORTS; it never acts, never gates a
// run and never blocks a stop (the rule WO-944 carries).
//
// ---------------------------------------------------------------------------
// WHY THIS COMPARES AGAINST THE MOVE LIST AND NOT AGAINST AN IDEAL SHAPE
// ---------------------------------------------------------------------------
// `pendant/path-fidelity.mjs` is the same check at the machine, and it is a
// good instrument, but it compares samples against an IDEALISED CIRCLE - a
// centre and a radius someone typed in. That shape has already cost this
// project two retractions: it read the 25 mm radial LEAD-IN of
// `circle-ladder.json` as a 25 mm chord across the circle and reported a
// correctly flown program as a dropped block, because it selected its band by
// radius alone and a lead-in has no radius the instrument recognises.
//
// The product has something the harness does not: THE ACTUAL MOVE LIST. So it
// asks a strictly better question - for each status frame, how far is
// `machinePos` from the geometry of the move the controller says it is
// executing? A lead-in is a commanded move with an id of its own; the machine
// flying it is the machine being CORRECT, and this comparison sees zero
// deviation rather than a 25 mm chord. THE ARTIFACT THAT COST TWO RETRACTIONS
// IS NOT SPELLABLE IN THIS DESIGN. That is the reason to prefer it.
//
// ---------------------------------------------------------------------------
// AND WHY THE ARC COMPARISON IS BOUNDED BY THE MOVE'S OWN START, END AND
// DIRECTION - NEVER BY THE CIRCLE IT LIES ON
// ---------------------------------------------------------------------------
// Measured, not argued -
// `src/tests/evidence/MOTION-2026-08-25/arc-direction-detectability.mjs`: a
// 90 degree quadrant commanded CCW and flown 270 degrees the WRONG way sits
// EXACTLY on the circle the whole time. Distance to the circle: max 0.0000 mm,
// completely blind. Distance to the DIRECTED ARC SPAN: max 73.9104 mm, 269 of
// 271 samples over threshold. And against real samples, `circle-c1.json` swept
// 2160 degrees in the wrong direction for a commanded 360 with a maximum radial
// error of 0.0017 mm - a circle-distance detector calls that a flawless path
// through six revolutions the wrong way, inheriting exactly the blindness that
// let the arc-direction defect reach the machine in the first place.
//
// The fix is not a second mechanism. A point whose angle falls outside the
// commanded sweep is not on the commanded arc AT ALL, so it measures to the
// nearer endpoint - and that is tens of millimetres. Same comparison, one
// concept, wrong-direction arcs fall out for free.
//
// ---------------------------------------------------------------------------
// WHAT IT SEES AND WHAT IT CANNOT
// ---------------------------------------------------------------------------
//   detects  SUSTAINED departure from the commanded path
//   detects  an arc flown the wrong way, or too far
//   misses   a SHORT gap - a 2.4 ms move against a ~33 ms status poll is over
//            before the next frame arrives, and the machine is back on the
//            path when it does
//
// The one confirmed drop in the whole record was catchable only because it
// lasted ~3.6 s across ~110 samples. That limit is not a footnote in a comment:
// `describePathFidelity` puts it in the report the operator reads, because a
// limit discovered later costs trust in the whole check and a limit stated up
// front costs nothing.

import { parseGcode, type GcodeLine, type GcodeSegment } from '../gcode/parse'
import type { MachineVec3, QueuedMove } from './controller'
import { formatPosition } from './positionFrames'
import { buildPreviewModel, type PreviewMove } from './previewGeometry'
import { PATH_ORDER_UNCHECKED_REASON } from './operatorMessages'
import type { MachineConsoleLine } from '../../store/machineControlStore'

export type PathFidelityVerdict = 'clean' | 'divergence' | 'unknown'

/**
 * How each sample was matched to a commanded move.
 *
 * - `executing-move`  the controller told us which move it was on, and the
 *                     comparison is bounded to that move's neighbourhood.
 * - `nearest-on-path` no frame carried a usable id, so each sample is measured
 *                     to the NEAREST point on the whole commanded path. That is
 *                     a LOWER BOUND on the real deviation and can therefore only
 *                     ever raise a fault, never clear one - see
 *                     `analysePathFidelity`.
 * - `none`            nothing was measured.
 */
export type PathFidelityAttribution = 'executing-move' | 'nearest-on-path' | 'none'

/** One status frame, reduced to what this check needs. */
export interface PathFidelitySample {
  /** Epoch ms the frame arrived. */
  atMs: number
  machinePos: MachineVec3 | null
  /** Work position from the SAME controller status frame. When the commanded
   * path is in work coordinates this is the controller's active frame; it must
   * never be reconstructed from LienCAM's stored G54..G59 table. */
  workPos?: MachineVec3 | null
  executingMoveId: number | null
  /** WO-2215: the XY rotation (degrees, CCW from +Z) of the work system that
   * `workPos` was read in, when the controller holds one. Absent = none: then
   * machine - work IS the work origin. Rotated, the controller reports
   * work = Rot(-R)(machine - O), so the origin is machine - Rot(R)(work). */
  workRotationDeg?: number
}

/** Rot(deg)(x, y) - the controller's own rotation (docs/design/WCS-ROTATION.md). */
function rotateXY(degrees: number, x: number, y: number): { x: number; y: number } {
  const a = (degrees * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: x * c - y * s, y: x * s + y * c }
}

function sampleRotationDeg(sample: PathFidelitySample): number {
  const degrees = sample.workRotationDeg
  return typeof degrees === 'number' && Number.isFinite(degrees) ? degrees : 0
}

/**
 * WO-2215: THE WORK ORIGIN THIS STATUS FRAME WAS READ AGAINST, in machine
 * coordinates - both positions from the one frame. Unrotated it is machine less
 * work, exactly as it always was; under a rotation R machine less work changes
 * with every position (a correct G53 park read as 234 mm "off" on 09-29), and
 * the origin is machine - Rot(R)(work).
 */
function sampleWorkOrigin(sample: PathFidelitySample): MachineVec3 | null {
  const machine = sample.machinePos
  const work = sample.workPos
  if (machine === null || work === null || work === undefined) return null
  const degrees = sampleRotationDeg(sample)
  if (degrees === 0) {
    return { x: machine.x - work.x, y: machine.y - work.y, z: machine.z - work.z }
  }
  const turned = rotateXY(degrees, work.x, work.y)
  return { x: machine.x - turned.x, y: machine.y - turned.y, z: machine.z - work.z }
}

/** A confirmed work-frame change during one program. `atMs` is a lower bound
 * captured before selection starts. When omitted, `shift` is derived from the
 * first controller-reported offset transition after that bound. */
export interface PathFidelityFrameChange {
  atMs: number
  firstMoveId: number
  fromFrame: string
  toFrame: string
  shift?: MachineVec3
}

type ResolvedPathFidelityFrameChange = Omit<PathFidelityFrameChange, 'shift'> & {
  shift: MachineVec3
}

export interface PathFidelityEvidenceSample {
  atMs: number
  machinePos: MachineVec3 | null
  workPos: MachineVec3 | null
  activeOffset: MachineVec3 | null
  reportedMoveId: number | null
  commandedMoveId: number | null
  commandedSegment: { from: MachineVec3; to: MachineVec3 } | null
  deviationMm: number | null
  measurementFault: string | null
}

export interface PathFidelityOptions {
  /**
   * The threshold is `toleranceMm * thresholdMarginX`. With
   * `Constantvelocitymode=True` the controller cuts corners DELIBERATELY, and
   * a segmented path measured on Operator's machine runs ~25 um inside the ideal
   * by design, not as a fault - so the threshold has to follow the configured
   * tolerance rather than a round number that would fire on every corner of
   * every program.
   */
  thresholdMarginX: number
  /**
   * HOW MANY POLL INTERVALS OF TRAVEL THE ID MAY BE OUT BY.
   *
   * `executingMoveId` and `machinePos` arrive in one status frame but they are
   * NOT simultaneous. Measured on `repeat-3142-run1.json`, a clean run: the
   * move actually nearest the reported position lags the reported id by a
   * median of 1, p90 7 and max 10 moves - up to ~2.5 mm of path at 3000 mm/min
   * with a 32 ms poll. Comparing rigidly to the id'd move ALONE reports up to
   * 2.4 mm of deviation on a run that is clean by every other measure, which is
   * the crying-wolf failure arriving through the implementation rather than the
   * design. So the comparison searches the moves within this many poll
   * intervals of commanded travel either side of the named move, and takes the
   * best. The id finds WHICH move to compare against; it never carries the
   * verdict.
   */
  attributionSlackPolls: number
  /**
   * A divergence must persist for this many consecutive frames. One frame over
   * threshold is a corner or a jitter; this detects SUSTAINED departure, and it
   * is also the floor on what the check can resolve in time.
   */
  minSustainedSamples: number
}

export const PATH_FIDELITY_DEFAULTS: PathFidelityOptions = {
  thresholdMarginX: 3,
  attributionSlackPolls: 3,
  minSustainedSamples: 3,
}

/** A stretch of consecutive frames spent off the commanded path. */
export interface PathFidelitySpan {
  startIndex: number
  endIndex: number
  sampleCount: number
  startedAtMs: number
  durationMs: number
  peakDeviationMm: number
  peakAtMs: number
  /** The move being compared against at the peak, when one was named. */
  peakMoveId: number | null
  /** WO-1667: where the tool was at the peak, through the one position
   *  formatter - "G54 X 1 Y 2 Z -110 (machine X 739 Y 726 Z 0)". */
  peakAt?: string
}

export interface PathFidelityReport {
  verdict: PathFidelityVerdict
  /** One line an operator can read without knowing any of this. */
  headline: string
  /** Why the verdict is what it is - an UNKNOWN especially. */
  reason: string | null
  attribution: PathFidelityAttribution
  /** The controller's configured path tolerance this ran against, mm. */
  toleranceMm: number | null
  /** `toleranceMm * thresholdMarginX`, mm. */
  thresholdMm: number | null
  /** Median status cadence measured from the frames themselves, ms. */
  pollMs: number | null
  /** How far either side of the named move the comparison looked, mm. */
  attributionSlackMm: number | null
  samples: {
    total: number
    /** Had a position AND an in-range executing move id. */
    attributed: number
    /** Had a position but no usable id - measured as a lower bound instead. */
    unattributed: number
    /** Of those: the id was outside the queued range (seen for real:
     *  1079590912 against 400 moves sent). */
    outOfRange: number
    /** Of those: the frame carried no id at all. */
    missingId: number
    /** No `machinePos`; nothing could be measured. */
    noPosition: number
    /** Controller position changed faster than the declared physical ceiling. */
    measurementFault: number
    /** Flown during a move whose path is not modelled (`G28`, `G53`, an arc
     *  with no I/J). Excluded from the verdict and reported - see
     *  `PathFidelityInput.unmodelledMoveIds`. */
    unmodelled: number
  }
  worst: {
    deviationMm: number
    atMs: number
    sampleIndex: number
    moveId: number | null
    /** WO-1667: where the tool was, through the one position formatter. */
    at?: string
  } | null
  spans: PathFidelitySpan[]
  /** What this check CANNOT see, in the operator's own words. Requirement 3. */
  limits: string[]
  /** Exact rows judged by the check. Kept optional because a backend may send
   * a summary report without the renderer-side samples. */
  evidence?: PathFidelityEvidenceSample[]
  /** WO-2681: set when frames went over the threshold but none lasted long
   *  enough to be a departure - the headline then says that short jump. */
  briefJump?: { frames: number; count: number }
}

export interface PathFidelityInput {
  /** The commanded program, in LienCAM's own terms. */
  moves: readonly QueuedMove[]
  /** Resolved machine position when the first move began. */
  startPos: MachineVec3
  samples: readonly PathFidelitySample[]
  /** `capabilities.executingMoveId` of the backend that produced the samples. */
  reportsExecutingMoveId: boolean
  /**
   * The controller's configured path tolerance, mm - UCCNC's `Linearerror`,
   * 0.03 on Operator's profile. NULL when nobody has read it back, and then the
   * verdict is UNKNOWN: a guessed constant near the machine's own designed
   * corner-cutting fires on every corner of every program.
   */
  toleranceMm: number | null
  /** Coordinate frame of `moves`. Geometry programs are work-coordinate
   * programs today. Defaults to machine for legacy direct analyser callers. */
  commandedFrame?: 'work' | 'machine'
  /** Confirmed work-frame changes that happened while this program ran. */
  frameChanges?: readonly PathFidelityFrameChange[]
  /** WO-1667: the work frame (G54..G59) the program started in, so a position
   *  in the report names the frame its work value is in. */
  workFrame?: string | null
  /** Fastest physically possible resultant travel. A faster position change is
   * a status measurement fault, not an instruction to inspect the part. */
  maxPhysicalTravelMmMin?: number | null
  /**
   * Move ids whose PATH is not modelled - see `commandedPathFromProgram`.
   *
   * A frame flown during one of these is counted and REPORTED, and carries no
   * verdict either way. Measuring it would compare the machine against a piece
   * of geometry we do not have, which manufactures a divergence over the `G28`
   * or `G53` at the end of every posted program; ignoring it silently would
   * let a real departure hide inside a block we chose not to look at. Neither
   * is acceptable, so it is excluded and said out loud.
   */
  unmodelledMoveIds?: readonly number[]
  /** WO-2437: where a move starts when the move before it in `moves` is not
   *  where it starts - the program re-placed the tool by its own words after
   *  blocks this check does not model (a G53 park). See `CommandedPath`. */
  restartsAt?: readonly MoveRestart[]
  options?: Partial<PathFidelityOptions>
}

/** WO-2687 fix round: the first commanded move after the program's own
 *  G54..G59 word carries that frame - see `commandedPathFromProgram`. */
export type ProgramFramedMove = QueuedMove & {
  programFrame?: string
  /** Fix round 2: axes of this move's end the program has not stated since its
   *  own G54..G59 - taken from where the move starts, once the analysis has
   *  carried that across the frame change it observes. */
  carried?: readonly ('x' | 'y' | 'z')[]
  /** Fix round 2: a G98 return on such an axis - back to where this source
   *  line's first move started. */
  toLineStart?: readonly ('x' | 'y' | 'z')[]
  /** Fix round 2: an arc whose start is such a position - its centre is this
   *  offset (I, J) from where it starts. */
  centreOffset?: MachineVec3
}

/** A modelled move whose start the program itself stated after unmodelled
 *  blocks moved the machine. */
export interface MoveRestart {
  moveId: number
  at: MachineVec3
}

/** Everything fixed before a run starts. Samples are streamed separately so
 * the renderer never has to clone or analyse the whole recording at Stop. */
export type PathFidelityStreamingInput = Omit<PathFidelityInput, 'samples' | 'frameChanges'>

export interface PathFidelityStreamingAnalysis {
  addSample(sample: PathFidelitySample): void
  finish(frameChanges?: readonly PathFidelityFrameChange[]): Promise<PathFidelityReport>
  dispose(): void
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A commanded move with its start point resolved and its length known. */
export interface MoveSpan {
  id: number
  kind: QueuedMove['kind']
  from: MachineVec3
  to: MachineVec3
  lengthMm: number
  /** Cumulative commanded path length at this move's START, mm. */
  atMm: number
  feedMmMin: number | null
  arc: {
    centre: MachineVec3
    clockwise: boolean
    plane: 'xy' | 'xz' | 'yz'
    radiusMm: number
    /** Radians, signed - negative is clockwise in the plane's (u, v) frame. */
    sweepRad: number
  } | null
  /** Axis-aligned box containing the whole move, for the nearest-point search. */
  box: { min: MachineVec3; max: MachineVec3 }
}

const AXES: Record<
  'xy' | 'xz' | 'yz',
  { u: 'x' | 'y' | 'z'; v: 'x' | 'y' | 'z'; w: 'x' | 'y' | 'z' }
> = {
  xy: { u: 'x', v: 'y', w: 'z' },
  xz: { u: 'x', v: 'z', w: 'y' },
  yz: { u: 'y', v: 'z', w: 'x' },
}

const dist3 = (a: MachineVec3, b: MachineVec3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/**
 * RESOLVE THE QUEUE INTO GEOMETRY.
 *
 * `to` is `Partial<MachineVec3>` on a line move: a move may constrain only X
 * and carry Y and Z from wherever the machine already was. Distance-to-segment
 * needs a START point, and that start point is the PREVIOUS move's RESOLVED
 * endpoint - so resolved position is threaded through the whole queue here.
 * Get this wrong and every partial move reports a large deviation, which is the
 * crying-wolf failure again, arriving through the implementation.
 *
 * `dwell` and `marker` produce no motion, so they resolve to a zero-length span
 * at the current position - the machine should be sitting exactly there, and
 * point-to-segment on a degenerate segment says precisely that.
 */
export function resolveMoveSpans(
  moves: readonly QueuedMove[],
  startPos: MachineVec3,
  frameChanges: readonly ResolvedPathFidelityFrameChange[] = [],
  restartsAt: readonly MoveRestart[] = [],
): MoveSpan[] {
  const spans: MoveSpan[] = []
  let pos: MachineVec3 = { ...startPos }
  const restartByMove = new Map(restartsAt.map((restart) => [restart.moveId, restart.at]))
  let frameShift: MachineVec3 = { x: 0, y: 0, z: 0 }
  let atMm = 0
  const changesByFirstMove = new Map(frameChanges.map((change) => [change.firstMoveId, change]))
  // WO-2687: one source line can command several moves (a canned drill
  // cycle's hole). A frame change or a restart belongs to the line's FIRST
  // move; applying it again at each later one would shift the path twice.
  const seenIds = new Set<number>()
  let lineStart: MachineVec3 = pos
  for (const move of moves) {
    const framed = move as ProgramFramedMove
    const firstOfId = !seenIds.has(move.id)
    seenIds.add(move.id)
    const frameChange = firstOfId ? changesByFirstMove.get(move.id) : undefined
    if (frameChange !== undefined) {
      pos = {
        x: pos.x + frameChange.shift.x,
        y: pos.y + frameChange.shift.y,
        z: pos.z + frameChange.shift.z,
      }
      frameShift = {
        x: frameShift.x + frameChange.shift.x,
        y: frameShift.y + frameChange.shift.y,
        z: frameShift.z + frameChange.shift.z,
      }
    }
    const restart = firstOfId ? restartByMove.get(move.id) : undefined
    if (restart !== undefined) pos = { ...restart }
    if (firstOfId) lineStart = pos
    const from = pos
    let to = from
    let arc: MoveSpan['arc'] = null
    let lengthMm = 0
    let feedMmMin: number | null = null

    if (move.kind === 'line') {
      to = {
        x: move.to.x ?? from.x,
        y: move.to.y ?? from.y,
        z: move.to.z ?? from.z,
      }
      for (const key of framed.toLineStart ?? []) to[key] = lineStart[key]
      lengthMm = dist3(from, to)
      feedMmMin = move.feedMmMin
    } else if (move.kind === 'arc') {
      to = { x: move.to.x, y: move.to.y, z: move.to.z }
      for (const key of framed.carried ?? []) to[key] = from[key]
      feedMmMin = move.feedMmMin
      const ax = AXES[move.plane]
      const offset = framed.centreOffset
      const c = offset === undefined
        ? move.centre
        : { x: from.x + offset.x, y: from.y + offset.y, z: from.z + offset.z }
      const radiusMm = Math.hypot(from[ax.u] - c[ax.u], from[ax.v] - c[ax.v])
      const a0 = Math.atan2(from[ax.v] - c[ax.v], from[ax.u] - c[ax.u])
      const a1 = Math.atan2(to[ax.v] - c[ax.v], to[ax.u] - c[ax.u])
      const sweepRad = normaliseSweep(a1 - a0, move.clockwise)
      arc = { centre: c, clockwise: move.clockwise, plane: move.plane, radiusMm, sweepRad }
      lengthMm = Math.hypot(Math.abs(sweepRad) * radiusMm, to[ax.w] - from[ax.w])
    }

    const rebasedFrom = {
      x: from.x - frameShift.x,
      y: from.y - frameShift.y,
      z: from.z - frameShift.z,
    }
    const rebasedTo = {
      x: to.x - frameShift.x,
      y: to.y - frameShift.y,
      z: to.z - frameShift.z,
    }
    const rebasedArc = arc === null ? null : {
      ...arc,
      centre: {
        x: arc.centre.x - frameShift.x,
        y: arc.centre.y - frameShift.y,
        z: arc.centre.z - frameShift.z,
      },
    }
    spans.push({
      id: move.id,
      kind: move.kind,
      from: rebasedFrom,
      to: rebasedTo,
      lengthMm,
      atMm,
      feedMmMin,
      arc: rebasedArc,
      box: boxOf(rebasedFrom, rebasedTo, rebasedArc),
    })
    atMm += lengthMm
    pos = to
  }
  return spans
}

/**
 * An arc's signed sweep. Counter-clockwise lands in (0, 2pi], clockwise in
 * [-2pi, 0); a move whose end equals its start is a FULL circle, which is how
 * G-code has always spelled one, not a zero-length arc.
 */
function normaliseSweep(raw: number, clockwise: boolean): number {
  const TWO_PI = Math.PI * 2
  let sweep = raw
  if (clockwise) {
    while (sweep > 0) sweep -= TWO_PI
    while (sweep <= -TWO_PI) sweep += TWO_PI
    if (Math.abs(sweep) < 1e-9) sweep = -TWO_PI
  } else {
    while (sweep < 0) sweep += TWO_PI
    while (sweep >= TWO_PI) sweep -= TWO_PI
    if (Math.abs(sweep) < 1e-9) sweep = TWO_PI
  }
  return sweep
}

function boxOf(
  from: MachineVec3,
  to: MachineVec3,
  arc: MoveSpan['arc'],
): { min: MachineVec3; max: MachineVec3 } {
  const min: MachineVec3 = {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    z: Math.min(from.z, to.z),
  }
  const max: MachineVec3 = {
    x: Math.max(from.x, to.x),
    y: Math.max(from.y, to.y),
    z: Math.max(from.z, to.z),
  }
  if (arc) {
    // Conservative: the whole circle, rather than solving for which quadrant
    // extremes the sweep actually crosses. This box only PRUNES a search, so
    // being too generous costs time and never correctness.
    const ax = AXES[arc.plane]
    min[ax.u] = Math.min(min[ax.u], arc.centre[ax.u] - arc.radiusMm)
    max[ax.u] = Math.max(max[ax.u], arc.centre[ax.u] + arc.radiusMm)
    min[ax.v] = Math.min(min[ax.v], arc.centre[ax.v] - arc.radiusMm)
    max[ax.v] = Math.max(max[ax.v], arc.centre[ax.v] + arc.radiusMm)
  }
  return { min, max }
}

/** Distance from a point to a straight segment, mm. */
function distanceToSegment(p: MachineVec3, a: MachineVec3, b: MachineVec3): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const lenSq = dx * dx + dy * dy + dz * dz
  if (lenSq === 0) return dist3(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy), p.z - (a.z + t * dz))
}

/**
 * DISTANCE FROM A POINT TO ONE COMMANDED MOVE - the single comparison this
 * whole module is built on.
 *
 * For an arc this is the distance to the DIRECTED ARC SEGMENT, bounded by that
 * move's own start point, end point and direction, and NEVER to the circle the
 * arc lies on. A point whose angle falls outside the commanded sweep is not on
 * the commanded arc at all, so it measures to the nearer ENDPOINT. That single
 * bound is what makes a wrong-direction arc visible: flown the long way round,
 * the tool sits perfectly on the circle (0.0000 mm) and tens of millimetres
 * from the span it was told to travel (73.9104 mm, measured).
 */
export function distanceToMoveSpan(p: MachineVec3, span: MoveSpan): number {
  if (!span.arc) return distanceToSegment(p, span.from, span.to)
  const { centre, radiusMm, sweepRad, plane } = span.arc
  const ax = AXES[plane]
  const du = p[ax.u] - centre[ax.u]
  const dv = p[ax.v] - centre[ax.v]
  const angle = Math.atan2(dv, du)
  const a0 = Math.atan2(span.from[ax.v] - centre[ax.v], span.from[ax.u] - centre[ax.u])
  const TWO_PI = Math.PI * 2

  let delta = angle - a0
  if (sweepRad > 0) {
    while (delta < 0) delta += TWO_PI
    while (delta > TWO_PI) delta -= TWO_PI
  } else {
    while (delta > 0) delta -= TWO_PI
    while (delta < -TWO_PI) delta += TWO_PI
  }

  const inSpan = sweepRad > 0 ? delta <= sweepRad : delta >= sweepRad
  if (!inSpan) {
    // OUTSIDE THE COMMANDED SWEEP. The tool is not on this move at all, so it
    // measures to whichever end of it is nearer. This is the branch a
    // wrong-direction arc lands in, and it is the whole of requirement 6.
    return Math.min(dist3(p, span.from), dist3(p, span.to))
  }
  const frac = sweepRad === 0 ? 0 : delta / sweepRad
  const idealW = span.from[ax.w] + (span.to[ax.w] - span.from[ax.w]) * frac
  const radial = Math.hypot(du, dv) - radiusMm
  return Math.hypot(radial, p[ax.w] - idealW)
}

/** Lower bound on how far a point is from a move's box - prunes the search. */
function distanceToBox(p: MachineVec3, box: MoveSpan['box']): number {
  const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x)
  const dy = Math.max(box.min.y - p.y, 0, p.y - box.max.y)
  const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z)
  return Math.hypot(dx, dy, dz)
}

/**
 * The nearest point on the WHOLE commanded path, across every move.
 *
 * This is a LOWER BOUND on the deviation from whichever move the machine was
 * really executing - the executing move is one of the moves searched, so its
 * distance can only be larger. That asymmetry is the whole reason this exists:
 * it can prove the machine was off the path, and it can never prove it was on
 * the RIGHT PART of it. `analysePathFidelity` refuses to return `clean` from
 * this mode for exactly that reason.
 */
export function nearestOnPath(
  p: MachineVec3,
  spans: readonly MoveSpan[],
): { deviationMm: number; moveId: number | null; spanIndex: number | null } {
  let best = Infinity
  let bestIndex: number | null = null
  spans.forEach((span, index) => {
    if (distanceToBox(p, span.box) >= best) return
    const d = distanceToMoveSpan(p, span)
    if (d < best) {
      best = d
      bestIndex = index
    }
  })
  return { deviationMm: best, moveId: bestIndex === null ? null : spans[bestIndex].id, spanIndex: bestIndex }
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const emptyCounts = (): PathFidelityReport['samples'] => ({
  total: 0,
  attributed: 0,
  unattributed: 0,
  outOfRange: 0,
  missingId: 0,
  noPosition: 0,
  measurementFault: 0,
  unmodelled: 0,
})

function cannotAssess(
  reason: string,
  attribution: PathFidelityAttribution,
  samples: PathFidelityReport['samples'] = emptyCounts(),
): PathFidelityReport {
  return {
    verdict: 'unknown',
    headline: 'Path check: CANNOT ASSESS - ' + reason,
    reason,
    attribution,
    toleranceMm: null,
    thresholdMm: null,
    pollMs: null,
    attributionSlackMm: null,
    samples,
    worst: null,
    spans: [],
    limits: [],
  }
}

/**
 * A CANNOT-ASSESS REPORT FOR SOMETHING THAT WENT WRONG BEFORE ANY MEASURING
 * COULD START - no program reached the machine, no route to send it one.
 *
 * It exists so that "this run was not checked" travels on the SAME channel as
 * every other verdict instead of being expressed by silence. Silence and a
 * clean run look identical to an operator, and telling those two apart is the
 * entire reason this module exists.
 */
export function pathFidelityCannotAssess(reason: string): PathFidelityReport {
  return cannotAssess(reason, 'none')
}

function evidenceRow(
  sample: PathFidelitySample,
  matched: MoveSpan | null,
  deviationMm: number | null,
  measurementFault: string | null,
): PathFidelityEvidenceSample {
  const workPos = sample.workPos ?? null
  const activeOffset = sampleWorkOrigin(sample)
  return {
    atMs: sample.atMs,
    machinePos: sample.machinePos,
    workPos,
    activeOffset,
    reportedMoveId: sample.executingMoveId,
    commandedMoveId: matched?.id ?? null,
    commandedSegment: matched === null ? null : { from: matched.from, to: matched.to },
    deviationMm,
    measurementFault,
  }
}

/**
 * Compare the path the machine reported flying against the path it was given.
 *
 * THREE ANSWERS, AND THE THIRD IS NOT THE FIRST. `clean`, `divergence` and
 * `unknown` are distinct on purpose: "I could not tell" and "the machine is
 * fine" are different facts, and conflating them is the entire defect class
 * this order came out of - the same rule as `asserted: null`, the dashed
 * readout and `negate: null`. Anything that stops this from measuring - no
 * `executingMoveId` capability, no configured tolerance, no commanded move
 * list, ids outside the queued range - produces UNKNOWN. Never `clean`.
 */
export function analysePathFidelity(input: PathFidelityInput): PathFidelityReport {
  const opts: PathFidelityOptions = { ...PATH_FIDELITY_DEFAULTS, ...input.options }

  if (!input.reportsExecutingMoveId) {
    // GRBL: `grbl/controller.ts` sets this capability false and returns null
    // always. There is nothing here to work with, and the honest answer is the
    // one `pendant/path-fidelity.mjs` gives - `ok = null`, not false.
    return cannotAssess(
      'this controller does not report which move it is executing, so the reported '
        + 'position cannot be matched to a commanded move.',
      'none',
    )
  }
  if (
    input.toleranceMm === null
    || !Number.isFinite(input.toleranceMm)
    || input.toleranceMm <= 0
  ) {
    return cannotAssess(
      "the controller's configured path tolerance has not been read back, and a guessed "
        + 'threshold would fire on corner-cutting the machine does by design.',
      'none',
    )
  }
  if (input.moves.length === 0) {
    return cannotAssess('no commanded move list was recorded for this job.', 'none')
  }

  const commandedFrame = input.commandedFrame ?? 'machine'
  const frameChanges: ResolvedPathFidelityFrameChange[] = []
  const activeOffset = sampleWorkOrigin
  // WO-2215: an origin shift between two work systems is a shift of the WORK
  // numbers only when both are turned alike: work = Rot(-R)(machine - O), so
  // moving O by d moves work by Rot(-R)(d). Frames turned differently are not a
  // shift at all, and the check says it cannot tell rather than guess.
  const frameRotations = new Set(input.samples
    .filter((sample) => sample.workPos != null)
    .map(sampleRotationDeg))
  const frameRotation = frameRotations.size === 1 ? [...frameRotations][0] : 0
  if (commandedFrame === 'work' && (input.frameChanges ?? []).length > 0 && frameRotations.size > 1) {
    return cannotAssess(
      'the program changed between work systems turned by different rotations, and their work '
        + 'positions differ by a turn as well as a shift.',
      'none',
    )
  }
  const unturn = (d: MachineVec3): MachineVec3 => {
    if (frameRotation === 0) return d
    const turned = rotateXY(-frameRotation, d.x, d.y)
    return { x: turned.x, y: turned.y, z: d.z }
  }
  // An id names its FIRST move: several moves may share one (WO-2687).
  const moveIndexById = new Map<number, number>()
  input.moves.forEach((move, index) => { if (!moveIndexById.has(move.id)) moveIndexById.set(move.id, index) })
  if (commandedFrame === 'work') {
    for (const change of [...(input.frameChanges ?? [])].sort((a, b) => a.atMs - b.atMs)) {
      let shift = change.shift
      let observedAtMs = change.atMs
      if (shift === undefined) {
        const before = [...input.samples].reverse().find((sample) =>
          sample.atMs < change.atMs && activeOffset(sample) !== null)
        const oldOffset = before === undefined ? null : activeOffset(before)
        const firstMoveIndex = moveIndexById.get(change.firstMoveId)
        const after = oldOffset === null ? undefined : input.samples.find((sample) => {
          if (sample.atMs < change.atMs) return false
          const offset = activeOffset(sample)
          if (offset === null) return false
          // A status already in the new frame may precede the receipt, while a
          // still-old status may follow the request. Observe the offset itself
          // rather than assuming either side of the async receipt names it.
          if (dist3(offset, oldOffset) > 1e-6) return true
          const sampleMoveIndex = sample.executingMoveId === null
            ? undefined
            : moveIndexById.get(sample.executingMoveId)
          // Equal-valued WCS rows have a real zero shift. The first incoming
          // move proves selection completed even though no offset jump exists.
          return firstMoveIndex !== undefined
            && sampleMoveIndex !== undefined
            && sampleMoveIndex >= firstMoveIndex
        })
        const newOffset = after === undefined ? null : activeOffset(after)
        if (oldOffset !== null && newOffset !== null && after !== undefined) {
          shift = unturn({
            x: oldOffset.x - newOffset.x,
            y: oldOffset.y - newOffset.y,
            z: oldOffset.z - newOffset.z,
          })
          observedAtMs = after.atMs
        }
      }
      if (shift === undefined) {
        return cannotAssess(
          `the ${change.fromFrame} to ${change.toFrame} frame change was confirmed, but status `
            + 'frames on both sides did not carry positions, so its coordinate shift is unknown.',
          'none',
        )
      }
      frameChanges.push({ ...change, atMs: observedAtMs, shift })
    }
  }
  const baseOffset = input.samples.map(activeOffset).find((offset) => offset !== null) ?? null
  // WO-2687 fix round: the program's OWN G54..G59 is a frame change too. The
  // derivation's start is in the frame selected at Cycle Start; from the line
  // that selects another, the controller reports work positions in that one
  // (machine seat 10-08: Setup 2's G56 under a selected G54 read 58.47 mm "off"
  // at the home position for the first 5.9 s). The shift is the one the
  // controller's own frames show across the switch, observed exactly as for a
  // confirmed change above; no stored offset value enters it.
  const programFrameChanges: ResolvedPathFidelityFrameChange[] = []
  if (commandedFrame === 'work' && baseOffset !== null) {
    const confirmed = new Set(frameChanges.map((change) => change.firstMoveId))
    let oldOffset = baseOffset
    let fromFrame = input.workFrame ?? 'the selected frame'
    let lowerMs = -Infinity
    for (const [index, move] of input.moves.entries()) {
      const toFrame = (move as ProgramFramedMove).programFrame
      if (toFrame === undefined || moveIndexById.get(move.id) !== index || confirmed.has(move.id)) continue
      // Fix round 2: naming the frame already in effect changes nothing.
      if (toFrame === fromFrame) continue
      const after = input.samples.find((sample) => {
        if (sample.atMs < lowerMs) return false
        const offset = activeOffset(sample)
        if (offset === null) return false
        if (dist3(offset, oldOffset) > 1e-6) return true
        const sampleMoveIndex = sample.executingMoveId === null
          ? undefined
          : moveIndexById.get(sample.executingMoveId)
        return sampleMoveIndex !== undefined && sampleMoveIndex >= index
      })
      // No frame reached that line: nothing flown there is left to place.
      if (after === undefined) break
      const newOffset = activeOffset(after)!
      programFrameChanges.push({
        atMs: after.atMs,
        firstMoveId: move.id,
        fromFrame,
        toFrame,
        shift: unturn({
          x: oldOffset.x - newOffset.x,
          y: oldOffset.y - newOffset.y,
          z: oldOffset.z - newOffset.z,
        }),
      })
      oldOffset = newOffset
      fromFrame = toFrame
      lowerMs = after.atMs
    }
    if (programFrameChanges.length > 0 && frameRotations.size > 1) {
      return cannotAssess(
        'the program changed between work systems turned by different rotations, and their work '
          + 'positions differ by a turn as well as a shift.',
        'none',
      )
    }
    frameChanges.push(...programFrameChanges)
  }
  const positionInCommandedFrame = (sample: PathFidelitySample): MachineVec3 | null => {
    if (commandedFrame === 'machine') return sample.machinePos
    if (sample.workPos === null || sample.workPos === undefined) return null
    // Use the work position from this very status frame. A stale stored
    // G54/G55 value has no route into the check.
    const workPosition = sample.workPos
    const sampleOffset = activeOffset(sample)
    if (frameChanges.length > 0 && baseOffset !== null && sampleOffset !== null) {
      // Normalize from the offset carried by THIS status frame. This remains
      // correct if a new-frame status precedes the receipt or an old in-flight
      // frame arrives after it; timestamp ordering is not used for the sample.
      if (frameRotation !== 0) {
        const d = unturn({
          x: sampleOffset.x - baseOffset.x,
          y: sampleOffset.y - baseOffset.y,
          z: sampleOffset.z - baseOffset.z,
        })
        return { x: workPosition.x + d.x, y: workPosition.y + d.y, z: workPosition.z + d.z }
      }
      return {
        x: workPosition.x + sampleOffset.x - baseOffset.x,
        y: workPosition.y + sampleOffset.y - baseOffset.y,
        z: workPosition.z + sampleOffset.z - baseOffset.z,
      }
    }
    const shift = frameChanges.reduce((sum, change) => change.atMs <= sample.atMs
      ? {
          x: sum.x + change.shift.x,
          y: sum.y + change.shift.y,
          z: sum.z + change.shift.z,
        }
      : sum, { x: 0, y: 0, z: 0 })
    return {
      x: workPosition.x - shift.x,
      y: workPosition.y - shift.y,
      z: workPosition.z - shift.z,
    }
  }
  const positioned = input.samples
    .map((sample) => ({ sample, position: positionInCommandedFrame(sample) }))
    .filter((row): row is { sample: PathFidelitySample; position: MachineVec3 } => row.position !== null)
  const noPosition = input.samples.length - positioned.length

  // FRAMES FLOWN DURING A MOVE WHOSE PATH IS NOT MODELLED CARRY NO VERDICT.
  // The block they belong to has no geometry here to compare against (a `G28`
  // to the reference point, a `G53` rapid in machine coordinates, an R-form
  // arc), so measuring them would score the machine against a path we never
  // derived - a manufactured divergence over the end of every posted program.
  // They are dropped from the comparison and counted, so the operator is told
  // how much of the run went unmeasured rather than being left to assume it
  // was covered.
  const unmodelledIds = new Set(input.unmodelledMoveIds ?? [])
  const usable =
    unmodelledIds.size === 0
      ? positioned
      : positioned.filter(({ sample }) =>
        sample.executingMoveId === null || !unmodelledIds.has(sample.executingMoveId))
  const unmodelled = positioned.length - usable.length

  if (usable.length < 2) {
    return cannotAssess('fewer than two status frames carried a machine position.', 'none', {
      ...emptyCounts(),
      total: input.samples.length,
      noPosition,
      unmodelled,
    })
  }

  // WO-1667: a position in the report names its frame - the work value in the
  // frame the program was in at that sample, the machine value beside it.
  const orderedFrameChanges = [...(input.frameChanges ?? []), ...programFrameChanges]
    .sort((a, b) => a.atMs - b.atMs)
  const positionAt = (sample: PathFidelitySample): string => {
    const change = orderedFrameChanges.findLast((entry) => entry.atMs <= sample.atMs)
    return formatPosition({
      wcs: change?.toFrame ?? input.workFrame ?? null,
      work: sample.workPos ?? null,
      machine: sample.machinePos,
    })
  }

  const spans = resolveMoveSpans(input.moves, input.startPos, frameChanges, input.restartsAt)
  const byId = new Map<number, MoveSpan>()
  for (const span of spans) byId.set(span.id, span)

  const thresholdMm = input.toleranceMm * opts.thresholdMarginX
  const gaps: number[] = []
  for (let i = 1; i < usable.length; i++) gaps.push(usable[i].sample.atMs - usable[i - 1].sample.atMs)
  const pollMs = median(gaps)

  // A plain loop, not `Math.max(...feeds)`: spreading one stack argument per
  // move overflows the call stack on a long program (WO-1629, Operator's
  // ~110,000-move file reported "Maximum call stack size exceeded").
  let maxFeedMmMin: number | null = null
  for (const span of spans) {
    if (span.feedMmMin !== null && span.feedMmMin > 0) {
      if (maxFeedMmMin === null || span.feedMmMin > maxFeedMmMin) maxFeedMmMin = span.feedMmMin
    }
  }

  const idBearing = usable.filter(
    ({ sample }) => sample.executingMoveId !== null && byId.has(sample.executingMoveId),
  ).length

  // WHY A RUN WITH NO USABLE IDS IS STILL WORTH MEASURING.
  // `capabilities.executingMoveId` says the backend CAN report the field; an
  // individual frame may still arrive without it, and a recorded capture may
  // predate the recorder saving it at all - `circle-stress.json`, the only
  // confirmed dropped block in the whole record, has 321 frames and not one of
  // them carries the field. Falling back to the nearest point on the whole path
  // measures a LOWER BOUND on the deviation, so it can raise a fault it can
  // prove and can never clear one it cannot. The verdict rules below enforce
  // exactly that: this mode returns `divergence` or `unknown`, never `clean`.
  const attribution: PathFidelityAttribution =
    idBearing > 0 && maxFeedMmMin !== null ? 'executing-move' : 'nearest-on-path'
  // THE LOWER BOUND ONLY WORKS OVER A COMPLETE PATH. Without ids there is no
  // way to tell which frames were flown during a move we could not model, so
  // "nothing was far from the path" would be measured against a path with
  // holes in it. That is the one combination this check must not score.
  if (attribution === 'nearest-on-path' && unmodelledIds.size > 0) {
    return cannotAssess(
      'no status frame said which move was executing, and '
        + unmodelledIds.size
        + ' block(s) of this program command motion this check does not model, so the '
        + 'commanded path it would have measured against is incomplete.',
      'nearest-on-path',
      { ...emptyCounts(), total: input.samples.length, noPosition, unmodelled },
    )
  }

  const attributionSlackMm =
    attribution === 'executing-move' && maxFeedMmMin !== null
      ? (maxFeedMmMin / 60) * (pollMs / 1000) * opts.attributionSlackPolls
      : null

  let attributed = 0
  let outOfRange = 0
  let missingId = 0
  let measurementFaults = 0
  let measurementFaultRun = 0
  let maxMeasurementFaultRun = 0
  const evidence: PathFidelityEvidenceSample[] = []
  const deviations: {
    mm: number
    moveId: number | null
    carriesVerdict: boolean
  }[] = []
  // WO-2687: a source line may command several moves (a canned drill cycle's
  // hole: rapid over, rapid to R, pecks, retract). An id therefore names a RUN
  // of spans, first to last; keying it to one span left a frame on the line's
  // first move judged against its last.
  const spanIndexById = new Map<number, number>()
  const lastSpanIndexById = new Map<number, number>()
  spans.forEach((span, index) => {
    if (!spanIndexById.has(span.id)) spanIndexById.set(span.id, index)
    lastSpanIndexById.set(span.id, index)
  })
  // Repeated stationary blocks share one point. Keep the first candidate in
  // search order: later copies have box distance equal to their exact distance
  // and the existing >= best pruning cannot select them. No sample is omitted.
  const stationaryStart = spans.map((_, index) => index)
  const stationaryEnd = spans.map((_, index) => index)
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1]
    const b = spans[i]
    if (a.arc === null && b.arc === null && a.lengthMm === 0 && b.lengthMm === 0
      && a.atMm === b.atMm && a.from.x === b.from.x
      && a.from.y === b.from.y && a.from.z === b.from.z) {
      stationaryStart[i] = stationaryStart[i - 1]
    }
  }
  for (let i = spans.length - 2; i >= 0; i--) {
    if (stationaryStart[i + 1] === stationaryStart[i]) stationaryEnd[i] = stationaryEnd[i + 1]
  }
  let previousMatchedIndex: number | null = null
  let previousTrusted: { atMs: number; position: MachineVec3 } | null = null
  const enteredFrameChanges = new Set<number>()

  for (const row of usable) {
    const sample = row.sample
    const p = row.position
    for (let i = 0; i < frameChanges.length; i++) {
      const firstIndex = spanIndexById.get(frameChanges[i].firstMoveId)
      const reportedIndex = sample.executingMoveId === null
        ? undefined
        : spanIndexById.get(sample.executingMoveId)
      if (firstIndex !== undefined && reportedIndex !== undefined && reportedIndex >= firstIndex) {
        enteredFrameChanges.add(i)
      }
    }
    const inRange = sample.executingMoveId !== null && byId.has(sample.executingMoveId)
    if (sample.executingMoveId === null) missingId++
    else if (!inRange) outOfRange++

    const dtMs = previousTrusted === null ? 0 : sample.atMs - previousTrusted.atMs
    const actualTravelMm = previousTrusted === null
      ? 0
      : Math.hypot(
        p.x - previousTrusted.position.x,
        p.y - previousTrusted.position.y,
        p.z - previousTrusted.position.z,
      )
    // `atMs` is renderer arrival time, not a controller clock. Buffered status
    // frames can therefore arrive a few milliseconds apart even though their
    // positions were sampled on separate polls. Never let that socket jitter
    // manufacture machine speed: one reported position step owns at least one
    // measured controller poll for this physical-plausibility check.
    const physicalIntervalMs = Math.max(dtMs, pollMs)
    const reportedSpeed = physicalIntervalMs > 0
      ? actualTravelMm * 60_000 / physicalIntervalMs
      : 0
    const physicalLimit = input.maxPhysicalTravelMmMin
    if (
      physicalLimit !== null
      && physicalLimit !== undefined
      && Number.isFinite(physicalLimit)
      && physicalLimit > 0
      // Status timestamps and axis updates are not simultaneous; measured
      // clean rapid frames can appear about 16% above the vector ceiling over
      // one poll. Keep a 25% acquisition margin. WO-1313's false 51.62 mm in
      // 0.1 s is still far beyond it.
      && reportedSpeed > physicalLimit * 1.25
    ) {
      measurementFaults++
      measurementFaultRun++
      maxMeasurementFaultRun = Math.max(maxMeasurementFaultRun, measurementFaultRun)
      deviations.push({ mm: 0, moveId: null, carriesVerdict: false })
      evidence.push(evidenceRow(sample, null, null,
        'reported position changed at ' + reportedSpeed.toFixed(0) + ' mm/min, beyond the '
        + physicalLimit.toFixed(0) + ' mm/min physical ceiling'))
      continue
    }
    measurementFaultRun = 0

    // The controller's id is a hint, never an index assertion. Once one frame
    // is located, the next frame can only reach nearby path segments: the
    // window grows from actual reported travel plus the existing poll slack,
    // and whole move lengths remain eligible at their boundary. This survives
    // counters that skip, continue across programs, or briefly overrun the
    // queued id range without widening the deviation tolerance itself.
    const candidates = new Set<number>()
    if (attribution === 'nearest-on-path' || previousMatchedIndex === null) {
      for (let i = 0; i < spans.length; i = stationaryEnd[i] + 1) candidates.add(i)
    } else {
      const previous = spans[previousMatchedIndex]
      const budget = actualTravelMm * opts.attributionSlackPolls + (attributionSlackMm ?? 0)
      for (let i = previousMatchedIndex; i >= 0; i = stationaryStart[i] - 1) {
        if (previous.atMm - (spans[i].atMm + spans[i].lengthMm) > budget) break
        candidates.add(i)
      }
      for (let i = previousMatchedIndex; i < spans.length; i = stationaryEnd[i] + 1) {
        if (spans[i].atMm - (previous.atMm + previous.lengthMm) > budget) break
        candidates.add(i)
      }
    }
    // A plausible reported id is also a recovery hint after a real departure.
    // Add its travel-sized neighbourhood, then still choose by position. A
    // drifting id cannot force a match; a recovered id can stop continuity
    // from remaining latched to the pre-departure segment.
    const hinted = sample.executingMoveId === null
      ? null
      : (spanIndexById.get(sample.executingMoveId) ?? null)
    const hintedLast = sample.executingMoveId === null
      ? null
      : (lastSpanIndexById.get(sample.executingMoveId) ?? null)
    if (hinted !== null && hintedLast !== null) {
      const namedLast = spans[hintedLast]
      const named = {
        atMm: spans[hinted].atMm,
        lengthMm: namedLast.atMm + namedLast.lengthMm - spans[hinted].atMm,
      }
      const slack = attributionSlackMm ?? 0
      // Cumulative span starts and ends are nondecreasing, including dwells.
      // Locate the same inclusive window without scanning the entire program
      // for every frame. Preserve ascending order and the boundary candidates.
      let lo = 0
      let hi = spans.length
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        if (spans[mid].atMm + spans[mid].lengthMm < named.atMm - slack) lo = mid + 1
        else hi = mid
      }
      for (let i = lo; i < spans.length; i = stationaryEnd[i] + 1) {
        if (spans[i].atMm > named.atMm + named.lengthMm + slack) break
        candidates.add(i)
      }
    }
    // Between a confirmed frame selection and the first incoming-stage move,
    // the controller is parked at the outgoing endpoint. Do not let the future
    // approach explain away a real hand displacement during that hold.
    const pendingFrameIndex = frameChanges.findLastIndex((change, index) =>
      change.atMs <= sample.atMs && !enteredFrameChanges.has(index))
    if (pendingFrameIndex >= 0) {
      const firstIndex = spanIndexById.get(frameChanges[pendingFrameIndex].firstMoveId)
      if (firstIndex !== undefined && firstIndex > 0) {
        candidates.clear()
        candidates.add(firstIndex - 1)
      }
    }
    let best = Infinity
    let bestIndex: number | null = null
    // Distance in spans from the run the id names; zero anywhere inside it.
    const fromHint = (index: number): number => hinted === null || hintedLast === null
      ? 0
      : index < hinted ? hinted - index : index > hintedLast ? index - hintedLast : 0
    for (const index of candidates) {
      const span = spans[index]
      if (distanceToBox(p, span.box) >= best) continue
      const d = distanceToMoveSpan(p, span)
      if (
        d < best
        || (d === best && hinted !== null && bestIndex !== null
          && fromHint(index) < fromHint(bestIndex))
      ) {
        best = d
        bestIndex = index
      }
    }
    if (bestIndex === null) {
      const near = nearestOnPath(p, spans)
      best = near.deviationMm
      bestIndex = near.spanIndex
    }
    const matched = bestIndex === null ? null : spans[bestIndex]
    if (bestIndex !== null) previousMatchedIndex = bestIndex
    previousTrusted = { atMs: sample.atMs, position: p }
    attributed++
    deviations.push({ mm: best, moveId: matched?.id ?? null, carriesVerdict: true })
    evidence.push(evidenceRow(sample, matched, best, null))
  }

  const unattributed = usable.length - attributed

  // SUSTAINED departure only. One frame over threshold is a corner or a jitter.
  const found: PathFidelitySpan[] = []
  let runStart = -1
  const closeRun = (endExclusive: number): void => {
    if (runStart < 0) return
    const count = endExclusive - runStart
    if (count >= opts.minSustainedSamples) {
      let peak = -Infinity
      let peakIndex = runStart
      for (let i = runStart; i < endExclusive; i++) {
        if (deviations[i].mm > peak) {
          peak = deviations[i].mm
          peakIndex = i
        }
      }
      found.push({
        startIndex: runStart,
        endIndex: endExclusive - 1,
        sampleCount: count,
        startedAtMs: usable[runStart].sample.atMs,
        durationMs: usable[endExclusive - 1].sample.atMs - usable[runStart].sample.atMs,
        peakDeviationMm: peak,
        peakAtMs: usable[peakIndex].sample.atMs,
        peakMoveId: deviations[peakIndex].moveId,
        peakAt: positionAt(usable[peakIndex].sample),
      })
    }
    runStart = -1
  }
  for (let i = 0; i < deviations.length; i++) {
    // A FRAME THAT NAMED A MOVE OUTSIDE THE QUEUED RANGE CANNOT OPEN OR EXTEND A
    // DIVERGENCE. Requirement 4: out of range is UNKNOWN, neither a fault nor a
    // pass, so it closes any open run rather than lengthening it. Without this,
    // the corrupt 1079590912 the machine has actually been seen reporting turns
    // untrustworthy attribution into a machine fault - the crying-wolf outcome
    // this order exists to not produce.
    if (!deviations[i].carriesVerdict) {
      closeRun(i)
      continue
    }
    if (deviations[i].mm > thresholdMm) {
      if (runStart < 0) runStart = i
    } else {
      closeRun(i)
    }
  }
  closeRun(deviations.length)

  let worst: PathFidelityReport['worst'] = null
  for (let i = 0; i < deviations.length; i++) {
    if (deviations[i].carriesVerdict && (worst === null || deviations[i].mm > worst.deviationMm)) {
      worst = {
        deviationMm: deviations[i].mm,
        atMs: usable[i].sample.atMs,
        sampleIndex: i,
        moveId: deviations[i].moveId,
        at: positionAt(usable[i].sample),
      }
    }
  }

  // The worst distance measured on frames that may carry a verdict at all.
  let worstCarryingMm: number | null = null
  for (const d of deviations) {
    if (d.carriesVerdict) {
      if (worstCarryingMm === null || d.mm > worstCarryingMm) worstCarryingMm = d.mm
    }
  }

  const counts: PathFidelityReport['samples'] = {
    total: input.samples.length,
    attributed,
    unattributed,
    outOfRange,
    missingId,
    noPosition,
    measurementFault: measurementFaults,
    unmodelled,
  }
  const base = {
    attribution,
    toleranceMm: input.toleranceMm,
    thresholdMm,
    pollMs,
    attributionSlackMm,
    samples: counts,
    worst,
    evidence,
    limits: buildLimits(opts, pollMs, attributionSlackMm, maxFeedMmMin, attribution, {
      frames: unmodelled,
      blocks: unmodelledIds.size,
    }, outOfRange, measurementFaults),
  }

  // NOT ONE FRAME COULD BE TRUSTED TO SPEAK. This is the physically impossible
  // telemetry case, not an accusation against the machine or the part.
  if (worstCarryingMm === null) {
    return {
      ...base,
      verdict: 'unknown',
      spans: [],
      reason:
        'every positioned status frame changed faster than this machine can physically '
        + 'travel. That is a path-check measurement fault, not evidence that the machine '
        + 'left the commanded path.',
      headline:
        'Path check: CANNOT ASSESS - the reported positions are physically impossible for '
        + 'this machine, so the path measurement is faulty. Do not use this check to judge the part.',
    }
  }

  if (maxMeasurementFaultRun >= opts.minSustainedSamples && found.length === 0) {
    return {
      ...base,
      verdict: 'unknown',
      spans: [],
      reason:
        measurementFaults + ' status frame(s) implied motion beyond the machine physical '
        + 'ceiling. Those frames are a fault in the path measurement, not evidence about '
        + 'the part; the remaining ' + attributed + ' frames were assessed.',
      headline:
        'Path check: CANNOT ASSESS the whole run - reported positions changed faster than '
        + 'this machine can travel, so the path measurement is faulty. Do not use this check '
        + 'to judge the part.',
    }
  }

  // A SUSTAINED DEPARTURE, MEASURED ONLY ON FRAMES THAT NAMED A QUEUED MOVE.
  // `outOfRange > 0` has already returned UNKNOWN above, so this verdict is
  // reachable only when EVERY frame's attribution was trustworthy - which is
  // what makes it a statement about the machine rather than about our
  // bookkeeping. (Attempt 3 reported `divergence` here with a parenthetical
  // naming the out-of-range count; that ordering is what the audit struck.)
  if (found.length > 0) {
    const worstSpan = found.reduce((a, b) => (b.peakDeviationMm > a.peakDeviationMm ? b : a))
    return {
      ...base,
      verdict: 'divergence',
      reason: null,
      spans: found,
      headline:
        'Path check: THE MACHINE LEFT THE COMMANDED PATH - up to '
        + worstSpan.peakDeviationMm.toFixed(2)
        + ' mm off'
        + (worstSpan.peakAt ? ' at ' + worstSpan.peakAt : '')
        + ' for '
        + (worstSpan.durationMs / 1000).toFixed(1)
        + ' s ('
        + worstSpan.sampleCount
        + ' status frames), against a '
        + thresholdMm.toFixed(3)
        + ' mm threshold. Check the part before running this program again.',
    }
  }

  if (attribution === 'nearest-on-path') {
    return {
      ...base,
      verdict: 'unknown',
      spans: [],
      // No out-of-range count is named here: `outOfRange > 0` returned UNKNOWN
      // above, so reaching this line means every id that WAS reported named a
      // queued move and the attribution fell back for a different reason.
      reason: PATH_ORDER_UNCHECKED_REASON,
      headline:
        'Path check: CANNOT CONFIRM - nothing was more than '
        + worstCarryingMm.toFixed(3)
        + ' mm from the commanded path, but no status frame named the move being '
        + 'executed, so the order it was flown in is unchecked.',
    }
  }

  if (attributed < opts.minSustainedSamples || unattributed > attributed) {
    return {
      ...base,
      verdict: 'unknown',
      spans: [],
      reason:
        'only ' + attributed + ' of ' + usable.length + ' status frames could be matched to '
        + 'a commanded move (' + outOfRange + ' carried an id outside the queued range, '
        + missingId + ' carried none), which is too few to call the run clean.',
      headline:
        'Path check: CANNOT ASSESS - too few status frames could be matched to a '
        + 'commanded move.',
    }
  }
  // A frame over the threshold that never became a departure is still a
  // fact, and the clean line may not quote it as "worst" beside "stayed on the
  // commanded path" (WO-2681). The verdict stays clean - the sustained rule
  // above is the rule - but the line says the jump: how far, where, how long.
  // The out-of-range id count is our bookkeeping, not the operator's; it stays
  // in `samples.outOfRange` and `limits`, off the console line.
  const faultsClause = measurementFaults > 0
    ? '; ' + measurementFaults + ' physically impossible position frame(s) were excluded as measurement faults'
    : ''
  if (worst !== null && worst.deviationMm > thresholdMm) {
    const jump = briefJumps(deviations, thresholdMm, worst.sampleIndex)
    return {
      ...base,
      verdict: 'clean',
      spans: [],
      reason: null,
      briefJump: jump,
      headline:
        BRIEF_JUMP_HEADLINE
        + worst.deviationMm.toFixed(3)
        + ' mm'
        + (worst.at ? ' at ' + worst.at : '')
        + ' for '
        + (jump.frames === 1 ? 'one status frame' : jump.frames + ' status frames')
        + ' (about ' + Math.round(jump.frames * pollMs) + ' ms)'
        + ', against a '
        + thresholdMm.toFixed(3)
        + ' mm threshold, over '
        + attributed
        + ' matched status frames'
        + faultsClause
        + '.'
        + (jump.count > 1 ? ' That happened ' + jump.count + ' times in this run.' : '')
        + ' None lasted the '
        + opts.minSustainedSamples
        + ' status frames that count as leaving the path.',
    }
  }
  return {
    ...base,
    verdict: 'clean',
    spans: [],
    reason: null,
    headline:
      'Path check: the machine stayed on the commanded path - worst '
      + (worst === null ? '0.000' : worst.deviationMm.toFixed(3))
      + ' mm'
      + (worst?.at ? ' at ' + worst.at : '')
      + ' against a '
      + thresholdMm.toFixed(3)
      + ' mm threshold, over '
      + attributed
      + ' matched status frames'
      + faultsClause
      + '.',
  }
}

const BRIEF_JUMP_HEADLINE = 'Path check: the machine was off the commanded path briefly - '

/**
 * A TRUNCATED RECORDING MAY NOT READ AS CLEAN. The frames past `cap` were never
 * looked at, and "I stopped watching" is not "nothing happened" - so a clean
 * report becomes UNKNOWN. What the recorded frames DID show is kept: a short
 * jump in them is still said as a short jump, never as "stayed on the
 * commanded path" (WO-2681). Any other verdict is returned as it is.
 */
export function truncatedPathFidelityReport(report: PathFidelityReport, cap: number): PathFidelityReport {
  if (report.verdict !== 'clean') return report
  const jumped = report.briefJump !== undefined && report.headline.startsWith(BRIEF_JUMP_HEADLINE)
  return {
    ...report,
    verdict: 'unknown',
    reason:
      'this job ran longer than the path check records ('
      + cap
      + ' status frames), so the later part of it was never watched.',
    headline:
      'Path check: CANNOT ASSESS the whole job - the first '
      + cap
      + (jumped
        ? ' status frames were recorded, and the rest were not. In those frames the machine was off the commanded path briefly - '
          + report.headline.slice(BRIEF_JUMP_HEADLINE.length)
        : ' status frames stayed on the commanded path, and the rest were not recorded.'),
  }
}

/**
 * WO-2681: the over-threshold runs too short to be a departure. `frames` is
 * the length of the run holding the worst frame; `count` is how many such runs
 * the whole recording had. Runs break exactly where the sustained rule breaks
 * them - at a frame within the threshold or one that may carry no verdict.
 */
function briefJumps(
  deviations: ReadonlyArray<{ mm: number; carriesVerdict: boolean }>,
  thresholdMm: number,
  worstIndex: number,
): { frames: number; count: number } {
  const over = (i: number): boolean => deviations[i].carriesVerdict && deviations[i].mm > thresholdMm
  let count = 0
  for (let i = 0; i < deviations.length; i++) if (over(i) && (i === 0 || !over(i - 1))) count++
  let start = worstIndex
  while (start > 0 && over(start - 1)) start--
  let end = worstIndex
  while (end + 1 < deviations.length && over(end + 1)) end++
  return { frames: end - start + 1, count }
}

/**
 * WHAT THIS CHECK CANNOT SEE, COMPUTED FROM THE RUN IT JUST READ.
 *
 * Requirement 3, and it goes in the OPERATOR'S report rather than only in a
 * comment: a limit discovered later costs trust in the whole check, and a limit
 * stated up front costs nothing.
 */
function buildLimits(
  opts: PathFidelityOptions,
  pollMs: number,
  attributionSlackMm: number | null,
  maxFeedMmMin: number | null,
  attribution: PathFidelityAttribution,
  unmodelled: { frames: number; blocks: number },
  outOfRange: number,
  measurementFaults: number,
): string[] {
  const limits: string[] = []
  if (outOfRange > 0) {
    limits.push(
      outOfRange
        + ' status frame(s) named a move id outside the queued range. The id was treated as '
        + 'a hint only; those positions were matched inside the continuity window established '
        + 'by adjacent frames and actual travel.',
    )
  }
  if (measurementFaults > 0) {
    limits.push(
      measurementFaults
        + ' status frame(s) implied travel beyond the machine physical ceiling. They were '
        + 'excluded as measurement faults and cannot instruct an operator to check the part.',
    )
  }
  if (unmodelled.blocks > 0) {
    limits.push(
      unmodelled.blocks
        + ' block(s) of this program command motion this check does not model - a G28 or '
        + 'G53 move, or an arc given by radius - so the '
        + unmodelled.frames
        + ' status frame(s) flown during them were NOT measured. This run is checked '
        + 'everywhere else and unchecked there.',
    )
  }
  const windowMs = pollMs * opts.minSustainedSamples
  const mmPerMs = maxFeedMmMin === null ? null : maxFeedMmMin / 60000
  limits.push(
    'Status frames arrive about every '
      + Math.round(pollMs)
      + ' ms, and a departure has to last '
      + opts.minSustainedSamples
      + ' of them (about '
      + Math.round(windowMs)
      + ' ms) to be reported'
      + (mmPerMs === null
        ? ''
        : ', which is about '
          + (mmPerMs * windowMs).toFixed(1)
          + ' mm of path at the commanded feed')
      + '.',
  )
  limits.push(
    'A SHORT GAP IS INVISIBLE. A few dropped moves are over before the next status frame '
      + 'arrives, and the machine is back on the path when it does - at a 0.1 mm chord a '
      + 'move takes about 2.4 ms against this '
      + Math.round(pollMs)
      + ' ms poll. The one dropped block this check was built from lasted about 3.6 s '
      + 'across about 110 frames.',
  )
  if (attributionSlackMm !== null) {
    limits.push(
      'The position and the executing-move id in one status frame are not simultaneous. '
        + 'The id is only a hint: position inside the continuity window chooses the match, '
        + 'so this check does not prove the path was flown in the named order or direction. '
        + 'The continuity comparison allows '
        + attributionSlackMm.toFixed(1)
        + ' mm of nearby path around the prior match. A departure smaller than that is '
        + 'inside the allowance and is not reported.',
    )
  }
  if (attribution === 'nearest-on-path') {
    limits.push(
      'No status frame named the move being executed, so this run was measured against the '
        + 'nearest point on the whole path. That can show the machine left the path; it '
        + 'cannot show the path was flown in the commanded order or direction.',
    )
  }
  return limits
}

/** The report as lines for the operator's console - headline, spans, limits. */
export function describePathFidelity(report: PathFidelityReport): string[] {
  const lines = [report.headline]
  for (const span of report.spans) {
    lines.push(
      '  off the path for '
        + span.sampleCount
        + ' status frames ('
        + (span.durationMs / 1000).toFixed(1)
        + ' s), peak '
        + span.peakDeviationMm.toFixed(2)
        + ' mm'
        + (span.peakMoveId === null ? '' : ' near move ' + span.peakMoveId)
        + (span.peakAt ? ' at ' + span.peakAt : ''),
    )
  }
  for (const limit of report.limits) lines.push('  limit: ' + limit)
  return lines
}

/** Console presentation for one report. Threshold disclosures are limits of
 * the instrument, not additional faults, even when the verdict is an error. */
export function pathFidelityConsoleLines(
  report: PathFidelityReport,
): Array<{ text: string; severity: MachineConsoleLine['severity'] }> {
  // WO-2681: a clean run whose worst frame is over the threshold had a brief
  // jump - said at warn, below the red departure and above a plain note.
  // A truncated recording keeps its measured short jump at warn too.
  const briefJump = report.spans.length === 0 && (report.briefJump !== undefined || (
    report.verdict === 'clean' && report.worst !== null
    && report.thresholdMm !== null && report.worst.deviationMm > report.thresholdMm))
  const departureSeverity =
    report.verdict === 'divergence' || report.spans.length > 0 ? 'error' : 'info'
  const verdictSeverity = departureSeverity === 'info' && briefJump ? 'warn' : departureSeverity
  return describePathFidelity(report).map((text) => ({
    text,
    severity: text.startsWith('  limit: ') ? 'info' : verdictSeverity,
  }))
}

// ---------------------------------------------------------------------------
// Streaming worker - keep terminal machine events off the renderer's long path
// ---------------------------------------------------------------------------

type PathFidelityWorkerRequest =
  | { type: 'start'; input: PathFidelityStreamingInput }
  | { type: 'sample'; sample: PathFidelitySample }
  | { type: 'finish'; frameChanges: readonly PathFidelityFrameChange[] }

type PathFidelityWorkerResponse =
  | { type: 'report'; report: PathFidelityReport }
  | { type: 'error'; message: string }

interface PathFidelityWorkerLike {
  onmessage: ((event: MessageEvent<PathFidelityWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: PathFidelityWorkerRequest): void
  terminate(): void
}

export type PathFidelityWorkerFactory = () => PathFidelityWorkerLike

const localStreamingAnalysis = (
  input: PathFidelityStreamingInput,
): PathFidelityStreamingAnalysis => {
  const samples: PathFidelitySample[] = []
  let disposed = false
  return {
    addSample(sample) {
      if (!disposed) samples.push(sample)
    },
    finish(frameChanges = []) {
      disposed = true
      // Vitest has no browser Worker. Keep the terminal callback asynchronous
      // there too, so a test cannot accidentally restore the old call shape.
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            resolve(analysePathFidelity({ ...input, samples, frameChanges }))
          } catch (error) {
            reject(error)
          }
        }, 0)
      })
    },
    dispose() {
      disposed = true
      samples.length = 0
    },
  }
}

/**
 * Score a run outside the renderer. One small message crosses at each status
 * frame, while the machine is already streaming; Stop only posts `finish`.
 * The worker then runs the unchanged batch analyser over its private sample
 * array, so verdict and evidence semantics stay byte-for-byte compatible.
 */
export function createPathFidelityStreamingAnalysis(
  input: PathFidelityStreamingInput,
  workerFactory?: PathFidelityWorkerFactory,
): PathFidelityStreamingAnalysis {
  const makeWorker = workerFactory ?? (() => new Worker(
    new URL('./pathFidelity.ts', import.meta.url),
    { type: 'module', name: 'liencam-path-fidelity' },
  ))
  if (workerFactory === undefined && typeof Worker === 'undefined') {
    return localStreamingAnalysis(input)
  }

  let worker: PathFidelityWorkerLike
  try {
    worker = makeWorker()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      addSample() {},
      finish() {
        return Promise.resolve(pathFidelityCannotAssess(
          'the path-analysis worker could not start (' + message + '), so this run was not measured.',
        ))
      },
      dispose() {},
    }
  }

  let settled = false
  let resolveReport: ((report: PathFidelityReport) => void) | null = null
  const reportPromise = new Promise<PathFidelityReport>((resolve) => { resolveReport = resolve })
  const settleUnknown = (reason: string): void => {
    if (settled) return
    settled = true
    worker.terminate()
    resolveReport?.(pathFidelityCannotAssess(reason))
  }
  worker.onmessage = (event) => {
    if (settled) return
    if (event.data.type === 'error') {
      settleUnknown('the path-analysis worker failed (' + event.data.message + '), so this run was not measured.')
      return
    }
    settled = true
    worker.terminate()
    resolveReport?.(event.data.report)
  }
  worker.onerror = (event) => {
    settleUnknown(
      'the path-analysis worker crashed (' + (event.message || 'unknown error')
        + '), so this run was not measured.',
    )
  }
  worker.onmessageerror = () => {
    settleUnknown('the path-analysis worker returned unreadable data, so this run was not measured.')
  }
  worker.postMessage({ type: 'start', input })

  return {
    addSample(sample) {
      if (!settled) worker.postMessage({ type: 'sample', sample })
    },
    finish(frameChanges = []) {
      if (!settled) worker.postMessage({ type: 'finish', frameChanges })
      return reportPromise
    },
    dispose() {
      if (settled) return
      settled = true
      worker.terminate()
      resolveReport?.(pathFidelityCannotAssess('the path-analysis run was cleared before it finished.'))
    },
  }
}

// This file is also its own worker entry. Vite emits it as a separate module
// for the static Worker URL above. The guard is false in the renderer and in
// Vitest; it is true only inside that emitted worker module.
const pathFidelityWorkerScope = globalThis as typeof globalThis & {
  document?: unknown
  postMessage?: (message: PathFidelityWorkerResponse) => void
}
if (
  typeof pathFidelityWorkerScope.document === 'undefined'
  && typeof pathFidelityWorkerScope.postMessage === 'function'
) {
  let workerInput: PathFidelityStreamingInput | null = null
  let workerSamples: PathFidelitySample[] = []
  globalThis.addEventListener('message', (event: MessageEvent<PathFidelityWorkerRequest>) => {
    try {
      if (event.data.type === 'start') {
        workerInput = event.data.input
        workerSamples = []
      } else if (event.data.type === 'sample') {
        workerSamples.push(event.data.sample)
      } else if (workerInput !== null) {
        const report = analysePathFidelity({
          ...workerInput,
          samples: workerSamples,
          frameChanges: event.data.frameChanges,
        })
        pathFidelityWorkerScope.postMessage?.({ type: 'report', report })
        workerInput = null
        workerSamples = []
      }
    } catch (error) {
      pathFidelityWorkerScope.postMessage?.({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

// ---------------------------------------------------------------------------
// THE COMMANDED PATH, DERIVED FROM THE PROGRAM THE PRODUCT ACTUALLY LOADED
// ---------------------------------------------------------------------------
//
// The check above needs a `QueuedMove[]`, and until this existed the only way
// to get one was for a test to hand one over - so the analyser was correct and
// the PRODUCT was inert. This is the wire: `machineSession` loads a program,
// and this turns that same text into the commanded move list.
//
// THE ID IS THE SOURCE LINE, and that is the product's own established
// convention rather than a choice made here:
//   - `simulatedController.parseProgramLines` mints `id: line.sourceLine` for
//     every move it queues ("id = source line for every text-loaded move, so
//     the two line up exactly"), and
//   - `uccncController.jobProgress` reads `status.executingMoveId` back out as
//     `ackedSourceLine`, i.e. the whole app already treats the executing move
//     id as the source line of the block being flown.
// So a list derived here from the same text carries the same ids the
// controller reports, and requirement 4's range check keeps a backend that
// numbers differently honest: those ids miss and the verdict is UNKNOWN.
//
// IT REUSES THE APP'S OWN G-CODE READER (`lib/gcode/parse.ts`, the same
// tokenizer and modal interpreter the backplot and the preview run on) rather
// than growing a second interpreter. What it adds is arc centres from I/J and,
// much more importantly, AN HONEST ACCOUNT OF WHAT IT COULD NOT INTERPRET.
//
// WHY "COULD NOT INTERPRET" IS A FIRST-CLASS OUTPUT AND NOT A BEST GUESS.
// A commanded path that is WRONG is worse than no commanded path at all: it
// reports a divergence on a machine that flew the program perfectly, and this
// order's own acceptance says a detector that cries wolf on a good program
// gets turned off. A posted program routinely ends with `G28` or
// `G53 G0 X.. Y.. Z..`, neither of which is expressible in the work
// coordinates the rest of the program is written in. Guessing at those would
// manufacture a divergence over every program end. So:
//
//   - a MODAL word this derivation does not model (G20 inch, G91 incremental,
//     G18/G19 planes, G92 offsets, G43 tool length, G41/G42 cutter comp,
//     G90.1 absolute arc centres) REFUSES THE WHOLE PROGRAM. The verdict is
//     then UNKNOWN, never clean;
//   - a single BLOCK whose path is not modelled (an arc with no I/J) is
//     excluded by id: frames flown during it are counted and reported, and
//     they carry no verdict;
//   - a block that moves somewhere this derivation cannot place (G28, G30,
//     G53) is excluded the same way, AND so is every following block until one
//     states X, Y and Z together - because until then the modal position, and
//     therefore that block's start point, is unknown.
//
// Everything excluded is reported. Nothing excluded is called clean.

/** Options for `commandedPathFromProgram`. */
export interface CommandedPathOptions {
  /** mm/min a G0 rapid runs at - a rapid block carries no F word. Only ever
   *  used to size the attribution window, never the threshold. */
  rapidFeedMmMin: number
  /**
   * WHERE THE MACHINE IS WHEN THE FIRST BLOCK RUNS, in the program's own
   * (work) coordinates.
   *
   * Needed because a program's first motion blocks routinely constrain one
   * axis - `G0 Z5` then `G0 X10 Y20` - and the unconstrained axes carry from
   * wherever the machine already was. `lib/gcode/parse.ts` seeds its modal
   * position at the origin, which is a drawing convention and not where the
   * machine is; seeding it with the machine's own reported position is what
   * makes requirement 5 (a partial move reads ZERO deviation, not a large one)
   * hold on a real program rather than only on a hand-built move list.
   */
  startPos: MachineVec3
}

export interface CommandedPath {
  /** The modelled commanded program, ids being source lines. */
  moves: QueuedMove[]
  /** Where the first move starts - `options.startPos`, carried through. */
  startPos: MachineVec3
  /**
   * Source lines that command motion this derivation does not model. Frames
   * flown during these are excluded from the verdict and REPORTED, never
   * silently folded into a clean run.
   */
  unmodelledMoveIds: number[]
  /** WO-2437: the first modelled move after a stretch of lost position starts
   *  where the program's own block re-placed X, Y and Z - not where the move
   *  before it in `moves` ended (a G53 park sits between them). */
  restartsAt?: MoveRestart[]
  /** Non-null when the whole program could not be derived; `moves` is empty. */
  refusal: string | null
}

/** Modal words that change what every later block MEANS. One of these and the
 *  whole derivation is refused: a mis-scaled or mis-offset path is a
 *  manufactured divergence. */
const UNMODELLED_MODAL: ReadonlyMap<number, string> = new Map([
  [20, 'G20 - the program is in inches'],
  [91, 'G91 - incremental distance mode'],
  [18, 'G18 - the XZ arc plane'],
  [19, 'G19 - the YZ arc plane'],
  [92, 'G92 - a coordinate offset set mid-program'],
  [43, 'G43 - a tool length offset applied mid-program'],
  [41, 'G41 - cutter compensation left'],
  [42, 'G42 - cutter compensation right'],
])

/** Words that move the machine somewhere this derivation cannot place in the
 *  program's own coordinates. The BLOCK is excluded, not the program. */
const POSITION_LOSING: ReadonlySet<number> = new Set([28, 30, 53])

/** The work frames a program selects by its own words. */
const PROGRAM_FRAMES: ReadonlySet<number> = new Set([54, 55, 56, 57, 58, 59])

/** WO-2687: one hole of an active G81/G82/G83 drilling cycle - its modal
 *  words, in work mm. */
export interface CannedHole {
  code: 81 | 82 | 83
  /** G98: back to the Z the hole started from. G99: back to R. */
  returnToInitial: boolean
  retractZ: number | null
  depthZ: number | null
  peckQ: number | null
  feedMmMin: number | null
  /** The X/Y the hole's block names; an axis it does not name stays put. */
  x: number | null
  y: number | null
}

const holeNumber = (value: number): string => {
  const text = value.toFixed(9).replace(/\.?0+$/, '')
  return text === '-0' ? '0' : text
}

/**
 * WO-2687: ONE hole of a canned drill cycle as the moves the controller makes
 * for it, from a known work-frame start. It is the 3D preview's own expansion
 * (previewGeometry's expandCannedCycle), read over a block stating just this
 * hole from just this start - not a second expansion, and not the preview's
 * reading of the whole program, so a word the preview cannot draw elsewhere (a
 * post's G28 end) never decides whether a hole runs or is checked. The
 * simulator and the path check both expand holes here. A string is the
 * preview's refusal of the hole itself.
 */
export function expandCannedHole(start: MachineVec3, hole: CannedHole): PreviewMove[] | string {
  // G-code wire words for the one block, never an operator sentence.
  const block = [`G${hole.returnToInitial ? 98 : 99}`, `G${hole.code}`]
  const word = (letter: string, value: number | null): void => {
    if (value !== null) block.push(letter + holeNumber(value))
  }
  word('X', hole.x)
  word('Y', hole.y)
  word('Z', hole.depthZ)
  word('R', hole.retractZ)
  word('Q', hole.peckQ)
  word('F', hole.feedMmMin !== null && hole.feedMmMin > 0 ? hole.feedMmMin : null)
  const preview = buildPreviewModel([
    'G21 G90 G17',
    `G0 X${holeNumber(start.x)} Y${holeNumber(start.y)} Z${holeNumber(start.z)}`,
    block.join(' '),
  ].join('\n'))
  if (preview.refusal !== null) return preview.refusal
  return preview.moves.filter((move) => move.line === 3)
}

/**
 * Turn the program the product loaded into the commanded move list the path
 * check compares against. See the block comment above for why "I could not
 * model this block" is an output rather than a guess.
 */
export function commandedPathFromProgram(
  programText: string,
  options: CommandedPathOptions,
): CommandedPath {
  const startPos = { ...options.startPos }
  const refuse = (refusal: string): CommandedPath => ({
    moves: [],
    startPos,
    unmodelledMoveIds: [],
    refusal,
  })

  const program = parseGcode(programText)
  const segmentByLine = new Map<number, GcodeSegment>()
  for (const seg of program.segments) {
    // One motion block per line in this subset; keep the first if that ever
    // stops being true rather than silently flying the last.
    if (!segmentByLine.has(seg.line)) segmentByLine.set(seg.line, seg)
  }

  const moves: QueuedMove[] = []
  const unmodelledMoveIds: number[] = []
  const restartsAt: MoveRestart[] = []
  // Seeded from the machine's own position, not from the origin - see
  // `CommandedPathOptions.startPos`.
  let pos: MachineVec3 = { ...startPos }
  let positionKnown = true
  let restart: MachineVec3 | null = null
  // WO-2687: a canned drill cycle's hole is the moves the controller makes for
  // it - the preview's expansion, the one the simulator runs - not the one
  // straight line to the bottom the parser infers.
  // Each hole is expanded on its own, from where this derivation has the tool,
  // so no other word in the program (a G28 end) decides whether it is read.
  let cycle: CannedHole | null = null
  let returnToInitial = true // G98 is the power-on default
  let feed: number | null = null
  // WO-2687 fix round: after the program's own G54..G59 the controller reads
  // positions in that frame, and an axis the program has not stated since is
  // somewhere this derivation can only name in the frame it left. Such an axis
  // stays off the move, as the geometry door's moves leave it, so the analysis
  // carries it across the frame change it observes (`ProgramFramedMove`).
  // Fix round 2: only a word naming ANOTHER frame than the program's last does
  // this. The first one may repeat the frame selected at Cycle Start, which
  // this derivation is not told; the analysis knows it and sees no change
  // there, and a carried axis then resolves to exactly the value main used.
  let stale = new Set<'x' | 'y' | 'z'>()
  let programFrame: number | null = null
  const known = (to: MachineVec3): Partial<MachineVec3> => stale.size === 0
    ? to
    : Object.fromEntries((['x', 'y', 'z'] as const).filter((key) => !stale.has(key)).map((key) => [key, to[key]]))

  for (const line of program.lines) {
    const gWords = line.words.filter((w) => w.letter === 'G' && !Number.isNaN(w.value))
    for (const w of gWords) {
      // G90.1 makes I/J ABSOLUTE centres rather than offsets from the start,
      // which silently relocates every arc. Exact-value check: G90 itself is
      // the mode this derivation assumes and is fine.
      if (w.value === 90.1) return refuse('G90.1 - absolute arc centres')
      const modal = UNMODELLED_MODAL.get(Math.trunc(w.value))
      if (modal !== undefined) return refuse(modal)
    }

    const losesPosition = gWords.some((w) => POSITION_LOSING.has(Math.trunc(w.value)))
    const frameWord = gWords.findLast((w) => PROGRAM_FRAMES.has(w.value))
    if (frameWord !== undefined && frameWord.value !== programFrame) {
      programFrame = frameWord.value
      if (positionKnown) stale = new Set(['x', 'y', 'z'])
    }
    const seg = segmentByLine.get(line.number)
    const f = coordOf(line, 'F')
    if (f !== null) feed = f
    if (gWords.some((w) => w.value === 98)) returnToInitial = true
    if (gWords.some((w) => w.value === 99)) returnToInitial = false
    if (gWords.some((w) => [0, 1, 2, 3, 80].includes(w.value))) cycle = null
    const cycleWord = gWords.find((w) => w.value === 81 || w.value === 82 || w.value === 83)
    if (cycleWord !== undefined) {
      cycle = { code: cycleWord.value as 81 | 82 | 83, returnToInitial, retractZ: null, depthZ: null, peckQ: null, feedMmMin: null, x: null, y: null }
    }
    const cycleHole = cycle !== null && !losesPosition
      && ['X', 'Y', 'Z'].some((letter) => coordOf(line, letter) !== null)
    if (cycle !== null && cycleHole) {
      cycle.retractZ = coordOf(line, 'R') ?? cycle.retractZ
      cycle.peckQ = coordOf(line, 'Q') ?? cycle.peckQ
      cycle.depthZ = coordOf(line, 'Z') ?? cycle.depthZ
      const holeX = coordOf(line, 'X')
      const holeY = coordOf(line, 'Y')
      // Fix round 3: an axis carried across a frame switch holds a number from
      // the frame the program left, so it equalling a hole's word says nothing
      // about whether the hole moves that axis. The hole is expanded from a
      // start no word of it can equal on such an axis, so the expansion never
      // drops the rapid across to the hole or down to R as "already there".
      // That start never lands on a move: a step's target is taken only on
      // the axes it addresses, and a G98 return is resolved to the line start.
      const expandFrom = { ...pos }
      if (stale.has('x') && holeX !== null) expandFrom.x = holeX + 1
      if (stale.has('y') && holeY !== null) expandFrom.y = holeY + 1
      if (stale.has('z') && cycle.retractZ !== null) {
        expandFrom.z = Math.max(cycle.retractZ, cycle.depthZ ?? cycle.retractZ) + 1
      }
      // A hole the preview's expansion refuses is unmodelled, never guessed.
      const expanded = positionKnown
        ? expandCannedHole(expandFrom, {
          ...cycle, returnToInitial, feedMmMin: feed, x: holeX, y: holeY,
        })
        : null
      const steps = typeof expanded === 'string' ? null : expanded
      if (steps === null) {
        unmodelledMoveIds.push(line.number)
        positionKnown = false
        continue
      }
      if (restart !== null && steps.length > 0) restartsAt.push({ moveId: line.number, at: restart })
      if (steps.length > 0) restart = null
      const lineStart = pos
      // Fix round 2: a G98 return on an axis not restated since the frame word
      // goes back to where the line started, which the analysis resolves.
      const staleAtLineStart = new Set(stale)
      for (const step of steps) {
        const to = { ...pos }
        const toLineStart: ('x' | 'y' | 'z')[] = []
        for (const key of step.addressedAxes) {
          if (key !== 'x' && key !== 'y' && key !== 'z') continue
          to[key] = step.targetMode === 'line-start' ? lineStart[key] : step.to[key]
          if (step.targetMode === 'line-start' && staleAtLineStart.has(key)) {
            stale.add(key)
            toLineStart.push(key)
          } else {
            stale.delete(key)
          }
        }
        moves.push({
          id: line.number,
          kind: 'line',
          to: known(to),
          ...(toLineStart.length > 0 ? { toLineStart } : {}),
          feedMmMin: step.kind === 'rapid' || step.feedMmMin === null || !(step.feedMmMin > 0)
            ? options.rapidFeedMmMin
            : step.feedMmMin,
        })
        pos = to
      }
      continue
    }

    if (losesPosition) {
      // The machine MOVES here (G28 to the reference point, G53 in machine
      // coordinates) and this derivation cannot say where to in the program's
      // own frame. Exclude the block by id, and stay lost until a block states
      // all three axes.
      unmodelledMoveIds.push(line.number)
      positionKnown = false
      stale.clear()
      continue
    }
    if (seg === undefined) {
      // A modal, M-code or dwell block: no motion. WO-2437: while the position
      // is lost (a G53 park), a frame naming this block - the M0 the machine
      // holds on at the park - cannot be placed either, so it is excluded too.
      if (!positionKnown) unmodelledMoveIds.push(line.number)
      continue
    }

    const xW = coordOf(line, 'X')
    const yW = coordOf(line, 'Y')
    const zW = coordOf(line, 'Z')
    // Fix round 2: an arc's centre is an offset from its start. A start not yet
    // stated in the program's new frame is where the tool is, so the arc is
    // placed from there (`centreOffset`) rather than dropped.
    const startStale = stale.size > 0
    if (xW !== null) stale.delete('x')
    if (yW !== null) stale.delete('y')
    if (zW !== null) stale.delete('z')

    if (!positionKnown) {
      // Start point unknown, so this move's PATH is unknown - but if the block
      // states every axis its END is exact, and the next block is measurable.
      unmodelledMoveIds.push(line.number)
      if (xW !== null && yW !== null && zW !== null) {
        pos = { x: xW, y: yW, z: zW }
        positionKnown = true
        restart = pos
      }
      continue
    }

    const from = pos
    const to: MachineVec3 = {
      x: xW ?? from.x,
      y: yW ?? from.y,
      z: zW ?? from.z,
    }
    const feedMmMin =
      seg.kind === 'rapid' || seg.feed === undefined || !(seg.feed > 0)
        ? options.rapidFeedMmMin
        : seg.feed

    if (seg.arc !== undefined) {
      const i = coordOf(line, 'I')
      const j = coordOf(line, 'J')
      if (i === null || j === null) {
        // An R-form arc, or a malformed one. The endpoint is still exact, so
        // only THIS block is excluded.
        unmodelledMoveIds.push(line.number)
        pos = to
        continue
      }
      if (restart !== null) restartsAt.push({ moveId: line.number, at: restart })
      restart = null
      moves.push({
        id: line.number,
        kind: 'arc',
        to,
        centre: { x: from.x + i, y: from.y + j, z: from.z },
        clockwise: seg.arc === 'cw',
        plane: 'xy',
        feedMmMin,
        ...(startStale ? { centreOffset: { x: i, y: j, z: 0 } } : {}),
        ...(stale.size > 0 ? { carried: [...stale] } : {}),
      } as ProgramFramedMove)
      pos = to
      continue
    }

    if (restart !== null) restartsAt.push({ moveId: line.number, at: restart })
    restart = null
    moves.push({ id: line.number, kind: 'line', to: known(to), feedMmMin })
    pos = to
  }

  if (moves.length === 0) {
    return refuse('this program commands no motion this check can model')
  }
  // WO-2687 fix round: the program's own G54..G59. The controller reports work
  // positions in the frame the program selects from that line on (UCCNC does,
  // and so does the simulator), while `startPos` was read in the frame selected
  // at Cycle Start. The first move from such a line names the frame, so the
  // analysis places the switch where the program made it (`ProgramFramedMove`).
  for (const line of program.lines) {
    const frameWord = line.words.findLast((w) => w.letter === 'G' && PROGRAM_FRAMES.has(w.value))
    const first = frameWord === undefined ? undefined : moves.find((move) => move.id >= line.number)
    if (frameWord !== undefined && first !== undefined) {
      (first as ProgramFramedMove).programFrame = `G${frameWord.value}`
    }
  }
  return {
    moves,
    startPos,
    unmodelledMoveIds,
    ...(restartsAt.length > 0 ? { restartsAt } : {}),
    refusal: null,
  }
}

/** One numeric coordinate word off a line, or null when the line has none. */
function coordOf(line: GcodeLine, letter: string): number | null {
  const word = line.words.find((w) => w.letter === letter)
  if (word === undefined || Number.isNaN(word.value)) return null
  return word.value
}
