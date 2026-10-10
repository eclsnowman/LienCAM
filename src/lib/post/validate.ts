// ============================================================
// Pre-emission validators (C-P0) — pure, never throw (ADR-0003)
// ============================================================
// Each returns PostDiagnostic[]; an empty array means "nothing to report".
// postProgram aggregates these and short-circuits on any 'error'.

import type { MachineConfig, Operation, ToolpathMove, WCS } from '../../types'
import { LEGACY_MODEL_ITEM_ID } from '../../doc/documentHolder'
import type { PostDiagnostic, PostOperation } from './types'
import { requestedSpindleRpm } from './resolve'

const EPS = 1e-6

/** Every used tool must have a defined numeric toolNumber, unique across the
 *  program. Missing -> error TOOL_NUMBER_MISSING. Duplicate -> TOOL_NUMBER_DUPLICATE,
 *  naming both tools so the Post Process screen can offer each its own number
 *  for the program (WO-2637).
 *  WO-2019: a number buildPostInput gave an unnumbered library tool is said
 *  once per tool -> info TOOL_NUMBER_ASSIGNED. */
export function validateToolNumbers(ops: PostOperation[]): PostDiagnostic[] {
  const diags: PostDiagnostic[] = []
  const seen = new Map<number, PostOperation['tool']>() // toolNumber -> first tool seen
  const told = new Set<string>()

  for (const { op, tool, toolNumberAssigned } of ops) {
    const n = tool.toolNumber
    if (toolNumberAssigned && n != null && !told.has(tool.id)) {
      told.add(tool.id)
      diags.push({
        level: 'info',
        code: 'TOOL_NUMBER_ASSIGNED',
        message: `Tool "${tool.name}" has no tool number, so it posts as T${n}. Give it a number in the tool library to choose another.`,
        opId: op.id,
      })
    }
    if (n == null) {
      diags.push({
        level: 'error',
        code: 'TOOL_NUMBER_MISSING',
        message: `Tool "${tool.name}" (used by operation "${op.name}") has no tool number. Assign a tool number in the tool library.`,
        opId: op.id,
      })
      continue
    }
    const prior = seen.get(n)
    if (prior != null && prior.id !== tool.id) {
      // WO-2637 (rule 11): the remedy is on the Post Process screen, for this
      // program only - never "renumber your library".
      diags.push({
        level: 'error',
        code: 'TOOL_NUMBER_DUPLICATE',
        message: `Tools "${prior.name}" and "${tool.name}" both have tool number ${n} in this program. ` +
          'Give one of them its own number for this program under "Tool numbers" on the Post Process screen; ' +
          'the tool library keeps its numbers.',
        opId: op.id,
        toolNumber: n,
        toolIds: [prior.id, tool.id],
      })
    } else if (prior == null) {
      seen.set(n, tool)
    }
  }
  return diags
}

/** WO-2019: several setups (one combined program, or one file each) each say
 *  the same assigned number; the operator reads it once. */
export function onceEachAssignedToolNumber(diags: PostDiagnostic[]): PostDiagnostic[] {
  const said = new Set<string>()
  return diags.filter((d) => {
    if (d.code !== 'TOOL_NUMBER_ASSIGNED') return true
    if (said.has(d.message)) return false
    said.add(d.message)
    return true
  })
}

function vecLength(v: { x: number; y: number; z: number }): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

function dot3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function cross3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

/** The WCS axes must describe a pure rotation about Z (yaw) - the only
 *  transform any of this app's three dialects can honour, since none emits a
 *  rotation word to the controller; a rotated frame is baked into posted
 *  coordinates host-side instead (docs/research/probing-angle-compensation.md).
 *  Accepted: orthonormal, right-handed, zAxis vertical, within EPS -
 *  this includes the identity basis (t=0) as the trivial case. Refused, each
 *  with its own message: a non-orthonormal basis (not a rotation at all), a
 *  tilted zAxis (rotation about X/Y - a 3-axis head cannot lean the tool to
 *  follow it, so this is not yaw), or a mirrored/left-handed basis (not any
 *  rotation) -> error WCS_ROTATED. */
export function detectRotatedWcs(wcs: WCS): PostDiagnostic[] {
  const { xAxis, yAxis, zAxis } = wcs
  const refuse = (message: string): PostDiagnostic[] => [{
    level: 'error',
    code: 'WCS_ROTATED',
    message: `WCS "${wcs.label}" ${message}`,
  }]

  const unitLength = (v: { x: number; y: number; z: number }) => Math.abs(vecLength(v) - 1) < EPS
  const orthonormal =
    unitLength(xAxis) && unitLength(yAxis) && unitLength(zAxis) &&
    Math.abs(dot3(xAxis, yAxis)) < EPS &&
    Math.abs(dot3(xAxis, zAxis)) < EPS &&
    Math.abs(dot3(yAxis, zAxis)) < EPS
  if (!orthonormal) {
    return refuse(
      'axes are not an orthonormal basis (each must be unit length and mutually perpendicular); ' +
      'rotated work coordinate systems are only supported for a well-formed rotation.',
    )
  }

  const zVertical =
    Math.abs(zAxis.x) < EPS && Math.abs(zAxis.y) < EPS && Math.abs(zAxis.z - 1) < EPS
  if (!zVertical) {
    return refuse(
      'zAxis is not vertical; only a rotation about Z (yaw) is supported by the postprocessor, not a tilt - ' +
      'a 3-axis head cannot lean the tool to follow it.',
    )
  }

  const cross = cross3(xAxis, yAxis)
  const rightHanded =
    Math.abs(cross.x - zAxis.x) < EPS &&
    Math.abs(cross.y - zAxis.y) < EPS &&
    Math.abs(cross.z - zAxis.z) < EPS
  if (!rightHanded) {
    return refuse(
      'axes are mirrored (left-handed); only a right-handed rotation about Z is supported by the postprocessor.',
    )
  }

  return []
}

/** Every op in scope must be up to date (status 'ready') before it can be
 *  posted. Any other status is red and refuses the run loud (ADR-0003): the
 *  only status valid to post is 'ready'. This is the general fail-loud guard
 *  and is what catches a STALE NEST (editing a nest seed flips that nest's seed
 *  op to 'outdated', so the status check blocks it with no nest-specific code).
 *  One error diagnostic per offending op, keyed by opId. */
export function validateOpsCurrent(ops: PostOperation[]): PostDiagnostic[] {
  const diags: PostDiagnostic[] = []
  for (const { op } of ops) {
    if (op.status === 'ready') continue
    switch (op.status) {
      case 'outdated':
        diags.push({
          level: 'error',
          code: 'OP_OUTDATED',
          message: `Operation "${op.name}" is out of date - recompute it before posting.`,
          opId: op.id,
        })
        break
      case 'error':
        diags.push({
          level: 'error',
          code: 'OP_ERROR',
          message:
            `Operation "${op.name}" has an error - fix it before posting.` +
            (op.errorMessage ? ` (${op.errorMessage})` : ''),
          opId: op.id,
        })
        break
      case 'computing':
        diags.push({
          level: 'error',
          code: 'OP_COMPUTING',
          message: `Operation "${op.name}" is still computing - wait before posting.`,
          opId: op.id,
        })
        break
      case 'degraded':
        // CAM-1: a referenced model face/edge is GONE. The op holds a
        // last-known toolpath but the geometry it was cut from no longer
        // exists, so posting it would emit g-code for absent geometry -> refuse.
        diags.push({
          level: 'error',
          code: 'OP_DEGRADED',
          message:
            `Operation "${op.name}" is degraded - its model geometry changed; re-select geometry and recompute before posting.` +
            (op.modelReferenceNote ? ` (${op.modelReferenceNote})` : ''),
          opId: op.id,
        })
        break
      case 'pending':
        diags.push({
          level: 'error',
          code: 'OP_PENDING',
          message: `Operation "${op.name}" has not been computed - compute it before posting.`,
          opId: op.id,
        })
        break
      case 'unsupported':
        // CAM-BINDING Stage 1: sources a modeled body; no Stage 2 compute path
        // exists yet. Never postable - there is no toolpath to emit, exactly
        // like 'pending', but named so the refusal explains WHY.
        diags.push({
          level: 'error',
          code: 'OP_MODEL_SOURCE_UNSUPPORTED',
          message:
            `Operation "${op.name}" sources a modeled body, which cannot yet be computed - ` +
            `pick an imported/sketched part instead, or wait for compute support.` +
            (op.errorMessage ? ` (${op.errorMessage})` : ''),
          opId: op.id,
        })
        break
      default: {
        // Compiler-enforced exhaustiveness (CAM-1): a new OperationStatus that
        // reaches the post gate un-handled is a build error, never a silent
        // fall-through that would post an unvalidated op.
        const _exhaustive: never = op.status
        throw new Error(`validateOpsCurrent: unhandled operation status ${String(_exhaustive)}`)
      }
    }
  }
  return diags
}

/** Per-Model-Item session evidence. Boolean values remain accepted only for
 *  compatibility with older callers/tests: true means all and false means none.
 *  Product state uses the record form so one item's pass cannot authorize any
 *  other item that happens to reuse the same raw body id. */
export type ModelRefVerificationEvidence =
  | boolean
  | Readonly<Record<string, true>>

function itemWasVerified(evidence: ModelRefVerificationEvidence, modelItemId: string): boolean {
  return typeof evidence === 'boolean' ? evidence : evidence[modelItemId] === true
}

export function validateModelRefsVerifiedSinceLoad(
  ops: ReadonlyArray<Pick<Operation, 'id' | 'name' | 'modelReferences'>>,
  evidence: ModelRefVerificationEvidence,
): PostDiagnostic[] {
  const diags: PostDiagnostic[] = []
  for (const op of ops) {
    if ((op.modelReferences?.length ?? 0) === 0) continue
    const uncheckedItems = [...new Set(
      op.modelReferences!
        .map((ref) => ref.modelItemId ?? LEGACY_MODEL_ITEM_ID)
        .filter((modelItemId) => !itemWasVerified(evidence, modelItemId)),
    )]
    if (uncheckedItems.length === 0) continue
    diags.push({
      level: 'error',
      code: 'OP_MODEL_REFS_UNVERIFIED',
      message:
        // WO-2332: Post Process runs this check itself when it opens; this
        // remains only before that, or when the check could not run.
        `Operation "${op.name}" references modeled geometry that has not been checked against the ` +
        `current model yet (${uncheckedItems.join(', ')}) - Post Process checks it automatically when ` +
        `opened; if that check could not run, the console says why.`,
      opId: op.id,
    })
  }
  return diags
}

// ============================================================
// Program extent vs machine travel (WO-285)
// ============================================================
// The HONEST HALF of "does this program fit". Whether a program fits is really
// a question about where the job sits on the table, and that is decided at
// touch-off — only the control knows where G54 points, so the app cannot answer
// it offline and this check does not pretend to. What IS answerable from the
// two saved numbers alone: if the program's own extent in an axis is larger
// than that axis's travel, it does not fit ANYWHERE on that machine, wherever
// you set your zero. Extent is a difference, so it is unchanged by any offset —
// world-coordinate moves answer it exactly. The extent measured is the extent of
// the path the tool actually SWEEPS, arcs included, not just the points it stops
// at. Warning only, never an error: a machinist may have a reason, and refusing
// to post is not this check's call.

/** Tolerance (mm) for "the program is exactly as big as the travel". Equality is
 *  a FIT, not an overrun, and toolpath coordinates arrive through floating-point
 *  offset/transform math, so a tenth of a micron of slop is absorbed. Far below
 *  anything a machine can resolve, far above float noise. */
const TRAVEL_FIT_EPS_MM = 1e-4

const TRAVEL_AXES = [
  { key: 'x', label: 'X' },
  { key: 'y', label: 'Y' },
  { key: 'z', label: 'Z' },
] as const

/** Millimetres for a machinist to read: at most 3 decimals, no trailing zeros. */
function mm(value: number): string {
  return `${Number(value.toFixed(3))}`
}

// ---- The swept path of an arc, not just where it ends up -------------------
// An arc move records only its endpoint and centre, but the tool does not travel
// in a straight line to that endpoint — it bulges out to the circle. Measuring
// endpoints alone understates the real envelope by up to one radius per axis,
// and in the worst case by ALL of it: a bore cut as two half-sweeps has both
// endpoints on the same line, so the axis it bulges into measures an extent of
// zero and a program that plainly cannot run reads as a fit. Silence that can be
// read as "it fits" is the one thing this check exists to prevent, so the arc's
// true extremes are folded in below.

const ARC_EPS = 1e-9

/** Normalise a raw angle difference into [0, 2*PI]. */
function normalizeSweep(raw: number): number {
  let sweep = raw
  while (sweep < 0) sweep += Math.PI * 2
  while (sweep > Math.PI * 2) sweep -= Math.PI * 2
  return sweep
}

/**
 * Swept angle of an arc, in radians, in the direction it is actually cut.
 *
 * This mirrors `sampleArcMovesForLinearConsumers`
 * (src/lib/cam/toolpathArcSampling.ts), which owns this convention for every
 * linear consumer in the app — including the rule that an arc whose endpoint
 * equals its start with a valid centre is a FULL CIRCLE, not a zero-length move.
 * That helper's internals are module-private and its file is not this order's to
 * edit, so the convention is mirrored here and `postFitsMachine.wo285.test.ts`
 * cross-checks that the two measure the same path.
 */
function arcSweepRadians(
  start: { x: number; y: number },
  end: { x: number; y: number },
  center: { x: number; y: number },
  ccw: boolean,
): number {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x)
  const a1 = Math.atan2(end.y - center.y, end.x - center.x)
  let sweep = normalizeSweep(ccw ? a1 - a0 : a0 - a1)
  if (sweep < ARC_EPS && Math.hypot(end.x - start.x, end.y - start.y) < 1e-6) {
    sweep = Math.PI * 2
  }
  return sweep
}

/** The four points where a circle reaches its extreme X or Y, as
 *  (angle, unit x, unit y). A circle's furthest reach in an axis is always one of
 *  these, so an arc's extremes are its two endpoints plus whichever of these its
 *  sweep actually crosses. Unit vectors are exact integers, not cos/sin of a
 *  multiple of PI/2, so no float dust enters the envelope. */
const CARDINALS = [
  { angle: 0, ux: 1, uy: 0 },
  { angle: Math.PI / 2, ux: 0, uy: 1 },
  { angle: Math.PI, ux: -1, uy: 0 },
  { angle: (Math.PI * 3) / 2, ux: 0, uy: -1 },
] as const

/** How far an arc's two endpoint radii may disagree and still be treated as one
 *  circle (mm). CAM-computed arcs agree to float noise; ten microns is orders of
 *  magnitude above that and far below anything a machinist would call a radius.
 *  Beyond it the move is not a circle at all and is bounded conservatively. */
const ARC_RADIUS_SLOP_MM = 0.01

/**
 * Fold the extreme points of an arc's swept path into the envelope via `fold`.
 *
 * A circle reaches its furthest point in an axis only at a cardinal, so a
 * well-formed arc's extremes are its two endpoints (already folded by the
 * caller) plus whichever cardinals its sweep actually crosses.
 *
 * Z is skipped deliberately: an arc move ramps Z linearly from `prev.z` to
 * `move.z`, so its Z range is exactly its two endpoints. Anything that is not an
 * arc at all (a straight move, a missing/non-finite centre, a zero radius) folds
 * nothing here and is measured by its endpoints as before — the check never gets
 * LESS careful than it was.
 */
function foldArcSweptExtremes(
  prev: ToolpathMove,
  move: ToolpathMove,
  fold: (key: 'x' | 'y', value: number) => void,
): void {
  if (move.type !== 'arc_cw' && move.type !== 'arc_ccw') return
  const cx = move.cx
  const cy = move.cy
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return
  if (!Number.isFinite(prev.x) || !Number.isFinite(prev.y)) return
  if (!Number.isFinite(move.x) || !Number.isFinite(move.y)) return

  const center = { x: cx as number, y: cy as number }
  const r0 = Math.hypot(prev.x - center.x, prev.y - center.y)
  const r1 = Math.hypot(move.x - center.x, move.y - center.y)
  if (!(r0 > ARC_EPS) || !(r1 > ARC_EPS)) return
  // The larger of the two: no point on the swept path is ever further from the
  // centre than this, whatever the move turns out to be.
  const radius = Math.max(r0, r1)

  if (Math.abs(r1 - r0) > ARC_RADIUS_SLOP_MM) {
    // Endpoints that disagree on the radius are not a circle — the sampler walks
    // a spiral between them, and a spiral's extremes need not sit on a cardinal.
    // Rather than guess a shape from a malformed move, take the bound that holds
    // for ANY path between these radii: the box of the larger circle. That can
    // only over-report, and over-reporting is the safe side of a check whose
    // whole purpose is to never let an overrun pass as a fit.
    fold('x', center.x - radius); fold('x', center.x + radius)
    fold('y', center.y - radius); fold('y', center.y + radius)
    return
  }

  const ccw = move.type === 'arc_ccw'
  const sweep = arcSweepRadians(prev, move, center, ccw)
  if (!(sweep > ARC_EPS)) return

  const a0 = Math.atan2(prev.y - center.y, prev.x - center.x)
  const sign = ccw ? 1 : -1

  for (const { angle, ux, uy } of CARDINALS) {
    // How far into the sweep, in radians, this extreme sits. Past the end of the
    // sweep means the tool turns away before reaching it — it is not on the path.
    const along = normalizeSweep(sign * (angle - a0))
    if (along > sweep + ARC_EPS) continue
    fold('x', center.x + radius * ux)
    fold('y', center.y + radius * uy)
  }
}

/** The half of the placement question the app cannot answer, said plainly. Every
 *  message this validator emits carries it, so a warning is never mistaken for a
 *  verdict about where the job sits. */
const PLACEMENT_CAVEAT =
  'This compares sizes only - the app cannot know where the job sits on the table.'

/**
 * Warn when the posted program's extent exceeds the selected machine's travel in
 * any axis -> warning MACHINE_TRAVEL_EXCEEDED, one per offending axis, naming the
 * axis, the program's extent, the machine's travel and the overrun in mm.
 *
 * No machine selected, or a machine with no travel recorded for an axis, is
 * MACHINE_TRAVEL_NOT_CHECKED — never silence that could be read as "it fits".
 * Axes that DO carry a travel are still checked.
 */
export function validateProgramFitsMachine(
  machine: MachineConfig | null | undefined,
  ops: PostOperation[],
): PostDiagnostic[] {
  // Extent across every move of every op: one program, one envelope.
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  let measured = false
  const fold = (key: 'x' | 'y' | 'z', value: number): void => {
    if (!Number.isFinite(value)) return
    if (value < min[key]) min[key] = value
    if (value > max[key]) max[key] = value
    measured = true
  }
  for (const { moves } of ops) {
    let prev: ToolpathMove | undefined
    for (const move of moves) {
      for (const { key } of TRAVEL_AXES) fold(key, move[key])
      // Where the tool ENDS UP is only half the envelope: an arc bulges out to
      // its circle on the way, so fold in the extremes it actually sweeps
      // through. Needs the previous move for the arc's start point; the first
      // move of an op has none, and is measured by its endpoint alone.
      if (prev) foldArcSweptExtremes(prev, move, fold)
      prev = move
    }
  }
  // Nothing to measure: no moves at all. validateOpsReady owns that anomaly
  // (OP_NO_TOOLPATH); there is no extent to compare and nothing to say here.
  if (!measured) return []

  if (!machine) {
    return [{
      level: 'warning',
      code: 'MACHINE_TRAVEL_NOT_CHECKED',
      message:
        'Program size was not checked against machine travel: no machine is selected. ' +
        `Choose a machine so posting can compare the program against its travel. ${PLACEMENT_CAVEAT}`,
    }]
  }

  const machineName = machine.name?.trim() ? `"${machine.name.trim()}"` : 'this machine'
  const diags: PostDiagnostic[] = []
  const unrecorded: string[] = []

  for (const { key, label } of TRAVEL_AXES) {
    const travel = machine.travel?.[key]
    // A travel of 0 or a missing/non-finite number is NOT a zero-size machine,
    // it is a machine nobody typed a travel into. Say so; never call it a fit.
    if (typeof travel !== 'number' || !Number.isFinite(travel) || travel <= 0) {
      unrecorded.push(label)
      continue
    }
    const extent = max[key] - min[key]
    const overrun = extent - travel
    if (overrun <= TRAVEL_FIT_EPS_MM) continue
    diags.push({
      level: 'warning',
      code: 'MACHINE_TRAVEL_EXCEEDED',
      message:
        `Program ${label} extent ${mm(extent)} mm exceeds ${machineName} ${label} travel ` +
        `${mm(travel)} mm by ${mm(overrun)} mm. It does not fit anywhere on this machine, ` +
        `wherever you set your zero. ${PLACEMENT_CAVEAT}`,
    })
  }

  if (unrecorded.length > 0) {
    diags.push({
      level: 'warning',
      code: 'MACHINE_TRAVEL_NOT_CHECKED',
      message:
        `Program size was not checked against ${unrecorded.join('/')} travel: ${machineName} has ` +
        `no ${unrecorded.join('/')} travel recorded. Enter the travels in the Machine Library so ` +
        `posting can compare the program against them. ${PLACEMENT_CAVEAT}`,
    })
  }

  return diags
}

/** A 'ready' op must still carry at least one move -> OP_NO_TOOLPATH. This is a
 *  true anomaly: the op claims to be up to date yet produced no toolpath.
 *  Non-ready ops (outdated/pending/computing/error) are owned by
 *  validateOpsCurrent, so they are skipped here to avoid a duplicate diagnostic
 *  for the same op (a non-ready op also has empty moves). */
export function validateOpsReady(ops: PostOperation[]): PostDiagnostic[] {
  const diags: PostDiagnostic[] = []
  const reportedSpindleClamp = new Set<string>()
  for (const { op, tool, spindle, moves } of ops) {
    if (op.status !== 'ready') continue
    const askedRpm = requestedSpindleRpm(op, tool)
    if (askedRpm !== spindle.rpm && !reportedSpindleClamp.has(op.id)) {
      const machineLimit = askedRpm > spindle.rpm
        ? `this machine tops out at ${spindle.rpm}`
        : `this machine's minimum is ${spindle.rpm}`
      diags.push({
        level: 'info',
        code: 'SPINDLE_RPM_CLAMPED',
        message: `${op.name} asked ${askedRpm} rpm; ${machineLimit}, posted ${spindle.rpm}.`,
        opId: op.id,
      })
      reportedSpindleClamp.add(op.id)
    }
    if (moves.length === 0) {
      diags.push({
        level: 'error',
        code: 'OP_NO_TOOLPATH',
        message: `Operation "${op.name}" has no computed toolpath. Recompute it before posting.`,
        opId: op.id,
      })
    }
  }
  return diags
}
