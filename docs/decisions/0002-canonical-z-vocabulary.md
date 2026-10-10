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

## References

- `src/lib/cam/heights.ts` — `resolveHeights` implementation; Phase 1 Commit 1
  (`59b5e5f`)
- docs/ARCHITECTURE.md "Height plane convention" — canonical five-plane diagram,
  mode resolution, absolute Z computation pattern
- docs/ARCHITECTURE.md "Operation contract → Every operation MUST NOT" — Z naming
  rule as a hard constraint
- docs/CONVENTIONS.md "Code conventions → Z-coordinate aliasing" — code-level pattern
  with example snippet
