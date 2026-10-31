# Associative technical drawings - WO-2750

The operator's words: "The print could become a linked document to the model, update with the model." "both Brep and Mesh and use our edge and feature identification methods for mesh geometry"; "make a plan for this." Trusted owner chat, 2026-10-18, P10; full quotation and authority are in [WO-2750](../../queue/WO-2750-associative-technical-drawings.md).

My reading: add a drawing document inside the Model interface, with editable templates, associative views and annotations, and useful PDF/DXF output. Preserve the earlier request for aligned or floating views, detail views, balloons, and repair of removed references.

Measured against: the source observations below and the edit/delete/reassociate/save/reopen counterexamples in section 8. This is a proposed implementation contract, not implemented behavior, an accepted identity contract, a release promise, or a drawing produced by the application.

## 1. Delivery boundary and first release

The current lease is this design file only. No product source, machine behavior, CAM output, credentials, publishing, or live dispatch changes are included. The required worker-result edit to the order is completion metadata. This order is AFTER alpha and changes no committed date.

The useful first release is one modeled part/body lineage per drawing, multiple sheets, orthographic front/top/right and isometric views, aligned or floating placement, a circular detail view, linear/angular/radius/diameter dimensions, center marks, notes, manual numbered balloons, and editable title/tolerance blocks. Include native models, imported BREP in the Model document, and imported meshes through the adapters below. A balloon number is a user annotation; it does not imply an assembly BOM. PDF and sheet-space DXF are release requirements, not an unspecified later export task.

Provide Letter and A4 landscape starter templates. Support mm and inch display, explicit first/third-angle projection, rational view scale, and explicit dimension precision. Internal model measurements and sheet positions use mm; angles use degrees. Display scale never multiplies nominal dimension values. The first release supports bilateral, unilateral, limit, and reference dimension notation plus a configurable general-tolerance table. Do not claim ISO/ASME compliance or infer a standard from a paper size or units. Full GD&T, section/cutaway views, automatic dimensioning, assembly BOMs and multi-model drawings are later phases.

Ship the release as the vertical slices in section 7. A prototype may precede it but must name absent capabilities; it cannot be called the completed associative drawing feature. No estimate or dependency here authorizes another dispatch.

## 2. Existing seams and their limits

Inspected at source HEAD `7ca13dbfe69bebca263ce257c8f7e1c199f44cb3` on 2026-10-20. These are read-only observations, not executed geometry tests.

| Source | Observation and intended reuse | Gap to implement |
| --- | --- | --- |
| [printDrawing.ts](../../src/lib/sketch/printDrawing.ts) | `drawingPrintLayout`, `buildSketchPrintDocument`, `printSketchDocument` provide physical paper sizes, actual/fit math, SVG-based printing and iframe lifetime handling. | This prints a sketch, including a small footer; no model projection, associative annotation model, editable technical title block, or direct PDF writer. Browser Save as PDF can reuse the print seam; validate its physical scale. |
| [exportDxf.ts](../../src/lib/sketch/exportDxf.ts) | `exportSketchDxf` emits R2000 ASCII DXF in mm, using the sketch bake for lines/arcs/circles and outlined text geometry. | No sheet/view model, layers for drawing roles, native associative DIMENSION entities, or image title-block export. Do not pass a drawing off as an ordinary sketch and lose its meaning. |
| [model/types.ts](../../src/lib/cam/geometry/occt/model/types.ts) | Imported BREP display/pick protocol: healed-shape DFS face/edge indices repeat for the same STEP bytes and OCCT build; shapes remain in worker memory. | Those indices are not cross-edit identity. Its horizontal derivations alone are not arbitrary-view hidden-line projection. |
| [element-map.ts](../../src/doc/element-map.ts), [stable-id-spec.md](../stable-id-spec.md) | Model StableIds, typed edge/vertex/face refs, exact/lineage/geometric/lost resolution; `successorsOf` and `isDeleted` expose evidence. | A single-face split can resolve to an overlap winner with status `exact`; geometric fallback is a suggestion for a drawing, not proof of dimension intent. Add drawing policy around existing APIs; do not change global naming policy. |
| [types/index.ts](../../src/types/index.ts) | `ModelBodyRef` separates current body leaf, lineage root and cache version. `sectionSource` separately tracks geometry and frame fingerprints. | Cache version is not durable identity. Drawings need document/item scope, source revision and reference-level provenance. |
| [edgeChains.ts](../../src/mesh/edgeChains.ts) | `extractMeshEdgeChains` rebuilds welded boundary/sharp chains; geometry-derived IDs tolerate triangle/vertex reordering. | No general guarantee across edits, remeshing, changed weld/angle settings or changed bounding-box-dependent quantization. |
| [recognition/types.ts](../../src/mesh/recognition/types.ts), [recognize.ts](../../src/mesh/recognition/recognize.ts) | `recognizeMeshFeatures` returns round features, pockets, slots and drafted pockets; source facets, fit deviation, tolerance and refusals are available. Feature IDs are explicitly stable only within one query. | Query IDs/facet order cannot become durable drawing references. Fit error is not a manufacturing tolerance. Preserve the detector settings and quality evidence. |
| [edit/resolve.ts](../../src/mesh/edit/resolve.ts) | `resolveEditedStlMesh` applies the mesh edit journal, preserves source-facet provenance where possible, and reports a replay stop. | A drawing adapter must consume the edited result and stop information, never independently parse the original STL and show pre-edit geometry as current. Generated facets can lack original source identity. |
| [promoteImportedStepModel.ts](../../src/doc/promoteImportedStepModel.ts), [promoteImportedMeshModel.ts](../../src/doc/promoteImportedMeshModel.ts) | Existing Model wrap/seed paths; STEP supports per-solid payload selection. Mesh wrap here is a prismatic BREP conversion. | Arbitrary raw mesh drawing must not require conversion or imply prismatic conversion works on every mesh. Wrapping creates separate cache lifetimes; it is not a live link to an imported CAM row. |
| [persist/format.ts](../../src/doc/persist/format.ts), [documentHolder.ts](../../src/doc/documentHolder.ts) | Model archives explicitly save DAG/deltas and assets. Holder preserves loaded archives even before lazy Model mount, keyed per Model Item. | No drawing field in `DocumentSaveInput`. Both mounted collection and unmounted pass-through must retain the extension and embedded assets. |
| [SolidsWorkbenchPage.tsx](../../src/components/model3d/SolidsWorkbenchPage.tsx), [store/index.ts](../../src/store/index.ts) | Model lifecycle/remount and project per-item archive collection/load are existing integration seams. | Drawing UI and headless refresh must share one scoped document service, with no second project persistence mechanism. |

No existing source observation proves arbitrary projection fidelity, stable references after topology replacement, or PDF/image DXF fidelity. Those are implementation acceptance tasks.

## 3. Model interface and document lifecycle

Place a contextual "Create drawing" action on the selected Model body and a collapsed Drawings group belonging to that Model Item. Opening a drawing replaces the central Model canvas with a sheet editor; a Model/Drawing switch and a source breadcrumb return to the part. Existing modeling tools remain in their existing workspace. A right panel edits the current view, annotation or template; do not add a permanent drawing toolbar to normal modeling.

The editor has sheet tabs, view placement, dimension tools and a compact reference-status list. Selecting a dimension highlights its source geometry and sheet witnesses. Show the last measured value plus a textual status on a broken reference, keeping its position, tolerance, number, and notes. Repair opens a focused source pick with old/new geometry and value side by side. Accept is one undoable command; Cancel changes nothing. Do not require repairing an unrelated dimension before editing a valid one.

Drawings belong to the Model Item archive, not the transient React component. Geometry edits invalidate relevant projections and measurements; annotation-only edits do not regenerate the model. On successful regeneration publish one consistent revision to all affected views. A failed/partial regeneration leaves the last successful drawing visible, identified as last-known rather than current. Undo/redo includes layout, templates, dimensions and repair. Undoing source edits triggers the same resolver as forward edits.

Drawing/source changes mark the project dirty through the existing holder. Persist before switching Model Items; in-flight results carry scope/revision tokens and cannot overwrite another item or a newer revision. Closing a drawing does not delete its document. Deleting the source body retains the drawing and annotations as missing-source content; undo restores its link. Deleting a drawing never deletes the part. Save As retains internal links within the copied project and never updates the original file.

Imported geometry entry: use the Model interface's existing import/Model Item identity where available. For raw meshes, add a drawing-source adapter under that item, using its edited mesh plus journal revision without forcing BREP conversion. A CAM-only import may be attached explicitly as a source snapshot in the Model interface; retain its provenance and say it is a snapshot, without claiming edits to the original row propagate. Source-file replacement is explicit and invalidates cross-file subshape bindings unless a proven lineage mapping exists.

## 4. Proposed identity and reference contract

This section resolves the recommended representation for review. Implementation waits for an accepted contract with named accepting reviewer and source revision recorded in its follow-up order; no full-order wait is needed for this plan. Do not mint a parallel topology-naming system.

### 4.1 Durable records

Proposed TypeScript notation below is a schema sketch, not existing exports. All IDs are scoped by the owning Model Item/document. Drawing/annotation IDs are document IDs; subshape IDs remain producer-owned StableIds or qualified mesh selectors.

```ts
type SourceRevision = {
  geometryFingerprint: string;   // model-space content, not session cache version
  frameFingerprint: string;      // source-local to chosen view frame
  producerVersion: string;       // kernel/detector identity and settings version
  journalFingerprint?: string;   // raw mesh edit journal
};
type DrawingSource = {
  modelItemId: string;
  documentId: string;
  lineageId: string;              // root, not current feature leaf
  kind: 'model-brep' | 'imported-brep' | 'mesh';
  importAssetId?: string;        // immutable archive asset identity
  importContentFingerprint?: string;
  observedRevision: SourceRevision;
};
type DrawingReference = {
  id: string;
  source: DrawingSource;
  selector:
    | { kind: 'face' | 'edge' | 'vertex'; stableId: string }
    | { kind: 'mesh-chain'; chainId: string; settingsFingerprint: string }
    | { kind: 'mesh-feature'; featureKind: string;
        supportFingerprint: string; settingsFingerprint: string };
  witness: {
    role: 'point' | 'endpoint' | 'center' | 'axis' | 'curve' | 'plane';
    pointLocalMm?: [number, number, number];
    endpoint?: 'start' | 'end';   // interpreted with stored orientation
    orientationLocal?: [number, number, number];
    parameter?: number;          // stored curve parameter is only a seed
    geometrySignature: string;  // snapshot used for validation/candidates
  };
  acceptedRevision: SourceRevision;
};
type ReferenceResult = {
  referenceId: string;
  state: 'current' | 'updating' | 'stale' | 'missing' | 'ambiguous' | 'unsupported';
  resolvedIds: string[];
  via: 'exact' | 'lineage' | 'confirmed-repair' | 'none';
  candidates: string[];
  reason?: string;
  measuredAt?: SourceRevision;
};
```

`geometryFingerprint` invalidates caches; it does not prove which entity survived. `frameFingerprint` invalidates pose-dependent geometry without replacing the reference. In body-local views a project placement change need not alter dimensions; a view intentionally tied to a world datum must refresh. Preserve that choice explicitly.

`DrawingDocument` has `schemaVersion`, `id`, `source`, created/edited timestamps, author metadata, a local template snapshot, embedded assets, `sheets[]`, `references[]`, and `annotations[]`. Each sheet has an ID, physical size, margins, projection convention, unit/precision settings and `views[]`. Each view stores an orthonormal model-to-view frame, rational scale, sheet origin in mm, visibility settings, and either a parent/alignment relation or free placement. A detail view stores parent ID, source-space crop plane/center/radius and magnification; never persist only a screen-pixel crop.

Dimensions contain a typed measurement (`linear`, `angle`, `radius`, `diameter`), ordered reference IDs and witness roles, displayed unit/precision, sheet label/leader placement, last-good raw measurement/revision, and tolerance intent. Tolerance is `none`, `general` (table key plus pinned template revision), `bilateral` (upper/lower deviations), `limits` (explicit lower/upper limits), or `reference`. Store values numerically in mm/degrees and format at render time. A nominal measurement is computed from resolved model geometry, never typed over to hide a stale value; optional prefix/suffix text stays separate. A note/balloon can use a geometry leader or an explicit sheet anchor; the latter has no invented model association.

### 4.2 Resolution policy and counterexamples

Run after every successful source edit/import replacement, deletion, suppression, reorder, rollback, undo/redo, placement change, adapter-setting change and reopen. Treat runtime cache versions only as refresh signals. Before implementing conditions, recheck incident comments and all callers of the source lifecycle, not just this list.

1. Resolve the scoped document/item and body lineage. Never cross to a same-named part or a matching ID in another item. Missing assets/source yield `missing` with preserved annotations.
2. For native or Model-imported BREP, ask ElementMap for the typed selector and inspect lineage multiplicity via its existing queries. Exact live membership or a unique lineage successor can be current only after validating the witness role and unique analytic measurement target. A single-face overlap winner from a multi-survivor split is a repair candidate, not automatic proof. A merge that collapses two dimension endpoints or destroys the intended role is stale even if both IDs resolve.
3. Geometric fallback, symmetric matches, split edges/faces, invalid witness domains, and changed import content without lineage never auto-rebind. Keep all viable candidates for explicit repair; unique geometric proximity alone is still a suggestion. A deleted hole near an identical hole must not move the dimension to the neighbor.
4. Imported BREP indices may seed picks inside the observed import revision. Map through the Model import's existing StableIds for edit association; do not use the CAM worker's face index as durable identity across replacement. Multi-solid selection is part of the source scope, not "first solid" by default.
5. Raw mesh adapters first use `resolveEditedStlMesh`, then the existing edge/recognition functions. A replay stop is stale source content, not a completed update. For an unchanged source content/settings revision, verified chain/support signatures can be current. A reorder-only import may retain chain association only when a one-to-one chain and witness match is proved; recognize query IDs and source facet numbers alone never qualify. A journal edit may retain a reference only with verified provenance, unique support and preserved witness meaning. Remeshing/replacement or changed detector settings without that proof yields candidates or unsupported association; the geometry can still be drawn and dimensioned afresh.
6. Recompute the measurement in model space and project witnesses using the same source revision as the view. Zero-length vectors, noncircular radius picks or an unresolvable silhouette intersection are unsupported measurement targets, not approximated exact values. Curved surface silhouette samples are view-dependent and do not become BREP edges. A view change revalidates such witnesses.
7. Publish reference status, value and geometry together only if the revision token is still current. Never mix old witnesses with a new nominal value. Persist last-good data as a cache with provenance, revalidate on reopen, and visibly distinguish last-known values while source replay is pending.

Mesh dimensions based on a fitted feature carry `maxDeviationMm`, detector tolerance/settings and approximate provenance with the value in the editor and exports. The fit deviation does not become a tolerance or a guarantee about the manufactured part. Nonmanifold, open, nearly coincident, coarse and unrecognized regions must be exercised: unavailable feature recognition does not prevent sheet projection, polyline dimensions or manual notes. Cross-remesh automatic association is explicitly unsupported in the first release unless the evidence above proves the particular reference.

Repair changes one annotation endpoint/reference by explicit pick, shows the resulting nominal value, retains tolerance values/layout by default, and records old/new selectors and revision. Role/type incompatibility is explained at the pick, with another supported selection available. Shared references require an explicit affected-annotations list before applying repair to all; default is the selected annotation. A fixed sheet note is an explicit conversion, never an invisible repair. Undo restores the original selector and stale status.

## 5. Projection and export fidelity

Introduce one drawing projection/annotation scene shared by the editor, PDF and DXF. It contains source-scoped analytic edges where available, approximated polylines with error metadata, visible/hidden/center line classes, text outlines and raster placements. Never measure a perspective screen length or a tessellation chord as an exact analytic radius. BREP hidden-line projection requires a bounded kernel capability spike; current horizontal loop derivation is insufficient. Mesh visible edges use the edited mesh and existing edge chains, with visibility clipping/occlusion validated separately. If hidden-line removal is absent in a prototype, label that limitation and keep it out of first-release completion claims.

| Concern | First-release contract and check |
| --- | --- |
| Units/scale | Sheet-space mm everywhere; a 100 mm source edge at 1:2 occupies 50 mm on paper while its dimension reads 100 mm (or correctly converted inches). Sheet DXF sets `$INSUNITS=4`; clearly name it a sheet drawing. Existing model/sketch true-size export remains separate. |
| PDF | Vector geometry/text outlines with embedded raster branding, physical media size and no accidental browser fit-to-page scaling. Reuse print iframe or add a bounded writer after the spike; verify saved PDF, not only HTML preview. Use an explicit deterministic export timestamp when requested, not export-time changes to author/edit dates. |
| DXF | R2000 sheet-space lines/arcs/circles and outlined annotation glyphs on named visible/hidden/dimension/text layers. In v1 dimensions are exploded geometry with nominal/tolerance meaning preserved visually; exported files are static and carry no LienCAM association. Do not claim native editable DIMENSION semantics. |
| Branding in DXF | Embed raster branding in PDF; DXF offers an explicit companion image bundle with relative IMAGE reference, or an explicit vector-only variant. Never silently omit or trace a logo. Prove image-bundle reopen in an independent reader before marking image-brand DXF support complete. |
| Text/tolerances | Use shared outline layout/font asset policy for sheet, PDF and DXF; cover diameter/degree/plus-minus, upper/lower stacked values and user names. Missing glyphs identify the actual unsupported text; changing unit/precision cannot alter stored tolerance limits. |
| Invalid references | Valid drawing content remains exportable. Include textual stale/missing/approximate labels and last-known revision beside affected dimensions and an export summary. A clean current value cannot be fabricated. No global repair gate; users can produce an honestly annotated partial drawing. |
| Detail/views | Crop and magnification preserve source measurements. Moving an aligned child updates its alignment relation; explicit Float removes only layout alignment. Model association persists in both modes. Parent deletion leaves detail/alignment dependencies repairable, not silently reassigned. |

Export tolerance intent numerically and visually. Proposed geometric error budget: exact primitives retain their analytic parameters; any tessellated projection/export uses a declared error bound no worse than 0.05 mm in sheet space, separately from the mesh's recorded source fit deviation. This is a proposed engineering acceptance metric, not a claimed drawing standard. Validate representative curves at several scales and paper sizes; if the implementation cannot meet it, revise the plan with measured evidence rather than silently loosening tests. Physical PDF sheet length acceptance is within 0.1 mm of declared lengths when inspected digitally; printer calibration is a separate device concern.

## 6. Editable template example

This is a proposed self-contained starter instance, not a file accepted by today's application. It specifies an editable general tolerance policy, not an industry standard. Blank author/branding and tolerance values are user-editable template configuration. General tolerances apply only to dimensions opting into them and never replace explicit limits.

```json
{
  "schemaVersion": 1,
  "id": "starter-letter-landscape-mm",
  "revision": 1,
  "name": "Letter landscape - editable shop template",
  "sheetMm": [279.4, 215.9],
  "marginMm": 10,
  "units": "mm",
  "projection": "third-angle",
  "defaultScale": { "numerator": 1, "denominator": 1 },
  "generalTolerances": {
    "label": "UNLESS OTHERWISE SPECIFIED (mm; degrees)",
    "linearByDecimalPlaces": { "0": 0.5, "1": 0.1, "2": 0.05 },
    "angularDegrees": 0.5
  },
  "titleBlock": {
    "rectMm": [159.4, 170.9, 110, 35],
    "branding": { "kind": "vector-text", "text": "YOUR SHOP", "fontAssetId": "bundled-outline-font" },
    "fields": [
      { "key": "title", "binding": "source.displayName", "rectMm": [2, 2, 106, 6] },
      { "key": "partNumber", "value": "", "rectMm": [2, 9, 52, 6] },
      { "key": "revision", "value": "A", "rectMm": [56, 9, 24, 6] },
      { "key": "drawnBy", "binding": "drawing.drawnBy", "rectMm": [2, 16, 52, 6] },
      { "key": "created", "binding": "drawing.createdDate", "rectMm": [56, 16, 52, 6] },
      { "key": "drawingEdited", "binding": "drawing.editedDate", "rectMm": [2, 23, 52, 6] },
      { "key": "modelEdited", "binding": "source.editedDate", "rectMm": [56, 23, 52, 6] }
    ],
    "brandingRectMm": [82, 9, 26, 6]
  },
  "drawing": { "drawnBy": "", "dateDisplayZone": "America/Chicago" },
  "style": { "lineWidthMm": 0.25, "hiddenWidthMm": 0.13, "textHeightMm": 3 }
}
```

Sheet coordinates above have origin top-left, X right, Y down; field and branding rectangles are local to the title block. Render the tolerance table as a movable sheet block, initially `[10, 170.9, 140, 35]`, outside the title block. Add sheet number, units, projection symbol and per-view scale labels as bound system fields. Every field has editable label, placement, text style, binding or literal override. An override is visibly marked in the editor, stays literal, and is never overwritten by model refresh.

Alternative branding is `{ "kind": "image", "assetId": "logo-1", "fit": "contain" }` in the same rectangle. Store image bytes and content type in the archive; use no remote URL dependency. Vector text uses bundled font outlines; arbitrary uploaded vectors require sanitization before support. Replacing a template explicitly previews affected styles/tolerance defaults; existing explicit tolerances stay unchanged. General-tolerance dimensions pin their table revision until an explicit update with an affected-dimensions preview. Changing displayed decimal precision selects no new tolerance policy silently.

Created and last-edit instants are stored with offsets or as epoch values and formatted using the chosen zone. Model edits update `source.editedDate`; drawing annotation/layout/template edits update `drawing.editedDate`. Opening, printing and exporting change neither. Drawn-by is user-entered metadata, not an authentication claim. Template instances are copied into the drawing; editing the library default never mutates issued drawings.

## 7. Implementation sequence and proposed exact grants

These paths are proposed future allocations, not live ownership. Before each dispatch the architect reconciles all current leases, reads current source incident comments and confirms the accepted identity contract. Do not batch every phase into one lane or modify shared files concurrently. New directories below contain only the explicitly named files. Additional discovered integration seams require a widened grant first.

| Slice / prerequisite | Proposed writable source paths | Named focused tests and exit evidence |
| --- | --- | --- |
| A. Reference and projection spikes; accept contract before B | `src/lib/drawing/types.ts`, `src/lib/drawing/resolve.ts`, `src/lib/drawing/project.ts` | `src/tests/drawing/references.wo2750.test.ts`, `src/tests/drawing/projection.wo2750.test.ts`. Demonstrate split/merge/deletion and scoped import/mesh cases; measure BREP hidden-line and mesh occlusion capability; record adapter limits. Contract acceptance identifies reviewer/source, supported witness roles and import replacement policy. |
| B. Archive extension; after A | `src/lib/drawing/document.ts`, `src/doc/persist/format.ts`, `src/doc/persist/versioning.ts`, `src/doc/documentHolder.ts` | `src/tests/drawing/persistence.wo2750.test.ts`, `src/tests/doc/persist/persist.test.ts`. Add explicit drawing records/assets to save/load with absent-field defaults; retain future-version data on unmounted pass-through; prevent silent loss on unsupported mounted edits. Save/reopen without mounting Model and autosave recovery are mandatory. |
| C. Editor and lifecycle; after A+B | `src/components/model3d/drawing/DrawingEditor.tsx`, `src/components/model3d/drawing/DrawingEntry.tsx`, `src/components/model3d/drawing/drawing.css`, `src/components/model3d/SolidsWorkbenchPage.tsx`, `src/lib/drawing/document.ts` | `src/tests/model3d/drawingEntry.wo2750.test.tsx`, `src/tests/model3d/drawingLifecycle.wo2750.test.tsx`. Production Model entry, switching items, dirty state, deletion/undo and out-of-order regen; before/after captures with part and sheet. |
| D. Raw mesh and imported source adapters; after A, serialized with C if shared host needed | `src/lib/drawing/meshSource.ts`, `src/lib/drawing/brepSource.ts`, `src/lib/drawing/resolve.ts`, `src/lib/drawing/project.ts`, `src/components/model3d/drawing/DrawingEntry.tsx` | `src/tests/drawing/importSources.wo2750.test.ts`, `src/tests/drawing/meshReferences.wo2750.test.ts`. Edited STL journal, reorder/remesh, coarse fit, missing assets, STEP multi-solid scope; no mandatory mesh-to-BREP conversion. |
| E. Templates/dimensions/repair; after B+C+D | `src/lib/drawing/template.ts`, `src/lib/drawing/annotations.ts`, `src/lib/drawing/document.ts`, `src/components/model3d/drawing/DrawingEditor.tsx` | `src/tests/drawing/templates.wo2750.test.ts`, `src/tests/drawing/annotations.wo2750.test.ts`, `src/tests/model3d/drawingRepair.wo2750.test.tsx`. Edit/delete/repair/undo, explicit tolerance preservation, date/branding round trip, aligned/float/detail/balloon cases. |
| F. Export and release evidence; after E | `src/lib/drawing/scene.ts`, `src/lib/drawing/exportPdf.ts`, `src/lib/drawing/exportDxf.ts`, `src/components/model3d/drawing/DrawingEditor.tsx` | `src/tests/drawing/exports.wo2750.test.ts`, `src/tests/model3d/drawingProduction.wo2750.test.tsx`. PDF physical dimensions, DXF independent readback, outlined symbols and image companion assets; one unchanged model/drawing revision across editor and exports. |

Allocate `src/tests/evidence/WO-2750/<slice>/` per slice for its artifacts only, plus the follow-up order's metadata. The actual follow-up WO must enumerate that path and tests, declare its test slice and build, and include exact owner P10/source authority above. Paths in the reuse table remain read-only unless explicitly allocated. No global ElementMap or mesh-recognizer change is currently proposed. If a spike proves one necessary, scope a separate narrowly owned change with its existing consumers and tests before proceeding.

Integration discovery in B/C must trace the holder's mounted collector, pending/unmounted archive, autosave/recovery, item deletion/disposal and project save/load consumers in `src/store/index.ts`. Preferred outcome is the existing per-item archive envelope working unchanged. If project-level serialization or deletion needs alteration, request the exact `src/store/index.ts` grant plus `src/tests/store/drawingProjectRoundTrip.wo2750.test.ts` before editing; the docs-only worker cannot grant it by inference. The same rule applies to menu/i18n seams discovered while wiring the entry action. Document all routes checked and why unchanged routes need no code changes.

## 8. Acceptance and adversarial verification plan

These are required future tests, not counts run in this documentation order. Focused commands are `npx vitest run` followed by the exact named files in the allocated slice; no directory-wide desk suite. Product/config slices also run the required build. Reserve full integration coverage for a meaningful assembled milestone, under its own declared gate.

| Scenario | Observable oracle through production entry/lifecycle | Test owner |
| --- | --- | --- |
| Edit native box 100 to 120 mm | Existing length dimension becomes 120; sheet position and explicit +0.1/-0.05 remain; unrelated hole dimension unchanged. Compare old/new captures and export values. | `annotations.wo2750.test.ts`, `drawingProduction.wo2750.test.tsx` |
| Add unrelated feature; change source placement | Existing intended references remain associated. Body-local dimensions unchanged by rigid placement; world-datum view refreshes. No edits to tolerance intent. | `references.wo2750.test.ts`, `drawingLifecycle.wo2750.test.tsx` |
| Delete dimensioned hole beside identical hole | Original dimension becomes missing/stale with last-good value; never jumps to its neighbor. Deleting an unrelated feature leaves valid dimensions current. | `references.wo2750.test.ts`, `drawingRepair.wo2750.test.tsx` |
| Split/merge/reorder/suppress/rollback | Symmetric and unequal split overlap winners both need validation/repair; collapsing endpoints cannot silently yield a fresh zero dimension; undo/redo resolves through the same policy. | `references.wo2750.test.ts`, `drawingLifecycle.wo2750.test.tsx` |
| Reassociate one endpoint; cancel; undo | Cancel preserves everything. Accept updates only selected dimension/reference, retains tolerance/layout and records repair; undo restores old selector/status. Shared reference update lists affected dimensions. | `drawingRepair.wo2750.test.tsx` |
| Save/reopen; never open Model before next save | Drawings, broken references, template instance/assets, tolerance policy, last-good revision and author/date metadata survive; source revalidation decides current state. Two items with identical local IDs stay isolated. Save As has no original-project side effect. | `persistence.wo2750.test.ts`, `drawingLifecycle.wo2750.test.tsx` |
| Delete source; undo; remove asset | Drawing is retained as missing, recoverable after undo/asset repair. A same-named replacement is never adopted automatically. | `drawingLifecycle.wo2750.test.tsx`, `importSources.wo2750.test.ts` |
| STEP import, multi-solid and replacement | Document/item/solid identity scopes every pick; same bytes can rehydrate, changed bytes/build without proven lineage require repair. CAM DFS index equality alone cannot turn a reference current. | `importSources.wo2750.test.ts` |
| STL journal edit versus original bytes | Production drawing uses resolved edited result. Replay stop keeps visible last-known state; generated facets without provenance do not acquire made-up stable IDs. | `meshReferences.wo2750.test.ts`, `drawingProduction.wo2750.test.tsx` |
| Mesh reorder/remesh and fit ambiguity | Reorder-only edge-chain preservation requires unique verified witness; recognized query ID equality alone fails. Remesh/settings change without proof is stale. Coarse/open/nonmanifold cases retain available projection and show fit deviation/unsupported target honestly. | `meshReferences.wo2750.test.ts` |
| Async edit A, then B; switch item during A | Late A never publishes into B or another item; labels/witnesses and source geometry share revision. Save during update retains a traceable last-good cache. | `drawingLifecycle.wo2750.test.tsx` |
| Aligned, float, detail, balloon | Alignment affects layout only; detail magnification changes paper geometry, never nominal dimensions; deleting parent produces repairable dependencies; manual balloon numbers persist. | `annotations.wo2750.test.ts`, `drawingProduction.wo2750.test.tsx` |
| Template edit and units/precision | Explicit limits and pinned general tolerance survive; default-library changes leave saved instances intact; drawn-by and edit-date rules hold; vector and embedded-image branding reopen offline. | `templates.wo2750.test.ts`, `persistence.wo2750.test.ts` |
| PDF/DXF mm/inch, scales 1:1/1:2/2:1 | Independent readback measures declared sheet sizes/edge lengths and annotation symbols; test stale labels and approximation metadata. DXF image bundle reopens with relative asset references. No bytes-only assertion substitutes for geometry/text fidelity. | `exports.wo2750.test.ts`, `drawingProduction.wo2750.test.tsx` |

The release evidence bundle must contain a native editable part, imported BREP and raw edited mesh, their linked drawings before/after edits, exported PDF/DXF plus image assets, commands/source commits and measured results. Capture the actual Model entry and editor via Playwright. A hand-built projection payload is a unit control, not proof of what the application draws. Tier 2 independent audit/review must challenge the unequal-split winner, same-ID/different-item, stale async result and mesh query-ID counterexamples. Independent review has not occurred as part of this worker plan.

For a genuine behavioral fix in later implementation, retain the same regression failing at the intended assertion on old source and passing on new source, with the required JSON proof and commit ordering. Every measured test failure needs its accountable RED record; never weaken a reference assertion to accept an arbitrary match. This documentation-only plan changes no executable conditions, so no negative-control mutation or machine test is appropriate.

## 9. Decisions, remaining checkpoints and current verification

Decide-and-log proposals: put drawings under their Model Item; keep floating views associative; scope all references by item/document and lineage; allow exact/unique proved lineage updates but require explicit repair for geometric fallback and uncertain mesh evolution; store template snapshots with pinned tolerance policy; export static sheet DXF with explicit raster companion assets. These implement the requested planning scope and remain reversible design decisions. No change to an approved motion routine is proposed, so no before/after motion card is required. No external message or dispatch is part of this worker assignment.

Remaining implementation checkpoints are bounded: A must prove the BREP projection capability and accepted reference policy; B must prove archive compatibility on mounted and unmounted routes; D must document the actually supported mesh witnesses; F must prove PDF and independent DXF/image readback. If unsupported, retain usable projection/manual annotation and describe the actual limit; do not claim unsupported automatic association or substitute another geometry-processing method silently.

Current evidence is source inspection and document validation only. Declared `test-slice: []`: zero executable tests run; no product/config change or build is required. `npm run check -- --dry-run` exposes unconditional `tsc -b`, which exceeds this evidence/design-only scope, so the executable check is not run and no green `.check-receipt.json` is claimed. Validate embedded JSON, local links, proposed-existing integration paths, required acceptance coverage and final owned diff before committing the worker result. The architect's independent review, contract acceptance and all functional captures/exports remain future work.
