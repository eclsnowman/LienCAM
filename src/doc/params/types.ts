// Parameters/expressions table types (DOC lane, WO DOC-4).
//
// docs/3d-modeling-plan.md §3.4: "Parameters/expressions: single reactive
// table; sketch dimensions and feature params can reference it; simple
// expression grammar (numbers, + - * / (), parameter refs, mm/in units) --
// evaluate with a tiny hand-rolled parser (no mathjs in core doc model; keep
// deterministic + serializable)."
//
// Pure TypeScript, zero kernel dependency: only plain-data types. The AST is
// intentionally plain-JSON (no class instances) so it can live directly inside
// a FeatureDag node's opaque `payload` (DagNodeInput.payload: "Opaque plain-
// JSON data ... Never geometry") and round-trip through FeatureDag.serialize/
// restore with no DOC-4-specific persistence code (see params/table.ts).

/** Unit suffix recognized by the parser. A bare number is 'mm' (canonical). */
export type Unit = 'mm' | 'in'

/** mm-per-unit conversion factor. Only a literal's OWN unit converts it --
 *  "1in + 2mm" evaluates as (1*25.4) + 2 = 27.4mm, never a whole-expression
 *  unit coercion. */
export const MM_PER_INCH = 25.4

export function toMm(raw: number, unit: Unit): number {
  return unit === 'in' ? raw * MM_PER_INCH : raw
}

/**
 * WO DOC-4-R1.4.A: the built-in function library for the
 * expressions engine.
 * Trig functions take/return DEGREES, never radians (params/evaluator.ts).
 * FUNCTION_ARITY is the single source of truth for both the parser's arity
 * check (wrong arity = edit-time PARAM_SYNTAX_ERROR, never silently
 * ignored/padded) and the evaluator's argument count.
 */
export const FUNCTION_NAMES = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sqrt',
  'abs',
  'floor',
  'ceil',
  'round',
  'min',
  'max',
] as const

export type FunctionName = (typeof FUNCTION_NAMES)[number]

/** atan2/min/max take exactly 2 arguments; every other function takes exactly 1. */
export const FUNCTION_ARITY: Readonly<Record<FunctionName, number>> = {
  sin: 1,
  cos: 1,
  tan: 1,
  asin: 1,
  acos: 1,
  atan: 1,
  atan2: 2,
  sqrt: 1,
  abs: 1,
  floor: 1,
  ceil: 1,
  round: 1,
  min: 2,
  max: 2,
}

const FUNCTION_NAME_SET: ReadonlySet<string> = new Set(FUNCTION_NAMES)

export function isFunctionName(name: string): name is FunctionName {
  return FUNCTION_NAME_SET.has(name)
}

/**
 * Deterministic AST. Every variant is a plain object literal built the same
 * way on every parse of the same source, so JSON.stringify(ast) is byte-
 * identical across repeated parses of identical input (AC #1's determinism
 * golden) -- there is no Map/Set iteration, no random id, no wall-clock field
 * anywhere in this tree. `const`/`call` (R1.4.A) hold the same invariant:
 * `pi`'s value is the fixed Math.PI constant (never a clock/random read) and
 * a function call's `args` is an ordinary plain-array of child ASTs.
 */
export type ParamAst =
  | { type: 'num'; raw: number; unit: Unit | null; valueMm: number }
  | { type: 'ref'; name: string }
  | { type: 'const'; name: 'pi'; value: number }
  | { type: 'neg'; arg: ParamAst }
  | { type: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: ParamAst; right: ParamAst }
  | { type: 'call'; fn: FunctionName; args: ParamAst[] }

/**
 * DOC-local structured diagnostic codes for the parameter table (same
 * constraint as dag.ts's DagDiag / regen/status.ts's RegenDiag: geom-
 * service.ts's DiagCode is frozen and cannot grow parameter-specific codes).
 * Never string-parsed by a caller -- always a typed `code` + structured
 * `params`. EDIT-TIME (setExpression returns ok:false, nothing mutated):
 * PARAM_SYNTAX_ERROR, PARAM_SELF_REFERENCE, PARAM_CYCLE, PARAM_UNKNOWN_FUNCTION.
 * EVAL-TIME (the edit commits ok:true; the failure surfaces afterward via
 * statusOf/diagnosticsOf, last-good value retained): PARAM_UNKNOWN_REFERENCE,
 * PARAM_DIVISION_BY_ZERO, PARAM_MATH_DOMAIN. See params/table.ts's
 * setExpression doc comment for the full contract SKC-4 is cut against.
 */
export type ParamDiagCode =
  | 'PARAM_SYNTAX_ERROR'
  | 'PARAM_UNKNOWN_REFERENCE'
  | 'PARAM_DIVISION_BY_ZERO'
  | 'PARAM_SELF_REFERENCE'
  | 'PARAM_CYCLE'
  | 'PARAM_UNKNOWN_FUNCTION'
  | 'PARAM_MATH_DOMAIN'

export interface ParamDiag {
  code: ParamDiagCode
  severity: 'error'
  params: Record<string, string>
}

/** Structured refusal for an unparseable expression -- fail loud, matching
 *  stable-id.ts's FragmentTieError / dag.ts's DagCycleError ethos: a caller
 *  always gets a typed diagnostic, never a bare string exception to parse. */
export class ParamParseError extends Error {
  readonly diagnostic: ParamDiag
  constructor(diagnostic: ParamDiag, message: string) {
    super(message)
    this.name = 'ParamParseError'
    this.diagnostic = diagnostic
  }
}
