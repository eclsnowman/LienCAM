# 0028 — Voxel stock-removal simulation engine, rendered by raymarching

Date: 2026-06-21
Status: Accepted (2026-06-22)

## Context

The stock-removal simulation (the material-removal preview shown in Simulation
mode) has shipped since early on as a **2.5D heightmap**: a 2D grid storing one
remaining-material top-Z per cell (`src/lib/simulation/HeightmapSimulator.ts`),
rendered as a displaced surface mesh in the viewport
(`src/lib/viewport/CNCViewport.ts` `initStockSim`/`updateStockSimHeights`,
`src/lib/viewport/stockSimMesh.ts`). docs/UI-ARCHITECTURE.md §4.3 documents this
model and its limitation; FEATURE-HITLIST Part 1 lists it delivered.

This model has three coupled ceilings that surfaced together:

1. **No undercuts.** One Z per XY cannot represent threads, T-slots, dovetails,
   or any overhang. Thread milling (a planned op) would render as a plain bore.
   FEATURE-HITLIST Part 2 already flags that "true thread/undercut visualization
   needs a future voxel/dexel sim model."
2. **Fidelity is grid-coupled and the surface stair-steps.** The boundary of a
   feature can only be as crisp as the XY cell size; round holes read as
   polygonal/pixelated from the top. Commit `00484b6` made hole *walls* truly
   vertical (a discontinuity-aware hybrid mesh) but did not — and a heightmap
   cannot — remove the top-down stair-stepping.
3. **Performance is grid-coupled.** The carve runs on the MAIN THREAD, and every
   playback frame re-meshes the whole grid and re-uploads the entire vertex
   buffer (`updateStockSimHeights`). At 0.100mm ("very fine") this is millions of
   cells re-meshed and re-uploaded ~60x/sec even though the tool touched a tiny
   region — playback becomes unusable.

Going to a finer grid multiplies fidelity cost AND per-frame upload cost
simultaneously, so the heightmap cannot deliver fidelity, undercuts, and
performance at the same time. The owner (the operator) directed building the
final-correct architecture once rather than patching the heightmap.

Simulation consumes `ToolpathMove[]` independently of operations and the
postprocessor (ADR-0001), so the engine can be replaced without touching any
operation or post code.

## Decision

Replace the heightmap engine with a **GPU voxel-field stock simulation rendered
by fragment-shader raymarching**.

**Representation.** A 3D scalar field over the stock axis-aligned bounding box,
stored in a WebGL2 3D texture (`THREE.Data3DTexture`). Each voxel stores a
clamped, normalized signed distance to the material surface (a narrow-band SDF)
so the rendered isosurface is sub-voxel smooth rather than blocky. This is true
3D occupancy: undercuts are native.

**Storage interface (`VoxelField`).** A storage abstraction
(`src/lib/simulation/voxel/VoxelField.ts`) owns the 3D texture and exposes:
field dimensions/voxel size derived from stock bounds and a memory budget;
`reset()`; a sub-box write (`texSubImage3D`); CPU `readback()` for tests;
`snapshot()/restore()` for the per-op rest-machining baseline and seek-backward.
The **initial backing is a dense 3D texture**; a sparse brick-pool backing is a
future drop-in behind this same interface (see Consequences). The carve API and
the raymarch render path are final regardless of backing.

**Carve.** The existing tool-profile model `profile(d) -> height-offset-from-tip`
(flat / ball / bull-nose / v-bit, today in `SimulationPanel.toolProfile`) is
lifted into a 3D swept-volume distance function. `carveSweep(field, from, to,
tool)` steps along the move and CSG-subtracts the tool from the field
(`new = min(old, -toolSdf)`, where `toolSdf` is inside-positive — the field
convention is value>0 = inside remaining solid, so subtraction takes the min),
updating ONLY the voxels in the tool's dirty
bounding box. Carve cost scales with the **tool footprint, not stock
resolution** — the core performance change. V1 computes the dirty sub-box on the
CPU (keeping the math in deterministic, unit-testable TypeScript) and uploads it
via `texSubImage3D`.

**Render.** A box mesh for the stock AABB with a custom `ShaderMaterial` that
raymarches the 3D texture per fragment: locate the isosurface crossing, compute
the normal from the field gradient, shade to match the scene lights, and write
`gl_FragDepth` at the hit so the volume composites correctly against the opaque
part, toolpaths, and tool marker. There is NO surface mesh and NO per-frame CPU
re-upload of geometry. Render cost is screen-pixel-bound and independent of grid
resolution; fidelity is therefore decoupled from voxel size.

**Resolution / memory.** Field dimensions derive from the user's resolution
setting (1.0 / 0.5 / 0.25 / 0.1 mm) capped to a voxel-count memory budget. If the
requested resolution would exceed the budget for the current stock size, the
engine coarsens with an explicit, logged notice to the user (ADR-0003: no silent
fallback) rather than silently degrading or crashing.

This decision is **Proposed**; it becomes **Accepted** when the engine passes its
visual gates and is wired in as the default (the heightmap path is kept behind a
temporary toggle until then, then removed).

## Alternatives considered

- **Keep / extend the 2.5D heightmap.** Rejected: structurally cannot represent
  undercuts, and its fidelity and per-frame cost are both bound to grid size, so
  it cannot satisfy all three goals at once.
- **Triple-dexel (solid intervals along X/Y/Z rays).** Handles undercuts and
  stores exact ray crossings, and is the established CPU-side CNC-sim workhorse.
  Rejected as the primary architecture because rendering it still requires
  per-update surface extraction on the CPU — the same main-thread bottleneck the
  heightmap has — and the extracted surface still facets. Raymarching a voxel
  field moves both carve (dirty sub-box) and render (GPU) off the per-frame
  main-thread path and yields a smoother surface.
- **Dense voxels meshed with marching cubes.** Rejected: meshing the whole field
  per update re-introduces the heightmap's per-frame CPU/upload cost, and
  marching cubes either stair-steps or explodes triangle counts at fine
  resolution. Raymarching avoids meshing entirely.
- **Sparse voxels / SDF bricks up front.** Deferred, not rejected: the right
  long-term memory strategy for large parts at 0.100mm, but building novel sparse
  storage AND a novel raymarch renderer simultaneously raises risk and blocks
  early visual gating. Built dense-first behind the `VoxelField` interface so the
  brick backing is a later drop-in with no API or render change (see Consequences).

## Consequences

Positive:
- Undercuts (threads, T-slots, dovetails, overhangs) render as true 3D cuts —
  unblocks faithful thread-mill visualization.
- Surface is sub-voxel smooth (gradient normals); top-down pixelation is gone and
  fidelity no longer tracks grid size.
- Per-frame cost decouples from resolution: carve is tool-footprint-bound, render
  is GPU/screen-bound. 0.100mm playback becomes viable.
- Engine swaps in cleanly under the `ToolpathMove[]` boundary (ADR-0001) — no
  operation or postprocessor change.

Negative / costs:
- Memory is O(n^3) for a dense field; large parts at 0.100mm will require the
  sparse brick-pool backing. That work is deferred and gated on measured need
  (profile-before-optimizing), and is confined to the `VoxelField` backing.
- Custom raymarch `ShaderMaterial` with manual `gl_FragDepth` compositing is the
  highest-risk implementation surface (depth + lighting must agree with the
  three.js scene) and is validated by visual review rather than unit tests.
- The shipped heightmap engine is removed once the voxel engine is gated in;
  during development both coexist behind a toggle.

Follow-on / opened work:
- Sparse brick-pool `VoxelField` backing (conditional, on measured memory need).
- Thread-mill operation visualization now has a sim model that can show it.
- Possible future move of the CPU carve to a GPU fragment pass behind the same
  `carveSweep` API if profiling shows the CPU sub-box carve is hot.

## References

- ADR-0001 — toolpath/postprocessor separation (the clean consumption boundary
  that lets the sim engine be replaced in isolation).
- ADR-0003 — no silent fallbacks (resolution coarsening must be explicit/logged).
- docs/UI-ARCHITECTURE.md §4.3 — current 2.5D simulation model and its limitation
  (to be revised when this lands).
- docs/FEATURE-HITLIST.md — "Stock-removal simulation" (Part 1) and the
  thread-mill/undercut sim caveat (Part 2).
- docs/planning/VOXEL-SIM-PLAN.md — the staged implementation plan.
- `src/lib/simulation/HeightmapSimulator.ts`, `src/lib/viewport/stockSimMesh.ts`,
  `src/components/simulation/SimulationPanel.tsx` — the engine being replaced.
- Commit `00484b6` — the vertical-wall hybrid mesh that motivated confronting the
  heightmap's structural ceiling.

## Status update (2026-06-22, Accepted)

The voxel engine was implemented, validated on a real GPU (NVIDIA RTX A4000 via
ANGLE/D3D11), and shipped. This ADR moves from Proposed to Accepted.

**Shipped as the default, behind a user setting with GPU auto-fallback.** The
full stack landed — `VoxelField` (dense CPU storage) + `carve`/`carveSweep` +
`VoxelSimulator` adapter + `VoxelSimTexture` + the raymarch `ShaderMaterial` —
wired into `CNCViewport` and `SimulationPanel`. It renders true 3D stock removal
including undercuts. The engine is selected by a new
`appSettings.simulationEngine = 'auto' | 'voxel' | 'heightmap'` (default
`'auto'`), exposed in Settings -> Stock Simulation. `'auto'` uses the voxel
engine when the GPU supports it (WebGL2 + `OES_texture_float_linear`, detected by
`CNCViewport.supportsVoxelSim()`) and otherwise falls back to the 2.5D heightmap
with a console warning (ADR-0003: explicit, logged fallback — not silent). The
heightmap engine is therefore RETAINED as the lightweight fallback, not removed
as the original Decision anticipated.

**Render-bug fixes (commit `d1ca596`).** Two defects blocked the carve from being
visible and were fixed: the raymarch shader referenced `projectionMatrix`, which
three.js does not supply to fragment shaders; and the heightmap displacement mesh
was masking the voxel volume. Both surfaced only on a real GPU — the headless
SwiftShader harness did not reproduce them.

**Performance findings (see PERF-NUMBERS.md).** The 2.5D heightmap is light at
every resolution (<=3 MB, <=2 s to carve a full ~34k-move path even at 0.1mm).
The voxel engine is far heavier and grows with volume (O(n^3)): comfortable at
0.5mm on a strong GPU, slow to carve at 0.25mm, and at 0.1mm it CRASHED the GPU
process at the original 32M-voxel budget. As a safety stopgap the voxel budget
was lowered to 8M so `auto`/`voxel` cannot attempt a crash-inducing 0.1mm field.
The dominant voxel cost is the full-texture re-upload on every carve sync (V1).

**Carve-opt update (2026-06-22).** Profiling on a real A4000 corrected the
"dominant cost is the full-texture re-upload per sync" note above: that claim was
unprofiled and wrong. The sim calls `sync()` once per scrubber-seek (not per move),
so the upload is a single event per seek and was never the full-path-carve
bottleneck. The real bottleneck was CPU carve bookkeeping; a byte-identical
hot-loop optimization (`markDirty` batched per carve point, early-out on saturated
voxels, hoisted `toolProfile`) gave a measured **~2.7x** carve speedup -- a
constant factor, not orders of magnitude. The budget stays at 8M: the carve opt
does not shrink the field ALLOCATION, so true 0.1mm remains allocation-bound and
still needs Item 7.

**Remaining follow-ups:**
- Item 5 — partial `texSubImage3D` upload of only the dirty sub-box — **DONE**
  (commit `5c23a6e`), render byte-identical. NOTE: profiling showed this was NOT
  the carve bottleneck (sync is once-per-seek, not per move); its benefit is
  per-frame playback upload bandwidth on weak GPUs. The real full-path-carve win
  came from the CPU carve hot-loop opt (commit `2b7f555`, ~2.7x measured,
  byte-identical).
- Item 7 — sparse brick-pool `VoxelField` backing, required for a true 0.1mm
  field without exhausting VRAM. This is the allocation-bound path to true 0.1mm;
  the carve speedup does not change it.
- Carve micro-opt (not done): a per-(ix,iy) column high-water-mark to skip
  re-scanning already-cleared z-ranges (the ~3.4B per-voxel visit count is
  unchanged by the hot-loop opt). Algorithmic; future profile+gate item.

See `docs/qa/001 - voxel-sim-render-gate/PERF-NUMBERS.md` for the full
measurement table and hardware-requirement guidance.
