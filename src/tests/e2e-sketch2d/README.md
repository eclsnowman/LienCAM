# sketch2d-smoke — 2D CAM sketcher real-app harness (WO SKC-6C)

A scripted, re-runnable Playwright harness that drives the REAL 2D CAM
sketcher UI (real mouse clicks on the actual `<canvas>`, real toolbox button
clicks — never the store or a unit-test seam) through its bread-and-butter
flows. Sibling of `tools/smoke/lab3d-smoke.mjs` (same self-heal Chromium
launch, Windows-safe process-tree kill, and per-run `vite` dev server), but
for the 2D sketcher instead of the 3D lab.

## Run it

One command, no prior build required:

```
node src/tests/e2e-sketch2d/sketch2d-smoke.mjs
```

It starts its own `vite --port 4192 --strictPort` dev server, launches
headless Chromium (self-installing the browser binary via
`npx playwright install chromium` on first use if missing, same as
`lab3d-smoke.mjs`), runs all six flows below, writes screenshots +
a run-local capture (`golden-run.local.json`, gitignored) to
`coordination/evidence/SKC-6C/` (seven screenshots, one per flow plus flow
1's post-edit shot), and exits 0 on pass / 1 on any assertion, console/page
error, or golden-gate mismatch. The dev server and browser are always torn
down in the `finally` block.

To re-baseline the COMMITTED golden (`golden-baseline.json`) deliberately:

```
node src/tests/e2e-sketch2d/sketch2d-smoke.mjs --rebaseline
```

This is the ONLY code path that writes the committed file; it prints a
loud warning and a field-by-field diff against whatever was previously
committed. Review that diff before committing the new golden -- an
unexplained drifted field is a finding, not a shrug.

## Why store reads for assertions

The shipped 2D sketch UI has **zero `data-testid` attributes** anywhere in
its toolbox, canvas, or modals (confirmed by grep across
`src/components/panels/sketch/*`, `src/components/viewport/Sketch*.tsx`,
`src/lib/viewport/CNCViewport.ts`) — every selector in this harness is the
visible button label text or a stable className, exactly what a real user
sees and clicks. `window.__cncViewport` (world<->screen projection) and
`window.__camStore` (the live Zustand store) are both unconditionally
exposed in the running app (not test-only stubs) — this harness uses them
ONLY to read state for assertions (dimension values, entity positions,
solve status) and to convert sketch-plane world coordinates into the
screen pixels Playwright's `page.mouse` needs. Every ACTION (drawing,
dimensioning, constraining, dragging, editing, baking, opening the New
Operation modal) happens through genuine `page.mouse`/`page.keyboard`
events on the real DOM, matching the standing rule that store/test-harness
proof must not substitute for real-UI proof.

## No solve/drag-timing hook exists

Traced the full drag/solve path (`CNCViewport` pointer handlers ->
`store.dragSolveSketch`/`solveSketch` -> a real Web Worker `SOLVE_SKETCH`
message). No duration/frame-timing is captured or exposed anywhere. Flow 4
records **wall-clock milliseconds around the drag gesture** as an explicitly
labeled proxy (`dragWallClockMsProxyNotDeterministic` in the golden JSON,
excluded from the determinism check below) — not a real per-solve timing
metric, per the WO's own allowance ("record the frame/solve timing the app
exposes or wall-clock as a proxy — labeled as such").

## The six flows (`sketch2d-smoke.mjs` source order)

1. **Create + dimension.** Draws a rectangle (2-click corner tool), a circle
   (2-click center+rim), a standalone line (2-click), and a second
   freestanding, deliberately non-axis-aligned line (2-click), then adds
   five dimensions with the one "Smart Dim." tool: a length dim on the
   rectangle's bottom edge (`DIM_D`, reused by flow 5), a length dim on the
   rectangle's right edge (`DIM_E`, pins the height so flow 5's width-only
   edit produces a deterministic area), an angle dim between the rectangle's
   bottom edge and the freestanding non-aligned line (`DIM_C`, ~56.3deg — NOT
   the rectangle's own two adjacent sides, which are already perpendicular
   via their Horizontal/Vertical auto-constraints and would make the angle
   dim a REDUNDANT constraint; a redundant angle dimension on the rectangle
   was observed to make its length stop responding to a later edit after a
   bake/re-edit round-trip even though the solver reported no conflict),
   a diameter dim on the
   circle (`DIM_B`), and a length dim on the standalone line (`DIM_A`).
   Edits `DIM_A` 60mm -> 80mm and confirms the line's endpoints moved to
   match.
2. **Constraints.** Two free points merged with Coincident; a diagonal line
   forced Horizontal (dy -> 0); a line + circle forced Tangent
   (center-to-line distance -> radius). Each asserts a real solved
   geometric relationship (not just "no error") AND the real DOM
   definedness/fully-constrained indicator (`SketchDefinitionChip`,
   `.sketch-def-chip`, "N DoF" / "Fully defined" / "Solve failed"): the
   chip's rendered DoF count is cross-checked against the store's
   `sketchSolveStatus.dof`, confirmed not failed, and confirmed to drop by
   the expected amount after each constraint (coincident removes 2 DoF,
   Horizontal and Tangent each remove 1).
3. **Driving vs reference.** Toggles `DIM_A` to reference, then attempts to
   edit its value — asserts the line's length is UNCHANGED (the store's
   `commitDimensionValue` rejects edits on non-driving dimensions; this
   harness proves that rejection is real, not just documented). A
   subsequent driving edit on a DIFFERENT dimension (`DIM_B`, diameter 30 ->
   45) DOES move its geometry, and `DIM_A`'s line is reconfirmed unchanged.
4. **Unconstrained drag.** A freshly placed, unconstrained point is dragged
   via a real `mousedown` -> 8 incremental `mousemove`s -> `mouseup`
   sequence; asserts the final position lands within 0.5mm of the drop
   target.
5. **Downstream CAM check.** Bakes the sketch (Finish sketch), creates a
   Setup (a blank project starts with zero setups) and opens the New
   Operation modal (`contour_2d`, the default/simplest 2D op type),
   switches to its Geometry tab, selects the baked "Sketches" geometry, and
   reads the per-loop area text (`.op-loop-area`) for the rectangle's closed
   loop — both from the DOM and from the store's `project.geometry` loops
   (cross-check; the loop is identified by nearest-area match to an
   expected value passed in fresh each call, since the baked geometry also
   contains the flow-1/flow-2 circles and reusing a stale target would
   match the wrong loop once the rectangle's area moves). Re-enters the
   sketch (`Edit sketch (parametric re-edit)` in the Design Tree), edits
   `DIM_D` 60mm -> 90mm, re-bakes, and confirms the SAME loop's area grew
   from 2400 to 3600 mm^2 (width x `DIM_E`'s pinned 40mm height) in both the
   DOM and the store.
6. **Run-local capture + golden gate.** Every asserted numeric value
   collected across flows 1-5 is assembled into one object and written to a
   RUN-LOCAL file (`golden-run.local.json`, gitignored — never the gate
   truth), excluding the labeled wall-clock timing field. That capture is
   then diffed field-by-field against the COMMITTED golden
   (`golden-baseline.json`) using a per-field tolerance table measured from
   real run-to-run jitter (`TOLERANCES` in the source — all fields
   currently 0, measured bit-identical across 3 consecutive runs on
   2026-07-10). Any field outside its tolerance is a hard failure that
   names the field. The harness NEVER writes the committed golden itself —
   only an explicit `--rebaseline` flag does that (see "Run it" above),
   which is how this gate can actually fail instead of silently
   re-baselining itself every run (BK-90). This is how two consecutive
   runs are proven deterministic (acceptance #2) and it is the file stage
   D's convergence proof will diff against (acceptance #3). Its own end
   state (the final app view at the moment the golden gate runs) is
   screenshotted as `07-baseline-captured.png`.

## `golden-baseline.json` schema

```jsonc
{
  "flow1": {
    "rectangleLine0Length": 60,       // mm, the rectangle's bottom edge (DIM_D's value at creation)
    "rectangleAngleDeg": 56.31,       // deg, angle between the rectangle's bottom edge and the freestanding non-aligned line (DIM_C)
    "circleDiameter": 30,             // mm, DIM_B's value at creation
    "lineL1LengthAfterEdit": 80       // mm, DIM_A's line length after the 60->80 edit
  },
  "flow2": {
    "coincidentGap": 0,               // mm, distance between the two merged points post-solve
    "horizontalDy": 0,                // mm, |dy| of the forced-horizontal line post-solve
    "tangentResidual": 0,             // mm, (center-to-line distance - radius) post-solve
    "dofAfterCoincident": 21,         // sketchSolveStatus.dof after Coincident, cross-checked against the .sketch-def-chip DOM readout
    "dofAfterHorizontal": 20,         // same, after Horizontal (coincident's dof - 1)
    "dofAfterTangent": 19             // same, after Tangent (horizontal's dof - 1)
  },
  "flow3": {
    "referenceDimRejectedEditLength": 80, // mm, DIM_A's line length AFTER the rejected reference edit (unchanged from flow1)
    "drivingDimAppliedDiameter": 45        // mm, circle diameter after DIM_B's driving edit
  },
  "flow4": {
    "dragFinalX": 235, "dragFinalY": 35,   // mm, world position of the dragged free point
    "dragWallClockMsProxyNotDeterministic": 123 // ms, EXCLUDED from the determinism check
  },
  "flow5": {
    "rectLoopAreaBefore": 2400,       // mm^2, baked rectangle loop area (60 x 40) before the sketch edit
    "rectLoopAreaAfter": 3600         // mm^2, same loop's area (90 x 40) after re-baking
  }
}
```

## Placement reasoning

- Harness code lives in `src/tests/e2e-sketch2d/` (no prior e2e directory
  existed in the repo — `tools/smoke/` was considered, but that directory is
  stage-neutral tooling outside this WO's ownership manifest, and
  `src/tests/` is where every other test-shaped artifact already lives).
- Evidence (screenshots + the committed golden JSON) lives in
  `coordination/evidence/SKC-6C/`, per the WO's explicit ownership grant —
  never mixed into the harness source directory.
