# 0016 — Parametric sketch mode on planegcs

Date: 2026-06-09
Status: Accepted

## Context

ADR-0011 established Sketch mode as a fourth top-level view mode for 2D layer
editing, scoped explicitly as "not parametric: geometry is direct-manipulation,
not constraint-driven." That scoping rejected a full constraint solver as
"substantial additional scope ... not required for the use case."

The use case has since expanded. The user explicitly requires
Standard parametric CAD behavior/feature-based CAD system-style parametric sketching: constraint solving (coincident,
tangent, parallel, perpendicular, horizontal/vertical, equal, concentric,
symmetric, midpoint, point-on-object), driving and reference dimensions, and
live degree-of-freedom feedback (under-defined / fully defined / over-defined
coloring). Direct manipulation alone cannot deliver this; a constraint network
solver is required.

A solver recon (2026-06-09, docs/sketch-mode/PLAN.md section 2.1) found a
production-hardened, license-compatible solver available as a WASM npm package,
removing the original cost objection: the solver does not have to be written,
only integrated.

What has NOT changed: the CAM layer consumes Loop2D/Layer2D geometry through
the operation contract (ADR 0001), and STL-projected layers are point-in-time
snapshots of a projection computation.

## Decision

Build Sketch mode as a PARAMETRIC sketching environment. This supersedes
ADR-0011's "not parametric - direct manipulation only" scope. ADR-0011's other
decisions carry forward unchanged:

- Sketch is a fourth top-level view mode alongside Setup, Toolpath, and
  Simulation, with its own mode badge and mode-specific tool surface.
- STL-projected layers (Layer2D with projectionPlane set) remain READ-ONLY
  snapshots; Sketch mode operates only on DXF/SVG-native and user-created
  layers, enforced in the UI.

The parametric architecture:

1. **Constraint solver: @salusoft89/planegcs.** FreeCAD's PlaneGCS solver
   compiled to WASM with TypeScript annotations. LGPL-2.1+ (dynamic-link
   friendly, same license family as our OCCT usage per ADR 0014). Exposes
   dof(), has_conflicting(), has_redundant(), get_conflicting(),
   get_redundant() — exactly what fully-defined/over-defined UX requires.
   Entities: point, line, circle, arc, ellipse, elliptical arc, B-spline.
   Maintainer risk is mitigated by the package repo doubling as the build
   recipe against FreeCAD upstream; fork-and-own is the documented fallback.

2. **Dedicated web worker.** Solving runs in sketchSolverWorker.ts (mirroring
   the toolpathWorker request/response protocol), keeping the WASM module
   dynamically loaded (LGPL compliance) and the UI thread free. Drag
   interactions use planegcs temporary constraints with debounced solves.

3. **Sketch document model.** A Sketch is a serializable document
   (entities[], constraints[], dimensions[], solveStatus) owned by a geometry
   layer and persisted inside project.geometry[] — it rides the existing
   .camproject persistence with no new storage mechanism. Re-opening a sketch
   restores the full parametric document (non-destructive editing).

4. **Lift / bake boundary.** Editing imported geometry LIFTS Loop2D into
   sketch entities (line/arc segments map 1:1). Finishing a sketch BAKES the
   entities back to Loop2D[] on the owning layer. The CAM layer and the
   operation contract (ADR 0001) never see sketch types — every existing
   operation consumes baked loops with zero changes.

5. **Interaction layer: built in-house to standard parametric CAD behavior conventions.** planegcs is
   headless; all interaction behavior (tool arming, inference snapping,
   smart dimension, definition coloring, constraint glyphs) is implemented in
   our React + Three.js stack per the interaction doctrine in
   docs/sketch-mode/PLAN.md section 3.4.

## Alternatives considered

**SolveSpace / libslvs.** Mature solver, but GPLv3 — including the standalone
libslvs library. Incompatible with shipping LIENCAM under a non-GPL license.
Rejected on license.

**JSketcher.** Web-based parametric sketcher, but its modified MIT license
requires copyright assignment of all modifications and "voids all permissions"
otherwise — a license trap for derived code. Treated as a DESIGN REFERENCE
ONLY; no derived code.

**CADmium / ISOtope.** The CADmium org was archived September 2025. ISOtope
(its solver) is MIT but has minimal constraint coverage, no DoF diagnosis, and
no WASM package. Dead upstream. Rejected.

**chili3d.** AGPL-3.0, and recon found no actual constraint solver in the
codebase. Rejected on both grounds.

**opencascade.js (existing dependency).** Confirmed to have NO 2D geometric
constraint solver — Geom2dGcc is one-shot constrained construction, not a
constraint network solver. Cannot serve.

**Stay non-parametric (keep ADR-0011 scope).** Rejected: the user's required
workflow (constraints, driving dimensions, DoF feedback) is parametric by
definition, and the original cost objection no longer holds now that a proven
LGPL solver exists as a WASM package.

## Consequences

**Positive:**
- Full parametric sketching with ~15 years of FreeCAD solver hardening, for
  integration cost rather than solver-development cost.
- The lift/bake boundary isolates all sketch complexity from the CAM layer;
  operations, the worker protocol, and ADR 0001 are untouched.
- Sketch documents persist in the project file, enabling non-destructive
  re-editing of parametric geometry.
- DoF/conflict diagnostics are first-class solver outputs, so over-constraint
  UX can fail loud with named conflict sets (ADR 0003 spirit).

**Negative:**
- New runtime dependency on a small-maintainer WASM package (mitigated by the
  documented rebuild recipe and fork-and-own fallback).
- A second WASM worker increases bundle size and build surface (planegcs is
  ~880 KB unpacked).
- The in-house interaction layer (snapping, inference, dimension editing,
  constraint glyphs) is substantial UI work that no library provides
  license-clean.
- Bake fidelity (exact arc round-trip to LoopSegment) becomes a correctness
  obligation with dedicated tests.

## References

- docs/sketch-mode/PLAN.md — master plan; sections 2.1 (solver recon), 3.1
  (data model), 3.4 (interaction doctrine), 3.5 (tool inventory)
- ADR 0011 — 2D layer editing tools (Sketch mode); superseded in its
  non-parametric scope, mode and read-only-projection decisions carried forward
- ADR 0001 — toolpath/postprocessor separation; the operation contract the
  bake boundary protects
- ADR 0003 — no silent fallbacks; conflict reporting follows this spirit
- ADR 0014 — OCCT WASM kernel; precedent for LGPL WASM modules in workers
- docs/UI-ARCHITECTURE.md section 4 — view mode system Sketch mode joins
- docs/UI-ARCHITECTURE.md section 7 — properties panel priority cascade the sketch
  toolbox extends
