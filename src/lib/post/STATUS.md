# Postprocessor (src/lib/post/) — STATUS

Append-only milestone log. Current continuity detail lives in HANDOFF.md.
Governing: ADR-0021; design docs/planning/POSTPROCESSOR-DESIGN.md (phases C-P0..C-P6).

## 2026-06-14 — C-P0 + C-P1 COMPLETE (UCCNC + GRBL linear), branch feat/postprocessor

- C-P0 contract + scaffolding: PostInput/PostConfig/PostResult types, resolveSpindle/
  resolveCoolant, fail-loud validators, store-side buildPostInput, assembly skeleton.
- C-P1 linear emission: modal engine + formatting + world->work transform + program
  assembly + G54-G59 select + opt-in G10 L2 + spindle/coolant + configurable
  tool-change (m6/pause/macro/none + toolChangePause) + fail-loud (rotated WCS, tool
  numbers, arc-to-linear-post). UCCNC + GRBL dialects (capability-config, one engine).
- Reusable g-code harness src/lib/gcode/ (parse/lint/backplot) — also groundwork for a
  future in-app GRBL sender.
- Synthetic all-roles test job + generated UCCNC/GRBL .nc samples + Post Process dialog
  (matches mockup + Operator's UX verdicts).
- Two safety fixes from Operator's real UCCNC sim: never G53-to-machine-zero (retract UP in
  work coords); comment-text sanitize (no nested parens).
- Tests: 92 (src/tests/post + src/tests/gcode) green; tsc -b clean.
- NEXT: C-P2 arc-collapse (src/lib/post/arcfit/) — plan ready, approval pending.
  OPEN: GRBL sample file stale on disk (regen when unlocked). See HANDOFF.md.

## 2026-06-14 — C-P2 COMPLETE (toleranced arc-collapse -> G2/G3), branch feat/postprocessor

- arcfit subsystem (src/lib/post/arcfit/): circleFit.ts (Kasa algebraic fit +
  maxRadialDeviation + sweepAngle), simplify.ts (Douglas-Peucker + indexed variant),
  index.ts (collapsePolyline: per-feed-run greedy line/arc fitter). Tolerance validated
  against the ORIGINAL points each primitive replaces (not the DP-thinned subset) — the
  honest end-to-end gate. Gates: minArcRadius / maxArcRadius / minSweepDeg / 180deg cap
  (full circle splits into multiple arcs) / z-plane guard (XY-only arcs v1) / helix stays
  G1. Pure; deterministic.
- Emission: emit.ts runs collapse per op when caps.arcs, emits G2/G3 with toWork endpoint
  + frame-invariant I/J = cx-prevWorldX (WCS offset cancels in the difference) + modal F.
  Fail-loud ARC_UNSUPPORTED (arcs off) / ARC_MALFORMED (missing center/predecessor).
  UCCNC + GRBL flipped arcs:true; labels dropped "(linear)" suffix.
- Linter: ARC_NO_CENTER (error) + ARC_R_AND_IJK (warning) IJK well-formedness rules.
- Formatter fix: fmtNum normalizes any zero-valued result (tiny-negative -> "J0" not "J-0").
- UI: Post dialog Arcs section is live — "Emit arcs" toggle (off = linear-only export) +
  Arc tolerance input (default 0.05mm); live preview re-runs on change. Operator verdicts
  P1-P3 approved 2026-06-14.
- Options/caps: PostOptions.arcTolerance (0.05 default); PostCapabilities.maxArcRadius
  (1e4) + minSweepDeg (2).
- Samples: synthetic-{uccnc,grbl}-{linear,arcs}.{nc,gcode} + overlay-arc-vs-polyline.png
  (270deg circle -> 2 arcs, 0.0000mm dev). GRBL linear sample refreshed (G53 plunge gone).
- Tests: 137 (post+gcode) green; full suite 1243 pass / 15 skip; tsc -b clean.
- GATE PASSED: Operator loaded all 4 samples in UCCNC sim / ncviewer 2026-06-14 -- "files
  load fine and look good." C-P2 validated against the authoritative load-and-sim gate.
- DEFERRED: helix-as-arc (stays G1); Taubin fit; LinuxCNC/generic arc enablement.
- OPEN UX (Operator, not C-P2): Preview-tab vs inline-preview-expand redundancy; direct
  post-script editing is C-P5 (user posts + sandboxed templates, ADR-0021).
- NEXT: see HANDOFF.md SEED (next post phase per docs/planning/POSTPROCESSOR-DESIGN.md S8).

## 2026-06-14 — C-P4 LinuxCNC dialect COMPLETE + Phase B custom dropdowns COMPLETE, branch feat/postprocessor

- C-P4 LinuxCNC dialect (src/lib/post/dialects/linuxcnc.ts, LINUXCNC_CONFIG): RS274NGC -
  ';' (semicolon) comments, dwell G4 P in SECONDS, native M6 tool change, G64 path-blend
  preamble (G90 G94 G17 G21 G64), arcs on (G2/G3 IJK), .ngc file extension. Registered in
  index.ts + PostProcessModal BUILT_INS + defaultPostId('linuxcnc') + extFor('.ngc').
  Generic dialect arcs flipped true (cloned caps, did NOT mutate DEFAULT_CAPABILITIES).
  Comment-style + dwell-units were already config-driven -> zero emit.ts change needed.
- LinuxCNC samples: synthetic-linuxcnc-{linear,arcs}.ngc + backplots; lint zero-errors +
  determinism pass. INTERNAL VALIDATION (Operator has NO LinuxCNC loader, only UCCNC+GRBL):
  proved LinuxCNC output is BYTE-IDENTICAL IN MOTION to the hardware-validated UCCNC
  samples - the ONLY diff is the comment syntax (`( )` -> `;`). So LinuxCNC inherits the
  UCCNC hardware validation; lint+parser clean. Honest scope: only `;` comments + .ngc are
  newly exercised; dwell-seconds + canned cycles are DECLARED but not yet emitted.
- Phase B (= POSTPROCESSOR-DESIGN S11 DEF-3) "Custom option on post dropdowns": new
  'custom' ProgramEndMode emits user-authored verbatim lines (options.programEndCustom) as
  the ENTIRE end block - the auto M5/M9/M30 tail is SUPPRESSED in custom mode (Operator verdict
  P1b "Replace, no duplicates"). Empty/missing custom fails loud PROGRAM_END_CUSTOM_MISSING
  (ADR-0003) and suppresses the whole tail (res.ok=false blocks export). Tool-change 'macro'
  path tightened to fail loud TOOL_CHANGE_MACRO_MISSING (was a silent bare-T# fallback) and
  its UI button relabeled "Custom". UI: End-behavior dropdown gains "Custom (verbatim)" +
  conditional textarea (hint: replaces the auto end, include M5/retract/M30). Comment-style
  control left as-is (Operator confirmed out of scope). Live-captured verdict walkthrough
  approved (P1/P2/P3 approve, P1b modify->implemented): docs/planning/post-samples/
  PHASE-B-CUSTOM-DROPDOWN-VERDICT-WALKTHROUGH.html + phaseB/ screenshots.
- Tests: 153 (post+gcode) green; tsc -b clean. Custom-end no-duplicate behavior locked by
  tests asserting real emitter output (single M5, no bare M30, program ends on user's line).
- DEFERRED (POSTPROCESSOR-DESIGN.md S11, MUST close before Group C V1): DEF-1 G59.1-.3
  extended offsets (declared, emission deferred - touches coordinate-track fixtureOffset);
  DEF-2 inch/G20 output (needs coordinate-value conversion). Revised phase order: A LinuxCNC
  (done) -> B custom dropdowns (done) -> C canned cycles/drilling -> D rest of C-P5.
- MANUAL TEST for Operator (now UCCNC-testable): Post dialog -> End behavior "Custom (verbatim)"
  -> type M5/G53 G0 Z0/M30 -> export -> confirm in UCCNC sim no duplicate M5/M30.
- NEXT: Phase C canned cycles / drilling (G81-class) - needs recon on whether a drill op
  emits into the move stream yet. See HANDOFF.md SEED.

## 2026-06-14 — Phase C COMPLETE (native canned drilling cycles), branch feat/postprocessor

- RECON refuted the seed's worry: a DRILL operation already exists and is fully
  implemented (OperationType 'drill', buildDrillToolpath in src/lib/cam/drill2d.ts,
  DrillParams.cycleType simple|peck|chip_break|dwell). It emits an EXPANDED plunge/
  retract move stream (role 'plunge' + 'rapid'). So NO operation-layer change was
  needed - Phase C stayed 100% in Group C (post + gcode + tests + samples).
- src/lib/post/cannedCycle.ts (PURE): reconstructDrillCycles(op, moves) re-derives a
  native G81/G82/G83 descriptor from the expanded stream. Hole grouping keys on the
  feedZ approach move (type 'feed', role 'rapid'); per-hole bottom = min plunge Z
  (honors holeBottoms); R plane = feedZ; initial level = clearance; plunge feed from
  the role 'plunge' moves. cycleType maps simple->G81, dwell->G82 (P=params.dwell s),
  peck->G83 (Q=params.peckDepth); retractMode clearance->G98, retract->G99 (approved
  Q1). chip_break returns the EXPECTED signal DRILL_CHIP_BREAK_EXPANDED (approved
  Q2(b): native G73 cannot carry the exact chipBreakRetract distance -> stays
  expanded). No throw, no silent partial: typed {ok:false,code,message} (ADR-0003).
- emit.ts: a drill branch (op.type==='drill' && caps.cannedCycles) emits one compact
  block per hole - G0 rapid to work clearance, then G98|G99 G8x X Y Z R [Q] [P] F with
  the G-word/R/Q/P/F modal-suppressed on later holes (X/Y only; Z re-emitted when a
  per-hole bottom differs), closed by G80, then modal.forceReset(). World->work via
  coords.toWork; dwell P converts seconds per caps.dwellUnits. Q3 fallback: a malformed
  reconstruction logs a level:'warning' diagnostic then emits the already-correct
  expanded stream (named fallback, ADR-0003). GRBL/generic (cannedCycles:false) and
  chip_break fall through to the unchanged linear walk.
- gcode/lint.ts: added Q to KNOWN_LETTERS + NUMBER_REQUIRED (the peck increment; R+P
  were already known). The canned G-words lint clean (leading G0 Z sets the motion
  mode the G8x lines inherit modally).
- Samples (lint 0 errors + determinism byte-identical): synthetic-uccnc-drill.nc +
  synthetic-linuxcnc-drill.ngc (native canned cycles), synthetic-grbl-drill.gcode
  (expanded fallback). Generator refactored into a shared processTarget() (no gate
  weakened). GATE PASSED: Operator loaded the UCCNC + GRBL drill samples 2026-06-15 -- "both
  seem good." LinuxCNC rides on the automated motion-equivalence gate (== UCCNC motion).
- Tests: cannedCycle.test.ts (8) + drill-emit.test.ts (8) + lint canned-cycle cases (3);
  full post+gcode suite green; tsc -b clean. Addresses design gap G10.
- SURFACED PRE-EXISTING DEFECT (NOT Phase C, operation layer): drill2d.ts peck
  under-drills. The peck count is computed from topZ but the descent starts from feedZ
  (above top), so the last peck stops ~(feedZ-topZ) short of bottom and emits a dangling
  re-approach. Affects BOTH the old expanded output and the new canned output equally
  (the canned cycle faithfully mirrors the stream's actual -11 bottom). Logged as S11
  DEF-4; needs its own planning cycle + Operator's OK (touches src/lib/cam, out of Group C).
- NEXT: DEF-1 (G59.1-.3) + DEF-2 (inch) must close before Group C V1; then D = rest of
  C-P5 (config form + templates + .cps importer). See HANDOFF.md.

## 2026-06-15 — DEF-4 CLOSED (peck under-drill fixed), branch feat/postprocessor

- src/lib/cam/drill2d.ts emitPeck: measured pecks from feedZ but counted from topZ, so the
  last peck stopped ~(feedZ-topZ) short of the hole bottom + emitted a dangling re-approach.
  FIX (commit a4b6ed9): start the descent at topZ (= bottomZ + totalDepth) so start + count
  agree; the final peck clamps exactly to bottomZ (full depth) and never trips the
  between-peck retract. feedZ stays the re-approach ceiling. emitChipBreak already started
  at topZ -> correct, unchanged (guard test added). OPERATION-LAYER change, authorized by
  Operator (picked DEF-4 + approved full first-peck bite, Q1).
- Corrects BOTH the expanded output (shipping) and the Phase C canned output (the canned
  reconstruction reads bottom from the stream). Drill samples regenerated (commit b0d7412):
  UCCNC G83 now Z-12 (was Z-11), GRBL 92->84 lines (dangling moves gone); lint 0 +
  determinism. Tests: peck job at bottom -12 reaches -12 / 7 plunge moves / no dangling;
  chip-break reaches -12; the -10 post fixtures unaffected. Full post+gcode green; tsc 0.
- REMAINING before Group C V1: DEF-1 (G59.1-.3, blocked on coordinate track), DEF-2 (inch).

## 2026-06-15 — Phase E1 COMPLETE (work-offset uniqueness at assignment), branch feat/postprocessor

- New feature line (Operator 2026-06-15): setup/op export selection + a HARD rule that no two
  setups share a work-coordinate number (G54-G59) — two setups on the same tag with
  different zeros crash when run in sequence. E1 = the assignment-time prevention.
- src/lib/post/workOffsets.ts (pure): usedFixtureOffsets / setupNameUsingOffset /
  findWorkOffsetConflicts. SetupModal.tsx greys out an offset claimed by ANOTHER setup
  ("G54 - in use (Roughing)"), defaults a new setup to the first free offset, and disables
  Create with an inline note when all 6 are taken. A setup never blocks its own offset.
  NON-DESTRUCTIVE (legacy dup projects still load; the E2 export guard catches them).
  Narrow diff in the coordinate-track-owned SetupModal, authorized by Operator. Ceiling = 6
  setups until extended offsets G59.1-.3 (DEF-1). Commits 41d4c5d + b299358.
- Tests: 12 (workOffsets); full suite 1297 pass / 15 skip; tsc 0. Visual-verdict walkthrough
  C1/C2/C3 all Approved by Operator.
- NEXT: Phase E2 (Post-dialog op/setup selection + multi-setup export) — fully specified +
  approved, see HANDOFF.md "FEATURE IN PROGRESS: E2 NEXT". Recommended as a FRESH session.

## 2026-06-15 — Phase E2 COMPLETE (op/setup export selection + multi-setup export), branch feat/postprocessor

- Post dialog can now export MULTIPLE setups (and pick which ops) in one action. Four atomic
  commits:
  1. 2475827 refactor(post): extracted a reusable emitSetupSection seam in emit.ts (optional
     section comment -> WCS select + optional G10 -> per-op walk -> optional trailing retract,
     using a CALLER-SUPPLIED modal). emitProgram is now the N=1 composition; single-setup
     output is BYTE-IDENTICAL (existing emit/synthetic tests pass unedited).
  2. 01479de feat(post): new src/lib/post/postProject.ts (PURE) orchestrating multi-setup
     export. 'combined' -> ONE program, a section per setup (one preamble/postamble, shared
     modal) via postCombined -> emitCombinedProgram; 'separate' -> N postProgram runs named
     <base>-G<nn>.<ext>. Per-op selection via selectedOpIds; zero-op setups dropped (info
     diag). FAIL-LOUD backstop (ADR-0003): findWorkOffsetConflicts over the SELECTED setups
     -> DUPLICATE_WORK_OFFSET, no output (catches legacy/programmatic dupes E1's SetupModal
     guard can't). SAFETY: emitCombinedProgram threads tool+coolant state across sections so
     two setups on DIFFERENT tools emit a real tool-change ceremony (not a mis-classified
     initial load that would cut setup 2 with setup 1's tool); the M0 pause-between-setups
     toggle stops the spindle (M5) before M0 and restarts it (M3 S) on resume, composed
     inside the section (pauseBefore) so it interleaves with the tool logic.
  3. d2e55de feat(post): PostProcessModal UI — "All Operations" master toggle (default on,
     compact) -> collapsible setup/op tree (per-setup checkbox = multi-select unit; chevron ->
     per-op checkboxes; conflict rows flagged); Combined/Separate toggle; "Pause between
     setups (M0)" toggle; live preview via postProject; Separate mode has a per-file preview
     selector; export disabled on error/empty selection. Filename base = project name.
  4. e4acbdf chore(post): synthetic-uccnc-combined.nc — a 2-setup combined sample (G54 Roughing
     T1/T2 + G55 Drilling T3/T4) generated by the real pipeline; one preamble, both WCS
     sections, the cross-setup T2->T3 tool change, native canned cycles, one M30; lint 0 +
     determinism; combined-sample.test.ts asserts the invariants. READ as the gate.
- GATE: visual-verdict-walkthrough P1-P7 (docs/planning/post-samples/e2/) — P1-3,P5-7 Approved
  by Operator (P5/P6 = the safety cases: cross-setup tool change + M0 spindle restart; refusing
  duplicate work offsets); P4 Modify (per-file preview selector in Separate mode) implemented
  + re-verified. Full suite 1311 pass / 15 skip; tsc 0.
- MANUAL TEST for Operator (UCCNC-loadable): build a 2-setup project (distinct G54/G55), open Post
  Process; (a) default = combined program loads + runs; (b) Separate -> two files
  <name>-G54 / -G55; (c) tick "Pause between setups" -> confirm M5/M0 then M3 restart between
  sections; (d) force two setups to share an offset -> export blocked with DUPLICATE_WORK_OFFSET.
- DEFERRED paired-doc debt (pre-existing, NOT E2's to fix): UI-ARCHITECTURE.md §13 + ARCHITECTURE.md
  still say "post-processor not implemented" — predates the whole Group C subsystem; owned by
  ADR-0021 consequence, to be consolidated before Group C V1.
- REMAINING before Group C V1: DEF-2 (inch) + DEF-1 (G59.1-.3, coordinate-track-blocked); then
  Phase D (config-form UX + .cps importer).

## 2026-06-15 — Post-E2 field findings: arc-collapse corner bug FIXED + G54/G55 overlap is EXPECTED

Operator exported a real 2-setup project (G54 leadscrew bracket + G55 BootL) and reported two issues.

- **ARC BUG — FIXED (commit 2ae11c4).** A purely-straight BootL contour (all G1) emitted huge
  bogus G2/G3 arcs (e.g. `G3 X77.011 Y52.099 I30.847 J17.729`, chord ~71mm r ~35.6mm = a
  ~180deg semicircle bulging ~17.6mm off the true path); the weirdness vanished with "Emit
  arcs" off. ROOT CAUSE: arcfit/collapsePolyline accepted an arc whenever the original VERTICES
  lay on the fitted circle (maxRadialDeviation), but ANY 3 points define a perfect circle, so
  two long straight edges meeting at a sharp corner passed and collapsed into a ballooning arc.
  AC was safe (dense tiny segments); sparse contour edges ballooned. FIX: new maxArcChordBulge
  guard — an arc must also stay within arcTolerance of the straight PATH between consecutive
  points (per-segment minor-arc sagitta r - sqrt(r^2 - (chord/2)^2)); reject otherwise. Corner
  -> stays 2 lines; dense real arc -> still collapses. Committed arc samples byte-identical
  (legit arcs unaffected). Tests: arcfit-collapse.test.ts (corner + box stay lines; dense arc
  regresses to 1 arc). Full suite 1320/15; tsc 0. CONFIRMED by Operator 2026-06-15 — re-exported
  the BootL with arcs ON, "now right."
- **G54/G55 OVERLAP — NOT A BUG (expected; web-researched 2026-06-15).** Combined export draws
  both setups overlapped in ncviewer/UCCNC backplots even though the machine offsets differ.
  Work offsets G54-G59 are stored in the CONTROLLER, not the program; a select-only multi-WCS
  program (D6 default, no G10 write) carries no separation in its text, so any backplot lacking
  the machine's offset table overlaps the sections. On the real machine, after touch-off of
  G54 + G55, the run separates correctly. The app cannot know the physical G54-vs-G55 origins
  (operator sets them via touch-off), so it correctly cannot/should not separate them in the
  file. Confirmed: ncviewer has no offset table (raw coords); UCCNC viewer behavior inferred
  (applies offsets to live DROs at run-time, viewer plots programmed coords — direct source
  thin); LinuxCNC/GRBL/CNCCookbook confirm work-offset-relative output is standard. FOLLOW-UP
  SHIPPED (commit 2a2c002, Operator requested): a one-line muted info note in the Post dialog,
  shown only in Combined mode with >1 setup ("Multiple work offsets (G54/G55...) overlap in
  backplots but run in separate locations on the machine after touch-off").

## 2026-06-20 — Nest multi-copy emission (P7) + post fail-loud "ops must be up to date" guard, branch feat/nesting-engine

- NEST MULTI-COPY STREAM (P7, commit 5d0f0c1): buildPostInput is now nest-aware — when a
  setup contains a seed op of a nest it substitutes the EXPANDED multi-copy ToolpathMove[]
  (all placements + inter-copy retract->rapid->plunge travel + cut ordering) produced by the
  one software expander, then the post FORMATS that stream unchanged. The post invents NO
  travel and NO machining order (ADR 0024 Amendment 1: travel + order live in software so
  they are seen/simulated, not in the post). PostOperation.nestExpanded flag makes nest DRILL
  ops SKIP the canned-cycle collapse so their per-copy safety travel survives in the output.
  Post test added. This keeps ADR 0001 intact (post formats geometry, never invents it).
- POST FAIL-LOUD GUARD (commit 83bcd99 "fix(post): refuse to post when any in-scope op is not
  up to date"): the post now REFUSES to emit when any operation in the SELECTED post scope is
  not 'ready' — i.e. outdated / error / computing / pending — fail-loud per ADR-0003.
  validateOpsCurrent is the new in-scope currency check; validateOpsReady was narrowed to flag
  only the ready-but-EMPTY (zero-move) case. This catches a STALE nest specifically: editing a
  seed flips its seed op to 'outdated', so without the guard a stale multi-copy program could
  be posted. No nest/geometry UI was added — the existing Post Processor modal disables Export
  + surfaces the diagnostic. (P8's earlier NEST-SCOPED "Generate program" UX was rejected by
  Operator + fully reverted in b3ed2fc; this guard is the real fix.)
- CONVENTION (cross-ref): generation stays SETUP-scoped via the Post Processor modal only;
  a nest is GEOMETRY, never a generate entry point. See src/lib/cam/nesting/HANDOFF.md.
- Gate at 83bcd99: `npx tsc -b` exit 0; full `npx vitest run` -> 1826 pass / 15 skip. NOT
  merged to main (branch feat/nesting-engine).

## 2026-07-02 — Post-merge milestones (reconciliation entry; everything below is ON MAIN)

- MERGED TO MAIN: all post work above landed on main (feat/postprocessor
  fast-forwarded; feat/nesting-engine delivered 2026-06-20). The "NOT merged"
  line in the 2026-06-20 entry above is SUPERSEDED by this entry.
- DEF-2 CLOSED: inch g-code output SHIPPED (commit 442b0b4) — emits G20 +
  converts values when exportUnits = inch (the full-stack units feature,
  ADR-0022 Accepted). The "REMAINING before Group C V1: ... DEF-2 (inch)"
  lines in the 2026-06-15 entries above are now DEF-1-only.
- Controller dropdown: the Machine controller dropdown is driven from the
  postprocessor registry (commit 06731c0).
- Multi-fixture safety: GLOBAL safe-Z retract between work offsets (commit
  9979477); verified by qa/003 RETEST PASS 2026-06-20.
- ADR-0026 one-stock-per-setup fail-loud guard (commit e9f3ae4).
- STILL OPEN: DEF-1 (G59.1-.3, blocked on the coordinate track) and Phase D
  (config-form UX + .cps importer).

## 2026-08-04 - Post-7/2 reconciliation (HEAD 4c36467e0)

Additional post milestones shipped on main after the 2026-07-02 entry:

- Portable user-post import and sharing (`fa68f3787`, `282c7cfc3`).
- Cutting-hand spindle control (`a3d895950`).
- Generated-input fingerprint freshness enforcement (`52ac9e3e7`).
- CAM-BINDING Stage 5 machining-boundary face binding and post gate
  (`fb2754f4a`).
- Work-offset assignment per stock (`551b075be`).

Current delivered-vs-not truth remains code plus docs/FEATURE-HITLIST.md. No
test or build gate was rerun for this documentation reconciliation; all older
counts above remain historical evidence for their named commits.
