// INT-17A-R1: the CAN-FAIL consumer census.
//
// THIS IS A TRIPWIRE, NOT A PROOF. (INT-17A-R2, per the binding ruling in
// coordination/DECISIONS.md 2026-07-18, "SKC-59 census two-bounce STOP".)
//
// The R1 audit's third finding was that this scan is not SOUND: it anchors on
// the literal text `project.geometry`, so it cannot see a helper that reads a
// geometry collection handed to it through a parameter or an alias. That is
// correct, and it is not fixable here - making it sound means static dataflow
// analysis of an untyped collection through the whole call graph, which is an
// analyzer problem, not a test problem. Each attempt at one yields a new
// clever-but-unsound analyzer, which is precisely the two-bounce pattern the
// SKC-59 ruling stopped.
//
// So the ruling's part 3 applies: the INVARIANT moved to where it is sound by
// construction, and this census stays as the cheap early warning it is good at.
//   - SAFETY now lives at the compute BOUNDARY: computeGeometryScope() in
//     src/store/dispatchGeo.ts runs where a geometry collection ARRIVES at a
//     compute/coordinate/height resolver. Any reader - literal, aliased, or not
//     yet written - is covered there without being enumerated. See
//     src/tests/store/int17aR2Boundary.test.ts.
//   - THIS FILE catches the common shape (a new file that reads
//     project.geometry directly) and makes whoever adds one state what they do
//     with a modeled entry. It is a prompt for a human, not a coverage claim.
// No further soundness rounds are owed against this scan.
//
// WHY THIS GATE EXISTS. Round 1 enumerated the consumers the preflight named -
// the op picker, the DesignTree format gates, the restore chain, the viewport
// filter - and every one of those was handled correctly. The audit then found
// four bypasses anyway, and all four were readers NOBODY HAD LISTED: a rehydrate
// blob, an `__all__` aggregation, an `undefined`-becomes-default fallthrough, a
// cascade delete. The defect was not in the seams that were classified; it was
// that the consumer set came from a hand-written list instead of from the code.
//
// So the census is DERIVED from the code, here, on every run. This test greps
// the production tree for readers of `project.geometry` and fails when the file
// set drifts from the classified manifest below. A new consumer cannot land
// silently: whoever adds one must come here, read what a model-origin entry is,
// and record which class their reader falls into.
//
// It is deliberately a FILE-level tripwire rather than an expression-level one.
// A finer grep would be noisy enough to get muted, and file granularity already
// catches the thing that actually happened - a whole surface nobody considered.
// The per-seam classifications live in
// coordination/reports/INT-17A-R1-evidence/consumer-census.md, and every
// INCLUDES-model row there that must refuse has a behavioural test in
// src/tests/store/int17aR1Bypasses.test.ts or
// src/tests/components/DesignTree.modelBodyBypasses.test.tsx.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC = join(process.cwd(), 'src')

/**
 * Every production file that reads the project's geometry collection, with the
 * class it falls into for a model-origin (`format: 'model'`) entry.
 *
 *  REFUSES              - has an explicit model-origin gate that turns the entry
 *                         away by name (the Stage-1 read-only rule).
 *  REFUSES-BY-SHAPE     - excludes it without naming origin, because it requires
 *                         something a modeled entry does not have (loops,
 *                         layers2d, type 'mesh'/'brep', an stl/step/dxf format
 *                         allow-list, source bytes). Safe today; NOT relied on
 *                         alone at any seam an operation or a delete flows
 *                         through - those all got an explicit origin gate too,
 *                         because the audit's bypass row wore `type:'brep'` and
 *                         loops precisely to defeat shape-based gates.
 *  HANDLES              - deliberately operates on modeled entries (the producer,
 *                         the renderer, the persistence path).
 *  ALLOWED-PASSTHROUGH  - sees the entry but does something Stage 1 permits:
 *                         listing it, counting it, naming it, colouring it,
 *                         hiding it, folding it, moving it, selecting it.
 */
const CENSUS: Record<string, string> = {
  'App.tsx': 'ALLOWED-PASSTHROUGH: geometry COUNT for the header badge.',
  'lib/exportCenter/index.ts': 'ALLOWED-PASSTHROUGH + REFUSES-BY-SHAPE: WO-2448 (e56294822, live-draft follow-up aeae543e5) routes existing exports without mutating geometry. Original rows require originalFile or stl/step format; normal model-origin rows have neither. Sketch ownership/name/draft reads require layers2d/sketches, absent on normal model rows. The nesting save passes the full list to buildSheetExportModel, which resolves existing placements by id and skips rows with no closed loops. The project save preserves all rows through existing persistence; the separate Model row exports live workbench bodies through its existing hooks, not through project.geometry or imported-source caches.',
  'components/modals/BooleanMeshDialog.tsx': "HANDLES: the whole point of this MSH-4 dialog is a modeled entry as the second boolean operand -- isModelBooleanBodyRow (booleanMeshModel.ts) explicitly gates on isModelOriginGeometry(g) plus a drawable display tessellation to populate modelRows/the 'Model body' picker and pick-in-viewport list, and Run calls booleanMeshVsModelBody to compute a real boolean against it (recording its id in the result's booleanProvenance.modelBodyId for the Edit re-run path). Deliberate compute-time use of a modeled entry, not a passthrough or a refusal.",
  'components/modals/NestModal.tsx': 'REFUSES-BY-SHAPE: isNestable needs a closed loop with >=3 points; a modeled entry carries none, so it never reaches the nest picker.',
  // BK-178-DECOMP (commits 2d398686c/999fa839c/bfbff0258, 2026-07-24) split the
  // 5900-line NewOperationModal.tsx into a thin wrapper + child modules; every
  // project.geometry read (operationSourceGeometries, parallel3dSolids, the
  // chamfer height resolvers, etc.) moved verbatim into the new
  // NewOperationModalBody.tsx - same code, same behaviour, pure relocation
  // (confirmed by reading the moved block: it still carries this census's own
  // "CAM-BINDING Stage 1"/"INT-17A-R1 C2" comments word for word). The wrapper
  // itself (NewOperationModal.tsx) no longer reads project.geometry at all, so
  // this row replaces the old NewOperationModal.tsx entry rather than adding a
  // second one.
  'components/modals/NewOperationModalBody.tsx': "REFUSES + CAM-BINDING Stage 1 ADMITS: operationSourceGeometries and parallel3dSolids gate on format via isModelOriginGeometry, but OR in isModelOpSourceEligible (modelOrigin.ts) so a model-origin row is now a legal, selectable op SOURCE (not yet computable - Stage 2) at whole-body granularity; the All Parts count and the chamfer geometry_face __all__ reference still resolve through resolveOpGeometrySources, which still excludes model-origin rows from that aggregate unchanged (C2).",
  // WO-1586/WO-1587: the seat command's markup moved out of
  // `components/modals/SeatInViseCommand.tsx` (WO-1574's original modal,
  // mounted nowhere, deleted by WO-1594) and into the strip Viewport.tsx
  // actually mounts. Same reads, same commit call, plus WO-1587's viewport
  // face picks - which arrive as a world point + normal from a raycast
  // against the DRAWN mesh and are converted by localFaceFromWorld using
  // only that row's position/rotation, so they add no new read of a modeled
  // entry's model data either.
  'components/viewport/SeatInViseStrip.tsx': "ALLOWED-PASSTHROUGH: lists every row as a workholding or part candidate keyed only on the `workholding` boolean, never on format, so a modeled entry is selectable on either side; it reads that row's name/boundingBox/position/rotation to build the contact face pair and calls updateGeometryTransform to commit the seat. It never reads loops, layers, source bytes or a kernel handle. NOTE, and the reason this row is a passthrough rather than a refusal: nothing in THIS file gates on origin, but the one write it makes - updateGeometryTransform - carries the store's own named model-origin refusal (refuseGeometryTransformForModelBody, INT-17C C1 step 3b, behaviourally pinned by int17cC1PlacementGates.test.ts), which throws; the strip's runSeat catch surfaces it in the refusal strip instead of reporting a seat that did not happen, and the imperative viewport sync is never reached. So selecting a modeled body as the PART (the side that never moves) genuinely works, and seating one as the moving workholding body is turned away by name at the store.",
  'components/modals/SetupModal.tsx': 'ALLOWED-PASSTHROUGH: id-keyed name lookup for a snap target.',
  // Smart Height V2 starting-policy selection (189885f4). It only ever reads a
  // row's TYPE - counting implicit single solids (mesh/brep/model), asking
  // whether any target surface exists, and passing the id through
  // resolveOpGeometrySources, which itself excludes model-origin rows from the
  // '__all__' aggregate (C2). It never derives loops, bounds or a profile from
  // a modeled entry, so it can neither bypass nor mis-source one.
  'components/modals/useNewOperationModalState.ts': 'ALLOWED-PASSTHROUGH: type-only reads (mesh/brep/model presence) to pick the starting Smart Height policy; ids go through resolveOpGeometrySources, which keeps its C2 exclusion.',
  // Machine-tab program context (WO-379 family). targetPartSnapshots copies id,
  // name, format, bounding box, position and rotation of every row owned by
  // the setup stock into a display-only comparison snapshot; a modeled entry
  // is copied with format:'model' verbatim and nothing is derived from it.
  'lib/machine/programContext.ts': "ALLOWED-PASSTHROUGH: display-only target-part snapshot (id/name/format/bbox/placement) per owning stock; a modeled row is copied with its format:'model' and never interpreted.",
  'components/modals/SketchEntryModal.tsx': 'REFUSES-BY-SHAPE: listSketchEntryCandidates walks layers2d; a modeled entry has none.',
  'components/model3d/SolidsWorkbenchPage.tsx': 'HANDLES: the PRODUCER. The regen hook derives display for changed bodies and calls syncModelBodies.',
  'components/panels/DesignTree.tsx': 'REFUSES + HANDLES: refuses delete, duplicate (C4) and names the folder-delete outcome; handles listing, colour, visibility, rename, folder moves, AND (CAM-BINDING Stage 3) stock membership - the "Owning stock" control now renders for a modeled row too.',
  'components/panels/PropertiesPanel.tsx': 'ALLOWED-PASSTHROUGH: renders name/position/rotation/colour for the selected entry; stock membership comes from the (CAM-BINDING Stage 3) manual setters, which now accept a modeled entry.',
  'components/simulation/SimulationPanel.tsx': 'REFUSES-BY-SHAPE: keyed off op.params.geometryId and toolpathMoves; no op can name a modeled entry (C2).',
  'components/toolbar/ModeTabStrip.tsx': "HANDLES: the UI-EDIT-MODEL-FROM-BODY navigation gate (ModeTabStrip.tsx:71-80) reads the selected row only to test modelItemId, which types/index.ts:438-446 documents as present IFF format:'model' and absent on every other row; when set and openModelItem's target Model Item exists it navigates via openModelItem (store/index.ts:10298-10301 - sets workspace + activeModelItemId only, no geometry read/write) instead of falling through to the plain setWorkspace('part'). Never cuts, deletes, stock-binds, or aggregates the entry - a Stage 1 allowed navigation, same class as DesignTree's selection/listing paths.",
  'components/viewport/Viewport.tsx': 'HANDLES: the live model-body draw/teardown effect, keyed on ref.version AND display presence (C1).',
  // WO-1267 gave the program runner the same legend builder the overlay uses:
  // collectToolpathSections(enabled, project.geometry, project.nests) at
  // machineSession.ts:6004. Same function, same argument, so the same refusal
  // holds - it resolves geometry ONLY through op.params.geometryId, and C2 stops
  // any op naming a modeled entry. Classified from that shared call, not from a
  // reading of the caller.
  'lib/machine/machineSession.ts': 'REFUSES-BY-SHAPE: builds the toolpath sections the post would have sent, via collectToolpathSections - geometry resolves only through op.params.geometryId; no op can name a modeled entry (C2), the same shape as ViewportOverlay.tsx and SimulationPanel.tsx.',
  'components/viewport/ViewportOverlay.tsx': 'REFUSES-BY-SHAPE: the toolpath-legend section builder (collectToolpathSections) resolves geometry only via op.params.geometryId; no op can name a modeled entry (C2), same shape as SimulationPanel.tsx above.',
  'components/viewport/ViewportToolbar.tsx': "ALLOWED-PASSTHROUGH: transform gizmos act on the selected part, but the commit they drive (gizmo drag-end, Drop to floor, Settle - all via CNCViewport.ts's onPartTransformChange) is routed by handlePartTransformChange (Viewport.tsx:236-246) to updateModelItemPlacement for a format:'model' row, never to updateGeometryTransform - so the move is permitted and lands on the Placement record, not the geometry row's own position/rotation. refuseGeometryTransformForModelBody (store/index.ts, INT-17C C1 step 3b) is not on this path.",
  'components/viewport/sceneStockRebuildKey.ts': 'ALLOWED-PASSTHROUGH: rebuild key over all entries; a modeled body itself still contributes an unchanging id:position term (its own position/rotation stay identity forever), but (CAM-BINDING Stage 3) a stock it is locked to now DOES change PhysicalStock.bounds on a model edit, and the key already encodes every stock bounds term - no change needed here for the box to live-rebuild.',
  'hooks/useGlobalShortcuts.ts': 'REFUSES: the Delete/Backspace handler turns a modeled entry away with a named notice.',
  'lib/cam/generationFingerprint.ts': "HANDLES: CAM-15's generation-freshness fingerprint deliberately hashes the WHOLE project.geometry array (including modeled entries) as one of the toolpath's own generation inputs -- it neither selects nor mutates a modeled entry, it detects drift in it, same class as the producer/persistence seams above.",
  'lib/cam/modelBodyAdapter.ts': "HANDLES: this module is the PRODUCER of model-origin entries (INT-17A Stage 1), so a format:'model' row is its subject rather than a foreign shape it must guard against. Its project.geometry read is BUG-AC-FRAME's load-time binding repair (7ccee2ab8): it maps the list, returns every non-model row untouched by identity (`if (!isModelBodyEntry(geo)) return geo`), and for a modeled row re-resolves modelBody.ref.lineageId from the live per-item lineage index. Repairs are reported out as ModelBodyBindingRepair records rather than applied silently, and the module stays PURE -- no store, no viewport, no kernel, and never a geoId/kind/index handle (the IDENTITY LAW in its own header).",
  'lib/cam/nesting/seedSelectors.ts': 'REFUSES-BY-SHAPE: selects on ownerNestId, never set on a modeled entry.',
  'lib/post/buildPostInput.ts': 'REFUSES-BY-SHAPE: reads operations and their toolpaths, not geometry rows directly.',
  'lib/post/postProject.ts': 'REFUSES-BY-SHAPE: same - posting walks computed operations.',
  'lib/post/workOffsets.ts': 'HANDLES: resolveSetupWorkOffset passes project.geometry into setupStockConsistency while resolving the physical stock that owns a setup\'s G54-G59 frame. That resolver deliberately accepts a model-origin row when it is a legal operation source with a real, assigned stock, and otherwise declines to resolve an owner; this reader neither mutates the row nor bypasses the existing compute/post stock guards.',
  'lib/sketch/types.ts': 'REFUSES-BY-SHAPE: sketch candidacy is a dxf/svg/sketch format allow-list.',
  'lib/viewport/CNCViewport.ts': "ALLOWED-PASSTHROUGH: WO-1573's isPartWorkholding looks one row up by id (`project.geometry.find((g) => g.id === id)`) only to read the workholding mark and pick the body's display color. A format:'model' row may carry the mark like any other body (WO-1572), and nothing of its loops, layers, source bytes or kernel handle is read, selected or mutated here - the viewport draws the modeled body exactly as before, only its material color follows the mark.",
  'lib/viewport/restoreScene.ts': 'HANDLES: the format:model restore branch draws from the entry display, recovering it from the durable cache on a refresh rehydrate (C1).',
  'store/dispatchGeo.ts': 'REFUSES + HANDLES: computeGeometryScope is still the compute BOUNDARY GUARD (R2 C1) for cut-time coordinate/height resolution (resolveOwningStock, resolveTopZ, resolveModelBottomZ, owningStockWorldBounds - a disclosed CAM-BINDING Stage 3 gap, not yet threaded to see a model-derived stock member); geometryWorldBounds/deriveAutoStockBounds now HANDLE a modeled entry (Stage 3), resolving its world bounds through resolveModelReferenceFrame instead of refusing it.',
  'store/index.ts': 'REFUSES + HANDLES: refuses removeGeometry and op source resolution (C2/C4); handles syncModelBodies (now including CAM-BINDING Stage 3 live stock re-derivation), persistPartialize, the durable display cache, AND (Stage 3) the four stock setters, which now accept a modeled entry instead of refusing it.',
  'store/migrateHierarchy.ts': 'REFUSES: skips modeled entries when stamping the catch-all stockId, and excludes them from the isFullyMigrated fast path (C3, unaffected by Stage 3 - migration still never auto-assigns one).',
  'store/stockAssignment.ts': 'REFUSES + HANDLES: assignGeometryToStocks still fails closed for an UNLOCKED modeled entry (never auto-swept by containment), but (CAM-BINDING Stage 3) now HANDLES a LOCKED one - respects the lock exactly like any other geometry, and deriveStockBounds resolves its world bounds. getUnassignedGeometry still skips modeled entries entirely (deliberate, unaffected). geometryBearingStockIds (MODEL-STOCK-NEW-SETUP-WCS-PICK) now ALSO HANDLES a LOCKED model row - it counts as geometry-bearing for the new-setup WCS smart-pick, same lock-only rule; an UNLOCKED model row is still invisible there (C3 unchanged for the unlocked case).',
  // Added after the census was last repinned (workholding family, reference-image/sketch
  // panels, agent snapshot, import and archive paths). Each row was classified by reading the
  // project.geometry read in that file.
  'components/machine/ProgramPanel.tsx': "ALLOWED-PASSTHROUGH: hands project.geometry to setupEnabledCutTimeMs as the cut-time context for the program-length readout; display-only, and geometry resolves there only through op.params.geometryId, which no op can aim at a modeled entry (C2).",
  'components/panels/sketch/ReferenceImage2d.tsx': "REFUSES-BY-SHAPE: resolveSketchEditorOffset looks a row up by sketch layer id (layers2d); a modeled entry carries no layers2d, so it never matches.",
  'components/panels/sketch/SketchToolbox.tsx': "REFUSES-BY-SHAPE: reads the sketch name from the row owning the sketch layer (layers2d); a modeled entry has none.",
  'components/workholding/ClampEditor.tsx': "ALLOWED-PASSTHROUGH: workholding editor (the WO-1572..1587 workholding family); the geometry list is only a read-only source for the part/boundary pickers and the viewport preview. A modeled row is a legal clamp part like any body; nothing here writes the row or reads its loops, layers or source bytes.",
  'components/workholding/ViseEditor.tsx': "ALLOWED-PASSTHROUGH: vise editor reads the geometry list only to offer rows as fixed/jaw/part bodies and to preview them; read-only, it never mutates a row or reads loops, layers or source bytes.",
  'components/workholding/WorkholdingReuse.tsx': "ALLOWED-PASSTHROUGH: looks one row up by id to show its name when offering a saved workholding setup for reuse; never mutates it.",
  'components/workholding/clampViewport.ts': "HANDLES: looks the clamped row up by id for the viewport preview and resolves a modeled row's pose through isModelOriginGeometry (its model placement), not its own identity position/rotation.",
  'components/workholding/viseViewport.ts': "ALLOWED-PASSTHROUGH: id-keyed row map for the vise preview; the pose and display come from the workholding resolvers (resolveWorkholding.ts), which are model-aware.",
  'lib/agent/commands.ts': "ALLOWED-PASSTHROUGH: the read-only agent project snapshot - lists feature and body summaries (name/format/bbox) of every row and the folders; a modeled row is summarised, never interpreted or changed.",
  'lib/import/importGeometryFile.ts': "REFUSES-BY-SHAPE: after an IGES-via-STEP import, stamps originalFile only onto rows new in this import with format 'step' and this file's name; a modeled entry has none of those, and no other row is changed.",
  'lib/post/setupSheet.ts': "ALLOWED-PASSTHROUGH: WO-2439 lists standalone holder names from workholding-marked rows, excluding definition component ids. Reads only id/name/workholding; modeled rows need no geometry interpretation and are never mutated.",
  'lib/projectBinaries.ts': "HANDLES: persistence path - gathers each row's original file or its stl/step bytes into the project archive; a modeled entry has neither (its bytes live in the document DAG, collected separately just below), so it contributes nothing here.",
  'lib/sketch/demoSeed.ts': "REFUSES-BY-SHAPE: finds the row owning a demo layer by layers2d; a modeled entry has none.",
  'lib/workholding/clamps.ts': "HANDLES: clamp boundary derivation - any non-workholding, non-nest row is a clampable part, including a modeled body, whose pose comes from markedRowWorldPose over the model placements; reads only, no row is mutated.",
  'lib/workholding/closeOnPart.ts': "ALLOWED-PASSTHROUGH: looks up the part row by id to read its bounding box and pose for the close-on-part move; read-only.",
  'lib/workholding/contactBodies.ts': "ALLOWED-PASSTHROUGH: builds clearance boxes from rows' bounding boxes and placements (and marked workholding rows) for the collision readout; read-only, a modeled row contributes its box like any body.",
  'lib/workholding/resolveWorkholding.ts': "HANDLES: resolves workholding bodies and poses; a modeled row is posed through isModelOriginGeometry / resolveModelReferenceFrame instead of its own position/rotation. Read-only.",
  'lib/workholding/reuse.ts': "REFUSES-BY-SHAPE + HANDLES: reuse snapshots rows by id; the stl-mesh capture requires format 'stl' AND !isModelOriginGeometry(row), so a modeled entry is never captured as a mesh; its pose is model-aware.",
  'lib/workholding/vise.ts': "ALLOWED-PASSTHROUGH: id lookups for the fixed and jaw rows to compute the vise seat from their bounding boxes and poses; read-only, never mutates a row.",
  // WO-2646 (704318587/28564fe62) added the exact-shape contact check. Classified
  // by WO-2652 from the two project.geometry reads in that file.
  'lib/simulation/workholdingContact.ts': "HANDLES + ALLOWED-PASSTHROUGH: primeWorkholdingContactShapes reads only rows that are placed vise/clamp components and caches each one's exact shape through readDisplayShape (workholding/shapes.ts), which takes a modeled row's shape from modelBody.display via isModelOriginGeometry and never from source bytes or a kernel handle; a row with no readable shape keeps its box (over-report, never miss). workholdingContactShapes poses components through resolveInstancePlacements (model-aware) and boxes any other marked row exactly as workholding/contactBodies.ts does. Read-only: no row is mutated, no operation can source from it, and the result is only a clearance mesh for the Simulate contact report.",
}

/** Recursively collect production .ts/.tsx files (tests excluded). */
function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'tests') continue
      productionFiles(full, out)
    } else if (/\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

describe('INT-17A-R1 consumer census (derived from the code, not from a hand list)', () => {
  it('every production reader of project.geometry is CLASSIFIED for model-origin entries', () => {
    const readers = productionFiles(SRC)
      .filter((f) => /project\.geometry/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .sort()

    const classified = Object.keys(CENSUS).sort()
    const unclassified = readers.filter((r) => !(r in CENSUS))
    const stale = classified.filter((c) => !readers.includes(c))

    expect(unclassified,
      `NEW consumer(s) of project.geometry with no model-origin classification:\n` +
      `  ${unclassified.join('\n  ')}\n\n` +
      `Every reader must state what it does with a format:'model' entry. Add a row to\n` +
      `CENSUS in this file (REFUSES / REFUSES-BY-SHAPE / HANDLES / ALLOWED-PASSTHROUGH)\n` +
      `and, if it must refuse, a behavioural test in int17aR1Bypasses.test.ts. This is\n` +
      `the gate that exists because four unlisted readers shipped a bypass each.`,
    ).toEqual([])

    expect(stale,
      `Census rows for files that no longer read project.geometry: ${stale.join(', ')}. ` +
      `Remove them so the census keeps describing the real code.`,
    ).toEqual([])
  })

  it('the census is NON-VACUOUS: it really is reading the tree', () => {
    // A census that silently matched nothing would pass forever. Pin the floor
    // and two seams that MUST be present, so an empty/broken scan fails loudly.
    const readers = productionFiles(SRC)
      .filter((f) => /project\.geometry/.test(readFileSync(f, 'utf8')))
    expect(readers.length).toBeGreaterThanOrEqual(15)
    const rel = readers.map((f) => relative(SRC, f).split(sep).join('/'))
    expect(rel).toContain('store/index.ts')
    expect(rel).toContain('store/stockAssignment.ts')
  })
})
