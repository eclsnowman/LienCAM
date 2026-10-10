// CAM-DRILL-FIX2: reproduces and fixes the defect CAM-DRILL-EVIDENCE-2's
// post-fix (CAM-DRILL-FIX1) re-run found - a drill op sourced from a
// modeled body, wizard defaults, Auto Stock, now PASSES FIX1's guard but
// fails R3 plane-ordering validation ("Clearance height (15) is below
// retract height (20)") while the Properties panel displays Retract = 5mm
// for the same op.
//
// ROOT CAUSE (src/store/dispatchGeo.ts, resolveTopZ's FIX1 model-source
// branch, ~line 1030-1067): the branch subtracts the Setup's REAL
// `setup.wcs.origin.z` to make the resolved stock_top/stock_bottom plane
// WCS-relative. For a REGULAR (real-geometry) derived stock this is always
// correct, because applyAutoStockToSetups (store/index.ts) keeps a
// corner-pinned WCS's origin.z pinned EXACTLY at that stock's own resolved
// top/bottom face every time the stock's bounds change - so the subtraction
// always nets to ~0 for stock_top/bottom, and the co-move in
// coMoveApproachPlanes (B24) never fires (topDelta stays 0). A model-only
// derived stock CANNOT get that same treatment today:
// deriveStockBounds's membership filter (`geo.stockId === stock.id`) never
// sees a Stage-2 model row (it structurally never carries a persisted
// stockId - INT-17A-R1 C3, the deliberate CAM-BINDING Stage 3 invariant
// this lane is FORBIDDEN from touching), so the real origin.z stays frozen
// at whatever a fresh Setup starts with (0), while `bounds` in the SAME
// branch has ALREADY correctly resolved the body's real, Placement-composed
// top via FIX1's own owning-stock machinery. Subtracting the frozen 0 from
// the real absolute top produced a large, spurious "resolved" height, which
// then inflated retract/feed via the B24 co-move far past clearance - the
// exact evidence-lane repro.
//
// THE FIX (same file, same branch): when (and ONLY when) the Setup's WCS is
// corner-pinned (cornerRow/cornerCol set, not vertex-snapped - the exact
// condition applyAutoStockToSetups itself gates its own re-derivation on),
// mirror cornerOriginFromBox's OWN formula (store/index.ts) against the
// `bounds` this function just resolved, in place of the real (possibly
// stale) origin.z. This is compute-time only - nothing is read back from or
// written to the WCS/stock records - and restores parity with how a REGULAR
// stock resolves the identical config. A non-corner-pinned WCS (no
// cornerRow/cornerCol, e.g. FIX1's own fixtures) is completely unaffected -
// falls through to the real origin.z exactly as before.
//
// Harness pattern: identical real-worker harness to camDrillFix1
// .modelHeights.test.ts (Worker global shimmed to the real toolpathWorker
// in-process), so a passing 'ready' status here proves a REAL
// ToolpathMove[] came back through the REAL drill builder.
//
// MUTATION-PROOF: reverting the effectiveWcsZ branch back to a bare
// `wcsZ` subtraction reproduces the RED state below (op status 'error',
// the EXACT plane-ordering message CAM-DRILL-EVIDENCE.report.md's post-fix
// re-run captured: "Clearance height (15) is below retract height (20)").
// Confirmed RED against pre-fix HEAD before this lane's edit landed.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  ImportedGeometry, Operation, PhysicalStock, Project, SceneStock, Setup, Tool,
  Vec3, BoundingBox, HeightParams, PassParams, LinkingParams, ModelItemPlacementRecord,
} from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// Real NewOperationModal wizard flow: import a plate, Detect holes lands a
// wizard-derived circle loop onto the model row (CAM-DRILL-ADAPTER). Local
// bbox top z=10 - matching CAM-DRILL-FIX1's own fixture exactly.
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
    layers2d: [{ id: 'model_drill_holes', name: 'Model holes', color: '#888888', visible: true, derived: true }],
  } as unknown as ImportedGeometry
}

function derivedAutoStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), // never-derived default - the state a fresh project starts in
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock = {
  mode: 'auto', autoOffsetXY: 5, autoOffsetZTop: 5,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], autoStocks: [],
} as unknown as SceneStock

// Panel-realistic numbers: Clearance 15 (absolute), Retract 5, Feed 5, top
// reference "Stock top" offset -5. bottomHeight/bottomHeightMode are
// deliberately vestigial here (a drill op resolves its depth-of-cut
// reference from params.heightReference/planeOffset below, NOT from
// heights.bottomHeightMode - discovered while building this fixture: the
// generalized "bottom-of-cut reference plane" selector in store/index.ts
// reads refParams.heightReference unconditionally whenever it is set and
// not 'absolute', which for a drill op is always true, since drill's own
// params always carry heightReference). Deliberately NOT FIX1's own
// artificially-high clearance (100), which was chosen there specifically to
// dodge this ordering check - this test's whole point is to exercise it,
// matching the real evidence-lane numbers.
const evidenceHeights: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 5,
  topHeight: -5, topHeightMode: 'stock_top',
  bottomHeight: -10, bottomHeightMode: 'absolute',
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
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

function makeDrillOp(geometryId: string): Operation {
  const heights = structuredClone(evidenceHeights)
  const params = {
    geometryId, loopIds: [], cycleType: 'simple', peckDepth: 5,
    chipBreakRetract: 1, dwell: 0, retractMode: 'clearance', sortStrategy: 'nearest_neighbor',
    // heightReference/planeOffset govern the BOTTOM (depth-of-cut)
    // reference plane for a drill op (see the evidenceHeights comment
    // above) - -10 here, distinct from heights.topHeight's -5, so top and
    // bottom resolve to genuinely different planes (a 5mm deep hole).
    heightReference: 'stock_top', planeOffset: -10,
  }
  return {
    id: 'op-1', name: 'Drill 1', type: 'drill', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [], modelReferences: [],
    heights,
    // Smart Height V2 is the only runtime authority (2e5678b7); stamp a
    // valid envelope so the op reaches the plane-ordering/co-move logic
    // under test instead of being refused earlier for want of authority
    // (ADR-0040). explicit_depth band matches the op's own bottom-of-cut
    // math above: top -5, bottom -10 (WCS-relative), a 5mm deep hole.
    smartHeight: smartHeightAuthorityFixture('drill', {
      heights, params, geometryIds: [geometryId],
    }),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params,
  } as unknown as Operation
}

// Corner-pinned "top" WCS, bound to the sole derived stock (setup.wcs.stockId
// = DERIVED_STOCK_ID) - exactly what "Add setup auto-bound the sole stock
// candidate" (CAM-DRILL-EVIDENCE.report.md step 3) produces in the real
// SetupModal default flow. origin.z starts at 0: the value a fresh, never
// -yet-rederived Setup carries. This test does NOT assert the WCS itself
// ever changes (the abandoned FIX2 approach did, and broke the CAM-BINDING
// Stage 3 invariant) - only that the OP'S OWN resolved heights agree with
// the panel's raw values despite the WCS staying frozen.
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

const IDENTITY_LEGACY_PLACEMENT: ModelItemPlacementRecord[] = [
  { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
]

function installProjectBeforeGeometry(op: Operation): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project, geometry: [], stocks: [derivedAutoStock()],
      setups: [makeSetup(op)], sceneStock, modelItemPlacements: IDENTITY_LEGACY_PLACEMENT,
    } as Project,
  }))
}

const currentProject = () => useCamStore.getState().project
const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

// ─── the REAL worker, driven in-process (identical harness to camDrillFix1.modelHeights.test.ts) ─
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
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
})

// Retired 2026-08-18: the third case here ("RED-shape check", a
// non-corner-pinned WCS reproducing the frozen-origin.z co-move defect via
// resolveTopZ's model-source branch + coMoveApproachPlanes, B24) asserted a
// V1 dispatch-pipeline defect. Smart Height V2's drill authority resolves its
// machining band from an explicit WCS plane (buildDrillBoreSmartHeightIntent,
// 'explicit_depth'), never through resolveTopZ/coMoveApproachPlanes, so the
// WCS's cornerRow/cornerCol state cannot affect it and the described defect
// is not reachable under V2. Per-family V2 dispatch truth lives in
// src/tests/store/smartHeight*Store.phase*.test.ts and
// src/tests/cam/smartHeight*.phase*.test.ts.
describe('CAM-DRILL-FIX2: drill-from-model retract/clearance resolve agrees with the Properties panel', () => {
  it('a drill op sourced from a modeled body, Auto Stock, wizard-realistic heights (Clearance 15 / Retract 5), computes ready - not the false "Clearance below retract" ordering error', async () => {
    installProjectBeforeGeometry(makeDrillOp('mb1'))
    useCamStore.getState().addGeometry(drillableModelGeo('mb1', 'Plate'))

    // The WCS is NOT re-derived by this fix (that would be the forbidden
    // WCS/stock-assignment-level approach) - it stays frozen at 0, exactly
    // as it does today. The fix must still make the op compute correctly.
    expect(currentProject().setups[0].wcs.origin.z).toBe(0)

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const op = currentOp()
    expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
    expect(workerRequests).toHaveLength(1)
    expect(workerRequests[0].type).toBe('COMPUTE_DRILL')
    expect((op.toolpathMoves ?? []).length).toBeGreaterThan(0)
  })

  it('panel-vs-compute agreement: resolved retract/clearance match the panel\'s raw configured values (5 / 15), not an inflated co-moved number', async () => {
    installProjectBeforeGeometry(makeDrillOp('mb1'))
    useCamStore.getState().addGeometry(drillableModelGeo('mb1', 'Plate'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const op = currentOp()
    expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
    expect(op.resolvedHeights).toBeDefined()
    // WCS-relative resolved planes must equal the panel's own raw stored
    // values - the exact parity CAM-DRILL-EVIDENCE.report.md's post-fix
    // re-run found broken (panel showed Retract=5, compute resolved 20).
    expect(op.resolvedHeights?.wcs.retract).toBeCloseTo(5, 6)
    expect(op.resolvedHeights?.wcs.clearance).toBeCloseTo(15, 6)
    // Machine (absolute) coordinates compose the WCS-relative value with the
    // Setup's real (frozen-at-0) origin.z - so with origin.z still 0, the
    // machine value equals the WCS-relative value exactly.
    expect(op.resolvedHeights?.machine.retract).toBeCloseTo(5, 6)
    expect(op.resolvedHeights?.machine.clearance).toBeCloseTo(15, 6)
  })
})
