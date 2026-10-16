// WO-1917 - THE CONSOLE-LINE CENSUS.
//
// COHESION-STANDARD.md s13.2 (Operator, 2026-09-23, relayed by the Spark audit
// session): "A console line is short: what did not happen, and what to do."
// 13.2.a is one sentence of what did not happen + one sentence of action;
// 13.2.b is ONE sentence when there is no action. A message that runs to THREE
// or more sentences is the "novel" the ruling rejects.
//
// This test DERIVES the count from the source by TypeScript AST - never a hand
// list - at every console/refusal sink s13.2 governs:
//   pushConsole, addConsoleEvent, refuse*(), notices.push, operatorNotice,
//   an `errorMessage:` property, and a `reason:` / `message:` property.
// The Spark audit measured 23 at fcde8fae8 with a looser sentence counter
// (docs/audits/OPERATOR-MESSAGES-2026-09-23.txt). This census pins the number
// under one stated, reproducible rule the audit could not: a sentence boundary
// is [.!?] followed by whitespace or end-of-string, counted over the message's
// constant-folded static text. That rule reads 12 on this branch. The number is
// the pin, not the audit's - a new three-sentence literal turns this red; a
// rewrite that drops a message lets the pin fall (lower it in the same change).
//
// Help topics (src/help) are excluded: s13.2 governs the console, and Help is
// where the mechanism sentence is allowed to live. Tests are excluded: they are
// not operator-facing.
//
// Proof of bite (COHESION-STANDARD s10): the negative control below feeds the
// real scanner a scratch copy carrying a three-sentence pushConsole literal and
// requires the count to rise AND the offender to be named; the positive control
// requires a two-sentence literal to be NOT counted, so the three-sentence bar
// is real rather than vacuous.
import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const SRC = join(process.cwd(), 'src')

/** One operator-facing message literal that runs to three or more sentences. */
interface Hit {
  file: string
  line: number
  sink: string
  sentences: number
  text: string
}

/** Which sink a literal was reached through, for the printed list. */
const REFUSE = /^refuse/

function propName(name: ts.PropertyName | undefined): string | null {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

function calleeName(call: ts.CallExpression): string | null {
  const c = call.expression
  if (ts.isIdentifier(c)) return c.text
  if (ts.isPropertyAccessExpression(c)) return c.name.text
  return null
}

/** `notices.push(...)` - the object identifier, so a different `.push` is not captured. */
function calleeObject(call: ts.CallExpression): string | null {
  const c = call.expression
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) return c.expression.text
  return null
}

/**
 * The text an operator ALWAYS sees from a string-valued expression: string
 * literals, template literals, and `+` concatenations of them, constant-folded.
 * Interpolated expressions are dropped - only the literal text the code writes
 * is counted, never a runtime-only value. A conditional yields each branch as
 * its own candidate (expanded in `consider`), so two distinct messages are
 * never joined into a false long one.
 */
function foldStaticText(node: ts.Expression | undefined, catalogCall?: (call: ts.CallExpression) => string | null): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text
    for (const span of node.templateSpans) {
      const inner = foldStaticText(span.expression, catalogCall)
      if (inner) s += inner
      s += span.literal.text
    }
    return s
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldStaticText(node.left, catalogCall)
    const r = foldStaticText(node.right, catalogCall)
    if (l === null || r === null) return null
    return l + r
  }
  if (ts.isParenthesizedExpression(node)) return foldStaticText(node.expression, catalogCall)
  if (ts.isConditionalExpression(node)) {
    const t = foldStaticText(node.whenTrue, catalogCall)
    const f = foldStaticText(node.whenFalse, catalogCall)
    if (t !== null && t === f) return t
    const tEmpty = t === null || t === ''
    const fEmpty = f === null || f === ''
    if (tEmpty && !fEmpty) return f
    if (fEmpty && !tEmpty) return t
    return null
  }
  if (ts.isCallExpression(node) && catalogCall) return catalogCall(node)
  return null
}

type CatalogReader = (area: string) => string | null

/** Read source data, never import the app/i18next or evaluate a catalog module. */
const readEnglishCatalog: CatalogReader = (area) => {
  if (!/^[a-z0-9-]+$/.test(area)) return null
  try { return readFileSync(join(SRC, 'i18n/locales/en', `${area}.ts`), 'utf8') } catch { return null }
}

function unwrapped(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression
  return node
}

/** Catalogs.ts registers each English filename's default-exported string tree. */
function catalogStrings(source: string): Map<string, string> {
  const sf = ts.createSourceFile('catalog.ts', source, ts.ScriptTarget.Latest, true)
  const declarations = new Map<string, ts.Expression>()
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) declarations.set(declaration.name.text, declaration.initializer)
    }
  }
  const words = new Map<string, string>()
  let staticTree = true
  const walk = (node: ts.Expression, prefix: string): void => {
    node = unwrapped(node)
    if (ts.isStringLiteralLike(node)) { words.set(prefix, node.text); return }
    if (!ts.isObjectLiteralExpression(node)) { staticTree = false; return }
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) { staticTree = false; continue }
      const key = propName(property.name)
      if (key !== null) walk(property.initializer, prefix ? `${prefix}.${key}` : key)
      else staticTree = false
    }
  }
  for (const statement of sf.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue
    const expression = unwrapped(statement.expression)
    const value = ts.isIdentifier(expression) ? declarations.get(expression.text) : expression
    if (value) walk(value, '')
  }
  return staticTree ? words : new Map()
}

/** Bind identifiers in this file only. No dependency source or default library is loaded.
 * Symbols distinguish the genuine imported factory/const lookup from shadowed names.
 * Only the existing static textFor(namespace)(key, parameters) form is supported. */
function catalogResolver(sf: ts.SourceFile, readCatalog: CatalogReader): (call: ts.CallExpression) => string | null {
  if (!sf.text.includes('textFor')) return () => null
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, target: ts.ScriptTarget.Latest }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (file) => file === sf.fileName ? sf : undefined
  host.fileExists = (file) => file === sf.fileName
  host.readFile = (file) => file === sf.fileName ? sf.text : undefined
  const checker = ts.createProgram([sf.fileName], options, host).getTypeChecker()
  const catalogs = new Map<string, Map<string, string>>()
  return (call) => {
    if (!ts.isIdentifier(call.expression) || call.arguments.length < 1 || call.arguments.length > 2) return null
    const declaration = checker.getSymbolAtLocation(call.expression)?.valueDeclaration
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer ||
        !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return null
    const factory = declaration.initializer
    if (!ts.isCallExpression(factory) || !ts.isIdentifier(factory.expression) || factory.arguments.length !== 1) return null
    const imported = checker.getSymbolAtLocation(factory.expression)?.declarations?.[0]
    if (!imported || !ts.isImportSpecifier(imported) || imported.isTypeOnly ||
        (imported.propertyName ?? imported.name).text !== 'textFor') return null
    const importDeclaration = imported.parent.parent.parent
    if (!ts.isImportDeclaration(importDeclaration) || !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
        importDeclaration.importClause?.isTypeOnly) return null
    const specifier = importDeclaration.moduleSpecifier.text
    if (!specifier.startsWith('.')) return null
    const importedPath = resolve(dirname(join(SRC, sf.fileName)), specifier)
    if (![join(SRC, 'i18n'), join(SRC, 'i18n/index'), join(SRC, 'i18n/index.ts')].includes(importedPath)) return null
    const area = factory.arguments[0]
    const key = call.arguments[0]
    if (!ts.isStringLiteralLike(area) || !ts.isStringLiteralLike(key)) return null
    if (!catalogs.has(area.text)) catalogs.set(area.text, catalogStrings(readCatalog(area.text) ?? ''))
    const value = catalogs.get(area.text)!.get(key.text)
    if (value === undefined) return null
    const values = new Map<string, string>()
    const parameters = call.arguments[1]
    if (parameters) {
      if (!ts.isObjectLiteralExpression(parameters)) return null
      for (const property of parameters.properties) {
        if (!ts.isPropertyAssignment(property)) return null
        const name = propName(property.name)
        // Namespace/default/key/interpolation overrides are not ordinary parameters.
        if (name === null || ['ns', 'defaultValue', 'keySeparator', 'nsSeparator', 'interpolation', 'count', 'context', 'lng'].includes(name)) return null
        values.set(name, foldStaticText(property.initializer) ?? '')
      }
    }
    // Match the existing template rule: keep static text, omit runtime-only values.
    const staticValue = value.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, name: string) => values.get(name) ?? '')
    return staticValue.includes('{{') ? null : staticValue
  }
}

/** A sentence boundary is [.!?] followed by whitespace or end-of-string. */
function sentenceCount(text: string): number {
  let n = 0
  const re = /[.!?]+(?=\s|$)/g
  while (re.exec(text) !== null) n++
  return n
}

/** Split a conditional into its branches; anything else is itself. */
function branches(node: ts.Expression): ts.Expression[] {
  if (ts.isConditionalExpression(node)) return [...branches(node.whenTrue), ...branches(node.whenFalse)]
  if (ts.isParenthesizedExpression(node)) return branches(node.expression)
  return [node]
}

/** Scan ONE source file's text and return every three-sentence message literal at a sink. */
export function scanSource(file: string, text: string, readCatalog: CatalogReader = readEnglishCatalog): Hit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX)
  const resolveCatalogCall = catalogResolver(sf, readCatalog)
  const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const hits: Hit[] = []
  const seen = new Set<number>()

  const consider = (sink: string, node: ts.Expression): void => {
    for (const n of branches(node)) {
      const message = foldStaticText(n, resolveCatalogCall)
      if (message === null) continue
      const sentences = sentenceCount(message)
      if (sentences < 3) continue
      const pos = n.getStart(sf)
      if (seen.has(pos)) continue
      seen.add(pos)
      hits.push({ file, line: at(n), sink, sentences, text: message })
    }
  }

  ;(function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      if (name === 'pushConsole' || (name !== null && REFUSE.test(name)) || name === 'operatorNotice') {
        for (const a of node.arguments) consider(name, a)
      } else if (name === 'addConsoleEvent') {
        for (const a of node.arguments) {
          if (ts.isObjectLiteralExpression(a)) {
            for (const p of a.properties) {
              if (ts.isPropertyAssignment(p) && propName(p.name) === 'message') consider('addConsoleEvent', p.initializer)
            }
          }
        }
      } else if (name === 'push' && calleeObject(node) === 'notices') {
        for (const a of node.arguments) consider('notices.push', a)
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const pn = propName(node.name)
      if (pn === 'errorMessage' || pn === 'reason' || pn === 'message') consider(pn + ':', node.initializer)
    }
    node.forEachChild(visit)
  })(sf)
  return hits
}

/** Every production source file the census reads: src/, no tests, no Help topics. */
function productionFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'tests' || name === '__tests__' || name === 'node_modules' || name === 'help') continue
      out.push(...productionFiles(p))
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

/** The real census over src/. */
export function census(): Hit[] {
  return productionFiles(SRC)
    .flatMap((file) => scanSource(relative(SRC, file).replace(/\\/g, '/'), readFileSync(file, 'utf8')))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

function byFile(hits: Hit[]): Record<string, number> {
  const table: Record<string, number> = {}
  for (const h of hits) table[h.file] = (table[h.file] ?? 0) + 1
  return table
}

function listFor(hits: Hit[]): string {
  return hits.map((h) => `  ${h.file}:${h.line}  [${h.sink}]  ${h.sentences}s  ${JSON.stringify(h.text.slice(0, 80))}`).join('\n')
}

// THE PIN. Measured 2026-09-23 on this branch. Raising one of these is the
// defect this file exists to catch; the fix is to shorten or delete the
// message, never to raise the pin (COHESION-STANDARD s13.2).
const PINNED: Record<string, number> = {
  'components/machine/JogPanel.tsx': 1,
  'lib/machine/probeRoutines.ts': 3,
  'mesh/edit/operations/boundaryCap.ts': 1,
  // WO-2324 maintenance: recovered baseline visibility, not new messages.
  // index502/503 and their real errorMessage sinks are Git-identical on frozen
  // M3940, accepted main802, current main6bd and this candidate. Keep the old
  // three pins intact; provenance and the preserved first red are in evidence.
  'store/index.ts': 2,
}

describe('WO-1917 console-line census - no operator message runs to three sentences', () => {
  it('counts every three-sentence operator message in src/ and pins it per file', () => {
    const hits = census()
    const actual = byFile(hits)
    expect(
      actual,
      `\nCONSOLE MESSAGES OF 3+ SENTENCES (total ${hits.length}):\n${listFor(hits)}\n`,
    ).toEqual(PINNED)
  })

  it('NEGATIVE CONTROL: a new three-sentence pushConsole literal turns the pin red and names it', () => {
    const scratch = [
      `export function boom(): void {`,
      `  useMachineControl.getState().pushConsole('tx',`,
      `    'The bridge did not answer. The port is closed. Try reconnecting.',`,
      `    'error')`,
      `}`,
    ].join('\n')
    const hits = scanSource('scratch/negative.ts', scratch)
    expect(hits.length, 'the three-sentence literal must be counted').toBe(1)
    expect(hits[0].sink).toBe('pushConsole')
    expect(hits[0].text).toContain('The port is closed.')
    // Driving the census the pin actually checks: the same literal present as a
    // source file must make the pinned table differ AND appear in the listing
    // that a red prints. This is the "adding one turns it red" mechanism.
    const withScratch = [...census(), ...hits]
    const raised = byFile(withScratch)
    expect(raised, 'the added literal must break the pin').not.toEqual(PINNED)
    expect(raised['scratch/negative.ts']).toBe(1)
    expect(listFor(withScratch), 'the red listing must name the offender').toContain('scratch/negative.ts')
  })

  it('POSITIVE CONTROL: a two-sentence literal is NOT counted, so the bar is three', () => {
    const scratch = [
      `export function fine(): void {`,
      `  useMachineControl.getState().pushConsole('tx',`,
      `    'The bridge did not answer. Try reconnecting.',`,
      `    'error')`,
      `}`,
    ].join('\n')
    expect(scanSource('scratch/positive.ts', scratch)).toEqual([])
  })
})

describe('WO-2324 static English catalog census maintenance', () => {
  const file = 'components/machine/census-control.ts'
  const three = 'The bridge did not answer. The port is closed. Try reconnecting.'
  const two = 'The bridge did not answer. Try reconnecting.'
  const source = (expression: string, binding = "import { textFor as factory } from '../../i18n'; const words = factory('census-control');") =>
    `${binding}\nfunction report() { pushConsole('tx', ${expression}, 'error') }`
  const reader = (words: Record<string, string>): CatalogReader => (area) => area === 'census-control'
    ? `const words = ${JSON.stringify({ messages: words })} as const; export default words;`
    : null

  it('resolves the real imported factory alias and attributes catalog text exactly like a literal', () => {
    const literal = scanSource(file, source(JSON.stringify(three)))
    const translated = scanSource(file, source("words('messages.long')"), reader({ long: three }))
    expect(translated).toEqual(literal)
    expect(translated).toEqual([{ file, line: 2, sink: 'pushConsole', sentences: 3, text: three }])
  })

  it('POSITIVE/NEGATIVE/RESTORED: adding the third catalog sentence raises the actual scan and restoring removes it', () => {
    const scratch = source("words('messages.message')")
    const before = scanSource(file, scratch, reader({ message: two }))
    const negative = scanSource(file, scratch, reader({ message: three }))
    const restored = scanSource(file, scratch, reader({ message: two }))
    expect(before).toEqual([])
    expect(negative).toEqual([{ file, line: 2, sink: 'pushConsole', sentences: 3, text: three }])
    expect(byFile(negative)).toEqual({ [file]: 1 })
    expect(listFor(negative)).toContain(`${file}:2`)
    expect(restored).toEqual(before)
  })

  it('folds concatenated catalog fragments into one message at the existing sink', () => {
    const hits = scanSource(file, source("words('messages.first') + words('messages.second')"), reader({
      first: 'The bridge did not answer. ', second: 'The port is closed. Try reconnecting.',
    }))
    expect(hits).toEqual([{ file, line: 2, sink: 'pushConsole', sentences: 3, text: three }])
  })

  it('preserves the literal-template rule for static and runtime-only interpolation', () => {
    const literal = scanSource(file, source('`First sentence. ${runtimeValue}Second sentence. ${"Final sentence."}`'))
    const translated = scanSource(file, source("words('messages.templated', { runtime: runtimeValue, fixed: 'Final sentence.' })"), reader({
      templated: 'First sentence. {{runtime}}Second sentence. {{fixed}}',
    }))
    expect(translated).toEqual(literal)
    expect(translated[0].sentences).toBe(3)
  })

  it('does not pretend missing/dynamic namespaces or keys resolve', () => {
    for (const expression of ["words('messages.missing')", 'words(dynamicKey)', "words('messages.' + key)"]) {
      expect(scanSource(file, source(expression), reader({ long: three }))).toEqual([])
    }
    for (const area of ['dynamicArea', "'missing-area'"]) {
      const binding = `import { textFor as factory } from '../../i18n'; const words = factory(${area});`
      expect(scanSource(file, source("words('messages.long')", binding), reader({ long: three }))).toEqual([])
    }
  })

  it('rejects similarly named functions, spoofed imports, type-only imports and shadowed bindings', () => {
    const bindings = [
      "function textFor(area) { return () => '' }; const words = textFor('census-control');",
      "import { textFor as factory } from '../../fake-i18n'; const words = factory('census-control');",
      "import type { textFor as factory } from '../../i18n'; const words = factory('census-control');",
      "import { textFor as factory } from '../../i18n'; function build(factory) { const words = factory('census-control'); pushConsole(words('messages.long')); }",
    ]
    for (const binding of bindings) expect(scanSource(file, source("words('messages.long')", binding), reader({ long: three }))).toEqual([])
    const shadowed = "import { textFor } from '../../i18n'; const words = textFor('census-control'); function report(words) { pushConsole(words('messages.long')) }"
    expect(scanSource(file, shadowed, reader({ long: three }))).toEqual([])
  })

  it('does not invent text for overridden lookup options or a dynamic/spread catalog tree', () => {
    expect(scanSource(file, source("words('messages.long', { ns: 'other' })"), reader({ long: three }))).toEqual([])
    expect(scanSource(file, source("words('messages.long')"), () => `export default { messages: { long: ${JSON.stringify(three)} }, ...unknown };`)).toEqual([])
    expect(scanSource(file, source("words('messages.long')"), () => 'export default { messages: { long: runtimeValue } };')).toEqual([])
  })
})
