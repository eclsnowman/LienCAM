# 0021 - Postprocessor architecture and post-customization/security model

Date: 2026-06-13
Status: Accepted

This ADR is a DRAFT for the operator's review. It records the proposed architecture for the
Group C postprocessor and the post-customization/security model. It depends on
several decisions (D1-D6) that are the operator's to make; those are listed under "Open
decisions" and must be resolved before this ADR is accepted and before any execute
session. Full design: docs/planning/POSTPROCESSOR-DESIGN.md; evidence:
docs/planning/POSTPROCESSOR-RESEARCH.md.

## Context

ADR-0001 established the toolpath/postprocessor separation: operations emit
controller-agnostic `ToolpathMove[]`; a separate postprocessor (deferred, never
built) consumes them and produces controller G-code. No runnable output exists today
- the postprocessor is the hard SHIP GATE for the project (docs/FEATURE-HITLIST.md
Group C).

Recon of the current model (verified in code, main HEAD 280591c) established the
load-bearing facts the architecture must accommodate:

- `ToolpathMove` can express arcs (`arc_cw`/`arc_ccw` + absolute `cx/cy`) but
  operations emit overwhelmingly DENSE POLYLINE `feed` moves; AC flattens even
  helix, loopbacks, and leads. A toleranced arc-collapse stage is required for any
  G2/G3 output.
- Move coordinates are in WORLD/absolute space: `resolveHeights` adds `wcsOrigin.z`
  to Z, and the WCS origin is NEVER applied to move XY. A G-code program must be
  WORK-relative, so the post owns the world->work transform and the G54-G59 / G10
  emission (the emission ADR-0020 explicitly deferred to the post).
- The post's true input is a SETUP (ordered enabled operations + tool/machine/WCS/
  stock context), not the per-operation bare `ToolpathMove[]` that ARCHITECTURE.md
  describes.
- Controllers differ widely (R2 matrix): GRBL has no M6, no canned cycles, only 6
  WCS, and a tight buffer; LinuxCNC is the RS274NGC reference superset.

Because this is a browser app with no backend, letting users customize/edit posts
(which every CAM's users do) raises a security question that desktop CAMs (which run
arbitrary JS posts) never had to answer in a sandboxed way.

## Decision (proposed)

1. **New subsystem `src/lib/post/`** consuming a `PostInput` (a SETUP + resolved
   context) and a `PostConfig` (the dialect), producing a G-code string + diagnostics.
   One-way dependency (ADR-0001): operations never import the post; the post never
   imports operation internals.
2. **Dialect = declarative config + capability flags over a single structured emit
   engine.** Controllers differ in DATA, not forked code; code forks only at genuine
   capability differences (canned-cycle expand vs emit, M6 vs pause), gated by
   capability flags. A USER post is a `PostConfig` (+ optional templates), no new code.
3. **Modal-state machine + per-quantity formatting** at the core (suppress unchanged
   words; force-reset at section boundaries).
4. **The post owns coordinate emission:** transform WORLD moves -> WORK coordinates
   (subtract `wcs.origin`, un-rotate by `wcs` axes), select `G54-G59`, and emit
   secondary per-stock offsets via `G10 L2/L20` (ADR-0020). Rotated WCS FAILS LOUD in
   v1 (ADR-0003).
5. **Program assembly is SETUP-level:** preamble -> per-op section (tool change,
   spindle, coolant, comment, motion) -> postamble. ARCHITECTURE.md's "input is a
   ToolpathMove[]" is corrected to "input is a setup's ordered operations + context."
6. **Toleranced arc-collapse pre-stage** (`post/arcfit/`): runs at post time on the
   move stream (NOT loop-level - AC flattens downstream of `Loop2D.segments`), gated
   by chordal tolerance + per-controller minimum arc radius. OFF for linear-only
   posts; ON for arc-capable posts.
7. **Fail loud (ADR-0003)** on unsupported-but-requested features: missing/duplicate
   tool numbers, rotated WCS, arc output to a non-arc post, a selected op without a
   computed toolpath.
8. **Post customization / security model:** v1 = data/config + restricted, sandboxed
   templates (no arbitrary code execution); built-in posts are vetted code; user
   posts are declarative `PostConfig` + templates persisted in IndexedDB
   (import/export as schema-versioned JSON). Full scriptable posts, if ever added,
   run in a WASM sandbox (quickjs-emscripten) with no host access and the identical
   data-in/string-out contract, so they are additive. A mandatory G-code preview/
   dry-run is part of the contract regardless of sandbox (a post's output is a safety
   artifact).

## Alternatives considered

- **Per-controller forked posts (a separate hand-written module per controller).**
  Rejected: duplicates the modal/format engine N times; the R1 "capability
  negotiation" model (one engine + declared flags) is the maintainable shape.
- **Loop-level arc fitting (populate `Loop2D.segments` upstream).** Rejected as the
  primary mechanism: AC flattens leads/loopbacks/helix DOWNSTREAM of any loop data,
  so only the move stream carries the true final motion. Kept as a future exact-arc
  fast path.
- **Arbitrary-JS posts now (timeline-based CAD/CAM system-style) in the browser.** Rejected for v1: a
  shared post is untrusted code; in-browser arbitrary JS is a sandboxing/provenance
  burden best deferred. The WASM-sandbox path keeps it additive for later.
- **Config-only (no templates).** Rejected as too limited for the routine edits users
  make (conditional preamble, per-move logic); restricted templates cover the
  majority safely.
- **Emitting absolute machine coordinates + G53 (no work offsets).** Rejected:
  contradicts standard operator touch-off workflow and ADR-0020's WCS-as-datum model.

## Consequences

- Unblocks the project ship gate: a real `.nc`/`.gcode` for a chosen controller.
- The GAP LIST (POSTPROCESSOR-DESIGN.md S5) defines small store-side glue
  (`resolveSpindle`, `resolveCoolant`, tool-number validation) and confirms most
  post needs are reads, not move-model changes - ADR-0001 stays intact.
- ARCHITECTURE.md postprocessor section needs an update (input is a setup; world->work
  is the post's job).
- The phased plan (C-P0..C-P5) lets linear output ship before the arc-collapse
  algorithm, de-risking the ship gate.
- Negative: a real coordinate-correctness burden moves to the post (world->work +
  G10); it must be tested against known-origin setups before any machine run.

## Decisions (RESOLVED by Operator ruling 2026-06-13; D7 still open)

- D1 RESOLVED: **UCCNC first** (the controller the operator owns + tests on), then GRBL, then
  LinuxCNC, then additional controller dialects.
- D2 RESOLVED: as recommended - config form + safe sandboxed templates v1;
  WASM-sandboxed full scripts later; mandatory G-code preview regardless.
- D3 RESOLVED: **three dialects first** - UCCNC, GRBL, LinuxCNC (+ generic fallback).
- D4 RESOLVED: linear first (C-P1, UCCNC), arc-collapse immediately after at C-P2
  ("arcs shortly after we prove linear works"); resolution/tolerance are post settings.
- D5 RESOLVED: built-ins + properties form with C-P1; user posts + templates at C-P5.
- D6 RESOLVED: select-only G54 by default (operator touch-off); opt-in G10 L2 write for
  fixtures. UCCNC supports G10 L2 (not L20).
- D7 RESOLVED: post-importer = **static-extract + translate into our PostConfig** for
  v1 (C-P5; parses a third-party `.cps` without running it, ~60-75% auto + a
  three-bucket gap report); "wrap-and-run" the original `.cps` in the WASM sandbox is
  a later C-P6 option.

All decisions D1-D7 are resolved and approved by the operator (2026-06-13); this ADR is
Accepted.

## References

- ADR-0001 - toolpath/postprocessor separation (the governing boundary).
- ADR-0002 - canonical Z vocabulary (resolved heights consumed at post time).
- ADR-0003 - no silent fallbacks (the post's fail-loud rules).
- ADR-0020 - nested coordinate hierarchy (G54-G59 / G10 emission deferred to the post).
- ADR-0005 - recipe/template system (future; the post `properties`/templates align).
- ADR-0007 / ADR-0008 - persistence + user-space storage (where user posts live).
- docs/planning/POSTPROCESSOR-DESIGN.md - full architecture + GAP LIST + phasing.
- docs/planning/POSTPROCESSOR-RESEARCH.md - synthesized evidence + controller matrix.
- docs/planning/research/R1..R4 - raw findings with inline citations.
- docs/ARCHITECTURE.md "Postprocessor boundary (planned)" - to be updated per D5/D5.
