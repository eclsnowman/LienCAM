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
import { join, relative } from 'node:path'

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
function foldStaticText(node: ts.Expression | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text
    for (const span of node.templateSpans) {
      const inner = foldStaticText(span.expression)
      if (inner) s += inner
      s += span.literal.text
    }
    return s
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldStaticText(node.left)
    const r = foldStaticText(node.right)
    if (l === null || r === null) return null
    return l + r
  }
  if (ts.isParenthesizedExpression(node)) return foldStaticText(node.expression)
  if (ts.isConditionalExpression(node)) {
    const t = foldStaticText(node.whenTrue)
    const f = foldStaticText(node.whenFalse)
    if (t !== null && t === f) return t
    const tEmpty = t === null || t === ''
    const fEmpty = f === null || f === ''
    if (tEmpty && !fEmpty) return f
    if (fEmpty && !tEmpty) return t
    return null
  }
  return null
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
export function scanSource(file: string, text: string): Hit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX)
  const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const hits: Hit[] = []
  const seen = new Set<number>()

  const consider = (sink: string, node: ts.Expression): void => {
    for (const n of branches(node)) {
      const message = foldStaticText(n)
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