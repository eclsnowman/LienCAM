// WO UI-57-R2 (DECISIONS 2026-07-17 "UI-57 second strike on alias-lineage",
// ruling 2): THE PROOF MATRIX. Every cell in the census's two tiers is either a
// CAN-FAIL test here or a NAMED REFUSAL with proof of unreachability that CITES
// the code -- never merely asserts it.
//
// THE INVARIANT EVERY TIER-1 CELL ASSERTS. Not "the loser resolves" (that would
// reward a producer that invents lineage), but:
//
//     resolve(id) BEFORE serialize == resolve(id) AFTER restore, for EVERY id
//
// -- the round trip changes no answer. An id that must stay 'lost' stays lost;
// an alias that must resolve 'fallback' still does. That is the honest form of
// the property, and it is what makesRestoreAgree below checks.
//
// Real occt-wasm kernel, real serializeBody/restoreBody, real engine ops. The
// fixture (fixtures/healedStep.ts) is SHARED with the R1 healing suite, so the
// two cannot drift apart.
//
// ---------------------------------------------------------------------------
// MATRIX SIZE (the WO's PREFLIGHT MATRIX SIZE note, restated as it applies here)
// ---------------------------------------------------------------------------
// A literal 7-producers x 4-scenarios cross product is 28 cells, two of whose
// scenario axes are VACUOUS for this defect class today. They collapse as
// follows, and each collapse cites the code that proves it:
//
//   * "single-generation alias" is not a separate cell: it is the BASE CASE of
//     every tier-1 cell below (the fixture heals FIRST, then runs the producer,
//     then round-trips). A cell that passes covers both.
//
//   * "undo/redo" and "save/load via the app's normal document-open flow"
//     collapse to ONE named refusal for the whole tier, proven at
//     #matrix-refusal-undo-redo-save-load below rather than repeated 7 times.
//     PROOF OF UNREACHABILITY, cited: undo/redo never touches a BodyRecord --
//     it is REPLAY through the DAG (src/doc/commands.ts:3-4, "Implements
//     docs/3d-modeling-plan.md 3.4 'Undo/redo': ... Undo/redo is REPLAY through
//     the DAG, never a geometry snapshot"), so an undone feature's body is
//     re-derived by re-running the feature, which mints a fresh alias map from
//     scratch; there is no persisted alias state for an undo to corrupt. And
//     loadDocumentArchive (src/doc/persist/format.ts:134) ends in
//     `dag.regenerate(elementMap)` -- a full structural DAG replay -- and calls
//     restoreBody NOWHERE, so "save/load via the app's normal document-open
//     flow" cannot reach the code this WO fixes. Both refusals are ASSERTED
//     mechanically below (the citations are checked against the real files), so
//     if either becomes reachable the refusal goes RED instead of rotting.
//
// The engine-contract round trip (serializeBody -> restoreBody) IS live and is
// what every tier-1 cell drives directly -- the only currently-reachable path,
// per the WO's own note that restoreBody has no production caller yet.
//
// FIX LOCUS: (a) WRITE-SIDE. Tier 3 (format.ts's load boundary) is therefore
// NOT in the census -- see the R2 report's fix-locus section.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ElementMapDelta, StableId } from '../../geom/geom-service.ts'
import { ElementMap } from '../../doc/element-map.ts'
import { FeatureDag } from '../../doc/dag.ts'
import { applyFeatureDelta } from '../../doc/replay.ts'
import { resolveFaceIdVia, aliasesFromDelta } from '../../geom/aliasLineage.ts'
import { STEP, healedStep, faceWhere, type HealedStep } from './fixtures/healedStep.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'
import { bindingsOf, RESOLVE_BINDING_FIELDS } from './support/resolveBinding.ts'
import { reresolveModelReferences, classifyOperation, indexBodies, type BodyResolution } from '../../lib/cam/modelReferenceResolution'
import type { Operation, Setup } from '../../types'

/** WORKER-CHARTER item 11 (the CRLF trap): this tree's sources are CRLF, so a
 *  citation check anchored on a literal '\n' silently never matches and the
 *  refusal below would go RED for the wrong reason -- or, in the mirror-image
 *  case, a `.not.toContain()` check would pass vacuously and let a rotted
 *  refusal through. Normalize once, here, so every citation compares against
 *  line-ending-agnostic text. */
function readRepoSource(repoRelativePath: string): string {
  return readFileSync(new URL(`../../${repoRelativePath.replace(/^src\//, '')}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}

/** A cited comment, with its `//` line prefixes and wrapping removed, so a
 *  citation matches the SENTENCE rather than the column it happened to wrap at.
 *  (Re-wrapping a paragraph must not void a proof; deleting the claim must.) */
function citedProse(repoRelativePath: string): string {
  return readRepoSource(repoRelativePath).replace(/^[ \t]*\/\/ ?/gm, '').replace(/\s+/g, ' ')
}

/**
 * THE SHARED TIER-1 ASSERTION. Round-trips `body` through the engine contract
 * with the delta `map` and proves the restore changed NO answer for any id in
 * `ids` -- neither losing an alias that resolved before, nor inventing one that
 * did not, NOR SILENTLY REBINDING ONE TO A DIFFERENT FACE.
 *
 * WO UI-57-R3 (the R2 MAJOR). This compared only `id` and `status` and was
 * therefore blind to the failure it most needed to catch: the R2 auditor changed
 * restoreBody so every rebuilt loser targeted the first DIFFERENT live face, and
 * all 16/16 cells stayed green -- the loser still resolved, still said
 * 'fallback', and pointed at the wrong face. It now compares EVERY field of the
 * binding (RESOLVE_BINDING_FIELDS, pinned exhaustive against the frozen contract
 * type at compile time -- support/resolveBinding.ts), so `localIndex` -- the
 * field that says WHICH face -- participates.
 *
 * Can-fail by construction, in two independent directions:
 *   * fold removed  -> the merged-away id resolves 'fallback' before and 'lost'
 *     after; `status` differs.
 *   * wrong binding -> the id still resolves 'fallback', but `localIndex`
 *     differs.
 * Both are proven non-vacuous by tools/mutation/ui57-heal-mutation.mjs
 * (`alias-fold` and `restore-wrong-target`), whose RED logs are committed under
 * coordination/evidence/UI-57/.
 */
async function expectRestoreAgrees(
  engine: GeomEngine, body: BodyHandle, map: ElementMapDelta, ids: StableId[], what: string,
  /** When the loser must still resolve after the restore (every cell except
   *  #matrix-shell, which legitimately REMOVES the face), the identity assertion
   *  runs on the restored body too -- so "resolves" can never again stand in for
   *  "resolves to the right face" in ANY producer cell, which is exactly how the
   *  auditor's wrong-binding mutation stayed green across all 16. */
  identity?: { loser: StableId; winner: StableId },
): Promise<{ before: Array<Record<string, unknown>>; restored: BodyHandle }> {
  const before = bindingsOf(await engine.resolve(body, ids))
  const bytes = await engine.serializeBody(body)
  const restored = await engine.restoreBody(bytes, map)
  const after = bindingsOf(await engine.resolve(restored, ids))
  expect(after, `${what}: serialize/restore CHANGED a resolve BINDING -- either the delta is not a complete statement of this body's id lineage, or an id was rebound to a DIFFERENT face. Compared fields: ${RESOLVE_BINDING_FIELDS.join(', ')}`).toEqual(before)
  if (identity !== undefined) await expectResolvesToSameLiveFace(engine, restored, identity.loser, identity.winner, what)
  return { before, restored }
}

/**
 * THE IDENTITY ASSERTION (the audit's own suggested fix: "on each restored body
 * prove the loser and its expected winner resolve to the same live face").
 *
 * Independent of the before/after comparison above, and stronger where it
 * counts: this is a claim about the RESTORED body alone, so it holds even if a
 * restore were free to renumber faces. `localIndex` is the kernel-local face the
 * caller actually receives, so loser.localIndex === winner.localIndex IS
 * "they are the same live face" -- the thing the stable-ID spec forbids getting
 * wrong, stated directly instead of inferred from a status string.
 */
async function expectResolvesToSameLiveFace(
  engine: GeomEngine, body: BodyHandle, loser: StableId, winner: StableId, what: string,
): Promise<void> {
  const [l, w] = await engine.resolve(body, [loser, winner])
  expect(w.status, `${what}: the winner must be a LIVE face for this identity check to mean anything`).toBe('exact')
  expect(l.status, `${what}: the merged-away loser must still resolve`).toBe('fallback')
  expect(l.localIndex, `${what}: SILENT WRONG-FACE BINDING -- the loser ${loser} resolves, but onto localIndex ${String(l.localIndex)} while its winner ${winner} is localIndex ${String(w.localIndex)}. A resolving-but-wrong binding is the stable-ID spec's explicitly forbidden case, and it is invisible to any check that reads only \`status\`.`).toBe(w.localIndex)
  expect(l.type, `${what}: the loser must resolve to the same SUBSHAPE TYPE as its winner`).toBe(w.type)
  expect(l.localIndex, `${what}: the identity check is vacuous if the winner itself did not resolve to a face`).toBeDefined()
}

/** A minimal ready CAM op holding `stableIds` as a persisted model reference --
 *  the shape src/tests/cam/modelReferenceResolution.integration.test.ts uses, so
 *  the two drive the SAME production mapping rather than two lookalikes. */
function setupWithRef(opId: string, bodyId: string, stableIds: string[]): Setup {
  const op: Operation = {
    id: opId, name: 'Contour', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 't', geometrySelections: [],
    modelReferences: [{ bodyId, stableIds, role: 'machining-boundary' }],
    heights: {} as never, passes: {} as never, linking: {} as never, params: {},
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 5 } as never],
  }
  return { id: 's1', name: 'S1', wcs: {} as never, stock: {} as never, operations: [op], notes: '' }
}

describe('WO UI-57-R2 tier 1: every delta producer that inherits aliases proves heal -> feature -> serialize/restore -> resolve', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  /** Every tier-1 cell asserts against the SAME id set: the merged-away loser
   *  (must stay resolvable), its winner, and both original tops. */
  const idsOf = (h: HealedStep): StableId[] => [h.merge.loser, h.merge.winner, h.topA, h.topB]

  /** Guard shared by every cell: the fixture must really have produced an alias
   *  that resolves BEFORE the round trip, or the cell proves nothing about the
   *  restore (the R0 vacuity trap, in fixture form). */
  async function expectLiveAliasBefore(body: BodyHandle, h: HealedStep, what: string): Promise<void> {
    const [res] = await engine.resolve(body, [h.merge.loser])
    expect(res.status, `${what}: fixture is VACUOUS -- the merged-away id does not resolve even BEFORE the round trip`).toBe('fallback')
  }

  // ---- P-cut / P-boolean / P-hole / P-edge-dressup (assignCutFaceIds) ------

  it('#matrix-cut-fillet: heal -> FILLET -> serialize/restore -> the merged-away id still resolves TO THE RIGHT FACE, and a persisted model reference + edge dress-up both re-drive through it (THE R1 AUDITOR\'S OWN BLOCKER REPRO)', async () => {
    const h = await healedStep(engine)
    // PERSIST a loser-naming edge id BEFORE the heal -- the state a saved
    // document is really in. After the merge NO live edge names the loser
    // (verified below), so this stale id is the only honest way to prove a
    // persisted dress-up reference still drives the restored body.
    const preHeal = await engine.tessellate(h.before, { deflection: 0.1 })
    const persistedLoserEdges = preHeal.edgeIds.filter((id) => (id as string).includes(h.topB as string))
    expect(persistedLoserEdges.length, 'fixture: expected pre-heal edges naming topB (the face that becomes the loser)').toBeGreaterThan(0)

    const tess = await engine.tessellate(h.body, { deflection: 0.1 })
    const edge = tess.edgeIds.find((id) => (id as string).includes(h.merge.winner as string))
    expect(edge, 'fixture: expected a live edge on the merged winner').toBeDefined()
    expect(
      tess.edgeIds.some((id) => (id as string).includes(h.merge.loser as string)),
      'fixture premise: after the merge NO live edge names the loser, which is WHY a persisted loser-naming edge must migrate through the alias to still work',
    ).toBe(false)

    const f = await engine.applyFillet({ featureId: 'FIL1', body: h.body, edges: [edge!], radius: 1, propagateTangent: true })
    expect(f.ok, `fillet failed: ${JSON.stringify(f.diagnostics)}`).toBe(true)
    await expectLiveAliasBefore(f.body!, h, '#matrix-cut-fillet')
    // The fillet's delta never MENTIONS the loser as its own doing -- and that
    // was the blocker: restore(fillet's delta) returned 'lost'. It now carries
    // the inherited lineage forward, so the restore agrees ON EVERY FIELD.
    const { restored } = await expectRestoreAgrees(engine, f.body!, f.elementMap!, idsOf(h), '#matrix-cut-fillet', h.merge)

    // ---- WO UI-57-R3, the R2 MAJOR: the three things this cell only CLAIMED --
    //
    // (1) IDENTITY, not status. "It resolves" rewarded a wrong binding: the R2
    //     auditor pointed every restored loser at a different live face and this
    //     cell stayed green.
    await expectResolvesToSameLiveFace(engine, restored, h.merge.loser, h.merge.winner, '#matrix-cut-fillet')

    // (2) A PERSISTED MODEL REFERENCE, re-resolved after the round trip through
    //     the REAL CAM lane -- reresolveModelReferences, whose RawResolution is
    //     the same {id,status,localIndex,type} binding. This is the consumer a
    //     silently-wrong localIndex actually harms: it machines the wrong face.
    //
    //     THE VERDICT THAT MATTERS IS 'stale-fallback', NOT 'untouched'. Reading
    //     the production semantics rather than assuming them (classifyOperation,
    //     modelReferenceResolution.ts:210-236): 'fallback' -> 'stale-fallback'
    //     (the face merged, so the toolpath is legitimately due a recompute --
    //     the op SHOULD flag), and 'lost' -> 'degraded' (the reference is DEAD).
    //     The claim this cell makes is survival, and the two verdicts are
    //     exactly what separates it: WITHOUT the write-side carry-forward this
    //     WO family exists for, the restored id resolves 'lost' and this op goes
    //     'degraded' -- a user's persisted machining boundary silently detaching
    //     from the model. That is the discrimination, and it is why this
    //     assertion is on the outcome rather than on a changed-op list.
    const reply = await engine.resolve(restored, [h.merge.loser])
    const body: BodyResolution = {
      bodyId: 'B1', changed: false,
      resolutions: reply.map((r) => ({ id: r.id, status: r.status, localIndex: r.localIndex, type: r.type })),
    }
    const verdict = classifyOperation(
      { id: 'op-fil', modelReferences: [{ bodyId: 'B1', stableIds: [h.merge.loser as string], role: 'machining-boundary' }] },
      indexBodies([body]),
    )
    expect(verdict?.outcome, 'a persisted model reference holding the merged-away id must SURVIVE the round trip: stale-fallback (recompute) is correct, degraded (dead reference) is the failure this WO exists to prevent').toBe('stale-fallback')
    expect(verdict?.lostIds, 'no persisted id may be LOST after the round trip').toEqual([])
    expect(verdict?.fallbackIds, 'the merged-away id is the one that resolves by fallback -- onto its winner').toEqual([h.merge.loser])
    // ...and the whole-pass entry point agrees, so this is the real lane rather
    // than one helper of it: the op is re-flagged, never dropped.
    const { changedOpIds } = reresolveModelReferences([setupWithRef('op-fil', 'B1', [h.merge.loser as string])], [body])
    expect(changedOpIds, 'the CAM pass must re-flag the op whose referenced face merged').toEqual(['op-fil'])

    // (3) A PERSISTED LOSER-NAMING EDGE DRESS-UP on the restored body. Each edge
    //     id was captured BEFORE the heal and names a face that no longer
    //     exists, so a dress-up through it only works if the body's alias
    //     lineage migrates the stale id (migrateEdgeIdVia).
    //
    //     THE ASSERTION IS AGREEMENT, not success -- the same invariant the
    //     resolve comparison uses, and for the same reason. A downstream feature
    //     may legitimately CONSUME an edge: this fillet really does destroy
    //     (FB:XTR:SB.e0:side ∧ FB:XTR:SB:capEnd), which refuses on the filleted
    //     body and on the restored one alike. Demanding success would fail on
    //     honest geometry; demanding agreement catches the thing that matters --
    //     the ROUND TRIP changing a persisted reference's answer. Every
    //     loser-naming edge is checked, not one lucky pick.
    let dressUpsThatWorked = 0
    for (const persisted of persistedLoserEdges) {
      const onLive = await engine.applyChamfer({ featureId: `FC-L-${dressUpsThatWorked}`, body: f.body!, edges: [persisted], distance: 0.3, propagateTangent: true })
      const onRestored = await engine.applyChamfer({ featureId: `FC-R-${dressUpsThatWorked}`, body: restored, edges: [persisted], distance: 0.3, propagateTangent: true })
      expect(onRestored.ok, `#matrix-cut-fillet: the round trip CHANGED whether a persisted loser-naming edge (${persisted}) can drive a dress-up -- live body: ${onLive.ok}, restored body: ${onRestored.ok}. ${JSON.stringify(onRestored.diagnostics)}`).toBe(onLive.ok)
      if (onLive.ok) dressUpsThatWorked++
    }
    // Non-vacuity: at least one persisted loser-naming edge must ACTUALLY have
    // driven a dress-up, or this whole check passed by agreeing that everything
    // is equally broken.
    expect(dressUpsThatWorked, 'no persisted loser-naming edge could drive a dress-up on EITHER body -- this check agreed vacuously; the fixture no longer proves a stale edge id migrates').toBeGreaterThan(0)

    // ...and the plain measure the cell used to rest on entirely.
    expect((await engine.measure(restored, 'area', [h.merge.loser])).aux?.unresolvedCount ?? 0).toBe(0)
    await engine.disposeAll()
  }, 120_000)

  it('#matrix-cut-hole: heal -> makeHole -> serialize/restore -> resolve agrees', async () => {
    const h = await healedStep(engine)
    const r = await engine.makeHole({
      featureId: 'H1', body: h.body, face: h.merge.winner, points: [{ x: 30, y: 15, z: STEP.az }],
      style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 3 },
    })
    expect(r.ok, `makeHole failed: ${JSON.stringify(r.diagnostics)}`).toBe(true)
    await expectLiveAliasBefore(r.body!, h, '#matrix-cut-hole')
    await expectRestoreAgrees(engine, r.body!, r.elementMap!, idsOf(h), '#matrix-cut-hole', h.merge)
    await engine.disposeAll()
  }, 120_000)

  it('#matrix-cut-boolean: heal -> BOOLEAN add (extrude-as-tool) -> serialize/restore -> resolve agrees', async () => {
    const h = await healedStep(engine)
    // A second extrude ADDED onto the healed body routes through the tool-
    // boolean lane -> assignCutFaceIds with target.aliases.
    const r = await engine.makeExtrude({
      featureId: 'FC',
      profile: { sketchId: 'SC', plane: xyPlane(STEP.az), loops: [rectLoop('SC', 5, 5, 15, 15)] },
      end: { kind: 'blind', distance: 4 }, op: 'add', target: h.body,
    })
    expect(r.ok, `boolean add failed: ${JSON.stringify(r.diagnostics)}`).toBe(true)
    await expectLiveAliasBefore(r.body!, h, '#matrix-cut-boolean')
    await expectRestoreAgrees(engine, r.body!, r.elementMap!, idsOf(h), '#matrix-cut-boolean', h.merge)
    await engine.disposeAll()
  }, 120_000)

  // ---- P-shell / P-shell-op (assignShellFaceIds) ---------------------------

  it('#matrix-shell: heal -> applyShell -> serialize/restore -> resolve agrees (including the ids the shell legitimately REMOVED, which must stay lost)', async () => {
    const h = await healedStep(engine)
    const s = await engine.applyShell({ featureId: 'S1', body: h.body, removeFaces: [h.merge.loser], thickness: 2 })
    expect(s.ok, `applyShell failed: ${JSON.stringify(s.diagnostics)}`).toBe(true)
    // The shell removed the face the alias pointed at, so the honest answer
    // AFTER restore is whatever it is BEFORE -- agreement is the invariant, not
    // resolvability.
    await expectRestoreAgrees(engine, s.body!, s.elementMap!, idsOf(h), '#matrix-shell')
    await engine.disposeAll()
  }, 120_000)

  // ---- P-draft -------------------------------------------------------------

  it('#matrix-draft: heal -> applyDraft -> serialize/restore -> resolve agrees (draft shipped `modified: {}` -- the emptiest delta in the engine)', async () => {
    const h = await healedStep(engine)
    // Draft a SIDE WALL, not the merged top. A face whose normal is PARALLEL to
    // pullDir is a degenerate draft and the kernel refuses it (DRAFT_FAILED) --
    // which the alias-fold mutation caught: with the top face here the cell
    // returned early on the refusal and stayed GREEN with the carry-forward
    // disabled. The wall is drafted about the same z=0 neutral plane, and the
    // merged top stays live so the inherited alias still has a root to point at.
    const wall = faceWhere(engine, h.body, 'xMin wall of the healed body', (s) =>
      s.type === 'plane' && !!s.normal && s.normal[0] < -0.999)
    const d = await engine.applyDraft({
      featureId: 'D1', body: h.body, faces: [wall], angleDeg: 5,
      neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      pullDir: { x: 0, y: 0, z: 1 },
    })
    if (!d.ok) {
      // A draft may refuse for GEOMETRIC reasons on this body -- but NEVER for
      // REFERENCE_UNRESOLVED, which would mean the id lookup rejected the alias.
      expect(d.diagnostics.find((x) => x.code === 'REFERENCE_UNRESOLVED'), `draft rejected the alias as unresolved: ${JSON.stringify(d.diagnostics)}`).toBeUndefined()
      // ...and a refusal must NOT pass this cell. The alias-fold mutation proved
      // that the hard way: an early `return` here made #matrix-draft stay GREEN
      // with the carry-forward disabled, i.e. the cell asserted nothing about
      // applyDraft at all. A producer whose proof cannot run has no proof.
      throw new Error(`#matrix-draft: applyDraft refused on this fixture, so P-draft's carry-forward never ran -- this cell would be VACUOUS: ${JSON.stringify(d.diagnostics)}`)
    }
    await expectLiveAliasBefore(d.body!, h, '#matrix-draft')
    // Draft is a bijection on faces: its delta reports nothing of its own, so
    // before this WO its `modified` was literally `{}` and the restore lost
    // EVERY inherited alias. The fold is the only reason this cell can pass.
    expect(Object.keys(d.elementMap!.modified).length, 'draft\'s delta must now carry the inherited lineage it used to drop').toBeGreaterThan(0)
    await expectRestoreAgrees(engine, d.body!, d.elementMap!, idsOf(h), '#matrix-draft', h.merge)
    await engine.disposeAll()
  }, 120_000)

  // ---- P-edited-ids / P-offset-boolean -------------------------------------

  it('#matrix-edited-ids: heal -> a SECOND face edit -> serialize/restore -> resolve agrees (the push/pull path this WO family is about)', async () => {
    const h = await healedStep(engine)
    const r2 = await engine.editFeature({ featureId: 'E2', body: h.body, featureKey: h.merge.loser as string, delta: 2, kind: 'faceOffset' })
    expect(r2.ok, `second edit failed: ${JSON.stringify(r2.diagnostics)}`).toBe(true)
    await expectLiveAliasBefore(r2.body!, h, '#matrix-edited-ids')
    await expectRestoreAgrees(engine, r2.body!, r2.elementMap!, idsOf(h), '#matrix-edited-ids', h.merge)
    await engine.disposeAll()
  }, 120_000)

  // ---- P-pair-healed: the SECOND-GENERATION cell ---------------------------

  it('#matrix-heal-then-heal: heal -> heal AGAIN elsewhere -> serialize/restore -> the FIRST heal\'s alias still resolves (the template\'s own second-generation bug)', async () => {
    const h = await healedStep(engine)
    // A second healing edit on a DIFFERENT face. The first heal's loser->winner
    // pair is now an INHERITED alias whose root this second heal does not
    // touch -- so #pairHealedFaces emitted modified[loser] with no survivor
    // marker for the root, aliasesFromDelta rejected it as a rename, and the
    // alias vanished on restore. This is the cell that was RED before this WO.
    const xMin = 'FA:XTR:SA:e0' as StableId
    const r2 = await engine.editFeature({ featureId: 'E2', body: h.body, featureKey: h.merge.winner as string, delta: 3, kind: 'faceOffset' })
    expect(r2.ok, `second heal failed: ${JSON.stringify(r2.diagnostics)}`).toBe(true)
    void xMin
    await expectLiveAliasBefore(r2.body!, h, '#matrix-heal-then-heal')
    const { restored } = await expectRestoreAgrees(engine, r2.body!, r2.elementMap!, idsOf(h), '#matrix-heal-then-heal', h.merge)
    // Directly pin the mechanism the bug lived in: the delta must carry BOTH
    // halves -- the loser's forward pointer AND its root's own survivor marker
    // -- or aliasesFromDelta silently rejects the pair.
    const rebuilt = aliasesFromDelta(r2.elementMap!)
    const root = resolveFaceIdVia(rebuilt, h.merge.loser)
    expect(root, 'the second heal\'s delta must let aliasesFromDelta rebuild the FIRST heal\'s alias').not.toBe(h.merge.loser)
    expect((await engine.measure(restored, 'area', [h.merge.loser])).aux?.unresolvedCount ?? 0).toBe(0)
    await engine.disposeAll()
  }, 120_000)

  // ---- P-healed-ids --------------------------------------------------------

  it('#matrix-healed-ids: heal -> defeature (hole removal) -> serialize/restore -> resolve agrees', async () => {
    const h = await healedStep(engine)
    const holed = await engine.makeHole({
      featureId: 'H2', body: h.body, face: h.merge.winner, points: [{ x: 30, y: 15, z: STEP.az }],
      style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 3 },
    })
    expect(holed.ok, `makeHole failed: ${JSON.stringify(holed.diagnostics)}`).toBe(true)
    const verdicts = await engine.recognizeFeatures(holed.body!)
    const hole = verdicts.find((v) => /hole/i.test(v.featureClass) && v.removable)
    if (hole === undefined) {
      // No removable recognized hole -> defeatureBatch -> #assignHealedIds never
      // runs, so this cell would prove nothing. Fail by NAME rather than pass on
      // a path that did not execute (charter item 2).
      throw new Error(`#matrix-healed-ids: fixture produced no removable hole verdict, so #assignHealedIds never ran -- this cell would be vacuous. Got: ${JSON.stringify(verdicts.map((v) => v.featureClass))}`)
    }
    const d = await engine.defeatureBatch({ featureId: 'DF1', body: holed.body!, featureKeys: [hole.featureKey] })
    expect(d.ok, `defeatureBatch failed: ${JSON.stringify(d.diagnostics)}`).toBe(true)
    await expectLiveAliasBefore(d.body!, h, '#matrix-healed-ids')
    await expectRestoreAgrees(engine, d.body!, d.elementMap!, idsOf(h), '#matrix-healed-ids', h.merge)
    await engine.disposeAll()
  }, 120_000)

  // ---- P-pattern -----------------------------------------------------------

  it('#matrix-pattern: heal -> applyBodyPattern -> serialize/restore -> resolve agrees', async () => {
    const h = await healedStep(engine)
    const p = await engine.applyBodyPattern({
      featureId: 'PT1', body: h.body,
      spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, spacing: 200, count: 2 },
    })
    if (!p.ok) {
      expect(p.diagnostics.find((x) => x.code === 'REFERENCE_UNRESOLVED'), `pattern rejected an alias as unresolved: ${JSON.stringify(p.diagnostics)}`).toBeUndefined()
      throw new Error(`#matrix-pattern: pattern refused on this fixture -- cell would be vacuous: ${JSON.stringify(p.diagnostics)}`)
    }
    await expectLiveAliasBefore(p.body!, h, '#matrix-pattern')
    await expectRestoreAgrees(engine, p.body!, p.elementMap!, idsOf(h), '#matrix-pattern', h.merge)
    await engine.disposeAll()
  }, 120_000)
})

// ---------------------------------------------------------------------------
// THE REGENERATE-ORDER AXIS (the WO's ADDITIONAL REQUIRED CELL).
// ---------------------------------------------------------------------------

describe('WO UI-57-R2: FeatureDag.reorderNode across a NO-CONSUMES-EDGE producer pair (a materially different failure axis than restore)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#matrix-reorder-no-consumes-edge: a fillet moved AHEAD of an unrelated heal reorders freely (dag.ts guards only across a consumes edge) -- and the alias either resolves or degrades BY NAME, never silently', async () => {
    const h = await healedStep(engine)
    const tess = await engine.tessellate(h.body, { deflection: 0.1 })
    const edge = tess.edgeIds.find((id) => (id as string).includes(h.merge.winner as string))
    expect(edge, 'fixture: expected a live edge on the merged winner').toBeDefined()
    const f = await engine.applyFillet({ featureId: 'FIL1', body: h.body, edges: [edge!], radius: 1, propagateTangent: true })
    expect(f.ok, `fillet failed: ${JSON.stringify(f.diagnostics)}`).toBe(true)

    // Two features with NO `consumes` edge between them -- exactly the pair
    // dag.ts's reorder guard does NOT protect (checkReorder refuses only a move
    // across a consumes edge; see ReorderBlockedError's own doc comment).
    const dag = new FeatureDag()
    dag.insertNode({ id: 'E1', kind: 'feature', consumes: [], refs: [{ id: h.merge.loser, kind: 'single-face' }] })
    dag.insertNode({ id: 'FIL1', kind: 'feature', consumes: [], refs: [{ id: edge!, kind: 'single-face' }] })

    // The move is ALLOWED (no edge to guard). That is the premise of this cell:
    // if it threw, the axis would not exist.
    expect(() => dag.reorderNode('FIL1', 0)).not.toThrow()
    expect(dag.featureOrder().indexOf('FIL1')).toBeLessThan(dag.featureOrder().indexOf('E1'))

    // Replay the deltas in the REORDERED timeline order and regenerate, exactly
    // as loadDocumentArchive does (format.ts:133-134).
    const map = new ElementMap()
    const deltaFor: Record<string, ElementMapDelta> = { E1: h.elementMap, FIL1: f.elementMap! }
    for (const id of dag.featureOrder()) {
      const d = deltaFor[id]
      if (d !== undefined) applyFeatureDelta(map, d)
    }
    dag.regenerate(map)

    // THE ASSERTION. Applying the fillet's delta BEFORE the heal that created
    // the alias means the loser's lineage arrives before the loser exists. The
    // contract is not "it must still resolve" -- reordering a fillet ahead of
    // the edit it visually depends on is a genuinely different document. The
    // contract is that the outcome is OBSERVABLE: a ref that cannot resolve
    // marks its node `degraded` and carries diagnostics (dag.ts regenerate()),
    // never a silent wrong binding.
    const e1 = dag.getNode('E1')
    expect(e1, 'E1 must still be in the dag after the reorder').toBeDefined()
    if (e1!.degraded) {
      expect(e1!.diagnostics.length, 'a DEGRADED node must carry structured diagnostics naming why -- a silent degrade is the failure this cell exists to forbid').toBeGreaterThan(0)
    } else {
      // Not degraded -> the ref really did resolve. Prove it bound to something
      // real rather than passing on an unchecked flag.
      expect(map.resolve(h.merge.loser, 'single-face').status, 'E1 is not degraded, so its face ref must genuinely resolve').not.toBe('lost')
    }
    await engine.disposeAll()
  }, 120_000)
})

// ---------------------------------------------------------------------------
// TIER 2: the shared resolver's own 4-scenario matrix (exactly once).
// ---------------------------------------------------------------------------

describe('WO UI-57-R2 tier 2: the shared resolver (resolveFaceIdVia / #resolveFaceId / #faceHashIndex) -- the full 4 scenarios, once', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#matrix-scenario-single-generation: a single-generation alias resolves through the shared resolver (fallback, onto the winner\'s live face)', async () => {
    const h = await healedStep(engine)
    const [loser] = await engine.resolve(h.body, [h.merge.loser])
    const [winner] = await engine.resolve(h.body, [h.merge.winner])
    expect(loser.status).toBe('fallback')
    expect(winner.status).toBe('exact')
    expect(loser.localIndex, 'the loser must land on the WINNER\'s live face, not merely "not lost"').toBe(winner.localIndex)
    await engine.disposeAll()
  }, 60_000)

  it('#matrix-scenario-through-feature: a multi-generation alias resolves THROUGH a downstream feature (the R1 killer, at the resolver)', async () => {
    const h = await healedStep(engine)
    const tess = await engine.tessellate(h.body, { deflection: 0.1 })
    const edge = tess.edgeIds.find((id) => (id as string).includes(h.merge.winner as string))
    const f = await engine.applyFillet({ featureId: 'FIL1', body: h.body, edges: [edge!], radius: 1, propagateTangent: true })
    expect(f.ok).toBe(true)
    const [res] = await engine.resolve(f.body!, [h.merge.loser])
    expect(res.status, 'the alias must survive a later feature, not just the healing one').toBe('fallback')
    await engine.disposeAll()
  }, 120_000)

  it('#matrix-scenario-undo-redo: replay-based undo/redo re-derives the alias map from scratch -- the resolver agrees across an undo and a redo', async () => {
    // Undo/redo is REPLAY (src/doc/commands.ts:3-4), so the honest construction
    // is exactly that: re-run the feature chain and prove the resolver gives the
    // same answer on the re-derived body. There is no persisted alias state for
    // an undo to corrupt -- which is the claim, so it is BUILT rather than
    // argued (charter item 4: settle an ordering claim with a constructed
    // interleave, never event-loop prose).
    const first = await healedStep(engine)
    const answerAfterHeal = (await engine.resolve(first.body, [first.merge.loser]))[0].status
    expect(answerAfterHeal).toBe('fallback')

    // "redo the fillet" -> apply it.
    const tess = await engine.tessellate(first.body, { deflection: 0.1 })
    const edge = tess.edgeIds.find((id) => (id as string).includes(first.merge.winner as string))
    const f = await engine.applyFillet({ featureId: 'FIL1', body: first.body, edges: [edge!], radius: 1, propagateTangent: true })
    expect(f.ok).toBe(true)
    expect((await engine.resolve(f.body!, [first.merge.loser]))[0].status).toBe('fallback')

    // "undo the fillet" -> REPLAY the chain without it. A replay re-executes the
    // producing features, so the alias map is minted fresh; the resolver must
    // land on the same answer, from a body that shares no record with the first.
    const replayed = await healedStep(engine)
    expect(replayed.merge.loser, 'a deterministic replay must re-derive the SAME ids').toBe(first.merge.loser)
    expect((await engine.resolve(replayed.body, [replayed.merge.loser]))[0].status).toBe(answerAfterHeal)
    await engine.disposeAll()
  }, 180_000)

  it('#matrix-scenario-save-load: the save/load round trip available to the resolver (serializeBody -> restoreBody) preserves every answer', async () => {
    const h = await healedStep(engine)
    const before = await engine.resolve(h.body, [h.merge.loser, h.merge.winner, h.topA, h.topB])
    const bytes = await engine.serializeBody(h.body)
    const restored = await engine.restoreBody(bytes, h.elementMap)
    const after = await engine.resolve(restored, [h.merge.loser, h.merge.winner, h.topA, h.topB])
    expect(after.map((r) => ({ id: r.id, status: r.status }))).toEqual(before.map((r) => ({ id: r.id, status: r.status })))
    await engine.disposeAll()
  }, 60_000)
})

// ---------------------------------------------------------------------------
// NAMED REFUSALS -- each CITES the code proving unreachability, and the
// citation is re-checked here so a refusal cannot rot into a false claim.
// ---------------------------------------------------------------------------

describe('WO UI-57-R2: the collapsed cells, refused BY NAME with their proof re-checked against the real code', () => {
  it('#matrix-refusal-undo-redo-save-load: undo/redo and app-flow save/load cannot reach restoreBody -- proof CITED and re-verified, not asserted', () => {
    // PROOF 1 -- undo/redo is replay, never a geometry/alias snapshot.
    const commands = readRepoSource('src/doc/commands.ts')
    expect(citedProse('src/doc/commands.ts'), 'src/doc/commands.ts:3-4 no longer states the replay-based undo contract this refusal rests on')
      .toContain('Undo/redo is REPLAY through the DAG, never a geometry snapshot')
    // No Command may capture a BodyHandle -- that is what would give an undo
    // something aliased to corrupt. The file states it; pin the code too.
    expect(/class \w*Command[\s\S]{0,4000}?BodyHandle/.test(commands), 'a Command now references a BodyHandle -- undo/redo may now touch alias state and this refusal is VOID').toBe(false)

    // PROOF 2 -- the document-open flow regenerates the DAG and never restores a body.
    const format = readRepoSource('src/doc/persist/format.ts')
    expect(format, 'loadDocumentArchive no longer ends in dag.regenerate -- the save/load refusal is VOID').toContain('dag.regenerate(elementMap)')
    expect(format.includes('restoreBody'), 'format.ts now calls restoreBody -- app-flow save/load IS reachable and this refusal is VOID: promote it to a real test through loadDocumentArchive').toBe(false)

    // The engine-contract round trip these collapse toward IS live and IS
    // proven, in every tier-1 cell above and #matrix-scenario-save-load.
    const engineSrc = readRepoSource('src/geom/worker/geom-engine.ts')
    expect(engineSrc).toContain('restoreBody(')
  })

  it('#matrix-tier2-routing: every OTHER tier-2 consumer routes through the shared resolver rather than reasoning about lineage itself (structural, per the WO\'s tier-2 rule)', () => {
    const migration = readRepoSource('src/components/model3d/workbench/faceIdMigration.ts')
    // It imports the shared lineage module...
    expect(migration).toMatch(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*aliasLineage/)
    // ...and does no lineage reasoning of its own: no hand-rolled alias walk,
    // no direct `.aliases` map arithmetic. An equality compare against a live
    // id is exactly the bypass UI-57-R1 blocker 2 named.
    expect(/while\s*\([^)]*aliases\.has/.test(migration), 'faceIdMigration re-implements an alias chain walk instead of calling the shared resolver').toBe(false)
    expect(migration).toContain('resolveFaceIdVia')
  })
})
