// WO-1680: THE MACRO LANGUAGE - JavaScript, run by an interpreter of our own.
//
// A macro body is JavaScript (Operator ruling 2026-09-18: "JavaScript in a sandbox"),
// and it must never reach the page: NOT `eval`, NOT `new Function`. This file
// parses a body into a tree and walks it. The walk is a generator, so the
// runtime (`macroRuntime.ts`) drives it one effect at a time:
//
//   - every macro API call (`line`, `goTo`, `wait`, `hold`...) is YIELDED to
//     the runtime, which does it and resumes the walk with the result - the
//     only door from a body to the machine, and the only place a Stop or an
//     E-STOP needs to be checked;
//   - every STEP_SLICE steps the walk yields a slice, so the runtime hands the
//     thread back to the UI - a busy loop can never freeze the app;
//   - STEP_BUDGET steps without one API call end the macro (an endless loop).
//
// The language is the everyday part of JavaScript: let/const/var, functions
// (declared, expressions, arrows), if/else, for, for...of, while, do...while,
// break/continue/return, the usual operators, arrays, plain objects, strings,
// template literals, and a pure `Math`. Nothing else is in scope: a name the
// body did not declare and the API did not grant is simply not defined.
// Property access is a whitelist - own data on the macro's own objects, and a
// fixed list of string/array/number methods - so `constructor`, `__proto__`
// and every other road back to the host realm reads as undefined.

export const STEP_SLICE = 2_000
export const STEP_BUDGET = 200_000
const MAX_CALL_DEPTH = 200

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MacroSyntaxError extends Error {
  readonly line: number
  readonly column: number
  constructor(message: string, line: number, column: number) {
    super(message)
    this.line = line
    this.column = column
  }
}

export class MacroRuntimeError extends Error {
  readonly line: number
  constructor(message: string, line: number) {
    super(message)
    this.line = line
  }
}

export class MacroBudgetError extends Error {
  readonly line: number
  constructor(line: number) {
    super(`it ran ${STEP_BUDGET} steps without one machine call - an endless loop?`)
    this.line = line
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenType = 'num' | 'str' | 'tpl' | 'name' | 'punc' | 'eof'
interface Token {
  t: TokenType
  v: string
  n?: number
  /** Template literal: the cooked strings and the source of each `${}`. */
  tpl?: { strings: string[]; exprs: { src: string; line: number; col: number }[] }
  line: number
  col: number
  /** A line break precedes this token (automatic semicolons). */
  nl: boolean
}

const PUNCTUATORS = [
  '===', '!==', '**=', '...', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '?.',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '!', '?', ':', '=', '.',
]

function tokenize(src: string, line0 = 1, col0 = 1): Token[] {
  const tokens: Token[] = []
  let i = 0
  let line = line0
  let col = col0
  let nl = false
  const advance = (count: number) => {
    for (let k = 0; k < count; k++) {
      if (src[i] === '\n') {
        line++
        col = 1
      } else {
        col++
      }
      i++
    }
  }
  const fail = (message: string): never => {
    throw new MacroSyntaxError(message, line, col)
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      nl = true
      advance(1)
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') {
      advance(1)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance(1)
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) fail('this comment is never closed')
      if (src.slice(i, end).includes('\n')) nl = true
      advance(end + 2 - i)
      continue
    }
    const startLine = line
    const startCol = col
    const push = (t: TokenType, v: string, extra: Partial<Token> = {}) => {
      tokens.push({ t, v, line: startLine, col: startCol, nl, ...extra })
      nl = false
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:[0-9][0-9_]*)?\.?[0-9_]*(?:[eE][+-]?[0-9]+)?)/.exec(src.slice(i))
      const text = m ? m[0] : c
      const value = Number(text.replace(/_/g, ''))
      if (Number.isNaN(value)) fail(`"${text}" is not a number`)
      if (/[A-Za-z_$]/.test(src[i + text.length] ?? '')) fail(`"${text}${src[i + text.length]}" is not a number`)
      push('num', text, { n: value })
      advance(text.length)
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i))!
      push('name', m[0])
      advance(m[0].length)
      continue
    }
    if (c === '"' || c === "'") {
      advance(1)
      let out = ''
      while (true) {
        if (i >= src.length || src[i] === '\n') fail('this string is never closed')
        const ch = src[i]
        if (ch === c) {
          advance(1)
          break
        }
        if (ch === '\\') {
          out += readEscape()
          continue
        }
        out += ch
        advance(1)
      }
      push('str', out)
      continue
    }
    if (c === '`') {
      advance(1)
      const strings: string[] = []
      const exprs: { src: string; line: number; col: number }[] = []
      let out = ''
      while (true) {
        if (i >= src.length) fail('this template literal is never closed')
        const ch = src[i]
        if (ch === '`') {
          advance(1)
          break
        }
        if (ch === '\\') {
          out += readEscape()
          continue
        }
        if (ch === '$' && src[i + 1] === '{') {
          strings.push(out)
          out = ''
          advance(2)
          const exprLine = line
          const exprCol = col
          let depth = 1
          const start = i
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
            if (depth > 0) advance(1)
          }
          if (depth > 0) fail('this ${ is never closed')
          exprs.push({ src: src.slice(start, i), line: exprLine, col: exprCol })
          advance(1)
          continue
        }
        out += ch
        advance(1)
      }
      strings.push(out)
      push('tpl', '`', { tpl: { strings, exprs } })
      continue
    }
    const punc = PUNCTUATORS.find((p) => src.startsWith(p, i))
    if (!punc) fail(`unexpected character "${c}"`)
    push('punc', punc!)
    advance(punc!.length)
  }
  tokens.push({ t: 'eof', v: '', line, col, nl: true })
  return tokens

  function readEscape(): string {
    advance(1)
    const e = src[i]
    advance(1)
    switch (e) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '0': return '\0'
      case 'b': return '\b'
      case 'f': return '\f'
      case 'v': return '\v'
      case 'x': {
        const hex = src.slice(i, i + 2)
        advance(2)
        return String.fromCharCode(parseInt(hex, 16))
      }
      case 'u': {
        const hex = src.slice(i, i + 4)
        advance(4)
        return String.fromCharCode(parseInt(hex, 16))
      }
      case '\n': return ''
      default: return e ?? ''
    }
  }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

type Node = { line: number } & (
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'tpl'; strings: string[]; exprs: Node[] }
  | { k: 'lit'; v: boolean | null | undefined }
  | { k: 'id'; name: string }
  | { k: 'arr'; items: Node[] }
  | { k: 'obj'; props: { key: string | Node; value: Node }[] }
  | { k: 'fn'; name: string | null; params: Param[]; body: Node; arrow: boolean; exprBody: boolean }
  | { k: 'unary'; op: string; arg: Node }
  | { k: 'update'; op: '++' | '--'; prefix: boolean; arg: Node }
  | { k: 'bin'; op: string; left: Node; right: Node }
  | { k: 'logic'; op: '&&' | '||' | '??'; left: Node; right: Node }
  | { k: 'cond'; test: Node; yes: Node; no: Node }
  | { k: 'assign'; op: string; target: Node; value: Node }
  | { k: 'member'; obj: Node; prop: Node | string; optional: boolean }
  | { k: 'call'; callee: Node; args: Node[]; optional: boolean }
  | { k: 'seq'; items: Node[] }
  | { k: 'var'; kind: 'var' | 'let' | 'const'; decls: { name: string; init: Node | null }[] }
  | { k: 'expr'; expr: Node }
  | { k: 'block'; body: Node[] }
  | { k: 'if'; test: Node; yes: Node; no: Node | null }
  | { k: 'for'; init: Node | null; test: Node | null; update: Node | null; body: Node }
  | { k: 'forof'; kind: 'var' | 'let' | 'const' | null; name: string; iter: Node; body: Node }
  | { k: 'while'; test: Node; body: Node }
  | { k: 'dowhile'; test: Node; body: Node }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'return'; arg: Node | null }
  | { k: 'empty' }
)

interface Param { name: string; init: Node | null }

const RESERVED = new Set([
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue',
  'true', 'false', 'null', 'undefined', 'typeof', 'of', 'in', 'new', 'this', 'class', 'import', 'export',
  'try', 'catch', 'finally', 'throw', 'switch', 'case', 'default', 'delete', 'void', 'yield', 'await',
  'async', 'with', 'instanceof', 'debugger', 'super', 'extends',
])
/** Words the parser knows but a macro cannot use, with what to write instead. */
const UNSUPPORTED: Record<string, string> = {
  new: 'macros have no "new"',
  this: 'macros have no "this"',
  class: 'macros have no classes - use functions and objects',
  import: 'macros cannot import anything',
  export: 'macros cannot export anything',
  try: 'macros have no try/catch',
  throw: 'macros have no throw - use return',
  switch: 'macros have no switch - use if / else if',
  with: 'macros have no "with"',
  async: 'macros need no async - every machine call already waits',
  await: 'macros need no await - every machine call already waits',
  delete: 'macros have no delete',
  yield: 'macros have no generators',
  debugger: 'macros have no debugger',
  super: 'macros have no classes',
  in: 'macros have no "in" operator',
  instanceof: 'macros have no "instanceof"',
}

class Parser {
  private pos = 0
  private readonly tokens: Token[]
  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private get tok(): Token {
    return this.tokens[this.pos]
  }
  private peek(offset = 1): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]
  }
  private fail(message: string, tok: Token = this.tok): never {
    throw new MacroSyntaxError(message, tok.line, tok.col)
  }
  private describe(tok: Token): string {
    if (tok.t === 'eof') return 'the end of the macro'
    if (tok.t === 'str') return 'a string'
    if (tok.t === 'tpl') return 'a template literal'
    return `"${tok.v}"`
  }
  private is(v: string): boolean {
    return (this.tok.t === 'punc' || this.tok.t === 'name') && this.tok.v === v
  }
  private eat(v: string): boolean {
    if (!this.is(v)) return false
    this.pos++
    return true
  }
  private expect(v: string): Token {
    if (!this.is(v)) this.fail(`expected "${v}" but found ${this.describe(this.tok)}`)
    return this.tokens[this.pos++]
  }
  private name(): string {
    const tok = this.tok
    if (tok.t !== 'name') this.fail(`expected a name but found ${this.describe(tok)}`)
    if (RESERVED.has(tok.v)) this.fail(UNSUPPORTED[tok.v] ?? `"${tok.v}" is a reserved word`)
    this.pos++
    return tok.v
  }
  private semicolon(): void {
    if (this.eat(';')) return
    if (this.is('}') || this.tok.t === 'eof' || this.tok.nl) return
    this.fail(`expected ";" or a new line but found ${this.describe(this.tok)}`)
  }

  program(): Node[] {
    const body: Node[] = []
    while (this.tok.t !== 'eof') body.push(this.statement())
    return body
  }

  statement(): Node {
    const tok = this.tok
    const line = tok.line
    if (tok.t === 'punc') {
      if (tok.v === '{') return this.block()
      if (tok.v === ';') {
        this.pos++
        return { k: 'empty', line }
      }
    }
    if (tok.t === 'name') {
      if (UNSUPPORTED[tok.v] && tok.v !== 'in' && tok.v !== 'instanceof') this.fail(UNSUPPORTED[tok.v])
      switch (tok.v) {
        case 'var':
        case 'let':
        case 'const': {
          const node = this.varDecl()
          this.semicolon()
          return node
        }
        case 'function': {
          this.pos++
          const name = this.name()
          const fn = this.functionRest(name, line)
          return { k: 'var', kind: 'var', decls: [{ name, init: fn }], line }
        }
        case 'if': {
          this.pos++
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          const yes = this.statement()
          const no = this.eat('else') ? this.statement() : null
          return { k: 'if', test, yes, no, line }
        }
        case 'while': {
          this.pos++
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          return { k: 'while', test, body: this.statement(), line }
        }
        case 'do': {
          this.pos++
          const body = this.statement()
          this.expect('while')
          this.expect('(')
          const test = this.expression()
          this.expect(')')
          this.eat(';')
          return { k: 'dowhile', test, body, line }
        }
        case 'for':
          return this.forStatement()
        case 'break':
        case 'continue': {
          this.pos++
          this.semicolon()
          return tok.v === 'break' ? { k: 'break', line } : { k: 'continue', line }
        }
        case 'return': {
          this.pos++
          const arg = this.is(';') || this.is('}') || this.tok.t === 'eof' || this.tok.nl ? null : this.expression()
          this.semicolon()
          return { k: 'return', arg, line }
        }
      }
    }
    const expr = this.expression()
    this.semicolon()
    return { k: 'expr', expr, line }
  }

  private block(): Node {
    const line = this.expect('{').line
    const body: Node[] = []
    while (!this.is('}')) {
      if (this.tok.t === 'eof') this.fail('a "{" is never closed with "}"')
      body.push(this.statement())
    }
    this.pos++
    return { k: 'block', body, line }
  }

  private varDecl(): Node & { k: 'var' } {
    const tok = this.tokens[this.pos++]
    const kind = tok.v as 'var' | 'let' | 'const'
    const decls: { name: string; init: Node | null }[] = []
    do {
      const name = this.name()
      const init = this.eat('=') ? this.assignment() : null
      if (kind === 'const' && init === null) this.fail(`const "${name}" needs a value`)
      decls.push({ name, init })
    } while (this.eat(','))
    return { k: 'var', kind, decls, line: tok.line }
  }

  private forStatement(): Node {
    const line = this.tokens[this.pos++].line
    this.expect('(')
    if ((this.is('let') || this.is('const') || this.is('var')) && this.peek(2).v === 'of' && this.peek(2).t === 'name') {
      const kind = this.tokens[this.pos++].v as 'var' | 'let' | 'const'
      const name = this.name()
      this.expect('of')
      const iter = this.assignment()
      this.expect(')')
      return { k: 'forof', kind, name, iter, body: this.statement(), line }
    }
    if (this.tok.t === 'name' && this.peek().v === 'of' && this.peek().t === 'name') {
      const name = this.name()
      this.expect('of')
      const iter = this.assignment()
      this.expect(')')
      return { k: 'forof', kind: null, name, iter, body: this.statement(), line }
    }
    let init: Node | null = null
    if (this.is('let') || this.is('const') || this.is('var')) init = this.varDecl()
    else if (!this.is(';')) init = { k: 'expr', expr: this.expression(), line }
    this.expect(';')
    const test = this.is(';') ? null : this.expression()
    this.expect(';')
    const update = this.is(')') ? null : this.expression()
    this.expect(')')
    return { k: 'for', init, test, update, body: this.statement(), line }
  }

  private params(): Param[] {
    this.expect('(')
    const params: Param[] = []
    while (!this.is(')')) {
      const name = this.name()
      params.push({ name, init: this.eat('=') ? this.assignment() : null })
      if (!this.eat(',')) break
    }
    this.expect(')')
    return params
  }

  private functionRest(name: string | null, line: number): Node {
    const params = this.params()
    const body = this.block()
    return { k: 'fn', name, params, body, arrow: false, exprBody: false, line }
  }

  expression(): Node {
    const first = this.assignment()
    if (!this.is(',')) return first
    const items = [first]
    while (this.eat(',')) items.push(this.assignment())
    return { k: 'seq', items, line: first.line }
  }

  private arrowAhead(): boolean {
    if (this.tok.t === 'name' && this.peek().v === '=>' && this.peek().t === 'punc') return true
    if (!this.is('(')) return false
    let depth = 0
    for (let j = this.pos; j < this.tokens.length; j++) {
      const t = this.tokens[j]
      if (t.t === 'eof') return false
      if (t.t !== 'punc') continue
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++
      else if (t.v === ')' || t.v === ']' || t.v === '}') {
        depth--
        if (depth === 0) {
          const next = this.tokens[j + 1]
          return next.t === 'punc' && next.v === '=>'
        }
      }
    }
    return false
  }

  private arrow(): Node {
    const line = this.tok.line
    const params: Param[] = this.tok.t === 'name' ? [{ name: this.name(), init: null }] : this.params()
    this.expect('=>')
    if (this.is('{')) return { k: 'fn', name: null, params, body: this.block(), arrow: true, exprBody: false, line }
    return { k: 'fn', name: null, params, body: this.assignment(), arrow: true, exprBody: true, line }
  }

  private assignment(): Node {
    if (this.arrowAhead()) return this.arrow()
    const left = this.conditional()
    const tok = this.tok
    if (tok.t === 'punc' && ['=', '+=', '-=', '*=', '/=', '%=', '**=', '??='].includes(tok.v)) {
      if (left.k !== 'id' && left.k !== 'member') this.fail('only a name or a property can be assigned to', tok)
      this.pos++
      return { k: 'assign', op: tok.v, target: left, value: this.assignment(), line: tok.line }
    }
    return left
  }

  private conditional(): Node {
    const test = this.binary(0)
    if (!this.is('?')) return test
    const line = this.tokens[this.pos++].line
    const yes = this.assignment()
    this.expect(':')
    const no = this.assignment()
    return { k: 'cond', test, yes, no, line }
  }

  private static readonly PRECEDENCE: Record<string, number> = {
    '??': 1, '||': 2, '&&': 3,
    '==': 6, '!=': 6, '===': 6, '!==': 6,
    '<': 7, '>': 7, '<=': 7, '>=': 7,
    '+': 9, '-': 9,
    '*': 10, '/': 10, '%': 10,
    '**': 11,
  }

  private binary(minPrec: number): Node {
    let left = this.unary()
    while (true) {
      const tok = this.tok
      if (tok.t === 'name' && (tok.v === 'in' || tok.v === 'instanceof')) this.fail(UNSUPPORTED[tok.v])
      const prec = tok.t === 'punc' ? Parser.PRECEDENCE[tok.v] : undefined
      if (prec === undefined || prec <= minPrec) return left
      this.pos++
      // `**` is right-associative.
      const right = this.binary(tok.v === '**' ? prec - 1 : prec)
      left = tok.v === '&&' || tok.v === '||' || tok.v === '??'
        ? { k: 'logic', op: tok.v, left, right, line: tok.line }
        : { k: 'bin', op: tok.v, left, right, line: tok.line }
    }
  }

  private unary(): Node {
    const tok = this.tok
    if (tok.t === 'punc' && (tok.v === '!' || tok.v === '-' || tok.v === '+')) {
      this.pos++
      return { k: 'unary', op: tok.v, arg: this.unary(), line: tok.line }
    }
    if (tok.t === 'name' && tok.v === 'typeof') {
      this.pos++
      return { k: 'unary', op: 'typeof', arg: this.unary(), line: tok.line }
    }
    if (tok.t === 'name' && (tok.v === 'void' || tok.v === 'delete')) this.fail(UNSUPPORTED[tok.v] ?? 'macros have no "void"')
    if (tok.t === 'punc' && (tok.v === '++' || tok.v === '--')) {
      this.pos++
      const arg = this.unary()
      if (arg.k !== 'id' && arg.k !== 'member') this.fail(`"${tok.v}" needs a name or a property`, tok)
      return { k: 'update', op: tok.v, prefix: true, arg, line: tok.line }
    }
    const expr = this.postfix()
    if (this.tok.t === 'punc' && (this.tok.v === '++' || this.tok.v === '--') && !this.tok.nl) {
      const op = this.tokens[this.pos++].v as '++' | '--'
      if (expr.k !== 'id' && expr.k !== 'member') this.fail(`"${op}" needs a name or a property`)
      return { k: 'update', op, prefix: false, arg: expr, line: expr.line }
    }
    return expr
  }

  private postfix(): Node {
    let expr = this.primary()
    while (true) {
      const tok = this.tok
      if (tok.t !== 'punc') return expr
      if (tok.v === '.' || tok.v === '?.') {
        this.pos++
        const optional = tok.v === '?.'
        if (optional && this.is('(')) {
          expr = { k: 'call', callee: expr, args: this.args(), optional: true, line: tok.line }
          continue
        }
        if (optional && this.is('[')) {
          this.pos++
          const prop = this.expression()
          this.expect(']')
          expr = { k: 'member', obj: expr, prop, optional: true, line: tok.line }
          continue
        }
        const nameTok = this.tok
        if (nameTok.t !== 'name') this.fail(`expected a property name after "${tok.v}"`)
        this.pos++
        expr = { k: 'member', obj: expr, prop: nameTok.v, optional, line: tok.line }
      } else if (tok.v === '[') {
        this.pos++
        const prop = this.expression()
        this.expect(']')
        expr = { k: 'member', obj: expr, prop, optional: false, line: tok.line }
      } else if (tok.v === '(') {
        expr = { k: 'call', callee: expr, args: this.args(), optional: false, line: tok.line }
      } else {
        return expr
      }
    }
  }

  private args(): Node[] {
    this.expect('(')
    const args: Node[] = []
    while (!this.is(')')) {
      if (this.is('...')) this.fail('macros have no spread "..."')
      args.push(this.assignment())
      if (!this.eat(',')) break
    }
    this.expect(')')
    return args
  }

  private primary(): Node {
    const tok = this.tok
    const line = tok.line
    switch (tok.t) {
      case 'num':
        this.pos++
        return { k: 'num', v: tok.n!, line }
      case 'str':
        this.pos++
        return { k: 'str', v: tok.v, line }
      case 'tpl': {
        this.pos++
        const exprs = tok.tpl!.exprs.map((e) => {
          const parser = new Parser(tokenize(e.src, e.line, e.col))
          const node = parser.expression()
          if (parser.tok.t !== 'eof') parser.fail(`unexpected ${parser.describe(parser.tok)} inside \${}`)
          return node
        })
        return { k: 'tpl', strings: tok.tpl!.strings, exprs, line }
      }
      case 'name': {
        switch (tok.v) {
          case 'true':
          case 'false':
            this.pos++
            return { k: 'lit', v: tok.v === 'true', line }
          case 'null':
            this.pos++
            return { k: 'lit', v: null, line }
          case 'undefined':
            this.pos++
            return { k: 'lit', v: undefined, line }
          case 'function': {
            this.pos++
            const name = this.tok.t === 'name' ? this.name() : null
            return this.functionRest(name, line)
          }
        }
        return { k: 'id', name: this.name(), line }
      }
      case 'punc': {
        if (tok.v === '(') {
          this.pos++
          const expr = this.expression()
          this.expect(')')
          return expr
        }
        if (tok.v === '[') {
          this.pos++
          const items: Node[] = []
          while (!this.is(']')) {
            if (this.is('...')) this.fail('macros have no spread "..."')
            items.push(this.assignment())
            if (!this.eat(',')) break
          }
          this.expect(']')
          return { k: 'arr', items, line }
        }
        if (tok.v === '{') {
          this.pos++
          const props: { key: string | Node; value: Node }[] = []
          while (!this.is('}')) {
            const keyTok = this.tok
            let key: string | Node
            if (keyTok.t === 'name' || keyTok.t === 'str') {
              key = keyTok.v
              this.pos++
            } else if (keyTok.t === 'num') {
              key = String(keyTok.n)
              this.pos++
            } else if (this.eat('[')) {
              key = this.assignment()
              this.expect(']')
            } else {
              this.fail(`expected a property name but found ${this.describe(keyTok)}`)
            }
            if (typeof key === 'string' && keyTok.t === 'name' && (this.is(',') || this.is('}'))) {
              if (RESERVED.has(key)) this.fail(`"${key}" is a reserved word`, keyTok)
              props.push({ key, value: { k: 'id', name: key, line: keyTok.line } })
            } else if (typeof key === 'string' && keyTok.t === 'name' && this.is('(')) {
              props.push({ key, value: this.functionRest(key, keyTok.line) })
            } else {
              this.expect(':')
              props.push({ key, value: this.assignment() })
            }
            if (!this.eat(',')) break
          }
          this.expect('}')
          return { k: 'obj', props, line }
        }
      }
    }
    return this.fail(`unexpected ${this.describe(tok)}`)
  }
}

/** Parse a macro body. Throws `MacroSyntaxError` with the line and column. */
export function parseMacro(body: string): MacroProgram {
  const parser = new Parser(tokenize(body))
  return { body: parser.program() }
}

export interface MacroProgram {
  readonly body: Node[]
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A function written in the macro. */
class Closure {
  readonly node: Node & { k: 'fn' }
  readonly env: Scope
  constructor(node: Node & { k: 'fn' }, env: Scope) {
    this.node = node
    this.env = env
  }
}

/** A pure host function the macro may call (string/array methods, Math). */
class NativeFn {
  readonly name: string
  readonly fn: (args: unknown[]) => unknown
  constructor(name: string, fn: (args: unknown[]) => unknown) {
    this.name = name
    this.fn = fn
  }
}

/** A macro API entry: calling it YIELDS to the runtime. */
class ApiFn {
  readonly name: string
  constructor(name: string) {
    this.name = name
  }
}

type Value = unknown

/** A macro object: no prototype, so nothing is inherited from the host. */
function newObject(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>
}

function isMacroObject(v: Value): v is Record<string, Value> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === null
}

/** Host data -> macro data (a deep copy, so nothing the host holds leaks). */
export function toMacroValue(v: unknown): Value {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.map(toMacroValue)
  if (typeof v === 'object') {
    const out = newObject()
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (typeof value !== 'function') out[key] = toMacroValue(value)
    }
    return out
  }
  return undefined
}

/** Macro data -> plain host data, for API arguments. Functions drop out. */
export function fromMacroValue(v: Value): unknown {
  if (v instanceof Closure || v instanceof NativeFn || v instanceof ApiFn) return undefined
  if (Array.isArray(v)) return v.map(fromMacroValue)
  if (isMacroObject(v)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v)) out[key] = fromMacroValue(v[key])
    return out
  }
  return v
}

/** How a value reads in a console row. */
export function macroValueText(v: Value): string {
  if (typeof v === 'string') return v
  if (v instanceof Closure) return `function ${v.node.name ?? ''}`.trim()
  if (v instanceof NativeFn || v instanceof ApiFn) return `function ${v.name}`
  if (Array.isArray(v)) return v.map((item) => (item === null || item === undefined ? '' : macroValueText(item))).join(',')
  if (isMacroObject(v)) {
    try {
      return JSON.stringify(fromMacroValue(v))
    } catch {
      return '[object]'
    }
  }
  return String(v)
}

const STRING_METHODS = new Set([
  'charAt', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'padEnd', 'padStart', 'repeat', 'replace',
  'slice', 'split', 'startsWith', 'substring', 'toLowerCase', 'toUpperCase', 'trim', 'trimEnd', 'trimStart',
])
const ARRAY_METHODS = new Set([
  'concat', 'includes', 'indexOf', 'join', 'lastIndexOf', 'pop', 'push', 'reverse', 'shift', 'slice',
  'unshift',
])
const NUMBER_METHODS = new Set(['toFixed', 'toString'])

function pureMath(): Record<string, Value> {
  const math = newObject()
  for (const key of ['PI', 'E', 'SQRT2', 'LN2', 'LN10'] as const) math[key] = Math[key]
  for (const key of [
    'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'exp', 'floor', 'hypot', 'log', 'max', 'min',
    'pow', 'round', 'sign', 'sin', 'sqrt', 'tan', 'trunc',
  ] as const) {
    const f = Math[key] as (...args: number[]) => number
    math[key] = new NativeFn(`Math.${key}`, (args) => f(...(args as number[])))
  }
  return math
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

class Scope {
  private readonly vars = new Map<string, { value: Value; constant: boolean }>()
  readonly parent: Scope | null
  readonly functionScope: boolean
  constructor(parent: Scope | null, functionScope: boolean) {
    this.parent = parent
    this.functionScope = functionScope
  }

  declare(name: string, value: Value, constant: boolean, line: number): void {
    if (this.vars.has(name) && (constant || this.vars.get(name)!.constant)) {
      throw new MacroRuntimeError(`"${name}" is already declared`, line)
    }
    this.vars.set(name, { value, constant })
  }
  lookup(name: string): { value: Value; constant: boolean } | undefined {
    for (let s: Scope | null = this; s; s = s.parent) {
      const slot = s.vars.get(name)
      if (slot) return slot
    }
    return undefined
  }
  nearestFunctionScope(): Scope {
    let s: Scope = this
    while (!s.functionScope && s.parent) s = s.parent
    return s
  }
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** What the walk hands the runtime. */
export type MacroEffect =
  | { kind: 'api'; name: string; args: unknown[]; line: number }
  | { kind: 'slice' }

type Completion =
  | { type: 'normal' }
  | { type: 'break' }
  | { type: 'continue' }
  | { type: 'return'; value: Value }

const NORMAL: Completion = { type: 'normal' }

type Walk<T> = Generator<MacroEffect, T, unknown>

/** Run a parsed macro. Yields every API call and every time slice; the value
 *  sent back into `next()` after an API effect is that call's result. Throws
 *  `MacroRuntimeError` / `MacroBudgetError`. */
export function* runMacroProgram(program: MacroProgram, apiNames: readonly string[]): Walk<void> {
  const machine = new Machine()
  const globals = new Scope(null, true)
  globals.declare('Math', pureMath(), true, 0)
  for (const name of apiNames) globals.declare(name, new ApiFn(name), true, 0)
  const top = new Scope(globals, true)
  yield* machine.execBlockBody(program.body, top)
}

class Machine {
  private steps = 0
  private sinceApi = 0
  private depth = 0

  private *tick(line: number): Walk<void> {
    this.steps++
    this.sinceApi++
    if (this.sinceApi > STEP_BUDGET) throw new MacroBudgetError(line)
    if (this.steps % STEP_SLICE === 0) yield { kind: 'slice' }
  }

  *execBlockBody(body: Node[], scope: Scope): Walk<Completion> {
    // Function declarations are hoisted within their block.
    for (const stmt of body) {
      if (stmt.k === 'var' && stmt.kind === 'var' && stmt.decls.length === 1 && stmt.decls[0].init?.k === 'fn'
        && stmt.decls[0].init.name === stmt.decls[0].name && !stmt.decls[0].init.arrow) {
        scope.declare(stmt.decls[0].name, new Closure(stmt.decls[0].init, scope), false, stmt.line)
      }
    }
    for (const stmt of body) {
      const c = yield* this.exec(stmt, scope)
      if (c.type !== 'normal') return c
    }
    return NORMAL
  }

  private *exec(node: Node, scope: Scope): Walk<Completion> {
    yield* this.tick(node.line)
    switch (node.k) {
      case 'expr':
        yield* this.eval(node.expr, scope)
        return NORMAL
      case 'var': {
        for (const d of node.decls) {
          if (node.kind === 'var' && d.init?.k === 'fn' && d.init.name === d.name && !d.init.arrow
            && scope.lookup(d.name)?.value instanceof Closure) continue
          const value = d.init ? yield* this.eval(d.init, scope) : undefined
          if (node.kind === 'var') {
            const target = scope.nearestFunctionScope()
            const existing = target.lookup(d.name)
            if (existing && !existing.constant && d.init === null) continue
            target.declare(d.name, value, false, node.line)
          } else {
            scope.declare(d.name, value, node.kind === 'const', node.line)
          }
        }
        return NORMAL
      }
      case 'block':
        return yield* this.execBlockBody(node.body, new Scope(scope, false))
      case 'if': {
        const test = yield* this.eval(node.test, scope)
        if (test) return yield* this.exec(node.yes, new Scope(scope, false))
        if (node.no) return yield* this.exec(node.no, new Scope(scope, false))
        return NORMAL
      }
      case 'while':
        while (true) {
          yield* this.tick(node.line)
          if (!(yield* this.eval(node.test, scope))) return NORMAL
          const c = yield* this.exec(node.body, new Scope(scope, false))
          if (c.type === 'break') return NORMAL
          if (c.type === 'return') return c
        }
      case 'dowhile':
        while (true) {
          yield* this.tick(node.line)
          const c = yield* this.exec(node.body, new Scope(scope, false))
          if (c.type === 'break') return NORMAL
          if (c.type === 'return') return c
          if (!(yield* this.eval(node.test, scope))) return NORMAL
        }
      case 'for': {
        const loopScope = new Scope(scope, false)
        if (node.init) yield* this.exec(node.init, loopScope)
        while (true) {
          yield* this.tick(node.line)
          if (node.test && !(yield* this.eval(node.test, loopScope))) return NORMAL
          const c = yield* this.exec(node.body, new Scope(loopScope, false))
          if (c.type === 'break') return NORMAL
          if (c.type === 'return') return c
          if (node.update) yield* this.eval(node.update, loopScope)
        }
      }
      case 'forof': {
        const iter = yield* this.eval(node.iter, scope)
        let items: Value[]
        if (Array.isArray(iter)) items = iter.slice()
        else if (typeof iter === 'string') items = Array.from(iter)
        else throw new MacroRuntimeError(`for...of needs a list or a string, not ${typeName(iter)}`, node.line)
        for (const item of items) {
          yield* this.tick(node.line)
          const itemScope = new Scope(scope, false)
          if (node.kind === null) this.assignName(node.name, item, scope, node.line)
          else itemScope.declare(node.name, item, node.kind === 'const', node.line)
          const c = yield* this.exec(node.body, new Scope(itemScope, false))
          if (c.type === 'break') return NORMAL
          if (c.type === 'return') return c
        }
        return NORMAL
      }
      case 'break':
        return { type: 'break' }
      case 'continue':
        return { type: 'continue' }
      case 'return':
        return { type: 'return', value: node.arg ? yield* this.eval(node.arg, scope) : undefined }
      case 'empty':
        return NORMAL
      default:
        yield* this.eval(node, scope)
        return NORMAL
    }
  }

  private assignName(name: string, value: Value, scope: Scope, line: number): void {
    const slot = scope.lookup(name)
    if (!slot) throw new MacroRuntimeError(`"${name}" is not declared - use let or const`, line)
    if (slot.constant) throw new MacroRuntimeError(`"${name}" is a constant`, line)
    slot.value = value
  }

  private *eval(node: Node, scope: Scope): Walk<Value> {
    switch (node.k) {
      case 'num':
      case 'str':
      case 'lit':
        return node.v
      case 'tpl': {
        let out = node.strings[0]
        for (let i = 0; i < node.exprs.length; i++) {
          out += macroValueText(yield* this.eval(node.exprs[i], scope)) + node.strings[i + 1]
        }
        return out
      }
      case 'id': {
        const slot = scope.lookup(node.name)
        if (!slot) throw new MacroRuntimeError(`"${node.name}" is not defined`, node.line)
        return slot.value
      }
      case 'arr': {
        const out: Value[] = []
        for (const item of node.items) out.push(yield* this.eval(item, scope))
        return out
      }
      case 'obj': {
        const out = newObject()
        for (const prop of node.props) {
          const key = typeof prop.key === 'string' ? prop.key : propertyKey(yield* this.eval(prop.key, scope))
          out[key] = yield* this.eval(prop.value, scope)
        }
        return out
      }
      case 'fn':
        return new Closure(node, scope)
      case 'unary': {
        if (node.op === 'typeof') {
          if (node.arg.k === 'id' && !scope.lookup(node.arg.name)) return 'undefined'
          const v = yield* this.eval(node.arg, scope)
          if (v instanceof Closure || v instanceof NativeFn || v instanceof ApiFn) return 'function'
          return typeof v
        }
        const v = yield* this.eval(node.arg, scope)
        if (node.op === '!') return !v
        return node.op === '-' ? -toNumber(v, node.line) : +toNumber(v, node.line)
      }
      case 'update': {
        const old = toNumber(yield* this.eval(node.arg, scope), node.line)
        const next = node.op === '++' ? old + 1 : old - 1
        yield* this.store(node.arg, next, scope)
        return node.prefix ? next : old
      }
      case 'bin':
        return binary(node.op, yield* this.eval(node.left, scope), yield* this.eval(node.right, scope), node.line)
      case 'logic': {
        const left = yield* this.eval(node.left, scope)
        if (node.op === '&&') return left ? yield* this.eval(node.right, scope) : left
        if (node.op === '||') return left ? left : yield* this.eval(node.right, scope)
        return left === null || left === undefined ? yield* this.eval(node.right, scope) : left
      }
      case 'cond':
        return (yield* this.eval(node.test, scope)) ? yield* this.eval(node.yes, scope) : yield* this.eval(node.no, scope)
      case 'assign': {
        if (node.op === '=') {
          const value = yield* this.eval(node.value, scope)
          yield* this.store(node.target, value, scope)
          return value
        }
        const old = yield* this.eval(node.target, scope)
        if (node.op === '??=') {
          if (old !== null && old !== undefined) return old
          const value = yield* this.eval(node.value, scope)
          yield* this.store(node.target, value, scope)
          return value
        }
        const value = binary(node.op.slice(0, -1), old, yield* this.eval(node.value, scope), node.line)
        yield* this.store(node.target, value, scope)
        return value
      }
      case 'member': {
        const obj = yield* this.eval(node.obj, scope)
        if (node.optional && (obj === null || obj === undefined)) return undefined
        const key = typeof node.prop === 'string' ? node.prop : propertyKey(yield* this.eval(node.prop, scope))
        return getProperty(obj, key, node.line)
      }
      case 'call':
        return yield* this.call(node, scope)
      case 'seq': {
        let last: Value
        for (const item of node.items) last = yield* this.eval(item, scope)
        return last
      }
      default:
        throw new MacroRuntimeError('that statement cannot be used as a value', node.line)
    }
  }

  private *store(target: Node, value: Value, scope: Scope): Walk<void> {
    if (target.k === 'id') {
      this.assignName(target.name, value, scope, target.line)
      return
    }
    if (target.k !== 'member') throw new MacroRuntimeError('only a name or a property can be assigned to', target.line)
    const obj = yield* this.eval(target.obj, scope)
    const key = typeof target.prop === 'string' ? target.prop : propertyKey(yield* this.eval(target.prop, scope))
    setProperty(obj, key, value, target.line)
  }

  private *call(node: Node & { k: 'call' }, scope: Scope): Walk<Value> {
    const callee = yield* this.eval(node.callee, scope)
    if (node.optional && (callee === null || callee === undefined)) return undefined
    const args: Value[] = []
    for (const arg of node.args) args.push(yield* this.eval(arg, scope))
    yield* this.tick(node.line)
    if (callee instanceof ApiFn) {
      this.sinceApi = 0
      const result = yield { kind: 'api', name: callee.name, args: args.map(fromMacroValue), line: node.line }
      return toMacroValue(result)
    }
    if (callee instanceof NativeFn) {
      try {
        return callee.fn(args)
      } catch (err) {
        throw new MacroRuntimeError(`${callee.name}: ${err instanceof Error ? err.message : String(err)}`, node.line)
      }
    }
    if (callee instanceof Closure) return yield* this.invoke(callee, args, node.line)
    const name = node.callee.k === 'id' ? `"${node.callee.name}"` : node.callee.k === 'member' && typeof node.callee.prop === 'string'
      ? `"${node.callee.prop}"` : 'that'
    throw new MacroRuntimeError(`${name} is not a function`, node.line)
  }

  private *invoke(fn: Closure, args: Value[], line: number): Walk<Value> {
    if (this.depth >= MAX_CALL_DEPTH) throw new MacroRuntimeError(`functions call each other more than ${MAX_CALL_DEPTH} deep`, line)
    this.depth++
    try {
      const fnScope = new Scope(fn.env, true)
      if (fn.node.name && !fn.node.arrow) fnScope.declare(fn.node.name, fn, false, line)
      for (let i = 0; i < fn.node.params.length; i++) {
        const param = fn.node.params[i]
        let value = args[i]
        if (value === undefined && param.init) value = yield* this.eval(param.init, fnScope)
        fnScope.declare(param.name, value, false, line)
      }
      if (fn.node.exprBody) return yield* this.eval(fn.node.body, fnScope)
      const body = fn.node.body as Node & { k: 'block' }
      const c = yield* this.execBlockBody(body.body, fnScope)
      return c.type === 'return' ? c.value : undefined
    } finally {
      this.depth--
    }
  }
}

function typeName(v: Value): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'a list'
  if (v instanceof Closure || v instanceof NativeFn || v instanceof ApiFn) return 'a function'
  return typeof v === 'object' ? 'an object' : String(typeof v === 'string' ? 'a string' : v)
}

function toNumber(v: Value, line: number): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean' || v === null || v === undefined || typeof v === 'string') return Number(v)
  throw new MacroRuntimeError(`${typeName(v)} is not a number`, line)
}

function primitive(v: Value, line: number): number | string | boolean | null | undefined {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v
  if (Array.isArray(v) || isMacroObject(v)) return macroValueText(v)
  throw new MacroRuntimeError(`${typeName(v)} cannot be used in arithmetic`, line)
}

function binary(op: string, a: Value, b: Value, line: number): Value {
  switch (op) {
    case '===': return a === b
    case '!==': return a !== b
    // Loose equality on two macro objects is identity, as in JavaScript.
    case '==': return (typeof a === 'object' || typeof b === 'object') && a !== null && b !== null ? a === b : a == b // eslint-disable-line eqeqeq
    case '!=': return !binary('==', a, b, line)
  }
  const x = primitive(a, line)
  const y = primitive(b, line)
  switch (op) {
    case '+':
      return typeof x === 'string' || typeof y === 'string' ? `${x}${y}` : (x as number) + (y as number)
    case '-': return (x as number) - (y as number)
    case '*': return (x as number) * (y as number)
    case '/': return (x as number) / (y as number)
    case '%': return (x as number) % (y as number)
    case '**': return (x as number) ** (y as number)
    case '<': return (x as number) < (y as number)
    case '>': return (x as number) > (y as number)
    case '<=': return (x as number) <= (y as number)
    case '>=': return (x as number) >= (y as number)
  }
  throw new MacroRuntimeError(`unknown operator "${op}"`, line)
}

function propertyKey(v: Value): string {
  return typeof v === 'number' || typeof v === 'string' ? String(v) : macroValueText(v)
}

const INDEX = /^(0|[1-9][0-9]*)$/

function getProperty(obj: Value, key: string, line: number): Value {
  if (obj === null || obj === undefined) {
    throw new MacroRuntimeError(`cannot read "${key}" of ${obj === null ? 'null' : 'undefined'}`, line)
  }
  if (typeof obj === 'string') {
    if (key === 'length') return obj.length
    if (INDEX.test(key)) return obj[Number(key)]
    if (STRING_METHODS.has(key)) {
      const method = (String.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[key]
      return new NativeFn(key, (args) => method.apply(obj, args.map((a) => (typeof a === 'object' && a !== null ? macroValueText(a) : a))))
    }
    return undefined
  }
  if (typeof obj === 'number') {
    if (NUMBER_METHODS.has(key)) {
      const method = (Number.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[key]
      return new NativeFn(key, (args) => method.apply(obj, args))
    }
    return undefined
  }
  if (Array.isArray(obj)) {
    if (key === 'length') return obj.length
    if (INDEX.test(key)) return obj[Number(key)]
    if (ARRAY_METHODS.has(key)) {
      const method = (Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[key]
      return new NativeFn(key, (args) => method.apply(obj, args))
    }
    return undefined
  }
  if (isMacroObject(obj)) return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined
  return undefined
}

function setProperty(obj: Value, key: string, value: Value, line: number): void {
  if (Array.isArray(obj)) {
    if (INDEX.test(key)) {
      const index = Number(key)
      if (index > obj.length + 100_000) throw new MacroRuntimeError(`index ${index} is too far past the end of the list`, line)
      obj[index] = value
      return
    }
    if (key === 'length' && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= obj.length) {
      obj.length = value
      return
    }
    throw new MacroRuntimeError(`a list has no settable "${key}"`, line)
  }
  if (isMacroObject(obj)) {
    obj[key] = value
    return
  }
  throw new MacroRuntimeError(`cannot set "${key}" on ${typeName(obj)}`, line)
}
