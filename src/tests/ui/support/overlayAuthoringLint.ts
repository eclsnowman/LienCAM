// ADVISORY LAYER (DECISIONS 2026-07-17, "UI-70 guard: SPLIT THE SAGA"): this
// source-syntax lint is EARLY WARNING, not the verdict-bearing gate. Two
// audited polarities (R4 blacklist, R5 allowlist) each lost to a constructed
// bypass (dynamic iframe; document.write) - source-syntax enforcement over a
// dynamic authoring language is structurally incomplete. Fail-closed
// enforcement lives at the DOM ATTACH choke point (WO UI-78). Keep this lint
// green and extend it freely; a bypass of THIS file is a finding for UI-78,
// not a blocker here.
// WO UI-70-R5 -- the AUTHORING LINT: a POSITIVE, FAIL-CLOSED recognizer.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE WAS REWRITTEN: six rounds, six bypasses, ONE root cause
// ---------------------------------------------------------------------------
// The runtime census (overlayRuntimeCensus.ts) is the better of the two ideas in
// this WO and it is NOT what failed. What failed is the space it was asked to
// cover, and then -- in R4 -- what failed is THIS FILE, in exactly the same way:
//
//   R0  CSS text            -> beaten by reusing a dispositioned class
//   R1  AST render walk     -> beaten by a locally declared styled wrapper
//   R2  live DOM, one tree  -> beaten by a body portal, then by SHADOW DOM
//   R3  live composed DOM   -> beaten by a same-origin IFRAME (a second Document)
//   R4  an authoring LINT   -> beaten by `const tag = 'iframe'` + createElement(tag)
//
// R4 inverted the RUNTIME arms race (bound the authoring space instead of
// enumerating what it paints) and then lost the SOURCE arms race, because the
// lint it shipped was still an enumerator. It recognised THE BAD:
//
//   "The authoring check is an exact-syntax blacklist, not a fail-closed bound
//    on the authoring space. It recognizes iframe creation only when
//    createElement/createElementNS receives a literal, JSX only when the tag
//    text is exactly iframe ... Constant aliases and computed/bound access
//    therefore pass. Because the runtime census is already proven not to enter
//    iframe Documents, a dynamically named iframe creates the forbidden third
//    state and L2's core acceptance claim is false."
//    -- coordination/reports/UI-70-R4.audit.json (BLOCKER, verbatim)
//
// Enumerating bad SPELLINGS is the same losing move as enumerating bad PAINTING,
// one level down. `'iframe'` has infinitely many spellings; so does every other
// token. A blacklist of spellings loses to spelling number N+1, forever.
//
// ---------------------------------------------------------------------------
// THE INVERSION THIS FILE IMPLEMENTS: RESOLVE-OR-REFUSE
// ---------------------------------------------------------------------------
// The verdict path below contains NO list of forbidden spellings. It is two
// stages, and the first is the one that matters:
//
//   STAGE 1 (RESOLVE). At every site where one of the four bounded routes could
//     be reached, the lint must statically RESOLVE the thing that decides which
//     route it is -- the element's tag, the member's name, the receiver's
//     origin, the markup's text. Resolution is a total function with two
//     outcomes and no third: a value, or `null`.
//
//   STAGE 2 (CLASSIFY). Only a RESOLVED value is classified, and it is
//     classified as a FACT, not as syntax. `resolveString()` folds literals,
//     concatenations, templates and same-file constant aliases, so
//     `const tag = 'if' + 'rame'` and `document.createElement(tag)` arrive at
//     stage 2 as the fact "tag === 'iframe'", which is not a spelling and
//     cannot be respelled.
//
// A construct that does NOT resolve never reaches stage 2. It REFUSES, by name,
// as route `UNRESOLVED`. That is the whole design: you cannot beat this by being
// cleverer about how you spell a tag, because cleverness is precisely what makes
// resolution fail, and failed resolution is a refusal. The R4 defect class --
// recognise-the-bad -- is structurally impossible here: delete every route name
// from this file and it refuses MORE, not less.
//
// THE FIFTH ROUTE IS THE POINT. `RefusedRoute` has five values, not four. The
// four named routes are the ruling's; `UNRESOLVED` is the fail-closed bucket
// made visible in the type system, so a reader can see -- from the type alone --
// that "we could not tell" is a REFUSAL and not a gap.
//
// ---------------------------------------------------------------------------
// THE BOUND IS BY ROUTE, NOT BY REGION (preflight amendment AM4, verbatim)
// ---------------------------------------------------------------------------
// "The boundary this lint enforces is NOT spatial (there is no static way to
//  prove a node lands 'inside the viewport region' from source syntax alone).
//  The bound is BY ROUTE, applied to the WHOLE product tree: the four named APIs
//  are refused everywhere in src/, which is a strict superset of 'refused inside
//  the viewport region' and therefore satisfies the ruling without requiring an
//  undecidable region check."
//
// ---------------------------------------------------------------------------
// THE SCOPE OF THE REFUSE-ON-UNRESOLVED DUTY (amendment AM1, verbatim)
// ---------------------------------------------------------------------------
// "The positive recognizer's refuse-on-unresolved duty applies only to
//  constructs that touch one of the four named APIs (attachShadow,
//  customElements.define/extends-HTMLElement, iframe creation in any form,
//  document.body/documentElement/head mutation in any form) or an alias/
//  computed/bound reference to one of them. Ordinary literal-tag DOM authoring
//  (canvas, div, input, style, svg via createElementNS) outside those four APIs
//  is unaffected and needs no sanction."
//
// This is why `document.createElement('canvas')` passes while
// `document.createElement(tag)` refuses. The first RESOLVED, and the resolved
// fact ('canvas') is not one of the four routes. The second did not resolve.
// Neither outcome consulted a list of bad names.
//
// ---------------------------------------------------------------------------
// WHY THE AST, NOT A GREP
// ---------------------------------------------------------------------------
// This file's own header says "attachShadow" and "iframe" repeatedly; so does
// the census's. A text scan flags its own prose and then gets weakened until it
// stops. The walk below is a TypeScript syntax-tree walk, so a comment or a
// string is not a call, and the lint never has to be taught to ignore itself.
import ts from 'typescript'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// 1. The routes
// ---------------------------------------------------------------------------

/** The four authoring classes the DECISIONS ruling bounds by law, plus the
 *  fail-closed bucket. Each of the four traces to a real audit artifact from
 *  this WO's own history -- none is hypothetical. */
export type RefusedRoute =
  /** A ShadowRoot is an authoring space the census can only reach by
   *  instrumenting attachShadow before any mount runs (R2 audit BLOCKER: an open
   *  root's div.auditor-shadow-hud read position:fixed while the census returned
   *  zero surfaces). Closed roots are unreachable BY DESIGN. */
  | 'SHADOW-ROOT'
  /** A second Document. R3's audit killed the census with one: a same-origin
   *  iframe whose contentDocument held a position:fixed HUD. `document.body`'s
   *  composed tree is not that document, and no walk of THIS document ever
   *  reaches it. */
  | 'IFRAME'
  /** A custom element builds its DOM imperatively, carries no React fiber, and
   *  is the natural host for a shadow root. The census reports one BY NAME as
   *  UNINSPECTABLE rather than walking past it -- but the authoring space is
   *  smaller if it is not there at all. */
  | 'WEB-COMPONENT'
  /** Authoring straight into document.body: React's createPortal, or an
   *  imperative append. The census DOES see these today (A4 membership is
   *  positioning over the whole document, and R3 committed the portal RED/GREEN
   *  proof) -- they are refused anyway, because the ruling bounds the space by
   *  law rather than by what the current walk happens to reach. */
  | 'BODY-PORTAL'
  /** THE FAIL-CLOSED BUCKET, and the entire answer to the R4 BLOCKER. A site
   *  that touches one of the four routes' decision points but whose deciding
   *  value did not statically resolve is refused HERE -- not passed, not guessed
   *  at, not matched against a list of spellings. R4's killer
   *  (`const tag = 'iframe'; document.createElement(tag)`) does resolve, and is
   *  refused as IFRAME. `document.createElement(computeIt())` does NOT resolve,
   *  and is refused as UNRESOLVED. There is no input that lands anywhere else. */
  | 'UNRESOLVED'

/** WHY the site refused, in the vocabulary of the resolve-or-refuse design. The
 *  code is the finding's own explanation of which stage rejected it: a
 *  RESOLVED-ROUTE refusal is a statement about a FACT the lint proved, and every
 *  other code is a statement that the lint could not prove anything and
 *  therefore refused. An auditor reading a report can separate the two without
 *  reading the source. */
export type RefusalCode =
  /** Stage 2. The deciding value RESOLVED, and the fact it resolved to is one of
   *  the four bounded routes. */
  | 'RESOLVED-ROUTE'
  /** Stage 1, at a tag position (amendment AM5a). createElement/createElementNS
   *  received a non-literal tag, a JSX tag identifier did not resolve to a
   *  string or to a component, or the createElement function itself was aliased
   *  away from its call site so no tag is visible at all. */
  | 'UNRESOLVED-TAG'
  /** Stage 1, at an append-family receiver (amendment AM5c). The receiver has no
   *  provable non-document-root origin in the same file. */
  | 'UNRESOLVED-RECEIVER'
  /** Stage 1, at a callee (amendment AM5c). The call goes through a computed
   *  member whose name did not resolve, so which method is being invoked is
   *  unknowable -- attachShadow included. */
  | 'UNRESOLVED-CALLEE'
  /** Stage 1, at a markup string (amendment AM2). An innerHTML/outerHTML
   *  assignment or an insertAdjacentHTML() call whose markup did not resolve to
   *  a string, so what it parses into is unknowable -- `<iframe>` included. */
  | 'UNRESOLVED-MARKUP'

export interface AuthoringViolation {
  /** `relative/file.tsx:enclosingName > snippet` -- deliberately the same shape
   *  as the census's authoring-site keys, and deliberately NOT line-anchored: a
   *  sanction that drifts when an unrelated import is added above it is a
   *  sanction nobody maintains. */
  key: string
  route: RefusedRoute
  /** Which stage refused, and why. See RefusalCode. */
  code: RefusalCode
  file: string
  line: number
  /** The exact syntax that refuses, so the message names the defect and not a
   *  category. */
  snippet: string
  reason: string
}

// ---------------------------------------------------------------------------
// 2. STAGE 1 -- resolution. The only thing standing between a construct and a
//    refusal.
// ---------------------------------------------------------------------------

/** WHAT a name was bound BY. The kind is what lets resolution stay honest about
 *  its own limits: `IMPORT` and `DECLARATION` are unreadable-but-known,
 *  `PARAMETER` and `DESTRUCTURED` are unreadable-and-unknown, and conflating the
 *  two groups is how a resolver accidentally fails OPEN. */
export type BindingKind =
  /** `const x = <expr>` -- the only kind with a readable initializer. */
  | 'VALUE'
  /** `function f()` / `class C {}` -- no initializer, but provably a callable. */
  | 'DECLARATION'
  /** `import { X } from '...'` -- the value lives in another file. */
  | 'IMPORT'
  /** `function f(x)` / `(x) => ...` -- the value comes from the caller. */
  | 'PARAMETER'
  /** `const { icon: Icon } = tool` -- the value comes from an object this walk
   *  cannot follow. */
  | 'DESTRUCTURED'
  /** Declared twice in one scope, or assigned again after declaration. A name
   *  that can hold two values has not resolved. This is why
   *  `let doc: Port | null = null; doc = port` never resolves: it is written
   *  twice, so every read of it refuses. */
  | 'AMBIGUOUS'

interface Binding {
  kind: BindingKind
  init: ts.Expression | null
  /** For DESTRUCTURED only: the element that introduced the name, kept so the
   *  resolver can follow the value back to the object it was pulled out of.
   *  Without this a destructured name is a dead end, and a dead end refuses --
   *  which is safe, but wrong often enough to matter (this tree destructures an
   *  icon COMPONENT out of a map in twelve places). */
  element?: ts.BindingElement
  /** For PARAMETER only: the declaration, kept for the same reason as
   *  `element` -- `SECTIONS.map((tool) => { const Icon = tool.icon; ... })`
   *  is resolvable, and a resolver that stops at "it's a parameter" would
   *  refuse four honest icon rails. */
  param?: ts.ParameterDeclaration
}

/** LEXICAL scope resolution -- per scope, not per file.
 *
 *  This is a real static resolver, not an index: `const overlay =
 *  document.createElement('div')` appears TWICE in CNCViewport.ts, in two
 *  different methods, and a file-wide index would call both AMBIGUOUS and refuse
 *  six innocent appends. A name is looked up from its USE SITE outward, so each
 *  `overlay` resolves to the declaration that actually governs it. Being MORE
 *  precise here only ever moves sites from refused to accepted with a proof --
 *  never the other way -- because every accept requires a resolution and every
 *  non-resolution still refuses. */
interface FileScope {
  /** scope node -> names declared directly in it. */
  table: Map<ts.Node, Map<string, Binding>>
}

/** The nodes that introduce a scope. Deliberately generous: an extra scope level
 *  can only make a lookup MISS and refuse, never make it find the wrong thing. */
function isScopeNode(n: ts.Node): boolean {
  return (
    ts.isSourceFile(n) ||
    ts.isBlock(n) ||
    ts.isModuleBlock(n) ||
    ts.isCaseBlock(n) ||
    ts.isForStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isClassDeclaration(n) ||
    ts.isClassExpression(n)
  )
}

function enclosingScope(n: ts.Node): ts.Node {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (isScopeNode(p)) return p
  return n.getSourceFile()
}

function buildFileScope(sf: ts.SourceFile): FileScope {
  const table = new Map<ts.Node, Map<string, Binding>>()
  const declare = (scope: ts.Node, name: string, b: Binding): void => {
    let m = table.get(scope)
    if (!m) { m = new Map(); table.set(scope, m) }
    // Second sighting of a name IN THE SAME SCOPE = ambiguous = does not
    // resolve. Fail closed rather than picking one and hoping.
    if (m.has(name)) m.set(name, { kind: 'AMBIGUOUS', init: null })
    else m.set(name, b)
  }
  /** Every name a binding pattern introduces, all DESTRUCTURED: what an element
   *  of a mapped array holds is not readable from this file's syntax. */
  const declarePattern = (scope: ts.Node, name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) return
    const walk = (el: ts.BindingElement): void => {
      if (ts.isIdentifier(el.name)) declare(scope, el.name.text, { kind: 'DESTRUCTURED', init: null, element: el })
      else for (const inner of el.name.elements) if (ts.isBindingElement(inner)) walk(inner)
    }
    for (const el of name.elements) if (ts.isBindingElement(el)) walk(el)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      const scope = enclosingScope(n)
      if (ts.isIdentifier(n.name)) declare(scope, n.name.text, { kind: 'VALUE', init: n.initializer ?? null })
      else declarePattern(scope, n.name)
    }
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) {
      declare(enclosingScope(n), n.name.text, { kind: 'DECLARATION', init: null })
    }
    if (ts.isParameter(n)) {
      const owner = enclosingScope(n.name)
      if (ts.isIdentifier(n.name)) declare(owner, n.name.text, { kind: 'PARAMETER', init: null, param: n })
      else declarePattern(owner, n.name)
    }
    if (ts.isImportSpecifier(n) || ts.isNamespaceImport(n) || (ts.isImportClause(n) && n.name)) {
      const nm = ts.isImportClause(n) ? n.name : (n as ts.ImportSpecifier | ts.NamespaceImport).name
      if (nm && ts.isIdentifier(nm)) declare(sf, nm.text, { kind: 'IMPORT', init: null })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  // SECOND PASS, and it must be second: an assignment destroys the binding it
  // targets, and a `doc = port` can appear ABOVE the `let doc` it invalidates.
  // Running this inside the declaration pass would let the assignment fire
  // before the declaration existed and leave the binding readable -- a
  // fail-OPEN, and the exact reason the passes are split rather than merged.
  // Invalidation is applied to EVERY scope that declares the name, because
  // which one the assignment targets is itself a lookup and the conservative
  // answer is "all of them".
  const invalidate = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      for (const m of table.values()) if (m.has(n.left.text)) m.set(n.left.text, { kind: 'AMBIGUOUS', init: null })
    }
    ts.forEachChild(n, invalidate)
  }
  invalidate(sf)
  return { table }
}

/** Look a name up from its USE SITE outward. Returns undefined when the name is
 *  not declared in this file at all -- a global. Callers must treat undefined as
 *  UNRESOLVED, never as absent. */
function lookup(scope: FileScope, name: string, from: ts.Node): Binding | undefined {
  for (let n: ts.Node | undefined = from; n; n = n.parent) {
    if (!isScopeNode(n)) continue
    const b = scope.table.get(n)?.get(name)
    if (b) return b
  }
  return undefined
}

const MAX_FOLD_DEPTH = 8

/** STAGE 1 FOR STRINGS. Folds a string-valued expression to its value, or
 *  returns null.
 *
 *  THIS FUNCTION IS THE ANSWER TO THE R4 BLOCKER, so it is worth being precise
 *  about what it is and is not. It is NOT a matcher and it never sees a route
 *  name: it folds literals, `+` concatenations, templates whose every hole
 *  folds, and same-file constant aliases, to depth 8. R4's killer probe --
 *  `const tag = 'iframe'; document.createElement(tag)` -- folds to the string
 *  `iframe`, and so does `'if' + 'rame'`, `` `${'if'}rame` ``, and an alias of
 *  an alias. Everything else returns null and its caller REFUSES.
 *
 *  The depth bound is not a limitation to apologise for: a chain deeper than 8
 *  returns null, which refuses. The fail-closed direction is the safe one, which
 *  is the entire reason resolution is written as fold-or-null rather than as
 *  match-or-pass. */
export function resolveString(expr: ts.Expression, scope: FileScope, depth = 0): string | null {
  if (depth > MAX_FOLD_DEPTH) return null
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isParenthesizedExpression(expr)) return resolveString(expr.expression, scope, depth + 1)
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
    return resolveString(expr.expression, scope, depth + 1)
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolveString(expr.left, scope, depth + 1)
    if (l === null) return null
    const r = resolveString(expr.right, scope, depth + 1)
    if (r === null) return null
    return l + r
  }
  if (ts.isTemplateExpression(expr)) {
    let out = expr.head.text
    for (const span of expr.templateSpans) {
      const v = resolveString(span.expression, scope, depth + 1)
      if (v === null) return null
      out += v + span.literal.text
    }
    return out
  }
  if (ts.isIdentifier(expr)) {
    const b = lookup(scope, expr.text, expr)
    // A global, a parameter, a destructured element, an import, an ambiguous
    // name: every one of them is "did not resolve", and every one refuses.
    // Only a VALUE binding has an initializer worth reading.
    if (!b || b.kind !== 'VALUE' || !b.init) return null
    return resolveString(b.init, scope, depth + 1)
  }
  return null
}

/** STAGE 1 FOR MEMBER NAMES. `x.foo` -> "foo"; `x['fo' + 'o']` -> "foo";
 *  `x[k]` where k does not fold -> null.
 *
 *  Amendment AM5b lives here: a computed member name is resolved by the SAME
 *  folder as a tag, so `frame['contentDoc' + 'ument']` is the fact
 *  "contentDocument" by the time anything classifies it. */
function resolveMemberName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  scope: FileScope,
): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return resolveString(node.argumentExpression, scope)
}

const ROOT_TEXT = /(^|\.)document\.(body|documentElement|head)$/

/** Is this expression, as written, one of the document roots? Matched on
 *  normalised text so `window . document . body` cannot slip through
 *  whitespace. */
function isRootShaped(expr: ts.Expression): boolean {
  return ROOT_TEXT.test(expr.getText().replace(/\s+/g, ''))
}

/** Constructors of a fresh, detached node. A value from one of these is provably
 *  NOT a document root: the DOM has no API that returns document.body from a
 *  create call. This is the ACCEPT side of receiver resolution, and it is the
 *  only accept side -- everything not provable here refuses. */
const FRESH_NODE_CALLS = new Set(['createElement', 'createElementNS', 'createDocumentFragment', 'createTextNode'])

export type ReceiverOrigin = 'DOCUMENT-ROOT' | 'FRESH-NODE' | 'UNRESOLVED'

/** STAGE 1 FOR RECEIVERS (amendment AM5c, and then some).
 *
 *  Returns DOCUMENT-ROOT when the receiver provably IS a root (directly, or via
 *  a same-file `const b = document.body` alias); FRESH-NODE when it provably is
 *  NOT (it came out of a create call, a `new`, an object/array literal, or a JSX
 *  expression); and UNRESOLVED for everything else -- parameters, fields,
 *  imports, reassigned names, call results.
 *
 *  AM5c requires UNRESOLVED-RECEIVER for "a bare identifier with NO provable
 *  non-document-root origin in the same file". This goes further and applies the
 *  same rule to property-access receivers (`this.container.appendChild(x)`),
 *  because `this.container` is a constructor parameter and `new CNCViewport(
 *  document.body)` is a body portal written in two files instead of one. AM5c is
 *  a floor, not a ceiling, and the sites this catches are sanctioned by name
 *  rather than waved through by a scoping technicality. */
export function receiverOrigin(expr: ts.Expression, scope: FileScope, depth = 0): ReceiverOrigin {
  if (depth > MAX_FOLD_DEPTH) return 'UNRESOLVED'
  if (isRootShaped(expr)) return 'DOCUMENT-ROOT'
  if (ts.isParenthesizedExpression(expr)) return receiverOrigin(expr.expression, scope, depth + 1)
  if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
    return receiverOrigin(expr.expression, scope, depth + 1)
  }
  if (ts.isNewExpression(expr) || ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr)) {
    return 'FRESH-NODE'
  }
  if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) return 'FRESH-NODE'
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression
    // `document.createElement('div')` and friends. The callee's own NAME must
    // resolve too -- `document[k]('div')` is not a provable create call, so it
    // lands in UNRESOLVED like everything else that did not resolve.
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const nm = resolveMemberName(callee, scope)
      if (nm !== null && FRESH_NODE_CALLS.has(nm)) return 'FRESH-NODE'
    }
    return 'UNRESOLVED'
  }
  if (ts.isIdentifier(expr)) {
    const b = lookup(scope, expr.text, expr)
    if (!b || b.kind !== 'VALUE' || !b.init) return 'UNRESOLVED'
    return receiverOrigin(b.init, scope, depth + 1)
  }
  return 'UNRESOLVED'
}

// ---------------------------------------------------------------------------
// 3. STAGE 2 -- classification. Only RESOLVED facts get here.
// ---------------------------------------------------------------------------

/** A tag that mints a second Document. Reached ONLY with a resolved tag string,
 *  never with syntax: by the time this is called, `const t = 'if'+'rame'` and
 *  `<iframe>` and `createElement('IFRAME')` are all the same fact. */
function routeForResolvedTag(tag: string): RefusedRoute | null {
  const t = tag.toLowerCase().trim()
  if (t === 'iframe') return 'IFRAME'
  // A hyphen in a tag name is the HTML spec's own definition of a custom
  // element -- not a heuristic and not a list. Scoped to TAG positions only:
  // kebab-case is also how this repo names classes, ids and test hooks, and a
  // rule that read those would be a false-positive machine.
  if (/^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(t)) return 'WEB-COMPONENT'
  return null
}

/** Markup scanned for the two routes a parsed string can mint. Reached ONLY with
 *  a RESOLVED markup string -- an unresolved one refused at stage 1 and never
 *  arrives here (amendment AM2). */
function routeForResolvedMarkup(markup: string): RefusedRoute | null {
  const tags = [...markup.matchAll(/<\s*([a-zA-Z][a-zA-Z0-9._-]*)/g)].map((m) => m[1])
  for (const t of tags) {
    const r = routeForResolvedTag(t)
    if (r) return r
  }
  return null
}

// ---------------------------------------------------------------------------
// 4. The sanctioned list
// ---------------------------------------------------------------------------
//
// DERIVED, NOT INVENTED, and the derivation is committed (see the R5 report's
// "sanctioned-set derivation" section). The clauses below were run over the
// current product tree and EVERY site they named was read at source and
// dispositioned here. Nothing is pattern-matched away.
//
// THE HALF OF THE DERIVATION THAT IS IMPLICIT, stated rather than left dangling
// (preflight sec B): the ruling's "standard positioned-element patterns the
// census enumerates today" has no named artifact in overlayRuntimeCensus.ts to
// point at, because it does not need one. Every authoring site in src/ that is
// NOT refused by a clause below is, BY ELIMINATION, an ordinary in-tree JSX or
// imperative append -- the standard route -- and the census governs it. The
// sanctioned set is therefore the complete list of NON-standard authoring in
// src/, and `refusedViolations()` being empty over the product tree is the
// assertion that nothing else exists.

export interface SanctionClaims {
  /** The scope sets `style.display = 'none'` on the node it authors. Re-derived
   *  from source by auditSanctions() in BOTH directions -- a claim of `true`
   *  where the source does not set it fails, and so does a claim of `false`
   *  where it does. The R4 audit's MINOR exists because two sanctions here said
   *  "display:none" in PROSE, where nothing checks. Prose is not a claim. */
  setsDisplayNone: boolean
  /** The scope disposes the node it authors (remove()/removeChild()) before it
   *  returns. This is what "immediately removed" means, and it is the claim the
   *  two corrected sanctions actually rest on. */
  removesNode: boolean
}

export interface SanctionedAuthoring {
  key: string
  route: RefusedRoute
  /** TRUE when the site authors an out-of-flow (absolute/fixed/sticky) element.
   *  A sanction that hides one of these is the kind of thing this WO exists to
   *  stop, so the flag is asserted against the source rather than trusted. */
  authorsOutOfFlow: boolean
  /** Every mechanical claim this sanction's reasoning rests on. If the reason
   *  string says the site does something, it belongs here where auditSanctions()
   *  can re-derive it -- that is the R4 MINOR's fix, generalised so the next
   *  sanction cannot repeat it. */
  claims: SanctionClaims
  /** Why the authoring space keeps this route open HERE. Not a label. */
  reason: string
  /** What the runtime census does about this site -- the L2 "no third state"
   *  question, answered per sanction. */
  censusStatus: string
}

/** Shorthand for the commonest claim shape, so an entry that needs no behaviour
 *  cannot accidentally CLAIM one by omission. */
const NO_CLAIMS: SanctionClaims = { setsDisplayNone: false, removesNode: false }

export const SANCTIONED_AUTHORING: readonly SanctionedAuthoring[] = [
  // WO-2622: move the exact WO-2470 exceptions into the single shared truth.
  {
    key: 'components/model3d/referenceImage/ReferenceImageCalibration.tsx:ReferenceImageCalibration > createPortal(<> {points.length < 2 && <WorkbenchConfirmBar testId="reference-image-cali...',
    route: 'BODY-PORTAL', authorsOutOfFlow: true,
    reason: 'WO-2303 (e355945b3): this portal targets canvas.parentElement, the viewport host, not a second document. Reuses WorkbenchConfirmBar and AnchoredValueEntry; moving the source is outside this grant.',
    claims: { setsDisplayNone: false, removesNode: false },
    censusStatus: 'Ordinary DOM inside the viewport host: the shared WorkbenchConfirmBar and AnchoredValueEntry authoring sites are already named and dispositioned by the census.',
  },
  {
    key: 'components/model3d/referenceImage/ReferenceImagePlacement.tsx:ReferenceImagePlacement > createPortal(<div aria-label="Reference image corner handles"> {IMAGE_CORNERS.map((corn...',
    route: 'BODY-PORTAL', authorsOutOfFlow: true,
    reason: 'WO-2331 (3693668eb): body-portalled fixed corner handles follow projected image corners in either sketch host; the fixed coordinates are document coordinates. A host migration needs a separate source grant.',
    claims: { setsDisplayNone: false, removesNode: false },
    censusStatus: 'Whole-document positioning sees the fixed buttons. overlayCohesionCensus explicitly classifies the wrapper STRUCTURAL and the handles RESTYLE-NEEDED with the existing raw-colour/z-index debt booked.',
  },
  {
    key: 'components/panels/sketch/SketchImportExportWindows.tsx:SketchImportExportWindows > createPortal( <div className="modal-backdrop" data-ui78-sanctioned="" onMouseDown={onCl...',
    route: 'BODY-PORTAL', authorsOutOfFlow: true,
    reason: 'WO-2318 (e1a181ed2): portals the shared focus-trapped modal shell out of the scrolling sketch toolbox/rail so the scrim covers the viewport; moving it is outside this grant.',
    claims: { setsDisplayNone: false, removesNode: false },
    censusStatus: 'Ordinary whole-document fixed modal-backdrop, data-ui78-sanctioned and MODAL-GOVERNED at its own authoring key in the committed dispositions; no child browsing context.',
  },
  {
    key: 'form/remesh.ts:r > home[i](q)',
    route: 'UNRESOLVED', authorsOutOfFlow: false,
    reason: 'Form remeshing (0f99e3126): home is a local array of Vec3 -> Vec3 closest-point functions, assigned from face/chain/vertex targets. The computed call is geometry math, not a DOM receiver.',
    claims: { setsDisplayNone: false, removesNode: false },
    censusStatus: 'Outside the census domain: pure cage remeshing computes positions and returns a Cage; this call authors no document, element or floating surface.',
  },
  {
    key: 'form/symmetry.ts:symmetrize/pairs.images.forEach(...) > T[t](positions[winner])',
    route: 'UNRESOLVED', authorsOutOfFlow: false,
    reason: 'Form symmetry (dc7e54a35): T comes from the local transforms() array of Vec3 -> Vec3 mirror/rotation functions, indexed by the symmetry image; no DOM receiver is involved.',
    claims: { setsDisplayNone: false, removesNode: false },
    censusStatus: 'Outside the census domain: pure mirror/rotation math copies cage positions and returns a Cage; the computed call authors no DOM or overlay.',
  },
  {
    key: 'lib/sketch/printDrawing.ts:printSketchDocument > document.body.appendChild(frame)',
    route: 'BODY-PORTAL', authorsOutOfFlow: true,
    reason: 'WO-2301 (6ce7ed850): appends the hidden, zero-size print frame so the browser print dialog has a live document. It remains until afterprint removes it; it is not an on-screen overlay.',
    claims: { setsDisplayNone: false, removesNode: true },
    censusStatus: 'The parent frame is fixed but visibility:hidden with width/height zero. Its child document is outside the overlay census by design: it is the printable drawing, not a viewport HUD.',
  },
  {
    key: "lib/sketch/printDrawing.ts:printSketchDocument > document.createElement('iframe')",
    route: 'IFRAME', authorsOutOfFlow: true,
    reason: 'WO-2301 (6ce7ed850): creates the same hidden zero-size iframe specifically for a same-origin print document; the shared overlay host cannot provide an isolated printable document.',
    claims: { setsDisplayNone: false, removesNode: false },
    censusStatus: 'Explicit print-document exemption: the child document is not enumerated, and the parent is visibility:hidden and zero-size. This does not sanction visible iframe overlays or any other iframe site.',
  },
  {
    key: 'lib/sketch/printDrawing.ts:printSketchDocument > frame.contentDocument',
    route: 'IFRAME', authorsOutOfFlow: false,
    reason: 'WO-2301 (6ce7ed850): reads only the print document fonts.ready promise before printing, so the drawing fonts settle; this access does not insert an overlay.',
    claims: { setsDisplayNone: false, removesNode: false },
    censusStatus: 'The isolated print document is explicitly outside the overlay census. This site only awaits fonts; the parent frame remains hidden and zero-size.',
  },
  {
    key: 'lib/sketch/printDrawing.ts:printSketchDocument > frame.contentWindow',
    route: 'IFRAME', authorsOutOfFlow: false,
    reason: 'WO-2301 (6ce7ed850): focuses and prints the child window and registers afterprint cleanup. This is the browser print API, not a child-document HUD author.',
    claims: { setsDisplayNone: false, removesNode: false },
    censusStatus: 'The isolated print document is explicitly outside the overlay census; its window supplies print/afterprint and the hidden parent frame is removed when printing ends.',
  },
  {
    key: 'components/model3d/form/formInteraction.ts:dragBoxTo > document.body.appendChild(shape)',
    route: 'BODY-PORTAL', authorsOutOfFlow: true, claims: NO_CLAIMS,
    reason: 'WO-2506: a drag from empty canvas space draws a transient fixed selection rectangle using the viewport amber token. Document coordinates keep it aligned with the pointer; pointer-events:none lets the canvas retain the drag. Release, Escape, second touch, cancellation and dispose call endBox and remove it. Removal occurs in endBox, not this authoring scope, so the local mechanical removal claim remains false.',
    censusStatus: 'Named imperative surface in FORM_IMPERATIVE_DISPOSITIONS (formInteraction.ts:form-box-select). The overlayGatePair production pointer recipe proves the live rectangle is enumerated by whole-document positioning, then checks its exact imperative disposition and cleanup. It has no React fiber; the recipe asserts that limitation rather than inventing JSX attribution.',
  },

  // -------------------------------------------------------------------------
  // BODY-PORTAL -- the route resolved to a document root.
  // -------------------------------------------------------------------------
  {
    key: 'components/machine/PendantPanel.tsx:PendantPanel > createPortal( <div id=\"pendant-pairing-popover\" ref={popoverRef} className=\"pendant-pop...',
    route: 'BODY-PORTAL',
    authorsOutOfFlow: true,
    claims: NO_CLAIMS,
    reason:
      'Operator ruling 2026-08-20 (WO-404; COHESION-STANDARD section 15 item 1): "pendant pop-out behaved how I asked it to be. Pendant pops right, user interacts, it pops back." The pendant pairing card is a transient flyout anchored beside the Pendant button (fixed, positioned from the trigger rect, closed by Escape / outside press / its own button) and it is allowed to paint over the program preview while open. It is authored through createPortal so it can escape the Machine panel\'s clipping and stacking context - an in-place author would be clipped by the panel body. This portal is sanctioned by this key alone: a second portal is a new site and a new card, never an inherited pattern.',
    censusStatus:
      'INSIDE the census domain and dispositioned there: `components/machine/PendantPanel.tsx:PendantPanel > div.pendant-popover` is COHESIVE in SURFACE_DISPOSITIONS on the same ruling, and the runtime census lists it among the in-viewport surfaces (OVERLAY-RUNTIME-KEYS.md). Sanctioned at authoring AND censused at runtime - no third state.',
  },
  {
    key: 'components/machine/MacroAskDialog.tsx:mountMacroAskDialog > document.body.appendChild(host)',
    route: 'BODY-PORTAL',
    authorsOutOfFlow: true,
    claims: NO_CLAIMS,
    reason:
      'WO-1715: a running macro can ask the operator from any screen, so its one persistent React ' +
      'root is mounted at the end of document.body instead of being owned by a panel that may not ' +
      'be mounted. The root renders only the shared modal-backdrop/modal-container shell while a ' +
      'question is pending, and every dismissal path answers or stops that question. This grant is ' +
      'keyed to mountMacroAskDialog alone; another body append is a new site and receives no grant.',
    censusStatus:
      'The rendered child is the shared position:fixed `modal-backdrop`, marked ' +
      '`data-ui78-sanctioned` and ordinary whole-document DOM. The runtime attach guard therefore ' +
      'governs it at insertion, while the modal-backdrop authoring site uses the same dispositioned ' +
      'modal class as the census recipes; the body-root host creates no separate visible surface.',
  },
  // (WO-1450 retired the 'lib/import/svgImporter.ts:importSVG > document.body.appendChild(host)'
  // BODY-PORTAL sanction and its 'samplePath > svgHost.appendChild(path)' UNRESOLVED
  // sibling: the importer now computes path geometry itself and no longer mounts a
  // measurement <svg>, so both sites are gone and are pruned, not carried.)
  // (WO-047 retired the 'App.tsx:FloatingModeTabs > createPortal(strip,
  // portalNode)' BODY-PORTAL sanction that lived here: the mode tabs moved
  // natively into the top header, FloatingModeTabs and its portal call are
  // deleted, and per the bidirectional discipline a sanction with no site
  // must be pruned, not carried. UI-73's grant history stays in git.)

  // -------------------------------------------------------------------------
  // UNRESOLVED -- the fail-closed bucket's honest cost, site by site.
  //
  // These are the FALSE-POSITIVE SURFACE the WO required be handled honestly
  // rather than legislated away. Not one of them is an overlay; every one of
  // them is a construct whose deciding value this lint cannot statically
  // resolve, and the design's own rule is that unresolved REFUSES. Each is
  // read at source and dispositioned here, which is the price of a bound that
  // cannot be respelled. They are NOT waived by weakening a clause -- that is
  // the move that lost R4.
  // -------------------------------------------------------------------------
  // ---- UNRESOLVED-RECEIVER: the receiver is caller-supplied -----------------
  {
    key: 'cam3d/dev/devPage.ts:mountCam3dDevPage > root.appendChild(page)',
    route: 'UNRESOLVED',
    authorsOutOfFlow: true,
    claims: NO_CLAIMS,
    reason:
      '`root` is this function\'s own HTMLElement parameter, so `mountCam3dDevPage(document.body)` really WOULD be a body portal and no reading of this file can prove otherwise -- which is why it refuses rather than passing. It is sanctioned because the site is read and understood: src/cam3d/dev/ is a dev-only page mounted by the cam3d proof script and by nothing in the app shell, and owning the element it is handed is its entire job. What it appends IS position:fixed;inset:0 (hence authorsOutOfFlow: true, re-derived not trusted). The ROUTE here is ordinary in-tree DOM -- not a shadow root, not an iframe, not a custom element -- so whatever document it lands in, the census governs it. Only the receiver is unprovable.',
    censusStatus:
      'Outside the census domain: no recipe mounts the cam3d dev page. Were it ever mounted in the app, its DOM is ordinary in-tree DOM in this document -- position:fixed, squarely inside A4\'s membership rule -- so the census names it as unmapped rather than missing it.',
  },
  {
    key: 'components/model3d/mountLab3DPage.ts:mountLab3DPage > root.appendChild(el)',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'Same shape as the cam3d dev page: `root` is the mount function\'s HTMLElement parameter and cannot be proven non-root from this file. The single call site in the app passes the #root div (main.tsx), never document.body -- but that is a fact about ANOTHER file, and this lint deliberately resolves within one file rather than pretending to a whole-program analysis it does not have. What it appends is an error banner element built with document.createElement: ordinary in-tree DOM the census enumerates.',
    censusStatus:
      'Outside the census domain: no recipe mounts the lab page shell. Its DOM is ordinary in-tree DOM in this document, so the census would enumerate and name it if a recipe ever did.',
  },
  {
    key: 'lib/sketch/sketcher/sketchInteraction.ts:updateMarquee > this.host.container.appendChild(this.marqueeDiv)',
    route: 'UNRESOLVED',
    authorsOutOfFlow: true,
    claims: NO_CLAIMS,
    reason:
      'The sketcher\'s rubber-band selection marquee, appended to the sketch host\'s container. The receiver is a field read through `this`, so its origin lives in whatever constructed the host -- unprovable here, and refused for that reason alone rather than for anything it does. The marquee IS position:absolute (authorsOutOfFlow: true, re-derived from source). It is ordinary in-tree DOM in this document: the census enumerates by positioning over the whole document and reaches it.',
    censusStatus:
      'IN the census domain, and that is the point of this entry: an unprovable RECEIVER is not an invisible SURFACE. The marquee is position:absolute in-tree DOM, so if a recipe mounts the sketcher the census enumerates it and fails BY NAME until it is dispositioned.',
  },
  {
    key: 'lib/viewport/CNCViewport.ts:CNCViewport > container.appendChild(this.renderer.domElement)',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The viewport constructor appending the WebGL canvas into the container it was handed. `container` is a constructor parameter: `new CNCViewport(document.body)` would be a body portal written across two files, and this file cannot rule it out. What it appends is renderer.domElement -- a canvas, in flow, sized to its parent. The refusal is about the receiver, not the node.',
    censusStatus:
      'Outside the census domain: a canvas in normal flow is not a floating surface, so the positioning walk never enumerates it. If it were ever positioned out of flow, it is in-tree DOM in this document and A4\'s membership rule names it.',
  },
  {
    key: 'components/machine/MeshViewerModal.tsx:MeshViewerModal > mount.appendChild(renderer.domElement)',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'WO-416: the flatness viewer\'s three.js scene mounts its WebGL canvas into a plain `<div ref={mountRef}>` inside the modal body. `mount` is `mountRef.current` -- a ref read, unprovable as non-document-root from this file, the same shape as CNCViewport\'s constructor-parameter `container` right above (and ViewCube\'s ref-read `canvas` further below). What it appends is `renderer.domElement` -- a canvas, in normal flow, sized to its `.mesh-viewer-canvas-mount` parent (100% width/height, no position: absolute/fixed anywhere in that class or its ancestors up to `.modal-body`). The refusal is about the receiver, not the node.',
    censusStatus:
      'Outside the census domain: a canvas in normal flow is not a floating surface, so the positioning walk never enumerates it -- same reasoning as CNCViewport\'s canvas above. The modal shell it sits inside (`div.modal-backdrop`) IS in the domain via its own JSX authoring site, dispositioned MODAL-GOVERNED in overlayDispositions.ts.',
  },
  {
    key: 'components/viewport/ViewCube.tsx:ViewCube > canvas.replaceWith(fresh)',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'MERGE-SEAM SANCTION (main 52ec79e9, dated 2026-07-17): a StrictMode dev-remount workaround, not an overlay. React StrictMode double-invokes effects in dev, and the mount effect\'s own cleanup already force-lost the canvas\'s WebGL context (WO INT-13B\'s explicit-release contract); constructing a second WebGLRenderer on a lost context crashes. So a remount that finds `canvas.dataset.contextLost === \'1\'` clones the dead canvas node and calls `canvas.replaceWith(fresh)` before building the renderer on `fresh` instead. `canvas` is `let canvas = canvasRef.current` -- a ref read, unprovable as non-document-root from this file (the same shape as every other ref/parameter receiver already sanctioned above) -- so it refuses at Stage 1 rather than at anything the call does. Both `canvas` and `fresh` are the SAME JSX-authored `<canvas className="view-cube-canvas">` node (ViewCube.tsx:293-294, a plain in-flow child of the already-positioned `.view-cube-wrap`); `replaceWith` swaps identity, not position, and neither carries an inline position of its own (authorsOutOfFlow: false, re-derived -- no `position:` literal anywhere in this effect).',
    censusStatus:
      'IN the census domain via its OWN JSX authoring site (`ViewCube.tsx:ViewCube > div.view-cube-wrap` / `span.view-cube-label`, both already dispositioned COHESIVE): ViewCube is OBSERVED through the renderer-stub mount (A2 mechanism 2), not exempted, so a real position:absolute regression on this canvas would already be caught there. This call itself authors no new position -- it swaps a dead canvas for a live clone of the identical node -- so there is nothing further for the runtime census to enumerate at this specific site.',
  },
  {
    key: 'lib/viewport/CNCViewport.ts:_buildProjectPlanePicker > this.container.appendChild(overlay)',
    route: 'UNRESOLVED',
    authorsOutOfFlow: true,
    // NOT removed in this scope -- disposal is the picker's exit path, in
    // another method. Claimed false because the source says false; the claim
    // gate refused the `true` this entry was first written with.
    claims: NO_CLAIMS,
    reason:
      'The project-plane picker overlay, mounted into the viewport container. Receiver is `this.container` -- the constructor parameter above, one hop further away -- so it is unprovable for the same reason and refuses for the same reason. The overlay IS position:absolute (authorsOutOfFlow: true, re-derived). This is a REAL in-viewport floating surface authored through the STANDARD route: imperative DOM, in this document, in the viewport\'s own container. It is precisely what the census is for, which is why it is sanctioned here and censused there rather than refused outright.',
    censusStatus:
      'IN the census domain. Ordinary in-tree DOM at position:absolute inside the viewport container: the census enumerates it by positioning, maps it to its authoring site, and fails BY NAME if it carries no disposition.',
  },
  {
    key: 'lib/viewport/CNCViewport.ts:_enterZScrubMode > this.container.appendChild(overlay)',
    route: 'UNRESOLVED',
    authorsOutOfFlow: true,
    // NOT removed in this scope -- disposal is the Z-scrub exit path, in
    // another method. The claim gate refused the `true` first written here.
    claims: NO_CLAIMS,
    reason:
      'The slice-plane Z overlay, mounted into the viewport container. Same receiver, same unprovable origin, same standard route as the project-plane picker: imperative in-tree DOM in this document. The overlay IS position:absolute (re-derived). Sanctioned as a resolution limit, governed by the census as a surface.',
    censusStatus:
      'IN the census domain. Ordinary in-tree DOM at position:absolute inside the viewport container: the census enumerates it by positioning and fails BY NAME if it carries no disposition.',
  },
  {
    key: 'lib/sketch/sketcher/toolController.ts:end > doc.append(commit, inferred)',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'NOT DOM AT ALL, and this is the honest cost of bounding a space by METHOD NAME rather than by type. `doc` is the sketch document port (`let doc: SketchDocumentPort | null = null`), and `append` here commits sketch entities and constraints to a parametric document -- there is no element, no node, and no page. It refuses because `append` is a real DOM method on a real document root and this walk cannot read `doc`\'s type to tell the two apart: the binding is written twice (declared null, assigned in setDocumentPort), so it resolves to AMBIGUOUS and AMBIGUOUS refuses. Seven sites in this file share that shape; each is named separately because one sanction covering two sites is the defect auditSanctions().ambiguous exists to refuse.',
    censusStatus:
      'Outside the census domain by construction: this call authors no DOM node of any kind, so there is no surface for any census to enumerate. The name collision is with the DOM API, not the behaviour.',
  },
  {
    key: 'lib/sketch/sketcher/toolController.ts:overlayApply > doc.append({ entities: r.entities, constraints: r.constraints }, [])  #1',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The sketch document port again, not the DOM -- see the `end` entry for the full reasoning. THREE byte-identical statements now sit in `overlayApply`, which is the one case no source-derived name can separate, so they are told apart by a source-order ordinal and each is sanctioned on its own terms. The ordinals map: `#1` is this one, the linear/circular pattern commit; `#2` is the path-pattern commit; `#3` is the offset commit. There were two until WO-1569 added the path-pattern branch BETWEEN them.',
    censusStatus:
      'Outside the census domain by construction: this call authors no DOM node, so no census has anything to enumerate.',
  },
  {
    key: 'lib/sketch/sketcher/toolController.ts:overlayApply > doc.append({ entities: r.entities, constraints: r.constraints }, [])  #2',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The path-pattern commit, which WO-1569 inserted BETWEEN the original two and which therefore TOOK the `#2` ordinal from the offset commit that used to hold it. That is the ordinal-shift cost this file discloses rather than hides, and auditSanctions().stale is what caught it the moment the count changed. Sanctioned separately for the reason A3 taught this program the expensive way -- two authoring sites sharing one grant is how a third one later inherits a reason nobody wrote for it.',
    censusStatus:
      'Outside the census domain by construction: this call authors no DOM node, so no census has anything to enumerate.',
  },
  {
    key: 'lib/sketch/sketcher/toolController.ts:overlayApply > doc.append({ entities: r.entities, constraints: r.constraints }, [])  #3',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The offset commit -- the side-locked offset applied at the live distance -- and the site that held `#2` until WO-1569 inserted the path-pattern branch above it. Same sketch document port, same twice-written AMBIGUOUS binding, same refusal as its two siblings, and written out in full here rather than inheriting a reason authored for a different branch.',
    censusStatus:
      'Outside the census domain by construction: this call authors no DOM node, so no census has anything to enumerate.',
  },
  {
    key: 'lib/sketch/sketcher/toolController.ts:click > doc.append({ entities, constraints: commit.constraints }, [])',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The sketch document port, not the DOM -- see the `end` entry for the full reasoning. This is the click handler\'s direct-commit path, appending the entities and constraints a completed tool produced to the parametric sketch document.',
    censusStatus:
      'Outside the census domain by construction: this call authors no DOM node, so no census has anything to enumerate.',
  },
  {
    key: 'lib/sketch/sketcher/toolController.ts:click > doc.append(r.commit, inferred, { openDimensionEditor: true, clearSelection: s.tool === ...',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The sketch document port, not the DOM -- see the `end` entry for the full reasoning. This is the click path that commits with inferred constraints and asks the document to open the dimension editor afterwards.',
    censusStatus:
      'Outside the census domain by construction: this call authors no DOM node, so no census has anything to enumerate.',
  },
  {
    key: 'lib/sketch/sketcher/toolController.ts:commitDrawValueAt > doc.append(res.commit, [])',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The sketch document port, not the DOM -- see the `end` entry for the full reasoning. This is the typed-value draw path, committing the entity the user dimensioned into existence.',
    censusStatus:
      'Outside the census domain by construction: this call authors no DOM node, so no census has anything to enumerate.',
  },
  {
    key: 'lib/sketch/sketcher/toolController.ts:pasteSelection > doc.append({ entities: pasted.entities, constraints: pasted.constraints }, [])',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The sketch document port, not the DOM -- see the `end` entry for the full reasoning. This is the clipboard paste path, appending remapped sketch entities and constraints to the parametric sketch document. It creates no HTMLElement and reaches no browser Document root.',
    censusStatus:
      'Outside the census domain by construction: this call authors no DOM node, so no census has anything to enumerate.',
  },
  {
    key: 'lib/sketch/sketcher/toolController.ts:importFileIntoSketch > doc.append({ entities: lifted.entities, constraints: lifted.constraints }, [])',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The sketch document port, not the DOM -- see the `end` entry for the full reasoning. This is the import-into-sketch path, appending lifted DXF/SVG loops as sketch entities and constraints to the parametric sketch document. It creates no HTMLElement and reaches no browser Document root.',
    censusStatus:
      'Outside the census domain by construction: this call authors no DOM node, so no census has anything to enumerate.',
  },

  // ---- UNRESOLVED-TAG: a component this file cannot follow ------------------
  {
    key: 'components/model3d/workbench/WorkbenchToolRail.tsx:WorkbenchToolRail/sketchHistoryTools.map(...) > <Icon size={15} />',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      '`const Icon = tool.icon` where `tool` iterates `sketchHistoryTools` -- a PROP. The resolver follows icon components out of same-file maps (twelve other `<Icon />` sites in this tree resolve exactly that way and do NOT appear in this list), but this array arrives from the component\'s caller and no same-file reading reaches it. A JSX tag position is a tag position, so an identifier that resolves to neither a string nor a provable component refuses. Read at source: RailTool.icon is typed LucideIcon and every call site passes lucide components.',
    censusStatus:
      'IN the census domain: whatever this renders is an <svg> in normal flow inside the rail. The census enumerates by positioning, so a floating surface here would be named; an icon is not one.',
  },
  {
    key: 'components/model3d/workbench/WorkbenchToolRail.tsx:WorkbenchToolRail/modelingSections.map(...)/section.tools.map(...) > <Icon size={15} />',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The same shape one nesting level deeper: `modelingSections` is a prop, `section.tools` is read off its elements, and `tool.icon` off those. Unfollowable from this file for the same reason and refused for the same reason. Named separately from its sibling above because the two `<Icon size={15} />` snippets are byte-identical -- the key tells them apart by the callback chain each sits in, which is why anonymous callbacks borrow their call\'s name.',
    censusStatus:
      'IN the census domain: whatever this renders is an <svg> in normal flow inside the rail. The census enumerates by positioning, so a floating surface here would be named; an icon is not one.',
  },

  // ---- UNRESOLVED-CALLEE: a call through a computed member -----------------
  {
    key: 'geom/index.ts:createGeomService > remote[Comlink.releaseProxy]()',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'Comlink\'s worker-teardown idiom: `releaseProxy` is a SYMBOL, and a symbol-keyed call can never be attachShadow (a string-named method) -- but proving that needs the checker, and this walk resolves syntax. So it refuses, and is sanctioned after being read. It is one of exactly TWO computed-member calls in the whole product tree, which is what makes the refuse-on-unresolved-callee rule affordable: the rule closes computed-callee aliasing structurally (`host[k]({mode:\'open\'})` cannot be spelled past it) and costs two entries.',
    censusStatus:
      'Outside the census domain by construction: this releases a Comlink proxy over a Web Worker. There is no DOM node and no surface anywhere in it.',
  },
  {
    key: 'geom/worker/geom-engine.ts:disposeKernel > k[Symbol.dispose]()',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The explicit-resource-management disposal idiom, keyed by the well-known symbol `Symbol.dispose`. Same reasoning as the Comlink entry: symbol-keyed, provably not a string member name to a reader, unprovable to a syntax walk, refused and then sanctioned by name. This runs inside the geometry Web Worker, where there is no document at all.',
    censusStatus:
      'Outside the census domain by construction: this disposes the manifold kernel inside a Web Worker. There is no DOM node and no surface anywhere in it.',
  },

  // ---- UNRESOLVED-MARKUP: an interpolated markup string --------------------
  {
    key: 'lib/viewport/CNCViewport.ts:makeBtn > btn.innerHTML = `<span class="pp-color-swatch" style="background:${colorHex}"></span> <...',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'AMENDMENT AM2\'S CLAUSE, firing on real product code the round it was added. The markup is a template with three interpolations, so it does not resolve to a string and what it parses into is formally unknowable -- `<iframe>` included, if one of the holes ever carried one. Read at source: the holes are a colour hex, a label and a Z readout, and the static skeleton is three <span>s. The receiver is a fresh <button> from createElement, not a document root. Refused because an unresolved markup string is refused, sanctioned because the string was read.',
    censusStatus:
      'IN the census domain: the button this fills is appended into the viewport container, so the census enumerates the surface it belongs to by positioning. The <span>s inside it are in normal flow.',
  },
  {
    key: 'lib/viewport/CNCViewport.ts:_enterZScrubMode > overlay.innerHTML = ` <div class="sp-title">${opts.title}</div> <div class="sp-z">Z = <...',
    route: 'UNRESOLVED',
    authorsOutOfFlow: false,
    claims: NO_CLAIMS,
    reason:
      'The second AM2 site: the slice-plane overlay\'s body, a template with seven interpolations (title, Z value, unit labels, range note). Does not resolve, so it refuses. Read at source: the skeleton is <div>s, an <input>, and two <button>s, and every hole is a formatted number or a label. The receiver is the fresh <div> created two statements above, not a document root -- the overlay itself is sanctioned separately at its append.',
    censusStatus:
      'IN the census domain: this fills the slice-plane overlay, which is position:absolute in the viewport container and is enumerated by the census at its own append site.',
  },
]

// ---------------------------------------------------------------------------
// 5. The walk
// ---------------------------------------------------------------------------

/** Product source: the files that PAINT the app. src/tests/ is excluded for the
 *  reason the static census already documents -- a fixture legitimately contains
 *  the very syntax these clauses hunt for, and this WO's own LINT-MUST-REFUSE
 *  fixtures are the clearest example. The fixtures are linted explicitly, by
 *  path, in the gate. */
export function productSourceFiles(srcRoot: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (full.includes(`${path.sep}tests${path.sep}`) || entry === 'tests') continue
        walk(full)
      } else if (/\.(ts|tsx)$/.test(full)) {
        out.push(full)
      }
    }
  }
  walk(srcRoot)
  return out.sort()
}

function relKey(file: string, srcRoot: string): string {
  return path.relative(srcRoot, file).split(path.sep).join('/')
}

/** The nearest NAMED enclosing scope, which is what makes a key survive an edit
 *  above it. Falls back to `<module>` for top-level statements rather than to a
 *  line number -- a key that silently rewrites itself on every unrelated commit
 *  is not a key, and a sanction keyed to a line number is one nobody maintains
 *  honestly (they just update the number).
 *
 *  THE useCallback HOP IS LOAD-BEARING, and it was found by running this lint
 *  rather than by reasoning about it. Without it, SolidsWorkbenchPage's two
 *  download anchors -- `handleExportStepClick` and `handleDebugExportClick`,
 *  200 lines apart -- BOTH resolved to the component name and produced the
 *  IDENTICAL key, because an arrow wrapped in useCallback() has a CallExpression
 *  between it and its variable declaration. Two distinct authoring sites sharing
 *  one key is precisely the defect amendment A3 exists to prevent, and here it
 *  would have been worse than a mislabel: ONE sanction would have silently
 *  covered BOTH sites, and a third append added to that scope could inherit it.
 *  So the hop resolves through the wrapping call -- useCallback, useMemo,
 *  forwardRef, memo -- to the name the reader actually sees. */
function enclosingName(node: ts.Node): string {
  const parts: string[] = []
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      parts.unshift(n.name.getText())
      break
    }
    if (ts.isClassDeclaration(n) && n.name) {
      parts.unshift(n.name.getText())
      break
    }
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      // `const f = () => {}`
      if (n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
        parts.unshift(n.parent.name.getText())
        break
      }
      // `const f = useCallback(() => {}, deps)` and its family.
      if (
        n.parent &&
        ts.isCallExpression(n.parent) &&
        n.parent.parent &&
        ts.isVariableDeclaration(n.parent.parent) &&
        ts.isIdentifier(n.parent.parent.name)
      ) {
        parts.unshift(n.parent.parent.name.getText())
        break
      }
      // AN ANONYMOUS CALLBACK -- `list.map((tool) => ...)`. It has no name of
      // its own, so it borrows the call's: `WorkbenchToolRail/sketchHistoryTools
      // .map`. WITHOUT THIS the rail's two `<Icon size={15} />` sites -- one in
      // the history grid, one in the modeling grid -- produce the IDENTICAL key
      // and collide, which is amendment A3's defect exactly (one sanction
      // silently covering two sites). Found by running the lint, not by
      // reasoning about it, which is also how the useCallback hop above was
      // found. Keeps walking outward, so the component's name still leads.
      if (n.parent && ts.isCallExpression(n.parent) && ts.isPropertyAccessExpression(n.parent.expression)) {
        parts.unshift(`${n.parent.expression.getText().replace(/\s+/g, '')}(...)`)
        continue
      }
    }
  }
  return parts.length ? parts.join('/') : '<module>'
}

function firstLineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function snippetOf(node: ts.Node, sf: ts.SourceFile): string {
  const text = node.getText(sf).replace(/\s+/g, ' ')
  return text.length > 90 ? `${text.slice(0, 87)}...` : text
}

/** Node-ATTACHING members. The BODY-PORTAL route is "attach a node to a document
 *  root", and this is the complete set of member names that do it.
 *
 *  WHY `document.body.style.cursor = 'col-resize'` IS NOT HERE, named rather
 *  than silently omitted (PanelResizer.tsx does it four times): a style-property
 *  write attaches no node. It cannot produce a floating surface, because there
 *  is no surface -- the route this lint bounds is authoring DOM the census
 *  cannot see, and a cursor is not DOM. AM1's "document.body mutation in any
 *  form" scopes the refuse-on-unresolved DUTY to the four APIs; it does not make
 *  every byte written near a root into an overlay. This accept path is stated in
 *  the R5 report as an accept path, not left for an auditor to discover. */
const ATTACH_METHODS = new Set([
  'appendChild',
  'append',
  'prepend',
  'insertBefore',
  'replaceChildren',
  'replaceWith',
  'before',
  'after',
  'insertAdjacentElement',
  'insertAdjacentHTML',
])

/** Members that PARSE a string into nodes. Assigned, not called -- which is
 *  exactly amendment AM2's gap: R4 walked CallExpressions only, so a
 *  `document.body.innerHTML = '<iframe ...>'` was neither refused nor
 *  census-visible. */
const MARKUP_PROPERTIES = new Set(['innerHTML', 'outerHTML'])

/** Memo for the walk. The lint is PURE over (files, srcRoot) -- it reads the
 *  tree and returns findings -- so repeat calls in one process are repeat work
 *  and nothing else.
 *
 *  THIS IS NOT A MICRO-OPTIMISATION. auditSanctions() re-derives every
 *  sanction's claims from source, and each re-derivation needs the site's own
 *  finding, so it called the walk once PER SANCTION: 24 sanctions x 482 files
 *  x a full TypeScript parse each. The gate took 491 SECONDS and tripped
 *  vitest's onTaskUpdate RPC timeout -- the exact BK-153 signature this repo's
 *  run-suite has a flake classifier for. A gate slow enough to look like a
 *  flake is a gate someone eventually stops running.
 *
 *  Keyed on the exact file list, so pointing the walk at the fixtures and at
 *  the product tree are different entries and neither can serve the other's
 *  answer. Cleared by process exit; vitest gives each test file a fresh one. */
const walkMemo = new Map<string, AuthoringViolation[]>()

/** THE LINT. Pure over `files`, so the identical clauses that judge the product
 *  tree judge the LINT-MUST-REFUSE fixtures -- no second implementation to drift
 *  (the gate proves this by pointing it at both). */
export function lintAuthoringSpace(files: string[], srcRoot: string): AuthoringViolation[] {
  const memoKey = `${srcRoot} ${files.join(' ')}`
  const hit = walkMemo.get(memoKey)
  // Returned as a copy: the ordinal pass below MUTATES violation keys, and a
  // caller that got the cached array itself could see them ordinalled twice.
  if (hit) return hit.map((v) => ({ ...v }))
  const out = lintAuthoringSpaceUncached(files, srcRoot)
  walkMemo.set(memoKey, out)
  return out.map((v) => ({ ...v }))
}

/** A plain `.ts` file can never contain JSX -- TypeScript itself refuses `<...>`
 *  there as either a generic type argument/parameter or a comparison operator,
 *  NEVER a tag. Parsing one in TSX mode anyway makes the two genuinely
 *  ambiguous only in `.tsx`: a bare `<T>(x: T) => ...` generic arrow (illegal
 *  in TSX without the `<T,>` trick, legal and unambiguous in `.ts`) forces an
 *  error-recovery path whose confusion can cascade into misreading later
 *  unrelated `<`/`<=` comparisons in the SAME file as JSX open-tags -- observed
 *  concretely in lib/cam/smartHeights/resolve.ts (a `.ts` file, zero JSX):
 *  `const unique = <T>(values: T[])` at line 85 is a real generic, and
 *  `feature.sourceVersion < 1` / `authored.depthMm <= 0` at lines 99/147/638
 *  are real comparisons, none of them tags. Scoping ScriptKind to the file's
 *  own extension removes the ambiguity at its source instead of papering over
 *  each cascade site by hand. */
function scriptKindFor(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function lintAuthoringSpaceUncached(files: string[], srcRoot: string): AuthoringViolation[] {
  const out: AuthoringViolation[] = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file))
    const rel = relKey(file, srcRoot)
    const scope = buildFileScope(sf)

    const push = (node: ts.Node, route: RefusedRoute, code: RefusalCode, reason: string): void => {
      out.push({
        key: `${rel}:${enclosingName(node)} > ${snippetOf(node, sf)}`,
        route,
        code,
        file: rel,
        line: firstLineOf(node, sf),
        snippet: snippetOf(node, sf),
        reason,
      })
    }

    /** Stage 2 for a tag position: a RESOLVED tag is a fact; classify it. */
    const classifyTag = (node: ts.Node, tag: string, where: string): void => {
      const route = routeForResolvedTag(tag)
      if (!route) return
      push(
        node,
        route,
        'RESOLVED-ROUTE',
        route === 'IFRAME'
          ? `${where} RESOLVES to the tag "${tag}". An iframe is a SECOND Document: the R3 audit killed the whole-document census with one, and no walk of THIS document reaches a child browsing context. The tag resolved as a FACT -- through literals, concatenation, templates and same-file aliases alike -- so respelling it does not help; a spelling that does NOT resolve refuses as UNRESOLVED-TAG instead.`
          : `${where} RESOLVES to the tag "${tag}". A hyphen in a tag name is the HTML spec's own definition of a custom element: it builds its DOM imperatively, carries no React fiber, and is the natural host for a shadow root. src/ has never defined one.`,
      )
    }

    /** Stage 1 + 2 for an attach receiver (AM5c). */
    const checkAttachReceiver = (node: ts.Node, receiver: ts.Expression, member: string): void => {
      const origin = receiverOrigin(receiver, scope)
      if (origin === 'FRESH-NODE') return // The ONLY accept path. Provably not a root.
      if (origin === 'DOCUMENT-ROOT') {
        push(
          node,
          'BODY-PORTAL',
          'RESOLVED-ROUTE',
          `\`${member}\` on a receiver that RESOLVES to a document root authors DOM no React walk can see. Sites in src/ that do this legitimately are sanctioned BY NAME in SANCTIONED_AUTHORING; this one is not among them. The receiver resolved through the same folder that resolves tags, so a \`const b = document.body\` alias is the same fact as \`document.body\`.`,
        )
        return
      }
      push(
        node,
        'UNRESOLVED',
        'UNRESOLVED-RECEIVER',
        `\`${member}\` on a receiver with NO provable non-document-root origin in this file (amendment AM5c). This does not claim the receiver IS document.body -- it says the lint cannot prove it is not, and an unprovable receiver is a refusal, never a pass. To resolve it, give the receiver a same-file origin the walk can read (a create call, a \`new\`, a literal), or sanction the site BY NAME.`,
      )
    }

    const visit = (node: ts.Node): void => {
      // =====================================================================
      // TAG POSITIONS -- "iframe creation in any form" (AM1), resolved or
      // refused. No clause below ever compares SYNTAX to a route name.
      // =====================================================================

      // ---- createElement / createElementNS ---------------------------------
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const member = resolveMemberName(node, scope)

        if (member !== null && (member === 'createElement' || member === 'createElementNS')) {
          const call = node.parent
          const isCallee = call && ts.isCallExpression(call) && call.expression === node
          if (!isCallee) {
            // `const ce = document.createElement` / `.bind(document)`. The
            // function escaped its call site, so NO tag is visible here and
            // none ever will be. Stage 1 fails; refuse.
            push(
              node,
              'UNRESOLVED',
              'UNRESOLVED-TAG',
              `\`${member}\` is REFERENCED without being called -- aliased, bound, or passed on. The tag it will eventually receive is not visible at this site and cannot be resolved from it, so the element it mints is unknowable (amendment AM5a). Call it directly with a literal tag, or sanction this site BY NAME.`,
            )
          } else {
            const arg = (call as ts.CallExpression).arguments[member === 'createElementNS' ? 1 : 0]
            const tag = arg ? resolveString(arg, scope) : null
            if (tag === null) {
              push(
                call as ts.CallExpression,
                'UNRESOLVED',
                'UNRESOLVED-TAG',
                `\`${member}\` received a tag that does NOT statically resolve to a string (amendment AM5a). THIS IS THE R4 BLOCKER'S CLAUSE: R4 recognised iframe creation only when the argument was a literal spelling "iframe", so \`const tag = 'iframe'\` walked straight past it and authored a Document the census cannot enter. Resolution -- not recognition -- decides here: a tag that folds (literal, concatenation, template, same-file alias) is judged as the FACT it folds to, and a tag that does not fold refuses, regardless of what it would have been at runtime.`,
              )
            } else {
              classifyTag(call as ts.CallExpression, tag, `\`${member}(...)\``)
            }
          }
        }

        // ---- attachShadow (any reference: called, aliased or bound) --------
        if (member === 'attachShadow') {
          push(
            node,
            'SHADOW-ROOT',
            'RESOLVED-ROUTE',
            'attachShadow opens an authoring space the census can only see by instrumenting this call before any mount runs, and a closed root is unreachable by design. The R2 audit killed the census with exactly this (an open root whose div.auditor-shadow-hud read position:fixed while the census returned zero surfaces). Refused as a REFERENCE, not as a call: to alias or bind a method you must first NAME it, and naming it is this. src/ has never used it; the ruling makes that permanent.',
          )
        }

        // ---- customElements (any reference) --------------------------------
        if (member === 'customElements') {
          push(
            node,
            'WEB-COMPONENT',
            'RESOLVED-ROUTE',
            '`customElements` is the custom-element registry, and every member of it (define, get, whenDefined, upgrade) exists to put an element on the page that builds its DOM imperatively and carries no React fiber -- so the census can name it only as UNINSPECTABLE. The whole registry is refused rather than the `define` call alone: refusing the NAME means the route cannot be aliased, because an alias must name it once. src/ has zero references.',
          )
        }

        // ---- contentDocument / contentWindow (AM5b) ------------------------
        if (member === 'contentDocument' || member === 'contentWindow') {
          push(
            node,
            'IFRAME',
            'RESOLVED-ROUTE',
            `.${member} is how a parent reaches into a child browsing context -- the exact move the R3 auditor's probe made to author a position:fixed HUD the census could not enumerate. The member name RESOLVES through the same folder as a tag, so \`frame['contentDoc' + 'ument']\` is this same fact (amendment AM5b).`,
          )
        }

        // ---- markup properties, ASSIGNED (AM2) -----------------------------
        if (member !== null && MARKUP_PROPERTIES.has(member)) {
          const assign = node.parent
          const isLhs =
            assign &&
            ts.isBinaryExpression(assign) &&
            assign.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            assign.left === node
          if (isLhs) {
            const rhs = (assign as ts.BinaryExpression).right
            const receiver = node.expression
            const origin = receiverOrigin(receiver, scope)
            if (origin === 'DOCUMENT-ROOT') {
              push(
                assign as ts.BinaryExpression,
                'BODY-PORTAL',
                'RESOLVED-ROUTE',
                `\`${member} =\` on a receiver that RESOLVES to a document root parses a string straight into the document root. R4 walked CallExpressions only, so this assignment form was neither refused nor census-visible (amendment AM2).`,
              )
            } else {
              const markup = resolveString(rhs, scope)
              if (markup === null) {
                push(
                  assign as ts.BinaryExpression,
                  'UNRESOLVED',
                  'UNRESOLVED-MARKUP',
                  `\`${member} =\` with markup that does NOT statically resolve to a string (amendment AM2). What this parses into is unknowable, and \`<iframe>\` is one of the things it could be. A resolved string is scanned for the routes it would mint; an unresolved one refuses.`,
                )
              } else {
                const route = routeForResolvedMarkup(markup)
                if (route) {
                  push(
                    assign as ts.BinaryExpression,
                    route,
                    'RESOLVED-ROUTE',
                    `\`${member} =\` with markup that RESOLVES to a string containing a ${route} tag. Parsing a route into existence is the same route (amendment AM2).`,
                  )
                }
              }
            }
          }
        }
      }

      // ---- customElements as a BARE GLOBAL --------------------------------
      // FOUND BY THE FIXTURE, NOT BY REASONING, and it was a real hole: the
      // clause above resolves the MEMBER name, so it caught `window
      // .customElements` (member "customElements") and sailed straight past
      // `customElements.define('auditor-hud', C)` -- where the member name is
      // "define" and the registry is a bare global identifier nothing looked
      // at. The R5 fixture's case 14 refused on `extends HTMLElement` alone and
      // the define() went unreported, which is exactly the "one clause happened
      // to fire on the same file" false comfort the tests are written by-code
      // to prevent. Refusing the NAME wherever it appears is what makes the
      // route unaliasable: `const r = customElements` names it too.
      if (
        ts.isIdentifier(node) &&
        node.text === 'customElements' &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !ts.isPropertySignature(node.parent) &&
        !ts.isPropertyAssignment(node.parent)
      ) {
        push(
          node,
          'WEB-COMPONENT',
          'RESOLVED-ROUTE',
          '`customElements` is the custom-element registry, and every member of it (define, get, whenDefined, upgrade) exists to put an element on the page that builds its DOM imperatively and carries no React fiber -- so the census can name it only as UNINSPECTABLE. The whole registry is refused rather than the `define` call alone: refusing the NAME means the route cannot be aliased, because an alias must name it once. src/ has zero references.',
        )
      }

      // =====================================================================
      // CALLS
      // =====================================================================
      if (ts.isCallExpression(node)) {
        const callee = node.expression

        // ---- a call through an UNRESOLVED computed member -------------------
        // `host[k]({ mode: 'open' })`. Which method is this? Unknowable --
        // attachShadow included. src/ has exactly two of these and both are
        // sanctioned BY NAME; that is what makes this rule affordable, and it
        // is what closes computed-callee aliasing structurally rather than by
        // adding another spelling.
        if (ts.isElementAccessExpression(callee) && resolveMemberName(callee, scope) === null) {
          push(
            node,
            'UNRESOLVED',
            'UNRESOLVED-CALLEE',
            'A call through a computed member whose NAME does not statically resolve. Which method runs is unknowable, so every bounded route is reachable through this one expression -- `host[k]({mode:\'open\'})` is attachShadow when k says so. Resolution decides, and this did not resolve.',
          )
        }

        const calleeName =
          ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? resolveMemberName(callee, scope)
            : ts.isIdentifier(callee)
              ? callee.text
              : null

        // ---- attach-family: the receiver decides (AM5c) ---------------------
        if (
          calleeName !== null &&
          ATTACH_METHODS.has(calleeName) &&
          (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
        ) {
          checkAttachReceiver(node, callee.expression, calleeName)
        }

        // ---- insertAdjacentHTML: the MARKUP also decides (AM2) --------------
        if (calleeName === 'insertAdjacentHTML') {
          const markup = node.arguments[1]
          const resolved = markup ? resolveString(markup, scope) : null
          if (resolved === null) {
            push(
              node,
              'UNRESOLVED',
              'UNRESOLVED-MARKUP',
              'insertAdjacentHTML() with markup that does NOT statically resolve to a string. What it parses into is unknowable, and `<iframe>` is one of the things it could be.',
            )
          } else {
            const route = routeForResolvedMarkup(resolved)
            if (route) {
              push(
                node,
                route,
                'RESOLVED-ROUTE',
                `insertAdjacentHTML() with markup that RESOLVES to a string containing a ${route} tag. Parsing a route into existence is the same route.`,
              )
            }
          }
        }

        // ---- createPortal ---------------------------------------------------
        if (calleeName === 'createPortal') {
          push(
            node,
            'BODY-PORTAL',
            'RESOLVED-ROUTE',
            'createPortal() authors DOM at a separate target. The census DOES see it (A4 membership is positioning over the whole document; R3 committed the portal RED/GREEN proof), and it is refused anyway: the ruling bounds the authoring space by law, not by what the current walk happens to reach. Only individually named portal sites in SANCTIONED_AUTHORING are accepted; another portal receives no inherited grant.',
          )
        }
      }

      // =====================================================================
      // JSX -- also a tag position
      // =====================================================================
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName
        const text = tagName.getText()
        if (/^[a-z][a-zA-Z0-9]*$/.test(text) && ts.isIdentifier(tagName)) {
          // An intrinsic element: the tag IS the text, resolved by definition.
          classifyTag(node, text, '<JSX> intrinsic element')
        } else if (ts.isIdentifier(tagName)) {
          // `const Tag = 'iframe'; <Tag />` renders an IFRAME -- React reads the
          // value, not the spelling. So the value must resolve.
          const folded = resolveString(tagName, scope)
          if (folded !== null) {
            classifyTag(node, folded, '<JSX> element whose tag identifier')
          } else if (isProvableComponent(tagName, scope)) {
            // ACCEPT PATH, named: the identifier provably holds a component (a
            // function, a class, a hook-wrapped arrow, or an import). React
            // renders a component's OUTPUT, and that output's own JSX is walked
            // by this same visitor. A component reference is not a tag.
          } else {
            push(
              node,
              'UNRESOLVED',
              'UNRESOLVED-TAG',
              'A JSX tag identifier that resolves to NEITHER a string nor a provable component. React renders a string-valued tag variable as a host element, so this position is a tag position: `const Tag = compute(); <Tag />` is `document.createElement(compute())` wearing angle brackets, and it refuses for the same reason (amendment AM5a).',
            )
          }
        } else if (!ts.isJsxNamespacedName(tagName)) {
          // `<Foo.Bar />` -- a member expression. Not a string tag (React never
          // treats one as a host element), so it is a component reference.
        }
      }

      // =====================================================================
      // A class that IS a custom element in all but the define()
      // =====================================================================
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
          for (const t of clause.types) {
            if (/^HTML[A-Za-z]*Element$/.test(t.expression.getText())) {
              push(
                clause,
                'WEB-COMPONENT',
                'RESOLVED-ROUTE',
                'A class extending an HTML element base is a custom element in all but the define() call -- refused at the same bar as the registry reference, so the route cannot be assembled one half at a time.',
              )
            }
          }
        }
      }

      // =====================================================================
      // A bare string that RESOLVES to "iframe", anywhere in src/
      // =====================================================================
      // This is what closes the CROSS-FILE tag hole, and it is the only clause
      // that judges a value rather than a site. `export const T = 'iframe'` in
      // one file and `<T />` in another is a route this lint would otherwise
      // never see, because no single file contains both halves. The string may
      // not be spelled in src/ at all -- 0 sites today, so the rule costs
      // nothing and cannot be routed around by moving the spelling somewhere
      // the walk does not look. A string that does NOT resolve cannot reach a
      // tag position either: every tag position above refuses on unresolved.
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        node.text.toLowerCase() === 'iframe' &&
        !isTagPositionArgument(node)
      ) {
        push(
          node,
          'IFRAME',
          'RESOLVED-ROUTE',
          'The string "iframe" is spelled in src/. Refused as a VALUE rather than at a call site, because a value crosses files and a call site does not: `export const T = \'iframe\'` here and `<T />` there is a second Document that no single-file walk would ever resolve. The tag positions refuse anything that does not resolve, and this refuses the one thing that does. src/ has never contained this string.',
        )
      }

      ts.forEachChild(node, visit)
    }

    visit(sf)
  }

  // ORDINAL DISAMBIGUATION, and it is load-bearing for exactly one reason:
  // BYTE-IDENTICAL statements can sit in one function. toolController.ts's
  // `overlayApply` calls `doc.append({ entities: r.entities, constraints:
  // r.constraints }, [])` THREE times in the same scope -- the linear/circular
  // pattern commit, the path-pattern commit and the offset commit. No name
  // derived from the source text can tell them apart, so without this they
  // share one key -- and ONE SANCTION WOULD COVER ALL THREE, which is amendment
  // A3's defect and the thing keyCollisions() exists to refuse.
  //
  // The ordinal is assigned in SOURCE ORDER and only where a key is not already
  // unique, so no key that was already injective changes shape. DISCLOSED
  // WEAKNESS: inserting a third identical statement BETWEEN two ordinalled ones
  // shifts the later one's suffix, and its sanction then points at a sibling.
  // That is a real cost, accepted over the alternative (a line number in every
  // key, which drifts on every unrelated commit above it); it is bounded to
  // duplicate-syntax-in-one-scope, and auditSanctions().stale fires the moment
  // the count changes.
  //
  // IT FIRED, exactly as written, on 2026-09-16. WO-1569 added the path-pattern
  // branch BETWEEN the original two: the offset commit went from `#2` to `#3`,
  // `#2`'s sanction came to point at its new sibling, and the tree carried an
  // unsanctioned `#3`. The sweep of main caught it; no per-order gate could,
  // because a failure already on main reads to them as a baseline failure. The
  // three sanctions now name their branches in prose, so the next shift is
  // readable rather than merely detectable.
  out.sort((a, b) => (a.key === b.key ? a.line - b.line : a.key.localeCompare(b.key)))
  const counts = new Map<string, number>()
  for (const v of out) counts.set(v.key, (counts.get(v.key) ?? 0) + 1)
  const seen = new Map<string, number>()
  for (const v of out) {
    if ((counts.get(v.key) ?? 0) < 2) continue
    const n = (seen.get(v.key) ?? 0) + 1
    seen.set(v.key, n)
    v.key = `${v.key}  #${n}`
  }
  return out.sort((a, b) => (a.key === b.key ? a.line - b.line : a.key.localeCompare(b.key)))
}

/** True when this literal is already being judged AS a tag by a clause above, so
 *  the value-level rule does not double-report it. Purely a de-duplication
 *  concern: both paths refuse. */
function isTagPositionArgument(node: ts.StringLiteralLike): boolean {
  const p = node.parent
  if (!p || !ts.isCallExpression(p)) return false
  const callee = p.expression
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : null
  return (name === 'createElement' || name === 'createElementNS') && p.arguments.includes(node)
}

/** ACCEPT-PATH RESOLUTION for a JSX tag identifier. True only when the name
 *  provably holds a component: a function/class declaration, an arrow or
 *  function expression, a hook/HOC-wrapped one (memo, forwardRef, useMemo,
 *  useCallback), or an import.
 *
 *  AN IMPORT COUNTS, and here is why that is not a hole: an imported name could
 *  in principle hold the string 'iframe', which React would render as a host
 *  element -- but the string 'iframe' cannot be spelled anywhere in src/ (the
 *  value-level clause above refuses it), and a string that does not resolve
 *  cannot reach this position either (a non-folding tag identifier that is not a
 *  provable component refuses here). The two clauses close each other's gap;
 *  neither is sufficient alone. */
function isProvableComponent(id: ts.Identifier, scope: FileScope): boolean {
  return isComponentValued(id, scope, 0)
}

/** Can this expression be proven to hold a component rather than a string tag?
 *  Every branch is a PROOF; the default is false, which refuses. */
function isComponentValued(expr: ts.Expression, scope: FileScope, depth: number): boolean {
  if (depth > MAX_FOLD_DEPTH) return false
  if (ts.isParenthesizedExpression(expr)) return isComponentValued(expr.expression, scope, depth + 1)
  if (ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return isComponentValued(expr.expression, scope, depth + 1)
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) return true
  // `const X = memo(...)` / `forwardRef(...)` / `useMemo(() => ..., [])`: a call
  // in a tag position returns a component. A call returning the STRING 'iframe'
  // would need that string spelled somewhere in src/, which is refused outright.
  if (ts.isCallExpression(expr)) return true
  // `rowIcon(id, kind) ?? Box` / `a || b` -- BOTH arms must prove out.
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isComponentValued(expr.left, scope, depth + 1) && isComponentValued(expr.right, scope, depth + 1)
  }
  // `cond ? A : B`
  if (ts.isConditionalExpression(expr)) {
    return (
      isComponentValued(expr.whenTrue, scope, depth + 1) && isComponentValued(expr.whenFalse, scope, depth + 1)
    )
  }
  if (ts.isElementAccessExpression(expr) || ts.isPropertyAccessExpression(expr)) {
    const container = expr.expression
    // `TOOL_ICONS[model.tool]` / `ICONS.line` -- a read out of a same-file map.
    // Resolved by reading EVERY value the map can yield: if all of them are
    // components, the read is a component whatever the key turns out to be. The
    // key never has to resolve, which is why this is a proof and not a guess.
    if (ts.isIdentifier(container)) {
      const cb = lookup(scope, container.text, container)
      if (cb?.kind === 'VALUE' && cb.init && isMapOfComponents(cb.init, scope, depth + 1)) return true
    }
    // `tool.icon` where `tool` is an element of a same-file array of tool
    // descriptors. Read the named property off every object the container can
    // be; all components => this read is a component.
    if (ts.isPropertyAccessExpression(expr)) {
      const objs = objectValues(container, scope, depth + 1)
      if (objs === null || objs.length === 0) return false
      return objs.every((o) => {
        const prop = o.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === expr.name.text)
        return !!prop && ts.isPropertyAssignment(prop) && isComponentValued(prop.initializer, scope, depth + 1)
      })
    }
    return false
  }
  if (ts.isIdentifier(expr)) {
    const b = lookup(scope, expr.text, expr)
    if (!b) return false
    if (b.kind === 'DECLARATION' || b.kind === 'IMPORT') return true
    if (b.kind === 'DESTRUCTURED' && b.element) {
      // `SECTIONS.map(({ icon: Icon }) => <Icon />)`. Follow the name back to
      // every value the destructuring can yield; if all of them are components,
      // so is this. Returns null when the chain cannot be followed -- which
      // refuses, like every other unresolved thing.
      const values = destructuredValues(b.element, scope, depth + 1)
      if (values === null || values.length === 0) return false
      return values.every((v) => isComponentValued(v, scope, depth + 1))
    }
    if (b.kind !== 'VALUE' || !b.init) return false
    return isComponentValued(b.init, scope, depth + 1)
  }
  return false
}

/** Every value a destructured name can hold, or null when the chain runs out.
 *
 *  Handles the one shape this tree actually uses: a property pulled out of the
 *  callback parameter of an array iteration -- `X.map(({ icon: Icon }) => ...)`.
 *  It walks BindingElement -> pattern -> parameter -> arrow -> the .map() call
 *  -> the array being iterated, resolves that array's elements, and reads the
 *  named property off each one. Nesting works because the array expression is
 *  itself resolved through `objectValues`, so `section.tools.map(...)` inside
 *  `SECTIONS.map(...)` resolves both hops.
 *
 *  Every unhandled shape returns null. That is the point: this function makes
 *  the resolver more PRECISE, never more permissive -- a chain it cannot follow
 *  is a refusal, exactly as before this function existed. */
function destructuredValues(el: ts.BindingElement, scope: FileScope, depth: number): ts.Expression[] | null {
  if (depth > MAX_FOLD_DEPTH) return null
  const propName = (el.propertyName ?? el.name)
  if (!ts.isIdentifier(propName)) return null
  const pattern = el.parent
  if (!ts.isObjectBindingPattern(pattern)) return null
  const param = pattern.parent
  if (!ts.isParameter(param)) return null
  const fn = param.parent
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null
  const call = fn.parent
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null
  if (!['map', 'flatMap', 'forEach', 'filter'].includes(call.expression.name.text)) return null

  const elements = arrayElements(call.expression.expression, scope, depth + 1)
  if (elements === null) return null
  const out: ts.Expression[] = []
  for (const e of elements) {
    const obj = unwrap(e)
    if (!ts.isObjectLiteralExpression(obj)) return null
    const prop = obj.properties.find(
      (p) => p.name && ts.isIdentifier(p.name) && p.name.text === propName.text,
    )
    // A missing property is not "no value" -- it is a value this walk cannot
    // see. Refuse rather than skip.
    if (!prop || !ts.isPropertyAssignment(prop)) return null
    out.push(prop.initializer)
  }
  return out
}

function unwrap(e: ts.Expression): ts.Expression {
  let n = e
  while (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) n = n.expression
  return n
}

/** The element expressions of an array-valued expression, or null. Follows
 *  identifiers to their same-file array literal and property reads to the arrays
 *  held on same-file object literals (`section.tools`). */
function arrayElements(expr: ts.Expression, scope: FileScope, depth: number): ts.Expression[] | null {
  if (depth > MAX_FOLD_DEPTH) return null
  const e = unwrap(expr)
  if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => x)
  if (ts.isIdentifier(e)) {
    const b = lookup(scope, e.text, e)
    if (b?.kind === 'VALUE' && b.init) return arrayElements(b.init, scope, depth + 1)
    if (b?.kind === 'DESTRUCTURED' && b.element) {
      const vals = destructuredValues(b.element, scope, depth + 1)
      if (!vals || vals.length !== 1) return null
      return arrayElements(vals[0], scope, depth + 1)
    }
    return null
  }
  if (ts.isPropertyAccessExpression(e)) {
    // `section.tools` where `section` is itself a destructured element.
    const objs = objectValues(e.expression, scope, depth + 1)
    if (objs === null) return null
    const out: ts.Expression[] = []
    for (const o of objs) {
      const prop = o.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === e.name.text)
      if (!prop || !ts.isPropertyAssignment(prop)) return null
      const inner = arrayElements(prop.initializer, scope, depth + 1)
      if (inner === null) return null
      out.push(...inner)
    }
    return out
  }
  return null
}

/** Every object literal an expression can evaluate to, or null. */
function objectValues(expr: ts.Expression, scope: FileScope, depth: number): ts.ObjectLiteralExpression[] | null {
  if (depth > MAX_FOLD_DEPTH) return null
  const e = unwrap(expr)
  if (ts.isObjectLiteralExpression(e)) return [e]
  if (ts.isIdentifier(e)) {
    const b = lookup(scope, e.text, e)
    if (b?.kind === 'VALUE' && b.init) return objectValues(b.init, scope, depth + 1)
    // `SECTIONS.map((section) => ...)` / `section.tools.map((tool) => ...)`:
    // the callback's parameter IS each element of the iterated array.
    if (b?.kind === 'PARAMETER' && b.param) {
      const els = iteratedElements(b.param, scope, depth + 1)
      if (els === null) return null
      const out: ts.ObjectLiteralExpression[] = []
      for (const el of els) {
        const o = unwrap(el)
        if (!ts.isObjectLiteralExpression(o)) return null
        out.push(o)
      }
      return out
    }
    return null
  }
  return null
}

/** The elements of the array an iteration callback is iterating, for a parameter
 *  of that callback. Null for a parameter that is not one -- an ordinary
 *  function parameter is caller-supplied and stays UNRESOLVED. */
function iteratedElements(param: ts.ParameterDeclaration, scope: FileScope, depth: number): ts.Expression[] | null {
  if (depth > MAX_FOLD_DEPTH) return null
  const fn = param.parent
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null
  const call = fn.parent
  if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null
  if (!['map', 'flatMap', 'forEach', 'filter'].includes(call.expression.name.text)) return null
  return arrayElements(call.expression.expression, scope, depth + 1)
}

/** An object/array literal whose EVERY value is a provable component. A single
 *  unreadable entry makes the whole map unprovable -- the key is never resolved,
 *  so one bad value poisons every read of it. */
function isMapOfComponents(expr: ts.Expression, scope: FileScope, depth: number): boolean {
  if (depth > MAX_FOLD_DEPTH) return false
  if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return isMapOfComponents(expr.expression, scope, depth + 1)
  }
  if (ts.isObjectLiteralExpression(expr)) {
    if (expr.properties.length === 0) return false
    return expr.properties.every(
      (p) => ts.isPropertyAssignment(p) && isComponentValued(p.initializer, scope, depth + 1),
    )
  }
  if (ts.isArrayLiteralExpression(expr)) {
    if (expr.elements.length === 0) return false
    return expr.elements.every((e) => isComponentValued(e, scope, depth + 1))
  }
  return false
}

/** Violations MINUS the sanctioned list. This is what the gate asserts is empty
 *  over the product tree. */
export function refusedViolations(files: string[], srcRoot: string): AuthoringViolation[] {
  const sanctioned = new Set(SANCTIONED_AUTHORING.map((s) => s.key))
  return lintAuthoringSpace(files, srcRoot).filter((v) => !sanctioned.has(v.key))
}

// ---------------------------------------------------------------------------
// 6. The committed sanctions artifact
// ---------------------------------------------------------------------------

/** The WO requires the sanctioned list be documented entry by entry. This renders
 *  it MECHANICALLY from SANCTIONED_AUTHORING, and the gate holds the committed
 *  file byte-for-byte against this output -- the same discipline (and the same
 *  reason) as A3's OVERLAY-RUNTIME-KEYS.md, which the R2 audit failed this WO
 *  for claiming and not publishing. A hand-maintained copy of a list that lives
 *  in code is a list that silently disagrees with it. */
export function renderSanctionsArtifact(sanctions: readonly SanctionedAuthoring[] = SANCTIONED_AUTHORING): string {
  const lines: string[] = [
    '# UI-70 -- the SANCTIONED authoring routes (DECISIONS 2026-07-17)',
    '',
    'GENERATED FILE. Do not edit by hand: it is rendered from `SANCTIONED_AUTHORING`',
    'in `src/tests/ui/support/overlayAuthoringLint.ts` and gated byte-for-byte, so a',
    'hand edit fails the gate rather than changing anything. Regenerate with:',
    '',
    '```',
    'UI70_WRITE_SANCTIONS=1 npx vitest run src/tests/ui/overlayAuthoringLint.test.ts',
    '```',
    '',
    'WHAT THIS IS. The DECISIONS 2026-07-17 ruling bounds the overlay AUTHORING',
    'SPACE by law: in-viewport floating surfaces are authored only through the',
    'routes this codebase already uses. R5 rebuilt the lint as a POSITIVE,',
    'FAIL-CLOSED recognizer: at every site where a bounded route could be reached,',
    'the deciding value (a tag, a member name, a receiver origin, a markup string)',
    'must statically RESOLVE, and anything that does not resolve REFUSES as route',
    '`UNRESOLVED`. There is no list of forbidden spellings in the verdict path.',
    'This file is the complete list of exceptions -- every place the current tree',
    'trips that bound anyway.',
    '',
    'Shadow roots and web components have zero sanctioned sites. The only iframe',
    'is the hidden zero-size print document, named at all three access routes and',
    'guarded by the production print/afterprint recipe in overlayGatePair.',
    '',
    'WHAT IS OUT OF SCOPE, stated rather than silently absent (preflight AM3):',
    '`eval`/`new Function` exist in this tree only for MODULE-LOAD indirection',
    '(meshLabWorker.ts, and the dynamic import of manifold-3d) and never construct',
    'DOM, so no clause names them. `DOMParser` (svgImporter.ts, threeMf.ts)',
    'produces a DETACHED Document that is never attached to the live DOM here; if a',
    'parsed fragment were ever adopted via importNode/appendChild, the attach-family',
    'clause already refuses that call regardless of the node\'s origin, so no',
    'separate DOMParser clause is needed.',
    '',
    '`authors out of flow` is the column that matters. It is the claim a sanction',
    'would have to lie about in order to smuggle a real overlay past the lint, so',
    'it is re-derived from the source by `auditSanctions()` and gated, not trusted.',
    'So is every entry in `claims` -- the R4 audit found two sanctions whose PROSE',
    'said "display:none" at sites that set no such thing, which is exactly what',
    'happens to a claim nothing checks.',
    '',
  ]

  const byRoute = new Map<RefusedRoute, SanctionedAuthoring[]>()
  for (const s of sanctions) {
    const list = byRoute.get(s.route) ?? []
    list.push(s)
    byRoute.set(s.route, list)
  }

  for (const route of ['SHADOW-ROOT', 'IFRAME', 'WEB-COMPONENT', 'BODY-PORTAL', 'UNRESOLVED'] as RefusedRoute[]) {
    const list = (byRoute.get(route) ?? []).slice().sort((a, b) => a.key.localeCompare(b.key))
    lines.push(`## ${route} -- ${list.length} sanctioned site${list.length === 1 ? '' : 's'}`, '')
    if (list.length === 0) {
      lines.push('NONE. This route has zero sites in `src/`, so the sanctioned list is empty and', 'the lint refuses it outright.', '')
      continue
    }
    for (const s of list) {
      lines.push(
        `### \`${s.key}\``,
        '',
        `- **authors out of flow:** ${s.authorsOutOfFlow ? 'YES' : 'no'}`,
        `- **mechanical claims (re-derived by auditSanctions):** sets display:none = ${s.claims.setsDisplayNone ? 'YES' : 'no'}; removes the node it authors = ${s.claims.removesNode ? 'YES' : 'no'}`,
        `- **why it is sanctioned:** ${s.reason}`,
        `- **what the census does about it:** ${s.censusStatus}`,
        '',
      )
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

// ---------------------------------------------------------------------------
// 7. The sanctions are themselves gated
// ---------------------------------------------------------------------------

export interface SanctionAudit {
  /** A sanction naming a site that no longer exists. The A2 exemption discipline,
   *  applied to the lint: an allowlist nobody prunes becomes an allowlist that
   *  permits things nobody has read. */
  stale: string[]
  /** A sanction claiming `authorsOutOfFlow: false` at a site whose source sets an
   *  out-of-flow position. This is the one that matters: it is how a sanction
   *  would be used to smuggle a real overlay past the lint. */
  understated: string[]
  /** A sanction whose key matches MORE THAN ONE site -- i.e. one grant covering
   *  two authoring sites, so a second site rides in on the first's reason. This
   *  is amendment A3's defect wearing an allowlist, and it was REAL here before
   *  the useCallback hop landed (see enclosingName). */
  ambiguous: string[]
  /** THE R4 MINOR'S FIX, generalised. A sanction whose `claims` disagree with the
   *  source they describe -- in EITHER direction. R4 found two sanctions whose
   *  prose claimed display:none at sites that set none; prose is not a claim, so
   *  the behaviours a sanction's reasoning rests on now live in `claims` where
   *  this re-derives them. */
  falseClaims: string[]
}

/** Keys that name more than one site anywhere in the scanned set. A key is only
 *  useful if it is injective -- the census learned this the expensive way (A3)
 *  and the lint does not get to relearn it. */
export function keyCollisions(files: string[], srcRoot: string): string[] {
  const counts = new Map<string, number>()
  for (const v of lintAuthoringSpace(files, srcRoot)) counts.set(v.key, (counts.get(v.key) ?? 0) + 1)
  return [...counts.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k}  (${n} sites)`).sort()
}

const OUT_OF_FLOW_SOURCE = /position\s*[:=]\s*['"`]?\s*(absolute|fixed|sticky)/

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Does the scope set `display:none` ON THE NODE THIS SITE AUTHORS?
 *
 *  ANCHORED TO THE NODE'S OWN NAME, and that is not a detail -- it is the whole
 *  difference between a claim and a coincidence. The first cut of this check
 *  regexed the enclosing scope for /display\s*[:=]\s*none/ and reported that
 *  svgImporter's measurement host is display:none. IT IS NOT: it is
 *  visibility:hidden, and the match came from a COMMENT twenty lines further
 *  down about skipping display:none subtrees in the imported artwork. A
 *  scope-wide regex would have "verified" the exact false claim the R4 audit
 *  raised this MINOR about. So the claim is anchored: `a.style.display = 'none'`
 *  or a cssText carrying it, on the node named at the append. */
function claimSetsDisplayNone(scopeText: string, node: string | null): boolean {
  if (!node) return false
  const n = escapeRe(node)
  if (new RegExp(`\\b${n}\\.style\\.display\\s*=\\s*['"\`]\\s*none`).test(scopeText)) return true
  const cssText = new RegExp(`\\b${n}\\.style\\.cssText\\s*=\\s*([^\\n]*)`).exec(scopeText)
  return !!cssText && /display\s*:\s*none/.test(cssText[1])
}

/** Does the scope dispose THE NODE THIS SITE AUTHORS? Anchored the same way, for
 *  the same reason: `.remove()` somewhere in a 200-line constructor says nothing
 *  about the canvas that constructor appended. */
function claimRemovesNode(scopeText: string, node: string | null): boolean {
  if (!node) return false
  const n = escapeRe(node)
  return (
    new RegExp(`\\b${n}\\.remove\\(\\)`).test(scopeText) ||
    new RegExp(`removeChild\\(\\s*${n}\\s*\\)`).test(scopeText)
  )
}

/** What a site's claims are re-derived FROM: the enclosing function's source,
 *  and the name of the node the site authors (the appended argument, or the
 *  receiver of a markup assignment). Null when the site is not found, which the
 *  caller treats as STALE rather than as "no claim to check". */
interface SiteFacts {
  scopeText: string
  /** The authored node's identifier, or null when the site authors no named node
   *  (a JSX tag, a computed callee). A null node makes every node-anchored claim
   *  FALSE rather than unchecked -- there is nothing to claim about. */
  authoredName: string | null
}

/** The identifier of the node a site authors, read off the site's own syntax.
 *
 *  THE ExpressionStatement UNWRAP IS LOAD-BEARING, and it was found by watching
 *  this check report `false` for MeshLabPage's `a.style.display = 'none'` -- a
 *  line that is right there in the source. This repo omits semicolons, so an
 *  ExpressionStatement's text is BYTE-IDENTICAL to the CallExpression inside it,
 *  both match the site key, and the statement is visited first. Without the
 *  unwrap every append site resolved to "authors no named node", every
 *  node-anchored claim silently became false, and the gate would have been
 *  perfectly green while checking nothing -- a probe that cannot fail, arriving
 *  by accident in the very check written to stop one. */
function authoredNodeName(node: ts.Node): string | null {
  if (ts.isExpressionStatement(node)) return authoredNodeName(node.expression)
  if (ts.isCallExpression(node)) {
    const arg = node.arguments[0]
    return arg && ts.isIdentifier(arg) ? arg.text : null
  }
  if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left)) {
    const recv = node.left.expression
    return ts.isIdentifier(recv) ? recv.text : null
  }
  return null
}

function siteFacts(s: SanctionedAuthoring, files: string[], srcRoot: string): SiteFacts | null {
  const hit = lintAuthoringSpace(files, srcRoot).find((v) => v.key === s.key)
  if (!hit) return null
  const file = path.join(srcRoot, hit.file)
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file))
  // The ordinal suffix lintAuthoringSpace appends to duplicate keys is not part
  // of any node's own text, so it is stripped before matching. The scope is the
  // same for every duplicate in one function by construction -- that is what
  // made them duplicates -- so re-deriving a claim against the first match is
  // the same answer as against the nth.
  const bareKey = s.key.replace(/ {2}#\d+$/, '')
  let facts: SiteFacts | null = null
  const visit = (node: ts.Node): void => {
    if (facts !== null) return
    if (`${hit.file}:${enclosingName(node)} > ${snippetOf(node, sf)}` === bareKey) {
      const authoredName = authoredNodeName(node)
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        if (
          ts.isFunctionDeclaration(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isFunctionExpression(n) ||
          ts.isArrowFunction(n)
        ) {
          facts = { scopeText: n.getText(sf), authoredName }
          return
        }
      }
      facts = { scopeText: sf.getText(), authoredName }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return facts
}

/** Re-derives every sanction's claims from the source it points at. Called by the
 *  gate; separated so its failure names WHICH claim broke, not merely that one
 *  did. */
export function auditSanctions(files: string[], srcRoot: string): SanctionAudit {
  const found = lintAuthoringSpace(files, srcRoot)
  const foundKeys = new Set(found.map((v) => v.key))
  const stale = SANCTIONED_AUTHORING.filter((s) => !foundKeys.has(s.key)).map((s) => s.key)

  const ambiguous = SANCTIONED_AUTHORING.filter(
    (s) => found.filter((v) => v.key === s.key).length > 1,
  ).map((s) => `${s.key}  (${found.filter((v) => v.key === s.key).length} sites share this ONE sanction)`)

  const understated: string[] = []
  const falseClaims: string[] = []
  for (const s of SANCTIONED_AUTHORING) {
    if (!foundKeys.has(s.key)) continue // already STALE; nothing to re-derive.
    const facts = siteFacts(s, files, srcRoot)
    if (facts === null) continue
    if (!s.authorsOutOfFlow && OUT_OF_FLOW_SOURCE.test(facts.scopeText)) understated.push(s.key)
    // BOTH DIRECTIONS. A claim is a claim whichever way it points, and an
    // OVERSTATED "we remove it" is exactly as false as an understated one. This
    // is what makes `claims` a gate rather than a comment -- and it earned its
    // keep on its first run by refusing four entries in this very list that the
    // author had written from memory instead of from the source.
    const setsDisplayNone = claimSetsDisplayNone(facts.scopeText, facts.authoredName)
    if (setsDisplayNone !== s.claims.setsDisplayNone) {
      falseClaims.push(
        `${s.key}  -- claims setsDisplayNone: ${s.claims.setsDisplayNone}, source says ${setsDisplayNone}`,
      )
    }
    const removesNode = claimRemovesNode(facts.scopeText, facts.authoredName)
    if (removesNode !== s.claims.removesNode) {
      falseClaims.push(`${s.key}  -- claims removesNode: ${s.claims.removesNode}, source says ${removesNode}`)
    }
  }

  return { stale, understated, ambiguous, falseClaims }
}
