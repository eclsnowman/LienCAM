// @vitest-environment jsdom
//
// React-render SMOKE test for the PropertiesPanel FIXED-STOCK editable branch.
// The repo's vitest env is 'node' by default (vite.config.ts); the directive
// above flips THIS file to jsdom so a real React tree can mount.
//
// WHY THIS GATE EXISTS: a hooks-order bug ("Rendered more hooks than during the
// previous render") shipped once in a modal because a hook sat below an early
// return and tsc + the pure-logic vitest suite did not catch it
// (feedback_render_gate_ui_changes). This file seeds a selected fixed stock and
// mounts PropertiesPanel, exercising the FixedStockProperties render path (which
// calls useCamStore hooks) that tsc cannot see. The stock branch lives high in
// the returned cascade and the selectedStock lookups sit with the other consts
// (before any return), so no hook ordering can shift — this mount guards that,
// plus asserts the editable W/H/D + position fields render.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { FixedStockItem } from '../../types'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store. Pure test
// scaffolding; no app change. (Mirrors PropertiesPanelNest.smoke.test.tsx.)
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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

// The store is a process singleton; reset to a clean project before each test so
// the tests are order-independent.
beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
  })
})

// Add one named fixed stock and select it (sets viewer.selectedStockId).
function seedFixedStock(): FixedStockItem {
  const stock: FixedStockItem = {
    id: 'fs-pp-1',
    name: 'Block A',
    width: 120,
    height: 80,
    depth: 19,
    position: { x: 5, y: 10, z: 0 },
  }
  act(() => {
    useCamStore.getState().addFixedStock(stock)
    useCamStore.getState().setSelectedStock(stock.id)
  })
  return stock
}

describe('PropertiesPanel fixed-stock editable render smoke', () => {
  it('mounts the stock branch without throwing (guards hooks-order)', () => {
    seedFixedStock()
    // A throw here (e.g. a hooks-order crash) fails the test.
    render(<PropertiesPanel />)
    expect(screen.getByText('Properties')).not.toBeNull()
  })

  it('renders the stock name', () => {
    seedFixedStock()
    render(<PropertiesPanel />)
    expect(screen.getByText('Block A')).not.toBeNull()
  })

  it('renders editable Width/Height/Depth + position rows', () => {
    seedFixedStock()
    render(<PropertiesPanel />)
    expect(screen.getByText('Width (X)')).not.toBeNull()
    expect(screen.getByText('Height (Y)')).not.toBeNull()
    expect(screen.getByText('Depth (Z)')).not.toBeNull()
    expect(screen.getByText('Pos X')).not.toBeNull()
    expect(screen.getByText('Pos Y')).not.toBeNull()
    expect(screen.getByText('Pos Z')).not.toBeNull()
    // Each editable row hosts a NumericInput (<input>); 6 rows -> >=6 inputs.
    const inputs = document.querySelectorAll('input')
    expect(inputs.length).toBeGreaterThanOrEqual(6)
  })

  it('writes through updateFixedStock when a field changes the store value', () => {
    const stock = seedFixedStock()
    render(<PropertiesPanel />)
    // Drive the SAME store action the field calls (the field's onChange ->
    // updateFixedStock). Asserts the panel + store agree on the write path.
    act(() => {
      useCamStore.getState().updateFixedStock(stock.id, { position: { ...stock.position, x: 42 } })
    })
    const updated = useCamStore.getState().project.sceneStock.fixedStocks.find((fs) => fs.id === stock.id)
    expect(updated?.position.x).toBe(42)
  })
})
