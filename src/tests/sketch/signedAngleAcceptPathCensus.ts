// WO SKC-59-R3 (audit MAJOR): the R1 "accept-path census" in
// angleDimSignedEdit.skc59.test.ts hand-anchored on TWO named function
// signatures (`commitDimensionValue:\s*\(dimId,\s*value\)\s*=>`, one per
// host) plus a regex check of the overlay file. It never DERIVED the domain
// -- a brand-new value-write site (a new function, or a second write inside
// an already-known function) could be added with no census entry noticing,
// and the raw `setDimensionValue` sink was simply never looked at.
//
// SKC-59-R4 (DECISIONS.md 2026-07-18 "SKC-59 census two-bounce STOP"): this
// module is a TRIPWIRE, not a proof. It catches the COMMON write shapes and
// naive new sinks in the five already-derived files -- it is NOT, and is not
// claimed to be, a sound static analysis of every dimension-value write in a
// dynamically-typed store (that is an unsound problem for a test to solve,
// per the ruling). The actual INVARIANT -- a reverseB=true angle dimension's
// value can never carry the wrong sign, no matter which write path produced
// it -- now lives at the solver boundary: `reversedAngleValueSignValid`
// (dimTool.ts), enforced by a fail-loud guard in gcsMapping's 'angle' case.
// That guard is sound BY CONSTRUCTION (every reverseB=true dim must pass
// through it to reach the solver); this census remains a useful, cheap
// early-warning layer on top of it, no more. No further soundness rounds are
// owed against this file.
//
// This module derives, mechanically, EVERY site in the codebase that writes
// a `value` field onto a `SketchDimension`, and classifies each as either
// SIGNED (proven, not merely claimed, to route through `signedAngleEditValue`)
// or ANGLE-IRRELEVANT (a named, human-reviewed reason it is not a raw typed
// magnitude). A site matching neither is UNCLASSIFIED -- a can-fail result,
// never silently accepted.
//
// THE ANCHOR, justified as exhaustive: a `SketchDimension.value` can only
// ever reach persisted state via a write to the `dimensions` array (there is
// no other field that holds it). `dimensionWritePathCensus.ts`
// (WO UI-50C-R2..R5) already independently proves, by a real AST parse (not
// a hand list), that EVERY `dimensions` array write across the five files in
// `DERIVED_FILES` is enumerated in `DIMENSION_WRITE_PATH_CENSUS` -- that
// census's own companion test fails RED if a new dimensions-write function or
// form appears anywhere in those files. Therefore the set of
// `(file, enclosingFunction)` pairs already named by that census's entries is
// itself an exhaustive, mechanically-derived list of every function that can
// possibly mutate a dimension's `value` field: scanning each such function's
// COMPLETE body (not just the one-line fragment `dimensionWritePathCensus`
// captured for its own purposes) for every `value:` property write recurses
// into any indirection for free -- a per-dimension edit built through a named
// intermediate variable (`updated`, `flipped`) is found because the variable's
// OWN initializer lives in the same function body, not because this module
// knows that variable's name in advance.
//
// A genuinely NEW accept path (a new function that writes `dimensions`, or a
// dimensions-write site in an as-yet-unlisted file) is not invisible: it must
// FIRST pass `dimensionWritePathCensus.test.ts`'s own exhaustive sweep (gain a
// `DIMENSION_WRITE_PATH_CENSUS` entry) before it can appear in this module's
// target-function set at all -- the two censuses compose, neither re-derives
// the other's guarantee.
//
// ONE file writes a typed value into this pipeline without ever writing
// `dimensions` itself: the overlay
// (`src/lib/sketch/sketcher/overlays/SketchDimensionOverlay.tsx`), which is
// NOT one of the five `DERIVED_FILES` (it holds no `dimensions:` literal at
// all -- it delegates). That gap is closed separately, in the companion test,
// by running the sibling census's own `extractDimensionWriteHits` against the
// overlay's real source and requiring ZERO hits (proving the overlay never
// constructs/assigns a `dimensions` array itself) plus a positive count of
// `port.commitDimensionValue(` call sites (proving it actually delegates
// rather than going silent).
//
// SCOPE (stated once, honestly, matching the sibling census's own practice):
// this module covers only the EDIT-an-existing-dimension's-value domain (the
// exact class of Operator's bug -- a typed magnitude entering an ALREADY-PLACED
// dimension). Fresh dimension CREATION (drawing a brand-new angle dim, whose
// initial value is always MEASURED from the just-drawn geometry, never typed)
// is a structurally different call path (`addDimension`'s INSERT site, which
// this module's own scan finds carries no `value:` write of its own -- the
// `dimension` object it inserts is built by the CALLING tool, not by
// `addDimension`) and is out of scope, exactly as it was in R1/R2.
import ts from 'typescript'
import { DIMENSION_WRITE_PATH_CENSUS } from './dimensionWritePathCensus'

/** One AST-located `value:` (or shorthand `{ value }`) property write found
 *  inside the body of a function ALREADY named by a `DIMENSION_WRITE_PATH_CENSUS`
 *  entry for this file (see the module header for why that domain is
 *  exhaustive). */
export interface ValueWriteSite {
  file: string
  enclosingFunction: string
  line: number
  /** Normalized (comments stripped, whitespace collapsed) text of the
   *  immediately-containing object literal -- the site's identity key. */
  containerText: string
  /** Normalized text of the `value:` property's initializer expression
   *  (or the literal string `'value'` for a shorthand `{ ...d, value }`
   *  property, which reads the enclosing scope's `value` binding directly). */
  initializerText: string
  /** True iff, within the SAME enclosing function body, `initializerText` is
   *  either a direct `signedAngleEditValue(...)` call, or an identifier bound
   *  by `const <name> = signedAngleEditValue(...)` earlier in that function --
   *  a real dataflow check against the function's actual source, not a
   *  name-shape guess. */
  routesThroughSignedHelper: boolean
}

export type ValueWriteClassification = 'signed' | 'angle-irrelevant' | 'UNCLASSIFIED'

export interface ValueWriteVerdict {
  site: ValueWriteSite
  classification: ValueWriteClassification
  reason: string | null
}

/** The bounded, human-reviewed escape hatch: a site whose written value is
 *  proven (by the accompanying `reason`) to never carry a raw typed magnitude,
 *  so `signedAngleEditValue` does not apply to it. Matched by the SAME
 *  (file, enclosingFunction, containerText) identity as a `ValueWriteSite` --
 *  if the site's text changes at all, the entry stops matching and the site
 *  reverts to UNCLASSIFIED until a human re-reviews it. */
export interface NamedAngleIrrelevantReason {
  id: string
  file: string
  enclosingFunction: string
  containerText: string
  reason: string
}

function stripCommentsAndNormalize(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The name a function-like node is bound to, or null if anonymous. Mirrors
 *  `dimensionWritePathCensus.ts`'s own `namedOf` (duplicated rather than
 *  imported so this module never needs to touch that already-audited file). */
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

function findFunctionNodesNamed(sf: ts.SourceFile, name: string): ts.Node[] {
  const found: ts.Node[] = []
  ;(function visit(node: ts.Node): void {
    if (
      ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
    ) {
      if (namedOf(node) === name) found.push(node)
    }
    node.forEachChild(visit)
  })(sf)
  return found
}

/** Every `const <ident> = signedAngleEditValue(...)` binding declared
 *  anywhere inside `fnNode`'s own body (IIFEs included -- they share the
 *  enclosing function's scope for this module's purposes). */
function collectSignedBindingNames(fnNode: ts.Node): Set<string> {
  const names = new Set<string>()
  ;(function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.initializer !== undefined && ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'signedAngleEditValue'
    ) {
      names.add(node.name.text)
    }
    node.forEachChild(visit)
  })(fnNode)
  return names
}

const DIRECT_SIGNED_CALL = /^signedAngleEditValue\(/

/**
 * Mechanically derives every `value:` / shorthand `{ value }` property write
 * inside the body of each function that `DIMENSION_WRITE_PATH_CENSUS` already
 * names for `fileName` (see the module header for the exhaustiveness
 * argument). Returns `[]` for a file with no census entries (nothing to
 * scan -- e.g. `sketchSessionStore.ts`, which never independently writes a
 * dimension's value).
 */
export function findValueWriteSites(fileName: string, source: string): ValueWriteSite[] {
  const targetFns = [...new Set(
    DIMENSION_WRITE_PATH_CENSUS.filter((e) => e.file === fileName).map((e) => e.enclosingFunction),
  )]
  if (targetFns.length === 0) return []
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind)
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const sites: ValueWriteSite[] = []

  for (const fnName of targetFns) {
    for (const fnNode of findFunctionNodesNamed(sf, fnName)) {
      const signedBindings = collectSignedBindingNames(fnNode)
      ;(function visit(node: ts.Node): void {
        if (
          (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
          ts.isIdentifier(node.name) && node.name.text === 'value'
        ) {
          const container = node.parent
          const initializerText = ts.isPropertyAssignment(node)
            ? stripCommentsAndNormalize(node.initializer.getText(sf))
            : 'value'
          const routesThroughSignedHelper =
            DIRECT_SIGNED_CALL.test(initializerText) || signedBindings.has(initializerText)
          sites.push({
            file: fileName,
            enclosingFunction: fnName,
            line: lineOf(node),
            containerText: stripCommentsAndNormalize(container.getText(sf)),
            initializerText,
            routesThroughSignedHelper,
          })
        }
        node.forEachChild(visit)
      })(fnNode)
    }
  }
  return sites
}

/**
 * Classifies one derived site: SIGNED if the extraction already proved it
 * routes through `signedAngleEditValue`; otherwise ANGLE-IRRELEVANT if (and
 * only if) an entry in `namedReasons` matches this exact site identity;
 * otherwise UNCLASSIFIED -- the can-fail state the companion test asserts
 * never occurs in the real derived files.
 */
export function classifyValueWriteSite(
  site: ValueWriteSite,
  namedReasons: readonly NamedAngleIrrelevantReason[],
): ValueWriteVerdict {
  if (site.routesThroughSignedHelper) return { site, classification: 'signed', reason: null }
  const match = namedReasons.find(
    (r) => r.file === site.file && r.enclosingFunction === site.enclosingFunction && r.containerText === site.containerText,
  )
  if (match !== undefined) return { site, classification: 'angle-irrelevant', reason: match.reason }
  return { site, classification: 'UNCLASSIFIED', reason: null }
}

// ---------------------------------------------------------------------------
// The committed classification data. Every entry below is a HUMAN ruling
// matched against a MECHANICALLY DERIVED site (see `findValueWriteSites` +
// the companion test) -- a site whose text drifts even slightly stops
// matching and reverts to UNCLASSIFIED, and a brand-new site (a genuinely new
// `value:` write in an already-named function) is never in this list to
// begin with, so it is UNCLASSIFIED from the moment it is written.
//
// `cam-setDimensionValue-raw` is deliberately NOT in this list. It is the
// audit's exact named gap: `setDimensionValue` writes `{ ...d, value }` --
// the RAW typed magnitude, never signed -- with no guard against `dim.kind
// === 'angle'`. It has no production caller today (proven by the companion
// test's repo-wide grep, not merely asserted here), so it is not a CURRENT
// runtime defect, but it is also not "angle-irrelevant" in the safe,
// permanent sense every other entry below is: if a future caller ever wires
// an angle dimension through this sink, the write is unsigned. Leaving it
// off this list means the census's own UNCLASSIFIED-sites assertion would
// fail the moment someone "fixes" that by writing a reason for it without
// also either signing the sink or keeping the zero-callers proof current --
// the honest treatment is a NAMED, VISIBLE, PERMANENTLY-FAILING entry in the
// companion test's own known-gaps list, not a quiet classification here.
export const NAMED_ANGLE_IRRELEVANT_VALUE_WRITES: readonly NamedAngleIrrelevantReason[] = [
  {
    id: 'cam-toggle-repair-d1xd2',
    file: 'src/store/index.ts',
    enclosingFunction: 'toggleDimensionDriving',
    containerText: '{ ...dim, driving: false, value: m.d1, d2: m.d2 }',
    reason: "d1xd2 driving->reference repair: value is m.d1, a FRESH MEASUREMENT from measureChamferSetbacks against the CURRENT geometry -- never a raw typed magnitude. d1xd2 is not an 'angle' kind, so signedAngleEditValue would not even apply to it if it were typed.",
  },
  {
    id: 'cam-toggle-repair-angle',
    file: 'src/store/index.ts',
    enclosingFunction: 'toggleDimensionDriving',
    containerText: "{ ...dim, driving: false, value: m.value, reverseB: m.reverseB }",
    reason: "angle driving->reference repair: value AND reverseB come ATOMICALLY from measureAngleDimension's own sector measurement of the current solved geometry -- a re-derivation from live state, never a typed magnitude, so there is no unsigned input to normalize.",
  },
  {
    id: 'cam-toggle-repair-generic',
    file: 'src/store/index.ts',
    enclosingFunction: 'toggleDimensionDriving',
    containerText: '{ ...dim, driving: false, value: measureDimension(sk.entities, dim) ?? dim.value }',
    reason: 'generic (non-d1xd2, non-angle) driving->reference repair: value is measureDimension\'s measured output (or the unchanged existing value on measurement failure) -- never a typed magnitude.',
  },
  {
    id: 'cam-updateDimensionLabel-sector-crossing',
    file: 'src/store/index.ts',
    enclosingFunction: 'updateDimensionLabel',
    containerText: '{ value: valueOverride.value, reverseB: valueOverride.reverseB }',
    reason: "label-drag sector crossing: value/reverseB are angleLabelDragValueOverride's OWN signed candidate for the anchor's CURRENT sector (selectAngleSector against live geometry) -- never a caller-typed magnitude, so there is no unsigned input for signedAngleEditValue to normalize.",
  },
  {
    id: 'cam-onmessage-dimension-revert',
    file: 'src/store/index.ts',
    enclosingFunction: 'onmessage',
    containerText: '{ ...d, value: revert.value, expression: revert.expression }',
    reason: "conflict-reject revert: revert.value is the dimension's OWN value captured (as `prev`) immediately BEFORE the rejected edit was applied -- an already-correctly-signed PERSISTED value being restored, never a fresh typed input to renormalize. \"sketch-dim equations wiring\": revert.expression travels alongside it (also captured before the edit, as `prevExpression`) so a rejected equation commit restores BOTH together -- never a reverted value paired with a stale (rejected) expression string.",
  },
  {
    id: 'cam-commitDimensionValue-revert-descriptor',
    file: 'src/store/index.ts',
    enclosingFunction: 'commitDimensionValue',
    containerText: "{ kind: 'restore', value: prev, expression: prevExpression }",
    reason: "NOT a dimension write at all: this `value:` belongs to the plain `PendingDimensionApply.revert` descriptor object (captures prev = dim.value, the value BEFORE this edit, for a later conflict-revert). It is never itself written into a `dimensions` array -- the site that actually APPLIES a revert is the separate, separately-classified 'cam-onmessage-dimension-revert' entry above (`{ ...d, value: revert.value, expression: revert.expression }`), which reads `prev`/`prevExpression` back out through `revert.value`/`revert.expression`.",
  },
  // The two d1xd2 (chamfer setback pair, WO-1858) twins of the revert pair above.
  // d1xd2 is not an angle kind and both writes restore already-persisted numbers.
  {
    id: 'cam-commitDimensionValue-revert-descriptor-d1xd2',
    file: 'src/store/index.ts',
    enclosingFunction: 'commitDimensionValue',
    containerText: "{ kind: 'restore', value: dim.value, d2: prev, expression: prevExpression }",
    reason: "NOT a dimension write: the d1xd2 (d2-half edit) flavour of the PendingDimensionApply.revert descriptor -- it captures the dimension's OWN prior value (dim.value) and prior d2 for a later conflict-revert. Never itself written into a `dimensions` array; the applying site is the separately classified 'cam-onmessage-dimension-revert-d1xd2' entry.",
  },
  {
    id: 'cam-onmessage-dimension-revert-d1xd2',
    file: 'src/store/index.ts',
    enclosingFunction: 'onmessage',
    containerText: '{ ...d, value: revert.value, d2: revert.d2, expression: revert.expression }',
    reason: "conflict-reject revert of a d1xd2 setback edit: value/d2 are the dimension's OWN values captured immediately BEFORE the rejected edit -- already-persisted numbers being restored, never a fresh typed magnitude. d1xd2 is not an angle kind, so signedAngleEditValue would not apply anyway.",
  },
  {
    id: 'wb-overlays-toggle-repair-d1xd2',
    file: 'src/components/model3d/workbench/workbenchOverlaysPort.ts',
    enclosingFunction: 'toggleDimensionDriving',
    containerText: '{ ...dim, driving: false, value: m.d1, d2: m.d2 }',
    reason: 'workbench twin of cam-toggle-repair-d1xd2: value is m.d1, a fresh measureChamferSetbacks measurement -- never a raw typed magnitude, and d1xd2 is not an angle kind regardless.',
  },
  {
    id: 'wb-moveDimLabel-sector-crossing',
    file: 'src/components/model3d/workbench/workbenchSketchDocumentPort.ts',
    enclosingFunction: 'moveDimLabel',
    containerText: '{ value: valueOverride.value, reverseB: valueOverride.reverseB }',
    reason: 'workbench twin of cam-updateDimensionLabel-sector-crossing: value/reverseB are angleLabelDragValueOverride\'s own signed candidate for the current sector -- never a typed magnitude.',
  },
] as const
