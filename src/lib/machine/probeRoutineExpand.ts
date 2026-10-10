// WO-411 slice 2 - the probe routine EXPANDER (contract section 4.1-4.3 and
// 2.7's expansion errors, docs/research/probe-routine-format.md).
//
// Inputs bound, every position evaluated to an absolute machine coordinate,
// every feed looked up in the profile and clamped, every endpoint checked
// against the signed envelope and the probe travel limit, a content hash over
// everything the preview depended on. The result is the ONLY thing the runner
// (slice 3) executes; the runner never reads the routine JSON.
//
// Nothing here produces text the controller sees: the expander produces
// numbers. The three emitters live in machineSession.ts.
//
// This module is deliberately tolerant of an INVALID routine: the static
// validator (slice 1) has already named the static faults, and this pass
// reports only what needs the envelope, the start and the profile - so the
// contract's user.bad-slot example yields exactly its #3, #4 and #5 here
// while slice 1 yields the other eight. A step kind the vocabulary does not
// have, or an expression that does not parse, is skipped here (already
// reported statically), never guessed at.

import { ENVELOPE_FIT_TOLERANCE_MM, type MachineEnvelope } from './machineEnvelope'
import { formatPosition } from './positionFrames'
import { sha256Hex } from './programContext'
import {
  evaluateExpr,
  parseExpr,
  type ExprAst,
  type ExprEvalScope,
  type ProbeNamespaceMember,
  type TouchResultField,
} from './probeRoutineExpr'
import {
  canonicalRoutineJson,
  type ProbeRoutine,
  type ProbeRoutineAxis,
  type ProbeRoutineBranchStep,
  type ProbeRoutineCalcStep,
  type ProbeRoutineCheckStep,
  type ProbeRoutineComparison,
  type ProbeRoutineCondition,
  type ProbeRoutineDirection,
  type ProbeRoutineExpression,
  type ProbeRoutineInput,
  type ProbeRoutineMoveStep,
  type ProbeRoutineOutput,
  type ProbeRoutineStep,
  type ProbeRoutineTouchStep,
  type RoutineError,
  type RoutineErrorCode,
} from './probeRoutineFormat'
import { validateZProbeConfig, type EffectiveProbeConfig } from './toolTable'
import type { AxisFeedLimits } from '../../types'
import { TOOL_SETTER_INPUTS, type ToolSetterDefaults } from './probeRoutineFactory'

// --- public types ------------------------------------------------------------

export interface ExpandPoint {
  x: number
  y: number
  z: number
}

export type ExpandAxisKey = 'x' | 'y' | 'z'

/** The value a user typed for an input: a number for length / angle / count,
 *  a string for an enum. A missing entry takes the input's default. */
export type ProbeRoutineInputValues = Readonly<Record<string, number | string>>

export interface ProbeRoutineExpandContext {
  /** Machine coordinates where the probe is parked when the routine starts. */
  start: ExpandPoint
  envelope: MachineEnvelope
  /** The effective profile config (`resolveProbeConfig(machine.probing, override)`). */
  probe: EffectiveProbeConfig
  /** The Probing tab's tip radius, mm. */
  tipRadiusMm: number
  /** Per-axis feed ceilings from the machine profile, when it declares them. */
  axisLimits?: { x: AxisFeedLimits; y: AxisFeedLimits; z: AxisFeedLimits } | null
  /** The active work offset (G54..G59), named in `workOffset` proposals whose
   *  `wcs` is 'active'. Informational; nothing is written. */
  activeWcs?: string | null
}

/** How a feed got to the number the preview shows. `requested` is the profile
 *  value times the routine's factor (factor clamped to 1 - a routine never
 *  raises a feed); `applied` is after the per-axis ceiling. */
export interface ExpandedFeed {
  profileMmMin: number
  factor: number
  requestedMmMin: number
  appliedMmMin: number
  clampedBy: 'none' | 'factor' | 'axisLimit'
}

export type ExpandedArm = 'then' | 'else'

interface ExpandedStepBase {
  /** 1-based, document order, branch-arm steps counted in place (same numbering as the validator). */
  number: number
  name: string | null
  /** Enclosing branch arms, outermost first, e.g. ["3.then"]. Empty at top level. */
  arms: string[]
  label: string
}

export interface ExpandedMoveStep extends ExpandedStepBase {
  kind: 'move'
  /** Where the probe is expected to be before this move (machine mm). */
  from: ExpandPoint
  /** Machine mm, rounded to 4 decimals. For a touch-dependent move this is the NOMINAL endpoint. */
  target: ExpandPoint
  /** Which axes the step moves (the others stay). */
  axes: Array<'X' | 'Y' | 'Z'>
  feedMmMin: number
  feed: ExpandedFeed
  rapid: boolean
  /** True when an endpoint expression references an earlier touch: the
   *  runner must re-validate the real endpoint before emitting it. */
  touchDependent: boolean
  /** For a touch-dependent move, the endpoint evaluated at every contact
   *  extreme (nearest / farthest per referenced touch), as a componentwise
   *  band; null otherwise. Both corners were envelope-checked. */
  band: { low: ExpandPoint; high: ExpandPoint } | null
  /** The safe plane this routine declared (first move only), machine Z; null otherwise. */
  safeZ: number | null
  /** Slice 3: the frame the endpoint expressions are written in, and the
   *  expressions themselves per moved axis - the runner re-evaluates a
   *  touch-dependent endpoint with the REAL contacts before emitting it. */
  frame: 'start' | 'machine'
  exprs: Partial<Record<ExpandAxisKey, { source: string; ast: ExprAst }>>
  /** WO-2073: a Z descent run as a probe move at the search feed - it stops
   *  on contact, rises `contactRetractMm` and the routine carries on. Absent
   *  on an ordinary move. */
  stopOnContact?: true
  contactRetractMm?: number
}

export interface ExpandedTouchStep extends ExpandedStepBase {
  kind: 'touch'
  name: string
  axis: ProbeRoutineAxis
  direction: ProbeRoutineDirection
  searchMm: number
  retractMm: number
  backoffMm: number
  searchFeedMmMin: number
  finalFeedMmMin: number
  searchFeed: ExpandedFeed
  finalFeed: ExpandedFeed
  /** Machine mm where the search begins (the tracked position). */
  expectedStart: ExpandPoint
  /** start + direction * searchMm on the probed axis - an envelope-checked endpoint. */
  farEnd: ExpandPoint
  /** The nominal contact the preview assumes: start + direction * (searchMm - overtravel). */
  nominalContact: ExpandPoint
  /** Where the probe stands after the back-off, on the nominal contact. */
  expectedAfter: ExpandPoint
  /** Slice 3: the search expression, and whether it depends on an earlier
   *  touch (the runner re-evaluates it with the real contacts if so). */
  searchExpr: { source: string; ast: ExprAst }
  touchDependent: boolean
}

export interface ExpandedCalcStep extends ExpandedStepBase {
  kind: 'calc'
  name: string
  unit: ProbeRoutineCalcStep['unit']
  source: string
  ast: ExprAst
  /** Evaluated with nominal contacts; the runner recomputes with real ones. */
  nominalValue: number
  /** True when the value depends (directly or through a calc) on a touch. */
  touchDependent: boolean
}

export interface ExpandedCheckStep extends ExpandedStepBase {
  kind: 'check'
  condition: ExpandedCondition
  message: string
  /** The condition with nominal contacts; the runner decides with real ones. */
  nominalResult: boolean
  touchDependent: boolean
}

export interface ExpandedBranchStep extends ExpandedStepBase {
  kind: 'branch'
  condition: ExpandedCondition
  nominalArm: ExpandedArm
  touchDependent: boolean
  then: ExpandedStep[]
  else: ExpandedStep[]
}

export type ExpandedStep =
  | ExpandedMoveStep
  | ExpandedTouchStep
  | ExpandedCalcStep
  | ExpandedCheckStep
  | ExpandedBranchStep

export interface ExpandedComparison {
  cmp: ProbeRoutineComparison['cmp']
  left: { source: string; ast: ExprAst }
  right: { source: string; ast: ExprAst }
}

export type ExpandedCondition =
  | { all: ExpandedComparison[] }
  | { any: ExpandedComparison[] }

/** A proposal with its expressions still unevaluated (they need real
 *  contacts). `wcs` / `tool` enum references are resolved to the bound input
 *  value; 'active' stays 'active' with `activeWcs` beside it. */
export type ExpandedProposal =
  | {
      kind: 'workOffset'
      wcs: string
      activeWcs: string | null
      axes: Partial<Record<'X' | 'Y' | 'Z', { source: string; ast: ExprAst }>>
      label: string
      compensationNote: string | null
    }
  | { kind: 'toolLength'; tool: 'active' | number; machineZ: { source: string; ast: ExprAst }; label: string }
  | { kind: 'report'; items: Array<{ label: string; expr: { source: string; ast: ExprAst }; unit: string }> }

export interface ExpandedRoutine {
  routineId: string
  routineName: string
  /** The inputs as bound: defaults filled in, numbers for numeric inputs. */
  inputs: Record<string, number | string>
  start: ExpandPoint
  /** The probe namespace the expressions saw, plus the three feeds. */
  profile: {
    tipRadiusMm: number
    retractMm: number
    surfaceClearanceMm: number
    overtravelMm: number
    maxTravelMm: number
    crossOverLiftMm: number
    positioningFeedMmMin: number
    searchFeedMmMin: number
    finalFeedMmMin: number
  }
  steps: ExpandedStep[]
  proposals: ExpandedProposal[]
  /** Where the probe is expected to stand when the routine ends (nominal). */
  end: ExpandPoint
  /** sha-256 hex of (canonical routine JSON + inputs + start + profile values + tip radius + axis limits + envelope + active WCS). */
  hash: string
}

export type ExpandProbeRoutineResult =
  | { ok: true; expanded: ExpandedRoutine; errors: [] }
  | { ok: false; expanded: null; errors: RoutineError[] }

// --- helpers -----------------------------------------------------------------

const AXIS_KEYS: readonly ExpandAxisKey[] = ['x', 'y', 'z']
const ENUM_REF_RE = /^\$input\.([a-zA-Z][a-zA-Z0-9_]{0,31})$/
const EQUALITY_TOLERANCE = 1e-6

function round4(value: number): number {
  return Number(value.toFixed(4))
}

/** A coordinate for a sentence: at least one decimal, at most four ("-1300.0", "-412.25"). */
export function formatCoordinate(value: number): string {
  const fixed = round4(value)
  if (Number.isInteger(fixed)) return fixed.toFixed(1)
  return String(fixed)
}

/** An envelope bound for a sentence: up to four decimals, no trailing zeros ("-812.8", "0"). */
export function formatBound(value: number): string {
  return String(round4(value))
}

function formatFeed(value: number): string {
  return String(Number(value.toFixed(1)))
}

function axisLetter(key: ExpandAxisKey): 'X' | 'Y' | 'Z' {
  return key.toUpperCase() as 'X' | 'Y' | 'Z'
}

/** WO-1667: one machine-coordinate value through the one position formatter
 *  ("machine Z 50.0"). A routine is written in machine coordinates. */
function machineAt(key: ExpandAxisKey, value: number): string {
  return formatPosition({ machine: { [key]: value }, format: formatCoordinate })
}

function stepPrefix(step: { number: number; kind: string; name: string | null }): string {
  return step.name ? `Step ${step.number} (${step.kind} '${step.name}')` : `Step ${step.number} (${step.kind})`
}

function refsOf(ast: ExprAst, out: Array<Extract<ExprAst, { type: 'ref' }>> = []): Array<Extract<ExprAst, { type: 'ref' }>> {
  if (ast.type === 'ref') out.push(ast)
  else if (ast.type === 'neg') refsOf(ast.arg, out)
  else if (ast.type === 'bin') {
    refsOf(ast.left, out)
    refsOf(ast.right, out)
  }
  return out
}

/** Whether this point is inside the envelope on every KNOWN axis (section 4.2:
 *  WO-377 semantics, ENVELOPE_FIT_TOLERANCE_MM of rounding slack - on the edge
 *  is inside, a hair beyond the slack is outside). Returns the first offending
 *  axis, or null. */
export function pointOutsideEnvelope(
  point: ExpandPoint,
  envelope: MachineEnvelope,
  tolerance: number = ENVELOPE_FIT_TOLERANCE_MM,
): { axis: ExpandAxisKey; value: number; min: number; max: number } | null {
  for (const axis of AXIS_KEYS) {
    const bounds = envelope[axis]
    if (!bounds) continue
    const value = point[axis]
    if (!Number.isFinite(value) || value < bounds.min - tolerance || value > bounds.max + tolerance) {
      return { axis, value, min: bounds.min, max: bounds.max }
    }
  }
  return null
}

/** WO-2554: an XY wall seek can touch before its requested far end. Bound
 *  it at the table edge instead of refusing a reachable wall. The runner
 *  applies the same bound from the real position after contact/back-off. */
export function boundProbeRoutineWallSearch(
  axis: ProbeRoutineAxis,
  direction: ProbeRoutineDirection,
  searchMm: number,
  from: ExpandPoint,
  envelope: MachineEnvelope,
): number {
  if (axis === 'Z') return searchMm
  const key = axis.toLowerCase() as ExpandAxisKey
  const bounds = envelope[key]
  if (!bounds || pointOutsideEnvelope(from, envelope)) return searchMm
  const room = direction === '+' ? bounds.max - from[key] : from[key] - bounds.min
  return Math.min(searchMm, Math.max(0, room))
}

function clampFeed(profileMmMin: number, factorRaw: number | undefined, ceiling: number | null): ExpandedFeed {
  const factorIn = typeof factorRaw === 'number' && Number.isFinite(factorRaw) && factorRaw > 0 ? factorRaw : 1
  const factor = Math.min(1, factorIn)
  const requested = profileMmMin * factor
  let applied = requested
  let clampedBy: ExpandedFeed['clampedBy'] = factorIn > 1 ? 'factor' : 'none'
  if (ceiling !== null && Number.isFinite(ceiling) && ceiling > 0 && ceiling < applied) {
    applied = ceiling
    clampedBy = 'axisLimit'
  }
  return {
    profileMmMin,
    factor,
    requestedMmMin: round4(requested),
    appliedMmMin: round4(applied),
    clampedBy,
  }
}

// --- the expander ------------------------------------------------------------

interface Cursor {
  number: number
}

interface Frame {
  /** Touch results visible here, nominal. */
  touch: Record<string, Record<TouchResultField, number>>
  calc: Record<string, number>
  /** Names whose value depends on a touch (touches themselves, and calcs over them). */
  touchDependent: Set<string>
  /** Per touch: the nominal contact point and the near / far extreme contacts. */
  touchExtremes: Record<string, { near: Record<TouchResultField, number>; far: Record<TouchResultField, number> }>
  /** Calcs in definition order (to recompute touch-dependent ones in each extreme world). */
  calcOrder: Array<[string, ExprAst]>
}

function childFrame(parent: Frame): Frame {
  return {
    touch: { ...parent.touch },
    calc: { ...parent.calc },
    touchDependent: new Set(parent.touchDependent),
    touchExtremes: { ...parent.touchExtremes },
    calcOrder: [...parent.calcOrder],
  }
}

class Expander {
  readonly errors: RoutineError[] = []
  private readonly routine: ProbeRoutine
  private readonly ctx: ProbeRoutineExpandContext
  private readonly inputValues: Record<string, number | string> = {}
  private readonly numericInputs: Record<string, number> = {}
  private readonly enumInputs: Record<string, string> = {}
  private readonly probeNs: Record<ProbeNamespaceMember, number>
  private readonly cursor: Cursor = { number: 0 }
  private safeZ: number | null = null
  private seenFirstMove = false

  constructor(routine: ProbeRoutine, inputs: ProbeRoutineInputValues, ctx: ProbeRoutineExpandContext) {
    this.routine = routine
    this.ctx = ctx
    this.probeNs = {
      tipRadiusMm: ctx.tipRadiusMm,
      retractMm: ctx.probe.retract,
      surfaceClearanceMm: ctx.probe.surfaceClearance,
      overtravelMm: ctx.probe.overtravel,
      maxTravelMm: ctx.probe.maxTravel,
      crossOverLiftMm: ctx.probe.crossOverLift,
    }
    this.bindInputs(inputs)
  }

  // -- emit

  private routineError(code: RoutineErrorCode, path: string, detail: string): void {
    this.errors.push({
      code,
      where: 'routine',
      step: null,
      index: null,
      path,
      detail,
      sentence: `Routine '${this.routine.name}': ${detail}`,
    })
  }

  private inputError(code: RoutineErrorCode, index: number, name: string, path: string, detail: string): void {
    this.errors.push({ code, where: 'input', step: null, index, path, detail, sentence: `Input '${name}': ${detail}` })
  }

  private stepError(
    code: RoutineErrorCode,
    step: { number: number; kind: string; name: string | null },
    path: string,
    detail: string,
  ): void {
    this.errors.push({
      code,
      where: 'step',
      step: { number: step.number, kind: step.kind, name: step.name },
      index: null,
      path,
      detail,
      sentence: `${stepPrefix(step)}: ${detail}`,
    })
  }

  // -- inputs (section 2.3, E_INPUT_OUT_OF_RANGE)

  private bindInputs(given: ProbeRoutineInputValues): void {
    const declared = Array.isArray(this.routine.inputs) ? this.routine.inputs : []
    const names = new Set<string>()
    declared.forEach((input: ProbeRoutineInput, i) => {
      if (!input || typeof input.name !== 'string') return
      names.add(input.name)
      const path = `inputs[${i}]`
      const raw = Object.prototype.hasOwnProperty.call(given, input.name) ? given[input.name] : input.default
      if (input.type === 'enum') {
        const options = Array.isArray(input.options) ? input.options : []
        if (typeof raw !== 'string' || !options.includes(raw)) {
          this.inputError(
            'E_INPUT_OUT_OF_RANGE',
            i + 1,
            input.name,
            path,
            `'${String(raw)}' is not one of the choices (${options.map((o) => `'${o}'`).join(', ')}).`,
          )
          return
        }
        this.inputValues[input.name] = raw
        this.enumInputs[input.name] = raw
        return
      }
      const value = typeof raw === 'number' ? raw : Number(raw)
      if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value)) {
        this.inputError('E_INPUT_OUT_OF_RANGE', i + 1, input.name, path, 'it needs a number before the routine can be previewed.')
        return
      }
      const unit = input.type === 'length' ? ' mm' : input.type === 'angle' ? ' deg' : ''
      const min = (input as { min?: unknown }).min
      const max = (input as { max?: unknown }).max
      const hasBounds = typeof min === 'number' && typeof max === 'number' && Number.isFinite(min) && Number.isFinite(max)
      if (hasBounds && (value < min || value > max)) {
        this.inputError(
          'E_INPUT_OUT_OF_RANGE',
          i + 1,
          input.name,
          path,
          `${formatBound(value)}${unit} is outside the allowed range ${formatBound(min)} to ${formatBound(max)}${unit}.`,
        )
        return
      }
      if (input.type === 'count' && !Number.isInteger(value)) {
        this.inputError('E_INPUT_OUT_OF_RANGE', i + 1, input.name, path, `${formatBound(value)} is not a whole number.`)
        return
      }
      this.inputValues[input.name] = value
      this.numericInputs[input.name] = value
    })
    for (const key of Object.keys(given)) {
      if (!names.has(key)) {
        this.routineError('E_FIELD_INVALID', `inputs.${key}`, `there is no input named '${key}' in this routine, so the value given for it cannot be used.`)
      }
    }
  }

  // -- expressions

  private scope(frame: Frame): ExprEvalScope {
    return {
      input: this.numericInputs,
      touch: frame.touch,
      calc: frame.calc,
      probe: this.probeNs,
      start: this.ctx.start,
    }
  }

  /** Parse; null (skipped, already reported statically) when the expression has static faults. */
  private parse(expr: ProbeRoutineExpression | undefined): { source: string; ast: ExprAst } | null {
    if (expr === undefined || expr === null) return null
    if (typeof expr !== 'string' && typeof expr !== 'number') return null
    const parsed = parseExpr(expr)
    if (!parsed.ast || parsed.faults.length > 0) return null
    return { source: parsed.source, ast: parsed.ast }
  }

  /** Evaluate against the frame; a fault is reported as E_CALC_NOT_FINITE (non-finite)
   *  and otherwise skipped (a name missing here was reported statically). */
  private evalAt(
    parsed: { source: string; ast: ExprAst },
    frame: Frame,
    step: { number: number; kind: string; name: string | null },
    path: string,
  ): number | null {
    const result = evaluateExpr(parsed.ast, this.scope(frame))
    if (result.ok) return result.value
    if (result.fault.code === 'E_CALC_NOT_FINITE') {
      this.stepError('E_CALC_NOT_FINITE', step, path, `\`${parsed.source}\` does not come out as a number with these inputs (division by zero or overflow).`)
    }
    return null
  }

  private dependsOnTouch(ast: ExprAst, frame: Frame): boolean {
    return refsOf(ast).some((ref) =>
      (ref.namespace === 'touch')
      || (ref.namespace === 'calc' && frame.touchDependent.has(ref.name)))
  }

  /** The touch names an expression depends on, directly or through calcs (for the band). */
  private touchNamesOf(ast: ExprAst, calcAsts: Map<string, ExprAst>): Set<string> {
    const out = new Set<string>()
    const visit = (node: ExprAst, depth: number): void => {
      if (depth > 64) return
      for (const ref of refsOf(node)) {
        if (ref.namespace === 'touch') out.add(ref.name)
        else if (ref.namespace === 'calc') {
          const calcAst = calcAsts.get(ref.name)
          if (calcAst) visit(calcAst, depth + 1)
        }
      }
    }
    visit(ast, 0)
    return out
  }

  // -- enum references on step fields

  private resolveEnum(value: unknown, allowed: readonly string[]): string | null {
    if (typeof value !== 'string') return null
    const m = ENUM_REF_RE.exec(value)
    if (m) {
      const bound = this.enumInputs[m[1]]
      return typeof bound === 'string' && allowed.includes(bound) ? bound : null
    }
    return allowed.includes(value) ? value : null
  }

  // -- conditions

  private expandCondition(
    condition: ProbeRoutineCondition | undefined,
    frame: Frame,
    step: { number: number; kind: string; name: string | null },
    path: string,
  ): { condition: ExpandedCondition; result: boolean; touchDependent: boolean } | null {
    if (!condition || typeof condition !== 'object') return null
    const list: ProbeRoutineComparison[] = 'all' in condition
      ? condition.all
      : 'any' in condition
        ? condition.any
        : [condition as ProbeRoutineComparison]
    if (!Array.isArray(list)) return null
    const mode: 'all' | 'any' = 'any' in condition ? 'any' : 'all'
    const comparisons: ExpandedComparison[] = []
    const results: boolean[] = []
    let touchDependent = false
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (!c || typeof c !== 'object') return null
      const left = this.parse(c.left)
      const right = this.parse(c.right)
      if (!left || !right) return null
      const sub = 'all' in condition || 'any' in condition ? `${path}.${mode}[${i}]` : path
      const l = this.evalAt(left, frame, step, `${sub}.left`)
      const r = this.evalAt(right, frame, step, `${sub}.right`)
      if (l === null || r === null) return null
      comparisons.push({ cmp: c.cmp, left, right })
      results.push(compare(c.cmp, l, r))
      if (this.dependsOnTouch(left.ast, frame) || this.dependsOnTouch(right.ast, frame)) touchDependent = true
    }
    const result = mode === 'all' ? results.every(Boolean) : results.some(Boolean)
    return {
      condition: mode === 'all' ? { all: comparisons } : { any: comparisons },
      result,
      touchDependent,
    }
  }

  // -- steps

  expandSteps(
    steps: ProbeRoutineStep[],
    frame: Frame,
    pos: ExpandPoint,
    arms: string[],
    calcAsts: Map<string, ExprAst>,
  ): { steps: ExpandedStep[]; end: ExpandPoint } {
    const out: ExpandedStep[] = []
    let current = pos
    if (!Array.isArray(steps)) return { steps: out, end: current }
    for (const raw of steps) {
      if (!raw || typeof raw !== 'object') {
        this.cursor.number += 1
        continue
      }
      const number = ++this.cursor.number
      const name = typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name : null
      switch (raw.kind) {
        case 'move': {
          const step = this.expandMove(raw, number, name, arms, frame, current, calcAsts)
          if (step) {
            out.push(step)
            current = step.target
          }
          break
        }
        case 'touch': {
          const step = this.expandTouch(raw, number, name, arms, frame, current)
          if (step) {
            out.push(step)
            current = step.expectedAfter
          }
          break
        }
        case 'calc': {
          const step = this.expandCalc(raw, number, name, arms, frame, calcAsts)
          if (step) out.push(step)
          break
        }
        case 'check': {
          const step = this.expandCheck(raw, number, name, arms, frame)
          if (step) out.push(step)
          break
        }
        case 'branch': {
          const step = this.expandBranch(raw, number, name, arms, frame, current, calcAsts)
          if (step) {
            out.push(step)
            current = endOf(step.nominalArm === 'then' ? step.then : step.else, current)
          }
          break
        }
        default:
          // E_STEP_KIND is the validator's; nothing to expand.
          break
      }
    }
    return { steps: out, end: current }
  }

  private expandMove(
    raw: ProbeRoutineMoveStep,
    number: number,
    name: string | null,
    arms: string[],
    frame: Frame,
    from: ExpandPoint,
    calcAsts: Map<string, ExprAst>,
  ): ExpandedMoveStep | null {
    const ref = { number, kind: 'move', name }
    const path = `steps[${number - 1}]`
    const to = raw.to && typeof raw.to === 'object' ? raw.to : null
    if (!to) return null
    const frameKind = raw.frame === 'machine' ? 'machine' : 'start'
    const isFirstMove = !this.seenFirstMove
    this.seenFirstMove = true

    // safeZ: only the first move's counts (the validator refuses it elsewhere)
    if (isFirstMove && raw.safeZ !== undefined) {
      const parsed = this.parse(raw.safeZ)
      if (parsed) {
        const value = this.evalAt(parsed, frame, ref, `${path}.safeZ`)
        if (value !== null) this.safeZ = round4(frameKind === 'start' ? this.ctx.start.z + value : value)
      }
    }

    const target: ExpandPoint = { ...from }
    const axes: Array<'X' | 'Y' | 'Z'> = []
    let touchDependent = false
    const touchNames = new Set<string>()
    const parsedAxes: Partial<Record<ExpandAxisKey, { source: string; ast: ExprAst }>> = {}
    for (const key of AXIS_KEYS) {
      const expr = to[key]
      if (expr === undefined) continue
      const parsed = this.parse(expr)
      if (!parsed) return null
      const value = this.evalAt(parsed, frame, ref, `${path}.to.${key}`)
      if (value === null) return null
      target[key] = round4(frameKind === 'start' ? this.ctx.start[key] + value : value)
      axes.push(axisLetter(key))
      parsedAxes[key] = parsed
      if (this.dependsOnTouch(parsed.ast, frame)) {
        touchDependent = true
        for (const t of this.touchNamesOf(parsed.ast, calcAsts)) touchNames.add(t)
      }
    }
    if (axes.length === 0) return null

    // feed - WO-2073: a descent that stops on contact runs at the search feed
    const guarded = raw.stopOnContact === true
    const rapid = raw.feed === 'rapid' && !guarded
    const ceiling = this.axisCeiling(axes)
    const feed = clampFeed(guarded ? this.ctx.probe.fastFeed : this.ctx.probe.positioningFeed, 1, ceiling)
    if (guarded && axes.length === 1 && axes[0] === 'Z' && !(target.z < from.z - ENVELOPE_FIT_TOLERANCE_MM)) {
      this.stepError(
        'E_FIELD_INVALID',
        ref,
        `${path}.to.z`,
        `a move that stops on contact must go down; this one goes from ${machineAt('z', from.z)} to ${machineAt('z', target.z)}.`,
      )
    }

    // rapid rule (section 2.4)
    if (rapid) {
      const zOnly = axes.length === 1 && axes[0] === 'Z'
      const xyOnly = !axes.includes('Z')
      if (this.safeZ === null) {
        this.stepError(
          'E_RAPID_NOT_AT_SAFE_Z',
          ref,
          `${path}.feed`,
          "a rapid is allowed only straight up in Z, or in XY at or above the routine's safe Z - this routine declares no safe Z. It will run at the positioning feed or not at all.",
        )
      } else if (zOnly) {
        if (target.z < from.z) {
          this.stepError(
            'E_RAPID_NOT_AT_SAFE_Z',
            ref,
            `${path}.feed`,
            `a rapid in Z is allowed only upward; this one goes down from ${machineAt('z', from.z)} to ${machineAt('z', target.z)}. It will run at the positioning feed or not at all.`,
          )
        }
      } else if (xyOnly) {
        if (from.z < this.safeZ - ENVELOPE_FIT_TOLERANCE_MM) {
          this.stepError(
            'E_RAPID_NOT_AT_SAFE_Z',
            ref,
            `${path}.feed`,
            `a rapid in XY is allowed only at or above the routine's safe Z (${machineAt('z', this.safeZ)}); this one starts at ${machineAt('z', from.z)}. It will run at the positioning feed or not at all.`,
          )
        }
      } else {
        this.stepError(
          'E_RAPID_NOT_AT_SAFE_Z',
          ref,
          `${path}.feed`,
          'a rapid may move straight up in Z, or in XY at or above the safe Z, never both at once. It will run at the positioning feed or not at all.',
        )
      }
    }

    // envelope: the endpoint (and, for a touch-dependent move, both band corners)
    let band: ExpandedMoveStep['band'] = null
    if (touchDependent) {
      band = this.bandFor(parsedAxes, frameKind, target, touchNames, frame, ref, path)
    }
    if (this.startInside(from)) {
      this.checkEndpoint(target, ref, path, touchDependent ? 'nominal endpoint' : null)
      if (band) {
        this.checkEndpoint(band.low, ref, path, 'lowest possible endpoint (depending on the contact)')
        this.checkEndpoint(band.high, ref, path, 'highest possible endpoint (depending on the contact)')
      }
    }

    // WO-2073: a named guarded descent is read later as touch.<name> - where it
    // stopped. Nominally it meets nothing and ends at its target; at the
    // extremes it touches at once (near) or runs the whole way (far).
    if (guarded && name) {
      const at = (p: ExpandPoint): Record<TouchResultField, number> => ({ x: p.x, y: p.y, z: p.z, value: p.z })
      frame.touch[name] = at(target)
      frame.touchExtremes[name] = { near: at({ ...target, z: from.z }), far: at(target) }
      frame.touchDependent.add(name)
    }

    return {
      kind: 'move',
      number,
      name,
      arms,
      label: name ?? `move ${number}`,
      from,
      target,
      axes,
      feedMmMin: feed.appliedMmMin,
      feed,
      rapid,
      touchDependent,
      band,
      safeZ: isFirstMove ? this.safeZ : null,
      frame: frameKind,
      exprs: parsedAxes,
      ...(guarded ? { stopOnContact: true as const, contactRetractMm: round4(this.ctx.probe.retract) } : {}),
    }
  }

  /** Evaluate the move's endpoint at every combination of referenced-touch
   *  extremes (2^k, k = touches referenced) and return the componentwise band. */
  private bandFor(
    parsedAxes: Partial<Record<ExpandAxisKey, { source: string; ast: ExprAst }>>,
    frameKind: 'start' | 'machine',
    nominal: ExpandPoint,
    touchNames: Set<string>,
    frame: Frame,
    ref: { number: number; kind: string; name: string | null },
    path: string,
  ): { low: ExpandPoint; high: ExpandPoint } {
    const names = [...touchNames].filter((n) => frame.touchExtremes[n]).slice(0, 8)
    const low: ExpandPoint = { ...nominal }
    const high: ExpandPoint = { ...nominal }
    const combos = 1 << names.length
    for (let mask = 0; mask < combos; mask++) {
      const touch: Frame['touch'] = { ...frame.touch }
      names.forEach((n, i) => {
        touch[n] = (mask & (1 << i)) ? frame.touchExtremes[n].far : frame.touchExtremes[n].near
      })
      // calcs that depend on those touches must be recomputed in this world
      const calc: Record<string, number> = { ...frame.calc }
      const world: Frame = { ...frame, touch, calc }
      for (const [calcName, ast] of frame.calcOrder) {
        if (!frame.touchDependent.has(calcName)) continue
        const r = evaluateExpr(ast, this.scope(world))
        if (r.ok) calc[calcName] = r.value
      }
      for (const key of AXIS_KEYS) {
        const parsed = parsedAxes[key]
        if (!parsed) continue
        const r = evaluateExpr(parsed.ast, this.scope(world))
        if (!r.ok) {
          if (r.fault.code === 'E_CALC_NOT_FINITE') {
            this.stepError('E_CALC_NOT_FINITE', ref, `${path}.to.${key}`, `\`${parsed.source}\` does not come out as a number at a possible contact (division by zero or overflow).`)
          }
          continue
        }
        const v = round4(frameKind === 'start' ? this.ctx.start[key] + r.value : r.value)
        if (v < low[key]) low[key] = v
        if (v > high[key]) high[key] = v
      }
    }
    return { low, high }
  }

  private expandTouch(
    raw: ProbeRoutineTouchStep,
    number: number,
    name: string | null,
    arms: string[],
    frame: Frame,
    from: ExpandPoint,
  ): ExpandedTouchStep | null {
    const ref = { number, kind: 'touch', name }
    const path = `steps[${number - 1}]`
    if (!name) return null
    const axis = this.resolveEnum(raw.axis, ['X', 'Y', 'Z']) as ProbeRoutineAxis | null
    const direction = this.resolveEnum(raw.direction, ['+', '-']) as ProbeRoutineDirection | null
    if (!axis || !direction) return null
    if (axis === 'Z' && direction === '+') {
      this.stepError('E_TOUCH_DIRECTION', ref, `${path}.direction`, 'a Z+ touch (probing upward) is not a measurement and is refused.')
      return null
    }
    const searchParsed = this.parse(raw.searchMm)
    if (!searchParsed) return null
    const searchMm = this.evalAt(searchParsed, frame, ref, `${path}.searchMm`)
    if (searchMm === null) return null
    const maxTravel = this.ctx.probe.maxTravel
    if (!(searchMm > 0)) {
      this.stepError('E_FIELD_INVALID', ref, `${path}.searchMm`, `a search of ${formatBound(searchMm)} mm goes nowhere; it must be more than 0 mm.`)
      return null
    }
    if (searchMm > maxTravel + 1e-9) {
      this.stepError(
        'E_SEARCH_OVER_MAX_TRAVEL',
        ref,
        `${path}.searchMm`,
        `a search of ${formatBound(searchMm)} mm is more than the machine profile's probe travel limit of ${formatBound(maxTravel)} mm.`,
      )
    }
    let retractMm = this.ctx.probe.retract
    if (raw.retractMm !== undefined) {
      const parsed = this.parse(raw.retractMm)
      if (!parsed) return null
      const v = this.evalAt(parsed, frame, ref, `${path}.retractMm`)
      if (v === null) return null
      retractMm = v
    }
    let backoffMm = this.ctx.probe.retract
    if (raw.backoffMm !== undefined) {
      const parsed = this.parse(raw.backoffMm)
      if (!parsed) return null
      const v = this.evalAt(parsed, frame, ref, `${path}.backoffMm`)
      if (v === null) return null
      backoffMm = v
    }
    if (!(retractMm > 0) || retractMm > searchMm + 1e-9) {
      this.stepError('E_FIELD_INVALID', ref, `${path}.retractMm`, `the retract of ${formatBound(retractMm)} mm must be more than 0 mm and no more than the search (${formatBound(searchMm)} mm).`)
    }
    if (!(backoffMm > 0)) {
      this.stepError('E_FIELD_INVALID', ref, `${path}.backoffMm`, `the back-off of ${formatBound(backoffMm)} mm must be more than 0 mm.`)
    }

    const key = axis.toLowerCase() as ExpandAxisKey
    const sign = direction === '+' ? 1 : -1
    const ceiling = this.axisCeiling([axis])
    const searchFeed = clampFeed(this.ctx.probe.fastFeed, raw.searchFeedFactor, ceiling)
    const finalFeed = clampFeed(this.ctx.probe.slowFeed, raw.finalFeedFactor, ceiling)

    const boundedSearch = boundProbeRoutineWallSearch(axis, direction, searchMm, from, this.ctx.envelope)
    if (!(boundedSearch > 0)) {
      this.stepError('E_FIELD_INVALID', ref, `${path}.searchMm`, `no wall search is possible toward ${axis}${direction} from the machine limit.`)
      return null
    }
    const searchRounded = round4(boundedSearch)
    const farEnd: ExpandPoint = { ...from, [key]: round4(from[key] + sign * searchRounded) }
    const nominalDepth = Math.max(0, searchRounded - this.ctx.probe.overtravel)
    const nominalContact: ExpandPoint = { ...from, [key]: round4(from[key] + sign * nominalDepth) }
    const expectedAfter: ExpandPoint = { ...nominalContact, [key]: round4(nominalContact[key] - sign * backoffMm) }

    if (this.startInside(from)) {
      this.checkEndpoint(farEnd, ref, path, 'far end of the search')
      this.checkEndpoint(expectedAfter, ref, path, 'position after the back-off')
    }

    // results visible to later expressions: nominal, plus the two extremes for bands
    const result = (contact: ExpandPoint): Record<TouchResultField, number> => ({
      x: contact.x,
      y: contact.y,
      z: contact.z,
      value: contact[key],
    })
    frame.touch[name] = result(nominalContact)
    frame.touchExtremes[name] = { near: result(from), far: result(farEnd) }
    frame.touchDependent.add(name)

    return {
      kind: 'touch',
      number,
      name,
      arms,
      label: name,
      axis,
      direction,
      searchMm: searchRounded,
      retractMm: round4(retractMm),
      backoffMm: round4(backoffMm),
      searchFeedMmMin: searchFeed.appliedMmMin,
      finalFeedMmMin: finalFeed.appliedMmMin,
      searchFeed,
      finalFeed,
      expectedStart: from,
      farEnd,
      nominalContact,
      expectedAfter,
      searchExpr: searchParsed,
      touchDependent: this.dependsOnTouch(searchParsed.ast, frame),
    }
  }

  private expandCalc(
    raw: ProbeRoutineCalcStep,
    number: number,
    name: string | null,
    arms: string[],
    frame: Frame,
    calcAsts: Map<string, ExprAst>,
  ): ExpandedCalcStep | null {
    if (!name) return null
    const ref = { number, kind: 'calc', name }
    const parsed = this.parse(raw.expr)
    if (!parsed) return null
    const value = this.evalAt(parsed, frame, ref, `steps[${number - 1}].expr`)
    if (value === null) return null
    const touchDependent = this.dependsOnTouch(parsed.ast, frame)
    frame.calc[name] = value
    if (touchDependent) frame.touchDependent.add(name)
    calcAsts.set(name, parsed.ast)
    frame.calcOrder.push([name, parsed.ast])
    return {
      kind: 'calc',
      number,
      name,
      arms,
      label: name,
      unit: raw.unit,
      source: parsed.source,
      ast: parsed.ast,
      nominalValue: value,
      touchDependent,
    }
  }

  private expandCheck(
    raw: ProbeRoutineCheckStep,
    number: number,
    name: string | null,
    arms: string[],
    frame: Frame,
  ): ExpandedCheckStep | null {
    const ref = { number, kind: 'check', name }
    const path = `steps[${number - 1}].condition`
    const cond = this.expandCondition(raw.condition, frame, ref, path)
    if (!cond) return null
    const message = typeof raw.message === 'string' ? raw.message : ''
    if (!cond.result && !cond.touchDependent) {
      // Decidable from the inputs alone and false: the routine would stop at
      // this step before it moves. Say so now rather than after the tick.
      this.stepError(
        'E_INPUT_OUT_OF_RANGE',
        ref,
        path,
        `with these inputs the check would stop the routine before it moves: ${message}`,
      )
    }
    return {
      kind: 'check',
      number,
      name,
      arms,
      label: name ?? `check ${number}`,
      condition: cond.condition,
      message,
      nominalResult: cond.result,
      touchDependent: cond.touchDependent,
    }
  }

  private expandBranch(
    raw: ProbeRoutineBranchStep,
    number: number,
    name: string | null,
    arms: string[],
    frame: Frame,
    from: ExpandPoint,
    calcAsts: Map<string, ExprAst>,
  ): ExpandedBranchStep | null {
    const ref = { number, kind: 'branch', name }
    const path = `steps[${number - 1}].condition`
    const cond = this.expandCondition(raw.condition, frame, ref, path)
    const thenFrame = childFrame(frame)
    const thenArms = [...arms, `${number}.then`]
    const thenResult = this.expandSteps(Array.isArray(raw.then) ? raw.then : [], thenFrame, from, thenArms, new Map(calcAsts))
    const elseFrame = childFrame(frame)
    const elseArms = [...arms, `${number}.else`]
    const elseResult = this.expandSteps(Array.isArray(raw.else) ? raw.else : [], elseFrame, from, elseArms, new Map(calcAsts))
    if (!cond) return null
    return {
      kind: 'branch',
      number,
      name,
      arms,
      label: name ?? `branch ${number}`,
      condition: cond.condition,
      nominalArm: cond.result ? 'then' : 'else',
      touchDependent: cond.touchDependent,
      then: thenResult.steps,
      else: elseResult.steps,
    }
  }

  // -- envelope

  private startInside(point: ExpandPoint): boolean {
    // A step whose START is already outside the table inherits an earlier
    // step's refusal; naming it again would be noise, not information.
    return pointOutsideEnvelope(point, this.ctx.envelope) === null
  }

  private checkEndpoint(
    point: ExpandPoint,
    ref: { number: number; kind: string; name: string | null },
    path: string,
    what: string | null,
  ): boolean {
    const outside = pointOutsideEnvelope(point, this.ctx.envelope)
    if (!outside) return true
    const letter = axisLetter(outside.axis)
    const lead = what ? `the ${what}, ${machineAt(outside.axis, outside.value)},` : machineAt(outside.axis, outside.value)
    this.stepError(
      'E_ENDPOINT_OUTSIDE_ENVELOPE',
      ref,
      path,
      `${lead} is outside the table (${letter} runs ${formatBound(outside.min)} to ${formatBound(outside.max)}).`,
    )
    return false
  }

  private axisCeiling(axes: Array<'X' | 'Y' | 'Z'>): number | null {
    const limits = this.ctx.axisLimits
    if (!limits) return null
    let ceiling: number | null = null
    for (const axis of axes) {
      const limit = limits[axis.toLowerCase() as ExpandAxisKey]
      if (!limit || !Number.isFinite(limit.maxCutting) || limit.maxCutting <= 0) continue
      ceiling = ceiling === null ? limit.maxCutting : Math.min(ceiling, limit.maxCutting)
    }
    return ceiling
  }

  // -- outputs

  expandOutputs(): ExpandedProposal[] {
    const out: ExpandedProposal[] = []
    const outputs = Array.isArray(this.routine.outputs) ? this.routine.outputs : []
    for (const raw of outputs as ProbeRoutineOutput[]) {
      if (!raw || typeof raw !== 'object') continue
      if (raw.kind === 'workOffset') {
        const wcs = this.resolveEnum(raw.wcs, ['active', 'G54', 'G55', 'G56', 'G57', 'G58', 'G59']) ?? 'active'
        const axes: Partial<Record<'X' | 'Y' | 'Z', { source: string; ast: ExprAst }>> = {}
        for (const letter of ['X', 'Y', 'Z'] as const) {
          const expr = raw.axes?.[letter]
          if (expr === undefined) continue
          const parsed = this.parse(expr)
          if (parsed) axes[letter] = parsed
        }
        out.push({
          kind: 'workOffset',
          wcs,
          activeWcs: this.ctx.activeWcs ?? null,
          axes,
          label: typeof raw.label === 'string' ? raw.label : '',
          compensationNote: typeof raw.compensationNote === 'string' ? raw.compensationNote : null,
        })
      } else if (raw.kind === 'toolLength') {
        const parsed = this.parse(raw.machineZ)
        if (!parsed) continue
        out.push({ kind: 'toolLength', tool: raw.tool, machineZ: parsed, label: typeof raw.label === 'string' ? raw.label : '' })
      } else if (raw.kind === 'report') {
        const items: Array<{ label: string; expr: { source: string; ast: ExprAst }; unit: string }> = []
        for (const item of Array.isArray(raw.items) ? raw.items : []) {
          const parsed = this.parse(item?.expr)
          if (!parsed) continue
          items.push({ label: item.label, expr: parsed, unit: item.unit })
        }
        out.push({ kind: 'report', items })
      }
    }
    return out
  }

  get boundInputs(): Record<string, number | string> {
    return this.inputValues
  }
}

function endOf(steps: ExpandedStep[], fallback: ExpandPoint): ExpandPoint {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (s.kind === 'move') return s.target
    if (s.kind === 'touch') return s.expectedAfter
    if (s.kind === 'branch') {
      const arm = s.nominalArm === 'then' ? s.then : s.else
      const inner = endOf(arm, fallback)
      if (inner !== fallback) return inner
    }
  }
  return fallback
}

function compare(cmp: ProbeRoutineComparison['cmp'], l: number, r: number): boolean {
  switch (cmp) {
    case '<': return l < r
    case '<=': return l <= r
    case '>': return l > r
    case '>=': return l >= r
    case '==': return Math.abs(l - r) <= EQUALITY_TOLERANCE
    case '!=': return Math.abs(l - r) > EQUALITY_TOLERANCE
    default: return false
  }
}

/** Evaluate an expanded condition against a scope (the runner does this with
 *  real contacts). A non-evaluable comparison makes the condition false and
 *  is reported in `fault`. `==` / `!=` compare within 1e-6. */
export function evaluateExpandedCondition(
  condition: ExpandedCondition,
  scope: ExprEvalScope,
): { ok: true; result: boolean } | { ok: false; fault: string } {
  const list = 'all' in condition ? condition.all : condition.any
  const results: boolean[] = []
  for (const c of list) {
    const l = evaluateExpr(c.left.ast, scope)
    if (!l.ok) return { ok: false, fault: l.fault.sentence }
    const r = evaluateExpr(c.right.ast, scope)
    if (!r.ok) return { ok: false, fault: r.fault.sentence }
    results.push(compare(c.cmp, l.value, r.value))
  }
  return { ok: true, result: 'all' in condition ? results.every(Boolean) : results.some(Boolean) }
}

// --- entry point ---------------------------------------------------------------

/**
 * Expand a routine against bound inputs and the machine context. Returns the
 * concrete plan or every expansion error found (section 2.7), in step order.
 * Pure: no store, no controller, no text the controller sees.
 */
export function expandProbeRoutine(
  routine: ProbeRoutine,
  inputs: ProbeRoutineInputValues,
  ctx: ProbeRoutineExpandContext,
): ExpandProbeRoutineResult {
  const expander = new Expander(routine, inputs ?? {}, ctx)
  const errors = expander.errors

  // probe config (E_PROBE_CONFIG_INVALID)
  const configCheck = validateZProbeConfig(ctx.probe)
  if (!configCheck.ok) {
    errors.push(routineLevel(routine, 'E_PROBE_CONFIG_INVALID', 'probe', `the probe settings are not usable: ${configCheck.reason}`))
  }
  if (!Number.isFinite(ctx.tipRadiusMm) || ctx.tipRadiusMm < 0) {
    errors.push(routineLevel(routine, 'E_PROBE_CONFIG_INVALID', 'tipRadiusMm', 'the probe tip radius must be a number of zero or more millimetres.'))
  }

  // envelope completeness (E_ENVELOPE_INCOMPLETE)
  const homed = routine.requires?.homed === true
  const missing = AXIS_KEYS.filter((a) => !ctx.envelope[a]).map(axisLetter)
  if (homed && missing.length > 0) {
    errors.push(routineLevel(
      routine,
      'E_ENVELOPE_INCOMPLETE',
      'requires.envelope',
      `it needs the full machine envelope (x, y and z) and the ${missing.join(', ')} ${missing.length === 1 ? 'range is' : 'ranges are'} unknown - home the machine, or declare the travel in the machine profile.`,
    ))
  }

  // the start itself
  const startOutside = AXIS_KEYS.some((a) => !Number.isFinite(ctx.start[a]))
    ? null
    : pointOutsideEnvelope(ctx.start, ctx.envelope)
  if (AXIS_KEYS.some((a) => !Number.isFinite(ctx.start[a]))) {
    errors.push(routineLevel(routine, 'E_ENVELOPE_INCOMPLETE', 'start', 'the machine position is unknown, so no endpoint can be placed on the table.'))
  } else if (startOutside) {
    const letter = axisLetter(startOutside.axis)
    errors.push(routineLevel(
      routine,
      'E_ENDPOINT_OUTSIDE_ENVELOPE',
      'start',
      `the probe is parked at ${machineAt(startOutside.axis, startOutside.value)}, outside the table (${letter} runs ${formatBound(startOutside.min)} to ${formatBound(startOutside.max)}).`,
    ))
  }

  const frame: Frame = { touch: {}, calc: {}, touchDependent: new Set(), touchExtremes: {}, calcOrder: [] }
  const { steps, end } = expander.expandSteps(routine.steps, frame, ctx.start, [], new Map())
  const proposals = expander.expandOutputs()

  if (errors.length > 0) return { ok: false, expanded: null, errors }

  const profile = {
    tipRadiusMm: ctx.tipRadiusMm,
    retractMm: ctx.probe.retract,
    surfaceClearanceMm: ctx.probe.surfaceClearance,
    overtravelMm: ctx.probe.overtravel,
    maxTravelMm: ctx.probe.maxTravel,
    crossOverLiftMm: ctx.probe.crossOverLift,
    positioningFeedMmMin: ctx.probe.positioningFeed,
    searchFeedMmMin: ctx.probe.fastFeed,
    finalFeedMmMin: ctx.probe.slowFeed,
  }
  const hash = previewHash(routine, expander.boundInputs, ctx, profile)

  return {
    ok: true,
    errors: [],
    expanded: {
      routineId: routine.id,
      routineName: routine.name,
      inputs: expander.boundInputs,
      start: { ...ctx.start },
      profile,
      steps,
      proposals,
      end,
      hash,
    },
  }
}

function routineLevel(routine: ProbeRoutine, code: RoutineErrorCode, path: string, detail: string): RoutineError {
  return {
    code,
    where: 'routine',
    step: null,
    index: null,
    path,
    detail,
    sentence: `Routine '${routine.name}': ${detail}`,
  }
}

/** sha-256 over everything the preview depended on (section 4.1 / 4.6). */
function previewHash(
  routine: ProbeRoutine,
  inputs: Record<string, number | string>,
  ctx: ProbeRoutineExpandContext,
  profile: ExpandedRoutine['profile'],
): string {
  const sortedInputs: Record<string, number | string> = {}
  for (const key of Object.keys(inputs).sort()) sortedInputs[key] = inputs[key]
  const envelope = AXIS_KEYS.map((a) => {
    const e = ctx.envelope[a]
    return e ? [a, e.min, e.max] : [a, null, null]
  })
  const limits = ctx.axisLimits
    ? AXIS_KEYS.map((a) => [a, ctx.axisLimits![a].maxCutting])
    : null
  const payload = JSON.stringify({
    routine: canonicalRoutineJson(routine),
    inputs: sortedInputs,
    start: [ctx.start.x, ctx.start.y, ctx.start.z],
    profile: [
      profile.tipRadiusMm, profile.retractMm, profile.surfaceClearanceMm, profile.overtravelMm,
      profile.maxTravelMm, profile.crossOverLiftMm, profile.positioningFeedMmMin,
      profile.searchFeedMmMin, profile.finalFeedMmMin,
    ],
    axisLimits: limits,
    envelope,
    activeWcs: ctx.activeWcs ?? null,
  })
  return sha256Hex(payload)
}

// --- preview ---------------------------------------------------------------------

export type ExpandedDisplayUnits = 'mm' | 'in'

function coord(value: number, units: ExpandedDisplayUnits): string {
  return units === 'in' ? String(Number((value / 25.4).toFixed(4))) : formatCoordinate(value)
}

function length(value: number, units: ExpandedDisplayUnits): string {
  return units === 'in' ? `${Number((value / 25.4).toFixed(4))} in` : `${formatBound(value)} mm`
}

function feedText(value: number, units: ExpandedDisplayUnits): string {
  return units === 'in' ? `${Number((value / 25.4).toFixed(2))} in/min` : `${formatFeed(value)} mm/min`
}

/** A routine position through the one position formatter: "machine X 96.5". */
function pointText(point: ExpandPoint, axes: Array<'X' | 'Y' | 'Z'>, units: ExpandedDisplayUnits): string {
  return formatPosition({
    machine: point,
    axes: axes.map((a) => a.toLowerCase() as ExpandAxisKey),
    format: (value) => coord(value, units),
  })
}

function conditionText(condition: ExpandedCondition): string {
  const list = 'all' in condition ? condition.all : condition.any
  const parts = list.map((c) => `${c.left.source} ${c.cmp} ${c.right.source}`)
  return parts.join('all' in condition ? ' and ' : ' or ')
}

/**
 * The preview sentence for one expanded step (contract section 6):
 *   "3. move to machine X -412.0 Y -300.0 at 1000 mm/min"
 *   "4. probe toward X- up to 10 mm: search 300 then 50 mm/min, back off 2 mm"
 */
export function describeExpandedStep(step: ExpandedStep, units: ExpandedDisplayUnits = 'mm'): string {
  const n = `${step.number}.`
  switch (step.kind) {
    case 'move': {
      const verb = step.rapid ? 'rapid' : 'move'
      const where = pointText(step.target, step.axes, units)
      const band = step.band
        ? ` (between ${pointText(step.band.low, step.axes, units)} and ${pointText(step.band.high, step.axes, units)}, depending on the contact)`
        : ''
      if (step.stopOnContact) {
        return `${n} descend to ${where}${band} at ${feedText(step.feedMmMin, units)}, stopping if it touches anything `
          + `(then it backs off ${length(step.contactRetractMm ?? 0, units)} and carries on)`
      }
      return `${n} ${verb} to ${where}${band} at ${feedText(step.feedMmMin, units)}`
    }
    case 'touch':
      return `${n} probe toward ${step.axis}${step.direction} up to ${length(step.searchMm, units)}: `
        + `search ${feedText(step.searchFeedMmMin, units).replace(/ mm\/min| in\/min/, '')} then ${feedText(step.finalFeedMmMin, units)}, `
        + `back off ${length(step.backoffMm, units)}`
    case 'calc': {
      const unit = step.unit === 'mm' || step.unit === 'deg' ? ` ${step.unit}` : ''
      return `${n} calc ${step.name} = ${step.source} (about ${formatBound(step.nominalValue)}${unit}${step.touchDependent ? ', from the contacts' : ''})`
    }
    case 'check':
      return `${n} check ${conditionText(step.condition)}; otherwise stop: ${step.message}`
    case 'branch': {
      const range = (arm: ExpandedStep[]): string => arm.length === 0
        ? 'nothing'
        : arm.length === 1
          ? `step ${arm[0].number}`
          : `steps ${arm[0].number}-${lastNumber(arm)}`
      const which = step.touchDependent ? ' (decided by the contacts - one of these will run)' : ` (with these inputs: ${step.nominalArm})`
      return `${n} if ${conditionText(step.condition)} then ${range(step.then)} else ${range(step.else)}${which}`
    }
  }
}

function lastNumber(steps: ExpandedStep[]): number {
  const last = steps[steps.length - 1]
  if (last.kind === 'branch') {
    const arm = last.else.length > 0 ? last.else : last.then
    return arm.length > 0 ? lastNumber(arm) : last.number
  }
  return last.number
}

/** Pre-order list of every step including both branch arms (for the preview list and diagram). */
export function listExpandedSteps(steps: readonly ExpandedStep[]): ExpandedStep[] {
  const out: ExpandedStep[] = []
  for (const step of steps) {
    out.push(step)
    if (step.kind === 'branch') {
      out.push(...listExpandedSteps(step.then))
      out.push(...listExpandedSteps(step.else))
    }
  }
  return out
}

/** The preview as numbered sentences, both branch arms included. */
export function describeExpandedRoutine(expanded: ExpandedRoutine, units: ExpandedDisplayUnits = 'mm'): string[] {
  return listExpandedSteps(expanded.steps).map((step) => describeExpandedStep(step, units))
}

// --- WO-1613: the tool setter measure --------------------------------------------
//
// A tool setter routine (`requires.probe: 'toolSetter'`, probeRoutineFactory)
// is run by the Measure tool button, not by the generic step runner: its
// descent onto the setter depends on the tool table (a known length lets the
// tool come down at the approach speed to the clearance above the expected
// touch), which the routine format has no word for. This plan is the one
// place that sequence is worked out; machineSession executes it and the editor
// shows describeToolSetterPlan - so what is previewed is what runs.

export interface ToolSetterPlanContext {
  /** Machine Z where the tool stands now; null when not reported (the preview
   *  then assumes the crossing height). */
  startZ: number | null
  /** The bottom of the machine's Z travel from its definition; the search
   *  never runs below it. */
  zMinMm: number | null
  /** The machine's X, Y and Z travel - the same envelope every other
   *  coordinate move is checked against (resolveMachineMotion). The setter X/Y
   *  and the crossing height must lie inside it; an unknown axis is not checked. */
  envelope: MachineEnvelope
  /** The active tool's recorded setter contact (tool table), or null. */
  expectedContactZ: number | null
  /** The active tool's number, for the sentences. */
  tool: number | null
  /** The profile's positioning feed, used for the crossing and XY moves. */
  positioningFeedMmMin: number
}

export interface ToolSetterPlan {
  routineId: string
  routineName: string
  /** Every setter input as bound (defaults filled in), mm and mm/min. */
  values: ToolSetterDefaults
  setter: { x: number; y: number }
  crossingZ: number
  /** The Z the tool crosses XY at: the crossing height, or higher when it already is. */
  travelZ: number
  positioningFeedMmMin: number
  /** The guarded descent toward the expected touch; null without a known length. */
  approach: { targetZ: number; feedMmMin: number; expectedContactZ: number } | null
  /** Why there is no approach, in words; null when there is one. */
  noApproachReason: string | null
  /** The machine Z the fast probe starts from and the one it searches to. */
  fastFromZ: number
  searchFloorZ: number
  tool: number | null
}

export type ToolSetterPlanResult = { ok: true; plan: ToolSetterPlan } | { ok: false; reason: string }

/**
 * Bind a tool setter routine's inputs and work out every move of the measure.
 * `overrides` are values typed for this one run (the editor's value column);
 * anything not given takes the routine's default. Refuses only what cannot run:
 * a missing input, a value outside its own bounds, a fine search too short to
 * reach back to the contact after the retract, a setter position or crossing
 * height outside the machine's travel, or no depth left to search.
 */
export function planToolSetterMeasure(
  routine: ProbeRoutine,
  overrides: ProbeRoutineInputValues,
  ctx: ToolSetterPlanContext,
): ToolSetterPlanResult {
  const values = {} as ToolSetterDefaults
  for (const name of TOOL_SETTER_INPUTS) {
    const input = routine.inputs.find((i) => i.name === name)
    if (!input || input.type !== 'length') {
      return { ok: false, reason: `"${routine.name}" has no length input named ${name}, so it is not a tool setter routine this build can run.` }
    }
    const raw = overrides[name] ?? input.default
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(value)) return { ok: false, reason: `${input.label}: ${String(raw)} is not a number.` }
    if (value < input.min || value > input.max) {
      return { ok: false, reason: `${input.label}: ${value} is outside the routine's bounds (${input.min} to ${input.max} mm).` }
    }
    values[name] = value
  }
  if (values.fineSearchMm <= values.retractMm) {
    return {
      ok: false,
      reason: `The fine search (${formatBound(values.fineSearchMm)} mm) must be longer than the retract (${formatBound(values.retractMm)} mm), or the fine touch cannot reach back down to the setter.`,
    }
  }
  // The XY move is made at the crossing height, so that one point is every
  // coordinate the routine sends the board on its own; the probes below it
  // stay inside by the search floor. A point outside the table moves nothing.
  const outside = pointOutsideEnvelope({ x: values.setterX, y: values.setterY, z: values.crossingZ }, ctx.envelope)
  if (outside) {
    const name = outside.axis === 'x' ? 'setterX' : outside.axis === 'y' ? 'setterY' : 'crossingZ'
    const label = routine.inputs.find((i) => i.name === name)?.label ?? name
    return {
      ok: false,
      reason: `${label}: ${machineAt(outside.axis, outside.value)} is outside the table (${axisLetter(outside.axis)} runs ${formatBound(outside.min)} to ${formatBound(outside.max)}).`,
    }
  }
  const travelZ = round4(ctx.startZ !== null && ctx.startZ > values.crossingZ ? ctx.startZ : values.crossingZ)
  const depthFloor = round4(values.crossingZ - values.maxSearchMm)
  const searchFloorZ = ctx.zMinMm !== null ? round4(Math.max(depthFloor, ctx.zMinMm)) : depthFloor
  if (!(searchFloorZ < travelZ)) {
    return { ok: false, reason: `The search would end at ${zText(searchFloorZ, 'mm')}, not below the crossing at ${zText(travelZ, 'mm')} - there is no depth to search.` }
  }
  let approach: ToolSetterPlan['approach'] = null
  let noApproachReason: string | null = null
  const toolName = ctx.tool === null ? 'the active tool' : `T${ctx.tool}`
  if (ctx.expectedContactZ === null || !Number.isFinite(ctx.expectedContactZ)) {
    noApproachReason = `the tool table has no measured length for ${toolName}`
  } else {
    const targetZ = round4(ctx.expectedContactZ + values.clearanceMm)
    if (targetZ >= travelZ) {
      noApproachReason = `${toolName}'s expected touch plus the clearance is not below the crossing height`
    } else if (targetZ <= searchFloorZ) {
      noApproachReason = `${toolName}'s expected touch plus the clearance is below the search depth`
    } else {
      approach = { targetZ, feedMmMin: values.approachFeed, expectedContactZ: round4(ctx.expectedContactZ) }
    }
  }
  return {
    ok: true,
    plan: {
      routineId: routine.id,
      routineName: routine.name,
      values,
      setter: { x: values.setterX, y: values.setterY },
      crossingZ: values.crossingZ,
      travelZ,
      positioningFeedMmMin: ctx.positioningFeedMmMin,
      approach,
      noApproachReason,
      fastFromZ: approach ? approach.targetZ : travelZ,
      searchFloorZ,
      tool: ctx.tool,
    },
  }
}

function zText(z: number, units: ExpandedDisplayUnits): string {
  return formatPosition({ machine: { z }, axes: ['z'], format: (value) => coord(value, units) })
}

/** The plan as numbered plain-words moves, in the display units. */
export function describeToolSetterPlan(plan: ToolSetterPlan, units: ExpandedDisplayUnits = 'mm'): string[] {
  const v = plan.values
  const lines: string[] = []
  const add = (text: string) => lines.push(`${lines.length + 1}. ${text}`)
  add(`raise Z to the crossing height, ${zText(plan.crossingZ, units)}, at ${feedText(plan.positioningFeedMmMin, units)} (never lower: a tool already above it crosses where it is)`)
  add(`move to the setter at ${pointText({ x: plan.setter.x, y: plan.setter.y, z: plan.travelZ }, ['X', 'Y'], units)} at ${feedText(plan.positioningFeedMmMin, units)}`)
  if (plan.approach) {
    add(
      `descend at ${feedText(plan.approach.feedMmMin, units)} to ${zText(plan.approach.targetZ, units)} - ${length(v.clearanceMm, units)} above `
      + `${plan.tool === null ? 'the tool' : `T${plan.tool}`}'s recorded touch at ${zText(plan.approach.expectedContactZ, units)}. `
      + `This is a probe move: if the setter triggers early it stops, says where, and backs off ${length(v.retractMm, units)}`,
    )
  } else {
    add(`no approach descent - ${plan.noApproachReason}; the fast probe starts from ${zText(plan.fastFromZ, units)}`)
  }
  add(`fast probe down to ${zText(plan.searchFloorZ, units)} at ${feedText(v.fastFeed, units)} (up to ${length(round4(plan.fastFromZ - plan.searchFloorZ), units)})`)
  add(`retract ${length(v.retractMm, units)}`)
  add(`fine probe down up to ${length(v.fineSearchMm, units)} at ${feedText(v.fineFeed, units)} - this touch is the measurement`)
  add(`retract ${length(v.retractMm, units)} and record the touch as ${plan.tool === null ? 'the active tool length' : `T${plan.tool}'s length`}`)
  return lines
}
