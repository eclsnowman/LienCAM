> HISTORICAL - SHIPPED. This handoff records the feat/postprocessor branch era.
> Its branch, HEAD, test-count, and NEXT details do not describe the current
> repository. For delivered-vs-not use code plus docs/FEATURE-HITLIST.md; for
> mechanical state use fresh git status/log output.
>
# Postprocessor (src/lib/post/) — HANDOFF

Work-line: Group C postprocessor ("real G-code out", the project ship gate).
Governing ADR: docs/decisions/0021 (Accepted). Design spine:
docs/planning/POSTPROCESSOR-DESIGN.md (phases C-P0..C-P6; S11 = deferred backlog +
revised phase order). Research: docs/planning/research/R2 (dialects), R3 (arc-collapse),
R5 (UI settings), R7 (UCCNC).

---

## WHAT I WISHED I KNEW AT START (read this first)

1. **A dialect is just a `PostConfig` object** in src/lib/post/dialects/*.ts (extends
   base.ts), exported from index.ts and listed in `BUILT_INS` in PostProcessModal.tsx.
   Comment style (`paren`/`semicolon`), dwell units (`ms`/`s`), tool-change mode, arcs,
   and program-end retract are ALL already config-driven — a new dialect that only differs
   on those needs ZERO emit.ts change. (LinuxCNC was almost pure config + registration.)
2. **Operator has NO LinuxCNC validator — only UCCNC and GRBL.** For any dialect/feature he
   can't load, validate INTERNALLY by EQUIVALENCE: the synthetic samples come from the
   same toolpath through the same emit pipeline, so a `diff` of the motion lines (comments
   stripped) against a hardware-validated dialect proves geometric identity. LinuxCNC
   passed this way (byte-identical motion to UCCNC; only `( )` -> `;` differs). Plus lint +
   parser clean. Use this pattern for any future un-loadable dialect.
3. **Custom program-end OWNS the whole end block.** emit.ts emits its own M5/M9/M30 tail
   AFTER emitProgramEnd's retract (emit.ts ~L239-246). In `programEndMode:'custom'` that
   tail is now SUPPRESSED (a `customEnd` guard) so the user's verbatim lines are the entire
   end — otherwise you get duplicate M5/M30 (the exact bug the verdict walkthrough caught).
4. **Tool-change "custom" already existed as the `macro` mode** (options.toolChangeMacro,
   verbatim with a `{tool}` token). Phase B just relabeled the button "Custom" and made the
   empty case fail loud. Don't rebuild it. Preamble/postamble are also already editable
   literal-line arrays (framing.programStart/programEnd, UI). The real Phase B gap was only
   custom program-END.
5. **NEVER emit `G53 G0 Z0` as a retract** (from C-P1). Operator's machine Z0 is near the
   BOTTOM of travel; G53 Z0 PLUNGES. Retracts go UP to a work-clearance Z.
6. **Operator wants FULL ABSOLUTE paths in review links**, not repo-relative ("Claude sessions
   are not consistent where they put files"). Lead the review ask with clickable links
   grouped at the END of the reply, visible text = the full `D:\...` path.
7. **A DRILL operation already EXISTS and is fully implemented** (Phase C recon refuted the
   seed's worry). src/lib/cam/drill2d.ts buildDrillToolpath emits an EXPANDED plunge/retract
   move stream (role 'plunge' + 'rapid'); DrillParams.cycleType = simple|peck|chip_break|
   dwell. So canned cycles needed NO operation-layer change — the post RECONSTRUCTS the
   cycle from the move stream + op.params (src/lib/post/cannedCycle.ts). The key emit fact:
   emit.ts has NO resolved heights (it walks absolute-Z moves); the dwell-SECONDS value for
   G82 lives ONLY in op.params.dwell (the stream just duplicates a point as a cue). So
   canned-cycle emission is a HYBRID: geometry (holes/R/bottom) from the moves, cycle
   discriminator + peck/dwell magnitudes from op.params.
8. **drill2d peck depth (DEF-4 — FIXED 2026-06-15, commit a4b6ed9).** emitPeck used to
   count pecks from topZ but descend from feedZ (above top), so it stopped ~(feedZ-topZ)
   short + left a dangling re-approach. Now it starts the descent at topZ (= bottomZ +
   totalDepth) so it reaches full depth. emitChipBreak already started at topZ (correct).
   If you touch peck/drill geometry: the canned reconstruction reads bottom from the move
   stream, so an operation-layer depth change auto-flows into the canned cycle.
9. **Multi-setup export (E2 — DONE 2026-06-15) has a reusable section seam.** emit.ts has a
   module-internal `emitSetupSection(input, config, modal, opts)` (opts: sectionComment?,
   trailingRetract?, prevToolNumber?, pauseBefore?, incomingCoolantOn?; returns lines +
   safeWorkZ + diagnostics + coolantWasOn + lastToolNumber) that emits ONE setup's body using
   a CALLER-SUPPLIED modal. `emitProgram` is the N=1 composition (preamble + section +
   postamble) and is BYTE-IDENTICAL to before (it passes the new opts as defaults — keep it
   that way). `emitCombinedProgram(inputs[], config, {pauseBetweenSetups, sectionComments})`
   is the multi-setup path: ONE preamble, N sections sharing one modal, ONE postamble.
   src/lib/post/postProject.ts is the top orchestrator (combined vs separate, per-op
   selectedOpIds filter, findWorkOffsetConflicts fail-loud guard). CRITICAL SAFETY FACT: tool
   state MUST thread across sections (carryTool) — a section that resets prevToolNumber to null
   mis-classifies its first op as an INITIAL LOAD (bare T#/M3, NO M6 ceremony), so two setups
   on different tools would cut setup 2 with setup 1's tool. Threading carryTool/carryCoolant
   is what makes the cross-setup tool change real; the M0 pause is composed INSIDE the section
   (pauseBefore) so spindle stop(M5)/restart(M3) interleaves with the tool logic. Redundant
   safety codes at boundaries (double G0 Z<safe>, double WCS select) are ACCEPTED, not bugs.

---

## Mechanical state

- Branch: `feat/postprocessor` (MAIN working copy — visible to Operator; no sibling worktree).
- Commit at update: `2a2c002` feat(post): note that multi-WCS combined exports overlap in
  backplots — the docs(handoff) refresh for THIS update lands immediately after.
- Tests: full suite 1320 pass / 15 skip; tsc -b -> 0. This session shipped Phase E2
  (Post-dialog op/setup selection + multi-setup export) PLUS two post-E2 field fixes from
  Operator's real 2-setup export: (1) fix(post) 2ae11c4 arc-collapse no longer balloons arcs
  across sharp contour corners (arc-to-chord/sagitta guard) — Operator confirmed the BootL with
  arcs ON is "now right"; (2) feat(post) 2a2c002 a multi-WCS combined-export info note; the
  G54/G55 backplot OVERLAP was web-researched and is EXPECTED (work offsets live in the
  controller, not the program — see STATUS 2026-06-15). Prior session: Phase C, DEF-4,
  motion-equivalence gate, Phase E1.

## FEATURE COMPLETE: setup/op export selection + work-offset uniqueness (E1 + E2 DONE)

Operator requested (2026-06-15): pick which setups/ops get posted, and HARD-guarantee no two
setups share a work-coordinate number (G54-G59) — two setups under the same tag but
different zeros crash when run in sequence. BOTH halves shipped.

- **E1 — DONE (commits 41d4c5d feature, b299358 walkthrough).** Work-offset uniqueness AT
  ASSIGNMENT. Pure helper src/lib/post/workOffsets.ts (usedFixtureOffsets, setupNameUsingOffset,
  findWorkOffsetConflicts). SetupModal greys out an offset claimed by ANOTHER setup, defaults
  a new setup to the first free offset, blocks Create when all 6 are taken. NON-DESTRUCTIVE.
  Ceiling = 6 setups until extended offsets G59.1-.3 (DEF-1). Walkthrough C1/C2/C3 Approved.

- **E2 — DONE 2026-06-15 (commits 2475827, 01479de, d2e55de, e4acbdf, 5c13c5a).** Post-dialog
  op/setup selection + multi-setup export. As built:
  - emit.ts reusable `emitSetupSection` seam + `emitCombinedProgram` (one preamble, N sections
    sharing one modal, one postamble); emitProgram is the byte-identical N=1 composition.
  - src/lib/post/postProject.ts orchestrator: combined (one program) vs separate
    (`<base>-G<nn>.<ext>` per setup, sequential downloads, no zip); per-op selectedOpIds
    filter; zero-op setups dropped; findWorkOffsetConflicts fail-loud DUPLICATE_WORK_OFFSET
    guard over the SELECTED setups.
  - PostProcessModal: "All Operations" master toggle (default on, compact) -> collapsible
    setup/op tree; Combined/Separate toggle; "Pause between setups (M0)" toggle; live preview
    (Separate has a per-file selector); export disabled on error/empty. Filename base = project
    name (changed from setup name — flagged to Operator, approved implicitly).
  - SAFETY: tool+coolant state threads across sections so different-tool setups emit a real
    tool-change ceremony (not a mis-classified initial load); M0 pause stops the spindle (M5)
    before the pause and restarts it (M3) on resume.
  - GATES PASSED: full suite 1311/15; tsc 0; synthetic-uccnc-combined.nc READ (one preamble,
    G54+G55 sections, cross-setup T2->T3 change, canned cycles, one M30); visual-verdict
    walkthrough P1-P7 (docs/planning/post-samples/e2/) — P1-3,P5-7 Approved, P4 Modify
    (per-file preview selector) implemented + re-verified.
- Working tree: all post work committed. Dirty files are UNRELATED parallel-session
  artifacts (AC engine probes, ui-ux PNGs, PHASE4 coord docs, imports/, test_fixtures/,
  Sample Parts/) — NEVER stage them.

### Commits this session (oldest->newest)
2475827 refactor(post): extract reusable emitSetupSection seam · 01479de feat(post): multi-setup
export orchestrator (combined/separate) + dup-offset guard · d2e55de feat(post): multi-setup
op/setup export selection UI in PostProcessModal · e4acbdf chore(post): multi-setup combined
sample (synthetic-uccnc-combined.nc) · 5c13c5a docs(post): record Phase E2 complete + walkthrough.

---

## What shipped this session: Phase C native canned drilling cycles (COMPLETE)

- **cannedCycle.ts (PURE):** `reconstructDrillCycles(op, moves)` re-derives a native
  G81/G82/G83 descriptor from the expanded drill stream. Holes grouped on the feedZ
  approach move (type 'feed', role 'rapid'); per-hole bottom = min plunge Z (honors
  holeBottoms); R = feedZ; initial = clearance; feed from the role 'plunge' moves. Maps
  simple->G81, dwell->G82 (P=params.dwell s), peck->G83 (Q=params.peckDepth); retractMode
  clearance->G98, retract->G99 (approved Q1). chip_break -> EXPECTED signal
  DRILL_CHIP_BREAK_EXPANDED (approved Q2(b): no faithful native G73 retract word -> stays
  expanded). Typed {ok:false,code,message}, no throw/partial (ADR-0003).
- **emit.ts drill branch:** op.type==='drill' && caps.cannedCycles -> G0 rapid to work
  clearance, then per-hole `G98|G99 G8x X Y Z R [Q] [P] F` (G-word/R/Q/P/F modal-suppressed
  after hole 1; Z re-emitted on a differing per-hole bottom), closed by G80 + modal
  forceReset. World->work via coords.toWork; dwell P converts seconds per caps.dwellUnits.
  Q3 fallback: malformed reconstruction -> level:'warning' diagnostic + the already-correct
  expanded stream. GRBL/generic + chip_break fall through to the unchanged linear walk.
- **gcode/lint.ts:** added Q to KNOWN_LETTERS + NUMBER_REQUIRED (peck increment; R+P were
  already known). Canned G-words lint clean (leading G0 Z sets the inherited motion mode).
- **Samples (lint 0 + determinism byte-identical):** synthetic-uccnc-drill.nc +
  synthetic-linuxcnc-drill.ngc (native G83 Q / G81, G80) + synthetic-grbl-drill.gcode
  (expanded). Generator refactored into a shared processTarget() (no gate weakened). I READ
  the UCCNC .nc — correct. GATE PASSED: Operator loaded UCCNC + GRBL drill samples 2026-06-15
  ("both seem good"). LinuxCNC inherits via the automated motion-equivalence gate.
- Addresses design gap G10. No UI change (drill op already had its modal tab) -> no
  verdict-walkthrough needed this phase.

---

## KNOWN ISSUES / OPEN (and DEFERRED — see POSTPROCESSOR-DESIGN.md S11)

1. **DEF-1 (MUST close): G59.1-.3 extended work offsets.** LinuxCNC declares
   workOffsets.extended:true but emit.ts (~L133, `G${wcs.fixtureOffset}`) emits only
   G54-G59. Build the G59.1/.2/.3 mapping when the coordinate-hierarchy track exposes a >6th
   fixture offset (none today, so untestable). Touches WCS/fixtureOffset (coordinate track).
2. **DEF-2 (MUST close): inch/G20 output.** format.units:'inch' exists but emit never emits
   G20 from it nor converts coordinate VALUES (all treated mm). True inch = cross-dialect.
3. **DEFERRED by plan:** helix-as-arc (stays G1); Taubin fit (Kasa is v1 default).
3b. **DEF-4: drill2d peck under-drill — CLOSED 2026-06-15 (commit a4b6ed9).** emitPeck now
   reaches full depth (starts the descent at topZ); emitChipBreak was already correct
   (verified, guard test added). Samples regenerated (UCCNC G83 Z-12). No longer open.
4. **OPEN UX (Operator, not yet scoped):** Post dialog Preview-TAB vs inline-preview EXPAND
   button redundancy — a small dialog-layout decision; do a separate
   visual-verdict-walkthrough if pursued.
5. **C-P5 (future):** direct post-script editing — ADR-0021 D2 config form + safe sandboxed
   templates (LiquidJS), then quickjs-WASM scripts; + the .cps static-extract importer (D7).
   "Save Post As" already persists a user config to localStorage (`liencam.userPosts`).

---

## Reuse-WITH-FRICTION (port, don't re-derive)

- **Adding a dialect:** copy dialects/uccnc.ts; only override the differing capability/
  format/framing/options fields; export from index.ts; add to BUILT_INS + defaultPostId +
  extFor in PostProcessModal.tsx; add TARGETS entries in scripts/post/generate-samples.ts;
  add assertions in src/tests/post/{emit,synthetic}.test.ts (NOT golden snapshots — they use
  toContain/toBe on emitted lines). FRICTION: generate-samples.ts hardcoded comment-style in
  its lint call — it now has a per-target `commentStyle` field; set it for non-paren dialects
  or the lint gate false-flags valid comments.
- **Internal dialect validation (no hardware loader):** `diff <(grep -vE '^\s*[;(]' A) <(grep
  -vE '^\s*[;(]' B)` to prove motion identity vs a hardware-validated dialect, then `diff A B`
  to confirm only comment lines differ. Decisive + cheap.
- `scripts/post/generate-samples.ts` — run via `node_modules/.bin/vite-node`. Generates
  samples + backplots, self-verifying (lint zero-errors + determinism). FRICTION: the
  Google-Drive output dir LOCKS (GoogleDriveFS holds a read handle) — the script uses
  `robustWriteFile` (delete-then-write + retry/backoff); do NOT kill node.
- `src/lib/gcode/backplot.ts` — backplotSvg LINEARIZES arcs (each G2/G3 as one chord), so
  arc backplots show chords not curves. The dedicated overlay is the arc-fidelity artifact.
- **UI verdict capture:** docs/planning/post-samples/capture-phaseB.mjs (this session) +
  the older capture-arcs.mjs / build-arcs-report.mjs — live Playwright against vite
  :5173/:5174. CHECK for an already-running dev server and REUSE it (don't spawn a duplicate).
  Seed the project via `window.__camStore.setProject` BEFORE the dialog mounts (defaultPostId
  reads at first mount). Native OS `<select>` dropdowns can't be screenshotted headless —
  render an in-DOM facsimile from the live option text. Seed a TWO-tool setup to exercise
  tool-change states.
- Post preview re-runs on any `working` config change (result useMemo dep) — editing a
  custom field updates the preview live; no extra wiring.
- **Drill canned cycles (port, don't re-derive):** the post NEVER gets resolved heights —
  emit.ts walks absolute-Z moves. So a canned cycle is reconstructed HYBRID: geometry
  (hole XY, bottom Z, R plane) from the move stream, cycle type + peck/dwell magnitudes
  from op.params (cast `op.params as unknown as DrillParams`). FRICTION: (1) the per-hole
  feedZ approach move is `type:'feed', role:'rapid'` (an unusual combo — it is the
  hole-start + R-plane marker, NOT a plunge); (2) peck full-retracts between pecks are
  `type:'rapid'` so they do NOT false-split a hole; (3) the G82 dwell value is ONLY in
  op.params.dwell (seconds) — the stream's duplicated bottom point is just a cue, the
  number is not in the moves; (4) reconstructDrillCycles returns DRILL_CHIP_BREAK_EXPANDED
  as an EXPECTED signal (not an error) so the caller keeps the expanded stream. Add a new
  canned G-code letter? -> also add it to gcode/lint.ts KNOWN_LETTERS + NUMBER_REQUIRED or
  the sample generator's lint gate false-flags it (that is how the Q gap surfaced).

## GROUND TRUTH to validate against
Operator's UCCNC simulator (.nc) + ncviewer.com (.gcode/.ngc). He has NO LinuxCNC loader — use
motion-equivalence for LinuxCNC. Load checks: arc files = clean G2/G3 on curves + G1 on
straights; linear = all G1; retract is G0 to work clearance, never G53 Z0; custom end block
= exactly the user's lines (no duplicate M5/M30); drill = native G81/G82/G83 + G80 on
UCCNC/LinuxCNC, expanded G0/G1 on GRBL.
- **Motion-equivalence is now an AUTOMATED gate** (was hand-run): src/tests/post/
  dialect-motion-equivalence.test.ts asserts LinuxCNC motion lines (comments stripped) ==
  UCCNC for linear/arc/drill jobs, so any future LinuxCNC drift from validated UCCNC motion
  fails CI. The ONE deliberate divergence (dwell units ms vs s) is excluded + pinned by a
  negative guard test. Add a dwell-bearing job to the EQUIVALENCE set and it WILL fail by
  design — that is expected, not a regression (move it to the guard, don't weaken the gate).

---

## Chat-side context (freshness: current, 2026-06-15)

- **What just shipped:** Phase E2 — Post-dialog op/setup selection + multi-setup export.
  Export multiple setups in one action (combined = one program with a section per setup;
  separate = one `<base>-G<nn>.<ext>` file per setup), pick which setups/ops, optional M0
  pause between setups (with spindle stop/restart), cross-setup tool changes, and a
  fail-loud DUPLICATE_WORK_OFFSET export guard. 5 commits (2475827..5c13c5a). Full suite
  1311 pass / 15 skip; tsc 0. Walkthrough P1-P7 approved (P4 Modify implemented).
- **Open strategic question:** none blocking. Remaining before Group C V1 = DEF-2 (inch/G20
  + value conversion) and DEF-1 (G59.1-.3 extended offsets — blocked on the coordinate track
  exposing a >6th fixture offset). Then Phase D = rest of C-P5 (config form + templates +
  .cps importer).
- **Recommended next step:** Operator's choice — (a) DEF-2 inch output (cross-dialect,
  self-contained in the post; closes one of the two remaining Group-C-V1 blockers), or
  (b) Phase D config-form UX + .cps importer (bigger, UI-heavy, multi-session). DEF-1 stays
  blocked on the coordinate track. Confirm the target with Operator before planning.
- **Pending docs-debt:** ARCHITECTURE.md "Postprocessor boundary (planned)" + UI-ARCHITECTURE.md
  §13 are STALE — both still say "no postprocessor / not implemented" and omit the now-shipped
  post (linear, arcs, canned cycles, LinuxCNC dialect, custom end, AND multi-setup export).
  Pre-existing doc-debt owned by the ADR-0021 consequence; every post phase has deliberately
  left it. A consolidated "post is shipped; input is a setup; world->work + canned cycles +
  multi-setup framing are the post's job" rewrite should land before Group C V1. STATUS.md +
  this HANDOFF + POSTPROCESSOR-DESIGN.md (Phase E section added) are current.
- **Operator workflow notes:** CNC SME + visual reviewer, not a coder — translate git/code to
  plain English; hand ONE complete copy-paste prompt; LEAD review asks with FULL ABSOLUTE
  paths clickable at the END (hard pref); his load-and-sim is the real gate (UCCNC + GRBL
  only, NO LinuxCNC); he runs PARALLEL sessions (never touch their dirty files); he said
  "keep progressing through" — defer phase ORDERING to the architect. E2-specific: he wanted
  Separate-mode preview to switch between files (P4) — a per-file selector now does that.
- **Manual test (Operator): PENDING for E2** — build a 2-setup project (distinct G54/G55), open
  Post Process: (a) default combined program loads/runs in UCCNC; (b) Separate -> two files
  `<name>-G54`/`-G55`; (c) tick "Pause between setups" -> confirm M5/M0 then M3 restart at the
  boundary; (d) force two setups onto the same offset -> export blocked with DUPLICATE_WORK_OFFSET.
  synthetic-uccnc-combined.nc is a ready loadable artifact for (a).

---

## SEED PROMPT for the next session

> RETARGET: feat/postprocessor is GONE (landed on main; branch deleted) - any
> new post work starts on a fresh branch off MAIN. Update since this seed was
> written: DEF-2 inch/G20 output SHIPPED (442b0b4) - no longer an open choice.
> STILL OPEN backlog: DEF-1 (G59.1-.3, blocked on the coordinate track) and
> Phase D (config-form UX + .cps importer). The work-style/read-first sections
> below remain good guidance.

```
New LIENCAM session - POSTPROCESSOR Group C. Phase C (canned cycles), DEF-4 (peck depth),
the LinuxCNC motion-equivalence gate, Phase E1 (work-offset uniqueness at assignment), and
Phase E2 (Post-dialog op/setup selection + multi-setup export) are DONE on feat/postprocessor
(HEAD at handoff 2a2c002, incl. two post-E2 field fixes: arc-collapse corner guard 2ae11c4 —
Operator-confirmed; multi-WCS overlap note 2a2c002 — overlap is EXPECTED, not a bug). Phase C is
hardware-validated; E2 multi-setup combined output now confirmed clean on Operator's real BootL
part (arcs ON). Remaining E2 manual checks (separate-file naming, M0 pause, dup-offset block)
optional. NEXT (Operator's choice, confirm before planning): DEF-2 inch output
(in-post, cross-dialect, closes one of the two Group-C-V1 blockers) OR Phase D (config-form
UX + .cps importer, bigger/UI-heavy). DEF-1 (G59.1-.3) stays blocked on the coordinate track.
Both DEF-2 + DEF-1 must close before Group C V1 is declared done.

WORK STYLE (standing convention - follow it): You are the ARCHITECT + QUALITY GATE, thin.
Your scarce resource is your OWN context window. DELEGATE everything heavy to FRESH
subagents - recon ("where/how does X work"), implementation chunks, debugging, and
verification/measurement runs - each returns a compact (~250-word) digest; heavy reading/
searching/building/running stays OUT of your window. You AUDIT each digest against the plan
+ conventions + ADRs, run the gates YOURSELF, gate, and commit. A subagent that returns a
digest buys context-longevity; doing it inline burns it. Require subagents to invoke skill
liencam-orientation. At ~75% context, checkpoint + hand off (liencam-session-handoff).

READ FIRST (grounding, before any code): 1) skill liencam-orientation. 2) src/lib/post/
HANDOFF.md (this file - the WHAT I WISHED I KNEW list incl. the drill HYBRID-reconstruction
facts, the E2 emitSetupSection/emitCombinedProgram seam + cross-setup tool-threading SAFETY
fact, and reuse-with-friction). 3) src/lib/post/STATUS.md (C-P0..C-P4 + Phase B + C + E1 + E2
complete). 4) docs/decisions/0021-*.md. 5) docs/planning/POSTPROCESSOR-DESIGN.md S8 + S11 +
the Phase E section (deferred backlog: DEF-1 G59.1-.3 + DEF-2 inch must close before Group C
V1; G10, DEF-3, DEF-4 done).

IF DEF-2 (inch output) is chosen: it is IN-POST (Group C) but CROSS-DIALECT. format.units
'inch' exists in the type but emit never emits G20 from it nor converts coordinate VALUES
(everything treated mm). True inch = emit G20, convert all XYZ/I/J/F/R/Q mm->inch, and
adjust decimals. Touches emit.ts + coords.ts + every dialect's format block + samples +
the lint/parser if any unit assumption is baked in. Plan-first.

METHOD: PLAN-FIRST (skill liencam-planning-cycle) -> Operator approves -> execute (skill
liencam-execution-cycle). Atomic commits, conventional messages, fail-loud (ADR-0003), no
silent fallbacks. "Reports are not artifacts" - verify by RUNNING (tests + a real generated
.nc you READ + any visual artifact you LOOK at). g-code harness lint (src/lib/gcode/) = the
"loads first try" gate - if you emit a NEW address letter/word, add it to lint.ts
KNOWN_LETTERS/NUMBER_REQUIRED or the sample generator false-flags it. For UI changes run a
visual-verdict-walkthrough (skill) + Operator's verdicts BEFORE committing. LEAD review asks
with FULL ABSOLUTE paths clickable at the END (Operator's hard pref). His UCCNC sim + ncviewer
load = the AUTHORITATIVE gate; NO LinuxCNC loader (validate by motion-equivalence to UCCNC).

HARD BOUNDARIES: stay in Group C - src/lib/post/ + src/lib/gcode/ + src/tests/ + docs/
planning/post-samples/ (+ the Post dialog component for UI). The OPERATION layer (src/lib/
cam/ + worker + types) - incl. any drill2d peck fix - crosses out of Group C; flag it as
expanded scope and get Operator's OK before touching it. Do NOT touch the coordinate track or
the parallel-session dirty files. Work on feat/postprocessor in the MAIN working copy.
Never merge/rename/delete branches without a fresh plain-English OK in THAT conversation.

PRE-AUTH: read any file under src/lib/post, src/lib/gcode, src/tests, docs/planning,
docs/decisions; run vitest + tsc + the generate-samples script freely.
```
