> HISTORICAL - SHIPPED. This is a branch-era development log. This subsystem is
> DELIVERED and merged to main; its current feature status lives in
> docs/FEATURE-HITLIST.md Part 1 (the single delivered-vs-not authority). Do NOT
> consult this file for current status. Kept for implementation history only.
> Live reference for ongoing work: docs/planning/AC-PERF-HANDOFF.md and docs/FEATURE-HITLIST.md Part 1.
> (Banner added 2026-06-24 doc consolidation.)

# STATUS — AdaptiveClearing2D

**Branch:** `main` (was branched as adaptive-clearing-v1; trunk is now main)
**Branched from:** `master`
**Architecture reference:** parent scope prompt (engagement-driven, five-layer spec)

---

## Current milestone

**[SUPERSEDED 2026-06-09 -- the morph-ring prototype described below is GRAVEYARD; the current architecture is the FreeCAD Adaptive2d port. See the LATEST milestone at the BOTTOM of this file.]**

**Morph-ring prototype — chained-offset ring-march is now the SOLE ring-generation path (NOT yet integrated).** The adaptive-clearing morph is developed empirically in `morphProto/`. **ADR-0012 is now IMPLEMENTED (2026-05-27):** the marching-squares / FMM-isocontour path substrate has been retired; rings are **chained-offset polylines** (each ring = prior ring offset by one stepover, real geometry), and the FMM grid is demoted to occupancy/region oracle exactly as the ADR required. Current pipeline: `region detection (FMM oracle) → seed (next-revolution OR boundary-offset) → chained offset with steering + sagitta correction → polyline-intersection wall clip → arc-continuation wall extrapolation → resample`. Validated this session (numbers + tsc): endpoint–wall contract exact (272/272 ring endpoints on real walls, wallGap=0, wallTangentRisk=0 across all fixtures); sagitta convexity correction (target 0.03, gain 3.0) holds the Paisley tail bow without breaking the wall contract; multi-bias steering driver aims the offset in-construction (the non-deforming successor to the reverted post-hoc alley steering); handedness still single-sourced from spiral winding; TWO composed region-split triggers (connectivity + spiral-truncation) unchanged. tsc clean, 138 passed / 6 skipped. See `## Prototype — Morph-Ring Construction` below for the commit table. **Next phase:** lead-in/lead-out + loopback layer. The "Toolpath Element Convention" note is now in project knowledge (`toolpath_element_convention.md`) and the full loopback/travel design model was worked out 2026-05-28 (captured as §3a in HANDOFF.md). **CONSTRUCTION METHOD — 2026-05-29 STRATEGIC DECISION: this layer's tangent geometry is built on the OpenCASCADE (OCCT) geometry kernel (`cadquery-ocp`), NOT hand-rolled tangent math — see `HANDOFF-OCCT-MIGRATION.md` for the decision, POC evidence, and next-session plan.** Open prerequisites: multi-loop analytic spiral for Square+Island; cross-region cutting-order policy (a DOMAIN decision — escalate to the user).

---

## Region-detection criterion VALIDATED vs measured reference GT (2026-06-05, Python research line)
The multi-region DETECTION criterion was cracked against the 9 measured reference fixtures (not synthetics).
**Result CONFIRMS the Q3 decision above** (island = merge seam; neck/reflex/corner do NOT split; only
disconnected areas split) and gives the concrete mechanism: **a region boundary = where the advancing
FILL-FRONT (chained offset / ringMarch, ADR-0012) BREAKS into a SUSTAINED separate alley.** Front rounds
corners + flows through narrowings as one piece; wraps+rejoins at islands/bulbs (seam). Corner-vs-alley =
TAPER-vs-PLATEAU of front-piece width (not size); corners = nibble cleanup. **This SUPERSEDES ADR-0013's
disjoint-segment/erosion as the detection mechanism** (both fire at the wrong features on real parts — the
ADR synthetic barbell=2 contradicts real Barbell fix7=1). Validate ONLY vs `scripts/_fusion_regions.py`
(cut-order GT). (a) up-front lookahead approximation built (`scripts/_region_inline.py`; Comma/Bar/Kidney
exact; trunk has 4 known bugs to fix — reuse `_skeleton_regions` builder); (b) = drive real `ringMarch`
next, then draft ADR-0014. Full detail: `test_fixtures/adaptive-clearing/spirals/_cmp/_gt/HANDOFF_ARCGEN.md`
(top box + SEED_NEXT_SESSION.md) + memory `project_ac_region_criterion`. Read-only diagnostics; no wiring yet.

---

## Done

- [x] **Engine architecture: Q3 region-decomposition fork resolved** (commit `8669381`)
  - Resolved via reference-path study (three diagnostic shapes: square+off-center-island, barbell, L-shape) + adversarial cross-check. Resolution: plan-then-adapt with topology-based regions.
  - Regions pre-computed once up front from pocket+island geometry (NOT iterative from remaining stock); §3 outer loop overturned accordingly.
  - Split rule is topological: island = one region with a merge seam (front flows around the hole and rejoins, single seed); neck and reflex corner do not split; only genuinely disconnected pocket areas form separate regions (the relocate case).
  - Seeding = best ranked-choice score (arc-quality dominant), not "largest"; seed at distance-field peak / innermost offset.
  - Return-move invariant SETTLED: never cross uncut stock, always loop back through cleared space. Step-back overlap integral-vs-separate deferred to morph-build time (depends on arc math).
  - Infrastructure check: region detection stays within offset-contour/grid infra (connected-components + distance-field peak); no medial-axis engine; §6 Q1 not reopened. One build-time verification checkpoint: island merge-seam emergence.
  - Cross-check caught a real evidence-reading error (island was wrongly described as relocate; corrected to merge seam) and demoted "largest-first" to ranked-choice-consistent. No code/algorithm changes; no test re-run.

- [x] **Engine architecture: research pass synthesized** (commits `c0dfc3b`, `dca383f`)
  - Morph-construction research pass (chat-side web research) complete and folded into the architecture doc.
  - Q1 morph construction — SETTLED: offset-contour / offset-linking sub-variant of landscape §4.1, buildable on existing Clipper-equivalent offset infra; Connected Fermat Spirals (Zhao 2016) as the published reference construction; engagement attaches as post-hoc validation (existing `engagementAngle`/`StockState`, unchanged). Voronoi-wave and Laplace rejected (require geometry subsystems we don't have and won't build).
  - Q2 morph onset — SETTLED: continuous blend in open field; triggered switch to trochoidal in narrow channels (<~1.5× tool dia); thin regions degenerate to near-parallel passes.
  - Q4 §4.6 divergence — SETTLED: confirmed, all four conditions met. Patent picture: US 6745100 expired/free; US 10108172 (2019 Voronoi-wave) in-force → Voronoi-wave construction explicitly avoided; iMachining-specific pieces avoided via academic offset-contour prior art.
  - Q3 region-emergence — NOT settled; elevated to architecture §5 as the next strategic decision (up-front decomposition vs. iterative stock-emergence; the iterative model structurally echoes the Approach-B faceting failure and warrants a deliberate decision + cross-check).
  - Architecture doc §4 retitled to "resolved strategic foundation (SETTLED by research)"; new §5 holds the Q3 fork; sections renumbered (old §5→§6, §6→§7, §7→§8); status preamble and §4 rationale reconciled with the patent finding. No code/algorithm changes; no test re-run.

- [x] **M0 — Skeleton** (commit `4d1cd36`)
  - Branch created, module directory scaffolded, five layers stubbed
  - Worker dispatch wired, smoke test passing

- [x] **M1 — Engagement Query** (commit `54a5107`)
  - **M1 carry-over:** grid bbox changed from `safeRegion` to `boundary` + 2-cell margin (`index.ts`)
  - `stock.ts` — `StockState` implemented: `Uint8Array` grid, `worldToCell`, `cellToWorld`, `update`, `isCleared`
  - `engagement.ts` — `engagementAngle` implemented: ray-cast loop, seam-based circular arc grouping, `workRegion` parameter, `pointInPolygon` boundary/island tests
  - `m1-engagement.test.ts` — 7 tests, all passing

- [x] **M2 — Scoring and Candidate Generation** (accepted as substantially complete; unstaged)
  - `planner.ts` — ENTERING + CUTTING + DONE sections implemented: LIC-based helix entry, 5-term scored candidate fan (±60°, 5° steps, 32 rays), `bothWays` mechanism, `updateDisk(entry, helixRadius + toolRadius)` helix stamp
  - `types.ts` — `PlannerState` updated to include `APPROACHING`
  - **First APPROACHING fix:** added APPROACHING state that walks along initial heading until `engagement > minEng`, then hands off to CUTTING. Prevents immediate termination when all first CUTTING candidates are inside the cleared helix disk.
  - **Second APPROACHING fix:** APPROACHING now walks along `wallDir` (radial toward nearest safe-region boundary). After exit, `heading` is recomputed via `_initialHeading` from the new tool position, pairing radial traversal with a correct tangent CUTTING heading.
  - `m2-planner.test.ts` — 5 tests; results after threshold adjustments:
    - T1 circle: 100% coverage ✓ (threshold ≥ 99%)
    - T2 square: 96.2% ✓ (threshold lowered to 95%; corner scallops at 90° corners are intrinsic to adaptive clearing)
    - T3 L-shape climb-only: 44.5% ✓ (regression floor 40%; ≥ 99% is M3 acceptance criterion pending RELOCATING)
    - T4 pentagon: ≥ 99% coverage ✓
    - T5 L-shape bothWays: 44.5% ✓ (regression floor 40%; ≥ 99% is M3 acceptance criterion pending RELOCATING)
  - **bothWays conventional-segment check deferred to M3:** No M2 fixture exercises the mechanism — see Decisions table.
  - 16 adaptive-clearing tests pass at M2 completion (7 M1 + 5 M2 + 4 M0).

- [x] **M3 — RELOCATING + engagement guard** (commit `97274de`)
  - **State-machine refactor:** sequential labeled sections (ENTERING → APPROACHING → CUTTING → DONE) converted to an explicit state-driven loop (`while (state !== 'DONE') { switch (state) { ... } }`). Cyclic transitions (CUTTING → RELOCATING → APPROACHING → CUTTING) are now explicit.
  - **`nearestUncutPocket` implemented** (`stock.ts`): BFS flood-fill over uncleared safeRegion cells (4-connected, Uint8Array visited bitmap). Filters components below `completionTolerance` (1.0 mm²). Optional `excludeNear` parameter: skips any component whose centroid is within `toolRadius` of any failed-entry centroid (handles re-computed centroid drift from grid discretization). Returns centroid of largest remaining component as `{ center: Vec2 } | null`. `_from` parameter preserved in signature for future entry-strategy pluggability.
  - **RELOCATING state** (`planner.ts`): retract from current pos → lateral rapid at safeZ → helix/plunge via `_enterRegion` → heading via `_initialHeading` → transition to APPROACHING. Always retract-rapid-plunge link strategy; in-material straight link optimization deferred to M4.
  - **`_enterRegion` shared helper** (`planner.ts`): computes `helixRadius` from `localRadius`, emits rapid + helix-or-plunge, stamps stock. Called by both ENTERING (with `lic.radius`) and RELOCATING (with `stock.distAt(newEntry)`). No helix-logic duplication.
  - **APPROACHING pre-emit engagement check**: before pushing each cut move, computes `eng` at the prospective position. If `eng > maxEngagement`, does not emit the move, does not stamp stock; transitions to RELOCATING with `lastRegionFailed = true`. The existing exit condition (`eng > minEng → CUTTING`) is unchanged; the maxEng check fires first.
  - **Failed-region tracking**: `failedCentroids: Vec2[]` and `lastEntryCentroid: Vec2 | null` in planner outer scope. When RELOCATING sees `lastRegionFailed`, pushes `lastEntryCentroid` into `failedCentroids` before calling `nearestUncutPocket`. If all components are excluded → null → DONE.
  - **Coverage results (all 17 tests pass):** T1 100% ✓, T2 96.2% ✓, T3 93.6% ✓ (floor 0.90), T4 100% ✓, T5 93.6% ✓ (floor 0.90), T6 86.2% ✓ (floor 0.83)
  - **Improvements over M2:** T3/T5 44.5% → 93.6% (+49.1pp), T6 51.9% → 86.2% (+34.3pp)
  - **Visual validation:** relocation behavior confirmed sensible across T2, T3, T6. Helix entries land at centroids of large uncut sub-regions. Rejected entries (failed plunges) appear in viewer as rapid-line endpoints — 2D top-down projection doesn't render the vertical plunge component; this is a viewer limitation, not a toolpath issue.
  - **Architectural validation:** engagement-driven approach handles inside-out cutting in convex sub-regions naturally (T1, T2, T4 don't trigger RELOCATING). Centroid-entry correctly handles large uncut regions but cannot enter thin strips or small corner geometries where the plunge stamp leaves no safe radial step direction. Edge-entry strategies are the M4 solution.

- [x] **M2.5 — Visual Review Infrastructure** (unstaged)
  - `assertPlannerOutput` — fixture write reordered to occur BEFORE the coverage
    assertion; fixtures always export regardless of pass/fail (required for diagnostic
    tests expected to fail, e.g. T6)
  - `m2-planner.test.ts` — fixture export added: each test writes
    `test_fixtures/adaptive-clearing/output/<name>.json`.
    Schema: `{ name, boundary, islands, safeRegion, toolRadius, params, moves, stats }`.
  - `debug-viewer-adaptive/` — standalone viewer: `index.html` + `viewer.js`,
    no build step, no framework. File picker loads any fixture JSON. SVG renders
    boundary, safe region, islands, moves colored by role and engagement.
    Stats panel shows coverage, move counts, path length, avg/max engagement (°).
    Engagement color uses absolute scale 0 → `params.maxEngagement`; red for violations.
  - **Visual validation results:**
    - T1 (circle): clean spiral fill, no gaps. ✓
    - T2 (square): clean; 3.8% gap confirmed as corner scallops at 90° corners.
      Intrinsic to adaptive clearing — circular tool cannot reach a sharp convex
      corner without a finish pass. Not a bug. ✓
    - T4 (pentagon): clean fill. ✓
    - T3 (L-shape): planner fills ~67% of the bottom arm before getting trapped in
      cleared cul-de-sacs; 0% of upper arm reached (expected — topology requires
      RELOCATING to cross the reflex-vertex pinch).
  - **Architectural validation:** engagement-driven approach naturally produces
    spirals from tool-rotation bias + engagement seeking. Naturally respects
    safe-region boundaries. Both confirmed visually across T1–T4.
  - **T6 diagnostic result:** plain 60×30 rectangle (same dimensions as L-shape
    bottom arm, identical ACParams to T3) hits 51.9% coverage — confirming the
    under-fill is NOT reflex-vertex-specific. The engagement-driven spiral fills
    the inscribed elliptical region of any non-circular pocket, then terminates
    when every candidate direction is surrounded by cleared territory.
  - T6 promoted to permanent M3 acceptance criterion alongside T3 and T5.
    Regression floor: 0.50. M3's RELOCATING is the planned remedy for all three.
  - `test_fixtures/adaptive-clearing/output/` added to `.gitignore`.
  - **Anti-reuse policy enforced:** no code from the spiral adaptive debug viewer.
    Data shapes (rings, loop-back arcs, phase numbers) do not apply here.
  - 17 adaptive-clearing tests pass at M2.5 completion (7 M1 + 6 M2 + 4 M0).

- [x] **Post-M7 viewer quality-of-life** (commits `847a4a8`, `1d69860`)
  - Zoom and pan added to debug viewer (847a4a8)
  - `wall_follow` false-positive suppressed in viewer crash-check simulator (1d69860)

- [x] **Wall-follow roadmap** (commit `77ea03e`)
  - Multi-stage roadmap at docs/research/wall-follow-roadmap.md: three-stage path from current state to commercial-quality AC; bulk-pass quality tracked as deferred-but-monitored

- [x] **Wall-follow pre-pivot foundation** (commits `64985b5`, `f0c5f77`, `fac0c0d`, `fa0df61`)
  - `sampleArc` arc-sampling primitive in geometry/index.ts (64985b5)
  - Reflex/convex corner classification gate tests (f0c5f77)
  - `runWallFollowPass` function + ACParams wall-follow fields, unwired (fac0c0d)
  - `simStock` wall_follow move stamping; `assertPlannerOutput` extended with wall_follow stats (fa0df61)

- [x] **Design pivot — bulk-pass quality** (commits `67c56fb`, `d79def0`)
  - Uniform-residual requirement research note (67c56fb)
  - Design pivot recorded: real target is bulk-pass motion quality, not single-pass finishing. Single-pass `runWallFollowPass` walk-and-skip logic superseded; foundation commits remain valid. (d79def0)
  - Session 2026-05-22: Phase A single-pass wiring (uncommitted) discarded; STAGE1-PLAN.md marked superseded; docs reconciled to post-pivot state.

- [x] **ADR-0012 — Grid as occupancy oracle; real geometry for all paths** (commit `a24f6d4`)
  - Grid (and FMM field) demoted to occupancy-oracle-only role; all path geometry must be real geometry.
  - Governing principle recorded: "Make and maintain good geometry. Never generate poor geometry to correct later."
  - Architecture doc: new §1a governing principle + §6 Q1 amendment + §7 sequencing update.
  - HANDOFF.md: conflict flag 4 added (marching-squares-as-path superseded); recommended next steps revised.
  - Re-architecture plan to follow in REAL_GEOMETRY_PLAN.md (pending architect/user approval).
  - FMM field, occupancy grid, and all behavioral logic (M0 coupling, region detection, ring-march-down-alley, spiral winding as climb source) preserved.

- [x] **Morph-ring prototype — field, spiral, region triggers, arc-march** (commits `0948e17` … `98d8933`; see `## Prototype — Morph-Ring Construction` for the full commit table)
  - Geodesic distance-field morph via fast marching; isocontour rings reproduce commercial reference behavior (circular near seed, wall-parallel outward, splits-and-rejoins around islands with an emergent merge seam) on L-shape, barbell, and square+island
  - Continuous outward Archimedean spiral; cut handedness single-sourced from spiral winding (a future climb toggle = flip the spiral, arcs follow)
  - Two composed region-split triggers: connectivity-split (existing `detectSplitsByStockConnectivity`) + spiral-truncation (NEW — retrace-arc metric, `AC_TRUNCATE_MARGIN=2.0` / `AC_TRUNCATE_MERGE_STEPOVERS=5`, validated twice on numbers: paisley fires at ring 9 / L=32mm, disc never), composed via `min(level)`
  - Truncation→ring-march handoff: cut/uncut frontier seeds an entry-only FMM; isolated regions filled by open arcs marching down the alley (not closed rings), handedness matched to the spiral (**note:** spiral→ring-march continuity pin is intended-but-not-built; first arc seeds from its region's entry FMM; spiral and arc-march are currently disconnected, ~11.5mm gap on paisley)
  - Paisley fixture added; debug viewer (`debug-viewer-adaptive/morph-viewer.html`) with fixture buttons, layer toggles, and a spiral/ring-march scrubber
  - Steering attempted and reverted (`98d8933`) — deferred to abrupt-turn fixtures (island-back, U-shape); load-band must not deform extracted arc geometry. See the Prototype section and HANDOFF.md for the lessons.

- [x] **ADR-0013 — Recursive real-geometry split detection (decided and documented, 2026-05-25)**
  - **The decided rule (one rule, applied recursively across all filling phases):**
    - Split detection uses the REAL spiral/ring-march path contacting REAL boundary segments,
      NOT the FMM grid BFS count.
    - Split trigger: a WALL-FOLLOW EVENT (path entering contact with and following along a
      boundary). A continuous follow across many segments is one event.
    - Dedup by SEGMENT IDENTITY: a wall-follow is a NEW DISCRETE contact only if its set of
      followed boundary segment indices ({polyIdx, segIdx} pairs) is FULLY DISJOINT from the
      segment sets of ALL prior wall-follows in the current fill. ANY shared segment =
      continuation = does not count.
    - Each new fully-disjoint discrete contact (after the first contact in a region) splits
      off one new region.
    - **RECURSIVE**: both the SPIRAL and each RING-MARCH apply the same rule. Splitting does
      not end when the spiral stops. Ring-march wall-follows that engage fully-disjoint
      boundary segments seed new ring-marches recursively.
    - FMM field remains oracle for split LEVEL detection (`detectSplitsByStockConnectivity`)
      and region SEEDING (`findIsolatedRegions`). Only split counting/identity moves to real
      geometry.
  - **Why segment identity not distance:** the spiral re-hits the same physical feature
    (e.g. L's inside corner) on every revolution at ever-larger radius; any fixed distance
    threshold falsely counts the same corner as new. Segment identity does not drift with
    radius.
  - **Why replaces BFS counting:** barbell BFS reported regionCount=56 (grid artifacts);
    L-shape BFS showed phantom 3rd region ~0.7mm after first split (discretization noise at
    reflex corner). Both are structural grid-cell artifacts, not real topology changes.
  - **Read-only confirmation per shape (static geometry trace, 2026-05-25):**
    - **L-shape:** Spiral phase: initial={seg 0, seg 5}; first disjoint contact={seg 3,
      inside corner vertical wall} → 1→2. Ring-march of R2 (top arm): initial={seg 3,
      seg 5}; first disjoint contact={seg 4, top wall} → 2→3. **3 real regions, recursive.**
      BFS phantom (0.7mm after first split, grid artifact) is DISTINCT from real R3 (ring-
      march-created at a different level via seg 4 contact).
    - **Barbell:** Spiral: initial={left-bulb arc segs}; first disjoint contact={neck
      straight-line segs} → 1→2. Ring-march of R2 (right bulb): contacts form a continuously
      sliding arc sequence — each follow shares ≥1 segment with prior follows → 0 new disjoint
      contacts → 0 additional splits. **2 real regions.** BFS reported 56 — all artifacts.
    - **Paisley:** Simply-connected alley with truncation trigger (not connectivity). 2
      principal regions (body + tail). Exact inner-arm disjoint timing requires build-phase
      code tracing.
  - **Build items (next session):** implement disjoint-segment dedup in spiral wall-follow
    detector; implement recursive ring-march; P1 fix (exact disjoint-contact seal point);
    rename "arc march" → "ring march"; dead-code purge.
  - ADR: `docs/decisions/0013-recursive-real-geometry-split-detection.md`
  - Conflict flag 5 added to HANDOFF.md.

- [x] **Analytic Archimedean seed-region spiral** (commits `86a7b5f`, `fb10a9c`, `7e586f5`)
  - New `analyticSpiral.ts`: true r(θ) = firstLevel + (stepover/2π)·|θ| analytic path, θ decreasing CW. Wall-following via ray-cast (`raySegDist`) against all boundary + island segments: actual radius = min(r_ideal, r_wall) at each step. No FMM field queries for position — closed-form analytic.
  - Stops at FIRST connectivity split from `detectSplitsByStockConnectivity` oracle; no hardcoded turn count, no T parameter. Split level derived from the topology oracle.
  - Replaces T2/T3/T4 hybrid scaffolding. Seed-region only; recursive ring-march for post-split sub-regions is the next planned stage (not built).
  - Observed split levels: L-shape 29mm (8 turns, 94 wall-follow events — reflex corner confirmed), Barbell 20mm (5 turns, neck split), Paisley 11mm (2 turns — matches RC-3 constraint exactly).
  - Viewer (`morph-viewer.html/js`): T2/T3/T4 buttons removed; single scrubber now drives analytic spiral point-by-point (seed outward). WELD rings shown statically as subdued background context. Stats panel shows splitLevel, turns, wall-follow count.
  - 5/5 tests pass; tsc clean.

- [x] **Chained-offset ring-march — sole ring-generation path (ADR-0012 implemented)** (session 2026-05-27, HEAD `79943ec`)
  - **The substrate change.** The marching-squares / FMM-isocontour ring/arc polylines are RETIRED. Rings are now **chained-offset polylines**: each ring is the previous ring offset by one stepover as real geometry, clipped against real boundary segments by polyline intersection, with endpoints extrapolated onto the wall. The FMM grid is demoted to occupancy/region oracle only — executing ADR-0012's "grid as oracle, real geometry for paths." Current pipeline: `region detection (FMM oracle) → seed (next-revolution OR boundary-offset) → chained offset with steering + sagitta correction → polyline-intersection wall clip → arc-continuation wall extrapolation → resample`.
  - **This session's commit arc (newest first):**
    | Commit | Summary |
    |--------|---------|
    | `79943ec` | refactor: retire all superseded ring-generation paths (FMM extraction, Stage A, V2, spline, FMM seed-propagation); −1553/+154 lines; chained-offset polylines byte-identical pre/post; minSagitta telemetry now surfaces in fixtures |
    | `99deb74` | chore: remove dead mask-aware ray-trim helpers |
    | `adecc23` | feat: sagitta convexity correction for chained-offset rings (target ratio 0.03, gain 3.0) — Paisley tail holds ~0.03 bow instead of collapsing flat; endpoint–wall contract preserved |
    | `015cfbc` | feat: arc-continuation + long-tangent wall extrapolation (sandbox v10) — 272/272 ring endpoints on real walls, wallGap=0, wallTangentRisk=0 across all fixtures |
    | `9c753c2` | feat: endpoint extrapolation + multi-bias steering driver for chained-offset rings |
  - **Endpoint–wall contract now exact.** 272/272 ring endpoints land on real walls; `wallGap=0`, `wallTangentRisk=0` across all fixtures. This attacks the old arc-to-wall termination quality gate (the wall-gap variance the trim/extend layer was meant to fix) at ring-generation time.
  - **Steering is in-construction, not post-hoc.** The multi-bias steering driver aims the chained offset as it is generated — the non-deforming successor to the reverted load-band "alley steering" attempt (the "emergent, not bent" principle holds).
  - **tsc clean; 138 passed / 6 skipped.** Chained-offset polylines verified byte-identical across the 79943ec dead-code retirement.
  - **Known cosmetic delta (NOT a bug):** 2 zero-ring regions (L-shape m1/m2 r0) now report termination reason `'no-source'` instead of the retired `'first-arc-cleared'`. Regions emit no toolpath; label is cosmetic.
  - **Broader migration context:** the chained-offset path landed across ~25 commits since the prior STATUS refresh (real-geometry rings `820ecb0`, clamped cubic spline `0b09e7f`, V2 analytic seed `f6f5594`, chained-offset port `aebba5a`, boundary-offset seed for disconnected regions `f14e874`, mask-aware then polyline-intersection wall trim `7b3caea`/`f65cee8`, all-fixtures + scrubber/stamp coupling `a0f0fdd`), plus the `ac-trace` doc series (`09bf19b`…`c5f31bf`).
  - **Next phase:** lead-in/lead-out + loopback layer, founded on a "Toolpath Element Convention" design note (being added to project knowledge). Open prerequisites: multi-loop analytic spiral for Square+Island; cross-region cutting-order policy (DOMAIN decision — escalate to the user).

- [x] **§3a loopback/travel design model + OCCT linking decision** (design + evaluation only, NO engine code; docs commit `acccc74`, sessions 2026-05-28 / 2026-05-29)
  - **2026-05-28 — loopback/travel design model.** The lead-in/out + loopback layer was designed in full and captured as **§3a in HANDOFF.md** (read with `toolpath_element_convention.md`, now in project knowledge): one unified transition primitive (`lead-out → wall-follow → fillet → rapid loopback → fillet → wall-follow-entry → lead-in`) for every element-to-element join; wall-follow length as the central computed quantity (cleanup + fillet-departure, formula-proposes / grid-stamp-confirms); **trajectory-first** computation ordering; the spiral-start **center-seek** special case; move types as a postprocessor contract (emit the existing `MoveRole` taxonomy — first emitter of `lead_out`/`loop_back`); pre-flight sequencing / sub-region decomposition flagged as a later third layer.
  - **2026-05-29 — OCCT construction-method decision (STRATEGIC).** The loopback layer's tangent geometry will be built on the **OpenCASCADE (OCCT) geometry kernel via the `cadquery-ocp` wheel**, NOT hand-rolled tangent math. Chosen after a cited library evaluation (vs cavalier_contours, build123d, shapely, Clipper2, pygeometry2d): one B-rep kernel serves today's 2D tangent-arc problem AND the roadmap (3D toolpathing, STEP/surface/solid, future UI geometry editing). POC proved `ChFi2d_FilletAlgo` produces a fillet tangent to two curved polylines at **0.000000 mm / 0.0000°** on the previously-broken 5→6 transition. The §3a/§3 behavioral requirements STAND; only the construction *technique* changes. Root cause of the prior hand-rolled failure: tangency/direction inferred from geometric proximity instead of carried as canonical orientation — the exact mechanism `toolpath_element_convention.md` predicts. Full decision, POC evidence, and next-session plan in the new **`HANDOFF-OCCT-MIGRATION.md`**. docs/CONVENTIONS.md principle 3 gained **"Non-convergence is itself a signal"** from this session.
  - **No repo/engine code this session** — mechanical state remains HEAD `79943ec`; both sessions were design/evaluation only.

- [x] **OCCT linking — Phase 2: single-transition port (sandbox_22 → TS)** (commits `9a7e310`…`1866965`, 2026-05-29)
  - **First OCCT-native algorithm surface in the pipeline lands.** The §4 single-transition linking architecture is ported from `sandbox_22_occt_endtoend.py` onto the OCCT WASM scaffold (ADR-0014). Per-transition chain (motion order): `ring_a → lead_out → wall_follow_e → exit_fillet → loopback → entry_fillet → wall_follow_i → lead_in → ring_b`; the 7 connective pieces are emitted as `LinkSegment[]` (rings emitted separately by the Phase-3 assembler), and the 8 joints between the 9 chain pieces are audited analytically.
  - **Reusable curve-query primitives added to `Curve2D`** (`src/lib/cam/geometry/occt/index.ts`): `paramOfPoint` (dense-sample + ternary refine), `walkArclen` (arc-length march in a motion direction), `sampleBetween`, `distanceTo`, `tangentAtPoint`, plus `lineCurve`. All sampled/adaptor-based — the proven in-WASM path that sidesteps `GeomAPI_ProjectPointOnCurve`'s endpoint `StdFail_NotDone`. This is the shared OCCT geometry service later tools build on (ADR-0014).
  - **`buildTransition` + 4 deterministic selectors, all strict on transition 5→6.** Selection from stamped canonical orientation, not proximity: lead-out by cut-vs-wall dot backtrack (`pick`); canonical winding cross-sign stamped once; lead-in mirrored via that sign (`pickCross`); exit/entry fillets by wall-motion agreement (`pick`). All four selected exactly one solution (strict) on 5→6.
  - **Cross-checked against the Python reference:** max analytic tangent **8.54e-7°** (truth = `D1` tangents on the OCCT curves at the exact contacts, not finite-difference on samples), max gap **2.4e-8 mm**, canonical winding sign **+1**. Ring contact points frozen as a regression baseline. **142 tests pass** (`test_fixtures/adaptive-clearing/transition-5-6-trimmed.json` is self-contained + committed).
  - **Known binding gap (carry-forward):** `BRepBuilderAPI_MakeEdge` is unusable in the vendored custom WASM (the `BRepBuilderAPI_MakeShape` base class is unbound), so `lineCurve` is built via 2-point exact interpolation as a geometrically-identical workaround (`fe08845`). **Any NEW edge constructor needs adding to the custom WASM bindings** — do not fall back to approximation silently (ADR-0003).
  - **Commit arc:** `9a7e310` curve query primitives → `e41420f` selectors + `buildTransition` → `fe08845` `lineCurve` via interpolation → `897bef7` self-contained 5→6 fixture → `1866965` vitest acceptance.
  - **Phase 3 next:** full-region assembler (port `sandbox_23_fullchain.py` — canonical-winding vote, arc-length wall window, nearest-corner tiebreak, degenerate-tip bridge, 36-transition continuous trajectory).


---

## In Progress

**M4 — Frontier-tangent edge entry (single strategy)**

**Scope:**
- Component classification: `CENTROID_FROM_MAX_DIST` vs `FRONTIER_TANGENT` based on `maxDistAt` threshold
- FRONTIER_TANGENT entry strategy (single new strategy in M4)
- Skip APPROACHING for edge entries; RELOCATING → CUTTING transition
- Strict 5-check validation gate (`hasClearedPlungeDisk`, `!wouldViolateSafeRegion`, `hasForwardProgressAlongTangent`, `initialEngagementBelowLimit`, `climbCorrect`)
- Climb direction as hard pre-filter (not delegated to CUTTING's `w_climb`)
- Frontier cell entry candidates require `clearedNeighbor != null`
- No fallback to centroid on UNRESOLVED — component is excluded and planner continues

**Explicitly deferred (NOT in M4):**
- closest-point as a separate strategy
- longest-run as a separate strategy (absorbed as a scoring term in frontier-tangent)
- In-material / stay-down linking
- Multi-frontier chaining

**Acceptance:** T3, T5, T6 all reach ≥ 99% coverage; T1, T2, T4 unchanged.

**M4-C1 complete (commit `bc0a6af`):**

*`ACParams` additions in `src/lib/cam/types.ts` (all optional with defaults):*
- `helixMinRadius = 0.5` mm
- `strategyTolerance = 0.5` mm
- `clearanceMargin = 1.0` mm
- `frontierPcaRadius = 2` cells
- `tangentStabilityMin = 0.25`
- `minEntryRun = 3 × stepDistance`

*`stock.ts` additions:*
- `ComponentInfo` type exported: `{cells, centroid, area, maxDistAt, maxDistAtPos}`
- `nearestUncutPocket` return type changed from `{center: Vec2} | null` to `ComponentInfo | null`
- BFS instrumented to track `maxDistAt` and `maxDistAtPos` during flood-fill
- `classifyComponent` function exported: `'CENTROID_FROM_MAX_DIST' | 'FRONTIER_TANGENT'`

*`planner.ts` changes:*
- RELOCATING consumes `ComponentInfo`
- `_enterRegion` uses `params.helixMinRadius ?? 0.5` for the `useHelix` threshold
- FRONTIER_TANGENT strategy stubbed — falls back to centroid entry, preserving M3 behavior

*Coverage after C1: T1 100%, T2 96.2%, T3 93.6%, T4 100%, T5 93.6%, T6 86.2% (identical to M3 — expected per the finding below).*

**Architectural finding from C1 (preserved for C3 reference):**

`maxDistAtPos` cannot serve as the entry position for `CENTROID_FROM_MAX_DIST`. The Borgefors chamfer-3/4 distance transform is discrete: the cell with maximum DT value lands fractionally off the true geometric center of the inscribed circle. Using `maxDistAtPos` as the entry position causes `_initialHeading` to derive a wall direction that doesn't align with the natural spiral entry path, and APPROACHING walks radially into thicker uncut material with engagement spikes.

Resolution: arithmetic centroid remains the entry position for `CENTROID_FROM_MAX_DIST`. `maxDistAtPos` is preserved on `ComponentInfo` as auxiliary data for C3 (helix sizing, classification tiebreakers, etc.) but NOT as the entry point. The strategy name "CENTROID_FROM_MAX_DIST" is somewhat misleading post-C1; rename consideration deferred to M4 wrap-up.

**M4-C2 complete (commit `a578044`):**

*`stock.ts` additions:*
- `FrontierNeighbor` type: `{cell: {col, row}, worldPos: Vec2}`
- `FrontierCell` type: `cell, worldPos, entryNormal, boundaryNormal, tangentA/B, clearedNeighbor, outsideSafeRegionNeighbor, hasClearedNeighbor, hasOutsideSafeRegionNeighbor, tangentStability, distAt, entryEligible`
- `FrontierEntryCandidate` type (defined for C3): `FrontierCell + plungePoint + heading + score`
- `PocketEntryDecision` discriminated union with strategy discriminant: `CENTROID_FROM_MAX_DIST | FRONTIER_TANGENT | UNRESOLVED` (with reason)
- `extractFrontierCells` method on `StockState`:
  - Two-pass algorithm (frontier identification + PCA tangent estimation)
  - Two separate normals: `entryNormal` (cleared-only) and `boundaryNormal` (outside-safe-only)
  - `entryNormal` sign convention: points FROM cleared neighbor INTO frontier cell; C3 plunge formula must SUBTRACT `entryNormal × offset` to move into cleared territory
  - PCA on local window of frontier cells with closed-form 2×2 eigendecomposition
  - `tangentStability = 1 − λ_min / (λ_max + ε)`
  - `entryEligible` three-condition gate (`hasClearedNeighbor` + stability + non-zero `entryNormal`)
  - No internal filtering — returns all frontier cells with computed values
  - `tangentStabilityMin` passed as explicit parameter (not read from `_params`)

*Test coverage (new file `m4-edge-entry.test.ts`, 9 tests):*
- 4 classifier unit tests (C-1..C-4): threshold behavior, deterministic boundary case
- 5 frontier extraction unit tests (FE-1..FE-5):
  - FE-1: one-sided cleared boundary; `entryNormal` direction
  - FE-2: 1-cell-wide strip; `entryNormal` cancellation; `entryEligible=false` correctly assigned
  - FE-3: boundary-only frontier; `clearedNeighbor=null`; `entryNormal={0,0}`; `entryEligible=false`
  - FE-4: L-shape corner stability vs straight arm (qualitative contrast)
  - FE-5: mixed cleared+outside-safe neighbor; normal separation verified

*Coverage after C2: unchanged from M3 baselines (T1 100%, T2 96.2%, T3 93.6%, T4 100%, T5 93.6%, T6 86.2%) — C2 is structural only, no planner behavior change.*

### M4-C3a — Frontier-tangent planning primitives — Complete (56599da)

**Scope:** Pure planning primitives, no planner.ts changes. C3a is the last sub-commit where frontier-entry logic can be tested in isolation before state-machine wiring (C3b).

**Files added:**
- `src/lib/cam/adaptiveClearing2d/frontierEntry.ts` (new, 700+ lines)

**Files modified:**
- `src/lib/cam/adaptiveClearing2d/stock.ts` — added `isInSafeRegion(point)` method (mirrors `isCleared` pattern); expanded PocketEntryDecision FRONTIER_TANGENT variant with explicit `plungePoint`, `contactPoint`, `heading` fields plus full `candidate` for telemetry
- `src/tests/adaptive-clearing/m4-edge-entry.test.ts` — added 16 unit tests

**Functions implemented in frontierEntry.ts:**
- `isClimbCorrect(heading, entryNormal, climb): boolean` — mirrors CUTTING's f_climb sign convention
- `generateFrontierCandidates(frontierCells, toolRadius, clearanceMargin, climb)` — emits one climb-correct candidate per entryEligible frontier cell; defensive skip for degenerate cases where neither tangent is climb-correct
- `scoreFrontierCandidate(candidate, stock, lastHeading, toolRadius, clearanceMargin, stepDistance): number` — 6-term penalty score, lower = better. Weights: 0.4 tangentStability, 0.5 clearedPlungeClearance, 0.3 forwardRunLength, 0.2 localWidth, 0.2 cornerPenalty, 0.1 directionFlip. Initial guesses; C3c visual review may rebalance.
- `validateFrontierCandidate(...)` — 8-check structured validation gate, returns `FrontierValidationResult = {ok: true} | {ok: false, reason: FrontierRejectReason}`
- `planFrontierEntry(...)` — orchestrator with rejection-reason aggregation; returns `{decision: PocketEntryDecision, rejectionCounts: Record<FrontierRejectReason, number>}`

**Validation check order (fail-fast, cheap → expensive):**
1. `not_entry_eligible`
2. `zero_entry_normal`
3. `wrong_climb_side` (defense in depth despite generation pre-filter)
4. `plunge_outside_safe_region` (pointInPolygon)
5. `plunge_disk_not_cleared`
6. `approach_segment_unsafe` (6 samples along plungePoint → contactPoint segment, all must be inside safeRegion)
7. `insufficient_forward_run` (default minEntryRun = 3 × stepDistance)
8. `excessive_initial_engagement` (engagement raycast at contactPoint, most expensive — last)

**Climb convention (verified from CUTTING scorer at planner.ts lines 186-195 and 383-392):**
- `wallDir` (CUTTING) and `entryNormal` (frontier) both point from tool position toward uncut material
- Formula: `crossVal = heading.x * normal.y - heading.y * normal.x`
- `crossVal < 0` → uncut on RIGHT of heading → climb-correct (matches f_climb = 0 in CUTTING)
- `crossVal >= 0` → uncut on LEFT of heading → conventional (matches f_climb = 1 in CUTTING)
- Frontier-tangent uses the same formula with `entryNormal` substituting for `wallDir`

**Plunge geometry (IMPORTANT architectural note for C3b/C3c):**

- Plunge point offset: `plungePoint = worldPos - entryNormal * (toolRadius + clearanceMargin)` (SUBTRACT — entryNormal points from cleared into uncut per C2 convention)
- At default values (toolRadius=5, clearanceMargin=1): plungePoint sits 6mm behind frontier cell, in cleared territory
- **Plunge disk validation check uses radius = `toolRadius`, NOT `toolRadius + clearanceMargin`.**
- Reasoning: `clearanceMargin` is the setback DISTANCE (offset from frontier to plungePoint), not a buffer added to the tool footprint disk. Using `toolRadius + clearanceMargin` as the check radius would always include the frontier cell (uncleared by definition since it's a component cell), making every plunge fail. The tool's physical footprint at plunge has radius `toolRadius`; the `clearanceMargin` sits as no-man's-land of cleared territory between the tool's leading edge and the frontier.
- T2 scoring term uses the same convention (sample radius = `toolRadius`)

**UNRESOLVED reasons (granular for C3b telemetry):**
- `'no_frontier_cells'` — extractFrontierCells returned empty
- `'no_eligible_candidates'` — frontier cells exist but none pass entryEligible + climb-correct tangent
- `'no_valid_candidates'` — scored candidates exist but all failed validation

**Tests added (16):**
- CC-1..CC-3: isClimbCorrect helper
- CG-1: entryEligible filter
- CG-2: tangent selection + plungePoint sign
- SC-1: scoring rank order
- SC-2: plunge clearance monotonicity (isolates the most important adaptive-entry preference)
- VG-1..VG-8: validation gate, one test per reject reason
- VG-OK: validation success case (guards against over-aggressive fail-fast)
- PFE-1: planFrontierEntry end-to-end (60×30 stock half-cleared)

**Test count: 43 total, all passing.**
- 4 M0 smoke + 7 M1 engagement + 6 M2 planner (T1-T6) + 4 classifier (C1-C4) + 5 frontier extraction (FE-1..FE-5) + 16 C3a primitives

**Coverage status (unchanged from M3 baselines — planner.ts not touched in C3a):**
- T1: 100% | T2: 96.2% | T3: 93.6% | T4: 100% | T5: 93.6% | T6: 86.2%

### M4-C3b — RELOCATING wiring + telemetry — Complete (cf4c539)

**Scope:** Wire planFrontierEntry into the planner state machine; add per-RELOCATING debug telemetry.

**feedHeight confirmed non-optional on HeightParams (src/types/index.ts:275). feedZ always available from resolveHeights.**

**Planner changes:**
- In RELOCATING, when classifyComponent returns FRONTIER_TANGENT, call `planFrontierEntry(component, stock, safeRegion, workRegion, lastHeading, params, nRays)`.
- If `decision.strategy === 'FRONTIER_TANGENT'`:
  - Emit Z sequence (see below)
  - Set `pos = decision.contactPoint`, `heading = decision.heading`
  - Transition directly to CUTTING (skip APPROACHING)
- If `decision.strategy === 'UNRESOLVED'`:
  - Push `component.centroid` to `failedCentroids`
  - Continue RELOCATING loop (nearestUncutPocket will exclude this component on retry)
  - **DO NOT call `_enterRegion(component.centroid)` or `_enterRegion(component.maxDistAtPos)` as a fallback.** This is a correctness invariant.

**Required Z sequence for FRONTIER_TANGENT relocation:**
1. Lift to `clearanceZ` (rapid)
2. Rapid XY to `decision.plungePoint` at `clearanceZ`
3. Descend: through `feedZ` if `feedHeight` is wired, else direct to `bottomZ`
4. Feed from `plungePoint` to `contactPoint` at `bottomZ`
5. Set `pos = decision.contactPoint`, `heading = decision.heading`, state = CUTTING

Use shared height-plane vocabulary: `clearanceHeight`, `retractHeight`, `feedHeight`, `topHeight`, `bottomHeight`. Resolve via shared `resolveHeights(heights, wcsOrigin)` from
`src/lib/cam/heights.ts` (Phase 1 Commit 1, `59b5e5f`). Local aliases (`const clearanceZ = ...`) are OK if clearly derived. DO NOT invent operation-specific Z names (no `safeZ`, `cutDepth`, `bridgeZ`, `plungeZ`, `relocationZ`).

**Per-RELOCATING telemetry log (consumed by debug viewer):**
- Component centroid + maxDistAt
- Frontier cell count + entryEligible cell count
- Candidate count after generation
- Top candidate scores (top 3)
- Selected candidate OR UNRESOLVED reason
- `rejectionCounts` from `planFrontierEntry` return value

---

## Prototype — Morph-Ring Construction (PROTOTYPE, visual review in progress)

**Branch:** `adaptive-clearing-v1` | **Prototype scope only — NOT integrated into live path**

**Status (HEAD 79943ec, 2026-05-27):** **Chained-offset ring-march is the sole ring-generation path (ADR-0012 implemented).** Rings are chained-offset polylines (prior ring offset by one stepover, real geometry), clipped against real walls by polyline intersection, endpoints extrapolated onto the wall by arc-continuation / long-tangent. The marching-squares / FMM-isocontour path substrate is RETIRED (79943ec); the FMM grid is now occupancy/region oracle only. Endpoint–wall contract exact: 272/272 ring endpoints on real walls, wallGap=0, wallTangentRisk=0 across all fixtures. Sagitta convexity correction (target 0.03, gain 3.0) holds the Paisley tail. Multi-bias steering driver aims the offset in-construction (non-deforming successor to the reverted post-hoc alley-steering). Handedness still single-sourced from spiral winding. tsc clean, 138 passed / 6 skipped. **Deferred:** Square+Island island-topology ring-ordering (blocked — multi-loop analytic spiral needed, angular ordering undefined); abrupt-turn steering on a sharp-turn fixture. **Open items:** spiral→ring-march continuity pin; cross-region cutting-order policy (DOMAIN decision). **Cosmetic delta (not a bug):** L-shape m1/m2 r0 zero-ring regions report termination `'no-source'` (was `'first-arc-cleared'`). **Next phase:** lead-in/lead-out + loopback layer — design model captured as §3a in HANDOFF.md (2026-05-28); construction method is the OCCT geometry kernel per the 2026-05-29 decision (`HANDOFF-OCCT-MIGRATION.md`), NOT hand-rolled tangent math.

**Files:** `src/lib/cam/adaptiveClearing2d/morphProto/` (analyticSpiral.ts, analyticInnerSpiral.ts, ringMarch.ts, clampedCubicSpline.ts, realGeomRings.ts, realGeomProof.ts, reMorph.ts, morphSpiral.ts, fastMarching.ts, marchingSquares.ts, testShapes.ts; fastMarching/marchingSquares now serve the oracle only) | **Viewer:** `debug-viewer-adaptive/morph-viewer.html` | **Fixtures (gitignored):** `test_fixtures/adaptive-clearing/morph-output/`

| Commit | Summary |
|--------|---------|
| `0948e17` | Fast-marching solver + marching-squares ring extractor + morph viewer |
| `5dcb3e8` | Drop open arc fragments from ring extraction (viewer straight-bridge fix) |
| `af6a696` | Guard barrier-corner NaN in interpolation; defensive assert on h/v edge crossing |
| `6b14e07` | docs: add morph-proto prototype section; record barrier-corner NaN fix |
| `0d8b52b` | feat: continuous outward spiral path from distance field (L-shape, ~5122 pts) |
| `7440c56` | docs: record spiral path built (L-shape), pending visual review |
| `dbc885d` | feat(morph-viewer): scrubber (drag/play/speed 0.1×–5.0×) + ring/spiral layer toggles |
| `bdcb92c` | fix(morph-viewer): lower default playback speed baseline to ~35 s at 1× |
| `7df4ac1` | feat(morph-proto): region-split detection + cleared-boundary re-morph (L-shape) |
| `da66ce1` | feat(morph-viewer): add re-morphed rings layer (purple, per-region toggle) |
| `187ce66` | feat(morph-viewer): extend scrubber to ring-march layer |
| `4182084` | fix(arc-march): derive traversal direction from spiral winding (all regions match) |
| `1873271` | fix(arc-march): correct arc handedness sign (crossZ opposite to winding for CW) |
| `c4d35d0` | feat(morph-spiral): add retrace-arc truncation trigger (M=2.0, merge=5×stepover) |
| `1519313` | feat(arc-march): accept truncationLevel for retrace-truncation handoff |
| `89fb6f9` | feat(paisley): wire paisley fixture + viewer button; add build self-checks |
| `9db4bdd` | fix(morph-viewer): constrain info overlay width; suppress undefined D values |
| `98d8933` | revert(arc-march): remove load-band arc-deformation steering; restore smooth arcs |
| `04ccb3f` | feat(morph-proto): engagement-bounded closing wall-follow lap (spiral crescent cleanup) |
| `b7b5976` | feat(morph-proto): couple spiral termination to disjoint wall-follow (L transition point) |
| `99a502e` | feat(morph-proto): uniform transition-point termination (continue past wall-follow to next boundary) |
| `967130f` | fix(morph-proto): remove post-lap theta-extension (eliminate straight-line jump through uncut stock) |
| `111e1d0` | chore: rename arc-march→ring-march, purge dead code, wire viewer fixtures |
| `820ecb0` | feat: real-geometry ring-march arcs (Newton-projected interiors + ray-trimmed endpoints) |
| `0b09e7f`–`c5f31bf` | clamped cubic spline primitive + S2 render gate + `ac-trace` doc series (sections 1–7) |
| `4f12110` | feat: grid-free real-geometry offset arcs on L-shape seed region (Stage A) |
| `f6f5594`/`7676668` | feat: V2 sandbox-proven first-ring generator (analytic seed) + clean spiral-derived first ring |
| `aebba5a` | feat: chained-offset ring-march (sandbox v6 ported, uniform) — L-shape |
| `4b03f20`/`379e6bb` | feat: seed from one more real spiral revolution; separate next-revolution generation from boundary trim |
| `f14e874` | feat: chained-offset rings for all three L-shape regions (boundary-offset seed for disconnected regions) |
| `7b3caea` | feat: mask-aware wall trim — reject far-side wall hits |
| `f65cee8` | feat: polyline-intersection wall trim — replace tangent-extension ray-trim |
| `a0f0fdd` | feat: chained-offset across all fixtures + scrubber playback + viewer stamp coupling |
| `9c753c2` | feat: endpoint extrapolation + multi-bias steering driver for chained-offset rings |
| `015cfbc` | feat: arc-continuation + long-tangent wall extrapolation (v10) — 272/272 endpoints on real walls, wallGap=0 |
| `adecc23` | feat: sagitta convexity correction (target 0.03, gain 3.0) — Paisley tail holds bow |
| `99deb74` | chore: remove dead mask-aware ray-trim helpers |
| `79943ec` | refactor: retire all superseded ring-generation paths; chained-offset is sole path; −1553/+154 |

**Three-case interpolation guard (af6a696):**
- Both corners barrier → unreachable; returns 0.5 (finite fallback, no null-return contract needed)
- dA=Infinity, dB finite → t=1 (crossing at inside-pocket B end)
- Both finite → unchanged clamped formula

**Truncation self-check (89fb6f9):** Paisley fixture must fire truncation at ring 9, L=32mm. Build fails if truncation regresses. Verified passing at 98d8933.

**Next step (current):** Lead-in/lead-out + loopback layer. Foundation: the "Toolpath Element Convention" note is now in project knowledge (`toolpath_element_convention.md`: element numbering, directionality, milling modes, cleared-region termination), and the full loopback/travel design model is captured as §3a in HANDOFF.md (2026-05-28). **Construction method — 2026-05-29 decision: the OCCT geometry kernel (`cadquery-ocp`), NOT hand-rolled tangent math — see `HANDOFF-OCCT-MIGRATION.md`.** The arc-to-wall termination quality gate is now largely addressed at ring-generation time (wallGap=0, 272/272 endpoints on real walls). Open prerequisites: multi-loop analytic spiral for Square+Island (island topology produces multi-loop rings, angular ordering undefined); cross-region cutting-order policy (DOMAIN decision — escalate to the user). Abrupt-turn steering remains a separate later effort on a sharp-turn fixture.

---

### M4-C3c — Fixtures + threshold raises + visual validation — In progress

**Scope:** New fixtures, big-bang threshold raises, visual review.

**C3c Commit 1 (f85ea98):** Structured diagnostic reporting in assertPlannerOutput. Removed duplicate engagement assertion (lines 255-259). No behavioral change.

**C3c Commit 2 — Threshold raises:**
- T3 (L-shape climb): 0.90 → 0.99 ✓ (actual 99.15%)
- T5 (L-shape bothWays): 0.90 → 0.99 ✓ (actual 99.15%)
- T6 (rectangle 60×30): 0.83 → 0.86 (honest floor — actual 86.21%)

**T6 diagnostic (honest floor justification):**
- 1 RELOCATING event, UNRESOLVED
- 15 candidates tried; 12 fail `insufficient_forward_run`, 3 fail `plunge_disk_not_cleared`
- Root cause: `minEntryRun = 3 × stepDistance = 7.5mm` exceeds available forward-run
  in the rectangle's remaining corner strips after spiral terminates
- Honest floor: 0.86 (86.21% actual; threshold set ~0.2pp below deterministic result).
  Closing gap to 0.99 requires planner enhancement (shorter `minEntryRun` for corner
  contexts, or a corner-probe strategy). Tracked for future milestones; not in C3c scope.
- Note: plan originally specified 0.87, which is above actual 86.21% — corrected to 0.86.

**T3/T5 diagnostic (why 0.99 but not 1.00):**
- 7 UNRESOLVED events each (identical — bothWays doesn't change corner geometry)
- All are small corner/strip fragments; dominant rejections: `plunge_disk_not_cleared`,
  `insufficient_forward_run`. These fragments are below the tool's physical reachability
  threshold for frontier-tangent entry. 99.15% is the effective ceiling for current planner.

**C3c Commit 3 — M4A/M4B/M4C validation fixtures:**

**M4A T-shape** (cap 60×30 + stem 12×30, 2mm safe corridor in stem):
- Coverage: 63.9% (0.6390532) — honest floor 0.63
- 1 RELOCATING event, UNRESOLVED: stem component centroid (30.0, 17.5)
- 84 frontier cells, 4 eligible, 4 candidates — ALL fail `insufficient_forward_run`
- Root cause: stem's 2mm safe corridor is shorter than minEntryRun=7.5mm. Planner
  fills the cap entirely but cannot enter the 12mm-wide stem at all.
- Improvement path: trochoidal / slot-following strategy for sub-minEntryRun corridors

**M4B L-shape narrow arm** (wide arm 60×30 + narrow arm 12×30, 2mm safe corridor):
- Coverage: 81.2% (0.8117732) — honest floor 0.80
- 2 RELOCATING events, both UNRESOLVED:
  - Narrow arm (5.9, 42.1): 85 frontier, 3 eligible, 3 candidates → UNRESOLVED
  - Rectangle corner strip (32.5, 23.5): 24 frontier, 15 eligible, 15 candidates → UNRESOLVED
- Aggregate rejections: insufficient_forward_run:14, plunge_disk_not_cleared:3,
  approach_segment_unsafe:1
- Root cause: narrow arm corridor (2mm) below minEntryRun; rectangle corner strips
  identical to T6 failure mode

**M4C Wedge** (trapezoid 60mm → 12mm base, converging walls):
- Coverage: 96.6% (0.9661489) — honest floor 0.96
- 3 RELOCATING events, all UNRESOLVED:
  - (30.3, 43.4): 29 frontier, 13 eligible, 13 candidates
  - (50.0, 6.4): 15 frontier, 6 eligible, 6 candidates
  - (9.4, 6.2): 11 frontier, 5 eligible, 5 candidates
- All 24 candidates fail `insufficient_forward_run`
- Root cause: converging walls produce forward-run shorter than minEntryRun=7.5mm
  in the narrowing tip region. The wedge geometry explicitly tests progressive narrowing;
  trochoidal motion would improve coverage near the tip (deferred).
- Best coverage of the 3 new fixtures (96.6%) because most of the wedge is wide enough

**Fixture geometries (verify before final dimensions — tool radius confirmed at 5mm, cellSize 0.625mm):**
- **M4A — T-shape**: 30mm base + 12mm thin arm (NOT 5mm — would collapse the safe region with 5mm tool). Tests entering a narrow arm.
- **M4B — L-shape**: 12mm vertical arm. Tests entering at a corner.
- **M4C — Wedge**: ~12mm base tapering toward 6mm tip. Tests progressive narrowing.

Arm width formula: `2 × toolRadius + ~2mm safe corridor` (= 12mm minimum for 5mm tool).

**Threshold raises (big bang):**
- T3 (L-shape climb): 0.90 → 0.99
- T5 (L-shape bothWays): 0.90 → 0.99
- T6 (rectangle 60×30): 0.83 → 0.99

**If 0.99 not reached:** Do NOT blindly force the threshold. Report diagnostics:
- Coverage % achieved
- Remaining uncleared area location
- Whether remaining area is tool-accessible (with this toolRadius)
- Dominant reject reasons (from C3b telemetry aggregates)
- Visual path observations

**Visual review distinguishes path roles:**
- Rapid (XY moves at clearanceZ/retractZ)
- Plunge/feed-down (Z descent at plungePoint)
- Frontier contact feed (plungePoint → contactPoint at cutZ)
- Normal cutting (CUTTING-state moves)

**Visual checks (all 9 fixtures — T1-T6 + M4A/M4B/M4C):**
- Plunge occurs in cleared territory
- plungePoint → contactPoint approaches from cleared side
- First CUTTING heading follows frontier tangent
- No plunge into narrow uncut arm
- No wrong-way conventional entry (climb correctness preserved)
- No unsafe centroid fallback
- Height planes use clearanceHeight/retractHeight/feedHeight/topHeight/bottomHeight conventions

### C3c Commit 4 — Realistic geometry baseline (fixture rescale)

**Scope:** Rescale all 9 fixtures to minimum 4:1 feature-to-tool ratios. Fixture concepts preserved; only dimensions change. Algorithm code unchanged (cf4c539).

**Why rescaled:** The original fixture geometry was too small for adaptive clearing's actual use case. AC pays off on substantial pockets at low radial engagement; on small geometry (especially old M4A/M4B/M4C with 12mm narrow features and 10mm tool — a 1.2:1 ratio) traditional pocketing or slot milling would be the appropriate strategy. Coverage data on such geometry doesn't measure algorithm quality; it measures whether the algorithm can do something it wasn't designed for.

**New geometry summary:**

| Fixture | Shape | Dimensions | Area |
|---------|-------|-----------|------|
| T1 | Circle | r=40mm, center (40,40) | ~5027 mm² |
| T2 | Square | 80×80mm | 6400 mm² |
| T3 | L-shape (climb) | 80×80 bbox, 40mm arms | 4800 mm² |
| T4 | Pentagon | inscribed r=40mm, center (40,40) | ~3800 mm² |
| T5 | L-shape (bothWays) | same as T3 | 4800 mm² |
| T6 | Rectangle | 120×60mm | 7200 mm² |
| M4A | T-shape | 120×60mm cap + 40×60mm stem | 9600 mm² |
| M4B | L-shape | 120×60mm wide arm + 40×60mm narrow arm | 9600 mm² |
| M4C | Wedge | 120mm→40mm over 80mm height | 6400 mm² |

Tool parameters unchanged: toolRadius=5mm, cellSize=0.625mm. Minimum feature-to-tool ratio: 4:1 (40mm / 10mm).

**Coverage results (algorithm from cf4c539, all thresholds calibrated to honest floors):**

| Fixture | Actual | Threshold | Dominant rejections |
|---------|--------|-----------|---------------------|
| T1 circle | ~100% | 0.99 | — (clean) |
| T2 square 80×80 | 97.9% | 0.975 | corner scallops (intrinsic) |
| T3 L-climb 80×80 | 80.0% | 0.79 | insufficient_forward_run:47, plunge_disk_not_cleared:23, excessive_initial_engagement:21 |
| T4 pentagon | ~100% | 0.99 | — (clean) |
| T5 L-bothWays 80×80 | 80.0% | 0.79 | same as T3 |
| T6 rect 120×60 | 91.4% | 0.91 | plunge_disk_not_cleared:24, insufficient_forward_run:18, excessive_initial_engagement:12 |
| M4A T-shape | 90.1% | 0.89 | insufficient_forward_run:35, excessive_initial_engagement:31, plunge_disk_not_cleared:6 |
| M4B L-narrow | 87.0% | 0.86 | plunge_disk_not_cleared:42, insufficient_forward_run:47, excessive_initial_engagement:5 |
| M4C wedge | 90.1% | 0.89 | insufficient_forward_run:23, plunge_disk_not_cleared:1 |

**6 of 9 fixtures land below 0.95.** This is above the escape-hatch threshold (3 of 9) and was surfaced as a finding rather than silently calibrated. The four named algorithmic findings below are the priority targets for post-research algorithm work. *(Superseded for forward work — see HANDOFF.md "Strategic context — where the morph prototype is headed": these findings characterize the old engine's relocation core, which the morph-spiral backend replaces. Retained as record, NOT as a forward worklist.)*

---

> **Superseded for forward work (see HANDOFF.md "Strategic context — where the morph
> prototype is headed").** These five findings characterize the OLD engine's
> relocation core, which the morph-spiral backend replaces. They are retained as
> record of that engine's behavior, NOT as a forward worklist — do not spend effort
> fixing them.

#### Finding 1 — APPROACHING fragmentation (T3, T5)

**Affected fixtures:** T3 (80.0%), T5 (80.0%)
**Prior coverage on old geometry:** 99.15% (60×60 with 30mm arms)

The APPROACHING state walks `wallDir` (toward nearest safe-region boundary) after a helix entry near the concave corner at (40,40). On the larger 80×80 geometry, this walk partially penetrates the upper arm and fragments the remaining uncleared region into multiple small components. Each fragment is below the `CENTROID_FROM_MAX_DIST` classification threshold (cannot fit a helix) and individually fails `planFrontierEntry` validation.

Diagnostic evidence: 5 RELOCATING events for T3, all UNRESOLVED, `FT:0 centroid:0`. All 91 total candidates across the 5 components fail validation — `insufficient_forward_run:47`, `plunge_disk_not_cleared:23`, `excessive_initial_engagement:21`.

This finding was masked by the old 60×60 geometry (20mm-wide safe arm), where the APPROACHING walk left clean large sub-regions. The larger 80×80 arm (30mm safe corridor) produces more complex fragmentation on partial penetration. The regression from 99.15% to 80.0% is the most significant result of the fixture rescale.

**Root cause hypothesis:** APPROACHING walks radially toward the boundary; the walk direction and step size, combined with the larger arm, leaves irregular cleared patches near the concave corner that subdivide the remaining upper-arm area into multiple non-enterable fragments.

**Improvement path:** Smarter APPROACHING termination (detect when entry into the next region is feasible rather than walking until `eng > minEng`); or a fragment-merging heuristic in `nearestUncutPocket` to treat adjacent small components as one entry problem.

---

#### Finding 2 — Near-boundary forward-run exhaustion (T6, M4A, M4C)

**Affected fixtures:** T6 (91.4%), M4A (90.1%), M4C (90.1%)

Components that form near a pocket terminus (right end of T6 at x≈110–115; stem end of M4A at x≈60; wedge tip at y≈74–80) have limited forward run in all viable heading directions because the safe region boundary is nearby. The `minEntryRun = 3 × stepDistance = 7.5mm` check rejects all candidates.

T6 diagnostic: 2 UNRESOLVED events both at x≈110–115. `plunge_disk_not_cleared:24` and `insufficient_forward_run:18` — the right-end corner geometry can't be plunged into from cleared territory AND has limited forward run. M4C: pure `insufficient_forward_run:23` near y=74–80 (available forward run to top safe boundary ≈ 1mm).

Note for M4C: old wedge (60mm→12mm over 50mm) achieved 96.6%; new wedge (120mm→40mm over 80mm) achieves 90.1%. The new wedge has a wider minimum (40mm vs 12mm) so the narrowest region is reachable, but the proportionally larger near-tip area (higher y range) increases the absolute area that falls below the forward-run threshold.

**Improvement path:** Context-sensitive `minEntryRun` — reduce the threshold when the component is small and near a pocket terminus, or when the only available candidates are all near-terminus. A corner-probe strategy (enter perpendicular to the terminus wall) could recover these regions.

---

#### Finding 3 — `excessive_initial_engagement` as new dominant failure mode (M4A, T6)

**Affected fixtures:** M4A (31 occurrences), T6 (12 occurrences)

`excessive_initial_engagement` is check 8 in `validateFrontierCandidate` — the most expensive check, last in the fail-fast order. On the old small-geometry fixtures it was rarely seen. On the new larger geometry it accounts for 31/72 M4A rejections and 12/54 T6 rejections.

Candidates that reach check 8 have already passed: `not_entry_eligible`, `zero_entry_normal`, `wrong_climb_side`, `plunge_outside_safe_region`, `plunge_disk_not_cleared`, `approach_segment_unsafe`, and `insufficient_forward_run`. Failing the engagement check at the contact point means: despite a geometrically valid approach path and sufficient forward run, the tool arrives at the material with `engagement > maxEngagement (120°)`. This can occur when the frontier cell is at a convex curve or corner of the cleared territory where the contact geometry funnels the tool into high-engagement territory on first contact.

Larger geometry produces more complex frontier shapes with tighter local curvature at some entry points, exposing this failure mode.

**Improvement path:** Pre-screen contact-point engagement during candidate generation (before the expensive raycast check at validation step 8) using a fast conservative estimate; or add a contact-point back-off that moves the contact point slightly further from the frontier.

---

#### Finding 4 — `plunge_disk_not_cleared` on wide corridors (M4B, T6)

**Affected fixtures:** M4B (42 occurrences), T6 (24 occurrences)

The wide arm in M4B (40mm arm, 30mm safe corridor) and the 120×60 rectangle in T6 should have ample room for a 10mm tool footprint. Yet `plunge_disk_not_cleared` is the single dominant failure mode in M4B (42/94 rejections) and significant in T6 (24/54 rejections).

The plunge disk check verifies that a disk of radius `toolRadius` centered at `plungePoint` lies entirely in cleared territory. `plungePoint = worldPos - entryNormal * (toolRadius + clearanceMargin)` — set 6mm behind the frontier cell in the cleared region. On fragmented or narrow cleared-territory patches (which appear as a result of Finding 1 fragmentation), the 6mm setback plus 5mm tool radius means the plunge disk can overlap adjacent uncleared material even when the nominal corridor is wide.

For M4B's 7 UNRESOLVED components, many are at the transition between the wide arm and the narrow arm, where the cleared region shape is irregular after APPROACHING fragmentation.

**Improvement path:** Adaptive `clearanceMargin` based on local cleared-territory width; or post-filter candidates by choosing the plunge position with maximum clearance from any frontier cell rather than the fixed-offset formula.

---

#### Finding 5 — Component-visit region-jumping (M4A, observed during Tier 2 visual review)

**Affected fixtures:** M4A (primary observation); likely present in any fixture with multiple RELOCATING events.

After APPROACHING fragmentation produces multiple small uncleared components, the planner visits them in score-order (`CENTROID_FROM_MAX_DIST` by `maxDistAt`; `FRONTIER_TANGENT` by top candidate score) rather than proximity-order. The result is crisscrossing rapid moves between geographically distant components instead of completing one region before moving to the next.

Visible on the M4A debug viewer: dashed rapid lines cross the cap region in multiple directions during the same clearing pass. The cutter bounces between the far-left, far-right, and center fragments rather than sweeping in any coherent spatial order.

**Impact:** Wasted rapid transit time between distant components; extra retract/re-entry sequences (each re-entry requires a fresh helix or plunge); mechanical stress from unnecessary Z-cycles; longer total cycle time without any coverage benefit.

**Root cause:** `nearestUncutPocket` returns the *largest* remaining component (by cell count), not the *nearest* one. After APPROACHING fragmentation, large components may be spatially far from the current tool position. The "nearest" in the function name refers to its original M3 intent (nearest uncut sub-region, measured by area rank, not distance) — the name is misleading.

**Improvement path:** Replace or augment the largest-component selection with a proximity-weighted scoring function: prefer components whose centroid is close to the current tool position, breaking ties by component area. A TSP-based or greedy nearest-neighbor ordering across all identified components would further reduce total rapid distance. See the "Component ordering optimization" note in Future Requirements for the pre-existing tracking of this item.

---

**Crossover correlation:** Old fixture JSON output preserved at commits 5bd60ee (initial M4A/M4B/M4C, tiny geometry) and 221ffb5 (post-C3c viewer state, small geometry baselines). Algorithm code unchanged from cf4c539.

**These results are the real baseline going forward.** All five findings become the input gap-analysis list for the post-research algorithm milestone. Future algorithmic improvements will be measured against realistic test cases, not synthetic small-geometry fixtures. *(Note: this framing is superseded — the morph-spiral backend replaces the relocation core these findings describe; they are retained as historical record of the old engine's behavior, not as a worklist. See HANDOFF.md "Strategic context — where the morph prototype is headed".)*

### M4-C3d — Viewer fix + physical and geometric upper bound metrics

Three diagnostic additions to support rest-material understanding:

1. **Viewer mask fix** (commit `7fd5d62`): StockSimulator now masks by `f.boundary` instead of `f.safeRegion`. Cells in the boundary-to-safeRegion ring (cleared by outermost spiral passes) now render correctly — green where the tool swept them, red where corner residuals remain. Previously these cells were hidden.

2. **Physical coverage metric**: Cleared cells / boundary interior cells. Measures actual material removal including ring clearance, with corner residuals counted against the denominator. Denominator is larger than the algorithm's safeRegion denominator, so physicalCoverage is lower than algorithm coverage.

3. **Geometric upper bound metric**: Theoretical maximum physical coverage achievable by any AC algorithm with this tool and geometry. Computed by stamping a `geometricStock` at every safeRegion sample point with `toolRadius` — the Minkowski sum of safeRegion and tool disk, intersected with boundary. A boundary cell is marked reachable iff any safeRegion point lies within `toolRadius` of it. Corner residuals at convex pocket corners are excluded.

#### Baseline (algorithm code cf4c539, all 9 fixtures)

| Fixture       | Alg cov (safeReg) | Phys cov (bndry) | Geo UB |
|---------------|-------------------|------------------|--------|
| T1 circle     | 100.0%            | 98.6%            | 98.9%  |
| T2 square     | 97.9%             | 89.0%            | 98.2%  |
| T3 L-climb    | 80.0%             | 62.5%            | 97.4%  |
| T4 pentagon   | 100.0%            | 95.3%            | 98.4%  |
| T5 L-bothWays | 80.0%             | 62.5%            | 97.4%  |
| T6 rectangle  | 91.4%             | 78.4%            | 98.2%  |
| M4A T-shape   | 90.1%             | 79.2%            | 98.1%  |
| M4B L-narrow  | 87.0%             | 74.6%            | 98.2%  |
| M4C wedge     | 90.1%             | 76.5%            | 97.5%  |

**Observations:**

- **Geometric upper bound is consistently 97–99% across all fixtures**, never 100% even for T1 (circle approximated as 32-segment polygon, creating tiny vertex residuals). The range is tight (97.4–98.9%), meaning the corner-residual loss is a near-constant ~1–2.5% of pocket area regardless of shape complexity.

- **Physical coverage is systematically lower than algorithm coverage.** The gap ranges from 1.4pp (T1) to 17.5pp (T3/T5). This is a denominator-framing effect: algorithm coverage is relative to the safeRegion (planning domain); physical coverage is relative to the full boundary. When the algorithm reports "80% covered," the true material-removed is only 62.5% of the pocket.

- **The gap (geometric UB − physical coverage) quantifies the algorithm's improvement opportunity** on each geometry. For T3/T5 it is 34.9pp; for T2 it is 9.2pp. These gaps are entirely closed by improving the planner — they are not geometric limits.

- **The gap (100% − geometric UB) quantifies unavoidable corner residuals** — approximately 1–2.5pp for all current fixtures. This will be the honest reporting floor for any future coverage assertion against physicalCoverage.

### M4-C3e — Rest-material gap: strategic documentation — Complete (c69a4eb)

#### The gap

The AC planner's `StockState` occupancy grid is the most accurate real-time record of what was and wasn't cleared — the planner updates it at every step as part of its decision-making. However, `StockState` is internal to the planner and is discarded after `buildAdaptiveClearingToolpath()` returns. The current output contract (`ToolpathMove[]` only, per ADR 0001) has no mechanism to expose the final stock state as a downstream-consumable data product.

The four findings from C3c Commit 4 (APPROACHING fragmentation, forward-run exhaustion, excessive_initial_engagement, plunge_disk_not_cleared) all leave identifiable rest-material regions that a subsequent re-roughing or finishing operation would need to address. Without rest-material output, downstream operations have no data about where material remains and would either re-cut already-cleared regions (cycle time waste) or enter uncleared regions at finishing feed rates (tool overload).

#### Strategic concern 1 — Engine unification

When rest material eventually lands (post-research milestone), the design MUST unify the stock-removal engine across:
- AC planner's internal `StockState` (planning decisions)
- AC output residual-material data product (downstream consumption)
- Simulation tab's material-removal visualization
- Downstream operations consuming prior operations' output

Building separate grids with different update semantics is a design risk — inconsistencies produce phantom stock or phantom gaps. The unified approach: `StockState` (or a serializable superset) becomes the shared representation across all consumers. The simulation tab and the AC planner should write to the same logical stock representation, not independent implementations.

*Expanded with industry grounding in landscape doc Section 7.7.*

#### Strategic concern 2 — Dependency tracking and staleness

Future operation-to-operation data passing (AC residual → pocket re-rough or finish) requires:
- Each operation declares which prior operation's output it consumes
- Reordering or modifying an upstream operation cascades invalidation to all downstream dependents
- Stale dependents are marked and recomputed in dependency order

The existing `outdateOpsReferencingGeo` pattern in `store/index.ts` handles geometry-change invalidation. The same pattern extends to operation-output dependencies: when operation N's residual stock changes, operations N+1, N+2, … that declared a dependency on it are invalidated. Residual stock should be stored in the Zustand store alongside `ToolpathMove[]`, with explicit dependency declarations.

*Expanded with industry grounding in landscape doc Section 7.8.*

#### Strategic concern 3 — 2D vs 3D scaling

In 2D, rest material is a flat set of ring and corner cells — manageable, and AC completion either succeeds or falls back. In 3D, rest material is essential for every downstream operation: roughing leaves substantial stock at multiple Z heights; pre-finishing and finishing require accurate per-height stock knowledge to avoid overloads or missed areas. The 2D `StockState` (Uint8Array occupancy grid) may be a stepping stone toward a 3D voxel representation, or a conceptually parallel system. The research milestone should determine: is 2D rest material a first-class deliverable, or primarily infrastructure for the 3D system?

*Expanded with industry grounding in landscape doc Section 7.9.*

#### Research milestone — Complete (c69a4eb)

The research deliverable answers Q1–Q13 (rest-material representation,
downstream consumption, resolution tradeoff, 2D-vs-3D, operation graph,
terminology, accuracy posture, integration timing, serialized form,
dependency declaration, shared engine API, first-class vs infrastructure
scaling, component-visit ordering) and proposes a first-cut design for
rest-material infrastructure.

The document also covers the broader adaptive clearing landscape:
commercial and OSS implementations, algorithmic taxonomy, controls
catalog, patterns library, and a five-milestone implementation sequence
(M5–M8). The recommended next algorithmic milestone is M5: four
first-order fixes addressing Findings 1, 2, 3, and 5 with expected
physical-coverage lift on T3/T5 from 62.5% to 80–85%.

See: docs/research/adaptive-clearing-landscape.md (1309 lines, 11
sections + Appendix A)

### M7 — Move-linking / stay-down infrastructure — Complete (8929861)

**Scope:** Three-tier stay-down/micro-lift/retract decision for BOTH RELOCATING
entry paths (FRONTIER_TANGENT and CENTROID_FROM_MAX_DIST). M7 was originally
scoped to FRONTIER_TANGENT only; CC pre-commit recon revealed real fixtures
produce zero FT successes, redirecting to both entry paths (see Scope
redirection note below).

**Commits:**

| Hash | Summary |
|------|---------|
| 0dd8674 | feat(ac-types): add 'loop_back' and 'wall_follow' to MoveRole |
| 9e0e856 | feat(ac): add analyzePathClearance to StockState + unit tests |
| 8d5aeca | feat(ac-types): add microLiftThreshold, microLiftHeight to ACParams |
| 8929861 | feat(ac): M7 three-tier stay-down/micro-lift/retract for both RELOCATING paths |

**Test results:** 93/93 passing at 8929861. New tests: AC-1..AC-4 (unit tests
for analyzePathClearance), SD-1..SD-3 (integration tests for stay-down behavior).

**Fixture impact (from pre-commit report):**

| Fixture | RELOCATING events | CENTROID breakdown | FT successes | UNRESOLVED | Coverage (alg / physical) |
|---------|-------------------|--------------------|--------------|------------|--------------------------|
| M4B | 14 | 11: 7 stay_down, 1 micro_lift, 3 retract | 0 | 3 | 87.0% / 74.6% (unchanged) |
| M4A | 19 | 16: 12 stay_down, 1 micro_lift, 3 retract | 0 | 3 | 90.1% / 79.2% (unchanged) |

Coverage preserved at baselines from C3d. Coverage improvement is not M7's
goal — motion-quality improvement is. The three-spirals-with-retract pattern
visible in prior visual reviews is replaced with continuous lateral feeds at
floor level for most inter-region transitions.

**Scope redirection note:** The original M7 plan was scoped to FRONTIER_TANGENT
only. CC pre-commit recon revealed real fixtures produce zero FT successes (all
RELOCATING events use CENTROID_FROM_MAX_DIST). Scope was redirected to both
entry paths. The three-spirals-with-retract pattern was produced by CENTROID
retracts; M7's extension to CENTROID was necessary for visible motion-quality
improvement. This is the canonical example of the CC escape hatch working
correctly: recon revealed a wrong architectural assumption, CC stopped and
reported, chat-side redirected scope before a single line of the original plan
was executed.

**Default parameter values:**

- `microLiftThreshold = toolRadius × 2` (= 10 mm for 10 mm tool). Prior
  proposals: a small lift of ~0.5 mm, FreeCAD ~3 mm, CC original proposal toolRadius × 4.
  toolRadius × 2 is a compromise. Exposed as `ACParams.microLiftThreshold`.
- `microLiftHeight = 0.5 mm`. Z rise above bottomZ for micro-lift hops.
  Exposed as `ACParams.microLiftHeight`.

**Future enhancements:**

M7 micro-lift implements two moves: rise to microLiftZ at destination XY in
one diagonal move, then plunge to bottomZ. A more sophisticated profile is a
"hop with midpoint apex": symmetric two-diagonal moves where the tool reaches
microLiftZ at the XY midpoint and descends to bottomZ at the destination. This
minimizes Z dwell time at the lifted height. `ToolpathMove` trivially
accommodates either profile; not implemented in M7.

**User visual review findings (next-milestone candidates, not M7 bugs):**

- M4B cap residuals terminated at UNRESOLVED — boundary-follow finishing would
  nibble along curved boundaries; M7's wall-follow primitive enables this
  geometrically but no strategy emits it yet.
- M4B L-corner shows three separate retract-plunge cycles instead of one
  continuous boundary-follow pass. Strategic gap.
- M4A asymmetric cleanup: right side has wall-follow finishing on a residual;
  symmetric left side does not. Suggests visit-order-dependent decision-making
  (M5 Finding 1 territory).

**Followups queued (not in M7 scope):**

- losPenalty multiplier retune in `_linkCost` (currently 1.5; retune
  empirically now that M7 provides real cost data per M7 plan Q3)
- diag_output.txt cleanup (.gitignore or delete)
- planner.ts line 308 lead_in / cut role discrepancy (pre-existing M8 cleanup,
  flagged during M7 recon)

---

## Open questions

- **Climb penalty stress-test (M3):** The `w_climb · climb_violation(θ, contact_side)` scoring term is implemented in M2 but contact_side flips are not exercised until M3 (island traversal forces direction reversals). Verify in M3 that the penalty produces correct climb-consistent behavior across region boundaries.

- **T3/T7 boundary-ray artifact (documented, not a bug):** The half-plane stamp test produces engagement = π + 2π/32 (one ray above π) because probes at θ=90° and θ=270° land exactly on the stamp boundary. This is a known discretization artifact of the ray-cast method; T3 asserts within ±2π/32 of π, and T7 uses nRays=32/64/128 (not 16) where the spread stays within 0.15 rad.

- **M3 acceptance criteria — coverage:** T3, T5, and T6 must all reach ≥ 99% coverage after RELOCATING is implemented. M2 baselines: T3 44.5%, T5 44.5%, T6 51.9%. All three fail for the same root cause — the spiral terminates when surrounded by cleared territory without reaching the full pocket. RELOCATING detects this termination, finds the nearest uncut region via `nearestUncutPocket` (currently a stub), and re-engages via a link move.

- **M3 prep — planner refactor required:** The current planner uses sequential labeled sections (ENTERING → APPROACHING → CUTTING → DONE) rather than a state-driven loop. M3's RELOCATING needs cyclic transitions (CUTTING → RELOCATING → APPROACHING → CUTTING) that the sequential structure can't accommodate cleanly. Small refactor to a state-driven loop is expected at the start of M3 before RELOCATING logic is added.

- **M3 RELOCATING entry strategy:** When finding the next uncleared region, the centroid of the largest uncleared cell cluster is the candidate entry point. Decide in M3: (a) fresh LIC helix entry at the new point, or (b) feed-level link if the transition is short. Decision deferred to M3 planning.

- **bothWays M3 test fixture design:** The conventional-segment check needs a shape that forces direction reversal — a long narrow slot or a multi-region pocket with cheap in-material links. Design deferred to M3.

---

## Pre-C3b architectural work — resolved

Identified in cross-operation Tier 1 audit. All items resolved in
Phase 1 Commit 1 — M4-C3b may proceed.

### cutZ handling — investigation required

AC's `src/lib/cam/adaptiveClearing2d/index.ts` (around line 13) sets:
```
const cutZ = heights.bottomHeight
```

Every other operation in the codebase does `heights.bottomHeight + wcsOrigin.z`. AC does not. Possible explanations:
1. Latent bug — works only because test fixtures use `wcsOrigin.z = 0`
2. Compensated upstream — the store sends pre-resolved Z for AC specifically
3. Intentional but undocumented

Read the store's COMPUTE_ADAPTIVE_CLEARING dispatch path before fixing. If a bug, fix in AC's index.ts. If compensated upstream, document it explicitly. Either way, address before adding more Z-aware code in C3b.

**Resolved in Phase 1 Commit 1 (`59b5e5f`).** AC's `index.ts` migrated
to `resolveHeights(heights, wcsOrigin)` from shared `heights.ts`.
`bottomZ` (= `heights.bottomHeight + wcsOrigin.z`) replaces the old
`cutZ = heights.bottomHeight`.

### safeZ → clearanceHeight migration

`params.safeZ` on ACParams (typed as "absolute WCS") is a pre-HeightParams holdover. Other operations derive `clearZ` from `heights.clearanceHeight + wcsZ`. AC should consume `heights.clearanceHeight` like every other operation.

Migration:
1. AC consumes `heights.clearanceHeight + wcsOrigin.z` for clearZ
2. Remove `safeZ` from ACParams interface in src/lib/cam/types.ts
3. Remove `safeZ` from any UI surface (NewOperationModal, PropertiesPanel)
4. Remove `safeZ` from worker payload construction in store dispatch

Bundle with cutZ fix as one commit: "AC height-handling normalization."

**Resolved in Phase 1 Commit 1 (`59b5e5f`).** `ACParams.safeZ` removed
from interface (`src/lib/cam/types.ts`), store dispatch, and UI. AC now
derives `clearanceZ` via `resolveHeights`. Bundled with cutZ fix as
planned.

---

## Future Requirements — Not Yet Implemented

### Helix entry as default entry motion (required)

**Status:** Not yet implemented. M4 implements plunge entry only as the simpler first cut. Helix entry is a required addition for a later milestone.

**Requirement:** Helix entry is the required DEFAULT entry motion for the operation. Plunge entry is the user-opt-in alternative (selected via an ACParams field, to be added). This matches commercial adaptive-clearing convention where endmills are often not efficient at center-cutting and helix entry produces gradual engagement rather than a full-disk plunge.

**Compatibility with current C3a primitives:**

The C3a primitives split into "lateral geometry" (transferable to helix unchanged) and "Z descent mechanism" (the part that changes).

Transfers directly:
- `isClimbCorrect` — heading + entryNormal independent of descent method
- Tangent stability (T1), forward run length (T3), local width (T4), corner penalty (T5), direction flip (T6) scoring terms
- Approach segment validation (check 6) — lateral move from helix exit to contactPoint is the same kind of motion as plunge-to-contact
- Engagement check at contactPoint (check 7) — first material contact matters regardless of descent
- Forward run check (check 8) — about the cut path after contact
- Climb pre-filter (check 3)

Needs extension:
- Plunge disk check (validation 5) → becomes helix-disk check: a disk of radius `helixRadius + toolRadius` around the helix center must be in cleared territory; alternatively sample around the helix circumference
- T2 (clearedPlungeClearance) scoring term → analogous helix-disk extension
- Candidate generation needs to compute helix center placement (offset from contactPoint along -entryNormal, similar to current plungePoint but factoring in helixRadius)

**Extension points to address when wiring helix entry (do NOT plumb these in C3b/C3c):**

1. **PocketEntryDecision shape refactor.** Current FRONTIER_TANGENT variant has `plungePoint: Vec2` as a top-level field. For helix support, refactor to a discriminated union:
```ts
   entryMotion:
     | { mode: 'plunge'; position: Vec2 }
     | { mode: 'helix'; center: Vec2; radius: number; exitPos: Vec2 }
```
   Every C3b consumer reading `decision.plungePoint` becomes a consumer of `decision.entryMotion`. Worth centralizing the consumer surface in C3b behind a single helper like `getEntryAnchor(decision)` to minimize the eventual refactor blast radius.

2. **validateFrontierCandidate** needs a helix-aware check 5: sample around the helix circumference; each sample's disk of radius `toolRadius` must be cleared.

3. **generateFrontierCandidates** needs to compute helix center placement when `entryMode === 'helix'`.

4. **ACParams** needs an `entryMode: 'helix' | 'plunge'` field, default `'helix'`.

5. **`ACParams.helixMinRadius`** is already defined (set in M4-C1) but currently unused. It becomes the user-facing minimum helix radius constraint when helix entry is wired. No drift here — it was prepped knowing helix would come later.

**Guidance for C3b/C3c (avoid making helix integration harder):**

- Where C3b reads `decision.plungePoint`, consider centralizing the read behind a small helper rather than scattering direct field access across the planner.
- C3c fixtures (M4A/M4B/M4C) should test edge-entry geometry generally (narrow arms, corners, sharp transitions) — not plunge-specific behavior. They're for testing frontier-tangent selection, not the descent mechanism.
- Do not invent plunge-specific Z vocabulary in C3b that would need renaming for helix.

### Debug viewer enhancements

`debug-viewer-adaptive/` is the current AC visual review tool (added in M2.5, commit 6ed4b43). It should grow features the previous React debug viewer had before being deprecated:

- Color coding per move type (rapid, cut, helix, ramp, plunge, stepover, lead_in, lead_out, loop_back, wall_follow)
- View on/off toggles per move type
- Regenerate button — re-run AC against fixtures and refresh JSON output after code changes
- General robustness improvements

Long-term goal: integrate adaptive toolpath preview into the main LIENCNC viewport/simulation system. Deferred until AC is stable — debugging AC against an unfamiliar visualization system would conflate AC bugs with viewer bugs.

### Pocket ↔ AC bidirectional alignment

The pocket operation (src/lib/cam/pocket2d.ts) has stable architecture worth porting INTO AC; AC has design discipline worth porting OUT to pocket. Specific items identified in Tier 1 audit:

- pocket2d's `emitHelix` (line 294) and AC's `_enterRegion` (planner.ts ~line 288) should converge on a shared helix subsystem
- pocket2d's inline `pointInPolygon` / `centroid` (private, different signatures) should consolidate with AC's `adaptiveGeometry.ts` versions in a shared geometry primitives module
- Other patterns TBD on close-read of pocket2d.ts (1000 lines — largest operation file in codebase)

### Shared subsystem extraction

Height planes, helical moves, retractions, ramping should each become their own
subsystem that operations consume rather than re-implement. Architectural goal: one
cohesive system of subsystems. Tracked as Phase 1 (architecture alignment) in
docs/ARCHITECTURE.md Roadmap.

**Phase 1 progress:**
- [x] **heights.ts** — Implemented, Phase 1 Commit 1 (`59b5e5f`):
  `resolveHeights(heights, wcsOrigin) → {clearanceZ, retractZ, feedZ, topZ, bottomZ}`
- [x] **feedrates.ts** — Implemented, Phase 1 Commit 2 (`6fef975`):
  `resolveFeedrates(tool, override) → ResolvedFeedrates`
- [x] **geometry/** — Implemented, Phase 1 Commit 3 (`24f3fb3`):
  consolidated geometry primitives (absorbs `offset2d.ts`, `adaptiveGeometry.ts`, pocket inline copies)
- [x] **moves/** — Implemented, Phase 1 Commit 4 (`238f568`):
  `rapidEntry`, `plungeTo`, `rampTo`, `cutLoop`, `cutLoopWithOverlap`, `retractFrom`
  (contour2d.ts and chamfer2d.ts migrated; `Pt2` alias removed, `Vec2` used throughout)

**Post-Phase 1:**
- Helix entry subsystem (consolidates `pocket2d.emitHelix` + AC `_enterRegion` +
  future helix-as-default work)

### Component ordering optimization

Current planner uses `nearestUncutPocket` (greedy nearest-neighbor) for component ordering during RELOCATING. A TSP-based or otherwise globally optimized ordering could reduce total transit time across components. Greedy is the correctness baseline; optimization is a layer on top. Defer until base coverage targets (T3/T5/T6 at 0.99) are met.

(Extracted from the deleted root-level ROADMAP.md item 4.)

---

## Misdiagnosis history

**Initial proposal (rejected):** Shrink the helix stamp from `(helixRadius + toolRadius)` to just `toolRadius` so that the first CUTTING candidate would immediately see uncut stock in the annulus. **Rejected** because this creates a phantom uncut annulus in the stock model — the planner would emit zero-engagement "cuts" through cleared air on a real machine. Physically wrong and silently wrong (no test would catch phantom air-cuts without a separate check).

**Correct diagnosis:** The stamp is physically accurate. The bug is in the planner state machine: CUTTING's termination criterion (`best.engagement < minEng`) fires immediately when all first-step candidates are inside the cleared disk. The fix is to add an APPROACHING state in the planner that traverses cleared air at feed speed until the tool reaches uncut stock.

---

## Decisions and rationale

| Decision | Rationale |
|---|---|
| Use `Vec2` throughout (not `Pt2`) | One point type only; `Pt2` is `adaptiveGeometry.ts`-specific |
| `adaptiveGeometry.ts` off-limits except 5 pure functions | Avoids inheriting spiral-op substrate; debugging ambiguity |
| Allowed imports from `adaptiveGeometry.ts`: `pointInPolygon`, `polygonArea`, `centroid`, `polyBBox`, `distToPolyBoundary` | Textbook stateless geometry; no algorithm design choices |
| `ClearedGrid`, `measureEngagement`, etc. — reimplemented fresh | See above |
| Worker wire-up in M0 | Integration safety: full compile path verified before any real logic |
| Module directory `adaptiveClearing2d/` | 5+ layers → 5 files; subdirectory cleaner than flat verbose names |
| `ACParams` in `src/lib/cam/types.ts` | Consistent with all other operation params in the worker protocol layer |
| Test fixtures: `test_fixtures/adaptive-clearing/` | Avoids collision with any future adaptive-spiral fixtures |
| Operation type: `'adaptive_clearing_2d'` | Distinct from `'adaptive_2d'`; matches naming convention |
| Grid bbox = `boundary` + 2-cell margin (not `safeRegion`) | Tool-disk edges and engagement probes at boundary positions reach the original boundary, not the inward-offset safe region. Two-cell margin covers floating-point edge cases at grid extremes. |
| Cell-cleared semantics: center-of-cell test | A cell is cleared when its CENTER lies within a stamped disk. Engagement probes call `isCleared(P)` at the probe tip; discrete error is bounded by ±cellSize = toolRadius/8. |
| Default ray count: 32 | One ray width = 2π/32 ≈ 0.196 rad, small enough for M2 scoring without excessive per-step cost. |
| `update(center)` with constructor-fixed radius | Planner always stamps at toolRadius; variable-radius API would expose surface the planner never uses. |
| Seam-based arc grouping in `engagementAngle` | Finding a not-in-contact seam before sweeping avoids splitting an arc that wraps across index 0. Correctly accumulates disjoint arcs (multi-arc case exercised in T6). |
| Helix stamp = `updateDisk(entry, helixRadius + toolRadius)` | Physically accurate: the helix tool-center path has radius `helixRadius`, so the swept disk has radius `helixRadius + toolRadius`. Reducing to `toolRadius` would create a phantom uncut annulus, causing air-cuts on a real machine. |
| APPROACHING state in planner | After helix entry, tool is inside cleared disk; CUTTING's termination fires immediately (engagement = 0). APPROACHING walks straight along initial heading at feed speed until `engagement > minEng`, then hands off to CUTTING. Designed as a real state so M3 RELOCATING can reuse the same "traverse cleared air to reach uncut stock" logic without retrofitting. |
| APPROACHING moves use `role:'cut'` | No new MoveRole values. APPROACHING moves are feed moves at cutting speed — physically a cut, even if engagement starts at 0. Keeps coverage simulation and boundary checks consistent. |
| APPROACHING safety bound = `2 × (max(0, helixRadius) + toolRadius)` | Limits traversal to twice the helix sweep radius. If no stock is found within that distance, something is geometrically wrong (bad heading, degenerate pocket). Retract and DONE rather than infinite traverse. |
| APPROACHING walks `wallDir`, not initial heading | Radial direction toward nearest safe-region boundary is more reliable than the initial heading for finding uncut stock. After exit, `heading` is recomputed via `_initialHeading` from the new position, pairing radial traversal with a correct tangent CUTTING heading. |
| T2 coverage threshold lowered to 95% | Corner scallops at 90° corners are intrinsic to adaptive clearing — the circular tool cannot fully clear a sharp convex corner without additional finishing passes. 96.2% actual vs. 95% floor is the correct M2 acceptance criterion. |
| T3/T5 coverage floor set to 40% | The L-shape's reflex vertex at (30,30) requires RELOCATING (M3) to clear the second arm. Current ~44.5% represents the accessible arm only. 40% catches regressions while ≥ 99% awaits M3. |
| T6 (60×30 rectangle) as M3 acceptance criterion | T6 diagnostic confirmed under-fill is not reflex-vertex-specific — the engagement-driven spiral terminates in any non-circular pocket. T3, T5, and T6 share the same root cause and the same planned fix (RELOCATING). Regression floor 0.50 vs. M2 baseline ~52%. |
| bothWays conventional-segment validation deferred to M3 | No M2 fixture exercises the bothWays mechanism: convex pockets (T1, T4) and the L-shape bottom arm (T3/T5) are clearable entirely in climb direction without retracts. bothWays only emits conventional segments to avoid retracts across region boundaries, which requires RELOCATING. M3 needs a dedicated fixture (long narrow slot, multi-region pocket). |
| Fixture write before coverage assertion | Diagnostic tests expected to fail (T6 at 51.9%) must still produce a fixture for visual review. `writeFileSync` moved before `expect(ratio >= minCoverage)` so the JSON always lands on disk. |
| Visual review viewer: fresh build, no spiral viewer reuse | Spiral viewer data shapes (rings, loop-back arcs, phase numbers) do not apply to AdaptiveClearing2D. Reuse would import wrong structural assumptions. Viewer built from scratch: file picker, SVG rendering, engagement color on absolute 0→maxEng scale. |
| M3 thresholds at baselines | T3/T5 at 0.90, T6 at 0.83 — regression floors with ~3pp margin below current coverage. 0.99 targets deferred to M4 with edge-entry strategies. |
| APPROACHING pre-emit maxEng check | Required for safe handling of plunge entries where helix sizing is constrained by region geometry. Refuses violating moves without stamping stock; transitions cleanly to RELOCATING with failed flag. |
| Failed-region exclude-by-proximity (toolRadius threshold) | Tracked in planner outer scope; `nearestUncutPocket` skips components whose centroid is within `toolRadius` of any failed centroid. Handles re-computed centroid drift from grid discretization (~1–2 cells = ~1mm) without state propagation complexity. |
| Strategy narrowing in M4 | Refined design implements frontier-tangent as the only new strategy. Closest-point and longest-run deferred indefinitely. Longest-run becomes a scoring term within frontier-tangent. Reasoning: commercial adaptive clearing follows "controlled engagement from existing cleared frontier" pattern, not a strategy zoo. |
| `CENTROID_FROM_MAX_DIST` uses arithmetic centroid | Borgefors DT discretization makes `maxDistAtPos` unreliable as an entry point. `maxDistAtPos` retained on `ComponentInfo` for auxiliary use in C3. |
| Climb as hard pre-filter at frontier entry | Adaptive clearing requires climb-correct first cut, not eventual convergence via `w_climb`. Climb-correct tangent direction is selected during candidate generation, before scoring. |
| Validation gate has 5 checks including `climbCorrect` | Defense in depth — even though climb is pre-filtered, the validation gate re-verifies for robustness against refactor regressions. |
| No centroid fallback on UNRESOLVED | If frontier-tangent fails for a component, centroid entry is also unsafe (that's why classifier picked FRONTIER_TANGENT). Component is excluded via `failedCentroids`; planner continues. |
| Test fixture geometries must be tool-radius-aware | New M4 fixtures (M4A/M4B/M4C in C3) need arm widths > 2 × toolRadius + safe-region margin, with `maxDistAt` below classification threshold. Earlier proposed dimensions assumed toolRadius 3.175mm but would produce collapsed safe regions. |

---

## MILESTONE — FreeCAD Adaptive2d PORT (2026-06-08) — SUPERSEDES M0–M4 above

**Pivot:** the bespoke M0–M4 state-machine planner (everything above this line) is
**retired/unwired**. Adaptive clearing is now a clean-room TypeScript port of FreeCAD's
Adaptive2d, living in `src/lib/cam/adaptiveClearing2d/engine/` (clipperEngine,
toolGeometry, geom, interpolation, steering, engagementPoint, processFeature, emit,
index). Source of truth = the `project_ac_freecad_port` auto-memory + the in-repo Python
reference at `docs/reference/FreeCAD_Mod_Adaptive_Path-master/Adaptive/`. The old
`planner.ts`/`stock.ts`/`engagement.ts`/`frontierEntry.ts`/`wallFollow.ts`/`morphProto/`
and the OCCT-linking work in `HANDOFF-OCCT-MIGRATION.md` are graveyard — do NOT re-enter.

**How it works:** constant cut-area-per-distance load held by a deflection-angle
root-find (clamped ±π/4) + 5-sample gyro heading smoothing; `cleared` = accumulated
clipper UNION; engagement = area(swept-capsule − cleared); regions emerge implicitly from
an engage-walker on the cut-region boundary + re-seeding (NO region decomposition).

**Done this session (branch adaptive-clearing-v1, HEAD 51b3cc9):**
- Phase 5 emit (`ac87453`, `4e484c3`, `056dbb0`): `emit.ts` turns FeatureResult.passes into
  Z-aware ToolpathMove[] (helix/plunge entry, cut, keep-down/lift links, multi-depth);
  `engine/index.ts` `buildAdaptiveClearingToolpath` adapts ACWorkerPayload → ProcessParams.
- Phase 6 wire (`8e7582d`, `a8fa109`, `251eb15`): routed store→worker→engine; full "2D
  Adaptive Clearing" op in NewOperationModal; paired ARCHITECTURE/UI-ARCHITECTURE docs.
- Perf (`d27bdfb`, ~1.7x): cleared-bounded engagement + one-shot corridor offset.
- Fix (`4a508c6`): honor params.loopIds (was machining the largest loop across ALL geometry).
- Fix (`51b3cc9`): keep-down links no longer gouge the island finish-stock band (split the
  jumpType decision into overload + finish-gouge checks).

**Validation:** all 9 sandbox fixtures clear 99.4–99.9% (worstGapR < toolRadius); engine
test suite 35 pass. Visual dumps gated behind `DUMP=1` (`_visual-dump`, `_emit-dump`).

**Open / next session (see `project_ac_freecad_port` memory for full detail + the ordered
hit list):** the LINKING/TRANSITIONS OVERHAUL — integral wall-follow (port old loopback
fillet onto the new arcs+walker; the centerpiece), fill seam/"squiddle", BootL corner-wrap,
keep-down high-feed; plus multi-part support, smoothing stage, deferred modal params, and a
cleared spatial-index perf step. NOT yet done: in-app visual sign-off across more parts.

---

## MILESTONE -- Linking, load-control + WALL FINISH (2026-06-09) -- over 51b3cc9

Work since the FreeCAD-port milestone (`51b3cc9`), branch `adaptive-clearing-v1`.

**Linking / transitions (prior sessions, HEADs `a756872`..`ccb29cd`):** `fast_traverse` move type + 3-tier feedrate; INTEGRAL WALL-FOLLOW (retract elimination, default on); FEATURE 2 "wall cleanup as we go" (`ACParams.wallCleanupAsWeGo`) + loopback fillet radius UI. Detail in HANDOFF.md history.

**This session (code HEAD `2caef90`, handoff `f7d1fd4`):**
- `8538719` LOAD CAP -- a 0.95 load setpoint holds cut-area-per-distance <= optimal smoothly (recenters the symmetric search; an asymmetric hard-cap was jagged + user-rejected). ~40% of steps were mildly over optimal; now ~0%. PROVISIONAL -- may be pulled back after the real-tool run.
- `537a549` STOCK-SIM CARVE FIX -- `SimulationPanel` `CUTTING_ROLES` now carves `wall_follow` + `lead_in`/`lead_out` (real cutting moves the live carve had skipped). This was the root of the user's "wedge ridge / area doesn't clean up" -- a SIM-DISPLAY bug, NOT a toolpath defect.
- WALL-FINISH FEATURE (`e241e8f`..`2caef90`): optional final wall cleanup. `ACParams.wallFinish` + `wallFinishMode` ('final' default / 'each_stepdown'); true-wall contour = `offsetClosed(featLoops, -toolRadius)` on the COMBINED boundary+islands (0 radial stock; an island too close to the wall blends into one wrapped contour); new `'finish'` MoveRole (magenta); finish feedrate override (`FeedrateOverride.finishFeedrate`, defaults to cut feed, not rapid-clamped); modal Linking-tab toggle; paired docs. User-gated the final-mode geometry live. Deferred (user Q1/Q6): FLOOR finish pass + finish LEAD-IN/OUT arcs.

**Validation:** tsc green; AC engine suite 57 pass / 4 skip; feedrate tests green. The `integral-wall-follow` test is intermittently flaky (clipper nondeterminism = the standing nondeterminism bug).

**Open / next (ordered; see HANDOFF.md banner + `project_ac_freecad_port` memory):** #1 missing/wrong-way loopback fillets (the <=90 gate `filletJoin` is DEAD CODE; fix = adaptive fillet radius); #2 engine nondeterminism; #4 BootL corner-wrap; #5 multi-part / "All Parts"; #6 toleranced polyline smoothing stage; #7 deferred modal params; #8 `cleared` spatial-index perf. HARD LESSON: never judge AC fill cleanliness by `worstGapR` / 2D-area-coverage -- those are blind to thin-but-tall spikes + scallops; use the in-app stock sim (heightmap) as ground truth.

---

## MILESTONE -- DETERMINISM + LOOPBACK FILLET FIX (2026-06-10) -- over d89957c

Backlog #1 and #2 from the wall-finish handoff, both closed this session. Branch
`adaptive-clearing-v1`.

**`bdbdcb1` ENGINE DETERMINISM.** Root cause OVERTURNS the prior theory: it was NEVER
"clipper set-ordering" -- clipper2-wasm is fully deterministic. The sole nondeterminism
source was the lone `Math.random()` in `interpolation.ts` `randInRange()` (a faithful
port of FreeCAD Interpolation.py's random probe angles, which can be directly ACCEPTED
as steering steps). Fix: fixed-seed mulberry32 per interpolator instance. Identical
inputs now emit byte-identical toolpaths; regression test `determinism.test.ts` runs the
engine twice in-process and asserts JSON byte-equality. Stale "clipper2-wasm is
stochastic" comments in `integral-wall-follow.test.ts` corrected.

**`b4c8b00` LOOPBACK FILLET GEOMETRY FIX + `6167758` circle-fit regression guard.**
Measured first (circle-fit audit, fixtures 0-8, deterministic HEAD): 12 MISSING
(exact-180deg straight REVERSAL links, fix5/fix1), 10 token arcs (sweep 11-60deg where
the joint needs 120-169), 1 crossed-contact backward traverse at pct25; 1 true 341.7deg
full-circle PIGTAIL + 413 MISSING at pct100. ROOT CAUSE: wall-ride budget (min 3.0mm)
overshoots so the outgoing contact F lands BEHIND the incoming contact E on the same
wall -> anti-parallel tangents -> `loopbackArc`'s silent den~0 fallback puts a contact
off-circle -> `sampleArc` wraps 2pi (pigtail) or the build degrades to a straight
reversal (missing). KEY FINDING: wiring the <=90 `filletJoin` gate (the handoff's own
prescription) would have been WRONG -- legitimate U-turn loopbacks sweep 90-161deg
(median 92.6); the bypass stays. Fix = geometry, not a gate: contact-overlap clamp
(forward-ordered contacts, zero coverage loss -- the overlap span is ridden twice),
adaptive Rf (t <= |EF|/2 and <= 0.9x own ride), fail-loud fillet validation
(contacts-on-circle, forward order, sampled sweep == intended turn) with an Rf retry
ladder; the straight-link fallback now carries a structured `console.warn` tripwire
(unreachable on all current fixtures). After: pct25 MISSING 12->0, token arcs 10->0,
backward 1->0, GOOD 1186->1230 fillet / 284->308 transition; pct100 PIGTAIL 1->0,
MISSING 413->0. Note: the prior "~173 good loopbacks" ballpark did NOT reproduce; the
committed guard's circle-fit class counts are the measurement of record.

**Validation:** tsc green; engine suite 59 pass / 4 skip (+determinism +loopback-fillet
guards); flaky integral-wall-follow now stable (3x clean). Renders:
`review-images/loopback-fillet-fixed-fix5.png`, `-pct100-fix5.png` (no defect class).
PENDING USER VISUAL GATE: balloon U-turns at pct100 (two tangent <=165deg arcs at
zero-length traverses, top-right pocket) -- constructed geometry, user judges motion
acceptability.

**Open / next (renumbered):** #1 BootL corner-wrap; #2 multi-part / "All Parts"; #3
toleranced polyline smoothing stage; #4 deferred modal params; #5 `cleared`
spatial-index perf; feature follow-ups: floor finish pass, finish lead-in/out arcs.
Manual tests still pending: `each_stepdown` wall-finish on a multi-stepdown pocket;
finish feedrate field. Engine-run limit RETIRED 2026-06-11: the ~12-engine-runs-per-
process clipper wasm abort was an embind handle leak in clipperEngine.ts (un-deleted
PathsD.get/PathD.get/polygon() heap copies), now fixed -- 20 runs in one process
verified flat at 16MB (engine/_wasm-leak-probe.test.ts).

---

## MILESTONE -- DEV-REPO CLEANUP (2026-06-10) -- docs/planning/CLEANUP-PLAN.md executed

**FORWARD WORK NOW LIVES IN docs/planning/FEATURE-REQUESTS.md.**

Stages 0-3 of docs/planning/CLEANUP-PLAN.md COMPLETE, all gates green: dirty tree settled in atomic
chunks; 1,763 files / ~224 MB research graveyard archived to
`..\LienCNC-CAM-archive\2026-06-graveyard\` (verified counts + ARCHIVE-MANIFEST.md);
dead TS removed (old planner, morphProto/, OCCT remnants; reachability dead-list = ZERO;
m5-wall-follow KEPT -- tests the live sampleArc contract); baggage removed (~110MB debris
+ ~350MB fixture diet, D2 user-confirmed; FreeCAD reference adopted to docs/reference/).
Stage 4 PARTIAL by design: trunk fast-forwarded + renamed `master` -> `main`; all tips
tagged `pre-cleanup/*-2026-06-10`; loopback-v2 deleted; a brep merge was fully gated
green but BACKED OUT (Operator wanted the branch prepared, not merged -- parked on tag
`staged-merge/brep-into-main-2026-06-10`, main reset to `87000aa`; brep/sketch have since
advanced, fresh merge on Operator's go); sketch merge blocked on Operator's visual gate; research
branches archived-by-tag, deletion is Operator's call. New baselines on `main`: tsc clean;
engine 56 pass / 4 skip; cam 88 pass (112 only after a future brep merge); geometry suite
has zero tests (occt-smoke removed). `87000aa` also flips optimal-load default 97% -> 25%.

## MILESTONE -- MATERIAL-SAFETY GATES: stay-down rides + lift landings (2026-06-12) -- 472eb61

B8 (Operator's island report, POST-MERGE-WORKPLAN Group 2): integral wall-follow
substituted an unvalidated boundary ride for a planned lift -> full-width slot
(6.00mm at 1.5mm stepover, 101mm over uncut) through solid stock. Fix: engagement
gate sweeps the candidate ride vs cleared-at-pass-start; sustained >=2mm window
above 1.5x stepover -> reject, keep the lift (fail-loud warn). Loopbacks NOT
gated: measured contact at/below optimal load = valid skims (Operator confirmed
visually; remember the 149-good-loopbacks lesson - watch, don't build).

Second gate: wallCleanupAsWeGo relocated post-lift plunge landings with no
material check (Bar first transition measured 97% uncut disk = center plunge
into solid). Landing gate: disk vs cleared, cap 5%, adaptive entry-ride shrink,
collapse to walker point when nothing safe remains.

Measured: island repro zero over-cap rides, all lift landings <=0.2% uncut;
fixtures fix0/1/3/6/8 byte-identical, fix2/4/5/7 ride-vs-lift policy only
(render pairs docs/planning/b8_*.png). Permanent gate test:
src/tests/.../staydown-engagement.test.ts; probes kept (_b8-slot-probe,
_lift-reentry-probe). Suite 815 pass / 14 skip.

OPEN (queued next, Operator design input): early-job RAW walker landings can be
unsafe (Bar first transition 87.8% uncut, currently warned + emitted) -> needs
helix/ramp re-entry sized by cleared area near the landing. Also open: 180deg
loopback-fillet failure falls back to STRAIGHT keep-down link (tripwire fires on
island repro, (116.95, 66.50)); wall-follow/loopback removal never folded into
cleared accounting (conservative under-count).

## MILESTONE -- HELIX-DESCENT LIFT LANDINGS: the raw-walker-landing hole closed (2026-06-12, uncommitted)

Closes the OPEN item above (Operator's approved direction: "look at Helix entries
nearby and then lead into the path we want to follow"). EVERY emitted jumpType-2
lift landing is now gated (not only relocated ones): when the landing disk's
uncut fraction vs cleared-at-pass-start exceeds the 5% cap, processFeature plans
a HELIX DESCENT (planHelixDescent) -- radius = min(helixDiameter/2, toolRadius)
(rh <= toolR guarantees the helix opens its FULL disk, no center post), centre
shifted inward off the wall by exactly rh along the local boundary normal (both
senses tried, halved down to the 0.2 floor if it does not fit). |centre-landing|
<= rh makes the short at-depth lead from helix bottom to the pass start provably
stay inside the helix-opened disk (R2 by construction). emit.ts emitLink honors
the link.helixDescent flag by reusing the SAME helix ramp as a region entry
(emitHelixRamp, extracted from emitEntry: same modal helixAngle, edge backoff,
safe approach), then a 'lead_in' feed to the landing; the pass still starts at
the same point, no reversal, deterministic. If no helix fits the planner falls
back to the OLD warned straight plunge ('NO helix fits' warn -- nothing silent);
measured: that fallback fires on NO current fixture.

Measured: Bar first transition (89.3% uncut raw walker landing) -> helix at
(141.43, -51.97) r=1.90; BootL (42.7% at (24.83, -98.66)) -> helix at
(24.83, -100.56) r=1.90. Byte-stability vs 2ab5f88 baseline: ONLY fix4 Bar +
fix5 BootL changed; the other 7 gt fixtures byte-identical (hashes in
docs/planning/_bytestab_baseline_2ab5f88.json / _bytestab_after_helix.json).
Render: docs/planning/helix_reentry_bar.png (full Bar + 30mm zoom; generator
_helix-descent-render.test.ts, HELIX_RENDER=1 env-gated). Gate test tightened:
staydown-engagement.test.ts -- Bar first transition MUST carry helixDescent +
emit helix-role moves (no plunge at the landing), BootL blanket no-straight-
plunge-into->cap-disk, island/Bar/BootL assert the unsafe fallback warn ABSENT.
Suite 856 pass / 15 skip (was 855/14: +1 BootL test, +1 env-gated render skip).

Still open (unchanged): 180deg loopback-fillet straight-link fallback on island
repro; wall-follow/loopback removal not folded into cleared accounting.

## MILESTONE -- AC PERF: B6 progress + B7 byte-identical speedup (2026-06-16) -- e251b83, 49951da

B6 (POST-MERGE-WORKPLAN Group 5): real progress feedback during long AC computes,
which previously stuck at 10%. Per-pass progress reporting now ticks the AC op
through the compute (commit e251b83), so the user sees genuine movement instead of
a frozen bar. This supersedes the old "deferred until the AC planner is finished"
note that scoped AC to coarse phase-boundary ticks only.

B7 (Group 5): large-area performance. PROFILE-FIRST was the lesson here. The first
hypothesis -- a spatial index over the `cleared` polygon for engagement queries --
was built, profiled, and REJECTED: it came out 1.41x SLOWER and was not
byte-identical (ADR-0023, recorded in commit a99b4b5). The box cache already
mitigated the assumed cost, so the assumed hot spot was wrong. The fix that
actually shipped (commit 49951da) was H7: a box-clip of the engagement walker's
disk-bite, narrowing the polygon work to the local window. Result: 4.65x faster
(572070ms -> 122903ms) and byte-identical on all 9 bytestab fixtures -- a pure
speedup, no path change. Full record: docs/planning/AC-PERF-B7-IDEAS.md (the
profile-first brainstorm + ranked hypotheses) and
docs/planning/AC-PERF-B7-H3-FEASIBILITY.md (the post-H7 deep dive showing the
remaining bottleneck is clearedNear at ~47%).

Still open (unchanged): 180deg loopback-fillet straight-link fallback on island
repro; wall-follow/loopback removal not folded into cleared accounting.

---

## TRUTH NOTE 2026-07-15 (housekeeping sweep, HEAD dd257c0d)

The bespoke-planner parameter fields introduced in the M4-C1 and M7 milestone
logs above are DEAD at HEAD. `ACParams.helixMinRadius` (M4-C1) and
`ACParams.microLiftThreshold` / `microLiftHeight` (M7) remain typed in
src/lib/cam/types.ts but have ZERO consumers - `planner.ts`/`stock.ts` were
deleted with the bespoke engine (see the "FreeCAD Adaptive2d PORT" pivot
milestone above). The live engine's helix floor is the hardcoded
`minHelixRadius` 0.2mm default in engine/emit.ts, and its user-settable knobs
are `helixDiameter` / `tolerance`. Do not read the M4-C1/M7 entries as current
behavior; the fields' doc comments in types.ts still claim runtime behavior
and a code-comment cleanup is owed (flagged in docs/FEATURE-HITLIST.md Part 2,
AC "Exposed params").

## TRUTH NOTE 2026-08-04 (housekeeping sweep, HEAD 4c36467e0)

Shipped AC milestones after the 2026-07-15 note above are now on this branch:

- B8 stay-down route-around stages 2 and 3 (`fc1c0d0ea`, `33818e9d3`).
- Floor-finish replay and tangent wall-finish leads (`2d3d4c0bb`, `32ceaf5d7`).
- User-settable minimum helix radius and integral wall-follow budget
  (`6a659437e`, `a87de6617`).
- Conventional-milling support plus corrected material-side semantics
  (`e7a3349fb`, `e8a352a14`).
- Finish leads constrained to the pocket region (`5088606cc`) and the shared
  insufficient-flute-reach fail-loud guard (`24fb11a56`).

Current delivered-vs-not truth remains code plus docs/FEATURE-HITLIST.md. The
dated AC-PERF-HANDOFF is implementation history, not a live mechanical status.
No test or build gate was rerun for this documentation reconciliation; all
older counts above remain historical evidence for their named commits.
