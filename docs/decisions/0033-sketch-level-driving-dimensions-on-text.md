# 0033 — Sketch-level driving dimensions on solver-inert text

Date: 2026-07-02
Status: Proposed

## Context

Sketch text is SOLVER-INERT: only the text anchor is a gcs point; when the
text is bound to a path, its on-path layout is derived per-frame from
`pathId` + `pathOffsetMm` via the arc-length LUT. planegcs has no text
primitive, and the on-path position `s` is not a solver variable — text
layout is a pure render-side derivation.

the operator's T4 verdict (TEXT-REDESIGN-PLAN.md, design D-D, items 8/9/10) asks
for DRIVING position control over text: an along-arc position dimension,
and H/V position dimensions that work on on-path text. Since the quantity
being driven is not a solver variable, these cannot be gcs constraints.

There is precedent: the inert direct-edit ellipse dimensions
(`majorRadius`/`minorRadius`, and the planned focus-to-focus kind) already
bypass gcs — `mapDimension` validates the reference and returns null
(`src/lib/sketch/solver/gcsMapping.ts:375-378`), and
`applyInertEllipseDims` rewrites the entity geometry pre-solve
(`gcsMapping.ts:546-574`). This ADR generalizes that pattern from "dim
edits rewrite SHAPE params" to "dim edits rewrite LAYOUT params" and names
the rules a sketch-level driving dimension must follow.

## Decision

We introduce DRIVING dimensions that are NOT gcs constraints — sketch-level
driving dimensions applied at the store layer, outside the solver:

1. **Along-arc position dimension** (new kind). Value = arc length from the
   align anchor reference to the text anchor. DRIVING it writes
   `pathOffsetMm`, forces `pathAlign='free'`, and LOCKS free dragging of
   the text along the path. Deleting the dimension unlocks dragging.

2. **H/V position dimensions on ON-PATH text.** Driving performs a 1D
   root-find for `s` on the arc-length LUT so the anchor hits the target
   world coordinate. (H/V dims on FREE text are ordinary gcs point
   dimensions via the anchor and are NOT covered by this ADR.)

3. **Root-find outcome rules** (for rule 2):
   - 0 solutions (target unreachable on the path) -> reject loudly with
     the value restored — the same revert flow as `commitDimensionValue`'s
     `pendingDimensionApply`.
   - 2+ solutions -> the solution nearest in `s` to the current position
     wins. Deterministic; the text never jumps across the sketch.

4. **Conflict rules.** Conflicts between a sketch-level dim and any gcs dim
   are impossible BY CONSTRUCTION (they act on disjoint variables). But
   conflicts among sketch-level dims themselves must be rejected at the
   STORE APPLY layer: two driving along-arc dims on one text = the second
   is rejected loudly at creation (ADR-0003; no silent
   last-writer-wins).

5. **Orphan rule.** If the bound path is deleted, `resolveTextPath` already
   reports loudly and the text falls back to free layout; the along-arc dim
   on that text must SURFACE as orphaned (visible error state on the
   dimension), never dangle silently.

6. **Reference dims.** Non-driving H/V and along-arc dims on text are
   display-only re-measurements, exactly like existing reference
   dimensions.

## Alternatives considered

- **Lift text into gcs as a real primitive, with `s` as a solver
  variable.** Rejected: planegcs has no such primitive; emulating one would
  add per-frame LUT constraints of unbounded size; and text layout must
  stay a pure render-side derivation for browser headroom.

- **Forbid driving position dims on on-path text entirely
  (reference-only).** Rejected: the operator's T4 verdict asked for driving
  position control, not just measurement.

- **Make the along-arc dim silently convert the text to FREE text at its
  current position.** Rejected: a silent mode change is exactly the class
  of behavior ADR-0003 forbids.

## Consequences

- **The conflict/DoF/definition-state machinery assumes driving dims are
  solver constraints.** Sketch-level driving dims do NOT participate in gcs
  conflict detection and do NOT count in the DoF ledger; the
  definition-state display treats the text layout as derived state. This
  is the same posture the inert ellipse dims already take.
- Conflict detection among sketch-level dims is OUR responsibility at the
  store apply layer (rule 4) — the solver will never flag them.
- Orphaned along-arc dims are a new visible error state that dim rendering
  must support (rule 5).
- The root-find rules (rule 3) give deterministic, loud behavior for
  unreachable or ambiguous H/V targets on curved paths; tests must cover
  the 0-solution and 2+-solution branches, not just the happy path.
- The inert-dim pattern is now general: future solver-inert entities can
  get driving dimensions by following these rules instead of inventing
  ad-hoc mechanisms.
- Slightly more store-layer wiring per dim kind (apply/reject/unlock
  paths), mirroring ADR-0003's cost of typed failure handling.

## References

- docs/ui-ux/sketch-tools/TEXT-REDESIGN-PLAN.md — design D-D and plan
  items 8 (H/V dims), 9 (along-arc dim), 10 (this ADR)
- `src/lib/sketch/solver/gcsMapping.ts:375-378` — `mapDimension` returns
  null for inert ellipse dim kinds (validated, no gcs constraint)
- `src/lib/sketch/solver/gcsMapping.ts:546-574` — `applyInertEllipseDims`,
  the existing pre-solve direct-edit mechanism this ADR generalizes
- ADR-0003 — no silent fallbacks; governs rules 3, 4, and 5
- ADR-0016 — parametric sketch mode on planegcs (the solver this bypasses)
