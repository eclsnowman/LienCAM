// The LIVE program builder - the straight-line slice (ADR-0043 sections 1-3,
// WO-1029; WO-1019 slice 1a).
//
// A `ToolpathMove[]` in WORLD coordinates goes in; a `MachineProgram` in WORK
// coordinates comes out. That is the whole job of this file. It is the peer of
// the file post, not a part of it: the post renders a setup as text, this
// renders the same geometry as a program the controller executes by id.
//
// Three rules run through every line below, and each one is a defect this
// product has already paid for:
//
// 1. NEVER INVENT A MACHINE FACT. A feed comes from the operation or from the
//    machine definition the caller resolved. A move with no feed is REFUSED by
//    name; it is never given a default and never silently dropped. (ADR-0003;
//    the rapid-feed rule in ADR-0043 section 3.)
// 2. REFUSE WHAT WE CANNOT EXPRESS. An arc is NEVER linearised here and never
//    quietly skipped. Since WO-1285 an XY arc is emitted natively (the wire and
//    the bridge have carried `kind: 'arc'` since WO-1019; the bridge flies it
//    with the direction inversion measured on Operator's machine 2026-08-25), and
//    since WO-1337 that arc may RAMP. A HELICAL ARC IS EXPRESSIBLE, so it is no
//    longer refused: it is one `arc` step whose endpoint Z differs from where
//    the arc started. NOTHING NEW GOES ON THE WIRE - the bridge has always
//    submitted `UC100.AddCircularMoveP(X, Y, Z, CX, CY, CZ, ...)` with an
//    endpoint Z and a centre Z (`Machine.cs`); what changed is that the
//    endpoint Z stopped being forced equal to the start. That is what lets a
//    Fusion helical ramp entry - 3,561 short `G3` arcs each stepping Z by about
//    0.1 mm - stage as 3,561 slots instead of being turned away at the door.
//    NO HELIX HAS FLOWN ON THIS HARDWARE YET (WO-1337 air-run fixture). That
//    gates CUTTING MATERIAL, not staging, and it is a session item rather than
//    a line of code: a refusal here would only hide the move from the very
//    capture that has to measure it.
//    What is still refused by name, exactly as before: a FULL CIRCLE (ambiguous
//    about which way and how far), a MALFORMED arc (ends not on one circle, no
//    centre, zero radius), and an arc with no move before it. A non-XY plane is
//    refused at the controller, where WO-1285 put it.
//    Linearising is wrong for the CAP, not for fidelity: a
//    contour of a few hundred arcs becomes tens of thousands of chords and
//    either refuses at 4,095 or splits a program the board could hold natively.
// 3. WORK COORDINATES, PRE-SHIFTED TOWARD NOTHING. The program declares
//    `frame: 'work'`; the bridge adds `offsets[activeWcs]` at LOAD, exactly as
//    it already does for `JogToWorkXY`. A builder that also shifted toward the
//    machine frame would double-apply the offset - which is why the frame is
//    DECLARED on the program rather than guessed by the reader.
//
// This module is NEUTRAL. It imports the shared transform, the shared program
// types and the project types - no store, no post, no backend, no component.
// `src/lib/machine/controller.ts` is the contract that names `MachineProgram`
// and `QueuedMove`; it is a type module, not a backend, and importing it is
// what makes the builder and the executor talk about the same program.

import type { ToolpathMove, WCS } from '../../types'
import type {
  MachineProgram,
  MachinePosition,
  MachineVec3,
  ProgramIndex,
  ProgramStep,
  QueuedMove,
} from '../machine/controller'
import { RESERVED_PROGRAM_ID, validateMachineProgram } from '../machine/controller'
import type { Bounds3, MachineEnvelope } from '../machine/machineEnvelope'
import { ENVELOPE_FIT_TOLERANCE_MM, turnWorkPoint } from '../machine/machineEnvelope'
import { toWork } from './coords'
import { isStagedMove } from './programCapacity'

// ---------------------------------------------------------------------------
// WO-1285: arcs, and the extent nobody checked.
//
// The bridge's soft-limit check at load (`Machine.cs:5166`) covers ENDPOINTS
// ONLY. An arc whose two ends are on the table and whose BULGE is not would be
// accepted and driven into a hard stop, and nothing downstream catches it. So
// the extent check is OURS, here beside the builder: `arcSweptBounds` is the
// true swept box of one arc (its ends plus every quadrant extreme inside the
// swept angle), and `firstStepOutsideTravel` walks a program step by step with
// that geometry and names the first step that leaves the declared travel.
// ---------------------------------------------------------------------------

/** The two ends of an arc must sit on the same circle to this much. */
export const ARC_RADIUS_TOLERANCE_MM = 0.01
/** An arc whose ends coincide IN XY closer than this is a full circle - which
 *  is true of a full helical turn too: the ambiguity a full circle has about
 *  which way and how far is an XY ambiguity, and a Z ramp does not resolve it. */
export const ARC_FULL_CIRCLE_TOLERANCE_MM = 1e-6

type Point3 = { x: number; y: number; z: number }

type TextMoveFacts = {
  machineAbsolute?: Partial<MachinePosition>
  executionAxes?: readonly (keyof MachinePosition)[]
}

type MachineAbsoluteLine = Extract<QueuedMove, { kind: 'line' }> & {
  machineAbsolute?: true
  machineTarget?: Partial<MachinePosition>
}

function isMachineAbsoluteLine(step: QueuedMove): step is MachineAbsoluteLine {
  return step.kind === 'line' && (step as MachineAbsoluteLine).machineAbsolute === true
}

/**
 * WO-1897: WHAT THE BRIDGE IS SENT FOR ONE MOVE - the one place a step becomes
 * its wire form, called where `loadMoves` frames are built
 * (`UccncController.sendStagedLoad`).
 *
 * An ordinary move goes out as it is. A machine-absolute (G53/G28/G30) line
 * goes out with its MACHINE TARGET as `to` and `machineAbsolute: true`: with
 * that flag set the bridge stages these numbers as machine coordinates and adds
 * no work offset (Bridge.cs, "machineAbsolute"). `machineTarget` itself stays
 * off the wire - the bridge has never read it, and a second target there would
 * be a second opinion about where the tool goes.
 *
 * Computed from the step's PLAIN DATA, at the boundary, and never carried on
 * the step as a `toJSON`. A function on a step is not data: structured clone
 * refuses it (DataCloneError) the moment a program is posted to a worker - the
 * path-fidelity analysis does exactly that - and an ordinary `{ ...step }` copy
 * either keeps it (when enumerable) or drops it (when hidden). Data survives
 * both; so this reads data.
 */
export function machineMoveWireForm(move: QueuedMove): QueuedMove {
  if (!isMachineAbsoluteLine(move)) return move
  const { machineTarget, ...rest } = move
  return { ...rest, to: { ...(machineTarget ?? move.to) }, machineAbsolute: true } as QueuedMove
}

/**
 * WO-1897: the move a `loadMoves` frame CARRIES (`UccncController.sendStagedLoad`).
 *
 * JSON is the wire: `bridgeTransport.send` is `socket.send(JSON.stringify(message))`.
 * So a machine-absolute line is handed over as a COPY of itself whose
 * non-enumerable `toJSON` is `machineMoveWireForm` - the frame object keeps the
 * step's own data (work-coordinate `to`, as every reader of a staged frame has
 * always seen it) and serialises to the machine target. The function lives only
 * on this per-send copy, never on the built step, so a program posted to a worker
 * by structured clone still carries plain data. Any other move is the same object.
 */
export function machineMoveForSend(move: QueuedMove): QueuedMove {
  if (!isMachineAbsoluteLine(move)) return move
  const copy = { ...move }
  Object.defineProperty(copy, 'toJSON', {
    value: () => machineMoveWireForm(copy),
    enumerable: false,
  })
  return copy
}

/**
 * Mark one built line as the machine-absolute (G53/G28/G30) move it is, in
 * PLAIN ENUMERABLE DATA (WO-1897).
 *
 * These facts used to be non-enumerable, to keep execution metadata out
 * of previews and ordinary object comparisons. What that actually bought was a
 * step that lost its frame the first time anything copied it: `{ ...step }`
 * keeps only enumerable own properties, so the copy said nothing about machine
 * coordinates and carried no machine target, and a G53 retract reached the
 * board as an ordinary WORK move for the active offset to shift. Previews and
 * fit checks already FILTER for these facts where they read them
 * (`stagedGeometryProgramPath`, `lineTargetForChecks`), which is where that
 * filtering belongs - hiding the facts on the object only hid them from the
 * copy that had to keep them. The wire form is made from them at the wire
 * (`machineMoveWireForm`), so the step carries no function to be cloned.
 */
function markMachineAbsoluteLine(
  step: Extract<QueuedMove, { kind: 'line' }>,
  machineTarget: Partial<MachinePosition>,
): void {
  const line = step as MachineAbsoluteLine
  line.machineAbsolute = true
  line.machineTarget = { ...machineTarget }
}

function lineTargetForChecks(step: Extract<QueuedMove, { kind: 'line' }>): Partial<MachinePosition> {
  return isMachineAbsoluteLine(step) ? step.machineTarget ?? step.to : step.to
}

/**
 * Signed sweep of an arc from `a0` to `a1` (radians): positive counter-
 * clockwise, negative clockwise, never zero (coincident ends read as a full
 * turn in the requested direction).
 */
export function arcSweep(a0: number, a1: number, clockwise: boolean): number {
  const twoPi = 2 * Math.PI
  const ccw = (((a1 - a0) % twoPi) + twoPi) % twoPi // [0, 2pi)
  if (ccw <= 1e-12 || twoPi - ccw <= 1e-12) return clockwise ? -twoPi : twoPi
  return clockwise ? ccw - twoPi : ccw
}

/**
 * The TRUE swept box of one XY arc: both ends, plus each quadrant extreme
 * (0, 90, 180, 270 degrees about the centre) that the sweep passes through.
 *
 * Z IS THE RANGE OF THE TWO ENDS, AND THAT IS EXACT FOR A HELIX TOO (WO-1337).
 * It used to be true by assumption - a planar arc's two ends have the same Z
 * and a helical one was refused before it got here - and it is now true by
 * argument, which is worth stating because a soft-limit check rests on it:
 * every backend that flies one of these interpolates Z LINEARLY IN THE SWEPT
 * ANGLE (the bridge's `AddCircularMoveP` does, and `simulatedController`'s
 * integrator does it in the same fraction it walks the circle by). A linear
 * function of the swept angle is monotonic between the ends, so it attains no
 * value outside them and reaches no Z extreme in the middle of the arc. There
 * is no Z equivalent of the BULGE this function exists to catch - the bulge is
 * an XY phenomenon, and Z never has one.
 */
export function arcSweptBounds(
  from: Point3,
  to: Point3,
  centre: { x: number; y: number },
  clockwise: boolean,
): Bounds3 {
  const r = Math.hypot(from.x - centre.x, from.y - centre.y)
  const a0 = Math.atan2(from.y - centre.y, from.x - centre.x)
  const a1 = Math.atan2(to.y - centre.y, to.x - centre.x)
  const sweep = arcSweep(a0, a1, clockwise)
  const min = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) }
  const max = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) }
  for (let k = 0; k < 4; k++) {
    const q = (k * Math.PI) / 2
    // Angle from a0 to q, measured in the direction of travel.
    let d = (q - a0) % (2 * Math.PI)
    if (sweep >= 0) { if (d < 0) d += 2 * Math.PI } else { if (d > 0) d -= 2 * Math.PI }
    if (Math.abs(d) <= Math.abs(sweep) + 1e-12) {
      const px = centre.x + r * Math.cos(q)
      const py = centre.y + r * Math.sin(q)
      if (px < min.x) min.x = px
      if (px > max.x) max.x = px
      if (py < min.y) min.y = py
      if (py > max.y) max.y = py
    }
  }
  return { min, max }
}

/**
 * Where a step leaves the tool. A line may address only some axes (the text
 * interpreter's programs do); an unaddressed axis keeps its previous value,
 * and is NaN when nothing before it established one.
 */
export function stepEnd(step: QueuedMove, from: MachineVec3 | null): MachineVec3 | null {
  if (step.kind === 'arc') return { ...step.to }
  if (step.kind !== 'line') return from
  const pick = (axis: 'x' | 'y' | 'z'): number => {
    const v = step.to[axis]
    if (typeof v === 'number') return v
    return from === null ? Number.NaN : from[axis]
  }
  return { x: pick('x'), y: pick('y'), z: pick('z') }
}

/** The swept box of one staged step, given where the tool is before it. A
 *  line's box is its endpoint (the same thing the bridge checks), with an
 *  unknown axis left as an empty range; an arc's is its true sweep; a dwell
 *  or marker sweeps nothing. */
export function stepSweptBounds(step: QueuedMove, from: MachineVec3 | null): Bounds3 | null {
  if (step.kind === 'line') {
    const target = lineTargetForChecks(step)
    const p = isMachineAbsoluteLine(step)
      ? {
          x: typeof target.x === 'number' ? target.x : Number.NaN,
          y: typeof target.y === 'number' ? target.y : Number.NaN,
          z: typeof target.z === 'number' ? target.z : Number.NaN,
        }
      : stepEnd(step, from)!
    const lo = (v: number) => (Number.isNaN(v) ? Infinity : v)
    const hi = (v: number) => (Number.isNaN(v) ? -Infinity : v)
    return { min: { x: lo(p.x), y: lo(p.y), z: lo(p.z) }, max: { x: hi(p.x), y: hi(p.y), z: hi(p.z) } }
  }
  if (step.kind === 'arc') {
    if (from === null || Number.isNaN(from.x) || Number.isNaN(from.y)) return null
    return arcSweptBounds({ x: from.x, y: from.y, z: Number.isNaN(from.z) ? step.to.z : from.z }, step.to, step.centre, step.clockwise)
  }
  return null
}

/** The arc-aware bounding box of a whole program in its own (work) frame, or
 *  null when it moves nothing. */
export function programSweptBounds(program: MachineProgram): Bounds3 | null {
  let from: MachineVec3 | null = null
  let out: Bounds3 | null = null
  for (const step of program.steps) {
    if (!isStagedMove(step)) continue
    const b = stepSweptBounds(step, from)
    if (b !== null) {
      out = out === null
        ? { min: { ...b.min }, max: { ...b.max } }
        : {
            min: { x: Math.min(out.min.x, b.min.x), y: Math.min(out.min.y, b.min.y), z: Math.min(out.min.z, b.min.z) },
            max: { x: Math.max(out.max.x, b.max.x), y: Math.max(out.max.y, b.max.y), z: Math.max(out.max.z, b.max.z) },
          }
    }
    from = stepEnd(step, from)
  }
  if (out !== null) {
    for (const axis of ['x', 'y', 'z'] as const) {
      if (!Number.isFinite(out.min[axis]) || !Number.isFinite(out.max[axis])) return null
    }
  }
  return out
}

/** The first staged step whose TRUE swept geometry leaves the declared travel. */
export interface TravelOffence {
  stepId: number
  kind: 'line' | 'arc'
  axis: 'x' | 'y' | 'z'
  /** Machine coordinate the step reaches on that axis. */
  reachesMm: number
  /** The declared travel on that axis, machine coordinates. */
  minMm: number
  maxMm: number
  /** True when the offending extreme is the arc's BULGE: both ends are inside. */
  bulge: boolean
}

/**
 * Walk a program with true per-step geometry against the declared travel.
 * `workOriginMachine` is the active work offset in machine coordinates
 * (machine = work + offset); an axis with no envelope or no offset is not
 * compared, which is the same rule `fitProgramToEnvelope` follows. Returns
 * the first offender, or null.
 *
 * WO-2219: `rotationDeg` is that offset's XY rotation as the CONTROLLER
 * reports it (docs/design/WCS-ROTATION.md: machine = O + Rot(R)(work)). Each
 * work step is turned about the work origin before the offset is added - an
 * arc stays an arc, so its true sweep is measured turned. A G53 line is
 * machine coordinates and is never turned. Absent or 0, nothing changes.
 */
export function firstStepOutsideTravel(
  program: MachineProgram,
  workOriginMachine: Partial<{ x: number; y: number; z: number }>,
  envelope: MachineEnvelope,
  tolerance: number = ENVELOPE_FIT_TOLERANCE_MM,
  rotationDeg: number = 0,
): TravelOffence | null {
  const turned = Number.isFinite(rotationDeg) && rotationDeg !== 0
  let from: MachineVec3 | null = null
  for (const step of program.steps) {
    if (!isStagedMove(step)) continue
    if (step.kind === 'line' || step.kind === 'arc') {
      const turnStep = turned && !isMachineAbsoluteLine(step)
      const b = turnStep ? turnedStepSweptBounds(step, from, rotationDeg) : stepSweptBounds(step, from)
      // The arc's two ends, where the machine meets them (turned when the frame is).
      const arcFrom = turnStep && from !== null ? turnWorkPoint(from, rotationDeg) : from
      const arcTo = turnStep && step.kind === 'arc' ? turnWorkPoint(step.to, rotationDeg) : step.to
      if (b !== null) {
        for (const axis of ['x', 'y', 'z'] as const) {
          const env = envelope[axis]
          const origin = isMachineAbsoluteLine(step) ? 0 : workOriginMachine[axis]
          if (!env || !Number.isFinite(origin)) continue
          const lo = b.min[axis] + origin!
          const hi = b.max[axis] + origin!
          const endsInside = step.kind === 'arc' && arcFrom !== null
            && arcFrom[axis] + origin! >= env.min - tolerance && arcFrom[axis] + origin! <= env.max + tolerance
            && arcTo[axis]! + origin! >= env.min - tolerance && arcTo[axis]! + origin! <= env.max + tolerance
          if (!Number.isFinite(lo) && !Number.isFinite(hi)) continue // axis not addressed yet
          if (lo < env.min - tolerance) {
            return { stepId: step.id, kind: step.kind, axis, reachesMm: lo, minMm: env.min, maxMm: env.max, bulge: endsInside }
          }
          if (hi > env.max + tolerance) {
            return { stepId: step.id, kind: step.kind, axis, reachesMm: hi, minMm: env.min, maxMm: env.max, bulge: endsInside }
          }
        }
      }
      from = stepEnd(step, from)
    }
  }
  return null
}

/** WO-2219: `stepSweptBounds` for a work step in a frame turned by
 *  `rotationDeg` about its origin. A line's end is turned (an X or Y the tool
 *  has not been given yet leaves BOTH turned axes unknown - each machine axis
 *  needs both); an arc is turned whole, ends and centre, and its true sweep
 *  measured there. */
function turnedStepSweptBounds(step: QueuedMove, from: MachineVec3 | null, rotationDeg: number): Bounds3 | null {
  if (step.kind === 'line') {
    const p = turnWorkPoint(stepEnd(step, from)!, rotationDeg)
    const lo = (v: number) => (Number.isNaN(v) ? Infinity : v)
    const hi = (v: number) => (Number.isNaN(v) ? -Infinity : v)
    return { min: { x: lo(p.x), y: lo(p.y), z: lo(p.z) }, max: { x: hi(p.x), y: hi(p.y), z: hi(p.z) } }
  }
  if (step.kind === 'arc') {
    if (from === null || Number.isNaN(from.x) || Number.isNaN(from.y)) return null
    const start = turnWorkPoint({ x: from.x, y: from.y, z: Number.isNaN(from.z) ? step.to.z : from.z }, rotationDeg)
    return arcSweptBounds(start, turnWorkPoint(step.to, rotationDeg), turnWorkPoint(step.centre, rotationDeg), step.clockwise)
  }
  return null
}

/** The refusal, in the operator's words. */
export function describeTravelOffence(offence: TravelOffence, program: MachineProgram): string {
  const trace = program.index[offence.stepId]
  const where = trace && 'moveOrdinal' in trace ? `move ${trace.moveOrdinal}, ` : ''
  const what = offence.kind === 'arc' ? 'an arc' : 'a line'
  const fmt = (v: number) => v.toFixed(3).replace(/\.?0+$/, '')
  return (
    `Step ${offence.stepId} (${where}${what}) reaches ${offence.axis.toUpperCase()} ${fmt(offence.reachesMm)}, ` +
    `outside the ${offence.axis.toUpperCase()} travel ${fmt(offence.minMm)}..${fmt(offence.maxMm)}` +
    (offence.bulge ? ', although both of its ends are inside: the arc bulges off the table' : '') +
    '. The whole program is refused and nothing was staged.'
  )
}

/** Where a program's steps trace back to. The caller knows which operation and
 *  setup it is building; the builder only records it. */
export interface ProgramTrace {
  opId: string
  setupId: string
}

/** Resolved spindle intent supplied by the caller that owns the operation,
 * tool and machine records. The builder records it; it never resolves a
 * second answer of its own. */
export interface ProgramSpindle {
  rpm: number
  direction: 'cw' | 'ccw'
}

export type BuildProgramResult =
  | {
      ok: true
      program: MachineProgram
      /**
       * HOW MANY MOVES THIS IS, REPORTED UP FRONT (WO-1044).
       *
       * The count of steps that will occupy a slot in the controller's staged
       * move list - which is the number the board's ceiling is measured
       * against (`ControllerCapabilities.maxProgramMoves`). It is reported by
       * the BUILDER, not counted later by each caller, so the product can say
       * whether a toolpath fits - and how many programs it would take - before
       * Cycle Start and before anything reaches a wire.
       *
       * It is `steps.length` today, because this builder emits `line` steps
       * and nothing else. It stops being `steps.length` the moment an action
       * step exists, and a caller that reached for the shorter expression
       * would then be counting spindle-on frames against a motion buffer.
       */
      motionCount: number
      /**
       * WO-1285: the arc-aware box of the program in WORK coordinates (every
       * line end, plus every arc's true swept extent), or null when it moves
       * nothing. The endpoint box `boundsOfPoints` gives is NOT this on a
       * program with arcs: a bulge is the part of an arc no endpoint reaches.
       */
      bounds: Bounds3 | null
    }
  | { ok: false; reason: string }

/**
 * Build a straight-line `MachineProgram` from WORLD-coordinate toolpath moves.
 *
 * `rapidFeedMmMin` is the machine definition's declared rapid rate, RESOLVED BY
 * THE CALLER - the same reader the text door uses. It is a parameter and not a
 * lookup precisely so this file has no way to invent one: a program containing
 * a rapid, built with no positive rapid rate, refuses.
 *
 * Refuses rather than repairs, and every refusal names the offending move by
 * its ordinal in the input array - the same ordinal `index` records - because a
 * program is built by code and read by a person.
 */
export function buildStraightLineProgram(
  moves: readonly ToolpathMove[],
  wcs: WCS,
  rapidFeedMmMin: number,
  trace: ProgramTrace,
  spindle?: ProgramSpindle,
  /** Where the tool already is, in the same WORLD coordinates as `moves`, when
   *  the caller knows it (a typed MDI line, or a program loaded onto a
   *  connected machine) - so the first move needs no move of its own before it
   *  to start an arc from. Null/absent when nothing is known, which is a file
   *  built with no machine attached: its first arc is still refused. */
  startPosition?: Point3 | null,
): BuildProgramResult {
  const steps: ProgramStep[] = []
  const index: ProgramIndex = {}
  // No motion means no controller completion edge, so it must also mean no
  // spindle start. This local fact drives both emission and id allocation.
  const carriesSpindle = spindle !== undefined && moves.length > 0

  if (carriesSpindle) {
    const step: ProgramStep = {
      id: RESERVED_PROGRAM_ID + 1,
      kind: 'spindle',
      direction: spindle.direction,
      rpm: spindle.rpm,
    }
    steps.push(step)
    index[step.id] = { action: true }
  }

  // Where the tool is BEFORE each move, in world coordinates: an arc's swept
  // geometry (and its helical / full-circle / malformed refusals) is defined
  // by both ends, and its start is the previous move's end - or, for the very
  // first move, wherever the caller already knows the tool to be.
  let previous: Point3 | null = startPosition ?? null

  for (let moveOrdinal = 0; moveOrdinal < moves.length; moveOrdinal++) {
    const move = moves[moveOrdinal]

    if (move.type === 'arc_cw' || move.type === 'arc_ccw') {
      const refusal = arcRefusal(moveOrdinal, move, previous)
      if (refusal !== null) return { ok: false, reason: refusal }
    }

    // The feed each move type is entitled to, and nothing else. A rapid has no
    // feed of its own - `ToolpathMove.feed` is undefined on one - so it gets
    // the machine's declared rapid rate, which the caller resolved. A feed move
    // carries its own. Neither borrows the other's.
    const feedMmMin = move.type === 'rapid' ? rapidFeedMmMin : move.feed
    if (!(typeof feedMmMin === 'number' && feedMmMin > 0)) {
      return {
        ok: false,
        reason:
          move.type === 'rapid'
            ? `Move ${moveOrdinal} is a rapid and the machine's rapid rate was not resolved ` +
              `(got ${describe(rapidFeedMmMin)}); a feed has to come from the machine, never from here.`
            : `Move ${moveOrdinal} is a feed move with no feed rate (got ${describe(move.feed)}); ` +
              `a feed has to come from the machine, never from here.`,
      }
    }

    // WORLD -> WORK. The one shared transform, the same one the post applies
    // (ADR-0043 section 3), so the two routes cannot disagree about where the
    // tool goes. Nothing is shifted toward the machine frame here.
    const workTo: MachinePosition = {
      ...toWork(move, wcs),
      ...(typeof move.a === 'number' ? { a: move.a } : {}),
      ...(typeof move.b === 'number' ? { b: move.b } : {}),
      ...(typeof move.c === 'number' ? { c: move.c } : {}),
    }
    const textFacts = move as ToolpathMove & TextMoveFacts
    const machineAbsolute = textFacts.machineAbsolute
    const lineTo: Partial<MachinePosition> = textFacts.executionAxes === undefined
      ? workTo
      : Object.fromEntries(textFacts.executionAxes.flatMap((axis) => (
          typeof workTo[axis] === 'number' ? [[axis, workTo[axis]]] : []
        )))

    // Ids from 1: `RESERVED_PROGRAM_ID` (0) is the bridge's connect sentinel
    // (`Machine.cs:426`), so a step numbered 0 is indistinguishable from
    // "nothing has started yet".
    const id = RESERVED_PROGRAM_ID + 1 + moveOrdinal + (carriesSpindle ? 1 : 0)

    const step: QueuedMove = move.type === 'arc_cw' || move.type === 'arc_ccw'
      ? {
          id,
          kind: 'arc',
          to: workTo,
          // THE CENTRE GOES THROUGH THE SAME TRANSFORM AS THE END. A centre
          // left in world coordinates against an end in work coordinates is an
          // arc of the wrong radius about the wrong point (the bridge says the
          // same of its own offset, `Machine.cs:5162`).
          //
          // ITS Z IS THE END'S Z, on a helix exactly as on a planar arc
          // (WO-1337). An XY arc turns about an axis PARALLEL TO Z, so no point
          // on that axis is more the centre than any other and `CZ` cannot
          // define the circle; the one rule that has always held here - centre
          // Z equals endpoint Z - keeps holding, and on a planar arc it is
          // byte-for-byte what WO-1285 pinned. What it must NOT become is a
          // second opinion about where the helix ends: the endpoint Z above is
          // the only Z that steers the machine.
          centre: toWork({ x: move.cx!, y: move.cy!, z: move.z }, wcs),
          // `arc_cw` is clockwise seen from +Z, and the bridge already applies
          // the inversion its API needs (measured 2026-08-25); nothing is
          // inverted here.
          clockwise: move.type === 'arc_cw',
          plane: 'xy',
          feedMmMin,
        }
      : {
          id,
          kind: 'line',
          to: lineTo,
          feedMmMin,
          // `rapid` is `true`-only and deliberately absent on a cutting move: an
          // unmarked line IS a feed move, and a tri-state would invite a backend to
          // read "absent" as a third thing. It carries no feed and changes no
          // motion - it exists so instruments can tell positioning from cutting.
          ...(move.type === 'rapid' ? { rapid: true as const } : {}),
        }

    if (step.kind === 'line' && machineAbsolute !== undefined) {
      // Internal geometry consumers retain the full work-coordinate endpoint
      // they already use. At the wire (`machineMoveWireForm`) this one G53
      // line becomes its partial machine target and declares that the bridge
      // must not apply the active work offset. WO-1897: and it keeps saying so
      // through every copy of the step, because the facts are the step's own
      // data now rather than metadata hidden from a spread.
      markMachineAbsoluteLine(step, machineAbsolute)
    }

    steps.push(step)
    index[id] = { opId: trace.opId, setupId: trace.setupId, moveOrdinal }
    previous = { x: move.x, y: move.y, z: move.z }
  }

  if (carriesSpindle) {
    const step: ProgramStep = {
      id: RESERVED_PROGRAM_ID + moves.length + 2,
      kind: 'spindle',
      direction: 'off',
    }
    steps.push(step)
    index[step.id] = { action: true }
  }

  const program: MachineProgram = { frame: 'work', units: 'mm', steps, index }

  // The builder answers to the same validator the backend does. If this ever
  // fails, the bug is here and not at the wire, and the caller learns it before
  // anything reaches a machine.
  const verdict = validateMachineProgram(program)
  if (!verdict.ok) {
    return { ok: false, reason: `The built program did not validate: ${verdict.reason}` }
  }

  return {
    ok: true,
    program,
    motionCount: program.steps.filter(isStagedMove).length,
    bounds: programSweptBounds(program),
  }
}

/**
 * WO-1285, widened by WO-1337: what an arc must be before it is emitted, in the
 * operator's words. What passes is an XY arc of positive radius whose two ends
 * sit on the same circle and do not coincide - planar or HELICAL, because the
 * endpoint Z is a field the wire has always carried.
 *
 * Every test below is an XY test. A helix is that same circle with Z ramping
 * along it, so a Z change can make an arc neither malformed nor ambiguous, and
 * the checks are written against the projection rather than the path.
 */
function arcRefusal(moveOrdinal: number, move: ToolpathMove, previous: Point3 | null): string | null {
  const name = `Move ${moveOrdinal} is an ${move.type}`
  if (move.a !== undefined || move.b !== undefined || move.c !== undefined) {
    return `${name} with a rotary A/B/C endpoint; rotary interpolation on an arc is not modeled, so it cannot be sent.`
  }
  if (previous === null) {
    return `${name} with no move before it, so where the arc starts is unknown; an arc has to follow a move.`
  }
  if (!(typeof move.cx === 'number' && Number.isFinite(move.cx) && typeof move.cy === 'number' && Number.isFinite(move.cy))) {
    return `${name} with no usable centre (got cx=${describe(move.cx)}, cy=${describe(move.cy)}); an arc without a centre cannot be sent.`
  }
  // WO-1337: A Z CHANGE IS NO LONGER A REFUSAL. An endpoint Z different from
  // the start is a HELIX, which the wire has always been able to say and this
  // builder used to forbid. Everything below is measured IN XY on purpose - the
  // radius agreement, the zero radius and the full circle are all facts about
  // the circle the arc is projected onto, and a Z ramp changes none of them.
  const r0 = Math.hypot(previous.x - move.cx, previous.y - move.cy)
  const r1 = Math.hypot(move.x - move.cx, move.y - move.cy)
  if (r0 <= ARC_RADIUS_TOLERANCE_MM || r1 <= ARC_RADIUS_TOLERANCE_MM) {
    return `${name} of zero radius (an end sits on its own centre); it cannot be sent.`
  }
  if (Math.abs(r0 - r1) > ARC_RADIUS_TOLERANCE_MM) {
    return (
      `${name} whose ends are ${r0.toFixed(3)} and ${r1.toFixed(3)} mm from its centre: the two ends ` +
      'are not on one circle, so this arc is malformed and would cut a shape nobody drew.'
    )
  }
  if (Math.hypot(move.x - previous.x, move.y - previous.y) <= ARC_FULL_CIRCLE_TOLERANCE_MM) {
    return (
      `${name} whose start and end coincide: a full circle is ambiguous about which way and how far, ` +
      'and our own post never emits one; split it into two arcs.'
    )
  }
  return null
}

/** A value in a refusal reason, printed as what it IS - so `undefined` reads as
 *  "not declared" rather than disappearing into an empty string. Mirrors
 *  `validateMachineProgram`'s own wording. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing'
  return typeof value === 'string' ? `"${value}"` : String(value)
}
