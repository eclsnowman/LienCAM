# 0017 — Machining orientation is canonical for B-rep derivation

Date: 2026-06-11
Status: Proposed

## Context

The B-rep model kernel (ADR 0018) derives 2D machining data (planar face
loops, hole features, sections) in the MODEL's own coordinate frame — the
orientation the part was drawn in. Commits 659370b/0643ecf made dispatch
apply the user's workspace transform to derived data, but only for
Z-axis-preserving poses (translation + any Z rotation, including flipped
Euler representations). Poses that tilt or flip the model's Z axis are
refused loudly at dispatch ("rotated off the Z axis" / "flipped upside
down"), because Z-plane derives computed in the model frame are invalid
or mirrored in the world frame.

The user (product owner) has dictated the end-state principle:

> The user must be able to orient the model however he wants to apply
> operations. Derivation must be agnostic of the drawn orientation and
> use the orientation the user has dictated as the machining
> orientation. It does not matter how the part was drawn; how it is
> laid out in the machining workspace is what matters.

A part drawn "upside down" or sideways in CAD, then posed flat in the
workspace, must machine exactly like a part drawn flat. The v1 refusal
is a stopgap, not the destination.

## Decision

The MACHINING orientation (the geometry's pose in the workspace) is the
canonical frame for all B-rep derivation. When implemented:

1. The model worker receives the geometry's full pose (rotation +
   position) with each derive request, applies it to the B-rep shape
   (OCCT `TopLoc_Location` / `BRepBuilderAPI_Transform`) and derives in
   the WORLD frame: planar-face detection, hole-axis detection, and
   sectionAtZ all test against WORLD Z, not model Z.
2. Derived layers land world-baked (no `frame: 'geometry_local'` tag,
   no dispatch-time transform); `selectedFaceZ`, `holeBottoms`, and
   section Z become world values end to end. The Section-at-Z UI input
   switches from model coords to world coords (matching the viewport
   scrub handle, which is already world-space).
3. The dispatch-time tilt/flip guards added in 659370b/0643ecf are
   RETIRED — they exist precisely to mark the poses v1 cannot derive;
   orientation-agnostic derivation makes every pose derivable. The
   geometric pose classification helper (`classifyRotationOffZ`,
   rotation-matrix axis-image math in `src/store/dispatchGeo.ts`)
   remains useful for cache keys and re-derive triggers.
4. Re-pose invalidates derives: moving/rotating a geometry marks its
   derived layers stale and triggers (or prompts) re-derivation in the
   new pose, replacing today's mixed regime (transform-at-dispatch for
   Z-preserving poses, refusal otherwise).

Until implementation, new code must not deepen the model-frame
assumption: anything consuming derived Z values or loop coordinates
goes through the existing dispatch helpers, not raw layer data.

## Alternatives considered

- Keep the v1 refusal and require re-importing the model in the
  desired orientation. Rejected by product direction: it pushes a CAM
  concern back into CAD and breaks the "lay out the workspace, then
  machine it" workflow.
- Mirror/transform derived data for the flip case only (z -> -z
  special case at dispatch). Rejected: handles one pose class, leaves
  arbitrary tilts broken, and accumulates per-pose special cases in
  dispatch — the worker-side shape transform solves all poses with one
  mechanism.
- Transform mesh + loops client-side without re-deriving. Rejected:
  hole-axis and planar-face classification are frame-dependent
  decisions made during derivation; transforming their outputs cannot
  reclassify features (e.g. a hole drawn horizontally becomes drillable
  only when the part is posed with the hole vertical).

## Consequences

- Positive: drawn orientation becomes irrelevant; lay-on-face and
  arbitrary posing become first-class machining setups; the tilt/flip
  error states disappear; STL and B-rep flows converge further (STL
  projection already operates on world-space triangles).
- Negative/cost: every re-pose costs a worker re-derive round-trip
  (measured 12-41 ms per derive — acceptable); derived layers must
  track which pose they were derived in; persisted projects carrying
  model-frame layers need migration or forced re-derive on load.
- Opens: multi-setup workflows (same model posed differently per
  setup) become representable later by storing pose per derive.

## References

- ADR 0018 (B-rep model kernel) — the v1 derivation this extends.
- src/store/dispatchGeo.ts — pose classification + transform helpers
  (659370b, fc4650b, 0643ecf).
- docs/brep/HANDOFF.md 2026-06-11 entries — the defect/UX history that
  surfaced this principle.
- User direction recorded 2026-06-11 (this ADR's Context quote).
