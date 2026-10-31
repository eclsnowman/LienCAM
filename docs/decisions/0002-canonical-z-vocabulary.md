# 0002 — Canonical Z vocabulary across operations

Date: 2026-05-17
Status: Accepted

## Context

Before Phase 1, there was no enforced naming convention for local Z aliases
inside operations. Divergence had accumulated:

- Adaptive clearing used `cutZ` and `safeZ` as local variable names.
- Other operations (contour, pocket, chamfer) used `clearZ`.
- `ACParams` carried a `safeZ` field — operation-specific Z vocabulary leaking
  onto the params interface, violating the layering principle that params describe
  intent, not resolved values.
- AC had a latent bug: `cutZ = heights.bottomHeight` without adding
  `wcsOrigin.z`. The bug only manifested when `wcsOrigin.z != 0`; all AC test
  fixtures used `wcsOrigin.z = 0`, so it never surfaced as a test failure.

The heights resolver subsystem planned for Phase 1 needed a single canonical
output vocabulary to serve all operations without per-operation adapters.

## Decision

Local Z aliases resolved from `HeightParams` follow one pattern: drop "Height"
from the field name, append "Z". No exceptions:

- clearanceHeight → clearanceZ
- retractHeight   → retractZ
- feedHeight      → feedZ
- topHeight       → topZ
- bottomHeight    → bottomZ

These aliases are **resolved values, not interface vocabulary.** They are derived
from `HeightParams` (and `wcsOrigin.z`) inside operations or by shared helpers.
They are NOT params, fields on `<Op>Params`, or fields on other public types
intended as operation inputs.

Operations MUST NOT add operation-specific Z params (`safeZ`, `cutDepth`,
`bridgeZ`, `plungeZ`, `relocationZ`, etc.) on `<Op>Params`. Height vocabulary
lives on `HeightParams`; the canonical aliases (`clearanceZ` etc.) are reserved
for resolved values produced by `resolveHeights` or future shared helpers that
derive from `HeightParams`.

The shared `resolveHeights(heights, wcsOrigin)` function in
`src/lib/cam/heights.ts` produces a `ResolvedHeights` struct with exactly these
five fields, and serves as the canonical resolver. Other shared helpers that
need to expose resolved Z values may use these same names where appropriate.

## Alternatives considered

**Allow operation-specific Z names (status quo).** Each operation uses whatever
names feel natural. Rejected: divergence creates reader confusion, makes shared
subsystems impossible to design without per-operation adapters, and creates
migration debt for every new operation.

**Shorter canonical names throughout (clearZ instead of clearanceZ).** `clearZ`
is mildly ambiguous — "clear of what, clearance plane or cleared material?".
`clearanceZ` is unambiguous and the verbosity cost is minimal. Not adopted.

**Separate vocabulary for raw vs resolved values.** Use `clearanceHeight` for the
raw WCS-relative field, `clearanceZAbs` for the absolute resolved value.
Rejected: operations always work with resolved absolute values after calling the
resolver; there is no reason to carry raw WCS-relative values.

## Consequences

**Positive:**
- `resolveHeights(heights, wcsOrigin)` serves all operations with no adapter.
- Z naming violations are immediately visible in code review (any `safeZ`,
  `cutZ`, `clearZ`, `bridgeZ` in an operation file is a red flag).
- The AC `cutZ` bug (missing `wcsOrigin.z` addition) is eliminated by design —
  the resolver always adds `wcsOrigin.z`.

**Negative:**
- Existing violations required a scheduled migration pass (Phase 1 Commit 1).
  AC's `params.safeZ` and the `cutZ` variable were removed in that commit.
- Future operations with genuinely novel height concepts (e.g., a peck-retract
  height above `retractZ`) must either use the canonical five-plane vocabulary
  or make a case for a new canonical plane — there is no informal escape.

## Amendment 1 (2026-10-23, WO-3083): where an entry starts - one rule for every operation

`feedZ` is no longer where an entry starts by default. Every helix, ramp and plunge
entry starts `ENTRY_CLEARANCE_MM` (1 mm, Pocket's "Helix start above material"
default) above the highest material under its footprint, reached by rapid; the
feed starts there. The rule lives in one place, `src/lib/cam/moves/index.ts`
(`entryStartZ`, `entryStartOver`, `entryStartAlong`, `entryAbove`), and reads the
material as Pocket always did (WO-1972): the remaining stock the earlier
operations left (the highest column over the footprint, padded one cell - too
high, never too low), else the stock block as loaded, else the resolved Top. An
operator whose Feed height sits lower than that start but still above the
material keeps it (the rule never adds air an operator took out). A Feed height
at or below the material no longer rapids into it.

Hops between the features of one operation (holes, loops, orbits, passes) cross
at `retractZ` (moves `hopTo` / `liftTo`); the first entry comes down through
`clearanceZ` and the final exit rises to it. A hop whose own corridor crosses
workholding is lifted by the reach trim (`raiseTraverses`), never by a
setup-wide raise. Builders whose links all ride `clearanceZ` (contour, face) pass
their finished stream through moves `hopsAtRetract`: every rapid AT Clearance
between the first cut and the last becomes a Retract crossing, lifting straight
up first. Drill keeps its retract mode (G98 to the initial plane by default):
its native canned cycle's return plane is the post's. G98 posts R at material
+ 1 and hops at Retract: the stream rises out of each hole to Retract, and the
post crosses to the first hole at Clearance, drops to Retract and starts the
cycle there, so the initial plane G98 returns to IS the hop plane; after G80 it
rises to Clearance, where the stream leaves the op. G99 returns to R between
holes, so its R stays the operator's Feed plane (as before this amendment) -
an R 1 mm over the part would hop the machine there while the stream showed
Retract. A drill hop the reach trim raised over workholding (either mode) is
posted by ending the cycle (G80), crossing at the raised Z and restarting the
cycle in full, so a canned cycle's return plane never crosses a clamp
(post/cannedCycle.ts `liftZ`).

Reason: owner release review 2026-10-23 (example 04, Chamfer 3): "chamfer start
height helix entry is really heigh as well ... This is a common theme across
several operations"; (Drill 1) "We don't need to go that high unless a
reposition move would go over a clamp". Three operations answered "where does
an entry start" three ways: the Feed plane Top + 5 (chamfer, contour, drill,
face, v-carve, thread mill, 3D rough first entry), AT the material after a fed
plunge through 5 mm of air (bore, adaptive clearing 2D - WO-3077), material + 1
(pocket only). A 3 deg chamfer ramp from Top + 5 spent ~95 mm in air per hole.
Proof: `src/tests/cam/helixEntryHeights.wo3083.test.ts` through the production
route on the shipped examples; before/after rows in
`src/tests/evidence/WO-3083/`.

## References

- `src/lib/cam/heights.ts` — `resolveHeights` implementation; Phase 1 Commit 1
  (`59b5e5f`)
- docs/ARCHITECTURE.md "Height plane convention" — canonical five-plane diagram,
  mode resolution, absolute Z computation pattern
- docs/ARCHITECTURE.md "Operation contract → Every operation MUST NOT" — Z naming
  rule as a hard constraint
- docs/CONVENTIONS.md "Code conventions → Z-coordinate aliasing" — code-level pattern
  with example snippet
