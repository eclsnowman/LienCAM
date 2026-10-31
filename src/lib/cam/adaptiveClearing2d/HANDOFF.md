> STALE MECHANICAL BANNER (flagged 2026-06-16): the HEAD/branch/suite numbers below are
> outdated (they predate the rename). For current mechanical state use
> `docs/planning/AC-PERF-HANDOFF.md`. Trust `git log`/`git status` over any number here.

# Adaptive Clearing — Session Handoff

> ## CLEANUP MILESTONE 2026-06-10 — trunk is now `main` (read before the session banner below)
>
> docs/planning/CLEANUP-PLAN.md was executed 2026-06-10. FORWARD WORK NOW LIVES IN
> docs/planning/FEATURE-REQUESTS.md. Stages 0-3 COMPLETE, gates green: dirty tree settled;
> 1,763 files / ~224 MB graveyard archived to `..\LienCNC-CAM-archive\2026-06-graveyard\`;
> dead TS removed (old planner, morphProto/, OCCT; reachability dead-list = ZERO;
> m5-wall-follow KEPT — live sampleArc contract); ~110MB debris + ~350MB fixture diet
> removed (D2 user-confirmed); FreeCAD port reference now at docs/reference/. Stage 4
> PARTIAL by design: `master` fast-forwarded + renamed `main`; all tips tagged
> `pre-cleanup/*-2026-06-10`; loopback-v2 deleted; a fully-gated brep merge was BACKED OUT
> per Operator (parked on tag `staged-merge/brep-into-main-2026-06-10`; brep/sketch branches
> have since advanced — fresh merge only on Operator's explicit go); sketch merge blocked on
> Operator's visual gate; research-branch deletion is Operator's call. NEW BASELINES on `main`:
> tsc clean; engine 56 pass / 4 skip; cam 88 pass (112 only after a future brep merge);
> geometry suite zero tests. `87000aa` = optimal-load default 97% -> 25% (user request).
> The session banner below predates the rename: where it says branch
> `adaptive-clearing-v1`, the trunk is now `main`.
>
> ### WHAT I WISHED I KNEW AT START (cleanup session 2026-06-10)
> 1. **Operator is the CNC tool-pathing SME, NOT a coder.** Translate ALL git/code talk to
>    plain English; never assume he can vet a git-level plan step.
> 2. **NEVER do branch topology changes (merge/rename/delete/worktree-remove) without a
>    fresh plain-English OK in the CURRENT conversation.** Plan docs are NOT standing
>    authorization. Operator runs PARALLEL Claude sessions in worktrees (brep + sketch were
>    BOTH actively advancing during this session).
> 3. **The dev-repo cleanup (docs/planning/CLEANUP-PLAN.md, see its Execution status section) is DONE
>    at file level:** dead planner/morphProto/OCCT code removed (reachability list =
>    zero), 350MB fixture sweeps removed, research graveyard archived at
>    `..\LienCNC-CAM-archive\2026-06-graveyard\` (1,763 files, verified,
>    ARCHIVE-MANIFEST.md).
> 4. **A fully-gated brep merge was built then BACKED OUT (Operator's call);** it is parked
>    on tag `staged-merge/brep-into-main-2026-06-10` as a REFERENCE ONLY --
>    brep-kernel-v1 has advanced past it (9ff436c+), so a FRESH merge is needed when
>    Operator gives the go.
> 5. **Engine baseline is now 56 pass / 4 skip** (fillet.test removed with dead
>    engine/fillet.ts); cam 88; geometry suite is EMPTY. (HISTORICAL: the clipper-wasm
>    ~12-engine-runs-per-process abort that forced own-invocation runs was fixed
>    2026-06-11 -- embind handle leak, see engine/_wasm-leak-probe.test.ts.)
>
> ### MECHANICAL STATE (2026-06-10 cleanup close, CC-derived)
> - **Branch:** `main` (trunk renamed from `master` and fast-forwarded).
> - **HEAD:** `ccd48de` docs(cleanup): Stage 5 closeout - execution status,
>   architecture refs, milestones.
> - **Recent commits (git log --oneline -8, newest first):** `ccd48de` Stage 5 closeout
>   docs -> `87000aa` fix(ac): default optimal load 97% -> 25% -> `7219bfe`
>   test(fixtures): fixture diet, drop 351M sweep dirs + renders, keep GT (D2) ->
>   `f0d0c0f` docs(ac): track canonical AC docs + sample part DXFs -> `e054cdb`
>   chore(repo): gitignore hardening + untrack machine-local Claude settings ->
>   `e6cadcc` chore(repo): remove research scripts/ and generated example  output ->
>   `001e5d0` docs(reference): adopt FreeCAD Adaptive_Path port reference ->
>   `8f1b562` refactor(ac): remove dead engine/fillet.ts + test (D4).
> - **Working tree:** clean except a small untracked KEEP-LIST set (canonical fixture
>   JSONs + README + preview + prepared/ under `test_fixtures/adaptive-clearing/`, GT
>   enrichment files under `spirals/_cmp/_gt/`, two scratch engine tests
>   `_one-loop-schematic.test.ts` / `_sidebyside.test.ts`). Stage by explicit path only;
>   never `git add -A`.
> - **Stash list:** EMPTY.
> - **Test baselines:** engine suite 56 pass / 4 skip; cam 88 pass; geometry ZERO tests
>   (occt-smoke removed with the dead OCCT code). tsc clean. Engine must run as its OWN
>   vitest invocation.
>
> ### SEED PROMPT for next session (CURRENT -- supersedes the session-4 seed prompt below)
> ```
> Continue LIENCAM (trunk = main, HEAD ccd48de). You are the ARCHITECT + QUALITY GATE,
> not the primary coder.
>
> WORK STYLE (load-bearing): stay THIN. Your scarce resource is your OWN context window.
> DELEGATE every heavy chunk -- recon, implementation, debugging, AND
> verification/measurement runs -- to fresh subagents that return ~250-word digests.
> Read the digests, make the architectural call, gate, and commit. Keep heavy
> reading/building/running OUT of your own context.
>
> REMAINING WORK ITEMS -- each one is GATED on Operator's explicit plain-English
> confirmation in THIS conversation (plan docs are NOT standing authorization; Operator
> runs parallel Claude sessions in worktrees):
> (a) Fresh merge of brep-kernel-v1 into main WHEN Operator says his brep session is done.
>     Re-run git merge-tree first; expect the cam suite to grow to 112 with brep's
>     drill2d + pocket2d-islands tests; run the brep smoke per docs/brep/HANDOFF.md.
> (b) sketch-mode-v1 merge ONLY after Operator passes its Stage-3 visual gate. 3 known
>     conflict files: src/store/index.ts, PropertiesPanel.tsx, docs/decisions/README.md
>     -- both branches add store slices; the semantic merge is TAKE BOTH.
> (c) Operator personally runs `git branch -D adaptive-spiral-v1 arc-tangency-fix-v1
>     tangent-continuity-v1` (archive-tagged; his settings block Claude doing it).
> (d) Worktree removals only after their merges land and Operator confirms those sessions
>     are closed.
>
> GUARDRAILS: never git add -A; gate every chunk (npx tsc -b + engine suite as its OWN
> vitest invocation + cam suite); plain ASCII replies only; end every reply with the
> review-image path if visual work occurs.
> ```
>
> ---
>
> **Freshness: mechanical CURRENT at HEAD `ccd48de` on branch `main` (2026-06-10
> cleanup session; mechanical-only update, no chat payload). CHAT-SIDE FIELDS: stale
> (last fresh: 2026-06-10 session 4) -- the mechanical state advanced via the cleanup
> session. EVERYTHING BELOW THE 2026-06-10 SESSION-4 BANNER
> (the OCCT-linking / §3/§3a / bespoke M0–M4 content) IS HISTORICAL — keep it for the
> fillet/loopback PORT REFERENCE, do not treat it as the current architecture. Backlog #1
> (loopback fillets) and #2 (engine nondeterminism) are now BOTH CLOSED; the open work is the
> renumbered backlog (BootL corner-wrap, multi-part, smoothing, deferred params, perf) — see
> the session-4 OPEN BACKLOG (the seed prompt of record is now the CURRENT one above).**
>
> ---
> ## SESSION 2026-06-10 — determinism + loopback fillets (READ THIS BANNER FIRST)
>
> ### WHAT I WISH I'D KNOWN AT LINE 1
> 1. **"Clipper set-ordering" was a FALSE theory.** clipper2-wasm is fully deterministic. The
>    engine's only nondeterminism was the lone `Math.random()` in `interpolation.ts`
>    `randInRange()` (FreeCAD-faithful random probe angles, directly acceptable as steering
>    steps). Fixed with a fixed-seed mulberry32 per interpolator (`bdbdcb1`); byte-identical
>    regression test = `engine/determinism.test.ts`. Do not re-suspect clipper.
> 2. **Wiring the <=90 `filletJoin` gate (the prior handoff's prescription) would have been
>    WRONG.** Measured: legitimate U-turn loopbacks sweep 90-161deg (median 92.6). The bypass
>    in `wallCleanLoop.ts` is CORRECT and stays. The real defects were anti-parallel contacts.
> 3. **Loopback defect root cause = ride overshoot, not fillet sizing.** The min-3.0mm wall-ride
>    budget put the outgoing contact F BEHIND the incoming contact E on the same wall ->
>    anti-parallel tangents -> silent den~0 fallback -> 2pi-wrap pigtails (pct100) or straight
>    180deg reversal links (pct25). Fixed (`b4c8b00`): contact-overlap clamp (forward-ordered,
>    zero coverage loss), adaptive Rf (t <= |EF|/2, <= 0.9x own ride), fail-loud validation +
>    Rf retry ladder; straight-link fallback now warns loudly (unreachable on all fixtures).
> 4. **The "~173 good loopbacks" ballpark did NOT reproduce** (284 transition-level GOOD at
>    pct25 pre-fix, 308 post-fix). The committed circle-fit guard
>    (`engine/loopback-fillet.test.ts`) is the measurement of record — judge by its classes
>    (GOOD/SUSPECT/PIGTAIL/MISSING), never bare counts.
> 5. **HISTORICAL (fixed 2026-06-11): clipper wasm aborted after ~12 engine runs per
>    process.** Root cause = embind handle leaks in clipperEngine.ts (un-deleted
>    PathsD.get/PathD.get/polygon() heap copies). Heavy sweeps no longer need splitting.
> 6. **Naive splitting of a balloon U-turn reports fake pigtails.** A zero-length-traverse
>    loopback = two tangent <=165deg arcs; split-by-longest-segment misclassifies it as a
>    >180 wrap. The committed guard tries all splits (certificate-split). In-engine, every
>    arc is validated sampled-sweep == intended-turn <= 180, so true wraps cannot be emitted.
>
> ### SHIPPED THIS SESSION (oldest->newest over `d89957c`)
> - `bdbdcb1` fix(ac): seed steering probe PRNG for deterministic toolpaths (+determinism test,
>   stale "clipper is stochastic" comments corrected; flaky integral-wall-follow now stable).
> - `b4c8b00` fix(ac): forward-ordered loopback contacts + adaptive fillet radius
>   (`wallCleanLoop.ts` ~400 lines: overlap clamp, loopbackArc rewrite with validation +
>   retry ladder; `processFeature.ts` escape callback + warn tripwires).
> - `6167758` test(ac): circle-fit regression guard for loopback fillets (fix1/5/7 pct25 +
>   fix5 pct100, <60s).
> - Results: pct25 MISSING 12->0, token arcs 10->0, backward traverse 1->0, GOOD 1186->1230
>   fillet / 284->308 transition; pct100 PIGTAIL 1->0, MISSING 413->0. Engine suite 59 pass /
>   4 skip; tsc green.
>
> ### SUPERSEDED THIS SESSION
> - Backlog #1 + #2 of the 2026-06-09 banner: CLOSED [2026-06-10, commits above].
> - "Fix = adaptive Rf / wire the <=90 gate": half-superseded — adaptive Rf yes, wiring the
>   <=90 gate NO (see WISH item 2).
> - "clipper nondeterminism / clipper set-ordering": REFUTED (WISH item 1).
>
> ### PENDING USER VISUAL GATE
> - `review-images/loopback-fillet-fixed-fix5.png` (pct25) and
>   `review-images/loopback-fillet-fixed-pct100-fix5.png` (pct100): no defect class in either.
>   At pct100, top-right pocket shows BALLOON U-turns (two tangent <=165deg arcs at
>   zero-length traverses) — constructed, validated geometry; the user judges whether that
>   motion is acceptable at large loopbackFilletPct.
> - Still pending from 2026-06-09: `each_stepdown` wall-finish on a multi-stepdown pocket;
>   finish feedrate field carry-through (magenta moves).
>
> ### OPEN BACKLOG (renumbered)
> 1. BootL corner not wrapped (should WRAP continuously, not reseed/skip).
> 2. Multi-part / "All Parts" (engine is single-largest-loop-as-boundary).
> 3. Toleranced polyline smoothing stage before the postprocessor.
> 4. Other deferred modal params (min ramp dia, axial/floor stock, fine stepdown, max
>    stay-down, min cutting radius).
> 5. Perf: spatial index on `cleared`.
> Feature follow-ups: floor finish pass; finish lead-in/out arcs.
> Then per docs/planning/RELEASE-PLAN.md: complete remaining v1 work -> run `liencam-release-cleanup`.
>
> ### REUSE, with friction (by path)
> - `engine/loopback-fillet.test.ts` — circle-fit defect guard (certificate-split; tries all
>   arc splits before declaring a wrap). Extend it, don't write a parallel counter.
> - `engine/determinism.test.ts` — byte-equality double-run; any new stochastic mechanism must
>   keep it green (seeded PRNG pattern in `interpolation.ts` mulberry32/PROBE_SEED).
> - `wallCleanLoop.ts` `loopbackArc` — now validates contacts-on-circle, forward order,
>   sweep==turn, <=45deg chain kink, with Rf ladder (1, .5, .25, .1) + region-escape callback.
>   Zero-turn joints emit straight stubs by design.
> - `processFeature.ts` straight-link fallback — fail-loud `console.warn`; if it EVER fires on
>   a fixture, that is a regression tripwire, not noise.
> - Joint kinks 25-40deg beside wall polyline vertices = pre-existing noise class (guard
>   threshold 60deg); >45deg kinks are retried in-engine. Don't chase the 25-40 band.
>
> ### SEED PROMPT for next session
>
> > RETIRED - do NOT paste. Stale branch/HEAD; the live AC truth is the FreeCAD
> > Adaptive2d TS port in engine/ ([[project_ac_freecad_port]]) + current perf
> > state in docs/planning/AC-PERF-HANDOFF.md. History only.
>
> ```
> Continue LIENCAM adaptive-clearing (branch adaptive-clearing-v1, HEAD 6167758). You are the
> ARCHITECT + QUALITY GATE, not the primary coder.
>
> WORK STYLE (load-bearing): stay THIN. Your scarce resource is your OWN context window.
> DELEGATE to fresh subagents for EVERYTHING heavy -- recon, implementation chunks,
> debugging, AND verification/measurement runs. Read their ~250-word digests, make the
> architectural call, gate the render yourself, hand the review-image path to the USER for
> the visual gate, and commit. Keep heavy reading/building/running OUT of your own context.
>
> START: read project_ac_freecad_port memory, then the 2026-06-10 HANDOFF banner
> top-to-bottom (esp. WHAT I WISH I'D KNOWN -- false clipper theory, the <=90-gate trap, the
> balloon-split artifact). Confirm HEAD = 6167758. The working tree has a LARGE pre-existing
> dirty/untracked mess -- LEAVE IT ALONE; stage only explicit paths.
>
> GOAL options (OPEN BACKLOG): #1 BootL corner-wrap (wrap continuously, not reseed/skip) OR
> #2 multi-part "All Parts". Diagnose-first: one cheap measurement subagent before any build.
> Engine determinism now holds (byte-identical) -- measurements are stable.
>
> HARD RULES: never judge fill cleanliness by worstGapR/2D-area coverage (use the in-app
> STOCK SIM); never reverse the path; loopback U-turns are EXEMPT from the <=90 lead gate;
> (the old clipper-wasm ~12-runs/process abort is FIXED 2026-06-11 -- embind handle leak).
> ```
>
> **Tooling:** `DUMP=1 FIX=0..8 [SPANS=1] [WALLFOLLOW=1] [DXF=path MAXISLANDS=n] npx vitest run
> src/tests/adaptive-clearing/engine/_visual-dump.test.ts` (-> `review-images/`); `_emit-dump`
> for emitted moves by Z; gate `npx vitest run src/tests/adaptive-clearing/engine/`; `tsc -b`.
>
> ---
> ## PRIOR SESSION 2026-06-09 (wall-finish) — kept for reference
>
> **Architecture:** adaptive clearing is a clean-room TS PORT of FreeCAD's Adaptive2d in
> `src/lib/cam/adaptiveClearing2d/engine/` (clipperEngine, toolGeometry, geom, interpolation,
> steering, engagementPoint, processFeature, emit, index). Routed store→worker→engine,
> creatable in the New Operation modal, user validating real parts in-app.
> **Source of truth = the `project_ac_freecad_port` auto-memory (read FIRST).**
>
> ---
> ## WHAT I WISH I'D KNOWN AT LINE 1 (read this first)
> 1. **The user's "uncut spike / area doesn't clean up" was NOT a toolpath defect — it was the
>    STOCK SIM not carving wall_follow moves.** Fixed in `537a549` (SimulationPanel.tsx
>    `CUTTING_ROLES` now includes `wall_follow` + `lead_in`/`lead_out`). The toolpath was CORRECT.
>    Do NOT chase a toolpath fix for a sim-DISPLAY gap.
> 2. **`worstGapR` / 2D-area-coverage is BANNED as a cleanliness verdict** — physically blind to
>    thin-but-tall spikes + scallops. GROUND TRUTH = the user's in-app STOCK SIM (heightmap). The
>    architect relapsed on this 3+ times this session (`feedback_gates_mask_defects`).
> 3. **The "spike at the spiral center" reported mid-session was a MEASUREMENT ARTIFACT** — the
>    offline raster omitted the HELIX ENTRY that bores the center. Any offline stock raster MUST
>    sweep ALL material-removing moves (helix/ramp/plunge/cut/wall_follow), matching
>    HeightmapSimulator's roles.
> 4. **The over-load the user flagged was REAL** (~40% of steps mildly over optimal) → fixed by a
>    0.95 load SETPOINT (`8538719`), a SMOOTH fix; an asymmetric hard-cap was jagged + user-rejected.
>    It is a setpoint SHIFT, not a hard cap. Degenerate near-zero-length start moves still spike
>    areaPerDist (likely a metric artifact, low priority). The cap is PROVISIONAL — user may pull
>    it back after the real-tool run.
> 5. **The "wedge / single-continuous-front topology rewrite" worry is DEAD** — there was no real
>    interior defect; it was the sim bug. Do NOT reopen it.
>
> ---
> ## SHIPPED THIS SESSION (mechanical, oldest→newest over `2caef90`)
> `8538719` load cap (0.95 setpoint, PROVISIONAL) · `537a549` stock-sim wall_follow carve fix ·
> `e241e8f` scaffold wall-finish params + `finish` MoveRole · `7d6c445` engine wall-finish contour
> + emit gating · `658443c` modal toggle · `357e4e5` finish feedrate override · `2caef90` paired docs.
> - **(a) Load cap `8538719`** — provisional smooth 0.95 load setpoint, NOT a hard cap.
> - **(b) Sim carve fix `537a549`** — the headline bug (item 1 above).
> - **(c) WALL-FINISH FEATURE `e241e8f..2caef90`** — `ACParams.wallFinish` + `wallFinishMode`
>   (`'final'` default / `'each_stepdown'`). True-wall contour = `offsetClosed(featLoops,-toolRadius)`
>   on COMBINED boundary+islands (0 radial stock; an island too close to the wall BLENDS into one
>   wrapped contour). New `'finish'` MoveRole (magenta). Finish feedrate override
>   (`FeedrateOverride.finishFeedrate`, optional; defaults to cut feed, NOT rapid-clamped). Modal:
>   Linking-tab checkbox + mode select. Docs paired. User-GATED the final-mode geometry live.
>   Deferred by user (Q1/Q6): FLOOR finish pass + finish LEAD-IN/OUT arcs (for more finish, add a
>   Contour op after).
> - **Tests:** `tsc` green; AC engine suite 57 pass / 4 skip; feedrate tests green. The
>   integral-wall-follow test is INTERMITTENTLY FLAKY (clipper nondeterminism) — pre-existing,
>   = backlog #2.
>
> ---
> ## SUPERSEDED
> - Backlog #3 "fill-seam / the wedge" + the session-long "wedge defect / single-front topology
>   rewrite" are SUPERSEDED [2026-06-09 — resolved as a stock-sim CARVE bug, `537a549`; the
>   toolpath fill is correct]. Do not reopen.
>
> ---
> ## GROUND TRUTH
> Cleanliness is judged ONLY by the user's in-app STOCK SIM (heightmap) — never by `worstGapR` or
> 2D area coverage (item 2). Any offline raster MUST sweep ALL material-removing roles
> (helix/ramp/plunge/cut/wall_follow), matching HeightmapSimulator (item 3). The user is the
> visual gate.
>
> ---
> ## MANUAL-TEST PENDING (headless — user must verify in-app)
> - `each_stepdown` mode on a multi-stepdown pocket (finish at EVERY Z level).
> - Finish feedrate field: set a value → confirm magenta `finish` moves carry it; empty = cut feed.
>
> ---
> ## OPEN BACKLOG (ordered, next-session)
> 1. **Missing/wrong-way loopback fillets.** MEASURED this session: the wrong-way ones are >180deg
>    pigtails; the ≤90 fillet gate `filletJoin` is DEAD CODE in the live `loopbackArc` path. Fix =
>    adaptive Rf / wire the ≤90 gate — NOT built. Verify by MEASUREMENT (circle-fit), never count.
> 2. **Engine NONDETERMINISM** (clipper set-ordering) — the flaky integral-wall-follow test.
>    Reproducible toolpaths are non-negotiable for CAM.
> 4. BootL corner not wrapped (should WRAP continuously, not reseed/skip).
> 5. Multi-part / "All Parts" (engine is single-largest-loop-as-boundary).
> 6. Toleranced polyline smoothing stage before the postprocessor.
> 7. Other deferred modal params (min ramp Ø, axial/floor stock, fine stepdown, max stay-down, min
>    cutting radius).
> 8. Perf: spatial index on `cleared`.
> Plus FEATURE FOLLOW-UPS: floor finish pass; finish lead-in arcs.
>
> ---
> ## REUSE, with friction (by path)
> - `SimulationPanel.tsx` `CUTTING_ROLES` — the LIVE carve set (now includes `wall_follow` + leads)
>   vs the BASELINE pre-carve (~line 281, uses `type !== 'rapid'`). `HeightmapSimulator` carves a
>   cylinder `r = tool.dia/2`, lower-Z-only.
> - `_visual-dump.test.ts` — the visual-dump harness is PRE-EXISTING DIRTY; do NOT modify it. Write
>   a SEPARATE scratch test for wallFinish renders.
> - **Engine emit:** `'finish'` passes are tagged role `'finish'` with NO baked feed (ADR-0001);
>   depth gating lives in the `emit.ts` depth loop.
> - **Reference scene:** `"Sample Parts/Leadscrew_Stepper_Mount.DXF"` (uppercase `.DXF`), boundary +
>   central bore island, `MAXISLANDS=1`, `TOOLR=1.55`, `STEPOVER=0.32`, finishStock `0.5`.
> - **Visual artifacts in `review-images/`:** `leadscrew-wallfollow-diff.png` (the sim-bug proof),
>   `leadscrew-stockmap-verify.png` (center cleared via helix), `wallfinish-leadscrew.png` +
>   `wallfinish-closeisland.png` (the feature + Q5 blend).
>
> ---
> ## SEED PROMPT for next session
>
> > RETIRED - do NOT paste. Stale branch/HEAD; live AC truth =
> > [[project_ac_freecad_port]] + docs/planning/AC-PERF-HANDOFF.md. History only.
>
> ```
> Continue LIENCAM adaptive-clearing (branch adaptive-clearing-v1, HEAD 2caef90). You are the
> ARCHITECT + QUALITY GATE, not the primary coder.
>
> WORK STYLE (load-bearing -- proven this session): stay THIN. Your scarce resource is your OWN
> context window. DELEGATE to fresh subagents for EVERYTHING heavy -- recon ("where/how does X
> work"), implementation chunks, debugging/troubleshooting, AND verification/measurement runs.
> Read their compact (~250-word) summaries, make the architectural call, gate the render yourself,
> hand the review-image path to the USER for the visual gate, and commit. Keep heavy
> reading/searching/building/running OUT of your own context so you orchestrate for many turns.
>
> START: read project_ac_freecad_port memory, then this HANDOFF banner top-to-bottom (esp. WHAT I
> WISH I'D KNOWN -- the sim-carve bug, the banned worstGapR verdict). Confirm HEAD = 2caef90. The
> working tree has a LARGE pre-existing dirty/untracked mess -- LEAVE IT ALONE; stage only explicit
> paths (engine files + their tests + modal/docs when a task needs them).
>
> GOAL options (see OPEN BACKLOG): #1 loopback fillets -- the <=90 gate (filletJoin) is DEAD CODE in
> the live loopbackArc path and the wrong-way ones are >180deg pigtails; fix = adaptive Rf or wire
> the <=90 gate; verify by circle-fit MEASUREMENT, never count. OR #2 engine nondeterminism (clipper
> set-ordering; the flaky integral-wall-follow test).
>
> HARD RULE: NEVER judge AC fill cleanliness by worstGapR or 2D-area coverage -- use the in-app
> STOCK SIM (heightmap). Any offline raster must sweep ALL material-removing roles.
> ```
>
> **Tooling:** `DUMP=1 FIX=0..8 [SPANS=1] [WALLFOLLOW=1] [DXF=path MAXISLANDS=n] npx vitest run
> src/tests/adaptive-clearing/engine/_visual-dump.test.ts` (→ `review-images/`); `_emit-dump`
> for emitted moves by Z; gate `npx vitest run src/tests/adaptive-clearing/engine/`; `tsc -b`.

> This file captures the current strategic and mechanical state of the
> adaptive clearing subsystem at session boundaries. Read this first at
> the start of any chat session. It is rewritten when state materially
> changes (see Document Maintenance Policy at the bottom), not append-only.
> For historical milestone records, see STATUS.md (sibling file). For
> research foundations, see docs/research/adaptive-clearing-landscape.md.
> The design-of-record is docs/research/adaptive-clearing-architecture.md —
> but see the CONFLICT FLAGS section: parts of it now lag the prototype.

---

## Working Discipline — read before anything else

> This is the most important section in the file. It captures *how* the
> chat-assistant (architect), the user (domain expert), and Claude Code (CC,
> the worker) work together effectively. A fresh session that has the technical
> state but not this discipline will predictably repeat a rough, low-effectiveness
> start. This was learned the hard way across a long prototype session; do not
> rediscover it by friction.

**The three roles, sharply separated:**

- **The user is a CNC/toolpath domain expert, NOT a programmer.** The user is the
  authority on what a toolpath *does* — cut quality, climb vs. conventional,
  engagement, motion, what a render actually shows. The user reads the renders and
  is the final judge of geometric and machining correctness.
- **The chat-assistant is the architect.** Owns all structure, code, git,
  doc-mechanics, thresholds, and context-routing decisions — makes a direct
  recommendation and the call, without escalating. Escalates ONLY genuine
  CNC/CAM-domain or strategic questions.
- **Claude Code (CC) is the worker** with repo access. Operates on planned scope,
  reports back. CC cannot see the rendered output; the user can. CC can see the
  code; the architect cannot. Pairing those two views is how problems get solved.

**The behavioral rule that turned a rough start into the most effective session yet
(the single most important thing):** The architect must **VERIFY BEFORE ASSERTING,
and DEFER in the user's domain rather than infer.** The session began rough because
the architect repeatedly substituted fast, confident inference where it should have
looked carefully or deferred — misreading an image, asserting geometry from a
glance, and once writing "validated in prototype" into a CC prompt for work that was
only proposed. These were all the same error: reaching into the user's domain (what
a render shows, what a path does) with structural-confidence that does not belong
there. Effectiveness jumped the moment this boundary was made explicit and enforced.
A fresh session WILL start in the fast-confident mode; this rule is the correction.

**Named anti-patterns — do not do these:**

- Do not override the user's stated conventions with your own visual impression.
- Do not assert a conclusion from a glance at a render — look carefully, or defer to
  the user, who can see it better than you can.
- Do not claim unvalidated work is validated. Say "proposed," "not yet tested,"
  "this run is the test of whether it's right."
- Do not deform or post-process extracted cut geometry to satisfy a constraint. This
  caused a real regression this session (a load-band rate-limiter that displaced arc
  points produced kinks at the wall). Geometry should be *emergent* from the field,
  not bent after the fact.

**The working loop that produces good results:**

Build (CC) → render in the debug viewer → **the user looks** → the user reports what
the motion actually does → the architect aims the next prompt at what was seen.
Reasoning is externalized into renders the user judges, rather than the architect
trying to be right about things it cannot see. When the user annotates a render
(arrows, labels, markup), that is the highest-bandwidth input in the whole loop —
treat it as authoritative and design directly against it.

**Hard rules (non-negotiable):**

- **Diagnose before building on any uncertain mechanism.** When a mechanism's
  correctness is in doubt, spend one cheap diagnostic prompt (CC reads/measures and
  reports, NO build) to pin it down before committing a build session to it. This
  repeatedly saved whole sessions — it caught a false-validation claim, a
  measurement-endpoint mismatch, and a metric that would have fired in the wrong
  place, all before any code was built on them.
- **Prototype-then-integrate, with a visual-review gate.** Never bundle "build +
  integrate + regenerate fixtures" for an unproven algorithm. Build the prototype,
  render it, the user reviews, THEN integrate. The visual-review gate is decisive,
  not a formality — it has caught defects that every numeric test passed.
- **Travel / loopback / rapid moves NEVER cross uncut stock. Ever.** Rapids transit
  only previously-cleared space. If a region is genuinely disconnected, the tool
  retracts, repositions over cleared space, and re-plunges. This is a hard
  machining-safety invariant, not a preference. An uneven boundary finish (e.g.
  arcs terminating at varying distances from the wall) is likewise a functional
  defect — it means uneven surface finish and dimensional inaccuracy — not a
  cosmetic one.
- **Isolate variables — one concern per prompt.** When something might fail in more
  than one way, scope the prompt so a failure points at a single cause. Bundling
  uncertain things together makes failures undiagnosable. (We split truncation from
  steering, steering from loopback, etc., for exactly this reason.)
- **Confirm parameters with numbers, twice, before trusting them.** Validated
  metrics were confirmed against measured data (e.g. "disc never fires / paisley
  fires at ring 9") before AND after building, so the build carried a regression
  rail.

**Context-routing is the architect's job, not the user's.** The user reports CC's
terminal context-bar reading; the architect decides reset-vs-continue and says which,
with reasoning. CC's self-reported context % is unreliable (observed off by ~20
points) — always defer to the user's terminal reading. Thresholds: ~70% → finish the
current commit and stop; 80% → hard ceiling, reset; reset before a heavy/meaty task
even at 60–69%. Don't reset an already-fresh session (reproduces cost for nothing).

---

## Request These First (highest-value inputs for a fast, accurate start)

A new session should request these at the top, before proposing any work — they get
us up to speed and making good decisions far faster than prose alone:

1. **The user's annotated commercial-reference toolpath images.** Highest-value
   input that exists for this work. The user generated frame-by-frame stills from a
   commercial CAM package and annotated them (propagation-front direction vs.
   cut-motion direction, the spiral→tail handoff, loopback travel moves, lead-in/out
   detail). Every correct design decision this session traced back to reading these.
   Prose cannot substitute. Ask the user to re-share the relevant shapes (comma/
   paisley, L-shape, barbell, square+island, loopback detail).
2. **A fresh render of the current prototype state in the debug viewer**, for
   whatever is being worked — so review is against what the code actually produces,
   not memory.
3. **The current STATUS.md and a `git log` of recent commits** (the mechanical state
   below may lag if this file wasn't refreshed at the last boundary).
4. **docs/CONVENTIONS.md** for the canonical working discipline, and the
   architecture doc for design-of-record — BUT read the CONFLICT FLAGS below first.

---

## Strategic context — where the morph prototype is headed

> RETIRED / GRAVEYARD (same status as the banner in the sibling STATUS.md): the
> morph-spiral/morph-ring engine described in this section was RETIRED. The live
> adaptive-clearing engine is the FreeCAD Adaptive2d TS port in engine/
> ([[project_ac_freecad_port]]); current perf state lives in
> docs/planning/AC-PERF-HANDOFF.md. Do NOT steer AC work by this section.

> Recorded because a fresh-session recon found this was never written down, and its
> absence let the prototype be built without a clear relationship to the rest of the
> CAM operations. This is the strategic intent; integration itself is future work,
> gated on continued successful prototype testing — NOT on the docket now.

**The morph-spiral adaptive clearing is the intended REPLACEMENT for the prior
adaptive-clearing backend.** It is not an augmentation of the old engine and not a
parallel experiment. The old engine (the M0–M7 planner state machine with the
CENTROID / FRONTIER_TANGENT relocation core) was tested, did not meet quality, and
its coverage findings (the five named gaps — APPROACHING fragmentation, forward-run
exhaustion, excessive-initial-engagement, plunge-disk-not-cleared, component-visit
region-jumping) are **moot for the forward path**: they are defects of the relocation
core being replaced, not a worklist. Do not spend effort fixing them.

**Verified status of the old engine (from wiring, not prose):** the old AC engine
code is still present and its worker handler (`COMPUTE_ADAPTIVE_CLEARING` in
`toolpathWorker.ts`) is live — but **the store never routes to it.** The store
dispatch sends pocket→COMPUTE_POCKET, drill→COMPUTE_DRILL, chamfer→COMPUTE_CHAMFER,
and everything else — *including `adaptive_clearing_2d`* — falls through to
`COMPUTE_CONTOUR`. So in the UI today, an adaptive-clearing operation is silently
processed as a **contour** op; the AC engine never runs. It is live code nobody
routes to, not deleted or stubbed.

**Integration target (future, gated on testing):** when the morph approach matures
under visual review, integration means routing `adaptive_clearing_2d` in the store
dispatch to the new morph backend (closing the fall-through-to-contour gap), and
doing so **as a conforming member of the shared 2D-toolpath-operation framework** —
consuming the factored-out shared subsystems rather than carrying redundant
per-operation code. The shared subsystems (verified paths) the morph backend should
consume on integration: `src/lib/cam/heights.ts` (5-plane → absolute-Z resolution),
`src/lib/cam/feedrates.ts` (two-tier feed resolution), `src/lib/cam/geometry/`
(offset, winding, point-in-poly, distance-to-boundary, `sampleArc`, loop utilities),
`src/lib/cam/moves/` (move-construction helpers), and the worker protocol
(`WorkerRequestMsg`/`WorkerResponseMsg`, `ToolpathMove`, `MoveRole`). The
shared-subsystem factoring is not captured in a single ADR — it is implicit in the
codebase structure; ADR-0001 (toolpath/postprocessor + worker-protocol separation)
and ADR-0004 (two-tier feedrate resolver as a shared subsystem) are the nearest
recorded decisions. The factoring principle itself (pull common capability into one
shared, best-of-breed subsystem so no operation carries redundant code that drifts
or goes stale) is the standing reason the morph backend integrates *into* the
framework rather than as an island.

**Sequence:** keep advancing and validating the prototype in `morphProto/` under
visual review (loopback layer next — see Recommended next steps). Integration is the
eventual destination, recorded so it is never re-derived, but it is not current work.

---

## CONFLICT FLAGS — guiding docs that now lag the prototype

> RETIRED / GRAVEYARD: these flags compare docs against the RETIRED morph
> prototype. Moot for the live FreeCAD-port engine
> ([[project_ac_freecad_port]]). History only.

> The prototype built this session empirically discovered things that the
> design-of-record documents predate. Treat these specific points in those docs as
> SUPERSEDED-PENDING-RECONCILIATION until the docs are updated (a queued housekeeping
> task). Do not follow the stale guidance over the prototype reality.

1. **Region split rule — architecture §3 / §5 is INCOMPLETE.** The architecture doc
   states a region split is "governed by topology, not constriction" — that necks and
   reflex corners do NOT split, and only genuinely disconnected pocket areas form
   separate regions. The prototype found a **second, validated split trigger the doc
   does not describe: spiral-truncation.** A *connected* region (the paisley's curving
   tail) gets truncated and handed to arc-march when the spiral can no longer continue
   productively (its retrace through cleared space exceeds a direct loopback). Both
   triggers now exist and compose via min(connectivity-split-level, truncation-level).
   The doc's "only disconnected areas split" is too narrow. (Also: the doc claimed the
   paisley/comma is purely simply-connected; CC found it ALSO produces connectivity
   splits at higher levels — the earlier "0 splits" characterization was wrong.)
2. **Morph construction — architecture §6 Q1 names the wrong concrete method.** The
   doc settles the morph as the offset-contour / Connected-Fermat-Spiral construction
   (Clipper polygon-offset, Zhao 2016), mentioning fast-marching only parenthetically.
   The prototype is built on **geodesic distance field via fast marching (eikonal,
   Godunov upwind), with isocontours as rings** — NOT Clipper offsetting, NOT Fermat.
   The spiral is **Archimedean (outward-expanding), with Fermat held only as a
   fallback.** The family is related, but a new session following the doc's
   "offset-contour/CFS" wording would build the wrong thing. Trust the prototype.
   **UPDATE 2026-05-27 — this flag has largely INVERTED.** The ring substrate is now
   **chained-offset polylines** (each ring = prior ring offset by one stepover, real
   geometry), which is the offset-contour family the architecture doc named. The FMM
   field is retained ONLY as the region/occupancy oracle, not as the path. So the doc's
   "offset-contour" wording is now closer to reality than the prior "trust the FMM
   isocontour prototype" guidance. The spiral remains Archimedean. Net: the construction
   converged toward the doc; this flag is a candidate for full reconciliation/closure.
3. **"Nothing built — design the representation next" — STALE in BOTH the
   architecture doc (§7) and the old STATUS/HANDOFF framing.** They say the next step
   is to design the contour data representation in the abstract with nothing built.
   That is overtaken by events: a working prototype exists in
   src/lib/cam/adaptiveClearing2d/morphProto/ and the representation has been
   developed empirically. Do not go "design the representation from scratch."

These three are queued for reconciliation back into the architecture doc and STATUS.md
(see Recommended Next Steps and Document Maintenance Policy).

4. **Marching-squares isocontours as path representation — SUPERSEDED by ADR-0012 (Accepted 2026-05-24).** The prototype's construction represents ring paths as marching-squares cell-boundary polylines and ring-march arcs as row/column grid-scan polylines. ADR-0012 declares the grid as occupancy-oracle-only and requires all path geometry to be real geometry (boundary offsets, true curves, intersection-computed endpoints). The FMM field is preserved as the solver/oracle; the PATH SUBSTRATE changes. Any doc text implying the marching-squares polylines ARE the ring paths is superseded. References to "isocontours as rings" mean "isocontours locate where rings should be," not "isocontours are the path representation." ADR-0012 is the recorded architectural decision (`docs/decisions/0012-grid-as-oracle-real-geometry-paths.md`); the re-architecture plan is in REAL_GEOMETRY_PLAN.md (sibling to this file, pending approval). **UPDATE 2026-05-27 — ADR-0012 is now IMPLEMENTED, not just decided.** The marching-squares ring/arc polylines have been retired (79943ec) and replaced by chained-offset real-geometry rings with intersection-computed wall endpoints. The grid/FMM is now oracle-only in practice, as the ADR required. The flag stays listed as the record of the substrate change, but the "superseded-pending-reconciliation" status is satisfied for the path substrate.

5. **Region split detection rule — architecture doc §3/§5 partially superseded by ADR-0013 (Accepted 2026-05-25).** The architecture doc states that splits are topology-based and that "only genuinely disconnected pocket areas form separate regions." ADR-0013 replaces the BFS COUNTING/IDENTITY mechanism with a recursive real-geometry rule: splits are detected by WALL-FOLLOW EVENTS on real boundary segments, deduped by segment identity (polyIdx, segIdx pairs). The rule is RECURSIVE — both the spiral and each ring-march apply the same disjoint-segment wall-follow counting, seeding new ring-marches when fully-disjoint contacts fire. The FMM oracle is preserved for split LEVEL detection and region SEEDING (findIsolatedRegions). The architecture doc's conceptual statement that "topology governs splits" is DIRECTIONALLY correct but incomplete (it omits truncation as a trigger and the recursive ring-march mechanism). Full reconciliation of the architecture doc §3/§5 is a queued housekeeping task for the implementation session. ADR-0013 is the authoritative record of the decided rule (`docs/decisions/0013-recursive-real-geometry-split-detection.md`).

---

## Mechanical state (CC-derived)

### Branch and recent commits

- **Branch:** adaptive-clearing-v1
- **HEAD:** 1866965 (test(occt-linking): vitest acceptance for transition 5→6 — confirmed
  via `git log` at handoff update 2026-05-29).
- **OCCT linking arc since 79943ec (newest first):** vitest acceptance for transition 5→6
  (1866965) → self-contained 5→6 fixture (897bef7) → `lineCurve` via 2-point
  interpolation (fe08845) → sandbox_22 selectors + `buildTransition` (e41420f) → reusable
  curve query primitives for the linking layer (9a7e310) → reusable OCCT geometry wrapper
  + WASM smoke test (d64ee09) → ADR-0014 adopt OCCT kernel (74f9d31) → vendor pinned
  custom opencascade.js WASM build (490fd5a). Phase 2 milestone in STATUS.md.
- **Prior chained-offset arc (newest first):** retire all superseded ring-generation paths
  (79943ec; −1553/+154 lines; chained-offset polylines byte-identical pre/post;
  minSagitta telemetry now surfaces in fixtures) → remove dead mask-aware ray-trim
  helpers (99deb74) → sagitta convexity correction for chained-offset rings (adecc23;
  target ratio 0.03, gain 3.0) → arc-continuation + long-tangent wall extrapolation,
  sandbox v10 (015cfbc; 272/272 ring endpoints on real walls, wallGap=0,
  wallTangentRisk=0 across all fixtures) → endpoint extrapolation + multi-bias steering
  driver for chained-offset rings (9c753c2).
- **Earlier (prior sessions, in the gap since the last HANDOFF refresh at 967130f):**
  the entire chained-offset migration landed across ~25 commits — real-geometry rings
  (820ecb0), clamped cubic spline (0b09e7f), V2 analytic seed (f6f5594), chained-offset
  ring-march port (aebba5a), boundary-offset seed for disconnected regions (f14e874),
  mask-aware then polyline-intersection wall trim (7b3caea, f65cee8), chained-offset
  across all fixtures + scrubber/stamp coupling (a0f0fdd), plus the `ac-trace` doc series
  (09bf19b…c5f31bf). STATUS.md carries the milestone record; the M0–M5 engine milestones
  predate the prototype entirely.

### Working tree

- Clean except known noise: .claude/settings.local.json,
  Erics Tools and Machines/, Sample Parts/. (Context Examples/ was archived and
  removed in cleanup chunk 3a; the FreeCAD Adaptive2d port reference now lives at
  docs/reference/FreeCAD_Mod_Adaptive_Path-master/.)
- **WARNING — never use `git checkout -- .` or any bulk revert.** It destroyed an
  uncommitted fixture once this session. Stage and revert by explicit path only;
  never `git add -A` / `git add .`.

### Active milestone

- **Milestone:** Adaptive-clearing MORPH PROTOTYPE (in morphProto/), under
  iterative visual review. NOT yet integrated into the live operation path.
- **CONSTRUCTION HAS CHANGED — chained-offset is now the sole ring-generation path.**
  The marching-squares / FMM-isocontour path substrate (the basis of the prior
  HANDOFF's "rings are isocontours" description) has been RETIRED (79943ec retired
  FMM extraction, Stage A, V2, spline, and FMM seed-propagation). This executes
  ADR-0012 (grid/FMM as oracle, real geometry for paths). The FMM field survives only
  as the **occupancy/region oracle.** Read the next bullet, not the old isocontour
  framing, for what the code actually does now.
- **Current pipeline (HEAD 79943ec):**
  `region detection (FMM oracle) → seed (next-revolution OR boundary-offset for
  disconnected regions) → chained offset with steering + sagitta correction →
  polyline-intersection wall clip → arc-continuation wall extrapolation → resample.`
  Each ring is the previous ring offset by one stepover as REAL polyline geometry; the
  multi-bias steering driver aims the offset, sagitta correction holds convexity, the
  ring is clipped against real boundary segments by polyline intersection, and endpoints
  are extrapolated onto the wall by arc-continuation / long-tangent.
- **Validated this session (numbers, tsc, and the wall contract):**
  - **Endpoint–wall contract is exact.** 272/272 ring endpoints land on real walls;
    `wallGap = 0` and `wallTangentRisk = 0` across ALL fixtures (015cfbc, arc-continuation
    + long-tangent wall extrapolation, sandbox v10). This directly attacks the old
    arc-to-wall termination quality gate — the variance the trim/extend layer was meant
    to fix is now near-eliminated at ring-generation time.
  - **Sagitta convexity correction** (adecc23; target ratio 0.03, gain 3.0). The Paisley
    tail holds ~0.03 bow instead of collapsing to flat; the endpoint–wall contract above
    is preserved through the correction (geometry stays emergent, not bent after the fact).
  - **Multi-bias steering driver** (9c753c2) aims the chained offset; endpoint
    extrapolation seeds the wall contact. This is the in-construction successor to the
    DEFERRED post-hoc "alley steering" — it shapes the offset as it is generated rather
    than deforming extracted arc points (the lesson from the reverted load-band attempt).
  - **Handedness still single-sourced from spiral winding.** CW/CCW = climb/conventional
    derives from the spiral; a future climb toggle = flip the spiral, rings follow.
  - **Region-split detection — TWO composed triggers (unchanged).** (1) connectivity-split
    (stock breaks into disconnected components — `detectSplitsByStockConnectivity`);
    (2) spiral-truncation (connected stock, spiral can't continue productively). Composed
    via min(level). Spiral-truncation metric is the retrace-arc rule (validated twice on
    numbers): per ring, the dominant *consolidated* retrace gap's arc/chord > M; truncate
    at the first firing ring. Parameters: AC_TRUNCATE_MARGIN = 2.0 (robust noise gate;
    any 1.5–5 gives the same result), AC_TRUNCATE_MERGE_STEPOVERS = 5 (the one
    geometry-tuned knob). Self-check: paisley truncates at ring 9 / L=32mm; disc never.
  - **Debug viewer** (debug-viewer-adaptive/morph-viewer.html, served via
    `python -m http.server 8000`): fixture buttons (L-shape, Barbell, Sq+Island, Disc,
    Paisley), layer toggles, and a scrubber (drag handle + play/pause + speed) that
    animates the spiral OR the ring-march, with viewer stamp coupling (a0f0fdd).

### Latest test/coverage state

- **tsc clean; 138 passed / 6 skipped at HEAD 79943ec.** The chained-offset polylines
  are byte-identical pre/post the 79943ec dead-code retirement (verified), and the
  minSagitta telemetry now surfaces in the emitted fixtures. Confirm with a fresh
  `vitest run` at session start if any algorithm change is contemplated. The older
  M0–M5 fixture suite is the pre-prototype engine; unchanged by prototype work.

---

## Steering — DEFERRED, and what was learned (so it isn't repeated)

Real ring-march steering (making arcs follow a curving alley by aligning the
midpoint-advance vector with the alley walls ahead, look-ahead ~3 stations) was
attempted and **reverted.** Two lessons, both load-bearing for the next attempt:

1. **Steering is a HIGH-CURVATURE feature, not a general one.** Gradual alleys (the
   paisley) are handled well by the raw entry-seeded field-scan arcs — steering added
   little there. Steering only earns its keep on ABRUPT direction change. The right
   stress fixtures are: the front looping behind the circular island (Sq+Island), and
   a U-shaped alley with ~180° of total turn. The paisley was too gentle to either
   need or properly stress steering; it stresses TRUNCATION (which it validated).
2. **The load-band rate-limit must NOT deform extracted arc geometry.** The reverted
   attempt clamped interior arc points while leaving endpoints fixed, producing kinks
   at the wall — appreciably worse than the smooth pre-steering arcs. When rebuilt,
   the load band must govern arc *advance/placement*, or drive *re-extraction from a
   steering-conditioned field* — never post-hoc point surgery on cut arcs (same
   "emergent, not bent" principle that governs the morph).
   Parameters carried for the rebuild: ALLEY_STEER_LOOKAHEAD = 3 (tunable; abrupt
   turns may need more), MORPH_LOAD_TOLERANCE_FRAC = 0.10 (placeholder, destined to
   be a material-driven user parameter — wood tolerates more variance than steel;
   geometric proxy acceptable until real engagement is computable).

---

## Open items to carry forward (watch these; provisional until validated broadly)

1. **Merge-distance (5x stepover) generalization.** Tuned to the paisley's
   retrace-wobble scale. Watch across ALL fixtures: false-fire (merge too aggressive,
   fuses real cuts into false retrace) or masked-signal (too tight). May need to adapt
   to geometry. The M=2.0 gate is robust; the merge distance is the one real knob.
2. **Wobble → smoothing / resolution.** The retrace "wobble" the merge bridges is the
   deferred grid-faceting/jitter. If it destabilizes the truncation trigger, path
   smoothing or higher grid resolution becomes non-optional (a second reason beyond
   cosmetics). Final parameter values can't be known until path generation is clean.
3. **Arc-to-wall termination — QUALITY GATE.** Arc ends terminate at uneven distances
   from the wall (paisley std ≈ 0.313mm vs. straight-arm baseline ≈ 0.094mm — measured).
   User's assessment (from prior AC experience): resolution-driven. Likely resolved by
   the future trim/extend + lead-in/out layer that places arc ends against the wall
   with tangency and wall-follow overlap. This is a HARD quality gate, not cosmetic —
   uneven boundary = uneven surface finish + dimensional inaccuracy = failure. Std
   0.313mm is the baseline the trim/extend layer must beat. Confirmed NOT steering-
   caused (steering ran and the variance persisted).
4. **Zero-arc regions.** On the paisley, several detected regions produced 0 arcs;
   confirmed benign there (degenerate slivers absorbed, tail fully covered, no bare
   patches). Watch that zero-arc regions never leave actual uncut gaps on other shapes.
5. **Cosmetic telemetry-label delta from the 79943ec cleanup (NOT a bug).** Two
   zero-ring regions (L-shape m1/m2 r0) now report termination reason `'no-source'`
   instead of the retired `'first-arc-cleared'`. These are regions that emit no
   toolpath, so the label is cosmetic — recorded so the next session doesn't chase it
   as a regression. Clean up the reason string opportunistically if it confuses a
   reader; no functional impact.

---

## Recommended next steps (in order)

> RETIRED / GRAVEYARD: these "next steps" belong to the retired morph-ring/OCCT
> loopback line. Nothing here is a live work item. The live engine is the
> FreeCAD Adaptive2d TS port ([[project_ac_freecad_port]]); live AC status =
> docs/planning/AC-PERF-HANDOFF.md. History only.

> **STATE AS OF 2026-05-27 — read this before the numbered items below, several of
> which were written before the chained-offset migration and are now overtaken.**
> The real-geometry substrate re-architecture (§2 below, ADR-0012 / REAL_GEOMETRY_PLAN)
> is **DONE**: chained-offset ring-march is the sole ring-generation path, and the
> endpoint–wall contract is exact (272/272 on real walls, wallGap=0). The marching-squares
> path substrate is retired. **The active next phase is the lead-in/lead-out + loopback
> layer (§3 below) — its detailed behavioral spec is still correct and still the target.**
> A design note **"Toolpath Element Convention"** (element numbering, directionality,
> milling modes, cleared-region termination) is now in project knowledge
> (`toolpath_element_convention.md`) as the foundation for that work — **read it first.**
> The loopback/travel system was then designed in detail in the session of 2026-05-28;
> that full model is captured in the new subsection **"§3a — Loopback / travel design
> model (developed 2026-05-28)"** below. Read §3a together with the convention note before
> proposing any loopback build — the two together are the complete foundation, and they
> were developed precisely so the loopback chat does not re-derive them by friction.
>
> **CONSTRUCTION METHOD (2026-05-29): the tangent geometry of this layer — lead-in/out
> arcs, fillets, the wall-follow↔fillet↔loopback chain — is to be built on the OCCT
> geometry kernel, per the strategic decision in the freshness header.** §3a and §3 below
> remain the authoritative *requirements*; `HANDOFF-OCCT-MIGRATION.md` is the authoritative
> *method and next-session plan*. The prior hand-rolled tangent construction failed by
> exactly the tangency-inversion mechanism `toolpath_element_convention.md` predicts
> (direction inferred from geometric proximity rather than read from a canonical order) —
> the OCCT approach builds the chain as connected curves carrying canonical orientation, so
> tangency/orientation are properties of the construction, not of post-hoc stitching. Do
> NOT resume the loopback layer by hand-rolling tangent math; start from the OCCT migration
> handoff.
> Two open prerequisites gate the loopback layer:
> - **Multi-loop analytic spiral for Square+Island** — the island topology produces
>   multi-loop rings whose angular ordering is undefined; the analytic spiral must handle
>   multiple loops before Square+Island can be sequenced. (Tracked in the prototype section
>   as the blocked Square+Island item.)
> - **Cross-region cutting-order policy — a DOMAIN decision (escalate to the user, do not
>   infer).** With multiple regions, the order in which they are cut (and how the tool
>   transits between them, all through cleared space) is a machining-strategy choice, not a
>   structural one. Surface it as an open question for the user before building loopback
>   across regions.

1. **ADR-0013 recorded (complete as of 2026-05-25); BUILD STATUS must be re-confirmed
   against the chained-offset rewrite.** The recursive real-geometry split-detection rule
   is decided and documented, and the TWO composed split triggers are present in the
   current code (see "Current prototype capabilities" above). But the §1 *build scope*
   below was written for the pre-chained-offset spiral/arc-march; the substrate has since
   been rewritten. Re-confirm what is actually wired (disjoint-segment dedup, recursive
   ring-march, P1 exact-seal) against the chained-offset ring-march before treating any of
   it as outstanding OR done. The recursive real-geometry
   split detection rule is decided and durably documented. The rule: split detection
   uses real spiral/ring-march path contacts with real boundary segments, deduped by
   segment identity (polyIdx, segIdx); fully-disjoint contacts (after the initial
   contact in each fill) split off new regions; BOTH the spiral AND each ring-march
   apply this rule recursively; the FMM oracle is preserved for split level and
   seeding. Read-only confirmation: L-shape = 3 real regions (spiral: 1→2 at seg 3;
   ring-march: 2→3 at seg 4), Barbell = 2 real regions (spiral: 1→2 at neck;
   ring-march: sliding arc contacts share segments → 0 additional splits), Paisley =
   2 principal regions (body + tail; inner-arm disjoint timing requires build-phase
   tracing). Conflict flag 5 added. Commit: see STATUS.md milestone for this session.

   **NEXT session (fresh build): implement ADR-0013 for the spiral and ring-march.**
   Exact build scope:
   - Implement disjoint-segment dedup in the spiral wall-follow detector (extend
     FIX-2's `clamped && !prevClamped` tracking in `analyticSpiral.ts` with a
     segment-set accumulator).
   - Implement the RECURSIVE ring-march: each ring-march phase tracks its own
     wall-follow segment sets and seeds new ring-marches on new disjoint contacts.
   - P1 fix: P1 = the boundary point at the first disjoint-contact seal (currently
     bridge-cell approximation; should be the exact wall-contact point from the
     disjoint follow).
   - ~~Final cleanup: rename "arc march" → "ring march" throughout; purge dead code~~
     **DONE (2026-05-26):** rename complete, reMorph.ts dead morph path purged,
     viewer now exposes all 5 shapes (incl. Square+Island and Disc).
   - STOP for visual review on L-shape, Barbell, Paisley before integrating further.

2. **Real-geometry re-architecture (ADR-0012 / REAL_GEOMETRY_PLAN) — DONE (2026-05-27).**
   The marching-squares-as-path substrate has been replaced with real geometry: rings are
   chained-offset polylines, endpoints are extrapolated onto real walls (wallGap=0,
   272/272 contacts), and the FMM grid is demoted to occupancy/region oracle as the ADR
   required. The staged conversion the plan specified (real rings → real arcs → re-validate
   truncation → spiral-blend) is subsumed by the chained-offset ring-march. No further
   substrate work is gating; the path-quality layers (§3) can now build on real geometry.
3. **The loopback + lead-in/out + trim/extend layer (next building step, after §2).** Connect
   the truncated arc segments (and, between spiral rings, the spiral's own ring
   transitions) into a continuous, machinable path. This is a NET-NEW layer built for
   the morph's arc-march/spiral geometry — it is NOT inherited from the old engine's
   linker (that engine failed; its linking assumptions are not precedent). Reusable
   shared *primitives* exist and should be consumed where they fit, but the
   *behavior* below is defined by what the morph spiral needs, not by how the old
   operations did it.

   **Hard behavioral requirements (these define "done well" for this layer):**
   - **Travel stays down by default.** Between cuts, the tool should remain at cutting
     depth and feed through *already-cleared* space wherever a cleared path exists.
     Lifting/repositioning (retract → rapid → re-plunge) is the LAST resort, used only
     when no stay-down cleared path exists (e.g. a genuinely disconnected region).
     Prefer stay-down; lift only if there is no other option.
   - **Travel NEVER crosses uncut stock (hard safety invariant).** Rapids and stay-down
     travel transit only previously-cleared material; the swept tool footprint during
     any travel move must lie entirely in cleared space. The layer must be
     cleared-vs-uncut aware and route around uncut stock — never plan a straight hop
     that crosses it. (The old `pathIsSafe` clearance-check in pocket2d is the *pattern*
     for "does this travel cross uncut stock?" — reuse the idea, built against the
     morph's stock-state field.)
   - **Resolution floor on cleared corridors (safety floor, not a comfort knob).**
     Stay-down travel must not trust a cleared corridor that exists only at the grid's
     margin of resolution. A corridor the field reports as cleared by only a cell or
     two may not be reliably cleared in reality — discretization error can hide uncut
     material at that scale. Requirement: stay-down travel must route through cleared
     space with enough margin that grid-discretization error cannot put uncut stock in
     the tool's path; where the only cleared corridor is at or near the grid's
     resolution limit, treat it as untrustworthy and lift rather than thread it. Do not
     pin a number — the morph's cell size (0.625mm currently) and the eventual real
     resolution set it; state that the floor exists and is resolution-driven, so the
     layer respects it from the start rather than discovering tool-into-uncut-stock the
     hard way. (Distinct from, and on top of, the binary invariant above.)
   - **Comfort margin beyond the resolution floor — DEFERRED to visual tuning.** How
     much *extra* cleared room beyond the resolution floor should bias toward lifting
     rather than threading a tight-but-trustworthy corridor is a quality/comfort knob,
     not a safety floor. It is deferred: we have not yet seen the morph produce a single
     travel move, so a number now would be guessing ahead of evidence. Tune it against
     the render once the layer produces visible travel moves. (Recorded so it is not
     mistaken for forgotten.)
   - **Lead-in directionality: enter FROM cleared material into the cut.** A lead-in
     begins in already-cleared space and brings the tool into contact with uncut
     material. It must **engage the uncut material gracefully** — ramping/arcing into
     the cut so engagement builds progressively rather than slamming to full width
     (no load spike at entry). Use the cleared-vs-uncut-aware stock state to place the
     lead-in so its approach runs through cleared space and only meets uncut stock at
     the intended engagement point.
   - **Lead-out directionality: exit INTO cleared material.** A lead-out carries the
     tool off the cut and terminates in already-cleared space (so the subsequent
     stay-down travel/loopback starts safely in cleared territory). It must
     **disengage gracefully** — easing engagement down rather than dropping off a
     full-width cut abruptly. (`lead_out` is declared in the MoveRole vocabulary
     (`src/types/index.ts`) but emitted by no code — verified; this layer is its first
     emitter. The viewport is already pre-wired to render `lead_out` with color/dashing,
     so emitted lead-outs render correctly without viewer work. `loop_back` is likewise
     declared-but-unemitted — verified, including that M7 linking uses
     wall_follow/rapid/plunge, never loop_back — so this layer is its first emitter too.)
   - **Arc-to-wall termination (the quality gate).** The arc ends must meet the wall
     cleanly with tangency and wall-follow overlap, producing an even boundary — this
     is where the measured wall-gap variance (paisley std ≈ 0.313mm vs. straight-arm
     baseline ≈ 0.094mm) gets resolved. Uneven boundary = uneven surface finish +
     dimensional inaccuracy = failure. The trim/extend operation places arc endpoints
     against the wall deliberately, rather than leaving them where the field-scan
     happened to stop. Std 0.313mm is the baseline this layer must beat.
   - **Geometry stays emergent.** Per discipline pattern J: shape lead-ins/outs and
     trims by constructing them correctly (tangent arcs off the spiral/arc endpoints,
     built from the field/geometry), not by deforming already-extracted points.

   ---

   ### §3a — Loopback / travel design model (developed 2026-05-28)

   > This is the detailed architecture worked out in conversation before any build.
   > It is DESIGN, not yet implemented or sandbox-validated. Read it WITH the
   > `toolpath_element_convention.md` note (numbering, directionality, milling modes).
   > Treat the formulas/relationships as load-bearing understanding to design against,
   > not as fixed constants to hard-code — sandbox-validate before committing, same as
   > every prior geometry layer. Nothing here has been rendered yet; the first build
   > should be a prototype under the visual-review gate.

   **The unified transition primitive (one solution for all element-to-element joins).**
   The connection from any element's exit to the next element's entry — spiral→first-ring
   AND ring→ring — is ONE primitive, agnostic to which elements it joins. The design intent
   is explicitly to avoid two code paths for "similar problems" (the user's stated goal). The
   primitive takes (exit node + exit tangent + exit element's cleared context) and (entry node
   + entry tangent + entry element's cleared context) and produces:

   `lead-out → wall-follow → fillet → rapid loopback → fillet → wall-follow-entry → lead-in`

   Each piece, and the controls on it:

   1. **Lead-out** — radiused arc, **tangent from the cutting arc to the wall.** TIGHTLY
      constrained: it is still finishing engagement, so its radius is set by tool + cut, a
      true tangent radius from cut-arc to wall. (Mirror on entry: **lead-in**, tangent from
      the wall into the next ring's cutting arc, equally tightly constrained.)

   2. **Wall-follow** — rides the boundary. **Dual purpose, both load-bearing:**
      (a) *backtrack into cleared stock* so the subsequent rapid transit happens in
      previously-cut material (safety); (b) *cleanup* — because the tool is a radius, the
      lead-out arc and the previous arc's curvature leave small uncut cusps/cuffing along the
      wall; the wall-follow scrubs them out. It is a CUTTING move, not mere reposition.

   3. **Fillet (exit)** — tangent arc from the wall-follow into the rapid. LOOSELY
      constrained (not cutting here) — its job is only to avoid jerking the tool into the
      rapid. BUT it is **bounded above**: too large a fillet departs the wall *early*, eating
      into the cleanup zone. (Mirror on entry: the **entry fillet** out of the rapid into the
      wall-follow-entry; too large joins the wall *late*, same failure reversed.)

   4. **Rapid loopback** — the transit between elements. Collision concern:
      *negligible arc-to-arc* (exit and entry are close, both in cleared stock); *real
      region-to-region* — a straight rapid may cross an island (a real wall = collision) or
      uncut stock. Cross-region rapids must be collision-checked and routed/avoided. This is
      where the cleared-region knowledge (sequence-numbered elements ≤ N−2 + real island
      geometry) governs what is safe to cross.

   **The central computed quantity — WALL-FOLLOW LENGTH.** It is not free. It must satisfy:
   `wall_follow_length ≥ (cleanup distance for the lead-out cusp + previous-arc curvature
   leftover) + (wall distance the fillet consumes by departing the wall early)`.
   If the fillet-into-rapid is too large it departs early and breaks cleanup, so **fillet
   radius and wall-follow length trade against each other, both bounded by the cleanup
   requirement.** Confirm two ways (belt-and-suspenders, the session's standing pattern):
   (1) **formula** — derive the required length from lead-out radius, tool radius, previous-arc
   curvature, and fillet radius; (2) **grid stamp** — stamp the swept cutter and verify the
   wall region is fully cleared (no uncut slivers). Formula proposes, stamp confirms. The
   cleanup tolerance (how small a leftover sliver counts as "clean," e.g. a fraction of
   stepover) is an open value to set against the grid resolution.

   **Computation ordering — TRAJECTORY-FIRST (this is the key structural decision).**
   Do NOT build the arcs/fillets first and then try to thread a rapid between them — that
   makes the rapid an over-constrained multi-tangency fit (both ends already pinned). Instead:

   1. Ring exit/entry nodes + tangents — fixed (canonical, on-wall, from the convention).
   2. Lead-out / lead-in arcs — fixed off the cutting arcs (anchored at the RING end,
      independent of the loopback trajectory).
   3. **Loopback trajectory** — computed next, between the lead-out's wall-arrival zone and
      the lead-in's wall-departure zone, with collision/routing (esp. cross-region islands).
   4. Wall-follow lengths — derived from cleanup requirement + where the fillets will sit.
   5. Fillets (exit + entry) — LAST, loose, flexing to tangentially join the now-known
      wall-follows to the now-known trajectory.
   Each step depends only on already-fixed quantities; only the loose fillets touch the
   trajectory, and they can flex to meet it. This decomposes the coupled multi-tangency solve
   into independent one-sided fits — the reason trajectory-first is correct.

   **THE SPIRAL-START SPECIAL CASE (the one genuine exception — design carefully).** The
   spiral-end → first-ring transition is the hardest because the only cleared material that
   exists at that moment is the spiral's own. It does NOT have a reliable wall to follow on
   the exit side the way ring-to-ring does. But it has something nothing else has: the
   **spiral center is guaranteed clear.** So at the spiral start ONLY, the exit-side
   wall-follow is replaced by a **center-seeking move**: lead-out off the spiral (still the
   shared tangent lead-out), then head toward the spiral center (the safe direction), going
   **only as far as required until a collision-free path to the first region's ring entry
   exists.** Stopping rule: at each step toward center, test reachability (the SAME collision/
   cleared-stock check the general rapid uses) to the first entry node; halt at the first point
   where a clean transit exists, minimizing the center-seek distance. The ENTRY side is the
   general primitive again (fillet → transit → wall-follow-entry if present → lead-in). So the
   special case is minimal: only the exit-side wall-follow → center-seek substitution differs;
   lead-out, fillets, rapid, and the entire entry side are shared. This is also the
   tightest-cleared-context transition (least cleared material), which is exactly why it uses
   the most-guaranteed-clear thing available (the center).

   **Robustness requirements that make the unification hold** (the primitive must handle these
   so spiral-start is "just the first call" plus the center-seek substitution): variable entry
   curvature (do not assume ring-grade convexity at the spiral terminus); possibly-missing wall
   on one side (graceful wall-follow skip rather than assuming a wall is always present);
   tightest-cleared-context (smallest safe-transit room, at the very first transition).

   **MOVE TYPES ARE A POSTPROCESSOR CONTRACT (carry this from the start).** Every segment the
   layer emits (cutting arc, lead-in, lead-out, wall-follow, fillet, rapid loopback,
   center-seek) carries a move-type tag the postprocessor consumes to emit correct gcode —
   feed vs rapid, feed rate per move type, spindle/speed, path resolution/tolerance per move
   type. The loopback work must emit the EXISTING move-type vocabulary (MoveRole in
   `src/types/index.ts` — `lead_in`/`lead_out`/`loop_back`/`wall_follow`/`rapid`/`plunge`;
   this layer is the first emitter of `lead_out` and `loop_back`), NOT invent ad-hoc types,
   so the eventual postprocessor handles them correctly. Pull the existing move-type taxonomy
   from the other operations' docs/code at the START of the loopback work, before designing
   move generation — reconcile with the postprocessor conventions, not just the geometry.

   **PRE-FLIGHT SEQUENCING — a LATER layer, but the idea recorded now.** The order in which
   regions (and possibly sub-regions) are cleared changes total rapid-routing/collision cost,
   because cleared material is free to cross and natural exit/entry adjacency changes. A
   pre-flight calculation can choose a clearing order that minimizes rerouting (e.g. the
   L-section: clearing one leg, then the corner, then the other leg avoids a reroute around
   the inside corner). Structure when built: enumerate clearing units → build a
   collision-aware, state-dependent transition-cost model between units (A→B is cheaper if
   the path between is already cleared) → search for a low-cost order (start GREEDY +
   short lookahead; real parts have few units; escalate only if measured cases leave value on
   the table). **Two cautions:** (1) it DEPENDS on the cross-region collision/transition-cost
   primitive, so it cannot precede the within-region and cross-region loopback work — it sits
   ON TOP, as the third layer (within-region loopback → cross-region transitions → pre-flight
   sequencing). (2) The deeper idea it surfaces is **sub-region DECOMPOSITION, not just region
   ordering**: the L-section win requires treating one connected region as leg/corner/leg
   units and ordering THOSE — region-ordering alone would not help (the L is one region). The
   clearing unit may be finer than a detected region, and the decomposition is chosen to
   optimize sequencing. Cross-region cutting order remains a DOMAIN decision (escalate to the
   user): routing-around-obstacles vs reordering-to-avoid-them is the open question.

   ---

   **Reusable shared primitives (consume these; do NOT reinvent):**
   - `sampleArc` (`geometry/index.ts`) — the shared arc-point generator; use/extend it
     for tangent-arc lead-in/out and loopback construction.
   - `moves/index.ts` helpers (`plungeTo` accepts a caller-specified role, so it can
     emit `lead_in`/`lead_out`; `retractFrom` for the last-resort lift; etc.).
   - The `emitBezierLeadin` pattern in `pocket2d.ts` (tangent-matched quintic-Bézier
     transition between rings) is a working *model* for graceful tangent transitions —
     learn from the pattern; it is not shared and its specifics are pocket-tuned, so
     reuse the approach, not the code, as the morph's needs dictate.
   These are building blocks. The old engine's *behavioral* lead-in/out conventions
   are NOT a specification — the requirements above are.

   After this layer is validated: abrupt-turn steering (rebuilt to not deform
   geometry, tested on a sharp-turn fixture — island-back or U-shape, NOT the gentle
   paisley), then UI integration per the Strategic context section above.
3. **Abrupt-turn steering**, rebuilt per the lessons above, tested on a sharp-turn
   fixture (island-back or U-shape) — NOT the gentle paisley.
4. **Eventually:** clean up the dead reMorphedRegions src/ emission (still computed/
   exported, viewer no longer draws it). Then integration into the live operation path.

---

## Document Maintenance Policy (NEW — when these files get updated)

> Added because four guiding docs all went stale at once (this session's prototype
> outran the design-of-record). A cadence prevents recurrence. docs/CONVENTIONS.md is the
> canonical home for working discipline; this policy is mirrored there. It is better
> to work slowly and well-documented than fast and sloppy.

- **HANDOFF.md** — refreshed whenever the prototype/engine state materially changes
  (a validated capability lands, a strategic decision is made, or a guiding doc is
  found stale), and always at a session boundary where the next session would
  otherwise start from a wrong picture. Not append-only; rewritten. Chat-side authors
  the content; CC commits it.
- **STATUS.md** — gets a new milestone entry when a milestone closes or a major
  capability is validated. Backfill commits (`docs(ac): backfill STATUS.md for
  <hash>`) are the clean way to catch up when a code commit landed without it. Old
  milestone history is retained as record, never deleted.
- **Architecture doc (design-of-record)** — reconciled when the prototype proves the
  abstract design incomplete or wrong (as now: region-split rule, morph construction).
  Do NOT let the prototype silently diverge from the doc; either fix the doc or flag
  the conflict here. Reconciliation is its own focused commit, not bundled with code.
- **docs/CONVENTIONS.md** — updated when a working pattern is added, changed, or retired.
  This session's discipline lessons (verify-before-assert, diagnose-first, don't-
  deform-extracted-geometry, build→render→user-looks loop) belong here as durable
  patterns, cross-referenced from the Working Discipline block above.
- **Trigger phrase for a housekeeping pass:** if a session opens and finds that MORE
  THAN ONE guiding doc disagrees with reality, stop and do a housekeeping pass before
  new feature work. Drift compounds; catch it early.
- **Cadence floor:** at minimum, review all guiding docs for staleness at every
  milestone close. Between milestones, update opportunistically per the triggers above.

---

## Reading guide for a new chat session

1. **Read the Working Discipline block first.** It is what makes the session
   effective; the technical state is secondary to it.
2. **Request the inputs in "Request These First"** — especially the user's annotated
   reference images.
3. **Read the CONFLICT FLAGS** before trusting the architecture doc or old STATUS
   framing on region-splitting, morph construction, or "what's next."
3a. **For the loopback phase specifically: read `toolpath_element_convention.md` (project
   knowledge) and §3a of this file together, before proposing any loopback build.** They
   are the complete design foundation developed 2026-05-28 and exist so the loopback work
   starts against a written standard rather than re-deriving it. Also pull the existing
   move-type (MoveRole) taxonomy from the other operations at the start — move types are a
   postprocessor contract, not a loopback-internal detail.
3b. **The construction method for that phase is now OCCT — read `HANDOFF-OCCT-MIGRATION.md`
   (2026-05-29) before §3a.** It carries the library decision, the proven POC, the root
   cause of the prior hand-rolled failure, the end-to-end-OCCT strategy, the sandbox-first /
   visual-review-gated plan, the Python-vs-WASM runtime question, and the exact file list
   the next session needs. §3a/§3 are the requirements; the migration handoff is the method.
4. **Confirm mechanical state** with `git log` + a fresh viewer render; this file may
   lag by the latest commit.
5. **Do not propose CC prompts immediately.** Acknowledge the handoff, confirm the
   strategic state (and the conflict flags), then propose approach. Mid-design and
   mid-prototype resets are normal docs commits, NOT a `liencam-session-handoff`
   invocation (that skill is milestone-close only).

---

*Chat-side fields are authored by the chat-assistant (the authority on conversation
state); CC commits the file but is not the source of chat-side content. Mechanical
fields are CC-derived and may lag by the most recent commit — confirm at session start.*
