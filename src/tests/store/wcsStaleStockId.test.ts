// Regression: a Setup's WCS keeps a STALE wcs.stockId pointing at a DELETED auto
// stock, so the DesignTree falsely flags it as "WCS stock reference is missing"
// even though the operation recomputes fine off the re-derived origin / binding.
//
// CONFIRMED REPRO (Operator, 2026-06-18), in UI terms:
//   1. A geometry is assigned to auto stock A; a Setup's WCS origin is bound to
//      stock A's corner (wcs.stockId = A).
//   2. DELETE auto stock A.
//   3. CREATE a new auto stock B.
//   4. ASSIGN the geometry to B.
//   5. RE-APPLY the WCS to the new stock B.
//   -> the setup row then shows the false "stock reference is missing" error.
// SAVE + RELOAD clears it: the bug is LIVE IN-MEMORY STALENESS.
//
// ROOT CAUSE: removeAutoStock() cleans up the DELETED stock's GEOMETRY members
// (clears geo.stockId) but leaves every setup's legacy wcs.stockId pointing at the
// now-deleted stock id. The cascade re-derive (applyAutoStockToSetups) bails for a
// missing bound stock (preserve-origin guard) and NEVER rewrites wcs.stockId, so
// the dangling reference persists in memory until a save/reload round-trip.
//
// This file drives the REAL store actions through the repro and asserts the
// DesignTree's exact `stockInvalid` predicate (wcs.stockId set but resolving to no
// PhysicalStock and no fixedStock). It FAILS on the pre-fix store, PASSES after.
//
// It also LOCKS the ADR-0003 fail-loud requirement: a WCS genuinely pinned to a
// stock id that was never re-bound to a real stock MUST still flag.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry, SceneStock, Setup, WCS, PhysicalStock,
  BoundingBox, Vec3, Project, AutoStockItem,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** 2D part bound to a named auto stock. */
function makeGeo(stockId: string, over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId, stockIdLocked: true,
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
      closed: true, type: 'contour', layerId: 'L1', area: 2500,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  } as ImportedGeometry
}

function autoStockItem(id: string, name: string): AutoStockItem {
  return { id, name, autoOffsetXY: 2, autoOffsetZTop: 1 }
}

function derivedPhysicalStock(id: string, name: string): PhysicalStock {
  return {
    id, name, mode: 'derived',
    bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 52, y: 52, z: 1 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function makeAutoSceneStock(autoStocks: AutoStockItem[]): SceneStock {
  return {
    mode: 'auto',
    autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [],
    autoStocks,
  }
}

function makeWcs(over: Partial<WCS> = {}): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    ...over,
  }
}

function makeSetup(wcs: WCS): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs,
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations: [], notes: '',
  }
}

function installProject(over: Partial<Project>): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [],
      setups: [],
      stocks: [],
      activeSetupId: 'setup-1',
      activeOperationId: null,
      ...over,
    },
  }))
}

/** The EXACT predicate DesignTree.tsx uses to flag a setup as dangling
 *  (DesignTree.tsx ~2158): wcs.stockId is set AND resolves to no PhysicalStock
 *  in project.stocks AND no fixedStock in sceneStock.fixedStocks. */
function stockInvalid(setup: Setup, project: Project): boolean {
  return !!(
    setup.wcs.stockId &&
    !(project.stocks ?? []).some((ps) => ps.id === setup.wcs.stockId) &&
    !(project.sceneStock.fixedStocks ?? []).some((fs) => fs.id === setup.wcs.stockId)
  )
}

function setup0(): Setup {
  return useCamStore.getState().project.setups[0]
}
function proj(): Project {
  return useCamStore.getState().project
}

const A_ID = 'auto-stock-a'
const B_ID = 'auto-stock-b'

beforeEach(() => {
  installProject({})
})

// =============================================================================
// CONFIRMED REPRO: delete A -> create B -> assign geo to B -> re-bind WCS to B
// =============================================================================

describe('WCS stale stockId after deleting/recreating its auto stock', () => {
  function installStockAScenario() {
    const geo = makeGeo(A_ID)
    const wcs = makeWcs({
      stockId: A_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      originBinding: { kind: 'stock_corner', stockId: A_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
    })
    installProject({
      geometry: [geo],
      stocks: [derivedPhysicalStock(A_ID, 'Auto Stock A')],
      setups: [makeSetup(wcs)],
      sceneStock: makeAutoSceneStock([autoStockItem(A_ID, 'Auto Stock A')]),
    })
  }

  it('does NOT falsely flag the setup after re-binding to stock B (the bug)', () => {
    // Step 1: geo on auto stock A; WCS bound to A's corner.
    installStockAScenario()
    expect(stockInvalid(setup0(), proj())).toBe(false)  // healthy at start

    // Step 2: DELETE auto stock A.
    useCamStore.getState().removeAutoStock(A_ID)

    // Step 3: CREATE a new auto stock B.
    useCamStore.getState().addAutoStock(autoStockItem(B_ID, 'Auto Stock B'))

    // Step 4: ASSIGN the geometry to B.
    useCamStore.getState().setGeometryAutoStock('geo-1', B_ID)

    // Step 5: RE-APPLY the WCS to stock B. Re-deriving the auto-bound WCS (the
    // cascade the stock actions run) must leave the legacy wcs.stockId pointing at
    // a REAL stock, not the deleted A. After the fix this is B.
    // (No-op trigger that re-runs the auto applier, mirroring a stock-touch.)
    useCamStore.getState().updateAutoStock(B_ID, { name: 'Auto Stock B (renamed)' })

    // The bug: wcs.stockId is still A (deleted) -> DesignTree flags it falsely
    // even though the op resolves fine off the re-derived origin/binding.
    expect(stockInvalid(setup0(), proj())).toBe(false)
  })

  it('keeps the WCS bound to a stock that actually exists after the repro', () => {
    installStockAScenario()
    useCamStore.getState().removeAutoStock(A_ID)
    useCamStore.getState().addAutoStock(autoStockItem(B_ID, 'Auto Stock B'))
    useCamStore.getState().setGeometryAutoStock('geo-1', B_ID)
    useCamStore.getState().updateAutoStock(B_ID, { name: 'Auto Stock B (renamed)' })

    const s = setup0()
    // wcs.stockId must NOT point at the deleted A. After the fix it is either the
    // surviving catch-all (DERIVED_STOCK_ID) or unbound (undefined) — never the
    // dangling deleted id. Either way the false flag is gone.
    expect(s.wcs.stockId).not.toBe(A_ID)
    if (s.wcs.stockId != null) {
      expect((proj().stocks ?? []).some((ps) => ps.id === s.wcs.stockId)).toBe(true)
    }
    expect(stockInvalid(s, proj())).toBe(false)
  })
})

// =============================================================================
// ADR-0003 FAIL-LOUD GUARD: a genuinely dangling wcs.stockId MUST still flag.
// =============================================================================

describe('ADR-0003: a truly-dangling wcs.stockId still flags', () => {
  it('flags a setup whose wcs.stockId points at a stock that was never re-bound', () => {
    const wcs = makeWcs({
      stockId: 'ghost-stock', cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      originBinding: { kind: 'stock_corner', stockId: 'ghost-stock', cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
    })
    installProject({
      geometry: [],
      stocks: [derivedPhysicalStock('real-stock', 'Real Stock')],
      setups: [makeSetup(wcs)],
      sceneStock: makeAutoSceneStock([autoStockItem('real-stock', 'Real Stock')]),
    })
    // ghost-stock resolves to nothing real and there is no member geometry to
    // re-bind it -> it MUST stay flagged (no silent heal to a guessed stock).
    expect(stockInvalid(setup0(), proj())).toBe(true)
  })
})
