// WO SKC-56-R2 (DECISIONS 2026-07-16 "SKC-56 async-coherence" ruling,
// requirement 2): "No caller may bypass the seam: add a census-style test
// that derives every history-restoring call site (grep/AST over
// src/store/index.ts for sketchFuture/sketchHistory consumers, list them in
// the report, disposition each) - audit citations are examples, never the
// domain." Mirrors the committed precedent
// (src/tests/sketch/dimensionWritePathCensus.ts): a real (`typescript`
// compiler API) AST parse of the derived file, never a text/regex scan, so a
// comment or a string cannot forge or hide a hit, and a brand-new site is
// UNCLASSIFIED (RED) rather than silently absorbed.
//
// DOMAIN (derived by WHAT a site does, not by a hand-picked WHERE): every
// place in src/store/index.ts that CONSTRUCTS, ASSIGNS, or MUTATES the
// `sketchHistory` or `sketchFuture` arrays. Only 6 real sites exist today
// (verified against wo/SKC-56 HEAD at R2 launch): the initial-state object
// (both fields), pushHistory (both fields), the shared
// restoreSketchFromHistorySeam choke point undo/redo now both route through
// (both fields, x2 branches), and two text-edit TRUNCATE-only sites
// (commitSketchTextEdit / cancelSketchTextEdit, sketchHistory only -- they
// drop the most recent history entry when discarding a just-placed empty
// text, they never RESTORE a snapshot into activeSketch).
//
// The load-bearing assertion this census exists to make mechanically
// checkable: undo() and redo() -- the two PUBLIC store actions a UI
// interaction actually calls -- must have ZERO direct sketchHistory/
// sketchFuture site of their own. Before the R2 refactor each carried its
// own byte-identical copy of the invalidation block; after it, both are
// one-line delegations to restoreSketchFromHistorySeam, so this census's
// "every site's enclosingFunction is on the approved list, and undo/redo
// specifically have none" check is what catches a future regression that
// reintroduces a direction-specific inlined copy (the exact class of bug
// the R1-to-R2 bounce was about: a fix landing in ONE of two duplicated
// bodies, not the other).
//
// A fail-closed CATCH-ALL (sweepUnrecognizedSketchHistorySites, ported from
// the dimensionWritePathCensus precedent) additionally hard-refuses ANY
// OTHER form of touching these two fields -- a mutating method call
// (`.push`/`.splice`), an index/destructuring assignment, a for-of/in
// target, a delete, or a postfix/prefix update -- regardless of which
// function it appears in, so a bypass need not be anticipated by name to be
// caught RED.

import ts from 'typescript'

export const DERIVED_FILES = ['src/store/index.ts'] as const

/** The two fields this census's mechanical sweep watches. */
const WATCHED_FIELDS = new Set(['sketchHistory', 'sketchFuture'])

export type SketchHistoryCensusClass =
  /** The initial-state object literal handed to `create<CamStore>()(...)` --
   *  both fields start as empty arrays; not a restore. */
  | 'init'
  /** pushHistory(): appends the CURRENT project/sketch snapshot onto history
   *  and clears future -- a forward write, never a restore FROM history. */
  | 'push-forward'
  /** WO-3133's rejected initial-dimension transaction restores the two stack
   *  values captured immediately before its own push, only while the exact
   *  transaction top remains live. It cancels that forward transaction; it is
   *  not an undo/redo restore of geometry from either stack. */
  | 'transaction-rollback'
  /** restoreSketchFromHistorySeam: the ONE choke point undo() and redo()
   *  both delegate to -- enforces both invariant halves (invalidate +
   *  re-solve) the DECISIONS ruling requires. */
  | 'seam-restore'
  /** commitSketchTextEdit / cancelSketchTextEdit: drops the most recent
   *  history entry outright (a just-placed, still-untyped text create is
   *  being un-done as if it never happened) -- TRUNCATE, never a restore of
   *  a snapshot into activeSketch. */
  | 'truncate'
  /** SKC-65 sketch-entry snapshot pair: snapshotSketchEntry CLONES the whole
   *  undo state into an entry snapshot before a sketch session begins, and
   *  cancelActiveSketch RESTORES that snapshot wholesale when the session is
   *  cancelled -- the entire pre-entry state comes back as one transition,
   *  never element-wise history surgery and never through the seam (nothing
   *  is being un-done; a session's existence is being erased). */
  | 'entry-snapshot'
  /** INT-21 newProject: starting a NEW DOCUMENT ends the previous document's
   *  undo domain, so both paired stacks reset to empty. Distinct from 'init'
   *  (which is the one module-scope literal handed to create<CamStore>()) and
   *  the opposite of a restore: nothing is read back OUT of history here, and
   *  leaving either stack alive would let Undo/Redo reach into the CLOSED
   *  project's geometry -- the precise defect the reset exists to prevent. */
  | 'document-reset'
  /** WO-1585 discardPendingHistory: pops the ONE most-recent sketchHistory
   *  entry, guarded by identity against `expectedTop` -- it removes only an
   *  entry the caller itself just pushed (proven by the exact object still
   *  being on top) and no-ops otherwise. Not undo traffic (no sketchFuture
   *  write, no re-solve): a session abandoning its own pending push, not a
   *  user-facing Undo/Redo. */
  | 'discard-pending'

export interface SketchHistoryCensusEntry {
  id: string
  file: (typeof DERIVED_FILES)[number]
  enclosingFunction: string
  text: string
  class: SketchHistoryCensusClass
  note: string
}

export interface SketchHistoryWriteHit {
  file: string
  line: number
  field: string
  enclosingFunction: string
  text: string
}

export type UnrecognizedSketchHistoryRole =
  | 'write-target'
  | 'delete-operand'
  | 'mutating-call'
  | 'string-literal-key'

export interface UnrecognizedSketchHistorySite {
  file: string
  line: number
  field: string
  enclosingFunction: string
  text: string
  role: UnrecognizedSketchHistoryRole
}

function stripCommentsAndNormalize(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

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

/** Nearest NAMED function-like ancestor, skipping anonymous callbacks
 *  (Zustand's `set((s) => ({...}))`) -- same walk as the dimension census's
 *  own `enclosingFunctionName`, so a site keys to the named action/function
 *  it is lexically defined inside, never an anonymous wrapper. */
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

/** For a `field:` object-literal property, the property's OWN "name:
 *  initializer" text (unlike the dimensionWritePathCensus precedent, which
 *  captures the WHOLE containing object literal -- that domain needed
 *  sibling context to catch a same-line rewrite; this domain's two fields
 *  are single-purpose arrays whose own initializer expression fully
 *  determines their behavior, AND the init site's `sketchHistory:` property
 *  is a DIRECT property of the giant top-level store-creator object literal,
 *  so capturing "the whole containing object" there would grab the entire
 *  multi-thousand-line store). For a bare `.field =` assignment, the whole
 *  enclosing statement. */
function completeAssignmentText(hitNode: ts.Node, sf: ts.SourceFile): string {
  if (ts.isPropertyAssignment(hitNode)) {
    return stripCommentsAndNormalize(hitNode.getText(sf))
  }
  return nearestStatementText(hitNode, sf)
}

/**
 * Real AST parse of `source`, returning one SketchHistoryWriteHit per site
 * that CONSTRUCTS or ASSIGNS `sketchHistory`/`sketchFuture` via one of the
 * two recognized forms: an explicit `field:` object-literal property, or a
 * bare `.field =` assignment. Exported so the SAME algorithm sweeps both the
 * real file and adversarial fixture sources in the companion test.
 */
export function extractSketchHistoryWriteHits(fileName: string, source: string): SketchHistoryWriteHit[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind)
  const hits: SketchHistoryWriteHit[] = []
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  ;(function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && WATCHED_FIELDS.has(node.name.text)) {
      hits.push({
        file: fileName,
        line: lineOf(node),
        field: node.name.text,
        enclosingFunction: enclosingFunctionName(node),
        text: completeAssignmentText(node, sf),
      })
    }
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) && WATCHED_FIELDS.has(node.left.name.text)
    ) {
      hits.push({
        file: fileName,
        line: lineOf(node),
        field: node.left.name.text,
        enclosingFunction: enclosingFunctionName(node),
        text: completeAssignmentText(node, sf),
      })
    }
    node.forEachChild(visit)
  })(sf)

  return hits
}

/** Every entry matching a hit -- a healthy census returns exactly one. */
export function matchingEntries(hit: SketchHistoryWriteHit): SketchHistoryCensusEntry[] {
  return SKETCH_HISTORY_RESTORE_CENSUS.filter(
    (e) => e.file === hit.file && e.enclosingFunction === hit.enclosingFunction && e.text === hit.text,
  )
}

// ---------------------------------------------------------------------------
// Fail-closed catch-all: everything extractSketchHistoryWriteHits does NOT
// claim as one of its two recognized forms. Ported from
// dimensionWritePathCensus's own sweepUnrecognizedDimensionsSites (same
// audited technique, narrowed to the two watched field names).
// ---------------------------------------------------------------------------

const KNOWN_PURE_ARRAY_METHODS = new Set([
  'map', 'filter', 'find', 'some', 'every', 'slice', 'concat', 'flatMap',
  'includes', 'indexOf', 'reduce', 'join', 'toSorted', 'toReversed', 'toSpliced', 'with',
])

function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

function isRecognizedExtractionKeyNode(node: ts.Node): boolean {
  const parent = node.parent
  if (parent === undefined) return false
  if (ts.isPropertyAssignment(parent) && parent.name === node && ts.isIdentifier(node)) return true
  if (
    ts.isPropertyAccessExpression(parent) && parent.name === node &&
    parent.parent !== undefined && ts.isBinaryExpression(parent.parent) &&
    parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.parent.left === parent
  ) return true
  return false
}

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
    if (ts.isSpreadAssignment(p) && p.expression === cur) { cur = p; continue }
    break
  }
  return false
}

function isForInOrOfAssignmentTarget(top: ts.Node): boolean {
  const p = top.parent
  return p !== undefined && (ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === top
}

function roleFromReferenceChain(ref: ts.Node): 'write-target' | 'delete-operand' | 'mutating-call' | 'read' {
  const top = climbReferenceChain(ref)
  const p = top.parent
  if (p === undefined) return 'read'
  if (ts.isBinaryExpression(p) && p.left === top && isAssignmentOperatorKind(p.operatorToken.kind)) return 'write-target'
  if (ts.isDeleteExpression(p) && p.expression === top) return 'delete-operand'
  if (
    (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && p.operand === top &&
    (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)
  ) return 'write-target'
  if (ts.isPropertyAccessExpression(top) && ts.isCallExpression(p) && p.expression === top) {
    return KNOWN_PURE_ARRAY_METHODS.has(top.name.text) ? 'read' : 'mutating-call'
  }
  if (isForInOrOfAssignmentTarget(top) || isDestructuringAssignmentTarget(top)) return 'write-target'
  return 'read'
}

type IdentifierRole = 'read' | 'binding' | 'type' | UnrecognizedSketchHistoryRole

function classifyIdentifierOccurrence(node: ts.Identifier): IdentifierRole {
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && parent.name === node) return 'binding'
  if (ts.isParameter(parent) && parent.name === node) return 'binding'
  if (ts.isBindingElement(parent) && parent.name === node) return 'binding'
  if (ts.isBindingElement(parent) && parent.propertyName === node) return 'read'
  if (ts.isPropertySignature(parent) && parent.name === node) return 'type'
  // Shorthand property (`{ sketchHistory }`) and a colon-form key are both
  // out of scope here: colon-form keys are filtered out by the caller via
  // isRecognizedExtractionKeyNode before classification is ever attempted
  // (a real write, matched or unclassified, by the recognized-extraction
  // path instead); shorthand is a known, disclosed gap (no production site
  // uses it today) rather than a silently-assumed-safe classification.
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return 'read'
  const ref: ts.Node = ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node
  return roleFromReferenceChain(ref)
}

/**
 * Fail-closed catch-all: every occurrence of the identifier `sketchHistory`
 * or `sketchFuture` in `source` that is NOT one of
 * extractSketchHistoryWriteHits's two recognized forms, and is NOT a pure
 * read / type position / local binding, is returned here as an
 * UNRECOGNIZED site -- "no caller may bypass the seam" enforced mechanically
 * rather than by convention.
 */
export function sweepUnrecognizedSketchHistorySites(
  fileName: string,
  source: string,
): UnrecognizedSketchHistorySite[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind)
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const sites: UnrecognizedSketchHistorySite[] = []

  ;(function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && WATCHED_FIELDS.has(node.text) && !isRecognizedExtractionKeyNode(node)) {
      const role = classifyIdentifierOccurrence(node)
      if (role !== 'read' && role !== 'binding' && role !== 'type') {
        sites.push({
          file: fileName,
          line: lineOf(node),
          field: node.text,
          enclosingFunction: enclosingFunctionName(node),
          text: nearestStatementText(node, sf),
          role: role as UnrecognizedSketchHistoryRole,
        })
      }
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && WATCHED_FIELDS.has(node.text)
    ) {
      const parent = node.parent
      const isKey =
        (parent !== undefined && ts.isPropertyAssignment(parent) && parent.name === node) ||
        (parent !== undefined && ts.isComputedPropertyName(parent) && parent.expression === node)
      if (isKey) {
        sites.push({
          file: fileName,
          line: lineOf(node),
          field: node.text,
          enclosingFunction: enclosingFunctionName(node),
          text: nearestStatementText(node, sf),
          role: 'string-literal-key',
        })
      }
    }
    node.forEachChild(visit)
  })(sf)

  return sites
}

export const SKETCH_HISTORY_RESTORE_CENSUS: readonly SketchHistoryCensusEntry[] = [
  {
    id: 'init-sketchHistory',
    file: 'src/store/index.ts',
    enclosingFunction: '<module-scope>',
    text: 'sketchHistory: []',
    class: 'init',
    note: 'Initial store state: history starts empty. Not a restore.',
  },
  {
    id: 'init-sketchFuture',
    file: 'src/store/index.ts',
    enclosingFunction: '<module-scope>',
    text: 'sketchFuture: []',
    class: 'init',
    note: 'Initial store state: future starts empty. Not a restore.',
  },
  {
    id: 'newProject-sketchHistory-reset',
    file: 'src/store/index.ts',
    enclosingFunction: 'newProject',
    text: 'sketchHistory: []',
    class: 'document-reset',
    note:
      'INT-21: New Project opens a new document lifetime, so the sketch undo stack it inherits ' +
      'must start empty. Written as part of the same state literal that clears projectHistory / ' +
      'projectFuture / sketchEntrySnapshot. Not a restore -- nothing is read back out of history; ' +
      'leaving it alive would let Undo restore a sketch owned by the project just closed.',
  },
  {
    id: 'newProject-sketchFuture-reset',
    file: 'src/store/index.ts',
    enclosingFunction: 'newProject',
    text: 'sketchFuture: []',
    class: 'document-reset',
    note:
      'INT-21: the redo half of the same New Project document-lifetime reset. Paired with ' +
      'newProject-sketchHistory-reset -- clearing only one stack is the defect this pair guards ' +
      'against, since a surviving redo stream can push closed-project geometry forward.',
  },
  {
    id: 'pushHistory-sketchHistory-append',
    file: 'src/store/index.ts',
    enclosingFunction: 'pushHistory',
    text: 'sketchHistory: [...s.sketchHistory.slice(-HISTORY_KEEP), s.activeSketch]',
    class: 'push-forward',
    note: 'pushHistory: appends the CURRENT (pre-edit) sketch snapshot; forward write, never a restore.',
  },
  {
    id: 'pushHistory-sketchFuture-clear',
    file: 'src/store/index.ts',
    enclosingFunction: 'pushHistory',
    text: 'sketchFuture: []',
    class: 'push-forward',
    note: 'pushHistory: a fresh edit branches history -- the redo stream is cleared, never restored.',
  },
  {
    id: 'pushHistory-dimension-transaction-history-rollback',
    file: 'src/store/index.ts',
    enclosingFunction: 'pushHistory',
    text: 'sketchHistory: prior.sketchHistory',
    class: 'transaction-rollback',
    note:
      'WO-3133: a rejected initial dimension cancels only its own forward transaction. The ' +
      'asynchronous verdict copies the pre-push sketchHistory back only when pending.history.top ' +
      'is still the current projectHistory top, so it cannot roll back a later authored step or ' +
      'a history-restored stack. This is stack repair for the rejected transaction, not a live ' +
      'geometry restore from history and not undo/redo traffic.',
  },
  {
    id: 'pushHistory-dimension-transaction-future-rollback',
    file: 'src/store/index.ts',
    enclosingFunction: 'pushHistory',
    text: 'sketchFuture: prior.sketchFuture',
    class: 'transaction-rollback',
    note:
      'WO-3133: the paired redo-stack half of the same rejected initial-dimension transaction. ' +
      'It restores the pre-push future only under the exact live-top identity guard alongside ' +
      'sketchHistory, preserving the pair as one cancellation and never restoring geometry by ' +
      'itself.',
  },
  {
    id: 'seam-undo-sketchHistory-pop',
    file: 'src/store/index.ts',
    enclosingFunction: 'restoreSketchFromHistorySeam',
    text: 'sketchHistory: s.sketchHistory.slice(0, -1)',
    class: 'seam-restore',
    note: 'The undo branch of the ONE choke point undo()/redo() both delegate to (SKC-56-R2).',
  },
  {
    id: 'seam-undo-sketchFuture-push',
    file: 'src/store/index.ts',
    enclosingFunction: 'restoreSketchFromHistorySeam',
    text: 'sketchFuture: [...s.sketchFuture.slice(-HISTORY_KEEP), s.activeSketch]',
    class: 'seam-restore',
    note: 'The undo branch stages the CURRENT (possibly mid-edit) sketch into sketchFuture -- exactly the snapshot the seam\'s re-solve half (not this write) makes safe for a later redo.',
  },
  {
    id: 'seam-redo-sketchHistory-push',
    file: 'src/store/index.ts',
    enclosingFunction: 'restoreSketchFromHistorySeam',
    text: 'sketchHistory: [...s.sketchHistory.slice(-HISTORY_KEEP), s.activeSketch]',
    class: 'seam-restore',
    note: 'The redo branch of the ONE choke point undo()/redo() both delegate to (SKC-56-R2).',
  },
  {
    id: 'seam-redo-sketchFuture-pop',
    file: 'src/store/index.ts',
    enclosingFunction: 'restoreSketchFromHistorySeam',
    text: 'sketchFuture: s.sketchFuture.slice(0, -1)',
    class: 'seam-restore',
    note: 'The redo branch of the ONE choke point undo()/redo() both delegate to (SKC-56-R2).',
  },
  {
    id: 'commitSketchTextEdit-truncate',
    file: 'src/store/index.ts',
    enclosingFunction: 'commitSketchTextEdit',
    text: 'sketchHistory: st.sketchHistory.slice(0, -1)',
    class: 'truncate',
    note: 'Discarding a just-placed empty text drops the create\'s own undo step outright -- never restores a snapshot into activeSketch, so the seam\'s invariant does not apply here.',
  },
  {
    id: 'cancelSketchTextEdit-truncate',
    file: 'src/store/index.ts',
    enclosingFunction: 'cancelSketchTextEdit',
    text: 'sketchHistory: st.sketchHistory.slice(0, -1)',
    class: 'truncate',
    note: 'Esc on a fresh untyped placement drops the create\'s own undo step outright -- same truncate-not-restore disposition as commitSketchTextEdit above.',
  },
  {
    id: 'snapshotSketchEntry-clone-history',
    file: 'src/store/index.ts',
    enclosingFunction: 'snapshotSketchEntry',
    text: 'sketchHistory: structuredClone(state.sketchHistory)',
    class: 'entry-snapshot',
    note: 'SKC-65: clones the history stack into the sketch-entry snapshot BEFORE a session begins. A read-and-preserve copy, not a restore.',
  },
  {
    id: 'snapshotSketchEntry-clone-future',
    file: 'src/store/index.ts',
    enclosingFunction: 'snapshotSketchEntry',
    text: 'sketchFuture: structuredClone(state.sketchFuture)',
    class: 'entry-snapshot',
    note: 'SKC-65: clones the redo stream into the sketch-entry snapshot BEFORE a session begins. A read-and-preserve copy, not a restore.',
  },
  {
    id: 'cancelActiveSketch-restore-history',
    file: 'src/store/index.ts',
    enclosingFunction: 'cancelActiveSketch',
    text: 'sketchHistory: snapshot.sketchHistory',
    class: 'entry-snapshot',
    note: 'SKC-65: cancel restores the WHOLE pre-entry snapshot in one transition (the session\'s existence is erased). Not undo traffic, so the seam invariant does not apply.',
  },
  {
    id: 'cancelActiveSketch-restore-future',
    file: 'src/store/index.ts',
    enclosingFunction: 'cancelActiveSketch',
    text: 'sketchFuture: snapshot.sketchFuture',
    class: 'entry-snapshot',
    note: 'SKC-65: cancel restores the pre-entry redo stream with the same snapshot transition. Not undo traffic, so the seam invariant does not apply.',
  },
  {
    id: 'discardPendingHistory-sketchHistory-pop',
    file: 'src/store/index.ts',
    enclosingFunction: 'discardPendingHistory',
    text: 'sketchHistory: s.sketchHistory.slice(0, -1)',
    class: 'discard-pending',
    note:
      'WO-1585: pops the sketchHistory half of the one pending entry a caller\'s own pushHistory() ' +
      'just pushed, guarded by identity against expectedTop (only the exact top entry the caller ' +
      'pushed is ever removed; anything else on top -- e.g. an app-level undo that already fired -- ' +
      'is left alone). A NestModal new-nest session\'s Dismiss uses this to keep its own abandoned ' +
      'Calculate off the undo stack instead of leaving it as a resurrectable provisional. Not undo ' +
      'traffic: no sketchFuture write, no re-solve, so the seam invariant does not apply.',
  },
] as const
