// CAM-DRILL-FIX3: reproduces and fixes CAM-DRILL-EVIDENCE's THIRD, deepest
// defect in the drill-from-model chain - a drill op sourced from a modeled
// body, wizard defaults (Auto Stock, "Detect holes"), now passes FIX1's
// model-origin guard AND FIX2's clearance/retract co-move fix, but fails the
// LAST R3 plane-ordering branch:
//
//   "Bottom height (0) is at or above top height (0) - operation not computed"
//
// (src/store/dispatchGeo.ts planeOrderingError, resolvedBottom >= resolvedTop)
//
// ROOT CAUSE (src/store/index.ts, the bottomFromFace/topFromFace
// selected_face resolution, ~line 7936 pre-fix; src/store/dispatchGeo.ts's
// resolveGeometryZToFrames, ~line 333 pre-fix): "Detect holes"
// (NewOperationModal.tsx runBrepDerive('holes')) sets
// heights.bottomHeightMode = 'selected_face' with heights.selectedFaceZ = the
// detected hole's MODEL-LOCAL bottomZ. The store's selected_face resolution
// converts that local Z to WCS-relative via resolveGeometryZToFrames, which
// (pre-fix) composed world Z as `localZ + geo.position.z` - but a
// MODEL-ORIGIN geometry row's OWN position/rotation stay IDENTITY forever
// (INT-17C; the real world pose lives only in the Placement registry, per
// CAM-DRILL-FIX1's own established rationale for modelBodyWorldBounds), and
// then subtracted the RAW, possibly-stale setup.wcs.origin.z (the exact
// staleness CAM-DRILL-FIX2 already fixed for resolveTopZ's stock_top/bottom
// branch, but that fix never reached this SIBLING resolver). For a
// corner-pinned, model-only derived stock (the real wizard default flow),
// BOTH of those add up to a resolved bottom of exactly 0 - coincidentally
// equal to the (correctly resolved) top of 0, tripping the ordering guard.
//
// THE FIX (same two files): resolveGeometryZToFrames gains an optional
// placementRecords param (composing a model-origin geo's REAL placement
// position via the shared modelGeoOriginZ helper, not identity) and an
// optional wcsOriginZOverride param (the EFFECTIVE, corner-pin-mirrored WCS
// baseline, shared via effectiveWcsOriginZ - extracted from FIX2's own inline
// formula, not re-derived a second time). store/index.ts's bottomFromFace/
// topFromFace resolution now calls resolveGeometryZToFramesModelAware, which
// supplies both for a model-origin faceSourceGeo and is byte-identical to the
// old call for a regular one.
//
// Harness pattern: identical real-worker harness to camDrillFix1
// .modelHeights.test.ts / camDrillFix2.retractResolve.test.ts (Worker global
// shimmed to the real toolpathWorker in-process), so a passing 'ready' status
// proves a REAL ToolpathMove[] came back through the REAL drill builder.
//
// MUTATION-PROOF: RED confirmed live via `git stash push -- src/store/
// dispatchGeo.ts src/store/index.ts` (reverting both files' FIX3 edits),
// re-running this file - test 1 failed with errorMessage EXACTLY
// "Bottom height (0) is at or above top height (0) - operation not
// computed", byte-identical to CAM-DRILL-EVIDENCE.report.md's captured text.
// `git stash pop` restored the fix; all tests green again (see gate tails in
// coordination/reports/CAM-DRILL-FIX3.report.md).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { buildDrillBoreAuthoringIntent } from '../../lib/cam/smartHeights'
import { legacyHeightIntentForOperation } from '../../lib/cam/heightIntent'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  ImportedGeometry, Operation, PhysicalStock, Project, SceneStock, Setup, Tool,
  Vec3, BoundingBox, HeightParams, PassParams, LinkingParams, ModelItemPlacementRecord,
  PersistedOperationHeightState,
} from '../../types'
import {
  setModelBodyFaceSnapshotReader,
  setModelBodyHoleRecognizer,
} from '../../lib/cam/modelBodyHoleRecognition'
import { modelBoreLoopId, deriveModelBodyBoreTarget } from '../../lib/cam/modelBodyDerive'
import type { GeometrySnapshot } from '../../geom'
import type { FeatureVerdict } from '../../geom/geom-service'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// Exactly the CAM-DRILL-FIX1/FIX2 fixture shape: local bbox z:[0,10] (a 10mm
// plate). ONE detected through-hole, HoleFeature.bottomZ = 0 (the plate's
// LOCAL bottom face - a through-hole's wall bottom reaches the solid's own
// bbox bottom), on a 'geometry_local'-framed layer - exactly what
// deriveBrepLayer(kind 'holes') lands (CAM-DRILL-ADAPTER).
function drillableModelGeo(id: string, name: string): ImportedGeometry {
  const r = 3
  const pts = Array.from({ length: 16 }, (_, k) => {
    const a = (2 * Math.PI * k) / 16
    return { x: r * Math.cos(a), y: r * Math.sin(a) }
  })
  return {
    id, name, filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: {
        positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
        bbox: { min: [-20, -15, 0], max: [20, 15, 10] },
      },
    },
    loops: [{
      id: `${id}-hole1`, points: pts, closed: true, type: 'contour', layerId: 'model_drill_holes', area: Math.PI * r * r,
    }],
    layers2d: [{
      id: 'model_drill_holes', name: 'Model holes', color: '#888888', visible: true,
      derived: true, frame: 'geometry_local',
      holes: [{ center: [0, 0], diameter: r * 2, topZ: 10, bottomZ: 0, through: true, loopId: `${id}-hole1` }],
    }],
  } as unknown as ImportedGeometry
}

function derivedAutoStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), // never-derived default
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock = {
  mode: 'auto', autoOffsetXY: 5, autoOffsetZTop: 5,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], autoStocks: [],
} as unknown as SceneStock

// Panel-realistic numbers matching CAM-DRILL-EVIDENCE's captured run:
// Clearance 15 (absolute), Retract 5, Feed 5, Top ref "Stock top" offset 0
// (defaultHeights.topHeight = 0), Bottom bound to the detected hole via
// "Detect holes" (bottomHeightMode 'selected_face', selectedFaceZ = the
// hole's LOCAL bottomZ = 0). bottomHeight is a display ESTIMATE the wizard
// pre-seeds (NewOperationModal.tsx: `minBottomZ - setup.wcs.origin.z`) - the
// store re-resolves it at compute time; its stale starting value must not
// matter to the fixed outcome.
const wizardHeights: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 5,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: 0, bottomHeightMode: 'selected_face', selectedFaceZ: 0,
}
const passes: PassParams = {
  stepdown: 2, stepover: 3, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0, overlapMm: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 10,
  leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
}
const tool = {
  id: 'tool-1', name: 'D6', type: 'drill', diameter: 6,
  // This fixture isolates model-aware height resolution. Keep the cutting
  // length beyond its intentional 30 mm test depth so the independent
  // shank/stock guard does not correctly stop the test before that boundary.
  // The placement-invariance case moves the model +37 mm while intentionally
  // retaining the stale imported Setup frame, producing a 67 mm guard depth.
  fluteLength: 80, shankDiameter: 6, overallLength: 100, numberOfFlutes: 2,
} as Tool
const boreTool = {
  id: 'tool-bore', name: 'EM3', type: 'flat_end_mill', diameter: 3,
  // The live-cylinder case reaches 22 mm below stock top. Its purpose is the
  // selected-feature endpoint path, so provide a tool that is actually capable
  // of that move instead of bypassing or weakening the collision guard.
  fluteLength: 30, shankDiameter: 3, overallLength: 50, numberOfFlutes: 2,
} as Tool

// "Detect holes" persists a 'detected_features' Smart Height V2 authority
// (buildDrillBoreAuthoringIntent, exactly NewOperationModalBody.tsx's own
// save path) whose feature evidence comes straight off the fixture's own
// `holes` layer entry - the same evidence deriveDrillBoreFeatureBindings
// independently re-derives at compute time, so the two agree byte-for-byte.
function drillSmartHeight(op: Operation, geometryId: string): PersistedOperationHeightState {
  const geo = drillableModelGeo(geometryId, 'Plate')
  const selectedLoopIds = (geo.loops ?? []).map((l) => l.id)
  // detected_features' Material Start is the composed, placement/margin-aware
  // detected-hole top plane, not wizardHeights' raw retract/feed (5/5) - those
  // were only ever valid against the V1 stock_top+offset resolution this op
  // no longer uses for its machining band. Give the safety planes generous
  // headroom above any plausible composed top so R3 ordering measures the
  // real thing under test, not an unrelated fixture mismatch.
  const safetyIntent = legacyHeightIntentForOperation({
    type: 'drill',
    // Headroom generous enough for the placement-invariance case (installs
    // the same op at placementZ +37, which shifts the composed material
    // start by the same +37).
    heights: { ...op.heights, clearanceHeight: 250, retractHeight: 200, feedHeight: 150 },
    params: op.params as Record<string, unknown>,
  })
  return {
    kind: 'smart_v2',
    intent: buildDrillBoreAuthoringIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent,
      geometries: [geo], selectedLoopIds,
      draft: { mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: 0 },
    }),
  }
}

function makeDrillOp(geometryId: string): Operation {
  const op = {
    id: 'op-1', name: 'Drill 1', type: 'drill', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [], modelReferences: [],
    heights: structuredClone(wizardHeights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: {
      geometryId, loopIds: [], cycleType: 'simple', peckDepth: 5,
      chipBreakRetract: 1, dwell: 0, retractMode: 'clearance', sortStrategy: 'nearest_neighbor',
      // "Detect holes" also sets perHoleDepth: true (NewOperationModal.tsx) -
      // exercises the SIBLING per-hole holeBottoms payload path (FIX3 also
      // fixes holeBottomWorldZ's identical defect), not just the op-level
      // ordering-check bottom.
      perHoleDepth: true,
      heightReference: 'stock_top', planeOffset: -5,
    },
  } as unknown as Operation
  op.smartHeight = drillSmartHeight(op, geometryId)
  return op
}

function makeBoreOp(geometryId: string): Operation {
  const loopId = modelBoreLoopId('wall')
  return {
    id: 'op-1', name: 'Bore 1', type: 'bore', enabled: true, status: 'ready',
    toolId: boreTool.id, geometrySelections: [loopId],
    modelReferences: [{ bodyId: `${geometryId}-body`, stableIds: ['wall'], role: 'bore-target' }],
    heights: { ...structuredClone(wizardHeights), bottomManual: false },
    passes: structuredClone(passes),
    linking: { ...structuredClone(linking), entryType: 'ramp_helical' },
    params: {
      geometryId, loopIds: [loopId], direction: 'climb', sortStrategy: 'nearest_neighbor',
      geometrySource: 'cylinder', targetDiameter: 7, perBoreDepth: true,
      perBoreDepthOverrides: { [loopId]: -7 },
      heightReference: 'stock_top', planeOffset: -5,
    },
  } as unknown as Operation
}

// Q-87's live-cylinder feature evidence, shared between the smartHeight
// authority built below (fixture-construction time) and the
// setModelBodyHoleRecognizer/setModelBodyFaceSnapshotReader mocks the test
// installs before compute (runtime) - both call the SAME production
// deriveModelBodyBoreTarget on the SAME inputs, so the stable feature
// identity Smart Height V2 checks at compute time matches byte-for-byte.
const boreVerdict: FeatureVerdict = {
  featureKey: 'hole:0:0:10:0:0:1:4', featureClass: 'blindHole',
  removable: true, effect: 'add', faceIds: ['wall'], neighbourIds: [],
  params: {
    diameter: 8, depth: 10, axisX: 0, axisY: 0, axisZ: 1,
    centerX: 0, centerY: 0, centerZ: 10,
  },
}
const boreSnapshot: GeometrySnapshot = {
  type: 'cylinder', centroid: [0, 0, 5], normal: [1, 0, 0], area: 250,
  axis: [0, 0, 1], axisPoint: [0, 0, 0], radius: 4,
}

// Mirrors NewOperationModalBody.tsx's own drillBoreHeightAuthorityForDraft
// (the 'modelBoreAuthoringGeometry' composition + buildDrillBoreAuthoringIntent
// call) for a live-cylinder Bore: derive the ephemeral loop/cylinder via the
// PRODUCTION helper, stitch it onto the geometry the same way the modal does,
// then author through the PRODUCTION intent builder - never a hand-rolled
// intent shape.
function boreSmartHeight(
  op: Operation, geo: ImportedGeometry, placements: ModelItemPlacementRecord[],
): PersistedOperationHeightState {
  const derived = deriveModelBodyBoreTarget(geo, placements, 'wall', boreSnapshot, [boreVerdict])
  const authoringGeo: ImportedGeometry = {
    ...geo,
    loops: [...(geo.loops ?? []).filter((l) => l.id !== derived.loop.id), derived.loop],
    layers2d: [
      ...(geo.layers2d ?? []).filter((l) => l.id !== derived.loop.layerId),
      {
        id: derived.loop.layerId, name: 'Selected model bore', color: '#4ea1ff',
        visible: true, derived: true, frame: 'geometry_local', cylinders: [derived.cylinder],
      },
    ],
  }
  const loopId = modelBoreLoopId('wall')
  // See drillSmartHeight's identical comment: detected_features' Material
  // Start is the composed live-cylinder evidence, not wizardHeights' raw
  // retract/feed - give the safety planes headroom above it.
  const safetyIntent = legacyHeightIntentForOperation({
    type: 'bore',
    heights: { ...op.heights, clearanceHeight: 100, retractHeight: 60, feedHeight: 50 },
    params: op.params as Record<string, unknown>,
  })
  return {
    kind: 'smart_v2',
    intent: buildDrillBoreAuthoringIntent({
      operationType: 'bore', setupId: 'setup-1', safetyIntent,
      geometries: [authoringGeo], selectedLoopIds: [loopId],
      draft: { mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: 0 },
      perFeatureEndOverridesWcsMm:
        (op.params as { perBoreDepthOverrides?: Record<string, number> }).perBoreDepthOverrides,
    }),
  }
}

// Corner-pinned "top" WCS, bound to the sole derived stock - exactly what
// "Add setup auto-bound the sole stock candidate" (CAM-DRILL-EVIDENCE.report
// .md step 3) produces. origin.z starts at 0: the value a fresh,
// never-yet-rederived Setup carries (and, per CAM-DRILL-FIX2, STAYS at for a
// model-only derived stock - this test does NOT assert the WCS itself ever
// changes, only that the op's own resolved heights agree with reality
// despite the WCS staying frozen).
function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      cornerRow: 0, cornerCol: 0, cornerFace: 'top', stockId: DERIVED_STOCK_ID,
    } as unknown as Setup['wcs'],
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 5, offsetY: 5, offsetZTop: 5, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  } as unknown as Setup
}

function installProject(
  op: Operation,
  placementZ: number,
  stocks: PhysicalStock[] = [derivedAutoStock()],
): void {
  const placements: ModelItemPlacementRecord[] =
    [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: placementZ }, rotation: { x: 0, y: 0, z: 0 } }]
  useCamStore.setState((s) => ({
    toolLibrary: [tool, boreTool],
    project: {
      ...s.project, geometry: [], stocks,
      setups: [makeSetup(op)], sceneStock, modelItemPlacements: placements,
    } as Project,
  }))
  useCamStore.getState().addGeometry(drillableModelGeo('mb1', 'Plate'))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

// ─── the REAL worker, driven in-process (identical harness to camDrillFix1/2) ─
let workerRequests: WorkerRequestMsg[] = []
let workerSelf: {
  postMessage: (m: WorkerResponseMsg) => void
  onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let OrigWorker: typeof Worker | undefined

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as { self: typeof workerSelf }).self
  expect(typeof workerSelf.onmessage).toBe('function')
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  workerRequests = []
  activeShim = null
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { activeShim = null }
  }
})

afterEach(() => {
  setModelBodyHoleRecognizer(null)
  setModelBodyFaceSnapshotReader(null)
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
})

describe('Q-87: Bore computes from a selected live Model cylinder wall', () => {
  it('dispatches ephemeral cylinder truth while preserving diameter/depth overrides and project geometry', async () => {
    const op = makeBoreOp('mb1')
    const identityPlacements: ModelItemPlacementRecord[] =
      [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }]
    op.smartHeight = boreSmartHeight(op, drillableModelGeo('mb1', 'Plate'), identityPlacements)
    installProject(op, 0)
    setModelBodyHoleRecognizer(async () => [boreVerdict])
    setModelBodyFaceSnapshotReader(async () => boreSnapshot)
    const beforeGeometry = structuredClone(useCamStore.getState().project.geometry)

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    expect(workerRequests).toHaveLength(1)
    expect(workerRequests[0].type).toBe('COMPUTE_BORE')
    const payload = workerRequests[0].payload as {
      params: { targetDiameter?: number }
      boreBottoms?: Record<string, number>
      loops: Array<{ id: string }>
    }
    const loopId = modelBoreLoopId('wall')
    expect(payload.loops.map((loop) => loop.id)).toEqual([loopId])
    expect(payload.params.targetDiameter).toBe(7)
    expect(payload.boreBottoms?.[loopId]).toBe(-7)
    expect(useCamStore.getState().project.geometry).toEqual(beforeGeometry)
    expect(useCamStore.getState().project.geometry.flatMap((g) => g.loops ?? []))
      .not.toContainEqual(expect.objectContaining({ id: loopId }))
  })
})

// Retired 2026-08-18: two V1-era numeric stories were removed here.
// "panel-vs-compute agreement" asserted a fixed WCS-relative top/bottom delta
// (15 = plate thickness + auto-stock padding) built on the V1
// heightReference/planeOffset resolution ("top always resolves to 0"); under
// Smart Height V2 a detected_features band's plane names come from the
// detected feature's own composed evidence and the fixed-delta arithmetic no
// longer holds. "placement-INVARIANCE" asserted the corner-pin cancellation
// that made a moved body's resolved height IDENTICAL to its unmoved one - V2
// composes the feature's REAL placement (confirmed empirically: moving the
// body +37mm shifts the resolved top by the full +37, not 0), so there is no
// invariance left to prove; this is the genuinely-fixed behavior, not a
// regression. Per-family V2 dispatch truth lives in
// src/tests/store/smartHeight*Store.phase*.test.ts and
// src/tests/cam/smartHeight*.phase*.test.ts.
describe('CAM-DRILL-FIX3: drill-from-model selected_face bottom resolves model-aware, not identity/stale-WCS', () => {
  it('a drill op sourced from a modeled body via "Detect holes" (selected_face bottom), fresh import (identity placement), computes ready - not the false "Bottom at or above top" ordering error', async () => {
    installProject(makeDrillOp('mb1'), 0)
    expect(useCamStore.getState().project.setups[0].wcs.origin.z).toBe(0)

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const op = currentOp()
    expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
    expect(workerRequests).toHaveLength(1)
    expect(workerRequests[0].type).toBe('COMPUTE_DRILL')
    expect((op.toolpathMoves ?? []).length).toBeGreaterThan(0)
  })


  it('per-hole payload correctness: the dispatched COMPUTE_DRILL holeBottoms Z is also placement-aware (not just the op-level ordering-check bottom)', async () => {
    installProject(makeDrillOp('mb1'), 0)

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(workerRequests).toHaveLength(1)
    const payload = workerRequests[0].payload as { holeBottoms?: { [loopId: string]: number } }
    // perHoleDepth is set, and the fixture's ONE loop has a detected
    // HoleFeature entry, so holeBottoms must be present and its resolved Z
    // must agree with the op-level resolved bottom (same 10mm-below-top
    // delta), not the pre-fix identity/stale-origin 0.
    expect(payload.holeBottoms).toBeDefined()
    const holeZ = Object.values(payload.holeBottoms ?? {})[0]
    const op = currentOp()
    expect(holeZ).toBeCloseTo(op.resolvedHeights?.wcs.bottom ?? NaN, 6)
  })

  it('typed refusal (not a crash) when the project has more than one stock - the selected_face path fails loud exactly like resolveTopZ\'s own stock_top/stock_bottom branch (ADR 0003)', async () => {
    const secondStock: PhysicalStock = {
      id: 'stock-2', name: 'Stock 2', mode: 'explicit',
      bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 10 }),
      position: { x: 0, y: 0, z: 0 },
    } as unknown as PhysicalStock
    installProject(makeDrillOp('mb1'), 0, [derivedAutoStock(), secondStock])

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const op = currentOp()
    expect(op.status).toBe('error')
    expect(op.errorMessage).toMatch(/exactly one stock/i)
  })
})
