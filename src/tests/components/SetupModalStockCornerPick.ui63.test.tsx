// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PhysicalStock } from '../../types'
import { resolveStockCornerPick } from '../../lib/viewport/CNCViewport'

const appCss = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8')

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: memStorage,
  configurable: true,
})

const { SetupModal } = await import('../../components/modals/SetupModal')
const { useCamStore } = await import('../../store')

let pickCallback: ((result: {
  stockId: string
  row: 0 | 1 | 2
  col: 0 | 1 | 2
  face: 'top' | 'bottom'
  pos: { x: number; y: number; z: number }
}) => void) | null = null
let allowedIds: readonly string[] = []

function stock(id: string, name: string, x: number): PhysicalStock {
  return {
    id,
    name,
    mode: 'explicit',
    bounds: {
      min: { x, y: 0, z: 0 },
      max: { x: x + 100, y: 50, z: 12 },
      size: { x: 100, y: 50, z: 12 },
      center: { x: x + 50, y: 25, z: 6 },
    },
    position: { x, y: 0, z: 0 },
  }
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  pickCallback = null
  allowedIds = []
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: (id?: string) => id === 'stock-b'
      ? { min: { x: 200, y: 0, z: 0 }, max: { x: 300, y: 50, z: 12 } }
      : { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 50, z: 12 } },
    setWCSOrigin: vi.fn(),
    enterStockCornerPickMode: (
      callback: NonNullable<typeof pickCallback>,
      ids: readonly string[] = [],
    ) => {
      pickCallback = callback
      allowedIds = ids
    },
    exitStockCornerPickMode: vi.fn(),
    exitWCSGizmoMode: vi.fn(),
    exitVertexPickMode: vi.fn(),
  }
  useCamStore.setState((state) => ({
    activeModal: null,
    editingSetupId: null,
    project: {
      ...state.project,
      stocks: [stock('stock-a', 'Stock A', 0), stock('stock-b', 'Stock B', 200)],
      geometry: [
        { id: 'part-a', stockId: 'stock-a' },
        { id: 'part-b', stockId: 'stock-b' },
      ] as unknown as typeof state.project.geometry,
      setups: [],
    },
  }))
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('UI-63 rendered-stock WCS picking', () => {
  it('snaps a rendered hit to the nearest named 3x3 stock point', () => {
    expect(resolveStockCornerPick(
      'stock-b',
      { x: 293, y: 47, z: 11.8 },
      { min: { x: 200, y: 0, z: 0 }, max: { x: 300, y: 50, z: 12 } },
    )).toEqual({
      stockId: 'stock-b',
      row: 0,
      col: 2,
      face: 'top',
      pos: { x: 300, y: 50, z: 12 },
    })
  })

  it('uses the viewport pick as both stock identity and WCS origin', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    fireEvent.click(screen.getByTestId('setup-pick-stock-corner'))

    expect(screen.getByTestId('setup-stock-corner-pick-banner')).not.toBeNull()
    expect(allowedIds).toEqual(['stock-a', 'stock-b'])
    const choose = pickCallback
    act(() => {
      choose?.({
        stockId: 'stock-b',
        row: 0,
        col: 2,
        face: 'top',
        pos: { x: 300, y: 50, z: 12 },
      })
    })

    expect(screen.queryByTestId('setup-stock-corner-pick-banner')).toBeNull()
    const select = document.querySelector('select.wcs-stock-select') as HTMLSelectElement
    expect(select.value).toBe('stock-b')
    expect((screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement).disabled)
      .toBe(false)
  })

  it('cancels stock-corner picking before a later Escape closes the modal', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    fireEvent.change(document.querySelector('select.wcs-stock-select') as HTMLSelectElement, {
      target: { value: 'stock-a' },
    })
    const name = screen.getByPlaceholderText('Setup 1') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Keep stock draft' } })
    fireEvent.click(screen.getByTestId('setup-pick-stock-corner'))

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' })
    expect(useCamStore.getState().project.setups).toHaveLength(0)
    expect(screen.getByTestId('setup-stock-corner-pick-banner')).not.toBeNull()

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByTestId('setup-stock-corner-pick-banner')).toBeNull()
    expect((screen.getByPlaceholderText('Setup 1') as HTMLInputElement).value)
      .toBe('Keep stock draft')
    expect(useCamStore.getState().activeModal).toBe('new-setup')

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(useCamStore.getState().activeModal).toBeNull()
    expect(useCamStore.getState().project.setups).toHaveLength(0)
  })

  it('cancels viewport vertex picking before a later Escape closes the modal', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    const name = screen.getByPlaceholderText('Setup 1') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Keep vertex draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Snap' }))
    fireEvent.click(screen.getByRole('button', { name: /Pick Vertex/ }))

    expect(screen.getByTestId('setup-vertex-pick-banner')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' })
    expect(useCamStore.getState().project.setups).toHaveLength(0)

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByTestId('setup-vertex-pick-banner')).toBeNull()
    expect((screen.getByPlaceholderText('Setup 1') as HTMLInputElement).value)
      .toBe('Keep vertex draft')
    expect(useCamStore.getState().activeModal).toBe('new-setup')

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })
    expect(useCamStore.getState().activeModal).toBeNull()
    expect(useCamStore.getState().project.setups).toHaveLength(0)
  })

  // SETUP-GRID-UNCOLLAPSE (Operator ruling 2026-07-24: "The grid should NEVER be
  // collapsed"): the stock select, top/bottom toggle, and 3x3 corner grid
  // render immediately below the pick-in-viewport button with ZERO toggle
  // interaction. This is mutation-proof — re-adding a collapsed-by-default
  // <details>/disclosure wrapper around the grid turns it red because the
  // grid buttons would not be in the accessibility tree until expanded.
  it('renders the stock select and full 3x3 grid flat, with no collapse to expand', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    // No disclosure element of any kind wraps the grid section.
    expect(document.querySelector('details')).toBeNull()

    // Stock select is visible without any click.
    const select = document.querySelector('select.wcs-stock-select') as HTMLSelectElement
    expect(select).not.toBeNull()

    // All 9 corner-grid buttons are visible without any click.
    expect(document.querySelectorAll('.wcs-corner-btn').length).toBe(9)

    // Top/Bottom face toggle is visible without any click.
    expect(screen.getByRole('button', { name: /Top \(Z\+\)/ })).not.toBeNull()
    expect(screen.getByRole('button', { name: /Bottom \(Z0\)/ })).not.toBeNull()

    // The grid still works normally once visible.
    fireEvent.change(select, { target: { value: 'stock-b' } })
    expect(select.value).toBe('stock-b')
  })

  it('keeps the complete WCS workflow in a desktop column beside setup defaults', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    const modal = screen.getByText('New Setup').closest('.setup-modal') as HTMLElement
    const body = modal.querySelector('.modal-body') as HTMLElement
    // WO-2435: on desktop the two columns sit in the shared resizable split
    // (pane, bar, pane); the compact pick card and phone width keep the grid.
    const grid = screen.getByTestId('setup-modal-split')
    const basics = screen.getByTestId('setup-modal-basics')
    const wcs = screen.getByTestId('setup-modal-wcs')
    const create = screen.getByRole('button', { name: /Create Setup/ })

    expect(body.firstElementChild).toBe(grid)
    expect(grid.children).toHaveLength(3)
    expect(grid.children[0].firstElementChild).toBe(basics)
    expect(grid.children[2].firstElementChild).toBe(wcs)
    expect(basics.contains(screen.getByLabelText('Setup default clearance height'))).toBe(true)
    expect(wcs.contains(screen.getByTestId('stock-work-offset-select'))).toBe(true)
    expect(wcs.querySelectorAll('.wcs-corner-btn')).toHaveLength(9)

    // The fixed footer remains outside the scrolling body, while every WCS mode
    // stays in the right column and preserves the stock-corner state.
    expect(body.contains(create)).toBe(false)
    expect(create.closest('.modal-footer')).not.toBeNull()
    const stockSelect = wcs.querySelector('select.wcs-stock-select') as HTMLSelectElement
    fireEvent.change(stockSelect, { target: { value: 'stock-b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }))
    expect(wcs.querySelector('.wcs-manual')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Snap' }))
    expect(wcs.querySelector('.wcs-snap')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Gizmo' }))
    // Gizmo mode swaps to the compact one-column card, so re-read the column.
    expect(screen.getByTestId('setup-modal-wcs').querySelector('.wcs-gizmo-info')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stock Corner' }))
    expect((screen.getByTestId('setup-modal-wcs').querySelector('select.wcs-stock-select') as HTMLSelectElement).value).toBe('stock-b')

    const desktopGridRule = appCss.match(/\.setup-modal-grid\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(desktopGridRule).toMatch(/display:\s*grid/)
    expect(desktopGridRule).toMatch(/grid-template-columns:\s*minmax\(0,\s*0\.92fr\)\s*minmax\(350px,\s*1\.08fr\)/)
    expect(appCss).toMatch(/\.setup-modal\s*\{[^}]*width:\s*min\(780px,\s*calc\(100vw\s*-\s*32px\)\)/s)
    expect(appCss).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.setup-modal-grid\s*\{[^}]*grid-template-columns:\s*1fr/s)
  })

  it('does not enter a misleading pick mode when no named stock is rendered', () => {
    const viewport = (window as unknown as Record<string, unknown>).__cncViewport as Record<string, unknown>
    viewport.getStockBounds = () => null
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })
    fireEvent.click(screen.getByTestId('setup-pick-stock-corner'))

    expect(screen.getByRole('alert').textContent).toMatch(/No selected stock is rendered/)
    expect(pickCallback).toBeNull()
  })
})
