// "sketch-dim equations wiring" hitlist item -- pure resolver for dimension VALUE-editor input.
//
// VETTING (2026-07-22): the hitlist's own 2026-07-21 rewrite note said "the full expression/
// parameter engine ALREADY EXISTS - src/doc/params/ (DOC-4) + the ParametersTable UI. The residual
// is wiring sketch dimension input (still parseFloat-only) to that engine." That is confirmed
// still true (SketchDimensionOverlay.tsx's DrivableDimValueInput was parseFloat/parseDimToMm-only
// before this file existed) -- but the vetting surfaced a wrinkle the hitlist note did not: DOC-4's
// `ParameterTable` (params/table.ts) is NAMED-PARAMETER support, and it is wired to a `FeatureDag`
// that only exists inside the 3D modeling workspace document (constructed locally in
// SolidsWorkbenchPage.tsx). The CAM sketcher's document (src/store/index.ts) has no FeatureDag and
// no project-parameter concept at all. Wiring NAMED references into only the 3D modeling workspace sketcher
// would violate the HARD sketcher-parity rule (CLAUDE.md: "3D modeling workspace + CAM sketchers FULL
// PARITY... improvements to one are improvements to both"), and building an equivalent named-
// parameter store for CAM projects is materially larger than this lane's scope.
//
// The part of DOC-4 that IS reusable as-is, with zero FeatureDag/store coupling, is the pure
// grammar: `params/parser.ts#parseExpression` + `params/evaluator.ts#evaluate` take/return plain
// data and accept an arbitrary `ParamLookup` callback. This module wires exactly that: arithmetic
// expressions (+ - * / ^, mm/in unit suffixes, sin/cos/sqrt/... functions per params/types.ts's
// FUNCTION_NAMES) work IDENTICALLY in both sketchers today. Named parameter/dimension references
// are deliberately OUT of v1 (`NO_REFS` below always reports "unknown reference", a typed,
// fail-loud diagnostic -- never a crash, never a silent 0) -- see the module note above. A future
// WO can widen `NO_REFS` once CAM gains an equivalent named-value store, and it will light up in
// both sketchers together by construction (this module and the overlay that calls it are shared,
// unfamiliar to which host is asking).
import { evaluate, type ParamLookup } from '../../doc/params/evaluator'
import { parseExpression } from '../../doc/params/parser'
import { ParamParseError, type ParamDiag } from '../../doc/params/types'
import { parseDimToMm, toDisplay, unitLabel, type Units } from '../ui/unitFormat'

/** No sketch-local or project-parameter references exist yet for either sketcher (see module doc)
 *  -- every `ref` node reports "unknown", a typed PARAM_UNKNOWN_REFERENCE diagnostic, never a
 *  crash or a silent fallback value. */
const NO_REFS: ParamLookup = () => ({ ok: false })

export type CountInputResult =
  | { ok: true; countFloat: number; expression?: string }
  | { ok: false; message: string }

export type DimInputResult =
  | { ok: true; mm: number; expression?: string }
  | { ok: false; message: string }

/**
 * Resolve raw count-field text to the dimensionless number it represents.
 * Mirrors `resolveDimInput`: plain text keeps the pre-existing `parseInt`
 * behavior byte-for-byte, while "=<expr>" is evaluated by the same DOC-4
 * engine so pattern counts can use arithmetic expressions.
 */
export function resolveCountInput(raw: string): CountInputResult {
  if (!isEquationInput(raw)) {
    const v = parseInt(raw, 10)
    if (!Number.isFinite(v)) return { ok: false, message: 'not a number' }
    return { ok: true, countFloat: v }
  }
  const trimmed = raw.trim()
  const source = trimmed.slice(1)
  if (source.trim() === '') return { ok: false, message: 'empty equation' }
  let parsed
  try {
    parsed = parseExpression(source)
  } catch (err) {
    if (err instanceof ParamParseError) return { ok: false, message: formatParamDiag(err.diagnostic) }
    throw err
  }
  const result = evaluate(parsed.ast, NO_REFS)
  if (!result.ok) return { ok: false, message: formatParamDiag(result.diag) }
  return { ok: true, countFloat: result.value, expression: trimmed }
}

/** Resolve a count-field value and coerce it to the integer the tool setter will
 *  accept, using the same truncation rule `parseInt` applies to typed decimals.
 *  Returns an error message if the expression is invalid or the coerced value
 *  is not positive / below the field's declared minimum. */
export function resolveCountToInteger(raw: string, min: number): { ok: true; count: number; expression?: string } | { ok: false; message: string } {
  const r = resolveCountInput(raw)
  if (!r.ok) return r
  const count = Math.trunc(r.countFloat)
  if (count <= 0) return { ok: false, message: 'must be positive' }
  if (count < min) return { ok: false, message: `must be at least ${min}` }
  return { ok: true, count, expression: r.expression }
}


/** Field-inline, plain-language text for a ParamDiag (ADR-0003 "no silent fallbacks": a typed
 *  error the user can read at the input, never a bare exception or a quiet revert). */
export function formatParamDiag(diag: ParamDiag): string {
  switch (diag.code) {
    case 'PARAM_SYNTAX_ERROR':
      return diag.params.detail || (diag.params.snippet ? `unexpected "${diag.params.snippet}"` : 'syntax error')
    case 'PARAM_UNKNOWN_FUNCTION':
      return `unknown function "${diag.params.snippet ?? diag.params.name ?? '?'}"`
    case 'PARAM_UNKNOWN_REFERENCE':
      return `"${diag.params.name}" is not a known value (named references aren't supported in sketch equations yet)`
    case 'PARAM_DIVISION_BY_ZERO':
      return 'division by zero'
    case 'PARAM_MATH_DOMAIN':
      return diag.params.detail || 'result is not a real number'
    case 'PARAM_SELF_REFERENCE':
      return 'self reference'
    case 'PARAM_CYCLE':
      return 'circular reference'
    default:
      return 'invalid equation'
  }
}

/** True for text the value editor should treat as an equation ("=" prefix
 *  convention -- also this codebase's own established affordance, see SketchConfirmOverlay note
 *  below). Leading whitespace tolerated ("  =1+2"). */
export function isEquationInput(raw: string): boolean {
  return raw.trim().startsWith('=')
}

/**
 * Resolve raw dimension-value-editor text to the mm (linear dims) / radians (angle dims) number to
 * commit. Mirrors, and is a strict superset of, the pre-existing plain-number path (parseFloat /
 * parseDimToMm) that both SketchDimensionOverlay callers used before this WO -- text with no
 * leading "=" resolves EXACTLY as before, byte-for-byte (today's tests for that path are untouched
 * by this module).
 *
 * "=<expr>" activates equation mode, evaluated by the DOC-4 engine (see module doc for the
 * named-reference scope note). Bare numeric literals inside an equation are ALWAYS millimeters
 * (params/types.ts's own mm-canonical convention -- matches the 3D modeling workspace Parameters table, so
 * an equation reads the same no matter which sketcher wrote it), regardless of the sketch's active
 * display-unit toggle; an explicit "in" suffix opts a literal into inches ("=1in/2"). This is a
 * deliberate, DOCUMENTED departure from the plain-number path (which reads a bare number in the
 * ACTIVE DISPLAY units) so a saved equation means the same thing forever, independent of a later
 * unit-toggle flip -- the equation-grammar convention. Angle dimensions: the
 * evaluated result is used directly in DEGREES (a bare unitless literal's mm-conversion is the
 * identity, so this is a plain arithmetic result; params/evaluator.ts's trig functions already
 * take/return degrees), matching today's plain-angle path one-for-one.
 */
export function resolveDimInput(raw: string, isAngle: boolean, units: Units): DimInputResult {
  if (isEquationInput(raw)) {
    const trimmed = raw.trim()
    const source = trimmed.slice(1)
    if (source.trim() === '') return { ok: false, message: 'empty equation' }
    let parsed
    try {
      parsed = parseExpression(source)
    } catch (err) {
      if (err instanceof ParamParseError) return { ok: false, message: formatParamDiag(err.diagnostic) }
      throw err // an unexpected non-ParamParseError is a real bug -- fail loud, don't swallow it here
    }
    const result = evaluate(parsed.ast, NO_REFS)
    if (!result.ok) return { ok: false, message: formatParamDiag(result.diag) }
    const mm = isAngle ? (result.value * Math.PI) / 180 : result.value
    return { ok: true, mm, expression: trimmed }
  }
  const mm = isAngle ? (parseFloat(raw) * Math.PI) / 180 : parseDimToMm(raw, units)
  if (Number.isNaN(mm)) return { ok: false, message: 'not a number' }
  return { ok: true, mm }
}

/** Live preview text for an in-progress "=..." edit (null for plain-number text -- the existing
 *  path has no live preview and none is added here). Success shows the resolved value in the
 *  field's own OWN display convention (angle: degrees; linear: active display units, matching what
 *  committing would show once re-opened); failure shows the same fail-loud message
 *  `resolveDimInput` would refuse to commit. */
export function previewDimInput(raw: string, isAngle: boolean, units: Units): { text: string; isError: boolean } | null {
  if (!isEquationInput(raw)) return null
  const r = resolveDimInput(raw, isAngle, units)
  if (!r.ok) return { text: r.message, isError: true }
  const shown = isAngle ? (r.mm * 180) / Math.PI : toDisplay(r.mm, units)
  const trimmed = +shown.toFixed(4)
  return { text: `= ${trimmed} ${isAngle ? 'deg' : unitLabel(units)}`, isError: false }
}
