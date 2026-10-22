# Kernel material service (WO-3017 part a, WO-3032 part b; alpha.3 A3-10 parity)

A headless kernel service built beside today's engine. It imports only its own
files, `src/types`, `src/lib/cam/stockCuttingRoles` and (types only) the kernel
geometry service, all inside the WO-2904 allow-list; it never imports
`src/kernel/heights` (WO-3020: no caller until a family switches). Nothing
in the app calls it: the engine selector stays `current`, and replay, air, links
and the reach trim keep running on `src/cam3d/stock` and `src/lib/cam/stockState.ts`.

| Piece | File | At parity with today's |
|---|---|---|
| One tool-shape source (MD-45): `dropCutterSpec`, `sweepShape` / `sweepHeight`, `reachBands`, `simulationBottomAt`, `toolShape` | shape.ts | `toolToCutterSpec`, `sweepProfile` / `profileHeight`, holderClearance `headBandsFor`, `tipOffsetAtRadius`, each generated from the caller's `buildToolProfile(tool)` and `toolTypeMeta(type).profileKind` |
| Kernel z-dexel field `DexelField.fromBox` | dexel.ts | `ZDexelField.fromBox` (same grid, budget and encoding) |
| `sweepMove(field, move, shape, removed)` | sweep.ts | `removeSweep`. Flat and ball heights are byte-equal; bull-nose and V-bit (which throw today) follow the analytic profile; any other family sweeps with its inscribed upward-open shape and says so in one line |
| MD-50 candidates `centre` (+ `declaredPad`) and `whole-cell`, `moveIntrusion` | removed.ts, sweep.ts | `maxTraverseIntrusion` (centre, no pad: value for value) |
| Parity policy table | policy.ts | the three compensations, top of cut per family, adjacent-roughs hand-off, replay cutter per tool type, all with file:line |

Policies: `PARITY_POLICY` keeps the centre rule, and every new rule is OFF
(`single_air_rule`, `top_of_cut_from_material`, `non_adjacent_handoff`,
`profile_replay`). MD-50..MD-53 need CARD V02 first, and MD-67 closes first for
2.5D rapids. The removed-definition benchmark (both candidates, A.5 rows,
several cell sizes, M-SAFE-2 and M-AIR-1) and the rule it names are in
`src/tests/evidence/WO-3017/removed-definition-benchmark.json`. Naming that
rule does not switch it on.

The sweep model keeps D-016: the cutter occupies every column from its lower
surface upward. That holds for the analytic heads. A cut deeper than the flute
with a narrower neck or shank is the reach check's business, as today.

## Part b (WO-3032): queries, lifecycle, polygon backend, at parity

| Piece | File | At parity with today's |
|---|---|---|
| Replay, the source of truth: `replayOperationInto`, `cuttingSweeps`, `replayCutterFor`, `PARITY_REPLAY` (0.2 mm, 1 000 000 columns, sagitta cell / 4) | replay.ts | store `remainingStockBefore` + `toolpathMovesToLinearSweeps` + `stockCutterOf` (drill flats lifted by the point length) |
| Lifecycle: `createMaterialLifecycle` (`snapshotAfter(N)`, `snapshotBefore(N)`, `isValid`, `stats`, `clear`), `replaySnapshotAfter`, `chainFingerprint` | lifecycle.ts | in-memory snapshot per operation keyed by a hash-chain fingerprint (every value replay reads); one validity test; nothing persisted (ADR-0040) |
| `topHeight(region)`, `remainingWithin(region, min thickness)`, `airAlong(moves)` | queries.ts | `highestMaterialOver`; benchmark `carveCoverage` uncut area (M-PART-1); `collectAlpha3` M-SAFE-2 / M-AIR-1 / M-AIR-2 read |
| `restAir2dPlan`, `restAirClears` (one-cell pad from the table) | air.ts | `skipAirOnlyPasses` decisions (dropped passes, links at rapid, counts) |
| `finishAirFeeds` (half-cell widening from the table) | air.ts | `rapidAirFeedsOverRemovedStock` demotions, sampled square + continuous proof |
| `smartTop2d`, `adaptiveHandoff` (+ `adaptiveChainFingerprint`), `finishTopOfCut` | handoff.ts | store `earlierMaterialStartFor`; `restStartStockFor` (adjacent roughs only); 3D finishes take no top from material |
| Polygon backend: `polygonSnapshotAfter`, `subtractSweeps`, `radiusAtHeight`, `capsule` | polygon.ts | same replay; per-level regions by boolean difference through the injected geometry service; `remainingAbove` within one cell |
| `reach(T)`: assembly bands + recorded head-only shape | reach.ts | holderClearance `assemblySweepBands`; `PARITY_QUERY_POLICY.head_only_reach_shape` OFF |

Every compensation the air answers use is read from `PARITY_COMPENSATIONS`, so
the table is the parity, not a comment. MD-50..MD-53 stay policy values, OFF
(CARD V02 first). Proof: `src/tests/kernel/material{Queries,Lifecycle}.wo3032.test.ts`,
evidence in `src/tests/evidence/WO-3032/`.

Not yet: any app wiring, any policy ON.

Proof: `src/tests/kernel/material{Profile,Sweep,Removed}.wo3017.test.ts`, with
evidence in `src/tests/evidence/WO-3017/`.
