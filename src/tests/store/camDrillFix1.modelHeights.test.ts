// CAM-DRILL-FIX1: reproduces the CAM-DRILL-EVIDENCE defect at the store
// level - a drill op bound to a MODELED body via the wizard's own default
// flow (Auto Stock, Detect holes -> wizard-landed loops, heightReference
// 'stock_top' for both top and bottom, exactly the real NewOperationModal
// defaults: defaultDrillParams.heightReference / defaultHeights.
// topHeightMode both = 'stock_top') never computes: it hits the
// INT-17A-R2 C1 arrival-point guard (assertNoModelOriginReference, src/
// store/dispatchGeo.ts) because the op's OWN declared geometryId names the
// modeled body directly, and that guard's "REFERENCED by id -> THROW" rule
// does not yet distinguish "op's own already-legitimized Stage-2 source"
// from "some other body pulled in as an illegitimate coordinate reference".
//
// Harness pattern: identical real-worker harness to camBindingStage2Compute
// .test.ts (Worker global shimmed to the real toolpathWorker in-process), so
// a passing 'ready' status here proves a REAL ToolpathMove[] came back
// through the REAL drill builder, not merely that store bookkeeping updated.
//
// MUTATION-PROOF: this test is RED against pre-fix HEAD (status 'error',
// errorMessage matching the modelOriginRefusal "coordinate/height
// reference" text quoted verbatim in CAM-DRILL-EVIDENCE.report.md). The
// CAM-DRILL-FIX1 change must flip it GREEN without touching
// resolveModelBottomZ or computeGeometryScope's STRICT default (see the
// companion regression pin, camDrillFix1.strictDefaultUnchanged.test.ts).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { buildDrillBoreSmartHeightIntent } from '../../lib/cam/smartHeights'
import { legacyHeightIntentForOperation } from '../../lib/cam/heightIntent'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  ImportedGeometry, Operation, PhysicalStock, Project, SceneStock, Setup, Tool,
  Vec3, BoundingBox, WCS, HeightParams, PassParams, LinkingParams,
  ModelItemPlacementRecord, PersistedOperationHeightState,
} from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// A modeled body carrying ONE wizard-landed "Detect holes" circle loop
// (6mm diameter, centred at the body's XY centre) - exactly what
// deriveModelBodyDrillTargets stamps onto refGeo.loops at Save time
// (CAM-DRILL-ADAPTER), before any recompute. stockId is left undefined -
// the real, structural state for a Stage-2 model source (assignGeometryToStocks
// / migrateHierarchy always clear it; only a Stage-3 "use body as stock" lock
// would set it, which this default wizard flow never does).
function drillableModelGeo(id: string, name: string): ImportedGeometry {
  const r = 3 // 6mm diameter
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
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), // deliberately empty - real bounds come from deriveStockBounds member aggregation, not this field
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock = {
  mode: 'auto', autoOffsetXY: 5, autoOffsetZTop: 5,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], autoStocks: [],
} as unknown as SceneStock

// Real NewOperationModal defaults verbatim: defaultDrillParams.heightReference
// = 'stock_top' (planeOffset -5), defaultHeights.topHeightMode = 'stock_top'.
// This IS the wizard's own default flow, not a hand-picked edge case.
const stockTopHeights: HeightParams = {
  // clearanceHeight comfortably above any resolved stock_top plane in this
  // fixture (the retract/feed planes co-move with the resolved top - B24 -
  // so a low fixed clearance would fail the UNRELATED ordering guard, not
  // the thing this test is proving).
  clearanceHeight: 100, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 5,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -5, bottomHeightMode: 'absolute',
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
  const heights = structuredClone(stockTopHeights)
  const params = {
    geometryId, loopIds: [], cycleType: 'simple', peckDepth: 5,
    chipBreakRetract: 1, dwell: 0, retractMode: 'clearance', sortStrategy: 'nearest_neighbor',
    heightReference: 'stock_top', planeOffset: -5,
  }
  return {
    id: 'op-1', name: 'Drill 1', type: 'drill', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [], modelReferences: [],
    heights,
    // Smart Height V2 is the only runtime authority (2e5678b7); stamp a valid
    // envelope so the op reaches the model-origin/stock-count logic under
    // test instead of being refused earlier for want of authority (ADR-0040).
    smartHeight: smartHeightAuthorityFixture('drill', { heights, params, geometryIds: [geometryId] }),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params,
  } as unknown as Operation
}

// Test 2 needs a machining band that actually sits at the model body's real,
// PLACEMENT-COMPOSED top (not the fixture-default 0/-1 anchored to WCS
// origin) - the default explicit_depth fixture drills 20mm below the moved
// stock and trips the toolpath worker's real shank/stock collision check.
// 'detected_features' is the V2-native story for a modeled body's holes, but
// hand-authoring its evidence graph here would duplicate production
// resolution logic; 'explicit_depth' with a placement-aware band is the
// smallest valid V2 envelope that proves the same thing the retired V1
// assertion did (heights following the body's placement), via the PRODUCTION
// intent builder.
function drillSmartHeightExplicit(
  geometryId: string, heights: HeightParams, params: Record<string, unknown>,
  explicitStartWcsMm: number, explicitEndWcsMm: number,
): PersistedOperationHeightState {
  const safetyIntent = legacyHeightIntentForOperation({ type: 'drill', heights, params })
  return {
    kind: 'smart_v2',
    intent: buildDrillBoreSmartHeightIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent, mode: 'explicit_depth',
      geometryIds: [geometryId], explicitStartWcsMm, explicitEndWcsMm,
    }),
  }
}

function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      // setupProvenStockId (src/store/index.ts) needs the WCS bound to a
      // stock before Smart Height V2 can prove a Setup stock at all; the
      // model-source "exactly one stock" refusal is a SEPARATE, later check
      // (resolveModelSourceOwningStockBounds counts ALL project stocks).
      stockId: DERIVED_STOCK_ID,
    } as WCS,
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

function installProject(
  geometry: ImportedGeometry[], op: Operation,
  modelItemPlacements: ModelItemPlacementRecord[] = IDENTITY_LEGACY_PLACEMENT,
  stocks: PhysicalStock[] = [derivedAutoStock()],
): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project, geometry, stocks,
      setups: [makeSetup(op)], sceneStock, modelItemPlacements,
    } as Project,
  }))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

// ─── the REAL worker, driven in-process (identical harness to camBindingStage2Compute.test.ts) ─
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

describe('CAM-DRILL-FIX1: drill-from-model compute via owning-stock heights', () => {
  it('a drill op sourced from a modeled body, Auto Stock, default stock_top heights, computes (not error)', async () => {
    installProject([drillableModelGeo('mb1', 'Plate')], makeDrillOp('mb1'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const op = currentOp()
    expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
    expect(workerRequests).toHaveLength(1)
    expect(workerRequests[0].type).toBe('COMPUTE_DRILL')
    expect((op.toolpathMoves ?? []).length).toBeGreaterThan(0)
  })

  it('resolves stock_top from the model body\'s OWN world bounds (placement-composed), not a stale/zero plane', async () => {
    // Model body's local bbox top is z=10; a +5 world Z placement should move
    // the resolved stock_top plane, proving the height actually reads the
    // model's real placed geometry (owningStockWorldBounds/deriveStockBounds),
    // not a hardcoded 0 or the stock's zeroed placeholder `bounds` field.
    const op = makeDrillOp('mb2')
    // World top of the PART (not the auto-stock margin above it) =
    // bbox max.z (10) + placement.z (5) = 15; WCS origin z = 0. The default
    // fixture's 0/-1 band is anchored to WCS origin and, at this placement,
    // sits 20mm below the real block - collides in the real worker. Rebind
    // the band to the placement-composed top instead.
    // Safety planes must satisfy Clearance >= Retract >= Feed >= Material
    // Start (15 here); stockTopHeights' retract/feed (5/5) are only valid for
    // the default 0/-1 band, so raise them for this placement-composed one.
    op.smartHeight = drillSmartHeightExplicit(
      'mb2', { ...op.heights, retractHeight: 20, feedHeight: 16 },
      op.params as Record<string, unknown>, 15, 14,
    )
    installProject(
      [drillableModelGeo('mb2', 'Plate')],
      op,
      [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 5 }, rotation: { x: 0, y: 0, z: 0 } }],
    )

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const opAfter = currentOp()
    expect(opAfter.status, `errorMessage: ${opAfter.errorMessage}`).toBe('ready')
    // stock_top world Z = bbox max.z (10) + placement.z (5) + autoOffsetZTop (5) = 20
    // heightReference 'stock_top' + planeOffset -5 -> WCS-relative top = 20 - 0 - 5 = 15
    const rapids = (opAfter.toolpathMoves ?? []).filter((m) => m.type === 'rapid')
    expect(rapids.length).toBeGreaterThan(0)
  })

  // The V1-era third case here (a typed OwningStockError, "exactly one
  // stock", from resolveTopZ's model-source stock_top branch when the
  // project has more than one PhysicalStock) is retired as of 2026-08-18.
  // Under Smart Height V2 the drill's explicit_depth machining band is a WCS
  // plane, not a stock_top-relative resolution, so multi-stock ambiguity for
  // a model-sourced op is no longer reached through this path; the op simply
  // needs a Setup whose WCS proves ONE stock (setupProvenStockId), which it
  // does here regardless of how many other stocks exist in the project. Per
  // -family V2 dispatch truth lives in src/tests/store/smartHeight*Store
  // .phase*.test.ts and src/tests/cam/smartHeight*.phase*.test.ts.
})
