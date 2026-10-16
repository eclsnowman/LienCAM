// WO UI-57-R5 -- TIER 1, OBSERVED AT THE DISPATCH CHOKE POINT (DECISIONS
// 2026-07-17, "UI-57 B1 recorder: observe at the DISPATCH CHOKE POINT";
// RUNTIME-GROUNDED CENSUS LAW ruling 1; WO amendments B1/B5).
//
// WHY THIS FILE EXISTS (R3). The R2 tier 1 was a static AST analysis, and the R2
// auditor walked through its blind spot in one move: appending
//
//     auditUnclassifiedDeltaProducer(): ElementMapDelta { return auditBuildDelta() }
//
// to geom-engine.ts left the census GREEN at 28/28, because the extractor only
// recognized delta shapes DECLARED IN THE SAME FILE. Membership here is decided
// by EXECUTION instead: the recipes drive the REAL GeomEngine on a REAL occt-wasm
// kernel, through its real public surface. The engine under census is UNMODIFIED
// production code; nothing is mocked, wrapped in a fake, or instrumented.
//
// WHY THE DOMAIN IS ROUTES (R4). The R3 census measured the METHOD NAME, and the
// R3 auditor proved that wrong: "In an isolated exact-HEAD archive I inserted a
// refusal in makeRevolve only for op:'add'. The unchanged verdict-bearing tier-1
// runtime census plus advisory census still passed 45/45 with tool-printed EXIT
// CODE: 0." `makeRevolve` is not one behaviour -- op:'newBody' mints from
// #assignSweptFaceIds and returns (geom-engine.ts:1449-1461) while every other op
// falls through to #applySweepBoolean -> #applyToolBoolean (:1466). So the domain
// is DERIVED DISPATCH ROUTES (aliasDispatchRoutes.ts): (method, one dispatch
// discriminant pinned to one declared literal), read from the engine's own
// branches plus the checker's declared unions. Nobody types the count.
//
// WHY THE RECORDER WAS REPLACED (R5) -- THE R4 BLOCKER, VERBATIM: "the recorder
// does not give every catalogued producer invocation its own coverage window or
// actual returned delta. Every synchronous engine method calls push(..., false),
// ignoring the computed profiled flag. ... its direct delta-shaped return is
// recorded as delta:null because push only reads result.elementMap. The route log
// then unions the misattributed counters and the global merged-count assertion
// stays green." Its evidence: a GREEN census printing `makeBox calls=4 ...
// producers=[#assignEditedIds debugAssignEditedIdsForTest makeBox]` -- an
// attribution makeBox cannot possibly have.
//
// THAT WAS NOT A BUG IN THE RECORDER; IT WAS THE RECORDER'S QUESTION. V8 precise
// coverage answers "what ran between two reads" -- about an INTERVAL. Pinning an
// interval to a call is an invariant every ordering change re-litigates, and
// three consecutive rounds lost that argument. So B1 is no longer per-producer
// observation at all:
//
//   ONE RECORDER, AT THE ONE SURFACE EVERY ROUTE FLOWS THROUGH (support/
//   engineCallRecorder.ts), pairing each route with the value THAT CALL RETURNED
//   -- synchronously for a sync method, inside that promise's own .then for an
//   async one. No profiler, no counters, no windows, no per-method
//   instrumentation. ATTRIBUTION IS TRUE BY CONSTRUCTION: THE ROUTE IS THE
//   DISPATCH KEY AND THE DELTA IS THE RETURN VALUE.
//
// And because "true by construction" is exactly what the last three canaries
// asserted without proving, the construction is PROVEN POSITIVELY here:
// #runtime-dispatch-delta-identity holds every delta to the featureId its own
// call was handed and to the ids its own call minted, and
// #runtime-dispatch-delta-canary commits the R4 finding's own case -- the sync
// hook's delta must be attributed ONLY to the sync hook and NEVER to makeBox.
//
// THE FAIL-CLOSED DIRECTIONS -- all verdict-bearing:
//   #runtime-every-route-driven          every derived producer route EXECUTED
//   #runtime-route-on-aliased-body       every producer route driven on a body
//                                        carrying inherited aliases, or holding a
//                                        committed genesis/refusal disposition
//   #runtime-every-route-has-its-own-delta  no route is certified over a null
//                                        delta (the R4 blocker, as a gate)
//   #runtime-dispatch-delta-identity     every delta is ITS OWN call's return
//   #runtime-dispatch-delta-canary       the R4 finding's own misattribution
//   #runtime-carry-forward-observed      every aliased call's OWN delta re-states
//                                        the inherited lineage
//   #runtime-worker-api-cross-check      every exposed Comlink method is in the
//                                        route domain or dispositioned (B1b)
//
// WHAT R5 DELETED, AND WHY THAT IS NOT A NARROWING. The V8 table-entry cells
// (#runtime-census-canary, #runtime-every-table-entry-driven) are gone: the
// directive forbids per-producer instrumentation "anywhere", and those two WERE
// it. What they measured -- "the catalogued producers really run" -- is now
// carried by the routes that reach them plus the delta-identity assertions, and
// the ALIAS_PRODUCER_CENSUS tables they keyed on remain live under the static
// tier 1 (aliasLifecycleCensus.test.ts). The recorder they depended on no longer
// exists to fall back to.
//
// SCOPE (amendment B5, and R5 amendment A4): "production entry points" means the
// GeomEngine class methods. The Comlink layer is a 1:1 transport wrapper the Node
// test path never imports (geom-worker.ts:14-16), so every api method reaches the
// engine through this same choke point; it participates as the B1(b) STATIC
// cross-check list. This file does not boot a real Web Worker.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { ElementMapDelta, StableId } from '../../geom/geom-service.ts'
import { aliasesFromDelta, resolveFaceIdVia } from '../../geom/aliasLineage.ts'
import {
  extractWorkerApiMethods, WORKER_API_FILE,
  NON_PRODUCER_API_DISPOSITIONS, GENESIS_ROUTE_DISPOSITIONS, REFUSED_ROUTE_DISPOSITIONS,
} from './aliasLifecycleCensus.ts'
import { createAliasProgram } from './aliasProgramDerivation.ts'
import { deriveDispatchRoutes, type DispatchRoute } from './aliasDispatchRoutes.ts'
import {
  recordEngineCalls, featureIdOf, type EngineCall, type RecordedDelta, type Recorder,
} from './support/engineCallRecorder.ts'
import { STEP, healedStep, faceWhere, type HealedStep } from './fixtures/healedStep.ts'
import { rectLoop, xyPlane, xzPlane } from './fixtures/profiles.ts'

const ENGINE_FILE = 'src/geom/worker/geom-engine.ts'
const ALIAS_MODULE = 'src/geom/aliasLineage.ts'

/**
 * THE DELTA-IDENTITY CANARY'S TWO SUBJECTS (R5 amendment A5), committed here so
 * the R4 finding's own case can never come back quietly.
 *
 * The finding: `makeBox calls=4 ... producers=[#assignEditedIds
 * debugAssignEditedIdsForTest makeBox]`. The sync hook's work was attributed to
 * makeBox because the sync branch never closed its own window, leaving the counts
 * pending until the next profiled call -- which, given the recipe order below, is
 * the `import` recipe's makeBox('RCEXP').
 *
 * So these two are pinned BY FEATURE ID: whatever the hook produces must be the
 * hook's, and makeBox's must be makeBox's. A recorder that reads a call's delta
 * from engine state, from the next call's value, or from a union of calls fails
 * #runtime-dispatch-delta-canary naming both routes.
 */
const CANARY_SYNC_HOOK = { method: 'debugAssignEditedIdsForTest', featureId: 'RCDBG' } as const
const CANARY_GENESIS = { method: 'makeBox', featureId: 'RCBOX' } as const

/** A recipe drives ROUTES. It does not declare which ones -- the recorder reads
 *  that off the requests the engine actually received. `covers` is documentation
 *  for the reader; the census never trusts it (see #runtime-every-route-driven,
 *  which is computed entirely from observations). */
interface Recipe {
  id: string
  what: string
  covers: string
  run: (r: Recorder) => Promise<void>
}

/** Fail loud, by name, the moment an op refuses: a recipe whose op did not run
 *  proves nothing about its producers, and a silently-skipped recipe is exactly
 *  the vacuity the charter's item 1 forbids. */
function mustOk<T extends { ok: boolean; diagnostics: unknown[] }>(r: T, what: string): T {
  if (!r.ok) throw new Error(`RECIPE ${what}: the op REFUSED, so its producers never ran and this recipe would be vacuous: ${JSON.stringify(r.diagnostics)}`)
  return r
}

const fixtureOf = (h: HealedStep, what: string) => ({ loser: h.merge.loser as string, winner: h.merge.winner as string, what })

// ---- TOOL GEOMETRY FOR THE BOOLEAN ROUTES ---------------------------------
//
// The healed fixture spans x 0..60, y 0..30, z 0..10, and its merged WINNER is
// the top face at z=10. Every tool below is chosen so the winner SURVIVES the
// boolean -- not for tidiness, but because the carry-forward question ("does
// this delta re-state the inherited alias?") is only askable while the alias's
// live root is still live. A tool that deleted the winner would make the route's
// own assertion vacuous, which is the defect class this file exists to refuse.

/** A profile that spans x0..x1 over the fixture's full y depth, at z=0. */
const spanRect = (id: string, x0: number, x1: number) =>
  ({ sketchId: id, plane: xyPlane(0), loops: [rectLoop(id, x0, -5, x1, STEP.y + 5)] })

/** A small profile clear of the merged top: a pocket/boss lane that never
 *  touches z=10. */
const smallRect = (id: string, x0: number, y0: number, x1: number, y1: number) =>
  ({ sketchId: id, plane: xyPlane(0), loops: [rectLoop(id, x0, y0, x1, y1)] })

/**
 * A rectangle in the xz plane, revolved about Z -> an ANNULUS (hollow cylinder).
 *
 * `r0` is deliberately > 0 on every caller: a profile touching the axis
 * degenerates when revolved 360deg (the axis edge collapses to a point) and the
 * kernel throws `projectPointOnFace: WebAssembly.Exception` out of the lineage
 * probe -- measured, not guessed, on the first run of these recipes. A refused
 * op drives no producer, so a degenerate tool would have made every revolve
 * route vacuous.
 */
const revolveRect = (id: string, r0: number, r1: number, z0: number, z1: number) =>
  ({ sketchId: id, plane: xzPlane(), loops: [rectLoop(id, r0, z0, r1, z1)] })

const zAxis = { origin: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 1 } }

/**
 * THE RECIPES. Each drives REAL production entry points on a REAL kernel; none
 * constructs a delta by hand. Coverage of the derived route domain is PROVEN by
 * #runtime-every-route-driven from the recorder's observations -- so a recipe
 * that quietly stops reaching its route makes the census RED rather than
 * silently narrowing it.
 */
const RECIPES: Recipe[] = [
  {
    id: 'heal',
    what: 'extrude -> add-extrude -> faceOffset that heals the seam (THE fixture every alias proof starts from)',
    covers: 'makeExtrude:op=newBody, makeExtrude:op=add, editFeature:kind=faceOffset + the six producers behind them',
    // One recipe, six producers: healedStep extrudes block A (genesis), ADDS
    // block B through the tool-boolean lane (-> assignCutFaceIds), then pulls
    // B's top flush, which heals the seam (#pairHealedFaces) through the face-
    // offset lane (#offsetFaceBoolean -> #assignEditedIds). Every one of those
    // calls is recorded with its OWN delta by the recorder.
    run: async (r) => { await healedStep(r.engine) },
  },
  {
    id: 'heal-then-heal',
    what: 'heal -> a SECOND faceOffset on the healed body (editFeature:kind=faceOffset driven on an ALIAS-CARRYING target)',
    covers: 'editFeature:kind=faceOffset on an aliased body',
    // The fixture's own faceOffset runs on a body with no inherited alias yet
    // (it is the call that CREATES the alias). This one runs the same route on
    // the healed result, which is where carry-forward is actually at stake.
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'second faceOffset on the healed body'), async () => {
        const wall = faceWhere(r.engine, h.body, 'xMax wall of the healed body', (s) =>
          s.type === 'plane' && !!s.normal && s.normal[0] > 0.999)
        mustOk(await r.engine.editFeature({ featureId: 'R4E2', body: h.body, featureKey: wall as string, delta: 2, kind: 'faceOffset' }), 'second faceOffset')
      })
    },
  },
  {
    id: 'pocket-depth',
    what: 'heal -> makeHole -> editFeature kind:pocketDepth (the THIRD editFeature dispatch -- driven by no round before R4)',
    covers: 'editFeature:kind=pocketDepth',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'pocketDepth on the healed body'), async () => {
        // #editPocketDepth REFUSES anything whose recognized type is not exactly
        // 'pocket' (geom-engine.ts:3958) -- a blind hole is a `blindHole` and is
        // turned away, which is how this recipe first failed. So cut a real
        // rectangular pocket into the merged top: profile at z=6, extruded up
        // through z=10, cut -> a 4 mm deep rectangular cavity in the winner face.
        // BLIND, not through: the profile sits at z=6 and the cut runs UP past
        // the top, so the cavity is z 6..10 and its floor at z=6 survives.
        // #editPocketDepth refuses a through pocket for want of a planar floor
        // ("could not isolate a planar floor face ... — refused in V1"), which is
        // how this recipe failed on its second run.
        const pocketed = mustOk(await r.engine.makeExtrude({
          featureId: 'R4PKX',
          profile: { sketchId: 'R4SPK', plane: xyPlane(STEP.bz), loops: [rectLoop('R4SPK', 10, 10, 20, 20)] },
          end: { kind: 'blind', distance: 6 }, op: 'cut', target: h.body,
        }), 'pocketDepth fixture cut')
        const verdicts = await r.engine.recognizeFeatures(pocketed.body!)
        const pocket = verdicts.find((v) => v.featureClass === 'pocket')
        if (pocket === undefined) {
          throw new Error(`RECIPE pocket-depth: no 'pocket' verdict, so #editPocketDepth would refuse and never run -- vacuous. Got: ${JSON.stringify(verdicts.map((v) => v.featureClass))}`)
        }
        mustOk(await r.engine.editFeature({ featureId: 'R4PKD', body: pocketed.body!, featureKey: pocket.featureKey, delta: 1, kind: 'pocketDepth' }), 'editFeature pocketDepth')
      })
    },
  },
  {
    id: 'fillet',
    what: 'heal -> applyFillet (THE feature in the R1 auditor\'s own blocker repro)',
    covers: 'applyFillet',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'fillet on the merged winner\'s edge'), async () => {
        const tess = await r.engine.tessellate(h.body, { deflection: 0.1 })
        const edge = tess.edgeIds.find((id) => (id as string).includes(h.merge.winner as string))
        if (edge === undefined) throw new Error('RECIPE fillet: no live edge on the merged winner -- fixture broke')
        mustOk(await r.engine.applyFillet({ featureId: 'RCFIL', body: h.body, edges: [edge], radius: 1, propagateTangent: true }), 'fillet')
      })
    },
  },
  {
    id: 'chamfer',
    what: 'heal -> applyChamfer (the second edge-dress-up dispatch)',
    covers: 'applyChamfer',
    // #applyEdgeDressUp is shared with fillet, but a lane reached only by fillet
    // would leave applyChamfer's own dispatch unproven -- and applyChamfer is on
    // the worker api surface (B1(b)).
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'chamfer on the merged winner\'s edge'), async () => {
        const tess = await r.engine.tessellate(h.body, { deflection: 0.1 })
        const edge = tess.edgeIds.find((id) => (id as string).includes(h.merge.winner as string))
        if (edge === undefined) throw new Error('RECIPE chamfer: no live edge on the merged winner -- fixture broke')
        mustOk(await r.engine.applyChamfer({ featureId: 'RCCHM', body: h.body, edges: [edge], distance: 0.5, propagateTangent: true }), 'chamfer')
      })
    },
  },
  {
    id: 'hole',
    what: 'heal -> makeHole',
    covers: 'makeHole',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'hole through the merged winner'), async () => {
        mustOk(await r.engine.makeHole({
          featureId: 'RCHOLE', body: h.body, face: h.merge.winner, points: [{ x: 30, y: 15, z: STEP.az }],
          style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 3 },
        }), 'makeHole')
      })
    },
  },
  {
    id: 'boolean-cut',
    what: 'heal -> applyBoolean op:cut (a tool body cut from the healed body)',
    covers: 'applyBoolean:op=cut',
    run: async (r) => {
      const h = await healedStep(r.engine)
      // The tool spans x/y 0..10, z 0..5 -- it overlaps block A WITHOUT reaching
      // the merged top at z=10, so the alias's live root stays live and the
      // carry-forward assertion has something to be about. It is minted OUTSIDE
      // withFixture: makeBox is a GENESIS route with no target, and marking it as
      // a call "on the aliased body" would demand it re-state a lineage it was
      // never handed. (The census caught exactly that on this recipe's first run.)
      const tool = mustOk(await r.engine.makeBox('RCTOOL', { x: 10, y: 10, z: 5 }), 'boolean tool box')
      await r.withFixture(fixtureOf(h, 'applyBoolean cut on the healed body'), async () => {
        mustOk(await r.engine.applyBoolean({ featureId: 'RCBOOL', op: 'cut', target: h.body, tools: [tool.body!] }), 'applyBoolean cut')
      })
    },
  },
  {
    id: 'boolean-fuse',
    what: 'heal -> applyBoolean op:fuse on the ALIASED body',
    covers: 'applyBoolean:op=fuse',
    run: async (r) => {
      const h = await healedStep(r.engine)
      // The tool overlaps block A and rises above it, producing a real union
      // while leaving part of the merged top face alive for alias carry-forward.
      const tool = mustOk(await r.engine.makeBox('RCFUST', { x: 10, y: 10, z: 15 }), 'boolean union tool box')
      await r.withFixture(fixtureOf(h, 'applyBoolean union on the healed body'), async () => {
        mustOk(await r.engine.applyBoolean({ featureId: 'RCFUSE', op: 'fuse', target: h.body, tools: [tool.body!] }), 'applyBoolean fuse')
      })
    },
  },
  {
    id: 'boolean-intersect',
    what: 'heal -> applyBoolean op:intersect on the ALIASED body',
    covers: 'applyBoolean:op=intersect',
    run: async (r) => {
      const h = await healedStep(r.engine)
      // Clip the healed body at x=40. The merged top survives as one retrimmed
      // face, so this proves both intersection lineage and inherited aliases.
      const tool = mustOk(await r.engine.makeBox('RCINTT', { x: 40, y: STEP.y, z: STEP.az }), 'boolean intersection tool box')
      await r.withFixture(fixtureOf(h, 'applyBoolean intersection on the healed body'), async () => {
        mustOk(await r.engine.applyBoolean({ featureId: 'RCINT', op: 'intersect', target: h.body, tools: [tool.body!] }), 'applyBoolean intersect')
      })
    },
  },
  {
    id: 'shell',
    what: 'heal -> applyShell',
    covers: 'applyShell',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'shell opened at the merged loser'), async () => {
        mustOk(await r.engine.applyShell({ featureId: 'RCSHL', body: h.body, removeFaces: [h.merge.loser], thickness: 2 }), 'applyShell')
      })
    },
  },
  {
    id: 'draft',
    what: 'heal -> applyDraft (the producer that shipped `modified: {}` -- the emptiest delta in the engine)',
    covers: 'applyDraft',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'draft on a side wall'), async () => {
        // A SIDE WALL, not the merged top: a face whose normal is parallel to
        // pullDir is a degenerate draft the kernel refuses (the matrix's own
        // #matrix-draft note records why this matters).
        const wall = faceWhere(r.engine, h.body, 'xMin wall of the healed body', (s) =>
          s.type === 'plane' && !!s.normal && s.normal[0] < -0.999)
        mustOk(await r.engine.applyDraft({
          featureId: 'RCDRF', body: h.body, faces: [wall], angleDeg: 5,
          neutralPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
          pullDir: { x: 0, y: 0, z: 1 },
        }), 'applyDraft')
      })
    },
  },
  {
    id: 'pattern',
    what: 'heal -> applyBodyPattern',
    covers: 'applyBodyPattern',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'linear body pattern of the healed body'), async () => {
        mustOk(await r.engine.applyBodyPattern({
          featureId: 'RCPAT', body: h.body, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, spacing: 200, count: 2 },
        }), 'applyBodyPattern')
      })
    },
  },
  {
    id: 'defeature',
    what: 'heal -> makeHole -> defeatureBatch (hole removal + heal)',
    covers: 'defeatureBatch',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'defeature of a hole in the healed body'), async () => {
        const holed = mustOk(await r.engine.makeHole({
          featureId: 'RCDFH', body: h.body, face: h.merge.winner, points: [{ x: 30, y: 15, z: STEP.az }],
          style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 3 },
        }), 'defeature fixture hole')
        const verdicts = await r.engine.recognizeFeatures(holed.body!)
        const hole = verdicts.find((v) => /hole/i.test(v.featureClass) && v.removable)
        if (hole === undefined) {
          throw new Error(`RECIPE defeature: no removable hole verdict, so #assignHealedIds never ran -- vacuous. Got: ${JSON.stringify(verdicts.map((v) => v.featureClass))}`)
        }
        mustOk(await r.engine.defeatureBatch({ featureId: 'RCDF', body: holed.body!, featureKeys: [hole.featureKey] }), 'defeatureBatch')
      })
    },
  },
  {
    id: 'hole-diameter',
    what: 'heal -> makeHole -> editFeature kind:holeDiameter',
    covers: 'editFeature:kind=holeDiameter',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'holeDiameter edit on the healed body'), async () => {
        const holed = mustOk(await r.engine.makeHole({
          featureId: 'RCHDH', body: h.body, face: h.merge.winner, points: [{ x: 30, y: 15, z: STEP.az }],
          style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 3 },
        }), 'holeDiameter fixture hole')
        const verdicts = await r.engine.recognizeFeatures(holed.body!)
        const hole = verdicts.find((v) => /hole/i.test(v.featureClass))
        if (hole === undefined) {
          throw new Error(`RECIPE hole-diameter: no hole verdict, so #recutHole never ran -- vacuous. Got: ${JSON.stringify(verdicts.map((v) => v.featureClass))}`)
        }
        mustOk(await r.engine.editFeature({ featureId: 'RCHD', body: holed.body!, featureKey: hole.featureKey, delta: 1, kind: 'holeDiameter' }), 'editFeature holeDiameter')
      })
    },
  },
  {
    id: 'hole-move',
    what: 'heal -> makeHole -> editFeature kind:holeMove',
    covers: 'editFeature:kind=holeMove',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'holeMove edit on the healed body'), async () => {
        const holed = mustOk(await r.engine.makeHole({
          featureId: 'RCMHH', body: h.body, face: h.merge.winner, points: [{ x: 30, y: 15, z: STEP.az }],
          style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 3 },
        }), 'holeMove fixture hole')
        const verdicts = await r.engine.recognizeFeatures(holed.body!)
        const hole = verdicts.find((v) => /hole/i.test(v.featureClass))
        if (hole === undefined) {
          throw new Error(`RECIPE hole-diameter: no hole verdict, so #recutHole never ran -- vacuous. Got: ${JSON.stringify(verdicts.map((v) => v.featureClass))}`)
        }
        mustOk(await r.engine.editFeature({ featureId: 'RCMHD', body: holed.body!, featureKey: hole.featureKey, delta: 0, kind: 'holeMove', translation: [5, 0, 0] }), 'editFeature holeMove')
      })
    },
  },
  {
    id: 'hole-depth',
    what: 'heal -> makeHole -> editFeature kind:holeDepth (WO-2091: same #recutHole core, new depth)',
    covers: 'editFeature:kind=holeDepth',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'holeDepth edit on the healed body'), async () => {
        const holed = mustOk(await r.engine.makeHole({
          featureId: 'RCHPH', body: h.body, face: h.merge.winner, points: [{ x: 30, y: 15, z: STEP.az }],
          style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 3 },
        }), 'holeDepth fixture hole')
        const verdicts = await r.engine.recognizeFeatures(holed.body!)
        const hole = verdicts.find((v) => /hole/i.test(v.featureClass))
        if (hole === undefined) {
          throw new Error(`RECIPE hole-depth: no hole verdict, so #recutHole never ran -- vacuous. Got: ${JSON.stringify(verdicts.map((v) => v.featureClass))}`)
        }
        mustOk(await r.engine.editFeature({ featureId: 'RCHP', body: holed.body!, featureKey: hole.featureKey, delta: 1, kind: 'holeDepth' }), 'editFeature holeDepth')
      })
    },
  },
  {
    id: 'relief',
    what: 'heal -> editFeature kind:relief (WO-2171) laid into the healed top face, keyed by the merged-away LOSER id',
    covers: 'editFeature:kind=relief',
    // A 4 x 4 pole grid, border ring 0 and the four inner poles raised 1 mm,
    // over x 20..40 y 10..20 on the healed top (z=10, x 0..60) -- across the
    // old seam, so the rectangle only lies on ONE face because the heal merged
    // it. Keyed by the loser so the face resolves through rec.aliases.
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'relief on the healed body'), async () => {
        const n = 4
        const heights = Array.from({ length: n * n }, (_, i) => {
          const ix = i % n, iy = Math.floor(i / n)
          return ix > 0 && ix < n - 1 && iy > 0 && iy < n - 1 ? 1 : 0
        })
        mustOk(await r.engine.editFeature({
          featureId: 'RCRL', body: h.body, featureKey: h.merge.loser, delta: 0, kind: 'relief',
          relief: {
            origin: { x: 20, y: 10, z: STEP.az }, xDir: { x: 1, y: 0, z: 0 }, yDir: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
            widthMm: 20, heightMm: 10, n, heights,
          },
        }), 'editFeature relief')
      })
    },
  },

  // ---- THE TOOL-BOOLEAN ROUTES: the R3 audit's blocker, route by route ------
  //
  // "makeRevolve and makeSweep are exercised only with op:'newBody' ... while
  // their separate add branches reach #applyToolBoolean at geom-engine.ts:1466
  // and :1799." Each of the four swept-tool methods has FOUR op routes; the
  // genesis one returns early, and the other three go through the boolean lane
  // with the target's inherited aliases. All twelve are driven below, every
  // non-genesis one on the healed fixture.
  {
    id: 'extrude-add',
    what: 'heal -> makeExtrude op:add on the ALIASED body (the add branch, geom-engine.ts:1383)',
    covers: 'makeExtrude:op=add',
    // R5 mutation target `r5-extrude-add-delta-swallow` swallows THIS call's
    // inherited pairs at the choke point's own subject -- the returned delta --
    // and #runtime-carry-forward-observed names this route RED.
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'add-extrude onto the healed body'), async () => {
        mustOk(await r.engine.makeExtrude({
          featureId: 'R4EXA', profile: smallRect('R4SXA', 5, 5, 15, 15), end: { kind: 'blind', distance: 14 },
          op: 'add', target: h.body,
        }), 'makeExtrude op:add')
      })
    },
  },
  {
    id: 'extrude-cut',
    what: 'heal -> makeExtrude op:cut on the ALIASED body',
    covers: 'makeExtrude:op=cut',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'cut-extrude into the healed body'), async () => {
        mustOk(await r.engine.makeExtrude({
          featureId: 'R4EXC', profile: smallRect('R4SXC', 5, 5, 15, 15), end: { kind: 'blind', distance: 4 },
          op: 'cut', target: h.body,
        }), 'makeExtrude op:cut')
      })
    },
  },
  {
    id: 'extrude-intersect',
    what: 'heal -> makeExtrude op:intersect on the ALIASED body',
    covers: 'makeExtrude:op=intersect',
    // The tool spans the fixture's full height (z -5..20) so the merged winner
    // at z=10 survives the intersection, trimmed rather than deleted.
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'intersect-extrude against the healed body'), async () => {
        mustOk(await r.engine.makeExtrude({
          featureId: 'R4EXI', profile: spanRect('R4SXI', -5, 40), end: { kind: 'blind', distance: 20 },
          op: 'intersect', target: h.body,
        }), 'makeExtrude op:intersect')
      })
    },
  },
  {
    id: 'revolve-newbody',
    what: 'makeRevolve op:newBody (genesis)',
    covers: 'makeRevolve:op=newBody',
    run: async (r) => {
      mustOk(await r.engine.makeRevolve({
        featureId: 'RCREV',
        profile: { sketchId: 'RCSR', plane: xzPlane(), loops: [[{ kind: 'arc', c: [20, 0], r: 5, a0: 0, a1: Math.PI * 2, ccw: true, srcId: 'RCSR.c0' }]] },
        axis: zAxis, angleDeg: 360, op: 'newBody',
      }), 'makeRevolve op:newBody')
    },
  },
  {
    id: 'revolve-add',
    what: 'heal -> makeRevolve op:add on the ALIASED body -- THE ROUTE THE R3 AUDIT PROVED UNDRIVEN (geom-engine.ts:1466)',
    covers: 'makeRevolve:op=add',
    // The auditor's mutation lives exactly here: a refusal inserted in
    // makeRevolve for op:'add' only. tools/mutation/ui57-heal-mutation.mjs target
    // `r4-revolve-add-refusal` re-applies it every mutation run, and this recipe
    // is what turns the gate RED by route name when it lands.
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'revolved boss fused onto the healed body'), async () => {
        // The ring is fused BELOW the body (z -6..2), so it adds real material
        // outside the block while leaving the merged top at z=10 untouched. A
        // ring that rose THROUGH the top would ring-fence the r<4 corner and
        // SPLIT the winner face in two -- the winner id then stops being live,
        // the fold legitimately drops the alias, and the route's carry-forward
        // assertion would be measuring the fixture instead of the engine. (That
        // is what the first draft of this recipe did; the census caught it.)
        mustOk(await r.engine.makeRevolve({
          featureId: 'R4RVA', profile: revolveRect('R4SRA', 4, 9, -6, 2), axis: zAxis, angleDeg: 360,
          op: 'add', target: h.body,
        }), 'makeRevolve op:add')
      })
    },
  },
  {
    id: 'revolve-cut',
    what: 'heal -> makeRevolve op:cut on the ALIASED body (geom-engine.ts:1466, the cut arm)',
    covers: 'makeRevolve:op=cut',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'revolved pocket cut into the healed body'), async () => {
        mustOk(await r.engine.makeRevolve({
          featureId: 'R4RVC', profile: revolveRect('R4SRC', 4, 9, 0, 4), axis: zAxis, angleDeg: 360,
          op: 'cut', target: h.body,
        }), 'makeRevolve op:cut')
      })
    },
  },
  {
    id: 'revolve-intersect',
    what: 'heal -> makeRevolve op:intersect on the ALIASED body (geom-engine.ts:1466, the intersect arm)',
    covers: 'makeRevolve:op=intersect',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'revolved cylinder intersected with the healed body'), async () => {
        mustOk(await r.engine.makeRevolve({
          featureId: 'R4RVI', profile: revolveRect('R4SRI', 4, 40, -5, 15), axis: zAxis, angleDeg: 360,
          op: 'intersect', target: h.body,
        }), 'makeRevolve op:intersect')
      })
    },
  },
  {
    id: 'sweep-newbody',
    what: 'makeSweep op:newBody orientation:fixed (genesis)',
    covers: 'makeSweep:op=newBody, makeSweep:orientation=fixed',
    run: async (r) => {
      mustOk(await r.engine.makeSweep({
        featureId: 'RCSWP',
        profile: { sketchId: 'RCSW', plane: xyPlane(0), loops: [rectLoop('RCSW', 0, 0, 10, 10)] },
        path: { sketchId: 'RCSP', plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }, segments: [{ kind: 'line', a: [0, 0], b: [0, 30], srcId: 'RCSP.p0' }] },
        orientation: 'fixed', op: 'newBody',
      }), 'makeSweep op:newBody')
    },
  },
  {
    id: 'sweep-add-frenet',
    what: 'heal -> makeSweep op:add orientation:frenet on the ALIASED body (geom-engine.ts:1799 -- and the OTHER orientation route, which no round before R4 drove)',
    covers: 'makeSweep:op=add, makeSweep:orientation=frenet',
    // Two routes, one call: the recorder reads BOTH discriminants off the same
    // request, so `orientation=frenet` is covered by the request that carries it
    // rather than by a recipe asserting it did.
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'swept boss fused onto the healed body'), async () => {
        mustOk(await r.engine.makeSweep({
          featureId: 'R4SWA',
          profile: { sketchId: 'R4SWP', plane: xyPlane(0), loops: [rectLoop('R4SWP', 2, 2, 8, 8)] },
          path: { sketchId: 'R4SWH', plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }, segments: [{ kind: 'line', a: [0, 0], b: [0, 16], srcId: 'R4SWH.p0' }] },
          orientation: 'frenet', op: 'add', target: h.body,
        }), 'makeSweep op:add orientation:frenet')
      })
    },
  },
  {
    id: 'sweep-cut',
    what: 'heal -> makeSweep op:cut on the ALIASED body',
    covers: 'makeSweep:op=cut',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'swept slot cut into the healed body'), async () => {
        mustOk(await r.engine.makeSweep({
          featureId: 'R4SWC',
          profile: { sketchId: 'R4SCP', plane: xyPlane(0), loops: [rectLoop('R4SCP', 2, 2, 8, 8)] },
          path: { sketchId: 'R4SCH', plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }, segments: [{ kind: 'line', a: [0, 0], b: [0, 5], srcId: 'R4SCH.p0' }] },
          orientation: 'fixed', op: 'cut', target: h.body,
        }), 'makeSweep op:cut')
      })
    },
  },
  {
    id: 'sweep-intersect',
    what: 'heal -> makeSweep op:intersect on the ALIASED body',
    covers: 'makeSweep:op=intersect',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'swept prism intersected with the healed body'), async () => {
        mustOk(await r.engine.makeSweep({
          featureId: 'R4SWI',
          profile: { sketchId: 'R4SIP', plane: xyPlane(-5), loops: [rectLoop('R4SIP', -5, -5, 40, 20)] },
          path: { sketchId: 'R4SIH', plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }, segments: [{ kind: 'line', a: [0, 0], b: [0, 20], srcId: 'R4SIH.p0' }] },
          orientation: 'fixed', op: 'intersect', target: h.body,
        }), 'makeSweep op:intersect')
      })
    },
  },
  {
    id: 'loft-newbody',
    what: 'makeLoft op:newBody (genesis)',
    covers: 'makeLoft:op=newBody',
    run: async (r) => {
      const section = (id: string, w: number, z: number) => ({
        sketchId: id, plane: xyPlane(z), loops: [rectLoop(id, -w / 2, -w / 2, w / 2, w / 2)],
      })
      mustOk(await r.engine.makeLoft({
        featureId: 'RCLFT', sections: [section('RCL1', 20, 0), section('RCL2', 10, 12)], ruled: true, op: 'newBody',
      }), 'makeLoft op:newBody')
    },
  },
  {
    id: 'loft-add',
    what: 'heal -> makeLoft op:add on the ALIASED body (geom-engine.ts:1968 -- the fourth #applyToolBoolean route)',
    covers: 'makeLoft:op=add',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'lofted boss fused onto the healed body'), async () => {
        const section = (id: string, w: number, z: number) => ({
          sketchId: id, plane: xyPlane(z), loops: [rectLoop(id, 10 - w / 2, 15 - w / 2, 10 + w / 2, 15 + w / 2)],
        })
        mustOk(await r.engine.makeLoft({
          featureId: 'R4LFA', sections: [section('R4LA1', 12, 5), section('R4LA2', 6, 16)], ruled: true,
          op: 'add', target: h.body,
        }), 'makeLoft op:add')
      })
    },
  },
  {
    id: 'loft-cut',
    what: 'heal -> makeLoft op:cut on the ALIASED body',
    covers: 'makeLoft:op=cut',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'lofted pocket cut into the healed body'), async () => {
        const section = (id: string, w: number, z: number) => ({
          sketchId: id, plane: xyPlane(z), loops: [rectLoop(id, 10 - w / 2, 15 - w / 2, 10 + w / 2, 15 + w / 2)],
        })
        mustOk(await r.engine.makeLoft({
          featureId: 'R4LFC', sections: [section('R4LC1', 12, 0), section('R4LC2', 6, 5)], ruled: true,
          op: 'cut', target: h.body,
        }), 'makeLoft op:cut')
      })
    },
  },
  {
    id: 'loft-intersect',
    what: 'heal -> makeLoft op:intersect on the ALIASED body',
    covers: 'makeLoft:op=intersect',
    run: async (r) => {
      const h = await healedStep(r.engine)
      await r.withFixture(fixtureOf(h, 'lofted prism intersected with the healed body'), async () => {
        const section = (id: string, w: number, z: number) => ({
          sketchId: id, plane: xyPlane(z), loops: [rectLoop(id, -5, -5, w, 35)],
        })
        mustOk(await r.engine.makeLoft({
          featureId: 'R4LFI', sections: [section('R4LI1', 40, -5), section('R4LI2', 40, 20)], ruled: true,
          op: 'intersect', target: h.body,
        }), 'makeLoft op:intersect')
      })
    },
  },

  // ---- THE DELTA-IDENTITY CANARY AND ITS NEIGHBOURS -------------------------
  // makeBox is a derived route; the debug hooks are not (they are not on the
  // Comlink surface), and they are driven anyway: the sync hook is THE R4
  // finding's subject, and the primitive hooks each mint a delta under their own
  // featureId, which is what #runtime-dispatch-delta-identity is about.
  {
    id: 'box',
    what: 'makeBox (genesis) -- the R4 finding\'s falsely-attributed victim, now the canary\'s second subject',
    covers: 'makeBox',
    run: async (r) => { mustOk(await r.engine.makeBox(CANARY_GENESIS.featureId, { x: 10, y: 10, z: 10 }), 'makeBox') },
  },
  {
    id: 'cylinder',
    what: 'debugMakeCylinder (genesis test hook)',
    covers: 'X-cylinder',
    run: async (r) => { mustOk(await r.engine.debugMakeCylinder('RCCYL', 5, 10), 'debugMakeCylinder') },
  },
  {
    id: 'cone',
    what: 'debugMakeCone (genesis test hook)',
    covers: 'X-cone',
    run: async (r) => { mustOk(await r.engine.debugMakeCone('RCCONE', 5, 2, 10), 'debugMakeCone') },
  },
  {
    id: 'torus',
    what: 'debugMakeTorus (genesis test hook)',
    covers: 'X-torus',
    run: async (r) => { mustOk(await r.engine.debugMakeTorus('RCTOR', 20, 5), 'debugMakeTorus') },
  },
  {
    id: 'debug-edited',
    what: 'debugAssignEditedIdsForTest -- THE R4 FINDING\'S OWN CASE: a SYNCHRONOUS producer whose delta is its DIRECT RETURN, driven so the choke point must attribute it to itself',
    covers: 'X-debug-edited (the delta-identity canary\'s subject)',
    run: async (r) => {
      // The hook takes ORIGINAL entries + final probes and calls the production
      // private methods (#pairByOffset -> #assignEditedIds) directly. Drive it
      // off a REAL body's REAL snapshots so it is production data, not a
      // hand-built record. A FaceProbe is { hash, snapshot } (internal-types.ts).
      const h = await healedStep(r.engine)
      const snaps = r.engine.snapshotsFor(h.body)
      const entries = Object.entries(snaps).map(([id, snap]) => ({ id: id as StableId, snap: snap as never }))
      if (entries.length < 2) throw new Error('RECIPE debug-edited: fixture body has too few faces')
      // THE CANARY'S NON-VACUITY, and why this recipe changed in R5. Probing the
      // originals back at themselves matches every one of them exactly, so the
      // hook returns an EMPTY delta -- nothing minted, nothing RCDBG-rooted, and
      // A5's identity canary would have had no id to be about. So one probe is a
      // face at a location no original occupies (a real snapshot, translated --
      // which is exactly what a faceOffset hands this producer). It survives the
      // exact-key pass unmatched, pairs with no remaining original, and mints
      // `RCDBG:EDIT:new#0` (geom-engine.ts:4199): the one id in this run that
      // ONLY this call can have produced.
      const stray = entries[0].snap as unknown as { centroid: [number, number, number] }
      const probes = [
        ...entries.map((e, i) => ({ hash: i + 1, snapshot: e.snap })),
        {
          hash: entries.length + 1,
          snapshot: { ...stray, centroid: [stray.centroid[0] + 1000, stray.centroid[1], stray.centroid[2]] },
        },
      ] as never
      const out = r.engine.debugAssignEditedIdsForTest(entries, probes, CANARY_SYNC_HOOK.featureId, 'faceOffset')
      if (out.ok !== true) throw new Error(`RECIPE debug-edited: the hook refused (${out.reason}) -- vacuous`)
      if (out.generated.length === 0) {
        throw new Error(
          `RECIPE debug-edited: the hook minted NOTHING, so its delta carries no ${CANARY_SYNC_HOOK.featureId}-rooted id and ` +
          `#runtime-dispatch-delta-canary would be vacuous. The stray probe must survive to the mint tail.`,
        )
      }
    },
  },
  {
    id: 'import',
    what: 'importStep (genesis) -- bytes produced by the engine\'s own exportStep, so the round trip is real STEP, not a checked-in blob. Driven IMMEDIATELY AFTER the sync hook: it is the makeBox call R4 mis-attributed the hook\'s work to',
    covers: 'importStep',
    run: async (r) => {
      const box = mustOk(await r.engine.makeBox('RCEXP', { x: 10, y: 10, z: 10 }), 'export source box')
      const bytes = await r.engine.exportStep([box.body!])
      const imp = await r.engine.importStep(bytes, 'RCIMP')
      if (imp.bodies.length === 0) throw new Error(`RECIPE import: importStep produced no bodies -- vacuous: ${JSON.stringify(imp.diagnostics)}`)
    },
  },
  {
    id: 'import-iges',
    what: 'importIges (genesis, WO-1824) -- a committed IGES fixture the repo generated from a known solid, so the route is driven on real IGES bytes through the real kernel; the kernel-side twin of importStep',
    covers: 'importIges',
    // The engine has no exportIges (it is a kernel-level op the test harness only
    // reaches via occt-wasm's facade), so unlike importStep this route cannot
    // round-trip engine-produced bytes. The fixture is real IGES the repo wrote
    // itself (src/tests/evidence/WO-1824/make-fixtures.mjs), not a STEP blob.
    run: async (r) => {
      const b = readFileSync(new URL('../evidence/WO-1824/fixtures/box-with-hole.solid.igs', import.meta.url))
      const bytes = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
      const imp = await r.engine.importIges(bytes, 'RCIGS')
      if (imp.bodies.length === 0) throw new Error(`RECIPE import-iges: importIges produced no bodies -- vacuous: ${JSON.stringify(imp.diagnostics)}`)
    },
  },
]

// ---------------------------------------------------------------------------

describe('WO UI-57-R5 tier 1 DISPATCH CHOKE POINT: every derived route is EXECUTED on an alias-carrying fixture and paired with the delta THAT CALL returned', () => {
  let engine: GeomEngine
  let rec: Recorder
  let routes: DispatchRoute[]
  let apiMethods: ReturnType<typeof extractWorkerApiMethods>
  const failures: string[] = []
  /** Every call the engine received, across every recipe. */
  let calls: EngineCall[] = []

  beforeAll(async () => {
    // THE DOMAIN, derived before anything runs: routes from the engine's own
    // dispatch branches + the checker's literal unions, over the methods the
    // Comlink surface really exposes.
    const ap = createAliasProgram(ALIAS_MODULE)
    const apiSource = readFileSync(new URL(`../../${WORKER_API_FILE.replace(/^src\//, '')}`, import.meta.url), 'utf8')
    apiMethods = extractWorkerApiMethods(WORKER_API_FILE, apiSource)
    routes = deriveDispatchRoutes(ap, ENGINE_FILE, [...new Set(apiMethods.map((m) => m.engineMethod))])

    engine = new GeomEngine()
    await engine.init()
    // R5: nothing to open, and no ordering contract. The R4 recorder had to be
    // installed after kernel init because its evidence was a coverage window;
    // this one's evidence is each call's return value, so where it is installed
    // cannot affect a single attribution.
    rec = recordEngineCalls(engine, routes)
    for (const r of RECIPES) {
      try {
        await r.run(rec)
      } catch (err) {
        // Collect rather than throw: one refusing recipe must not hide every
        // other recipe's verdict behind a single beforeAll explosion. Every
        // collected failure is re-thrown BY NAME in #runtime-recipes-all-ran.
        failures.push(`recipe '${r.id}' (${r.what}): ${err instanceof Error ? err.message : String(err)}`)
      }
      await rec.engine.disposeAll()
    }
    calls = rec.calls
  }, 900_000)

  afterAll(async () => {
    await engine?.disposeKernel()
  })

  /** Calls that pinned `route`. */
  const callsFor = (route: string): EngineCall[] => calls.filter((c) => c.routes.includes(route))
  const producerRoutes = (): DispatchRoute[] => {
    const nonProducer = new Set(NON_PRODUCER_API_DISPOSITIONS.map((d) => d.method))
    return routes.filter((r) => !nonProducer.has(r.method))
  }
  /** How a RED message names one observed call. */
  const nameOf = (c: EngineCall): string =>
    `${c.method}[${c.routes.join(', ') || 'no derived route'}] featureId=${c.requestFeatureId ?? '<none readable>'}`
  /** EVERY StableId a delta names, wherever it names it. */
  const idsIn = (d: RecordedDelta): string[] => [
    ...Object.keys(d.modified), ...Object.values(d.modified).flat(),
    ...d.generated, ...d.deleted, ...Object.keys(d.geometry),
  ]
  /** aliasesFromDelta reads `modified` and NOTHING else (aliasLineage.ts:60-71),
   *  so the featureId handed here is documentation, not data -- which matters
   *  because the sync inline shape genuinely declares none and this census does
   *  not invent one. */
  const aliasesOf = (d: RecordedDelta): Map<StableId, StableId> =>
    aliasesFromDelta({
      featureId: d.statedFeatureId ?? '(the sync inline shape states no featureId)',
      modified: d.modified, generated: d.generated, deleted: d.deleted,
    } as ElementMapDelta)

  it('#runtime-recipes-all-ran: every recipe drove its real op to completion (a refused op proves nothing about its producers)', () => {
    expect(failures, `${failures.length} recipe(s) could not drive their routes:\n${failures.join('\n')}`).toEqual([])
  })

  it('#runtime-routes-derived: the route domain is DERIVED from the engine\'s own dispatch branches and the checker\'s literal unions (a domain that silently collapsed to method names is the R3 blocker itself)', () => {
    expect(routes.length, 'no routes derived -- every completeness cell below would be vacuously green').toBeGreaterThanOrEqual(40)
    // The derivation must really have SPLIT the op-shaped methods; if it degraded
    // to one-route-per-method, the census would be back to the R3 domain that the
    // audit walked through, and every cell below would still pass.
    for (const method of ['makeExtrude', 'makeRevolve', 'makeSweep', 'makeLoft']) {
      const ids = routes.filter((r) => r.method === method && r.field === 'op').map((r) => r.id)
      expect(ids.sort(), `${method} dispatches on req.op through four declared literals; a domain that does not name all four cannot tell its genesis branch from its boolean branches -- which is exactly how R3 certified an undriven add route`)
        .toEqual([`${method}:op=add`, `${method}:op=cut`, `${method}:op=intersect`, `${method}:op=newBody`])
    }
    expect(routes.filter((r) => r.method === 'editFeature').map((r) => r.id).sort())
      .toEqual(['editFeature:kind=faceOffset', 'editFeature:kind=holeDepth', 'editFeature:kind=holeDiameter', 'editFeature:kind=holeMove', 'editFeature:kind=pocketDepth', 'editFeature:kind=relief'])
  })

  it('#runtime-every-route-driven: EVERY derived PRODUCER dispatch route was ACTUALLY EXECUTED, and the driven set is read off the REQUESTS THE ENGINE RECEIVED (an undriven route is RED BY ROUTE NAME)', () => {
    // Scoped to producer routes: a method on NON_PRODUCER_API_DISPOSITIONS emits
    // no delta, so it has no carry-forward to prove and its ruling (re-checked by
    // #runtime-api-dispositions-live) is its coverage. Every OTHER route -- every
    // branch of every delta-producing method -- must run.
    const undriven = producerRoutes().filter((r) => callsFor(r.id).length === 0)
    if (undriven.length > 0) {
      const detail = undriven.map((r) => `  ${r.id}   (${r.file}:${r.line}${r.comparedAt.length ? `, dispatched at :${r.comparedAt.join(', :')}` : ''})`).join('\n')
      throw new Error(
        `${undriven.length} of ${routes.length} derived dispatch route(s) were NEVER EXECUTED.\n` +
        `THE R3 BLOCKER, VERBATIM: "the runtime census does not execute every named delta-producing dispatch route on an ` +
        `alias-carrying fixture. makeRevolve and makeSweep are exercised only with op:'newBody' ... The B1(b) cross-check ` +
        `then collapses coverage to a method-name set ..., so a genesis call to makeRevolve or makeSweep falsely certifies ` +
        `its unexecuted add route."\n` +
        `A route nobody executes has an UNPROVEN disposition, whatever its method-name sibling proved. Add a recipe that ` +
        `drives it through the real GeomEngine entry point:\n${detail}\n` +
        `Routes driven: ${[...new Set(calls.flatMap((c) => c.routes))].sort().join(', ')}`,
      )
    }
    expect(producerRoutes().length, 'no producer routes in the domain -- this cell would be vacuously green').toBeGreaterThanOrEqual(25)
  })

  it('#runtime-route-on-aliased-body: every PRODUCER route ran against a body carrying INHERITED aliases -- or holds a committed genesis/refusal disposition (B1: "on a fixture body ... an equivalent alias-carrying fixture")', () => {
    const genesis = new Set(GENESIS_ROUTE_DISPOSITIONS.map((d) => d.route))
    const refused = new Set(REFUSED_ROUTE_DISPOSITIONS.map((d) => d.route))
    const problems: string[] = []
    for (const r of producerRoutes()) {
      if (genesis.has(r.id) || refused.has(r.id)) continue
      const aliased = callsFor(r.id).filter((c) => c.fixture !== null && c.ok === true)
      if (aliased.length === 0) {
        problems.push(
          `  ${r.id} (${r.file}:${r.line}) ran ${callsFor(r.id).length} time(s), but NEVER successfully against a body ` +
          `carrying an inherited alias -- so its carry-forward behaviour is unproven`,
        )
      }
    }
    expect(problems, `${problems.length} producer route(s) were never driven on an alias-carrying fixture:\n${problems.join('\n')}\n` +
      `Drive it on healedStep()'s result inside withFixture(), or -- if it genuinely cannot take a target -- add a ruling to ` +
      `GENESIS_ROUTE_DISPOSITIONS naming why.`).toEqual([])
    // Non-vacuity: the dispositions must not have eaten the domain.
    const covered = producerRoutes().filter((r) => !genesis.has(r.id) && !refused.has(r.id))
    expect(covered.length, 'every producer route is dispositioned away -- this cell would be vacuously green').toBeGreaterThanOrEqual(15)
  })

  it('#runtime-every-route-has-its-own-delta: EVERY producer route production ACCEPTED was recorded WITH the delta it returned -- no route is certified over a delta:null (THE R4 BLOCKER, as a gate)', () => {
    // The R4 blocker, verbatim: "its direct delta-shaped return is recorded as
    // delta:null because push only reads result.elementMap". R4 had no cell that
    // could notice: nothing ever asserted a route's delta EXISTS, so a producer
    // whose return shape the recorder could not read passed as coverage. Here a
    // route that ran, succeeded, and yielded no readable delta is RED by name --
    // and the recorder itself refuses to reach that state quietly (extractDeltas
    // throws on an ok:true return matching no known shape).
    const refused = new Set(REFUSED_ROUTE_DISPOSITIONS.map((d) => d.route))
    const problems: string[] = []
    for (const r of producerRoutes()) {
      if (refused.has(r.id)) continue // production refuses it; a refusal returns no delta by design
      const accepted = callsFor(r.id).filter((c) => c.ok !== false)
      const withDelta = accepted.filter((c) => c.deltas.length > 0)
      if (withDelta.length === 0) {
        problems.push(
          `  ${r.id} (${r.file}:${r.line}) ran ${callsFor(r.id).length} time(s) and was ACCEPTED ${accepted.length} time(s), ` +
          `but not ONE of those calls returned a delta this census could read. A producer route certified over a null delta ` +
          `is the R4 blocker itself: teach support/engineCallRecorder.ts extractDeltas() the return shape it actually uses.`,
        )
      }
    }
    expect(problems, `${problems.length} producer route(s) were certified WITHOUT their own delta:\n${problems.join('\n')}`).toEqual([])
    const graded = producerRoutes().filter((r) => !refused.has(r.id))
    expect(graded.length, 'every producer route is refusal-dispositioned -- this cell would be vacuously green').toBeGreaterThanOrEqual(20)
  })

  it('#runtime-dispatch-delta-identity: EVERY recorded delta is the delta ITS OWN call returned -- proven per call by featureId identity and by the ids that call MINTED, never unioned across calls (R4 blocker: "the route log then unions the misattributed counters")', () => {
    // WHAT THIS REFUSES. Pairing a route with its own return value at the choke
    // point makes attribution true BY CONSTRUCTION -- and a canary that merely
    // restated the construction is exactly the vacuity R2/R3/R4 were bounced for.
    // So the construction is measured against production's own naming law: every
    // minting site spells `${featureId}:<opCode>:...` (see featureIdOf), so the
    // ids a delta MINTS name the call that minted them. A recorder that sourced a
    // delta from engine state, from the next call, or from a union of calls is
    // RED here, naming both the route and the foreign featureId.
    const problems: string[] = []
    let examined = 0
    for (const c of calls) {
      for (const d of c.deltas) {
        examined++
        if (c.requestFeatureId === null) {
          // NAME THE EVIDENCE, not just the verdict. The delta is rooted in SOME
          // feature; printing which one is what tells the next reader whether
          // this is a signature requestFeatureId() cannot read or -- far more
          // likely -- another call's delta that landed here (R4's forward leak).
          const roots = [...new Set(idsIn(d).map(featureIdOf))]
          problems.push(
            `  ${nameOf(c)} returned a ${d.shape} delta rooted in [${roots.join(', ')}] (e.g. ${idsIn(d)[0] ?? '<no ids>'}), ` +
            `but NO featureId is readable off its OWN request -- so this delta cannot be tied to the call that made it. ` +
            `Either it is some OTHER call's delta that leaked here (the R4 finding's exact shape), or requestFeatureId() ` +
            `cannot read this signature.`,
          )
          continue
        }
        if (d.statedFeatureId !== null && d.statedFeatureId !== c.requestFeatureId) {
          problems.push(
            `  ${nameOf(c)} was called with featureId '${c.requestFeatureId}', but the ${d.shape} delta recorded for it ` +
            `STATES featureId '${d.statedFeatureId}'. That delta belongs to a DIFFERENT call -- this is a smeared/unioned ` +
            `attribution, the exact R4 finding in delta form.`,
          )
        }
        const foreign = [...new Set(d.generated.filter((id) => featureIdOf(id) !== c.requestFeatureId))]
        if (foreign.length > 0) {
          problems.push(
            `  ${nameOf(c)} recorded a ${d.shape} delta that MINTS ${foreign.length} id(s) rooted in another feature: ` +
            `${foreign.slice(0, 4).join(', ')}. A call can only mint ids under its OWN featureId (every minting site spells ` +
            `\`\${featureId}:<opCode>:...\`), so this delta was sourced from somewhere other than this call's return.`,
          )
        }
      }
    }
    expect(problems, `${problems.length} recorded delta(s) are NOT their own call's return:\n${problems.join('\n')}`).toEqual([])
    // Non-vacuity: this cell must be examining real deltas across the census, and
    // more of them than there are routes.
    expect(examined, 'no delta was examined at all -- every identity claim above is vacuous').toBeGreaterThanOrEqual(50)
    expect(new Set(calls.filter((c) => c.deltas.length > 0).map((c) => c.requestFeatureId)).size,
      'the deltas examined all carry ONE featureId -- identity across calls would be untested').toBeGreaterThanOrEqual(20)
  })

  it('#runtime-dispatch-delta-canary: the R4 FINDING\'S OWN CASE -- the SYNCHRONOUS hook\'s delta is attributed ONLY to its own call and NEVER to makeBox (R4: "`makeBox calls=4 ... producers=[#assignEditedIds debugAssignEditedIdsForTest makeBox]`. makeBox cannot call either")', () => {
    const hook = calls.filter((c) => c.method === CANARY_SYNC_HOOK.method)
    expect(hook.length, `the ${CANARY_SYNC_HOOK.method} recipe did not reach the engine -- this canary would be vacuous`).toBe(1)
    const [hookCall] = hook
    expect(hookCall.requestFeatureId, 'the hook\'s featureId was not read off its own arguments').toBe(CANARY_SYNC_HOOK.featureId)

    // THE ORDER OF THESE FOUR IS LOAD-BEARING, and it was set by watching the
    // probe fail. The disjointness statements run BEFORE the hook's own delta is
    // asserted, because under a forward leak the hook's delta is EMPTY -- so an
    // "expected 0 to be 1" would fire first and the RED would never name the id
    // that moved. A gate that goes red without naming the misattribution leaves
    // the next reader exactly where R4 left this one.

    // 1. THE ADJACENCY TRAP -- R4's failure, precisely. Its sync branch never
    //    closed its window, so the hook's work landed on the NEXT call. That
    //    neighbour must exist for "sourced from the next call" to be a refutable
    //    hypothesis at all; here it is the `import` recipe's makeBox('RCEXP'),
    //    the very call R4's log printed the hook's producers under.
    const bearing = calls.filter((c) => c.deltas.length > 0)
    const hookAt = calls.indexOf(hookCall)
    const next = bearing.find((c) => calls.indexOf(c) > hookAt)
    expect(next, 'nothing delta-bearing runs AFTER the sync hook, so a forward leak (R4\'s exact failure) could not be detected').toBeDefined()
    const leaked = next!.deltas.flatMap(idsIn).filter((id) => featureIdOf(id) === CANARY_SYNC_HOOK.featureId)
    expect(leaked, `the call right after the sync hook (${nameOf(next!)}) carries ${leaked.length} ` +
      `${CANARY_SYNC_HOOK.featureId}-rooted id(s) -- ${leaked.slice(0, 3).join(', ')} -- so the hook's delta leaked FORWARD ` +
      `onto its neighbour. That is the R4 finding exactly: "its direct delta-shaped return is recorded as delta:null ... ` +
      `The route log then unions the misattributed counters and the ... assertion stays green."`).toEqual([])

    // 2. THE DISJOINTNESS HALF, over the whole run. No call but the hook may name
    //    an RCDBG id anywhere in its delta.
    const smeared = calls
      .filter((c) => c !== hookCall)
      .flatMap((c) => c.deltas.flatMap((d) => idsIn(d)
        .filter((id) => featureIdOf(id) === CANARY_SYNC_HOOK.featureId)
        .map((id) => `  ${nameOf(c)} :: ${id}`)))
    expect(smeared, `${smeared.length} call(s) other than the sync hook carry its ${CANARY_SYNC_HOOK.featureId} lineage. A delta ` +
      `read from engine state, from the next call's value, or from a union of calls does exactly this:\n${smeared.join('\n')}`).toEqual([])

    // 3. THE POSITIVE HALF. The hook's own delta really is its own, and really
    //    carries ids only it can have minted -- otherwise "no other call has
    //    them" would be a claim about an empty set, which is how a canary dies
    //    without ever failing.
    expect(hookCall.deltas.length, 'the hook returned its delta INLINE (geom-engine.ts:997-1002); R4 recorded exactly this as delta:null').toBe(1)
    expect(hookCall.deltas[0].shape, 'the hook\'s delta must be recognized as the INLINE return, not fished out of .elementMap').toBe('sync-inline-return')
    const own = hookCall.deltas[0].generated.filter((id) => featureIdOf(id) === CANARY_SYNC_HOOK.featureId)
    expect(own.length, `the hook's delta mints no ${CANARY_SYNC_HOOK.featureId}-rooted id, so the disjointness halves above would be vacuous`).toBeGreaterThan(0)

    // 4. makeBox BY NAME -- the finding's named victim. Its delta is entirely its
    //    own, and there is no RCDBG anywhere in it.
    const box = calls.filter((c) => c.method === CANARY_GENESIS.method && c.requestFeatureId === CANARY_GENESIS.featureId)
    expect(box.length, `the ${CANARY_GENESIS.featureId} makeBox recipe did not reach the engine`).toBe(1)
    const boxIds = box[0].deltas.flatMap(idsIn)
    expect(boxIds.length, 'makeBox recorded no delta -- the canary\'s second subject would be vacuous').toBeGreaterThan(0)
    expect([...new Set(boxIds.map(featureIdOf))],
      `makeBox('${CANARY_GENESIS.featureId}') mints a box from nothing, so EVERY id in its delta is rooted in ${CANARY_GENESIS.featureId}. ` +
      `Anything else is another call's lineage attributed to makeBox -- R4's finding, verbatim.`).toEqual([CANARY_GENESIS.featureId])
  })

  it('#runtime-carry-forward-observed: EVERY call on an alias-carrying body emitted a delta that RE-STATES that lineage -- per producer invocation, not once per recipe (the R3 audit: "examines one final Outcome.delta per recipe")', () => {
    const problems: string[] = []
    let examined = 0
    for (const c of calls) {
      if (c.fixture === null || c.ok !== true) continue
      for (const d of c.deltas) {
        examined++
        const rebuilt = aliasesOf(d)
        const root = resolveFaceIdVia(rebuilt, c.fixture.loser as StableId)
        if (root === (c.fixture.loser as StableId)) {
          problems.push(
            `  ${nameOf(c)} (${c.fixture.what}) ran on a body carrying the inherited alias ${c.fixture.loser} -> ` +
            `${c.fixture.winner}, but ITS OWN delta does NOT re-state it: aliasesFromDelta() cannot rebuild the pair, so ` +
            `the alias dies at the next serialize/restore. This is the R2 blocker's exact shape.`,
          )
        }
      }
    }
    expect(problems, `${problems.length} producer invocation(s) DROPPED inherited alias lineage at runtime:\n${problems.join('\n')}`).toEqual([])
    // Non-vacuity: this cell must actually be examining aliased calls -- and MORE
    // of them than there are recipes, which is the R4 difference.
    expect(examined, 'no call was examined on an aliased body -- every carry-forward assertion above is vacuous').toBeGreaterThanOrEqual(20)
  })

  it('#runtime-genesis-routes-truly-genesis: every GENESIS-dispositioned route\'s delta states NO inherited lineage -- its "there is no target body" excuse, re-earned by execution', () => {
    const problems: string[] = []
    for (const d of GENESIS_ROUTE_DISPOSITIONS) {
      for (const c of callsFor(d.route).filter((c) => c.ok !== false)) {
        for (const delta of c.deltas) {
          const rebuilt = aliasesOf(delta)
          if (rebuilt.size > 0) {
            problems.push(
              `  ${d.route} is dispositioned GENESIS ("${d.reason.slice(0, 60)}..."), yet a call to it emitted a delta that ` +
              `reconstructs ${rebuilt.size} alias pair(s) -- it DOES carry inherited lineage and must be driven on an ` +
              `alias-carrying fixture like every other producer route instead of excused.`,
            )
          }
        }
      }
    }
    expect(problems, `${problems.length} genesis route disposition(s) have rotted:\n${problems.join('\n')}`).toEqual([])
    for (const d of GENESIS_ROUTE_DISPOSITIONS) {
      expect(routes.map((r) => r.id), `GENESIS_ROUTE_DISPOSITIONS names '${d.route}', which is not a derived route -- a ruling for a route that does not exist is dead weight over a real gap`).toContain(d.route)
      expect(d.reason.length, `${d.route}'s disposition states no reason -- an empty ruling is not a ruling`).toBeGreaterThan(30)
      // Non-vacuity, and new in R5: R4 could not examine importStep at all -- its
      // {bodies:[{elementMap}]} return was recorded as delta:null, so this cell
      // silently graded nothing for it. Every genesis route must bring a real
      // delta to be excused over.
      expect(callsFor(d.route).some((c) => c.deltas.length > 0), `${d.route} is excused as genesis, but no call to it produced a delta this cell could examine -- the excuse would be granted over nothing`).toBe(true)
    }
  })

  it('#runtime-refused-routes-still-refuse: every REFUSED-dispositioned route was DRIVEN and observed refusing by its named diagnostic (the day production implements it, this cell demands a real recipe)', () => {
    for (const d of REFUSED_ROUTE_DISPOSITIONS) {
      expect(routes.map((r) => r.id), `REFUSED_ROUTE_DISPOSITIONS names '${d.route}', which is not a derived route`).toContain(d.route)
      const driven = callsFor(d.route)
      expect(driven.length, `${d.route} is dispositioned as refused-by-production, but nothing DROVE it -- a refusal nobody observed is an assertion, not evidence`).toBeGreaterThan(0)
      for (const c of driven) {
        expect(c.ok, `${d.route} was dispositioned as refused ("${d.reason.slice(0, 60)}...") but PRODUCTION ACCEPTED IT. It now produces deltas nobody censuses: delete the disposition and add a real alias-carrying recipe.`).toBe(false)
        expect(JSON.stringify(c.diagnostics), `${d.route} refused, but not with the diagnostic its disposition names (${d.refusalMatches}) -- the disposition describes a refusal that no longer happens`).toMatch(d.refusalMatches)
        expect(c.deltas, `${d.route} refused yet still returned a delta -- a refusal that produces lineage is a producer, and must be censused as one`).toEqual([])
      }
    }
  })

  it('#runtime-worker-api-cross-check: every method the Comlink surface EXPOSES is in the ROUTE DOMAIN and driven, or carries a committed non-producer disposition (B1(b) -- now by route, so a method with four behaviours cannot be certified by one)', () => {
    expect(apiMethods.length, 'the worker api extraction found no methods -- the extractor broke, and this cross-check would pass vacuously').toBeGreaterThanOrEqual(25)
    const drivenRoutes = new Set(calls.flatMap((c) => c.routes))
    const undisposed = apiMethods.filter((m) => {
      if (NON_PRODUCER_API_DISPOSITIONS.some((d) => d.method === m.name)) return false
      const mine = routes.filter((r) => r.method === m.engineMethod)
      // Every ROUTE of the method must be driven -- not merely the method name.
      return mine.length === 0 || mine.some((r) => !drivenRoutes.has(r.id))
    })
    if (undisposed.length > 0) {
      const detail = undisposed.map((m) => {
        const mine = routes.filter((r) => r.method === m.engineMethod)
        const missing = mine.filter((r) => !drivenRoutes.has(r.id)).map((r) => r.id)
        return `  ${m.name} -> engine.${m.engineMethod}() (${m.file}:${m.line})\n    undriven route(s): ${missing.join(', ') || '<no route derived at all>'}`
      }).join('\n')
      throw new Error(
        `${undisposed.length} method(s) on the worker's exposed Comlink surface have a dispatch route that is neither ` +
        `DRIVEN by a runtime census recipe nor dispositioned as a non-producer.\n` +
        `An exposed method is APP-REACHABLE the moment it ships, and so is EVERY BRANCH of it: R3 proved a method-name ` +
        `cross-check certifies an add branch a genesis call never touched. If a route produces a delta, drive it; if the ` +
        `method does not, say so in NON_PRODUCER_API_DISPOSITIONS with a reason:\n${detail}`,
      )
    }
  })

  it('#runtime-api-dispositions-live: every non-producer disposition still names a method the worker really exposes (a disposition for a deleted method is dead weight hiding a real gap)', () => {
    const exposed = new Set(apiMethods.map((m) => m.name))
    const stale = NON_PRODUCER_API_DISPOSITIONS.filter((d) => !exposed.has(d.method)).map((d) => d.method)
    expect(stale, 'non-producer dispositions naming methods the Comlink surface no longer exposes').toEqual([])
    for (const d of NON_PRODUCER_API_DISPOSITIONS) {
      expect(d.reason.length, `${d.method}'s disposition states no reason -- an empty ruling is not a ruling`).toBeGreaterThan(30)
    }
  })

  it('#runtime-route-log: the census PRINTS every route, and every CALL with the delta THAT CALL returned (the WO\'s "route key + delta summary ... names alone are not evidence")', () => {
    // PER CALL first -- the unit B1 is about. R4's log printed producer NAMES per
    // route, unioned across calls, which is how an impossible attribution
    // (`makeBox ... producers=[debugAssignEditedIdsForTest]`) could print inside a
    // green run and be believed. A delta summary cannot do that: it says which
    // feature the delta is FOR and how much lineage it states.
    const perCall = calls.map((c, i) => {
      const deltas = c.deltas.length === 0
        ? 'no delta'
        : c.deltas.map((d) => {
          const stated = d.statedFeatureId ?? '<inline shape states none>'
          return `${d.shape} featureId=${stated} modified=${Object.keys(d.modified).length} ` +
            `generated=${d.generated.length} deleted=${d.deleted.length} geometry=${Object.keys(d.geometry).length}`
        }).join(' | ')
      return `${String(i).padStart(3)} ${(c.routes.join(',') || `<${c.method}: no derived route>`).padEnd(36)} ` +
        `req=${(c.requestFeatureId ?? '-').padEnd(7)} ok=${c.ok === null ? '-' : c.ok ? 'Y' : 'N'} ` +
        `fixture=${c.fixture === null ? '-' : 'Y'} ${deltas}`
    })
    // ...then the per-ROUTE rollup, so an undriven route is visible at a glance.
    const perRoute: string[] = []
    for (const r of [...routes].sort((a, b) => a.id.localeCompare(b.id))) {
      const cs = callsFor(r.id)
      const aliased = cs.filter((c) => c.fixture !== null && c.ok === true).length
      perRoute.push(
        `${r.id.padEnd(34)} calls=${String(cs.length).padStart(2)} aliased=${String(aliased).padStart(2)} ` +
        `ok=${cs.map((c) => c.ok === null ? '-' : c.ok ? 'Y' : 'N').join('') || '-'} ` +
        `deltas=${String(cs.reduce((n, c) => n + c.deltas.length, 0)).padStart(2)}`,
      )
    }
    console.log(
      `\nUI-57-R5 DISPATCH CHOKE-POINT CENSUS -- ${routes.length} derived routes, ${calls.length} recorded calls, ` +
      `${calls.reduce((n, c) => n + c.deltas.length, 0)} deltas paired with the call that returned them\n\n` +
      `PER CALL (route key + the delta THAT CALL returned):\n${perCall.join('\n')}\n\n` +
      `PER ROUTE:\n${perRoute.join('\n')}\n`,
    )
    expect(perRoute.length).toBe(routes.length)
    expect(perCall.length).toBe(calls.length)
  })
})
