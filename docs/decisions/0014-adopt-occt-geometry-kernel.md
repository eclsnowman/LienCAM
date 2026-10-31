# 0014 — Adopt OCCT as the geometry kernel (opencascade.js custom WASM build, in-worker)

Date: 2026-05-29
Status: Accepted

## Context

The adaptive-clearing linking layer (lead-in/out + wall-follow + fillet + loopback that joins
consecutive ring cuts into one continuous, tangent toolpath) needs **tangent arcs between
curved polylines**. The hand-rolled tangent-arc construction failed by a systematic mechanism:
it inferred adjacency and traversal direction from geometric proximity at link time and
computed tangent points on the *infinite tangent lines* of curves rather than on the curves
themselves. The result was unstable fillet-side selection and ~178° tangent flips at roughly
half the joints. Successive heuristic patches each fixed some transitions and broke others —
the non-convergence that CONVENTIONS §3 names as the signature of a structural, not a tuning,
problem (the failure `toolpath_element_convention.md` predicts).

A chat-side library evaluation + proof-of-concept selected OpenCASCADE (OCCT): its
`ChFi2d_FilletAlgo` is the exact primitive ("arc tangent to two edges … on any curves
including b-splines"), proven in Python (`cadquery-ocp`) to produce a fillet tangent to two
curved polylines at 0.000000 mm gap / 0.0000° tangent mismatch on the previously-broken
transition. The linking algorithm itself is sandbox-validated (`sandbox_22`, `sandbox_23`,
`LINKING-LAYER-HANDOFF.md`); this ADR records only the *runtime/kernel* decision.

LienCAM is client-side-only by product mandate: all toolpath computation runs in a Web Worker,
no backend. The kernel must run there.

## Decision

Adopt **OCCT via `opencascade.js`, compiled as a CUSTOM WebAssembly build, loaded in the
existing Web Worker** (runtime "Option B"). `ChFi2d_FilletAlgo` is the fillet primitive;
`GeomAPI_Interpolate` builds exact C2 BSplines through ring/wall points.

Concretely:
- **Pinned toolchain:** `donalffons/opencascade.js:2.0.0-beta.b5ff984` (single-threaded),
  matching the npm `beta` dist-tag at vendor time.
- **Vendored artifacts:** the build outputs (`occt-fillet.{js,wasm,d.ts}`) and the build config
  (`occt-fillet.yml`) are committed under `src/lib/cam/geometry/occt/vendor/`. Contributors
  build/run the app with no Docker dependency; Docker is needed only to *regenerate* the
  binding. Real artifact size: **2.55 MiB raw / ~1.26 MiB gzip** wasm (vs the prebuilt
  full build's 62.8 MiB / 13.3 MiB gzip — ~10× smaller, the reason the custom build is
  mandatory for a client-side payload).
- **Converged binding set** (authoritative list in `occt-fillet.yml`): `ChFi2d_FilletAlgo`,
  `GeomAPI_Interpolate`, `GeomAPI_ProjectPointOnCurve`, `BRepAdaptor_Curve` (+ its bases
  `Adaptor3d_Curve`, `Standard_Transient` — embind needs the full chain), `BRep_Tool`,
  `BRepBuilderAPI_MakeEdge`, `gp_Pnt/Vec/Dir/Ax2/Ax3/Pln/Circ`, `TColgp_Array1OfPnt`,
  `Handle_TColgp_HArray1OfPnt`, `TopoDS_Edge/Wire/Shape`, `Geom_Curve/Geom_BSplineCurve`,
  `GeomAbs_CurveType`, and a custom helper class `LienGeom`.
- **`LienGeom` helper (additionalCppCode):** `GeomAPI_Interpolate` needs a populated
  `Handle(TColgp_HArray1OfPnt)`, which cannot be constructed from JS (only the `Handle_`
  wrapper is bound; the bare handle-array has no bindable symbol). `LienGeom::interpolateEdge`
  takes a JS-built `TColgp_Array1OfPnt`, builds the handle-array + runs the interpolation in
  C++, and returns a `TopoDS_Edge`. It is a *class listed in the bindings* because
  `additionalCppCode` free functions / manual `EMSCRIPTEN_BINDINGS` get dead-stripped from the
  final module.
- **Arc emission:** `gp_Circ` + `GeomAbs_CurveType` + `BRepAdaptor_Curve.GetType()/.Circle()`
  are bound so fillet results emit as true arcs (center + radius + sense) in Phase 3.

Verified in-WASM through the vendored module (vitest smoke test): fillet parity (radius
3.000000 mm, gap 1.9e-8 mm, tangent 0.000000°) and exact interpolation (input points on the
interpolated curve to 4e-13 mm).

## Alternatives considered

- **Option A — Python geometry sidecar (`cadquery-ocp`).** Rejected: incompatible with the
  client-side-only product mandate (introduces a runtime/IPC boundary into a pure-TS,
  in-worker engine). Also worse for open-source portability (native deps for users).
- **Option C — port the tangent algorithms to TypeScript (no OCCT).** Rejected: this is the
  cobble-half-measures path that produced the original failure, and it forfeits the
  3D/STEP/UI roadmap payoff entirely.
- **`opencascade.js@1.1.1` prebuilt full build.** Rejected despite proving `ChFi2d_FilletAlgo`
  works in it: it lacks `GeomAPI_Interpolate` (forcing lossy `PointsToBSpline` approximation,
  which threatens the exact wall-endpoint contract), ships a 62.8 MiB / 13.3 MiB-gzip
  monolithic wasm with no TypeScript types, and is an unmaintained 2021 / OCCT-7.5-era line.
- **2D-only libraries (cavalier_contours, Clipper2, shapely).** Rejected as non-substitutes:
  none provides the 2D tangent-fillet primitive between arbitrary curves, and none serves the
  B-rep roadmap below — choosing one forces a later rewrite.

## Consequences

- **In-worker WASM load path.** The kernel loads in the Web Worker via the vendored ES6
  module factory; the browser fetches the wasm asset URL. A Node path (inject `wasmBinary` +
  shim `__dirname`/`require`) exists for tests. Worker wiring of the linking algorithm is
  Phase 2 (this ADR lands the kernel + scaffold only).
- **Vendored binary in the repo.** A ~2.6 MB wasm is committed. Deliberate: it keeps the app
  buildable without Docker. Regeneration is reproducible from the pinned image + `occt-fillet.yml`.
- **Substrate-migration direction.** This linking module is the first OCCT-native geometry
  surface. Migration of other stages (ring generation, spiral, clipping; eventually 3D/STEP)
  is **opportunistic, no deadline**; each is its own gated milestone. The FMM region oracle
  stays a grid PDE — domain behaviors *call* OCCT but do not *become* it.
- **License (LGPL).** OCCT is LGPL 2.1 with the Open CASCADE exception; commercial use is
  permitted with no royalties. If LienCAM ever ships closed-source, LGPL wants OCCT
  dynamically linked / replaceable — a non-issue while open-source, but design for it if
  commercializing. The WASM is a separable, regenerable artifact, which fits that constraint.

## References

- `src/lib/cam/geometry/occt/vendor/` — vendored artifacts + `occt-fillet.yml` + build README.
- `src/lib/cam/geometry/occt/` — the TypeScript wrapper (Curve2D, polyline_to_curve,
  sample_curve, curve_length, all-solutions fillet primitive) + worker load path.
- `src/tests/geometry/occt-smoke.test.ts` — in-WASM parity + exact-interpolation proof.
- `src/lib/cam/adaptiveClearing2d/HANDOFF-OCCT-MIGRATION.md`, `LINKING-LAYER-HANDOFF.md`,
  `sandbox_22_occt_endtoend.py`, `sandbox_23_fullchain.py` — the validated linking algorithm
  (ported in Phase 2).
- docs/CONVENTIONS.md §3 "Non-convergence is itself a signal"; `toolpath_element_convention.md`.
- ADR 0001 (toolpath/postprocessor + worker-protocol separation).
