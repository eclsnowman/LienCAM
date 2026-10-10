# 0005 — Recipe / template system as future requirement

Date: 2026-05-17
Status: Proposed

## Context

Many CNC parts require the same operation sequence: 2D facing, drilling, adaptive
clearing, pocket, chamfer, contour is a representative pattern for a typical
milled part. Recreating this sequence from scratch for each new part is tedious.
Commercial CAM products (timeline-based CAD/CAM system, commercial CAM system, engagement-controlled adaptive clearing system) support templates or
operation libraries — saved sequences applied to a new Setup, with the user
filling in geometry references afterward.

LienCAM does not have this yet. The requirement surfaced concretely during Phase 1
feedrate resolver design (ADR 0004): if operation code embeds tool-specific
fallback feeds, those fallbacks must be manually adjusted whenever a recipe is
applied with a different tool. That reasoning drove the decision to remove
operation-level fallbacks. The recipe requirement is thus already constraining
current design, even though implementation is deferred.

## Decision

Establish recipe/template support as a future requirement. No implementation in
this milestone — the ADR is Proposed status because the design constraints below
are accepted now but the feature build is deferred until the project needs it.

The decision has three binding constraints on current design:

1. **Operation params describe intent, not tool-specific realization.** Parameters
   like step depth, stepover, engagement limits, and cutting direction describe
   what the operation does in material. Feeds, speeds, and tool-geometry-derived
   values come from the tool definition or override — not hardcoded in params.

2. **Geometry references are Setup-scoped placeholders.** A recipe stores
   operation type + intent params. It does not store geometry loop IDs (which are
   Setup-specific). The user fills in geometry references when applying the recipe
   to a new Setup.

3. **Recipes do not include tool selections.** Tools are shop-specific — a recipe
   created with a 6mm carbide end mill is not portable to a shop using a 4mm HSS
   end mill. Tool assignment happens at apply-time, not at recipe-save-time.
   This keeps recipes portable across tooling configurations.

## Alternatives considered

**No recipe system.** Users always configure from scratch. Rejected: the workflow
benefit is real, competitors offer it, and the absence is a friction point for
experienced CNC operators.

**Build recipe system now.** Implement in this milestone. Rejected: the scope is
substantial (storage format, Apply workflow, geometry placeholder UI, version
compatibility) and the feature is not yet blocking any user workflow. Premature
implementation would consume time better spent on the AC milestone.

**Recipes include tool selections.** Save the tool association with the recipe.
Rejected: tools are shop-specific. A recipe created with a 6mm carbide end mill
means something different on a machine with a 4mm HSS end mill. Recipe portability
is highest when the tool is filled in at apply-time.

## Consequences

**Positive:**
- Current operation param design is recipe-ready from day one. No retrofit
  required when recipe implementation begins.
- Reinforces keeping operation code free of tool-physics knowledge (ADR 0004).

**Negative:**
- Adds a future scope commitment that is not yet resourced or scheduled.
- The "recipe-ready" constraint may feel over-engineered until the feature exists.
- When recipe implementation does begin, existing `<Op>Params` interfaces will
  need an audit to verify no implicit tool-physics knowledge has accumulated.

## References

- docs/ARCHITECTURE.md "Roadmap" — recipe/template system appears as a future item
- ADR 0004 — two-tier feedrate resolver; the removal of operation-level fallbacks
  was directly motivated by recipe-readiness; cross-reference in both directions
