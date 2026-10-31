# 0030 — Tool geometry as a single tip-up revolved profile; holders and named libraries

Date: 2026-06-23
Status: Accepted

## Context

A tool is a solid of revolution, but the codebase never modelled it that way.
Three independent consumers each rebuilt the tool's shape from scratch,
shank-down, and tacked the tip on afterward — with no shared geometry source:

- **2D tool diagram** (`ToolDiagram.tsx`): drew the flute as a rectangle and the
  tip as a SEPARATE path below it. The tapered-endmill taper height was a
  hardcoded pixel constant (`Math.min(40, FLUTE_HW*0.9)`), so a tapered tool was
  stuck at ~2 mm of taper and ignored its real flute length and angle.
- **3D viewport** (`CNCViewport.buildToolMesh`): a generic cylinder stack with a
  `switch` on the raw `Tool.type`. Only ball / V / drill / bull got a tip;
  tapered / dovetail / lollipop / chamfer / disc / countersink fell through to a
  flat cylinder. It ignored `profileKind` entirely.
- **Simulation** (`carve.ts` and a DUPLICATE in `SimulationPanel.tsx`): a
  per-type radius function covering only flat / ball / bull / V; everything else
  became a flat cylinder, and the non-cutting neck / shank was never modelled, so
  undercut tools (lollipop / disc / dovetail) carved as plain cylinders.

The three shapes could (and did) drift apart, and several tool families had no
honest geometry in any of them. Separately, manufacturer / ISO 13399 research
(captured in `docs/qa/009 - tool-geometry-model/`) showed the angle and taper
conventions were under-specified: a tapered endmill's `diameter` could be read as
either end, the taper was unadjustable, and there was no model for tool holders or
for organizing tools into named libraries (the store held one flat global pool).

ADR-0029 had already unified the tool ANGLE on one canonical
`Tool.angleFromAxisDeg` (the from-axis half-angle). This ADR unifies the tool
SHAPE on one canonical generator that consumes that angle.

## Decision

### One geometry generator — `src/lib/tool/toolProfile.ts`

Every tool is a solid of revolution described by an ordered radius(z) polyline
built from the TIP (z = 0) upward toward the holder. The full silhouette is that
profile mirrored across the centerline.

```ts
interface ProfileVertex { z: number; r: number }
interface ToolProfile { vertices: ProfileVertex[]; cuttingMaxZ: number; fluteTopZ: number }

buildToolProfile(tool): ToolProfile          // tip(z=0) -> up, keyed on profileKind
buildHolderProfile(holder): ProfileVertex[]  // revolved, bottom-up
radiusAtZ(profile, z): number                // interpolating sampler; 0 above the tool
isCutting(profile, z): boolean               // z <= cuttingMaxZ
tipOffsetAtRadius(profile, d): number         // z of the lower cutting surface at radius d
toolReachWarnings(tool, axialDepthMm): ToolReachWarning[]   // passive rub check
```

`buildToolProfile` switches on `toolTypeMeta(tool.type).profileKind` (the
`ProfileKind` union: flat / ball / bull / cone / frustum / drillpoint / dovetail /
disc / lollipop) and the canonical half-angle (`toolHalfAngleRad`). The per-type
math is ported EXACTLY from the validated reference implementation in
`docs/qa/009 - tool-geometry-model/tool-geometry-reference.html`. The cutting
region is `[0, cuttingMaxZ]`; everything above is non-cutting neck / shoulder /
shank. The function is pure and deterministic.

This module is THE source of truth and drives all three consumers:

- **2D diagram** mirrors the profile into the silhouette (no tacked-on tip, no
  hardcoded taper constant), colored by cutting / neck / shank region.
- **3D viewport** revolves the profile into a `LatheGeometry`, colored by region;
  a holder is revolved from `buildHolderProfile` and seated at the tool's stickout.
- **Simulation** uses one shared sampler (`tipOffsetAtRadius` / `radiusAtZ`) in
  place of BOTH former per-type duplicates; material removal uses the cutting
  envelope (`z <= cuttingMaxZ`), so every tool type now carves a real shape.

### Geometry conventions (manufacturer / ISO 13399)

- **Tapered endmill** (`frustum`): `diameter` is the MAJOR (top) diameter; the
  tool narrows DOWN to the tip; the derived tip diameter spans the FULL flute
  length: `tip = diameter - 2 * fluteLength * tan(angleFromAxis)`. The taper is
  per-side. If the cone closes before the flute ends it acts as a V-bit.
- **V-bit / chamfer / countersink / drill** (`cone` / `drillpoint`): quote an
  INCLUDED angle at the UI/import edge, stored canonical as the from-axis
  half-angle (ADR-0029). A `tipDiameter` of 0 / undefined = sharp point.
- **Corner radius** (`bull`) composes with taper (tapered bull / ball cases).
- **Undercut tools** (`lollipop` / `disc` / `dovetail`) use `neckDiameter` for the
  non-cutting neck below the cutting head; `fluteLength` is the cutting boundary,
  neck / shank are non-cutting.

New `Tool` fields: `tipDiameter`, `neckDiameter`, `holderId`, `libraryId`.
`toolMeta.ts` gains `ProfileKind` and `PROFILE_FIELD_RELEVANCE` (per-kind field
relevance) so the editor shows only the fields each type uses.

### Tool holders — a revolved segment stack

A holder is a separate first-class entity, modelled (like a timeline-based CAD/CAM system's `.tools`
holder block) as a stack of revolved segments:

```ts
interface HolderSegment { height: number; lowerDiameter: number; upperDiameter: number }  // mm
interface ToolHolder {
  id: string; name: string; vendor?: string; productId?: string; description?: string;
  gaugeLength?: number; segments: HolderSegment[]   // stacked from the holder bottom (tool side) up
}
```

Equal diameters make a cylinder, unequal a cone. A tool selects a holder via
`Tool.holderId`; the holder seats at the tool's `lengthBelowHolder` stickout and
is rendered with the tool in 3D. Holders live in a `holders: ToolHolder[]` store
slice and are import/export-compatible with timeline-based CAD/CAM system `.tools`.

A PASSIVE, non-blocking rub warning (`toolReachWarnings`) is surfaced when an
operation's axial cut depth exceeds the flute length (shank/neck rub) or the
stickout below the holder (holder rub). It modifies no toolpath. Active avoidance
(pull-away / trim / auto-extend / fail) is deferred (ADR-0003 fail-safe: surface
explicitly, never block).

### Named tool sub-libraries

Tools stay in the flat global `toolLibrary: Tool[]` pool; a `Tool.libraryId`
assigns each to a named `ToolLibrary { id; name }` (stored in
`toolLibraries: ToolLibrary[]`). Filter and sort work ACROSS all libraries or
scoped to one. Importing a `.tools` / `.json` creates a new library from the
filename; export / remove operate on a whole library; a duplicate-tool action
clones a tool with a new id. This mirrors a timeline-based CAD/CAM system's library model over the
existing one-flat-pool store, without a project-vs-library split (that model was
spiked and rejected — see docs/FEATURE-HITLIST.md).

### Migration v2 -> v3 (ADR-0027 chain)

A new migration step creates a default `ToolLibrary { id: 'lib-default',
name: 'My Tools' }`, backfills every tool's `libraryId` to it, and initializes
`holders: []`. `tipDiameter` / `neckDiameter` / `holderId` are left undefined
(`buildToolProfile` supplies per-type defaults). The same heal runs on the
Zustand persist-rehydrate path. Byte-identical no-op once current.

## Alternatives considered

- **Keep three per-consumer shape builders, just fix the tapered tip.** Rejected:
  it treats the symptom. The shapes would still be three code paths free to drift,
  and most tool families would still have no honest geometry in the sim or 3D view.
- **Build the profile shank-down (from the holder toward the tip).** Rejected:
  the tip is the machining-relevant datum (z = 0 = the cut origin), cutting depth
  and the rub check are naturally measured up from it, and the reference impl is
  authored tip-up. Shank-down would invert every formula for no gain.
- **Model holders as a single bounding cylinder.** Rejected: it cannot represent
  stepped / collet holders, would give a false rub clearance, and is not
  timeline-based CAD/CAM system-interchangeable. The segment stack is the minimal honest model and maps
  1:1 to the `.tools` holder block.
- **A project-vs-library tool split for organization.** Rejected (already spiked
  and rejected, ADR-0007 follow-up): named flat libraries over one global pool
  deliver the organization without the confusing two-tier scoping.

## Consequences

Positive:
- One geometry definition; the 2D diagram, 3D viewport, and simulation can never
  disagree about a tool's shape.
- All 18 tool types get an honest profile in every view, including the previously
  flat-cylinder families (tapered, dovetail, lollipop, disc, countersink).
- The tapered endmill's taper is driven by its real flute length and angle.
- Holders give a real assembly preview and a basis for the passive rub warning,
  and travel through timeline-based CAD/CAM system `.tools` import/export.
- Named libraries organize a growing tool pool without a schema fork.

Negative / watch-items:
- The simulation models undercut tools (lollipop / dovetail / disc) by their lower
  bottom silhouette, NOT true undercut removal of material BEHIND the neck. This
  is conservative (it never carves material the tool cannot reach from below) and
  safe, but honest 3D undercut carving is deferred to a 3D-milling pass.
- The rub warning is passive only; active collision avoidance is deferred.
- Vendor `shaft` segment import (richer shank geometry) is deferred; a holder's
  shaft maps its max diameter to `shankDiameter` for v1.

## References

- `src/lib/tool/toolProfile.ts` — `buildToolProfile` / `buildHolderProfile` /
  `radiusAtZ` / `isCutting` / `tipOffsetAtRadius` / `toolReachWarnings`.
- `src/lib/tool/toolMeta.ts` — `ProfileKind`, `TOOL_TYPE_META`,
  `PROFILE_FIELD_RELEVANCE`.
- `src/types/index.ts` — `Tool.{tipDiameter,neckDiameter,holderId,libraryId}`,
  `ToolHolder`, `HolderSegment`, `ToolLibrary`.
- `src/store/migrations/projectMigrations.ts` — v2 -> v3 step
  (`MIGRATION_DEFAULT_TOOL_LIBRARY`, `CURRENT_PROJECT_SCHEMA_VERSION = 3`).
- `src/components/modals/ToolLibraryModal.tsx` (library scope + holders + diagram),
  `src/components/panels/PropertiesPanel.tsx` (rub warning),
  `CNCViewport.buildToolMesh` (3D lathe), `carve.ts` / `SimulationPanel.tsx` (sim).
- `docs/qa/009 - tool-geometry-model/` — reference HTML + research + plan.
- ADR-0029 (tool angle stored as angle-from-axis), ADR-0027 (versioned schema
  migration chain), ADR-0003 (no silent fallbacks — fail-safe rub warning).
- docs/ARCHITECTURE.md (Tool geometry module), docs/UI-ARCHITECTURE.md §12.3.
