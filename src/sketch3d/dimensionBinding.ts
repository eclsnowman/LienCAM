// Driving-dimension <-> parameter-table binding (WO SKC-4, WP3.5).
//
// A distance/angle/radius/diameter constraint's `value` can be DRIVEN by a
// DOC-4 parameter-table expression instead of typed directly. This module is
// the whole binding surface: it REUSES DOC-4's parser/evaluator verbatim via
// its public barrel (Architect ruling 2 -- "Expression input reuses DOC-4's
// parser (import the public API) -- do NOT re-implement expression parsing
// in the sketch lane") and owns nothing else: no parallel expression
// grammar, no forked evaluation semantics.
//
// Edit-time vs eval-time split mirrors params/table.ts's own setExpression
// contract exactly: a malformed expression (syntax error, unknown function)
// is rejected IMMEDIATELY, before the document is touched
// (`bindDimensionExpression` returns ok:false); a well-formed expression
// always commits, and an unknown-reference/division-by-zero/math-domain
// failure surfaces later, at EVALUATION time (`evaluateDrivingDimensions`),
// leaving the dimension's last-good `value` untouched -- never silently 0,
// never dropping the constraint (the WO's own FAILS-IF).
//
// No AST is cached on the constraint: `source` is re-parsed at evaluation
// time. The parser is pure/cheap/deterministic, so this trades a negligible
// amount of CPU for avoiding a second piece of state (a cached ast) that
// could drift from `expression` -- there is exactly one source of truth.

import { evaluate, ParamParseError, parseExpression, type ParamDiag, type ParamLookup } from '../doc/params'
import type { Sketch3dConstraint, Sketch3dDocument } from './types'

/** The four value-bearing constraint kinds a driving-dimension expression can bind to. */
export type Sketch3dDimensionConstraint = Extract<
  Sketch3dConstraint,
  { kind: 'distance' | 'angle' | 'radius' | 'diameter' }
>

export function isDimensionConstraint(c: Sketch3dConstraint): c is Sketch3dDimensionConstraint {
  return c.kind === 'distance' || c.kind === 'angle' || c.kind === 'radius' || c.kind === 'diameter'
}

/** SKC-4-local structural diagnostics -- these describe binding a
 *  NONEXISTENT/non-dimension constraint, never an expression-grammar
 *  problem, so they get their own codes rather than extending DOC-4's
 *  ParamDiagCode (which this module never forks). */
export type Sketch3dDimensionDiagCode = 'DIMENSION_NOT_FOUND' | 'DIMENSION_NOT_DRIVABLE'

export interface Sketch3dDimensionDiag {
  code: Sketch3dDimensionDiagCode
  severity: 'error'
  params: Record<string, string>
}

export type Sketch3dBindDiag = ParamDiag | Sketch3dDimensionDiag

export type Sketch3dBindOutcome =
  | { ok: true; document: Sketch3dDocument }
  | { ok: false; diag: Sketch3dBindDiag }

function findConstraint(document: Sketch3dDocument, constraintId: string): Sketch3dConstraint | undefined {
  return document.constraints.find((c) => c.id === constraintId)
}

/**
 * Binds `source` as constraintId's driving expression. Rejects (ok:false,
 * document untouched) when: constraintId doesn't exist, it isn't one of the
 * four value-bearing kinds, or `source` fails to parse (DOC-4's own
 * PARAM_SYNTAX_ERROR/PARAM_UNKNOWN_FUNCTION, surfaced verbatim, unwrapped).
 * A successful bind ALWAYS commits (even a forward/dangling parameter
 * reference is legal, exactly like DOC-4's own setExpression) -- evaluation
 * failures surface later via evaluateDrivingDimensions.
 */
export function bindDimensionExpression(
  document: Sketch3dDocument,
  constraintId: string,
  source: string,
): Sketch3dBindOutcome {
  const target = findConstraint(document, constraintId)
  if (!target) {
    return { ok: false, diag: { code: 'DIMENSION_NOT_FOUND', severity: 'error', params: { constraintId } } }
  }
  if (!isDimensionConstraint(target)) {
    return {
      ok: false,
      diag: { code: 'DIMENSION_NOT_DRIVABLE', severity: 'error', params: { constraintId, kind: target.kind } },
    }
  }
  try {
    parseExpression(source) // validate only -- re-parsed at eval time (see module comment)
  } catch (e) {
    if (e instanceof ParamParseError) return { ok: false, diag: e.diagnostic }
    throw e
  }
  return {
    ok: true,
    document: {
      ...document,
      constraints: document.constraints.map((c) => (c.id === constraintId ? { ...c, expression: source } : c)),
    },
  }
}

/** Reverts a dimension to a plain literal -- its current `value` is kept as-is. */
export function unbindDimensionExpression(document: Sketch3dDocument, constraintId: string): Sketch3dDocument {
  return {
    ...document,
    constraints: document.constraints.map((c) => {
      if (c.id !== constraintId || c.expression === undefined) return c
      const { expression: _drop, ...rest } = c
      return rest as Sketch3dConstraint
    }),
  }
}

/** Every parameter name referenced by ANY bound dimension expression in this
 *  document, sorted+deduped -- the set a DAG node hosting this document must
 *  `consumes` so a parameter edit's dirty-closure reaches it (ruling 4). */
export function dimensionParameterRefs(document: Sketch3dDocument): string[] {
  const refs = new Set<string>()
  for (const c of document.constraints) {
    if (!isDimensionConstraint(c) || c.expression === undefined) continue
    // A malformed expression cannot have been committed (bindDimensionExpression
    // rejects it up front) -- re-parsing here is safe and never throws in practice.
    for (const name of parseExpression(c.expression).refs) refs.add(name)
  }
  return [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export interface Sketch3dDimensionDiagnostic {
  constraintId: string
  diag: ParamDiag
}

export interface Sketch3dEvaluateResult {
  document: Sketch3dDocument
  /** One entry per bound dimension whose expression FAILED to evaluate this
   *  pass (unknown reference, division by zero, math domain) -- sorted by
   *  constraintId for determinism. Empty when every bound expression evaluated
   *  cleanly. */
  diagnostics: Sketch3dDimensionDiagnostic[]
}

/**
 * Re-evaluates every bound dimension's expression against `lookup` (a
 * parameter-value resolver -- see regen.ts's makeSketch3dExecutor, which
 * reads a shared FeatureDag directly, the same pattern DOC-4's own
 * evaluateParameterNode uses) and writes the result back into each
 * constraint's `value`. Never throws: a failing expression leaves that
 * dimension's `value` exactly as it was (last-good, per the WO's FAILS-IF)
 * and is reported in `diagnostics` instead -- it never silently evaluates to
 * 0 and never drops the constraint.
 */
export function evaluateDrivingDimensions(document: Sketch3dDocument, lookup: ParamLookup): Sketch3dEvaluateResult {
  const diagnostics: Sketch3dDimensionDiagnostic[] = []
  const constraints = document.constraints.map((c) => {
    if (!isDimensionConstraint(c) || c.expression === undefined) return c
    const { ast } = parseExpression(c.expression)
    const result = evaluate(ast, lookup)
    if (!result.ok) {
      diagnostics.push({ constraintId: c.id, diag: result.diag })
      return c
    }
    return { ...c, value: result.value }
  })
  diagnostics.sort((a, b) => (a.constraintId < b.constraintId ? -1 : a.constraintId > b.constraintId ? 1 : 0))
  return { document: { ...document, constraints }, diagnostics }
}
