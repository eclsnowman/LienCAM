// WO SKC-56-R3 (DECISIONS 2026-07-17 "SKC-56 async-coherence THIRD strike"
// ruling, requirement 1): the restore seam's invariant is "NO asynchronous
// write channel into the active sketch survives a history restore", where the
// channel list is DERIVED FROM THE CODE -- never a hand list of the mechanisms
// the last fix happened to know about.
//
// ===========================================================================
// STATUS: DEFENSE-IN-DEPTH. THIS CENSUS NO LONGER OWNS CORRECTNESS.
// ===========================================================================
// Read this before trusting a GREEN verdict here (WO SKC-56-R4; DECISIONS
// 2026-07-17 "SKC-56 FOURTH strike"). The R3 audit proved this file's domain
// CANNOT be closed as the third-strike ruling specified -- it found a real new
// channel that stayed GREEN here -- and the program response was to INVERT the
// invariant rather than widen the sweep again. Correctness now lives at the
// store's epoch gate (commitSketchGeometry in src/store/index.ts): every
// deferred write carries the epoch it was minted under and a stale one is
// refused BY CONSTRUCTION, so a channel nobody enumerated -- including one this
// census cannot see -- is refused anyway. That claim is proven, not asserted,
// by the unknown-channel cell in undoInFlightSolve.skc56r1.test.ts, which mints
// a throwaway writer appearing in NO census and watches the gate refuse it.
//
// What this file is FOR, now: regression documentation of the channels four
// rounds found by hand, plus an early warning when a new module-scope holder
// appears without a disposition. Its verdict is ADVISORY. A RED here means
// "someone should look", not "the sketch is corrupt"; a GREEN here means
// nothing about safety on its own -- the gate is the safety.
//
// KNOWN GAPS, stated rather than papered over (the ruling: "Do not chase
// further census completeness - the gate owns correctness"). These are why a
// GREEN verdict here is not a correctness claim:
//   - TIER 1 does not enumerate DESTRUCTURED module-scope bindings
//     (`let { a } = ...`): extractModuleScopeMutables skips a non-identifier
//     binding name, so such a binding is invisible, NOT red. (The pre-R4
//     comment on that line claimed "RED-by-absence if added" -- it was wrong,
//     and saying so is cheaper than a wrong reassurance.)
//   - TIER 2 recognizes only INLINE function nodes whose parent is the
//     scheduling call, so `setTimeout(namedWriter, 25)` -- a callback passed by
//     REFERENCE -- is not derived as a deferred site. The R3 audit demonstrated
//     exactly this form slipping through, and the R3 report's claim that tier 1
//     always covers it was incorrect.
// Both gaps are ACCEPTED under the fourth-strike ruling. Neither can produce
// the failure this program exists to stop, because a channel these gaps hide
// still cannot write stale geometry: it must pass the epoch gate like every
// other deferred write. Closing them would make this file a better advisor; it
// would not make the store safer.
//
// The R4 WIDENING the ruling did authorize (exactly one): tier 1 now includes
// module-scope const-held mutable containers. See extractModuleScopeMutables.
//
// WHY THIS FILE EXISTS. Three rounds failed the same criterion the same way:
// R0 neutralized nothing, R1 neutralized the solve REQUEST it knew about
// (latestSketchRequestId), R2 kept that plus the two verdict trackers and
// built the single seam -- and the R2 audit proved a debounced DRAG queued
// before undo STILL survived the restore and overwrote restored geometry. The
// seam was real; its invariant's SCOPE was a mechanism list. So the scope is
// now mechanical: this census derives the domain, and it FAILS when a new
// channel appears without a disposition.
//
// TWO-TIER DOMAIN (both tiers fail CLOSED -- an unclassified member is RED,
// never assumed safe):
//
//   TIER 1 -- STATE HOLDERS. Every module-scope mutable (`let`) declared in
//   src/store/index.ts. Each is either:
//     (a) class 'channel'  -- it can hold a pending asynchronous write into
//         the active sketch, so it MUST be positively neutralized inside
//         restoreSketchFromHistorySeam (asserted mechanically below: the seam
//         must contain an assignment to it, and a 'channel-timer' must ALSO
//         carry a clearTimeout call there), or
//     (b) in CHANNEL_NAMED_EXCLUSIONS -- with a stated reason, mirroring the
//         dimensionWritePathCensus NAMED_RULINGS precedent.
//   Nothing else is permitted: a brand-new module-scope `let` matches neither
//   table and the census is RED until someone rules on it.
//
//   THE TIER-1 DERIVATION TRAP the ruling names explicitly: keying the domain
//   on "assigned inside a setTimeout/onmessage body" structurally MISSES
//   sketchDragPlan -- it is assigned OUTSIDE any deferred body (in
//   beginSketchDrag) and only READ inside one, yet it is precisely the channel
//   that carries PRE-restore drag targets across a keyboard undo. Keying on
//   the DECLARATION (every module-scope `let`, no matter where it is written)
//   has no such blind spot: the domain is a syntactic property of the file, so
//   membership cannot depend on anyone anticipating the shape of the next bug.
//
//   TIER 2 -- DEFERRED WRITE SITES. Every function-like node in
//   src/store/index.ts that is DEFERRED (a timer callback, a promise
//   callback, an event-handler assignment, or an async body containing an
//   await -- i.e. its code runs after the statement that created it returns,
//   so a restore can interleave ahead of it) AND that can WRITE SKETCH STATE.
//   "Can write" is computed by a call-graph fixed point (`writes()` below),
//   not by looking for a literal write in the body: importSketchFont's
//   post-await continuation writes activeSketch only through
//   applyTextEditPatch, one call away, and a body-local check would silently
//   miss it (the ruling names this site by hand precisely because a naive
//   sweep loses it). Each derived site must match exactly one
//   DEFERRED_SKETCH_WRITE_SITES entry with a stated disposition; the entry
//   also declares how many sites its key covers, so growing a SECOND deferral
//   inside an already-classified function is RED rather than absorbed.
//
// Real (`typescript` compiler API) AST parse throughout, never a text/regex
// scan -- so a comment or a string literal can neither forge nor hide a
// member. Same technique as the two committed precedents in this directory
// (dimensionWritePathCensus.ts, sketchHistoryRestoreCensus.ts); the extraction
// functions are exported so the companion test runs the SAME code against both
// the real file and adversarial fixture sources.

import ts from 'typescript'

export const DERIVED_FILES = ['src/store/index.ts'] as const

/** The seam every history restore routes through (proven to be the only such
 *  path by the sketchHistoryRestoreCensus, SKC-56-R2). Tier 1's neutralization
 *  check is scoped to this function BY NAME: neutralizing a channel anywhere
 *  else is not neutralizing it on the restore path. */
export const SEAM_FUNCTION = 'restoreSketchFromHistorySeam'

/** Sketch-state write targets for tier 2's `writes()` fixed point. A write to
 *  `activeSketch` is a DIRECT write of the document; a write to
 *  `latestSketchRequestId` mints a solve request whose response WILL write the
 *  document when it lands -- an asynchronous write into the active sketch just
 *  the same, one worker round-trip later (this is exactly how the R2 blocker's
 *  drag channel does its damage, so a sweep that ignored it would miss the
 *  very site the round exists for). */
const SKETCH_WRITE_TARGETS = new Set(['activeSketch', 'latestSketchRequestId'])

// ---------------------------------------------------------------------------
// Shared AST helpers (same shapes as the two precedent census modules).
// ---------------------------------------------------------------------------

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

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
}

/** Nearest NAMED function-like ancestor, skipping anonymous callbacks -- same
 *  walk as both precedent censuses, so a site keys to the named action it is
 *  lexically defined inside, never an anonymous wrapper. */
function enclosingFunctionName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent
  while (cur !== undefined) {
    if (isFunctionLike(cur)) {
      const name = namedOf(cur)
      if (name !== null) return name
    }
    cur = cur.parent
  }
  return '<module-scope>'
}

function parse(fileName: string, source: string): ts.SourceFile {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind)
}

// ---------------------------------------------------------------------------
// TIER 1: module-scope mutable state holders.
// ---------------------------------------------------------------------------

export type ChannelClass =
  /** Holds a pending asynchronous write into the active sketch. MUST be
   *  assigned inside SEAM_FUNCTION. */
  | 'channel'
  /** A 'channel' whose pending write is carried by a live timer handle: the
   *  seam must ALSO clearTimeout it, since dropping the handle without
   *  cancelling leaves the callback armed and firing. */
  | 'channel-timer'

export interface ChannelCensusEntry {
  id: string
  file: (typeof DERIVED_FILES)[number]
  /** The module-scope `let` binding name. */
  name: string
  class: ChannelClass
  /** What pending write it can carry, and what neutralizing it costs. */
  note: string
}

export interface ChannelNamedExclusion {
  id: string
  file: (typeof DERIVED_FILES)[number]
  name: string
  /** Why this module-scope mutable is NOT an asynchronous write channel into
   *  the active sketch. Never empty (asserted). */
  reason: string
}

export interface ModuleScopeMutable {
  file: string
  line: number
  name: string
  /** The declaration's own normalized text (`let x: T | null = null`). */
  text: string
}

/**
 * Every module-scope `let` binding declared in `source`. Module-scope means a
 * VariableStatement that is a DIRECT child of the SourceFile -- a `let` inside
 * any function body is ordinary local state that cannot outlive its call, so
 * it can hold nothing across a restore.
 */
export function extractModuleScopeMutables(fileName: string, source: string): ModuleScopeMutable[] {
  const sf = parse(fileName, source)
  const out: ModuleScopeMutable[] = []
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0
    for (const decl of stmt.declarationList.declarations) {
      // THE R4 WIDENING (WO SKC-56-R4 item 4; the R3 audit's BLOCKER (tests)).
      // `const` was equated with immutable CONTENTS, which is false: a `const`
      // binding cannot be re-pointed, but a const-held OBJECT or ARRAY can have
      // its fields assigned, and that is enough to carry pending geometry
      // across a restore. The auditor proved it with
      // `const auditDebounce = { pending: null }` -- a brand-new real channel
      // that produced no classification problem at all. Mutable STORAGE, not
      // binding immutability, is the criterion: a const initialized to an
      // object/array literal is in-domain; `const N = 3` / `const f = () => {}`
      // / `const S = 'x'` cannot hold a field write and stay out.
      // (`var` is in-domain via !isConst too; the file has none today.)
      if (isConst && !isMutableContainerInitializer(decl.initializer)) continue
      if (!ts.isIdentifier(decl.name)) continue // see KNOWN GAPS in the header
      out.push({
        file: fileName,
        line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1,
        name: decl.name.text,
        text: stripCommentsAndNormalize(decl.getText(sf)),
      })
    }
  }
  return out
}

/** A const initializer whose CONTENTS are mutable, i.e. storage a later
 *  `x.field = pendingSketch` can write. Object/array literals only: those are
 *  the forms that hold assignable fields directly in this file, and the
 *  widening the ruling authorized is exactly one, not an open-ended
 *  reachability analysis (the epoch gate owns correctness now -- see the
 *  header). `as const` and parenthesized/satisfies wrappers are unwrapped so a
 *  spelling cannot dodge the domain. */
function isMutableContainerInitializer(init: ts.Expression | undefined): boolean {
  if (init === undefined) return false
  let e: ts.Expression = init
  for (;;) {
    if (ts.isParenthesizedExpression(e)) { e = e.expression; continue }
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) { e = e.expression; continue }
    break
  }
  return ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)
}

export interface SeamNeutralization {
  /** The binding the seam assigns. */
  name: string
  line: number
  /** The assignment's normalized text. */
  text: string
}

/**
 * Every module-scope binding ASSIGNED inside SEAM_FUNCTION's body, i.e. every
 * channel the seam positively neutralizes. Only bare `name = ...` assignments
 * count: a write through a property (`obj.name = ...`) is not a write of the
 * module-scope binding.
 */
export function extractSeamNeutralizations(fileName: string, source: string): SeamNeutralization[] {
  const sf = parse(fileName, source)
  const seam = findFunctionByName(sf, SEAM_FUNCTION)
  if (!seam) return []
  const out: SeamNeutralization[] = []
  ;(function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      out.push({
        name: node.left.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        text: stripCommentsAndNormalize(node.getText(sf)),
      })
    }
    node.forEachChild(visit)
  })(seam)
  return out
}

/** Every identifier passed to a `clearTimeout(...)`/`clearInterval(...)` call
 *  inside SEAM_FUNCTION -- the extra proof a 'channel-timer' needs (dropping a
 *  timer handle without cancelling leaves its callback armed). */
export function extractSeamTimerCancels(fileName: string, source: string): string[] {
  const sf = parse(fileName, source)
  const seam = findFunctionByName(sf, SEAM_FUNCTION)
  if (!seam) return []
  const out: string[] = []
  ;(function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      (node.expression.text === 'clearTimeout' || node.expression.text === 'clearInterval')
    ) {
      const arg = node.arguments[0]
      if (arg !== undefined && ts.isIdentifier(arg)) out.push(arg.text)
    }
    node.forEachChild(visit)
  })(seam)
  return out
}

function findFunctionByName(sf: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null
  ;(function visit(node: ts.Node): void {
    if (found) return
    if (isFunctionLike(node) && namedOf(node) === name) { found = node; return }
    node.forEachChild(visit)
  })(sf)
  return found
}

export function matchingChannelEntries(m: ModuleScopeMutable): ChannelCensusEntry[] {
  return ASYNC_WRITE_CHANNEL_CENSUS.filter((e) => e.file === m.file && e.name === m.name)
}

export function matchingExclusions(m: ModuleScopeMutable): ChannelNamedExclusion[] {
  return CHANNEL_NAMED_EXCLUSIONS.filter((e) => e.file === m.file && e.name === m.name)
}

export interface ClassificationProblem {
  name: string
  line: number
  /** 'unclassified' -- matches NEITHER table, so nobody has ruled on whether it
   *  can carry a pending write across a restore. This is the fail-closed case
   *  the whole round exists for: a new channel appearing without a disposition
   *  is RED, never silently safe.
   *  'double-classified' -- matches BOTH tables, i.e. it is claimed to be a
   *  channel AND excused from being one. Ambiguous rulings are refused rather
   *  than resolved by table order. */
  kind: 'unclassified' | 'double-classified'
}

/** Every module-scope mutable that is not classified exactly once. The two
 *  table parameters default to the real census and exist so the adversarial
 *  fixtures can drive THIS function -- never a re-implemented copy -- with a
 *  constructed collision. */
export function auditClassification(
  mutables: readonly ModuleScopeMutable[],
  census: readonly ChannelCensusEntry[] = ASYNC_WRITE_CHANNEL_CENSUS,
  exclusions: readonly ChannelNamedExclusion[] = CHANNEL_NAMED_EXCLUSIONS,
): ClassificationProblem[] {
  const problems: ClassificationProblem[] = []
  for (const m of mutables) {
    const c = census.filter((e) => e.file === m.file && e.name === m.name).length
    const x = exclusions.filter((e) => e.file === m.file && e.name === m.name).length
    if (c + x === 0) problems.push({ name: m.name, line: m.line, kind: 'unclassified' })
    else if (c + x > 1) problems.push({ name: m.name, line: m.line, kind: 'double-classified' })
  }
  return problems
}

export interface SeamViolation {
  channelId: string
  name: string
  /** 'not-neutralized' -- the seam contains no assignment to this channel, so a
   *  write pending in it survives the restore (the R2 blocker's exact shape).
   *  'timer-not-cancelled' -- the seam nulls the handle but never clearTimeout
   *  s it, so the callback stays ARMED and fires anyway: dropping a timer
   *  handle is not cancelling a timer. */
  kind: 'not-neutralized' | 'timer-not-cancelled'
}

/**
 * Every censused channel the seam fails to neutralize, given the seam's
 * DERIVED assignments/cancels. This is the load-bearing check: it is what
 * would have caught the R2 blocker at commit time (dragDebounceTimer was a
 * channel by tier 1's structural domain, and the R2 seam assigned it nowhere).
 */
export function auditSeamNeutralization(
  neutralizations: readonly SeamNeutralization[],
  timerCancels: readonly string[],
  census: readonly ChannelCensusEntry[] = ASYNC_WRITE_CHANNEL_CENSUS,
): SeamViolation[] {
  const assigned = new Set(neutralizations.map((n) => n.name))
  const cancelled = new Set(timerCancels)
  const out: SeamViolation[] = []
  for (const c of census) {
    if (!assigned.has(c.name)) { out.push({ channelId: c.id, name: c.name, kind: 'not-neutralized' }); continue }
    if (c.class === 'channel-timer' && !cancelled.has(c.name)) {
      out.push({ channelId: c.id, name: c.name, kind: 'timer-not-cancelled' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// TIER 2: deferred sketch-write sites (call-graph fixed point).
// ---------------------------------------------------------------------------

export type DeferralKind =
  /** Argument to setTimeout/setInterval/queueMicrotask/requestAnimationFrame. */
  | 'timer-callback'
  /** Argument to .then/.catch/.finally. */
  | 'promise-callback'
  /** Assigned to an .onmessage/.onerror/.onmessageerror handler property. */
  | 'event-handler'
  /** An async function whose body contains an await: everything after the
   *  first await runs on a later microtask, so a restore can interleave. */
  | 'async-body'

export interface DeferredWriteSite {
  file: string
  line: number
  /** The deferred callback's own name if it has one (`onmessage`), else the
   *  nearest NAMED enclosing function (`dragSolveSketch`). */
  siteFunction: string
  deferral: DeferralKind
  /** The deferral construct's own head text (the timer callee + delay, the
   *  handler's assignment target, the promise callee chain, or the async
   *  function's signature) -- NOT the callback body, which for the solver
   *  worker's onmessage is 130+ lines. Uniqueness within a function is carried
   *  by this plus the entry's own `siteCount`. */
  anchorText: string
}

export interface DeferredSiteEntry {
  id: string
  file: (typeof DERIVED_FILES)[number]
  siteFunction: string
  deferral: DeferralKind
  anchorText: string
  /** How many derived sites this key legitimately covers. Asserted exactly:
   *  a SECOND deferral growing inside an already-classified function is RED,
   *  never absorbed by the existing entry. */
  siteCount: number
  /** 'neutralized' -- the pending write is dropped by the seam via a tier-1
   *  channel (name it in the note); 'no-seam-action' -- the site cannot carry
   *  a pre-restore write into the restored sketch (justify in the note). */
  disposition: 'neutralized' | 'no-seam-action'
  note: string
}

const TIMER_CALLEES = new Set(['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'])
const PROMISE_CALLEES = new Set(['then', 'catch', 'finally'])
const HANDLER_PROPS = new Set(['onmessage', 'onerror', 'onmessageerror'])

function deferralKindOf(fn: ts.FunctionLikeDeclaration): DeferralKind | null {
  const p = fn.parent
  if (p !== undefined && ts.isCallExpression(p) && p.arguments.some((a) => a === fn)) {
    if (ts.isIdentifier(p.expression) && TIMER_CALLEES.has(p.expression.text)) return 'timer-callback'
    if (ts.isPropertyAccessExpression(p.expression) && TIMER_CALLEES.has(p.expression.name.text)) return 'timer-callback'
    if (ts.isPropertyAccessExpression(p.expression) && PROMISE_CALLEES.has(p.expression.name.text)) return 'promise-callback'
  }
  if (
    p !== undefined && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.right === fn && ts.isPropertyAccessExpression(p.left) && HANDLER_PROPS.has(p.left.name.text)
  ) return 'event-handler'
  if (
    ts.canHaveModifiers(fn) &&
    (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) &&
    containsAwait(fn)
  ) return 'async-body'
  return null
}

/** An await ANYWHERE in `fn`'s own body (not inside a nested function, which
 *  owns its own deferral classification). */
function containsAwait(fn: ts.FunctionLikeDeclaration): boolean {
  let found = false
  ;(function visit(node: ts.Node): void {
    if (found) return
    if (node !== fn && isFunctionLike(node)) return
    if (ts.isAwaitExpression(node) || ts.isForOfStatement(node) && node.awaitModifier !== undefined) { found = true; return }
    node.forEachChild(visit)
  })(fn)
  return found
}

function anchorTextOf(fn: ts.FunctionLikeDeclaration, kind: DeferralKind, sf: ts.SourceFile): string {
  const p = fn.parent
  if (kind === 'timer-callback' && p !== undefined && ts.isCallExpression(p)) {
    // callee + the NON-callback arguments (the delay), never the body.
    const rest = p.arguments.filter((a) => a !== fn).map((a) => stripCommentsAndNormalize(a.getText(sf)))
    return `${stripCommentsAndNormalize(p.expression.getText(sf))}(<fn>${rest.length ? `, ${rest.join(', ')}` : ''})`
  }
  if (kind === 'promise-callback' && p !== undefined && ts.isCallExpression(p)) {
    return `${stripCommentsAndNormalize(p.expression.getText(sf))}(<fn>)`
  }
  if (kind === 'event-handler' && p !== undefined && ts.isBinaryExpression(p)) {
    return `${stripCommentsAndNormalize(p.left.getText(sf))} = <fn>`
  }
  // async-body: the signature (name + parameter list), never the body.
  const params = fn.parameters.map((x) => stripCommentsAndNormalize(x.getText(sf))).join(', ')
  return `async ${namedOf(fn) ?? '<anonymous>'}(${params})`
}

interface FunctionFacts {
  node: ts.FunctionLikeDeclaration
  /** Writes a SKETCH_WRITE_TARGETS member directly in its own body. */
  directWrite: boolean
  /** Names this function calls: `get().NAME(...)`, `NAME(...)`, or
   *  `useCamStore.getState().NAME(...)`. */
  calls: Set<string>
}

/** Every assignment operator (`=`, `+=`, `??=`, ...) -- the same kind-range
 *  check the two precedent census modules use (`ts.isAssignmentOperatorToken`
 *  is not part of the public typescript API surface this repo pins). */
function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

/** Is `node` an identifier/name occurrence that WRITES a sketch target? Three
 *  recognized write forms, mirroring the precedent censuses: a `target:`
 *  object-literal property (the Zustand `set({...})` form), a `.target =` /
 *  bare `target =` assignment, and a `'target':` string-literal key. */
function isSketchWrite(node: ts.Node): boolean {
  if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
    return SKETCH_WRITE_TARGETS.has(node.name.text)
  }
  if (ts.isBinaryExpression(node) && isAssignmentOperatorKind(node.operatorToken.kind)) {
    if (ts.isPropertyAccessExpression(node.left)) return SKETCH_WRITE_TARGETS.has(node.left.name.text)
    if (ts.isIdentifier(node.left)) return SKETCH_WRITE_TARGETS.has(node.left.text)
  }
  return false
}

/**
 * The name of the LOCAL function `call` invokes, or null if it does not invoke
 * one. Two recognized receiver shapes, and the narrowness is the point:
 *
 *   - `NAME(...)`            -- a bare call of a module-scope function.
 *   - `<store>.NAME(...)`    -- a store action, where <store> is `get()`,
 *                               `useCamStore.getState()`, or an identifier
 *                               bound to one of those (`const s = get()`).
 *
 * A method call on anything ELSE (`text.replace(...)`, `arr.map(...)`) is NOT
 * a local call. Keying on the callee NAME alone -- the obvious simplification
 * -- is measurably wrong here: the sketch mount exports an action literally
 * named `replace` that writes activeSketch directly, so a name-only graph
 * makes every `String.prototype.replace` caller in this 9500-line file a
 * "sketch writer" and drags saveProjectToFile and importBrepGeometry in as
 * bogus deferred channels. That noise is fail-CLOSED, but it is still noise,
 * and a census whose entries are mostly false has no teeth for a reviewer.
 */
function localCalleeNameOf(call: ts.CallExpression, storeAliases: ReadonlySet<string>): string | null {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (!ts.isPropertyAccessExpression(e)) return null
  const recv = e.expression
  // `get().NAME(...)` / `getState().NAME(...)`
  if (
    ts.isCallExpression(recv) &&
    (
      (ts.isIdentifier(recv.expression) && recv.expression.text === 'get') ||
      (ts.isPropertyAccessExpression(recv.expression) && recv.expression.name.text === 'getState')
    )
  ) return e.name.text
  // `s.NAME(...)` where `s` was bound to get()/getState()
  if (ts.isIdentifier(recv) && storeAliases.has(recv.text)) return e.name.text
  return null
}

/** Identifiers bound to `get()` / `useCamStore.getState()` anywhere in the
 *  file (`const s = get()`, `const s0 = useCamStore.getState()`). Collected
 *  file-wide rather than per-scope: an alias name reused for a NON-store value
 *  elsewhere would only ADD reach, never remove it -- fail-closed. */
function collectStoreAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>()
  ;(function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.initializer !== undefined && ts.isCallExpression(node.initializer)
    ) {
      const callee = node.initializer.expression
      if (
        (ts.isIdentifier(callee) && callee.text === 'get') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'getState')
      ) aliases.add(node.name.text)
    }
    node.forEachChild(visit)
  })(sf)
  return aliases
}

/**
 * Facts for every named function-like node in `source`, keyed by name. A name
 * can legitimately map to several nodes (a store action and a helper sharing a
 * name); `writes()` treats a name as a writer if ANY node under it writes --
 * fail-closed, since an over-broad reach only ADDS sites to disposition.
 */
function collectFunctionFacts(sf: ts.SourceFile, storeAliases: ReadonlySet<string>): Map<string, FunctionFacts[]> {
  const byName = new Map<string, FunctionFacts[]>()
  ;(function visit(node: ts.Node): void {
    if (isFunctionLike(node)) {
      const name = namedOf(node)
      if (name !== null) {
        const facts: FunctionFacts = { node, directWrite: false, calls: new Set() }
        ;(function scan(n: ts.Node): void {
          if (isSketchWrite(n)) facts.directWrite = true
          if (ts.isCallExpression(n)) {
            const c = localCalleeNameOf(n, storeAliases)
            if (c !== null) facts.calls.add(c)
          }
          n.forEachChild(scan)
        })(node)
        const list = byName.get(name)
        if (list) list.push(facts)
        else byName.set(name, [facts])
      }
    }
    node.forEachChild(visit)
  })(sf)
  return byName
}

/** Names that can reach a sketch-state write, as a least fixed point over the
 *  call graph. */
function computeWriterNames(byName: Map<string, FunctionFacts[]>): Set<string> {
  const writers = new Set<string>()
  for (const [name, list] of byName) if (list.some((f) => f.directWrite)) writers.add(name)
  let grew = true
  while (grew) {
    grew = false
    for (const [name, list] of byName) {
      if (writers.has(name)) continue
      if (list.some((f) => [...f.calls].some((c) => writers.has(c)))) { writers.add(name); grew = true }
    }
  }
  return writers
}

/** Can this specific function-like node reach a sketch write (directly, or
 *  through any call it makes -- INCLUDING calls made from nested callbacks
 *  inside it, which is conservative on purpose)? */
function nodeWrites(
  node: ts.FunctionLikeDeclaration, writers: ReadonlySet<string>, storeAliases: ReadonlySet<string>,
): boolean {
  let reaches = false
  ;(function scan(n: ts.Node): void {
    if (reaches) return
    if (isSketchWrite(n)) { reaches = true; return }
    if (ts.isCallExpression(n)) {
      const c = localCalleeNameOf(n, storeAliases)
      if (c !== null && writers.has(c)) { reaches = true; return }
    }
    n.forEachChild(scan)
  })(node)
  return reaches
}

/**
 * Every DEFERRED function-like node in `source` that can write sketch state.
 * Exported so the companion test runs the SAME algorithm against the real file
 * and against adversarial fixture sources.
 */
export function extractDeferredWriteSites(fileName: string, source: string): DeferredWriteSite[] {
  const sf = parse(fileName, source)
  const storeAliases = collectStoreAliases(sf)
  const byName = collectFunctionFacts(sf, storeAliases)
  const writers = computeWriterNames(byName)
  const sites: DeferredWriteSite[] = []
  ;(function visit(node: ts.Node): void {
    if (isFunctionLike(node)) {
      const kind = deferralKindOf(node)
      if (kind !== null && nodeWrites(node, writers, storeAliases)) {
        sites.push({
          file: fileName,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          // The deferred callback's OWN name when it has one (`onmessage`),
          // else the named action it is defined inside (`dragSolveSketch` for
          // its anonymous debounce arrow). Every store action is a property of
          // one giant anonymous object literal, so climbing past it would key
          // every action site to '<module-scope>' -- true but useless.
          siteFunction: namedOf(node) ?? enclosingFunctionName(node),
          deferral: kind,
          anchorText: anchorTextOf(node, kind, sf),
        })
      }
    }
    node.forEachChild(visit)
  })(sf)
  return sites
}

export function matchingDeferredEntries(site: DeferredWriteSite): DeferredSiteEntry[] {
  return DEFERRED_SKETCH_WRITE_SITES.filter(
    (e) => e.file === site.file && e.siteFunction === site.siteFunction &&
      e.deferral === site.deferral && e.anchorText === site.anchorText,
  )
}

// ---------------------------------------------------------------------------
// THE CENSUS (tier 1: channels).
// ---------------------------------------------------------------------------

export const ASYNC_WRITE_CHANNEL_CENSUS: readonly ChannelCensusEntry[] = [
  {
    id: 'latestSketchRequestId',
    file: 'src/store/index.ts',
    name: 'latestSketchRequestId',
    class: 'channel',
    note:
      'The solve REQUEST channel. Every sketchWorker.onmessage branch is gated on ' +
      '`msg.requestId === latestSketchRequestId`, so setting it to \'\' (never equal to a ' +
      'crypto.randomUUID()) makes every response minted before the restore a no-op. ' +
      'R1 major 3\'s original fix; kept.',
  },
  {
    id: 'pendingConstraintApply',
    file: 'src/store/index.ts',
    name: 'pendingConstraintApply',
    class: 'channel',
    note:
      'The constraint-apply VERDICT channel: a SKETCH_SOLVE_FAILED for an apply made against the ' +
      'PRE-restore sketch would otherwise strip `pending.constraintIds` out of the RESTORED ' +
      'sketch\'s constraints and re-solve. Dropped, so the handler\'s ' +
      '`pendingConstraintApply?.requestId === msg.requestId` branch cannot be entered.',
  },
  {
    id: 'pendingDimensionApply',
    file: 'src/store/index.ts',
    name: 'pendingDimensionApply',
    class: 'channel',
    note:
      'The dimension-apply VERDICT channel: same shape as pendingConstraintApply, but its revert ' +
      'is worse -- {kind:\'remove\'} would DELETE the restored sketch\'s dimension, and ' +
      '{kind:\'restore\', value} would write a PRE-restore value onto it. Dropped for the same ' +
      'reason.',
  },
  {
    id: 'pendingAppendApply',
    file: 'src/store/index.ts',
    name: 'pendingAppendApply',
    class: 'channel',
    note:
      'The append-commit VERDICT channel (WO-1461): same shape as pendingConstraintApply, but the ' +
      'reject also strips the entity/dimension ids this specific append() added (an inferred-snap ' +
      'commit can introduce a brand-new entity, not just constraints). A SKETCH_SOLVE_FAILED for an ' +
      'apply made against the PRE-restore sketch would otherwise strip the PRE-restore ids out of ' +
      'the RESTORED sketch. Dropped, so the handler\'s `pendingAppendApply?.requestId === ' +
      'msg.requestId` branch cannot be entered.',
  },
  {
    id: 'dragDebounceTimer',
    file: 'src/store/index.ts',
    name: 'dragDebounceTimer',
    class: 'channel-timer',
    note:
      'The R2 audit BLOCKER, queued-timer mode. dragSolveSketch arms a trailing 25ms debounce; ' +
      'if it is still armed at restore time it fires AFTERWARDS and mints a requestId NEWER than ' +
      'the seam\'s own re-solve, so the stale-response guard cannot help -- the pre-restore drag ' +
      'targets land on the restored geometry. clearTimeout + null (a channel-timer: dropping the ' +
      'handle alone would leave the callback armed).',
  },
  {
    id: 'pendingDrag',
    file: 'src/store/index.ts',
    name: 'pendingDrag',
    class: 'channel',
    note:
      'The payload half of the drag debounce: the armed timer reads pendingDrag when it fires, ' +
      'and the callback bails on `!pendingDrag`. Dropped alongside the timer -- belt and braces ' +
      'for the same blocker (the timer clear alone already prevents the fire; this makes the ' +
      'channel EMPTY rather than merely unscheduled, so a future re-arm cannot pick up ' +
      'pre-restore targets from it).',
  },
  {
    id: 'sketchDragPlan',
    file: 'src/store/index.ts',
    name: 'sketchDragPlan',
    class: 'channel',
    note:
      'The R2 audit BLOCKER, live-rearm mode -- and the site the ruling\'s named derivation trap ' +
      'protects: it is assigned OUTSIDE any deferred body (beginSketchDrag) and only READ inside ' +
      'one, so a "written in a timer/onmessage body" domain would miss it entirely. It holds each ' +
      'dragged point\'s `orig` position captured from PRE-restore geometry; with the pointer still ' +
      'down through a keyboard undo, the next moveSketchDrag re-arms a FRESH debounce against ' +
      'those stale origins. Dropped, which makes moveSketchDrag/endSketchDrag inert for the rest ' +
      'of the gesture (both open with `if (!sketchDragPlan) return`); endSketchDrag\'s own clear ' +
      'cannot cover this -- it is mouse-up-only and a keyboard undo never reaches it.',
  },
] as const

/**
 * THE EPOCH GATE'S OWN MODULE STATE -- the whole exclusion, in one place, landed
 * by ONE commit (WO SKC-56-R5 MAJOR 3; spliced into CHANNEL_NAMED_EXCLUSIONS
 * below).
 *
 * WHY THIS BLOCK IS SEPARATE AND WHY IT SAYS SO. WO SKC-56-R4 item 4a required
 * these exclusions to land "in the same commit that introduces" the counters,
 * so the fail-closed census would not go RED on an unrelated reason. That is NOT
 * what happened, and the R4 audit caught it:
 *
 *   - 9fefa262 (feat: epoch-gated sketch writes) introduced sketchGeometryEpoch,
 *     latestSketchRequestEpoch and sketchEpochRefusals in src/store/index.ts.
 *   - f0b93570 (test: census widening) added their exclusions, one commit LATER.
 *
 * So 9fefa262's tree is census-RED: two new module-scope `let`s in the census's
 * derived domain with no disposition. The intermediate implementation commit is
 * non-atomic and a bisect through it fails the census for a reason that has
 * nothing to do with the commit under test. The comment that stood here claimed
 * the opposite ("Ruled on here in the same commit that introduces it") -- it was
 * false when it was written, and correcting it is half of MAJOR 3.
 *
 * History is not rewritten to fix this (never rebase a shared branch): the R5
 * work order names the compliant alternative, and this block IS it -- the
 * exclusion re-landed self-contained, entries and reasons and this comment
 * together, by the single R5 commit whose message carries the same account. Read
 * that commit (`git log -S EPOCH_GATE_NAMED_EXCLUSIONS`) for the record; the
 * hash is in the r5 section of coordination/reports/SKC-56.report.json.
 *
 * The RULE this leaves behind, for whoever adds the next module-scope mutable to
 * src/store/index.ts: its census entry or exclusion belongs in YOUR commit, not
 * the next one. The census is fail-closed, so a split lands a RED tree.
 */
export const EPOCH_GATE_NAMED_EXCLUSIONS: readonly ChannelNamedExclusion[] = [
  {
    id: 'sketchGeometryEpoch',
    file: 'src/store/index.ts',
    name: 'sketchGeometryEpoch',
    reason:
      'The monotonic sketch-geometry epoch counter (a module-scope `let`, introduced in ' +
      '9fefa262) -- the gate itself, not a pending-write channel. It holds an integer, never a ' +
      'captured sketch, a payload or a callback, so there is nothing in it for a restore to ' +
      'invalidate. Neutralizing it at the seam would INVERT its meaning: the seam BUMPS it (that ' +
      'bump is what makes every write minted against the pre-restore geometry stale), and ' +
      'resetting it there would instead re-validate exactly the writes it exists to refuse.',
  },
  {
    id: 'latestSketchRequestEpoch',
    file: 'src/store/index.ts',
    name: 'latestSketchRequestEpoch',
    reason:
      'The epoch TAG of the in-flight solve request (a module-scope `let`, introduced in ' +
      '9fefa262) -- the companion of latestSketchRequestId, holding an integer rather than a ' +
      'pending write. It needs no seam neutralization for the same reason it needs no clearing: ' +
      'the REQUEST it tags is already neutralized through latestSketchRequestId (blanked at the ' +
      'seam), and its value is the gate\'s minted-epoch input -- a response tagged with a ' +
      'pre-restore epoch is refused by construction, which is the point of storing it rather ' +
      'than re-reading the counter when the response lands.',
  },
  {
    id: 'sketchEpochRefusals',
    file: 'src/store/index.ts',
    name: 'sketchEpochRefusals',
    reason:
      'The gate\'s bounded refusal log (a const-held array, introduced in 9fefa262 -- in-domain ' +
      'only because of the R4 tier-1 widening, which is a fair demonstration that the widening ' +
      'bites). It is an OUTPUT of the gate, never an input to a write: it holds {channel, ' +
      'mintedEpoch, currentEpoch} records for the tests and the console, and nothing reads it ' +
      'back into the document. Clearing it at the seam would destroy the evidence that a restore ' +
      'refused something -- the opposite of the observability the ruling requires (3c).',
  },
]

export const CHANNEL_NAMED_EXCLUSIONS: readonly ChannelNamedExclusion[] = [
  {
    id: 'OUTDATED_REASON_GEOMETRY_PARAMS',
    file: 'src/store/index.ts',
    name: 'OUTDATED_REASON_GEOMETRY_PARAMS',
    reason:
      'WO-2663: readonly as-const tuple of geometry parameter key names, used only by ' +
      'outdatedReasonForOperationUpdate to compare synchronous operation edits. Never assigned, ' +
      'never carries a deferred sketch write, payload or callback, and needs no restore clearing.',
  },
  {
    id: 'modelBodyRowTombstones',
    file: 'src/store/index.ts',
    name: 'modelBodyRowTombstones',
    reason:
      'WO-1413: dropped model-body CAM rows retained so undoing the delete that dropped one can ' +
      'give it back its saved Section. Written ONLY from inside the synchronous body of ' +
      'syncModelBodies ' +
      '(retainModelBodyRowTombstone on the sync that drops a row, and a filter on the sync that ' +
      'consumes one) - no timer, promise, worker message or awaited continuation reaches it, so ' +
      'nothing minted before a restore can land through it afterwards. It carries rows and Model ' +
      'document history positions, never a pending sketch write, payload or callback, and it is ' +
      'read only when the live Model history sits exactly where that delete was undone. A new or ' +
      'opened project calls clearModelBodyRowTombstones(), so a retained row never outlives the ' +
      'history that could bring it back.',
  },
  {
    id: 'historySnapshotPushedThisTurn',
    file: 'src/store/index.ts',
    name: 'historySnapshotPushedThisTurn',
    reason:
      'WO-1434: the undo-grouping marker for ONE synchronous user action - a reference to the ' +
      'project snapshot pushHistory() pushed during the current turn, cleared by a queued ' +
      'microtask. It never holds a pending sketch write, payload or callback. updateOperation ' +
      'only compares it BY REFERENCE against the top of projectHistory, so a restore that swaps ' +
      'the stacks makes the comparison fail and the next authored edit simply pushes its own ' +
      'undo step - nothing minted before the restore can be written through it.',
  },
  {
    id: 'sketchWorker',
    file: 'src/store/index.ts',
    name: 'sketchWorker',
    reason:
      'The persistent solver worker HANDLE -- transport, not a pending write. It holds no ' +
      'restore-crossing state of its own: every write a response of its can perform is gated on ' +
      'the latestSketchRequestId channel, which the seam invalidates. Terminating it on undo ' +
      'would also defeat the reason it is persistent (a drag emits a request stream, so the WASM ' +
      'module stays warm) and would not add safety the request gate does not already give.',
  },
  {
    id: 'sketchTextPathDrag',
    file: 'src/store/index.ts',
    name: 'sketchTextPathDrag',
    reason:
      'EPOCH-GATED, deliberately NOT seam-neutralized (WO SKC-56-R4 item 2). This entry\'s R3 ' +
      'reason -- "not an asynchronous channel ... nothing of it survives a restore to land later" ' +
      '-- was FALSE, and the R3 audit disproved it: the plan caches the bound path entity and its ' +
      'arc-length LUT at grab, that cache survives a restore as data, and the next pointer move ' +
      'projected against the PRE-restore path and wrote pathOffsetMm=70 onto a restored 40mm path. ' +
      'Being synchronous on the pointer event never made it safe; its GEOMETRY was captured ' +
      'earlier, which is the only thing staleness needs. The fourth-strike ruling fixes it at the ' +
      'WRITE, not at the holder: the plan carries the epoch it was minted under (SketchTextPathDrag.' +
      'epoch, stamped in beginSketchDrag) and moveSketchDrag\'s on-path branch commits through ' +
      'commitSketchGeometry, which refuses the stale write by name and drops the plan. It is ' +
      'excluded from the seam-neutralization duty because the seam clearing it would be the FIFTH ' +
      'round of the enumerate-and-neutralize pattern this program abandoned -- the gate covers it, ' +
      'and covers the next one nobody named. Proven by the sketchTextPathDrag refusal cell in ' +
      'undoInFlightSolve.skc56r1.test.ts.',
  },
  {
    id: 'sketchTextEditOriginal',
    file: 'src/store/index.ts',
    name: 'sketchTextEditOriginal',
    reason:
      'The pre-edit text entity kept so Esc can revert a live in-place edit. Written and read ' +
      'synchronously by the modal text-edit actions (begin/commit/cancel); no deferred write is ' +
      'ever outstanding through it, so a restore cannot be overtaken by one.',
  },
  {
    id: 'sketchTextEditDirty',
    file: 'src/store/index.ts',
    name: 'sketchTextEditDirty',
    reason:
      'A synchronous once-only flag for the text edit\'s lazy pushHistory. Same modal, ' +
      'synchronous lifecycle as sketchTextEditOriginal: it schedules nothing.',
  },
  {
    id: 'sketchBlockEditMeta',
    file: 'src/store/index.ts',
    name: 'sketchBlockEditMeta',
    reason:
      'SKC-BLOCKS Stage 4: the pre-edit block\'s frame/outerIds (BlockEditSessionMeta) captured ' +
      'by beginSketchBlockEdit so finishSketchBlockEdit can re-group the current members back ' +
      'into the SAME block id/frame, and cancelSketchBlockEdit can restore it verbatim. Written ' +
      'and read synchronously by the modal block-edit actions (begin/finish/cancel) only -- no ' +
      'deferred write is ever outstanding through it, so a restore cannot be overtaken by one. ' +
      'Same modal, synchronous lifecycle as sketchTextEditOriginal below.',
  },
  {
    id: 'sketchBlockEditReturnSketch',
    file: 'src/store/index.ts',
    name: 'sketchBlockEditReturnSketch',
    reason:
      'SKC-BLOCKS Stage 4: the pre-edit document snapshot kept so cancelSketchBlockEdit can ' +
      'revert the whole sketch verbatim on Esc. Same modal, synchronous lifecycle as ' +
      'sketchTextEditOriginal: written at begin, read and cleared at finish/cancel, and it ' +
      'schedules nothing that could fire after a restore.',
  },
  {
    id: 'sketchNoticeTimer',
    file: 'src/store/index.ts',
    name: 'sketchNoticeTimer',
    reason:
      'A real timer, but NOT a channel into the sketch: its callback\'s only write is ' +
      '`set({ sketchNotice: null })` -- the status-bar string, never activeSketch and never a ' +
      'solve request. Cancelling it on undo would blank an unrelated notice early, a regression ' +
      'for no invariant. (Mechanically corroborated by tier 2: it is a timer-callback whose body ' +
      'the writer fixed point does NOT reach, which is why no deferred-site entry exists for it.)',
  },
  {
    id: 'confirmResolver',
    file: 'src/store/index.ts',
    name: 'confirmResolver',
    reason:
      'PROMOTE-SKETCH-FAIL round 2\'s themed-confirm resolve HANDLE -- transport for the ' +
      'requestConfirm/resolveConfirm dialog promise, same shape as the sketchWorker exclusion ' +
      'above: it holds a callback reference, never a captured sketch or a pending payload. Its ' +
      'only two call sites today (DesignTree.tsx handleConvertLayerToModel, PropertiesPanel.tsx ' +
      'handleConvert) both await it and then call promoteSketchLayerToModel, which re-reads the ' +
      'CURRENT project via get() at resolve time -- never a value captured before the dialog ' +
      'opened -- and neither site writes activeSketch or latestSketchRequestId at all (the promote ' +
      'flow moves a CAM layer into project.modelItems, a different document than the live sketch ' +
      'editor). A restore that lands while the dialog is open cannot make the eventual resolve() ' +
      'write anything stale: if the promoted layer/geo id no longer exists post-restore, ' +
      'promoteSketchLayerToModel\'s own not-found guard refuses it by name; if it still exists, the ' +
      'promote reads the RESTORED state, which is correct, not stale. Superseding a still-pending ' +
      'request already resolves it `false` (requestConfirm\'s own supersede branch), so nothing is ' +
      'ever left armed across a restore either. Neutralizing it at the seam would have nothing to ' +
      'neutralize (there is no sketch payload in it to drop) -- the two call sites already own ' +
      'their own correctness by re-reading get() fresh rather than relying on the seam.',
  },

  // ---- The epoch gate's own module state (WO SKC-56-R4 item 4a) -----------
  // The gate is implemented with module-scope mutables in the very file this
  // census derives, so it joins tier 1's domain the moment it lands. The whole
  // exclusion -- entries, reasons, and the account of the split commit that
  // made 4a's "same commit" claim false -- is EPOCH_GATE_NAMED_EXCLUSIONS,
  // above, landed self-contained by the single R5 commit that also deleted the
  // comment which used to claim otherwise here.
  ...EPOCH_GATE_NAMED_EXCLUSIONS,

  // ---- Pre-existing const containers, in-domain since the R4 widening -----
  // Each holds mutable storage by the new criterion, so each needs a ruling.
  // None is a write channel: they are frozen-by-convention defaults and a
  // method table, none of which any deferred path assigns into.
  {
    id: 'CAM_SKETCH_ORIGIN_LOCAL',
    file: 'src/store/index.ts',
    name: 'CAM_SKETCH_ORIGIN_LOCAL',
    reason:
      'The fixed local-origin point injected into every sketch. A constant coordinate literal ' +
      'read at anchor injection; no code path assigns its fields, and it carries no pending write.',
  },
  {
    id: 'DERIVED_LAYER_COLORS',
    file: 'src/store/index.ts',
    name: 'DERIVED_LAYER_COLORS',
    reason:
      'The derived-layer colour palette: a read-only lookup array. Indexed when a layer is ' +
      'created; never assigned into, and holds no sketch state.',
  },
  {
    id: 'defaultSceneStock',
    file: 'src/store/index.ts',
    name: 'defaultSceneStock',
    reason:
      'A default-value template spread into new projects. Read at construction only; nothing ' +
      'assigns its fields, and it holds no sketch state (scene stock is not sketch geometry).',
  },
  {
    id: 'defaultMachine',
    file: 'src/store/index.ts',
    name: 'defaultMachine',
    reason: 'A default-value template spread into new projects. Same disposition as ' +
      'defaultSceneStock: read-only at construction, no sketch state, no deferred writer.',
  },
  {
    id: 'defaultAppSettings',
    file: 'src/store/index.ts',
    name: 'defaultAppSettings',
    reason: 'A default-value template for app settings. Same disposition as defaultSceneStock.',
  },
  {
    id: 'defaultViewerState',
    file: 'src/store/index.ts',
    name: 'defaultViewerState',
    reason: 'A default-value template for viewer state. Same disposition as defaultSceneStock.',
  },
  {
    id: 'DEFAULT_TOOL_FEEDS',
    file: 'src/store/index.ts',
    name: 'DEFAULT_TOOL_FEEDS',
    reason:
      'A read-only feeds/speeds lookup table keyed by tool type. Read when a tool is created; ' +
      'never assigned into, and unrelated to sketch geometry.',
  },
  {
    id: 'camSketchDocumentPort',
    file: 'src/store/index.ts',
    name: 'camSketchDocumentPort',
    reason:
      'The sketcher package\'s mount-contract METHOD TABLE (WO SKC-14B) -- an object literal of ' +
      'functions, so the widening pulls it in, but its fields are never reassigned and it stores ' +
      'no state. Its methods DELEGATE into the store actions (beginSketchDrag / moveSketchDrag / ' +
      'endSketchDrag), which is where the drag channels are censused and where the epoch is ' +
      'minted; the port itself holds nothing across a restore.',
  },
  // NOTE (2026-07-26, MSH-4-OPERAND-CACHE landing): `booleanOperandCache`
  // (const ... = new Map(...), store/index.ts) is NOT in this census's domain
  // because the R4 widening admits only object/array LITERAL initializers, not
  // constructor expressions -- a known gap of the widening, recorded here at
  // the nearest ruling site so the next widening round picks it up. Its safety
  // argument (derived memo, reference-equality invalidation, never a write
  // conduit) lives in the code comment at its declaration and in
  // booleanOperandCache.test.ts.
  {
    id: 'multiBodyImportResolver',
    file: 'src/store/index.ts',
    name: 'multiBodyImportResolver',
    reason:
      'IMPORT-MULTIBODY-CHOICE (c65b039a5): the modal-choice resolve HANDLE, same shape as the ' +
      'confirmResolver exclusion above -- transport for one promise, holding a callback ' +
      'reference, never a captured payload. requestMultiBodyImportChoice supersedes any prior ' +
      'resolver by resolving it with the CURRENT mode read via get() at supersede time; ' +
      'resolveMultiBodyImportChoice nulls the handle before resolving. The importer that awaits ' +
      'it continues against state it re-reads after the await, not values captured before the ' +
      'dialog opened, so a restore landing while the dialog is open cannot make the eventual ' +
      'resolve() replay stale geometry through this binding.',
  },
  {
    id: 'importStockChoiceResolver',
    file: 'src/store/index.ts',
    name: 'importStockChoiceResolver',
    reason:
      'IMPORT-STOCK-PROMPT: the import-time stock-choice resolve HANDLE, same shape as ' +
      'multiBodyImportResolver above (and confirmResolver before it) -- transport for one ' +
      'promise, holding a callback reference, never a captured payload. ' +
      'requestImportStockChoice supersedes any prior resolver by resolving it with { kind: ' +
      '\'auto\' } (the pre-selected default); resolveImportStockChoice nulls the handle before ' +
      'resolving. Every project replacement/new/open boundary settles the resolver at auto and ' +
      'clears the transient modal state before installing the next project, so an old importer ' +
      'cannot write into a new document. The importer persists a live pick through the existing ' +
      'stock-binding seam (setStockMembership / setGeometryNoStock), and a stale stock id is ' +
      'refused BY NAME ' +
      '(setStockMembership throws ADR-0003), never a silent fallback.',
  },
  {
    id: 'modelNavigationEpoch',
    file: 'src/store/index.ts',
    name: 'modelNavigationEpoch',
    reason:
      'MODEL-TRANSITION-RELIABILITY generation counter for asynchronous Model Item navigation. ' +
      'It gates add/open/finish continuations against newer navigation or project replacement and ' +
      'never carries a sketch payload or writes activeSketch. A sketch-history restore must not ' +
      'neutralize unrelated model-workspace intent; each model continuation applies only after its ' +
      'own epoch and project-id checks.',
  },
  {
    id: 'stlVisitClaimedModelItem',
    file: 'src/store/index.ts',
    name: 'stlVisitClaimedModelItem',
    reason:
      'WO-2094: a {projectId, itemId} marker naming the plain "Project Model" record an STL visit ' +
      'to the Model screen claimed (set by openStlInModelScreen after its awaited ' +
      'enterModelWorkspace, only when that record did not exist before the visit). Two plain ids, ' +
      'never a sketch, payload or callback. Its one reader, finishModelItem\'s releaseStlVisitItem, ' +
      'runs only after that finish\'s own modelNavigationEpoch and project-id checks, clears the ' +
      'marker first, re-reads the CURRENT project via get(), and removes only a modelItems record ' +
      'that is still empty, owns no row, has no authored evidence and holds no document - it ' +
      'writes project.modelItems and activeModelItemId, never activeSketch or ' +
      'latestSketchRequestId. A sketch-history restore therefore has nothing in it to neutralize.',
  },
  {
    id: 'projectOpenEpoch',
    file: 'src/store/index.ts',
    name: 'projectOpenEpoch',
    reason:
      'MODEL-TRANSITION-RELIABILITY generation counter for transactional project-file opens. ' +
      'It prevents an older open/checkpoint continuation from replacing a newer project. It holds ' +
      'only a number, no sketch data; the winning load closes the live sketch through ' +
      'setActiveSketch(null), whose own sketch-geometry epoch bump invalidates prior sketch writes.',
  },
  {
    id: 'EMPTY_MODEL_ITEM_PLACEMENTS',
    file: 'src/store/index.ts',
    name: 'EMPTY_MODEL_ITEM_PLACEMENTS',
    reason:
      'A single shared empty-array sentinel minted once so "no placements yet" compares ' +
      'reference-equal to itself across booleanOperandCache checks (an inline fallback would ' +
      'mint a fresh array per call and defeat the check). Never assigned into, never carries ' +
      'any write.',
  },
  {
    id: 'PROJECT_OPEN_MESSAGES',
    file: 'src/store/index.ts',
    name: 'PROJECT_OPEN_MESSAGES',
    reason:
      'The UI-85 project-open phase -> display-string lookup table (introduced in 8202146b0, ' +
      '"feat(ui): show honest project-open progress"). In-domain only because of the R4 tier-1 ' +
      'const-container widening -- another fair demonstration that the widening bites, since the ' +
      'binding is a const Record. It is a frozen READ-ONLY table of six literal strings keyed by ' +
      'ProjectOpenPhase: nothing ever assigns into it, so it cannot hold a captured sketch, a ' +
      'payload or a callback for a restore to invalidate. Its only consumer reads a message out ' +
      'to render progress text. Neutralizing it at the seam would blank the phase labels for ' +
      'every subsequent open while adding no stale-sketch protection whatsoever.',
  },
  {
    id: 'adaptive3dRetainedField',
    file: 'src/store/index.ts',
    name: 'adaptive3dRetainedField',
    reason:
      'WO-279 rest-machining record of the CAM-3D adaptive-rough worker\'s carved field (setup/op/' +
      'geometry ids, stock bounds, cell size, and the client that owns it). Entirely orthogonal to ' +
      'the sketch document this seam guards: it is read only inside adaptive-3D-rough evidence ' +
      'building (buildAdaptive3dSmartHeightEvidence-style code around line 2565) and written only ' +
      'around the adaptive-3D-rough compute call and invalidateProjectComputeWork -- never ' +
      'activeSketch, never a sketch action. It is dropped (`= undefined`) at the START of every ' +
      'rough and on project invalidation, so it is never stale for the CAM domain it belongs to ' +
      'either. A sketch history restore neither reads nor writes it; nothing about it could land a ' +
      'stale write on a restored sketch because it never carries sketch payload in the first place.',
  },
  {
    id: 'lastSolvedFullyDefinedEntities',
    file: 'src/store/index.ts',
    name: 'lastSolvedFullyDefinedEntities',
    reason:
      'The last completed solve\'s per-entity definition states, kept aside in solveSketch so a ' +
      'worker CRASH (SKETCH_SOLVE_ERROR, no status in the message at all) can still colour the ' +
      'viewport (ADR 0003) while the verdict stays revoked (WO-210) -- never a captured document, ' +
      'only a plain id->boolean map. Its ONE read site is the crash branch of sketchWorker.' +
      'onmessage, which is reachable only when `msg.requestId === latestSketchRequestId` (the ' +
      'already-neutralized request-id channel the seam blanks on restore) -- a crash tied to a ' +
      'pre-restore request is dropped by that guard before this variable is ever consulted. Even ' +
      'when reached, the value only feeds a `crashedStatus` written through commitSketchGeometry\'s ' +
      'own epoch gate (latestSketchRequestEpoch), the same defense-in-depth path solveFailed above ' +
      'uses -- so a restore that lands mid-flight refuses the write outright, regardless of what ' +
      'stale per-entity ids this variable happens to hold. It is presentational fallback data ' +
      'behind two independent gates this census already treats as authoritative, not a channel of ' +
      'its own.',
  },
] as const

// ---------------------------------------------------------------------------
// THE CENSUS (tier 2: deferred write sites).
// ---------------------------------------------------------------------------

export const DEFERRED_SKETCH_WRITE_SITES: readonly DeferredSiteEntry[] = [
  {
    id: 'dragSolveSketch-debounce',
    file: 'src/store/index.ts',
    siteFunction: 'dragSolveSketch',
    deferral: 'timer-callback',
    anchorText: 'setTimeout(<fn>, 25)',
    siteCount: 1,
    disposition: 'neutralized',
    note:
      'The R2 blocker\'s own site: the trailing 25ms drag debounce, which mints a DRAG_SOLVE ' +
      'requestId when it fires. Neutralized through the dragDebounceTimer (cleared) and ' +
      'pendingDrag (dropped) channels, and its re-arm source sketchDragPlan is dropped too.',
  },
  {
    id: 'ensureSketchWorker-onmessage',
    file: 'src/store/index.ts',
    siteFunction: 'onmessage',
    deferral: 'event-handler',
    anchorText: 'sketchWorker.onmessage = <fn>',
    siteCount: 1,
    disposition: 'neutralized',
    note:
      'The solver response handler -- the deferred site that actually performs every ' +
      'solve/verdict write. Neutralized at its three gates, all of which the seam empties: the ' +
      'top-of-handler `msg.requestId !== latestSketchRequestId` early return, and the ' +
      'pendingConstraintApply / pendingDimensionApply requestId branches.',
  },
  {
    id: 'ensureSketchWorker-onerror',
    file: 'src/store/index.ts',
    siteFunction: 'onerror',
    deferral: 'event-handler',
    anchorText: 'sketchWorker.onerror = <fn>',
    siteCount: 1,
    disposition: 'no-seam-action',
    note:
      'Worker SCRIPT load/parse failure. Its only write is `solveStatus: crashedStatus` on ' +
      'whatever sketch is live -- it carries no pre-restore geometry, value or anchor, and the ' +
      'fact it reports (solving is dead for the session) is equally true of the restored sketch. ' +
      'Suppressing it on restore would SILENCE a fail-loud path (ADR 0003), which is why the ' +
      'disposition is no-seam-action rather than neutralization.',
  },
  {
    id: 'importSketchFont-await-continuation',
    file: 'src/store/index.ts',
    siteFunction: 'importSketchFont',
    deferral: 'async-body',
    anchorText: 'async importSketchFont(file)',
    siteCount: 1,
    disposition: 'no-seam-action',
    note:
      'Named by the ruling\'s preflight and dispositioned here rather than silently omitted. Its ' +
      'post-await continuation writes activeSketch.entities one call away, through ' +
      'applyTextEditPatch (which is why the body-local sweep the naive design would have used ' +
      'misses it, and the call-graph fixed point catches it). Self-correcting, so no seam action: ' +
      'the continuation reads state FRESH via get() at apply time and patches by entity id, ' +
      'carrying only the imported font family/style -- data from the FILE the user picked, not a ' +
      'snapshot of the pre-restore sketch. It is also gated on sketchTextEditId still naming an ' +
      'open edit, and text is solver-inert. Nothing stale can cross the restore through it.',
  },
  {
    id: 'loadProjectFromFile-await-continuation',
    file: 'src/store/index.ts',
    siteFunction: 'loadProjectFromFile',
    deferral: 'async-body',
    anchorText: 'async loadProjectFromFile(json, requestId)',
    siteCount: 1,
    disposition: 'no-seam-action',
    note:
      'The transactional file-open body awaits recovery/checkpoint storage before replacing the ' +
      'project. It carries no pre-restore sketch payload: after every await, projectOpenEpoch owns ' +
      'the continuation, and the winning open deliberately calls setActiveSketch(null) before the ' +
      'project swap. That document-switch choke point bumps the sketch geometry epoch and closes ' +
      'the outgoing session. Neutralizing file open at sketch undo/redo would cancel explicit user ' +
      'intent while adding no stale-sketch protection. ' +
      'RE-RULED 2026-08-04: UI-85 (8202146b0) added the `requestId` parameter, which changed the ' +
      'anchorText and correctly cost this site its classification -- the census is built so a ' +
      'signature change forces a fresh reading rather than silently inheriting the old one. The ' +
      'disposition is UNCHANGED, and the new parameter strengthens rather than weakens it: ' +
      'requestId carries the caller-owned projectOpenEpoch, and the body now refuses outright ' +
      '(`if (requestId !== undefined && projectOpenEpoch !== requestId) return`) when a newer open ' +
      'has taken ownership. That is a stricter ownership check than the ++projectOpenEpoch path it ' +
      'replaced for progress-reporting callers, so there is still no pending sketch write for the ' +
      'seam to neutralize.',
  },
  {
    id: 'askBeforeReplacingProject-await-continuation',
    file: 'src/store/index.ts',
    siteFunction: 'askBeforeReplacingProject',
    deferral: 'async-body',
    anchorText: "async askBeforeReplacingProject(action: 'new' | 'open')",
    siteCount: 1,
    disposition: 'no-seam-action',
    note:
      'WO-2704 (901114eba): the Save / Discard / Cancel question asked before New, Open or an ' +
      'example replaces an unsaved project. It awaits the operator\'s answer, and only on Save ' +
      'does its continuation reach a sketch write: saveProjectToFile -> prepareProjectToFile, ' +
      'which commits the live sketch draft through Finish\'s own bakeActiveSketch path. No seam ' +
      'action, because it carries no captured sketch across the await: prepareProjectToFile reads ' +
      'activeSketch FRESH via get() at the moment Save is answered, exactly as the toolbar Save ' +
      'click does, so whatever sketch is live then (restored or not) is what is committed. The ' +
      'write is the operator\'s explicit Save, not a pending solve; neutralizing it on restore ' +
      'would drop the save he asked for while adding no stale-sketch protection.',
  },
] as const
