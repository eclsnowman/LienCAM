# 0026 — One stock per setup; different-height fixtures use separate setups + combined multi-offset posting

Date: 2026-06-20
Status: Accepted

## Context

A user may want to machine parts/stocks that sit at DIFFERENT Z heights
(different stock thickness, or different fixture heights on the table). The
question was whether to model multiple different-height stocks as first-class
inside a single setup, or to require separate setups.

Recon of the codebase and research into CAM/CNC convention (2026-06-20,
docs/qa/002) established:

- A multi-height-stock-in-one-setup model is ambiguous and unsafe: there is no
  single correct "stock top" for height resolution, the clearance plane would
  have to vary by area (no rendering path exists; hard to visualize), and rapids
  across regions at different heights risk collisions.
- Industry convention is uniform across commercial CAD/CAM vendor timeline-based CAD/CAM system, commercial CAM system, open-source CAD/CAM system
  Path, and standard CNC practice: one CAM "setup" = ONE work coordinate system
  (WCS) = ONE fixture origin = ONE stock. Parts at a different
  orientation/origin/fixture get a NEW setup. Multi-fixture jobs are programmed
  as multiple work offsets (G54, G55, …, or extended G54.1 Pn) combined into ONE
  NC file, with a retract to a GLOBAL machine-frame safe Z between offsets.
- Our app already matches most of this: a `Setup` carries exactly one `WCS`
  (one fixture offset); the post already emits a combined program with one work
  offset per setup (`emitCombinedProgram`, fail-loud duplicate-offset guard);
  the clearance plane is drawn as one plane per setup; and an operation whose
  `__all__` selection spans more than one stock is already blocked fail-loud
  (`resolveOwningStock`).

Two gaps remained: (1) a single setup could still mix per-geometry ops across
different stocks (only the `__all__` case was blocked), sharing one clearance
plane; and (2) the cross-setup retract used a per-setup work-relative safe Z,
not a global machine-frame safe Z — a genuine multi-fixture crash risk when a
later setup sits on a taller fixture.

## Decision

1. **One stock per setup.** A setup's operations must all resolve to a single
   stock — the setup's WCS-bound stock. This is the canonical model.

2. **Different-height stocks → separate setups.** Each fixture/height gets its
   own setup with its own WCS / work offset. The user exports them as ONE
   combined `.nc` via the existing multiple-work-offset post (combined mode).

3. **Fail-loud guard (ADR 0003).** A setup whose operations reference geometry
   on more than one distinct stock surfaces a clear, named error steering the
   user to split the work into separate setups. This extends today's
   `__all__`-only block to the whole setup.

4. **Global safe-Z between offsets.** The combined post must retract to a global
   safe Z (the maximum clearance across all posted setups, expressed in the
   machine/world frame and converted into each outgoing setup's work frame)
   before changing work offset and moving in XY. It must never emit `G53 Z0`
   as a retract (a machine whose Z0 is near the bottom of travel would crash);
   the safe Z is the highest work clearance.

5. **No bespoke multi-height-stock-in-one-setup system.** Rejected (see below).

## Alternatives considered

- **Multi-height stocks first-class inside one setup (per-area clearance).**
  Rejected: ambiguous "which stock top"; no way to visualize per-area clearance;
  collision risk; contrary to every mainstream CAM convention; large build for a
  workflow the industry deliberately does not support.

- **Document the convention but do not enforce it.** Rejected: relies on user
  discipline and fails silently when a setup quietly mixes stocks — contrary to
  the no-silent-fallbacks rule (ADR 0003).

## Consequences

- Matches industry convention exactly; the multi-offset combined export already
  exists, so the net new work is small: the fail-loud guard (decision 3) and the
  global safe-Z fix (decision 4, which benefits ALL multi-setup posting, not just
  nesting).
- Costs the user an extra setup per fixture — the normal professional CAM
  workflow, not a regression.
- A separate, smaller follow-up remains backlog: parts at different heights on
  the SAME single stock/origin (per-part top-Z from model geometry) — the only
  single-setup multi-height case the industry supports.

## Amendment 1 - physical-stock work-offset ownership

Date added: 2026-07-31
Implementation shipped: 2026-07-30 in commit `551b075be`

The one-stock-per-setup safety rule remains accepted and unchanged. This
amendment supersedes only the original one-setup-one-controller-slot reading:

- The Context statement that the post emits "one work offset per setup" and
  fails on every duplicate setup offset is no longer the ownership rule.
- In Decision 2, each separate setup still has its own WCS datum, but the
  controller G54-G59 slot is owned by the physical stock. "Its own WCS / work
  offset" must not be read as requiring a unique slot for every setup.

The delivered posting contract is:

1. Every setup still resolves to at most one physical stock. Enabled operations
   spanning multiple stocks fail loud with `SETUP_MULTI_STOCK`; the user must
   split them into separate setups.
2. An assigned `PhysicalStock.fixtureOffset` is the canonical G54-G59 slot for
   every setup that resolves to that stock. Multiple setups may share that slot
   because they represent one physical offset owner.
3. Different stocks may not share a slot. A legacy or unbound setup with no
   resolved stock is a distinct owner and may not share its setup-level slot
   with another stock or setup owner. Such collisions fail before emission
   with `DUPLICATE_WORK_OFFSET`.
4. Old projects remain readable. If a resolved stock predates
   `PhysicalStock.fixtureOffset`, posting inherits that setup's WCS
   `fixtureOffset`. If selected setups would thereby resolve the same stock to
   different slots, posting refuses with `WORK_OFFSET_STOCK_INCONSISTENT`
   rather than selecting one.
5. Operation stock ownership and the authoritative WCS stock binding must
   agree. A mismatch fails with `SETUP_STOCK_BINDING_MISMATCH`; a missing stock
   fails with `WORK_OFFSET_STOCK_MISSING`; a value outside G54-G59 fails with
   `WORK_OFFSET_INVALID`.
6. When `wcs.originBinding` is present, it is authoritative for stock binding.
   Only `stock_corner` names a stock. A stale legacy `wcs.stockId` is ignored
   for `manual` or `part_feature` bindings and is consulted only when
   `originBinding` is absent on a pre-hierarchy record.

This amendment does not change Decision 4's global machine-frame safe-Z rule
or add support for multiple stocks inside one setup.

Implementation anchors:

- [`resolveSetupWorkOffset`, `wcsBoundStockId`,
  `findInconsistentStockWorkOffsets`, and
  `findResolvedWorkOffsetConflicts`](../../src/lib/post/workOffsets.ts)
- [`postProject`](../../src/lib/post/postProject.ts), which applies the
  fail-loud checks before combined or separate output
- [`setStockFixtureOffset`](../../src/store/index.ts), the canonical assignment
  action for PhysicalStock-owned G54-G59 slots

## References

- docs/qa/002 — the recon + market research + approved proposal (Operator ruling 2026-06-20)
- ADR 0001 — toolpath/postprocessor separation
- ADR 0003 — no silent fallbacks (the fail-loud guard)
- ADR 0020 — nested machine/setup/stock/geometry coordinate hierarchy
- ADR 0021 — postprocessor architecture
- src/lib/post/emit.ts — emitCombinedProgram (multi-offset + cross-setup retract)
- src/store/dispatchGeo.ts — resolveOwningStock (existing per-op stock resolution)
