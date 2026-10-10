# 0015 — 2D Facing operation: scope, boundary-source abstraction, and outward-overrun convention

Date: 2026-06-06
Status: Accepted

## Context

LienCAM has four stable 2.5D operations (contour, pocket, drill, chamfer) and
one in development (adaptive clearing). The `'face'` member already exists in
the `OperationType` union (`src/types/index.ts`) but no params type, worker
route, algorithm, store dispatch, or UI exists for it.

Facing — clearing material off the top of stock to create a flat reference
surface — is the simplest real CAM operation and reuses essentially all
existing infrastructure (geometry→world-loop transform, the standard worker
payload, height/feedrate resolvers, the `moves/` primitives). It is the right
next operation to ship: high user value, low algorithmic risk, no new shared
subsystem.

Two design questions are large enough to constrain future work and must be
recorded before implementation:

1. **What does a face operation cut against?** Real-world facing is
   stock-relative (you face the top of a blank). But the project also wants to
   eventually face selected *model* geometry, and face a *rest* surface left by
   a prior operation (rest machining). These three sources differ in where the
   region polygon comes from, not in how it is filled.

2. **How does a face path relate to its boundary?** A pocket is bounded by
   walls the tool must never cross, so pocket paths offset *inward*. A face has
   no walls — the cutter is expected to *overrun* the region edges so the
   perimeter is fully cleared. This inverts the pocket convention and is a
   recurring source of confusion if left implicit.

The user's directive: build a commercial-grade operation with the full
configuration surface present from day one, deferring implementation of the
advanced surface but never losing track of it.

## Decision

### 1. Boundary-source abstraction (the keystone)

The face operation is **source-agnostic**. It receives a region as an ordinary
world-XY polygon through the existing `loops: LoopData[]` payload channel and
fills it. The decision of *what* to face is resolved in the **store** (payload
preparation), not in the algorithm:

- `boundarySource: 'stock'` — the store synthesizes a boundary polygon from the
  active stock footprint. **Implemented in v1.**
- `boundarySource: 'geometry'` — the store uses the selected geometry loops
  (the existing `geometryId`/`loopIds` path used by every other op). **Deferred.**
- `boundarySource: 'rest'` — the store computes the uncut region from prior
  operations' toolpaths (rest machining). **Deferred**, and explicitly gated on
  rest machining becoming well-controlled elsewhere in the project.

Consequence: adding `geometry` and `rest` sources later is store-only work. The
algorithm and its tests never change. This is the durability the operation is
designed for.

### 2. Outward-overrun convention

Face toolpaths offset the boundary **outward** and extend pass ends **past** the
boundary so the cutter fully clears the perimeter. Specifically, the tool-centre
fill region is the boundary offset outward by `toolRadius` (plus any
`stockOffset`, modulated by `boundaryContainment`), and each pass is extended at
both ends by `passExtension`. This is the deliberate inverse of the pocket inset
convention (ADR context in docs/ARCHITECTURE.md §Operations catalog). No operation
may silently reinterpret this — facing overruns, pocketing insets.

### 3. Full configuration surface, deferred members fail loud

`FaceParams` carries the complete commercial-grade configuration surface from
the first commit. Members not implemented in v1 are present in the type, shown
greyed/disabled in the UI, and — per ADR 0003 (no silent fallbacks) — produce a
**named, fail-loud error** if a project somehow arrives with them set to an
unimplemented value (e.g. `boundarySource: 'rest'`, `pattern: 'spiral'`). A
deferred capability must never silently degrade into a wrong toolpath.

v1-active surface: stock-source facing; linear + zigzag pass patterns;
pass-angle; climb/conventional/both-ways; stepover; pass extension; stock offset;
boundary containment; multi-Z stepdown with per-level direction alternation;
radial + axial stock-to-leave; finish pass; plunge entry; stay-down/retract
linking; straight + smooth transitions; chord tolerance.

Deferred (typed, greyed, fail-loud): `geometry` and `rest` boundary sources;
spiral/contour-parallel pattern; arc lead-in/lead-out; chip thinning;
high-feed/no-contact transitions; avoidance regions (islands/features to keep
clear). The full checklist lives in `src/lib/cam/face2d/STATUS.md` Future
Requirements.

## Alternatives considered

- **Geometry-source first, stock later.** Rejected: facing is fundamentally a
  stock operation; shipping geometry-first would deliver a less useful v1 and
  invert the natural priority. The boundary-source abstraction makes the order a
  free choice, so we pick the one with the highest v1 value.
- **Reuse the pocket algorithm with an inverted offset.** Rejected: pocket's
  concentric-ring fill is wrong for facing's parallel-pass surfacing pattern and
  carries island/helix machinery facing does not need. A dedicated scanline fill
  is simpler and matches commercial face strategies.
- **Only model v1 params, add deferred ones when built.** Rejected: the user
  explicitly wants the complete configuration surface visible from the start so
  the operation reads as a robust system and deferred work cannot be forgotten.
- **No ADR (treat as a per-operation note).** Rejected: the boundary-source
  abstraction and the outward-overrun convention are cross-cutting (they shape
  store payload prep and invert an existing operation convention) and a future
  capability is being designed for today — the three conditions for an ADR per
  docs/CONVENTIONS.md §Architecture Decision Records.

## Consequences

Positive:
- v1 ships a genuinely useful stock-facing operation with low risk.
- `geometry` and `rest` facing become additive store-only work.
- The outward-overrun convention is now explicit and citable.
- Deferred scope is pinned in four places (this ADR, STATUS.md Future
  Requirements, greyed UI, fail-loud guards) so it cannot be silently dropped.

Negative / costs:
- The full `FaceParams` surface carries fields that do nothing in v1, which is a
  deliberate, documented form of forward-design rather than dead code.
- Stock-footprint synthesis adds a new payload-prep path in the store
  (`boundarySource` resolution) that the other operations do not have.

## References

- docs/ARCHITECTURE.md §Operation contract, §Operations catalog, §Worker protocol
- ADR 0001 — toolpath/postprocessor separation (output stays full-precision)
- ADR 0002 — canonical Z vocabulary (face uses the five planes, no new names)
- ADR 0003 — no silent fallbacks (deferred members fail loud)
- ADR 0004 — two-tier feedrate resolver (finish/lead feeds by role)
- `src/lib/cam/face2d/STATUS.md` — milestone tracker and Future Requirements
- `src/lib/cam/pocket2d.ts` — the inset-convention counterexample
