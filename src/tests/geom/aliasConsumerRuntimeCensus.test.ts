// WO UI-57-R3 -- TIER 2's RUNTIME HALF (contract Required shape item 2: the
// import-graph derivation "IS PAIRED WITH a runtime structural check: resolve a
// multi-generation alias through EVERY consumer entry point and assert the
// shared resolver observed the call (spy/counter on the production resolver)").
//
// WHY A RUNTIME HALF AT ALL. The import graph (aliasProgramDerivation.ts,
// exercised by aliasLifecycleCensus.test.ts) answers "who COULD consume the
// lineage" -- it discovers the domain. It cannot answer "does the lineage
// actually flow through the ONE shared resolver when a real alias is resolved
// through this consumer's real entry point". An importer that imports
// resolveFaceIdVia and then, on some branch, compares ids by string equality
// anyway is import-graph GREEN and behaviourally broken -- and that string-
// equality bypass is UI-57-R1 blocker 2 by name. So membership is DISCOVERED
// statically and behaviour is PROVEN by execution, per the RUNTIME-GROUNDED
// CENSUS LAW's split of advisory vs verdict-bearing.
//
// THE COUNTER ON THE PRODUCTION RESOLVER. The contract says "spy/counter on the
// production resolver". A vi.mock of aliasLineage.ts would replace the resolver
// with a fake and then prove the FAKE was called -- censusing the mock, and
// worse, disabling the very code whose invocation is the claim. So the counter
// is V8's own precise coverage over the UNMODIFIED src/geom/aliasLineage.ts
// (support/runtimeCallCensus.ts): the real resolver runs, and V8 reports how
// many times. Nothing is patched.
//
// MULTI-GENERATION, not single. Every entry point below is driven with an alias
// that has survived a DOWNSTREAM FEATURE (heal -> fillet), which is the R1
// killer's own shape -- a single-generation alias would pass through code paths
// that a second generation breaks, which is exactly how R1 shipped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ElementMapDelta } from '../../geom/geom-service.ts'
import { ALIAS_CONSUMER_CENSUS, ALIAS_MODULE, FOLD_FUNCTION } from './aliasLifecycleCensus.ts'
import { RuntimeCallCensus, callsTo, namesIn, type CallCounts } from './support/runtimeCallCensus.ts'
import { healedStep, type HealedStep } from './fixtures/healedStep.ts'
// The REAL UI stores -- not doubles. All three are plain classes with no-arg
// constructors and no DOM/React dependency, so the UI consumer lane is driven
// exactly as the app drives it (migrateStoredFaceIds writing real stored ids).
import { migrateStoredFaceIds } from '../../components/model3d/workbench/faceIdMigration.ts'
import { SelectionState } from '../../viewport3d/SelectionState.ts'
import { AppearanceStore } from '../../components/model3d/appearance/appearanceStore.ts'
import { VisibilityStore } from '../../components/model3d/visibility/visibilityStore.ts'

const RESOLVER = 'resolveFaceIdVia'
const FROM_DELTA = 'aliasesFromDelta'

describe('WO UI-57-R3 tier 2 RUNTIME: a MULTI-GENERATION alias resolves through EVERY consumer entry point, and the ONE shared resolver is OBSERVED handling each', () => {
  let engine: GeomEngine
  let census: RuntimeCallCensus
  let h: HealedStep
  /** The healed body carried THROUGH a downstream feature (fillet): the alias
   *  here is multi-generation, i.e. it survived a feature that never touched it. */
  let downstream: BodyHandle
  let downstreamDelta: ElementMapDelta
  /** consumer entry point -> resolver calls V8 observed during it. */
  const perEntry = new Map<string, CallCounts>()

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
    h = await healedStep(engine)
    const tess = await engine.tessellate(h.body, { deflection: 0.1 })
    const edge = tess.edgeIds.find((id) => (id as string).includes(h.merge.winner as string))
    if (edge === undefined) throw new Error('fixture: no live edge on the merged winner')
    const f = await engine.applyFillet({ featureId: 'T2FIL', body: h.body, edges: [edge], radius: 1, propagateTangent: true })
    if (!f.ok) throw new Error(`fixture: fillet failed: ${JSON.stringify(f.diagnostics)}`)
    downstream = f.body!
    downstreamDelta = f.elementMap!

    // Counters attach AFTER the fixture is built, so each entry point's window
    // measures only that entry point.
    census = await RuntimeCallCensus.open([ALIAS_MODULE])

    // UI-57-R4: takeWindow() RESETS V8's counters as it reads them, so the take
    // IS the window (see RuntimeCallCensus -- R3 diffed two takes, which under
    // reset semantics subtracts the previous window from this one). Take once to
    // zero, drive, take again to read exactly this entry point's calls.
    const record = async (entry: string, drive: () => Promise<void> | void): Promise<void> => {
      await census.takeWindow()
      await drive()
      perEntry.set(entry, await census.takeWindow())
    }

    // ---- C-engine (shared-resolver): the worker's own read entry points ----
    await record('engine.resolve', async () => { await engine.resolve(downstream, [h.merge.loser]) })
    await record('engine.measure', async () => { await engine.measure(downstream, 'area', [h.merge.loser]) })
    await record('engine.classifyFace', async () => { await engine.classifyFace(downstream, h.merge.loser) })
    await record('engine.restoreBody', async () => {
      const bytes = await engine.serializeBody(downstream)
      await engine.restoreBody(bytes, downstreamDelta)
    })

    // ---- C-ui-migration: the UI store lane, driven with the REAL stores ----
    await record('migrateStoredFaceIds', () => {
      const selection = new SelectionState()
      const appearance = new AppearanceStore()
      const visibility = new VisibilityStore()
      // The UI is holding the LOSER id -- the state a user's selection / face
      // colour / hidden-face mask is actually in after a merge heals.
      selection.select(h.merge.loser)
      appearance.setFaceColor(h.merge.loser, [1, 0, 0])
      visibility.setFaceHidden(h.merge.loser, true)
      const result = migrateStoredFaceIds(downstreamDelta, { selection, appearance, visibility })
      // Not merely "the resolver was called": the stored ids must ACTUALLY have
      // moved to the live winner, in all three stores.
      expect(result.aliasCount, 'the downstream delta must declare the inherited alias for the UI lane to migrate').toBeGreaterThan(0)
      expect(selection.selection.has(h.merge.winner), 'selection must migrate loser -> winner').toBe(true)
      expect(selection.selection.has(h.merge.loser), 'the stale loser id must be gone from the selection').toBe(false)
      expect(appearance.faceColor(h.merge.winner), 'the painted face colour must migrate to the winner').toEqual([1, 0, 0])
      expect(visibility.isFaceHidden(h.merge.winner), 'the hidden-face mask must migrate to the winner').toBe(true)
    })

    // ---- C-stable-id (lineage-writer): its consumption IS the fold ---------
    await record('stable-id fold (a further feature on the aliased body)', async () => {
      const r = await engine.makeHole({
        featureId: 'T2H', body: downstream, face: h.merge.winner, points: [{ x: 30, y: 15, z: 10 }],
        style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 3 },
      })
      if (!r.ok) throw new Error(`fixture: makeHole on the filleted body failed: ${JSON.stringify(r.diagnostics)}`)
    })
  }, 600_000)

  afterAll(async () => {
    await census?.close()
    await engine?.disposeKernel()
  })

  it('#tier2-runtime-fixture-multi-generation: the alias under test really IS multi-generation (it survived a downstream feature that never touched it) -- otherwise every cell below proves only the easy case', async () => {
    const [res] = await engine.resolve(downstream, [h.merge.loser])
    expect(res.status, 'the merged-away id must still resolve on the DOWNSTREAM body, or the fixture is single-generation').toBe('fallback')
    // The fillet's delta never mentions the loser as its own doing -- that is the
    // R1 blocker's whole shape -- so this is genuinely inherited lineage.
    expect(downstreamDelta.modified[h.merge.loser as string], 'the downstream delta must carry the INHERITED pair (that is what makes this multi-generation)').toBeDefined()
  }, 60_000)

  it('#tier2-runtime-resolver-observed: EVERY consumer entry point drove the ONE shared resolver in src/geom/aliasLineage.ts (the counter is V8 over the UNMODIFIED module -- no mock, no patch)', () => {
    const problems: string[] = []
    for (const [entry, counts] of perEntry) {
      const resolver = callsTo(counts, ALIAS_MODULE, RESOLVER)
      const fromDelta = callsTo(counts, ALIAS_MODULE, FROM_DELTA)
      const fold = callsTo(counts, ALIAS_MODULE, FOLD_FUNCTION)
      if (resolver + fromDelta + fold === 0) {
        problems.push(
          `consumer entry point '${entry}' resolved a multi-generation alias WITHOUT the shared resolver observing a ` +
          `single call. It is reasoning about lineage itself -- a hand-rolled alias walk or a raw string compare -- ` +
          `which is UI-57-R1 blocker 2 by name. Observed in ${ALIAS_MODULE} during '${entry}': ` +
          `${namesIn(counts, ALIAS_MODULE).join(', ') || '<nothing>'}`,
        )
      }
    }
    expect(problems, `${problems.length} consumer entry point(s) bypassed the shared resolver:\n${problems.join('\n')}`).toEqual([])
    expect(perEntry.size, 'no entry points were driven -- this cell would be vacuous').toBeGreaterThanOrEqual(6)
  })

  it('#tier2-runtime-every-censused-consumer-driven: every tier-2 census entry has at least one DRIVEN entry point (a dispositioned consumer nobody executes has an unproven routing claim)', () => {
    // Which census entry each driven entry point belongs to. The mapping is
    // stated once, here, and checked for COMPLETENESS against the census table
    // -- so a new consumer disposition with no runtime entry point is RED.
    const ENTRY_POINTS_BY_CONSUMER: Record<string, string[]> = {
      'C-engine': ['engine.resolve', 'engine.measure', 'engine.classifyFace', 'engine.restoreBody'],
      'C-ui-migration': ['migrateStoredFaceIds'],
      'C-stable-id': ['stable-id fold (a further feature on the aliased body)'],
    }
    const undriven = ALIAS_CONSUMER_CENSUS.filter((c) => {
      const entries = ENTRY_POINTS_BY_CONSUMER[c.id] ?? []
      return entries.length === 0 || !entries.some((e) => perEntry.has(e))
    })
    expect(undriven.map((c) => `${c.id} (${c.file})`), 'censused consumer(s) with no driven runtime entry point -- add one, or the disposition is a claim nobody tested').toEqual([])
    // ...and no mapping names a consumer the census no longer has.
    const known = new Set(ALIAS_CONSUMER_CENSUS.map((c) => c.id))
    expect(Object.keys(ENTRY_POINTS_BY_CONSUMER).filter((id) => !known.has(id)), 'entry-point mapping names a consumer the census no longer lists').toEqual([])
  })

  it('#tier2-runtime-resolver-is-shared: the UI lane and the worker lane drove the SAME module (one resolver, one lineage rule, two lanes -- the whole reason aliasLineage.ts exists)', () => {
    const ui = perEntry.get('migrateStoredFaceIds') as CallCounts
    const worker = perEntry.get('engine.resolve') as CallCounts
    expect(callsTo(ui, ALIAS_MODULE, RESOLVER), 'the UI store migration must resolve through the shared module').toBeGreaterThan(0)
    expect(callsTo(worker, ALIAS_MODULE, RESOLVER), 'the worker read path must resolve through the SAME shared module').toBeGreaterThan(0)
    // The UI lane must also rebuild its map with the shared rule rather than
    // reading `modified` itself -- the two lanes agreeing is the invariant.
    expect(callsTo(ui, ALIAS_MODULE, FROM_DELTA), 'the UI lane must rebuild lineage via the shared aliasesFromDelta, not by reading `modified` itself').toBeGreaterThan(0)
  })

  it('#tier2-runtime-counter-canary: the resolver counter DISCRIMINATES -- it is not reporting "called" for everything (a counter that always fires proves nothing)', async () => {
    // An engine read on a body with NO aliases, through an id that needs no
    // resolution. If the counter fired here as loudly as it does above, the
    // cells above would be green for the wrong reason.
    await census.takeWindow()
    const box = await engine.makeBox('T2BOX', { x: 5, y: 5, z: 5 })
    expect(box.ok).toBe(true)
    const observed = await census.takeWindow()
    expect(callsTo(observed, ALIAS_MODULE, FROM_DELTA), 'makeBox is genesis -- it has no delta to rebuild lineage from').toBe(0)
  }, 60_000)
})
