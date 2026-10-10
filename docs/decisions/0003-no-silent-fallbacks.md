# 0003 — No silent fallbacks for specialized strategies

Date: 2026-05-17
Status: Accepted

## Context

Silent strategy fallbacks are a real temptation during incremental development.
The adaptive clearing planner demonstrates this concretely: `planner.ts` lines
264–267 (commit `bc0a6af`, M4-C1) contain an intentionally temporary stub that
falls back to centroid-entry when classifyComponent returns `FRONTIER_TANGENT`,
explicitly labeled as a placeholder while C3a primitives were being built:

```ts
// FRONTIER_TANGENT stub (C3): fall back to centroid entry to preserve M3
// behavior until planFrontierEntry is wired in C3b
newEntry    = component.centroid
```

The stub was a deliberate temporary measure, not an accidental design choice.
But it captures the exact pattern being guarded against: when a specialized
strategy isn't yet wired, silently using a simpler one preserves visible coverage
numbers while hiding that the intended logic is absent.

This pattern has two compounding problems when applied non-temporarily:

1. **Hides bugs.** The rejection that triggered the fallback might be a logic
   error in the validator rather than genuine infeasibility. Silent output makes
   the error invisible: operations produce results, coverage tests may pass, and
   nothing flags that the intended strategy was bypassed.
2. **Makes visual review meaningless.** If an operation can silently degrade
   to a different strategy, visual path review cannot distinguish "intended
   strategy was used" from "fallback was used." A path that looks reasonable
   provides false confidence.

The decision below ensures C3b replaces the stub with the UNRESOLVED path —
and that no future strategy follows the same silent-fallback pattern.

## Decision

When an operation has a specialized strategy and that strategy fails its safety
or geometric checks, the operation MUST surface that failure explicitly. Two
acceptable patterns:

**Pattern 1 — Return explicit failure.** The planner returns an `UNRESOLVED`
decision variant (or equivalent typed failure). The caller decides: exclude the
component, abort, escalate. This is the pattern used for AC frontier-tangent
entry.

**Pattern 2 — Fall back with explicit logging.** If a fallback is genuinely the
safer choice by design, emit a structured log entry naming (a) the failed
strategy, (b) the rejection reason, and (c) the fallback being used. This is the
pattern used for `resolveFeedrates` safety constants.

The rule applies **recursively**: if a fallback also fails, that failure surfaces.
There is no silent second-level fallback.

Applications:

- **AC frontier-tangent entry (planned for C3b).** `planFrontierEntry` returns
  `{ decision: PocketEntryDecision, rejectionCounts }` where
  `decision.strategy === 'UNRESOLVED'` (with granular reason) when all candidates
  fail validation. In the C3b RELOCATING state, the component's centroid will be
  pushed to `failedCentroids` and the planner will continue — replacing the
  current temporary centroid-entry stub (see Context above). This ADR governs
  that replacement.
- **`resolveFeedrates` safety constants (currently applied).** When neither
  override nor tool defaults provide `feedRate` / `plungeRate`, the resolver uses
  300/100 mm/min AND emits `console.warn` naming the tool and rate. Two
  independent signals fire. This is Pattern 2 applied to feedrate resolution.
  Landed in Phase 1 Commit 2 (`6fef975`).

## Alternatives considered

**Silent fallback (prior practice).** When strategy A fails, emit strategy B
without logging. Rejected: hides bugs, creates surprising machine behavior (the
operator has no indication their intended strategy wasn't used), makes visual
review produce false confidence.

**Throw on any strategy failure.** No fallback whatsoever — fail hard. Rejected:
some fallbacks are genuinely safer choices that should produce usable output. The
`resolveFeedrates` case is the canonical example: a missing tool config value
should not block all toolpath computation. The goal is visibility, not zero
fallbacks.

**Structured telemetry only, no typed failure returns.** Log everything but keep
code flow simple (no error union types). Rejected: typed failure returns let the
compiler enforce that callers handle the failure case. Logging alone is advisory;
typed returns are structural.

## Consequences

**Positive:**
- Strategy failures surface at the point of failure, not silently downstream.
- Visual review is actionable: an unexpected fallback path is flagged and
  prompts investigation, rather than appearing as valid output.
- Machine behavior is predictable: if frontier-tangent was the intended strategy,
  the user can verify it was actually used.

**Negative:**
- Callers must handle typed failure returns rather than trusting silent output —
  slightly more wiring per strategy.
- Test coverage must include the UNRESOLVED / fallback paths, not just the happy
  path.

## References

- docs/CONVENTIONS.md "Code conventions → Strategy failures and silent fallbacks" —
  full pattern specification with code examples
- `src/lib/cam/feedrates.ts` — `console.warn` implementation for required-rate
  missing case
- `src/lib/cam/adaptiveClearing2d/STATUS.md` — C3b pending section: "DO NOT call
  `_enterRegion` as a fallback. This is a correctness invariant."
- `src/lib/cam/adaptiveClearing2d/STATUS.md` — Decisions and rationale table:
  "No centroid fallback on UNRESOLVED"
- ADR 0004 — the two-tier feedrate resolver; the `console.warn` fallback is
  Pattern 2 applied to feedrate resolution
- ADR 0006 — the specific fallback constant values used in Pattern 2
