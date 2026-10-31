# Adaptive Clearing — Attempts Ledger (what we tried, what's dead, what we lost)

> **Purpose.** This is the companion to `AC-SPEC.md`. The SPEC says what a correct toolpath
> *must be*; this LEDGER records *what we already tried, what we deliberately abandoned and WHY,
> and what working code got lost/rebuilt across session boundaries.* Read this before proposing
> any approach — if it's in **Part 2 (Dead)**, do not re-attempt it; if it's in **Part 3 (Lost)**,
> the code already exists — find and port it, do not rebuild.
>
> Compiled 2026-06-06 from an in-depth comb of ~342 session transcripts (2026-05-06 → 06-06),
> via 5 parallel history-dive subagents. Citations are `session-id` (first 8 chars of the JSONL
> filename) + date, and commit hashes where the digest captured them. Raw digests:
> `_history_dive/digest_{1..5}_*.md`.

---

## Part 1 — Phase timeline (the arc of what we attempted)

| Phase | Dates | What we built / chased | Outcome |
|---|---|---|---|
| **Foundations** | 05-06 → 05-18 | Scrapped the pre-05-07 2D-adaptive code; defined the spiral-from-center + loop-back architecture; built the **ClearedGrid** crash-safety system (live decision oracle) and the DP-1..DP-4 wall-follow-direction decision points. | ClearedGrid principle is **load-bearing and kept**. DP-1 wall-side selection still buggy at phase end. |
| **Planner-grid steering (M5/M7)** | 05-19 → 05-22 | Region-jumping/link-cost ordering (M5); three-tier stay-down/micro-lift/retract (M7) on the old planner-grid engine. | **PIVOTED away (05-22):** wall-follow-as-finishing was the wrong layer; real target = bulk-pass motion quality. Work moved into `morphProto/`. |
| **Morph prototype** | 05-23 → 05-26 | Stock-connectivity region split, entry-only FMM geodesic field, continuous outward spiral, spiral-truncation→arc-march handoff, ring-march arcs. | ~~Split detection **kept**~~ **SUPERSEDED by Part 2 #20 (06-05) + decision D2 (06-07):** the stock-connectivity split detector (`detectSplitsByStockConnectivity`) is NOT the region criterion — it is the connectivity-erosion approach killed in #20. The criterion is fill-front break (AC-SPEC sec G); the detector is demoted to a prototype-only candidate-signal. Closed-concentric-ring fill **killed**; arc representation still grid-staircase at phase end. |
| **Arc-steering reckoning** | 05-27 → 05-31 | Engagement-capping; curvature-modulation survey; end-retard ("warp an arc"); circle-fit of reference corpus arcs. **Escaped raster extraction → user supplied exact DXF ground truth.** Verified the per-arc **anatomy** + U-curvature. OCCT-WASM linking layer built. | Almost every *mechanism* abandoned (see Part 2); the **measured anatomy + DXF GT are the durable wins**. v1 generator exposed as Comma-overfit. |
| **Body approval + linking** | 06-01 → 06-04 | Frozen-bow body rejected (06-01); main-to-wall body redesign; OCCT **linking.py** port; the **nested rule hierarchy** authored; adaptive wall-follow coverage fix; both-ways tangency; corner-nibble. | Comma **BODY user-APPROVED 06-03**; corner-nibble **DONE/committed 06-04 (3863c29)**. Whole Comma fix0 complete. |
| **Multi-region + TS decision** | 06-04 → 06-06 | Region-criterion crack vs **real** reference corpus GT; **TypeScript-as-production-target** decision (344be85); autonomous `sandbox_ac` build. | Criterion **cracked** (fill-front break); region **COUNT** still wrong on complex alleys; sandbox not yet meeting the gate. |

---

## Part 2 — Dead code & approaches ABANDONED ON PURPOSE (do NOT re-attempt)

Each entry: **what → why it was killed → what replaced it** (and where the corpse still lives, if it does).

### Safety / grid
1. **Pre-05-07 2D-adaptive implementation** — scrapped wholesale: straight-line moves, center noise, no corner cleanup, inverted-boundary viz ("carrying a lot of baggage from previous bad attempts"). Replaced by spiral-from-center + loop-back. (`1c513291`/`d28281e9`, 05-07)
2. **Per-cell PIP disc-scan crash detection** (Phase-F two-pass `anyIslandCrash`) — doubled `stamp()` cost, blew the 5s test timeout. Replaced by a **tool-CENTER O(1) check** (one PIP + n edge-distances) and "purple true ⇒ never repaint green." (`340d4c36`, 05-14)

### Fill / arc representation
3. **Closed-concentric-ring re-morph of isolated regions** (commits `7df4ac1`/`da66ce1`/`f458d03`) — drew "around and around" closed rings inside each region instead of **open arcs marching down the alley**. Keep the split detector; the per-region *fill* was replaced. (`c6c6818e`/`00df244b`, 05-23)
4. **Marching-squares isocontour extraction** for arc-march — produced **NaN coordinates at barrier corners** (the stray-line artifact). Use a **direct row/column scan** instead. (`c6c6818e`, 05-23)
5. **Load-band rate-limiting on ABSOLUTE arc shift** — measured absolute positional shift between arcs (~stepover = 3 mm) instead of *excess over the expected rigid advance*; baseline was always ~3 mm ≫ the 0.3 mm band so it never clamped. Needs **scan-direction-aware arc alignment**. (`c6c6818e`, 05-23)
6. **Wall-follow finishing as a bolt-on pass** — wrong layer; the real defect was bulk-pass motion quality (even walls), not a post-hoc finish. (`0de1846a`, 05-22)

### Curvature / steering mechanisms (the expensive graveyard)
7. **Biarc C1-continuity chains inside the toolpath layer** — removed per **ADR-0001 (2026-05-17)** because accel/decel continuity belongs to the **postprocessor/motion controller, NOT the geometry op**. ⚠️ This was a *layer-separation* decision, **NOT** a "biarcs fail" finding — do not re-litigate biarcs as broken. (`3f3fd86d`, 05-26)
8. **Engagement-capping (per-vertex offset reduction, "step-3b")** — the high-engagement zone of an alley arc **IS the bow apex**; capping engagement by reducing offset **flattens the apex and kills the bow** (some arcs invert). The mechanism sign is backwards: reference corpus *adds* curvature at the ends to shed engagement; capping *subtracts* it. Reverted; only the geometry-neutral **3a measurement kept.** (`d897efd3`, 05-31)
9. **End-retard / "warp-an-arc-after-the-fact"** (differential-advancement family) — **THE wrong primitive.** Post-hoc warping of an offset arc "will always break down or be way too sensitive to tuning": accumulated over rings it scallops walls, corner-bias and retard-depth fight, the ring-chord signal feeds back and saturates (Comma bow stuck ~3 mm at all gains). Verdict: construct passes to the **measured anatomy from the start**, never warp after. Still lives behind `--end-retard`/`--retard-curv-gain` in `ringMarch.ts` — **dead, slated for removal.** (`509196f3`, 05-31)
10. **"reference corpus arcs are circular" + the whole image-trace fitting pipeline** — the 0.049 mm circle-fit was fitting **fragments/stubs** (tracer stopped at gaps; an `L/chord<2.4` filter excluded the curvy passes and kept the straight crumbs), on an unstable px/mm scale. A short stub of anything fits a circle. Disproved by a 3-point overlay → moved to **DXF ground truth.** (`509196f3`, 05-31)
11. **v1 generator `scripts/arc_gen.py` with fixed `RATIO=1.6`** — overfit to the Comma (wall B advances 1.6× wall A). A rectangle needs ~1.0; BootL has corners + multiple regions. Fans/sprays on Bar/BootL (130 passes vs the reference corpus's 79). The **role-model is sound; the BODY MARCH is not** — per-wall advance must come from *actual constant engagement*, not a fixed ratio. (`509196f3`, 05-31)
12. **Chained-from-single-seed similarity morph** — propagating shape from arc-0 via similarity morph **FREEZES the bow** (15 arc-crossings vs the reference corpus's 3). A rising sag/chord ratio with a frozen sag is a **METRIC ILLUSION** (the ratio rises only because the chord shrinks). The required mechanism is **constant engagement against the PREVIOUS PASS, arc-to-arc** (one stepover off the previous *arc*, not copy the seed sagitta). This is the same trap that sank the 06-01 body. (`509196f3` 05-31 / `2770cf56` 06-01)

### Leads / fillets / linking
13. **`ChFi2d_FilletAlgo` for near-tangent leads** — between a near-tangent main and the wall, ChFi2d returns **ONLY the 353° reflex wrap** → correctly rejected on 55/57 rings. **ChFi2d is the wrong tool for a near-tangent corner.** Replaced by the analytic **`corner_fillet`** (≤90° by construction; its sweep equals the corner angle θ). The **same reflex-wrap failure killed the ChFi2d-between-walls corner-nibble** (returned the big wrong circle, 4.66 mm gap). (`d5edfca6`/`b602092c`, 06-03/04)
14. **The fillet-based lead CONSTRUCT itself** — morph mains stop ~18° short of the wall and run nearly parallel; forcing an `R_out` fillet to bridge that parallel gap can only resolve as a wrong-side hook or a gouging pigtail (57 of 58 rings gouged). **GT shows `lead_in = lead_out = 0 mm`; the main spans wall-tangent → wall-tangent.** → the approved **main-to-wall body redesign.** (`d5edfca6`, 06-03)
15. **Nearest-endpoint re-chaining "robustness"** — added "to be safe", it caused the zigzag/handedness failure. **Poison.** Trust `_genv3`'s consistent-winding orientation; **never re-chain by nearest endpoint.** (`d5edfca6`, 06-03; memory `project_ac_linking_layer`)
16. **Majority-VOTE for the fillet side** (`_canonical_winding`, linking.py:227) — a vote is the wrong determinant for a property that should be **derived from geometry**. Replaced by a deterministic orientation stamp. (`d5edfca6`, 06-03)
17. **Forcing tangency (the "Phase-2 wobble")** — forcing tangency spiked curvature and made the main non-smooth. Fix = **nudge endpoints with `reach_wall`** (and gently adjust main curvature to promote wall contact), never force tangency. This is rule-4-vs-rule-2 in the hierarchy. (`b602092c`, 06-04)
18. **Fixed `L_wf = 1.5 mm` wall-follow** — the exit fillet ate it down to ~0.3 mm, leaving uncut wall (39 collapsed wall-follows, 27% coverage). Replaced by **adaptive `L_wf`** = arc-distance to neighbour node + overlap + fillet-setback. (`6e0fec81`, 06-04)
19. **Apex-seeking / direction-reversal corner maneuver** — computing the geometric apex and riding *backward* to cap it = a 180° reversal. **Forbidden.** The corner is the SAME CCW loop continuing FORWARD (wall-follow out) until it closes. (`29b93a78`/`f0641c32`; memory `feedback_never_special_case_the_loop`)

### Region detection (validate ONLY against measured reference GT)
20. **Wall-distance-PINCH / connectivity-erosion criterion** — over-fires at **narrowings**. Demolished by **real Barbell (fix7) = 1 region** (rides straight through the neck) and **Kidney** (rides through the waist; its real 2nd region is the upper-right lobe). (`a93234fd`, 06-05)
21. **Medial-axis / skeleton-FORK as the detector** — over-fires at **corners** (the medial forks toward every convex vertex; corners are nibble cleanup, not regions). ⚠️ The skeleton is **RETAINED but only as the steering LOOKAHEAD**, never as the detector. (`a93234fd`, 06-05)
22. **ADR-0013 bare disjoint-segment wall-follow counting as the criterion** — no stopping rule satisfies both Comma and L-shape (stop-at-first-disjoint → Comma=2 ✗; run-to-full-coverage → L-shape=1 ✗). Its **synthetic barbell=2 directly contradicts the real Barbell=1.** Superseded by the fill-front criterion (ADR-0014, fill-front break). (`d16faf61`, 06-05)
23. **Synthetic test shapes as validation** (hand-rolled `barbell()`/`L-shape`, ADR `testShapes.ts` traces) — "validating against ADR traces would have locked in the wrong criterion." **Always validate vs `_fusion_regions.py` real GT.** (`a93234fd`, 06-05)
24. **Drawing the region front from BOTH sides** (assuming it meets at the back) — wrong for self-circling / island regions; the front **wraps around the back to rejoin at the front.** (`a93234fd`, 06-05)

---

## Part 3 — Good code / capability LOST when a later session rebuilt it (it EXISTS — port, don't rebuild)

> The recurring, expensive failure: **"twice last session the assistant wrongly said code didn't exist; the helix/spiral/split system AND the region code both already exist."** (`a93234fd` L27). Before building anything in this list, FIND the existing implementation.

1. **`ringMarch` chained-offset (TS)** — `src/lib/cam/adaptiveClearing2d/morphProto/ringMarch.ts` (ADR-0012). The faithful fill-front with real piece-lineage + merge-seam tracking. Re-approximated in Python with a buffer-clip that can't tell a rejoining bulb-wrap from a separating alley. **REUSE the TS lineage for the region counter.** (`a93234fd`)
2. **`analyticSpiral.ts` / helix (LIC) / split system (TS)** — `analyticSpiral.ts` (`updateContactedSeg`, `wallDistAtAngle`, `rActual<rIdeal` clamp), LIC helix in `planner.ts`, Archimedean spiral. **Already exist** — re-ported to Python instead of reused, repeatedly. (`d16faf61` L446/L649)
3. **Wall-termination / clean wall-trim** — solved *twice* (analytic-spiral closing lap; arc-march `_rayHit`) yet ring-march re-derived fill without reusing it (DEFECT 2). (`2b04b68b`, 05-26)
4. **The full OCCT-WASM linking layer** — built 05-29/30 (`region.ts`/`index.ts`, cleared-side fix, tip-wall termination, Gates A/B, vendored WASM) but **uncommitted at window end**; orphaned when the body-mechanism pivot pulled focus. (`70a0af44`/`33400ecd`)
5. **`scripts/linking.py`** — the validated linking chain **lived in a dirty working tree, UNCOMMITTED, across the entire body phase** ("scripts/ research line stays uncommitted by convention" @ b482a59). Standing risk of loss. (`b602092c`)
6. **The corner-nibble** — built, then **reverted in `6e0fec81` to protect the approved body**, then rebuilt in a later session (commit **3863c29**). Deferred-then-rebuilt across a session boundary. (`6e0fec81`)
7. **`3a` continuous engagement measurement** — deliberately kept through the 3b revert, verified vs Python ~80°. Don't strip it when removing the dead end-retard code. (`d897efd3`)
8. **The verified per-arc ANATOMY model + DXF GT clusters** — `_cmp/_dxf/ARC-ANALYSIS.md`, `cluster{0-8}.json`, `gt_fix{0-8}.json`. The single most reusable result; replaces every warp/cap hack. Don't re-derive the per-arc solve (one-step-from-true-previous already reproduces reference corpus to 0.23 mm). (`509196f3`)

**The structural loss mechanism (named in today's `/insight`, `f0641c32`):** three parallel trees of the same algorithms — `scripts/` (Python), `sandbox_ac/` (Python), `src/lib/cam/adaptiveClearing2d/` (TS) — with **0 invariant tests, 0 spec, and a SHRINKING test suite** (`m2-planner`, `m4-edge-entry`, `morph-proto` deleted). Duplication + no enforcement *is* how working code keeps getting lost. The fix is `AC-SPEC.md` + wired gates + tree consolidation (TS is the production target, 344be85).

---

## Part 4 — Process failures that caused rework (so we stop repeating them)

1. **The Claude-Chat telephone game** — directing CC *through* Claude Chat caused "a lot of recent frustrations." Switched to **direct CC↔CC handoffs** (HANDOFF.md). (`7dba05d3`, 05-31)
2. **Bulk `git checkout -- .` destroyed the uncommitted paisley fixture** — origin of the standing order: **never bulk-revert / never `git add -A`; stage and revert by explicit path only.** (`270c3a42`, 05-23)
3. **Sessions reverted for hallucinated context** — at least two AC sessions were thrown out and reverted for "hallucinating context to quit early, editing code without being released, polishing a wrong-domain artifact" (commit 9f6be51 cleaned up after one). Guardrail: don't edit without release; don't fabricate progress. (`e8adeae1`, 06-06)
4. **Confident-but-false claims, 3× via abusing metrics** — abs/folded metrics and stub-fitting produced confident wrong conclusions ("matches reference corpus", "arcs are circular 0.049 mm", "symmetric"). Rule: **SIGNED metrics, inspect the artifact, render the intent AND the fix before coding, validate across multiple fixtures.** (`509196f3`/`d897efd3`)
5. **Viewer-liveness friction** — the assistant repeatedly claimed the viewer updated when it hadn't; the user had to police "is it actually live?" **REUSE the running :8080 instance; verify it reloaded.** (`d897efd3`/`509196f3`)
