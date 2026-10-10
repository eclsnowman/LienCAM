> HISTORICAL - SHIPPED. This handoff records the 2026-06-07 branch session.
> Its branch, HEAD, dirty-tree, test-count, and command details do not describe
> the current repository. For delivered-vs-not use code plus
> docs/FEATURE-HITLIST.md; for mechanical state use fresh git status/log output.
>
# Face 2D — HANDOFF

Cross-session handoff for 2D facing. Pairs with STATUS.md (milestone log) and
ADR 0015 (design of record). Read both before working.

---

## Mechanical state

- **Branch:** `adaptive-clearing-v1`
- **HEAD at update:** `98326d5` — docs: document operation metrics and runtime estimate
  (handoff commit lands on top of this).
- **Working tree:** face2d + progress-reporting files clean. NOTE the repo has a large
  PRE-EXISTING dirty tree of unrelated adaptive-clearing research (modified
  `ringMarch.ts`, `package.json`, deleted AC tests, untracked scripts/fixtures/PNGs).
  None of it is facing- or progress-related. Use explicit `git add <file>` on every
  commit (never `git add -A`) — verified across all 11 commits this session.
- **Tests:** `npx vitest run` → 126 passed + 2 todo (full suite; was 119+2, +7 from the
  new `src/tests/cam/runtime.test.ts`). `face2d.test.ts` = 45 tests green. `npx tsc -b`
  clean. Generation still fast (ms) at all stepovers.
- **Build/test:** `npx tsc -b` (typecheck), `npx vitest run` (tests), `npm run dev`.

---

## What the prior session (2026-06-07, pt 1) delivered — facing bugs FIXED + stretch goal

Started from `db0f34d` with two open bugs on the "Platte C" contour. All resolved:

1. **Bug 2 — zigzag stray diagonal/retract (DONE).** Boustrophedon turns now stay
   DOWN as one continuous cut while the connecting move stays inside the overrun
   envelope (`stayDownEnvR`, grown by `passExt + toolRadius`); retract only when it
   would cross a gap deeper than the tool (a real slot). `cutLevel` /
   `segmentInsideRot`.
2. **Bug 1 — spiral/offset tangle on concave/branched (DONE — the deferred stretch
   goal).** Both ring fills now build a recursive **clipper offset tree**
   (`clipperOffset.ts` + `buildRegionTree`): offset inward with clipper2-wasm
   (round joins, returns the multiple loops a concave region splits into; trims the
   concave-corner overlap a miter offset left), recurse each sub-region. OFFSET cuts
   nested rings; SPIRAL is a true morph spiral per run, sub-regions recursed. No
   concavity gate any more.

Key follow-ups also landed: clipper wasm loads in the Vite worker (`?url` +
`locateFile`); the spiral RESPECTS the user's stepover (an over-aggressive 0.5R
coverage clamp was removed); a vertex-accumulation perf blowup (minutes -> ms) is
fixed by decimating offset rings to ~0.2 mm in `clipperOffset.ts`.

### Known characteristic (not a bug)
A morphed SPIRAL sweeps each annulus once, so on a CONCAVE region its coverage is
stepover-bound — it clears at reasonable stepovers but not arbitrarily coarse ones.
OFFSET/zigzag are the any-stepover guaranteed-coverage choice. A medial-axis /
Fermat spiral would lift this; out of scope. The coverage grid test asserts spiral
on concave at a 2 mm step; offset/zigzag at any step.

---

## This session (2026-06-07, pt 2) delivered: progress reporting + operation metrics

Both features the previous handoff queued are DONE and committed (11 atomic commits,
`0b62073`..`98326d5`). Suite 119+2 -> 126+2; `tsc -b` clean throughout.

**Phase 1 — toolpath progress reporting** (`0b62073`..`46e8682`):
- Protocol `TOOLPATH_PROGRESS { opId, progress 0..1, phase? }` added to
  `WorkerResponseMsg` (`src/lib/cam/types.ts`).
- All six builders take an optional `onProgress(fraction, phase?)` 2nd arg and call
  it at coarse checkpoints (face: per Z level; contour/chamfer: per loop, counted at
  loop TOP so a `continue` still reaches 1.0; drill: per hole; pocket: per Z within
  each boundary; AC: coarse phase ticks only — see deferral below).
- Worker (`toolpathWorker.ts`) builds a THROTTLED `onProgress` (posts only on >=1%
  advance or phase change) and passes it to each builder; posts `TOOLPATH_PROGRESS`.
- Store (`src/store/index.ts`): `op.progress`/`op.progressPhase` on `Operation`;
  `worker.onmessage` handles `TOOLPATH_PROGRESS` and RETURNS WITHOUT terminating the
  worker (critical — the terminate is shared by COMPLETE/ERROR only); progress
  cleared on every terminal path. Batch state `toolpathBatch {total,completed}` set
  by `computeAllToolpaths`, advanced per terminal msg, cleared on the last op.
- UI: DesignTree op-row shows a determinate SVG ring + % (`ProgressRing`), falling
  back to the spinner before the first tick; status bar shows derived
  `Computing…/Compute pending/Ready` + a "Computing toolpaths… N / M" batch strip.

**Phase 2 — operation metrics** (`6aa73bd`..`98326d5`), per the user's "3 things
known about an operation + setup total" request:
- `estimateRuntimeMs(moves, rapidRate)` in NEW `src/lib/cam/runtime.ts` (sum
  segment-length/speed; rapid=machine.rapidRate, feed/arc=move.feed; true arc len;
  Z included). 7 unit tests in `src/tests/cam/runtime.test.ts`.
- `op.estimatedCutTimeMs` computed in the store on COMPLETE (worker payload has NO
  machine config — rate read from `project.machine.rapidRate`, default 5000).
- UI: PropertiesPanel shows "Cut time" + "Computed in" for a ready op; DesignTree
  setup row shows the setup TOTAL cut time. Formatters in NEW `src/lib/format.ts`.

Paired docs updated: docs/ARCHITECTURE.md (§Worker protocol -> Progress reporting +
Operation metrics) and docs/UI-ARCHITECTURE.md (§9.3 rewritten, §15.1 resolved entries).

### WHAT THE NEXT SESSION WISHED IT KNEW

1. **AC progress is a SEAM ONLY, not live.** The store's `computeOperationToolpath`
   does NOT dispatch `adaptive_clearing` — its allow-list (~`store/index.ts:996`) is
   `contour_2d|pocket_2d|drill|chamfer|face` and there is NO AC dispatch branch. The
   worker handles `COMPUTE_ADAPTIVE_CLEARING` but nothing sends it. So the AC
   `onProgress` ticks compile and are correct but are UNREACHABLE until AC is wired
   into the store. Do NOT "fix" AC progress by tweaking the builder — wire dispatch.
2. **A real AC %-calculator is deliberately deferred** (user J4 decision): build the
   plumbing AC pushes into per internal tool (Clipper2/OCCT), but do NOT architect
   the internal % math until the AC planner itself is finished. An operation is not
   "complete" until it reports progress — that's the contract, recorded in
   `project_operation_metrics` memory.
3. **The worker UI is NOT headless-verifiable** — Phase 1/2 visuals (ring, batch
   strip, metrics) are PENDING the user's visual review (see below). Tests cover the
   estimator math and the type/exhaustiveness paths only.

## VISUAL REVIEW PENDING (user is the reviewer)

Run `npm run dev`, load geometry + a face/pocket/contour/drill op:
- **Per-op ring:** Play an op -> spinner becomes a filling ring + %; phase tooltip
  ("Z level 2/4"); flips to green check on finish.
- **Batch strip:** "Generate All" -> status bar shows `Computing toolpaths… N/M`
  with a bar, left label `Computing…`, both clear on completion. Single-op Play
  shows NO strip.
- **Metrics:** select a ready op -> PropertiesPanel "Cut time" + "Computed in";
  setup row shows green total = sum of its ready ops.

## NEXT SESSION candidates (no plan written yet)

- **Optional:** per-op cut-time badge in the DesignTree op row (currently only in
  PropertiesPanel + setup total). Row is crowded; deferred by judgment, not blocked.
- **AC integration** (separate, larger): wire `adaptive_clearing` into
  `computeOperationToolpath` dispatch, then its internal progress %. Belongs to the
  AC build line, not this feature.

---

## Code map (current)

- `src/lib/cam/face2d/index.ts` — `buildFaceToolpath` (entry, depth loop, pattern
  branch, the stepover clamps `maxRingStep = 1.3R` / straight `1.9R`); `cutLevel` +
  `segmentInsideRot` + `linkPasses` (zigzag stay-down/retract); `cutLevelOffset` +
  `buildRegionTree` + `emitOffsetNode` (offset tree); `cutLevelMorphedSpiral` +
  `emitSpiralNode` (morph spiral on the tree); `resampleByArcLength`,
  `rayPointOnRing`, `ringPerimeter`.
- `src/lib/cam/face2d/clipperOffset.ts` — `ensureClipperReady()` (async, worker
  inits before a face op), `offsetLoop(loop, delta)` (signed; round joins;
  decimated; returns split loops), `clipperReady()`.
- `src/store/index.ts` `computeOperationToolpath` — boundary-source resolution
  (stock / geometry / rest fail-loud), spawns a worker per op.
- `src/lib/cam/geometry/index.ts` — `offsetPolygon` (miter, used only for the
  zigzag scan region + envelope), `pointInPolygon`, `ensureCCW`, `centroid`,
  `largestLoop`, `polyBBox`.

## Ground truth
- **Coverage:** `worstUncoveredInPoly` / `worstUncovered` in `face2d.test.ts` — every
  interior point within toolRadius of a cut segment. The no-missing-stock gate.
- **Smoothness / spiral look / "hot mess":** VISUAL only — the user is the judge.
  Re-render in the app (Toolpath -> Simulate, "Simulate Stock Removal" ON).

*Freshness: CURRENT as of 2026-06-07 (pt 2), HEAD 98326d5 (handoff commit lands on
top). Chat-side fields written first-hand by the executing CC session (no separate
chat payload; user works directly with CC).*
