# 0018 — B-rep model kernel: STEP import, face/edge selection, derivation layer

Date: 2026-06-09
Status: Accepted

## Context

LienCAM's 2D operation rollout is nearly complete. All 2D operations consume
`LoopData[]` (world-XY polygons) plus the five canonical heights. Today those
loops come from DXF/SVG import or from slicing/projecting STL meshes — a
workaround docs/UI-ARCHITECTURE.md §6.2 explicitly labels as standing in for "not
yet having B-rep face/edge selection", and §15.6 lists B-rep selection as the
strategic prerequisite for 3D toolpaths.

ADR 0014 adopted OCCT via a custom opencascade.js WASM build (`occt-fillet`,
2.55 MiB) for the adaptive-clearing linking layer, deliberately excluding
STEP import, tessellation, and section bindings ("added opportunistically").
The data model already anticipates this feature: `ImportedGeometry.type`
includes `'brep'`, the store carries `viewer.selectedFaceIds` (unused), and
height-mode enums include `'selected_face'` / `'geometry_face'`.

The question: how to let users import STEP solids and pick faces/edges that
drive the existing 2D operations, without bloating the toolpath worker or
changing the operation contract. Full plan: `docs/brep/PLAN.md`.

## Decision

Five sub-decisions (D1–D5):

**D1 — Second WASM module, not growth of `occt-fillet`.** A new custom build
`occt-model` (own yml, own vendor dir under
`src/lib/cam/geometry/occt/model/vendor/`) carries import + healing +
tessellation + query + section symbols. It loads lazily in a dedicated
"model worker", separate from the toolpath worker. Same pinned Docker image
as ADR 0014 (`donalffons/opencascade.js:2.0.0-beta.b5ff984`),
single-threaded, `-sALLOW_MEMORY_GROWTH=1`, `-fexceptions` (wasm-exceptions
conflicts with OCCT's setjmp usage). Artifacts vendored/committed exactly as
ADR 0014 does; Docker needed only to regenerate.

**D2 — The B-rep shape handle lives only in the model worker's WASM heap.**
It is never serialized. Persistence = cache the original STEP bytes in
IndexedDB (same pattern as `stlCache.ts`) and re-read on project load.
Tessellation buffers (copied out of the WASM heap into fresh typed arrays,
posted with transferables) and derived loops are the only artifacts that
cross the worker boundary.

**D3 — Subshape identity = `TopExp::MapShapes` index order over the healed
shape, fixed at import.** Selections are `{ geoId, kind: 'face' | 'edge',
index }`. The pinned OCCT version makes the order deterministic for the same
STEP bytes; a smoke gate asserts stability across two reads. Re-import
invalidates dependent operations the same way `projectionStale` does today.

**D4 — Derived geometry is stored as `Loop2D` layers on the
`ImportedGeometry`,** exactly like STL projection layers (reuse `layerId`,
`ProjectionPlane`, `projectionStale`). Operations keep consuming loops by ID;
no operation source file changes. The operation contract (payload in,
`ToolpathMove[]` out) is untouched.

**D5 — Non-planar face selected for a 2D operation = typed rejection** (ADR
0003: no silent fallback to projection). Planarity test:
`BRepAdaptor_Surface.GetType() == GeomAbs_Plane`. Cylindrical faces are not
rejected — they are the input to drill-hole detection — but they cannot
source a boundary loop.

## Alternatives considered

- **Grow `occt-fillet` into one kernel.** Simpler ops story, but the toolpath
  worker's hot path would pay a 4–8 MiB load for an import-time feature.
  Rejected; revisit only if the two binding sets converge.
- **`occt-import-js` (import-only, mesh JSON out).** Small and mature, but
  discards the live B-rep handle, which the derivation layer needs for face
  wires, planarity queries, hole detection, and exact sections. Rejected.
- **Full prebuilt opencascade.js.** 62.8 MiB raw / 13.3 MiB gzip; rejected in
  ADR 0014 for the same client-side payload reason, which still holds.
- **Pthreads build for faster STEP reads.** Requires COOP/COEP headers and
  SharedArrayBuffer; ADR 0014 pinned single-threaded for good reasons; the
  model worker + progress messages make read latency acceptable.

## Consequences

- STEP solids become first-class geometry sources; face/edge picks drive
  contour, pocket, drill, chamfer, engrave, face, and adaptive clearing with
  exact loops and correct Z — no manual height entry for picked faces.
- Exact `BRepAlgoAPI_Section` slicing supersedes faceted STL slicing for
  B-rep models, and (Stage 5, deferred) enables per-depth re-sectioning for
  multi-depth passes on tapered walls.
- Two vendored WASM builds must be regenerated when bindings change (Docker
  via WSL on this machine); the embind base-class-chain gotcha documented in
  `vendor/README.md` applies to both.
- Native 3D toolpaths (parallel/waterline) gain their prerequisite: a live
  B-rep in a worker with stable subshape identity.

## References

- `docs/brep/PLAN.md` — staged build plan and recon evidence
- ADR 0014 — OCCT kernel adoption (toolchain, vendoring, embind rules)
- ADR 0003 — no silent fallbacks (D5)
- ADR 0010 — flexible import system
- docs/UI-ARCHITECTURE.md §6.2, §15.6 — the gap this closes
- `src/lib/cam/geometry/occt/vendor/README.md` — build/regeneration notes
