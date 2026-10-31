# Nesting subsystem - HANDOFF

## *** MERGED TO MAIN (HEAD 29f0577, 2026-06-20). P7 SHIPPED + GATE PASSED; P8 nest-scoped generate BUILT then REJECTED + REVERTED; REAL FIX = post fail-loud guard ***
MECHANICAL STATE: MERGED TO MAIN at 29f0577 (2026-06-20); the feat/nesting-engine
branch was deleted post-merge. Last nesting CODE commit before merge was 148cd3c. Gate
at 148cd3c: `npx tsc -b` exit 0; full `npx vitest run` -> 1841 passed / 15 skipped.
Nesting is now DELIVERED in docs/FEATURE-HITLIST.md Part 1. Chat-side: CURRENT (2026-06-20).

THIS SESSION'S P8 ARC (the headline -- read before anything below):
- P8 was first built as a NEST-SCOPED "Generate program" UX (a generate entry point
  hung off the nest: openPostProcessForNest, a "Generate program" nest icon,
  nestGenerationStatus). Commits fdef732..3ffffea.
- OPERATOR REJECTED IT as the WRONG APPROACH. It was fully REVERTED (commit b3ed2fc).
  Generation stays SETUP-scoped via the Post Processor modal ONLY; a nest is GEOMETRY
  data, never a generate entry point. Do NOT rebuild the nest-scoped generate UX
  (the old "P8 SEED PROMPT" block below is now marked SUPERSEDED for this reason).
- THE REAL FIX shipped instead: commit 83bcd99 "fix(post): refuse to post when any
  in-scope op is not up to date". The post now REFUSES to emit when any operation in
  the SELECTED post scope is not 'ready' (i.e. outdated / error / computing /
  pending) -- fail-loud per ADR 0003. This catches a STALE nest: editing a seed flips
  its seed op to 'outdated', and the post refuses rather than emitting a stale
  program. NO nest/geometry UI was added; the Post Processor modal already disables
  Export + shows the diagnostic. P7's expansion contract (the post FORMATS the
  already-expanded multi-copy stream; it invents no travel/order, ADR 0024 Amd 1) is
  UNCHANGED and still in force.
- MERGE DONE: nesting landed on main 2026-06-20 (delivered post-merge note
  5a27325; branch deleted). The old "NEXT = merge prep" plan is HISTORY.
  ACCEPT/GENERATE UX = CLOSED (Operator 2026-06-20): there is NO
  separate accept/generate action -- setup-scoped posting via the Post Processor
  modal IS the deliverable (it already produces the full multi-copy program, and the
  post now refuses a stale/red scope). Do not revisit. The FEATURE-HITLIST Part-1
  move is DONE (nesting is DELIVERED in Part 1, see line above).

ALSO THIS SESSION -- MULTI-STOCK / DIFFERENT-HEIGHT MODEL (ADR 0026, Operator-approved
via docs/qa/002; recon + market research first). DECISION: one stock per setup
(= one WCS = one fixture offset); different-height stocks go in SEPARATE setups,
exported as ONE combined multi-offset .nc (already supported). Matches industry
convention (standard CNC and FreeCAD); no bespoke multi-height-stock
system. SHIPPED this session (all gated green, on feat/nesting-engine):
- 9979477 fix(post): GLOBAL safe-Z retract between work offsets. The combined post
  lifted only to the OUTGOING setup's work-relative clearance; a taller next fixture
  could sit ABOVE that -> cross-offset rapid crash. Now lifts to the max clearance
  across ALL setups in world frame (coords.toWorld), re-expressed per outgoing WCS;
  never G53 Z0. >>> NEEDS OPERATOR'S UCCNC/SIM GATE on a real 2-setup-different-height
  program before trusting on hardware (g-code-output change, not headlessly verifiable).
- e9f3ae4 feat(post): one-stock-per-setup fail-loud guard. setupStockConsistency
  (src/store/stockAssignment.ts) + postProject refuses (SETUP_MULTI_STOCK) a selected
  setup whose ops span >1 stock; steers user to split.
- 148cd3c feat(ui): Setup Properties shows a "Stock conflict" banner before export.
- ADR 0026 (Accepted) records it; 0024+0025 promoted Proposed->Accepted (7db732c).
Backlog (smaller, separate): per-part top-Z on the SAME single stock (the only
single-setup multi-height case industry supports).

OPERATOR'S P7 VISUAL GATE PASSED (all 11 checks, 2026-06-20) on
docs/planning/nesting-p7-livegate.html. Two pieces of feedback drove POST-GATE work
(both shipped + OPERATOR-CONFIRMED this session):
- 04e7879 feat(nesting): expose Cut order at nest CREATION (NestModal selector, not
  just the Properties panel) -- Many-Paths. OPERATOR RE-CHECK PASSED.
- fd4a4d6 fix(setup): smart-pick the setup's stock; force a choice when ambiguous --
  FIXES the Step-9 bug Operator hit (a new setup hard-defaulted to the catch-all auto
  stock, so a nest's setup took Z0 from the 5mm auto stock while the seed ops resolved
  stock-top from the thicker bound sheet -> "Feed (0.5) below top (1.35)" fail-loud).
  Now geometryBearingStockIds (members UNION every NestRecord.boundStockId) +
  pickDefaultSetupStock: lone candidate auto-selected, >1 forces an explicit pick
  (Create disabled in corner mode until chosen), none -> DERIVED_STOCK_ID fallback.
  This CLOSES the "setup stock-default smart-pick" backlog item. REWORKED in
  447c91a after Operator's review: the forced-pick state had rendered as the
  "All stocks (combined bounds)" option (empty value '' backed both) and picking
  it cleared the gate; "All stocks" is also ill-defined for a corner origin
  (corner of the combined AABB of all stocks). Per Operator: REMOVED "All stocks" as
  a corner-origin choice (a corner setup must bind a SPECIFIC stock) + added a
  distinct disabled "-- Select a stock --" placeholder; the gate clears only on a
  real stock id; legacy unbound setups load fine but prompt for a stock on edit.
  OPERATOR RE-CHECK PASSED (2026-06-20): repro 1-3 all good (placeholder shows, Create
  disabled until a specific stock is picked, nest-only auto-selects, no "All stocks"
  option). Repro 4 (legacy unbound setup on edit): CLOSED (Operator 2026-06-20) --
  accepted on the unit-test coverage (SetupModal smoke "legacy unbound" case); no
  live re-verification needed.
ALSO this session: the unrelated machine-default-profile commit (45c3e5c) was
cherry-picked onto its OWN branch `machine-default-profile` (off main, full suite
green) per Operator, so the nesting PR can stay clean. It is STILL in feat/nesting-engine
history too -- when machine-default-profile merges to main first, a later rebase of
nesting drops the duplicate; do NOT rewrite nesting history without a fresh OK.

WHAT I WISH I KNEW AT START (read these 5 first):
1. P7 IS BUILT + visually PASSED. All 6 build-sequence steps of the old "P7 SEED
   PROMPT" (now marked HISTORY below) shipped this session. Do NOT rebuild them.
2. OPERATOR'S P7 VISUAL GATE PASSED (all 11, docs/planning/nesting-p7-livegate.html), and
   BOTH post-gate fixes (cut-order-at-creation + setup smart-pick) are OPERATOR-CONFIRMED
   (the setup fix repro 1-3; repro 4 legacy-edit untested, no old setup available). The
   multi-copy render + simulation are WebGL -- the pure logic (expander, ordering,
   travel, sections, estimate, post) is also unit-tested. P7 + post-gate work is DONE
   and visually signed off; the only open items are P8 and the merge.
3. THE ONE EXPANDER: `expandNest` in src/lib/cam/nesting/instanceToolpath.ts (pure;
   travel seams + ordering + both modes). Store bridge = `buildNestExpansion` and the
   shared render/sim/post section collector = `collectToolpathSections`, both in
   nestRuntime.ts. Viewport, Simulation, post (buildPostInput), and the estimate ALL
   consume these -- do NOT add a second travel model anywhere (ADR 0024 Amd 1).
4. TRAVEL Z is the max of both ops' clearance planes, derived from each seed op's OWN
   resolved moves (`zSpan` = max/min move.z), NOT re-resolved heights. retractMode is
   honored (clearance vs retract). The seam = retract-up-if-needed + rapid-across at the
   safe height; the next copy's own stream plunges. Safety invariant is unit-tested
   (no horizontal rapid below safe Z between copies).
5. NEXT = P8 (accept/generate). [SUPERSEDED: P8 nest-scoped generate was REJECTED
   + reverted b3ed2fc; posting stays setup-scoped. FEATURE-HITLIST IS updated -
   nesting is DELIVERED in Part 1.]

THIS SESSION'S P7 COMMITS (9 work/doc commits + this handoff; all on
feat/nesting-engine, each gated tsc+full-suite green at its commit):
- 7e12a01 docs(adr): ADR 0024 Amendment 1 -- travel+order in software, not post (the
  contract: post invents no travel/order; it formats the already-expanded stream).
- cfd0434 feat(nesting): pure nest expander (expandNest + orderCopies; innermost-first
  then deterministic nearest-neighbor; retract->rapid travel seams; by-operation/by-part;
  15 unit tests incl. the safety invariant).
- b2e29fe feat(nesting): NestRecord.machiningOrder toggle (type + setNestMachiningOrder
  + "Cut order" select in nest Properties; +2 RTL smoke).
- a95ebbe feat(nesting): buildNestExpansion store->expander bridge (derives per-op
  clearance/feed Z from the op's own moves; 6 unit tests).
- 0c08ed3 feat(nesting): Toolpath view + Simulation render the expanded nest
  (collectToolpathSections shared collector; rebuild keys fold nest copy count + cut
  order + origin; +4 unit tests; WebGL render/carve -> Operator's gate).
- 8f530cd docs(nesting): P7 live viewport gate HTML (11 checks incl. the SAFETY
  travel-rides-high check + non-nest regression + uncomputed-nest edge).
- 5d0f0c1 feat(post): emit the expanded multi-copy nest stream (buildPostInput
  substitutes the expansion; PostOperation.nestExpanded flag makes nest DRILL ops skip
  the canned-cycle collapse so their safety travel survives; post test).
- 56525a6 feat(nesting): cut-time estimate counts inter-copy travel (estimateNestCutTimeMs
  times the expanded stream via estimateRuntimeMs; travelExcluded->false; PropertiesPanel
  disclaimer now "incl. inter-copy travel"; rapidRate arg added).
- 650b0f9 docs(ui): UI-ARCHITECTURE 10.6 -- nest toolpath expansion.

=== [SUPERSEDED -- P8 nest-scoped generation was REJECTED + reverted (b3ed2fc); do NOT build this] P8 SEED PROMPT (copy/paste-ready) ===
NOTE (2026-06-20): this seed prescribes a NEST-SCOPED generate UX (openPostProcessForNest,
a "Generate program" nest icon, nestGenerationStatus). That was built then REJECTED by Operator
as the wrong approach and fully reverted (commit b3ed2fc). Generation is SETUP-scoped via the
Post Processor modal ONLY; a nest is geometry, never a generate entry point. The real fix
shipped instead = the post fail-loud guard (commit 83bcd99, see the top status block). Kept
below for HISTORY only -- do NOT rebuild it.
WORK STYLE (standing, non-negotiable): you are the THIN ARCHITECT + QUALITY GATE, not the
primary coder. Your scarce resource is your OWN context window. DELEGATE every heavy chunk
-- recon ("where/how does X work"), implementation, debugging, verification runs -- to
FRESH subagents that invoke liencam-orientation + liencam-execution-cycle and return
~250-350-word digests, with HARD anti-runaway rules (no Monitor/background/dev-server/
polling; each command ONCE foreground bounded; reduce-don't-relaunch; subagents run only
TARGETED test files, never the full suite). YOU run the gates (`npx tsc -b` + full
`npx vitest run`) and commit atomic-green per step. Viewport/sim/g-code are OPERATOR's visual
review -- hand him exact UI click-steps + a p7-livegate-style gate; never claim a path
renders/cuts correctly headlessly. HARD UI GATE: a React RENDER smoke test (RTL,
src/tests/components/) for ANY modal/tree/viewport/properties component touched. Plain
ASCII; conventional commits ending Co-Authored-By + Claude-Session trailers; hand Operator ONE
complete pasted prompt if you need him. Default to the verdict-walkthrough HTML for any
batch of visual decisions. GUARDRAILS: branch feat/nesting-engine; do NOT merge to main
without Operator's fresh explicit OK.
FIRST: confirm Operator PASSED the P7 visual gate (docs/planning/nesting-p7-livegate.html). If
any step Failed, fix the view/sim wiring (Viewport.tsx / SimulationPanel.tsx) before P8.
P8 GOAL = accept/generate: the user-facing "generate the nest program" action (export the
expanded multi-copy g-code via the post) + any accept/finalize UX. READ FIRST: this top
section; ADR 0024 + Amendment 1; src/lib/cam/nesting/instanceToolpath.ts (expandNest) +
nestRuntime.ts (buildNestExpansion, collectToolpathSections); src/lib/post/buildPostInput.ts
(already nest-aware) + PostProcessModal.tsx (the export entry). Most post plumbing is DONE
in P7 -- P8 is mostly the accept/generate UX + verifying the exported g-code on Operator's real
machine/sim. AFTER merge + Operator accept: move nesting into docs/FEATURE-HITLIST.md Part 1 +
bump "Last verified against HEAD".
=== END P8 SEED PROMPT ===

## [SUPERSEDED 2026-06-20 -- P7 is now BUILT; section below is the pre-build record] *** P6 GATE PASSED (2026-06-20) -- P7 REDIRECTED + PLANNED, NOT BUILT (fresh session next) ***
MECHANICAL STATE: branch feat/nesting-engine, working tree CLEAN, HEAD 62b2840. NOT
merged to main. Gate: `npx tsc -b` exit 0; full `npx vitest run` -> 1773 passed / 15
skipped (last run this session). Chat-side fields: CURRENT (2026-06-20).

WHAT I WISH I KNEW AT START (read these 5 first):
1. P6's live viewport gate is DONE and PASSED -- Operator ran all 8 steps + the rotation
   deviation, all green (after the two render fixes below). The old "AWAITING GATE"
   section beneath this one is HISTORY.
2. P7 IS REDIRECTED. ADR 0024 section 3 (post replicates copies + invents inter-copy
   travel) is REJECTED by Operator. Inter-copy travel + machining ORDER must be generated
   + visualized + simulated IN SOFTWARE as real ToolpathMove[]; the post only FORMATS.
   Reason: rapids can crash clamps/vises/workholding, so they must be seen + simmed.
   Do NOT build the post-expansion design from the OLD P7 section lower in this file.
3. P7 is FULLY PLANNED + Operator-approved (the SEED PROMPT below). Do not re-litigate the
   decisions -- build them.
4. There is NO clamp/fixture/collision model anywhere in the app (recon-confirmed).
   P7 = generate/visualize/simulate travel so Operator judges clamp risk BY EYE. Automated
   collision-avoidance is a SEPARATE future feature, explicitly OUT of P7 scope.
5. The architecture is OPTION (b): keep each op's seed toolpath stored SEED-LOCAL
   (preserves P6 frame-invariance), add ONE shared nest-level EXPANDER that produces
   the full multi-copy stream; viewport + sim + post + estimate all consume it. Do NOT
   bake the expansion into op.toolpathMoves (option a -- breaks seed-local invariance).

THIS SESSION'S COMMITS (5 work commits below + this handoff c2a3ce1 = 6; all on
feat/nesting-engine, each work commit tsc+full-suite green):
- f1cade0 fix(nesting): P6 render fixes. Live gate found Simulate drew the carve+tool
  at the WORLD ORIGIN (raw seed-local moves) while the toolpath render offset to the
  slot; and moving the bound stock did not re-render (rebuild key omitted seed pose).
  Added two PURE helpers in instanceToolpath.ts -- renderMovesForGeo(localMoves, geo)
  (shared render gate: pass-through for non-seed, seedSlotMoves for an owned seed) and
  seedPoseKeyForGeo(geo) ("" for non-seed, pos+effZrot for a seed). Wired into
  Viewport.tsx + SimulationPanel.tsx. Non-seed byte-identical.
- 3a0855e docs(nesting): P6 live-gate HTML (docs/planning/nesting-p6-livegate.html) --
  interactive Pass/Fail checklist + clipboard export (reusable for re-gates).
- 4873ca4 fix(nesting): WCS Fix A (REAL bug). A part_feature/snap WCS bound to a seed
  did not ride a bound-sheet move (seed is no-stock -> only moves in translateBoundNest,
  which ran AFTER the WCS appliers). Fixed moveFixedStockLive + updateFixedStock to
  re-derive snap WCS from coupled.geometry (post-shift). All 3 WCS modes now honor
  Operator's invariant in the nest case: stock-relative rides the sheet, geometry-relative
  follows the seed, machine/manual stays put.
- 45c3e5c feat(machine): default-machine profile + load-time choice prompt (UNRELATED
  to nesting -- Operator raised it mid-session). AppSettings.defaultMachineId (persisted) +
  "Set as Default" button + badge in MachineLibraryModal; newProject binds the default;
  pure machineNeedsChoice(machine, library) (missing/unknown-id/generic -> true); App
  effect raises transient machineChoiceRequired -> MachineChoiceModal (forced pick,
  pre-selects default, no silent switch). A known non-generic machine is honored
  silently. NB: this is on feat/nesting-engine; OFFER to cherry-pick onto its own
  branch so the nesting PR stays clean (Operator aware, his call -- needs fresh OK).
- 62b2840 fix(viewport): clearScene now disposes nestGroups. New/Open both route
  through clearScene, which cleared everything EXCEPT nests, so the prior project's
  nest lingered until refresh. (Also fixed the projectOpen test stub to init nestGroups.)

OPERATOR'S OTHER REVIEW FEEDBACK (open items, NOT yet built -- prioritized by Operator):
- [P7, chosen next] in-software travel+order redirect (the SEED below).
- [CLOSED at 447c91a] SETUP STOCK DEFAULT smart-pick -- SHIPPED (pickDefaultSetupStock +
  geometryBearingStockIds in src/store/stockAssignment.ts + SetupModal.tsx). See the top
  status block: lone candidate auto-selected, >1 forces an explicit pick, none ->
  DERIVED_STOCK_ID fallback. (Listed as open in this pre-P7 record; superseded.)
- [LARGER, backlog] TREE-WIDE "FAIL UP": a collapsed parent (setup/folder/nest) must
  show a consistent indicator when a descendant needs recompute / has an error, across
  all tree display modes. Operator wants this designed consistently (do a verdict-walkthrough
  first). Triggered by: moving the stock needs a toolpath regen, and a collapsed setup
  gave no signal that a child op was stale.

=== P7 SEED PROMPT (copy/paste-ready; Operator-approved 2026-06-20) ===
WORK STYLE (standing, non-negotiable): you are the THIN ARCHITECT + QUALITY GATE, not
the primary coder. Your scarce resource is your OWN context window. DELEGATE every heavy
chunk -- recon ("where/how does X work"), implementation, debugging, verification runs --
to FRESH subagents that invoke liencam-orientation + liencam-execution-cycle and return
~250-350-word digests, with HARD anti-runaway rules (no Monitor/background/dev-server/
polling; each command ONCE foreground bounded; reduce-don't-relaunch; subagents run only
TARGETED test files, never the full suite). YOU run the gates (`npx tsc -b` + full
`npx vitest run`) and commit atomic-green per step. Viewport/sim/g-code are OPERATOR's visual
review -- hand him exact UI click-steps + a re-run of docs/planning/nesting-p6-livegate.html
style gate; never claim a path renders/cuts correctly headlessly. HARD UI GATE: a React
RENDER smoke test (RTL, src/tests/components/) for ANY modal/tree/viewport/properties
component touched. Plain ASCII; conventional commits ending Co-Authored-By + Claude-Session
trailers; hand Operator ONE complete pasted prompt if you need him. Default to the
verdict-walkthrough HTML for any batch of visual decisions (esp. toolpath order review).
GUARDRAILS: branch feat/nesting-engine; do NOT merge to main without Operator's fresh explicit
OK. PLAN-FIRST is DONE for P7 -- decisions below are FINAL, build them; only re-plan if you
hit a contradiction.
READ FIRST (in order): this top section; ADR 0024 (you will AMEND it -- step 1); the shipped
helpers src/lib/cam/nesting/instanceToolpath.ts (instanceMoves, orderPlacementsInnermostFirst,
expandSourceMoves [per-placement groups, NO travel, NO flatten -- extend this],
seedSlotMoves, renderMovesForGeo, seedPoseKeyForGeo); src/lib/cam/nesting/nestRuntime.ts
(estimateNestCutTimeMs, travelExcluded:true today); src/lib/cam/moves/index.ts (rapidEntry,
plungeTo, retractFrom -- the retract->rapid->plunge vocab to REUSE) + src/lib/cam/drill2d.ts
(first-region-clearance / between-region-retract-rapid-plunge model + resolveHeights);
src/lib/post/emit.ts ~367-427 (per-op per-move walk, ZERO nest concept -- if op moves were
already the full multi-copy stream it formats them unchanged). Invoke liencam-orientation
-> liencam-execution-cycle.
APPROVED DESIGN (FINAL):
- ARCHITECTURE = option (b): per-op toolpaths stay SEED-LOCAL; ONE shared nest-level
  EXPANDER (extend expandSourceMoves) produces the full multi-copy ToolpathMove[] with
  inter-copy travel + ordering + NestRecord.origin world offset. Consumed identically by
  the Toolpath view, Simulation, post emit, and the cut-time estimate. Seam consumers:
  Viewport.tsx (render effect using renderMovesForGeo), SimulationPanel.tsx (frame build
  + pre-carve), emit.ts (per-move walk), nestRuntime.ts (estimate). NB the expander is a
  NEST-LEVEL op (spans ALL seed ops of a nest + cross-source ordering) -- NOT a per-op
  render gate; decide re-derive-on-demand vs cache (lean on-demand, memoize by a nest key
  if perf needs it).
- MACHINING ORDER = NestRecord.machiningOrder: 'by-operation' (DEFAULT) | 'by-part'
  (user-selectable TOGGLE). by-operation = each op across all copies (internal features on
  all parts before any cutoff -> parts stay anchored; fewer tool changes). by-part = all
  ops on copy1, then copy2 (frees parts as you go). BOTH must be supported. Toggle lives on
  NestRecord, exposed in NestProperties (Many-Paths). (Operator: "Default By-Operation, Option
  By-Part".)
- COPY VISIT ORDER within an op = innermost-first (orderPlacementsInnermostFirst, windowed
  children before hosts) THEN deterministic NEAREST-NEIGHBOR (minimize rapids; deterministic
  tie-break so byte-stable).
- INTER-COPY TRAVEL = retract -> rapid -> plunge, reusing moves/index.ts primitives +
  each op's existing retractMode + resolveHeights (clearanceZ/retractZ/feedZ). NO new height
  vocabulary (ADR 0002).
- COLLISION = visualize + simulate ONLY. No auto-avoidance (no model exists). Out of scope.
- ADR 0024/0001 REFRAME: ADR 0001 = post emits no GEOMETRY, it FORMATS ToolpathMove[].
  Generating real travel moves (so they are seen/simmed) is a SOFTWARE concern; the post
  still only formats the already-expanded stream. Capture this in the ADR 0024 amendment.
BUILD SEQUENCE (each its own gated atomic commit):
1. ADR 0024 AMENDMENT -- record the redirect + every decision above (the contract).
2. NEST EXPANDER (core) -- extend expandSourceMoves into the full pure expander: flatten +
   insert inter-copy travel (heights/linking) + ordering (innermost-first then nearest-
   neighbor) + origin + both machiningOrder modes. HEAVILY unit-test (travel inserted,
   ordering, both modes, origin, byte-stable).
3. NestRecord.machiningOrder + setter + NestProperties toggle (types + store + PP), RTL smoke.
4. Toolpath VIEW + SIMULATION consume the expander (show ALL copies + travel) -- OPERATOR VISUAL
   GATE (re-run / extend the p6-livegate HTML).
5. POST emit formats the expanded stream for seed ops; estimateNestCutTimeMs COUNTS travel
   (drop travelExcluded). Post round-trip/unit test.
6. DOCS -- UI-ARCHITECTURE + this HANDOFF refresh; after merge + Operator accept, move nesting
   into FEATURE-HITLIST Part 1 (P8 = accept/generate).
=== END P7 SEED PROMPT ===

## [P6 GATE PASSED 2026-06-20 -- the section below is the pre-gate record; superseded by the top] *** P6 INSTANCED TOOLPATH - SHIPPED (2026-06-19) ***
P6 (ADR 0024 section 2) DONE on feat/nesting-engine. HEAD 170be7c, working tree
clean, full suite green (184 files / 1735 tests). NOT merged to main. Five atomic
commits on top of a76b8b7:
- 3d080b6 Item 1: computeOperationToolpath skips the geometry-pose bake
  (transformLoopPoints) for any loop whose geometry has ownerNestId -> a seed op's
  toolpathMoves are stored in the SEED-LOCAL 2D frame (origin = part canonical
  origin), NOT the slot pose. Non-seed byte-identical. ALSO fixed: the '__all__'
  geometry resolver pulled owned seeds (they carry loops) into standalone all-parts
  ops -> now filtered on ownerNestId === undefined. Test seedLocalToolpath (4).
- 9f7ad58 Item 2: PURE P7 transform src/lib/cam/nesting/instanceToolpath.ts:
  instanceMove/instanceMoves (world = origin + M(p).local; maps endpoint + arc
  center; preserves z/feed/role/engagement/arc-dir), orderPlacementsInnermostFirst
  (depth DESC, instanceId tie-break), expandSourceMoves (innermost-first per-
  placement groups; inter-copy travel DEFERRED to P7). Test (9).
- 902fd34 Item 4: PURE estimateNestCutTimeMs(nest, ops) in nestRuntime.ts = sum
  seed-op per-copy estimate x placement count; travelExcluded:true. Test (6).
- 4bd3474 Item 3b: NestProperties shows "Est. cut time: ~T (N copies, excl.
  inter-copy travel)" (formatDurationHMS; neutral 'pending seed toolpaths' when no
  seed op computed). RTL smoke test extended.
- 170be7c Item 3a: seedSlotMoves(localMoves, geometry) offsets a seed op's local
  toolpath by the seed geometry pose (reuses instanceMoves; uses
  effectiveZRotationDeg to match how the seed LOOPS render) so it draws ON the seed
  slot + tracks nest moves. Wired into Viewport.tsx toolpath-render effect, gated on
  ownerNestId (non-seed byte-identical). Test (4). Viewport = WebGL, not jsdom-
  testable -> LIVE GATE below.

SEED-AUTHORING GAP FIXES A/B/C (seed authoring was BLOCKED until these - found on
Operator's FIRST live test; the original "P6 complete" claim was premature because the
headless tests never ran a seed op end-to-end):
- a473a15 (A) STOCK BLOCKER: a seed op failed "not assigned to any stock" (seeds
  are no-stock by design, ADR 0025 Amd 2). New pure effectiveStockIdForCompute
  (src/store/stockAssignment.ts) resolves an owned seed's stock from the owning
  nest's boundStockId (ADR 0025 Amd 3), substituted at the membership guard + the
  resolveTopZ/resolveOwningStock inputs via a compute-only shallow copy (the real
  seed stays no-stock). Fail-loud if the nest has no bound stock. Test
  seedStockResolution (3); seedLocalToolpath fixture updated to a bound nest.
- 83e3d7b (B) VIEWPORT PICK: "Pick from viewport" could not pick a seed's loops
  (owned seeds suppressed from standalone render). Seed-slot loop lines now join
  selectableObjects; pure resolveLoopPickGeoId (nestRender.ts) maps a hit to the
  seed geoId; amber highlight works. nestRender.test +7; fixed the
  reactiveStockRebuild stub to init nestGroups (updateSelectableObjects traverses
  it now).
- d03b974 (C) SELECTION UX (longstanding, Operator-raised): real "Unselect all" + no
  snap-back to all. Modal-only userClearedLoops flag distinguishes untouched-empty
  (=all, compute contract UNTOUCHED - empty=all is hardwired in every op algo) from
  explicitly-cleared (=none -> Create disabled + warning, ADR-0003). Stale
  setPickedLoops fixed. NewOperationModalLoops.smoke (3).

DESIGN DECISION (load-bearing): seed toolpaths are stored in the LOCAL frame
(frame-invariant; survives nest moves with no staleness; trivial P7 = origin +
M(p)). The cost (seed op toolpath would draw at origin) is paid by the Item 3a
render offset. Operator approved this + my Q1/Q2 recommendations (render in P6;
existing select-seed-then-New-Operation authoring flow).

OPERATOR'S LIVE VIEWPORT GATE (P6 visual sign-off - WebGL not headlessly verifiable;
REAL on-screen labels, corrected after the first jargon attempt):
1. In the left Design tree Geometry header click the LayoutGrid (grid) icon ->
   the nest dialog. Use "Add part..." to import a 2D part, set a quantity,
   Calculate, Accept. (Importing through the dialog consumes the standalone copy,
   so the only thing named after your part is the seed.) The seed renders at the
   nest's lower-left slot.
2. In the Setups section header click "+" (Add setup) and create a setup.
3. On the setup row click "+" (Add operation), or the "Add Operation" button ->
   the New Operation wizard (tabs: Type & Name, Tool, Geometry, Passes, Heights,
   Linking, Feedrate).
4. Geometry tab -> the "Source geometry" dropdown -> pick your part by name (that
   entry is the seed). OPTIONAL (Item B): click "Pick from viewport", then click a
   loop ON the seed in the viewport -> it highlights amber + joins the selection.
   (Item C: every loop box starts checked = all; "Unselect all" clears with no
   snap-back; explicit-empty disables Create with a warning.) Finish the wizard.
5. The op computes (Item A makes a seed op resolve its stock from the nest's bound
   sheet - no "not assigned to any stock" error).
6. Viewport mode tabs (Setup | Toolpath | Simulate | Sketch) -> "Toolpath".
   EXPECT: the toolpath sits ON the seed at its lower-left slot, NOT at the origin.
7. Move the nest's bound stock (click the stock body + drag the gizmo, or type a
   Position in Properties). EXPECT: the toolpath tracks the seed (incl. rotation).
8. Select the nest node -> Properties -> "Est. cut time" reads "~<time> (N copies,
   excl. inter-copy travel)" (or "pending seed toolpaths" before step 5).
DEVIATION TO CONFIRM: Item 3a uses effectiveZRotationDeg (matches the seed-loop
render convention) not raw rotation.z - correct under the gizmo quaternion->Euler
round-trip; confirm the toolpath stays glued to the seed under rotation.

P7 IS NEXT (ADR 0024 section 3): the POST replicates each seed op's LOCAL toolpath
per placement in the per-op motion block (emit.ts ~367-427) using the SHIPPED pure
helper expandSourceMoves(localMoves, placements, NestRecord.origin) - innermost-
first - inserting inter-copy retract->rapid->plunge travel (heights the pure helper
does NOT own), then the NestRecord.origin world offset, then the existing toWork.
P7 SEAM: an op is a seed op iff its params.geometryId resolves to a geometry with
ownerNestId set; that op's toolpathMoves are already seed-local. The post has ZERO
nest concept today (buildPostInput/assemble/emit) - P7 adds it. estimateNestCutTime
Ms already expands instances honestly (travel excluded until P7 adds linking moves).
Then P8 = accept/generate + move nesting to FEATURE-HITLIST Part 1 after merge +
Operator accept.

---

## [PRIOR SESSION] Last updated: 2026-06-19 (SESSION CLOSE / PAUSE POINT). N1d sheet-as-stock +
thickness COMPLETE; D3 move-coupling APPROVED. THEN a unified STOCK click-to-move
feature + Properties-panel stock fields + a Properties-panel dark restyle shipped
(awaiting Operator's viewport visual gate on the stock-move + restyle - all committed
green). N1d DOCS REFRESH DONE (ADR 0025 Amendment 3 + UI-ARCHITECTURE 10.5). Icon
commonality CLOSED = keep as-is (seed=Pencil, root=PenTool). Operator chose to PAUSE
here; NEXT = P6 in a FRESH session. POST-CLOSE FIX (4862807): typed stock-position
edits in the Properties panel were reverting (the viewport `sceneStockRebuildKey`
omitted fixedStock.position so the box never rebuilt, + a stale gizmo handle);
fixed - the key now (pure buildSceneStockRebuildKey) encodes position, and the
gizmo sphere follows a typed edit (CNCViewport.setStockGizmoPosition). Also fixed
plain fixed stocks (typed moves silently did nothing). Branch: feat/nesting-engine.
HEAD at update: 4862807 (+ this handoff commit). Working tree: clean. NOT merged to
main. Gate: `npx tsc -b` exit 0; `npx vitest run` -> 180 files / 1710 tests passing
(10 files / 15 skipped), last run this session. SESSION BASELINE at start was 9206327.

## *** NEXT-SESSION SEED PROMPT (P6 instanced toolpath) - copy/paste-ready ***
WORK STYLE (standing, non-negotiable): you are the THIN ARCHITECT + QUALITY GATE,
not the primary coder. Your scarce resource is your OWN context window. DELEGATE
every heavy chunk - recon ("where/how does X work"), implementation, debugging,
verification runs - to FRESH subagents that invoke liencam-orientation +
liencam-execution-cycle and return ~250-word digests, with HARD anti-runaway rules
(no Monitor/background/dev-server/polling; run each command ONCE foreground bounded;
reduce-don't-relaunch; subagents do NOT run the full vitest suite, only targeted
files). YOU run the gates (`npx tsc -b` + full `npx vitest run`) and commit atomic
-green per item. The viewport/g-code is OPERATOR's visual review - hand him exact UI
click-steps + sim/backplot artifacts, never claim a path renders/cuts correctly
headlessly. HARD UI GATE: a React RENDER smoke test (RTL, src/tests/components/) for
ANY modal/tree/viewport/properties component touched. Plain ASCII; conventional
commits ending with the Co-Authored-By + Claude-Session trailers; hand Operator ONE
complete pasted prompt if you need him. Default to the verdict-walkthrough HTML for
any batch of visual decisions (esp. toolpath role/order review).
GUARDRAILS: branch feat/nesting-engine; do NOT merge to main without Operator's fresh
explicit OK. PLAN-FIRST + confirm with Operator before building (P6/P7 touch the
toolpath/post boundary + cut-ordering - costly to get wrong).
READ FIRST (in order): this HANDOFF top, ADR 0024 (the instanced toolpath +
post-expansion CONTRACT - this is what P6/P7 implement), ADR 0025 + all 3 amendments,
docs/planning/NESTING-SPEC.md. Invoke liencam-orientation -> liencam-planning-cycle.
P6 GOAL (ADR 0024 §2): compute a source part's toolpath ONCE against the SEED (the
seed already IS the authoring geometry - ops bind to it by Operation.geometrySelections
/ geometryId, so NO new op-binding plumbing; this was confirmed by the old N1b recon).
Capture/subtract the seed's LOCAL pose so the stored toolpath lives in the seed's
local 2D frame (ADR 0024's named cost: "P6 must define how the source pose is captured
and subtracted"). P7 (ADR 0024 §3): the POST replicates per placement in the per-op
motion block (emit.ts ~367-427, NOT the operation layer) via M(p)=translate(p.x,p.y).
rotate(rotationDeg) on endpoints + arc centers (z/feed/role/arc-dir untouched),
inserting inter-copy retract->rapid->plunge travel, ordered INNERMOST-FIRST (depth
-descending; windowed children before hosts) per ADR 0024 §3 / SPEC C3. P8 = accept/
generate + move nesting to FEATURE-HITLIST Part 1 AFTER merge + Operator accept.
KEY FACTS the post MUST honor: NestRecord.origin is the nest WORLD origin (the post
applies it so the whole nest sits where the bound stock is - moving the stock moved
origin, D3). placements[].partId + sources[].geometryId point at the OWNED seed copy
ids (ownerNestId). Seeds are explicit no-stock; the nest's CUT stock is the bound
FIXED stock (boundStockId, ADR 0025 Amendment 3). estimateRuntimeMs must expand
instances (or report per-source x N) to stay honest (ADR 0024 "Negative/costs").
WHAT I WISH I KNEW: (1) replication is a POST concern (ADR 0001) - do NOT emit 40x
ToolpathMove[] from the operation/store layer. (2) The seed is not a separate object;
it is an owned geometry the ops already target. (3) origin + boundStockId are the two
new NestRecord fields the post/estimate consume.

## *** STOCK MOVE UX (general, off the D3 review) - SHIPPED; viewport gate pending ***
Operator, reviewing D3, asked to improve how stock is MOVED. Audit found: (1) a desync
BUG - the tree gizmo "blue" state was DesignTree-local (activeStockGizmoId), separate
from the viewport TransformControls, so an empty-viewport click detached the gizmo
but left the icon stuck blue (needed an off/on toggle); (2) stock was tree-icon-only
to move, unlike geometry (click-the-mesh). Operator chose UNIFIED CLICK-TO-MOVE (fixed
stocks; auto stocks scoped out - no position). Commits on top of the N1d handoff
commit a420a4a:
- 618fec8 viewer.selectedStockId = ONE shared selection owner (tri-exclusive with
  geometry/nest/op; teardown on stock removal). 
- bf0d9b9 desync FIX: tree icon + gizmo both derive from selectedStockId via one
  effect (drivenGizmoIdRef gates it -> one history push per enter); empty-click
  clears it. 
- 7b55cd2 viewport click-to-move: fixed-stock boxes tagged userData {kind:'stock',
  stockId, movable} + added to selectableObjects (movable only); pure
  resolveViewportPick(hits) = part-first (GEOMETRY wins on overlap) then movable
  stock; onStockSelect -> setSelectedStock (gizmo follows the effect). 
- ec77c7a Properties-panel stock fields: selecting a fixed stock shows editable
  W/H/D + Position X/Y/Z (writes updateFixedStock - same action as the tree node +
  gizmo, Many-Paths); nest-bound shows a "W/H nest-driven, regenerate on re-pack"
  hint; auto stocks = read-only derived summary. 
- 60b38b0 docs: "Properties panel as a first-class edit surface" principle into
  CONVENTIONS.md + UI-ARCHITECTURE.md (§7 + §15.4 deferred PP-coverage audit) +
  FEATURE-HITLIST.md Part 2. (Operator: leverage the Properties panel everywhere; deep
  PP-coverage audit DEFERRED until nesting lands - see memory
  feedback_properties_panel_first_class_edits.)
AWAITING OPERATOR'S VIEWPORT VISUAL GATE: (bug) click stock icon -> gizmo+blue, click
empty -> gizmo gone AND un-blues, click again -> gizmo back (no toggle dance);
(workflow) click a fixed stock body/edge -> selects+gizmo, click a part over it ->
part wins, click empty -> deselect, auto stock not clickable; (PP) select a fixed
stock -> editable W/H/D+position, edits agree with the tree node.
ICON COMMONALITY (CLOSED 2026-06-19): Operator delegated the call; decided KEEP AS-IS
(seed=Pencil, root=PenTool). Full commonality would force layer rename off the
Pencil onto double-click-only - not worth the UX churn for a minor consistency gain.

## *** PROPERTIES-PANEL RESTYLE + first-class principle (SHIPPED) ***
- 60ddd6b style(props): the panel's bright-white inputs/buttons were orphaned/missing
  CSS, not bad colors. Inputs now use the existing dark `.props-number-input`
  (var(--bg-input) + accent focus) + a scoped `.properties-panel input` fallback;
  `.props-btn` defined with variants - Recompute = `.props-btn-accent` (filled),
  Explode = `.props-btn-danger` (ghost, red on hover). Direction A from the design
  review (docs/planning/properties-panel-restyle-verdicts.html). Operator delegated the
  pick ("make it cohesive"); awaiting his browser look.
- ec77c7a Properties-panel now shows editable fixed-stock W/H/D + Position fields
  (FixedStockProperties); auto stocks = read-only summary. Many-Paths via
  updateFixedStock.
- 60b38b0 "Properties panel as a first-class edit surface" is now a documented
  STANDING PRINCIPLE (CONVENTIONS.md + UI-ARCHITECTURE §7/§15.4 + FEATURE-HITLIST
  Part 2). DEFERRED (until nesting lands): a deep-dive audit of underutilized
  Properties-panel details per selection + operation mode. See memory
  feedback_properties_panel_first_class_edits.

## *** N1d (sheet-as-FIXED-stock + thickness) - SHIPPED; D3 awaiting visual review ***
Operator approved all 6 verdict cards (docs/planning/nesting-n1d-verdicts.html, N1d-1..6)
+ 2 polish fixes. DECISION CHANGE vs the original plan: the nest's bound sheet stock
is a FIXED stock (explicit bounds, movable, directly-editable depth), NOT an auto
stock - auto stocks are strictly member-derived (deriveStockBounds), and the seeds
are deliberately no-stock, so a sheet-sized stock has to be a fixed/explicit stock.
THICKNESS MODEL: thickness is a MATERIAL property = the bound stock's depth; the
modal selector + Settings default only SEED it; re-pack regenerates XY but never
touches depth. Commits on top of 9206327:
- aa60dd3 types: NestRecord += thickness/boundStockId/origin; AppSettings +=
  defaultStockThicknessMm(12)/defaultStockPaddingXYMm(0) + setters.
- 96e960d settings: SettingsModal "Nesting" section (default thickness + padding).
- 4ca51fa modal: always-shown "Thickness (Z)" selector (prefill from the setting,
  remembered via lastNestSettings) -> record.thickness.
- c812cb9 bind: applyNestResult auto-creates a fixed stock "<nest> stock" sized
  sheet+2*pad x depth=thickness at position {origin-pad, z:0}; re-pack regenerates
  XY, preserves depth; D4 (Stock panel visible+editable) is free.
- 9eb85c7 many-paths thickness: setNestThickness canonical action + editable
  "Thickness (Z)" in NestProperties (first first-class PP edit) + reverse-sync so
  editing the bound stock depth in the tree mirrors record.thickness. (Operator's "Many
  Paths to Same Result" UX principle - see that memory; OWED future PP-edit study.)
- 1beb174 lifecycle (D2): removeNest removes the bound stock (one undo restores
  both); explodeNest KEEPS it + assigns the baked parts to it.
- d1884a7 / 74b7f94 polish: seed-layer edit-in-sketch -> Pencil (root layer rows
  stay PenTool to avoid a rename-Pencil collision; OPEN offer to Operator: full
  commonality would move rename off Pencil); nest modal footer Calculate reads
  clickable (primary while live), not muted.
- 654dd48 D3 move-coupling: moving the bound fixed stock moves the nest group +
  seed pose (NestRecord.origin += delta; placements stay relative => no
  double-translate; seeds no-stock so translateStockMembers never moves them twice);
  wired into moveFixedStockLive + updateFixedStock. AWAITING OPERATOR'S VISUAL GATE.
KEY MODEL FACT for P6: NestRecord.origin is the nest world origin - the post must
read it when expanding instances. DOCS DEBT (NOT done yet): add an ADR 0025
amendment (bound = FIXED stock, not auto; thickness=stock depth), refresh
UI-ARCHITECTURE (Stock/nest), and move nesting in FEATURE-HITLIST only after P6-P8
land + merge. NEXT = P6 instanced toolpath against the seed (ADR 0024) - recommend a
FRESH session.

## *** SEED-MODEL REDO COMPLETE - THE OWNED-SEED MODEL (2026-06-19) ***
THE NEXT SESSION'S HEADLINE. The earlier "in-nest lower-left seed via a source-flag
provenance model" guidance from the prior handoff is now SUPERSEDED - it shipped as
PASS 1, Operator reviewed it, and his P5 verdict REDIRECTED the architecture. PASS 2
re-architected it into the OWNED-SEED model that is now in the tree. The seed redo
and ADR 0025 reconcile are DONE. Operator's ROUND-2 review APPROVED all six cards
(B1-B6) on 2026-06-19. What remains = the deferred NEXT PASS = seed EDITABILITY.

### SEED EDITABILITY PASS - SHIPPED + ROUND-3 PASSED (2026-06-19)
Operator chose this next (over N1d). Built in 3 atomic stages, all gated green;
Operator ran round-3 and PASSED C1/C2/C3 (C2 decided: keep in-situ rotated editing):
- Stage A (13673c8): seed child row gets per-layer edit-sketch / lock / delete +
  a New-layer button, reusing the EXACT root-geometry handlers + gating (the
  deep-copy preserves format/locked/projection). Viewport nest-seed reactive key
  extended to loopsVersion + layer-id set (nestSeedContentKey) so add/delete-layer
  + loop edits re-render the seed slot live. Still NO whole-seed hide icon.
- Stage B (55b62c5): EDIT-AT-SLOT. Chosen mechanism = DISPLAY OFFSET, NOT loop
  baking (loops stay in the clean local frame for P6 / ADR 0024). Part 1:
  applyNestResult records each owned seed's home (position/rotation) = its
  lower-left slot pose. Part 2: the sketch LAYER + overlays are display-offset by
  the edited geo's pose (identity for normal geos -> no change), and the
  interaction seams (sketchClientToWorld + pick/marquee) inverse-map the pose so
  clicks/snaps/new entities land correctly. Solver coords unchanged. ROTATION is
  included (rotated slot edits rotated) - flagged for Operator (translation-only is a
  one-line change if he prefers). NOT jsdom-testable (needs GL) -> Operator visual gate.
- Stage C (b021c6f): RECOMPUTE-ON-EDIT. NestRecord.needsRecompute (PERSISTED) set
  via markOwningNestStale on setGeometryLoops + deleteGeometryLayer when the geo is
  an owned seed (NOT on visibility/color/lock or empty addLayer); cleared in
  applyNestResult on a fresh pack. UI: highlighted RefreshCw on the nest row
  (nest-recompute) + a stale banner + Recompute button in NestProperties
  (nest-recompute-props), both calling the existing recomputeNest. No auto-repack.
Round-3 verdict doc: docs/planning/nesting-seed-editing-verdicts.html (C1-C3).

### [SHIPPED 2026-06-19 - N1d done as sheet-as-FIXED-stock; follow the P6 SEED at the TOP] NEXT-SESSION SEED PROMPT (N1d sheet-as-auto-stock) - copy/paste-ready
WORK STYLE (standing, non-negotiable): you are the THIN ARCHITECT + QUALITY GATE,
not the primary coder. Your scarce resource is your OWN context window. DELEGATE
every heavy chunk - recon ("where/how does X work"), implementation, debugging,
verification runs - to FRESH subagents that invoke liencam-orientation +
liencam-execution-cycle and return ~250-word digests, with HARD anti-runaway rules
(no Monitor/background/dev-server/polling; run each command ONCE foreground bounded;
reduce-don't-relaunch; subagents do NOT run the full vitest suite, only targeted
files). YOU run the gates yourself (`npx tsc -b` + full `npx vitest run`) and commit
atomic-green per item. The tree/viewport is OPERATOR's visual review - hand him exact UI
click-steps, never claim a render works headlessly. HARD UI GATE: a React RENDER
smoke test (RTL, src/tests/components/) for ANY modal/tree/viewport/properties
component touched. Plain ASCII; conventional commits ending with the Co-Authored-By
+ Claude-Session trailers; ONE complete prompt if you need Operator. Default to the
verdict-walkthrough HTML for any batch of visual decisions.
GUARDRAILS: branch feat/nesting-engine; do NOT merge to main without Operator's fresh
explicit OK. PLAN-FIRST + confirm with Operator before building (N1d is visual-gated +
touches the coordinate hierarchy).
READ FIRST (in order): this HANDOFF top (THE SHIPPED MODEL facts below), ADR 0024 +
ADR 0025 (incl. both amendments), docs/planning/NESTING-SPEC.md "COHESION", and the
SUPERSEDED-marked N1d section LOWER in this file for the RECON + the D1-D4 decisions
(already made - do NOT re-ask). Invoke liencam-orientation -> liencam-planning-cycle.
N1d SCOPE: bind the nest's sheet to an AUTO stock (AutoStockItem) created on
Calculate/Accept; re-size on re-pack; moving the stock moves the sheet+parts (D3
pinned); delete-nest removes the stock (D2), explode keeps it (D2); the bound stock
shows in the Stock panel (D4). Add a THICKNESS (Z) selector to the nest UI (2D parts
have no Z) + DEFAULT thickness + padding fields in the global SETTINGS panel (top
toolbar - it EXISTS, grep SettingsModal; EXTEND it) that the nest thickness + the
auto stock autoOffsetXY/depth read as prefill (D1). AutoStockItem (types ~323) has
NO depth field today - add one. NOTE: owned seeds are currently explicit NO-STOCK
(stockId undefined + stockIdLocked) - N1d must decide how the nest's bound auto stock
relates to the owned seeds (they are nest content, sized by the SHEET, not members).
THEN: P6/P7 instanced toolpath against the seed (compute once per seed, replicate per
placement via linking moves, innermost-first per ADR 0024) -> P8 generate.
DOCS DEBT: when N1d lands, refresh ADR 0025 / UI-ARCHITECTURE / this HANDOFF; move
nesting toward FEATURE-HITLIST Part 1 only after P6-P8 land + merge + Operator accepts.

### OPTIONAL POLISH BACKLOG (not blockers; Operator-flagged)
- UI NOMENCLATURE SHEET (Operator 2026-06-19): a glossary naming every UI element (the
  bottom-left "status bar" = .status-bar in App.tsx; design tree; workspace/viewport;
  properties panel; etc.) so code comments + the eventual customer wiki use the SAME
  terms. Future doc task; confirm an element's real in-code name before documenting.

### THE SHIPPED MODEL (carry these facts forward)
- The nest OWNS a deep COPY of each source as its seed. The owned-seed geometry is
  tagged `ImportedGeometry.ownerNestId === nestId`. createNest deep-copies loops /
  layers / sketches (stable loop ids per ADR 0019), sets the seed to explicit
  NO-STOCK (`stockId` undefined + `stockIdLocked` so the catch-all auto stock never
  wraps it), and the nest references the COPIES (sources[].geometryId +
  placements[].partId = copy ids).
- Ties to the ORIGINAL are broken at creation. A pre-existing workspace original
  stays an independent root geometry; deleting it does NOT break the nest. A fresh
  modal "Add part..." import is CONSUMED (deleted after copying) via the new
  createNest `consumeSourceIds` param - only fresh-this-session modal imports are
  consumed; pre-existing originals are left alone.
- SUPPRESSION + DELETE + EXPLODE all key on `ownerNestId`:
  - standalone-render + tree-root suppression use selector `nestOwnedGeometryIds`
    (replaced the old `ownedSeedGeometryIds`).
  - removeNest deletes all geometries with `ownerNestId === nestId`.
  - explode bakes each per-placement copy as an independent geometry
    (`ownerNestId` undefined) and paints it to the viewport immediately
    (__cncViewport.add2DGeometry); the pre-existing original survives explode.
- SEED IS SELECTABLE with per-layer visibility:
  - `seedPlacementIds` = the lower-left marked slot (the seed render position).
  - the seed child row selects the owned-seed geometry (Properties shows it) and
    expands into per-layer rows with a visibility eye.
  - toggling a layer hides/shows its loops live in the seed slot via pure
    `visibleSeedLoops(loops, layers)` in restoreNestsToViewport + a reactive
    `nestSeedVisKey` effect in Viewport.tsx; expand state persisted via uiPrefs
    `expandedSeedIds` (default collapsed). NO whole-seed hide icon (a lone-seed
    hide is meaningless; hide the whole nest instead).
- EDIT FLOW: the modal keeps the original nest alive until Accept, so a provisional
  createNest always copies a LIVE geometry. Cancel restores cleanly.
- LEGACY: `CreateNestParams.sources.ownedByNest` is now legacy / ignored (kept only
  for buildNestSources type-compat). The provenance flag from PASS 1 is gone -
  ownerNestId on the copy is the truth now.

### PASS 1 (the source-flag model - SHIPPED then SUPERSEDED by PASS 2)
Verdict cards P1-P6 (docs/planning/nesting-seed-redo-verdicts.html, commit 92612cb):
- 2573e54 foundation: NestRecord source `ownedByNest` flag + selectors
  seedPlacementIds / ownedSeedGeometryIds.
- 3859a88 viewport: seed renders at the lower-left slot with real per-layer colors;
  dropped the old floater halo.
- a928d73 viewport toolbar toggle for the violet seed-outline box
  (ViewerState.showSeedOutline, default on).
- db48b3c tree: suppress modal-imported seeds from standalone rows.
- a883ae9 modal: flag "Add part..." imports ownedByNest.
- 785b01b removeNest removes owned sources.
- cb53739 ADR 0025 amendment (the FIRST amendment - source-flag provenance).
OPERATOR'S PASS-1 VERDICTS (2026-06-19): P1 Approve (a floating original is BY DESIGN
for a pre-existing workspace part). P2 Approve w/ issues (per-seed hide icon was a
no-op; seed action icons needed design). P3 Approve - KEEP the outline box. P4
Approve w/ bugs ("Add part" checkbox should default checked; nest from an EMPTY
workspace + modal Add part produced a phantom seed at the origin, not in the tree,
vanishing on refresh). P5 Modify - THE ARCHITECTURAL REDIRECT: "nesting creates a
self-contained integrated SEED that lives in the nest; break ties to the original;
all ties go to the in-nest seed" + bugs (stale seed badge after delete; deleting
the source part broke the nest). P6 Undecided (explode needed a viewport refresh).

### PASS 2 (the re-architecture per P5 + bug fixes - the SHIPPED model above)
Operator's PASS-2 DECISIONS: (1) STAGE IT - this pass = model flip + explode + selectable
seed with layer-visibility; NEXT pass = add/delete layers + sketch editing on the
seed + recompute-on-edit. (2) REMOVE the per-seed hide icon. (3) Recalc-on-edit =
MARK STALE + a Recompute button (not auto), to land next pass.
- 9bd8f2b Stage 1 MODEL FLIP: nest owns a deep copy (ownerNestId); consumeSourceIds
  consumes fresh modal imports; suppression/delete re-keyed to ownerNestId via new
  selector nestOwnedGeometryIds. Fixes P5b (delete original safe), P5a (no stale
  badge), P4a/c (no floater; seed persists as a real geometry). "Add part" include
  checkbox defaults checked.
- 0481f7e Stage 2 EXPLODE: paints baked per-placement copies to the viewport so
  exploded parts appear immediately (P6); owned-seed removal re-keyed to ownerNestId;
  baked copies independent; pre-existing original survives explode.
- 164d585 Stage 3 SELECTABLE SEED: seed row selectable -> Properties; expandable
  per-layer rows with a visibility eye; visibleSeedLoops + nestSeedVisKey drive live
  seed-slot layer visibility; expandedSeedIds persisted; no whole-seed hide icon.
  Deferred: add/delete layers, sketch edit, recompute-on-edit.
- 12632ff round-2 verdict HTML docs/planning/nesting-seed-rework-verdicts.html
  (cards B1-B6).

CURRENT STATE: clean, gate green, AWAITING OPERATOR'S ROUND-2 VISUAL REVIEW
(docs/planning/nesting-seed-rework-verdicts.html B1-B6).

## *** NEXT-SESSION SEED PROMPT (copy/paste-ready) ***
WORK STYLE (standing, non-negotiable): you are the THIN ARCHITECT + QUALITY GATE,
not the primary coder. Your scarce resource is your OWN context window. DELEGATE
every heavy chunk - recon ("where/how does X work"), implementation, debugging,
and verification runs - to FRESH subagents that invoke liencam-orientation +
liencam-execution-cycle and return ~250-word digests, with HARD anti-runaway rules
(no Monitor/background/polling; run each command ONCE foreground, bounded timeout;
reduce-don't-relaunch). YOU run the gates yourself (`npx tsc -b` + full `npx vitest
run`) and commit atomic-green. The tree/viewport is OPERATOR's visual review - hand him
exact UI click-steps, never claim a render works headlessly. HARD UI GATE: a React
RENDER smoke test (RTL; pattern src/tests/components/) for ANY modal/tree/viewport
component touched. Plain ASCII; conventional commits; hand Operator ONE complete prompt
if you need him. Default to the verdict-walkthrough HTML for any batch of visual
decisions.
GUARDRAILS: branch feat/nesting-engine; do NOT merge to main without Operator's fresh
explicit OK (his instruction this work-stream; also the standing no-branch-surgery
rule). PLAN-FIRST and confirm with Operator before building visual-gated work.
READ FIRST (in order): this HANDOFF (esp. "THE SHIPPED MODEL" + "KEY MODEL FACTS"
below), ADR 0024 + ADR 0025 (esp. the SECOND amendment 2026-06-19), docs/planning/
NESTING-SPEC.md. Invoke liencam-orientation -> liencam-planning-cycle.
NEXT-SESSION ORDER:
1. Apply any round-2 Modify/Reject verdicts from
   docs/planning/nesting-seed-rework-verdicts.html (B1-B6).
2. NEXT PASS seed editing: add/delete layers + edit the seed sketch +
   recompute-on-edit (mark stale + a Recompute button, NOT auto). NOTE:
   recomputeNest exists in the store but is currently UNUSED - wire it.
3. N1d sheet-as-auto-stock + thickness + Settings-panel defaults. NOTE: owned seeds
   are currently EXPLICIT NO-STOCK - N1d binds the nest sheet to an auto stock. Add
   default autostock THICKNESS + PADDING fields to the global SETTINGS panel (top
   toolbar "Settings" - grep for it, it EXISTS; EXTEND it); nest thickness selector
   + auto stock autoOffsetXY/depth read defaults from there. Auto-create+bind an
   AutoStockItem on Calculate/Accept; re-size on re-pack; delete-nest removes the
   stock, explode keeps it; parts pinned to the sheet; bound stock shows in the
   Stock panel. AutoStockItem (types) has NO depth field today - add one.
4. P6/P7 instanced toolpath (compute once per seed, replicate per instance via
   linking moves; innermost-first per ADR 0024) -> P8 generate.
ALREADY DECIDED (do NOT re-ask): the owned-seed model (nest owns a deep copy,
ownerNestId, ties to original broken); seed editing is STAGED for the next pass;
no per-seed hide icon; recalc-on-edit = mark stale + Recompute button; D1 thickness
+ padding defaults live in the global Settings panel; D2 delete-nest removes its
stock / explode keeps it; D3 parts pinned to sheet; D4 bound stock visible+editable
in the Stock panel.

## KEY MODEL FACTS to carry forward (the owned-seed model)
- nest OWNS its seed (geometry.ownerNestId === nestId, a deep copy).
- nestOwnedGeometryIds(project) drives standalone-render + tree-root suppression.
- seedPlacementIds = the lower-left marked slot (seed render position).
- owned seeds are EXPLICIT no-stock (stockId undefined + stockIdLocked).
- visibleSeedLoops(loops, layers) + the nestSeedVisKey effect drive seed-slot
  per-layer visibility.
- edit flow keeps the original nest alive until Accept (provisional copies a live
  geometry).
- consumeSourceIds = fresh-this-session modal imports only (consumed/deleted after
  copying); pre-existing originals stay independent.
- CreateNestParams.sources.ownedByNest is LEGACY/ignored (kept for buildNestSources
  type-compat).

## N1a REVIEW FOLLOW-UPS (2026-06-18) - Operator reviewed N1a, PASSED with fixes
Operator's verdict: A/B/C/D all PASS. Fixes he asked for, all SHIPPED + gated green:
- 3c25255 feat(tree): N1a review polish - reorder Geometry header actions to
  Import, Empty Layer, Folder, Nest; declutter the nest row (dropped placed/left/
  util/time meta -> it lives in the Properties panel; row now mirrors a folder
  with a quiet source-part count + transient 'computing...').
- 49a347d feat(tree): drag-reorder folders AND nests (mirrors geometry reorder;
  GripVertical handle gutter reserved on every folder/nest row, drag enabled only
  when >1; new store actions reorderGeometryFolder + reorderNest; folder/nest
  drags independent; geo->folder re-parent drop preserved).
- 03eb030 fix(stock): re-point setups when their bound auto stock is DELETED.
  Operator repro: geo on auto stock A + setup WCS bound to A -> delete A, create B,
  reassign geo to B, reapply WCS -> setup FALSELY flagged "WCS stock reference is
  missing" (op recomputed fine). ROOT CAUSE: removeAutoStock re-pointed the
  deleted stock's GEOMETRY members but never its SETUPS, leaving a dangling
  wcs.stockId that the (correct) tree predicate reports. Fix =
  repointSetupsAfterStockRemoval (re-point to surviving catch-all DERIVED_STOCK_ID
  else unbind), wired into removeAutoStock. Test src/tests/store/
  wcsStaleStockId.test.ts (fail-first, 3/3 after). Tree predicate UNCHANGED.
  SECONDARY (RESOLVED - no code needed): Operator's saved file carries the same stale
  id, but the real load path HEALS it - migrateProjectToHierarchy (migrateHierarchy
  .ts:186-194) UNCONDITIONALLY re-adds a stock-derived-migrated PhysicalStock to
  project.stocks every migrate, so the dangling wcs.stockId resolves on reload
  (verified by running the actual .camproject through the load path: flagged=true
  pre-migrate, false post-migrate). Fully explains Operator's "save+reload clears it";
  no load-time heal added. Two cold investigations could NOT repro from the
  screenshots alone; Operator's exact step sequence (delete stock -> recreate -> reassign
  -> reapply WCS) + "save+reload clears it" was the key (LIVE staleness from
  removeAutoStock, NOT a persistence write bug).

## [SUPERSEDED 2026-06-19 by the OWNED-SEED model above] N1b/N1c history below
The sections from here down (N1b DECISIONS / N1c EXPLODE / N1d NEXT and older) are
the PRE-redo history. The violet floater-halo seed, the source-flag provenance, and
the "absorb source" explode they describe were all REPLACED by the owned-seed model
(see "THE OWNED-SEED MODEL" at the top). Kept for history only; do NOT follow this
guidance.

## N1b DECISIONS MADE (Operator) - seed authoring, build IN FLIGHT
Operator answered the 3 questions:
- SEED COLOR (nuanced, HARD constraint): in the general workspace the seed should
  be DISTINCT from the nest COPIES, BUT this must NOT recolor the seed's loops -
  its per-LAYER colors must stay fully visible so Operator can zoom in and select
  geometry by feature when building seed toolpaths. => design "R1": distinguish the
  seed by a NON-loop means (seed-colored bounding outline/halo + tree badge),
  loops keep layer colors. (R2 alternative = flat seed color in overview that
  switches to layer colors in toolpath/selection mode - NOT chosen; offer if R1
  reads wrong on visual review.)
- MARKER: both viewport AND tree. - MULTI-NEST: binary is-a-seed (no per-nest).
BUILT (d71b868): pure seedGeometryIds(project)/isSeedGeometry (seedSelectors.ts);
CNCViewport.setSeedGeometryIds attaches a violet (--vp-seed #b06bff) padded-AABB
wireframe HALO per seed (separate THREE.LineSegments child, loops' per-layer
materials UNTOUCHED); Viewport.tsx reactive effect keyed on seedHaloKey; tree
Sprout badge (--vp-seed, "Seed (nest source)") on the source-geo row + nest
source-child rows. Tests: seedSelectors (3) + DesignTree badge smoke (3); full
suite 167 files/1607 green.
AWAITING OPERATOR'S VISUAL REVIEW (viewport not headlessly verifiable):
- Create a nest, look at the source part in the workspace: it should carry a
  violet rectangular wireframe frame (the seed halo) distinct from the nest
  copies, while its loops keep their layer colors (zoom in - layer colors must
  still show for feature selection). Tree: source-geo row + nest child rows show
  a green-ish Sprout icon.
- OPEN halo-STYLE question for Operator: the halo is a padded (0.5mm) local-AABB BOX
  wireframe (thin rectangular frame just outside the part). Confirm that reads
  right, or prefer a HULL outline / different color. Easy to swap.
## N1c EXPLODE - DONE (1c8eba0), awaiting Operator's visual review of the layout
Operator chose Option A: ABSORB the source. explodeNest(nestId) (store ~1190-1340 after
removeNest): each placement -> independent ImportedGeometry at its packed pose
(source loops deep-copied + M(p)=translate(x,y).rotate(rotationDeg) per ADR 0024;
loop ids re-minted via assignStableLoopIds per ADR 0019; new uuid; name
`${source} n`; pose baked into points, position/rotation zeroed; segments/sketches
dropped). Absorbs nest.sources[] EXCEPT a source shared by another nest. Removes
nest + disposes viewport instances; single pushHistory (one undo); clears
selectedNestId. UI: confirm-guarded Ungroup button on the nest tree row
(testid nest-explode) + an Explode button in NestProperties (nest-explode-props).
Tests: explodeNest.test.ts (4) + smoke. Full suite 168 files/1612 green.
VISUAL REVIEW: explode a nest, confirm the parts land as independent geometries
at the packed sheet layout (at root, no folder), the originals are gone, the nest
node is removed, and one Ctrl+Z restores everything.

## N1d NEXT (the last N1 stage) - sheet-as-auto-stock + thickness selector
Not started. Scope (ADR 0025 contract 3, Operator pre-confirmed auto-binding on
Calculate/Accept): nest sheet binds to an AUTO stock created automatically; stock
re-sizes on re-pack; moving the stock moves the sheet + all parts; add a THICKNESS
(Z) selector to the nesting UI (2D parts have no Z). Depends on N0 (done).
RECON (from N1b pass): NestModal numeric controls = useState sheet{w,h} (~77) +
spacing (~80) via sheetInputsFor(solver) (~298,394-419) - thickness field drops
in there. AutoStockItem (types:323) = {id,name,autoOffsetXY,autoOffsetZTop} - NO
depth field today; N1d adds a depth source. addAutoStock (store:2669),
rederiveDerivedStockBounds (store:377), setStockMembership (store:2066).
N1d DECISIONS - ANSWERED by Operator (verdict export 2026-06-19):
- D1 THICKNESS DEFAULT = Modify: do NOT hardcode a default. Add a setting in the
  global SETTINGS panel (top toolbar "Settings") where the user defines DEFAULT
  autostock THICKNESS *and* PADDING values; the nest thickness selector (and the
  autostock XY padding/offset = autoOffsetXY) read their defaults from there.
  Fresh session: grep for the Settings panel/modal (it exists - top toolbar) and
  ADD the two default fields (thickness Z + padding XY); thread them as the
  prefill for the nest thickness input + the auto stock's autoOffsetXY/depth.
  (Relates to the long-planned "global Settings panel + STL tolerance" item.)
- D2 LIFECYCLE = Approve: DELETE nest -> remove its auto stock too; EXPLODE -> KEEP
  the stock, exploded parts stay assigned to it (it becomes a normal auto stock).
- D3 MOVE-COUPLING = Approve: parts pinned to the SHEET; sheet origin rides the
  stock origin, so moving the bound stock translates the whole nest (sheet+parts).
- D4 STOCK VISIBILITY = Approve: the nest's bound stock appears in the Stock panel
  as a NORMAL auto stock (visible + editable), consistent with the unified model.
ALSO: V1 (N1a tree polish) = Approve (final - header order, declutter, drag-reorder
confirmed). V2/V3 superseded by the refined seed model (redo). WCS live confirm:
not separately reported but the fix is in + tested; Operator can re-confirm anytime.
RECOMMEND building N1d in a FRESH session AFTER the seed-model redo (N1b/N1c),
since N1d's sheet-as-stock binds to the nest whose seed model is changing. Order
in the fresh session: (1) seed-model redo (N1b in-nest seed + N1c explode) + ADR
0025 amendment, (2) N1d sheet-as-auto-stock + Settings-panel thickness/padding
defaults. Largest remaining stage - modal + store + viewport + coordinate
hierarchy.

## N1a nest-as-geometry-node (2026-06-18) - DONE, REVIEWED + PASSED (polish above)
Built autonomously (Operator AFK, authorized "work autonomously, get shit done").
Adopted all 4 plan recommendations: Q1 quantity stays modal-only (tree shows xN);
Q2 nests render after folders; Q3 Properties = read-only summary; Q4 ADR 0025
covers all of N1. Four atomic green commits on top of 142889c:
- 100d49b docs(adr): 0025 nest-as-geometry, seed, sheet-as-stock (Proposed) -
  EXTENDS (not supersedes) ADR 0024; 3 contracts (node / seed / sheet-as-stock);
  phasing N1a-d. README row added.
- 6fd375d feat(store): viewer.selectedNestId + setSelectedNest, mutually exclusive
  with geometry/op selection (every geo/op select site clears nest; removeNest
  clears it). Transient (viewer slice, not persisted). Test: src/tests/store/
  selectedNest.test.ts (11 pass).
- 8681f14 feat(tree): DesignTree nest = folder-like node. New LayoutGrid header
  button (data-testid tree-new-nest-geo) creates a nest; source parts = child
  "layer" rows (name + xN, display-only); per-nest collapse persisted via uiPrefs
  collapsedNestIds (mirrors collapsedFolderIds). Row click -> setSelectedNest
  (selected style = tree-item-geo-active). Pencil still reopens the modal.
  Standalone "Nests" section REMOVED; nestsExpanded gone. Smoke test:
  src/tests/components/DesignTreeNest.smoke.test.tsx (5 pass).
- fc87431 feat(props): PropertiesPanel nest branch (top priority, after sketch
  short-circuit) = read-only NestProperties summary (sheet WxH, style, spacing,
  solver, seed, per-source name+qty, placed/left, utilization, computeTime + hint
  "Edit in the nest modal"). Smoke test: src/tests/components/
  PropertiesPanelNest.smoke.test.tsx (3 pass).

OPERATOR'S VISUAL REVIEW CLICK-STEPS (do before continuing to N1b):
1. Open the app; in the left Design tree, the "Geometry" section header now has a
   4th icon (LayoutGrid grid icon) next to new-sketch/new-folder/import. There is
   NO separate "Nests" section anymore.
2. Click the LayoutGrid icon -> the existing nest modal opens. Pick a part, qty,
   Calculate, Accept. The nest appears as a FOLDER-LIKE row inside the Geometry
   section (after any folders). Expand it (chevron) -> its source parts list as
   child rows with an "xN" quantity badge.
3. Click the nest row (not its action buttons) -> the right Properties panel shows
   the nest's settings (sheet size, style, spacing, solver, seed, sources, placed/
   left, utilization, compute time). Selecting a geometry/op deselects the nest
   (and vice versa).
4. Pencil on the nest row -> the modal reopens prefilled (edit). Eye = hide/show,
   Trash = delete. Rename by double-click. Confirm collapse state survives reload.
VERDICT NEEDED: does the tree node + Properties summary look right? Any layout/
copy tweaks? Then N1b unblocks.

## N1b - recon DONE, scoped THIN, awaiting Operator's design+color confirm
RECON VERDICT (2026-06-18): N1b is small. The "seed" already IS the existing
source ImportedGeometry - createNest (store:4828) references geometry BY ID
(sources[].geometryId), never copies it; ops already bind to geometry by id via
Operation.geometrySelections (types:485). So "plan ops against the seed" needs
ZERO new op-binding plumbing; the compute-once-replicate-per-placement work is
explicitly ADR 0024 P6/P7, NOT N1b. N1b's ONLY real work = recognize a geometry
as a nest seed (= it is referenced by some nest's sources[]) and give it distinct
coloration. Coloration seams found: 2D loops color PER-LAYER at CNCViewport.ts
:3784-3818 (layerColor map -> LineBasicMaterial; refreshLoopColors at :3400);
nest INSTANCES color by depth at addNestInstances :3871/:3911 (depth0=
--vp-loop-default, depth1=--role-stepover). A distinct seed tint hooks the
per-loop material at :3795 (source geo) and/or the instance mat at :3911.
DECISIONS FOR OPERATOR (N1b is purely visual, so these need his eye, not a solo build):
- Q-color: distinct seed TINT vs reuse the part's original layer colors? (spec/ADR
  lean "distinct".)
- Q-where: mark the seed in the VIEWPORT (tint loops), the TREE (badge/icon on the
  source geometry row), or BOTH?
- Q-multi: if one geometry is a source for multiple nests, still just "is a seed"
  (binary) - confirm binary is fine for v1.
Once answered, N1b is a ~1-commit build (coloration + a render smoke test).

## N1d - recon noted (for later, depends on N0 done): thickness + auto-stock
NestModal numeric controls are useState sheet{width,height} (NestModal.tsx:77) +
spacing (:80), rendered via sheetInputsFor(solver) (:298,:394-419) - a THICKNESS
(Z) field drops in alongside. AutoStockItem (types:323) = {id,name,autoOffsetXY,
autoOffsetZTop} with NO depth field; bounds computed by rederiveDerivedStockBounds
(store:377) from members; created via addAutoStock (store:2669), membership via
setStockMembership (store:2066). N1d adds a depth source + auto-creates/binds an
AutoStockItem on Calculate/Accept (Operator-confirmed auto-binding). Has a visual
(stock box) outcome -> Operator-gated.

---
PRIOR (pre-N1a) state was HEAD 2797204; ALL 7 N0/N0.1 re-test items Operator-verified
2026-06-18 (reactive render, expand-on-load, empty-stock zero-out, per-stock
offsets, None dropdown, setup-stock picker restored, no work-origin clobber,
auto-bound setup not falsely flagged invalid).

## N0 + N0.1 + debug sweep (2026-06-18) - the STOCK-MODEL refactor
Context pivot (Operator): before P6, make nesting cohesive with the geometry/stock
model. N0 (first, standalone) shipped MULTIPLE named AUTO stocks coexisting with
fixed stocks. Then N0.1 (Operator review feedback) reshaped the Stock panel, which
RIPPLED (we hinge setups/render/sizing on stock) - a 3-chain deep-debug audit
found + fixed 8 knock-on bugs. State below; N1 (nest-as-geometry) is NEXT.

CONFIRMED DECISIONS (Operator ruling 2026-06-18):
- Auto-stock MEMBERSHIP = explicit (you assign parts to a stock); auto stock
  sizes to exactly its members.
- Nest<->auto-stock binding (N1d) = automatic on Calculate/Accept.
- Nest controls (N1) = reuse the existing MODAL for create/edit (pencil reopens
  it); clicking a generated nest node shows its settings in the PROPERTIES PANEL
  (panel inherits from the NestRecord; room to grow into quick-edit later).
- New nest icon in the Geometry header = LayoutGrid (confirmed).
- Geometry stock dropdown has a "None" option; a CNC op on a no-stock part FAILS
  LOUD (ADR-0003).
- Default stock: every project ALWAYS carries >=1 default auto stock (the
  catch-all made VISIBLE, id===DERIVED_STOCK_ID, name "Auto Stock 1"); new
  imports auto-land in it. Removed the AUTO/FIXED mode toggle + global offset
  fields; `sceneStock.mode` FIELD kept (stuck 'auto') for back-compat readers.

NEW STOCK MODEL (how it works now):
- sceneStock.autoStocks[] (AutoStockItem {id,name,autoOffsetXY,autoOffsetZTop})
  + fixedStocks[] coexist; each maps to a twin PhysicalStock in project.stocks
  (auto=mode'derived', fixed=mode'explicit'). syncAutoStocksToPhysical /
  syncFixedStocksToPhysical keep twins; rederiveDerivedStockBounds sizes derived
  twins from members (geo.stockId===id) with PER-ITEM offsets.
- Membership: setStockMembership(geo, id|null) (assign locked / clear to
  catch-all), setGeometryNoStock(geo) (explicit None). resolveStockMembershipState
  -> named / catch-all / none. Empty derived stock collapses to ZERO bounds
  (viewport skips it).
- Viewport rebuildStock renders ONLY named stocks (no legacy union box);
  Viewport.tsx has a REACTIVE effect rebuilding on stocks/sceneStock/geometry.
- Setups: applyAutoStockToSetups is now STOCK-ID-AWARE (skips fixed-bound WCS =
  no work-origin clobber; auto-bound WCS re-derive from THEIR stock; unbound =
  legacy whole-scene union). SetupModal stock picker is mode-agnostic, lists all
  named stocks from project.stocks, binds wcs.stockId + originBinding on save.

COMMITS (this sweep, oldest->newest after the parked baseline 0232f7a):
N0: f6c664b, 8a4f087, 1672753, ab89fae, 9b473d2, 5eeccf4.
N0.1 data: 71aba83, a3b0c2c, 59a3d72, 3206c46(test). N0.1 ui: 0d18025, d8847df,
b083e77, 2bdf3de, 9307e3a(test). open-fix: c1f3957.
debug fixes: f06b339(empty zero-out), d3d7070(per-stock offsets), b317f8b(expand
on load), d266628(reactive rebuild), 0c6d5b4(stock-id-aware WCS), c1d7b16(picker
restore), d2a7ef8(SetupModal smoke), 2797204(don't flag auto-stock-bound setups
invalid - the tree stockInvalid check only knew fixedStocks). handoff: fb9332e.

KNOWN/DEFERRED (not blockers): fully retiring `sceneStock.mode` (still read by
SetupModal multi-fixed projection + reanchorProjectionLayers + dispatchGeo) is a
later pass. Bug "3" (fixed-bound WCS not re-deriving on stock MOVE) turned out a
non-issue - moveFixedStockLive/updateFixedStock already re-derive unconditionally.
Viewport reactive effect could not get a jsdom mount smoke test (WebGL); covered
by a store-path test instead. Docs (UI-ARCHITECTURE Stock section) to backfill
after Operator signs off.

NEXT: on Operator's sign-off -> N1 (new ADR nest-as-geometry+seed+sheet-as-stock,
then N1a nest=Geometry-tree folder node w/ LayoutGrid). Then P6 instanced
toolpath. The original P4-era seed/roadmap is below (unchanged).

---
PRIOR (P4) HANDOFF STATE - HEAD was 39c498f before this sweep:
Last updated: 2026-06-17 (P4 COMPLETE + signed off; pack-time UX + bug/infra
hardening). Gate state then: 156 files / 1528 tests.

## WHAT I WISH I KNEW AT START (read these 5 first)
1. SOLVER SEMANTICS are the #1 footgun: engine `fixSheet` = MAX-QTY FILL (Qty is
   a RATIO, scales the set to fill the sheet); `fixSheetExact` = exact qty on a
   fixed WxH (packNest); `fixQty/none|width|height` = exact qty, solve sheet;
   `fixQtyRatio` = exact qty, solve sheet at a fixed W:H aspect. runNest=solveNest;
   packNest is the inner exact packer. Do NOT "fix" fixSheet to honor exact counts.
2. NestRecord PERSISTS solver + sources + computeTimeMs + rotationCount; status/
   error are TRANSIENT (stripped in persistPartialize). Edit/recompute rely on this.
3. UI/modal changes MUST get a React RENDER smoke test - tsc+vitest miss hooks-
   order bugs. RTL is now installed; pattern at src/tests/components/
   NestModal.smoke.test.tsx (jsdom + localStorage shim + mount-then-openModal;
   vite.config include needs *.test.tsx). A hook after `if(!isOpen) return null`
   = "Rendered more hooks" crash. See [[feedback_render_gate_ui_changes]].
4. The modal's re-Calculate does removeNest(old)+createNest (NOT recomputeNest) so
   edited controls take effect; recomputeNest is currently UNUSED by the modal.
5. utilization = part-area/sheet (CORRECT, arrangement-independent when all fit) -
   do NOT "fix" it.

## P4 nesting INTERFACE - DONE + SIGNED OFF (P4.1-P4.3 + hardening)

## P4 nesting INTERFACE - DONE + SIGNED OFF (P4.1-P4.3)
Replaced the TEST button with a real NestModal. All committed + full-suite green.
- P4.1 (9a67c37): NestModal shell + part picker (include/qty/orientation-lock) +
  inline "Add part..." import (shared importGeometryFile) + Calculate -> createNest
  -> live render. Pure buildNestSources (unit-tested). Operator signed off (with fix).
- FIX (0f3cec3): Calculate honored qty wrong - default solver fixSheet (= max-qty
  FILL, qty is a RATIO) packed 5+3 -> 16. Now defaults fixQty; NestRecord PERSISTS
  `solver` + recomputeNest REUSES it (was hardcoded fixSheet -> silent revert).
- P4.2 (75a2730): full Solver/Style/Spacing controls + provisional Accept/Cancel
  flow (re-Calculate replaces provisional to honor edited controls) + spinner +
  in-modal result summary + FAIL-LOUD NEST_ERROR (applyNestError sets record
  status='error'; persistPartialize strips transient status/error).
- FIX (0f6dbd6): added SolverMode `fixSheetExact` (packNest on a fixed WxH = exact
  qty + leftovers) as its own mode; kept `fixSheet` (fill, Qty=ratio) separate;
  truthful per-part placed/requested summary + loud shortfall warning (role=alert).
- P4.3a (c848fe8): Nests header "+" ICON button (matches Geometry/Setups); solver
  dropdown reorder + default = fixSheet-exact; REMEMBER last-used controls
  (useUiPrefs.lastNestSettings + pure mergeNestSettings validator), prefill on open.
- P4.3b-1 (c44b1f9): SolverMode `fixQtyRatio` (smallest sheet of a fixed W:H aspect
  that fits EXACT qty; binary-search; invalid ratio -> solveMinArea + ADR-0003
  warn) + auto-size "Constrain to sheet ratio (W:H)" checkbox/inputs.
- P4.3b-2 (351c349): per-row EDIT (pencil) -> reopens modal prefilled from the
  record (solverStateFromMode inverse map incl ratio; picker rows from sources;
  rotationCount stored on NestRecord); Accept REPLACES (deletes old), Cancel keeps
  it + restores visibility; transient store nestEditTarget (not persisted).
SOLVER MODES (engine SolverMode -> modal SolverChoice): fixSheetExact='Fixed sheet,
exact quantity' (DEFAULT) | fixSheet='Fill sheet (max quantity, by ratio)' | fixQty
none/width/height='Exact quantity auto-size / lock width / lock height' | fixQtyRatio
=auto-size + ratio checkbox. NOTE: utilization = part-area/sheet (CORRECT, do not
"fix"). Operator SIGNED OFF the full P4.3 batch 2026-06-17 (all 5 points pass).
- PACK-TIME UX (c1391dd): nest COMPUTE TIME on the tree row ("... . 4.2s", same
  formatComputeMs as ops; NestResult/NestRecord.computeTimeMs, rides persistence)
  + a live "Packing... Ns" timer + hint in the modal while computing (no real
  progress bar yet - see backlog).
- POST-SIGNOFF HARDENING: hooks-order crash fix (adc3e31 - the QW2 timer useEffect
  was below `if(!isOpen) return null`; moved above); ratio W:H inputs compact CSS
  so the modal stops h-scrolling (02dc233); RTL + NestModal render smoke test gate
  (39c498f), PROVEN to fail on the reintroduced hooks bug. All Operator-verified.

## P3 instanced data model + render - DONE (awaiting Operator VISUAL review)
- P3.1 (bafaa0a): NestRecord + Project.nests? (rides persistence); Web Worker
  COMPUTE_NEST/NEST_COMPLETE protocol (pack off the UI thread); runNest seam;
  store actions createNest/recomputeNest/renameNest/removeNest/setNestVisible.
- P3.2 (44c89ef): CNCViewport.addNestInstances (sheet outline + one posed Group
  per placement from the SINGLE source loops; depth-0/1 colored); nestRender.ts
  pure transform helper (tested); restoreScene re-instances on load; live-render
  on worker completion; removeNest disposes viewport.
- P3.3+P3.4 (2269fcc): "Nests" section in DesignTree (renameable rows + placed/
  left/util summary + hide/delete + "computing..." state); "NEST (TEST)" trigger
  button (qty 4, 300x300mm, ninety, seed 1 - TEMPORARY defaults, replaced by P4).
P3 VISUAL SIGN-OFF RECEIVED 2026-06-17 (Operator: nest of 16 Leadscrew mounts packed
clean on the sheet; visibility toggle + delete work). HEAD now df29f73.

NEXT = P5 preview interactivity (nudge/rotate/lock a placement + re-pack around
locked parts) + the inside-window picker popout -> P6 instanced TOOLPATH (compute
once/source,
transform per instance) -> P7 POST expansion (single toolpath + travels -> full
g-code, innermost-first cut order) -> P8 accept/generate + FEATURE-HITLIST. P6/P7
implement ADR 0024. P4.2's recomputeNest is currently UNUSED by the modal (re-
Calculate creates fresh to honor edited controls) - keep or revisit in P5.

## Nesting BACKLOG (tactical enhancements - Operator 2026-06-17)
- [DONE c1391dd] NEST COMPUTE TIME on the tree row + cheap-interim live "Packing...
  Ns" timer + hint in the modal.
- [OPEN] REAL NEST PACK PROGRESS BAR (Operator: "phase+fraction so it's not hung").
  The live elapsed timer landed (c1391dd) as the cheap interim; the real bar is
  still open. The worker COMPUTE_NEST path calls runNest as one async with NO
  onProgress (toolpaths thread onProgress; nesting does not). Build: thread a
  progress callback through runNest -> the solvers emit fractional progress (each
  binary-search probe in solveFixSheet/solveMinArea/solveLockedAxis/solveRatio + GA
  generations in ga.ts), worker posts a NEST_PROGRESS message, store/modal show a
  bar (e.g. "probe 3/~8"). A true time ETA is unreliable (per-pack time swings with
  part vertex count); prefer phase+fraction. Medium effort.

SESSION CHECKPOINT (2026-06-17): P4 (the whole nesting INTERFACE) COMPLETE +
Operator-signed-off, plus pack-time UX + bug/infra hardening. Everything committed
(HEAD af2fc02), tree clean, full suite green (156 files / 1528 tests). NOT merged
to main (awaiting Operator's explicit merge OK - do NOT merge without it).
STRATEGIC PIVOT (Operator 2026-06-17): P5 (preview interactivity) is PARKED (maybe
never - "more complexity than it is worth"; nesting works well as-is). Before P6,
build the NEST-COHESION direction so nesting is a first-class part of the geometry/
stock model. Full requirements + the 4 resolved decisions are in
docs/planning/NESTING-SPEC.md "COHESION + multi-auto-stock". Seed below.

## NEXT-SESSION SEED (N0 multi-auto-stock, then N1 nest-cohesion)
WORK STYLE (standing): you are the thin ARCHITECT + QUALITY GATE, not the primary
coder; your scarce resource is your own context. DELEGATE every heavy chunk (recon,
impl, debug, verify) to FRESH subagents that invoke liencam-orientation +
liencam-execution-cycle and return ~250-word digests with HARD anti-runaway rules
(no Monitor/background-relaunch/polling; run each cmd ONCE foreground bounded;
reduce-don't-relaunch). YOU audit digests, run gates yourself (tsc -b + full vitest
run), commit atomic green. The tree/viewport is OPERATOR's visual review - hand him
exact UI click-steps, never claim render works headlessly. Plain ASCII; conventional
commits; one complete prompt if you need him.
GATE FOR UI WORK (HARD, learned this session): add/extend a React RENDER smoke test
(RTL is installed; pattern at src/tests/components/NestModal.smoke.test.tsx) for ANY
modal/tree/viewport component you change - tsc+vitest MISS hooks-order/render bugs
(we shipped a "Rendered more hooks" crash). vite.config include already matches
*.test.tsx. See [[feedback_render_gate_ui_changes]].
READ FIRST: this HANDOFF (esp. "WHAT I WISH I KNEW" + the SolverMode map), then
docs/planning/NESTING-SPEC.md "COHESION + multi-auto-stock" (N0/N1 + the OPEN DETAILS
to confirm with Operator), ADR 0024, and [[project_coordinate_hierarchy]] (the geometry->
stock tie N0/N1d build on). Then liencam-orientation -> liencam-planning-cycle;
confirm the plan + the OPEN DETAILS with Operator before building (visual-review-gated,
do NOT build solo). Likely a NEW ADR (nest-as-geometry + seed authoring + sheet-as-
auto-stock) extending ADR 0024.
BUILD ORDER:
- N0 FIRST (standalone, smallest): a "+Auto" stock button mirroring "+Fixed" so
  MULTIPLE auto stocks can coexist, each auto-sizing from its assigned parts. Recon
  the existing fixed-stock "+" path + the auto-stock model + the geometry->stock
  assignment (coordinate hierarchy). This unblocks N1d.
- N1 NEST-COHESION (the refactor): (a) nest = a GEOMETRY-TREE folder-like node, parts
  acting like layers, created from a NEW Geometry-header icon (propose LayoutGrid;
  Operator confirms) - REUSE the existing nesting controls, only the category moves out of
  the standalone "Nests" section; (b) SEED authoring per ADR 0024 (one source copy/
  part = seed; ops planned against the seed, toolpath instances off it; seed distinct
  coloration); (c) EXPLODE -> independent editable copies at packed poses, nest
  removed; (d) sheet binds to an AUTO stock (re-sizes on re-pack; moving stock moves
  the nest) + a THICKNESS (Z) selector in the nesting UI (2D parts have no Z).
- THEN P6 instanced toolpath (seed is the authoring source) -> P7 post expansion
  (innermost-first) -> P8 generate + move nesting into FEATURE-HITLIST Part 1.
OPEN BACKLOG (not N0/N1): the real pack PROGRESS BAR (phase/probe fraction via
runNest onProgress; the cheap live timer already shipped) - see backlog above.

## Real-part hardening (2026-06-17, after first visual review)
The first visual harness run on Operator's REAL Sample Parts exposed problems the
synthetic unit tests masked. All now fixed and committed:
- PERF (650b86f): packing real parts took ~8 MIN (BMG.dxf = 202-vertex ring;
  PROFILED: noFitPolygon = 99.9% of wall-clock; caching was NOT the lever -
  redundancy only 1.5x). Fix = SVGnest-style Douglas-Peucker simplification of
  the NFP PROXY rings only (simplify.ts, curveTolerance default 0.3mm), BEFORE
  the spacing grow. Full part geometry untouched for toolpath/render (ADR 0024).
  202 -> 30 verts; ~8min -> ~15s.
- CORRECTNESS (ddffcfd): mixed-real-parts OVERLAP + min-sheet solver returning
  impossible (>100% util) sheets were ONE root cause - the DXF importer yields
  CLOCKWISE outer rings for some parts (BootL/Leadscrew) but the orbiting
  noFitPolygon needs CCW; CW parts gave an empty NFP -> placeParts silently
  `continue`d and every copy STACKED at one point. Fix = ensureCCW all proxy
  rings before NFP + ADR-0003 fail-loud (no silent stack). winding-cw.test.ts
  gates it (verified fail pre-fix / pass post-fix).
- VISUAL: docs/planning/nesting-visual.html (re-run on the fixed engine) - ALL 5
  panels PASS the no-overlap self-check; solver sane (84x316 @ 63.1%, was 315%).
  The harness source is docs/planning/nesting-visual-harness.ts.txt (kept OUT of
  the suite - it is a ~45s diagnostic; copy into src/tests/nesting/ to re-run).

KNOWN/NOTES: utilization metric = part-area/sheet-area (arrangement-independent
when all parts fit; not a tightness measure - revisit when UI shows yield). The
inside-window path is correct but only triggers for parts that DON'T fit the open
sheet (Phase B = leftovers); the harness panel 5 shows 0 in-window because the
tabs all fit the sheet. Further perf headroom exists (NFP caching now WOULD help
since the GA advances; sub-second-per-NFP achievable).

## What this is
True-shape (no-fit-polygon) nesting engine - the OBJECTIVE, unit-testable spine
(SPEC: docs/planning/NESTING-SPEC.md; contract: ADR 0024). Ported from SVGnest
(MIT); Deepnest (GPLv3) deliberately NOT used. Clipper2-wasm has no Minkowski,
so the orbiting NFP method is the workhorse; clipperEngine provides union/
difference/offset for NFP-union, sheet subtraction, and spacing.

## Mechanical state - DONE (engine phases P1 + P2)
- P1.0 (1558463) scaffold: types.ts, rng.ts (seeded mulberry32), index.ts,
  vendored/ SVGnest sources (.js.txt, out of tsc graph) + LICENSE.
- P1.1 (537b697) nfp.ts/geometry.ts: orbiting noFitPolygon (part-vs-part, and
  inside=true for concave containers) + noFitPolygonRectangle (part-in-sheet).
- P1.2 (7f60a28) placement.ts (placeParts worker) + ga.ts (seeded GA). packNest
  is ASYNC (awaits clipper). Determinism: all 5 SVGnest Math.random sites routed
  through mulberry32(req.seed). Spacing applied once up front.
- P1.3 (e7ecdac) solver.ts: solveNest(req) - fixSheet (max qty), fixQty +
  width|height locked (min free axis), fixQty none (min area via candidate-width
  strip packs). fastPlace feasibility probe; packNest for final quality.
- FIX (b5185d0) packer under-utilized (3/4 squares in 70x70) - ROOT CAUSE was the
  smallest-x gravity tie-break building one column; fixed to bottom-left (sx+sy).
  Strengthened utilization tests (4/4 in 70x70; 3x3 grid floor).
- P2 (740d050) inside-window: NestPart.windows?; Placement.windowParentId? +
  depth (0 sheet / 1 window). Two-phase (Phase B fills placed hosts' windows with
  Phase-A leftovers via inside-NFP + windowGap). Gated on windows present so
  no-window output is byte-identical to P1.

Public API (src/lib/cam/nesting/index.ts): `packNest(req): Promise<NestResult>`
(fixed sheet) and `solveNest(req): Promise<NestResult>` (bidirectional). Types in
types.ts. All deterministic for a given req.seed.

## ROADMAP (updated 2026-06-17 - see the SEED above for the live next steps)
- P3 instanced data model + render: DONE. P4 interface: DONE + signed off.
- P5 preview interactivity (nudge/rotate/lock + re-pack; window-picker popout):
  PARKED by Operator (maybe never). Engine support (NestPart.windows? + two-phase
  placeInWindows) EXISTS from P2 if it is ever revived.
- NEXT = N0 multi-auto-stock -> N1 nest-cohesion (see SEED + NESTING-SPEC).
- THEN P6 instanced TOOLPATH (compute once per SEED, transform per instance) -> P7
  POST expansion (single toolpath + travels -> g-code, innermost-first per ADR 0024)
  -> P8 accept/generate. ADR 0024 is Proposed (Operator-signed-off); implements in P6/P7;
  N1 likely adds a new ADR extending it (nest-as-geometry + seed + sheet-as-stock).

## Open decisions parked for Operator (not blockers; defaults chosen)
1. Inside-window two-phase model: Phase-A GA is blind to a window's bonus
   capacity, so end-to-end packNest naturally yields single-child nesting (engine
   DOES support multi-sibling; proven at the placeInWindows unit level). Accept
   for v1, or want global window-aware optimization later?
2. fixQty none-locked min-area uses a bounded candidate-width strip-pack
   heuristic (not provably optimal). Acceptable for v1?
3. Arbitrary-angle style default rotationCount (yield vs compute time budget).

## Not shipped (delivered-vs-not)
FEATURE-HITLIST.md (2026-06-17) ANNOTATES nesting as BUILT-on-branch (P1-P4) under
the to-build "Nesting" section + records the N0/N1 cohesion direction; it is NOT
moved to Part 1 (delivered) because the branch is not merged and there is no post
expansion yet. Move it to Part 1 only after P6-P8 land, the branch merges, and Operator
accepts. The N0 multi-auto-stock item is flagged "NEXT UP" under stock features.
