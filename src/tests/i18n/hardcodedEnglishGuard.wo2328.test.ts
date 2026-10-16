// WO-2328: no NEW hard-coded user-facing English outside the catalog.
//
// Reads the real source tree, so it keeps working as screens are added:
//   - every .tsx under src/ (src/tests excluded) and every .ts under
//     src/components: JSX text, string children ({'Saving...'}, a ? 'Yes' : 'No'),
//     the text attributes in TEXT_ATTRIBUTES and the same-named object
//     properties (option labels, summaries, tooltips);
//   - every .ts under src/lib and src/store: the console message sites only -
//     pushConsole's text argument and the message of addConsoleEvent /
//     pushConsoleEvent. The rest of src/lib is G-code, posted text, error
//     plumbing and identifiers, where a word scan would only raise false alarms.
//
// A finding is English when one of its words is not a literal token
// (support/guardAllowList.ts LITERAL_TOKENS: units, G-code words, dialect
// names, file formats, key names). Text present before this guard is listed
// per file in RESIDUAL_TEXT; anything new fails with file, line and text.
// docs/testing/I18N-HARDCODED-ENGLISH-GUARD.md says what to do on a failure.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { LITERAL_TOKENS, RESIDUAL_TEXT } from './support/guardAllowList'

const ROOT = process.cwd()
const TEXT_ATTRIBUTES = new Set([
  'title', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext', 'aria-roledescription',
  'placeholder', 'alt', 'label', 'tooltip', 'ariaLabel', 'hint', 'description', 'caption', 'heading',
  'summary', 'message', 'emptyText', 'emptyMessage', 'confirmLabel', 'cancelLabel', 'subtitle', 'helpText', 'detail',
])
const CONSOLE_TEXT_ARG = /(^|\.)pushConsole$/
const CONSOLE_EVENT_CALL = /(^|\.)(addConsoleEvent|pushConsoleEvent)$/

type Finding = { file: string; line: number; site: string; text: string }

/** Literal and template pieces an expression can render as text. A template's
 *  substitutions read as {}, so `${n} mm` is "{} mm"; text inside a
 *  substitution (`${busy ? 'Saving' : 'Ready'}`) is reported on its own. */
function literalTexts(e: ts.Expression | undefined): string[] {
  if (!e) return []
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text]
  if (ts.isTemplateExpression(e)) {
    return [e.head.text + e.templateSpans.map(s => '{}' + s.literal.text).join(''), ...e.templateSpans.flatMap(s => literalTexts(s.expression))]
  }
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return literalTexts(e.expression)
  if (ts.isConditionalExpression(e)) return [...literalTexts(e.whenTrue), ...literalTexts(e.whenFalse)]
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return literalTexts(e.right)
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return [...literalTexts(e.left), ...literalTexts(e.right)]
    }
    if (op === ts.SyntaxKind.PlusToken) {
      // 'a' + n + 'b' reads as one sentence "a{}b"; text inside a non-literal
      // part (a ? 'x' : 'y') is still reported on its own.
      const parts: ts.Expression[] = []
      const flatten = (x: ts.Expression) => {
        if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) { flatten(x.left); flatten(x.right) } else parts.push(x)
      }
      flatten(e)
      const plain = (x: ts.Expression) => ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isTemplateExpression(x)
      const joined = parts.map(x => (plain(x) ? literalTexts(x)[0] : '{}')).join('')
      return [...(parts.some(plain) ? [joined] : []), ...parts.filter(x => !plain(x)).flatMap(literalTexts)]
    }
  }
  return []
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

/** True when the text holds a word a reader must translate. Words are runs of
 *  letters and digits; single letters (axes, shortcut letters) and literal
 *  tokens stay. A lone identifier (fooBar, foo-bar, foo_bar) in a prop or a
 *  message is code, not text; `rendered` JSX text (read-only) is read as words. */
function isEnglish(text: string, rendered = false): boolean {
  const t = normalize(text)
  if (!rendered && /^[a-z]+([A-Z][a-z0-9]*)+$|^[a-z0-9]+([-_][a-z0-9]+)+$/.test(t)) return false
  // A leading dot keeps a file extension (.nc) one word.
  const words = t.replace(/&#?[A-Za-z0-9]+;/g, ' ').match(/(?<![A-Za-z0-9])\.?[A-Za-z][A-Za-z0-9]*/g) ?? []
  return words.some(w => /[A-Za-z].*[A-Za-z]/.test(w) && !LITERAL_TOKENS.some(token => token.pattern.test(w)))
}

const propName = (name: ts.PropertyName, ast: ts.SourceFile) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(ast)

/** Every hard-coded English text in one source file. `screen` turns on the
 *  JSX and text-property scan; message sites are scanned in every file. */
function scanSource(file: string, source: string, screen: boolean): Finding[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Finding[] = []
  const add = (node: ts.Node, site: string, texts: string[]) => {
    for (const raw of texts) {
      if (!isEnglish(raw, site === 'JSX text')) continue
      // One lowercase word in tooltip is a mode value (tooltip="native"); in
      // any other prop or message it is a word (placeholder="search").
      if (/^tooltip[=:]$/.test(site) && /^[a-z][a-z0-9]*$/.test(raw)) continue
      out.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, site, text: normalize(raw) })
    }
  }
  const visit = (node: ts.Node) => {
    if (screen && ts.isJsxText(node)) add(node, 'JSX text', [node.text])
    else if (screen && ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      add(node, 'JSX text', literalTexts(node.expression))
    } else if (screen && ts.isJsxAttribute(node) && node.initializer && TEXT_ATTRIBUTES.has(node.name.getText(ast))) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
      add(node, `${node.name.getText(ast)}=`, literalTexts(value))
    } else if (screen && ts.isPropertyAssignment(node) && TEXT_ATTRIBUTES.has(propName(node.name, ast))) {
      add(node, `${propName(node.name, ast)}:`, literalTexts(node.initializer))
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast)
      if (CONSOLE_TEXT_ARG.test(callee)) add(node, 'console line', literalTexts(node.arguments[1]))
      if (CONSOLE_EVENT_CALL.test(callee)) {
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue
          for (const p of arg.properties) {
            // In a screen file the property visit below reports message: itself.
            if (!screen && ts.isPropertyAssignment(p) && propName(p.name, ast) === 'message') add(p, 'console message', literalTexts(p.initializer))
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return out
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$|\.test\.tsx?$/.test(name)) out.push(relative(ROOT, path).split(sep).join('/'))
  }
  return out
}

/** The guarded source tree and which scan each file gets. */
function guardedFiles(): { file: string; screen: boolean }[] {
  return sourceFiles(join(ROOT, 'src'))
    .filter(file => !file.startsWith('src/tests/'))
    .map(file => ({ file, screen: file.endsWith('.tsx') || file.startsWith('src/components/') }))
    .filter(({ file, screen }) => screen || file.startsWith('src/lib/') || file.startsWith('src/store/'))
}

/** Findings the allow-list does not cover. Residual texts are counted, so a
 *  second copy of an allowed sentence in the same file is still new. */
function unlisted(findings: Finding[], residual = RESIDUAL_TEXT): Finding[] {
  const left = new Map<string, number>()
  for (const entry of residual) for (const text of entry.texts) {
    const key = `${entry.file}\n${text}`
    left.set(key, (left.get(key) ?? 0) + 1)
  }
  return findings.filter(f => {
    const key = `${f.file}\n${f.text}`
    const n = left.get(key) ?? 0
    if (n > 0) { left.set(key, n - 1); return false }
    return true
  })
}

function report(found: Finding[]): string {
  return [
    `${found.length} hard-coded English text(s) outside the catalog.`,
    'Add each to its area catalog under src/i18n/locales/en/ and read it with useText()/textFor().',
    'If it must stay literal (G-code, unit, key name...), see docs/testing/I18N-HARDCODED-ENGLISH-GUARD.md.',
    ...found.map(f => `  ${f.file}:${f.line} ${f.site} "${f.text}"`),
  ].join('\n')
}

describe('WO-2328: hard-coded English guard', () => {
  it('finds no hard-coded user-facing English outside the catalog and the allow-list', () => {
    const files = guardedFiles()
    // The tree walk itself is the point: it must see screens, lib and store.
    expect(files.some(f => f.file === 'src/App.tsx')).toBe(true)
    expect(files.filter(f => f.file.startsWith('src/components/')).length).toBeGreaterThan(300)
    expect(files.some(f => f.file === 'src/lib/machine/machineSession.ts' && !f.screen)).toBe(true)
    const findings = files.flatMap(({ file, screen }) => scanSource(file, readFileSync(join(ROOT, file), 'utf8'), screen))
    if (process.env.WO2328_DUMP) writeFileSync(process.env.WO2328_DUMP, JSON.stringify(findings, null, 1))
    const fresh = unlisted(findings)
    if (fresh.length) throw new Error(report(fresh))
  }, 60000)

  it('fails a fixture component that adds a hard-coded English label, and names file, line and text', () => {
    const file = 'src/components/fixture/Wo2328Fixture.tsx'
    const hardCoded = [
      "export function Panel({ busy }: { busy: boolean }) {",
      "  return <div className=\"panel-row\" data-testid=\"wo2328-row\">",
      "    <button title=\"Start the spindle\">Spindle on</button>",
      "    {busy ? 'Saving...' : null}",
      "    <input placeholder=\"search\" /><span>{`${busy ? 'Saving' : 'Ready'}`}</span><span>read-only</span>",
      "  </div>",
      "}",
    ].join('\n')
    const found = unlisted(scanSource(file, hardCoded, true))
    expect(found.map(f => `${f.line} ${f.site} ${f.text}`)).toEqual([
      '3 title= Start the spindle',
      '3 JSX text Spindle on',
      '4 JSX text Saving...',
      '5 placeholder= search',
      '5 JSX text Saving',
      '5 JSX text Ready',
      '5 JSX text read-only',
    ])
    const message = report(found)
    expect(message).toContain(`${file}:3 title= "Start the spindle"`)
    expect(message).toContain('Add each to its area catalog')
    // The same fixture through the catalog passes.
    const viaCatalog = hardCoded
      .replace('title="Start the spindle">Spindle on<', "title={t('start')}>{t('on')}<")
      .replace("'Saving...'", "t('saving')")
      .replace('placeholder="search"', "placeholder={t('search')}")
      .replace("{`${busy ? 'Saving' : 'Ready'}`}", "{`${busy ? t('saving') : t('ready')}`}")
      .replace('<span>read-only</span>', "<span>{t('readOnly')}</span>")
    expect(scanSource(file, viaCatalog, true)).toEqual([])
  })

  it('fails a new hard-coded console message in lib and store', () => {
    const source = [
      "store().pushConsole('rx', 'The probe did not trip', 'warn')",
      "get().addConsoleEvent({ severity: 'error', source: 'toolpath', message: `Could not plan ${name}` })",
      "store().pushConsole('tx', 'G0 X0 Y0', 'info')",
      "store().pushConsole('rx', textFor('console-and-operator-messages')('x'), 'info')",
      "store().pushConsole('rx', 'disconnected', 'info')",
    ].join('\n')
    expect(scanSource('src/lib/machine/wo2328.ts', source, false).map(f => `${f.line} ${f.text}`)).toEqual([
      '1 The probe did not trip',
      '2 Could not plan {}',
      '5 disconnected',
    ])
  })

  it('raises no false alarm on G-code, units, dialects, file formats, keys, identifiers, class names or test ids', () => {
    const source = [
      "export const X = () => <div className=\"control-dro big\" data-testid=\"dro-x\" id=\"dro\" role=\"group\">",
      "  <code>G0 G90 G54 M6 T{tool} S12000 M3</code> <span>{rpm} rpm</span> <span>{`${f} mm/min`}</span>",
      "  <span>{deg}deg</span> <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> <kbd>Esc</kbd> <span>X</span><span>IJK</span>",
      "  <span title=\"UCCNC\">LinuxCNC</span> <span>GRBL</span> <span>.nc</span> <span>STL</span> <span>STEP</span> <span>DXF</span>",
      "  <span label=\"opMachineAction\" tooltip=\"spindle-off\">&nbsp;&#x283F;</span> <span>{a} / {b}</span> <span>%</span>",
      "  <EstopControl tooltip=\"native\" /> <span>{`${n} .camproject`}</span>",
      "</div>",
    ].join('\n')
    expect(scanSource('src/components/fixture/Literals.tsx', source, true)).toEqual([])
  })

  it('counts allowed residual text, so a second copy of an allowed sentence is new', () => {
    const findings = [1, 2].map(line => ({ file: 'a.tsx', line, site: 'JSX text', text: 'Applying...' }))
    expect(unlisted(findings, [{ file: 'a.tsx', reason: 'r', texts: ['Applying...'] }]).map(f => f.line)).toEqual([2])
  })

  it('documents every allow-list entry with a one-line reason', () => {
    for (const entry of [...LITERAL_TOKENS, ...RESIDUAL_TEXT]) {
      expect(entry.reason.trim().length, JSON.stringify(entry).slice(0, 80)).toBeGreaterThan(10)
      expect(entry.reason).not.toContain('\n')
    }
    for (const entry of RESIDUAL_TEXT) expect(entry.texts.length, entry.file).toBeGreaterThan(0)
    // One entry per file and reason: a file may hold the original residual and
    // a group for each later order that added text to it.
    expect(new Set(RESIDUAL_TEXT.map(e => `${e.file}\n${e.reason}`)).size).toBe(RESIDUAL_TEXT.length)
  })
})
