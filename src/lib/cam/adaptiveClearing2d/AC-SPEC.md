# Adaptive Clearing — Executable Specification (Contract)

> **Status: v0.1 DRAFT — needs Operator's verification before the gates are wired.**
> This file is the single source of truth for *what a correct AC toolpath must satisfy*.
> It exists to replace lossy reconstruction from scattered memory/docs. Every **[GATE]**
> below is intended to become a fail-loud assertion in `src/tests/adaptive-clearing/ac-invariants.test.ts`,
> run against every fixture. Until a gate is wired it is marked `NOT YET WIRED`.
>
> Provenance tags:
> - **[ESTABLISHED]** — carried from validated prior work (cite the memory/doc).
> - **[OPERATOR 2026-06-06]** — stated directly by Operator this session; authoritative.
> - **[RECOVERED]** — recovered 2026-06-06 from an in-depth comb of ~342 session transcripts
>   (cited `session-id` + date). These are real rules/numbers Operator stated or we measured in prior
>   sessions; treat as authoritative but verify a number against the artifact before betting on it.
> - **[RECONSTRUCTED — VERIFY]** — pulled from memory by Claude; Operator must confirm before it is law.
>
> **Companion doc:** `AC-ATTEMPTS-LEDGER.md` — what we already tried, what is DEAD (do not
> re-attempt), and what working code got lost/rebuilt (exists — port, don't rebuild). Read it
> before proposing any approach.

---

## A. Per-move precedence hierarchy

A lower-priority control may shape geometry but **may never break a higher-priority rule**.
On conflict, the higher rule wins and the lower adjustment is *retarded/limited*, never the reverse.
(1 = highest, never violated.) **[ESTABLISHED — project_ac_rule_hierarchy]**

### R1 — Material safety **[OPERATOR 2026-06-06, corrects prior inverted phrasing]**
- Never gouge: stay inside `toolpath_center`.
- **EVERY toolpath point stays INSIDE `toolpath_center` AT ALL TIMES — non-optional. [OPERATOR 2026-06-07]**
  The ONLY two exceptions are: (a) a TRANSIT/rapid move to a COMPLETELY DIFFERENT fixture, and (b) a
  RETRACT + REPOSITION within the SAME fixture (over cleared stock). Cuts, body arcs, leads, and
  wall-follows have NO exception — they must lie within `toolpath_center` (and outside island keep-outs)
  everywhere, the WHOLE arc, not just the endpoints. Clamping endpoints while the arc body bulges past the
  wall is a GOUGE = automatic REJECT. (Measured failure 2026-06-07: body one-step put 18-43% of points up to
  2.1mm outside `toolpath_center` because only endpoints were clamped.)
- **[GATE r1-in-bounds]** zero non-exempt (non-transit, non-reposition) toolpath points outside
  `toolpath_center` / inside an island keep-out, measured on the densified emitted path. This gate is run
  FIRST, before any shape/engagement gate (a path that gouges is rejected regardless of its other metrics).
  Reference check: `sandbox_ac/scripts/_body_verify.py`. `NEEDS WIRING in ac-invariants.test.ts`.
- **Cleared stock is SAFE.** Rapids, bridges, and loopbacks **THROUGH cleared stock are allowed.**
- **A crash = a move over UNCLEARED stock that is not a designed cutting move.** The forbidden
  thing is a *rapid/non-cutting move over uncleared material*, **not** a move over cleared material.
- The ClearedGrid is the live decision tool (`isPathClear`/`isRapidSafe`), not a debug display.
  **[ESTABLISHED — project_adaptive_clearing_principles]**
- **[GATE r1-no-uncleared-rapid]** every non-cutting move's swept path touches only cells with bit0=1
  (CLEARED or CLEARED_BY_CRASH). `NOT YET WIRED`.

### R2 — Optimal load / engagement cap **[ESTABLISHED]**
- Radial engagement (chip load) never exceeds the optimal-load max.
- Gain curvature by **retarding endpoints, never by exceeding stepover.**
- **NO INTER-PASS GAP MAY EXCEED THE STEPOVER.** **[OPERATOR 2026-06-06]** The radial spacing between ANY two
  adjacent passes -- including **the helix/spiral core -> the first wall-to-wall arc** (the most common
  offender), arc-to-arc, and arc-to-wall-follow -- must be <= the optimal-load stepover. A gap larger than
  stepover leaves an uncleared band that EITHER (a) never gets cleaned, OR (b) overloads the tool when a
  later pass finally hits it (engagement spikes past the cap). This is a STRUCTURAL placement requirement:
  where critical move geometry is placed must guarantee overlap within stepover, by construction. A loose
  "slotting-only" engagement check does NOT catch this -- the gate must measure the actual inter-pass gap.
- **[GATE r2-engagement-cap]** max per-vertex radial engagement <= cap across the whole path. `NEEDS WIRING`.
- **[GATE r2-interpass-gap]** max radial gap between adjacent passes (spiral->first-arc, arc->arc,
  arc->wall-follow) <= stepover, everywhere, every fixture. `NOT YET WIRED` (CRITICAL — currently masked
  because coverage uses an R-radius proxy and engagement only flags sustained slotting).
- **ENGAGEMENT IS PERPENDICULAR DISTANCE TO THE PREVIOUS PASS — measured/enforced ALONG THE WHOLE PASS, NOT
  apex-stepover-along-the-medial-spine. [2026-06-07, measured]** Marching the arc APEX by one stepover along
  the medial trunk controls only the SPINE spacing; where the channel CURVES or WIDENS, perpendicular
  cross-sections RADIATE (fan out like spokes) and leave wedge gaps far over stepover (measured on the Comma
  medial-body port: max gap 14.96mm = 9.3x the 1.6mm stepover, 19% of points over). So apex-along-spine is a
  BANNED PROXY for engagement. The medial trunk is for STEERING DIRECTION (flow) only; the engagement spacing
  must be enforced as the actual perpendicular distance to the PREVIOUS PASS at every station (ties
  ARC-ANALYSIS "constant engagement against the previous pass" + [[project_ac_engagement_measured]]).
- **MEASURE THE MAX GAP OVER THE WHOLE PATH — a MEDIAN/typical engagement is a BANNED proxy. [OPERATOR 2026-06-07]**
  The gate value is the MAXIMUM point-to-previous-pass perpendicular distance across the entire path (and the
  COUNT of points whose spacing > stepover), NOT a median or mean. A median hides distinct gaps: measured
  2026-06-07, the body one-step had a MAX spacing of 5.54mm (3.4x the 1.6mm stepover, 12.8% of points over
  optimal load) while its MEDIAN engagement read a healthy 1.45mm — the median "passed" while the path left
  uncleared bands. Any spacing > stepover anywhere = REJECT. Reference: `sandbox_ac/scripts/_body_gaps_asym.py`.

### R3 — Cut topology & direction **[ESTABLISHED]**
- **Orientation is by OPERATION, not by region** **[RECOVERED — e1ce0c9e 2026-06-03]**: climb vs
  conventional is set by cutter rotation + the operation, imparted into the spiral direction (CW/CCW),
  and **maintained throughout ALL cut paths in the operation. Non-negotiable.** Do not decide
  per-path which way is start/end, and do not flip handedness per region. (Quote: *"It is not an
  option. It is driven by cutter rotation and the operation. Period."*)
- Cut **CCW** (for the chosen operation sense), propagated across the part.
- Wall-follow rides **toward the cleared side**.
- **Loopback/reposition may travel "backward" (opposite spiral sense) THROUGH CLEARED stock** to
  reach the next ring start — this is the reposition move, not a cut reversal, and is allowed
  (see R1/W1). The **CUT** never reverses. Do not conflate the two. **[RECOVERED — 2a56f0e7 05-08]**
- **No path reversals — ever.** Any reversal is a red flag that the loop was special-cased.
  **[ESTABLISHED — feedback_never_special_case_the_loop, feedback_tip_finish_rejection_rules]**
- Lead / wall-follow **fillet sweep ≤ 90°** **[ESTABLISHED — feedback_ac_fillet_90deg_gate]**. -- LEAD/wall-follow transitions ONLY; loopback/U-turn moves are EXEMPT (wallCleanLoop.ts:204) and the lead-side gate r3-fillet-le-90 (L103) is NOT YET WIRED.
  *Exception:* the single wall-to-wall corner-nibble closure fillet may exceed 90°
  **[ESTABLISHED — project_ac_corner_nibble]**.
- **[GATE r3-no-reversal]** no cutting-move turn > 150° (loopback/reposition moves EXEMPT — they
  may legitimately turn sharply over cleared stock). ✅ Validated on all 9 GT fixtures in
  `src/tests/adaptive-clearing/ac-invariants.test.ts` (2026-06-06; GT max ~29°). ⚠️ The faithful
  **generated-output** gate is the validated Python `sandbox_ac/scripts/_gate.py` — **authority,
  currently 5/9 PASS** (Tee, Bar, Triangle, Barbell, Boomerang; failing: Comma/Kidney/BootL = a few
  cutting reversals + sharp loopback-joint tangency, SquareIsland = island-wrap coverage hole). A
  naive all-points max-turn over-counts exempt loopback joints (it falsely read 1/9) — the TS port
  must exempt loopback roles + split at role boundaries to agree with `_gate.py` before it's trusted.
- **[GATE r3-fillet-le-90]** every lead/wall-follow fillet sweep <= 90 deg (corner-nibble exempt). `NOT YET WIRED`.
- **Acute AND right-angle corners use the SAME unified nibble logic.** **[OPERATOR 2026-06-06]** We currently
  handle ACUTE corners acceptably but 90 deg / square corners much worse -- there is no reason for that. A
  right-angle corner is the same problem class as an acute one (a converging wall pair the loop closes with a
  wall-to-wall nibble); handle both with one mechanism. A square corner must not be treated worse than an acute one.
- **[GATE r3-corner-uniform]** corner-cleanup quality (residual uncut at the vertex, fold-free closure) for
  90 deg corners is no worse than for acute corners. `NOT YET WIRED`.

### R4 — Tangency & gradually-varying curvature **[ESTABLISHED]**
- Tangent joints, C0 continuity, no curvature spikes/sign-flips on mains.
- Forcing tangency at the cost of smooth curvature caused the Phase-2 wobble — do not.
- **A standard body MAIN_ARC stays SINGLE-SIGN (one bow side, toward the cleared side). NEVER inject an
  S-curve or a curvature sign-flip near a REAL wall to FORCE endpoint modulation — automatic REJECT (the known
  "forced-modulation" failure).** The asymmetric end-curl in the reference corpus must EMERGE from morph-onto-walls +
  constant engagement (the endpoints slide unequally where the channel turns), not be manufactured. Smoothness
  outranks hitting any curvature/sagitta/engagement number. **[OPERATOR 2026-06-07]**
- **EXCEPTION — island-wrap / pseudo-boundary REJOIN CLEANUP (a distinct role, NOT a body main-arc):** where
  the wound front wraps an island/cleared frontier and rejoins its OWN cleared path at the cleared/uncleared
  PSEUDO-WALL, the residual-lune cleanup MAY reverse curvature (S-curve). SquareIsland GT does exactly this in
  its last ~25% of passes. This role is EXEMPT from single-sign; it is the hardest, still-UNSOLVED part — when
  built it must be deliberate, justified by the rejoin geometry, and reviewed vs SquareIsland GT, never an
  S-curve smuggled in to pass a metric elsewhere. **[OPERATOR 2026-06-07]** (See AC-MASTER-PLAN §C2 RP4.)
- **Review tools (NOT targets/handcuffs):** signed curvature + sagitta + engagement + endpoint-skew via
  `sandbox_ac/scripts/_arc_evolution.py`, always over a `_gt_overlay.py` GT-in-frame comparison. Acceptance =
  same DECISION TYPE as the reference corpus (constant engagement, skew rises at turns, smooth single-sign body bow), NOT
  geometric overlap. See AC-MASTER-PLAN §C2 (the binding review protocol).
- **[GATE r4-single-sign-smooth]** no curvature sign-flip (S-curve) within a standard body MAIN_ARC pass;
  curvature gradually-varying (no spikes). EXEMPTS passes tagged as island-wrap/pseudo-boundary rejoin
  cleanup. `NOT YET WIRED`.

### R5 — Feedrate-by-role **[ESTABLISHED — feedback_ac_feedrate_by_role]**
- All 5 roles (lead-in, lead-out, their wall-follows, main) tagged with distinct feedrates;
  preserve role boundaries even when geometry merges (back-calc + split).

### R6 — Shape / aesthetic adjustments **[ESTABLISHED]**
- Wall-reaching extension, lead-radius sizing, GT-look matching. Subordinate to R1–R5.

---

## B. Global completion invariants (whole-path, checked at the end)

### W1 — 100% wall coverage **[OPERATOR 2026-06-06]**
- Every wall must be cleared; the finished path achieves **full wall-follow coverage** (overlapping
  footprints, no uncut slivers/cusps). This is *the* completion invariant.
- **Cuts AND wall-follows must REACH the `toolpath_center` boundary -- the explicit "go up to here, not
  beyond" limit -- never inset/short of it.** **[OPERATOR 2026-06-06]** The `toolpath_center` line in each
  fixture EXISTS to give the explicit cut limit (it already bakes in tool radius + finish stock); the tool
  center is meant to ride right up to it. Stopping short leaves a rim band of uncut stock. A coverage metric
  that only checks "within R of a cut point" MASKS this inset (a pass 2mm inside still "covers" the boundary
  cell). The gate must measure the actual reach to the boundary, not a within-R proxy.
- **Wall-follow-as-arc-continuation (operational arsenal).** **[OPERATOR 2026-06-06]** When a cut arc merely
  CLIPS / just touches a wall, do NOT terminate the arc -- ride a short wall-follow segment along the wall,
  then resume the arc. The wall-follow continues the cut forward (it is not only an end-of-pass coverage ride).
- **Traveling along the wall is allowed for repositioning.**
- **Retracing already-cleared stock along a wall is allowed when it produces a better overall toolpath.**
- Wall-follow length is **adaptive** = (wall-arc distance to neighbour ring's node) + overlap + fillet-setback;
  a fixed nominal collapses and leaves wall uncut. **[ESTABLISHED — project_ac_wall_follow_coverage]**
- **[GATE w1-wall-coverage]** swept wall coverage >= threshold (target 100%) per fixture. `NOT YET WIRED`.
- **[GATE w1-wall-reach]** max distance from any `toolpath_center` boundary point to the nearest cut/wall-follow
  point is ~0 (the path reaches the limit, not inset). `NOT YET WIRED` (currently masked by the within-R coverage proxy).

### W2 — Reposition efficiency bounded by reference corpus **[OPERATOR 2026-06-06]**
- Repositioning is allowed only when there is no better option. **The reference corpus GT is the bar:** if reference corpus
  did not need to reposition here, our system should not either.
- **Track the number of reposition moves. If it exceeds the reference corpus's count for that fixture, the path is
  inefficient** — flag it.
- **[GATE w2-reposition-count]** `repositionCount(ours) ≤ repositionCount(fusionGT)` per fixture. `NOT YET WIRED`.

### W3 — Region count matches the measured reference corpus **[ESTABLISHED — project_ac_region_criterion]**
- Region count validated **only** against measured reference GT (`_fusion_regions`), never synthetic ADR examples.
- **[GATE w3-region-count]** `regionCount(ours) == regionCount(fusionGT[fixture])`. `NOT YET WIRED`.

### W4 — Shape fidelity vs enriched JSON ground truth **[ESTABLISHED — feedback_fit_metric_must_be_honest]**
- Compare per-pass by normalized march position, oriented A→B, resampled to equal arc-length.
- Report **arc-length ratio** (catches ballooning), point-by-point, **symmetric** Hausdorff, and the
  **distribution** (worst pass + count ballooned) — never just a mean. Pair every number with a visual overlay.
- Never claim "matches reference corpus" without the overlay artifact in front of Operator.
  **[ESTABLISHED — feedback_no_unearned_fusion_match_claims]**
- **[GATE w4-shape-fidelity]** arc-length ratio + symmetric Hausdorff within tol vs enriched GT, per pass. `NOT YET WIRED`.

### W5 — Role & component fidelity vs enriched GT **[OPERATOR — uses cut_components enrichment]**
- The GT already labels every pass: compare **role-by-role**, not just whole-pass polylines.
- **[GATE w5-component-kind]** our per-pass `kind` ∈ {simple,compound,wallclip,tiny} matches GT `cut_components[i].kind`. `NOT YET WIRED`.
- **[GATE w5-lead-caps]** lead_in ≤ 3.5mm, lead_out ≤ 2mm (GT-derived caps). `NOT YET WIRED`.
- **[GATE w5-main-curvature]** MAIN_ARC is gradually-varying curvature (no circle-forcing, no κ sign-flip) — ties to R4. `NOT YET WIRED`.

---

## C. Authoritative references (do not re-derive — PORT)
- **Ground truth = the ENRICHED JSON, not the bare DXF.** `test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix{0..8}.json`
  (DXF is only the raw upstream the JSON was extracted from). Our generated output for diffing: `gen_fix{0..8}.json`; index: `manifest.json`.
- **Enriched GT schema** (per fixture object): `boundary`, `islands`, `stock_to_leave`, `toolpath_center`, `stock_mm`,
  `center_mm`, `cut` (passes), `spiral`, `helix`, `loop_untrusted`, and **`cut_components[i] = {kind, frac:[f0,f1,f2,f3]}`**
  where for `kind=simple` the fracs are normalized-arc-length splits of `cut[i]`:
  `wall_follow_entry[0,f0] · lead_in[f0,f1] · MAIN_ARC[f1,f2] · lead_out[f2,f3] · wall_follow_exit[f3,1]`.
  `kind=compound` = island-wrap cleanup (no simple fit); `kind=wallclip` = corner/along-wall or clip-and-resume.
  MAIN_ARC = gradually-varying-curvature cubic (NOT a circle); lead/main boundary is angle-based (crossing >18° from wall).
  Derived by `_enrich_cut_components.py` via `_seg.py`. Region visual: `_fusion_regions.png`.
- Linking layer (leads/wall-follows/loopback): the OCCT linking port — do not re-derive direction.
- Honest fit metric: the resample-by-march-position method (W4).

## D. How this contract is used
1. **Session start:** read this file + `AC-ATTEMPTS-LEDGER.md` + `AC-STATUS.md`, then run
   `ac-invariants.test.ts` and report pass/fail *before touching code* — ground in the artifact, not memory.
2. **Before any "done"/"matches" claim:** the relevant gate must pass, and W4 needs the overlay shown.
3. **When a gate trips often:** fix the *upstream* logic for that rule level — do not patch downstream.
4. **Before proposing an approach:** check `AC-ATTEMPTS-LEDGER.md` Part 2 (Dead — don't re-attempt)
   and Part 3 (Lost — exists, port don't rebuild).

---

## E. Canonical operation sequence **[RECOVERED]**

The whole-operation motion structure, as Operator defined it (`1c513291` 05-07, `2a56f0e7` 05-08,
`340d4c36` 05-14):

1. **Helix entry** at the center of the pocket/region (helix Ø ≈ 3.8 mm on the Sketch1 Ø4 tool).
2. **Outward spiral** with stepover driven by the optimal-load value (constant load *by construction*
   — geometry-driven, no per-step FEA: *"if we can make paths that yield essentially constant load,
   we don't have to calculate for it"*).
   - **THE SPIRAL IS ONE CONTINUOUS PATH AND DOES NOT TERMINATE MID-REGION.** **[OPERATOR 2026-06-06 —
     ESTABLISHED GROUND, regressed]** The helix-entry spiral grows OUTWARD continuously and **flows
     directly into the wall-to-wall arc march as a single path** — it must NOT be a separate small
     "core spiral" that stops mid-region and hands off to disconnected arc rings (the current sandbox
     `_regroup` patchwork: a prepended Archimedean core + reference-arc-shaped rings joined by loopbacks
     = the regression). Within a region the cut is continuous from helix center to the last ring; a
     break only at a TRUE forced reposition (R1/W2). A spiral terminating in open material mid-region
     is forbidden. We spent significant prior effort getting this right (port the existing continuous
     spiral — Ledger Part 3 #2 `analyticSpiral.ts` / LIC helix / split system; do NOT re-derive).
   - **[GATE e-spiral-continuity]** no cut pass endpoint terminates in open (non-wall, non-reposition)
     material mid-region; spiral->arc is one connected path; gap to the next pass <= stepover (ties R2
     interpass-gap). `NOT YET WIRED`.
3. On a boundary/island/stock-to-leave approach: **arc lead-out** to avoid collision → **lift** by the
   stay-down value → **backtrack through previously-cleared material** (the loopback rapid, opposite
   spiral sense) to the start of the next available ring → **lead-in** → resume cut.
4. **Loop-Back is the DEFAULT** retract; *Continue-On* (proceed to next ring in the same spiral sense)
   is an option. The loopback U-turn uses a **midpoint-radius arc (`rCross − stepover/2`)** — the
   geometric guarantee it stays in cleared material.
5. **Canonical 5-role pass** (the unit the GT `cut_components` decompose): `wall_follow_entry ·
   lead_in · MAIN_ARC · lead_out · wall_follow_exit` (see §C schema). The wall-follow is a
   coverage-mandated wall RIDE (W1), not a smoothing arc into the loopback.

**The ClearedGrid is the live decision oracle** (R1): stamped on every emitted move, queried at the
decision points (DP-1 wall-follow direction; DP-2 bridge-or-retract; DP-3 terminal wall-follow
direction; DP-4 bridge landing). It is **not** a debug display. (`340d4c36` 05-14)

---

## F. The measured geometric model of a pass **[RECOVERED — this is the DEFINITION of a correct arc]**

> Construct passes to THIS from the start. Do **not** generate a plain offset/circle and warp it
> after — that whole family is dead (Ledger §2 #8/#9). Source: `d897efd3`, `509196f3` (2026-05-31),
> measured from DXF GT, Menger curvature, spline-independent.

- **Engagement target ≈ 78°**, derived `arccos(1 − stepover/toolR)`; nominal **stepover 1.6 mm**,
  tool **Ø4 / R2** on the Sketch1 fixtures. Real steady-state engagement measures **~80°** (Python
  `engagement-diag.py`). ⚠️ The TS measurement **over-reported ~136°** because it modeled discrete
  static rings — trust the steady-state arc-to-arc measure, not the static-ring one.
- **Stepover tolerance is ASYMMETRIC** (machinist rule): **under** ideal is acceptable (leaves a
  sliver to clean up); **over** ideal is **forbidden** (over-engages, deflects the tool). Ties to R2.
- **The reference corpus curvature is U-shaped — this is the steering signal, not a plain offset.** Comma open
  wall-to-wall arcs: **mid-arc κ ≈ 0.29 /mm (R ≈ 3.4 mm)**, **both ends κ ≈ 2.0–2.3 /mm** → the ends
  bend **~7× tighter** than the middle, and concavity *persists/increases* outward (it does NOT decay
  like a plain offset would). Straight-channel control (Bar): mid κ ≈ 0.035 /mm (R ≈ 28 mm) — proves
  the bow is real steering, not an extraction artifact.
- **Per-arc ANATOMY (from each wall inward):** `[tangent-to-wall, R 20–160 mm, ~0.4 mm long] →
  [tight turn, R ≈ 1–2 mm] → [gentle constant-engagement middle, R ≈ 8 mm] → [tight turn] →
  [tangent-to-wall]`. κ(s) is a textbook **double-peak** (high dκ/ds at the ends, ~0 in the middle).
  **There is no flat wall-follow stretch in the MAIN_ARC — the "wall-follow" is the tangent point at
  each tip** (the wall *coverage* ride is the separate `wall_follow_entry/exit` role, W1).
- **A pass is NEITHER a circle NOR a clothoid.** 3-point circle overlay fails; clothoid R² ≈ 0.01
  (curvature not linear in arc length). Curvature is constant-ish only in the reliable interior.
- **GENERATOR CHOICE — the open problem is DIRECTIONAL STEERING, not arc-making. [OPERATOR 2026-06-07]** Making
  arcs within optimal-load tolerance is SOLVED; we have built several good arc generators (RECURSIVE
  ARC-EVOLUTION where each arc evolves from the previous with curvature ~ 1/width — `scripts/_generator.py`,
  `scripts/_drivers.py` mixed-midline drivers; `analyticSpiral.ts`). **PURE OFFSET geometry FLATTENS as it
  propagates and its steering is non-trivial — it is the WORST generator and is BANNED as the primary body
  source; a rigid chord similarity-morph is likewise inferior (bulges OOB / flips asymmetry in curves).** Use
  the existing recursive-evolution generator for the ARC SHAPE and spend the effort on DIRECTIONAL STEERING
  (medial / midline, RECURSIVE off the evolving frontier) — that is the actual unsolved lever. Do NOT
  re-reach for offset/similarity-morph as the generator.
- **Passes are NOT symmetric** — one side curves more than the other; any model must allow it.
- **THE PER-PASS CURVATURE ASYMMETRY MUST MATCH GT — which end curls tighter is GEOMETRY-DEPENDENT, NOT a
  fixed inside/outside law. [OPERATOR 2026-06-07, corrects an earlier over-generalized "tight curl on the inside
  wall" rule]** The requirement is to REPRODUCE GT's behavior, not to put the tight curl on any particular
  wall. In some geometries the tighter curl is on the inside/concave wall, in others the outside — it depends
  on the channel. Observed defect: ours' asymmetry was INVERTED relative to GT (ours aggressive on the outside
  where GT was aggressive on the other side). Measurable: per pass, the location of the tighter-curl end
  (which fraction of arc length, and toward which wall) matches the GT pass at that location. Do NOT hard-code
  inside-vs-outside. **[GATE r4-curl-matches-gt]** per-pass tight-curl-end location agrees with GT (signed,
  per fixture). `NOT YET WIRED`.
- **Generation principle:** hold **constant engagement (~0.6 mm arc-to-arc, CV ~0.05) against the
  PREVIOUS PASS**, same bow side; do **not** copy the seed's sagitta forward (freezes the bow —
  Ledger §2 #12). One-step-from-true-previous agrees with the reference corpus to **0.23 mm**.
- **Leads & loopbacks:** GT lead_in = lead_out ≈ 0 mm on the wall-tangent→wall-tangent Comma main;
  where leads exist they're capped (enriched GT: in ≤ 3.5 mm, out ≤ 2 mm — see §C). **Loopbacks are
  TRUE ARCS** (~9 mm, comparable to the cut arc), never chords, attaching to cut-arc tips at ~11–15°,
  and run as **rapids because they cross only previously-cleared stock.** ⚠️ Lead radius vs tool
  dimension is ambiguous across notes (50% Ø ≈ 2 mm corner fillet vs "75–125% of tool R") and is
  partly fixture-dependent (old paisley tool r5 vs Sketch1 R2) — **VERIFY against the enriched GT
  per fixture; do not hardcode a percentage.**

---

## G. Region model **[RECOVERED — cracked 2026-06-05 vs MEASURED REFERENCE GT]**

> Validate **ONLY** against `scripts/_fusion_regions.py` real GT — **never** synthetic shapes or ADR
> traces (they lock in the wrong criterion; the synthetic barbell=2 contradicts the real Barbell=1).
> Source: `a93234fd`, `d16faf61` (06-05). Supersedes ADR-0013 disjoint counting (→ ADR-0014 fill-front).

- **The criterion = FILL-FRONT BREAK.** A region boundary is where the advancing fill-front
  (chained-offset / `ringMarch`, ADR-0012) **breaks into a sustained alley**. The front **rounds
  corners and flows through narrowings as one piece**, and **wraps + rejoins around islands.**
- **Split qualification:** split → pieces **rejoin** (convex-bulb fill, island wrap) = a **merge seam,
  NOT a region**. Split → pieces **dead-end separately** (alley fork) = **real regions.**
- **Corner-vs-alley = TAPER vs PLATEAU** (a *trend*, not size): a corner's front-piece *tapers* to a
  point (→ nibble cleanup within the region); an alley holds a *plateau* width even when skinny (→ region).
- **Reposition refinement (the still-open piece):** the true boundary is **where the spiral must
  REPOSITION (lift to unreachable stock), not every alley terminus.** A branch is a new region only if
  the continuing outward front cannot reach it in-line. One region can have several termini one spiral
  fills without repositioning.
- **Real reference corpus counts (user-vetted ground truth):** Comma **1**, Kidney **2** (the upper-right lobe,
  NOT the waist), Tee **4** (the arms, NOT the bar corners), Bar **1** (top-corner V = cleanup),
  BootL **5** (the skinny leg splits off), Barbell fix7 **1** (rides through the neck), SquareIsland
  **4** (island wrap-seam). These are the W3 gate targets.
- **Architecture = pre-process + reactive** (user-approved): a pre-process predicts where the region
  will split (look further down the road), plus a reactive system that adapts while marching (the road
  right in front). **The skeleton is steering LOOKAHEAD only** — it runs *after* the first split event
  (not from the spiral center) and **biases the median toward the eventual LARGER Y-leg centerline**
  so a small leg that will split off anyway doesn't drag the main path.
- **[GATE w3-region-count]** already in §B/W3. Blocker: the faithful counter needs the real
  `ringMarch` piece-lineage (TS, exists — Ledger §3 #1), not a Python buffer-clip approximation.

### G2 — PSEUDO-BOUNDARY STEERING (islands & complex geometry) **[OPERATOR 2026-06-06 — load-bearing architecture]**

> This is THE way islands (and all already-cut frontiers) must be handled. The 2026-06-06 `_island4`
> stitcher VIOLATES it (fills the island from both sides and meets head-on at the back = architecturally
> broken). SquareIsland is "just about the simplest version it will ever see -- we could have 10 islands";
> the architecture must steer/meander through far more complicated geometry than this.

- **Already-cut stock defines a PSEUDO-BOUNDARY.** The cut/uncut frontier (the edge of cleared material) is
  treated by the path **exactly like any other wall/boundary.** The ClearedGrid (R1) is the live oracle for
  this: cut = boundary; uncut = fillable.
- **An island region circles the island and rejoins ITS OWN cut path.** As the spiral/arc front works around
  an island, when it comes back to stock it already cleared, it treats that cleared edge as a pseudo-boundary
  and follows along it -- the SAME loop continuing forward back onto itself. **There is nothing stopping the
  first region from working around the island back onto itself.**
- **NEVER fill an island from both sides to meet at the back.** Two fronts growing toward each other and
  meeting head-on (anti-parallel) is **functionally and architecturally broken** -- it forces the 179 deg
  loopback-joint / retrace seam we keep seeing. Forbidden. One continuous climb-wound path wraps the island.
- **Must GENERALIZE.** The mechanism is not an island-special-case stitcher; it is general pseudo-boundary
  steering that meanders through arbitrary cut/uncut topology (N islands, branching alleys). Build the
  general capability; SquareIsland is the easy first test, not the target.
- **[GATE g2-no-headon-meet]** no two cut fronts meet anti-parallel at an island back-seam (no anti-parallel
  coincident cut pair; the island wrap is one continuous winding). `NOT YET WIRED` (SquareIsland fails this
  in spirit -- the lb_joint 47 deg is the symptom of the head-on meet, not the disease).
- **REGION / TERMINUS LOCI must be a point GUARANTEED inside the actual uncut stock (pole-of-inaccessibility /
  a representative in-component cell), NEVER a raw area-CENTROID. [OPERATOR 2026-06-07]** A centroid is invalid for
  any region that SURROUNDS a hole: the uncut stock wrapping an island is an ANNULUS whose centroid lies IN THE
  HOLE. Observed: the front_regions SquareIsland "sustained region" star landed exactly at the island center
  [72.5,-53.3] because the locus was the annulus centroid. No region/terminus locus may lie inside an island /
  keep-out -- if one does, the locus computation (or the ring-region handling) is buggy.
  **[GATE region-locus-in-stock]** every emitted region/terminus locus is inside uncut stock AND outside all
  island keep-outs. `NOT YET WIRED`.

---

## H. Logical tools inventory (USE THESE — they work; don't rebuild) **[RECOVERED]**

> Full provenance in `AC-ATTEMPTS-LEDGER.md`. "(TS)" = exists in the production tree; port, don't rewrite.

**Ground truth & validation**
- `gt_fix{0..8}.json` / `cluster{0-8}.json` + `_enrich_cut_components.py` / `_seg.py` — enriched GT (§C).
- `scripts/_fusion_regions.py` — the region ground-truth oracle (real cut-order regions). THE region check.
- `scripts/comma-curvature.py` — Menger curvature / U-shape survey. `scripts/engagement-diag.py` —
  validated ~80° engagement reference. `scripts/point-match.py` → per-arc **sagitta** comparison
  (nearest-ring distance conflates ring-phase with shape — use sagitta).
- `scripts/_tan_analytic.py` — analytic tangency via **D1 on OCCT curves** (NOT finite-diff).

**Body / fill (geometry)**
- `ringMarch.ts` (TS, ADR-0012) — chained-offset fill-front with piece-lineage + merge-seam. Reuse for regions.
- `analyticSpiral.ts` (TS) — `updateContactedSeg`, `wallDistAtAngle`, `rActual<rIdeal` clamp. LIC helix in `planner.ts`.
- `fastMarching.ts` (TS) — entry-only FMM geodesic field; `MorphGrid.dist` is the single backend cut/uncut truth.
- `reMorph.ts::detectSplitsByStockConnectivity` (TS) — stock-connectivity region split. **DEMOTED / PROTOTYPE-ONLY / UNCALLED (decision D2, 2026-06-07).** It is NOT the region detector. The region criterion is **FILL-FRONT BREAK (sec G)**; this routine is at most a cheap *candidate-signal* whose proposed splits must be qualified by the fill-front rejoin-vs-dead-end test before any of them counts as a region. As a standalone criterion it is the connectivity-erosion approach **KILLED by Ledger Part 2 #20** (over-fires at necks/tapers; contradicted by real Barbell=1). It has no production caller (`index.ts` ships `runPlanner` only). Do NOT wire it as the detector; do NOT re-derive it. (Prior "(correct; keep)" wording was stale — superseded by sec G + Ledger #20.)
- `scripts/_genv3.py` — body generator; orients each main by turn-sign = spiral winding. `scripts/_phase1_build.py` — analytic loop builder.

**Linking / leads / corners**
- `scripts/linking.py` — validated OCCT linking chain: `corner_fillet` (**≤90° by construction** — use
  this, NOT ChFi2d for near-tangent leads), `reach_wall`, `wall_trim`, `walk`, `sample_uv`,
  `build_transition`, `make_lead`, `force_close` (corner-nibble), `closing_fillet`, `inscribed_radius`.
  A faithful PORT of the OCCT sandbox (sandbox_23 / occt_fillet). **Trust `_genv3` orientation; never re-chain.**
- OCCT-WASM vendored build under `src/lib/cam/geometry/occt/vendor/` (opencascade.js 2.0.0-beta:
  ChFi2d, GeomAPI_Interpolate, gp_Circ). ⚠️ `MakeEdge` unusable in WASM → use `polylineToCurve`.

**Visual / harness**
- `scripts/_shoot.py out.png 0` then **Read the PNG yourself** (self visual review). Render the intent
  AND the intended fix before coding.
- `overlay.html` / `gen-viewer.html` at **:8080** (`server.mjs`, no-store). **REUSE the running
  instance**; verify it actually reloaded (viewer-liveness was a recurring false claim).
- `sandbox_ac/_gate.py` — 9-fixture gate. **Never weaken a gate to pass; strengthen it honestly if it
  false-passes; revert anything that regresses the best state.**
- For raster centerlines use **skeletonize + junction-splitting (scikit-image)**, never a naive greedy tracer.

**Method (the working loop)**
- Diagnostic-first: **hypothesize → measure → review the artifact → adjust → proceed only when data
  matches.** SIGNED metrics only (abs/folded lied 3×). Generalize across **Bar + BootL + Comma**
  before adopting a mechanism (single-fixture conclusions are the recurring expensive mistake).
- "**Explain the scope back to me**" — when repeatedly missing, restate the scope; it surfaces the misunderstanding.
- No numeric conclusion without a single ordered run + inspected artifact; no commit hash unless copied
  from `git log` in the same step. **Replicate BEHAVIOR, not exact output** — correlate up to the first
  region split; divergence after is acceptable; the user is the visual judge.
