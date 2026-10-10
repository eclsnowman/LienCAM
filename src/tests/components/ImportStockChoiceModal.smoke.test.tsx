// @vitest-environment jsdom
//
// React-render SMOKE test for ImportStockChoiceModal (the import-time stock
// chooser, IMPORT-STOCK-PROMPT). tsc + the pure vitest suite do NOT catch
// render-time defects (hooks-order bugs, missing selectors); this mounts the
// modal open and asserts its chrome + plainly-worded options render, and that
// clicking an option resolves the awaited choice. Mirrors
// MultiBodyImportModal.smoke.test.tsx (localStorage shim + store-driven
// closed->open).

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ImportedGeometry, PhysicalStock } from '../../types'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'

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

const { ImportStockChoiceModal } = await import('../../components/modals/ImportStockChoiceModal')
const { useCamStore } = await import('../../store')

const fixtureStock: PhysicalStock = {
  id: 'fix-1',
  name: 'Fixture A',
  mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 50, y: 50, z: 10 },
    size: { x: 50, y: 50, z: 10 },
    center: { x: 25, y: 25, z: 5 },
  },
  position: { x: 0, y: 0, z: 0 },
}

function seedAssignableGeometry(geoId: string): void {
  const geo: ImportedGeometry = {
    id: geoId,
    name: 'Part',
    filename: 'part.stl',
    type: 'mesh',
    format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 10, z: 5 },
      size: { x: 10, y: 10, z: 5 },
      center: { x: 5, y: 5, z: 2.5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
  }
  useCamStore.setState((s) => ({
    project: { ...s.project, stocks: [fixtureStock], geometry: [geo] },
  }))
}

const catchAllStock: PhysicalStock = {
  id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 },
    size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 },
  },
  position: { x: 0, y: 0, z: 0 },
}
const namedDerivedStock: PhysicalStock = {
  id: 'auto-op', name: 'Op Stock', mode: 'derived',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 },
    size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 },
  },
  position: { x: 0, y: 0, z: 0 },
}

/** Seed the catch-all derived stock + one NAMED derived stock + a part, so the
 *  chooser opens with the named derived stock as a pickable option (the
 *  catch-all is the Auto option, NOT a named button). */
function seedDerivedStockGeometry(geoId: string): void {
  const geo: ImportedGeometry = {
    id: geoId,
    name: 'Part',
    filename: 'part.stl',
    type: 'mesh',
    format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 10, z: 5 },
      size: { x: 10, y: 10, z: 5 },
      center: { x: 5, y: 5, z: 2.5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
  }
  useCamStore.setState((s) => ({
    project: { ...s.project, stocks: [catchAllStock, namedDerivedStock], geometry: [geo] },
  }))
}

afterEach(() => {
  cleanup()
  // Settle any pending request so the module-level resolver never leaks.
  act(() => { useCamStore.getState().resolveImportStockChoice({ kind: 'auto' }) })
})

describe('ImportStockChoiceModal render smoke', () => {
  it('renders nothing while no choice is pending', () => {
    render(<ImportStockChoiceModal />)
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('opens on requestImportStockChoice with the named stocks + Auto + None options; Auto carries the default marker', () => {
    // Seed an explicit stock so requestImportStockChoice opens (rather than
    // returning null for "no obvious stock").
    seedAssignableGeometry('g1')

    render(<ImportStockChoiceModal />)
    expect(document.querySelector('.modal-backdrop')).toBeNull()

    act(() => {
      void useCamStore.getState().requestImportStockChoice({ geoId: 'g1', name: 'bracket.stl' })
    })

    expect(document.querySelector('.modal-backdrop')).not.toBeNull()
    expect(document.querySelector('.modal-container')).not.toBeNull()
    // The part is named in the title.
    expect(screen.getByText(/Which stock should/)).not.toBeNull()
    expect(screen.getByText(/bracket\.stl/)).not.toBeNull()
    // The named stock, Auto (default), and None options all render.
    expect(screen.getByTestId('import-stock-choice-stock-fix-1')).not.toBeNull()
    expect(screen.getByText(/Auto \(default\)/)).not.toBeNull()
    expect(screen.getByText(/^None$/)).not.toBeNull()

    act(() => { useCamStore.getState().resolveImportStockChoice({ kind: 'auto' }) })
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('clicking a named stock resolves the awaited choice with that stockId and closes', async () => {
    seedAssignableGeometry('g2')

    render(<ImportStockChoiceModal />)
    let resolved: { kind: string; stockId?: string } | null = null
    act(() => {
      void useCamStore.getState().requestImportStockChoice({ geoId: 'g2', name: 'part.stl' })
        .then((c) => { resolved = c ? { kind: c.kind, stockId: c.kind === 'stock' ? c.stockId : undefined } : null })
    })

    const stockBtn = screen.getByTestId('import-stock-choice-stock-fix-1')
    await act(async () => { fireEvent.click(stockBtn) })

    expect(resolved).toEqual({ kind: 'stock', stockId: 'fix-1' })
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('a named DERIVED stock renders as a pickable option (not the catch-all) and resolves with its id', async () => {
    // The catch-all (DERIVED_STOCK_ID) is the Auto option; the NAMED derived
    // stock 'auto-op' renders as its own button and is clickable. Guards the
    // completion patch: derived stocks must appear in the chooser.
    seedDerivedStockGeometry('g5')

    render(<ImportStockChoiceModal />)
    expect(document.querySelector('.modal-backdrop')).toBeNull()

    let resolved: { kind: string; stockId?: string } | null = null
    act(() => {
      void useCamStore.getState().requestImportStockChoice({ geoId: 'g5', name: 'bracket.stl' })
        .then((c) => { resolved = c ? { kind: c.kind, stockId: c.kind === 'stock' ? c.stockId : undefined } : null })
    })

    // The named derived stock button renders; the catch-all does NOT (no button
    // with the catch-all's id).
    expect(screen.getByTestId('import-stock-choice-stock-auto-op')).not.toBeNull()
    expect(document.querySelector('[data-testid="import-stock-choice-stock-' + DERIVED_STOCK_ID + '"]')).toBeNull()
    // The Auto (default) option still renders alongside the named derived pick.
    expect(screen.getByText(/Auto \(default\)/)).not.toBeNull()

    const derivedBtn = screen.getByTestId('import-stock-choice-stock-auto-op')
    await act(async () => { fireEvent.click(derivedBtn) })

    expect(resolved).toEqual({ kind: 'stock', stockId: 'auto-op' })
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('clicking None resolves with the none pick and closes', async () => {
    seedAssignableGeometry('g3')

    render(<ImportStockChoiceModal />)
    let resolved: string | null = null
    act(() => {
      void useCamStore.getState().requestImportStockChoice({ geoId: 'g3', name: 'part.stl' })
        .then((c) => { resolved = c ? c.kind : null })
    })

    const noneBtn = screen.getByTestId('import-stock-choice-none')
    await act(async () => { fireEvent.click(noneBtn) })

    expect(resolved).toBe('none')
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('dismiss (backdrop) resolves with auto (the pre-selected historical default)', async () => {
    seedAssignableGeometry('g4')

    render(<ImportStockChoiceModal />)
    let resolved: string | null = null
    act(() => {
      void useCamStore.getState().requestImportStockChoice({ geoId: 'g4', name: 'part.stl' })
        .then((c) => { resolved = c ? c.kind : null })
    })

    const backdrop = document.querySelector('[data-testid="import-stock-choice-backdrop"]') as HTMLElement
    await act(async () => { fireEvent.mouseDown(backdrop) })

    expect(resolved).toBe('auto')
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })
})
