> RETIRED / SUPERSEDED (2026-06-16). This plan describes the now-DELETED reactive
> planner (`runPlanner` / `index.ts` / `planner.ts`) as the production tree, and
> reference-GT overlay as a mandatory gate. Both are dead. The shipping AC engine is the
> FreeCAD Adaptive2d TS port in `src/lib/cam/adaptiveClearing2d/engine/`; the current
> gate is the bytestab fingerprint, not reference corpus overlay. Kept for historical reference
> only. Current state: see `docs/planning/AC-PERF-HANDOFF.md` and the LATEST milestone
> at the bottom of `STATUS.md`.

# Adaptive Clearing — MASTER PLAN & WORK CONTRACT

> Authoritative plan for finishing Adaptive Clearing (AC) in the SHIPPING TypeScript pipeline.
> Created 2026-06-07 after the 384-image / month-long failure audit
> (`docs/History of Issues and Redirections/AUDIT-Issues-and-Redirections.md` + 4 code deep-dives).
> This file exists to STOP the regression loop: criterion-cracked-on-paper -> fixed-in-a-sandbox ->
> production-unchanged -> same-defect-returns. It is the single contract every work session (and every
> subagent) reads first. It supersedes ad-hoc memory. Companions: `AC-SPEC.md` (the rules),
> `AC-ATTEMPTS-LEDGER.md` (dead/lost code), the deep-dives.
>
> **Change no shipped behaviour without (a) the relevant wired gate passing and (b) a reference-GT overlay
> in correct orientation inspected by Operator. A green coverage number is NOT a pass.**

---

## 0. THE ROOT CAUSE THIS PLAN FIXES (read first)

The failures are not 300 bugs; they are a small set of families recurring because **the validated fixes
are not in the code the app runs.** Three parallel AC trees exist; production ships the OLD reactive
planner (`adaptiveClearing2d/index.ts -> runPlanner`; regions from `stock.ts nearestUncutPocket`
flood-fill; ZERO gates). The proven solutions live in Python sandbox scripts or orphaned TS
(`morphProto/ringMarch.ts buildAlleyArcRegions`, `scripts/linking.py`) that production never calls, and
the one prototype detector that is wired is gated by a criterion the Ledger already KILLED.

**Therefore the single highest-leverage action is NOT another algorithm. It is: consolidate onto the
shipping TS tree, PORT the validated region engine + linking layer + safety/honest gates in, and WIRE
the gates to fail loud against reference corpus GT.** Everything below serves that.

---

## A. WHAT ADAPTIVE CLEARING **IS** (definitive)

1. A 2D **constant-engagement** clearing operation. Constant radial tool load **by construction** of the
   geometry — not by per-step FEA. "If the paths yield essentially constant load, we don't calculate it."
2. **Helix entry** at the deepest point (largest inscribed circle) of a region.
3. **One continuous outward spiral** from that entry, stepover = the optimal-load value, that **flows
   directly into wall-to-wall arcs** — a single connected path per region, helix-centre to last ring.
4. **Region decomposition by FILL-FRONT BREAK** (where the advancing chained-offset front must
   REPOSITION to stock it cannot reach in-line). Validated ONLY vs measured reference GT (`_fusion_regions`).
   Targets: **Comma 1, Kidney 2, Tee 4, Bar 1, BootL 5, Barbell 1, SquareIsland 4.**
5. **Islands / already-cut frontiers = PSEUDO-BOUNDARY.** ONE consistently-wound front treats the cleared
   edge as a wall, wraps the island, and **rejoins its own path.** Generalises to N islands.
6. **5-role passes:** wall_follow_entry · lead_in · MAIN_ARC · lead_out · wall_follow_exit, each tagged
   with feedrate-by-role. Leads/wall-follows/loopbacks from the validated linking layer.
7. **Loopbacks/repositions are ARCS over CLEARED stock** (opposite spiral sense is allowed THROUGH
   cleared; the CUT never reverses).
8. **Gradually-varying curvature** (the reference corpus's measured U-shape: ends ~7x tighter than the middle),
   tangent joints, single operation-wide winding. Output = best-fit polyline; arc-fitting is the
   POSTPROCESSOR's job (ADR-0001).
9. **Reaches `toolpath_center`** (the explicit tool-centre limit) on cuts AND wall-follows — never inset.

## A'. WHAT ADAPTIVE CLEARING **IS NOT** (the recurring kludges — banned)

- **NOT concentric circles about a fixed centre** / symmetric distance-field level-sets (Euclidean OR
  geodesic). They close on themselves behind an obstacle = **meet-at-the-back**. Structurally forbidden.
- **NOT a boustrophedon / zigzag raster** (alternating rows = reversing cut = forbidden).
- **NOT attacking an island or region from BOTH sides** (two fronts colliding anti-parallel).
- **NOT** per-arc biarc/G2 forced fitting (postprocessor does that); **NOT** forced tangency at the cost
  of smooth curvature (caused the Phase-2 wobble).
- **NOT** region-per-corner or region-per-medial-fork; **NOT** connectivity-erosion splits (over-fire at
  necks; Ledger #20/#21/#22 DEAD).
- **NOT** path reversals; **NOT** rapids/cuts over UNCLEARED stock; **NOT** out-of-`toolpath_center`
  moves; **NOT** sealing geometry / special-casing a fixture.
- **NOT** reference corpus arc shapes as INPUT (P3 cheat). reference corpus GT is the success BAR only.
- **NOT** a coverage scalar standing in for the geometry (a green `cov=0.99` with a visible defect is a
  GATE DEFECT, not a pass).

---

## B. RANKED REQUIREMENT HIERARCHY (1 = highest, NEVER violated)

A lower-priority control may SHAPE geometry but **may never break a higher rule.** On conflict the higher
wins and the lower is retarded/limited — never the reverse. A "convenient" or "cheap-win" violation of a
higher rule is an automatic REJECT, no matter how good the lower-order result looks.

1. **MATERIAL SAFETY [R1]** — no gouge (stay inside `toolpath_center`); no non-cutting move over UNCLEARED
   stock; cleared stock is safe (rapids/loopbacks through cleared allowed). A crash = a move over
   uncleared. **Fail-loud REJECT.**
2. **OPTIMAL LOAD / ENGAGEMENT [R2]** — radial engagement never EXCEEDS the stepover; no inter-pass gap
   (incl. spiral-core -> first arc) > stepover. Gain curvature by retarding endpoints, never by
   exceeding stepover. Asymmetric: under is OK, over is forbidden.
3. **CUT TOPOLOGY & DIRECTION [R3]** — single operation-wide winding (climb/conventional set by
   operation, NOT per region); wall-follow rides toward CLEARED; **no cut reversals**; lead/wall-follow
   fillet <= 90 deg (single corner-nibble closure exempt); regions by fill-front-break.
4. **TANGENCY & GRADUALLY-VARYING CURVATURE [R4]** — tangent joints (analytic D1), no curvature
   spikes/sign-flips on mains. Do not force tangency at the cost of smoothness.
5. **FEEDRATE-BY-ROLE [R5]** — all 5 roles tagged with distinct feedrates; preserve role boundaries even
   when geometry merges.
6. **SHAPE / AESTHETIC [R6]** — wall-reaching extension, lead-radius, GT-look. Subordinate to R1-R5.

**Whole-path completion invariants (checked at the end):** W1 100% wall coverage + reach toolpath_center;
W2 reposition count <= the reference corpus's; W3 region count == the reference corpus's; W4 per-pass shape fidelity vs enriched GT;
W5 role/component fidelity vs GT `cut_components`.

---

## C. DEFINITIVELY MEASURING BACK TO REFERENCE GT (the only acceptance)

- **Ground truth = the enriched JSON** `test_fixtures/.../_gt/gt_fix{0..8}.json` (boundary, islands,
  toolpath_center, cut, spiral, helix, `cut_components[i]={kind,frac}`) + `_fusion_regions` for region
  count/locations. NOT the bare DXF, NOT synthetic shapes.
- **Every gate measures the FRONT / the path geometry, never a coverage scalar.** Strengthen, never
  weaken. **The reference corpus GT must PASS every cap** (the honesty proof) — if reference corpus fails a cap, the cap is wrong.
- **Always overlay in the correct orientation** ("from above"; island upper-right, like
  `goal/_scout_cl2.png`). A mirrored render is a non-comparison.
- **Shape fidelity** = per-pass arc-length-ratio + symmetric Hausdorff + the DISTRIBUTION (worst pass +
  count), never a centroid-matched average (that metric called a spider-web a 7.9mm match).
- The B-GATE (regions), linking-gate, safety-gate, and W-gates below are the contract. **No "done"
  without the inspected overlay artifact in front of Operator.**

### The wired gates (fail-loud, all 9 fixtures, every change)
- **B1-B7 (regions, vs `_fusion_regions`):** B1 count exact; B2 split locations bijective; B3 no split at
  a taper (front piece must hold a plateau width >= k*stepover over >= m rings); B4 flow-through (no split
  where the front stays one advancing piece — Barbell neck, Kidney waist); B5 no float (every sub-region
  reachable in-line or via a logged reposition; no uncut band > stepover to a sibling); B6 island-wrap
  (one wound front, NO anti-parallel coincident cut pair at any island back — geometric headon=0);
  B7 order+winding (finish-region-before-next; one operation-wide sense).
- **SAFETY:** zero moves over uncleared (vs ClearedGrid); zero cut turns > 150 deg; zero segments outside
  toolpath_center (densified, < 0.01mm); all repositions are arcs.
- **LINKING:** 5 roles present + feedrate-by-role; joints location-exact + tangent (analytic D1 < ~0.1deg);
  no lead fillet > 90 deg (nibble exempt); loopbacks are arcs over cleared.
- **LOAD/COVERAGE:** engagement <= stepover everywhere (real inter-pass distance, not within-R);
  swept-tool uncut clearable area + largest-uncut-cluster small (reference-calibrated); path continuity
  (no unbridged jump > stepover).
- **W3 region-count + W4/W5 fidelity** wired in `src/tests/adaptive-clearing/ac-invariants.test.ts`.

---

## C2. REFERENCE-CORPUS REVIEW PROTOCOL (BINDING — run on EVERY AC change; RULES, not suggestions)

**Why this exists (Operator 2026-06-07).** The recurring failures came from (a) judging our output by a scalar
with NO ground truth in the frame, and (b) chasing pixel-identical reference corpus overlap. Both are banned here.
The recorded paths provide measured examples of constant engagement, smooth curvature and region
transitions. Review and quantify these properties without requiring identical geometry.
These are encoded as RULES on purpose: memory is forgotten, rules are adhered to. They are meant to make
progress EASIER (clear acceptance, fast dead-end detection), not harder.

- **RP1 — GT IN EVERY FRAME, ALWAYS.** Every visual artifact MUST draw the reference corpus GT in the same frame,
  correct orientation (island upper-right, `invert_yaxis`), via `sandbox_ac/scripts/_gt_overlay.py` (the
  mandatory base layer: boundary / toolpath_center / islands / spiral / cut passes / helix / region splits,
  each labelled so its meaning is never guessed). NEVER render or judge our output alone — an ours-only image
  is not evidence.
- **RP2 — ACCEPTANCE = SAME TYPE OF DECISION as the reference corpus, NOT identical geometry.** 100% geometric overlap is
  explicitly NOT the goal — it is likely impossible and not beneficial. Do NOT optimize toward
  pixel/Hausdorff-identical output. Acceptance = our toolpath makes the same KIND of decisions reference corpus makes,
  measured by the decision-signatures in RP3. "Replicate BEHAVIOR, not exact output" (correlate up to the
  first region split; divergence after is acceptable; Operator is the visual judge).
- **RP3 — THE METRIC TOOLSET IS FOR REVIEW, NOT A TARGET OR A HANDCUFF.** Use
  `sandbox_ac/scripts/_arc_evolution.py` (signed metrics, ACTUAL coordinates, runs on GT and ours) to ANSWER
  "are we deciding like reference corpus?" — never as an objective function to maximize. The decision-signatures (and
  what each MEANS, so it is not misread):
    - **Constant engagement** — interior perpendicular spacing to the PREVIOUS pass held ~constant (reference corpus
      ~1.45-1.55mm, low CV; Barbell straight-neck 1.48, CV 0.03). CHECK ours is roughly constant with low CV
      — NOT that the exact number matches. (Whole-length min-gap ~0 is an endpoint-SHARING artifact, not the
      engagement — do not chase it.)
    - **Curve-following via endpoint slide** — the two pass endpoints advance ~equally in straight channels
      and UNEQUALLY (skew rises) where the channel TURNS. CHECK ours' skew rises with channel turn like
      the reference corpus's. This is the morph-around-curves decision.
    - **Smooth single-sign bow** — curvature is a gradually-varying, single-sign U (one bow side, toward the
      cleared side), no sign flips. CHECK ours is smooth and single-sign (see RP4).
    - **Region / reposition decisions** — region COUNT + split locations match reference corpus (the B-gates), body is
      one continuous winding per region.
  Report the GT-vs-ours SIGNATURE comparison, not a single distance number.
- **RP4 — SMOOTH STANDARD ARCS; NEVER FORCE MODULATION WITH AN S-CURVE ON A BODY MAIN-ARC (automatic
  REJECT) — BUT the island-wrap REJOIN CLEANUP is an explicit, intended exception.** Scope matters; this is
  NOT a blanket ban (Operator 2026-06-07):
    - **BANNED (standard body main-arcs meeting REAL walls):** a standard wall-to-wall MAIN_ARC must stay
      SINGLE-SIGN (one bow side); its endpoint modulation MUST EMERGE from wall geometry + constant engagement
      (morph the previous arc onto the walls), and must NEVER be manufactured by injecting an S-curve /
      curvature sign-flip near a wall. A forced sign-flip on a standard body arc is the known
      "forced-modulation" failure = automatic REJECT. Smoothness OUTRANKS hitting any curvature/sagitta/
      engagement number. Sagitta and curvature are REVIEW lenses, not values to force.
    - **EXPLICIT EXCEPTION (island-wrap / pseudo-boundary rejoin CLEANUP):** where the wound front has wrapped
      an island (or any cleared frontier) and comes back onto ITS OWN cleared path at the cleared/uncleared
      PSEUDO-WALL, the residual-lune cleanup MAY legitimately reverse curvature (an S-curve). SquareIsland GT
      proves this: its LAST ~25% of passes clean the left-of-island lune at the pseudo-wall with curvature
      that reverses (see `docs/AC-progress/overlays/arc_evolution/05_sqisl_cleanup_order.png`). Banning
      S-curves there would handcuff the cleanup. This cleanup is a DISTINCT ROLE (rejoin/cleanup), NOT a body
      main-arc, and is exempt from the single-sign rule.
    - **INTENT (how we will handle the cleanup — currently UNSOLVED, the hardest part):** we have NOT yet
      designed the pseudo-boundary rejoin cleanup. When we do: the wound front treats the cleared edge as a
      pseudo-wall, wraps ONE-SIDED (no head-on meet, B6), then cleans the rejoin lune with cleanup-role passes
      that MAY reverse curvature — modeled and reviewed against the SquareIsland GT, deliberate and justified
      by the rejoin geometry, NEVER an S-curve smuggled in to pass a metric elsewhere. The single-sign rule
      governs the BODY; the cleanup role is the bounded, intended exception.
- **RP5 — VALIDATE THE PRIMITIVE FIRST; SHAPE OVER SCALAR; PICTURES (WITH GT) OVER ENUMS.** Before building
  any loop on a primitive, validate ONE invocation of it on the SIMPLEST fixture, overlaid on GT — if it is
  wrong there, STOP at the primitive (do not build on a broken base). Judge SHAPE and decision-type, not a
  scalar count (a right count with wrong shape is still wrong; a wrong count is just the first symptom).
  NEVER claim "correct" / "matches" from termination enums or counts — only from the GT-overlaid artifact +
  the RP3 signatures.
- **RP6 — HARD GATES BEFORE SIGNATURES; READ AT FULL RESOLUTION, PER-PASS, NOT MEDIANS+THUMBNAILS.** Two
  failure modes that have produced FALSE WINS (Operator caught the body one-step 2026-06-07: 18-43% of points
  out of bounds, called a "win"):
    1. **Run the R1 BOUNDARY-CONTAINMENT gate FIRST, on the actual output.** Any point outside
       `toolpath_center` (or inside an island keep-out) = an automatic FAIL (a gouge). Decision-signatures
       are MEANINGLESS if the path leaves the legal region — check containment BEFORE engagement/curvature/
       skew. (Use `gates.ts gateBoundary` / point-in-toolpath_center; the body morph clamping ENDPOINTS only
       is not enough — the arc BODY must stay inside.)
    2. **Aggregate medians + small thumbnails LIE.** A median engagement / bow-side / single-sign fraction is
       dominated by well-behaved straight sections and hides the failure exactly where it is hardest (curved
       regions, hooks, junctions). Inspect PER-PASS at FULL resolution (hi-res overlay, GT in frame); a
       blunt scalar that "agrees" (e.g. mean-curvature sign) is not evidence the SHAPE/kinks match. No win is
       claimed until the hard gates pass AND the per-pass full-res picture matches.

---

## D. HARD CONSTRAINTS

1. **DO NOT BREAK OTHER OPERATIONS.** Pocket, facing, drill, contour, profile, stock-sim, etc. must keep
   passing their tests and building. AC work is confined to `adaptiveClearing2d/` (+ `morphProto/`).
   Shared subsystems (`stock.ts`, `geometry/`, store, worker messages, types) are touched **only
   additively or behind a flag** — never a breaking change to a shared API another op uses. **Before
   editing any shared file, enumerate its other-op callers and prove the change is additive.** The full
   existing test suite + a clean build are part of the fail-loud net on every change.
2. **PORT, don't re-derive** (Ledger Part 3). The region front (`ringMarch.buildChainedOffsetRings` +
   merge-seam), the linking chain (`scripts/linking.py`), the helix/spiral, the `_fusion_regions` oracle
   — these EXIST. Find and port; do not rebuild from scratch (rebuilding is how they keep getting lost).
3. **NEVER re-attempt Ledger Part 2 dead ends** (connectivity-erosion criterion #20, medial-fork detector
   #21, ADR-0013 disjoint counting #22, synthetic-shape validation #23, both-sides island fill #24,
   engagement-capping #8, end-retard warp #9, similarity-morph freeze #12, ChFi2d near-tangent leads #13).
4. **NEVER weaken a gate to pass.** If a gate passes on visibly broken geometry, the gate is the bug.
5. **No claim without the artifact** (M1). No special-casing the loop (M2). Measure before building (M3).
   No proxy metrics (M4). No symmetric level-sets (M5). Port don't re-derive (M6).
6. **RUN THE C2 REFERENCE-CORPUS REVIEW PROTOCOL (RP1-RP6) ON EVERY AC CHANGE.** GT in every frame
   (`_gt_overlay.py`); judge DECISION-TYPE not geometric overlap; the `_arc_evolution.py` metrics are review
   tools, NOT targets and NOT handcuffs; NO forced S-curve / curvature sign-flip on a BODY main-arc (automatic
   REJECT) — the island-wrap rejoin cleanup is an explicit exception (RP4); run the hard gates (RP6) FIRST;
   validate the primitive on the simplest fixture vs GT before building on it. A change reviewed any other way
   is NOT reviewed. **[OPERATOR 2026-06-07 — binding]**
7. **DEFECT-TO-RULE RATCHET (Operator, standing order — strongest).** Every time a defect is found on review (by
   Operator's eye OR by measurement), BEFORE work proceeds it MUST become (1) a written rule in this contract /
   AC-SPEC, and (2) a runnable, fail-loud CHECK that catches its recurrence. A defect that is merely fixed but
   not ruled-and-gated is NOT done — it WILL recur (memory is forgotten; rules + gates are not). The C2/RP
   review must run ALL accumulated hard gates on every output. **[OPERATOR 2026-06-07 — binding]**
   Hard output gates accumulated so far (run on EVERY body/region output, FAIL-LOUD, before signatures):
   - **r1-in-bounds**: zero non-exempt points outside `toolpath_center` / inside an island keep-out (whole
     arc, not endpoints). Only exceptions: transit-to-different-fixture, retract+reposition-in-fixture.
   - **r2-interpass-gap (MAX, not median)**: max point-to-previous-pass spacing <= stepover everywhere; a
     median/typical engagement is a BANNED proxy.
   - **r4-single-sign / r4-curl-matches-gt**: body arcs single-sign (S-curve only in island-wrap cleanup);
     the per-pass curvature asymmetry (which end curls tighter) MATCHES GT — geometry-dependent, NOT a fixed
     inside/outside law.
   - **w1-coverage**: ours' SWEPT coverage (tool-radius around the path) of the region ~= GT's (GT = `cut` +
     `spiral` core, NOT cut alone — cut-only undercounts to ~42%, GT cut+spiral ~99.9%). A body that PINCHES
     OUT and leaves an uncut region FAILS, even if r1/r2/r4 pass on the passes it did emit (measured 2026-06-07:
     the medial body passed r1/r2/r4 on Comma while covering only 71.8% vs GT 99.9% — a 28% hole from
     offset-perp collapse). r2 (inter-pass gap) does NOT catch this — it only measures between EMITTED passes.
   Reference checks: `sandbox_ac/scripts/_body_verify.py` (bounds + curvature), `_body_gaps_asym.py` (gaps).

---

## E. THE WORK PLAN (phased; each phase has an EXIT GATE that must pass on ALL fixtures)

**Sequencing rule:** wire the regression net FIRST, then fix region source, then linking+safety, then
body shape. Never advance a phase while an earlier phase's gate regresses on any fixture.

### Phase 0 — Foundation & regression net (no behaviour change)
- Reconcile the canon: settle the `detectSplitsByStockConnectivity` contradiction (fill-front-break is
  THE criterion; the detector is a demoted candidate-signal). Sweep AC-SPEC/Ledger/memory for stale
  "correct/keep/done" lines superseded by GT and annotate them.
- Confirm `_fusion_regions` (or a faithful port) is callable in the TS test harness as the region oracle.
- WIRE the gates above (B1-B7, safety, linking, load/coverage, W3/W4/W5) in `ac-invariants.test.ts` as
  fail-loud assertions vs reference corpus GT, currently allowed to FAIL (they expose the true baseline). Build a
  one-command "score all 9 fixtures + render reference corpus overlays in correct orientation" harness.
- **EXIT:** the gates run, produce the honest current baseline per fixture, and the overlay harness emits
  correct-orientation reference-vs-ours images. Nothing shipped changed yet.

### Phase 1 — Region engine (the #1 lever; B+K ~= half the corpus)
- Make the chained-offset FILL-FRONT the region SOURCE (PORT `buildChainedOffsetRings` lineage).
- Add **split-qualification** (rejoin-vs-dead-end): a candidate split is a region only if the pieces
  dead-end separately; rejoining pieces = merge seam, not a region. (Kills Barbell-neck + taper splits.)
- Add **pseudo-boundary island steering (G2)**: front meets cleared stock -> treat as wall -> SAME
  winding continues around the island and rejoins itself. General to N islands. (Kills meet-at-the-back.)
- **One operation-wide winding; finish-region-before-next ordering.**
- Graft as the AC region source feeding the bulk-cut — ADDITIVE / flagged, NOT a destructive rewrite of
  shared planner internals (protect other ops). [Decision D1 below.]
- **EXIT GATE:** B1-B7 PASS on all 7 region fixtures + no safety regression + Operator's visual sign-off on
  the reference corpus overlays.

### Phase 2 — Linking layer + safety (C/D/L/H + I/A = ~193 appearances)
- PORT the validated 5-role chain (linking.py): wall-follow entry AND exit (adaptive length, rides
  forward past the neighbour node), true equidistant-R-centre tangent fillets (<= 90 deg), forward-loop
  corner nibble (no reversal, one wall-to-wall closure fillet), loopback arcs over cleared.
- Wire the four safety rules as fail-loud REJECTs in the TS path (today only a disconnected Python gate).
- Feedrate-by-role tagging.
- **EXIT GATE:** linking-gate + safety-gate PASS on all 9; tangency analytic D1 < ~0.1deg; Operator overlay.

### Phase 3 — Body / pass shape (G; 73)
- Replace the symmetric mid-peak curvature with engagement-to-previous regulation producing the measured
  U-shape wall-leaving end-curl; each arc evolves recursively from the previous; do not copy seed sagitta.
- **EXIT GATE:** W4/W5 fidelity within tol per pass on all 9; Operator overlay.

### Phase 4 — Full sign-off & regression lock
- Every fixture passes every gate. CI runs all gates on all fixtures so any future change fails loud.
- **DONE** only when: all 9 fixtures PASS every gate AND Operator signs off on every reference corpus overlay. Zero
  exceptions.

---

## F. THE WORK SYSTEM (how subagents are used WISELY, without kludging)

The audit shows the loop is: orchestrator burns context -> hands a context-starved worker a gate to
pass -> worker reinvents a kludge -> green number -> Operator rejects. The system below breaks that.

- **Thin orchestrator** holds the plan, the gate scoreboard, and the reference corpus overlays. It does NOT do
  heavy edits; it delegates bounded chunks to FRESH subagents and VERIFIES their work against the gate +
  overlay itself (trust-but-verify; render and LOOK).
- **Every subagent task is grounded** with: (1) this plan's Part A/A'/B/C/D, (2) the specific reference-GT
  gate it must make pass, (3) the Ledger Part 2 don't-retry list + the banned-kludge list (A'),
  (4) the requirement that the deliverable is "the wired gate passes on ALL fixtures + the reference corpus overlay
  in correct orientation looks like GT," NOT a sandbox number. A subagent that turns a gate green by a
  banned kludge is a FAILED iteration.
- **Parallel COMPETING subagents** only for a genuinely open sub-problem (e.g. split-qualification
  heuristic), each in isolation, compared by the gate delta + overlay; adopt the winner, discard the rest.
- **Regression net runs on every change, all fixtures + all other-op tests.** A fix that regresses any
  fixture or any other operation is reverted.
- **Context discipline:** one focused change -> gate -> overlay -> update plan/handoff -> stop that chunk.
  Checkpoint before degrading; a fresh session bootstraps from this plan + the wired gates (cold-start
  proven). The plan + gates ARE the memory — no reliance on a long single context.

---

## G. LEARNING LOG — the mistakes I must stop repeating (check before every claim)

- M1 claim-over-show: I called a meet-at-the-back geodesic result "progress." -> No claim without the
  inspected reference corpus overlay.
- M2 invent-over-continue: seal-to-wall, zigzag, geodesic level-sets. -> Continue the one forward loop;
  port the validated front.
- M4 proxy-masks-defect: chased `_gate.py` green; headon missed the 1.6mm-spaced zigzag. -> Gate measures
  the front; strengthen never weaken.
- M5 symmetry trap: every distance-field level-set meets at the back. -> One wound front from one side,
  pseudo-boundary steering.
- M6 port-don't-rederive: rebuilt concentric circles instead of porting the chained-offset front. -> Port.
- Amnesia: the canon held contradictory dead beliefs (detector "correct;keep" vs "DEAD"), so I re-reached
  for corpses. -> Phase 0 reconciles the canon; this plan is the single contract.
- Walled-off sandbox: all "wins" were disconnected from the shipping tree = the regression engine. -> Work
  on the shipping TS tree behind the gates.

---

## H. DECISIONS (RESOLVED 2026-06-07 — Operator)

**D1 — integration shape: FULL AC-SCOPED CORRECT PIPELINE (chosen for BEST, not convenient).** Operator:
"Choose what will work best, not what will work easiest. Easy patches and recycling the same mistakes is
how we got here." Decision: build a NEW, correct, self-contained AC pipeline in the TS tree — fill-front
region engine + pseudo-boundary steering + ported linking + body shape — that **replaces the reactive
planner FOR THE AC OPERATION ONLY**. Rationale: the additive graft keeps the broken reactive flood-fill
(`nearestUncutPocket` independent island flanks, link-cost interleave, per-region winding flips) as the
substrate, so its defects leak through whatever is bolted on — the exact recycling that kept us failing.
The correct end-state is AC running ONLY the validated pipeline. **Other ops are protected** because the
new pipeline is reached ONLY through the AC operation entry; shared files (`stock.ts`, `geometry/`, store,
worker) are touched additively only, and the full existing test suite + build are part of the regression
net on every change.

**SELF-ENFORCING GUARDRAIL (Operator: "stop you dead in your tracks and regroup"):** the R1/R2/R3 hard rules
are enforced as **fail-loud REJECTS inside the generator itself** — it refuses to emit a move that gouges,
exceeds stepover, reverses the cut, or leaves `toolpath_center`, and surfaces the violation instead of
shipping it. A banned-kludge (Part A') or a higher-rule violation is an automatic abort, not a warning.
Plus the wired all-fixture test gates. I literally cannot emit (or claim) a toolpath that breaks a
requirement.

**D2 — canon reconciliation: APPROVED.** Fill-front-break is THE region criterion;
`detectSplitsByStockConnectivity` demoted to a candidate-signal only. Update AC-SPEC sec H line 317 + the
Ledger timeline row so no future session re-reaches for the dead detector. (Done in Phase 0.)

**D3 - cadence: AUTONOMOUS + PROGRESS FOLDER.** Operator asked for continued work, images,
progress summaries and measurable checks against ground truth (paraphrased for public naming).
Decision: I work
autonomously through the phases/gates; I maintain **`docs/AC-progress/`** with (a) `PROGRESS.md` (live
summary: phase, per-fixture gate scoreboard, what changed, what's next) and (b) correct-orientation
reference-vs-ours overlay images per fixture per gate, refreshed as I move between gates. No stop required;
the gates + overlays + this plan are the anti-cheat substrate. DONE = all 9 fixtures pass every gate AND
the overlays visibly match reference corpus. Zero exceptions.
