# 0025 — Nest as geometry node, seed authoring, and sheet-as-auto-stock

Date: 2026-06-18
Status: Accepted (2026-06-20; was Proposed — the nest-as-geometry data model, the
owned-seed authoring model, and the sheet-as-FIXED-stock decision, as revised by
Amendments 1-3, shipped on feat/nesting-engine and passed the operator's visual gates)

## Context

ADR 0024 established the instanced nest data model (a `NestRecord` of
placements, with the toolpath computed ONCE per unique source part and
replicated in the post). That contract is correct and stays intact. But the
nest still surfaces as a bolted-on "Nests" section in the design tree, separate
from the geometry it is made of, and the relationship between a nest's sheet and
the project's stock model is undefined.

the operator's cohesion pivot (2026-06-17/18, after P4 shipped and was signed off,
P5 parked): nesting should be a FIRST-CLASS citizen of the geometry/stock
model, not a separate category. Three things were left undecided by ADR 0024
and are settled here:

- How a nest appears in the tree and how the user inspects/edits it.
- What the "source part" the toolpath is computed against actually IS in
  authoring terms (the seed).
- How the sheet relates to stock, given that 2D parts carry no Z.

This builds on the recently shipped stock-model refactor (multiple named auto
stocks coexisting with fixed stocks; geometry binds to a stock via
`ImportedGeometry.stockId`; `AutoStockItem` auto-sizes from its assigned
members) and the nested coordinate hierarchy (ADR 0020).

## Decision

Extend ADR 0024 with three contracts. ADR 0024's render and post-expansion
behaviour is unchanged.

### 1. Nest-as-geometry-node

A nest surfaces as a folder-like node INSIDE the geometry tree (not a separate
"Nests" section). Its unique source parts render as child rows that act like
layers act inside a geometry — the nest's contents live "inside the folder."
The node is created from a new `LayoutGrid` icon in the Geometry section header,
alongside new-sketch / new-geometry / new-folder. It reuses the existing nest
modal for create and edit (the pencil reopens the modal prefilled from the
`NestRecord`).

Selecting the nest node shows its settings in the Properties panel, which reads
from the `NestRecord` (read-only summary for v1 — sheet size, style, spacing,
solver, seed, per-source quantity, placed/left, utilization, compute time —
with room to grow into inline quick-edit later). This requires a new transient
selection field `viewer.selectedNestId`, MUTUALLY EXCLUSIVE with geometry and
operation selection (selecting a nest clears the others and vice versa). It is
not persisted.

Per-part quantity remains authored in the modal for v1; the tree child rows
display quantity ("xN") only.

### 2. Seed authoring

The single stored source copy per unique part IS the authoring seed — there is
NO separate seed object. Operations are planned against the seed part; the
toolpath then instances off it for every placement, exactly per ADR 0024 §2.
Seed parts get distinct coloration in the viewport/tree so it is clear which
copy is the authoring source. This is the data-model groundwork that the P6
instanced toolpath builds on.

### 3. Sheet-as-auto-stock and explode

The nest's sheet binds to an AUTO stock (an `AutoStockItem`, the same kind the
stock-model refactor introduced), created AUTOMATICALLY when the nest is
calculated/accepted (not via a separate "convert sheet to stock" action). The
stock re-sizes when the nest re-packs; moving the stock moves the sheet and all
placed parts with it. Because 2D parts carry no inherent Z, the nesting UI gains
a THICKNESS (Z) selector that feeds the auto stock's depth.

EXPLODE is an explicit, history-pushing user action: each placed instance
becomes an independent, individually-editable geometry at its packed pose, the
seed/instanced link is dropped, and the nest node is removed (classic CAD
explode). It is a user action, not the storage model — the instanced model
(geometry stored once) remains the default.

## Alternatives considered

**Keep the standalone "Nests" section.** Simplest — no tree-model change.
Rejected: it is exactly the bolted-on feel the operator is removing; the nest is made of
geometry and belongs in the geometry tree.

**A separate "seed" object distinct from the source part.** Rejected: the source
part already IS the single authoring copy per ADR 0024; introducing a second
object duplicates the concept and the data. The source doubles as the seed.

**Explicit "convert sheet to stock" action.** Rejected: the operator chose automatic
binding on Calculate/Accept; an extra manual step adds friction with no benefit
once the stock kind (auto) and thickness are known.

**Explode-by-default / duplicate geometry as the storage model.** Rejected:
defeats ADR 0024's whole memory/compute win. Explode stays an explicit user
action; storage remains instanced.

## Consequences

**Positive:**
- The nest is cohesive with the geometry/stock model: one tree, one selection
  model, one stock model. The source part is the obvious authoring target for
  operations (P6).
- The seed coloration makes the authoring copy visually unambiguous.
- Auto stock binding gives the nest a real physical extent (with Z), unifying it
  with setups/WCS and the rest of the coordinate hierarchy (ADR 0020).

**Negative / costs:**
- New transient `selectedNestId` selection state and the mutual-exclusion wiring
  across every selection setter (a missed clear site = a stale highlight).
- The geometry tree learns a nest node type (folder-like render, per-nest
  collapse state).
- Explode is a new destructive action that must push history.
- Nest lifecycle couples to stock lifecycle (auto stock created/resized/moved
  with the nest), a coupling that must fail loud (ADR 0003) if the bound stock
  is missing.

## Implementation phasing

- N1a — nest-as-geometry-node (contract 1): tree node, selection state,
  Properties summary, modal reuse. Standalone Nests section removed.
- N1b — seed authoring + distinct coloration (contract 2).
- N1c — explode (contract 3, explode half).
- N1d — sheet-as-auto-stock + thickness selector (contract 3, stock half;
  depends on the shipped N0 multi-auto-stock work).
- Then P6/P7 implement ADR 0024's instanced toolpath + post-expansion against
  the seed.

## Amendment (2026-06-19) — refined seed model and source provenance

Contract 2 ("Seed authoring") as originally written said the single stored
source copy IS the seed and "gets distinct coloration in the viewport/tree."
N1b was first built on that literal reading: the source rendered as a standalone
floating part next to the nest, marked with a violet halo. On visual review the operator
rejected that model. This amendment refines contract 2 (and the explode/delete
half of contract 3) accordingly. The instanced data model (contract 1) and the
ADR 0024 toolpath/post contracts are unchanged.

REFINED SEED MODEL:
- The seed is NOT a separate floating object. It is the nest's designated
  LOWER-LEFT placement — the placement with the smallest (x + y) among a given
  source part's placements (deterministic tie-break: x+y, then x, then y, then
  instanceId). A nest of N copies of one part = 1 seed (that lower-left slot) +
  N-1 copies, with nothing floating outside.
- The seed slot renders with the source geometry's REAL per-layer loop colors
  (so the user can zoom in and select geometry by feature when authoring seed
  toolpaths in P6 — a hard constraint: the seed's loops are NEVER recolored).
  The other (copy) slots keep the flat depth coloring from ADR 0024 §1, so the
  seed visually stands out.
- The seed slot is additionally marked by a distinct violet (--vp-seed)
  rectangular outline box and a tree "Sprout" badge. The outline is behind a
  global view toggle (ViewerState.showSeedOutline, default on) so it can be
  hidden if the color difference + tree badge alone read clearly enough.
- The seed slot's loop meshes carry userData { geometryId, seedPlacement } so P6
  can wire feature-picking on the seed slot (picking itself is P6, not N1b).

SOURCE PROVENANCE (governs whether the source also exists outside the nest):
A nest source carries an optional `ownedByNest?: boolean` flag.
- PRE-EXISTING (ownedByNest false/undefined): the user picked a geometry that
  was already in the workspace. The original STAYS as a standalone root geometry
  (tree row + its own viewport position) with a seed badge, and SURVIVES
  delete-nest. It was the user's part before the nest existed.
- MODAL-IMPORTED (ownedByNest true): the part was imported via the nest modal's
  "Add part..." button. It lives ONLY inside the nest — suppressed from the
  standalone viewport render and from standalone tree rows (it appears only as
  the nest's child row) — and is DELETED when the nest is deleted (if no other
  nest still references it). Nothing it brought in lingers in the workspace.

DELETE vs EXPLODE:
- DELETE nest removes the nest plus its owned, non-shared sources (one undo
  restores everything). Pre-existing and shared sources are kept.
- EXPLODE remains as in contract 3: every placement (seed slot included) becomes
  an independent baked geometry at its packed pose and the nest is removed; the
  old "absorb the separate source" question is moot because there is no separate
  floating source under this model. OPEN for visual review: whether explode of a
  nest built from a PRE-EXISTING source should keep the user's original in
  addition to the baked copies (today it absorbs it like any other source).

## Amendment 2 (2026-06-19) — the owned-seed model (supersedes Amendment 1)

> NOTE: This amendment SUPERSEDES Amendment 1 (2026-06-19, "refined seed model and
> source provenance"). Amendment 1 is kept above for history (ADRs are append-only)
> but its source-flag provenance model is no longer how the code works. Where the
> two conflict, this amendment wins.

Amendment 1 settled on a SOURCE-FLAG provenance model: the seed was the original
source geometry positioned at the nest's lower-left slot, and an `ownedByNest`
boolean on each nest source decided whether the source stayed in the workspace
(pre-existing) or was suppressed/deleted with the nest (modal-imported). That model
shipped as PASS 1 and was put to visual review. the operator's verdict (P5) REDIRECTED the
architecture: a nest should create a SELF-CONTAINED, INTEGRATED seed that lives in
the nest, with all ties to the original BROKEN. PASS 2 re-architected to that, and
this is the model the code now implements. The instanced data model (contract 1)
and the ADR 0024 toolpath/post contracts remain unchanged.

THE OWNED-SEED MODEL:
- The nest OWNS a deep COPY of each source as its seed. The owned-seed geometry is
  tagged `ImportedGeometry.ownerNestId === nestId`. createNest deep-copies the
  source's loops, layers, and sketches (with stable loop ids per ADR 0019), sets
  the seed to EXPLICIT NO-STOCK (`stockId` undefined plus a `stockIdLocked` flag so
  the catch-all auto stock never wraps it), and the nest references the COPIES
  (`sources[].geometryId` and `placements[].partId` point at copy ids, not the
  original). N1d will bind the nest sheet to an auto stock; until then owned seeds
  are deliberately no-stock.
- TIES TO THE ORIGINAL ARE BROKEN at creation. A PRE-EXISTING workspace original
  stays an independent root geometry and is unaffected by the nest — deleting the
  original does NOT break the nest, and the nest does not render or suppress the
  original. A FRESH modal "Add part..." import is CONSUMED (deleted after the copy
  is made) via a new createNest `consumeSourceIds` parameter — only fresh-this-
  session modal imports are consumed; pre-existing originals are left untouched.
- The `ownedByNest` source flag from Amendment 1 is now LEGACY and IGNORED (kept on
  `CreateNestParams.sources` only for buildNestSources type-compatibility).
  Provenance is no longer tracked on the source; `ownerNestId` on the owned copy is
  the single source of truth.

SUPPRESSION, DELETE, AND EXPLODE all key on `ownerNestId`:
- Standalone viewport render and tree-root suppression use the selector
  `nestOwnedGeometryIds(project)` (which replaced Amendment 1's
  `ownedSeedGeometryIds`): owned seeds appear only inside their nest, never as a
  standalone root geometry.
- removeNest deletes every geometry with `ownerNestId === nestId` (one undo
  restores everything). Pre-existing originals are NOT touched.
- EXPLODE bakes each per-placement copy into an independent geometry at its packed
  pose (`ownerNestId` undefined) and paints it to the viewport immediately so the
  exploded parts appear without a reload; the nest is then removed. A pre-existing
  original survives explode (it was never part of the nest's owned set). The old
  Amendment-1 "OPEN: should explode keep the user's original" question is RESOLVED:
  the original is independent and always survives.

SEED RENDER AND SELECTION:
- The seed renders at `seedPlacementIds` — the designated lower-left slot — with
  the source's REAL per-layer loop colors (the hard constraint from Amendment 1
  stands: the seed's loops are never recolored). The other (copy) slots keep ADR
  0024's flat depth coloring, so the seed stands out.
- The seed slot is selectable: its tree child row selects the owned-seed geometry
  (the Properties panel shows it) and expands into per-layer rows, each with a
  visibility eye. Toggling a layer hides/shows its loops live in the seed slot via
  the pure helper `visibleSeedLoops(loops, layers)` in restoreNestsToViewport plus
  a reactive `nestSeedVisKey` effect in Viewport.tsx; the per-seed expand state is
  persisted via uiPrefs `expandedSeedIds` (default collapsed). There is NO whole-
  seed hide icon (a lone-seed hide is meaningless — hide the whole nest instead).
- The violet (`--vp-seed`) seed-outline box and its `ViewerState.showSeedOutline`
  view toggle from Amendment 1 remain.

STAGED FOR THE NEXT PASS (not yet built, per the operator's "stage it" decision):
- add/delete layers on the seed, edit the seed sketch, and recompute-on-edit. The
  recompute model is MARK-STALE + a Recompute button (not automatic). `recomputeNest`
  exists in the store today but is currently unused — the next pass wires it.

## Amendment 3 (2026-06-19) — N1d shipped: sheet binds to a FIXED stock; thickness = stock depth

> This amendment refines contract 3 ("Sheet-as-auto-stock and explode"), the
> stock half. The instanced data model (contract 1), the seed model (contracts 2
> + Amendment 2), and the ADR 0024 toolpath/post contracts are all UNCHANGED.
> Status stays Proposed (branch not merged).

Contract 3 as originally written said the nest's sheet "binds to an AUTO stock
(an `AutoStockItem`...)". N1d shipped a CORRECTION: the sheet binds to a FIXED
stock, not an auto stock.

SHEET BINDS TO A FIXED STOCK (corrects contract 3):
- The nest's sheet binds to a `FixedStockItem` (explicit bounds, movable,
  editable depth), NOT an `AutoStockItem`. WHY: auto stocks are strictly
  member-derived (`deriveStockBounds` sizes them from their geometry members),
  but the nest's owned seeds are deliberately NO-STOCK (`stockIdLocked`, per
  Amendment 2). A sheet-sized stock therefore cannot be an auto stock that wraps
  members — it must be an explicit/fixed stock with bounds set from the sheet.

THICKNESS = THE BOUND FIXED STOCK'S DEPTH (a material property):
- 2D parts carry no Z; the sheet's thickness IS the bound fixed stock's DEPTH.
  The nest modal's "Thickness (Z)" selector and a global Settings default
  (`AppSettings.defaultStockThicknessMm` / `defaultStockPaddingXYMm`) only SEED
  the initial value; thereafter thickness is edited as the stock's depth.
- Re-pack regenerates the stock's XY footprint from the sheet (+ padding) but
  PRESERVES depth — thickness is NOT a packing output, so re-packing never
  clobbers the user's thickness.
- Editable from MULTIPLE surfaces (Properties panel, tree stock node, nest
  modal), all routed through `updateFixedStock` — "Many Paths to Same Result".

LIFECYCLE:
- DELETE nest removes the bound stock as well (one undo restores both).
- EXPLODE keeps the bound stock; the baked parts become its members.

MOVE-COUPLING (D3):
- `NestRecord.origin` is the nest's world origin. Moving the bound fixed stock
  translates the nest group + seed pose together; placements stay relative.
- FORWARD NOTE (P6/P7): the POST must read `NestRecord.origin` when expanding
  instances so emitted toolpaths land at the moved nest position.

NEW FIELDS:
- `NestRecord` += `thickness`, `boundStockId`, `origin`.
- `AppSettings` += `defaultStockThicknessMm`, `defaultStockPaddingXYMm`.

## References

- ADR 0024 (0024-instanced-nest-toolpath-post-expansion.md) — the instanced
  data model, toolpath-once-per-source, and post-expansion contract this extends
- ADR 0020 (0020-nested-coordinate-hierarchy.md) — machine/setup/stock/geometry
  frames the sheet-as-stock binding composes with
- ADR 0003 (0003-no-silent-fallbacks.md) — missing bound stock must fail loud
- docs/planning/NESTING-SPEC.md — "COHESION + multi-auto-stock" requirements
  (N0/N1a-d) and the resolved product decisions
- src/types/index.ts — `NestRecord`, `Project.nests`, `AutoStockItem`,
  `ImportedGeometry.stockId`, `ImportedGeometry.ownerNestId`
- src/lib/cam/nesting/seedSelectors.ts — `nestOwnedGeometryIds`, `seedPlacementIds`,
  `visibleSeedLoops` (the owned-seed selectors driving suppression + seed render)
- src/store/index.ts — createNest (`consumeSourceIds`), removeNest, explodeNest,
  recomputeNest (currently unused)
- src/lib/viewport/restoreScene.ts — restoreNestsToViewport (seed-slot layer
  visibility)
- src/components/viewport/Viewport.tsx — the reactive `nestSeedVisKey` effect
- src/components/panels/DesignTree.tsx — geometry tree, folder render model,
  selectable seed child rows
- src/components/panels/PropertiesPanel.tsx — selection cascade
