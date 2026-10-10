// GEO-11-R2 (blocker 2, PROVE THE CENSUS) + GEO-14 item 4 (BK-110 a, ALIAS-PROOF).
// =====================================================================
// The every-consumer finite-data defense is only complete if the set of `healRemoval`
// CALL SITES is known and fixed. The audit found exactly TWO production consumers; this
// scan enumerates every call site in src/ (excluding tests) and FAILS if a third appears,
// so a future consumer cannot be added without either wiring the same finite-data gate or
// tripping this gate.
//
// BK-110(a): the ORIGINAL census keyed on the literal `healRemoval(` token via regex, which
// an aliased import (`import { healRemoval as heal }`), a destructured alias
// (`const { healRemoval: h } = mod`), a re-export (`export { healRemoval as gone }`), or a
// bracket-property call (`mod['healRemoval'](...)`) all EVADE — the token `healRemoval(` never
// appears on the call line. GEO-14 replaces it with an AST scan (TypeScript parser, syntactic
// only) that resolves the local binding name of the imported symbol and counts calls through
// ANY of those forms, plus re-export leaks. The four evasion fixtures below each prove the
// scan COUNTS the form AND the old regex MISSED it (a mutation-style proof on the scan itself:
// weaken the scan back to the regex and every fixture assertion fails).
import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(process.cwd(), 'src')
const TARGET = 'healRemoval'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'tests' || name === '__tests__' || name === 'node_modules') continue
      out.push(...walk(p))
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

// ---- the AST census: alias-resolving, form-agnostic, 0 false negatives on the 4 evasions ----
// Returns the 1-based line numbers of every site in `text` that CALLS or RE-EXPORTS the
// `healRemoval` export, under any name. Excludes the `export function healRemoval` DEFINITION
// (a declaration, not a call). No type-checker: purely per-file syntactic resolution.
function scanSites(fileName: string, text: string): number[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS)
  const aliases = new Set<string>()   // local identifiers bound to the healRemoval export

  // pass 1 — collect local binding names (aliased/plain named imports + destructured aliases).
  ;(function collect(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) {
        const orig = el.propertyName?.text ?? el.name.text     // `healRemoval as heal` -> propertyName=healRemoval
        if (orig === TARGET) aliases.add(el.name.text)
      }
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.name && ts.isObjectBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            const prop = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName)) ? el.propertyName.text : undefined
            const local = ts.isIdentifier(el.name) ? el.name.text : undefined
            if (prop === TARGET && local) aliases.add(local)           // { healRemoval: h }
            else if (!prop && local === TARGET) aliases.add(local)     // { healRemoval }
          }
        }
      }
    }
    node.forEachChild(collect)
  })(sf)

  // pass 2 — count call + re-export sites.
  const lines: number[] = []
  const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  ;(function count(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const c = node.expression
      if (ts.isIdentifier(c) && aliases.has(c.text)) lines.push(at(node))                                   // heal(...) / h(...)
      else if (ts.isPropertyAccessExpression(c) && c.name.text === TARGET) lines.push(at(node))             // mod.healRemoval(...)
      else if (ts.isElementAccessExpression(c) && c.argumentExpression && ts.isStringLiteralLike(c.argumentExpression) && c.argumentExpression.text === TARGET) lines.push(at(node))  // mod['healRemoval'](...)
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        const orig = el.propertyName?.text ?? el.name.text
        if (orig === TARGET) lines.push(at(el))                                                             // export { healRemoval as gone } from '...'
      }
    }
    node.forEachChild(count)
  })(sf)
  return lines.sort((a, b) => a - b)
}

// the OLD naive regex census, kept ONLY to prove the AST scan is strictly stronger.
function naiveRegexCount(text: string): number {
  let n = 0
  for (const line of text.split(/\r?\n/)) {
    if (/\bhealRemoval\s*\(/.test(line) && !/function\s+healRemoval\s*\(/.test(line)) n++
  }
  return n
}

function productionSites(): string[] {
  const hits: string[] = []
  for (const file of walk(SRC)) {
    for (const ln of scanSites(file, readFileSync(file, 'utf8'))) {
      hits.push(`${relative(SRC, file).replace(/\\/g, '/')}:${ln}`)
    }
  }
  return hits.sort()
}

describe('HealResult consumer census — alias-proof (GEO-11-R2 + GEO-14 BK-110a)', () => {
  it('there are EXACTLY two production healRemoval call sites, both in geom-engine.ts', () => {
    const sites = productionSites()
    // If this fails with a NEW site, that consumer MUST validate the HealResult at its accept
    // point (heal.ok && heal.shape && Number.isFinite(heal.volumeDelta), plus a finite-positive-
    // volume/solid final gate) before it is added here.
    expect(sites.length, `expected exactly 2 healRemoval call sites, found: ${sites.join(', ')}`).toBe(2)
    expect(sites.every((s) => s.startsWith('geom/worker/geom-engine.ts:')), `all call sites live in geom-engine.ts: ${sites.join(', ')}`).toBe(true)
  }, 15_000)

  // ---- BK-110(a): the four alias/indirection forms the old regex evaded. Each MUST be COUNTED
  //      by the AST scan AND MISSED by the regex — else the scan has silently weakened. ----
  const fixtures: Array<{ name: string; src: string }> = [
    {
      name: 'aliased import',
      src: [
        `import { healRemoval as heal } from '../../geom/worker/defeature.ts'`,
        `export function run(k: any, s: any, f: any, sc: any) { return heal(k, s, f, sc) }`,
      ].join('\n'),
    },
    {
      name: 'destructured alias',
      src: [
        `import * as mod from '../../geom/worker/defeature.ts'`,
        `const { healRemoval: h } = mod`,
        `export function run(k: any, s: any, f: any, sc: any) { return h(k, s, f, sc) }`,
      ].join('\n'),
    },
    {
      name: 're-export',
      src: `export { healRemoval as gone } from '../../geom/worker/defeature.ts'`,
    },
    {
      name: 'bracket-property call',
      src: [
        `import * as mod from '../../geom/worker/defeature.ts'`,
        `export function run(k: any, s: any, f: any, sc: any) { return mod['healRemoval'](k, s, f, sc) }`,
      ].join('\n'),
    },
  ]

  for (const fx of fixtures) {
    it(`#alias counts an evasion the regex misses: ${fx.name}`, () => {
      const astHits = scanSites(`fixture-${fx.name.replace(/\s+/g, '-')}.ts`, fx.src)
      const regexHits = naiveRegexCount(fx.src)
      expect(astHits.length, `AST scan COUNTS the ${fx.name} form`).toBeGreaterThanOrEqual(1)
      expect(regexHits, `the old regex MISSES the ${fx.name} form (proving the AST scan is strictly stronger)`).toBe(0)
    })
  }

  it('CONTROL: the AST scan does NOT count the export-function DEFINITION or a bare mention', () => {
    const defn = `export function healRemoval(k: any) { return k }\n// a comment about healRemoval() usage\nconst notACall = healRemoval\n`
    expect(scanSites('defn.ts', defn).length, 'the definition + a mention are not call sites').toBe(0)
    // and a genuine bare-identifier call IS counted (so the scan is not vacuous).
    const call = `import { healRemoval } from '../../geom/worker/defeature.ts'\nexport const r = healRemoval(1 as any, 2 as any, 3 as any, 4 as any)`
    expect(scanSites('call.ts', call).length, 'a bare imported call is counted').toBe(1)
  })
})
