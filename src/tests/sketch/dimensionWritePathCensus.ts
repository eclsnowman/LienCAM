// WO UI-50C-R2 (DECISIONS 2026-07-16 STOP, requirement 1): "the census DOMAIN
// is itself a hand list" was the exact failure the preflight caught in the
// WO-as-drafted. This is the re-cut: DERIVED BY WHAT a site does (every
// place across BOTH hosts that constructs, ingests, or rewrites a Sketch
// `dimensions` array), not by a hand-picked WHERE.
//
// WO UI-50C-R3 (audit FAIL, MAJOR 1): the R2 census swept ONE LINE per site
// (`dimensions:\s*s\.activeSketch!\.dimensions\.map\(\(d\)\s*=>\s*$`) and
// bundled five textually-identical-on-line-one sites under that single
// pattern. A brand-new site sharing that same first line but a DIFFERENT
// map body (`auditScratchRewriteDimensions`, the exact adversarial shape the
// R2 audit's own probe used: `.map((d) => ({ ...d, driving: true }))`)
// matched the same regex and went GREEN. The fix keyed each site by its
// NEAREST NAMED enclosing function PLUS the COMPLETE text of the containing
// assignment -- not just its first line.
//
// WO UI-50C-R4 (audit MAJOR, second bounce of the same root cause: "guard the
// forms you were told about, miss the siblings"): R3's extractor recognized
// exactly TWO syntactic forms -- an object-literal `dimensions:` property
// assignment and a dotted `x.dimensions =` assignment. A THIRD form (element-
// access assignment, a mutating method call, an index assignment, a string-
// literal object key, or a computed property key) returned ZERO hits and so
// was never named, never red. The STOP ruling for this re-cut REJECTED
// "extend the two branches" (the same guard-what-you-know-about class) in
// favor of a fail-closed CATCH-ALL: `sweepUnrecognizedDimensionsSites` below
// treats every occurrence of the identifier or string literal `dimensions`
// in a scanned file as UNSAFE unless it is POSITIVELY classified as one of:
// a recognized extracted hit (`extractDimensionWriteHits`, now THREE forms --
// object-literal property, dotted assignment, and element-access assignment
// `x["dimensions"] = ...` / `x['dimensions'] = ...`), a pure READ, a type/
// interface position, a local BINDING position (a variable declaration,
// parameter, or destructuring binding actually named `dimensions` -- the two
// real sites today are both `const dimensions =` in `src/store/index.ts`'s
// onmessage branches), or an explicit KNOWN_SAFE_DIMENSIONS_SITES entry.
// Everything else -- an assignment-target chain member (`s.dimensions.length
// = 0`, `s.dimensions[0].value = 5`), a `delete` operand, a call to any
// method on a `dimensions` receiver that is NOT on the KNOWN-PURE allowlist
// (map/filter/find/some/every/slice/concat/flatMap/includes/indexOf/reduce/
// join/toSorted/toReversed/toSpliced/with -- `.push`/`.splice`/an unknown
// method/`dimensions.length = 0` all fail RED, never assumed pure), a
// shorthand object-literal property, an accessor declaration, or ANY string-
// literal 'dimensions' occurrence used as an object key (plain or computed)
// or an Object.defineProperty/Reflect.set argument -- fails the census RED
// as UNRECOGNIZED_DIMENSIONS_FORM naming file, line, enclosing function, and
// the specific role that tripped it. Index-assignment (`dimensions[0] =
// forged`) and mutating-call forms (`dimensions.push(forged)`) are
// deliberately NOT promoted to recognized extraction (zero production sites
// use them and repo doctrine is immutable updates) -- the catch-all hard-
// refuses them instead, which is sufficient: it names them RED with no
// dependency on knowing that exact shape in advance.
//
// WO UI-50C-R5 (audit BLOCKER, a fourth silent absence the fail-closed
// catch-all's own write-target check missed): a destructuring-ASSIGNMENT
// target (`[s.dimensions] = ...`, `({ d: s.dimensions } = ...)`, and
// arbitrarily nested combinations of the two) and a for-of/for-in
// assignment target (`for (s.dimensions of chunks) {}`) are BOTH part of the
// `write-target` role above -- `roleFromReferenceChain` now climbs through
// the ArrayLiteralExpression / ObjectLiteralExpression / PropertyAssignment /
// ShorthandPropertyAssignment / SpreadElement wrapper nodes a destructuring
// pattern builds on top of a `dimensions` reference, and separately checks a
// ForOfStatement/ForInStatement's `initializer`. A destructuring-BINDING
// (`const [dimensions] = arr`) is a structurally different node kind
// (ArrayBindingPattern/BindingElement, never reached by this climb) and
// stays classified `binding`, as before.
//
// The KNOWN_SAFE_DIMENSIONS_SITES list is the ONE escape hatch, and it is
// deliberately narrow: an entry may classify ONLY an occurrence whose own
// structural role is a bare read or a local binding -- the sweep's code path
// never even CONSULTS this list for an assignment-target chain, a delete
// operand, a mutating-or-unknown-method receiver, a shorthand property, an
// accessor declaration, or any string-literal key/argument occurrence, so an
// entry cannot be used to launder a real write-context site (see the
// adversarial 'known-safe list cannot absorb a write-context site' test in
// the companion test file, which adds exactly such an entry and confirms the
// site still reports RED). It is empty today: both real local-binding sites
// are classified automatically by AST shape (a VariableDeclaration named
// `dimensions`), so neither needs an explicit entry -- the list exists, and
// is tested, as a bounded mechanism for a future ambiguous case, not because
// today's derived files need it.
//
// Mirrors the committed precedent (`src/components/model3d/debugSceneCensus.ts`
// + `src/tests/model3d/SolidsWorkbenchPage.stateCensus.test.ts`): the
// companion test `src/tests/sketch/dimensionWritePathCensus.test.ts` calls
// `extractDimensionWriteHits` against each file below for every recognized
// AST site and `sweepUnrecognizedDimensionsSites` for everything the
// recognized extraction does NOT claim, requiring the former to match
// EXACTLY ONE census entry and the latter to return zero sites for the real
// derived files (zero matches on the recognized side is an unclassified RED
// failure naming the file, line, function, and text; more than one is an
// AMBIGUOUS RED failure; any catch-all site is itself a RED failure).
//
// SCOPE (stated once, honestly): the mechanical reach covers every
// `dimensions:` object-literal property, every `.dimensions =` / `x
// ["dimensions"] =` assignment, and (via the catch-all) every OTHER
// occurrence of the identifier or string literal `dimensions` that is a
// write-target, a delete operand, a mutating-or-unrecognized method call, a
// shorthand property, or a string-literal key/argument, in the DERIVED_FILES
// below (a real parse, not a text scan -- comments cannot forge or hide a
// hit). Three classes remain genuinely invisible to a syntactic parse and
// are NOT covered even by the catch-all (a real gap, not a silent one):
//   - DYNAMIC computed-property names, `obj[expr]` where `expr` is not a
//     string/no-substitution-template literal (e.g. `obj[someVariable]`) --
//     the sweep cannot know at parse time whether `someVariable` evaluates
//     to the string "dimensions".
//   - ALIASING: `const dims = s.activeSketch!.dimensions; dims.push(forged)`
//     -- once the reference is rebound to a name other than `dimensions`,
//     no occurrence of the identifier `dimensions` exists at the mutation
//     site for either the recognized extraction or the catch-all to see.
//   - ARGUMENT-POSITION escape: a callee that mutates a `dimensions` array
//     passed to it as a plain argument (`foo(s.activeSketch!.dimensions)`)
//     is, by design, classified as a READ at the call site (the sweep has
//     no way to know whether `foo` mutates its argument without a type
//     checker / call-graph analysis it deliberately does not attempt).
// Two real document boundaries have NO `dimensions:`/`.dimensions =` literal
// at their call site at all (the write forwards a WHOLE Sketch/Project
// object by reference) and so cannot be swept mechanically -- documented in
// NAMED_RULINGS at the bottom for a human reader, exactly like the
// precedent's own "composite child-hook results" carve-out:
//   - CAM undo/redo (src/store/index.ts `undo`/`redo`): `activeSketch:
//     prevSketch` / `nextSketch` restores a WHOLE prior Project/Sketch
//     snapshot captured by `pushHistory()`.
//   - Workbench undo/redo (`workbenchSketchDocumentPort.ts`'s
//     `SketchStepCommand`): `dag.setPayload(this.id, this.before)` restores
//     a WHOLE prior dag node payload captured by `openStepNow()`.
// Both are ruled NAMED-INERT below, not left silent.
//
// The two REAL document-ingestion boundaries the two-bounce STOP named
// (`sketchSessionStore.begin` and the workbench debug-scene restore) used to
// be swept mechanically because each carried an explicit `dimensions:
// normalizeReferenceOnlyDriving(...)` key. WO-1858 removed that guard (a
// driving chamfer setback pair is a legitimate document state), and with it
// the debug-scene restore pass that existed only to call it -- so
// SolidsWorkbenchPage.tsx now names no `dimensions:` write at all and is
// ruled in NAMED_RULINGS below instead.

import ts from 'typescript'

/** Every file this census's mechanical sweep reads. Relative to this file's
 *  own directory is NOT how the test resolves them -- see the test's own
 *  `new URL(...)` calls, which are relative to the TEST file's location
 *  (this module and its companion test live side by side, so both resolve
 *  identically). */
export const DERIVED_FILES = [
  'src/store/index.ts',
  'src/components/model3d/workbench/workbenchSketchDocumentPort.ts',
  'src/components/model3d/workbench/workbenchOverlaysPort.ts',
  'src/components/model3d/workbench/sketchSessionStore.ts',
  'src/components/model3d/SolidsWorkbenchPage.tsx',
] as const

// WO-1858 retired the invariant this census was originally built to guard:
// a d1xd2 chamfer setback pair CAN drive the solver now, so there is no
// `normalizeReferenceOnlyDriving` for a write path to route through and no
// "forged driving:true" state to normalize. What the census still does --
// and why it survives the retirement rather than being deleted with the
// guard -- is name, DERIVED from the real source, every place either host
// builds or ingests a Sketch `dimensions` array. That derived list is what
// any FUTURE document invariant gets attached to; the classes below say what
// each site does, not which guard it happens to call.
export type CensusClass =
  /** Constructs a NEW dimensions array that includes tool/caller-supplied
   *  entries never covered by a per-dimension commit/toggle guard. */
  | 'insert'
  /** Replaces the WHOLE dimensions array with a tool-supplied one (trim /
   *  fillet / chamfer MODIFY results). */
  | 'replace'
  /** A per-dimension `.map()` mutation confined by its OWN enclosing
   *  function: commitDimensionValue / setDimensionValue /
   *  toggleDimensionDriving each write exactly one named dimension's
   *  value/driving state, after that function's own refusals have run. */
  | 'edit'
  /** toggleDimensionDriving's driving -> reference direction, which also
   *  snaps the now-reference dimension to its measured value (both halves,
   *  for the two-valued chamfer setback pair). */
  | 'toggle-to-reference'
  /** Rewrites only `labelAnchor` (display-only) -- never touches
   *  value/driving/kind, so it cannot violate the reference-only invariant. */
  | 'label-inert'
  /** WO SKC-56: a label-drag write that CONDITIONALLY also rewrites `value`
   *  (and, since SKC-58B, the `reverseB` orientation) -- ONLY for an 'angle'
   *  dimension whose anchor just crossed into a DIFFERENT sector
   *  (angleLabelDragValueOverride returns non-null only in that case; a plain
   *  move or any non-angle dim spreads `null`, a no-op). The new value and
   *  reverseB are selectAngleSector's own signed candidate + reversed-operand
   *  orientation for the anchor's CURRENT sector -- never a caller-supplied or
   *  forged number -- so this is a deliberate, narrowly-scoped sector-crossing
   *  write, not a weakening of the reference-only/label-inert guards those
   *  classes cover. */
  | 'label-value-conditional'
  /** A pure filter/remove (delete cascade) -- never introduces or mutates a
   *  surviving dimension. */
  | 'cascade-inert'
  /** A value-only rewrite via `remeasureReferenceDimensions`, which touches
   *  REFERENCE dimensions only (a driving one holds its own value) -- never
   *  an independent ingestion. */
  | 'remeasure-inert'
  /** Resurrects ids that were ALREADY persisted (a solver-conflict revert
   *  restoring a pre-apply value/driving state, or a filter removing a
   *  rejected placement) -- never a fresh ingestion. */
  | 'revert-inert'
  /** Forwards a caller-built dimensions array one hop downstream to a write
   *  path this census already names (`workbenchSketchDocumentPort.replace`)
   *  -- the disposition lives at the receiving end, not this call site. */
  | 'passthrough-inert'

export interface CensusEntry {
  id: string
  file: (typeof DERIVED_FILES)[number]
  /** The nearest NAMED function enclosing this site (walking OUTWARD past
   *  anonymous callbacks like Zustand's `set((s) => ({...}))`, which have no
   *  name of their own, to the named action/method/function they are
   *  lexically defined inside). A brand-new differently-named function that
   *  reuses an existing site's exact body text does NOT match this entry --
   *  this is the "site-unique" axis (WO UI-50C-R3 MAJOR 1). */
  enclosingFunction: string
  /** The EXACT normalized (comments stripped, whitespace collapsed) text of
   *  the complete object-literal expression containing the `dimensions:`
   *  property (or, for a bare `.dimensions =` / element-access assignment,
   *  the complete enclosing statement) -- not merely the first line. An
   *  existing function whose body is mutated into an unsafe rewrite produces
   *  DIFFERENT text and no longer matches -- this is the "semantics-aware"
   *  axis (WO UI-50C-R3 MAJOR 1). */
  text: string
  class: CensusClass
  note: string
}

/** One AST-located `dimensions:` / `.dimensions =` / `x["dimensions"] =`
 *  site -- the THREE forms `extractDimensionWriteHits` promotes to
 *  first-class recognized extraction. */
export interface DimensionWriteHit {
  file: string
  line: number
  enclosingFunction: string
  text: string
}

/** Why a site failed the catch-all sweep -- never a claim that the SITE is
 *  necessarily an active bug, only that it is not one of the positively-safe
 *  shapes the sweep recognizes (recognized extraction, pure read, type
 *  position, local binding, or an explicit known-safe entry). */
export type UnrecognizedDimensionsRole =
  | 'write-target'
  | 'delete-operand'
  | 'mutating-call'
  | 'shorthand-property'
  | 'accessor-declaration'
  | 'string-literal-key'
  | 'string-literal-arg'
  | 'string-literal-other'

/** One site the catch-all sweep flags RED as UNRECOGNIZED_DIMENSIONS_FORM:
 *  a `dimensions` occurrence not positively classified as a recognized
 *  extracted hit, a pure read, a type position, a local binding, or an
 *  explicit KNOWN_SAFE_DIMENSIONS_SITES entry. */
export interface UnrecognizedDimensionsSite {
  file: string
  line: number
  enclosingFunction: string
  text: string
  role: UnrecognizedDimensionsRole
}

/** A bounded escape hatch: an entry may classify ONLY an occurrence whose
 *  OWN structural role is a bare read or a local binding -- the sweep's code
 *  never consults this list for any of the UnrecognizedDimensionsRole
 *  categories above (those are hard-flagged unconditionally, see
 *  `sweepUnrecognizedDimensionsSites`), so an entry here can never launder a
 *  real write-context site. Keyed by the same (file, enclosingFunction,
 *  normalized text) triple as CensusEntry -- no line numbers, no wildcards,
 *  no whole-file entries. */
export interface KnownSafeSite {
  id: string
  file: (typeof DERIVED_FILES)[number]
  enclosingFunction: string
  text: string
  reason: string
}

function stripCommentsAndNormalize(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The name a function-like node is bound to, or null if it is anonymous
 *  (a bare callback argument with no binding of its own). */
function namedOf(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return fn.name.text
  const p = fn.parent
  if (p === undefined) return null
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text
  if (
    ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(p.left)
  ) return p.left.name.text
  return null
}

/** Nearest NAMED function-like ancestor: an anonymous callback (Zustand's
 *  `set((s) => ({...}))`, `useCamStore.setState({...})`'s object argument
 *  needs no callback at all) is skipped in favor of the named action it is
 *  lexically defined inside, so every site is keyed to something a mutation
 *  can actually name. */
function enclosingFunctionName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent
  while (cur !== undefined) {
    if (
      ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur)
    ) {
      const name = namedOf(cur)
      if (name !== null) return name
    }
    cur = cur.parent
  }
  return '<module-scope>'
}

/** Walk up to the nearest expression-statement/variable-statement/return-
 *  statement boundary and return its normalized text -- the generic "what
 *  statement is this occurrence part of" text used by both a bare
 *  `.dimensions =` / element-access assignment hit and every catch-all site
 *  (which has no object-literal to anchor to). */
function nearestStatementText(node: ts.Node, sf: ts.SourceFile): string {
  let cur: ts.Node | undefined = node
  while (
    cur !== undefined &&
    !ts.isExpressionStatement(cur) && !ts.isVariableStatement(cur) && !ts.isReturnStatement(cur)
  ) {
    cur = cur.parent
  }
  return stripCommentsAndNormalize((cur ?? node).getText(sf))
}

/** The "complete assignment" a `dimensions:` property belongs to: the WHOLE
 *  containing object literal (captures sibling properties AND the
 *  property's own full multi-line initializer, so an unsafe rewrite's actual
 *  body -- not just its first line -- is part of what must match); for a
 *  bare `.dimensions =` / element-access assignment, the whole enclosing
 *  statement (delegated to `nearestStatementText`). */
function completeAssignmentText(hitNode: ts.Node, sf: ts.SourceFile): string {
  if (ts.isPropertyAssignment(hitNode)) {
    return stripCommentsAndNormalize(hitNode.parent.getText(sf))
  }
  return nearestStatementText(hitNode, sf)
}

/**
 * The census's own mechanism: a real (syntactic, no type-checker) AST parse
 * of `source`, returning one `DimensionWriteHit` per site that CONSTRUCTS or
 * ASSIGNS a `dimensions` array via one of THREE recognized forms: an
 * explicit `dimensions:` object-literal property, a `.dimensions =`
 * assignment, or an element-access assignment `x["dimensions"] = ...` /
 * `x['dimensions'] = ...` (each requires the operator to be exactly `=`,
 * which excludes `===`/`!==` -- never a write).
 *
 * Exported (rather than inlined in the test) so the SAME algorithm that
 * sweeps the real derived files also runs against the adversarial fixture
 * sources in the companion test's mutation-proof regressions -- a fixture
 * proof against a re-implemented copy would prove nothing about the real
 * census.
 */
export function extractDimensionWriteHits(fileName: string, source: string): DimensionWriteHit[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind)
  const hits: DimensionWriteHit[] = []
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  ;(function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'dimensions') {
      hits.push({
        file: fileName,
        line: lineOf(node),
        enclosingFunction: enclosingFunctionName(node),
        text: completeAssignmentText(node, sf),
      })
    }
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'dimensions'
    ) {
      hits.push({
        file: fileName,
        line: lineOf(node),
        enclosingFunction: enclosingFunctionName(node),
        text: completeAssignmentText(node, sf),
      })
    }
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      (ts.isStringLiteral(node.left.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.left.argumentExpression)) &&
      node.left.argumentExpression.text === 'dimensions'
    ) {
      // WO UI-50C-R4 item 2: element-access assignment (audit finding form A,
      // `s.activeSketch["dimensions"] = ...`) is a first-class recognized hit,
      // like the dotted form -- NOT merely caught by the catch-all.
      hits.push({
        file: fileName,
        line: lineOf(node),
        enclosingFunction: enclosingFunctionName(node),
        text: completeAssignmentText(node, sf),
      })
    }
    node.forEachChild(visit)
  })(sf)

  return hits
}

/** Every entry matching a hit -- a healthy census returns exactly one. */
export function matchingEntries(hit: DimensionWriteHit): CensusEntry[] {
  return DIMENSION_WRITE_PATH_CENSUS.filter(
    (e) => e.file === hit.file && e.enclosingFunction === hit.enclosingFunction && e.text === hit.text,
  )
}

// ---------------------------------------------------------------------------
// WO UI-50C-R4 catch-all sweep: everything `extractDimensionWriteHits` does
// NOT claim as one of its three recognized forms.
// ---------------------------------------------------------------------------

/** Array methods that never mutate their receiver -- an ALLOWLIST, not a
 *  denylist: any method call on a `dimensions` receiver whose name is NOT
 *  here fails RED as a `mutating-call` (the sweep never assumes an
 *  unrecognized method is pure; `.push`/`.splice`/`.forEach`/an unknown
 *  helper all flag). */
const KNOWN_PURE_DIMENSIONS_ARRAY_METHODS = new Set([
  'map', 'filter', 'find', 'some', 'every', 'slice', 'concat', 'flatMap',
  'includes', 'indexOf', 'reduce', 'join', 'toSorted', 'toReversed', 'toSpliced', 'with',
])

function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

/** True for the exact node shapes `extractDimensionWriteHits` already
 *  promotes to a first-class recognized hit -- the catch-all must never
 *  double-flag (or need to separately exclude) these, since they are judged
 *  by the census-entry matching logic instead. A PURE function of the node's
 *  own immediate parent chain (re-derivable from either function's own
 *  independent parse -- no cross-parse node identity is required). */
function isRecognizedExtractionKeyNode(node: ts.Node): boolean {
  const parent = node.parent
  if (parent === undefined) return false
  // colon-form: `dimensions: value` object-literal property key -- an IDENTIFIER key only (matches
  // extractDimensionWriteHits's own `ts.isIdentifier(node.name)` guard); a STRING-LITERAL key
  // (`{ 'dimensions': value }`, WO UI-50C-R4 fixture D2) is deliberately NOT recognized here, so it
  // falls through to the catch-all's `string-literal-key` classification instead.
  if (ts.isPropertyAssignment(parent) && parent.name === node && ts.isIdentifier(node)) return true
  // dotted-form: `x.dimensions = value` (node.left is the WHOLE LHS -- a
  // chain-member write like `x.dimensions.length = 0` does NOT match here,
  // it falls through to the catch-all's write-target classification)
  if (
    ts.isPropertyAccessExpression(parent) && parent.name === node &&
    parent.parent !== undefined && ts.isBinaryExpression(parent.parent) &&
    parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.parent.left === parent
  ) return true
  // element-access form: `x["dimensions"] = value` / `x['dimensions'] = value` -- a STRING/NO-SUB-
  // TEMPLATE-LITERAL argument only (matches extractDimensionWriteHits's own guard); a computed key
  // driven by some other expression (e.g. a variable reference) is not this form.
  if (
    ts.isElementAccessExpression(parent) && parent.argumentExpression === node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    parent.parent !== undefined && ts.isBinaryExpression(parent.parent) &&
    parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.parent.left === parent
  ) return true
  return false
}

/** Climbs from a `dimensions` reference expression through every FURTHER
 *  property/element access, non-null assertion, or parenthesization built on
 *  top of it (`s.dimensions.length`, `s.dimensions[0].value`, `s.dimensions!`,
 *  `(s.dimensions)`) to the outermost node that still denotes "the value
 *  reached via this dimensions reference" -- what that outermost node's OWN
 *  parent is (an assignment target, a delete operand, a call) determines the
 *  occurrence's role; a read nested inside some OTHER expression's own
 *  right-hand side never reaches this far up. */
function climbReferenceChain(ref: ts.Node): ts.Node {
  let cur = ref
  while (cur.parent !== undefined) {
    const p = cur.parent
    if (ts.isPropertyAccessExpression(p) && p.expression === cur) { cur = p; continue }
    if (ts.isElementAccessExpression(p) && p.expression === cur) { cur = p; continue }
    if (ts.isNonNullExpression(p) && p.expression === cur) { cur = p; continue }
    if (ts.isParenthesizedExpression(p) && p.expression === cur) { cur = p; continue }
    break
  }
  return cur
}

/** True if `top` sits inside a destructuring-ASSIGNMENT pattern (never a
 *  binding pattern -- `const [x] = ...` uses `ArrayBindingPattern` /
 *  `BindingElement`, node kinds this function never matches, so the
 *  binding-form control fixture stays classified `binding` as before) whose
 *  outermost pattern is the LHS of a plain `=` assignment: climbs through
 *  ArrayLiteralExpression / ObjectLiteralExpression / PropertyAssignment /
 *  ShorthandPropertyAssignment / SpreadElement wrapper nodes -- exactly the
 *  shapes `[s.dimensions] = ...`, `({ d: s.dimensions } = ...)`, and their
 *  arbitrarily nested combinations build on top of a `dimensions`
 *  reference -- verbatim per WO UI-50C-R5's adopted fix. */
function isDestructuringAssignmentTarget(top: ts.Node): boolean {
  let cur: ts.Node = top
  while (cur.parent !== undefined) {
    const p: ts.Node = cur.parent
    if (ts.isBinaryExpression(p) && p.left === cur && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true
    if (ts.isArrayLiteralExpression(p) && p.elements.includes(cur as ts.Expression)) { cur = p; continue }
    if (ts.isObjectLiteralExpression(p) && p.properties.includes(cur as ts.ObjectLiteralElementLike)) { cur = p; continue }
    if (ts.isPropertyAssignment(p) && p.initializer === cur) { cur = p; continue }
    if (ts.isShorthandPropertyAssignment(p) && p.name === cur) { cur = p; continue }
    if (ts.isSpreadElement(p) && p.expression === cur) { cur = p; continue }
    // Object-rest destructuring assignment (`({ ...s.dimensions } = obj)`) parses the rest
    // element as SpreadAssignment -- the OBJECT-literal sibling of the array/call
    // SpreadElement kind above. Missing it was the UI-50C-R5 audit blocker (the same
    // enumerate-and-miss-a-sibling class); both spread kinds now climb.
    if (ts.isSpreadAssignment(p) && p.expression === cur) { cur = p; continue }
    break
  }
  return false
}

/** True if `top` is the target of a `for (top of iterable)` / `for (top in
 *  iterable)` loop -- `ForOfStatement`/`ForInStatement`'s `initializer` is a
 *  plain assignment-target expression (never a binding pattern) whenever the
 *  loop header omits `const`/`let`/`var`, exactly like a bare `x = y`
 *  assignment target. */
function isForInOrOfAssignmentTarget(top: ts.Node): boolean {
  const p = top.parent
  return p !== undefined && (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === top
}

/** The shared decision for both an identifier reference (`s.dimensions`) and
 *  a string-literal element-access read (`s["dimensions"]`): after climbing
 *  to the outermost chain node, is IT the target of an assignment (including
 *  a destructuring-assignment or for-of/for-in target), a delete operand,
 *  the callee-receiver of a method call (checked against the KNOWN-PURE
 *  allowlist), or -- the fall-through -- a read. */
function roleFromReferenceChain(ref: ts.Node): 'write-target' | 'delete-operand' | 'mutating-call' | 'read' {
  const top = climbReferenceChain(ref)
  const p = top.parent
  if (p === undefined) return 'read'
  if (ts.isBinaryExpression(p) && p.left === top && isAssignmentOperatorKind(p.operatorToken.kind)) return 'write-target'
  if (ts.isDeleteExpression(p) && p.expression === top) return 'delete-operand'
  // Grammar-derivation closure (UI-50C-R5 re-audit blocker): UpdateExpression prefix/postfix
  // ++/-- REASSIGNS its operand - the seventh and FINAL assignment-target reachability context
  // per the audit's complete derivation (simple/compound assignment, destructuring, for-in/of,
  // delete, update). The operator guard is required: PrefixUnaryExpression also parses the
  // pure-READ operators +/-/!/~.
  if (
    (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && p.operand === top &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
  ) return 'write-target'
  if (ts.isPropertyAccessExpression(top) && ts.isCallExpression(p) && p.expression === top) {
    return KNOWN_PURE_DIMENSIONS_ARRAY_METHODS.has(top.name.text) ? 'read' : 'mutating-call'
  }
  // WO UI-50C-R5 (audit BLOCKER): a destructuring-assignment target
  // (`[s.dimensions] = ...`, `({ d: s.dimensions } = ...)`, nested
  // combinations) or a for-of/for-in assignment target
  // (`for (s.dimensions of chunks) {}`) never reaches any check above --
  // `p` is an ArrayLiteralExpression/ObjectLiteralExpression/PropertyAssignment
  // or a ForOfStatement/ForInStatement, none of which is a BinaryExpression --
  // so both fell through to 'read' before this fix.
  if (isForInOrOfAssignmentTarget(top) || isDestructuringAssignmentTarget(top)) return 'write-target'
  return 'read'
}

type IdentifierRole = 'read' | 'binding' | 'type' | UnrecognizedDimensionsRole

/** Classifies one `dimensions` IDENTIFIER occurrence (never the recognized
 *  colon-form key -- callers filter that via `isRecognizedExtractionKeyNode`
 *  first) by its own immediate parent shape, falling back to the reference-
 *  chain climb for every ordinary property-access / bare-variable read or
 *  write. */
function classifyIdentifierOccurrence(node: ts.Identifier): IdentifierRole {
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && parent.name === node) return 'binding'
  if (ts.isParameter(parent) && parent.name === node) return 'binding'
  if (ts.isBindingElement(parent) && parent.name === node) return 'binding'
  if (ts.isBindingElement(parent) && parent.propertyName === node) return 'read'
  if (ts.isPropertySignature(parent) && parent.name === node) return 'type'
  if ((ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) {
    return 'accessor-declaration'
  }
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return 'shorthand-property'
  const ref: ts.Node = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node
  return roleFromReferenceChain(ref)
}

/** True if `node` (a string literal 'dimensions') is an argument to
 *  `Object.defineProperty(...)` or `Reflect.set(...)` -- the two standard-
 *  library dynamic-property APIs a string-literal argument could smuggle a
 *  `dimensions` write through. */
function isObjectDefinePropertyOrReflectSetArg(node: ts.Expression): boolean {
  const parent = node.parent
  if (parent === undefined || !ts.isCallExpression(parent)) return false
  if (!parent.arguments.includes(node)) return false
  const callee = parent.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false
  const objectName = callee.expression.text
  const methodName = callee.name.text
  return (objectName === 'Object' && methodName === 'defineProperty') || (objectName === 'Reflect' && methodName === 'set')
}

/** Classifies one `dimensions` STRING-LITERAL occurrence (never the
 *  recognized element-access-assignment key). Per the STOP ruling, a string
 *  literal is NEVER a pure read by mere argument position: the ONLY safe
 *  shape is an element-access READ (`obj['dimensions']` used as a value, not
 *  an assignment target) -- every other position (object-literal string key,
 *  computed property key, Object.defineProperty/Reflect.set argument, or any
 *  other occurrence) is flagged unless explicitly recognized. */
function classifyStringLiteralOccurrence(node: ts.StringLiteralLike): UnrecognizedDimensionsRole | 'read' {
  const parent = node.parent
  if (parent !== undefined && ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
    return roleFromReferenceChain(parent)
  }
  if (parent !== undefined && ts.isPropertyAssignment(parent) && parent.name === node) return 'string-literal-key'
  if (parent !== undefined && ts.isComputedPropertyName(parent) && parent.expression === node) return 'string-literal-key'
  if (isObjectDefinePropertyOrReflectSetArg(node)) return 'string-literal-arg'
  return 'string-literal-other'
}

/** Roles the KNOWN_SAFE_DIMENSIONS_SITES list may NEVER absorb -- every
 *  UnrecognizedDimensionsRole this module produces. As implemented, every
 *  role this classifier returns is either automatically safe (read/binding/
 *  type -- never even offered to the known-safe list) or unconditionally
 *  hard-flagged, so this set is exactly "every UnrecognizedDimensionsRole" --
 *  see the adversarial 'known-safe list cannot absorb a write-context site'
 *  test, which proves this boundary by adding a matching entry and
 *  confirming the site still reports RED. */
const HARD_UNSAFE_ROLES = new Set<UnrecognizedDimensionsRole>([
  'write-target', 'delete-operand', 'mutating-call', 'shorthand-property',
  'accessor-declaration', 'string-literal-key', 'string-literal-arg', 'string-literal-other',
])

/**
 * WO UI-50C-R4's fail-closed catch-all: every occurrence of the identifier or
 * string literal `dimensions` in `source` that is NOT one of
 * `extractDimensionWriteHits`'s three recognized forms, and is NOT
 * positively classified as a pure read, a type/interface position, or a
 * local binding, is returned here as an UNRECOGNIZED_DIMENSIONS_FORM site.
 * `knownSafe` defaults to the committed list but is overridable so the
 * companion test can prove the list's boundary without mutating the
 * production export.
 */
export function sweepUnrecognizedDimensionsSites(
  fileName: string,
  source: string,
  knownSafe: readonly KnownSafeSite[] = KNOWN_SAFE_DIMENSIONS_SITES,
): UnrecognizedDimensionsSite[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind)
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const sites: UnrecognizedDimensionsSite[] = []

  function record(node: ts.Node, role: UnrecognizedDimensionsRole): void {
    const enclosingFunction = enclosingFunctionName(node)
    const text = nearestStatementText(node, sf)
    if (HARD_UNSAFE_ROLES.has(role)) {
      // Hard-unsafe roles are never eligible for a known-safe override --
      // this branch does not even perform the lookup, which is what the
      // adversarial 'cannot absorb a write-context site' test verifies.
      sites.push({ file: fileName, line: lineOf(node), enclosingFunction, text, role })
      return
    }
    const covered = knownSafe.some(
      (k) => k.file === fileName && k.enclosingFunction === enclosingFunction && k.text === text,
    )
    if (!covered) sites.push({ file: fileName, line: lineOf(node), enclosingFunction, text, role })
  }

  ;(function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && node.text === 'dimensions' && !isRecognizedExtractionKeyNode(node)) {
      const role = classifyIdentifierOccurrence(node)
      if (role !== 'read' && role !== 'binding' && role !== 'type') record(node, role)
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'dimensions' &&
      !isRecognizedExtractionKeyNode(node)
    ) {
      const role = classifyStringLiteralOccurrence(node)
      if (role !== 'read') record(node, role)
    }
    node.forEachChild(visit)
  })(sf)

  return sites
}

/** The bounded known-safe escape hatch (see the module header + the
 *  KnownSafeSite doc comment). Empty today: both real local-binding sites
 *  (`const dimensions =` in src/store/index.ts's two onmessage branches) are
 *  classified automatically by AST shape and need no entry here. */
export const KNOWN_SAFE_DIMENSIONS_SITES: readonly KnownSafeSite[] = []

export const DIMENSION_WRITE_PATH_CENSUS: readonly CensusEntry[] = [
  // ---- src/store/index.ts (CAM) -----------------------------------------------------------------
  {
    id: 'cam-deleteEntity-cascade',
    file: 'src/store/index.ts',
    enclosingFunction: 'deleteEntity',
    text: '{ ...s.activeSketch!, entities: s.activeSketch!.entities.filter((e) => e.id !== id), constraints: s.activeSketch!.constraints.filter( (c) => !constraintRefIds(c).includes(id) ), dimensions: s.activeSketch!.dimensions.filter( (d) => !dimensionRefIds(d).includes(id) ), }',
    class: 'cascade-inert',
    note: 'deleteEntity: removes dimensions referencing the deleted entity; never inserts or mutates a survivor.',
  },
  {
    id: 'cam-addDimension-insert',
    file: 'src/store/index.ts',
    enclosingFunction: 'addDimension',
    text: '{ ...s.activeSketch!, dimensions: [...s.activeSketch!.dimensions, dimension], }',
    class: 'insert',
    note: 'addDimension: appends the ONE dimension demoteExtraEllipseShapeDims just vetted. WO-1858 removed the d1xd2 driving normalization that used to wrap this insert -- every driving flag a dimension can arrive with is a legitimate document state now.',
  },
  {
    id: 'cam-setDimensionValue-edit',
    file: 'src/store/index.ts',
    enclosingFunction: 'setDimensionValue',
    text: '{ ...s.activeSketch!, dimensions: s.activeSketch!.dimensions.map((d) => d.id === id ? { ...d, value } : d ), }',
    class: 'edit',
    note: 'setDimensionValue: the raw setter writes one named dimension\'s base value. WO-1858 removed its d1xd2 refusal (that kind is drivable now); the setter still touches nothing but `value` on the one id it was given.',
  },
  {
    id: 'cam-commitDimensionValue-edit',
    file: 'src/store/index.ts',
    enclosingFunction: 'commitDimensionValue',
    text: '{ ...s.activeSketch!, dimensions: s.activeSketch!.dimensions.map((d) => d.id !== dimId ? d : d.kind === \'d1xd2\' && editsD2 ? { ...d, d2: value, expression } : { ...d, value: signedValue, expression } ), solveStatus: null, }',
    class: 'edit',
    note: 'commitDimensionValue: writes the ONE named dimension the editor committed. WO-1858: a chamfer setback pair is two-valued, so the edit names WHICH half it sets -- `editsD2` (the caller\'s `half` argument) picks `d2`, every other kind and the omitted-half default take the `value` branch unchanged. SKC-59-R1: the written value is signedValue = signedAngleEditValue(dim, value) (the typed magnitude normalized to the dim\'s signed sector convention), never the raw typed value. "sketch-dim equations wiring": `expression` is the raw "=..." source (or undefined for a plain number), written alongside value so a plain-number commit clears any prior equation. `solveStatus: null` revokes the stale verdict synchronously before the re-solve this commit dispatches -- same fail-closed revoke every editing commit performs (ADR 0003); it touches solveStatus, never dimensions, so the site\'s dimensions-write classification is unchanged.',
  },
  {
    id: 'cam-toggleDimensionDriving-repair',
    file: 'src/store/index.ts',
    enclosingFunction: 'toggleDimensionDriving',
    text: '{ ...s.activeSketch!, dimensions: s.activeSketch!.dimensions.map((d) => d.id === dimId ? updated : d ), }',
    class: 'toggle-to-reference',
    note: "toggleDimensionDriving's driving -> reference direction: `updated` sets driving:false and snaps the value to the measured one -- for d1xd2 BOTH halves via measureChamferSetbacks, for an angle the atomic (value, reverseB) pair, otherwise measureDimension.",
  },
  {
    id: 'cam-toggleDimensionDriving-forward',
    file: 'src/store/index.ts',
    enclosingFunction: 'toggleDimensionDriving',
    text: '{ ...s.activeSketch!, dimensions: s.activeSketch!.dimensions.map((d) => d.id === dimId ? { ...d, driving: true } : d ), solveStatus: null, }',
    class: 'edit',
    note: "toggleDimensionDriving's FORWARD direction (reference -> driving): flips the driving flag on the ONE named dimension and lets the verdict solve rule on it. WO-1858 removed the d1xd2 refusal that used to return before this line, so a chamfer setback pair reaches it like any other kind. `solveStatus: null` revokes the stale verdict before the re-solve this toggle dispatches (same ADR 0003 revoke-before-resolve pattern as commitDimensionValue above); it touches solveStatus, never dimensions, so the site's dimensions-write classification is unchanged.",
  },
  {
    id: 'cam-updateDimensionLabel-sector-conditional',
    file: 'src/store/index.ts',
    enclosingFunction: 'updateDimensionLabel',
    text: '{ ...s.activeSketch!, dimensions: s.activeSketch!.dimensions.map((d) => d.id === dimId ? { ...d, labelAnchor: { x: anchor.x, y: anchor.y }, ...(valueOverride !== null ? { value: valueOverride.value, reverseB: valueOverride.reverseB } : null) } : d ), }',
    class: 'label-value-conditional',
    note: 'updateDimensionLabel (WO SKC-56 + SKC-58B): labelAnchor always; value AND reverseB ONLY when angleLabelDragValueOverride found a sector crossing (null spread is a no-op for every other case).',
  },
  {
    id: 'cam-deleteSketchItems-cascade',
    file: 'src/store/index.ts',
    enclosingFunction: 'deleteSketchItems',
    text: '{ ...st.activeSketch!, entities: r.entities, constraints: r.constraints, dimensions: r.dimensions, patterns: r.patterns ?? st.activeSketch!.patterns, }',
    class: 'cascade-inert',
    note: 'deleteSketchItems (deleteSketchSelection delegates here): r comes from deleteFromSketch (pure cascade filter), never a fresh insert. WO-2784 RE-PIN: WO-2616 (4d60c51a8a, landed 5211ea829b, dependent sketch patterns) added the sibling `patterns: r.patterns ?? st.activeSketch!.patterns` field to this object; deleteFromSketch still builds r.dimensions as `sketch.dimensions.filter(...)` (src/lib/sketch/deleteSelection.ts), so the dimensions write is unchanged and the ruling stays cascade-inert.',
  },
  {
    id: 'cam-solve-complete-remeasure',
    file: 'src/store/index.ts',
    enclosingFunction: 'onmessage',
    text: '{ ...sk, entities: msg.entities, dimensions: dimensions, solveStatus: msg.status, }',
    class: 'remeasure-inert',
    note: "SKETCH_SOLVE_COMPLETE branch of ensureSketchWorker's onmessage handler: `dimensions` is remeasureReferenceDimensions's own output (value-only, REFERENCE dimensions only). WO SKC-56-R4: the RULING here is unchanged -- only the spelling is. The branch now commits through the store's epoch gateway (commitSketchGeometry), so the live sketch arrives as the callback's `sk` parameter instead of being re-read as `s.activeSketch`; `dimensions` is the same remeasure output written the same value-only way.",
  },
  {
    id: 'cam-solver-revert',
    file: 'src/store/index.ts',
    enclosingFunction: 'onmessage',
    text: '{ ...sk, dimensions: dimensions }',
    class: 'revert-inert',
    note: "SKETCH_SOLVE_FAILED branch of ensureSketchWorker's onmessage handler: `dimensions` is a filter (remove) or a value/driving-flag rewrite of an EXISTING entry -- resurrects only what was already persisted, never a fresh ingestion. WO SKC-56-R4: same RULING, new spelling -- the branch commits through the epoch gateway now, so the live sketch is the callback's `sk` parameter (see cam-solve-complete-remeasure).",
  },
  {
    id: 'cam-append-insert',
    file: 'src/store/index.ts',
    enclosingFunction: 'append',
    text: '{ ...st.activeSketch!, entities: [...st.activeSketch!.entities, ...commit.entities], constraints: [...st.activeSketch!.constraints, ...liveConstraints, ...liveInferred], dimensions: [...st.activeSketch!.dimensions, ...liveDimensions], solveStatus: null, }',
    class: 'insert',
    note: "camSketchDocumentPort.append: appends this tool commit's own dimensions (WO-1858 removed the d1xd2 driving normalization that used to wrap them). `solveStatus: null` (alongside the sibling `sketchSolveStatus: null` outside this object) revokes the stale verdict before the caller's own re-solve -- same ADR 0003 revoke-before-resolve pattern as the edit-path sites above; it touches solveStatus, never the guarded dimensions insert. WO-1461 audit fix (2026-09-15): `liveConstraints`/`liveInferred`/`liveDimensions` are `commit.constraints`/`inferred`/`commit.dimensions ?? []` pre-filtered to drop any entry referencing an entity id not in this sketch (a stale tool-chain reference to an entity an earlier append-reject already removed) -- same guarded insert, one upstream filter.",
  },
  {
    id: 'cam-append-reject',
    file: 'src/store/index.ts',
    enclosingFunction: 'onmessage',
    text: '{ ...sk, entities: sk.entities.filter((e) => !removedIds.has(e.id)), constraints: sk.constraints.filter((c) => !removedIds.has(c.id)), dimensions: sk.dimensions.filter((d) => !removedIds.has(d.id)), }',
    class: 'cascade-inert',
    note: "WO-1461/BUG-486: SKETCH_SOLVE_FAILED branch's pendingAppendApply reject -- strips exactly the entity/constraint/dimension ids append()'s own commit added (never a survivor), restoring the sketch to its pre-commit state. Same disposition as cam-deleteEntity-cascade/cam-deleteSketchItems-cascade: a pure filter/remove, never an insert or a mutation of anything that was not part of THIS commit.",
  },
  {
    id: 'cam-replace-guarded',
    file: 'src/store/index.ts',
    enclosingFunction: 'replace',
    text: '{ ...st.activeSketch!, entities: next.entities, constraints: next.constraints, dimensions: next.dimensions, patterns: next.patterns ?? st.activeSketch!.patterns, }',
    class: 'replace',
    note: 'camSketchDocumentPort.replace: MODIFY-tool (trim / fillet / chamfer) results land whole. WO-1858 removed the d1xd2 driving normalization that used to wrap them. WO-2784 RE-PIN: WO-2616 (4d60c51a8a, landed 5211ea829b, dependent sketch patterns) added the sibling `patterns: next.patterns ?? st.activeSketch!.patterns` field so a modify result carries its pattern definitions; it touches patterns, never dimensions, so `dimensions: next.dimensions` keeps the same whole-result replace ruling.',
  },

  // ---- src/components/model3d/workbench/workbenchSketchDocumentPort.ts (workbench) --------------
  {
    id: 'wb-solved-remeasure',
    file: 'src/components/model3d/workbench/workbenchSketchDocumentPort.ts',
    enclosingFunction: 'solved',
    text: '{ ...sketch, entities: outcome.entities, dimensions: remeasureReferenceDimensions(outcome.entities, sketch.dimensions, sketch.constraints), solveStatus: outcome.status, }',
    class: 'remeasure-inert',
    note: 'solved(): value-only remeasure after every synchronous solve; same guarantee as CAM\'s SOLVE_COMPLETE handler.',
  },
  {
    id: 'wb-relinked-remeasure',
    file: 'src/components/model3d/workbench/workbenchSketchDocumentPort.ts',
    enclosingFunction: 'solveRelinkedSketch',
    text: '{ ...injected, entities: outcome.entities, dimensions: remeasureReferenceDimensions(outcome.entities, injected.dimensions, injected.constraints), solveStatus: outcome.status, }',
    class: 'remeasure-inert',
    note: 'WO-1864 solveRelinkedSketch: the same value-only remeasure as solved(), run after the regen pass rewrote linked projected pieces to follow the model; reference dimensions follow the moved geometry, driving ones are untouched.',
  },
  {
    id: 'wb-append-insert',
    file: 'src/components/model3d/workbench/workbenchSketchDocumentPort.ts',
    enclosingFunction: 'append',
    text: '{ ...s, entities: [...s.entities, ...commit.entities], constraints: [...s.constraints, ...commit.constraints, ...inferred], dimensions: [...s.dimensions, ...(commit.dimensions ?? [])], }',
    class: 'insert',
    note: 'append: the workbench twin of the CAM append insert, same WO-1858 disposition.',
  },
  {
    id: 'wb-replace-guarded',
    file: 'src/components/model3d/workbench/workbenchSketchDocumentPort.ts',
    enclosingFunction: 'replace',
    text: '{ ...s, ...next, dimensions: next.dimensions }',
    class: 'replace',
    note: 'replace: the workbench twin of the CAM replace path, same WO-1858 disposition.',
  },
  {
    id: 'wb-labelAnchor-sector-conditional',
    file: 'src/components/model3d/workbench/workbenchSketchDocumentPort.ts',
    enclosingFunction: 'moveDimLabel',
    text: '{ ...s, dimensions: s.dimensions.map((d) => d.id === dimId ? { ...d, labelAnchor: anchor, ...(valueOverride !== null ? { value: valueOverride.value, reverseB: valueOverride.reverseB } : null) } : d ), }',
    class: 'label-value-conditional',
    note: 'moveDimLabel (WO SKC-56 + SKC-58B): labelAnchor always; value AND reverseB ONLY when angleLabelDragValueOverride found a sector crossing -- workbench twin of the CAM store site, same shared helper.',
  },

  // ---- src/components/model3d/workbench/workbenchOverlaysPort.ts (workbench) --------------------
  {
    id: 'wb-overlays-applyWithVerdict-passthrough',
    file: 'src/components/model3d/workbench/workbenchOverlaysPort.ts',
    enclosingFunction: 'applyWithVerdict',
    text: '{ entities: outcome.entities, constraints: next.constraints, dimensions: next.dimensions, }',
    class: 'passthrough-inert',
    note: 'applyWithVerdict: forwards to workbenchSketchDocumentPort.replace, which itself normalizes (wb-replace-guarded).',
  },
  {
    id: 'wb-overlays-toggle-passthrough',
    file: 'src/components/model3d/workbench/workbenchOverlaysPort.ts',
    enclosingFunction: 'toggleDimensionDriving',
    text: '{ entities: s.entities, constraints: s.constraints, dimensions: s.dimensions.map((d) => (d.id === dimId ? flipped : d)), }',
    class: 'passthrough-inert',
    note: 'toggleDimensionDriving: builds the array handed to workbenchSketchDocumentPort.replace (named downstream); the driving -> reference direction remeasures a d1xd2 pair via measureChamferSetbacks, and WO-1858 removed the forward-direction refusal that used to sit above this line.',
  },
  {
    id: 'wb-overlays-commitValue-passthrough',
    file: 'src/components/model3d/workbench/workbenchOverlaysPort.ts',
    enclosingFunction: 'commitDimensionValue',
    text: "{ ...s, dimensions: s.dimensions.map((x) => ( x.id !== dimId ? x : x.kind === 'd1xd2' && editsD2 ? { ...x, d2: value, expression } : { ...x, value: signedValue, expression })), }",
    class: 'passthrough-inert',
    note: 'commitDimensionValue: writes the ONE named dimension and hands the array to replace() (named downstream). WO-1858: a chamfer setback pair is two-valued, so `editsD2` (from the caller-supplied `half` argument) picks `d2`; every other kind and the omitted-half default take the `value` branch unchanged -- the workbench twin of the CAM commit site. SKC-59-R1: value is signedValue = signedAngleEditValue(dim, value), the SAME shared signed-convention normalization CAM applies (single point of truth). "sketch-dim equations wiring": `expression` is the raw "=..." source (or undefined for a plain number); applyWithVerdict only ever commits `next` on ACCEPT (no optimistic-write-then-revert here), so there is no separate reject-path expression restore to track, unlike CAM\'s async verdict.',
  },

  {
    id: 'wb-overlays-group-passthrough',
    file: 'src/components/model3d/workbench/workbenchOverlaysPort.ts',
    enclosingFunction: 'groupSelectionIntoBlock',
    text: '{ entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions, }',
    class: 'passthrough-inert',
    note: 'SKC-BLOCKS groupSelectionIntoBlock: r.sketch.dimensions is groupIntoBlock\'s PARTITION of the EXISTING dimensions (external ones stay on the sketch; internal ones move into the block members) -- never a fresh insert or a driving-flag rewrite. Handed to workbenchSketchDocumentPort.replace, which normalizes downstream (wb-replace-guarded).',
  },
  {
    id: 'wb-overlays-explode-passthrough',
    file: 'src/components/model3d/workbench/workbenchOverlaysPort.ts',
    enclosingFunction: 'explodeSelectedBlock',
    text: '{ entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions, blockDefs: r.sketch.blockDefs, }',
    class: 'passthrough-inert',
    note: 'SKC-BLOCKS explodeSelectedBlock: r.sketch.dimensions is explodeBlock\'s reunion of the sketch dimensions with the block\'s member dimensions (both were already-persisted entries) -- never a fresh insert or a driving-flag rewrite. SKC-BLOCKS Stage 5 added blockDefs (the def registry, possibly pruned) to the same passthrough object. Handed to workbenchSketchDocumentPort.replace, which normalizes downstream (wb-replace-guarded).',
  },
  {
    id: 'wb-overlays-insertinstance-passthrough',
    file: 'src/components/model3d/workbench/workbenchOverlaysPort.ts',
    enclosingFunction: 'insertInstance',
    text: '{ entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions, blockDefs: r.sketch.blockDefs, }',
    class: 'passthrough-inert',
    note: 'SKC-BLOCKS Stage 5 insertInstance: r.sketch.dimensions is insertInstanceOfBlock\'s UNCHANGED sketch.dimensions -- placing a new def-backed instance only adds a block entity + (on first reuse) a definition; it never inserts, rewrites, or flags a dimension. Passthrough only, handed to workbenchSketchDocumentPort.replace (wb-replace-guarded).',
  },
  {
    id: 'wb-overlays-setblockscale-passthrough',
    file: 'src/components/model3d/workbench/workbenchOverlaysPort.ts',
    enclosingFunction: 'setBlockScale',
    text: '{ entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions, }',
    class: 'passthrough-inert',
    note: 'SKC-BLOCKS Stage 2 setBlockScale: r.sketch.dimensions is setBlockScale (blocks.ts)\'s UNCHANGED sketch.dimensions -- the function only ever rewrites the named block entity\'s `scale` field, never touches dimensions. Passthrough only, handed to workbenchSketchDocumentPort.replace (wb-replace-guarded).',
  },
  {
    id: 'wb-overlays-setblockrotationdeg-passthrough',
    file: 'src/components/model3d/workbench/workbenchOverlaysPort.ts',
    enclosingFunction: 'setBlockRotationDeg',
    text: '{ entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions, }',
    class: 'passthrough-inert',
    note: 'SKC-BLOCKS Stage 2 setBlockRotationDeg: r.sketch.dimensions is setBlockRotationDeg (blocks.ts)\'s UNCHANGED sketch.dimensions -- the function only ever rewrites the named block entity\'s `rotation` field, never touches dimensions. Passthrough only, handed to workbenchSketchDocumentPort.replace (wb-replace-guarded).',
  },

  // ---- src/components/model3d/workbench/sketchSessionStore.ts (workbench document boundary) -----
  // NO mechanical entry: begin() carries no `dimensions:` literal (see
  // NAMED_RULINGS' 'wb-session-begin-noop' below for why it needs none).

  // ---- src/components/model3d/SolidsWorkbenchPage.tsx (workbench document boundary) -------------
  // NO mechanical entry: WO-1858 removed normalizeDebugSceneSketchDimensions
  // (the only `dimensions:` write this file carried) along with the
  // reference-only invariant it existed to enforce. See NAMED_RULINGS'
  // 'wb-debugscene-restore-noop'.
  {
    id: 'store-nudgeSelection-passthrough',
    file: 'src/store/index.ts',
    enclosingFunction: 'nudgeSelection',
    text: '{ entities, constraints: sketch.constraints, dimensions: sketch.dimensions, }',
    class: 'passthrough-inert',
    note: 'Arrow-key nudge (1b2c19510): translates selected ENTITIES only and forwards the untouched dimensions array to camSketchDocumentPort.replace, whose guard normalizes at the receiving end.',
  },
] as const

/** Non-mechanical rulings (WO UI-50C-R2 requirement 1's own "NAMED census
 *  ruling" allowance): these document boundaries forward a WHOLE prior
 *  Project/Sketch/payload snapshot rather than naming a `dimensions:` key at
 *  their own call site, so the mechanical sweep cannot see them -- exactly
 *  the "composite child-hook results" carve-out debugSceneCensus.ts
 *  documents for the same reason. Recorded here so the census's own honesty
 *  is complete, not silent. */
export const NAMED_RULINGS: ReadonlyArray<{ id: string; file: string; note: string }> = [
  {
    id: 'cam-undo-redo-restore',
    file: 'src/store/index.ts (undo / redo)',
    note:
      'undo()/redo() restore a WHOLE prior `activeSketch` snapshot captured by pushHistory() BEFORE the '
      + 'mutation that follows it. Every snapshot in sketchHistory/sketchFuture was itself produced by a '
      + 'write path this census already names (or the initial load) -- undo/redo only ever replays an '
      + 'already-persisted prior state, never a fresh ingestion. NAMED-INERT, not mechanically swept: no '
      + '`dimensions:` key appears at this call site (the whole Sketch object is restored by reference).',
  },
  {
    id: 'wb-undo-redo-restore',
    file: 'src/components/model3d/workbench/workbenchSketchDocumentPort.ts (SketchStepCommand)',
    note:
      'SketchStepCommand.undo()/do() call dag.setPayload(id, this.before / this.after) -- whole prior dag '
      + 'node payload snapshots captured by openStepNow()/commitSketch(), themselves produced by the SAME '
      + 'append()/replace() write paths this census names above. NAMED-INERT, not mechanically swept: no '
      + '`dimensions:` key appears at this call site (the whole payload object is restored by reference).',
  },
  {
    id: 'wb-session-begin-noop',
    file: 'src/components/model3d/workbench/sketchSessionStore.ts (begin)',
    note:
      'begin() mirrors the dag node payload into the live session state VERBATIM -- no `dimensions:` key at '
      + 'this call site, so the sweep cannot see it, and deliberately carries NO independent normalization. '
      + 'A mirror-only guard was tried here once and REVERTED, and the reason still binds any future one: '
      + 'the session mirror and the dag payload are two separate copies that only a real commit '
      + '(append/replace) syncs, so fixing the mirror alone makes the live state disagree with the document '
      + 'it came from without ever writing the fix through.',
  },
  {
    id: 'wb-debugscene-restore-noop',
    file: 'src/components/model3d/SolidsWorkbenchPage.tsx (initialDebugScene restore)',
    note:
      'The debug-scene restore boundary (FeatureDag.restore + seedGenesisNodes) carries NO dimension pass '
      + 'at all since WO-1858. It had exactly one: normalizeDebugSceneSketchDimensions, which forced every '
      + 'persisted d1xd2 back to driving:false. That invariant is retired -- a driving chamfer setback pair '
      + 'is a legitimate document state now -- so the pass was deleted with it rather than left as a '
      + 'do-nothing walk over every dag node. This file therefore names no `dimensions:` write, which is why '
      + 'it has no mechanical census entry; it stays in DERIVED_FILES so the fail-closed catch-all keeps '
      + 'sweeping it for a new one.',
  },
]
