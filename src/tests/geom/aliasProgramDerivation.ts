// WO UI-57-R3 -- the COMPILER-GROUNDED derivations both census tiers needed and
// neither had (the two R2 BLOCKERs), built on ONE real ts.Program over the app's
// own tsconfig.
//
// WHY A PROGRAM, NOT A PER-FILE PARSE. The R2 census parsed each file in
// isolation with ts.createSourceFile, which cannot resolve anything declared
// somewhere else. Both blockers are that limitation, wearing two hats:
//
//   TIER 1's hat. deltaShapedTypeNames() only learned interfaces/type aliases
//   declared in the SAME FILE, and returnTypeHasDeltaShape() only recognized
//   those local names. The R2 auditor appended
//
//       auditUnclassifiedDeltaProducer(): ElementMapDelta { return auditBuildDelta() }
//
//   to geom-engine.ts -- the CANONICAL IMPORTED type, no object literal -- and
//   the census stayed GREEN at 28/28 with EXIT CODE 0 while the control
//   type-checker identified the function as returning the required shape. The
//   fix is to ask the same question the control asked: resolve the return type
//   BY PROPERTY through the checker, so imported / aliased / inherited / union /
//   parenthesized / Promise-wrapped shapes are all one code path and none of
//   them is a syntax anyone has to remember to enumerate.
//
//   TIER 2's hat. The consumer check scanned a hard-coded CANDIDATE_FILES array
//   of the three already-known files, so a new aliasLineage importer ANYWHERE
//   else in src was never presented to the classifier at all. The R2 auditor
//   added src/geom/worker/auditAliasConsumer.ts importing resolveFaceIdVia with
//   no census entry; the census stayed GREEN at 28/28. That is "enumerate only
//   known paths", which the two-bounce ruling forbids by name. The fix is
//   REPOSITORY DISCOVERY: every production source file in the Program is
//   examined, and membership is decided by the compiler's own module resolution
//   -- never by a list.
//
// PRECEDENT: tools/deriveSetupClosure.mjs:45-53 builds exactly this Program
// (parseJsonConfigFileContent + createProgram from tsconfig.app.json) and exists
// for the same reason -- the CAM-12 STOP ruling found three rounds of
// hand-derived census tables each missed a real field. `typescript` is already a
// direct devDependency (package.json).
//
// COST: ~4.3 s to create the Program + ~1.4 s for the checker over ~1,220 files,
// measured on this tree. Built ONCE and shared by both tiers.
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root, from this file at src/tests/geom/. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** The three fields that make a type an ElementMapDelta-shaped lineage
 *  statement -- the SAME definition the syntactic tier uses, asked of the
 *  checker's resolved type rather than of the source text. */
const DELTA_SHAPE_FIELDS = ['modified', 'generated', 'deleted'] as const

const norm = (p: string): string => p.replace(/\\/g, '/')

export interface AliasProgram {
  program: ts.Program
  checker: ts.TypeChecker
  options: ts.CompilerOptions
  /** Absolute, normalized path of the shared alias module. */
  aliasModulePath: string
}

/**
 * ONE Program over the app's real tsconfig -- the same file set `npm run build`
 * type-checks, so the census cannot be green over a source set the build does
 * not see.
 */
export function createAliasProgram(aliasModuleRepoPath: string): AliasProgram {
  const configPath = resolve(REPO_ROOT, 'tsconfig.app.json')
  const configFile = ts.readConfigFile(configPath, (p) => readFileSync(p, 'utf8'))
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, REPO_ROOT)
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  return {
    program,
    checker: program.getTypeChecker(),
    options: parsed.options,
    aliasModulePath: norm(resolve(REPO_ROOT, aliasModuleRepoPath)),
  }
}

/**
 * An IN-MEMORY Program over literal fixture sources, so every RED direction this
 * module claims is a COMMITTED, permanently-re-run proof driving the SAME
 * exported derivations as the real tree -- never a re-implemented copy, and
 * never a rogue producer/importer left permanently in src/ (which would itself
 * need a disposition and pollute the very domain it is testing; WO amendment
 * B4).
 *
 * Files are keyed repo-relative ('src/geom/worker/engine.ts'); the alias module
 * must be one of them.
 */
export function createInMemoryAliasProgram(files: Record<string, string>, aliasModuleRepoPath: string): AliasProgram {
  const abs = (rel: string): string => norm(resolve(REPO_ROOT, rel))
  const sources = new Map<string, string>(Object.entries(files).map(([rel, text]) => [abs(rel), text]))
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
  }
  const host: ts.CompilerHost = {
    fileExists: (f) => sources.has(norm(f)) || ts.sys.fileExists(f),
    readFile: (f) => sources.get(norm(f)) ?? ts.sys.readFile(f),
    getSourceFile: (f, lang) => {
      const text = sources.get(norm(f)) ?? ts.sys.readFile(f)
      return text === undefined ? undefined : ts.createSourceFile(f, text, lang, true, ts.ScriptKind.TS)
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => undefined,
    getCurrentDirectory: () => REPO_ROOT,
    getCanonicalFileName: (f) => norm(f),
    useCaseSensitiveFileNames: () => false,
    getNewLine: () => '\n',
    directoryExists: (d) => ts.sys.directoryExists(d) || [...sources.keys()].some((f) => f.startsWith(`${norm(d)}/`)),
    getDirectories: (d) => ts.sys.getDirectories(d),
  }
  const program = ts.createProgram({ rootNames: [...sources.keys()], options, host })
  return { program, checker: program.getTypeChecker(), options, aliasModulePath: abs(aliasModuleRepoPath) }
}

/** Repo-relative, forward-slashed path of a source file (the key every census
 *  table uses). */
export function repoRelative(fileName: string): string {
  const n = norm(fileName)
  const root = `${norm(REPO_ROOT)}/`
  return n.startsWith(root) ? n.slice(root.length) : n
}

// ---------------------------------------------------------------------------
// TIER 1 (advisory discovery): return-shape by the CHECKER, not by the text.
// ---------------------------------------------------------------------------

/** Unwrap Promise<T> -> T, so an `async` producer's declared shape is judged on
 *  what it actually resolves to. */
function awaited(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  const sym = type.getSymbol()
  if (sym?.getName() === 'Promise') {
    const args = checker.getTypeArguments(type as ts.TypeReference)
    if (args.length === 1) return args[0]
  }
  return type
}

/**
 * Does this CHECKER-RESOLVED type state a delta shape -- directly, through an
 * imported/aliased name, through an interface's inherited members, as any member
 * of a union, or inside a Promise?
 *
 * Union: ANY constituent matching is enough, because every producer here returns
 * `{...} | { ok: false; reason }` -- demanding every constituent match would
 * derive none of them.
 *
 * getProperty() is the whole point: it answers "does the resolved type HAVE this
 * member", which is exactly the question the R2 extractor could not ask and the
 * control type-checker could. Inheritance, imports, and aliases are the
 * checker's problem, not this function's.
 */
export function typeHasDeltaShape(checker: ts.TypeChecker, type: ts.Type): boolean {
  const t = awaited(checker, type)
  if (t.isUnion()) return t.types.some((c) => typeHasDeltaShape(checker, c))
  if (t.isIntersection()) return DELTA_SHAPE_FIELDS.every((f) => t.getProperty(f) !== undefined)
  return DELTA_SHAPE_FIELDS.every((f) => t.getProperty(f) !== undefined)
}

export interface CheckedReturnSite {
  file: string
  line: number
  name: string
  /** The checker's own rendering of the resolved return type, for the RED
   *  message -- so a reader sees WHY it was derived. */
  typeText: string
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
}

function namedOf(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text
  if (ts.isMethodDeclaration(fn)) {
    if (ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name) || ts.isStringLiteral(fn.name)) return fn.name.text
  }
  const p = fn.parent
  if (p === undefined) return null
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text
  return null
}

/**
 * Every named function in `repoRelativeFiles` whose CHECKER-RESOLVED return type
 * is delta-shaped. This is the derivation the R2 audit's control used and the
 * committed extractor lacked.
 */
export function deriveCheckedReturnProducers(ap: AliasProgram, repoRelativeFiles: readonly string[]): CheckedReturnSite[] {
  const wanted = new Set(repoRelativeFiles.map((f) => norm(f)))
  const out: CheckedReturnSite[] = []
  for (const sf of ap.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    const rel = repoRelative(sf.fileName)
    if (!wanted.has(rel)) continue
    ;(function visit(node: ts.Node): void {
      if (isFunctionLike(node)) {
        const name = namedOf(node)
        // A function-like with NO BODY cannot produce anything at runtime: it is
        // an ambient `declare`, an interface method signature, or -- the case
        // that matters in real source -- a TypeScript OVERLOAD signature, whose
        // implementation is the next declaration along. Deriving those would
        // double-count a single producer and demand dispositions for functions
        // that do not exist at run time. The implementation signature, which has
        // the body, is the one derived.
        if (name !== null && node.body !== undefined) {
          const signature = ap.checker.getSignatureFromDeclaration(node)
          if (signature !== undefined) {
            const ret = ap.checker.getReturnTypeOfSignature(signature)
            if (typeHasDeltaShape(ap.checker, ret)) {
              out.push({
                file: rel,
                line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                name,
                typeText: ap.checker.typeToString(ret).slice(0, 200),
              })
            }
          }
        }
      }
      node.forEachChild(visit)
    })(sf)
  }
  return out
}

// ---------------------------------------------------------------------------
// TIER 2: REPOSITORY-WIDE import-graph discovery, by the compiler's own module
// resolution. No file array anywhere.
// ---------------------------------------------------------------------------

/**
 * THE PRODUCTION-ROOT RULE (the WO's explicit demand: "Keep test files out by an
 * explicit production-root rule, not a known-file allowlist").
 *
 * A file is PRODUCTION iff it lives under src/ and not under src/tests/. Tests
 * import the alias module constantly -- that is what a test does -- and are not
 * app-reachable consumers of the resolver invariant. Stating the rule
 * structurally (rather than listing the files it happens to exclude today) is
 * what makes a NEW production consumer discoverable and a NEW test file
 * automatically out of scope.
 */
export function isProductionSource(repoRelPath: string): boolean {
  return repoRelPath.startsWith('src/') && !repoRelPath.startsWith('src/tests/')
}

/** Resolve a module specifier from `fromFile` using the compiler host -- the
 *  same resolution the build uses (bundler mode, .ts extensions allowed), never
 *  path arithmetic. */
export function resolveSpecifier(ap: AliasProgram, fromFile: string, specifier: string): string | null {
  const r = ts.resolveModuleName(specifier, fromFile, ap.options, ts.sys)
  const f = r.resolvedModule?.resolvedFileName
  return f === undefined ? null : norm(f)
}

/**
 * Every module that PROVIDES aliasLineage's exports -- the module itself plus,
 * transitively, every re-export barrel that forwards them (`export * from`,
 * `export { x } from`). Fixpoint, so a barrel chain of any depth is followed.
 *
 * This is what stops a consumer from hiding one hop away: importing
 * resolveFaceIdVia from `src/geom/index.ts` (which re-exports it) is consuming
 * the shared resolver just as much as importing it directly, and the census must
 * see it.
 */
export function deriveProviderModules(ap: AliasProgram): Set<string> {
  const providers = new Set<string>([ap.aliasModulePath])
  let grew = true
  while (grew) {
    grew = false
    for (const sf of ap.program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue
      const self = norm(sf.fileName)
      if (providers.has(self)) continue
      for (const stmt of sf.statements) {
        if (!ts.isExportDeclaration(stmt)) continue
        const spec = stmt.moduleSpecifier
        if (spec === undefined || !ts.isStringLiteral(spec)) continue
        const target = resolveSpecifier(ap, sf.fileName, spec.text)
        if (target !== null && providers.has(target)) { providers.add(self); grew = true; break }
      }
    }
  }
  return providers
}

export interface DiscoveredImporter {
  /** Repo-relative path -- the key the consumer census tables use. */
  file: string
  line: number
  /** The aliasLineage export names it takes (through a barrel or directly). */
  imported: string[]
  /** How it was discovered. Both forms are unioned into the domain because
   *  either alone has a blind spot the other closes. */
  via: 'static-import' | 'dynamic-import'
  text: string
  /** For a dynamic import: the specifier VALUE that was statically evaluated,
   *  and how. A literal token and a const-bound specifier resolve to the same
   *  module and are the same consumer; recording HOW is what lets the census
   *  prove it saw the non-literal forms rather than assert it. */
  specifier?: { value: string; form: StaticStringForm }
}

/**
 * An `import()` in PRODUCTION source whose specifier CANNOT be evaluated
 * statically -- so nothing can prove it does not resolve to aliasLineage.
 *
 * THIS IS THE FAIL-CLOSED HALF of the R3 audit's B2 blocker (its suggested fix,
 * verbatim: "together with a nonconstant control that remains explicitly
 * undiscoverable or fails closed by named disposition"). An unreadable specifier
 * is not evidence of absence: dropping it silently is precisely the fail-open
 * class this WO family has been bounced for three rounds running. So it leaves
 * the derivation as a NAMED, first-class member the census must rule on.
 */
export interface UnresolvableDynamicImport {
  file: string
  line: number
  text: string
  /** Why the evaluator could not read it -- so the RED message tells a reader
   *  what to do rather than only that something is wrong. */
  reason: string
}

/** How a specifier's value was recovered. Ordered cheapest-first, and reported
 *  so a census cell can assert the NON-LITERAL paths are really exercised (a
 *  const-specifier probe that silently took the literal branch would prove
 *  nothing -- the exact shape of the R3 B2 blocker). */
export type StaticStringForm =
  | 'string-literal'
  | 'template-no-substitution'
  | 'template-expression'
  | 'concatenation'
  | 'checker-literal-type'

export interface StaticString { value: string; form: StaticStringForm }

/**
 * Evaluate a specifier expression to its string value, or null if it genuinely
 * cannot be known without running the program.
 *
 * WHY THIS EXISTS (the R3 audit's B2 BLOCKER, verbatim): "discoverAliasImporters
 * enters the dynamic-import path only when the argument node itself is
 * ts.StringLiteral; it does not resolve a statically-known const, even though
 * binding amendment B2 explicitly covers a string-literal or statically-
 * resolvable specifier." The auditor's probe --
 *
 *     const route = '../aliasLineage.ts' as const
 *     const { resolveFaceIdVia } = await import(route)
 *
 * -- returned [] and printed CONST_SPECIFIER_ENUMERATED=false. A consumer route
 * the census cannot see is a blocker whatever syntax hid it, and "the argument
 * is a StringLiteral node" is a syntax list one rename long.
 *
 * THE MECHANISM: structural evaluation for the forms that compose (templates,
 * `+`), then THE CHECKER for everything a name can stand in front of. Asking
 * `getTypeAtLocation(...).isStringLiteral()` is the same question the audit's
 * control asked, and it answers for const bindings, `as const`, readonly
 * properties, enum members, and imported constants in ONE code path -- none of
 * which is a syntax anyone has to remember to enumerate. That is the whole
 * difference between this and the token check it replaces.
 */
export function evaluateStaticString(checker: ts.TypeChecker, node: ts.Expression): StaticString | null {
  if (ts.isStringLiteral(node)) return { value: node.text, form: 'string-literal' }
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { value: node.text, form: 'template-no-substitution' }
  if (ts.isParenthesizedExpression(node)) return evaluateStaticString(checker, node.expression)
  // `x as const` / `x satisfies T` are type-level noise over the value beneath.
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) {
    const inner = evaluateStaticString(checker, node.expression)
    return inner === null ? null : { value: inner.value, form: inner.form }
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      const part = evaluateStaticString(checker, span.expression)
      if (part === null) return null
      value += part.value + span.literal.text
    }
    return { value, form: 'template-expression' }
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = evaluateStaticString(checker, node.left)
    const r = evaluateStaticString(checker, node.right)
    return l === null || r === null ? null : { value: l.value + r.value, form: 'concatenation' }
  }
  // THE CHECKER: any expression whose RESOLVED TYPE is a single string literal
  // is statically known, whatever expression form spelled it.
  const t = checker.getTypeAtLocation(node)
  if (t.isStringLiteral()) return { value: t.value, form: 'checker-literal-type' }
  return null
}

const stripAndNormalize = (raw: string): string =>
  raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * REPOSITORY DISCOVERY: every PRODUCTION module in the Program that imports an
 * aliasLineage export, by static import OR by dynamic `import()`, directly or
 * through a re-export barrel.
 *
 * THE DYNAMIC-IMPORT HALF (WO amendment B2). A consumer written
 *
 *     const { resolveFaceIdVia } = await import('../../geom/aliasLineage')
 *
 * is a ts.CallExpression, NOT a ts.ImportDeclaration. The R2 extractor walked
 * only import declarations, and the R3 contract's own suggested fix ("parse
 * every import declaration") would have missed it too -- while the codebase
 * already uses dynamic import elsewhere (meshLabWorker.ts:26). So
 * ImportKeyword-headed calls are walked as first-class members of this domain.
 */
export function discoverAliasImporters(ap: AliasProgram): DiscoveredImporter[] {
  return discoverAliasImportGraph(ap).importers
}

export interface AliasImportGraph {
  importers: DiscoveredImporter[]
  /** Production `import()` calls whose specifier could not be evaluated. The
   *  census REFUSES on these by name (see UnresolvableDynamicImport): an
   *  unreadable route is an unproven one, never an absent one. */
  unresolvable: UnresolvableDynamicImport[]
}

/**
 * REPOSITORY DISCOVERY, both halves: who imports the shared module, and which
 * `import()` calls could not be read at all.
 *
 * The two are ONE walk on purpose. A discovery that returned only its hits would
 * let the census conclude "no consumer here" from a specifier it never managed
 * to evaluate -- the reading of silence as safety that the R2 and R3 audits both
 * walked straight through.
 */
export function discoverAliasImportGraph(ap: AliasProgram): AliasImportGraph {
  const providers = deriveProviderModules(ap)
  const out: DiscoveredImporter[] = []
  const unresolvable: UnresolvableDynamicImport[] = []

  for (const sf of ap.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    const rel = repoRelative(sf.fileName)
    if (!isProductionSource(rel)) continue
    if (providers.has(norm(sf.fileName))) continue // the module cannot consume itself

    const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

    // ---- static imports -------------------------------------------------
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
      const target = resolveSpecifier(ap, sf.fileName, stmt.moduleSpecifier.text)
      if (target === null || !providers.has(target)) continue
      const bindings = stmt.importClause?.namedBindings
      const imported: string[] = []
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) imported.push(el.name.text)
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        // `import * as lineage from '...'` -- a namespace import takes EVERY
        // export, so it is a consumer of all of them. Recorded honestly rather
        // than dropped for having no named bindings to list.
        imported.push('* (namespace import)')
      }
      if (imported.length === 0) continue
      out.push({ file: rel, line: lineOf(stmt), imported: imported.sort(), via: 'static-import', text: stripAndNormalize(stmt.getText(sf)) })
    }

    // ---- dynamic import() -----------------------------------------------
    ;(function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0]
        const text = stripAndNormalize(node.getText(sf)).slice(0, 160)
        // WO UI-57-R4 (the R3 audit's B2 BLOCKER): the specifier is EVALUATED,
        // not token-matched. A const-bound or template specifier names the same
        // module a literal would, and the census must see the same consumer.
        const spec = arg === undefined ? null : evaluateStaticString(ap.checker, arg)
        if (arg === undefined) {
          unresolvable.push({ file: rel, line: lineOf(node), text, reason: 'import() called with NO argument' })
        } else if (spec === null) {
          // FAIL CLOSED. Nothing here proves this is not the shared resolver.
          unresolvable.push({
            file: rel, line: lineOf(node), text,
            reason:
              `the specifier expression (${ts.SyntaxKind[arg.kind]}) has type '${ap.checker.typeToString(ap.checker.getTypeAtLocation(arg)).slice(0, 60)}', ` +
              'which is not a single string literal, so no static derivation can know which module it loads',
          })
        } else {
          const target = resolveSpecifier(ap, sf.fileName, spec.value)
          if (target !== null && providers.has(target)) {
            out.push({
              file: rel, line: lineOf(node),
              imported: destructuredNamesOf(node),
              via: 'dynamic-import',
              text,
              specifier: spec,
            })
          }
        }
      }
      node.forEachChild(visit)
    })(sf)
  }
  return { importers: out, unresolvable }
}

/**
 * The names a dynamic import's result is destructured into, e.g.
 * `const { resolveFaceIdVia } = await import('...')` -> ['resolveFaceIdVia'].
 * A dynamic import whose names cannot be read statically (held whole, or
 * property-accessed later) still counts as a consumer -- it is recorded as
 * taking the whole module rather than silently dropped for being unreadable,
 * which would be fail-OPEN.
 */
function destructuredNamesOf(call: ts.CallExpression): string[] {
  let cur: ts.Node = call
  // Walk out through `await` / parenthesis to the variable declaration, if any.
  while (cur.parent !== undefined && (ts.isAwaitExpression(cur.parent) || ts.isParenthesizedExpression(cur.parent))) cur = cur.parent
  const parent = cur.parent
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
    const names: string[] = []
    for (const el of parent.name.elements) {
      const n = el.propertyName ?? el.name
      if (ts.isIdentifier(n)) names.push(n.text)
    }
    if (names.length > 0) return names.sort()
  }
  return ['* (dynamic import, names not statically readable)']
}
