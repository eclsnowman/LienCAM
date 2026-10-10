// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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


import { makeStock, makeWcs } from '../post/helpers'
const { DesignTree } = await import('../../components/panels/DesignTree')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
beforeEach(() => act(() => {
  useCamStore.getState().newProject()
  useCamStore.getState().addSetup({ id: 'setup-2703', name: 'Setup target', wcs: makeWcs(), stock: makeStock(), operations: [], notes: '' })
}))
afterEach(cleanup)
describe('WO-2703 setup activation after stock selection', () => {
  it.each(['fixed', 'auto'] as const)('shows setup Properties after clicking %s stock then setup', (kind) => {
    act(() => {
      if (kind === 'fixed') useCamStore.getState().addFixedStock({ id: 'stock-2703', name: 'Selected block', width: 50, height: 40, depth: 20, position: { x: 0, y: 0, z: 0 } })
      else useCamStore.getState().addAutoStock({ id: 'stock-2703', name: 'Selected auto', autoOffsetXY: 2, autoOffsetZTop: 2, autoOffsetZBottom: 0 })
    })
    render(<><DesignTree /><PropertiesPanel /></>)
    if (kind === 'fixed') fireEvent.click(screen.getByTestId('fixed-stock-gizmo-btn'))
    else fireEvent.click(screen.getByText('Selected auto'))
    expect(useCamStore.getState().viewer.selectedStockId).toBe('stock-2703')
    expect(screen.queryByTestId('setup-name-input')).toBeNull()
    fireEvent.click(screen.getByText('Setup target'))
    expect((screen.getByTestId('setup-name-input') as HTMLInputElement).value).toBe('Setup target')
    expect(screen.getByText('Holding method')).toBeTruthy()
    expect(screen.getByText('WCS')).toBeTruthy()
    expect(useCamStore.getState().viewer.selectedStockId).toBeNull()
  })
})
