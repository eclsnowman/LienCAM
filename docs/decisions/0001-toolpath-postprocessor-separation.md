# 0001 — Toolpath/postprocessor separation

Date: 2026-05-17
Status: Accepted

## Context

During loopback-v2 spiral development, a C1-continuous biarc infrastructure was
built inside the toolpath layer to achieve smooth path transitions at junctions.
This was solving an acceleration/deceleration continuity concern that belongs to
the postprocessor or the motion controller, not to the operation computing
geometry. The mismatch surfaced clearly when GCode export came up in design
review: operations had accumulated controller-specific logic that would make them
unmaintainable as target controllers multiplied.

Prior state: operations produced geometry coupled to controller assumptions. There
was no formal boundary separating "what geometry to cut" from "how to express
that for a specific machine."

## Decision

Operations (everything in `src/lib/cam/`) produce controller-agnostic
`ToolpathMove[]`: geometry (lines, arcs) with move-type intent (rapid, cut,
plunge, helix, lead_in, etc.) and feeds resolved from project/process settings.

A separate postprocessor (planned, not yet implemented) consumes `ToolpathMove[]`
and produces GCode for a specific controller. All controller-specific concerns
live in the postprocessor:

- GCode dialect (G0/G1/G2/G3, M-codes, comment syntax)
- Formatting (decimal precision, block numbering, line endings, header/footer)
- Acceleration/deceleration ramps if the controller doesn't handle them
- Resolution (arcs vs line segments for legacy controllers)
- Machine-specific preamble, postamble, modal setup

Operations MUST NOT emit M-codes, make controller-specific assumptions, add
acceleration/deceleration math to cut paths, or chunk arcs into line segments.

## Alternatives considered

**All-in-toolpath (status quo before this decision).** Operations produce GCode
directly. Rejected: coupling every operation to specific controllers means adding
a new controller requires touching every operation. Testing operations in isolation
becomes impossible. Smoothing math (like biarcs) accretes in the wrong layer, as
the loopback-v2 incident demonstrated.

**Hybrid with some controller awareness in operations.** "Universal" patterns
(generic smoothing) stay in operations; only truly controller-specific work goes
in the postprocessor. Rejected: the distinction between "universal" and
"controller-specific" is unstable. What looks universal today becomes
controller-specific when a new target is added. The biarc work is exactly this
failure mode materializing.

## Consequences

**Positive:**
- Operations are testable without any controller dependency.
- New controllers require only a new postprocessor; existing operations are
  untouched.
- Toolpath code stays focused on geometry and machining physics.
- `ToolpathMove[]` is a clean, stable contract between planning and output.

**Negative:**
- Every toolpath result is "incomplete" until a postprocessor exists. GCode output
  is blocked until the postprocessor is built.
- Requires holding a two-phase mental model (operations produce; postprocessor
  consumes).
- If the postprocessor needs information `ToolpathMove` doesn't carry, the
  interface must evolve through a deliberate design step.

## References

- docs/ARCHITECTURE.md "Overview" — states this architectural pillar in the second
  paragraph
- docs/ARCHITECTURE.md "Postprocessor boundary (planned)" — full boundary contract
  specification
- docs/ARCHITECTURE.md "Roadmap" item 4 — postprocessor implementation is a planned
  future item (no scheduled phase; begins when GCode export is needed)
- docs/CONVENTIONS.md "Engineering principles" § 2 "Toolpath planning is separate from
  GCode generation" — operational implications for toolpath code; includes the
  "Historical anchor" note documenting the motivating biarc incident
- docs/CONVENTIONS.md "Engineering principles" § 1 "Functional clarity over cosmetic
  perfection" — includes an explicit connection (final paragraph of the Safety
  caveat) that what feels "cosmetic" in the toolpath layer often belongs in the
  postprocessor or controller
