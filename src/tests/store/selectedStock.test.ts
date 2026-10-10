// Commit A of the unified stock-select work: a single shared selection owner
// `viewer.selectedStockId` so the viewport gizmo and the tree's active state stop
// drifting. TRI-EXCLUSION (ADR 0025 selection model): selectedGeometryId /
// selectedNestId / selectedStockId are mutually exclusive, and selecting ANY of
// the three (or an operation) clears the active operation (activeOperationId).
// At most one of {geometry, op, nest, stock} is selected at a time. Pure store
// tests (no React render): they exercise the store actions directly.
//
// Coverage:
//  (a) setSelectedStock sets selectedStockId and clears geometry + nest;
//  (b) setSelectedStock clears the active operation (activeOperationId);
//  (c) setSelectedGeometry clears selectedStockId;
//  (d) setSelectedNest clears selectedStockId;
//  (e) setActiveOperation(non-null) clears selectedStockId;
//  (f) removing a SELECTED fixed stock clears selectedStockId (different stock left alone);
//  (g) removing a SELECTED auto stock clears selectedStockId;
//  (h) selectedStockId is TRANSIENT (lives in the non-persisted viewer slice).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore, persistPartialize } from '../../store'
import { DERIVED_STOCK_ID as DSID } from '../../store/migrateHierarchy'
import type { AutoStockItem } from '../../types'

function autoItem(over: Partial<AutoStockItem> = {}): AutoStockItem {
  return { id: 'auto-1', name: 'Auto', autoOffsetXY: 2, autoOffsetZTop: 1, ...over }
}

// Reset the viewer + project selection state before each test so cases don't
// bleed into one another. selection ids live in viewer; activeOperationId/
// activeSetupId live in project.
beforeEach(() => {
  useCamStore.setState((s) => ({
    viewer: {
      ...s.viewer,
      selectedGeometryId: null,
      selectedNestId: null,
      selectedStockId: null,
    },
    project: { ...s.project, activeOperationId: null, activeSetupId: null, setups: [] },
  }))
})

describe('setSelectedStock — tri-exclusion', () => {
  it('(a) sets selectedStockId and clears geometry + nest', () => {
    useCamStore.getState().setSelectedGeometry('geo-1')
    useCamStore.getState().setSelectedStock('stk-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBe('stk-1')
    expect(useCamStore.getState().viewer.selectedGeometryId).toBeNull()

    // From a nest selection too.
    useCamStore.getState().setSelectedNest('nest-1')
    useCamStore.getState().setSelectedStock('stk-2')
    expect(useCamStore.getState().viewer.selectedStockId).toBe('stk-2')
    expect(useCamStore.getState().viewer.selectedNestId).toBeNull()
  })

  it('(b) clears the active operation (activeOperationId)', () => {
    useCamStore.setState((s) => ({
      project: { ...s.project, activeOperationId: 'op-1' },
    }))
    useCamStore.getState().setSelectedStock('stk-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBe('stk-1')
    expect(useCamStore.getState().project.activeOperationId).toBeNull()
  })

  it('clearing the stock (null) leaves competing selections untouched', () => {
    useCamStore.getState().setSelectedGeometry('geo-1')
    useCamStore.getState().setSelectedStock(null)
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('geo-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
  })
})

describe('competing selectors clear selectedStockId', () => {
  it('(c) setSelectedGeometry drops the selected stock', () => {
    useCamStore.getState().setSelectedStock('stk-1')
    useCamStore.getState().setSelectedGeometry('geo-1')
    expect(useCamStore.getState().viewer.selectedGeometryId).toBe('geo-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
  })

  it('(d) setSelectedNest drops the selected stock', () => {
    useCamStore.getState().setSelectedStock('stk-1')
    useCamStore.getState().setSelectedNest('nest-1')
    expect(useCamStore.getState().viewer.selectedNestId).toBe('nest-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
  })

  it('(e) setActiveOperation(non-null) drops the selected stock', () => {
    useCamStore.getState().setSelectedStock('stk-1')
    useCamStore.getState().setActiveOperation('op-1')
    expect(useCamStore.getState().project.activeOperationId).toBe('op-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
  })
})

describe('removing a selected stock clears selectedStockId', () => {
  it('(f1) removing the SELECTED fixed stock clears selectedStockId', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addFixedStock({
      id: 'fs-1', name: 'Block', width: 100, height: 100, depth: 20,
      position: { x: 0, y: 0, z: 0 },
    })
    useCamStore.getState().setSelectedStock('fs-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBe('fs-1')

    useCamStore.getState().removeFixedStock('fs-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
  })

  it('(f2) removing a DIFFERENT fixed stock leaves the selection intact', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addFixedStock({
      id: 'fs-1', name: 'A', width: 100, height: 100, depth: 20,
      position: { x: 0, y: 0, z: 0 },
    })
    useCamStore.getState().addFixedStock({
      id: 'fs-2', name: 'B', width: 100, height: 100, depth: 20,
      position: { x: 200, y: 0, z: 0 },
    })
    useCamStore.getState().setSelectedStock('fs-1')
    useCamStore.getState().removeFixedStock('fs-2')
    expect(useCamStore.getState().viewer.selectedStockId).toBe('fs-1')
  })

  it('(g) removing the SELECTED auto stock clears selectedStockId', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-1' }))
    useCamStore.getState().setSelectedStock('auto-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBe('auto-1')

    useCamStore.getState().removeAutoStock('auto-1')
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
    // The catch-all derived stock is still present (sanity that remove ran).
    expect((useCamStore.getState().project.stocks ?? []).some((s) => s.id === DSID)).toBe(true)
  })

  it('(g2) removing a DIFFERENT auto stock leaves the selection intact', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-1' }))
    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-2' }))
    useCamStore.getState().setSelectedStock('auto-1')
    useCamStore.getState().removeAutoStock('auto-2')
    expect(useCamStore.getState().viewer.selectedStockId).toBe('auto-1')
  })
})

describe('selectedStockId is transient', () => {
  it('(h) is NOT in the persisted partialize slice', () => {
    useCamStore.getState().setSelectedStock('stk-1')
    const slice = persistPartialize(useCamStore.getState())
    expect('viewer' in slice).toBe(false)
    expect(JSON.stringify(slice)).not.toContain('selectedStockId')
  })
})
