// INT-17A-R2 C1, at the FINAL CONSUMER: computeOperationToolpath itself.
//
// SUPERSEDED BY src/tests/store/int17aR3OpCompute.test.ts. The round-3 audit
// found this file's claim to be vacuous and was right: the Worker stub below
// never responds, the computeOperationToolpath calls are not awaited, and the
// assertions are negative-only, so every op here sits at status 'computing'
// with zero moves and the assertions hold no matter what the guard does. The
// product behaviour it claimed was in fact correct, so nothing here is WRONG -
// it is just not evidence. Kept as the R2 round's own regression surface; the
// real final-consumer proof, driving the REAL toolpathWorker and asserting real
// ToolpathMove[], is the R3 file.
//
// The R1 audit's remedy for finding 1 asked for exactly this - "an end-to-end
// operation-compute test with two legitimate sources plus a hostile loop-bearing
// MODEL entry, and assert the model entry neither contributes nor prevents
// resolution". The resolver-level proofs live in int17aR2Boundary.test.ts; this
// file is the one that drives the real store action a user's Compute button
// calls, so the guard is proven where the behaviour is actually observed.
//
// The two directions the WO's C1 requires, both asserted here:
//   - a modeled body merely PRESENT must not block a legitimate All Parts op
//     (it carries no stockId by R1's own C3 rule, which is what made the
//     unassigned check fire and name it);
//   - a modeled body REFERENCED by the op must refuse BY NAME on the op card,
//     never a silent block and never a computed toolpath.
//
// Harness shape (fixtures, Worker stub, installProject) follows
// src/tests/store/opNoStockGuard.test.ts, the existing test for the sibling
// ADR-0003 guard at the same seam.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type {
  ImportedGeometry, SceneStock, PhysicalStock, BoundingBox, Vec3, Project,
  Setup, Operation, WCS, Tool, HeightParams, PassParams, LinkingParams,
} from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** A legitimate loop-bearing 2D part on the derived stock. */
function ordinaryGeo(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: `${id}-loop`,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

/** The auditor's hostile row: model ORIGIN wearing type 'brep' and real loops,
 *  no stockId (Stage 1 refuses to stock-bind it), parked high in Z. */
function hostileModelGeo(): ImportedGeometry {
  return {
    id: 'modelbody:F1', name: 'Model F1', filename: '', type: 'brep', format: 'model',
    boundingBox: bbox({ x: 0, y: 0, z: -50 }, { x: 10, y: 10, z: 50 }),
    position: { x: 0, y: 0, z: 500 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: 'modelbody:F1-loop',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 } },
  } as unknown as ImportedGeometry
}

function derivedStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 12, y: 12, z: 1 }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
} as unknown as SceneStock

/** stock_top so the op genuinely routes through resolveTopZ -> resolveOwningStock,
 *  which is where the audit reproduced the block. */
const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 1.5, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

// Commit 2e5678b7: a valid smart_v2 envelope is now the ONLY runtime height
// authority, checked BEFORE this file's guard. smartHeightGeometryIds
// defaults to [geometryId], which is right for a direct single-geometry
// reference but wrong for the '__all__' aggregate sentinel: the Smart Height
// V2 scope is a concrete geometry-id list, not the sentinel itself
// (resolveContourSmartRuntime looks each id up in state.project.geometry
// directly), so '__all__' callers must pass the real ids the aggregate
// resolves to.
function makeOp(geometryId: string, smartHeightGeometryIds: string[] = [geometryId]): Operation {
  return {
    id: 'op-1', name: 'Profile Cut', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { geometryId, side: 'outside', direction: 'climb' },
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights, geometryIds: smartHeightGeometryIds,
    }),
  } as unknown as Operation
}

function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      // Contour's Smart Height runtime (setupProvenStockId, store/index.ts)
      // requires a proven owning stock before it resolves anything.
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  } as unknown as Setup
}

const tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

function installProject(
  geometry: ImportedGeometry[],
  geometryId: string,
  smartHeightGeometryIds?: string[],
): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project,
      geometry,
      stocks: [derivedStock()],
      setups: [makeSetup(makeOp(geometryId, smartHeightGeometryIds))],
      sceneStock,
    } as Project,
  }))
}

const op = (): Operation => useCamStore.getState().project.setups[0].operations[0]

// Worker construction throws in jsdom; stub it so a legitimate op can proceed
// PAST the guard rather than dying for an unrelated reason (the same stub
// opNoStockGuard.test.ts uses for the same purpose).
let OrigWorker: typeof Worker | undefined
beforeEach(() => {
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: unknown) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(): void { /* no-op */ }
    terminate(): void { /* no-op */ }
  }
})
afterEach(() => {
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
  vi.restoreAllMocks()
})

describe('computeOperationToolpath with a modeled body in the project (INT-17A-R2 C1)', () => {
  it('an ALL PARTS op with two legitimate sources computes UNBLOCKED', () => {
    // THE AUDIT REPRO at the consumer. Before the boundary guard this op landed
    // status:'error' - "1 selected geometry ("Model F1") is not assigned to an
    // existing stock" - even though both real parts share one perfectly good
    // owner. A modeled card sitting in the tree could stop every All Parts cut
    // in the project.
    installProject([ordinaryGeo('a', 'Part A'), ordinaryGeo('b', 'Part B'), hostileModelGeo()], '__all__', ['a', 'b'])
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(op().errorMessage ?? '').not.toMatch(/Model F1/)
    expect(op().errorMessage ?? '').not.toMatch(/not assigned to an existing stock/)
    expect(op().status).not.toBe('error')
  })

  it('the same op is UNCHANGED by removing the modeled body (it never contributed)', () => {
    // The other half of "neither contributes nor prevents": with the modeled row
    // gone the outcome must be identical, which is what shows the guard excluded
    // it rather than merely tolerating it.
    installProject([ordinaryGeo('a', 'Part A'), ordinaryGeo('b', 'Part B'), hostileModelGeo()], '__all__', ['a', 'b'])
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    const withModel = { status: op().status, errorMessage: op().errorMessage }

    installProject([ordinaryGeo('a', 'Part A'), ordinaryGeo('b', 'Part B')], '__all__', ['a', 'b'])
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect({ status: op().status, errorMessage: op().errorMessage }).toEqual(withModel)
  })

  it('an op that REFERENCES the modeled body as its declared source lands on the named CAM-BINDING Stage 1 pending state, not error', () => {
    // R1 resolved this to an empty source list - a silent block. R2/R3 then made
    // it a hard 'error'. CAM-BINDING Stage 1 (coordination/work-orders/
    // CAM-BINDING.md) reopens this seam DELIBERATELY: a modeled body is now a
    // legal declared SOURCE (the op-picker gate), so referencing one by id is no
    // longer a mistake - it is just not yet COMPUTABLE (Stage 2). The op lands on
    // the named 'unsupported' status, never 'error' and never a silent 'ready'.
    //
    // CAM-BINDING Stage 2: contour_2d DOES have a real compute path now, so
    // this specific fixture (hostileModelGeo has no modelBody.display - never
    // regenerated) falls to a MORE SPECIFIC derive-failure message than
    // Stage 1's generic one, still 'unsupported', still naming the body.
    installProject([ordinaryGeo('a', 'Part A'), hostileModelGeo()], 'modelbody:F1')
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(op().status).toBe('unsupported')
    expect(op().errorMessage).toMatch(/Model F1/)
    expect(op().errorMessage).toMatch(/profile could not be derived/)
    expect(op().errorMessage).toMatch(/no tessellated geometry/)
    // ...and no toolpath was produced for it.
    expect(op().toolpathMoves ?? []).toHaveLength(0)
  })

  it('an ordinary op is untouched by the guard (no-regression control)', () => {
    installProject([ordinaryGeo('a', 'Part A')], 'a')
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(op().errorMessage ?? '').not.toMatch(/read-only projection/)
    expect(op().status).not.toBe('error')
  })
})
