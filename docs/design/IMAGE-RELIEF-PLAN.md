# Image relief (picture -> 3D relief on a part) - recon and plan

Asked by Operator ruling 2026-09-28 ~9:40 PM CT: "What would it take to make 3d depth map 2d image to 3d tools
into our software? ... emboss or relief map onto parts in our current modeling environment ... bounded
by sketches as masks ... texture projections onto selected surfaces with smooth edge transitioning ...
tools for image manipulation (contrast, greyscale adjustment, denoising, smoothing, midtone adjustment,
etc) and placement in the model (rotation, sizing, movement). Plus 3d and 2d preview for adjustment of
the depth/height scaling, zero plane clipping, invert depth direction, etc."

Status: RECON AND PLAN ONLY. No product code was changed. Pictures: `src/tests/evidence/RELIEF-RECON/`.

---

## 1. What would it take (the short answer)

About six to eight small stages, each one usable on its own, and no outside product to buy or port.
Almost every hard piece already exists in LienCAM: the Model screen already has a "mode" pattern (Form
swaps the rail and docks a live palette - the relief tool copies it), sketches already give closed
regions we can use as masks, the geometry kernel (OpenCascade) can already build a smooth B-spline
surface from a grid of points, Form already proved we can turn a generated smooth surface into an exact
body that holes, fillets, booleans, STEP export and CAM all accept, and the 3D finishing toolpaths
(parallel, scallop, pencil, waterline) already cut any body the Model screen makes. What we build new
is: the image adjustments (a handful of GPU filters - small), the picture -> height numbers (levels,
zero plane, invert, depth, edge blend - small), the live preview (a displaced grid on the GPU - small),
one new kernel operation that lays the relief surface into the chosen face (the real engineering, and
the thing to measure first), and later wrapping onto round and freeform faces. Optional: an AI "photo
depth" button (Depth Anything V2 Small, Apache-2.0, 26 MB download) for turning a photograph of a real
object into believable depth; ordinary greyscale artwork does not need it.

---

## 2. Reuse vs build

### 2a. Already in LienCAM (reuse, no new licence)

| Piece | Where | What it gives the relief tool |
|---|---|---|
| A tool that swaps the rail and docks a live palette | `src/components/model3d/form/useFormSession.ts:64` (`railSections`), `:393` (`paletteAnchor` - docks top-left of the viewport); page wiring `src/components/model3d/SolidsWorkbenchPage.tsx:21242` (rail swaps to the mode's sections), `:21388` (palette mounts) | The exact shape of the relief mode: rail shows RELIEF sections, palette sits where the Form palette sits |
| The Form palette itself | `src/components/model3d/form/FormPanel.tsx:61-292` (`modal-container` shell, rows of label + `NumericInput` + unit, status block, Cancel / Finish footer); styles `src/components/model3d/form/form.css` (tokens only) | The look to copy: same shell, rows, fonts, colours (measured into `RELIEF-RECON/styles.json`) |
| A slider in the product | `src/components/model3d/section/SectionControls.tsx:74` (`type="range"`) | Precedent for sliders next to number boxes (contrast, denoise, smooth, zero plane) |
| Rail button + feature history | Rail `SolidsWorkbenchPage.tsx:19523-19575` (Create section; the Form button at `:19558`); op list `src/components/model3d/bodyLineage.ts:8-32` (`form` added at `:32`); replay branch for form at `SolidsWorkbenchPage.tsx:8078-8088`; one history step per Finish `useFormSession.ts:152-173` | A new `relief` op slots in the same three places; editing the feature re-opens the tool like Edit Form (`SolidsWorkbenchPage.tsx:19286`) |
| Sketch regions as masks | `src/components/model3d/workbench/sketchProfile.ts:396` (`extractSketchProfile` -> closed regions, open/stray edges tolerated), `profileRegionPicker.ts:159` (click a region in the viewport) | "Mask from sketch" is a region pick we already do for Extrude |
| Face picking | `SolidsWorkbenchPage.tsx:3047` (`selectedFacePickRef`: owner body + face id of the last face click) | "Pick face" for placement |
| Generated smooth surface -> exact body | `src/form/exactStep.ts:206` (writes `B_SPLINE_SURFACE_WITH_KNOTS`), `src/form/formBody.ts:69-99` (`buildFormBody`: STEP text -> `importStep` -> volume check -> faceted fallback with a named reason) | Proven route to an exact relief without rebuilding the kernel |
| Kernel B-spline + face tools | `node_modules/occt-wasm/dist/index.d.ts:382` (`bsplineSurface(controlPoints, rows, cols)`), `:201` (`makeFaceOnSurface(face, wire)` - trim a surface by a wire), `:112` (`split`), `:196-198` (`sew`, `sewAndSolidify`, `buildSolidFromFaces`), `:356-360` (`surfaceType`, `surfaceNormal`, `pointOnSurface`, `uvBounds` - for curved faces); engine `src/geom/worker/geom-engine.ts:4835` (`tessellate`), `:6848` (`importStep`) | Everything the relief kernel op needs is exposed; no occt-wasm rebuild |
| Live material switch without recompiling | `src/lib/viewport/lighting/zebra.ts:21-43` (a uniform flips stripes on/off in every body material) | Pattern for the live preview material (height map in, displaced surface out) and zebra on the relief to judge smoothness |
| Mesh bodies + mesh booleans | `src/components/model3d/workbench/stlModelBody.ts:1-20` (an STL shown as a Model body), `src/mesh/manifoldOps.ts:296` (`booleanMesh`, manifold-3d 3.5.1), `src/mesh/crossDomainBoolean.ts:1-23` (mesh vs exact, labelled approximate) | The fallback route if the exact route is too slow |
| 3D finishing on any Model body | Input `src/cam3d/integration/adaptive3dPartSource.ts:40-93` (a Model body reaches CAM as its display triangles, face ids kept); strategies `src/cam3d/strategies/` (parallel, scallop, pencil, rest, waterline, adaptiveRough); exact drop-cutter `src/cam3d/kernel/dropCutter.ts:1-18`, culled by a grid index `src/cam3d/kernel/bvhKernel.ts:1-30`; finish bounded to picked faces `src/cam3d/integration/parallel3dOperation.ts:444-520` | A relief body is cut by the same ops; "finish only the relief face" already works on exact bodies (not on STL - `parallel3dOperation.ts:451-457`) |
| Imported file bytes kept for replay | `SolidsWorkbenchPage.tsx:16736` (`cacheStep` keyed by a random id on the node payload) | Same pattern stores the relief image |

Size limits found on the CAM side (they matter for a dense relief):
- STEP -> CAM mesh budget 1.5 M triangles, coarsened automatically: `src/cam3d/input/step.ts:27`.
- A Model body reaches CAM as its DISPLAY tessellation with NO triangle cap: `adaptive3dPartSource.ts:40-93`;
  display deflection 0.05 mm by default (`src/lib/cam/geometry/occt/model/quality.ts:20-39`). A fine relief
  face could produce millions of triangles here - stage 6 must cap it.
- Stock field budget 4 M cells: `src/cam3d/stock/zdexel.ts:30`.
- Waterline refuses very large parts up front (32-bit OpenCAMLib): `src/cam3d/integration/waterline3dOperation.ts:130`.
- Form sews every triangle as its own face and is capped at 12,288 (7.5 s): `src/form/formBody.ts:20-28`.
  That route is useless for a relief (millions of triangles) - a relief must be ONE smooth face, not a
  pile of flat ones.

### 2b. Outside tools (licence named; LienCAM is GPL v3, so all of these are usable)

| Tool | Licence | What it would give us | Cost | Risk / verdict |
|---|---|---|---|---|
| Hand-written WebGL2 shaders (three.js already loaded, 0.184) | ours (GPL-3) | Greyscale, levels/midtones, contrast, invert, blur, median denoise, edge-preserving smooth - live on a 2000 x 2000 image | S-M | Bilateral (edge-keeping) smoothing needs care at big radii. RECOMMENDED - no new download |
| OpenCV.js | Apache-2.0 | Every filter imaginable (CLAHE, bilateral, median, morphology) | M | 6-9 MB wasm. Keep as a fallback only if a filter proves hard in shaders |
| image-js | MIT | Basic filters in plain JS | S | Slower on big images. Not needed |
| glfx.js | MIT | Filter-chain reference code (WebGL1) | S as reference | Unmaintained. Read, do not depend |
| jimp | MIT | Basic ops | S | ~1 MB, slow pixel loops. No |
| three.js displacement / our own displaced grid | MIT (in the app) | Instant 3D preview | S | Preview only. RECOMMENDED for preview |
| mapbox/delatin | ISC | Adaptive triangle mesh from a height grid (few triangles where flat, many where detailed) | S | Only for the mesh fallback or a lighter CAM mesh |
| mapbox/martini | ISC | Same, needs 2^k+1 grids, very fast | S | Same |
| fogleman/hmm | MIT | Same algorithm in C++ | M (we would compile it) | delatin is its JS port - use that instead |
| OpenCascade B-spline (`bsplineSurface`, already in occt-wasm 3.6.1) | LGPL-2.1 (already shipped) | The exact relief face | M | Speed at big grids unknown - MEASURE FIRST (stage 1 opens with this). `GeomAPI_PointsToBSplineSurface` is NOT in our binding and is known to ripple on dense grids; we do not need it - we compute control points ourselves |
| Depth Anything V2 Small via transformers.js / onnxruntime-web (WebGPU) | Apache-2.0 (Small only) | Believable depth from a PHOTO of a real object or face | M | Download 18-47 MB (q4f16 18 MB, int8 26 MB, fp16 47 MB - checked on the Hugging Face file list). Base/Large/Giant are CC-BY-NC (non-commercial) - EXCLUDED. Apple Depth Pro: Apple research licence - EXCLUDED. MiDaS (MIT) is a weaker fallback |
| dmap2gcode (Scorch Works) | GPL-3 | Image -> G-code directly (drop the tool onto a height grid) | reference | Proof that "CAM straight from the picture" works; not needed while the body route works |
| pngcam (jes) | open source | Clean reference of drop-cutter on a height grid | reference | Same |

Relief controls describe the height field and its placement directly:
- Depth sets the height range; Raise / Cut in sets its direction from the face.
- Zero plane clips the background; Base offsets the whole relief from the face.
- Edge blend joins the mask to the face; Smooth removes grain and quantisation terraces.
- Invert image reverses the brightness mapping; Fit to face keeps the image proportions.
- Later shape profiles grow height from an outline, and combine modes add, subtract or merge reliefs.

---

## 3. The hard part: laying the picture onto a chosen face, inside a sketch, with a soft edge

Three ways to make the result, compared honestly:

| | (a) Triangle-mesh relief | (b) Exact B-spline relief face sewn into the part | (c) CAM only - no geometry |
|---|---|---|---|
| What it is | Displace a dense grid, boolean it into the part as a mesh | Turn the height grid into one smooth OpenCascade surface, trim it by the mask, replace that part of the face | Keep the picture as numbers; the finishing toolpath drops the cutter straight onto the height grid |
| Stays a real CAD body? | NO. The whole part becomes a mesh (approximate, `crossDomainBoolean.ts:11-17`); holes/fillets afterwards only through the STL edit tools | YES. Holes, fillets, shell, booleans, STEP export all still work; the relief is one face | NO model at all; the Model screen never shows it as geometry |
| Speed | Fast to build; booleans on millions of triangles are slow and memory-hungry | Measured in 3a: 11-60 s build-to-toolpath at 256 x 256; fails at 1024 | Fastest to chips |
| CAM | Works; no face ids, so "finish only the relief" cannot pick the face (`parallel3dOperation.ts:451-457`) | Works; face ids kept, so a finish can be bounded to the relief face | Needs a new toolpath type; nothing else in CAM (stock sim, rest, simulate) knows about it |
| Curved faces | Easy (displace along normals) | Harder (control points along the face's normals) but the same idea | Flat only in practice |
| Fits the operator's ask ("onto parts in our modeling environment") | Partly | Fully | No |

RECOMMENDATION
- Preview, every stage: (a)-style displaced grid drawn on the GPU - instant, never touches the kernel.
- Applied result: (b) exact relief face, flat faces first, then cylinders, then freeform.
- Fallback, decided by the stage 1 measurement: if the exact face is too slow at useful detail, Apply
  builds (a) through the existing mesh-body route and says so in the tree row ("mesh relief").
- (c) only later, and only if CAM on the relief body proves too slow - as a faster finishing engine for
  the same relief, not as a replacement for the model.

How (b) works on a flat face, in plain steps:
1. The picture, after adjustments, becomes a grid of heights (0..1).
2. Placement maps that grid onto the face (size, rotation, position on the face's plane).
3. The mask (a sketch region) and the edge blend multiply the heights: full height well inside, fading
   along the blend profile to exactly zero at the mask edge. Distance to the mask edge comes from a
   distance transform of the mask drawn into the same grid.
4. Heights are sampled onto a control-point grid (capped at 256 x 256 - measured, section 3a) and
   written as explicit poles, read in as a STEP face (`src/relief/reliefStep.ts`; NOT `bsplineSurface`,
   which fits its own surface and was measured running off the part, 3a). A cubic B-spline only "feels" its nearest 4 x 4 control points, so where the blend
   has already brought the heights to zero the surface lies EXACTLY on the face - the relief meets the
   flat face with no step and no seam (the soft edge is real geometry, not a display trick).
5. The face is split by the mask outline (`split`), the inside piece is replaced by the relief surface
   trimmed by the same outline (`makeFaceOnSurface`), and the shell is sewn back into a solid
   (`sewAndSolidify`). "Cut in" is the same with negative heights.
6. The payload keeps the image id and every setting; replay rebuilds it; Edit re-opens the tool.

Curved faces (later stage): the control points are the face's own points pushed out along its normal
(`pointOnSurface` + `surfaceNormal` at a UV grid). Cylinders: "wrap" (the picture follows round, like a
label). Freeform: "project" (the picture shone straight on from a direction, like a slide projector).

Sizes (worked for a 2000 x 2000 picture):
- Picture in memory: 16 MB (RGBA). Each working height buffer (float): 16 MB; three or four stages
  of adjustments on the GPU: ~64 MB of textures - fine on any GPU.
- Full-resolution triangle mesh (route a): 4 M points, 8 M triangles = ~190 MB with normals and
  indices. Too heavy to preview or boolean; that is why the preview uses a 512 x 512 grid (~260 K
  points, ~6 MB) displaced on the GPU with the full picture as a texture.
- Exact face (route b): 2000 x 2000 control points = 4 M x 24 bytes = 96 MB inside the kernel - too
  much. Capped at 512 x 512 = 262 K points (~6 MB). On a 60 mm relief that is one control point every
  0.12 mm, finer than a 1 mm ball nose can follow. Larger reliefs get the same count (coarser pitch) or
  are tiled into several faces (measure first). MEASURED (3a): the cap is 256 x 256 - at 1024 the
  first boolean after it fails inside the kernel.
- CAM mesh of the relief face at 0.05 mm: roughly 0.5-2 M triangles (estimate). MEASURED (3a): the
  exact face meshes to 8 K-444 K triangles at 0.0125 mm; the 10 / mm mesh relief is 0.5-0.9 M.
  The STEP path budget is 1.5 M (`step.ts:27`); the Model-body path has none (`adaptive3dPartSource.ts:40-93`),
  so stage 6 adds a relief-aware cap.

Where it runs:
- Image adjustments: WebGL2 on the page's GPU (sub-frame for 2000 x 2000).
- Height grid, mask distance, control points: a web worker (plain typed arrays; ~100 ms).
- The kernel op: the existing geometry worker (`src/geom/worker/geom-worker.ts`), like every Model op.
- Photo depth: its own worker, WebGPU, model cached after the first download.

### 3a. Measured: the kernel on relief faces (stage 1a, WO-2170)

RECOMMENDATION: EXACT UP TO 256 CONTROL POINTS PER SIDE, MESH ABOVE. At 256, all three fixtures ran
the whole route (build, hole, CAM mesh, Parallel Finish) in 11-60 s. At 512 the bump and the portrait
still ran (23-31 s), but the text sign took 76 s just for its CAM mesh. At 1024 the through-hole cut
failed inside the kernel on all three fixtures, and the kernel was broken afterwards (seen when the
portrait's 128 and 256 ran after it in the same process). So the
kernel's room ends between 512 and 1024; 256 leaves a margin and 512 does not. The mesh route (a)
always finished (16-27 s, 1.5-2.6 GB) and matched the height grid's volume exactly. Stage 1b therefore
builds the exact face up to 256 x 256 and switches to a mesh relief above that. One more rule for
stage 1b: when the exact body's CAM mesh does not close, fall back to the mesh relief; this happened
twice (see finding 4).

The run: `$env:RELIEF_BENCH='1'; npx vitest run src/tests/relief/reliefKernel.test.ts`. It writes
`src/tests/evidence/WO-2170/kernel-times.json`, which is where this table comes from. The box was
Ryzen9WS (AMD Ryzen 9 3900X, 24 threads, 64 GB RAM, Windows 11, Node 25.2.1). I ran it late on
2026-09-28 CT (the last slice at 11:35 PM), in slices chosen with RELIEF_BENCH_CASES / _SIZES / _ROUTES
(each slice merges into the same file). What was measured:
- The part: a 100 x 70 x 15 plate with the relief on its top face.
- The reliefs: a cosine bump (80 x 56 mm, 2.25 mm high, R 25 mm, with a known volume), the portrait
  (43.5 x 56 mm, 1.75 mm deep, 0.2 mm smooth) and the text sign (80 x 40 mm, 1.5 mm, inverted, 0.15 mm
  smooth). Each was faded to the face over 2 mm and sampled on the 10 / mm working grid.
- The hole: a 6 mm through hole on the relief's slope.
- The CAM mesh: made at the D-007 deflection of 0.0125 mm (a quarter of the 0.05 mm CAM tolerance).
- The finish: Parallel Finish (3D) with a 1.6 mm ball at 0.16 mm stepover, over the relief rectangle.
- Each route's steps: (b) explicit poles -> STEP face -> `split` + `sewAndSolidify` into the plate ->
  BREP hand-off to GeomEngine -> GeomEngine.tessellate -> GeomEngine.applyBoolean cut ->
  tessellate -> computeParallel3dMoves through the cam3d worker. (a) working grid -> closed triangle
  mesh -> manifold `booleanMesh` difference -> the same finish.
- "Relief volume error": the relief volume in the body's CAM mesh, against the reference (the
  analytic volume for the bump; the working grid's integral for the pictures).
- "Chord": the largest gap between the CAM mesh and the exact relief surface.
- "Peak memory": the process high-water mark so far in that slice. The kernel's own heap is not
  readable.

| Fixture | Route, size | Build s | Hand-off s | CAM mesh s (triangles, chord mm) | Hole s | CAM mesh after hole s | Parallel Finish s | Peak memory MB | Relief volume error | Result |
|---|---|---|---|---|---|---|---|---|---|---|
| cosine-bump | (a) mesh, grid 801 x 561 | 0.1 (898734 tri) | - | - | 12.1 | 5.1 (894026) | 9.4 | 2586 | 0 % | OK |
| cosine-bump | (b) exact, 128 | 0.6 | 1.8 | 1.1 (7626, 0.00541) | 1.4 | 1.1 (7786) | 1.9 | 2586 | -0.003 % (getVolume -0.0049 %) | OK |
| cosine-bump | (b) exact, 256 | 0.4 | 2.0 | 7.0 (31270, 0.00133) | 2.2 | 5.3 (31272) | 2.6 | 2586 | 0.0003 % (getVolume -0.0046 %) | OK |
| cosine-bump | (b) exact, 512 | 1.5 | 2.0 | 11.0 (31822, 0.00131) | 6.0 | 7.7 (31816) | 2.4 | 3436 | -0.0004 % (getVolume -0.0127 %) | OK |
| cosine-bump | (b) exact, 1024 | 7.0 | 2.2 | 9.3 (20422, 0.00204) | - | - | - | 1673 | -0.0008 % (getVolume -0.0059 %) | FAILED: hole cut trapped in the kernel (memory access out of bounds) |
| cosine-bump | kernel point fit, 64 | 0.4 | | | | | | 233 | -  | FAILED: sewing the relief into the face did not give a valid solid; z -6144.924 .. 5210.160 mm |
| cosine-bump | kernel point fit, 128 | 0.9 | | | | | | 234 | 0.0836 % | OK; z -0.001 .. 2.250 mm |
| cosine-bump | kernel point fit, 256 | 2.0 | | | | | | 259 | 0.0808 % | OK; z -0.001 .. 2.250 mm |
| cosine-bump | kernel point fit, 512 | 6.1 | | | | | | 329 | 0.0694 % | OK; z -0.001 .. 2.250 mm |
| cosine-bump | kernel point fit, 1024 | 16.1 | | | | | | 633 | 0.0839 % | OK; z -0.001 .. 2.250 mm |
| portrait | (a) mesh, grid 436 x 561 | 0.0 (489204 tri) | - | - | 6.3 | 2.4 (484632) | 7.0 | 1529 | 0 % | OK |
| portrait | (b) exact, 128 | 0.1 | 1.6 | 0.8 (52588, 0.02342) | 1.2 | 1.1 (56972) | 2.4 | 4576 | -0.0759 % (getVolume 0.3064 %) | OK |
| portrait | (b) exact, 256 | 0.4 | 2.7 | 1.3 (70604, 0.02641) | 2.6 | 1.5 (72298) | 2.5 | 800 | 0.0018 % (getVolume 0.7708 %) | OK |
| portrait | (b) exact, 512 | 1.8 | 4.4 | 2.8 (88372, 0.02921) | 7.5 | 3.2 (87910) | 2.9 | 2695 | 0.0137 % (getVolume 1.1342 %) | OK |
| portrait | (b) exact, 1024 | 7.4 | 4.7 | 3.1 (84992, 0.0311) | - | - | - | 1518 | 0.0045 % (getVolume 1.8324 %) | FAILED: hole cut trapped in the kernel (table index is out of bounds) |
| portrait | kernel point fit, 128 | 3.8 | | | | | | 4534 | -  | FAILED: the face split into 1 pieces, expected 2; z -0.196 .. 1.735 mm |
| portrait | kernel point fit, 256 | 45.7 | | | | | | 4534 | -  | FAILED: the face split into 1 pieces, expected 2; z -80.678 .. 30.269 mm |
| text-sign | (a) mesh, grid 801 x 401 | 0.0 (642414 tri) | - | - | 7.4 | 3.3 (637522) | 6.3 | 1848 | 0 % | OK |
| text-sign | (b) exact, 128 | 0.5 | 3.1 | 3.6 (169056, 0.06525) | 2.1 | - | - | 1906 | -0.6145 % (getVolume -19.217 %) | FAILED: CAM mesh not watertight: 9 open edges |
| text-sign | (b) exact, 256 | 0.5 | 3.4 | 24.9 (333516, 0.03861) | 3.0 | 22.9 (329966) | 5.4 | 2750 | 0.0506 % (getVolume -1.8146 %) | OK |
| text-sign | (b) exact, 512 | 1.6 | 3.4 | 75.8 (444396, 0.04334) | 6.7 | - | - | 3660 | 0.014 % (getVolume -40.0053 %) | FAILED: CAM mesh not watertight: 9 open edges |
| text-sign | (b) exact, 1024 | 7.9 | 3.8 | 85.6 (444314, 0.04457) | - | - | - | 4209 | 0.0205 % (getVolume -49.8328 %) | FAILED: hole cut trapped in the kernel (table index is out of bounds) |
| text-sign | kernel point fit, 128 | 3.3 | | | | | | 254 | -  | FAILED: the face split into 1 pieces, expected 2; z -0.300 .. 1.770 mm |
| text-sign | kernel point fit, 256 | 31.0 | | | | | | 259 | -  | FAILED: sewing the relief into the face did not give a valid solid; z -0.174 .. 1.605 mm |

What the numbers say (each is a rule for stage 1b):
1. `bsplineSurface(points, rows, cols)` does NOT take control points. It FITS its own surface
   (degree up to 8) through the grid, and on a relief the fit is not safe:
   - The 64 x 64 bump ran off to z -6145 .. +5210 mm.
   - The portrait at 256 ran off to -80 mm, and that fit alone took 46 s.
   - The fitted photo and text dip 0.2-0.3 mm below the face, and even their edges wander.

   The exact route therefore writes explicit poles: a clamped uniform bicubic with each pole at its
   Greville point, read in as a STEP face (`src/relief/reliefStep.ts`, the same route Form uses).
   Because a B-spline stays inside its poles, that surface never dips below the face and lies exactly
   on it wherever the heights are zero. The kernel reads it back point for point (under 1e-9 mm,
   tested).
2. Building the face is cheap (0.4-1.8 s up to 512, 7-8 s at 1024, including an 80 MB STEP text).
   The costly steps are the kernel's CAM tessellation and the boolean.
3. The kernel's `getVolume` misreads a detailed B-spline face. It was right on the bump (within 0.013 %)
   but +0.3 to +1.8 % off on the portrait and -1.8 to -50 % off on the text sign. The geometry itself
   is right: its tessellation matches the poles' closed-form volume. So stage 1b must not use
   getVolume as an acceptance check the way `buildFormBody` does. Mass properties will also misreport
   a relief body.
4. After the hole, the text sign's CAM mesh came out open (9 open edges) at 128 and 512, so Parallel
   Finish rightly refused it. At 256 it closed. The engine meshes face by face
   (`GeomEngine.tessellate`), and the relief/hole seam is where it opens. This needs a follow-up in
   stage 6 (the relief CAM mesh). Until then, an exact relief whose CAM mesh does not close falls
   back to the mesh relief.
5. On detailed art the exact face's CAM mesh misses the 0.0125 mm deflection it asks for: 0.023-0.031
   mm chord on the portrait and 0.039-0.065 mm on the text (0.065 mm at 128 is over the 0.05 mm CAM
   tolerance). The smooth bump meets it. Stage 6's relief-aware CAM mesh should refine to the tolerance
   and measure the result.
6. A kernel that traps is dead afterwards: the next call failed with "null function or function
   signature mismatch". Stage 1b's size cap is what keeps the geometry worker out of that state.
7. Sampling: at 256 poles the relief's volume is within 0.01 % of the working grid on all three
   fixtures. At 128 the text sign loses 0.76 %, because its thin strokes are finer than the 0.64 mm pole
   pitch. 256 per side is a 0.32 mm pitch on an 80 mm relief. Detail finer than that, which the
   standard's 10 / mm grid carries for a 0.8 mm ball, needs the mesh route.

---

## 4. The UI

Principle (Operator ruling 2026-09-27, the Form ruling in `docs/design/FORM-ENVIRONMENT.md:27-53`): modelling
happens in the Model screen. So Relief is a button in the rail's Create section; it enters "relief mode"
inside the Model screen exactly as Form does: the rail swaps to the relief sections, the palette docks
at the viewport's top-left, Apply Relief puts ONE feature in the history, Cancel leaves no trace.

Today's screen (real captures, 1600 x 900, headless, throwaway port 4691):
- `src/tests/evidence/RELIEF-RECON/current-01-model-screen-empty.png`
- `src/tests/evidence/RELIEF-RECON/current-02-model-screen-with-a-body.png`
- `src/tests/evidence/RELIEF-RECON/current-03-display-flyout.png`
- `src/tests/evidence/RELIEF-RECON/current-04-form-palette.png` (the pattern being copied)
- `src/tests/evidence/RELIEF-RECON/current-05-form-rail-crop.png`
- Colours, fonts and rectangles measured from the live page: `src/tests/evidence/RELIEF-RECON/styles.json`

The mockup (built over a real capture, with the measured colours and fonts; the 3D part is a real
three.js render of a relief computed the way section 3 describes):

![Relief tool mockup](../../src/tests/evidence/RELIEF-RECON/mockup/relief-mockup.png)

`src/tests/evidence/RELIEF-RECON/mockup/relief-mockup.png` (source `relief-mockup.html`, rendered by
`render-mockup.mjs`).

Wireframe:

```
+-- LienCAM  New Open Save | Tool Library Setup Sketch [Model] Toolpath Simulate Post | Control Undo --+
| PROJECT MODEL  | +-- Relief - Rose -------- x --+                  +-- Height map [Image|Height|Both]+| MODELING       |
| Origin XY XZ YZ| | IMAGE      brightness=height |                  | +---------------------------+ || RELIEF - IMAGE |
| Plate          | | [thumb] rose.png 1200x1200   |                  | |   ( dashed oval = mask )  | || Open  Paste    |
| Relief 1 (edit)| | [Brightness|Photo depth]     |                  | |  [ picture, grey=height ] | || Photo depth    |
|                | | ADJUST                       |                  | | A-----------------------A | || PLACE          |
| BODIES         | | Greyscale [Luma|R|G|B]       |                  | +---------------------------+ || Pick face Move |
|  Plate         | | [histogram  ^black ^mid ^wht]|   3D VIEWPORT    | Section A-A     /\/\          || Rotate Size    |
|                | | Levels   [12] [1.20] [240]   |                  |  ___________/    \_________ zero|| Fit Mirror     |
| INSPECT ...    | | Contrast ----o----- [+15]    |    +--------------+-------+                       || MASK           |
|                | | Denoise  --o------- [2] px   |   /   . - ~ - .   rotate o  /                      || From sketch    |
|                | | Smooth   ---o------ [1.5] px |  /  ( rose  ^ )  depth ^ /  <- placement frame     || From image     |
|                | | Invert image [ ]             | /    ' - ~ - '   size [] /     (dashed), mask       || No mask        |
|                | | HEIGHT                       |+-----------------------+      (orange dashes)       || PREVIEW        |
|                | | Depth [3.00] mm [Raise|Cut in]|                                                   || 3D  2D map     |
|                | | Zero plane --o---- [18] %    |                                                   || Section Zebra  |
|                | | Base  [0.00] mm above face   |                                                   || Stock ShowCAM  |
|                | | PLACE  on Plate - top face   |                                                   || DOCUMENT       |
|                | | Size [60.00] x [60.00] keep  |                                                   || Undo Redo Save |
|                | | Rotate [15.0] deg Move [0][0]|                                                   ||                |
|                | | MASK AND EDGE                |                                                   ||                |
|                | | Mask [Sketch 2 - Oval   v]   |                                                   ||                |
|                | | Edge blend [6.00] [Smooth|Straight|Round]                                        ||                |
|                | | Preview 600x600, 0.4 s ...   |                                                   ||                |
|                | |          [Cancel] [Apply Relief]                                                 ||                |
+-- console: Relief 1: preview updated - 600 x 600 samples, 0.40 s ------------------------------------------+
```

What each control does, in his words:
- Brightness / Photo depth: light = high (artwork, height maps), or the AI guesses depth from a photo.
- Greyscale: how colour becomes grey (normal brightness, or one colour channel).
- Levels (with the histogram): black point, midtones, white point - pull the midtones up to fatten the
  middle heights, clip the ends to flatten noise.
- Contrast, Denoise (removes speckle, keeps edges), Smooth (softens everything), Invert image.
- Depth: tallest point in mm. Raise / Cut in: stand proud of the face or sink into it.
- Zero plane: everything darker than this % sits flat on the face (Blender's "midlevel").
- Base: lift the whole masked area as a plinth.
- Place: size (lock proportions), rotate, move - by number here, or by dragging the handles on the part
  (corner squares = size, knob = rotate, arrows = move). Fit to face centres and fits it. Mirror flips it.
- Mask: a sketch region on the face (click it, like Extrude), a mask from the picture itself
  (transparent or black background), or none (the whole placement rectangle).
- Edge blend: width in mm and profile (Smooth, Straight, Round) of the fade to the face.
- 2D map: the final heights from above with the mask and blend band drawn on, and a live section line
  with the zero plane. 3D: the part itself, updated as he drags. Zebra works on it (the existing flyout).
- Status line: preview size and time, the highest point, the steepest wall (so he can choose a cutter).
  Information, never a refusal (rule 11).

---

## 5. Staged build plan

Each stage lands on its own, leaves the operator with something he can use, and is proven through the
production entry point (the Model screen, by its buttons) plus focused tests.

| # | Stage | After it, the operator can | Size | Main risk | Proof |
|---|---|---|---|---|---|
| 1 | FLAT-FACE EMBOSS. Opens with a kernel measurement: a relief face at 128 / 256 / 512 control points on a 100 x 70 plate - build, sew, tessellate, one boolean after it, one parallel finish on it - times and triangle counts written into this file. Then: Relief on the rail, pick a flat face, open a PNG/JPG, Fit to face, size/rotate/move by number, Depth, Raise/Cut in, Invert image, Zero plane, Base; live 3D preview + 2D height map; Apply -> one `relief` feature, exact body; Edit re-opens; image stored with the project | Emboss or engrave a logo/picture onto a flat face, export STEP, run 3D finishing on it | L | Kernel speed at fine detail. If 512 is too slow: fall back to route (a) for Apply and say so | Unit tests for height math (levels, zero plane, invert, depth) on small known grids; kernel test: volume of a known relief (a cosine bump) within 0.5%; app capture set via a `RELIEF/shoot.mjs` like Form's; a Parallel Finish (3D) toolpath generated on the relief through the CAM screen's own buttons |
| 2 | IMAGE ADJUSTMENTS. Greyscale channel, levels with histogram (black / mid / white), contrast, denoise (median), smooth (gaussian), edge-keeping smooth, as WebGL2 filters; 2D map shows before/after | Clean up a scanned drawing or a noisy photo inside LienCAM instead of an image editor | M | Edge-keeping smoothing speed at big radius (fallback: OpenCV.js, Apache-2.0, lazy-loaded) | Pixel tests of each filter against a CPU reference on small images; captures of the palette and 2D map before/after |
| 3 | SKETCH MASK + EDGE BLEND. Mask from one or more sketch regions (the Extrude region picker), mask from the picture (transparent / threshold), blend width and profile | Put a picture inside an oval or a shield outline with a soft rolled edge into the face | M | Masks with holes / several islands; blend wider than a thin part of the mask | Distance-transform tests on known shapes; kernel test: surface exactly on the face along the mask edge (max gap under 1e-6 mm); captures incl. zebra on the blend |
| 4 | DRAG HANDLES. On-part move arrows, rotate knob, corner size squares (the existing gizmo pattern `src/components/model3d/gizmos/`), snapping to face centre / edges | Place and size by eye, like the mockup | S-M | Handles fighting the view orbit | Interaction tests on the store; frame-strip capture of a drag (1 fps) |
| 5 | CURVED FACES. Cylinders (wrap around; seam handled), then freeform faces (project from a direction). Mask sketch projected onto the face | A name ring on a round handle, a crest on a domed lid | L | Stretching on freeform faces; the cylinder seam; kernel speed on non-flat surfaces | Kernel tests on a cylinder (wrapped length = arc length), a sphere cap; captures |
| 6 | CAM FOR RELIEFS. Cap the relief face's CAM mesh (it has none today), a finish bounded to the relief face by default, a "smallest ball that reaches the detail" readout in the status line (information only), time the toolpaths | Rough + finish a relief in minutes with a sensible tool | M | Toolpath time on millions of triangles | Toolpath generated and simulated through the CAM screen; triangle count and times recorded; one relief cut on the machine when the operator chooses |
| 7 | PHOTO DEPTH (optional). Depth Anything V2 Small (Apache-2.0) in a worker on WebGPU, downloaded on first use and cached; output feeds the same adjustments | Turn a photo of a face or an object into a believable relief | M | Download size (18-47 MB), WebGPU availability, quality on flat artwork (keep Brightness the default) | Fixed test photo -> depth map compared to a stored result; capture |
| 8 | (only if stage 6 is too slow) CAM STRAIGHT FROM THE HEIGHT GRID: a finishing engine that drops the cutter onto the relief's height grid instead of its triangles | Faster finishing of very large reliefs | M | Keeping it identical to the body it describes | Same toolpath within tolerance as the body route on a test relief |

Suggested order: 1 -> 2 -> 3 -> 6 -> 4 -> 5 -> 7 (8 only if needed). Stage 6 is pulled ahead of the
handles and curved faces because a relief that cannot be cut is not worth anything
(core capability before edge cases).

What each stage touches (for the work orders): new `src/relief/` (non-React core: height math,
filters, mask distance, control points), new `src/components/model3d/relief/` (palette, session hook,
preview), one new op in the geometry worker, and small hub edits in `SolidsWorkbenchPage.tsx` (rail
button, mode switch, palette mount, replay branch) and `bodyLineage.ts` (the `relief` op) - the same
footprint Form took.

---

## 6. Questions for the operator (each has a default we use if he does not answer)

1. The picture is saved INSIDE the project file (the project gets a few MB bigger, but opens anywhere),
   or only linked to the file on disk? DEFAULT: inside.
2. On round and freeform faces, should the picture WRAP around the surface (like a label on a bottle)
   or PROJECT straight on (like a slide projector)? DEFAULT: wrap on cylinders, project on freeform,
   with a switch for both.
3. Photo depth downloads an AI model (about 26 MB) from the internet the first time it is used. Fine,
   or should it ship inside LienCAM (bigger install, works offline)? DEFAULT: download on first use,
   then keep it.

---

## the operator's rulings, 2026-09-28 10:55 PM CT (card "Image relief: do these defaults look right?")

- "Yes - build to these, move photo-depth to stage 3." The stage order is now:
  1 (flat-face emboss, WO-2170 measure + WO-2171 build) -> 2 (image adjustments + step-downs) -> 3 (PHOTO DEPTH, was 7)
  -> 4 (sketch mask + edge blend, was 3) -> 6 (CAM for reliefs) -> drag handles -> curved faces.
  The photo-depth ENGINE (photo in, depth map out, in a worker, model cached) needs no stage-1 screen, so it is built in
  parallel as WO-2173 and wired into the palette after WO-2171 lands.
- NEW - fixed depth STEP-DOWNS: "fixed depth step Downs option for things like lake topography, which is a common 3D
  signage and 3D project concept." The height map snaps to flat terraces: N levels, or a fixed depth per level (e.g. 3
  mm per step), each level a flat floor with vertical (or a chosen draft) walls between - the layered-lake / contour
  sign look. Part of stage 2 (WO-2174).
- NEW - HIGH DETAIL is the target: "high detail 3d for things like coinage and signage", with a link
  (https://forum.makerforums.info/t/create-depth-maps-from-ai-images-for-3d-laser-engraving-with-one-click/89392) and two
  target pictures (dragon medallion and dragon coin - third-party, kept OUTSIDE the repo at
  the private relief reference images). These set the quality bar for photo depth (stage 3) and for
  the working-grid resolution / smoothing defaults: fine scales, crisp leaf edges, no stair-steps, no mush.
