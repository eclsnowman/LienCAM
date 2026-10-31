# Workholding assemblies - design draft for discussion

Status: proposal only. This document does not authorize implementation and does
not claim that the defaults below are product decisions.

Labels used below:

- CURRENT FACT: behavior verified in the current source on 2026-09-21.
- PROPOSED DEFAULT: a concrete starting point for the operator to accept or change.
- PRODUCT CHOICE: a question whose answer changes the product model or workflow.

## Goal and boundaries

Model a vise with fixed and sliding bodies, and model individually placed
hold-down clamps, without creating a machine command. The same resolved bodies
must be drawn in Setup/Toolpath/Simulation, supplied to CAM keep-out and tool
reach checks, and supplied to simulation contact checks.

This draft does not add automatic clamp suggestions, broaden which machining
strategies understand workholding, control a physical vise, write a controller
offset, or require an operator gate. "Close on part" is geometry calculation in
the project only. It is not machine motion.

## Current product facts

1. CURRENT FACT: a scene body is workholding when
   `ImportedGeometry.workholding` is true. The flag is saved with the project;
   marking/unmarking is one project undo step. See `src/types/index.ts`
   (`ImportedGeometry.workholding`) and `src/store/index.ts`
   (`setGeometryWorkholding`).
2. CURRENT FACT: imported STL/STEP rows store world position and Euler rotation
   on the geometry row. Model-backed bodies keep identity on the row and resolve
   world position through `Project.modelItemPlacements` and
   `resolveModelReferenceFrame`. See `src/types/index.ts`
   (`ModelItemPlacementRecord`) and `src/lib/cam/modelReferenceFrame.ts`.
3. CURRENT FACT: `resolveWorkholdingObstacles` is the CAM shape path. It reads
   exact STL/STEP/Model meshes when possible, applies each format's display
   frame, and falls back to a transformed bounding box when the shape cannot be
   read. It currently includes every marked body in the project, regardless of
   setup. See `src/store/fixtureObstacles.ts`.
4. CURRENT FACT: the 2D worker consumes those obstacle meshes in world space.
   The 3D operations convert the same world meshes into the part's local frame
   with `workholdingInPartFrame`. See `src/store/index.ts` at the 2D worker
   payload and the Parallel/Waterline/Adaptive 3D dispatch paths.
5. CURRENT FACT: simulation has a separate path. It builds transformed bounding
   boxes directly from geometry rows, so it does not share CAM's exact mesh,
   fallback notice, or Model Item placement resolution. See
   `src/components/simulation/SimulationPanel.tsx` and
   `src/lib/simulation/workholdingContact.ts`.
6. CURRENT FACT: workholding is excluded from derived stock and from an
   all-parts operation. Moving, deleting, reshaping, marking, or unmarking it
   outdates generated operations. See `src/store/dispatchGeo.ts`,
   `src/store/stockAssignment.ts`, and the workholding routes in
   `src/store/index.ts`.
7. CURRENT FACT: project state is saved by spreading `Project` through
   `persistPartialize`, file save/load, and migrations. Project undo stores a
   bounded project snapshot. Additive project fields therefore have established
   save/reload and undo seams. See `persistPartialize`, `persistMerge`, and
   `pushHistory` in `src/store/index.ts`.
8. CURRENT FACT: contour tabs already have the interaction the operator referenced.
   Custom positions are normalized arc fractions keyed by a loop id; the
   Properties panel seeds even positions, and the viewport supports click,
   drag, and double-click removal. The CAM engine consumes the same fractions.
   See `ContourParams.tabLocations` in `src/lib/cam/types.ts`,
   `buildContourTabPlan` in `src/lib/cam/contour2d.ts`, and the tab-edit routes
   in `src/components/panels/PropertiesPanel.tsx` and
   `src/lib/viewport/CNCViewport.ts`.
9. CURRENT FACT: duplicating an imported geometry row makes new ids, copies its
   cached source, and offsets its pose. Because the row is spread, the current
   workholding flag is also copied. Model-backed rows are not duplicable from
   CAM. There is no workholding-definition library today. See
   `handleDuplicateGeo` in `src/components/panels/DesignTree.tsx` and
   `duplicateGeometryRow` in `src/components/panels/PropertiesPanel.tsx`.
10. CURRENT FACT: toolpath moves and workholding obstacles meet in project/world
    coordinates. A setup WCS transforms world coordinates to work coordinates;
    changing a WCS is not a physical move. See `WCS` in `src/types/index.ts` and
    `toWork`/`toWorld` in `src/lib/program/coords.ts`.

## Proposed persisted model

PROPOSED DEFAULT: use one model for vises and clamps: reusable definitions plus
setup-scoped instances. A vise is a multi-component definition with a linear
joint. A strap or toe clamp is normally a one-component definition with no
joint. Both resolve through the same code.

```ts
interface WorkholdingModel {
  definitions: WorkholdingDefinition[]
  instances: WorkholdingInstance[]
}

interface WorkholdingDefinition {
  id: string
  revision: number
  name: string
  kind: 'vise' | 'clamp' | 'fixture'
  components: Array<{
    id: string
    name: string
    geometryId: string
    localPose: RigidTransform
    joint?: {
      kind: 'linear'
      axis: Vec3
      minMm: number
      maxMm: number
      closedAtMm: number
    }
  }>
}

interface WorkholdingInstance {
  id: string
  definitionId: string
  definitionRevision: number
  setupScope: { kind: 'all' } | { kind: 'setups'; setupIds: string[] }
  worldPose: RigidTransform
  jointValuesMm: Record<string, number>
  placement?:
    | { kind: 'free' }
    | {
        kind: 'boundary'
        target: { kind: 'stock' | 'part'; id: string; loopId: string }
        fraction: number
        normalOffsetMm: number
        yawOffsetDeg: number
        lastResolvedWorldPose: RigidTransform
      }
}
```

`Project` would gain one optional `workholding` field holding this model. The
component `geometryId` reuses existing project geometry and its embedded/cached
STL, STEP, or Model body data. A geometry row referenced as an assembly
component is shape data for that definition; it is not also rendered or offered
as an independent part. The assembly resolver, not the source row's scene pose,
places it.

PROPOSED DEFAULT: definitions placed from a personal library are copied into
the project with their required shape data and revision. A project never has a
live pointer to a mutable global library entry. This keeps `.camproject` files
self-contained and keeps an existing job unchanged when a library template is
edited. Updating an instance to a newer library revision must be an explicit,
undoable action.

PROPOSED DEFAULT: migrate each existing `workholding: true` row to a one-body
definition plus one `setupScope: { kind: 'all' }` instance. That preserves the
current all-setup behavior and exact world pose. New instances should require an
explicit setup selection, defaulting to the active setup.

### Small example

```json
{
  "definitions": [{
    "id": "def-kurt-6",
    "revision": 1,
    "name": "6 inch vise",
    "kind": "vise",
    "components": [
      { "id": "fixed", "name": "Fixed body", "geometryId": "geo-fixed", "localPose": "identity" },
      { "id": "moving", "name": "Moving jaw", "geometryId": "geo-jaw", "localPose": "identity",
        "joint": { "kind": "linear", "axis": { "x": 1, "y": 0, "z": 0 },
          "minMm": 0, "maxMm": 152.4, "closedAtMm": 0 } }
    ]
  }],
  "instances": [{
    "id": "vise-top",
    "definitionId": "def-kurt-6",
    "definitionRevision": 1,
    "setupScope": { "kind": "setups", "setupIds": ["setup-top"] },
    "worldPose": { "position": { "x": 210, "y": 85, "z": 0 },
      "rotation": { "x": 0, "y": 0, "z": 90 } },
    "jointValuesMm": { "moving": 63.5 },
    "placement": { "kind": "free" }
  }]
}
```

The literal `"identity"` above is only to keep the example small; persisted
data would use the normal numeric position/rotation object.

## One transform and shape resolver

PROPOSED DEFAULT: introduce one pure public resolver, conceptually:

```ts
resolveWorkholding(project, setupId): ResolvedWorkholdingBody[]
```

Each result carries instance id, component id, definition revision, exact world
transform, world mesh or named bounding-box fallback, and any fallback notice.
The transform is:

```text
worldFromComponent = instanceWorldPose * jointPose(value) * componentLocalPose
```

Imported-format base-frame handling (including STL recentering) and Model body
local display handling live behind this resolver. No preview, CAM, or simulation
consumer may rebuild those transforms.

The consumers are:

- Preview/tree: render only instances whose setup scope includes the active
  setup, using the resolver's world transform.
- 2D CAM: pass the resolver's world meshes to the existing worker payload.
- 3D CAM: pass those same meshes through the existing
  `workholdingInPartFrame` conversion.
- Simulation: use the resolver's meshes instead of rebuilding boxes in
  `SimulationPanel`. Contact remains informational and does not stop playback.

The instance pose stays in project/world space. The active setup WCS may be used
to display or enter coordinates, but editing the WCS must not move physical
workholding. This preserves the current world-coordinate convention and avoids
making an origin correction move a vise.

Every shape or pose change must outdate only operations in the affected setup
scope. A definition edit outdates every setup containing an instance of that
definition. The resolved definition revision, joint values, instance pose, and
shape identities must participate in the operation generation fingerprint so a
change during compute cannot publish an old result.

## Vise workflows

### Create and set the opening

1. Import or choose the fixed body and moving-jaw body.
2. Create a vise definition, choose which component moves, pick its local slide
   axis, and enter minimum and maximum travel.
3. Place an instance in the active setup. The initial numeric opening is stored
   immediately.
4. Edit Opening or drag the moving jaw. Each completed gesture updates one
   joint value and creates one undo step. The edit is limited to the declared
   travel; the UI reports the value it actually used.

PROPOSED DEFAULT: the numeric opening is always the persisted authority.
"Close on part" is a one-shot command that projects the selected part mesh onto
the jaw axis, computes the opening plus an entered clearance, limits it to the
travel, and writes the resulting numeric opening. It does not establish a live
constraint and it never moves hardware.

Manual opening is predictable and continues to work when the selected part is
edited or removed. One-shot close-on-part is fast but becomes stale if the part
later changes; the normal workholding staleness/fingerprint path then requires
CAM regeneration, not a modal gate. A live close-on-part constraint would follow
part edits automatically, but can make a saved vise jump when geometry changes
and adds a long-lived dependency. That is why live constraint mode is not the
proposed default.

If the selected part does not fit inside the declared travel, the command can
still move the jaw to the nearest legal endpoint and state the remaining gap or
interference. Manual entry remains available. Nothing is sent to a machine.

### Save, reopen, and reuse

The definition, world instance pose, setup scope, and numeric joint value live
in `Project`, so browser hydration, `.camproject` save/open, and project
undo/redo use existing seams. Saving a definition to the library copies its
shape bundle. Placing it again creates a new instance with independent pose and
joint values while sharing the project-local immutable definition revision.

## Clamp workflows

### Place like a tab

1. Choose a clamp definition, then explicitly choose Stock edge or Part edge.
2. Click a visible closed boundary in the Setup view. The picker records the
   target id, stable loop id, and normalized arc fraction, matching the useful
   part of contour tab placement.
3. The boundary tangent sets clamp yaw; the outward normal and editable normal
   offset place the clamp body. The resolved world pose is shown immediately.
4. Click the boundary to add another clamp, drag a clamp to slide it along that
   same boundary, and delete a clamp directly. No automatic suggestions or
   "you need more clamps" messages are produced.

The clamp record belongs to project workholding, not `Operation.params`.
Contour tabs are operation-specific cut features; clamps are physical setup
objects consumed by every relevant operation.

PROPOSED DEFAULT: let the operator choose stock edge or part edge for each
placement rather than choosing one application-wide policy. A stock-edge clamp
follows stock boundary changes; a part-edge clamp follows the chosen part and
its placement. Persisting the normalized fraction gives the same edit behavior
as tabs while target id and loop id prevent a clamp from silently jumping to a
different body.

PRODUCT CHOICE: if the referenced loop disappears, either (A) keep the last
resolved world pose and show "edge reference lost" only in that clamp's
properties, or (B) remove the anchor and make it a free placement. Proposed
default is A: preserve the physical arrangement and do not block CAM. The
operator can reattach or move it.

### Move, duplicate, and change setup

- Move edits the instance or its boundary anchor, never the shared definition.
- Duplicate makes a new instance id with copied setup scope, pose, joint values,
  and anchor. It shares the immutable definition revision.
- "Move to setup" changes scope and preserves world pose by default, so the
  body does not jump. "Copy to setup coordinates" is a distinct command that
  converts through the source and destination WCS for repeated fixture layouts.
- Delete removes only the instance. Removing the last instance does not delete
  a reusable definition or its library template without a separate action.

## Consumer-route census

The following current routes were checked because they consume workholding
classification, shape, or pose. The implementation must either repoint them to
the assembly resolver or deliberately retain their current role.

| Route | Required treatment |
| --- | --- |
| `dispatchGeo.isWorkholdingGeometry` | Retain for legacy/migration; add instance-aware selectors rather than changing unrelated part rules. |
| `stockAssignment.derivedStockMembers` and auto-stock bounds | Assembly component assets and instances never size stock. |
| `resolveOpGeometrySources` all-parts filter | Preserve current exclusion; do not make assembly components cut sources as part of this feature. |
| `DesignTree` workholding group and Properties workholding row | Present definitions/instances without also presenting component asset rows as parts. |
| Geometry and Model Item move, delete, regen, lock, mark/unmark actions | Route assembly edits through one undoable action family; preserve legacy actions for non-assembly rows. |
| `fixtureObstacles.resolveWorkholdingObstacles` | Become or call the single setup-scoped resolver; retain exact-mesh/fallback behavior. |
| 2D worker dispatch | Consume active-setup resolved world meshes. No strategy rule change. |
| Parallel, Waterline, and Adaptive 3D dispatch | Consume the same meshes converted to each part frame. No strategy rule change. |
| `SimulationPanel` workholding contact | Stop deriving independent geometry-row boxes; consume the same resolved bodies/fallbacks as CAM. |
| `persistPartialize`, file save/open, migrations | Round-trip optional model; migrate marked rows without changing their world pose or current all-setup effect. |
| `pushHistory`, undo, redo | One snapshot per completed jaw/clamp gesture or command; zero-delta edits add no history. |
| Geometry duplicate/import cache paths | Definition import owns shape-copying; instance duplication never duplicates bytes. |

No controller, pendant, live program builder, postprocessor, or machine-seat
route needs this model. Generated moves already embody avoidance; the machine
does not need a vise-opening command or clamp-placement payload.

## Risks and unresolved product choices

1. PRODUCT CHOICE: should old free-standing workholding remain visible in all
   setups after migration? Proposed default is yes for exact compatibility.
2. PRODUCT CHOICE: should a boundary clamp stay attached when its stock/part
   moves? Proposed default is yes; a lost loop keeps its last world pose.
3. PRODUCT CHOICE: ship a personal workholding library with the first assembly
   release, or first ship project-local reusable definitions plus import/export?
   Proposed default is project-local first, then the library as a separate
   slice; it avoids mixing global persistence into collision correctness.
4. PRODUCT CHOICE: should close-on-part remain one-shot or optionally become a
   live constraint? Proposed default is one-shot for predictable saved jobs.
5. Risk: source shapes use different local display frames today. The shared
   resolver must own STL recentering, STEP coordinates, and Model local display
   frames or preview/CAM/simulation will disagree.
6. Risk: an invalid jaw axis or travel range makes a transform undefined.
   Definition creation must normalize a finite nonzero axis and require
   `maxMm >= minMm`; corrupt loaded data should use a conservative swept-volume
   fallback plus a named notice, not silently place one jaw at identity.
7. Risk: a definition edit can affect many instances and setups. Revision and
   dependency indexing are required so all and only affected ready operations
   become outdated.
8. Risk: edge loop ids can change after a body is remodeled. The persisted last
   world pose prevents a disappearance or jump, but the operator must choose whether
   reattachment is manual or whether geometric matching is worth a later slice.

## Acceptance routes for a future implementation

1. A pre-feature project with two marked bodies opens with the same world poses,
   both visible and effective in every setup; save/open and undo preserve them.
2. A two-body vise at 0, midpoint, and maximum travel resolves fixed and moving
   component meshes to measured world transforms. Preview, 2D CAM, every wired
   3D family, and simulation receive matching source identities and bounds.
3. Dragging or typing one opening is one undo step; zero movement is none.
   Undo/redo, browser hydration, and file reopen restore the same numeric value.
4. Close-on-part computes from a rotated part, applies clearance, stays within
   travel, persists the result, and produces no controller or machine command.
5. A clamp can be placed on both stock and part boundaries, slid across the loop
   seam, duplicated, deleted, and moved/copied between setups. Every completed
   action is one undo step and every instance has a distinct id.
6. Switching setups shows and resolves only instances in that setup's scope.
   Editing one instance outdates ready operations only in its affected setups;
   editing a shared definition outdates every setup using that revision.
7. A missing exact shape produces the same named bounding-box fallback in CAM
   and simulation. A Model-backed component moved by Model Item placement cannot
   appear at one pose in preview and another in collision checks.
8. A missing boundary target or loop preserves the clamp's last resolved world
   pose, identifies the lost reference in its properties, and does not add a CAM
   gate or an automatic clamp suggestion.
9. A library/template placement copies a self-contained revision into the
   project. Editing the library later does not change an existing project;
   explicit update is undoable and outdates affected operations.

## Minimal implementation slices

1. Schema and resolver: additive project types, marked-row migration, pure
   transform/shape resolver, save/reload/undo tests, and frame/fallback tests.
2. Vise instance editing: definition creation from existing bodies, setup scope,
   manual joint value, preview, travel endpoints, and one-step undo.
3. CAM and simulation convergence: repoint all current keep-out/contact consumers
   to resolved setup bodies, add fingerprint/outdating coverage, and remove the
   independent simulation-box derivation.
4. One-shot close-on-part: selected target, mesh projection, clearance, bounded
   numeric result, and rotated-target tests. No machine integration.
5. Clamp placement: boundary picker, fraction/tangent resolver, click/drag/remove,
   duplicate and setup move/copy workflows, plus lost-anchor behavior.
6. Reuse: project-local definition import/export first; personal library and
   explicit revision update only after the collision model above is proven.

Each slice should retain focused tests and visual evidence appropriate to its
surface. None requires broadening machining rules or adding an operator gate.
