# 0004 — Two-tier feedrate resolver (no operation-level fallbacks)

Date: 2026-05-17
Status: Accepted

## Context

Before Phase 1 Commit 2, each operation resolved feedrates inline using a
three-tier chain: operation override → `tool.feedsAndSpeeds.default` →
operation-hardcoded fallback constant. The hardcoded fallbacks differed per
operation: milling operations used 1000 mm/min feed / 300 mm/min plunge; drill
used 300/150 mm/min with the stated rationale "drill cycles need lower feeds for
safety."

The per-operation hardcoded fallbacks represent tool-physics knowledge — what
feed rate is safe for a given tool type and material. That knowledge belongs in
the tool definition, not in operation code. Operations should describe machining
intent; tools provide physical realization. This layering violation became
concrete when the recipe/template system was considered as a future requirement
(see ADR 0005): a recipe portable across tool setups cannot be portable if
operation code embeds tool-type-specific feed defaults.

## Decision

Two tiers only:

1. **Operation override** — if `override.enabled` is true, use the override rates
   verbatim.
2. **Tool defaults** — `tool.feedsAndSpeeds.default`; use the rates from the tool
   definition.

**Required rates** (`feedRate`, `plungeRate`) that neither tier provides fall back
to internal safety constants (300/100 mm/min — see ADR 0006) with a
`console.warn` naming the tool and rate (see ADR 0003).

**Derived rates** (`rampRate`, `leadInRate`, `leadOutRate`) fall back silently to
geometry-based heuristics when not provided:

- `rampRate = Math.round(plungeRate * 1.5)` — between plunge and full feed
- `leadInRate = leadOutRate = feedRate` — tangent lead moves at full cut feed

Operations do NOT pass fallback values to the resolver. The resolver signature is:

```ts
resolveFeedrates(tool: Tool, override: FeedrateOverride | undefined): ResolvedFeedrates
```

No third argument. Implemented in `src/lib/cam/feedrates.ts`, Phase 1 Commit 2
(`6fef975`).

## Alternatives considered

**Three-tier with operation fallbacks (status quo).** Operations pass their own
fallback values as a third argument. Rejected: hardcoded feed values in operation
code are tool-physics knowledge in the wrong layer. Also creates per-operation
maintenance burden — each op must be updated when fallback reasoning changes.

**Throw on missing tool defaults.** If `tool.feedsAndSpeeds.default` is absent,
throw. Rejected: blocks all toolpath work for that tool when the problem is just
a missing configuration value. The `console.warn` + safety constant approach
surfaces the problem without making the operation inoperable.

**Per-operation safety nets as separate mechanism.** Each operation registers its
own "safe minimum" separate from the shared resolver, coexisting with the two-tier
chain. Rejected for the same layering reason as three-tier; also creates
divergence that grows as operations are added.

## Consequences

**Positive:**
- Operations have no tool-physics knowledge. An operation configured for milling
  behaves correctly when assigned a drill — the tool brings its own feed defaults.
- Operations are recipe-portable (ADR 0005): swap the tool in a recipe, the new
  tool's feeds come with it.
- Safety fallback constants are centralized in one file; changing them applies
  uniformly to all operations.

**Negative:**
- Tool configurations lacking `feedsAndSpeeds.default` trigger `console.warn`
  until fixed. May be noisy for imported or hand-edited tools in the short term.
- Derived rate heuristics (`rampRate = plungeRate * 1.5`) are approximations.
  Users wanting precise derived rates must set them explicitly in the tool
  definition or via override.

## References

- `src/lib/cam/feedrates.ts` — implementation; Phase 1 Commit 2 (`6fef975`)
- docs/ARCHITECTURE.md "Shared subsystems" — `feedrates.ts` entry (the signature
  shown there, `resolveFeedrates(tool, override, fallbacks)`, is stale and will
  be corrected in a separate cleanup commit)
  *(Resolved: docs/ARCHITECTURE.md was corrected to `resolveFeedrates(tool, override) →
  ResolvedFeedrates` before the docs-cleanup commit following 17c4147. The entry
  and implementation are now consistent.)*
- docs/CONVENTIONS.md "Code conventions → Strategy failures and silent fallbacks" —
  documents the `console.warn` pattern used for required-rate fallback
- ADR 0003 — the no-silent-fallback principle that governs the `console.warn`
  behavior
- ADR 0005 — recipe/template system requirement; directly motivated the removal
  of operation-level fallbacks
- ADR 0006 — the specific values chosen for the safety fallback constants
