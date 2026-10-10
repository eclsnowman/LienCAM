// @vitest-environment jsdom
//
// React-render SMOKE test for the FIXED-STOCK gizmo button's active state
// (commit B). The bug this gate locks: the tree's blue gizmo state used to be a
// DesignTree-local useState (activeStockGizmoId) independent of the viewport
// TransformControls, so an empty-viewport click could detach the gizmo while
// the icon stayed blue. After commit B the button's active state derives ONLY
// from the shared viewer.selectedStockId, and the row button TOGGLES that
// owner. This test asserts that one-way derivation + the toggle, the path tsc
// cannot see (hooks-order + wiring). Mirrors DesignTreeAutoStock.smoke.test.tsx
// (jsdom directive + in-memory localStorage shim + store-singleton reset).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist(). Install an in-memory Storage shim BEFORE
// importing the store. Pure test scaffolding; no app change.
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

const FIXED_ID = 'fixed-1'

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.getState().addFixedStock({
      id: FIXED_ID,
      name: 'Fixed Block',
      width: 50, height: 40, depth: 20,
      position: { x: 0, y: 0, z: 0 },
    })
  })
})

describe('DesignTree fixed-stock gizmo button follows viewer.selectedStockId', () => {
  it('renders the gizmo button inactive when no stock is the shared owner', () => {
    render(<DesignTree />)
    const btn = screen.getByTestId('fixed-stock-gizmo-btn')
    expect(btn).not.toBeNull()
    expect(btn.className).not.toContain('tree-icon-btn-active')
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
  })

  it('blues the gizmo button when selectedStockId becomes this fixed stock (state-driven, no button click)', () => {
    render(<DesignTree />)
    // Drive the SHARED owner directly via the store — the button must follow it
    // WITHOUT any local click. This is the one-way derivation commit B installs:
    // the icon mirrors viewer.selectedStockId, not a DesignTree-local useState.
    act(() => { useCamStore.getState().setSelectedStock(FIXED_ID) })
    const btn = screen.getByTestId('fixed-stock-gizmo-btn')
    expect(btn.className).toContain('tree-icon-btn-active')
  })

  it('clicking the gizmo button TOGGLES the shared owner (on then off)', () => {
    render(<DesignTree />)
    const btn = screen.getByTestId('fixed-stock-gizmo-btn')

    // OFF -> ON: clicking the button sets the shared owner to this stock id.
    act(() => { fireEvent.click(btn) })
    expect(useCamStore.getState().viewer.selectedStockId).toBe(FIXED_ID)
    expect(screen.getByTestId('fixed-stock-gizmo-btn').className).toContain('tree-icon-btn-active')

    // ON -> OFF: clicking the active button clears the shared owner (toggle).
    act(() => { fireEvent.click(screen.getByTestId('fixed-stock-gizmo-btn')) })
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
    expect(screen.getByTestId('fixed-stock-gizmo-btn').className).not.toContain('tree-icon-btn-active')
  })

  it('clearing selectedStockId externally (empty-click path) un-blues the icon', () => {
    render(<DesignTree />)
    act(() => { useCamStore.getState().setSelectedStock(FIXED_ID) })
    expect(screen.getByTestId('fixed-stock-gizmo-btn').className).toContain('tree-icon-btn-active')

    // The empty-viewport click path ultimately calls setSelectedStock(null).
    // Asserting the icon follows that clear is the exact desync the bug caused.
    act(() => { useCamStore.getState().setSelectedStock(null) })
    expect(screen.getByTestId('fixed-stock-gizmo-btn').className).not.toContain('tree-icon-btn-active')
  })
})
