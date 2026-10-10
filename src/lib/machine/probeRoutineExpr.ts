// WO-411 slice 1 - the probe routine expression language (contract section 2.5,
// docs/research/probe-routine-format.md).
//
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := '-' unary | primary
//   primary := NUMBER | IDENT | '(' expr ')'
//   IDENT   := namespace '.' name ('.' name)?
//
// Bounds: <= 64 tokens, parentheses <= 8 deep, finite literals, no calls, no
// exponent, no strings, no assignment, no loops. Five read-only namespaces.
// Nothing here touches eval/Function; the evaluator walks the AST.

export const EXPR_MAX_TOKENS = 64
export const EXPR_MAX_PAREN_DEPTH = 8

export type ExprNamespace = 'input' | 'touch' | 'calc' | 'probe' | 'start'
export const EXPR_NAMESPACES: readonly ExprNamespace[] = ['input', 'touch', 'calc', 'probe', 'start']

export const PROBE_NAMESPACE_MEMBERS = [
  'tipRadiusMm',
  'retractMm',
  'surfaceClearanceMm',
  'overtravelMm',
  'maxTravelMm',
  'crossOverLiftMm',
] as const
export type ProbeNamespaceMember = (typeof PROBE_NAMESPACE_MEMBERS)[number]

export const START_NAMESPACE_MEMBERS = ['x', 'y', 'z'] as const
export const TOUCH_RESULT_FIELDS = ['x', 'y', 'z', 'value'] as const
export type TouchResultField = (typeof TOUCH_RESULT_FIELDS)[number]

export type ExprBinaryOp = '+' | '-' | '*' | '/'

export type ExprToken =
  | { kind: 'num'; text: string; value: number; at: number }
  | { kind: 'ident'; text: string; at: number }
  | { kind: 'op'; text: ExprBinaryOp; at: number }
  | { kind: 'lparen'; text: '('; at: number }
  | { kind: 'rparen'; text: ')'; at: number }

/** Every node carries the source slice it came from, for sentences. */
export type ExprAst =
  | { type: 'num'; value: number; text: string }
  | { type: 'ref'; namespace: string; name: string; field: string | null; text: string }
  | { type: 'neg'; arg: ExprAst; text: string }
  | { type: 'bin'; op: ExprBinaryOp; left: ExprAst; right: ExprAst; text: string }

export type ExprFaultCode =
  | 'E_EXPR_UNBOUNDED'
  | 'E_EXPR_UNKNOWN_NAME'
  | 'E_EXPR_FORWARD_REFERENCE'
  | 'E_EXPR_ENUM_IN_ARITHMETIC'
  | 'E_CALC_NOT_FINITE'

export interface ExprFault {
  code: ExprFaultCode
  /** The plain sentence, without the step prefix; ends with a full stop. */
  sentence: string
  /** The offending token or name, when there is one. */
  token?: string
}

export interface ExprParseResult {
  /** Present whenever the grammar parsed, even when a bound was broken. */
  ast: ExprAst | null
  faults: ExprFault[]
  tokenCount: number
  parenDepth: number
  source: string
}

function unbounded(sentence: string, token?: string): ExprFault {
  return token === undefined
    ? { code: 'E_EXPR_UNBOUNDED', sentence }
    : { code: 'E_EXPR_UNBOUNDED', sentence, token }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*/
const NUMBER_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/

/**
 * Tokenize one expression. Returns the token list, or the first fault. The
 * token count and paren depth are computed here so an over-long expression
 * still reports both bounds in one sentence.
 */
export function tokenizeExpr(source: string): { tokens: ExprToken[]; fault: ExprFault | null } {
  const tokens: ExprToken[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen', text: '(', at: i })
      i += 1
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen', text: ')', at: i })
      i += 1
      continue
    }
    if (ch === '*' && source[i + 1] === '*') {
      return { tokens, fault: unbounded("the operator `**` is not allowed; a routine's arithmetic is only + - * and /.", '**') }
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', text: ch, at: i })
      i += 1
      continue
    }
    const rest = source.slice(i)
    const num = NUMBER_RE.exec(rest)
    if (num) {
      const text = num[0]
      const value = Number(text)
      if (!Number.isFinite(value)) {
        return { tokens, fault: unbounded(`the number \`${text}\` is not finite.`, text) }
      }
      tokens.push({ kind: 'num', text, value, at: i })
      i += text.length
      continue
    }
    const ident = IDENT_RE.exec(rest)
    if (ident) {
      const text = ident[0]
      tokens.push({ kind: 'ident', text, at: i })
      i += text.length
      continue
    }
    const bad = ch === '^' ? '^' : ch
    const why = ch === '^'
      ? 'the operator `^` is not allowed; a routine\'s arithmetic is only + - * and /.'
      : ch === '"' || ch === '\''
        ? 'strings are not allowed in an expression.'
        : ch === ','
          ? 'a comma is not allowed; there are no function calls or lists.'
          : ch === '='
            ? 'assignment is not allowed; a calc step names its result.'
            : `the character \`${ch}\` is not allowed in an expression.`
    return { tokens, fault: unbounded(why, bad) }
  }
  return { tokens, fault: null }
}

function parenDepthOf(tokens: ExprToken[]): number {
  let depth = 0
  let max = 0
  for (const token of tokens) {
    if (token.kind === 'lparen') {
      depth += 1
      if (depth > max) max = depth
    } else if (token.kind === 'rparen') {
      depth -= 1
    }
  }
  return max
}

class Parser {
  private pos = 0
  private readonly tokens: ExprToken[]
  private readonly source: string
  constructor(tokens: ExprToken[], source: string) {
    this.tokens = tokens
    this.source = source
  }

  private peek(): ExprToken | undefined {
    return this.tokens[this.pos]
  }

  private slice(from: number, toExclusive: number): string {
    const first = this.tokens[from]
    const last = this.tokens[toExclusive - 1]
    if (!first || !last) return ''
    return this.source.slice(first.at, last.at + last.text.length)
  }

  parse(): { ast: ExprAst | null; fault: ExprFault | null } {
    if (this.tokens.length === 0) {
      return { ast: null, fault: unbounded('the expression is empty.') }
    }
    try {
      const ast = this.expr()
      const trailing = this.peek()
      if (trailing) {
        if (trailing.kind === 'rparen') {
          throw unbounded('there is a `)` with no matching `(`.', ')')
        }
        throw unbounded(`unexpected \`${trailing.text}\` after the end of the expression.`, trailing.text)
      }
      return { ast, fault: null }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        return { ast: null, fault: error as ExprFault }
      }
      throw error
    }
  }

  private expr(): ExprAst {
    const start = this.pos
    let left = this.term()
    for (;;) {
      const token = this.peek()
      if (!token || token.kind !== 'op' || (token.text !== '+' && token.text !== '-')) break
      this.pos += 1
      const right = this.term()
      left = { type: 'bin', op: token.text, left, right, text: this.slice(start, this.pos) }
    }
    return left
  }

  private term(): ExprAst {
    const start = this.pos
    let left = this.unary()
    for (;;) {
      const token = this.peek()
      if (!token || token.kind !== 'op' || (token.text !== '*' && token.text !== '/')) break
      this.pos += 1
      const right = this.unary()
      left = { type: 'bin', op: token.text, left, right, text: this.slice(start, this.pos) }
    }
    return left
  }

  private unary(): ExprAst {
    const start = this.pos
    const token = this.peek()
    if (token && token.kind === 'op' && token.text === '-') {
      this.pos += 1
      const arg = this.unary()
      return { type: 'neg', arg, text: this.slice(start, this.pos) }
    }
    if (token && token.kind === 'op' && token.text === '+') {
      throw unbounded('a leading `+` is not allowed; only unary minus is.', '+')
    }
    return this.primary()
  }

  private primary(): ExprAst {
    const token = this.peek()
    if (!token) {
      throw unbounded('the expression ends where a number or a name was expected.')
    }
    if (token.kind === 'num') {
      this.pos += 1
      return { type: 'num', value: token.value, text: token.text }
    }
    if (token.kind === 'ident') {
      this.pos += 1
      const next = this.peek()
      if (next && next.kind === 'lparen') {
        throw unbounded(
          `function calls are not allowed (\`${token.text}(\`); a routine's arithmetic is only + - * and /.`,
          `${token.text}(`,
        )
      }
      const parts = token.text.split('.')
      return {
        type: 'ref',
        namespace: parts[0],
        name: parts[1] ?? '',
        field: parts.length > 2 ? parts.slice(2).join('.') : null,
        text: token.text,
      }
    }
    if (token.kind === 'lparen') {
      const start = this.pos
      this.pos += 1
      const inner = this.expr()
      const close = this.peek()
      if (!close || close.kind !== 'rparen') {
        throw unbounded('there is a `(` with no matching `)`.', '(')
      }
      this.pos += 1
      return { ...inner, text: this.slice(start, this.pos) }
    }
    if (token.kind === 'rparen') {
      throw unbounded('there is a `)` with no matching `(`.', ')')
    }
    throw unbounded(`unexpected \`${token.text}\`; a number or a name was expected.`, token.text)
  }
}

/**
 * Parse one expression (a string, or a JSON number where a literal is meant).
 * Bound violations (token count, paren depth) are reported as faults but the
 * AST is still returned when the grammar parsed, so later checks (names,
 * division by a constant zero) can still run on the same expression.
 */
export function parseExpr(source: string | number): ExprParseResult {
  if (typeof source === 'number') {
    if (!Number.isFinite(source)) {
      return {
        ast: null,
        faults: [unbounded(`the number \`${String(source)}\` is not finite.`, String(source))],
        tokenCount: 1,
        parenDepth: 0,
        source: String(source),
      }
    }
    return {
      ast: { type: 'num', value: source, text: String(source) },
      faults: [],
      tokenCount: 1,
      parenDepth: 0,
      source: String(source),
    }
  }
  const { tokens, fault: tokenFault } = tokenizeExpr(source)
  if (tokenFault) {
    return { ast: null, faults: [tokenFault], tokenCount: tokens.length, parenDepth: parenDepthOf(tokens), source }
  }
  const tokenCount = tokens.length
  const parenDepth = parenDepthOf(tokens)
  const faults: ExprFault[] = []
  const tooMany = tokenCount > EXPR_MAX_TOKENS
  const tooDeep = parenDepth > EXPR_MAX_PAREN_DEPTH
  if (tooMany && tooDeep) {
    faults.push(unbounded(
      `the expression has ${tokenCount} tokens (limit ${EXPR_MAX_TOKENS}) and parentheses ${parenDepth} deep (limit ${EXPR_MAX_PAREN_DEPTH}).`,
    ))
  } else if (tooMany) {
    faults.push(unbounded(`the expression has ${tokenCount} tokens (limit ${EXPR_MAX_TOKENS}).`))
  } else if (tooDeep) {
    faults.push(unbounded(`the expression has parentheses ${parenDepth} deep (limit ${EXPR_MAX_PAREN_DEPTH}).`))
  }
  const { ast, fault } = new Parser(tokens, source).parse()
  if (fault) faults.push(fault)
  return { ast, faults, tokenCount, parenDepth, source }
}

// --- static name resolution --------------------------------------------------

export type ExprInputType = 'length' | 'angle' | 'count' | 'enum'

/**
 * Whether a touch/calc name may be referenced from the expression being
 * checked. `later` = defined by a later step; `branch-arm` = defined inside a
 * branch arm that is not guaranteed to have run at this point.
 */
export type ExprNameAvailability =
  | { available: true }
  | { available: false; reason: 'later' | 'branch-arm'; stepNumber: number }

export interface ExprNameScope {
  inputs: ReadonlyMap<string, ExprInputType>
  touches: ReadonlyMap<string, ExprNameAvailability>
  calcs: ReadonlyMap<string, ExprNameAvailability>
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const d: number[] = new Array(rows * cols).fill(0)
  for (let i = 0; i < rows; i++) d[i * cols] = i
  for (let j = 0; j < cols; j++) d[j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1
      d[i * cols + j] = Math.min(
        d[(i - 1) * cols + j] + 1,
        d[i * cols + j - 1] + 1,
        d[(i - 1) * cols + j - 1] + cost,
      )
    }
  }
  return d[rows * cols - 1]
}

/** "(did you mean 'x'?)" for the closest candidate, or '' when there are none. */
export function didYouMean(name: string, candidates: Iterable<string>): string {
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best === null ? '' : ` (did you mean '${best}'?)`
}

function* refsOf(ast: ExprAst): Generator<Extract<ExprAst, { type: 'ref' }>> {
  if (ast.type === 'ref') yield ast
  else if (ast.type === 'neg') yield* refsOf(ast.arg)
  else if (ast.type === 'bin') {
    yield* refsOf(ast.left)
    yield* refsOf(ast.right)
  }
}

/**
 * Check every name in the AST against the static scope. Returns one fault per
 * offending reference, in source order. Pure; no machine values involved.
 */
export function checkExprNames(ast: ExprAst, scope: ExprNameScope): ExprFault[] {
  const faults: ExprFault[] = []
  for (const ref of refsOf(ast)) {
    const text = ref.text
    switch (ref.namespace) {
      case 'input': {
        if (!ref.name || ref.field !== null) {
          faults.push({
            code: 'E_EXPR_UNKNOWN_NAME',
            token: text,
            sentence: `\`${text}\` is not a name a routine can use; an input is written \`input.<name>\`.`,
          })
          break
        }
        const type = scope.inputs.get(ref.name)
        if (type === undefined) {
          faults.push({
            code: 'E_EXPR_UNKNOWN_NAME',
            token: text,
            sentence: `\`${text}\` is not an input of this routine${didYouMean(ref.name, scope.inputs.keys())}.`,
          })
        } else if (type === 'enum') {
          faults.push({
            code: 'E_EXPR_ENUM_IN_ARITHMETIC',
            token: text,
            sentence: `\`${text}\` is a choice (enum) input and cannot be used in arithmetic; only length, angle and count inputs can.`,
          })
        }
        break
      }
      case 'touch': {
        if (!ref.name || ref.field === null) {
          faults.push({
            code: 'E_EXPR_UNKNOWN_NAME',
            token: text,
            sentence: `\`${text}\` is incomplete; a touch result is written \`touch.<name>.x\`, \`.y\`, \`.z\` or \`.value\`.`,
          })
          break
        }
        const availability = scope.touches.get(ref.name)
        if (availability === undefined) {
          faults.push({
            code: 'E_EXPR_UNKNOWN_NAME',
            token: text,
            sentence: `\`${text}\`: '${ref.name}' is not a touch in this routine${didYouMean(ref.name, scope.touches.keys())}.`,
          })
          break
        }
        if (!(TOUCH_RESULT_FIELDS as readonly string[]).includes(ref.field)) {
          faults.push({
            code: 'E_EXPR_UNKNOWN_NAME',
            token: text,
            sentence: `\`${text}\`: a touch result has .x, .y, .z and .value, not .${ref.field}.`,
          })
          break
        }
        if (!availability.available) faults.push(forwardFault('touch', ref.name, text, availability))
        break
      }
      case 'calc': {
        if (!ref.name || ref.field !== null) {
          faults.push({
            code: 'E_EXPR_UNKNOWN_NAME',
            token: text,
            sentence: `\`${text}\` is not a name a routine can use; a calc result is written \`calc.<name>\`.`,
          })
          break
        }
        const availability = scope.calcs.get(ref.name)
        if (availability === undefined) {
          faults.push({
            code: 'E_EXPR_UNKNOWN_NAME',
            token: text,
            sentence: `\`${text}\` is not a calc in this routine${didYouMean(ref.name, scope.calcs.keys())}.`,
          })
          break
        }
        if (!availability.available) faults.push(forwardFault('calc', ref.name, text, availability))
        break
      }
      case 'probe': {
        if (!ref.name || ref.field !== null || !(PROBE_NAMESPACE_MEMBERS as readonly string[]).includes(ref.name)) {
          faults.push({
            code: 'E_EXPR_UNKNOWN_NAME',
            token: text,
            sentence: `\`${text}\` is not a probe value; the probe values are ${PROBE_NAMESPACE_MEMBERS.map((m) => `probe.${m}`).join(', ')}.`,
          })
        }
        break
      }
      case 'start': {
        if (!ref.name || ref.field !== null || !(START_NAMESPACE_MEMBERS as readonly string[]).includes(ref.name)) {
          faults.push({
            code: 'E_EXPR_UNKNOWN_NAME',
            token: text,
            sentence: `\`${text}\` is not a start coordinate; the start values are start.x, start.y and start.z.`,
          })
        }
        break
      }
      default:
        faults.push({
          code: 'E_EXPR_UNKNOWN_NAME',
          token: text,
          sentence: `\`${text}\` is not a name a routine can use; names start with input., touch., calc., probe. or start.`,
        })
    }
  }
  return faults
}

function forwardFault(
  what: 'touch' | 'calc',
  name: string,
  text: string,
  availability: Extract<ExprNameAvailability, { available: false }>,
): ExprFault {
  const sentence = availability.reason === 'later'
    ? `\`${text}\` refers to ${what} '${name}', which happens later (step ${availability.stepNumber}); a step may only use touches and calcs that come before it.`
    : `\`${text}\` refers to ${what} '${name}', which is inside a branch arm (step ${availability.stepNumber}) and may not have run; a name defined in a branch arm is usable only inside that arm.`
  return { code: 'E_EXPR_FORWARD_REFERENCE', token: text, sentence }
}

// --- structural zero (static E_CALC_NOT_FINITE) ------------------------------

function sameAst(a: ExprAst, b: ExprAst): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'num':
      return a.value === (b as typeof a).value
    case 'ref': {
      const o = b as typeof a
      return a.namespace === o.namespace && a.name === o.name && a.field === o.field
    }
    case 'neg':
      return sameAst(a.arg, (b as typeof a).arg)
    case 'bin': {
      const o = b as typeof a
      return a.op === o.op && sameAst(a.left, o.left) && sameAst(a.right, o.right)
    }
  }
}

/** True when the subtree is zero for every possible value of every name. */
export function isIdenticallyZero(ast: ExprAst): boolean {
  switch (ast.type) {
    case 'num':
      return ast.value === 0
    case 'ref':
      return false
    case 'neg':
      return isIdenticallyZero(ast.arg)
    case 'bin':
      if (ast.op === '-') return sameAst(ast.left, ast.right) || (isIdenticallyZero(ast.left) && isIdenticallyZero(ast.right))
      if (ast.op === '+') return isIdenticallyZero(ast.left) && isIdenticallyZero(ast.right)
      if (ast.op === '*') return isIdenticallyZero(ast.left) || isIdenticallyZero(ast.right)
      return isIdenticallyZero(ast.left) && !isIdenticallyZero(ast.right)
  }
}

/**
 * Find a division whose divisor is identically zero. Returns the divisor's
 * source text, or null. This is the STATIC half of E_CALC_NOT_FINITE: the
 * value-dependent half (a divisor that happens to be zero) belongs to the
 * expander's nominal evaluation and to the runner.
 */
export function findConstantZeroDivisor(ast: ExprAst): string | null {
  switch (ast.type) {
    case 'num':
    case 'ref':
      return null
    case 'neg':
      return findConstantZeroDivisor(ast.arg)
    case 'bin': {
      if (ast.op === '/' && isIdenticallyZero(ast.right)) return stripOuterParens(ast.right.text)
      return findConstantZeroDivisor(ast.left) ?? findConstantZeroDivisor(ast.right)
    }
  }
}

function stripOuterParens(text: string): string {
  let t = text.trim()
  while (t.startsWith('(') && t.endsWith(')')) {
    // only strip when the outer pair matches each other
    let depth = 0
    let matched = true
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth += 1
      else if (t[i] === ')') {
        depth -= 1
        if (depth === 0 && i < t.length - 1) {
          matched = false
          break
        }
      }
    }
    if (!matched) break
    t = t.slice(1, -1).trim()
  }
  return t
}

// --- evaluation ----------------------------------------------------------------

export interface ExprEvalScope {
  input: Readonly<Record<string, number>>
  touch: Readonly<Record<string, Readonly<Record<TouchResultField, number>>>>
  calc: Readonly<Record<string, number>>
  probe: Readonly<Record<ProbeNamespaceMember, number>>
  start: Readonly<{ x: number; y: number; z: number }>
}

export type ExprEvalResult =
  | { ok: true; value: number }
  | { ok: false; fault: ExprFault }

/**
 * Evaluate an AST against bound values. IEEE double; a non-finite result is
 * E_CALC_NOT_FINITE; a name missing from the scope is E_EXPR_UNKNOWN_NAME.
 * Never throws for a well-formed AST.
 */
export function evaluateExpr(ast: ExprAst, scope: ExprEvalScope): ExprEvalResult {
  const result = evalNode(ast, scope)
  if (!result.ok) return result
  if (!Number.isFinite(result.value)) {
    return {
      ok: false,
      fault: {
        code: 'E_CALC_NOT_FINITE',
        sentence: `\`${ast.text}\` does not come out as a number (division by zero or overflow).`,
        token: ast.text,
      },
    }
  }
  return result
}

function lookup(ref: Extract<ExprAst, { type: 'ref' }>, scope: ExprEvalScope): number | undefined {
  switch (ref.namespace) {
    case 'input':
      return ref.field === null ? scope.input[ref.name] : undefined
    case 'calc':
      return ref.field === null ? scope.calc[ref.name] : undefined
    case 'probe':
      return ref.field === null ? scope.probe[ref.name as ProbeNamespaceMember] : undefined
    case 'start':
      return ref.field === null ? scope.start[ref.name as 'x' | 'y' | 'z'] : undefined
    case 'touch': {
      if (ref.field === null) return undefined
      const touch = scope.touch[ref.name]
      if (!touch) return undefined
      return touch[ref.field as TouchResultField]
    }
    default:
      return undefined
  }
}

function evalNode(ast: ExprAst, scope: ExprEvalScope): ExprEvalResult {
  switch (ast.type) {
    case 'num':
      return { ok: true, value: ast.value }
    case 'ref': {
      const value = lookup(ast, scope)
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return {
          ok: false,
          fault: {
            code: 'E_EXPR_UNKNOWN_NAME',
            token: ast.text,
            sentence: `\`${ast.text}\` has no value at this point.`,
          },
        }
      }
      return { ok: true, value }
    }
    case 'neg': {
      const arg = evalNode(ast.arg, scope)
      return arg.ok ? { ok: true, value: -arg.value } : arg
    }
    case 'bin': {
      const left = evalNode(ast.left, scope)
      if (!left.ok) return left
      const right = evalNode(ast.right, scope)
      if (!right.ok) return right
      switch (ast.op) {
        case '+':
          return { ok: true, value: left.value + right.value }
        case '-':
          return { ok: true, value: left.value - right.value }
        case '*':
          return { ok: true, value: left.value * right.value }
        case '/':
          return { ok: true, value: left.value / right.value }
      }
    }
  }
}
