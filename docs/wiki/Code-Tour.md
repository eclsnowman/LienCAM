# Code tour

Where things live. Every folder below exists in the repository; paths are relative to the repository root. For how the parts fit together, read the [Architecture overview](Architecture-Overview) first.

## Top level

| Path | What is there |
| --- | --- |
| `src/` | The application |
| `docs/` | Design and reference documents |
| `patches/`, `xtask/`, `Dockerfile` | The patched geometry kernel build ([Geometry kernel build](Geometry-Kernel-Build)) |
| `vendor/` | Vendored WebAssembly packages |
| `electron/` | The desktop app wrapper |
| `site/` | The project web site |
| `tools/release/` | Export, scan, credits and wiki generators ([Releasing](Releasing)) |
| `pendant/` | Machine bridge and pendant code |
| `examples/`, `Example Projects/`, `Sample Parts/` | Files to try |

## Inside src/

| Folder | What is there |
| --- | --- |
| `src/components/` | React components: panels, modals, toolbar, viewport, machine control |
| `src/store/` | The project store, persistence and migrations |
| `src/lib/cam/` | Toolpath operations and the subsystems they share; `toolpathWorker.ts` is the worker entry point |
| `src/lib/cam/geometry/` | The geometry kernel interface |
| `src/cam3d/` | The 3D CAM engine: mesh and STEP input, 3D roughing and finishing strategies, and their workers (`src/cam3d/worker/cam3dWorker.ts`) |
| `src/lib/import/` | The file-import entry point (`importGeometryFile.ts`) and the DXF, SVG, OBJ and IGES importers; STEP and STL readers are in `src/cam3d/input/` |
| `src/lib/post/` | The post-processor: dialects, emitters, setup sheet |
| `src/lib/machine/` | Controller backends, machine definitions, macros, probing |
| `src/lib/simulation/` | Material-removal simulation |
| `src/lib/tool/` | Tool library |
| `src/lib/workholding/` | Fixtures and clamps |
| `src/geom/` | Geometry service and its worker |
| `src/sketch3d/`, `src/form/`, `src/relief/` | The Sketch, Form and Relief workspaces |
| `src/viewport3d/` | The 3D viewport |
| `src/help/` | The in-app Help topics the wiki pages are generated from |
| `src/about/` | The credits data |
| `src/tests/` | The tests, grouped by area |

## Finding your way

- Looking for what a button does: search `src/components/` for its label, then follow the action into `src/store/`.
- Looking for how a toolpath is made: start in `src/lib/cam/toolpathWorker.ts` for 2.5D operations, or `src/cam3d/worker/` for 3D ones, find the operation by its message type, then read its builder.
- Looking for a G-code word: search `src/lib/post/dialects/`.
- Looking for a test: tests sit under `src/tests/` in a folder named for the area, and the file name says what it pins.
