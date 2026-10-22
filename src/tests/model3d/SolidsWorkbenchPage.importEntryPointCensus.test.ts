// WO CAM-13B (derivation duty, standing rule): "DERIVE the set of import
// entry points that can produce a workbench tree row from the code (grep
// constructors of 'import'-kind DAG nodes), and cover every one you find or
// prove it unreachable - do not hand-list."
//
// CAM-13B-R1 MAJOR (audit, importEntryPointCensus.test.ts:58): the original
// census was a single-line regex for the exact token sequence `kind: 'import'`
// -- a new constructor spelled `kind: ('import')` (parenthesized) or
// `kind: importKind` (a const alias) was INVISIBLE to it, so the hard-coded
// one-file expectation stayed green while a second, unnamed entry point could
// exist undetected. This rewrite derives the census through a real TypeScript
// AST walk instead of line text:
//
//  1. Scan every production (non-test) .ts/.tsx file for a call matching one
//     of the four shapes that can hand a plain-data node to FeatureDag
//     (dag.ts:48-57's DagNodeInput): `createFeatureCommand(dag, X)`,
//     `<dag>.insertNode(X)`, `new InsertNodeCommand(X)`,
//     `new InsertAtMarkerCommand(X)`.
//  2. Resolve each call's node-input argument `X` down to the object literal
//     that actually carries `kind` -- following parens/`as const`, a local
//     `const`/destructured alias, or a call to a same-repo helper function that
//     returns the node-input literal (e.g. buildFacePlaneDatumNodeInput). The
//     only pass-throughs exempt from literal resolution are classified below
//     by their exact source declaration identity -- never by field-name text.
//  3. Resolve the object literal's `kind` property the same way (parens,
//     const alias) to a literal string.
//  4. Anything the resolver cannot reduce to a literal string, including an
//     unproven field/parameter/element-access/helper indirection, is NOT
//     silently dropped: it must appear in KNOWN_UNCLASSIFIABLE_SITES below
//     with a written proof of what it resolves to and why -- a new, unlisted
//     site fails this test BY FILE + LINE + FORM (the "prove it unreachable"
//     half of the derivation rule; this is the fail-closed catch-all the
//     audit required in place of the old regex's silent false negative).
//
// Two things are still asserted about the real production tree, same as the
// original census: the exact set of confirmed "import"-kind sites, and that
// every one of them plumbs a `name:` field into its payload.
//
// Pure text/AST census (node:fs + the `typescript` compiler API already a
// project dependency), same technique family as
// SolidsWorkbenchPage.stateCensus.test.ts -- no jsdom/kernel needed, fast
// (the full production tree scans in ~1.5s).

import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { describe, it, expect } from 'vitest'

const SRC_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function listProductionSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'tests') continue // production code only -- test fixtures are not app entry points
      out.push(...listProductionSourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  while (true) {
    if (ts.isParenthesizedExpression(e)) { e = e.expression; continue }
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) { e = e.expression; continue }
    break
  }
  return e
}

function propName(prop: ts.ObjectLiteralElementLike): string | undefined {
  const name = (prop as { name?: ts.PropertyName }).name
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return undefined
}

function findEnclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur)) return cur
    cur = cur.parent
  }
  return undefined
}

function findEnclosingClass(node: ts.Node): ts.ClassDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isClassDeclaration(cur)) return cur
    cur = cur.parent
  }
  return undefined
}

/** First in `sourceFile`, then (an imported helper) across every other parsed production file --
 *  exported DagNodeInput-building helpers like buildFacePlaneDatumNodeInput live one file away
 *  from their call site. */
function findTopLevelFunctionDecl(sourceFile: ts.SourceFile, name: string, allFiles: readonly ts.SourceFile[]): ts.FunctionDeclaration | undefined {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt
  }
  for (const other of allFiles) {
    if (other === sourceFile) continue
    for (const stmt of other.statements) {
      if (
        ts.isFunctionDeclaration(stmt) &&
        stmt.name?.text === name &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        return stmt
      }
    }
  }
  return undefined
}

/** WO-2805 audit: prove one unconditional terminal return; never choose the first branch.
 *  Multiple/bare/conditional returns stay unresolved rather than guessing at control flow. */
function singleReturnExpr(fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  if (!fn.body || !ts.isBlock(fn.body)) return undefined
  const terminal = fn.body.statements[fn.body.statements.length - 1]
  if (!terminal || !ts.isReturnStatement(terminal) || !terminal.expression) return undefined
  let returnCount = 0
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) { returnCount++; return }
    if (ts.isFunctionLike(node) && node !== fn) return // don't descend into nested function bodies
    ts.forEachChild(node, visit)
  }
  visit(fn.body)
  return returnCount === 1 ? terminal.expression : undefined
}

/** WO-2805 follow-up (Rholand review 10-14): a variable whose value is changed after its declaration
 *  (reassigned, a property written or deleted, or handed to Object.assign) is not proven by its
 *  initializer - default-deny. */
function isMutatedIn(scope: ts.Node, name: string): boolean {
  let mutated = false
  const rootIs = (n: ts.Expression): boolean => {
    let cur: ts.Expression = n
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = cur.expression
    return ts.isIdentifier(cur) && cur.text === name
  }
  const visit = (node: ts.Node): void => {
    if (mutated) return
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && rootIs(node.left)) mutated = true
    else if (ts.isDeleteExpression(node) && rootIs(node.expression)) mutated = true
    else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        && rootIs(node.operand)) mutated = true
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object'
        && node.expression.name.text === 'assign' && node.arguments[0] && rootIs(node.arguments[0])) mutated = true
    ts.forEachChild(node, visit)
  }
  visit(scope)
  return mutated
}

type ValueResolution = { type: 'object'; node: ts.ObjectLiteralExpression }

/** Resolve `expr` down to the object literal it evaluates to, or undefined when the value is
 *  not proven. Pass-through exemptions are handled separately by exact declaration identity;
 *  this resolver is deliberately default-deny. Bounded depth guards pathological recursion. */
function resolveValue(
  expr: ts.Expression,
  enclosingFn: ts.FunctionLikeDeclaration | undefined,
  sourceFile: ts.SourceFile,
  depth: number,
  allFiles: readonly ts.SourceFile[],
): ValueResolution | undefined {
  if (depth > 8) return undefined
  const e = unwrap(expr)

  if (ts.isObjectLiteralExpression(e)) return { type: 'object', node: e }

  if (e.kind === ts.SyntaxKind.ThisKeyword) return undefined

  if (ts.isIdentifier(e)) {
    const name = e.text
    const scopes: ts.Node[] = enclosingFn ? [enclosingFn, sourceFile] : [sourceFile]
    for (const scope of scopes) {
      let foundInit: ts.Expression | undefined
      let foundBindingName: string | undefined // property name inside a destructured source
      const visit = (node: ts.Node): void => {
        if (foundInit !== undefined) return
        if (ts.isVariableDeclaration(node) && node.initializer) {
          if (ts.isIdentifier(node.name) && node.name.text === name) {
            foundInit = node.initializer
          } else if (ts.isObjectBindingPattern(node.name)) {
            for (const el of node.name.elements) {
              if (ts.isIdentifier(el.name) && el.name.text === name) {
                foundInit = node.initializer
                foundBindingName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : name
                break
              }
            }
          }
        }
        if (foundInit === undefined) ts.forEachChild(node, visit)
      }
      visit(scope)
      if (foundInit !== undefined) {
        if (isMutatedIn(scope, name)) return undefined
        const resolved = resolveValue(foundInit, enclosingFn, sourceFile, depth + 1, allFiles)
        if (!foundBindingName) return resolved
        if (resolved) {
          const prop = resolved.node.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === foundBindingName)
          if (prop && ts.isPropertyAssignment(prop)) return resolveValue(prop.initializer, enclosingFn, sourceFile, depth + 1, allFiles)
        }
        return undefined
      }
    }
    return undefined
  }

  if (ts.isPropertyAccessExpression(e)) {
    const objResolved = resolveValue(e.expression, enclosingFn, sourceFile, depth + 1, allFiles)
    if (objResolved) {
      const prop = objResolved.node.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === e.name.text)
      if (prop && ts.isPropertyAssignment(prop)) return resolveValue(prop.initializer, enclosingFn, sourceFile, depth + 1, allFiles)
    }
    return undefined
  }

  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const fnDecl = findTopLevelFunctionDecl(sourceFile, e.expression.text, allFiles)
    if (fnDecl) {
      const ret = singleReturnExpr(fnDecl)
      const declFile = allFiles.find((f) => f.statements.includes(fnDecl)) ?? sourceFile
      if (ret) return resolveValue(ret, fnDecl, declFile, depth + 1, allFiles)
    }
    return undefined
  }

  return undefined
}

/** The default-deny resolver has exactly four structural pass-through exemptions. Two are the
 *  command classes named by the R3 ruling; their callers are separately censused. The factory's
 *  two constructor arms are also separately identified so its bare `input` parameter is never a
 *  generic "all parameters are safe" escape hatch. Source + declaration identity are both
 *  required: the EvilCommand fixture below proves that reusing the field name `input` is RED. */
function classifyKnownPassThrough(
  node: ts.Node,
  argExpr: ts.Expression,
  sourceFile: ts.SourceFile,
): string | undefined {
  const file = sourceFile.fileName.replace(/\\/g, '/')
  const arg = unwrap(argExpr)

  if (
    file.endsWith('/doc/commands.ts') &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'dag' &&
    node.expression.name.text === 'insertNode' &&
    ts.isPropertyAccessExpression(arg) && arg.expression.kind === ts.SyntaxKind.ThisKeyword && arg.name.text === 'input'
  ) {
    const method = findEnclosingFunction(node)
    const owner = findEnclosingClass(node)
    const ownerName = owner?.name?.text
    if (
      method && ts.isMethodDeclaration(method) && ts.isIdentifier(method.name) && method.name.text === 'do' &&
      (ownerName === 'InsertNodeCommand' || ownerName === 'InsertAtMarkerCommand')
    ) {
      return `${ownerName}.do`
    }
  }

  if (
    file.endsWith('/components/model3d/dialogs/createFeatureCommand.ts') &&
    ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
    (node.expression.text === 'InsertNodeCommand' || node.expression.text === 'InsertAtMarkerCommand') &&
    ts.isIdentifier(arg) && arg.text === 'input'
  ) {
    const fn = findEnclosingFunction(node)
    if (fn && ts.isFunctionDeclaration(fn) && fn.name?.text === 'createFeatureCommand') {
      return `createFeatureCommand->${node.expression.text}`
    }
  }

  return undefined
}

/** Resolve an expression to a literal string, following same-scope const-identifier indirection --
 *  handles both false-negative shapes the audit named: `kind: ('import')` (parens) and
 *  `const importKind = 'import'; ... kind: importKind` (alias). */
function resolveStringLiteral(
  expr: ts.Expression,
  enclosingFn: ts.FunctionLikeDeclaration | undefined,
  sourceFile: ts.SourceFile,
  depth: number,
): string | undefined {
  if (depth > 8) return undefined
  const e = unwrap(expr)
  if (ts.isStringLiteralLike(e)) return e.text
  if (ts.isIdentifier(e)) {
    const name = e.text
    const scopes: ts.Node[] = enclosingFn ? [enclosingFn, sourceFile] : [sourceFile]
    for (const scope of scopes) {
      let foundInit: ts.Expression | undefined
      const visit = (node: ts.Node): void => {
        if (foundInit !== undefined) return
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
          foundInit = node.initializer
        }
        if (foundInit === undefined) ts.forEachChild(node, visit)
      }
      visit(scope)
      if (foundInit !== undefined) return resolveStringLiteral(foundInit, enclosingFn, sourceFile, depth + 1)
    }
  }
  return undefined
}

function resolveKindLiteral(obj: ts.ObjectLiteralExpression, enclosingFn: ts.FunctionLikeDeclaration | undefined, sourceFile: ts.SourceFile): string | undefined {
  const kindProp = obj.properties.find(
    (p) => (ts.isPropertyAssignment(p) && propName(p) === 'kind') || (ts.isShorthandPropertyAssignment(p) && p.name.text === 'kind'),
  )
  if (!kindProp) return undefined
  const expr = ts.isPropertyAssignment(kindProp) ? kindProp.initializer : (kindProp as ts.ShorthandPropertyAssignment).name
  return resolveStringLiteral(expr, enclosingFn, sourceFile, 0)
}

function payloadHasName(obj: ts.ObjectLiteralExpression, allFiles: readonly ts.SourceFile[]): boolean {
  const payloadProp = obj.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === 'payload')
  if (!payloadProp || !ts.isPropertyAssignment(payloadProp)) return false
  // WO-2796 shares the per-solid payload helper across both import routes.
  // Resolve its returned object, retaining default-deny for unknown payloads.
  const payload = resolveValue(payloadProp.initializer, findEnclosingFunction(obj), obj.getSourceFile(), 0, allFiles)?.node
  if (!payload) return false
  return payload.properties.some((pp) => propName(pp) === 'name' || (ts.isShorthandPropertyAssignment(pp) && pp.name.text === 'name'))
}

interface CensusHit {
  file: string
  line: number
  ctor: string
  kind: string
  hasName: boolean
}

interface UnclassifiedSite {
  file: string
  line: number
  ctor: string
  text: string
}

interface CensusResult {
  hits: CensusHit[]
  unclassified: UnclassifiedSite[]
}

/** Walks one already-parsed file for the four DagNodeInput-constructor call shapes and classifies
 *  each one's resolved `kind`. `pathLabel` is the census-relative path used in results (so synthetic
 *  in-memory sources used by the mutation-proof tests below can report a readable fake path). */
function censusFile(sf: ts.SourceFile, pathLabel: string, allFiles: readonly ts.SourceFile[]): CensusResult {
  const hits: CensusHit[] = []
  const unclassified: UnclassifiedSite[] = []
  const visit = (node: ts.Node): void => {
    let argExpr: ts.Expression | undefined
    let ctor: string | undefined
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && callee.text === 'createFeatureCommand') { argExpr = node.arguments[1]; ctor = 'createFeatureCommand' }
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'insertNode') { argExpr = node.arguments[0]; ctor = 'insertNode' }
    } else if (ts.isNewExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && (callee.text === 'InsertNodeCommand' || callee.text === 'InsertAtMarkerCommand')) {
        argExpr = node.arguments?.[0]
        ctor = callee.text
      }
    }
    if (argExpr && ctor) {
      const enclosingFn = findEnclosingFunction(node)
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart())
      if (classifyKnownPassThrough(node, argExpr, sf) === undefined) {
        const resolved = resolveValue(argExpr, enclosingFn, sf, 0, allFiles)
        if (!resolved) {
          unclassified.push({ file: pathLabel, line: line + 1, ctor, text: argExpr.getText().slice(0, 80).replace(/\s+/g, ' ') })
        } else {
          const kind = resolveKindLiteral(resolved.node, enclosingFn, sf)
          if (kind === undefined) {
            unclassified.push({ file: pathLabel, line: line + 1, ctor, text: resolved.node.getText().slice(0, 150).replace(/\s+/g, ' ') })
          } else {
            hits.push({ file: pathLabel, line: line + 1, ctor, kind, hasName: payloadHasName(resolved.node, allFiles) })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { hits, unclassified }
}

function parseFile(file: string): ts.SourceFile {
  const text = readFileSync(file, 'utf8')
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

/** The ONE production site the resolver cannot reduce to a literal today, with a written proof of
 *  what it resolves to (verified by hand, re-verify on any change to this data flow):
 *
 *  SolidsWorkbenchPage.tsx:3421 `createFeatureCommand(dag, datumInput)` -- `datumInput` is
 *  `entry.datumInput` (PackageSketchEntry.datumInput, declared at SolidsWorkbenchPage.tsx:404),
 *  which is populated exactly once, at SolidsWorkbenchPage.tsx:3818 (`datumInput: freshDatumInput`),
 *  where `freshDatumInput = built.input` (line 3749) and
 *  `built = buildFacePlaneDatumNodeInput(...)` (sketch3d/datumPlane.ts) -- a literal
 *  `kind: 'datum'` return, never 'import'. The resolver traces `built.input` itself (same-file
 *  local + cross-file helper-return resolution); it cannot follow `entry.datumInput` because
 *  `entry` arrives through a PackageSketchEntry passed across a click-handler boundary this
 *  resolver does not chase (real interprocedural dataflow, not constant-literal resolution). A
 *  NEW unresolved site is NOT this one -- it fails the test below and must be proven safe here
 *  (or fixed to carry `name:`) before being added.
 */
const KNOWN_UNCLASSIFIABLE_SITES: UnclassifiedSite[] = [
  { file: 'components/model3d/SolidsWorkbenchPage.tsx', line: 3421, ctor: 'createFeatureCommand', text: 'datumInput' },
  // createFeatureCommand.ts:50 `createFeatureCommand(dag, input)`, inside createDirectEditFeatureCommand
  // -- `input` is that function's own bare DagNodeInput PARAMETER, never a const/destructure the
  // resolver's identifier-lookup can trace (it only walks ts.VariableDeclaration/binding patterns,
  // deliberately not parameter declarations -- unresolvable by design, same shape as the R3
  // "element-access hidden behind parameter indirection" mutation proof below). Proven never an
  // 'import'-kind construction NOT by tracing what it resolves to, but by a guard clause immediately
  // above it in the SAME function (createFeatureCommand.ts:47-49):
  // `if (input.kind !== 'feature' || !isDirectEditBodyOpType(input.payload?.opType)) throw ...`
  // -- every call reaching line 50 already had input.kind === 'feature' enforced at runtime, so
  // kind: 'import' is impossible here regardless of which caller supplied `input`
  // (isDirectEditBodyOpType, bodyLineage.ts:55, narrows payload.opType against
  // WORKBENCH_BODY_OP_DEFINITIONS' direct-edit subset, which has no 'import' entry either). A NEW
  // unresolved site is NOT this one -- it fails the test below and must be proven safe here (or made
  // statically traceable) before being added.
  { file: 'components/model3d/dialogs/createFeatureCommand.ts', line: 50, ctor: 'createFeatureCommand', text: 'input' },
  // SolidsWorkbenchPage.tsx:14293 `createFeatureCommand(dag, source.supportInput)` (applyOffsetPlane,
  // the face-supported Offset Plane create branch) -- `source` is a dialog-state OffsetPlaneSource
  // (setDialog at SolidsWorkbenchPage.tsx:14267 -> dialog.sources at 14277), and `supportInput`
  // (optional field, declared SolidsWorkbenchPage.tsx:1028) is populated at EXACTLY ONE site,
  // SolidsWorkbenchPage.tsx:14253: a spread of `built.input` overriding only payload.lastGoodFrame,
  // where `built = buildFacePlaneDatumNodeInput(...)` (line 14238; sketch3d/datumPlane.ts:174) --
  // a literal `kind: 'datum'` return (datumPlane.ts:188), never 'import'. The spread cannot change
  // `kind` (it overrides only payload.lastGoodFrame). The resolver cannot follow it because the
  // value crosses the openOffsetPlaneCreate -> setDialog -> applyOffsetPlane React-state boundary
  // (real interprocedural dataflow, same shape as the entry.datumInput exemption above). A NEW
  // unresolved site is NOT this one -- it fails the test below and must be proven safe here (or
  // made statically traceable) before being added.
  { file: 'components/model3d/SolidsWorkbenchPage.tsx', line: 14293, ctor: 'createFeatureCommand', text: 'source.supportInput' },
  // lib/agent/model/sketchCreate.ts:199 `createFeatureCommand(dag, plane.datumInput)` (WO-3013, the
  // assistant's sketch-on-face create) -- `plane` is a ResolvedPlane returned by resolvePlane or
  // resolveFace in the same file. resolvePlane never sets datumInput; resolveFace sets it at EXACTLY
  // ONE site (sketchCreate.ts:277, `datumInput: built.input`) where
  // `built = buildFacePlaneDatumNodeInput(...)` (sketch3d/datumPlane.ts:244) -- a literal
  // `kind: 'datum'` return (datumPlane.ts:258), never 'import'. The resolver cannot follow it because
  // the value crosses a function return into an optional interface field (the same interprocedural
  // shape as the entry.datumInput and source.supportInput exemptions above). A NEW unresolved site is
  // NOT this one -- it fails the test below and must be proven safe here (or made statically
  // traceable) before being added.
  { file: 'lib/agent/model/sketchCreate.ts', line: 199, ctor: 'createFeatureCommand', text: 'plane.datumInput' },
]

function unclassifiedFailureMessage(sites: readonly UnclassifiedSite[]): string {
  return `unclassified DagNodeInput construction(s) -- default deny: classify each by ruling with proving coverage, or make its name-bearing payload statically traceable:\n${sites
    .map((site) => `  ${site.file}:${site.line} [${site.ctor}] ${site.text}`)
    .join('\n')}`
}

describe('WO CAM-13B-R1: derived AST census of every production FeatureDag node-input constructor', () => {
  const files = listProductionSourceFiles(SRC_ROOT)
  const sourceFiles = files.map(parseFile)
  const pathLabels = files.map((f) => relative(SRC_ROOT, f).replace(/\\/g, '/'))

  let allHits: CensusHit[] = []
  let allUnclassified: UnclassifiedSite[] = []
  sourceFiles.forEach((sf, i) => {
    const { hits, unclassified } = censusFile(sf, pathLabels[i], sourceFiles)
    allHits.push(...hits)
    allUnclassified.push(...unclassified)
  })

  it('sanity: the scan actually walked production source (a zero file count means the path broke)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('every unresolved node-input construction site is an already-verified KNOWN_UNCLASSIFIABLE_SITES entry -- a NEW one fails HERE, by name, not silently', () => {
    const unlisted = allUnclassified.filter(
      (u) => !KNOWN_UNCLASSIFIABLE_SITES.some((k) => k.file === u.file && k.ctor === u.ctor && k.text === u.text),
    )
    expect(unlisted, unclassifiedFailureMessage(unlisted)).toEqual([])
    // The allowlist itself must not rot into a hand-list of stale/removed sites either.
    const stale = KNOWN_UNCLASSIFIABLE_SITES.filter(
      (k) => !allUnclassified.some((u) => u.file === k.file && u.ctor === k.ctor && u.text === k.text),
    )
    expect(stale).toEqual([])
  })

  it('exactly two production entry points construct a FeatureDag "import"-kind node today', () => {
    // A new site changes this on purpose -- update it ONLY alongside verifying the new site's
    // payload also carries `name:` (the next assertion), never bump it to silence a failure
    // without reading what changed.
    //
    // Site 1: SolidsWorkbenchPage.tsx (handleImportStepFileChange) -- the interactive workbench
    //   STEP import (createFeatureCommand -> import node).
    // Site 2 (GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1): doc/promoteImportedStepModel.ts
    //   (buildImportedStepModelArchive) -- the HEADLESS seed builder for the CAM "Edit as model"
    //   wrap. It mints the SAME create-shape import node (dag.insertNode, kind 'import', payload
    //   { fileName, cacheKey, name }) so a wrapped STEP replays byte-identically to a hand-imported
    //   one; its payload carries `name:` (asserted below), so the wrapped tree row never shows the
    //   raw node id. Verified against the interactive path by importedStepModelArchive.geoUnifyStage4.
    const importHits = allHits.filter((h) => h.kind === 'import')
    expect([...new Set(importHits.map((h) => h.file))].sort()).toEqual([
      'components/model3d/SolidsWorkbenchPage.tsx',
      'doc/promoteImportedStepModel.ts',
    ])
  })

  it('every discovered "import"-kind node construction site plumbs a `name:` field into its payload', () => {
    const missingName = allHits.filter((h) => h.kind === 'import' && !h.hasName)
    expect(missingName).toEqual([])
  })
})

describe('WO CAM-13B-R1: census resolver mutation proofs (the exact false-negative shapes the audit named)', () => {
  function censusSynthetic(source: string): CensusResult {
    const sf = ts.createSourceFile('synthetic.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    return censusFile(sf, 'synthetic.ts', [sf])
  }

  it('CAN-FAIL PROOF: a parenthesized kind literal `kind: (\'import\')` is DETECTED, not invisible (the audit\'s exact false negative)', () => {
    const { hits } = censusSynthetic(`
      function f(dag, history) {
        history.execute(createFeatureCommand(dag, { id, kind: ('import'), payload: { fileName, cacheKey } }))
      }
    `)
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('import')
    expect(hits[0].hasName).toBe(false) // this mutant also proves the missing-name check still fires
  })

  it('CAN-FAIL PROOF: a const-aliased kind `kind: importKind` is DETECTED, not invisible (the audit\'s other named shape)', () => {
    const { hits } = censusSynthetic(`
      const importKind = 'import'
      function f(dag, history) {
        history.execute(createFeatureCommand(dag, { id, kind: importKind, payload: { fileName, cacheKey, name: displayName } }))
      }
    `)
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('import')
    expect(hits[0].hasName).toBe(true)
  })

  it('CATCH-ALL PROOF: a node-input construction whose kind cannot be statically resolved is flagged UNCLASSIFIED, never silently skipped', () => {
    const { hits, unclassified } = censusSynthetic(`
      function f(dag, history, runtimeKind) {
        history.execute(createFeatureCommand(dag, { id, kind: runtimeKind(), payload: {} }))
      }
    `)
    expect(hits).toHaveLength(0)
    expect(unclassified).toHaveLength(1)
    expect(unclassified[0].ctor).toBe('createFeatureCommand')
  })

  it('regression: a plain unparenthesized literal `kind: \'import\'` still resolves (today\'s real shape)', () => {
    const { hits } = censusSynthetic(`
      function f(dag, history) {
        history.execute(createFeatureCommand(dag, { id, kind: 'import', payload: { name: 'x' } }))
      }
    `)
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('import')
    expect(hits[0].hasName).toBe(true)
  })

  it('R3 CATCH-ALL: the auditor exact class-field import evasion is RED by file, line, and form', () => {
    const { hits, unclassified } = censusSynthetic(`
      class DeferredImport {
        nodeInput = { id: 'IMP2', kind: 'import', payload: {} }
        do(dag) { return createFeatureCommand(dag, this.nodeInput) }
      }
    `)
    expect(hits).toHaveLength(0)
    expect(unclassified).toEqual([
      { file: 'synthetic.ts', line: 4, ctor: 'createFeatureCommand', text: 'this.nodeInput' },
    ])
  })

  it('R3 CATCH-ALL: element-access hidden behind parameter indirection is RED by file, line, and form', () => {
    const { hits, unclassified } = censusSynthetic(`
      const inputs = [{ id: 'IMP3', kind: 'import', payload: {} }]
      function forward(dag, input) { return createFeatureCommand(dag, input) }
      forward(dag, inputs[0])
    `)
    expect(hits).toHaveLength(0)
    expect(unclassified).toEqual([
      { file: 'synthetic.ts', line: 3, ctor: 'createFeatureCommand', text: 'input' },
    ])
  })

  it('R3 CATCH-ALL: an unrelated class reusing the real field name input is RED, not exempt by string', () => {
    const { hits, unclassified } = censusSynthetic(`
      class EvilCommand {
        input = { id: 'IMP4', kind: 'import', payload: {} }
        do(dag) { dag.insertNode(this.input) }
      }
    `)
    expect(hits).toHaveLength(0)
    expect(unclassified).toEqual([
      { file: 'synthetic.ts', line: 4, ctor: 'insertNode', text: 'this.input' },
    ])
  })
})

// WO-2796 helper extraction must remain visible to the name-field census.
describe('WO-2805 import payload helper tracing', () => {
  it.each([
    ['alternate unnamed return', 'if (body.named) return { name: body.name }; return { fileName: body.fileName }'],
    ['conditional fallthrough', 'if (body.named) return { name: body.name }'],
    ['bare alternate return', 'if (body.named) return { name: body.name }; return'],
    ['multiple named returns', 'if (body.named) return { name: body.name }; return { name: "other" }'],
    ['reassigned payload', 'let p = { name: body.name }; p = { fileName: body.fileName }; return p'],
    ['deleted name', 'const p = { name: body.name, fileName: body.fileName }; delete p.name; return p'],
    ['Object.assign over the payload', 'const p = { name: body.name }; Object.assign(p, { name: undefined }); return p'],
  ])('default-denies an uncertain payload helper: %s', (_label, body) => {
    const sf = ts.createSourceFile('synthetic.ts', `
      function sharedPayload(body) { ${body} }
      dag.insertNode({ id: 'IMP1', kind: 'import', payload: sharedPayload({ named: false, fileName: 'part.step' }) })
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const result = censusFile(sf, 'synthetic.ts', [sf])
    expect(result.unclassified).toEqual([]) // node kind is known; its name proof is missing
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].hasName).toBe(false)
  })

  it('flags a helper with alternate node-input returns as unclassified', () => {
    const sf = ts.createSourceFile('synthetic.ts', `
      function sharedInput(named) {
        if (named) return { id: 'IMP1', kind: 'import', payload: { name: 'part' } }
        return { id: 'IMP2', kind: 'import', payload: {} }
      }
      dag.insertNode(sharedInput(false))
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const result = censusFile(sf, 'synthetic.ts', [sf])
    expect(result.hits).toEqual([])
    expect(result.unclassified).toEqual([
      { file: 'synthetic.ts', line: 6, ctor: 'insertNode', text: 'sharedInput(false)' },
    ])
  })

  it('ignores nested function returns when proving one unconditional payload return', () => {
    const sf = ts.createSourceFile('synthetic.ts', `
      function sharedPayload(body) {
        function nested() { return {} }
        return { name: body.name }
      }
      dag.insertNode({ id: 'IMP1', kind: 'import', payload: sharedPayload(body) })
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const result = censusFile(sf, 'synthetic.ts', [sf])
    expect(result.unclassified).toEqual([])
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].hasName).toBe(true)
  })

  it.each([true, false])('detects name presence in a shared helper (hasName=%s)', (hasName) => {
    const sf = ts.createSourceFile('synthetic.ts', `
      function sharedPayload(body) { return { fileName: body.fileName${hasName ? ', name: body.name' : ''} } }
      dag.insertNode({ id: 'IMP1', kind: 'import', payload: sharedPayload(body) })
    `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const result = censusFile(sf, 'synthetic.ts', [sf])
    expect(result.unclassified).toEqual([])
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].hasName).toBe(hasName)
  })
})
