// WO UI-57-R2 (DECISIONS 2026-07-17 "UI-57 second strike on alias-lineage",
// ruling 1): the alias invariant quantifies over a DERIVED census of alias
// lifecycle paths -- never a hand list of the paths the last fix happened to
// know about.
//
// WHY THIS FILE EXISTS. Two rounds failed the same seam the same way. R0 left
// aliases un-shared and the delta direction backwards. R1 fixed every NAMED
// finding -- and the R1 auditor then CONSTRUCTED a fresh hole in the same seam:
// heal -> later feature -> serialize/restore lost the merged-away face, because
// restoreBody rebuilds aliases from the delta it is handed and most PRODUCERS
// never wrote the historical lineage into theirs. Each round neutralized the
// paths it knew about. So the scope is now mechanical: this census derives the
// domain from the code, and it FAILS when a new member appears without a
// disposition.
//
// THE DERIVATION TRAP THIS ROUND'S PREFLIGHT NAMES. The obvious domain -- "every
// importer of aliasLineage.ts" -- structurally MISSES the defect's own site:
// not one of the delta producers below imported aliasLineage.ts before this WO,
// so an import-graph census would have been GREEN across the exact blocker it
// exists to catch. Producers are therefore derived by the SHAPE of the delta
// they construct (a syntactic property of the two engine files), which cannot
// depend on anyone remembering to import the right module. The import graph is
// still derived -- as TIER 2, where it is the right tool, because a resolver's
// domain genuinely IS its importers.
//
// TWO TIERS, both fail CLOSED (an unclassified member is RED, never assumed
// safe -- the standing fail-closed-extraction ruling, DECISIONS 2026-07-16):
//
//   TIER 1 -- DELTA PRODUCERS. Every function in src/geom/worker/geom-engine.ts
//   or src/geom/worker/stable-id.ts that constructs or returns an
//   ElementMapDelta-shaped object ({ modified, generated, deleted }). Each is
//   either:
//     (a) CARRIES-FORWARD -- it folds its target body's inherited alias lineage
//         into its own `modified`, asserted MECHANICALLY: its body must contain
//         a call to foldAliasLineageIntoDelta (aliasLineage.ts), the one shared
//         owner of that carry-forward; or
//     (b) a NAMED EXCEPTION in PRODUCER_NAMED_EXCEPTIONS, with a stated reason.
//   Nothing else is permitted.
//
//   TIER 2 -- RESOLVERS/CONSUMERS. Every importer of aliasLineage.ts's exports,
//   derived by import graph exactly as the ruling specifies. Each importer needs
//   a matrix disposition; a new one with none is RED.
//
// Real (`typescript` compiler API) AST parse throughout, never a text/regex scan
// -- so a comment or a string literal can neither forge nor hide a member. Same
// technique as the committed precedent this file is modelled on
// (src/tests/sketch/asyncWriteChannelCensus.ts, SKC-56-R3, commit f6378754);
// the extraction functions are exported so the companion test drives the SAME
// code against both the real files and adversarial fixture sources.

import ts from 'typescript'

export const PRODUCER_FILES = ['src/geom/worker/geom-engine.ts', 'src/geom/worker/stable-id.ts'] as const
export type ProducerFile = (typeof PRODUCER_FILES)[number]

/** The alias-lineage module every tier-2 consumer imports, and whose exports
 *  tier 2's import graph is keyed on. */
export const ALIAS_MODULE = 'src/geom/aliasLineage.ts'

/** THE shared carry-forward. Tier 1's CARRIES-FORWARD check is scoped to this
 *  call BY NAME: folding lineage by hand inside a producer is not routing
 *  through the one owner, and is exactly how #pairHealedFaces came to emit
 *  modified[loser] without the root's own survivor marker for two rounds. */
export const FOLD_FUNCTION = 'foldAliasLineageIntoDelta'

/** The three fields that make an object an ElementMapDelta-shaped lineage
 *  statement. `featureId`/`geometry`/`faceMap`/`snapshots`/`ok` deliberately do
 *  NOT participate: the domain is "states id lineage", and both the engine's
 *  internal assignment objects and its contract-facing `elementMap` literals do
 *  that with exactly these three. Requiring all three (not any) is what keeps a
 *  `{ modified }`-only options bag out of the domain. */
const DELTA_SHAPE_FIELDS = ['modified', 'generated', 'deleted'] as const

// ---------------------------------------------------------------------------
// Shared AST helpers (same shapes as the precedent census module).
// ---------------------------------------------------------------------------

function stripCommentsAndNormalize(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
}

/** A function-like's own name. Handles the three forms these two files use:
 *  `function f()`, a class method (INCLUDING a #private one, whose name is a
 *  PrivateIdentifier -- miss that and #pairHealedFaces/#assignEditedIds, i.e.
 *  most of this domain, silently key to '<module-scope>'), and a function
 *  assigned to a const. */
function namedOf(fn: ts.Node): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text
  if (ts.isMethodDeclaration(fn)) {
    if (ts.isIdentifier(fn.name)) return fn.name.text
    if (ts.isPrivateIdentifier(fn.name)) return fn.name.text
    if (ts.isStringLiteral(fn.name)) return fn.name.text
  }
  const p = fn.parent
  if (p === undefined) return null
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text
  return null
}

/** Nearest NAMED function-like ancestor, skipping anonymous callbacks -- so a
 *  match keys to the named producer it is lexically defined inside, never an
 *  anonymous wrapper. */
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
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS)
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

// ---------------------------------------------------------------------------
// TIER 1: delta producers, derived by the SHAPE of the object they construct.
// ---------------------------------------------------------------------------

export type ProducerDisposition =
  /** Folds the target body's inherited alias lineage into its own `modified`
   *  via FOLD_FUNCTION. Asserted mechanically -- see auditProducerFold. */
  | 'carries-forward'
  /** Does not fold: it COMPOSES its delta out of an assignment object a
   *  censused CARRIES-FORWARD producer already built (`modified:
   *  assign.modified`), so the lineage is already in the record it passes
   *  through. Asserted mechanically on BOTH halves -- see auditProducerDelegation
   *  -- because "calls a folding producer" alone is not enough: applyDraft
   *  called none and shipped `modified: {}`, and a composer that calls a folding
   *  producer and THEN writes `modified: {}` throws away the very lineage the
   *  producer just computed. That is the failure this disposition exists to
   *  make impossible to write. */
  | 'delegates'

export interface ProducerCensusEntry {
  id: string
  file: ProducerFile
  /** The enclosing function's own name (`assignCutFaceIds`, `#pairHealedFaces`). */
  name: string
  disposition: ProducerDisposition
  /** For 'delegates' only: the censused CARRIES-FORWARD producer whose
   *  assignment object this one composes its delta from. Asserted to be called
   *  from this function's body, and asserted to itself be censused
   *  carries-forward (a delegation chain that bottoms out in nothing is RED). */
  delegatesTo?: string
  /** What body's aliases it inherits, and through which field. Never empty. */
  note: string
}

export interface ProducerNamedException {
  id: string
  file: ProducerFile
  name: string
  /** Why this producer cannot drop alias lineage -- i.e. the PROOF that no
   *  inherited alias can reach it. Never empty (asserted). A reason of the form
   *  "it does not merge faces" is NOT a proof: healing is not the only way a
   *  body acquires aliases -- inheriting them from a target is. The only honest
   *  proof in this domain is "there is no target body". */
  reason: string
}

/** One derived delta-shaped construction site. */
export interface DeltaProducerSite {
  file: string
  line: number
  /** The named function the site is lexically inside. */
  name: string
  /** How the site was derived -- both derivations are unioned into the domain,
   *  so a producer that stops using a literal but keeps its declared return
   *  type (or vice versa) does not fall out of the census. */
  via: 'object-literal' | 'return-type'
  /** The construction's own head text, for the RED message's file+line+form. */
  text: string
}

function objectLiteralHasDeltaShape(node: ts.ObjectLiteralExpression): boolean {
  const names = new Set<string>()
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) names.add(prop.name.text)
    else if (ts.isShorthandPropertyAssignment(prop)) names.add(prop.name.text)
  }
  return DELTA_SHAPE_FIELDS.every((f) => names.has(f))
}

function typeLiteralHasDeltaShape(node: ts.TypeLiteralNode): boolean {
  const names = new Set<string>()
  for (const member of node.members) {
    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) names.add(member.name.text)
  }
  return DELTA_SHAPE_FIELDS.every((f) => names.has(f))
}

/** Same-file interface/type-alias declarations whose shape is a delta -- so a
 *  producer declaring `: CutAssignment` is derived even though its return type
 *  names no member directly. Follows `extends` heritage (ShellAssignment
 *  extends CutAssignment: without this the shell producer, a REAL member, falls
 *  out of the domain). */
function deltaShapedTypeNames(sf: ts.SourceFile): Set<string> {
  const members = new Map<string, Set<string>>()
  const heritage = new Map<string, string[]>()
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      const own = new Set<string>()
      for (const m of stmt.members) {
        if ((ts.isPropertySignature(m) || ts.isMethodSignature(m)) && ts.isIdentifier(m.name)) own.add(m.name.text)
      }
      members.set(stmt.name.text, own)
      const bases: string[] = []
      for (const clause of stmt.heritageClauses ?? []) {
        for (const t of clause.types) if (ts.isIdentifier(t.expression)) bases.push(t.expression.text)
      }
      heritage.set(stmt.name.text, bases)
    } else if (ts.isTypeAliasDeclaration(stmt) && ts.isTypeLiteralNode(stmt.type)) {
      const own = new Set<string>()
      for (const m of stmt.type.members) {
        if (ts.isPropertySignature(m) && ts.isIdentifier(m.name)) own.add(m.name.text)
      }
      members.set(stmt.name.text, own)
      heritage.set(stmt.name.text, [])
    }
  }
  const effective = (name: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(name)) return new Set()
    seen.add(name)
    const out = new Set(members.get(name) ?? [])
    for (const base of heritage.get(name) ?? []) for (const f of effective(base, seen)) out.add(f)
    return out
  }
  const out = new Set<string>()
  for (const name of members.keys()) {
    const fields = effective(name)
    if (DELTA_SHAPE_FIELDS.every((f) => fields.has(f))) out.add(name)
  }
  return out
}

/** Does this return-type annotation state a delta shape -- directly, through a
 *  same-file delta-shaped named type, or as ANY member of a union (every
 *  producer here returns `{...} | { ok: false; reason }`, so a union check that
 *  demanded EVERY member be delta-shaped would derive none of them)? */
function returnTypeHasDeltaShape(type: ts.TypeNode | undefined, namedDeltaTypes: ReadonlySet<string>): boolean {
  if (type === undefined) return false
  if (ts.isTypeLiteralNode(type)) return typeLiteralHasDeltaShape(type)
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) return namedDeltaTypes.has(type.typeName.text)
  if (ts.isUnionTypeNode(type)) return type.types.some((t) => returnTypeHasDeltaShape(t, namedDeltaTypes))
  if (ts.isParenthesizedTypeNode(type)) return returnTypeHasDeltaShape(type.type, namedDeltaTypes)
  return false
}

/**
 * Every site in `source` that constructs or returns an ElementMapDelta-shaped
 * object, keyed to the named function it lives in. THE DOMAIN.
 *
 * Two unioned derivations, because either alone has a blind spot: the literal
 * sweep misses a producer that builds its delta by spread/Object.assign, and
 * the return-type sweep misses the contract-facing `elementMap: {...}` literals
 * (applyDraft's is a NAMED member of this domain and its enclosing method's
 * return type is a bare OpResult).
 */
export function extractDeltaProducerSites(fileName: string, source: string): DeltaProducerSite[] {
  const sf = parse(fileName, source)
  const namedDeltaTypes = deltaShapedTypeNames(sf)
  const out: DeltaProducerSite[] = []
  ;(function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node) && objectLiteralHasDeltaShape(node)) {
      out.push({
        file: fileName,
        line: lineOf(sf, node),
        name: enclosingFunctionName(node),
        via: 'object-literal',
        text: stripCommentsAndNormalize(node.getText(sf)).slice(0, 160),
      })
    }
    if (isFunctionLike(node) && returnTypeHasDeltaShape(node.type, namedDeltaTypes)) {
      const name = namedOf(node)
      if (name !== null) {
        out.push({
          file: fileName,
          line: lineOf(sf, node),
          name,
          via: 'return-type',
          text: stripCommentsAndNormalize(node.type?.getText(sf) ?? '').slice(0, 160),
        })
      }
    }
    node.forEachChild(visit)
  })(sf)
  return out
}

/** The DOMAIN: one entry per distinct (file, enclosing function) that
 *  constructs a delta, with every site that keyed to it. */
export interface DeltaProducer {
  file: string
  name: string
  sites: DeltaProducerSite[]
}

export function deriveProducers(sites: readonly DeltaProducerSite[]): DeltaProducer[] {
  const byKey = new Map<string, DeltaProducer>()
  for (const s of sites) {
    const key = `${s.file}::${s.name}`
    const existing = byKey.get(key)
    if (existing) existing.sites.push(s)
    else byKey.set(key, { file: s.file, name: s.name, sites: [s] })
  }
  return [...byKey.values()].sort((a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file)))
}

/** Every function in `source` whose body calls FOLD_FUNCTION -- the mechanical
 *  CARRIES-FORWARD proof. Keyed to the nearest NAMED enclosing function, the
 *  same keying the domain uses, so the two sets are directly comparable. */
export function extractFoldCallSites(fileName: string, source: string): Array<{ file: string; line: number; name: string }> {
  const sf = parse(fileName, source)
  const out: Array<{ file: string; line: number; name: string }> = []
  ;(function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isFold =
        (ts.isIdentifier(callee) && callee.text === FOLD_FUNCTION) ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === FOLD_FUNCTION)
      if (isFold) out.push({ file: fileName, line: lineOf(sf, node), name: enclosingFunctionName(node) })
    }
    node.forEachChild(visit)
  })(sf)
  return out
}

export interface ProducerClassificationProblem {
  file: string
  name: string
  line: number
  form: string
  /** 'unclassified' -- matches NEITHER table, so nobody has ruled on whether it
   *  can drop inherited alias lineage. THE fail-closed case this round exists
   *  for: a new producer appearing without a disposition is RED, never silently
   *  safe. 'double-classified' -- matches BOTH, i.e. claimed to carry lineage
   *  forward AND excused from doing so. Ambiguous rulings are refused rather
   *  than resolved by table order. */
  kind: 'unclassified' | 'double-classified'
}

/** Every derived producer that is not classified exactly once. The table
 *  parameters default to the real census and exist so the adversarial fixtures
 *  can drive THIS function -- never a re-implemented copy. */
export function auditProducerClassification(
  producers: readonly DeltaProducer[],
  census: readonly ProducerCensusEntry[] = ALIAS_PRODUCER_CENSUS,
  exceptions: readonly ProducerNamedException[] = PRODUCER_NAMED_EXCEPTIONS,
): ProducerClassificationProblem[] {
  const problems: ProducerClassificationProblem[] = []
  for (const p of producers) {
    const c = census.filter((e) => e.file === p.file && e.name === p.name).length
    const x = exceptions.filter((e) => e.file === p.file && e.name === p.name).length
    if (c + x === 1) continue
    problems.push({
      file: p.file,
      name: p.name,
      line: p.sites[0].line,
      form: p.sites[0].text,
      kind: c + x === 0 ? 'unclassified' : 'double-classified',
    })
  }
  return problems
}

export interface FoldViolation {
  producerId: string
  file: string
  name: string
  /** 'not-folded' -- the producer is censused CARRIES-FORWARD but its body
   *  never calls FOLD_FUNCTION, so every inherited alias it holds dies at the
   *  next serialize/restore. This is the R1 BLOCKER's own shape, reproduced
   *  structurally: it is the check that would have caught it at commit time. */
  kind: 'not-folded'
}

/**
 * Every censused CARRIES-FORWARD producer that does not actually route through
 * the shared fold, given the DERIVED call sites. The load-bearing tier-1 check.
 */
export function auditProducerFold(
  foldCallSites: ReadonlyArray<{ file: string; name: string }>,
  census: readonly ProducerCensusEntry[] = ALIAS_PRODUCER_CENSUS,
): FoldViolation[] {
  const folded = new Set(foldCallSites.map((s) => `${s.file}::${s.name}`))
  const out: FoldViolation[] = []
  for (const e of census) {
    if (e.disposition !== 'carries-forward') continue
    if (!folded.has(`${e.file}::${e.name}`)) out.push({ producerId: e.id, file: e.file, name: e.name, kind: 'not-folded' })
  }
  return out
}

/** Every call in `source`, keyed to its nearest NAMED enclosing function --
 *  the raw material for the delegation check. */
export function extractCallsByFunction(fileName: string, source: string): Array<{ file: string; line: number; caller: string; callee: string }> {
  const sf = parse(fileName, source)
  const out: Array<{ file: string; line: number; caller: string; callee: string }> = []
  ;(function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const e = node.expression
      let callee: string | null = null
      if (ts.isIdentifier(e)) callee = e.text
      else if (ts.isPropertyAccessExpression(e)) callee = e.name.text
      if (callee !== null) out.push({ file: fileName, line: lineOf(sf, node), caller: enclosingFunctionName(node), callee })
    }
    node.forEachChild(visit)
  })(sf)
  return out
}

/**
 * How each delta-shaped object literal binds its `modified` field. THE fact the
 * delegation check turns on: `modified: assign.modified` passes a producer's
 * computed lineage through; `modified: {}` is applyDraft's own shipped bug --
 * an empty lineage statement on a body that has lineage.
 */
export interface ModifiedBinding {
  file: string
  line: number
  name: string
  /** 'passthrough' -- a property access (`assign.modified`), i.e. some other
   *  producer's computed record. 'local-identifier' -- a shorthand/identifier
   *  naming a record built in this function (applyBodyPattern's own `modified`,
   *  which the fold mutates in place). 'empty-literal' -- a fresh `{}`: this
   *  function STATES that the body has no id lineage at all. 'other' -- any
   *  form nobody has ruled on; fail-closed, never assumed safe. */
  kind: 'passthrough' | 'local-identifier' | 'empty-literal' | 'other'
  text: string
}

export function extractModifiedBindings(fileName: string, source: string): ModifiedBinding[] {
  const sf = parse(fileName, source)
  const out: ModifiedBinding[] = []
  ;(function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node) && objectLiteralHasDeltaShape(node)) {
      for (const prop of node.properties) {
        let kind: ModifiedBinding['kind'] | null = null
        let text = ''
        if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'modified') {
          kind = 'local-identifier'
          text = prop.getText(sf)
        } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'modified') {
          const init = prop.initializer
          text = stripCommentsAndNormalize(prop.getText(sf)).slice(0, 120)
          if (ts.isPropertyAccessExpression(init)) kind = 'passthrough'
          else if (ts.isObjectLiteralExpression(init)) kind = init.properties.length === 0 ? 'empty-literal' : 'other'
          else if (ts.isIdentifier(init)) kind = 'local-identifier'
          else kind = 'other'
        }
        if (kind !== null) out.push({ file: fileName, line: lineOf(sf, prop), name: enclosingFunctionName(prop), kind, text })
      }
    }
    node.forEachChild(visit)
  })(sf)
  return out
}

export interface DelegationViolation {
  producerId: string
  file: string
  name: string
  line: number
  /** 'delegate-not-called' -- the entry claims to compose another producer's
   *  assignment, but never calls it.
   *  'delegate-not-carries-forward' -- it delegates to something that is not
   *  itself censused CARRIES-FORWARD, so the chain bottoms out in nothing.
   *  'lineage-discarded' -- it calls the delegate and then writes `modified:
   *  {}` (or an unruled form) anyway, throwing away the lineage the delegate
   *  just computed. This is applyDraft's own shipped bug, made structurally
   *  unwritable. */
  kind: 'delegate-not-called' | 'delegate-not-carries-forward' | 'lineage-discarded'
  detail: string
}

export function auditProducerDelegation(
  calls: ReadonlyArray<{ file: string; caller: string; callee: string }>,
  bindings: readonly ModifiedBinding[],
  census: readonly ProducerCensusEntry[] = ALIAS_PRODUCER_CENSUS,
): DelegationViolation[] {
  const out: DelegationViolation[] = []
  const carriesForward = new Set(census.filter((e) => e.disposition === 'carries-forward').map((e) => e.name))
  for (const e of census) {
    if (e.disposition !== 'delegates') continue
    const target = e.delegatesTo ?? ''
    const called = calls.some((c) => c.file === e.file && c.caller === e.name && c.callee === target)
    if (!called) {
      out.push({ producerId: e.id, file: e.file, name: e.name, line: 0, kind: 'delegate-not-called', detail: `no call to ${target || '<none declared>'}` })
      continue
    }
    if (!carriesForward.has(target)) {
      out.push({ producerId: e.id, file: e.file, name: e.name, line: 0, kind: 'delegate-not-carries-forward', detail: `${target} is not censused carries-forward` })
      continue
    }
    for (const b of bindings.filter((b) => b.file === e.file && b.name === e.name)) {
      if (b.kind === 'passthrough') continue
      out.push({ producerId: e.id, file: e.file, name: e.name, line: b.line, kind: 'lineage-discarded', detail: `modified is '${b.kind}': ${b.text}` })
    }
  }
  return out
}

/** Every `this.#mint({...})` call, keyed to its enclosing function, with
 *  whether the record literal carries an `aliases` field. The structural fact
 *  every NAMED EXCEPTION's proof rests on. */
export interface MintSite {
  file: string
  line: number
  name: string
  carriesAliases: boolean
  text: string
}

export function extractMintSites(fileName: string, source: string): MintSite[] {
  const sf = parse(fileName, source)
  const out: MintSite[] = []
  ;(function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isPrivateIdentifier(node.expression.name) && node.expression.name.text === '#mint'
    ) {
      const arg = node.arguments[0]
      const carriesAliases =
        arg !== undefined && ts.isObjectLiteralExpression(arg) &&
        arg.properties.some((p) => (
          (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'aliases') ||
          (ts.isShorthandPropertyAssignment(p) && p.name.text === 'aliases')
        ))
      out.push({
        file: fileName,
        line: lineOf(sf, node),
        name: enclosingFunctionName(node),
        carriesAliases,
        text: stripCommentsAndNormalize(node.getText(sf)).slice(0, 140),
      })
    }
    node.forEachChild(visit)
  })(sf)
  return out
}

export interface ExceptionViolation {
  exceptionId: string
  file: string
  name: string
  line: number
  /** 'mint-carries-aliases' -- the exception's proof is "GENESIS: no target
   *  body, so no inherited lineage", but its #mint passes an `aliases` field,
   *  i.e. it DOES hold inherited lineage and is dropping it. The exception has
   *  rotted and the producer needs a fold. This is what stops a named exception
   *  from being a permanent blind spot: the reason is re-proven on every run,
   *  never trusted because someone wrote it down once. */
  kind: 'mint-carries-aliases'
  detail: string
}

/**
 * Re-prove every NAMED EXCEPTION's structural claim against the code. A genesis
 * producer that grows a target body (its #mint starts carrying `aliases`) goes
 * RED here rather than silently keeping an exception that is no longer true.
 */
export function auditGenesisExceptions(
  mintSites: readonly MintSite[],
  exceptions: readonly ProducerNamedException[] = PRODUCER_NAMED_EXCEPTIONS,
): ExceptionViolation[] {
  const out: ExceptionViolation[] = []
  for (const x of exceptions) {
    for (const m of mintSites.filter((m) => m.file === x.file && m.name === x.name && m.carriesAliases)) {
      out.push({
        exceptionId: x.id,
        file: x.file,
        name: x.name,
        line: m.line,
        kind: 'mint-carries-aliases',
        detail: m.text,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// THE WORKER'S EXPOSED SURFACE (WO UI-57-R3 amendment B1(b)).
//
// THE BYPASS THIS CLOSES, in the preflight's own words: "the Comlink api object
// exposes 29 methods, far more than the six names. A new delta-producing method
// added to that surface (e.g. a future applyCounterbore) is app-reachable the
// moment it ships, but a harness built from the six names literally never
// invokes it; applyFillet/applyChamfer/makeHole already have exactly this shape
// TODAY. A runtime census that only executes a fixed call list is a hard-coded
// array wearing a runtime costume -- the same fail-open class."
//
// So the runtime census's driven list is cross-checked against THIS derivation
// -- the api object's own keys, parsed from geom-worker.ts's AST. Neither list
// is hand-maintained against the other: adding a method to the Comlink surface
// puts it in this domain automatically, and it must then be DRIVEN or
// DISPOSITIONED.
// ---------------------------------------------------------------------------

export const WORKER_API_FILE = 'src/geom/worker/geom-worker.ts'

export interface WorkerApiMethod {
  file: string
  line: number
  /** The key the Comlink surface exposes (what the app calls). */
  name: string
  /** The GeomEngine method its body delegates to -- the name V8 reports when
   *  the runtime census observes it running. Falls back to `name` when the
   *  wrapper's body names no engine call (which the census then treats as
   *  undriven, i.e. fail-closed). */
  engineMethod: string
}

/**
 * Every key of geom-worker.ts's `const api = { ... }` object -- the surface
 * Comlink.expose() publishes to the app.
 *
 * Real AST parse: the api object is found by its declaration, never by regex
 * over the file, so a commented-out method neither forges nor hides a member.
 */
export function extractWorkerApiMethods(fileName: string, source: string): WorkerApiMethod[] {
  const sf = parse(fileName, source)
  const out: WorkerApiMethod[] = []
  ;(function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'api' &&
      node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue
        if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) continue
        const name = prop.name.text
        // The engine method this wrapper delegates to: the first `engine.X(...)`
        // call anywhere in its initializer.
        let engineMethod: string | null = null
        ;(function findEngineCall(n: ts.Node): void {
          if (engineMethod !== null) return
          if (
            ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'engine'
          ) {
            engineMethod = n.expression.name.text
            return
          }
          n.forEachChild(findEngineCall)
        })(prop.initializer)
        out.push({ file: fileName, line: lineOf(sf, prop), name, engineMethod: engineMethod ?? name })
      }
    }
    node.forEachChild(visit)
  })(sf)
  return out
}

/**
 * Methods on the exposed Comlink surface that the runtime census does NOT drive
 * because they PRODUCE NO DELTA -- each with the reason, re-checked every run
 * (#runtime-api-dispositions-live asserts none names a deleted method, and that
 * every reason is non-empty).
 *
 * This is the ONLY admissible way for an exposed method to stay out of the
 * runtime census. Silence is not: an exposed method that produces a delta and
 * appears in neither the driven list nor here is RED by construction, which is
 * what makes a future applyCounterbore impossible to ship unproven.
 */
export const NON_PRODUCER_API_DISPOSITIONS: Array<{ method: string; reason: string }> = [
  { method: 'init', reason: 'Kernel lifecycle: boots occt-wasm and returns KernelInfo. Constructs no body and no ElementMapDelta, so it holds no alias lineage to carry or drop.' },
  { method: 'dispose', reason: 'Kernel lifecycle: releases ONE body handle. Returns void, produces no delta; a released body has no lineage to state.' },
  { method: 'disposeAll', reason: 'Kernel lifecycle: releases every live handle. Returns void, produces no delta.' },
  { method: 'makeSolidFromPlanarFaces', reason: 'MSH-3 prismatic bridge: mints a solid from a mesh-lane planar face set. It is GENESIS by the same proof as makeBox (no target body), but it is not in ALIAS_PRODUCER_CENSUS because it constructs no delta-shaped object the tier-1 derivation recognizes; it is dispositioned here rather than silently omitted. If it ever gains a target body it must be censused and driven.' },
  { method: 'recognizeFeatures', reason: 'Read-only interrogation: returns FeatureVerdict[] describing a body. Mutates nothing and emits no delta.' },
  { method: 'queryFeatures', reason: 'Read-only interrogation: a filtered recognizeFeatures. Mutates nothing and emits no delta.' },
  { method: 'tessellate', reason: 'Read-only interrogation: returns triangle buffers for display. Mutates nothing and emits no delta.' },
  { method: 'resolve', reason: 'Read-only interrogation: the READ side of the alias invariant. It CONSUMES lineage (via the shared resolver) rather than producing a delta; its correctness is proven by tier 2 and by the matrix, not by a producer disposition.' },
  { method: 'measure', reason: 'Read-only interrogation: area/volume/length on ids. Mutates nothing and emits no delta.' },
  { method: 'classifyFace', reason: 'Read-only interrogation: returns a face SurfaceType. Mutates nothing and emits no delta.' },
  { method: 'exportStep', reason: 'I/O out: serializes live bodies to STEP bytes. Creates no body and emits no delta. (Its inverse, importStep, IS censused as the X-import genesis exception and IS driven.)' },
  { method: 'serializeBody', reason: 'I/O out: kernel-native body cache for fast document open. Emits no delta -- it is the WRITE half of the round trip whose READ half, restoreBody, consumes one.' },
  { method: 'restoreBody', reason: 'I/O in: CONSUMES an ElementMapDelta to rebuild rec.aliases; it produces none. It is the exact path the whole WO family exists to protect, and every tier-1 matrix cell drives it (aliasLineageMatrix.test.ts).' },
  { method: 'snapshotsFor', reason: 'Read-only interrogation: returns the body record\'s geometry snapshots. Mutates nothing and emits no delta.' },
  { method: 'bboxDiagonal', reason: 'Read-only interrogation: returns a scalar. Mutates nothing and emits no delta.' },
]

// ---------------------------------------------------------------------------
// ROUTE-LEVEL DISPOSITIONS (WO UI-57-R4, the R3 audit's B1 BLOCKER).
//
// The audit: "the B1(b) cross-check ... collapses coverage to a METHOD-NAME set
// ..., so a genesis call to makeRevolve or makeSweep falsely certifies its
// unexecuted add route." So the runtime census's domain is now DISPATCH ROUTES
// (aliasDispatchRoutes.ts), and these are the only two admissible reasons a
// PRODUCER route may not be driven on an alias-carrying body. Both are
// fail-closed: each is proven by EXECUTING the route, never by asserting it.
// ---------------------------------------------------------------------------

/**
 * Routes that MINT a body from nothing. They must still be DRIVEN (a genesis
 * route nobody executes is as unproven as any other) -- what they are excused
 * from is the alias-carrying-target requirement, because there is no target to
 * carry from. #runtime-genesis-routes-truly-genesis re-earns that excuse every
 * run: if one of these ever emits a delta that reconstructs inherited lineage,
 * its "there is no target body" proof has rotted and it is RED.
 */
export const GENESIS_ROUTE_DISPOSITIONS: Array<{ route: string; reason: string }> = [
  { route: 'makeBox', reason: 'Mints a box from dimensions. No target body parameter exists, so there is no inherited lineage to carry.' },
  { route: 'makeExtrude:op=newBody', reason: 'The newBody branch (geom-engine.ts:1365) mints from #assignSweptFaceIds and returns before the tool-boolean lane; `target` is unread on this route. Its add/cut/intersect siblings DO take a target and are driven on the healed fixture.' },
  { route: 'makeRevolve:op=newBody', reason: 'The newBody branch (geom-engine.ts:1449) mints from #assignSweptFaceIds and returns before #applySweepBoolean. THE R3 GAP: this route being driven is exactly what falsely certified the undriven op=add route when the domain was method names.' },
  { route: 'makeSweep:op=newBody', reason: 'The newBody branch (geom-engine.ts:1781) mints and returns before #applyToolBoolean.' },
  { route: 'makeLoft:op=newBody', reason: 'The newBody branch (geom-engine.ts:1950) mints and returns before #applyToolBoolean.' },
  { route: 'importStep', reason: 'I/O in: mints bodies from STEP bytes with import-rooted ids. No target body, so no inherited lineage (the X-import named exception, driven from engine-produced bytes).' },
  { route: 'importIges', reason: 'I/O in (WO-1824): mints bodies from IGES bytes with import-rooted ids. No target body, so no inherited lineage (the X-import-iges named exception, driven from a committed IGES fixture).' },
]

/**
 * Routes PRODUCTION ITSELF refuses. They must still be DRIVEN, and the refusal
 * OBSERVED: the census asserts the route returns ok:false with a diagnostic
 * matching `refusalMatches`.
 *
 * THIS IS A GATE, NOT AN EXCUSE. The day the kernel subset grows fuse, this
 * route starts succeeding, the disposition stops matching, and the census goes
 * RED demanding a real recipe -- which is the entire point: a new delta-producing
 * route must be unable to ship unproven. Compare the alternative of quietly
 * leaving fuse out of the domain, which is how R3 shipped an undriven add branch.
 */
export const REFUSED_ROUTE_DISPOSITIONS: Array<{ route: string; reason: string; refusalMatches: RegExp }> = []

/**
 * WO UI-57-R4 (the R3 audit's B2 BLOCKER, fail-closed half).
 *
 * A production `import()` whose specifier cannot be evaluated statically is a
 * route NOTHING can prove is not the shared resolver. It may not be silently
 * dropped -- that is reading unreadability as absence, the fail-open move this
 * family has now been bounced for three rounds. It may only be RULED ON here, by
 * file:line, with a reason a reader can check.
 *
 * EMPTY TODAY, and that is a MEASURED claim, not a hopeful one: every dynamic
 * import in production source spells a literal specifier (the census cell
 * #census-tier2-dynamic-specifiers-readable re-measures it every run and names
 * any new one). The table exists so the day someone writes `import(pathFromCfg)`
 * the census stops them rather than shrugging.
 */
export const UNREADABLE_DYNAMIC_IMPORT_DISPOSITIONS: Array<{ file: string; line: number; reason: string }> = []

// ---------------------------------------------------------------------------
// TIER 2: aliasLineage.ts consumers, derived by import graph.
// ---------------------------------------------------------------------------

export interface AliasConsumerEntry {
  id: string
  file: string
  /** 'shared-resolver' -- the ONE consumer that owns the resolve invariant and
   *  therefore carries the full 4-scenario proof matrix (single-generation,
   *  multi-generation through a downstream feature, undo/redo, save/load).
   *  'routes-through-shared-resolver' -- it consumes lineage only by calling
   *  the shared resolver, so its correctness is the resolver's; it gets a
   *  STRUCTURAL routing check, not its own scenario matrix (the WO's tier-2
   *  rule).
   *  'lineage-writer' -- it WRITES lineage into a delta via the shared fold;
   *  its proof is tier 1's. */
  role: 'shared-resolver' | 'routes-through-shared-resolver' | 'lineage-writer'
  /** Which aliasLineage exports it imports, and where its proof lives. */
  note: string
}

// WO UI-57-R3 blocker 2. The R2 module's own import extractor lived here:
// resolvesToAliasModule() (hand-rolled path arithmetic) + extractAliasImports()
// (one file at a time, ts.ImportDeclaration only). BOTH ARE DELETED, and the
// deletion is the point.
//
// They were not merely incomplete -- they were the wrong SHAPE of mechanism. A
// per-file extractor can only ever answer "does THIS file, which you already
// handed me, import the module?", which is why the R2 tier had to be fed a
// hard-coded CANDIDATE_FILES array, and why the auditor's fourth importer was
// never even offered to the classifier. Keeping them as "helpers" would leave an
// adversarial fixture driving a function that is NOT the gate -- exactly the
// defect the R2 auditor named: the fixture "proves the classifier rejects an
// importer only after a human manually supplies its source; it does not prove
// repository discovery".
//
// Discovery now lives in aliasProgramDerivation.ts (discoverAliasImporters),
// which walks the app's real ts.Program, resolves specifiers with the compiler
// host, follows re-export barrels to a fixpoint, and catches dynamic import()
// -- and the RED probes drive THAT function, on a Program, so a fourth importer
// file is DISCOVERED rather than supplied.
//
// auditConsumerClassification stays: given the DISCOVERED importers, it is what
// rules on them. It takes a structural shape so the Program-derived importers
// and the in-memory fixture Program's importers both drive this one function.

export function auditConsumerClassification(
  importers: ReadonlyArray<{ file: string; line: number }>,
  census: readonly AliasConsumerEntry[] = ALIAS_CONSUMER_CENSUS,
): Array<{ file: string; line: number; kind: 'unclassified' | 'double-classified' }> {
  const out: Array<{ file: string; line: number; kind: 'unclassified' | 'double-classified' }> = []
  for (const i of importers) {
    const n = census.filter((e) => e.file === i.file).length
    if (n === 1) continue
    out.push({ file: i.file, line: i.line, kind: n === 0 ? 'unclassified' : 'double-classified' })
  }
  return out
}

// ---------------------------------------------------------------------------
// THE TABLES.
// ---------------------------------------------------------------------------

const ENGINE: ProducerFile = 'src/geom/worker/geom-engine.ts'
const STABLE_ID: ProducerFile = 'src/geom/worker/stable-id.ts'

/**
 * TIER 1 CARRIES-FORWARD members. Every one folds its target's inherited
 * lineage through FOLD_FUNCTION, and every one carries a decisive
 * heal -> this feature -> serialize/restore -> resolve proof in
 * aliasLineageMatrix.test.ts.
 */
export const ALIAS_PRODUCER_CENSUS: ProducerCensusEntry[] = [
  {
    id: 'P-cut',
    file: STABLE_ID,
    name: 'assignCutFaceIds',
    disposition: 'carries-forward',
    note: 'The boolean lineage core -- reached by makeHole, applyBoolean, applyFillet/applyChamfer and the pattern cut lane. Inherits via the REQUIRED inheritedAliases parameter (a new caller that forgets it is a compile error). Proof: #matrix-cut-* .',
  },
  {
    id: 'P-shell',
    file: STABLE_ID,
    name: 'assignShellFaceIds',
    disposition: 'carries-forward',
    note: 'applyShell\'s producer. Inherits via the REQUIRED inheritedAliases parameter. Proof: #matrix-shell.',
  },
  {
    id: 'P-pattern',
    file: ENGINE,
    name: 'applyBodyPattern',
    disposition: 'carries-forward',
    note: 'Inherits seed.aliases (instance 0 keeps the seed body\'s own ids, so an aliased seed face\'s live root is live here under the same id). Proof: #matrix-pattern.',
  },
  {
    id: 'P-draft',
    file: ENGINE,
    name: 'applyDraft',
    disposition: 'carries-forward',
    note: 'Draft is a bijection on faces, so its delta legitimately reports no modified/generated/deleted of its OWN -- which is exactly why it shipped an empty `modified: {}` literal and lost every inherited alias on restore. Inherits target.aliases. Proof: #matrix-draft.',
  },
  {
    id: 'P-healed-ids',
    file: ENGINE,
    name: '#assignHealedIds',
    disposition: 'carries-forward',
    note: 'The defeature/heal-removal producer. Inherits rec.aliases. Proof: #matrix-healed-ids.',
  },
  {
    id: 'P-edited-ids',
    file: ENGINE,
    name: '#assignEditedIds',
    disposition: 'carries-forward',
    note: 'Runs on EVERY face edit (faceOffset/pocketDepth/holeDiameter/holeDepth), so it is the producer a second push/pull on an already-healed body goes through. Inherits rec.aliases. Proof: #matrix-edited-ids.',
  },
  {
    id: 'P-pair-healed',
    file: ENGINE,
    name: '#pairHealedFaces',
    disposition: 'carries-forward',
    note: 'The seam-healing producer -- the one that MINTS aliases, and the template the WO calls already-compliant. It was compliant for ONE generation only: it emitted modified[loser] but not the root\'s own survivor marker, which a merge winner got incidentally from its own step (b). Now routes through the shared fold like everything else. Proof: #matrix-pair-healed + #matrix-heal-then-heal (the second-generation cell that was RED before this round).',
  },

  // ---- DELEGATES ---------------------------------------------------------
  // The WO's "known members today" list named 7 producers. The mechanical
  // derivation finds 25 (see the R2 report's census disclosure): the missing 18
  // are the contract-facing `elementMap: {...}` composers and the genesis mints,
  // both of which construct the delta shape and are therefore in the domain by
  // the WO's own definition. This is exactly why the ruling says DERIVE the
  // census and calls audit citations examples, never the domain.
  {
    id: 'P-boolean',
    file: ENGINE,
    name: 'applyBoolean',
    disposition: 'delegates',
    delegatesTo: 'assignCutFaceIds',
    note: 'Composes `modified: assign.modified` from assignCutFaceIds, which it calls with target.aliases. Proof: #matrix-cut-boolean.',
  },
  {
    id: 'P-tool-boolean',
    file: ENGINE,
    name: '#applyToolBoolean',
    disposition: 'delegates',
    delegatesTo: 'assignCutFaceIds',
    note: 'The shared extrude/revolve/sweep-as-boolean lane. Composes assignCutFaceIds\'s record, called with target.aliases.',
  },
  {
    id: 'P-hole',
    file: ENGINE,
    name: 'makeHole',
    disposition: 'delegates',
    delegatesTo: 'assignCutFaceIds',
    note: 'Composes assignCutFaceIds\'s record, called with target.aliases. Proof: #matrix-cut-hole.',
  },
  {
    id: 'P-edge-dressup',
    file: ENGINE,
    name: '#applyEdgeDressUp',
    disposition: 'delegates',
    delegatesTo: 'assignCutFaceIds',
    note: 'The fillet/chamfer lane -- THE feature in the R1 auditor\'s own repro (heal -> fillet -> restore). Composes assignCutFaceIds\'s record, called with target.aliases. Proof: #matrix-cut-fillet, which is the blocker\'s exact chain.',
  },
  {
    id: 'P-shell-op',
    file: ENGINE,
    name: 'applyShell',
    disposition: 'delegates',
    delegatesTo: 'assignShellFaceIds',
    note: 'Composes assignShellFaceIds\'s record, called with target.aliases. Proof: #matrix-shell.',
  },
  {
    id: 'P-shell-construct',
    file: ENGINE,
    name: '#applyShellByConstruction',
    disposition: 'delegates',
    delegatesTo: 'assignShellFaceIds',
    note: 'WO-2107: applyShell\'s second route (shell the block, cut the depressions back in), used only when the direct shell fails. Composes assignShellFaceIds\'s record, called with target.aliases, and mints with target.aliases, exactly like P-shell-op. Proof: #matrix-shell (same producer).',
  },
  {
    id: 'P-defeature',
    file: ENGINE,
    name: 'defeatureBatch',
    disposition: 'delegates',
    delegatesTo: '#assignHealedIds',
    note: 'Composes #assignHealedIds\'s record, which folds rec.aliases. Proof: #matrix-healed-ids.',
  },
  {
    id: 'P-offset-boolean',
    file: ENGINE,
    name: '#offsetFaceBoolean',
    disposition: 'delegates',
    delegatesTo: '#assignEditedIds',
    note: 'The faceOffset/pocketDepth core (the push/pull path this whole WO family is about). Composes #assignEditedIds\'s record, which folds rec.aliases. Proof: #matrix-edited-ids.',
  },
  {
    id: 'P-hole-diameter',
    file: ENGINE,
    name: '#recutHole',
    disposition: 'delegates',
    delegatesTo: '#assignEditedIds',
    note: 'The holeDiameter AND holeDepth (WO-2091) core: heal + re-cut. Composes #assignEditedIds\'s record, which folds rec.aliases. Runtime proof: recipes hole-diameter and hole-depth.',
  },
  {
    id: 'P-relief',
    file: ENGINE,
    name: '#applyRelief',
    disposition: 'delegates',
    delegatesTo: '#assignEditedIds',
    note: 'The editFeature kind relief core (WO-2171): split the flat face, sew in the relief face. Composes #assignEditedIds\'s record, which folds rec.aliases, and mints with aliases: rec.aliases. Runtime proof: recipe relief.',
  },
  {
    id: 'P-debug-edited',
    file: ENGINE,
    name: 'debugAssignEditedIdsForTest',
    disposition: 'delegates',
    delegatesTo: '#assignEditedIds',
    note: 'Committed TEST HOOK (not in the frozen contract): returns #assignEditedIds\'s record verbatim, constructing no delta of its own -- it is derived only by its declared return type. Its lineage behaviour IS #assignEditedIds\'s.',
  },
]

/**
 * TIER 1 NAMED EXCEPTIONS. Every entry's reason is the same PROOF, the only
 * honest one available in this domain: the producer has no target body, so
 * there is no inherited alias map for it to drop. Each is a GENESIS producer --
 * it mints a body from a sketch profile, a primitive parameter set, or an
 * imported file, and its own #mint call passes NO `aliases` field (verified
 * per-member below; that absence is the structural fact these reasons rest on).
 *
 * "It does not merge faces" is NOT admissible here and appears nowhere below:
 * healing is not how a body acquires aliases at these sites -- INHERITING them
 * from a target is -- so a reason of that shape would excuse exactly the
 * producers the blocker was about (applyDraft merges nothing either, and it was
 * the emptiest delta in the engine).
 */
export const PRODUCER_NAMED_EXCEPTIONS: ProducerNamedException[] = [
  {
    id: 'X-box',
    file: ENGINE,
    name: 'makeBox',
    reason: 'GENESIS: mints a box from parameters alone. No target body -- its #mint passes no `aliases` (re-proven every run by auditGenesisExceptions) -- so it holds no inherited lineage to drop. Every id it emits it minted itself and lands in `generated`; a generated id is an output, never an alias key. Its `modified: {}` is therefore a true statement, not applyDraft\'s false one.',
  },
  {
    id: 'X-cylinder',
    file: ENGINE,
    name: 'debugMakeCylinder',
    reason: 'GENESIS (committed test hook): mints a cylinder from parameters. No target body, no `aliases` on its #mint.',
  },
  {
    id: 'X-cone',
    file: ENGINE,
    name: 'debugMakeCone',
    reason: 'GENESIS (committed test hook): mints a cone from parameters. No target body, no `aliases` on its #mint.',
  },
  {
    id: 'X-torus',
    file: ENGINE,
    name: 'debugMakeTorus',
    reason: 'GENESIS (committed test hook): mints a torus from parameters. No target body, no `aliases` on its #mint.',
  },
  {
    id: 'X-extrude',
    file: ENGINE,
    name: 'makeExtrude',
    reason: 'GENESIS: mints a solid from a sketch profile. No target body, no `aliases` on its #mint. (Extrude AGAINST an existing body is a different path -- #applyToolBoolean -> assignCutFaceIds -- which is censused P-tool-boolean.)',
  },
  {
    id: 'X-revolve',
    file: ENGINE,
    name: 'makeRevolve',
    reason: 'GENESIS: mints a solid from a profile revolved about an axis. No target body, no `aliases` on its #mint. (Revolve against an existing body routes through #applyToolBoolean.)',
  },
  {
    id: 'X-sweep',
    file: ENGINE,
    name: 'makeSweep',
    reason: 'GENESIS: mints a solid from a profile swept along a path. No target body, no `aliases` on its #mint. (Sweep against an existing body routes through #applyToolBoolean.)',
  },
  {
    id: 'X-loft',
    file: ENGINE,
    name: 'makeLoft',
    reason: 'GENESIS: mints a solid lofted through profiles. No target body, no `aliases` on its #mint.',
  },
  {
    id: 'X-import',
    file: ENGINE,
    name: 'importStep',
    reason: 'GENESIS: mints bodies from an imported STEP file. No target body, no `aliases` on its #mint; ids are minted from the imported topology and land in `generated`.',
  },
  {
    id: 'X-import-iges',
    file: ENGINE,
    name: 'importIges',
    reason: 'GENESIS (WO-1824): mints bodies from an imported IGES file, the kernel-side twin of importStep with the same `#mint({ shape, faceMap, snapshots })` (no `aliases`, re-proven every run by auditGenesisExceptions) and the same empty `modified: {}`. No target body -- whether the file held a solid or only surfaces, the shape it mints is caller-owned output, never an inherited alias source -- so it holds no inherited lineage to drop.',
  },
]

/**
 * TIER 2. Derived by import graph from aliasLineage.ts's exports, exactly as
 * the ruling specifies -- the right tool HERE, where a resolver's domain
 * genuinely is its importers (contrast tier 1, whose members import nothing).
 */
export const ALIAS_CONSUMER_CENSUS: AliasConsumerEntry[] = [
  {
    id: 'C-engine',
    file: 'src/geom/worker/geom-engine.ts',
    role: 'shared-resolver',
    note: 'Imports resolveFaceIdVia (via #resolveFaceId/#faceHashIndex/#migrateEdgeId), aliasesFromDelta (via restoreBody), and foldAliasLineageIntoDelta (tier 1). Owns the resolve invariant, so it carries the FULL 4-scenario matrix exactly once: #matrix-scenario-single-generation, #matrix-scenario-through-feature, #matrix-scenario-undo-redo, #matrix-scenario-save-load.',
  },
  {
    id: 'C-ui-migration',
    file: 'src/components/model3d/workbench/faceIdMigration.ts',
    role: 'routes-through-shared-resolver',
    note: 'The UI store migration (selection/appearance/visibility). Imports resolveFaceIdVia + aliasesFromDelta and does no lineage reasoning of its own, so per the WO\'s tier-2 rule it gets a STRUCTURAL routing check (#matrix-tier2-routing), not its own scenario matrix.',
  },
  {
    id: 'C-stable-id',
    file: 'src/geom/worker/stable-id.ts',
    role: 'lineage-writer',
    note: 'Imports foldAliasLineageIntoDelta for assignCutFaceIds/assignShellFaceIds. Writes lineage, never resolves it; its proof is tier 1\'s (#matrix-cut-*, #matrix-shell).',
  },
]
