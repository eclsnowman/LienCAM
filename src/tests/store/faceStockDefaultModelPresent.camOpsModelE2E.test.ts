// @vitest-environment jsdom
//
// CAM-OPS-MODEL-E2E Part 2 (Operator 2026-07-24): 'face' is the one op family in
// this sweep whose DEFAULT geometry source (boundarySource: 'stock',
// defaultFaceParams in NewOperationModal.tsx) references no geometry ENTRY
// at all - op.params.geometryId is the sentinel '__stock__', which matches
// no row in project.geometry. operationReferencedGeometryIds
// (src/store/opModelOriginGuard.ts) therefore returns ['__stock__'], and
// guardOperationModelOrigin's computeGeometryScope only refuses when a
// REFERENCED id actually resolves to a model-origin row - a sentinel that
// resolves to nothing is a legitimate no-op for the guard.
//
// This proves that CLAIM directly: a project holding a model-origin body
// (never referenced by this op) does NOT block a stock-boundary face op from
// reaching dispatch. Deliberately does NOT assert a completed 'ready'
// toolpath (that would require also proving the stock-footprint/height
// resolution chain, unrelated to the model-origin question this sweep is
// auditing) - it asserts the op clears the model-origin guard AND the
// stock-footprint resolution (dispatchGeo's `fp.boundarySource === 'stock'`
// branch, src/store/index.ts ~7852) far enough to reach a real
// COMPUTE_FACE worker dispatch, which is as far as "is this refused because
// of the model body sitting in the project" can be observed. Same silent-
// worker, not-awaited-past-dispatch harness as
// int17aR3OpCensus.test.ts's CONTROL cases (guardOperationModelOrigin is
// synchronous and runs before any await, so by the time control returns
// here the guard has already had its say).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type {
  ImportedGeometry, Operation, PhysicalStock, Project, SceneStock, Setup, Tool,
  Vec3, BoundingBox, WCS, HeightParams } from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function modelGeoUnreferenced(): ImportedGeometry {
  return {
    id: 'modelbody:F1', name: 'Model F1', filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 } },
  } as unknown as ImportedGeometry
}

function derivedStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 102, y: 102, z: 12 }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

// mode: 'fixed' (not 'auto') so synthesizeStockFootprintLoop resolves a real
// footprint with no viewport present (jsdom has no __cncViewport global) -
// getStockBoundsFromViewport returns null in that environment, and the
// 'auto' branch fails loud by design (a different, unrelated concern).
const sceneStock = {
  mode: 'fixed', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
} as unknown as SceneStock

function makeFaceStockOp(): Operation {
  // Stamped for Smart Height V2 (commit 2e5678b7): the legacy-intent bridge
  // (legacyHeightIntentForOperation) maps clearance/retract/feed straight
  // through as absolute wcs_plane offsets - it no longer co-moves them off
  // the resolved stock top the way the old V1 dispatch-time math did. The
  // stubbed stock top below resolves to world/WCS Z 12 (WCS origin is Z 0),
  // so retract/feed must already clear it as literal WCS values (17/13) for
  // the V2 authority's Clearance >= Retract >= Feed >= Material Start check
  // to hold; clearanceHeightMode is likewise unread by the bridge.
  const opHeights = {
    clearanceHeight: 25, clearanceHeightMode: 'relative',
    retractHeight: 17, feedHeight: 13,
    topHeight: 0, topHeightMode: 'stock_top',
    bottomHeight: -1, bottomHeightMode: 'absolute',
  }
  const params = { boundarySource: 'stock', geometryId: '__stock__', loopIds: [] }
  return {
    id: 'op-1', name: 'Face 1', type: 'face', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights: opHeights,
    passes: { stepdown: 1, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 2, rampLength: 5,
      leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
    },
    params,
    smartHeight: smartHeightAuthorityFixture('face', {
      setupId: 'setup-1', heights: opHeights as HeightParams, params, stockId: DERIVED_STOCK_ID,
    }),
  } as unknown as Operation
}

function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
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

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

describe('CAM-OPS-MODEL-E2E Part 2: face (boundarySource: stock, the default) with an UNREFERENCED model-origin body present', () => {
  let OrigWorker: typeof Worker | undefined
  let workerRequests: unknown[] = []

  beforeEach(() => {
    workerRequests = []
    OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((e: unknown) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      postMessage(data: unknown): void { workerRequests.push(data) }
      terminate(): void { /* no-op */ }
    }
    // getStockBoundsFromViewport (src/store/index.ts) reads this global -
    // browser-only in production (CNCViewport installs it), stubbed here so
    // the 'stock' branch's faceTopWorldZ capture runs the SAME way it does
    // for real, rather than falling through to the (also real, but separate
    // and unrelated to this test's claim) no-viewport synthesize fallback.
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 12 } }),
    }
    useCamStore.setState((s) => ({
      toolLibrary: [tool],
      project: {
        ...s.project,
        geometry: [modelGeoUnreferenced()],
        stocks: [derivedStock()],
        setups: [makeSetup(makeFaceStockOp())],
        sceneStock,
      } as Project,
    }))
  })

  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
    delete (window as unknown as Record<string, unknown>).__cncViewport
    vi.restoreAllMocks()
  })

  it('is NOT refused by the model-origin guard and reaches a real COMPUTE_FACE worker dispatch', async () => {
    void useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
      .catch(() => { /* the silent-worker shim never resolves; unrelated to this assertion */ })
    await Promise.resolve()
    await Promise.resolve()

    expect(currentOp().errorMessage ?? '').not.toMatch(/sources modeled geometry/)
    expect(currentOp().status).not.toBe('unsupported')
    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).not.toBe('error')
    expect(workerRequests).toHaveLength(1)
    expect((workerRequests[0] as { type?: string }).type).toBe('COMPUTE_FACE')
  })
})
