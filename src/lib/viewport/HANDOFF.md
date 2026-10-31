# Viewport subsystem - HANDOFF

> MERGED - feat/voxel-sim (stacked on feat/viewport-display-modes) landed on
> main 29db10d; ADR-0028 is Accepted. Every "NOT merged" / "NEXT = merge" line
> below is HISTORY. NOTE: this directory now ALSO carries the sketch overlay
> work (dimensions/text/leaders) - the last ~10 commits touching it are sketch
> dimension/text, tracked in docs/ui-ux/sketch-tools/, not here.

## *** feat/voxel-sim, HEAD 2647732 (2026-06-22, carve HWM+inline session). NOT merged. CURRENT HEAD ***
Verify HEAD with `git log --oneline -3` (expect 2647732, 45f8e27, 496104e).
Two MORE byte-identical carve commits landed this session on top of the 2b7f555 block below:
- `45f8e27` perf(sim): **column high-water-mark (HWM)** carve opt. Track per-(ix,iy)
  column the highest still-non-air iz; stop scanning the already-cleared column top.
  Fixes the dead `cur === -band` early-out (satAir = Math.fround(-band)) and guards the
  HWM update for bounded csgSubtract callers (interior-void carves). columnTop lives on
  VoxelField (Int32Array), re-established to solid on constructor/restore/reset/initStock
  so the SimulationPanel seek-backward (restore -> re-carve) path cannot skip solid voxels.
- `2647732` perf(sim): **inline/no-alloc** hot loop. CPU-profiled the post-HWM carve;
  hoisted per-voxel call+alloc overhead (field.idx(), the voxelCenterWorld {x,y,z}
  ALLOCATION, module clamp()) out byte-identically.

MEASURED on the real A4000 (voxel-profile.mjs, d3d11), carve totals: 1.0mm 1296->1160,
0.5mm 5344->4378, 0.25mm 32552->**11498 (2.83x)**, 0.1mm 32522->**11370 (2.86x)**. The
HWM alone was ~2.0x at fine res (NOT the 3.85x a throwaway had suggested) and ~10-13%
SLOWER at coarse res (cache locality); the inline pass added ~1.4x everywhere and ERASED
the coarse regression. Stopped: the remaining ~29% is the irreducible per-voxel SDF sqrt.
Byte-identical proven (oracle + restore-lifecycle + tight-box regression tests; full gate
green tsc -b + vitest 1966 passed incl. AC fingerprint). PERF-NUMBERS.md updated.

MERGE PLAN (recon 2026-06-22) [EXECUTED - whole stack merged 29db10d; HISTORY]:
feat/voxel-sim is 50 commits ahead of main and STACKED on
feat/viewport-display-modes (which sits at eb6ab2a, NOT merged). Merging voxel-sim -> main
brings BOTH features in as one unit. The stack is gate-green (tsc 0, vitest 1966) and has
NO half-finished/reverted blockers. The ONLY outstanding gate is the display-modes layer's
stock-sim TRUE-VERTICAL-WALL taper fix (commit 00484b6) -- a render-only geometry change
Operator has not yet visually signed off (HANDOFF lines ~247-256; eb6ab2a subject "awaiting
visual gate"). All other gates approved (QA 004 P1-P9 incl. the P8 ViewCube control-move
8ff32cd/01602ec; QA 005 F1-F4 incl. shading 4740cd4; voxel render gate #1). RECOMMENDATION:
get Operator's one-line OK on the taper fix, then merge the WHOLE stack to main (needs his fresh
plain-English OK). No need to split display-modes out first.

POST-MERGE ROADMAP (FEATURE-HITLIST Part 2):
 1. tipAngle convention -- SUPERSEDED by ADR-0029 (feat/tool-angle-convention,
    2026-06-22). v0.4.2 (cd846fd) assumed the stored value was the FULL INCLUDED
    angle and halved it everywhere -- but real data is the FROM-AXIS half-angle, so
    it over-pointed every tool. Canonical is now Tool.angleFromAxisDeg (half-angle,
    no /2 in any consumer); included vs per-side conversion happens at the UI +
    Fusion-import edges; schema v1->v2 migration. See docs/tool_angle_conventions.md.
 2. Thread-mill OPERATION [NEEDS-VISUAL; visualization blocker now resolved by voxel sim;
    helix-interp op not built] -- highest-value next feature. <-- NEXT.
 3. Open-contour 2D op [NEEDS-VISUAL; commit 706e256] -- Operator's "close out 2D ops".
DEFERRED (not merge blockers): voxel Item 7 sparse bricks (only path to true 0.1mm; keep
VOXEL_MAX_VOXELS=8M until then); voxel Item 6 undercut visual gate (capability is unit-
proven); section-view P6/P7 follow-ups [NEEDS-DECISION].

--- prior session block (still valid history) below ---

## *** feat/voxel-sim, HEAD 2b7f555 (2026-06-22, carve-opt session). NOT merged. ***
Verify HEAD with `git log --oneline -3` (expect 2b7f555, 5c23a6e, 430cf45).
Two commits landed this session on top of the prior feat/voxel-sim block below:
- `5c23a6e` feat(sim): partial `texSubImage3D` upload of only the voxel dirty sub-box
  (ADR-0028 Item 5). Correct, render byte-identical. PROFILING PROVED it does NOT
  speed up the full-path carve: the sim calls `sync()` ONCE per scrubber-seek (not
  per move), so full-vs-partial upload is a single event either way. Its real benefit
  is per-frame playback upload bandwidth on weak GPUs (masked by vsync on the A4000).
- `2b7f555` perf(sim): byte-identical CPU carve hot-loop opts -- the REAL bottleneck.
  `markDirty` was 48.6% of CPU (per-voxel AABB marking, ~3.4B times); 87.8% of visited
  voxels were already -band saturated air (no-op writes); `toolProfile` was rebuilt
  per voxel (28.4% of SDF cost). Fixes: batch markDirty per carve point, early-out on
  saturated voxels, hoist toolProfile. Field byte-identical (brute-force `toEqual`
  reference + AC byte-stability fingerprint + all carve tests green).

CORRECTED BOTTLENECK STORY: the prior entry's claim that the full 3D re-upload per
sync was THE perf bottleneck was WRONG/unprofiled. Upload was never the bottleneck
(once-per-seek); CPU carve bookkeeping was. Measured carve speedup = **~2.7x** (a
constant factor, not orders of magnitude): 1.0mm 3,318->1,296ms; 0.5mm 14,287->5,344;
0.25mm 88,116->32,552; 0.1mm 86,651->32,522 (real A4000, see PERF-NUMBERS.md).

BUDGET UNCHANGED at VOXEL_MAX_VOXELS=8M. The carve opt does NOT shrink the field
ALLOCATION; the old 0.1mm crash was a ~126MB 3D-texture allocation. Do NOT raise the
budget on the carve speedup -- raising needs Item 7 (sparse bricks) for allocation.

NEXT PRIORITIES (this session's): (a) per-(ix,iy) column high-water-mark carve opt to
stop re-scanning already-cleared z-ranges (the ~3.4B visit COUNT is unchanged;
algorithmic, must keep the narrow band below the cut refreshing -- profile+gate item);
(b) Item 7 sparse bricks for true 0.1mm ALLOCATION; (c) Item 6 undercut/thread-mill
validation; (d) merge feat/voxel-sim -> main (needs Operator's fresh OK). [(d) DONE 29db10d.]

## feat/voxel-sim, HEAD f633d4f (2026-06-22). NOT merged. Gate green. OPERATOR CONFIRMED RENDER WORKS. (SUPERSEDED by the 2b7f555 entry above)
Branched off feat/viewport-display-modes @eb6ab2a. Replaced the 2.5D heightmap
stock-removal sim with a GPU VOXEL-FIELD engine raymarched in a fragment shader
(ADR-0028, now ACCEPTED) for fidelity + true 3D undercuts + resolution-decoupled
perf. Operator's directive: build the final architecture once, no half-measures.
Dense-backed storage first (sparse bricks deferred behind the VoxelField interface).

OPERATOR GATE #1 PASSED 2026-06-22 ("It works! Looks way better.") - after the post-gate
fixes below. Render validated on his RTX A4000 (and headlessly via ANGLE/D3D11).

ALSO SHIPPED THIS SESSION (on top of Items 1-4):
- USER-SELECTABLE ENGINE + GPU AUTO-FALLBACK (commit 08fbcfe): appSettings.simulationEngine
  = 'auto'|'voxel'|'heightmap' (default 'auto'); Settings -> Stock Simulation dropdown.
  'auto' uses voxel when supported (CNCViewport.supportsVoxelSim() = WebGL2 +
  OES_texture_float_linear) else 2.5D heightmap (console-warned, ADR-0003). The old
  STOCK_SIM_ENGINE const is GONE - read the setting. No schema migration (additive
  appSettings field). This is Operator's "works for everyone / low performance mode".
- PERF PROFILED (commit 231be6d, docs/qa/001 .../PERF-NUMBERS.md, real A4000): heightmap
  light at all res; voxel grows n^3 and the full-re-upload-per-sync dominates (Item 5
  target). 0.1mm at 32M budget CRASHED the GPU.
- BUDGET STOPGAP (commit c95233a): VOXEL_MAX_VOXELS 32M -> 8M (~30MB max field) so 0.1mm
  coarsens to ~0.25mm and can't crash. Verified. RAISE after Item 5.
- DOCS (commit f633d4f): ADR-0028 Accepted + formula fix; UI-ARCHITECTURE §4.3 rewritten
  (dual engine + setting); FEATURE-HITLIST updated (thread-mill VISUALIZATION blocker
  resolved, OPERATION still not built).

NEXT PRIORITY = Item 5 (partial texSubImage3D upload of only the dirty sub-box per
sync) - the perf data proves this is THE bottleneck (full 3D re-upload x ~34k syncs;
88s carve at fine res). It unlocks smooth fine-res playback AND raising the budget
back toward true 0.1mm. Then Item 6 (undercut/thread validation) + Item 7 (sparse
bricks, conditional) + merge feat/voxel-sim -> main (needs Operator's fresh OK).

DONE this session (Items 1-4 of docs/planning/VOXEL-SIM-PLAN.md), each gated
(tsc -b exit 0 + full vitest green, ~1958 passing at HEAD):
- ADR 0028 (Proposed) + plan doc.
- src/lib/simulation/voxel/VoxelField.ts -- dense CPU narrow-band SDF field (planVoxelGrid
  budget/coarsen, idx/world<->voxel, dirty-AABB, snapshot/restore). 26 tests.
- src/lib/simulation/voxel/carve.ts -- 3D swept-volume CSG (toolSdf min(a,b), csgSubtract,
  carveSweep, initSolidStock). 10 tests incl. an UNDERCUT proof. Field value convention:
  value>0 inside solid, <0 air; subtract = min(old, -toolSdf). (NOTE: ADR text's formula
  reads max(old,-dist) for the opposite sign convention -- code is ground truth; fix the
  ADR wording when flipping it to Accepted at Item 8.)
- src/lib/simulation/VoxelSimulator.ts -- driver analogue of HeightmapSimulator. 8 tests.
- src/lib/viewport/voxelSimTexture.ts (Data3DTexture, R32F/Linear, full re-upload on dirty)
  + voxelSimMaterial.ts (GLSL3 raymarch ShaderMaterial: ortho parallel rays, backward-slab
  entry w/ axis-aligned NaN-epsilon guard, 4-iter bisection isosurface, gradient normal,
  4-light Lambert matching the scene, ACES+sRGB, gl_FragDepth compositing -- NO log depth).
  GLSL architect-audited; render is GPU-gated. 6 smoke tests.
- Wired in CNCViewport (initVoxelSim/syncVoxelSim/disposeVoxelSim + render-loop uniform hook,
  base colour --vp-sim-mesh + folded light tokens) and SimulationPanel behind
  STOCK_SIM_ENGINE flag (default 'voxel'; heightmap path preserved byte-identical;
  VOXEL_MAX_VOXELS=32M budget; console.warn on coarsening). 3 visibility tests.

GATE #1 (RENDER): docs/qa/001 - voxel-sim-render-gate/voxel-sim-render-gate.html
(7 verdict items + Pn: export). CAVEAT shown to Operator: judge RENDER quality, not
playback speed.

POST-GATE FIX (commit d1ca596, real-GPU validated): the first gate attempt showed
a SOLID BLOCK that never cut. TWO bugs, both fixed:
  1. The raymarch fragment shader used `projectionMatrix`, which THREE only
     auto-declares in the VERTEX prefix (fragment gets viewMatrix + cameraPosition
     only) -> shader never compiled. Fixed: pass projection*view as a uProjView
     uniform (updateVoxelSimUniforms), used for the gl_FragDepth write.
  2. The heightmap sim mesh was STILL built: SimulationPanel calls
     syncStockSimSurface() (-> initStockSim) to get stock bounds, which also builds
     the opaque heightmap mesh; in voxel mode it's never carved, so it masked the
     voxel volume. Fixed: initVoxelSim now calls disposeStockSim() so the two
     engines never coexist.
The CPU carve was correct the whole time (field-probe: 157k air voxels).

*** BIG TOOLING DISCOVERY: real-GPU bugs CAN be reproduced headless here. ***
tools/capture/voxel-repro.mjs with the `d3d11` backend launches Chromium with
ANGLE --use-angle=d3d11 --enable-gpu, which on this Windows box uses the ACTUAL
NVIDIA RTX A4000 (verified UNMASKED_RENDERER = "ANGLE (NVIDIA ... RTX A4000 ...
D3D11)"), NOT SwiftShader. So the old "GPU artifacts can't repro headless" rule is
only true for the SwiftShader harness (shoot.mjs); the d3d11 ANGLE path reproduces
real-GPU render bugs without Operator. The harness loads a .camproject via the live
store, jumps the scrubber to carve, frames the camera on the stock, screenshots,
and probes field data. REUSE IT for any future sim/render debugging.

NEXT (after gate #1 passes), in order:
- Item 5: PARTIAL texSubImage3D upload (the current full re-upload per frame is the
  perf bottleneck) + PROFILE at 0.1mm + raise/right-size the voxel budget. Then gate #2.
- Item 6: undercut/thread-mill validation -> gate #3.
- Item 7 (conditional, profile-gated): sparse brick pool for large parts @0.1mm.
- Item 8: ADR 0028 -> Accepted; update UI-ARCHITECTURE.md §4.3 + FEATURE-HITLIST
  (voxel sim delivered; undercut limitation resolved); fix the ADR CSG-formula sign note.
- THEN remove the heightmap path + the STOCK_SIM_ENGINE flag once voxel is accepted.

RESOLVED (was "LATENT BUG", recorded docs/planning/POST-MERGE-WORKPLAN.md, commit b7343ab):
the tool-angle convention is settled by ADR-0029 + docs/tool_angle_conventions.md.
The field is now Tool.angleFromAxisDeg (the half-angle from the tool axis); NO
consumer halves it (toolHalfAngleRad only deg->rad converts). Included vs per-side
is converted only at the Tool-Library UI and the Fusion-import edges. The earlier
"tipAngle is the FULL included angle" framing (v0.4.2) was wrong for real data.

## *** feat/viewport-display-modes, HEAD 706e256 (2026-06-21). NOT merged. Gate green. (taper fix; base of feat/voxel-sim) ***
MECHANICAL: branch feat/viewport-display-modes, HEAD 706e256. 10 commits this
work-line (8ff32cd..706e256). Gate at HEAD: `npx tsc -b` exit 0; full `npx vitest run`
-> 1905 passed / 14 skipped (1919). Working tree CLEAN, no stash. NOT merged to main.

LATEST (this session, 2 commits on top of 2c4e8ad):
- 00484b6 feat: TRUE VERTICAL stock-sim hole walls -- the OPEN #1 taper fix is DONE.
  New lib/viewport/stockSimMesh.ts (discontinuity-aware hybrid mesh: 4 corner verts +
  2 tris/cell TOP, plus a vertical wall quad per interior edge that opens only at a
  cliff threshold ~71.6deg; gentle slopes stay smooth+watertight w/ shared corner Z +
  averaged normals, cliffs split the corner and the wall quad fills it). Wired into
  CNCViewport initStockSim/updateStockSimHeights (fixed topology, in-place buffer
  updates, manual normals -- NO computeVertexNormals). DISPLAY-ONLY; carve data
  untouched. 6 pure-math tests. Before/after: docs/qa/simmesh-{before,after}.png.
  AWAITING OPERATOR'S VISUAL GATE (geometry change -> valid on software GL too).
- 706e256 docs(hitlist): track open-contour + thread milling as remaining 2D ops.

## WHAT I WISHED I KNEW AT START (read this first)
1. **GPU-dependent render artifacts do NOT reproduce on the headless SwiftShader
   capture harness** (tools/capture/shoot.mjs default = software GL). This cost TWO
   wrong root-cause theories this session. For any visual artifact Operator reports from
   his real machine, reproduce on a REAL GPU first (Playwright `headless:false`, or
   `headless:'new'` + `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`; verify
   WEBGL UNMASKED_RENDERER != "SwiftShader") or hand it to Operator. See
   [[feedback_real_gpu_for_render_artifacts]].
2. **The "flat-face shimmer" was the STOCK BOX** (Operator said so on turn 1 and was
   right) -- specifically the translucent stock FILL whose top face is coplanar
   (same Z) with the OPAQUE part top; both wrote depth, so the depth test was
   ambiguous per pixel along the part's fan tessellation = radial streaks. Fixed by
   `polygonOffset` on the stock fill (245da8c), Operator-verified.
3. **The capture harness modal dismissal was broken** -- the "Choose a machine"
   modal stayed up and its `.modal-backdrop` scrim DIMMED every screenshot (I kept
   brightness-boosting unviewable shots). Fixed in fd0a147: `dismissMachineModal()`
   in shoot.mjs binds a NON-generic machine via `window.__camStore` and waits for the
   backdrop to detach. REUSE it; do not re-debug.
4. **The tapered sim sidewalls are RENDER-ONLY** (the carve data is a correct
   cylinder, EMPIRICALLY bisected). Do NOT chase the carve engine / toolpath / tool
   profile -- they are correct.

## SUPERSEDED (do not follow)
- The original seed's PRIORITY TASK -- "OCCT fans planar faces into sub-pixel SLIVER
  triangles -> flat-face shimmer; fix via TAA / SSAA / planar re-triangulation" -- is
  **[SUPERSEDED 2026-06-21 - WRONG]**. Measured: planar-face vertex normals are
  already uniform (0.000 deg), the part material/specular is not the cause (matte made
  no difference, reverted), and the real cause was the stock-fill coplanar z-fight
  (245da8c). Do NOT pursue TAA/SSAA for the "shimmer".
- 65781b0 "anti-alias stock-box edges to kill zoom shimmer" was a SwiftShader-driven
  RED HERRING -- the stock EDGES were never the cause (isolation on real GPU: fill-off
  = clean, edges-off = still streaks). The 2px AA edges are harmless and the bolder
  look was Operator-approved, so it stays, but its commit subject overclaims; the REAL
  shimmer fix is 245da8c.

## GROUND TRUTH for this work-line
Operator's real GPU (NVIDIA RTX A4000, D3D11) is the visual gate. The headless SwiftShader
harness CANNOT see depth-fight / specular / coplanar artifacts. Validate render bugs on
a real GPU or hand the artifact to Operator. Matching a static screenshot is NOT enough for
TEMPORAL artifacts (shimmer/crawl) -- they need motion (a real GPU, or Operator).

## REUSE THESE (with friction)
- `tools/capture/shoot.mjs` -> exported `dismissMachineModal(page)`: reliably clears
  the machine modal + scrim (binds a 'capture-machine' via `window.__camStore`, waits
  `.modal-backdrop` detached). FRICTION: default LAUNCH_ARGS force SwiftShader, which
  will NOT reproduce GPU-only artifacts -- launch `headless:false` for those.
- `window.__cncViewport` (set Viewport.tsx:730) = the live CNCViewport instance.
  Reach `.scene/.camera/.controls/.stockGroup/.workpieceGroup`, `.setStockVisible(v)`
  at runtime to isolate render variants by mutating the live scene -- no source edits
  needed (how every real-GPU isolation this session was done).
- `src/lib/viewport/restoreScene.ts` -> `restoreBrepPart()` (shared) + new
  `retessellateBrepParts()` (F3). The B-rep reload path: re-reads cached STEP bytes
  (IndexedDB), re-tessellates at current quality, `addBrepModel` (replaces same-id
  group in place). FRICTION: shape handle lives ONLY in worker memory (ADR 0018 D2),
  re-read every reload; nest-owned seeds are skipped.
- `src/lib/simulation/HeightmapSimulator.ts` `carveWithProfile` is CORRECT (verified by
  synthetic flat plunge = perfect cylinder). The sim taper fix is NOT here.

## WHAT SHIPPED THIS SESSION (8 commits, all gated green)
- 8ff32cd style: display-mode control = bare glowing Boxes icon by the ViewCube.
- 65781b0 fix: AA (Line2) stock-box edges -- RED HERRING for shimmer (see SUPERSEDED).
- fd0a147 chore(capture): reliable machine-modal dismissal (normal-brightness shots).
- 245da8c fix: stock-fill coplanar z-fight -> the REAL flat-face shimmer fix
  (polygonOffset on the stock fill). Operator-verified. DISPLAY-ONLY: toolpaths/stock-data
  unchanged (Operator asked; confirmed -- polygonOffset is a depth-test bias, not geometry).
- abbdab7 style: display-mode icon closer to cube (left 126) + up (bottom 46) + softer glow.
- b29fe53 feat: F3 live B-rep re-tessellation on render-fidelity (quality) change
  (restoreScene reuse + Viewport effect; loop + stale-async guards; 8 tests; docs).
- 490cc8c fix: coplanar z-fight between sim stock mesh and part top (NEGATIVE
  polygonOffset so the sim mesh wins the tie). Operator-verified.
- 2c4e8ad fix: display-mode icon z-index 11->10 (under .sim-panel, not over the bar).

## OPEN (next session) -- priority order
1. **[DONE 2026-06-21, commit 00484b6 -- awaiting Operator's visual gate]** tapered sim
   stock sidewalls (render-only). Fixed by the discontinuity-aware hybrid mesh in
   lib/viewport/stockSimMesh.ts (see LATEST above). The PERF question was resolved by
   keeping a FIXED topology and updating buffers in place (no per-frame realloc).
   If Operator wants tuning: STOCK_SIM_CLIFF_THRESHOLD_FACTOR (default 3 = ~71.6deg) is
   the single knob. Remaining inherent limit: round holes stair-step at grid
   resolution (expected for a heightmap sim).
2. Owed: the architect's own visual audit of the display modes (docs/qa/004 review.html).
3. Merge feat/viewport-display-modes -> main (needs Operator's FRESH plain-English OK; no
   branch surgery without it -- [[feedback_no_branch_surgery_without_fresh_ok]]).
   [DONE - merged to main as part of the voxel-sim stack, 29db10d.]
4. OCCT binding expansion (cee1d8d analysis): recommended first step = STEP/STL export
   + bundle gp_Pnt2d. Deferred (post-v1 modeling is a separate large effort).
5. Cosmetic backlog: model the drill 118deg POINTED bottom in sim (currently flat);
   this is the bottom, NOT the tapered walls (#1).

## OPEN STRATEGIC QUESTION
(RESOLVED) The taper-fix perf approach is settled: fixed topology + in-place buffer
updates, no per-frame realloc. No open strategic question on the sim mesh.

---
Commit at update: c4dae41
Chat-side fields: CURRENT (2026-06-22)
Strategic state: VOXEL SIM (ADR-0028) shipped on feat/voxel-sim + OPERATOR GATE #1 PASSED
("It works! Looks way better."). Engine is default with user setting (Auto/3D/2.5D) +
GPU auto-fallback to 2.5D; both render bugs fixed (d1ca596); perf profiled; 8M budget
stopgap (c95233a) prevents the 0.1mm GPU crash; ADR Accepted + paired docs done.
NEXT = Item 5 (partial texSubImage3D upload - THE perf bottleneck), then Item 6/7,
then merge feat/voxel-sim -> main (NEEDS OPERATOR'S FRESH OK). [MERGE DONE 29db10d -
this NEXT list is history.] Test gate: tsc -b exit 0;
full vitest 1958 passed / 14 skipped. Working tree clean except Operator's untracked
splash/ + docs/planning/SPLASH-SCREEN-PLAN.md (his separate work; NOT this session's).
The older feat/viewport-display-modes taper-fix line (HEAD 706e256, this branch's base)
is still UNMERGED + awaiting its own visual gate + 004 audit.
