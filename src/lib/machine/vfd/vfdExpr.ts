// WO-425 - scale expressions for a VFD definition.
//
// A VFD definition never carries code. Every place where one inverter differs
// from another by ARITHMETIC - "the frequency register is RPM / 2.4", "the
// status word is Hz x 100", "power is volts x amps" - carries an expression
// string instead, and that string is parsed and evaluated by the bounded
// evaluator that already landed for probe routines
// (src/lib/machine/probeRoutineExpr.ts): an AST walk, no `eval`, no `Function`,
// <= 64 tokens, parentheses <= 8 deep, only + - * / and unary minus.
//
// That evaluator's namespaces are probe-routine ones (input/touch/calc/probe/
// start). Rather than fork the parser, a VFD reference is REWRITTEN onto the
// `input.` namespace with its full dotted name as the key
// (`set.rpm` -> input["set.rpm"]) after parsing. So there is exactly one
// tokenizer, one parser and one evaluator in the product, and this file only
// decides which names exist and what they mean.
//
// Namespaces:
//   set.rpm        the commanded spindle speed, RPM  (setpoint direction only)
//   raw.value      the register word as read, unsigned (status direction only)
//   field.<name>   an ALREADY DECODED status field, earlier in the list
//   vfd.<name>     a constant declared by the definition (maxRpm, poles, ...)

import {
  evaluateExpr,
  findConstantZeroDivisor,
  parseExpr,
  type ExprAst,
  type ExprEvalScope,
  type ExprFault,
  type ProbeNamespaceMember,
} from '../probeRoutineExpr'

/** Which names an expression is allowed to use, decided by where it sits. */
export type VfdExprDirection = 'setpoint' | 'status'

export const VFD_EXPR_NAMESPACES = ['set', 'raw', 'field', 'vfd'] as const
export type VfdExprNamespace = (typeof VFD_EXPR_NAMESPACES)[number]

export interface VfdExprScopeShape {
  direction: VfdExprDirection
  /** Constant names the definition declares, referenced as `vfd.<name>`. */
  constants: readonly string[]
  /** Status field names decoded BEFORE this expression, as `field.<name>`. */
  earlierFields: readonly string[]
}

export interface VfdExprCheck {
  ast: ExprAst | null
  faults: ExprFault[]
}

const ZERO_PROBE: Record<ProbeNamespaceMember, number> = {
  tipRadiusMm: 0,
  retractMm: 0,
  surfaceClearanceMm: 0,
  overtravelMm: 0,
  maxTravelMm: 0,
  crossOverLiftMm: 0,
}

function unknown(text: string, sentence: string): ExprFault {
  return { code: 'E_EXPR_UNKNOWN_NAME', token: text, sentence }
}

/** Every `ref` node in the tree, in source order. */
function refsOf(ast: ExprAst, out: Extract<ExprAst, { type: 'ref' }>[]): void {
  if (ast.type === 'ref') out.push(ast)
  else if (ast.type === 'neg') refsOf(ast.arg, out)
  else if (ast.type === 'bin') {
    refsOf(ast.left, out)
    refsOf(ast.right, out)
  }
}

/**
 * Rewrite VFD references onto the probe evaluator's `input.` namespace, keyed
 * by the whole dotted name. Pure; returns a new tree and leaves `text` alone so
 * fault sentences still quote what the author wrote.
 */
export function bindVfdExpr(ast: ExprAst): ExprAst {
  switch (ast.type) {
    case 'num':
      return ast
    case 'ref':
      return {
        type: 'ref',
        namespace: 'input',
        name: ast.field === null ? `${ast.namespace}.${ast.name}` : `${ast.namespace}.${ast.name}.${ast.field}`,
        field: null,
        text: ast.text,
      }
    case 'neg':
      return { type: 'neg', arg: bindVfdExpr(ast.arg), text: ast.text }
    case 'bin':
      return { type: 'bin', op: ast.op, left: bindVfdExpr(ast.left), right: bindVfdExpr(ast.right), text: ast.text }
  }
}

/** The names this scope shape makes legal, as the flat keys `bindVfdExpr` produces. */
export function legalVfdNames(shape: VfdExprScopeShape): string[] {
  const names: string[] = []
  if (shape.direction === 'setpoint') names.push('set.rpm')
  else names.push('raw.value')
  for (const field of shape.earlierFields) names.push(`field.${field}`)
  for (const constant of shape.constants) names.push(`vfd.${constant}`)
  return names
}

/**
 * Parse one scale expression and check its names against the shape. Returns the
 * bound AST (ready for `evaluateVfdExpr`) plus every fault, in source order.
 * A grammar fault means `ast` is null; a name fault does not.
 */
export function checkVfdExpr(source: string | number, shape: VfdExprScopeShape): VfdExprCheck {
  const parsed = parseExpr(source)
  const faults: ExprFault[] = [...parsed.faults]
  if (!parsed.ast) return { ast: null, faults }

  const refs: Extract<ExprAst, { type: 'ref' }>[] = []
  refsOf(parsed.ast, refs)
  const legal = new Set(legalVfdNames(shape))
  const list = legalVfdNames(shape).join(', ')

  for (const ref of refs) {
    const flat = ref.field === null ? `${ref.namespace}.${ref.name}` : `${ref.namespace}.${ref.name}.${ref.field}`
    if (!ref.name) {
      faults.push(unknown(ref.text, `\`${ref.text}\` is not a name a VFD definition can use; the names here are ${list}.`))
      continue
    }
    if (!(VFD_EXPR_NAMESPACES as readonly string[]).includes(ref.namespace)) {
      faults.push(unknown(ref.text, `\`${ref.text}\` is not a name a VFD definition can use; names start with set., raw., field. or vfd.`))
      continue
    }
    if (ref.namespace === 'set' && shape.direction !== 'setpoint') {
      faults.push(unknown(ref.text, `\`${ref.text}\` is the commanded speed and can only be used by the setpoint scale, not by a status field.`))
      continue
    }
    if (ref.namespace === 'raw' && shape.direction !== 'status') {
      faults.push(unknown(ref.text, `\`${ref.text}\` is a register word read back and can only be used by a status field, not by the setpoint scale.`))
      continue
    }
    if (!legal.has(flat)) {
      if (ref.namespace === 'field') {
        faults.push(unknown(
          ref.text,
          `\`${ref.text}\` is not a status field decoded before this one; a field may only use fields above it in the list.`,
        ))
      } else if (ref.namespace === 'vfd') {
        faults.push(unknown(ref.text, `\`${ref.text}\` is not a constant this definition declares.`))
      } else {
        faults.push(unknown(ref.text, `\`${ref.text}\` is not a name a VFD definition can use; the names here are ${list}.`))
      }
      continue
    }
  }

  const zeroDivisor = findConstantZeroDivisor(parsed.ast)
  if (zeroDivisor !== null) {
    faults.push({
      code: 'E_CALC_NOT_FINITE',
      token: zeroDivisor,
      sentence: `\`${parsed.ast.text}\` divides by \`${zeroDivisor}\`, which is always zero.`,
    })
  }

  return { ast: bindVfdExpr(parsed.ast), faults }
}

export interface VfdExprValues {
  /** `set.rpm`, when the setpoint scale is being evaluated. */
  setRpm?: number
  /** `raw.value`, when a register-sourced status field is being decoded. */
  rawValue?: number
  /** `field.<name>` for every field already decoded. */
  fields?: Readonly<Record<string, number>>
  /** `vfd.<name>` for every declared constant. */
  constants?: Readonly<Record<string, number>>
}

/** Evaluate a BOUND AST (the one `checkVfdExpr` returned) against real values. */
export function evaluateVfdExpr(
  ast: ExprAst,
  values: VfdExprValues,
): { ok: true; value: number } | { ok: false; fault: ExprFault } {
  const input: Record<string, number> = {}
  if (values.setRpm !== undefined) input['set.rpm'] = values.setRpm
  if (values.rawValue !== undefined) input['raw.value'] = values.rawValue
  for (const [name, value] of Object.entries(values.fields ?? {})) input[`field.${name}`] = value
  for (const [name, value] of Object.entries(values.constants ?? {})) input[`vfd.${name}`] = value
  const scope: ExprEvalScope = {
    input,
    touch: {},
    calc: {},
    probe: ZERO_PROBE,
    start: { x: 0, y: 0, z: 0 },
  }
  return evaluateExpr(ast, scope)
}
