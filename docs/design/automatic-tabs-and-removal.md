# WO-3176 - draft-ready product scopes

Baseline `f5f9843de9063c656ac0aeb96a84323e5ae7dd96`; recon handoff only.
These are two bounded briefs for conversion into the existing queue. Path grants
below are PROPOSED, not this worker's ownership. No implementation is released.
The desk retains source/approval ownership and reconciles existing leases.

October 28 resume: see [RESUME.md](RESUME.md) for qualifications against
`367a517dff3f85d5ae11adb5efdd4833a78a655d`. Core tab authorities are unchanged.
WO-3170 Slice A now supplies optional feature evidence and source scope; reuse
those fields rather than proposing them again. Its shared binder/production
consumers remain separate Slice B work. Existing line numbers below refer to
the original inspection, not the new comparison pin.

## Brief A - place tabs away from geometric trouble, retaining hand edits

Smallest user outcome: on an existing finish-only, closed Contour, choose
**Suggest tab locations** in Properties > Holding tabs. Preview suggestions away
from corners/short spans/nearby holes and setup obstacles, then **Apply**. The
result uses today's `tabLocations` and can immediately be dragged or deleted
with today's editor. Old projects still generate exactly their old evenly
spaced/manual plans unless the user invokes and applies this action.

Size: M for the consumer plus S pure math; separate S headless wiring. Not one
combined L. The first delivery makes no claim to repair Offset/multi-region
roughing retention. Those incidents stay in the existing A3-19 scope.

### A0 (S): wire existing record stock bottom for Contour tabs

Proposed owned source: `src/store/index.ts` only. Read/reuse
`src/kernel/world/{stock,index}.ts` stockBottomWcsZ/stockBounds; do not change
the kernel's policies or material authority. Replace only the Contour tab stock
bottom/preview dependency on getStockBoundsFromViewport with the record result,
including correct world-to-WCS conversion exactly once. Audit every consumer
of `tabStockBounds` (worker payload and tabTopZ preview), and all membership
fallbacks (explicit, derived, legacy, multiple stocks, nests).

Named focused tests, individually granted:
`src/tests/store/contourTabRecordStock.wo3176.test.ts` (new),
`src/tests/cam/contour2d-tabs.test.ts` (existing regression).
The new file must compute through store computeOperationToolpath without
window.__cncViewport, not call resolveTabs with a fabricated bottom. Assert
world bottom 0/WCS origin Z 6 -> worker bottom -6 -> retained world top 1.5
for height 1.5. Repeat with moved explicit stock bottom 10 and origin Z 16;
assert world top 11.5. Viewport mounted/unmounted plans must agree. Missing
record stock retains the actual inability with one line and no motion.
No new stock schema/cache, no Face-rest or other-family migration.

Dependencies: WO-3008 code is already present; no dependency on completing all
kernel migrations. Serialize A0 and A2 because both touch store/index.ts.
This is restoration of headless parity, not a change of approved machining
method. Preserve WO-3008's policy holds.

### A1 (S): extend existing pure tab-placement math

Proposed source: `src/lib/viewport/tabPlacement.ts`. Add a pure
`suggestTabFractions`-style export beside cumulative/projection helpers; no
service, recognizer or second stored tab model. A UI command consumes it;
Contour emission still consumes buildContourTabPlan. Keep kernel/workholding
planTabs as the parity authority, not a parallel new scorer. A later migrated
consumer can receive this function through its composition adapter instead of
violating the kernel import boundary.

Named test: `src/tests/viewport/automaticTabPlacement.wo3176.test.ts` (new).
Existing read-only regression: `src/tests/viewport/tabPlacement.test.ts`.

Input contract: directed production finish path and loop identity; requested
count, existing lift width, cutter radius; source boundary/nested loop rings;
world-mm fixture footprints and their Z bands; actual entry/exit exclusion
intervals where known; approximation tolerance. Return suggested fractions,
per-candidate reason/clearance facts and found/requested counts. No mutation.
The scorer must distinguish absent obstacle evidence from an empty obstacle
set; do not label an omitted fixture as checked. Missing feature recognition
must not block ordinary 2D loops or infer an unknown hole depth.

Deterministic design to implement/test:

1. Remove duplicate points and coalesce collinear spans within declared input
   tolerance. Canonicalize the candidate enumeration's start/orientation in
   world geometry, then map results back onto the original directed finish path.
   Do not rotate stored manual fractions or modify emission's existing seam.
2. Let W be today's tool-center lift interval width, R cutter radius, epsilon
   the explicit geometric allowance (initial proposal 0.25 mm plus input error).
   Sharp corners have center exclusions of W/2 + R + epsilon along both sides.
   A sharp-bounded segment shorter than W + 2R + 2epsilon has no candidate.
   These are conservative placement margins, not a reinterpretation of W as
   finished physical web width. Do not silently widen the tab lift (CF-067).
3. Build feasible intervals on the circular arclength domain. Check the ENTIRE
   tab support corridor/cutter sweep against other holes, nonadjacent concave
   edges, islands and fixtures; a safe center point alone is insufficient.
   Fixture bands intersecting the planned Z range include cutter/holder reach
   via existing authorities. Check the material-side connection to the outer
   stock/skeleton, not just length on the selected inner contour. Absence of
   such a web means no automatic suggestion at that location; manual authoring
   remains available. Use existing loop containment/Clipper predicates and
   resolved workholding adapters; no geometry-to-feature detector is needed.
4. Generate interval endpoints, midpoints, and a deterministic arclength grid
   with step <= min(W/4, 1 mm); deduplicate using the declared tolerance. Reserve
   entry/exit spans where fixed; when entry is free, hand selected centers to
   the existing largest-gap reseam logic. Never impose a new descent method.
5. Among feasible candidates, use a documented lexicographic score: lower
   tangent turn across W first (curvature), then larger minimum clearance to
   geometric exclusions, then larger minimum circular distance to already
   selected centers, then smaller deviation from the even-spacing targets;
   final ties by canonical world XY/arclength. Quantize comparisons to the
   declared geometric tolerance, not unbounded floating point equality.
   Reject overlaps by circular separation >= W. Limit each clearance score to
   a documented cap so an unbounded distance cannot defeat the other criteria.
6. A deterministic greedy packing may return fewer candidates than requested;
   it must report "found K of N suggestions", not prove the geometry impossible.
   No donor-style silent loss, force-fitting to a corner, or fallback to even
   spacing. Applying a partial plan requires the explicit **Apply K** action;
   cancel leaves the operation unchanged. A zero-result returns reasons and
   writes nothing. No global generation refusal or new required field.

This is a geometric heuristic, not an optimizer of retention forces. Constants
are explicit proposals for the implementation scope, not owner-approved tab
sizes. Do not impose a tab-height gate or claim a material-specific safe count.

Independent test cases (same named test file):

- 100 x 20 rectangle, N=6: even spacing hits corners at s=100,220. Suggested
  centers must clear all hard corners by 7.25 mm for W=8,R=3,e=0.25. Assert
  inequalities, not an upstream implementation's exact chosen list.
- 10 mm short segment between sharp turns: empty center interval at those
  values; 20 mm span yields allowed center domain [7.25,12.75].
- Smooth circular arcs, W=8: turns 8/20 and 8/100 rad distinguish curvature.
  Refining a circle's tessellation within tolerance must not create artificial
  corner exclusions; evaluate accumulated tangent turn, not segment count.
- Concave U/notch and nested island: corridor intersecting the opposite wall
  or hole is excluded even where center and endpoint tests are individually
  clear. Compare swept-disc/line distances with analytic rectangles/circles.
- Clamp rectangle at known Z: capsule intersects inflated footprint at an
  intersecting cutting band -> exclude; an obstacle wholly outside the sweep
  band is not falsely considered collided. Unknown holder/clamp geometry
  records omission, never asserts a checked-safe fixture.
- Seam tab at s=1 on L=200, W=8: modulo interval [197,200)+[0,5], separation
  checked across the wrap. Round-trip fractions through existing reseaming.
- Manual entries are not input for relocation; same loop skipped by command.
  Different count cannot erase them. Duplicate vertices, zero-length loop,
  NaN input and a tightly packed N request produce honest diagnostics.
- Cyclic seam rotation and reversal preserve geometric suggestions within
  tolerance after mapping fractions; identical world geometry produces the
  same decision regardless of input enumeration. Left-hand/climb mapping
  uses the directed production preview, not a hard-coded winding.
- R=5,W=8: do not call the zero central web a strong tab. Record the physical
  limitation; do not silently change W or assert that placement proves retention.

### A2 (M): wire suggestions into existing authoring and Generate/Post

Proposed owned source:
`src/components/panels/PropertiesPanel.tsx`, `src/store/index.ts`,
`src/types/index.ts` (only transient preview source identity), and locale files
`src/i18n/locales/en/cam-operations-new-operation.ts`,
`src/i18n/locales/de/cam-operations-new-operation.ts`,
`src/i18n/locales/es/cam-operations-new-operation.ts`,
`src/i18n/locales/fr/cam-operations-new-operation.ts`. These existing shards
own the tab controls (non-English shards may currently fall back to English).
No New Operation modal control is necessary for the first useful outcome.
Read-only dependencies: A1 math, generationFingerprint, existing obstacle/
loop adapters, persistenceRegistry and Contour engine.

Named new tests:
`src/tests/components/automaticTabPlacement.wo3176.test.tsx`,
`src/tests/store/automaticTabsJourney.wo3176.test.ts`.
Existing focused regressions:
`src/tests/cam/contour2d-tabs.test.ts`,
`src/tests/viewport/tabPlacement.test.ts`.

Production path: create Contour via NewOperationModalBody -> closed outline,
finish/profile-only and existing tabs on -> Generate using
computeOperationToolpath -> select operation Properties > Holding tabs >
Suggest -> preview proposed locations/count/reasons -> Apply -> existing
updateOperation/applyCamCommands with one undo transaction -> Generate ->
registry.contourRequest -> COMPUTE_CONTOUR/toolpathWorker ->
buildContourToolpath -> normal final reach/workholding processing -> Simulate
Cut Stock -> PostProcessModal -> postProject/buildPostInput -> dialect output.
The test must use the production worker seam and final published moves/post
bundle. A direct buildContourToolpath payload is only a math/control test.

Preserve every nonempty tabLocations entry byte-for-byte; seed suggestions
only for selected loops without hand locations. To replace hand locations,
user already has Reset to even spacing; do not overload Suggest with silent
replacement. Keep no new durable automatic mode, cache or provenance schema.
Apply saves ordinary fractions; edit/delete/drag remains existing behavior.

Preview freshness: bind the transient contourTabPreview to the exact dispatch
input fingerprint/revision, including current geometry/instance, tool cutHand
and diameter, setup/WCS/stock and clamp snapshot. Verify again before Apply;
recompute suggestions if any input changed. Do not trust status ready alone.
The existing preview is stripped from all saved forms; additive preview
identity must follow that registry. Avoid async writes into a different
project, deleted operation or a changed setup. A new generation after Apply
must publish a matching preview/fingerprint, not mark the result current from
old suggested geometry.

Persistence/migration: no schema bump for ordinary tabLocations. Legacy no-map
and empty-map entries keep even spacing. Save/reopen retains applied map;
preview is rederived; undo/redo restores map and stale/current transitions.
Geometry changes retain manual values under existing semantics; do not rescore
or pretend old fractions track a reshaped physical location. Duplicate/deleted
loop keys follow current source resolution; no global loop-ID migration.

Tier 2 acceptance: round rectangle plus concave/island/clamp fixture, source
loops sourced through real 2D import and one supported model/mesh closed
profile. Both UI test and store journey show applied centers, final tab lifts
and posted Z over the same physical spans. Verify save/reopen and undo/redo,
count override, moved WCS, left-hand tool, cancellation, stale response and
source deletion. Existing manually placed triangular seam-crossing ramp tabs
and even/disabled legacy output must remain equal to baseline.
Capture Properties suggestion/apply and Toolpath/Cut Stock results at desktop
sizes used by this product. Never claim an unsupported route became covered.

A3-19 route repair is not a hidden dependency for finish-only A2. Roughing or
split/open routes get an honest capability explanation for this suggestion
command; do not alter their current generation or silently select another
strategy. Restoring all-route tab retention must be separately scoped/released
against BL-312/313, with same-test old/new proof, final-output material evidence
and the existing V13 motion approval rules.

## Brief B (M) - create an explicit all-tab removal Contour in the same setup

Smallest user outcome: choose a computed tabbed Contour, choose **Create tab
removal contour**, review the source tabs and existing setup/holding notes,
and create a separate finishing-only Contour that cuts the FULL selected
outline to its intended bottom with tabs OFF. The action names removal of ALL
tabs on those outlines; it is not a selected-tab-local operation. No automatic
cleanup pass is appended to the original operation and no automatic stop,
clamp motion or workholding change is added.

Recommendation: ADAPT the existing Contour primitive. Do not add a new operation
family, stock engine, post dialect or virtual support body. This outcome is
bounded M because it uses complete-loop finishing, not a new partial-arc engine.
A combined same-side/subset/flip implementation would be L and is not proposed.

### Proposed source and exact tests

Owned source proposal:
`src/components/panels/PropertiesPanel.tsx` (source action/review),
`src/lib/cam/contourTabRemoval.ts` (new pure authoring adapter, NOT an emitter),
`src/lib/cam/types.ts` (optional source binding under Contour params),
`src/store/index.ts` (existing command and source-resolution integration),
`src/lib/cam/generationFingerprint.ts` (live and saved source dependency),
`src/lib/post/setupSheet.ts` (removal identity/holding-method line), and
`src/i18n/locales/en/cam-operations-new-operation.ts`,
`src/i18n/locales/de/cam-operations-new-operation.ts`,
`src/i18n/locales/es/cam-operations-new-operation.ts`,
`src/i18n/locales/fr/cam-operations-new-operation.ts`.
Read-only/reuse: contour2d, toolpathWorker, operation manifest/registry,
operationStockAuthority, operationStockInputs, flipSetup, kernel feature
identity, document transaction and persistence registries. If investigation
requires a primitive-emitter change, stop that expansion and split the scope.

Individually named tests:
`src/tests/cam/contourTabRemoval.wo3176.test.ts` (new authoring contract),
`src/tests/store/tabRemovalJourney.wo3176.test.ts` (new production journey),
`src/tests/post/tabRemovalSheet.wo3176.test.ts` (new sheet/post lifecycle),
`src/tests/cam/contour2d-tabs.test.ts` (existing preservation regression),
`src/tests/lib/operationStockAuthority.wo2953.test.ts` (existing authority).
Serialize B with A2 (same Properties/store/locale files); A1 pure math is disjoint
from B. A0/A2/B are independent release slices, not concurrent file owners.

### Authored operation, identity and material contract

- Reuse source geometry selections, side, direction, actual tool and resolved
  bottom authority. Create a NEW operation ID; source remains untouched.
  Explicitly choose existing finishing-only passes, radial/floor allowance zero,
  tabs false, original intended cut-through bottom and ordinary stepdown/linking.
  Do not take a full-depth plunge through the tab just because roughing finished.
  Existing finish-only stepdowns and the user's plunge/ramp choice remain.
- Initial cleanup uses the same tool/outline/placement/setup as its source.
  Changing tool/frame is not a silent adaptation: regenerate from the source
  through the new action or leave the existing independent generic Contour
  workflow available. No rewrite of saved source settings or attached locations.
- Save additive `tabRemovalSource` binding in Contour params: source setup/op
  IDs, source authored generation identity, exact selected loop IDs and target
  tab identities. Resolve source centers by the SAME buildContourTabPlan input,
  including reseaming, not transient marker positions. Reuse WO-3004 loopId#k
  labels for display only. They are ordinal and NOT stable across insertion,
  deletion, reseaming or changed shape. A target identity must include source
  generation identity + loop reference + center/profile identity (or retained
  source interval), so old #1 cannot silently bind to new #1.
- No generalized tab recognition. If source references later use STEP/model/
  mesh features, reuse WO-3002 adapters/WO-3170 binder and native-to-world frame.
  Keep existing content-derived loop IDs; never migrate global IDs in this slice.
- Mark the cleanup predecessor-dependent through existing
  operationDependsOnPredecessors/dependsOnPredecessors mechanism. Fingerprint
  validation must also compare live source identity for both store compute and
  saved-file/post reconciliation; a saved source hash in params alone is not
  a dependency. Store compute/publication currently derives and overwrites
  dependsOnPredecessors from dependsOnRestStock (`index.ts:21144` and its
  normalization helper around `:9427`); extend those consumers as well so
  regeneration cannot erase this binding. Keep this in the existing predicate,
  not a second dependency graph. Reorder before source, suppress/delete source, change tabs,
  cutHand, diameter, placements, stock, WCS, setup or earlier material -> stale
  and no stale G-code posted. Source/output progress-only writes do not churn
  authored identity. Source edit-away/edit-back and late workers are covered.
- Remaining-stock authority is WO-2953 getOperationStockDomain for ordered enabled
  predecessors on the SAME physical stock in world/mm. Reuse its token/readiness
  checks. At the October 28 comparison pin, reuse its asynchronous preparation
  and `readBeforeAndQuery` boundary where a read plus query is needed; await
  readiness and reject stale publication, rather than copying the old synchronous
  input/replay path into this adapter. Upper envelopes can prove air above the bound, not that a tab is intact
  or strong. Do not use kernel material's unwired lifecycle or store a second
  remaining-stock cache. The full-contour method does not need exact thin-web
  geometry: if precise material is unavailable it still traces the explicitly
  chosen full outline conservatively, reports that fact, and does not invent
  stock-based path clipping or change the requested method.
- Retention: the setup must physically support both the released part and
  whatever stock/skeleton can move. Existing holdingMethod/holdingNotes,
  resolved fixtures and user-authored operator-stop actions describe the plan,
  not a force/contact certificate. Review shows the current method and that ALL
  targets will be removed. Do not infer vacuum/tape/screws from a field, insert
  clamps, or insist on an arbitrary mandatory note/checklist before a path the
  software can compute. Source tabs alone cannot physically retain the part
  after the last tab. A safely secured tape/glue or screw-held coupon is the
  independent retention fixture; actual hardware use remains an owner decision.
- Inter-operation changes: existing operator_stop/park action may be authored
  by the operator between source and cleanup if a screwdown/clamp change is
  part of his plan. Never auto-add that action or assume it happened from a
  simulated stop. Post/buildPostInput uses actual existing action ordering.
- Source and cleanup save/undo/reopen in the existing document. One creation
  transaction undoes just the cleanup; deleting it never deletes source tabs.
  Older projects have no binding and are unchanged; malformed/missing source
  binding cannot become an unbound, silently reinterpreted cleanup. A user
  can deliberately create an ordinary independent Contour using the existing UI.

### Production acceptance and independent oracles

Source tabbed Contour -> Generate -> inspect retained stock -> Create tab
removal contour -> review full-outline/all-targets + setup -> create separate
operation -> Generate -> Cut Stock -> Post Process. No controller call.
Exercise the same store -> registry -> worker -> final moves -> postProject
path as Brief A, including original source preserved before and after creation.

Analytic fixture: 100 x 60 x 6 stock, closed rectangular inner part, four source
box tabs of lift width 8 and height 1.5, 6 mm flat end mill, stock bottom world
0, top 6. Source bottom 0, offset path correctly one tool radius from the wall.
Independently swept discs/solid sections show retained webs on source output;
cleanup at bottom 0 removes the targeted webs, with no change to source output.
Use independent swept-volume/cross-section calculations, not just the same
planner's interval test. At channel center a straight box lift W=8,R=3 leaves
2 mm tangential web; avoid claiming an 8 mm central web. Triangular variant
must use its true 45-degree Z profile and cutter sweep, not a flat box oracle.
With source bottom -0.2 the cleanup retains that explicitly authored allowance,
not a newly invented through-spoilboard default. Final posted program positions
must map those same world depths through the saved WCS once.

Test source/cleanup ordering, source deletion/suppression, no tabs on source,
partial/stale source output, changed tab identities, manually moved centers,
seam crossing, ramp entry, second stock with identical dimensions, roundtrip,
undo/redo, and delayed worker settlement. For missing/invalid references the
requested linked operation cannot be resolved: one line, no substitute motion.
Selecting only two of four tabs must NOT create a full-outline cleanup; first
slice supports all only and must say selective removal is not implemented.
Captures: source retained webs and cleanup removal, separate operation list,
review with actual setup holding method and posted setup sheet. Simulation
proves geometry only; it does not prove the part stays held on the machine.

### Explicit extension boundaries (not blockers for the M outcome)

Selected-tab-only removal (future M): map selected immutable source intervals
onto the finish path, prove bounded approach/retract and swept coverage,
preserve EVERY unselected tab including triangular seam profiles. Only this
limitation justifies a new localized-span emitter. A full-contour primitive
cannot satisfy it. Exact proposed future source: contourTabRemoval.ts plus
contour2d.ts/types.ts/worker payload adapter, with separately named
`src/tests/cam/localTabRemoval.wo3176.test.ts` and
`src/tests/store/localTabRemovalJourney.wo3176.test.ts`. Re-grant at dispatch.

Second-side removal (future M contract/adapter): reuse flipSetup.ts and
coordinateFrames.ts; explicitly transfer/replay retained solid plus tab IDs
and support, using the child actual WCS and Setup.flipOf axis. Current
kernel/world/stock.ts carriedMaterial returns null; Setup.flipOf is not that
transfer. For the known 100 x 50 x 20 flip-X case, source point (10,5,-3)
with zeros (0,0,20)/(0,50,20) must map to (10,-5,-17). Test X and Y, changed
destination datum, wrong stock identity, fixtures moved for the new setup,
uncertain imported STL surfaces and every unremoved web. No mirrored posted
G-code or synthetic fresh box as a stand-in for carried material. Named future
tests: `src/tests/cam/flippedTabRemoval.wo3176.test.ts` and
`src/tests/store/flippedTabRemovalJourney.wo3176.test.ts`. Same-setup action
must explicitly decline this linked method until that adapter exists, while
ordinary second-side operations remain available.

## Verification and release contract for both briefs

The current recon has test-slice [] and changes only evidence/WO metadata:
no Vitest/build run is warranted. For future product slices use ONLY their
individually named focused files plus `npm run build` (compilation changes).
Each future scope records actual counts, independent adversarial review,
ownership checks, final-output Tier 2 evidence, and required motion/picture
review under the existing rule 11; this recon grants none of those approvals.
The comparison pin includes per-family generator revisions and automatic
outdated-path regeneration for simulation. Reuse those freshness authorities;
evaluate a Contour revision bump under ADR-0040 if a slice changes emitted
paths for identical authored inputs. Merely wiring new authoring is not evidence
that all old paths should be invalidated. Include saved-file simulation and
Post reconciliation in the same source-dependency tests already named above.
Risk-relevant fixes need the same unchanged regression failing on the exact old
source at the intended assertion and passing on the new commit, with the
required JSON proof after the tested source commit. Feature absence controls
must not fail merely from a missing import/export. Every measured red receives
the required RED JSON line and genuine reds get a pinned-baseline comparison.
No broad test directory, full suite or machine fault reproduction is proposed.

Implement/adapt/reuse decision: implement A1's missing scorer; adapt A2's existing
manual authoring route; wire A0's existing stock authority; adapt B's existing
complete-loop finishing; defer new localized/flip motion to their exact missing
contracts. No general survey or replacement engine is needed before A begins.
