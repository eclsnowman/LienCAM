# 0020 - Nested machine/setup/stock/geometry coordinate hierarchy

Date: 2026-06-13
Status: Accepted

Implementation is PHASED: the data model + migration land first, nested
resolution next, then WCS binding, scene-graph behavior, and UI. This ADR records
the LOCKED model and the doctrine; the phased build spec is
docs/planning/COORDINATE-HIERARCHY-PLAN.md.

## Context

Coordinate resolution today is FLAT. The five height planes are stored
WCS-relative (ADR-0002); `resolveHeights` produces an absolute machine Z by simply
adding `wcsOrigin.z` (`src/lib/cam/heights.ts`). The reference modes
(`geometry_face`, `stock_top`, `stock_bottom`, `machine_floor`, `wcs_plane`,
`model_top`, `selected_face`, `absolute`) resolve a single world Z and then
subtract `wcsZ` (`src/store/dispatchGeo.ts`). In that scheme STOCK is only a
VALUE-SOURCE (it supplies the `stock_top` / `stock_bottom` numbers) and not a
transform layer: once a plane is resolved, the stock drops out. GEOMETRY has NO
stock linkage. The scene graph is FLAT - `stockGroup`, `workpieceGroup`, and
`wcsGroup` are sibling groups under the scene root, so moving a stock does not
carry its parts. The WCS<->stock relationship is ad-hoc parallel fields
(`wcs.stockId` + corner alongside `snapGeoId` + `snapLocalPt`).

This flatness is the root of the wrong-location-cut bug family: B10/B18 (WCS
drift), B19 (chamfer resolving the wrong part's face), B22 (stock-side cross-
contamination, where a `stock_top` plane resolves against the WHOLE scene's stock
extent instead of the selected part's own stock), and the general cross-part
height bleed (a project-wide `Math.max` / `Math.min` mixing planes across
unrelated parts).

The acute symptoms surfaced on Z, but the model governs all three axes: the WCS is
the XY datum that places toolpaths in the plane as well as the Z origin.

## Decision

Adopt the LOCKED nested hierarchy:

```
machine
 -> SETUP (primary WCS = operator-established zero; the datum ALL op moves are
           relative to; the thing that ties everything together)
   -> STOCK (first-class, scene-level, REUSABLE across setups; mode =
             derived-from-its-geometry | explicit-fixed; optional secondary work
             offset defined RELATIVE TO the setup primary WCS)
     -> GEOMETRY (physical membership in a stock via geometry.stockId;
                  auto-by-containment + manual override)
       -> OPERATION internal offsets (chamfer tip, drill per-hole, pocket floor,
                                      plane offset)
```

Resolution composes inward -> machine: geometry plane / stock plane (as the
reference selects) -> op internal offset -> the op's SETUP primary WCS (the zero in
effect) -> machine. Each level is a nested relative transform; the absolute cut
location is the composition of all of them, in X, Y AND Z.

Relations are MANY-TO-MANY. A stock / part can appear in multiple setups (Setup A
machines the top; Setup B, after a flip and re-zero, machines the bottom of the
SAME block), so stock is NOT owned by a setup - it stays first-class and
scene-level; setups REFERENCE stocks through their operations. Re-zeroing
mid-process is a DISTINCT setup/WCS boundary.

STOCK<->WCS is a SIBLING BINDING, not parent-child (the crux that caused the
WCS-drift trouble). The WCS is always the datum; it is COMMONLY tied to a stock
corner, but it may instead be tied to a part feature or be manual. Re-derivation is
CONDITIONAL on the binding source:

- `stock_corner` (stockId + corner/face) -> re-zeros when that stock moves or
  RESIZES (the corner moves, the zero moves with it).
- `part_feature` (geoId + feature ref, e.g. circle center / edge / vertex) ->
  tracks the PART; a stock SIZE change does not move it; moving that part does.
- `manual` -> fixed in machine space; tracks nothing.

A stock move/resize re-zeros only stock-bound WCSs; a part move re-zeros only
feature-bound WCSs.

### Common-subsystem rules (the doctrine)

1. An operation MUST resolve every height/datum through the ONE common resolution
   subsystem. It MUST NOT read geometry / stock / WCS to compute a plane itself.
2. An op declares reference + offset + its geometry/loop selection; the subsystem
   composes geometry -> stock -> setup WCS -> machine. An op NEVER reaches outside
   its selected geometry's owning frame.
3. Op-internal offsets (chamfer tip, drill per-hole, pocket floor, plane offset)
   consume RESOLVED planes only; they never re-resolve references.
4. Undeterminable ownership / binding -> FAIL LOUD (ADR-0003), never a silent
   guess.
5. UI previews MUST call the same resolver - no mirrors.
6. New reference types go in the common reference enum (ADR-0002 spirit), not
   per-op.

## Alternatives considered

- **The bounded OWNING-GEOMETRY-HEIGHT fix only** (resolve `stock_top` against the
  selected part's stock, leave the rest flat). Rejected as too narrow - it patches
  one symptom while the flat model keeps generating the rest of the family. the operator:
  "waiting only opens us to more pain."
- **Per-op reference systems** (each operation keeps its own reference enum and
  resolver). Rejected as unprincipled legacy: two enums coexist today (the legacy
  `topHeightMode` / `bottomHeightMode` plus the richer reference enum) and a
  duplicated resolver (`resolveRefZ` in NewOperationModal re-implementing the
  dispatch math) - that duplication is the exact source of the B19-b
  display-vs-dispatch drift. No op SEMANTICALLY needs a separate reference system.
- **WCS as a rigid child of stock.** Rejected per the sibling-binding crux: the WCS
  is often re-established off a part FEATURE (a circle center) or set manually, and
  a stock SIZE change must not move a feature-bound or manual zero. A rigid
  parent-child would re-zero in cases it must not.

## Consequences

- Phased build (full spec: COORDINATE-HIERARCHY-PLAN.md):
  - Phase 0 - data model + migration (types only, no behavior change).
  - Phase 1 - geometry<->stock linkage + auto-assignment + per-stock derive.
  - Phase 2 - nested RESOLUTION: the cut-correctness win, retiring B22, the
    cross-part height bug, the owning-geometry gap, and B19-b chamfer.
  - Phase 3 - WCS sibling binding + conditional re-derivation triggers (retires
    the B10/B18 WCS-drift family).
  - Phase 4 - scene-graph move behavior (explicit stock = parent frame of its
    parts; derived stock re-wraps).
  - Phase 5 - UI surfacing.
- MIGRATION preserves each op's currently-resolved values: existing single-stock
  projects map to one stock owning all geometry, and each setup keeps its current
  WCS as its primary zero; existing stockId/snap bindings map to the unified origin
  binding.
- A typed "resolved coordinate context" handed to ops (not raw geometry/stock) plus
  a test asserting every op type routes through the subsystem make new ops inherit
  correct behavior by design.
- Postprocessor emission of G54-G59 / secondary work offsets remains DEFERRED -
  the secondary stock offset is metadata only for now.
- Preserves ADR-0001 (toolpath/postprocessor separation), ADR-0002 (the five-plane
  Z vocabulary - only what each reference resolves THROUGH changes, not the plane
  names), ADR-0003 (fail-loud), and ADR-0019 (stable loop ids; loop selection ->
  owning geometry leans on it).

## Amendment 1 - binding authority and per-stock controller offsets

Date added: 2026-07-31
Implementation shipped: 2026-07-30 in commit `551b075be`

This amendment records the delivered hierarchy behavior without rewriting the
phased decision above as though it had always been present.

Two earlier statements are superseded or narrowed:

- The Context description of `wcs.stockId` and corner fields as an active
  parallel binding applies only to pre-hierarchy records. When
  `wcs.originBinding` is present, it is authoritative. A `stock_corner` binding
  supplies the stock id; `manual` and `part_feature` deliberately mean that the
  WCS is not stock-bound, even if a stale legacy `wcs.stockId` remains.
  `wcs.stockId` is read only when `originBinding` is absent.
- The Consequences statement that G54-G59 emission remains deferred is
  superseded for the primary controller fixture slot. `PhysicalStock.fixtureOffset`
  now owns the assigned G54-G59 slot. The separate
  `PhysicalStock.workOffset` secondary relative offset remains data-only and
  deferred; this amendment does not claim secondary-offset emission.

The delivered ownership rules are:

1. A physical stock is the canonical owner of an assigned G54-G59 slot.
   Setup WCS origin and axes remain the setup datum; assigning the controller
   slot to stock does not turn the stock/WCS sibling binding into a
   parent-child transform.
2. Multiple setups may resolve to the same G54-G59 slot only when they resolve
   to the same physical stock.
3. Different physical stocks are different offset owners and may not collide.
   A legacy or otherwise unbound setup is its own owner and may not collide
   with another stock or setup owner.
4. Backward compatibility is explicit: a pre-feature stock without
   `fixtureOffset`, or a setup with no resolved stock, continues to use the
   setup WCS `fixtureOffset`. This compatibility path does not permit ambiguous
   ownership.

Resolution remains fail-loud under ADR-0003:

- A setup whose enabled operations span multiple stocks is refused with
  `SETUP_MULTI_STOCK`.
- When operation ownership identifies one stock but the authoritative WCS
  binding identifies another, posting is refused with
  `SETUP_STOCK_BINDING_MISMATCH`; neither source silently wins.
- A dangling stock binding is refused with `WORK_OFFSET_STOCK_MISSING`, and an
  offset outside G54-G59 is refused with `WORK_OFFSET_INVALID`.
- If legacy setup-level fallback values resolve one physical stock to different
  offsets, posting is refused with `WORK_OFFSET_STOCK_INCONSISTENT`.
- If different stock/setup owners resolve to one slot, posting is refused with
  `DUPLICATE_WORK_OFFSET`.

Implementation anchors:

- [`wcsBoundStockId`, `wcsStockCornerBinding`, `resolveSetupWorkOffset`,
  `findInconsistentStockWorkOffsets`, and
  `findResolvedWorkOffsetConflicts`](../../src/lib/post/workOffsets.ts)
- [`postProject`](../../src/lib/post/postProject.ts), which converts resolution
  failures and owner collisions into post diagnostics before emission
- [`setStockFixtureOffset`](../../src/store/index.ts), which validates the slot,
  rejects missing or colliding owners, writes the stock, and mirrors its slot
  label/value to setups bound to that stock

## References

- ADR-0001 - toolpath/postprocessor separation.
- ADR-0002 - canonical Z vocabulary (the five planes, preserved).
- ADR-0003 - no silent fallbacks (the fail-loud net rules 4 builds on).
- ADR-0019 - stable content-derived loop ids (loop -> owning geometry).
- docs/planning/COORDINATE-HIERARCHY-DESIGN.md - the full design record + the operator's
  decisions and refinements (locked model).
- docs/planning/COORDINATE-HIERARCHY-PLAN.md - the phased build spec.
