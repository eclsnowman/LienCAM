# 0006 — Safety fallback feedrate values (300 / 100 mm/min)

Date: 2026-05-17
Status: Accepted

## Context

ADR 0004 establishes the two-tier feedrate resolver and specifies that required
rates (`feedRate`, `plungeRate`) fall back to internal safety constants when
neither override nor tool defaults provide them. ADR 0003 requires any fallback
to emit an explicit signal. The remaining question was the specific constant values.

The constants fire only when both the operation override and
`tool.feedsAndSpeeds.default` are absent or missing the relevant rate. In normal
operation they should never fire — once upstream tool validation exists, tool
defaults will always be present.

Two constraints shaped the choice:

- The value must be conservative enough that, for a brief diagnostic run, the
  operator has time to react to obvious issues before serious problems develop.
  This is diagnostic conservatism — not a safety guarantee for every cutter,
  material, or stock configuration.
- The value must be sensorily noticeable as wrong — slow enough that an operator
  notices sluggish behavior and checks the tool config.

## Decision

```
SAFETY_FALLBACK_FEED_RATE   = 300  // mm/min
SAFETY_FALLBACK_PLUNGE_RATE = 100  // mm/min
```

A `console.warn` fires when a required rate falls back to the safety constant,
naming the tool and rate.

Derived rates resolve from the safety constants when not otherwise provided:
`rampRate = Math.round(100 * 1.5) = 150 mm/min`,
`leadInRate = leadOutRate = 300 mm/min`.

Implemented as `SAFETY_FALLBACK_FEED_RATE` and `SAFETY_FALLBACK_PLUNGE_RATE`
constants in `src/lib/cam/feedrates.ts`, Phase 1 Commit 2 (`6fef975`).

## Alternatives considered

**Match existing milling defaults (1000/300 mm/min).** These were the hardcoded
milling fallbacks removed in Phase 1. Rejected: at 1000 mm/min the machine
behavior feels normal — the operator would not notice the fallback fired. A tool
config problem would go undetected until something went wrong at depth.

**Lower still (100/50 mm/min).** Very conservative but the machine would barely
move, suggesting hardware failure rather than misconfiguration. Rejected:
conflates the fallback-fired diagnostic signal with an apparent machine problem.

**Throw an exception.** No fallback at all — fail hard if tool defaults are
missing. Rejected per ADR 0004 reasoning: blocks all toolpath work for what is
a correctable configuration problem.

## Consequences

**Positive:**
- 300/100 mm/min is intentionally conservative for broad diagnostic use across
  typical cutters and materials. This is not a substitute for proper tool
  configuration — the `console.warn` ensures the operator is alerted to the
  missing config.
- The feed rate is noticeably slow ("something is off") without suggesting broken
  hardware.
- Two independent signals fire when the fallback activates: browser `console.warn`
  + sluggish machine behavior. Satisfies ADR 0003's explicit-signal requirement.
- Constants are centralized — changing them updates all operations uniformly.

**Negative:**
- The constants are not a safety guarantee for every setup. Users running unusual
  materials, large diameters, or aggressive cuts must configure proper tool
  defaults rather than relying on the fallback.
- Users who deliberately want to run at 300/100 mm/min (cautious first cuts) will
  see spurious warnings. Acceptable resolution: configure those rates explicitly
  as tool defaults, which silences the warning.

## References

- `src/lib/cam/feedrates.ts` — `SAFETY_FALLBACK_FEED_RATE` (line 16) and
  `SAFETY_FALLBACK_PLUNGE_RATE` (line 17); Phase 1 Commit 2 (`6fef975`)
- ADR 0004 — the two-tier resolver design that uses these constants as last resort
- ADR 0003 — the no-silent-fallback principle that mandates the `console.warn`
