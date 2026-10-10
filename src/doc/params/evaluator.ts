// Pure expression evaluator (DOC lane, WO DOC-4; extended by WO DOC-4-R1.4.A/C).
//
// Evaluates a parsed ParamAst against a caller-supplied lookup of OTHER
// parameters' current values. Never throws -- every failure mode (unknown
// reference, division by zero, function domain error, overflow) is a typed
// ParamDiag result (AC #2: "typed errors, never throws-through"). Pure and
// total: for any well-formed AST and any lookup function, evaluate() returns
// exactly once, synchronously, with no recursion depth beyond the AST's own
// (bounded, caller-authored) expression tree -- it never walks INTO another
// parameter's expression (see params/executor.ts), so a cyclic parameter
// graph can never cause unbounded evaluation recursion here even in
// principle (the DAG also refuses to construct such a graph in the first
// place -- belt and suspenders, see params/table.ts).
//
// NaN/Infinity backstop (R1.4.C): NO evaluation path may ever return a
// non-finite number as a SUCCESSFUL result. `finite()` is the single choke
// point every numeric result (a literal, every binary op including '^', unary
// negation, and every function call) passes through -- a domain error
// (sqrt of a negative number, asin/acos outside [-1, 1], atan2(0, 0)) or any
// overflow to +/-Infinity or NaN becomes a typed PARAM_MATH_DOMAIN diagnostic
// instead of a committed value, so params/table.ts's "last-good value
// retained, never NaN/Infinity" guarantee holds by construction, not by
// caller discipline.

import type { FunctionName, ParamAst, ParamDiag } from './types'

export type ParamLookup = (name: string) => { ok: true; value: number } | { ok: false }

export type EvalResult = { ok: true; value: number } | { ok: false; diag: ParamDiag }

const DEG_PER_RAD = 180 / Math.PI
const RAD_PER_DEG = Math.PI / 180

function unknownRef(name: string): ParamDiag {
  return { code: 'PARAM_UNKNOWN_REFERENCE', severity: 'error', params: { name } }
}

function divisionByZero(): ParamDiag {
  return { code: 'PARAM_DIVISION_BY_ZERO', severity: 'error', params: {} }
}

function mathDomain(detail: string): ParamDiag {
  return { code: 'PARAM_MATH_DOMAIN', severity: 'error', params: { detail } }
}

/** The one choke point every numeric result passes through -- see the
 *  NaN/Infinity backstop note at the top of the file. */
function finite(value: number, context: string): EvalResult {
  if (!Number.isFinite(value)) {
    return { ok: false, diag: mathDomain(`${context} produced a non-finite result (${String(value)})`) }
  }
  return { ok: true, value }
}

function evaluateCall(fn: FunctionName, args: number[]): EvalResult {
  switch (fn) {
    case 'sin':
      return finite(Math.sin(args[0] * RAD_PER_DEG), `sin(${args[0]})`)
    case 'cos':
      return finite(Math.cos(args[0] * RAD_PER_DEG), `cos(${args[0]})`)
    case 'tan':
      return finite(Math.tan(args[0] * RAD_PER_DEG), `tan(${args[0]})`)
    case 'asin':
      if (args[0] < -1 || args[0] > 1) return { ok: false, diag: mathDomain(`asin(${args[0]}) is outside [-1, 1]`) }
      return finite(Math.asin(args[0]) * DEG_PER_RAD, `asin(${args[0]})`)
    case 'acos':
      if (args[0] < -1 || args[0] > 1) return { ok: false, diag: mathDomain(`acos(${args[0]}) is outside [-1, 1]`) }
      return finite(Math.acos(args[0]) * DEG_PER_RAD, `acos(${args[0]})`)
    case 'atan':
      return finite(Math.atan(args[0]) * DEG_PER_RAD, `atan(${args[0]})`)
    case 'atan2':
      if (args[0] === 0 && args[1] === 0) return { ok: false, diag: mathDomain('atan2(0, 0) is undefined') }
      return finite(Math.atan2(args[0], args[1]) * DEG_PER_RAD, `atan2(${args[0]}, ${args[1]})`)
    case 'sqrt':
      if (args[0] < 0) return { ok: false, diag: mathDomain(`sqrt(${args[0]}) is negative`) }
      return finite(Math.sqrt(args[0]), `sqrt(${args[0]})`)
    case 'abs':
      return finite(Math.abs(args[0]), `abs(${args[0]})`)
    case 'floor':
      return finite(Math.floor(args[0]), `floor(${args[0]})`)
    case 'ceil':
      return finite(Math.ceil(args[0]), `ceil(${args[0]})`)
    case 'round':
      return finite(Math.round(args[0]), `round(${args[0]})`)
    case 'min':
      return finite(Math.min(args[0], args[1]), `min(${args[0]}, ${args[1]})`)
    case 'max':
      return finite(Math.max(args[0], args[1]), `max(${args[0]}, ${args[1]})`)
  }
}

export function evaluate(ast: ParamAst, lookup: ParamLookup): EvalResult {
  switch (ast.type) {
    case 'num':
      return finite(ast.valueMm, 'this literal')
    case 'const':
      return finite(ast.value, `'${ast.name}'`)
    case 'ref': {
      const found = lookup(ast.name)
      if (!found.ok) return { ok: false, diag: unknownRef(ast.name) }
      return { ok: true, value: found.value }
    }
    case 'neg': {
      const arg = evaluate(ast.arg, lookup)
      if (!arg.ok) return arg
      return finite(-arg.value, 'negation')
    }
    case 'call': {
      const args: number[] = []
      for (const argAst of ast.args) {
        const result = evaluate(argAst, lookup)
        if (!result.ok) return result
        args.push(result.value)
      }
      return evaluateCall(ast.fn, args)
    }
    case 'bin': {
      const left = evaluate(ast.left, lookup)
      if (!left.ok) return left
      const right = evaluate(ast.right, lookup)
      if (!right.ok) return right
      switch (ast.op) {
        case '+':
          return finite(left.value + right.value, 'addition')
        case '-':
          return finite(left.value - right.value, 'subtraction')
        case '*':
          return finite(left.value * right.value, 'multiplication')
        case '/':
          if (right.value === 0) return { ok: false, diag: divisionByZero() }
          return finite(left.value / right.value, 'division')
        case '^':
          return finite(Math.pow(left.value, right.value), `${left.value}^${right.value}`)
      }
    }
  }
}
