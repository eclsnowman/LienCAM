// Hand-rolled deterministic expression parser (DOC lane, WO DOC-4, ruling 2;
// extended by WO DOC-4-R1.4.A/B, Operator's expressions-polish riders).
//
// Grammar (the WHOLE grammar -- deliberately minimal per the Architect ruling
// "NO mathjs, NO eval/new Function, NO new deps"):
//
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := '-' unary | power
//   power   := primary ('^' unary)?      -- RIGHT-associative (2^3^2 =
//              2^(3^2) = 512): the exponent's own right-hand side re-enters
//              `unary`, so it may itself carry a leading '-' (2^-2 = 0.25)
//              and chain further '^'. Binds TIGHTER than unary minus on the
//              LEFT/base side: `unary` wraps '-' around the WHOLE power
//              production, so -2^2 = -(2^2) = -4, matching standard mathematical precedence
//              math convention (golden-table row, parser.test.ts).
//   primary := NUMBER [unit] | 'pi' | IDENT '(' expr (',' expr)* ')'
//              | IDENT | '(' expr ')'
//   unit    := 'mm' | 'in'                      -- immediately after a number
//              literal (whitespace-tolerant: the tokenizer already elides
//              whitespace between tokens); ONLY the literal it decorates is
//              converted -- "1in + 2mm" = (1*25.4) + 2 = 27.4mm. A bare
//              number is mm. A parameter reference is never unit-decorated
//              (units apply to LITERALS, not to whole sub-expressions).
//
// Functions (R1.4.A, class-leader parity for an expressions engine): sin,
// cos, tan, asin, acos, atan, atan2, sqrt, abs, floor, ceil, round, min, max
// -- see types.ts's FUNCTION_NAMES/FUNCTION_ARITY (the single source of
// truth both this parser's arity check and the evaluator use). atan2/min/max
// take exactly 2 args; every other function takes exactly 1 -- a wrong
// argument count is an edit-time PARAM_SYNTAX_ERROR naming the function and
// its expected arity, nothing is silently padded/truncated. An identifier
// immediately followed by '(' that is NOT one of these names is a distinct
// edit-time PARAM_UNKNOWN_FUNCTION. `pi` is a reserved constant (alongside
// the `mm`/`in` unit suffixes) -- params/table.ts's RESERVED_NAMES rejects it
// as a parameter name.
//
// Positioned diagnostics (R1.4.B, "the polished in polished"): every
// PARAM_SYNTAX_ERROR/PARAM_UNKNOWN_FUNCTION carries `params.pos` (the
// character offset into `source`, as a string) and `params.snippet` (the
// exact source text of the offending token, or 'end of expression' for a
// diagnostic anchored at eof) -- enough for a future UI to render an inline
// caret. Messages are plain language (no parser-internal jargon like "EOF"
// or "<expr>").
//
// Determinism (AC #1): tokenize/parse are pure functions of the source string
// -- no Math.random, no Date.now, no Map/Set iteration order dependence.
// Parsing the same source twice yields byte-identical
// JSON.stringify(ast) output (the golden/determinism test asserts this
// directly). Every failure mode (illegal character, malformed number,
// unexpected/missing token, trailing input, unknown function, wrong arity)
// is a typed ParamParseError carrying a structured diagnostic -- never a
// bare exception with a message a caller would have to string-match.

import { FUNCTION_ARITY, isFunctionName, type FunctionName, type ParamAst, type Unit } from './types'
import { ParamParseError, toMm } from './types'

type TokenKind = 'num' | 'ident' | '+' | '-' | '*' | '/' | '^' | '(' | ')' | ',' | 'eof'

interface Token {
  kind: TokenKind
  pos: number
  /** Exact source text of this token ('' for eof) -- used verbatim as a
   *  positioned diagnostic's human-readable snippet (R1.4.B). */
  text: string
  value?: number
  name?: string
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9'
}

function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_')
}

function isIdentPart(c: string | undefined): boolean {
  return isIdentStart(c) || isDigit(c)
}

function isWhitespace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

/** Plain-language description of a token for a diagnostic message/snippet --
 *  never a raw parser-internal kind like 'eof'. */
function describeToken(tok: Token): string {
  return tok.kind === 'eof' ? 'end of expression' : tok.text
}

function syntaxError(pos: number, detail: string, snippet: string): ParamParseError {
  return new ParamParseError(
    { code: 'PARAM_SYNTAX_ERROR', severity: 'error', params: { pos: String(pos), detail, snippet } },
    `Parameter expression: ${detail} (position ${pos}, near '${snippet}').`,
  )
}

function syntaxErrorAt(tok: Token, detail: string): ParamParseError {
  return syntaxError(tok.pos, detail, describeToken(tok))
}

function unknownFunctionError(tok: Token): ParamParseError {
  const name = tok.name as string
  return new ParamParseError(
    { code: 'PARAM_UNKNOWN_FUNCTION', severity: 'error', params: { pos: String(tok.pos), name, snippet: name } },
    `Parameter expression: unknown function '${name}' (position ${tok.pos}, near '${name}').`,
  )
}

function arityError(tok: Token, expected: number, actual: number): ParamParseError {
  const name = tok.name as string
  const detail = `function '${name}' expects ${expected} argument${expected === 1 ? '' : 's'} but got ${actual}`
  return syntaxError(tok.pos, detail, name)
}

/**
 * Tokenizes `source` into a token stream terminated by a single 'eof' token.
 * Throws ParamParseError(PARAM_SYNTAX_ERROR) on any character that cannot
 * start a valid token -- never silently skips or guesses.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    if (isWhitespace(c)) {
      i++
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      const start = i
      while (isDigit(source[i])) i++
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i++
        while (isDigit(source[i])) i++
      }
      const raw = source.slice(start, i)
      tokens.push({ kind: 'num', pos: start, text: raw, value: Number(raw) })
      continue
    }
    if (isIdentStart(c)) {
      const start = i
      while (isIdentPart(source[i])) i++
      const name = source.slice(start, i)
      tokens.push({ kind: 'ident', pos: start, text: name, name })
      continue
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '^' || c === '(' || c === ')' || c === ',') {
      tokens.push({ kind: c, pos: i, text: c })
      i++
      continue
    }
    throw syntaxError(i, `unexpected character '${c}'`, c)
  }
  tokens.push({ kind: 'eof', pos: n, text: '' })
  return tokens
}

const UNIT_NAMES = new Set(['mm', 'in'])

class Parser {
  private readonly tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  peek(): Token {
    return this.tokens[this.pos]
  }

  private advance(): Token {
    return this.tokens[this.pos++]
  }

  parseExpr(): ParamAst {
    let node = this.parseTerm()
    for (;;) {
      const k = this.peek().kind
      if (k !== '+' && k !== '-') return node
      this.advance()
      const right = this.parseTerm()
      node = { type: 'bin', op: k, left: node, right }
    }
  }

  private parseTerm(): ParamAst {
    let node = this.parseUnary()
    for (;;) {
      const k = this.peek().kind
      if (k !== '*' && k !== '/') return node
      this.advance()
      const right = this.parseUnary()
      node = { type: 'bin', op: k, left: node, right }
    }
  }

  private parseUnary(): ParamAst {
    if (this.peek().kind === '-') {
      this.advance()
      return { type: 'neg', arg: this.parseUnary() }
    }
    return this.parsePower()
  }

  /** power := primary ('^' unary)?  -- see the grammar note at the top of the file. */
  private parsePower(): ParamAst {
    const base = this.parsePrimary()
    if (this.peek().kind === '^') {
      this.advance()
      const exponent = this.parseUnary()
      return { type: 'bin', op: '^', left: base, right: exponent }
    }
    return base
  }

  private parsePrimary(): ParamAst {
    const tok = this.peek()
    if (tok.kind === 'num') {
      this.advance()
      let unit: Unit | null = null
      const next = this.peek()
      if (next.kind === 'ident' && next.name !== undefined && UNIT_NAMES.has(next.name)) {
        unit = this.advance().name as Unit
      }
      const raw = tok.value as number
      return { type: 'num', raw, unit, valueMm: toMm(raw, unit ?? 'mm') }
    }
    if (tok.kind === 'ident') {
      this.advance()
      const name = tok.name as string
      if (this.peek().kind === '(') {
        return this.parseCall(tok)
      }
      if (name === 'pi') {
        return { type: 'const', name: 'pi', value: Math.PI }
      }
      return { type: 'ref', name }
    }
    if (tok.kind === '(') {
      this.advance()
      const inner = this.parseExpr()
      if (this.peek().kind !== ')') throw syntaxErrorAt(this.peek(), "expected ')'")
      this.advance()
      return inner
    }
    throw syntaxErrorAt(tok, `unexpected ${describeToken(tok)}`)
  }

  /** Parses `name(arg, arg, ...)` -- `nameTok` is the already-peeked-but-not-
   *  yet-advanced identifier token; `this.peek()` is the '(' that follows it. */
  private parseCall(nameTok: Token): ParamAst {
    const name = nameTok.name as string
    if (!isFunctionName(name)) throw unknownFunctionError(nameTok)
    this.advance() // consume '('
    const args: ParamAst[] = []
    if (this.peek().kind !== ')') {
      args.push(this.parseExpr())
      while (this.peek().kind === ',') {
        this.advance()
        args.push(this.parseExpr())
      }
    }
    const closeTok = this.peek()
    if (closeTok.kind !== ')') throw syntaxErrorAt(closeTok, "expected ')'")
    this.advance()
    const expected = FUNCTION_ARITY[name as FunctionName]
    if (args.length !== expected) throw arityError(nameTok, expected, args.length)
    return { type: 'call', fn: name as FunctionName, args }
  }
}

/** Sorted, de-duplicated set of parameter names an AST references. */
export function collectRefs(ast: ParamAst): string[] {
  const found = new Set<string>()
  const stack: ParamAst[] = [ast]
  while (stack.length > 0) {
    const node = stack.pop() as ParamAst
    switch (node.type) {
      case 'ref':
        found.add(node.name)
        break
      case 'neg':
        stack.push(node.arg)
        break
      case 'bin':
        stack.push(node.left, node.right)
        break
      case 'call':
        stack.push(...node.args)
        break
      case 'num':
      case 'const':
        break
    }
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export interface ParsedExpression {
  ast: ParamAst
  refs: string[]
}

/**
 * Parses one parameter expression. Throws ParamParseError(PARAM_SYNTAX_ERROR
 * or PARAM_UNKNOWN_FUNCTION) on any malformed input, including trailing
 * tokens after a complete expression (e.g. "1 2", "1)"). Deterministic:
 * identical `source` always yields byte-identical `ast` (see serializeAst).
 */
export function parseExpression(source: string): ParsedExpression {
  const tokens = tokenize(source)
  const parser = new Parser(tokens)
  const ast = parser.parseExpr()
  const trailing = parser.peek()
  if (trailing.kind !== 'eof') {
    throw syntaxErrorAt(trailing, `unexpected ${describeToken(trailing)} after the end of the expression`)
  }
  return { ast, refs: collectRefs(ast) }
}

/** Canonical serialization of an AST -- see the determinism note at top of file. */
export function serializeAst(ast: ParamAst): string {
  return JSON.stringify(ast)
}
