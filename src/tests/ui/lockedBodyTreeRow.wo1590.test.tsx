// @vitest-environment jsdom
//
// WO-1590 (mating S0): the design tree shows a padlock on a locked row and
// offers a one-click Lock/Unlock toggle, driving the real setGeometryLocked /
// setFixedStockLocked store actions - same render/interaction shape as
// WO-1573's workholdingTreeAndProperties test.
//
// jsdom's built-in localStorage is broken under vitest's node launch flags,
// and the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store (same
// scaffolding as workholdingTreeAndProperties.wo1573.test.tsx).
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { ImportedGeometry } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => new ArrayBuffer(84)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
  })
  delete (window as unknown as { __cncViewport?: unknown }).__cncViewport
})

function meshGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-part-1', name: 'Bracket', filename: 'bracket.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
  } as ImportedGeometry
}

describe('WO-1590: design tree padlock on a geometry row', () => {
  it('an unlocked row offers "Lock in place"; clicking it locks the body and swaps to "Unlock"', () => {
    const geo = meshGeo({ id: 'vise-1', name: 'Kurt vise' })
    act(() => { useCamStore.getState().addGeometry(geo) })
    render(<DesignTree />)

    const btn = screen.getByTestId(`lock-geo-btn-${geo.id}`)
    expect(btn.getAttribute('aria-label')).toBe('Lock in place')

    fireEvent.click(btn)

    expect(useCamStore.getState().project.geometry.find((g) => g.id === geo.id)?.locked).toBe(true)
    expect(screen.getByTestId(`lock-geo-btn-${geo.id}`).getAttribute('aria-label')).toBe('Unlock')
  })

  it('clicking an already-locked row unlocks it', () => {
    const geo = meshGeo({ id: 'vise-2', name: 'Toggle vise' })
    act(() => { useCamStore.getState().addGeometry(geo) })
    act(() => { useCamStore.getState().setGeometryLocked(geo.id, true) })
    render(<DesignTree />)

    expect(screen.getByTestId(`lock-geo-btn-${geo.id}`).getAttribute('aria-label')).toBe('Unlock')
    fireEvent.click(screen.getByTestId(`lock-geo-btn-${geo.id}`))
    expect(useCamStore.getState().project.geometry.find((g) => g.id === geo.id)?.locked).toBeFalsy()
  })
})

describe('WO-1590: design tree padlock on a fixed-stock row', () => {
  it('locks and unlocks a fixed stock block through the row button', () => {
    act(() => {
      useCamStore.getState().updateSceneStock({ mode: 'fixed' })
      useCamStore.getState().addFixedStock({
        id: 'stock-1', name: 'Vise block', width: 100, height: 60, depth: 40,
        position: { x: 0, y: 0, z: 0 },
      })
    })
    render(<DesignTree />)

    const btn = screen.getByTestId('fixed-stock-lock-btn')
    expect(btn.getAttribute('aria-label')).toBe('Lock in place')

    fireEvent.click(btn)
    expect(
      (useCamStore.getState().project.sceneStock.fixedStocks ?? []).find((fs) => fs.id === 'stock-1')?.locked,
    ).toBe(true)
    expect(screen.getByTestId('fixed-stock-lock-btn').getAttribute('aria-label')).toBe('Unlock')

    fireEvent.click(screen.getByTestId('fixed-stock-lock-btn'))
    expect(
      (useCamStore.getState().project.sceneStock.fixedStocks ?? []).find((fs) => fs.id === 'stock-1')?.locked,
    ).toBeFalsy()
  })

  // WO-1590 audit: handleUpdateFixedStock (DesignTree.tsx) rebuilt the viewport
  // by merging the caller's raw `updates` onto the stock, undoing the store's
  // own refusal — the box moved on screen and stayed there while the store
  // correctly held position. Drive the REAL typed Pos X field on a locked row
  // and assert the viewport rebuild it triggers carries the UNCHANGED position.
  it('a locked stock row rebuilds the viewport at its held position, not the refused typed edit', () => {
    const rebuildStock = vi.fn()
    ;(window as unknown as Record<string, unknown>).__cncViewport = { rebuildStock }

    act(() => {
      useCamStore.getState().updateSceneStock({ mode: 'fixed' })
      useCamStore.getState().addFixedStock({
        id: 'stock-2', name: 'Locked block', width: 100, height: 60, depth: 40,
        position: { x: 0, y: 0, z: 0 },
      })
      useCamStore.getState().setFixedStockLocked('stock-2', true)
    })
    render(<DesignTree />)

    // Expand the stock row to reveal its typed Pos X/Y/Z fields.
    fireEvent.click(screen.getByText('Locked block'))
    const posXRow = Array.from(document.querySelectorAll('.stock-field-row'))
      .find((el) => el.querySelector('.stock-field-label')?.textContent === 'Pos X')!
    const posXInput = posXRow.querySelector('input')!

    act(() => {
      fireEvent.focus(posXInput)
      fireEvent.change(posXInput, { target: { value: '55' } })
      fireEvent.blur(posXInput)
    })

    expect(
      (useCamStore.getState().project.sceneStock.fixedStocks ?? []).find((fs) => fs.id === 'stock-2')?.position,
    ).toEqual({ x: 0, y: 0, z: 0 })
    expect(rebuildStock).toHaveBeenCalled()
    const lastCall = rebuildStock.mock.calls[rebuildStock.mock.calls.length - 1][0]
    const rebuiltStock = (lastCall.fixedStocks ?? []).find((fs: { id: string }) => fs.id === 'stock-2')
    expect(rebuiltStock.position).toEqual({ x: 0, y: 0, z: 0 })

    delete (window as unknown as Record<string, unknown>).__cncViewport
  })
})
