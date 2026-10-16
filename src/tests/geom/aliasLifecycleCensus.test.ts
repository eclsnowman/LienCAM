// WO UI-57-R2 (DECISIONS 2026-07-17 "UI-57 second strike on alias-lineage",
// ruling 1): the census is committed as a CAN-FAIL test that FAILS when a new
// alias lifecycle path appears without a matrix disposition.
//
// Reads the REAL sources with node:fs and runs them through the SAME exported
// production functions the census module uses -- never a re-implemented copy
// (the technique the committed precedent, src/tests/sketch/
// asyncWriteChannelCensus.test.ts, is audited on). The adversarial fixtures
// below then drive those same functions with literal fixture sources, so every
// RED direction this census claims is a COMMITTED, permanently-re-run proof
// rather than a one-time manual mutation whose log can rot.
//
// The RED directions proven here are the ways this invariant has ACTUALLY been
// broken, or could next be broken:
//   1. a new delta producer appears and nobody rules on it     -> fixture A
//   2. a censused carries-forward producer never folds          -> fixture B
//      (the R1 BLOCKER's own shape, reproduced structurally)
//   3. a delegate discards the lineage it just composed         -> fixture C
//      (applyDraft's own shipped `modified: {}` bug)
//   4. a genesis exception ROTS -- it grows a target body       -> fixture D
//   5. a new aliasLineage consumer appears undisposed           -> fixture E
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, it, expect, beforeAll } from 'vitest'
import {
  PRODUCER_FILES, ALIAS_MODULE, FOLD_FUNCTION,
  ALIAS_PRODUCER_CENSUS as BASE_PRODUCER_CENSUS, PRODUCER_NAMED_EXCEPTIONS, ALIAS_CONSUMER_CENSUS,
  extractDeltaProducerSites, deriveProducers, extractFoldCallSites,
  extractCallsByFunction, extractModifiedBindings, extractMintSites,
  auditProducerClassification, auditProducerFold, auditProducerDelegation,
  auditGenesisExceptions, auditConsumerClassification,
  UNREADABLE_DYNAMIC_IMPORT_DISPOSITIONS,
  type ProducerFile,
} from './aliasLifecycleCensus'
import {
  createAliasProgram, createInMemoryAliasProgram, deriveCheckedReturnProducers,
  discoverAliasImporters, discoverAliasImportGraph, isProductionSource, resolveSpecifier, REPO_ROOT,
  type AliasProgram, type DiscoveredImporter, type UnresolvableDynamicImport,
} from './aliasProgramDerivation.ts'

// WO-2804: the granted census test owns this new producer's disposition.
// It delegates the complete assignment, including inherited aliases, exactly
// as the Resize core does. The runtime census independently drives the route.
const ALIAS_PRODUCER_CENSUS = [...BASE_PRODUCER_CENSUS, {
  id: 'P-hole-move', file: 'src/geom/worker/geom-engine.ts' as const,
  name: '#moveRecognizedHole', disposition: 'delegates' as const,
  delegatesTo: '#assignEditedIds',
  note: 'Exact-void Move composes #assignEditedIds and retains rec.aliases; runtime hole-move recipe runs on an inherited-alias body.',
}]

/** Repo-relative `src/...` path -> a URL resolvable from THIS test file's own
 *  location (`src/tests/geom/`, two directories below `src/`). */
function readSource(repoRelativePath: string): string {
  return readFileSync(new URL(`../../${repoRelativePath.replace(/^src\//, '')}`, import.meta.url), 'utf8')
}

const sourceOf = new Map<string, string>(PRODUCER_FILES.map((f) => [f, readSource(f)]))
const syntacticSites = PRODUCER_FILES.flatMap((f) => extractDeltaProducerSites(f, sourceOf.get(f) as string))

/**
 * THE DOMAIN, from TWO unioned derivations (WO UI-57-R3 blocker 1).
 *
 * The R2 census had only the syntactic half, and its two documented blind spots
 * are exactly what the auditor walked through: a producer declaring the
 * CANONICAL IMPORTED `ElementMapDelta` return type and returning a PREBUILT
 * delta has no same-file type declaration to learn and no object literal to
 * sweep, so it was invisible -- the census passed 28/28 with EXIT CODE 0 while
 * the control type-checker saw it plainly.
 *
 * So the checker-resolved return type (aliasProgramDerivation.ts) is unioned in:
 * imported, aliased, inherited, union, parenthesized and Promise-wrapped shapes
 * all collapse into one question -- "does the resolved type HAVE these three
 * members" -- which is the question the control asked.
 *
 * The literal sweep is RETAINED, not replaced, exactly as the WO's suggested fix
 * says: it is what catches the nested contract-facing `elementMap: {...}`
 * composers, whose enclosing method's return type is a bare OpResult and which
 * the checker's return-type question therefore cannot see.
 *
 * ADVISORY, per the RUNTIME-GROUNDED CENSUS LAW ruling 2: this pair is the cheap
 * early-warning DISCOVERY layer. The verdict-bearing gate is the runtime census
 * (aliasProducerRuntimeCensus.test.ts), which EXECUTES every member this
 * discovers. Neither may pass while a discovered member goes undisposed (here)
 * or unexecuted (there).
 */
let ap: AliasProgram
let producers: ReturnType<typeof deriveProducers>
let allSites: typeof syntacticSites
let importers: DiscoveredImporter[]
let unreadableDynamicImports: UnresolvableDynamicImport[]

beforeAll(() => {
  // ONE Program, shared by both tiers (~6 s over ~1,220 files).
  ap = createAliasProgram(ALIAS_MODULE)
  const checked = deriveCheckedReturnProducers(ap, PRODUCER_FILES)
  allSites = [
    ...syntacticSites,
    ...checked.map((c) => ({ file: c.file, line: c.line, name: c.name, via: 'return-type' as const, text: c.typeText })),
  ]
  // WO-2799's cutCavity returns raw numerical OCCT face history, not stable
  // ElementMapDelta IDs. Discover it, then prove the named disposition below.
  // Its enclosing construction route still has the existing delegation audit.
  producers = deriveProducers(allSites).filter((p) =>
    !(p.file === 'src/geom/worker/geom-engine.ts' && p.name === 'cutCavity'))
  const graph = discoverAliasImportGraph(ap)
  importers = graph.importers
  unreadableDynamicImports = graph.unresolvable
}, 120_000)
const foldCalls = PRODUCER_FILES.flatMap((f) => extractFoldCallSites(f, sourceOf.get(f) as string))
const calls = PRODUCER_FILES.flatMap((f) => extractCallsByFunction(f, sourceOf.get(f) as string))
const bindings = PRODUCER_FILES.flatMap((f) => extractModifiedBindings(f, sourceOf.get(f) as string))
const mints = PRODUCER_FILES.flatMap((f) => extractMintSites(f, sourceOf.get(f) as string))

// ---- TIER 1: delta producers -----------------------------------------------

describe('UI-57-R2 tier 1: every ElementMapDelta producer is classified, and every one that holds inherited aliases carries them forward', () => {
  it('#census-sanity: the AST sweep actually found producers in BOTH engine files (a zero/tiny count means the parser or the file set broke, not that none exist)', () => {
    expect(producers.length).toBeGreaterThanOrEqual(20)
    for (const f of PRODUCER_FILES) {
      expect(producers.filter((p) => p.file === f).length, `no producers derived from ${f}`).toBeGreaterThan(0)
    }
    // Neither derivation may silently stop contributing: the literal sweep is
    // what catches the contract-facing `elementMap: {...}` composers, the
    // return-type sweep is what catches a producer declaring a named
    // assignment type (CutAssignment). Losing either re-opens a blind spot.
    expect(allSites.some((s) => s.via === 'object-literal')).toBe(true)
    expect(allSites.some((s) => s.via === 'return-type')).toBe(true)
  })

  it('#census-checker-half-live: the CHECKER derivation really contributes to the domain on the REAL files (the half the R2 census lacked -- if it silently stops resolving, the imported-shape blind spot is back and nothing else would notice)', () => {
    const checked = deriveCheckedReturnProducers(ap, PRODUCER_FILES)
    // The seven the checker resolves today include raw-history cutCavity,
    // the #private methods and the
    // two named-assignment-type producers (CutAssignment / ShellAssignment --
    // the latter only via `extends`). A checker that resolved nothing would make
    // the union silently collapse back to the R2 syntactic sweep, which is
    // exactly the state the auditor bypassed.
    expect(checked.map((c) => c.name).sort(), 'the checker resolved a different producer set than the tree declares -- if this is a real code change, update this pin; if it is empty/short, the Program or the checker broke')
      .toEqual(['#assignEditedIds', '#assignHealedIds', '#pairHealedFaces', 'assignCutFaceIds', 'assignShellFaceIds', 'cutCavity', 'debugAssignEditedIdsForTest'])
    // The checker must be resolving TYPE NAMES, not just inline literals: these
    // two are declared `: CutAssignment` / `: ShellAssignment` and are the
    // reason a same-file-only derivation ever seemed sufficient.
    expect(checked.find((c) => c.name === 'assignCutFaceIds')?.typeText).toBe('CutAssignment')
    expect(checked.find((c) => c.name === 'assignShellFaceIds')?.typeText).toBe('ShellAssignment')
  }, 120_000)

  it('#census-cutCavity: the named numerical kernel-history producer is not a stable-ID delta and is converted by the censused Shell owner', () => {
    const sf = ap.program.getSourceFile(`${REPO_ROOT}/src/geom/worker/geom-engine.ts`)!
    let found = 0
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && node.name.getText(sf) === 'cutCavity' && node.initializer && ts.isArrowFunction(node.initializer)) {
        found++
        const signature = ap.checker.getSignatureFromDeclaration(node.initializer)!
        const ret = ap.checker.getNonNullableType(ap.checker.getReturnTypeOfSignature(signature))
        // A rename or a change to stable/string IDs must reopen this disposition.
        expect(ap.checker.typeToString(ret)).toBe('EvolutionData')
        for (const field of ['modified', 'generated', 'deleted']) {
          const symbol = ret.getProperty(field)!
          expect(ap.checker.typeToString(ap.checker.getTypeOfSymbolAtLocation(symbol, node))).toBe('number[]')
        }
        let owner: ts.Node = node
        while (owner.parent && !ts.isMethodDeclaration(owner)) owner = owner.parent
        expect(ts.isMethodDeclaration(owner) && owner.name.getText(sf)).toBe('#applyShellByConstruction')
        expect(node.initializer.body.getText(sf)).toContain('k.cutWithHistory(source, cavity, inputHashes, HM)')
        expect(node.initializer.body.getText(sf)).toContain('return cut')
        expect(owner.getText(sf)).toContain('decodeEvolution(evo.modified)')
        expect(owner.getText(sf)).toContain('assignShellFaceIds(req.featureId, target.faceMap, removedRecords, spawnedRecords, this.#faceProbes(result), target.aliases)')
      }
      node.forEachChild(visit)
    }
    visit(sf)
    expect(found).toBe(1)
    expect(deriveProducers(allSites).filter((p) => p.name === 'cutCavity')).toHaveLength(1)
  })

  it('#census-unclassified: every derived producer is classified EXACTLY ONCE -- an unclassified one is RED (the fail-closed domain the whole ruling turns on)', () => {
    const problems = auditProducerClassification(producers, ALIAS_PRODUCER_CENSUS)
    if (problems.length > 0) {
      const detail = problems.map((p) => `  ${p.file}:${p.line} ${p.name} -- ${p.kind}\n      form: ${p.form}`).join('\n')
      throw new Error(
        `${problems.length} delta producer(s) are not classified exactly once.\n` +
        `DERIVE the ruling and either (a) add an ALIAS_PRODUCER_CENSUS entry (carries-forward: call ` +
        `${FOLD_FUNCTION}; delegates: compose a carries-forward producer's record), or (b) add a ` +
        `PRODUCER_NAMED_EXCEPTIONS entry PROVING no inherited alias can reach it -- the only honest ` +
        `proof here is "there is no target body" ("it does not merge faces" excuses applyDraft, which ` +
        `was the blocker):\n${detail}`,
      )
    }
  })

  it('#census-fold: every censused CARRIES-FORWARD producer positively routes through the shared fold (the check that would have caught the R1 blocker at commit time)', () => {
    const violations = auditProducerFold(foldCalls, ALIAS_PRODUCER_CENSUS)
    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.producerId} (${v.file} :: ${v.name}) -- ${v.kind}`).join('\n')
      throw new Error(
        `${violations.length} censused producer(s) hold inherited alias lineage and never fold it into their ` +
        `delta -- every alias they carry dies at the next serialize/restore:\n${detail}`,
      )
    }
  })

  it('#census-delegation: every DELEGATES producer really calls its carries-forward delegate AND passes its record through (never re-writing modified: {})', () => {
    const violations = auditProducerDelegation(calls, bindings, ALIAS_PRODUCER_CENSUS)
    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.producerId} (${v.file}:${v.line} ${v.name}) -- ${v.kind}: ${v.detail}`).join('\n')
      throw new Error(`${violations.length} delegation(s) do not hold:\n${detail}`)
    }
  })

  it('#census-exception-rot: every NAMED EXCEPTION\'s "GENESIS: no target body" proof is RE-PROVEN against the code (its #mint carries no aliases)', () => {
    const violations = auditGenesisExceptions(mints)
    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.exceptionId} (${v.file}:${v.line} ${v.name}) -- ${v.kind}\n      ${v.detail}`).join('\n')
      throw new Error(
        `${violations.length} named exception(s) have ROTTED: the producer now mints with inherited aliases, ` +
        `so "there is no target body" is no longer true and it must fold instead:\n${detail}`,
      )
    }
    // Non-vacuity: the sweep must actually be finding mints with aliases
    // somewhere, or `carriesAliases` is broken and every exception passes for
    // the wrong reason.
    expect(mints.some((m) => m.carriesAliases), 'no #mint anywhere carries aliases -- the extractor is broken').toBe(true)
    expect(mints.some((m) => !m.carriesAliases), 'every #mint carries aliases -- the extractor is broken').toBe(true)
  })

  it('#census-tables-live: every censused/excepted name still EXISTS in the derived domain (a table entry for a deleted function is dead weight that hides a real gap)', () => {
    const derived = new Set(producers.map((p) => `${p.file}::${p.name}`))
    const stale = [...ALIAS_PRODUCER_CENSUS, ...PRODUCER_NAMED_EXCEPTIONS]
      .filter((e) => !derived.has(`${e.file}::${e.name}`))
      .map((e) => `${e.id} (${e.file} :: ${e.name})`)
    expect(stale, 'census/exception entries naming functions that no longer produce a delta').toEqual([])
  })
})

// ---- TIER 2: aliasLineage consumers, by import graph ------------------------

// WO UI-57-R3 blocker 2: this tier is now an IMPORT GRAPH, derived by the
// compiler's own module resolution over EVERY production file in the Program.
//
// What it replaced, and why. The R2 check scanned:
//
//     const CANDIDATE_FILES = [...PRODUCER_FILES, '.../faceIdMigration.ts']
//
// -- the three files already known to be consumers. A new aliasLineage importer
// anywhere else in src was never presented to the classifier at all, so the
// auditor's src/geom/worker/auditAliasConsumer.ts (importing resolveFaceIdVia,
// no census entry) left the census GREEN at 28/28 with EXIT CODE 0. The R2
// fixture "proves the classifier rejects an importer only after a human manually
// supplies its source; it does not prove repository discovery" -- the auditor's
// own words, and the exact enumerate-only-known-paths failure the two-bounce
// ruling forbids.
//
// There is no file list here now. Membership is: every module in the app's own
// tsconfig Program, filtered by the PRODUCTION-ROOT RULE (isProductionSource --
// under src/, not under src/tests/), whose static or dynamic import resolves --
// through any depth of re-export barrel -- to aliasLineage.ts.
describe('UI-57-R3 tier 2: every aliasLineage.ts consumer is DISCOVERED from the import graph and has a disposition', () => {
  it('#census-tier2-sanity: the import GRAPH found the known consumer lanes (worker + UI), and each really imports an aliasLineage export', () => {
    expect(importers.length).toBeGreaterThanOrEqual(3)
    for (const i of importers) expect(i.imported.length, `${i.file} matched with no named imports`).toBeGreaterThan(0)
    // Both lanes must be present: the whole reason the resolver lives outside
    // geom-engine.ts is that the UI store migration must read the SAME lineage
    // the same way.
    expect(importers.map((i) => i.file)).toContain('src/geom/worker/geom-engine.ts')
    expect(importers.map((i) => i.file)).toContain('src/components/model3d/workbench/faceIdMigration.ts')
  })

  it('#census-tier2-discovery-is-repository-wide: the domain is the PROGRAM, not a file list -- the discovery walks every production module the app build compiles', () => {
    // The scan must be over the real, whole source graph. A Program that saw a
    // handful of files would make every "no undisposed consumer" verdict below
    // vacuous -- which is precisely how the R2 tier passed.
    const production = ap.program.getSourceFiles()
      .filter((sf) => !sf.isDeclarationFile)
      .map((sf) => sf.fileName.replace(/\\/g, '/'))
      .filter((f) => f.includes('/src/'))
    expect(production.length, 'the Program compiled a suspiciously small source set -- discovery would be vacuous').toBeGreaterThan(500)
    // The production-root rule is STRUCTURAL, not a list: tests are excluded by
    // where they live, so a new test file never needs a disposition and a new
    // production consumer always does.
    expect(isProductionSource('src/geom/worker/geom-engine.ts')).toBe(true)
    expect(isProductionSource('src/components/model3d/workbench/faceIdMigration.ts')).toBe(true)
    expect(isProductionSource('src/tests/geom/aliasLineageMatrix.test.ts')).toBe(false)
    // ...and no discovered importer is a test file, or the census would be
    // policing its own fixtures.
    for (const i of importers) expect(isProductionSource(i.file), `${i.file} is not a production module`).toBe(true)
  })

  it('#census-tier2-unclassified: every importer of aliasLineage.ts is disposed EXACTLY ONCE -- a new consumer with no disposition is RED', () => {
    const problems = auditConsumerClassification(importers)
    if (problems.length > 0) {
      const detail = problems.map((p) => `  ${p.file}:${p.line} -- ${p.kind}`).join('\n')
      throw new Error(`${problems.length} aliasLineage consumer(s) are not disposed exactly once:\n${detail}`)
    }
  })

  it('#census-tier2-resolver-unique: exactly ONE consumer is the shared-resolver owner (the 4-scenario matrix is a property of the resolver\'s invariant, proven once)', () => {
    expect(ALIAS_CONSUMER_CENSUS.filter((e) => e.role === 'shared-resolver').map((e) => e.file)).toEqual(['src/geom/worker/geom-engine.ts'])
  })

  it('#census-tier2-module-resolution: BOTH lanes\' import forms resolve through the COMPILER HOST (worker .ts-suffixed, UI extensionless) and a near-miss does not', () => {
    // The two lanes reach the module from different depths and spell the
    // extension differently ('.ts' in the worker lane, extensionless in the UI
    // lane). R2 normalized that by hand; the compiler's own bundler-mode
    // resolution is what decides it now, so an import form nobody anticipated
    // (index re-export, path alias, extensionless-with-subpath) resolves
    // correctly for free rather than needing new arithmetic.
    const alias = resolveSpecifier(ap, `${REPO_ROOT}/src/geom/worker/geom-engine.ts`, '../aliasLineage.ts')
    expect(alias, 'the worker lane\'s .ts-suffixed specifier must resolve to the shared module').toBe(ap.aliasModulePath)
    const ui = resolveSpecifier(ap, `${REPO_ROOT}/src/components/model3d/workbench/faceIdMigration.ts`, '../../../geom/aliasLineage')
    expect(ui, 'the UI lane\'s extensionless specifier must resolve to the SAME module').toBe(ap.aliasModulePath)
    // A near-miss in the same directory must NOT be confused for it.
    expect(resolveSpecifier(ap, `${REPO_ROOT}/src/geom/worker/geom-engine.ts`, '../geom-service.ts')).not.toBe(ap.aliasModulePath)
  })
})

// ---- TIER 2 RED DIRECTIONS: driven on a REAL PROGRAM, so DISCOVERY is what is
// ---- proven -- never a classifier hand-fed a source string.
//
// This is the R2 fixture's exact defect, stated by the auditor: it "proves the
// classifier rejects an importer only after a human manually supplies its
// source; it does not prove repository discovery". Every probe below therefore
// ADDS A FILE TO A PROGRAM'S SOURCE SET and asserts the real discovery path
// finds it -- the WO's demand verbatim: "Add a probe that adds a fourth file to
// the source set and proves the real discovery path turns RED."
describe('UI-57-R3 tier 2 RED directions (a fourth importer is DISCOVERED, not supplied)', () => {
  /** The minimal shared module + its two known lanes, as an in-memory Program.
   *  `extra` is the auditor's new file. */
  function programWith(extra: Record<string, string>) {
    return createInMemoryAliasProgram({
      'src/geom/aliasLineage.ts': `
        export type StableId = string & { __b?: 1 }
        export function resolveFaceIdVia(aliases: ReadonlyMap<StableId, StableId> | undefined, id: StableId): StableId { return aliases?.get(id) ?? id }
        export function aliasesFromDelta(): Map<StableId, StableId> { return new Map() }
      `,
      'src/geom/worker/geom-engine.ts': `
        import { resolveFaceIdVia } from '../aliasLineage.ts'
        export const useIt = (m: Map<string, string>, id: string) => resolveFaceIdVia(m as never, id as never)
      `,
      ...extra,
    }, 'src/geom/aliasLineage.ts')
  }

  it('#census-red-tier2-fourth-file: a NEW importer ANYWHERE in src is DISCOVERED and, with no disposition, is RED (the R2 auditor\'s auditAliasConsumer.ts bypass, reproduced)', () => {
    // The auditor's own file, verbatim in shape: a new production module
    // importing resolveFaceIdVia with no ALIAS_CONSUMER_CENSUS entry. R2 stayed
    // GREEN at 28/28 because CANDIDATE_FILES never mentioned it.
    const p = programWith({
      'src/geom/worker/auditAliasConsumer.ts': `
        import { resolveFaceIdVia } from '../aliasLineage.ts'
        export function auditResolve(m: Map<string, string>, id: string) { return resolveFaceIdVia(m as never, id as never) }
      `,
    })
    const found = discoverAliasImporters(p)
    // DISCOVERED -- nobody handed the census this path.
    expect(found.map((i) => i.file), 'the fourth importer must be found by walking the Program, not by being listed').toContain('src/geom/worker/auditAliasConsumer.ts')
    // ...and it is RED, because nothing dispositions it.
    const problems = auditConsumerClassification(found)
    expect(problems.map((p2) => ({ file: p2.file, kind: p2.kind })))
      .toContainEqual({ file: 'src/geom/worker/auditAliasConsumer.ts', kind: 'unclassified' })
  })

  it('#census-red-tier2-dynamic-import: a consumer using `await import(...)` is DISCOVERED (a CallExpression, NOT an ImportDeclaration -- the blind spot the R3 contract\'s own suggested fix would have kept)', () => {
    // "parse every import declaration" would miss this by construction. The
    // codebase already uses dynamic import elsewhere (meshLabWorker.ts:26), so
    // this is a live route, not a hypothetical.
    const p = programWith({
      'src/geom/worker/lazyAliasConsumer.ts': `
        export async function lazily(m: Map<string, string>, id: string) {
          const { resolveFaceIdVia } = await import('../aliasLineage.ts')
          return resolveFaceIdVia(m as never, id as never)
        }
      `,
    })
    const found = discoverAliasImporters(p)
    const hit = found.find((i) => i.file === 'src/geom/worker/lazyAliasConsumer.ts')
    expect(hit, 'a dynamic-import consumer must be in the domain').toBeDefined()
    expect(hit!.via).toBe('dynamic-import')
    expect(hit!.imported).toContain('resolveFaceIdVia')
    expect(auditConsumerClassification(found).map((x) => x.file)).toContain('src/geom/worker/lazyAliasConsumer.ts')
  })

  // ---- WO UI-57-R4: the R3 audit's B2 BLOCKER, as committed fixtures --------
  //
  // The finding, verbatim: "B2 is only implemented for a literal token.
  // discoverAliasImporters enters the dynamic-import path only when the argument
  // node itself is ts.StringLiteral; it does not resolve a statically-known
  // const, even though binding amendment B2 explicitly covers a string-literal
  // or statically-resolvable specifier. The committed fixture tests only await
  // import('../aliasLineage.ts'), so it cannot catch this gap."
  //
  // Its evidence, verbatim: "const route = '../aliasLineage.ts' as const; const
  // { resolveFaceIdVia } = await import(route). TypeScript can statically
  // resolve route, but the shipped discoverAliasImporters returned [] and
  // printed CONST_SPECIFIER_ENUMERATED=false."
  //
  // That probe is now a permanent cell -- RED against the R3 derivation, GREEN
  // against this one -- and it is the AUDITOR'S OWN SOURCE, not a paraphrase.

  it('#census-red-tier2-const-specifier: the R3 auditor\'s escaping route -- `const route = \'...\' as const; await import(route)` -- is DISCOVERED, and by the CHECKER rather than by a token match (R4 B2)', () => {
    const p = programWith({
      'src/geom/worker/constSpecifierConsumer.ts': `
        const route = '../aliasLineage.ts' as const
        export async function lazily(m: Map<string, string>, id: string) {
          const { resolveFaceIdVia } = await import(route)
          return resolveFaceIdVia(m as never, id as never)
        }
      `,
    })
    const found = discoverAliasImporters(p)
    const target = 'src/geom/worker/constSpecifierConsumer.ts'
    const hit = found.find((i) => i.file === target)
    // The exact assertion the auditor's probe made and the R3 code failed. The
    // message names the escaping consumer and echoes the auditor's own marker,
    // so a future RED here reads as the finding rather than as "undefined".
    expect(hit, `CONST_SPECIFIER_ENUMERATED=false: ${target} consumes resolveFaceIdVia through a const-bound specifier and was NOT discovered. A const names the same module a literal does; the census must see the same consumer. Discovered instead: [${found.map((i) => i.file).join(', ') || '<none>'}]`).toBeDefined()
    expect(hit!.via).toBe('dynamic-import')
    expect(hit!.imported).toContain('resolveFaceIdVia')
    expect(hit!.specifier?.value).toBe('../aliasLineage.ts')
    // NON-VACUITY: this must be the path that could NOT exist in R3 -- if the
    // evaluator quietly took the string-literal branch, the probe would be
    // re-proving the thing that already worked.
    expect(hit!.specifier?.form, 'the const specifier must be recovered through the CHECKER; a `string-literal` form here means the fixture is not exercising the R4 mechanism at all').toBe('checker-literal-type')
    // ...and, having been discovered, it is RED with no disposition.
    expect(auditConsumerClassification(found).map((x) => x.file)).toContain('src/geom/worker/constSpecifierConsumer.ts')
  })

  it('#census-red-tier2-template-specifier: a TEMPLATE-literal specifier assembled from const parts is DISCOVERED (the same evaluator, a form the token check never had a case for)', () => {
    const p = programWith({
      'src/geom/worker/templateSpecifierConsumer.ts': `
        const dir = '..' as const
        export async function lazily(m: Map<string, string>, id: string) {
          const { resolveFaceIdVia } = await import(\`\${dir}/aliasLineage.ts\`)
          return resolveFaceIdVia(m as never, id as never)
        }
      `,
    })
    const target = 'src/geom/worker/templateSpecifierConsumer.ts'
    const hit = discoverAliasImporters(p).find((i) => i.file === target)
    expect(hit, `${target} builds its specifier from a template whose every part is statically known -- so the specifier IS statically known, and the consumer must be discovered`).toBeDefined()
    expect(hit!.specifier?.value).toBe('../aliasLineage.ts')
    expect(hit!.specifier?.form).toBe('template-expression')
  })

  it('#census-red-tier2-unreadable-specifier-fails-closed: a genuinely NON-CONSTANT specifier is not "absent" -- it is REFUSED BY NAME (the R4 B2 control: undecidable must fail closed, never silently green)', () => {
    // The audit's demand, verbatim: "together with a nonconstant control that
    // remains explicitly undiscoverable or fails closed by named disposition."
    // TypeScript CANNOT know what this loads; the honest answer is a refusal
    // that names the file and line, not an empty list that reads as safety.
    const p = programWith({
      'src/geom/worker/runtimeSpecifierConsumer.ts': `
        export async function lazily(where: string, m: Map<string, string>, id: string) {
          const mod = await import(where)
          return (mod as { resolveFaceIdVia: (a: never, b: never) => string }).resolveFaceIdVia(m as never, id as never)
        }
      `,
    })
    const graph = discoverAliasImportGraph(p)
    // NOT in the importer list -- nothing proves it IS the resolver...
    expect(graph.importers.map((i) => i.file)).not.toContain('src/geom/worker/runtimeSpecifierConsumer.ts')
    // ...and NOT silently dropped either: it is a named member awaiting a ruling.
    const flagged = graph.unresolvable.find((u) => u.file === 'src/geom/worker/runtimeSpecifierConsumer.ts')
    expect(flagged, 'an import() the compiler cannot read must leave the derivation as a NAMED unresolved route -- dropping it is how a consumer hides in plain sight').toBeDefined()
    expect(flagged!.reason).toMatch(/not a single string literal/)
    expect(flagged!.line).toBeGreaterThan(0)
  })

  it('#census-tier2-dynamic-specifiers-readable: EVERY `import()` in real production source has a specifier this census can evaluate, or a committed named disposition (measured on the real Program, not asserted)', () => {
    const undisposed = unreadableDynamicImports.filter((u) =>
      !UNREADABLE_DYNAMIC_IMPORT_DISPOSITIONS.some((d) => d.file === u.file && d.line === u.line))
    if (undisposed.length > 0) {
      const detail = undisposed.map((u) => `  ${u.file}:${u.line}  ${u.text}\n    -> ${u.reason}`).join('\n')
      throw new Error(
        `${undisposed.length} production import() call(s) have a specifier no static derivation can read, so nothing ` +
        `proves they are not consumers of the shared resolver.\n` +
        `Either make the specifier statically evaluable (a const, a template of consts, a literal), or add a ruling to ` +
        `UNREADABLE_DYNAMIC_IMPORT_DISPOSITIONS stating why this route cannot reach aliasLineage:\n${detail}`,
      )
    }
    // Every disposition must still name a live site -- a ruling for code that
    // moved is dead weight over a real gap.
    const stale = UNREADABLE_DYNAMIC_IMPORT_DISPOSITIONS.filter((d) =>
      !unreadableDynamicImports.some((u) => u.file === d.file && u.line === d.line))
    expect(stale, 'dispositions naming import() sites that are no longer unreadable (or no longer exist)').toEqual([])
  })

  it('#census-red-tier2-barrel: a consumer importing through a RE-EXPORT BARREL is DISCOVERED (membership follows the compiler, so one hop of indirection is not a hiding place)', () => {
    const p = programWith({
      'src/geom/index.ts': `export * from './aliasLineage.ts'`,
      'src/geom/worker/barrelConsumer.ts': `
        import { resolveFaceIdVia } from '../index.ts'
        export const viaBarrel = (m: Map<string, string>, id: string) => resolveFaceIdVia(m as never, id as never)
      `,
    })
    const found = discoverAliasImporters(p)
    expect(found.map((i) => i.file), 'an importer one barrel hop away still consumes the shared resolver').toContain('src/geom/worker/barrelConsumer.ts')
  })

  it('#census-red-tier2-test-files-excluded: a TEST file importing the module is NOT in the domain (the production-root RULE, not an allowlist)', () => {
    const p = programWith({
      'src/tests/geom/someNewAliasTest.test.ts': `
        import { resolveFaceIdVia } from '../../geom/aliasLineage.ts'
        export const t = (m: Map<string, string>, id: string) => resolveFaceIdVia(m as never, id as never)
      `,
    })
    expect(discoverAliasImporters(p).map((i) => i.file)).not.toContain('src/tests/geom/someNewAliasTest.test.ts')
  })

  it('#census-red-tier2-nonconsumer-green: a production module that imports something ELSE is NOT dragged into the domain (the discovery discriminates, it does not merely accuse)', () => {
    const p = programWith({
      'src/geom/worker/unrelated.ts': `
        export function unrelated(x: number): number { return x + 1 }
      `,
    })
    expect(discoverAliasImporters(p).map((i) => i.file)).not.toContain('src/geom/worker/unrelated.ts')
  })
})

// ---- ADVERSARIAL FIXTURES: every RED direction, permanently re-run ----------

const ENGINE: ProducerFile = 'src/geom/worker/geom-engine.ts'

describe('UI-57-R2 census RED directions (adversarial fixtures drive the SAME exported functions, never a copy)', () => {
  it('#census-red-A: a NEW delta producer nobody ruled on is RED (fail-closed, the case the round exists for)', () => {
    const fixture = `
      class Engine {
        applyNewFeature(target: BodyRecord): OpResult {
          const handle = this.#mint({ shape: 0, faceMap, snapshots, aliases: target.aliases })
          return { ok: true, body: handle, elementMap: { featureId: 'F', modified: {}, generated: [], deleted: [], geometry } }
        }
      }
    `
    const derived = deriveProducers(extractDeltaProducerSites(ENGINE, fixture))
    expect(derived.map((p) => p.name)).toContain('applyNewFeature')
    const problems = auditProducerClassification(derived)
    expect(problems.map((p) => ({ name: p.name, kind: p.kind }))).toEqual([{ name: 'applyNewFeature', kind: 'unclassified' }])
  })

  it('#census-red-A2: a producer claimed by BOTH tables is RED (ambiguous rulings are refused, never resolved by table order)', () => {
    const derived = deriveProducers(extractDeltaProducerSites(ENGINE, `
      function applyDraft() { return { modified: {}, generated: [], deleted: [] } }
    `))
    const problems = auditProducerClassification(
      derived,
      [{ id: 'P-x', file: ENGINE, name: 'applyDraft', disposition: 'carries-forward', note: 'n' }],
      [{ id: 'X-x', file: ENGINE, name: 'applyDraft', reason: 'r' }],
    )
    expect(problems.map((p) => p.kind)).toEqual(['double-classified'])
  })

  it('#census-red-B: a censused CARRIES-FORWARD producer that never folds is RED (the R1 blocker, reproduced structurally)', () => {
    // The pre-fix applyDraft, verbatim in shape: it mints WITH the target's
    // aliases and emits an empty `modified`.
    const fixture = `
      class Engine {
        applyDraft(target: BodyRecord): OpResult {
          const handle = this.#mint({ shape: 0, faceMap, snapshots, aliases: target.aliases })
          return { ok: true, body: handle, elementMap: { featureId: 'F', modified: {}, generated: [], deleted: [], geometry } }
        }
      }
    `
    const violations = auditProducerFold(
      extractFoldCallSites(ENGINE, fixture),
      [{ id: 'P-draft', file: ENGINE, name: 'applyDraft', disposition: 'carries-forward', note: 'n' }],
    )
    expect(violations).toEqual([{ producerId: 'P-draft', file: ENGINE, name: 'applyDraft', kind: 'not-folded' }])
  })

  it('#census-red-B2: the SAME fixture with the fold call present is GREEN (proving the check discriminates, not merely rejects)', () => {
    const fixture = `
      class Engine {
        applyDraft(target: BodyRecord): OpResult {
          const modified = {}
          ${FOLD_FUNCTION}({ aliases: target.aliases, isLive: (id) => snaps.has(id), modified })
          return { ok: true, body: h, elementMap: { featureId: 'F', modified, generated: [], deleted: [], geometry } }
        }
      }
    `
    expect(auditProducerFold(
      extractFoldCallSites(ENGINE, fixture),
      [{ id: 'P-draft', file: ENGINE, name: 'applyDraft', disposition: 'carries-forward', note: 'n' }],
    )).toEqual([])
  })

  it('#census-red-C: a DELEGATE that calls its folding producer and then writes modified: {} anyway is RED (lineage discarded -- applyDraft\'s own shipped bug)', () => {
    const fixture = `
      class Engine {
        applyShell(target: BodyRecord): OpResult {
          const assign = assignShellFaceIds(fid, target.faceMap, rem, spawn, faces, target.aliases)
          return { ok: true, body: h, elementMap: { featureId: 'F', modified: {}, generated: assign.generated, deleted: assign.deleted, geometry } }
        }
      }
    `
    const violations = auditProducerDelegation(
      extractCallsByFunction(ENGINE, fixture),
      extractModifiedBindings(ENGINE, fixture),
      [
        { id: 'P-shell-op', file: ENGINE, name: 'applyShell', disposition: 'delegates', delegatesTo: 'assignShellFaceIds', note: 'n' },
        { id: 'P-shell', file: ENGINE, name: 'assignShellFaceIds', disposition: 'carries-forward', note: 'n' },
      ],
    )
    expect(violations.map((v) => v.kind)).toEqual(['lineage-discarded'])
  })

  it('#census-red-C2: a DELEGATE that never calls its declared delegate is RED', () => {
    const fixture = `
      class Engine {
        applyShell(): OpResult {
          return { ok: true, body: h, elementMap: { featureId: 'F', modified: other.modified, generated: [], deleted: [], geometry } }
        }
      }
    `
    const violations = auditProducerDelegation(
      extractCallsByFunction(ENGINE, fixture),
      extractModifiedBindings(ENGINE, fixture),
      [
        { id: 'P-shell-op', file: ENGINE, name: 'applyShell', disposition: 'delegates', delegatesTo: 'assignShellFaceIds', note: 'n' },
        { id: 'P-shell', file: ENGINE, name: 'assignShellFaceIds', disposition: 'carries-forward', note: 'n' },
      ],
    )
    expect(violations.map((v) => v.kind)).toEqual(['delegate-not-called'])
  })

  it('#census-red-C3: a delegation chain that bottoms out in a NON-folding producer is RED (delegation cannot launder a gap)', () => {
    const fixture = `
      class Engine {
        applyShell(): OpResult {
          const assign = assignShellFaceIds()
          return { ok: true, body: h, elementMap: { featureId: 'F', modified: assign.modified, generated: [], deleted: [], geometry } }
        }
      }
    `
    const violations = auditProducerDelegation(
      extractCallsByFunction(ENGINE, fixture),
      extractModifiedBindings(ENGINE, fixture),
      [
        { id: 'P-shell-op', file: ENGINE, name: 'applyShell', disposition: 'delegates', delegatesTo: 'assignShellFaceIds', note: 'n' },
        // assignShellFaceIds censused as a DELEGATE, not carries-forward: the chain has no fold at its root.
        { id: 'P-shell', file: ENGINE, name: 'assignShellFaceIds', disposition: 'delegates', delegatesTo: 'somethingElse', note: 'n' },
      ],
    )
    // Scoped to the entry under test: the second table row is itself a broken
    // delegation in this fixture and correctly reports its own violation, which
    // is not what this cell is asserting.
    expect(violations.filter((v) => v.producerId === 'P-shell-op').map((v) => v.kind)).toEqual(['delegate-not-carries-forward'])
  })

  it('#census-red-D: a NAMED EXCEPTION that ROTS -- its genesis mint grows a target body\'s aliases -- is RED (a written reason is re-proven, never trusted)', () => {
    const fixture = `
      class Engine {
        makeExtrude(target: BodyRecord): OpResult {
          const handle = this.#mint({ shape: 0, faceMap, snapshots, aliases: target.aliases })
          return { ok: true, body: handle, elementMap: { featureId: 'F', modified: {}, generated: [], deleted: [], geometry } }
        }
      }
    `
    const violations = auditGenesisExceptions(
      extractMintSites(ENGINE, fixture),
      [{ id: 'X-extrude', file: ENGINE, name: 'makeExtrude', reason: 'GENESIS: no target body' }],
    )
    expect(violations.map((v) => ({ id: v.exceptionId, kind: v.kind }))).toEqual([{ id: 'X-extrude', kind: 'mint-carries-aliases' }])
  })

  it('#census-red-D2: the same exception is GREEN while the mint really is genesis (no aliases field)', () => {
    const fixture = `
      class Engine {
        makeExtrude(): OpResult {
          const handle = this.#mint({ shape: 0, faceMap, snapshots })
          return { ok: true, body: handle, elementMap: { featureId: 'F', modified: {}, generated: [], deleted: [], geometry } }
        }
      }
    `
    expect(auditGenesisExceptions(
      extractMintSites(ENGINE, fixture),
      [{ id: 'X-extrude', file: ENGINE, name: 'makeExtrude', reason: 'GENESIS: no target body' }],
    )).toEqual([])
  })

  it('#census-red-E: THE R2 AUDITOR\'S TIER-1 BYPASS -- a producer returning the CANONICAL IMPORTED ElementMapDelta with no object literal is DERIVED (the blind spot that kept the R2 census green at 28/28)', () => {
    // Verbatim in shape from the R2 audit's evidence: "I appended
    // auditUnclassifiedDeltaProducer(): ElementMapDelta { return auditBuildDelta() }
    // to geom-engine.ts without adding a disposition. The unchanged census still
    // passed 28/28 with EXIT CODE 0."
    //
    // Nothing here is same-file: the type is IMPORTED, and the body returns a
    // PREBUILT delta rather than spelling an object literal. So the R2
    // derivation -- same-file type declarations + literal sweep -- saw nothing.
    // The checker sees it, because it asks the resolved type for its members.
    const p = createInMemoryAliasProgram({
      'src/geom/geom-service.ts': `
        export type StableId = string & { __b?: 1 }
        export interface ElementMapDelta {
          featureId: string
          modified: Record<StableId, StableId[]>
          generated: StableId[]
          deleted: StableId[]
        }
      `,
      'src/geom/aliasLineage.ts': `export function foldAliasLineageIntoDelta(): void {}`,
      'src/geom/worker/geom-engine.ts': `
        import type { ElementMapDelta } from '../geom-service.ts'
        declare function auditBuildDelta(): ElementMapDelta
        export class Engine {
          auditUnclassifiedDeltaProducer(): ElementMapDelta { return auditBuildDelta() }
        }
      `,
    }, 'src/geom/aliasLineage.ts')

    const derived = deriveCheckedReturnProducers(p, ['src/geom/worker/geom-engine.ts'])
    expect(derived.map((d) => d.name), 'the auditor\'s producer must be DERIVED by the checker -- this is the R2 blocker, reproduced')
      .toContain('auditUnclassifiedDeltaProducer')

    // ...and, being in the domain with no table entry, it is RED.
    const problems = auditProducerClassification(
      deriveProducers(derived.map((d) => ({ file: d.file, line: d.line, name: d.name, via: 'return-type' as const, text: d.typeText }))),
    )
    expect(problems.map((x) => ({ name: x.name, kind: x.kind })))
      .toContainEqual({ name: 'auditUnclassifiedDeltaProducer', kind: 'unclassified' })
  })

  it('#census-red-E2: the checker derivation discriminates -- a producer returning a NON-delta imported type is NOT dragged into the domain', () => {
    // The mirror of red-E. A derivation that accused every imported return type
    // would be "green by accusing everything", which proves nothing and would
    // force junk dispositions.
    const p = createInMemoryAliasProgram({
      'src/geom/geom-service.ts': `
        export interface KernelInfo { version: string; triangleBudget: number }
      `,
      'src/geom/aliasLineage.ts': `export function foldAliasLineageIntoDelta(): void {}`,
      'src/geom/worker/geom-engine.ts': `
        import type { KernelInfo } from '../geom-service.ts'
        declare function buildInfo(): KernelInfo
        export class Engine {
          notAProducer(): KernelInfo { return buildInfo() }
        }
      `,
    }, 'src/geom/aliasLineage.ts')
    expect(deriveCheckedReturnProducers(p, ['src/geom/worker/geom-engine.ts']).map((d) => d.name)).toEqual([])
  })

  it('#census-red-E3: the checker derivation follows an ALIAS, a UNION and a Promise to the same answer (the forms the R2 extractor each needed its own branch for)', () => {
    const p = createInMemoryAliasProgram({
      'src/geom/geom-service.ts': `
        export type StableId = string & { __b?: 1 }
        export interface ElementMapDelta { featureId: string; modified: Record<StableId, StableId[]>; generated: StableId[]; deleted: StableId[] }
      `,
      'src/geom/aliasLineage.ts': `export function foldAliasLineageIntoDelta(): void {}`,
      'src/geom/worker/geom-engine.ts': `
        import type { ElementMapDelta } from '../geom-service.ts'
        type Renamed = ElementMapDelta
        declare function build(): Renamed
        export class Engine {
          viaAlias(): Renamed { return build() }
          viaUnion(): Renamed | { ok: false; reason: string } { return build() }
          async viaPromise(): Promise<Renamed> { return build() }
        }
      `,
    }, 'src/geom/aliasLineage.ts')
    // All three forms land in the domain from ONE code path. `build` itself is
    // absent: it is a bodyless `declare`, which produces nothing at runtime (the
    // same rule that keeps TypeScript OVERLOAD signatures from double-counting a
    // producer -- see deriveCheckedReturnProducers).
    expect(deriveCheckedReturnProducers(p, ['src/geom/worker/geom-engine.ts']).map((d) => d.name).sort())
      .toEqual(['viaAlias', 'viaPromise', 'viaUnion'])
  })

  it('#census-red-F: a producer whose delta shape hides behind a NAMED type is still derived (the return-type half of the union carries it)', () => {
    const fixture = `
      export interface CutAssignment { faceMap: Map<number, StableId>; modified: Record<StableId, StableId[]>; generated: StableId[]; deleted: StableId[] }
      export interface ShellAssignment extends CutAssignment { unmapped: FaceProbe[] }
      export function assignSomething(): ShellAssignment { return buildIt() }
    `
    // No object literal anywhere: literal-sweep-only would derive NOTHING here,
    // and the heritage walk is what keeps a `extends CutAssignment` producer in
    // the domain.
    const sites = extractDeltaProducerSites('src/geom/worker/stable-id.ts', fixture)
    expect(sites.map((s) => ({ name: s.name, via: s.via }))).toEqual([{ name: 'assignSomething', via: 'return-type' }])
  })

  it('#census-red-G: a comment or string literal can neither forge nor hide a member (real AST parse, never a text scan)', () => {
    const fixture = `
      // const fake = { modified: {}, generated: [], deleted: [] }
      const alsoFake = "{ modified: {}, generated: [], deleted: [] }"
      /* { modified: {}, generated: [], deleted: [] } */
      function realOne() { return { modified: {}, generated: [], deleted: [] } }
    `
    expect(deriveProducers(extractDeltaProducerSites(ENGINE, fixture)).map((p) => p.name)).toEqual(['realOne'])
  })

  it('#census-red-H: an options bag with only SOME of the delta fields is NOT in the domain (all three required, never any)', () => {
    const fixture = `function opts() { return { modified: {}, geometry: {} } }`
    expect(extractDeltaProducerSites(ENGINE, fixture)).toEqual([])
  })
})

// ---- The tables themselves --------------------------------------------------

describe('UI-57-R2 census tables are well-formed', () => {
  it('#census-ids-unique: every census/exception/consumer id is unique', () => {
    const ids = [...ALIAS_PRODUCER_CENSUS.map((e) => e.id), ...PRODUCER_NAMED_EXCEPTIONS.map((e) => e.id), ...ALIAS_CONSUMER_CENSUS.map((e) => e.id)]
    expect(ids.length).toBe(new Set(ids).size)
  })

  it('#census-reasons-nonempty: every named exception states a reason and every entry a note (an empty ruling is not a ruling)', () => {
    for (const x of PRODUCER_NAMED_EXCEPTIONS) expect(x.reason.length, `${x.id} has no reason`).toBeGreaterThan(40)
    for (const e of ALIAS_PRODUCER_CENSUS) expect(e.note.length, `${e.id} has no note`).toBeGreaterThan(20)
    for (const c of ALIAS_CONSUMER_CENSUS) expect(c.note.length, `${c.id} has no note`).toBeGreaterThan(20)
  })

  it('#census-delegates-declared: every DELEGATES entry names the producer it delegates to', () => {
    for (const e of ALIAS_PRODUCER_CENSUS) {
      if (e.disposition === 'delegates') expect(e.delegatesTo, `${e.id} declares no delegatesTo`).toBeTruthy()
      else expect(e.delegatesTo, `${e.id} is ${e.disposition} but declares a delegatesTo`).toBeUndefined()
    }
  })

  it('#census-exception-reasons-honest: no named exception rests on "does not merge faces" -- that reason excuses applyDraft, which WAS the blocker', () => {
    for (const x of PRODUCER_NAMED_EXCEPTIONS) {
      expect(/does not merge|no merge|never merges/i.test(x.reason), `${x.id}'s reason is a merge argument, not a no-target-body proof`).toBe(false)
      expect(/GENESIS/.test(x.reason), `${x.id}'s reason must state the no-target-body (GENESIS) proof`).toBe(true)
    }
  })

  it('#census-module-path: ALIAS_MODULE points at the real shared module', () => {
    expect(() => readSource(ALIAS_MODULE)).not.toThrow()
    expect(readSource(ALIAS_MODULE)).toContain(`export function ${FOLD_FUNCTION}`)
  })
})
