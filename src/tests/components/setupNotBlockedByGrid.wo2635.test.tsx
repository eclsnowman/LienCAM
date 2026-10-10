// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PhysicalStock, Setup } from '../../types'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
const { SetupModal } = await import('../../components/modals/SetupModal')
const { useCamStore } = await import('../../store')

const stock: PhysicalStock = {
  id: 'grid-stock', name: 'Grid stock', mode: 'explicit', fixtureOffset: 55,
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 12 },
    size: { x: 100, y: 80, z: 12 }, center: { x: 50, y: 40, z: 6 },
  },
  position: { x: 0, y: 0, z: 0 },
}

beforeEach(() => {
  memory.clear()
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => stock.bounds,
    setWCSOrigin: () => {}, exitWCSGizmoMode: () => {},
    exitStockCornerPickMode: () => {}, exitVertexPickMode: () => {},
  }
  useCamStore.setState((state) => ({
    activeModal: null, editingSetupId: null,
    project: {
      ...state.project, stocks: [stock],
      geometry: [{ stockId: stock.id }] as typeof state.project.geometry,
      nests: [], setups: [], activeSetupId: null, activeOperationId: null,
    },
    projectHistory: [], projectFuture: [], sketchHistory: [], sketchFuture: [],
  }))
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

function openNew() {
  render(<SetupModal />)
  act(() => { useCamStore.getState().openModal('new-setup') })
}
function selectPlane(mode: string) {
  fireEvent.change(screen.getByTestId('setup-support-plane-mode'), { target: { value: mode } })
}
function expectFallback() {
  const note = screen.getByTestId('setup-support-plane-readout').textContent ?? ''
  expect(note).toBe('Grid: machine table (plane unavailable).')
  expect(note).not.toContain('at Z')
  expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
}
function saveButton() {
  return screen.getByRole('button', { name: /(?:Create|Save) Setup/ }) as HTMLButtonElement
}

describe('WO-2635 planning grid never blocks a setup', () => {
  it.each(['spoilboard', 'vise_bed', 'fixed_jaw_shelf', 'soft_jaw_step'] as const)(
    'creates and preserves an unresolved %s plane without changing WCS or stock', (mode) => {
      openNew()
      selectPlane(mode)
      expect(saveButton().disabled).toBe(false)
      expectFallback()
      const stocksBefore = structuredClone(useCamStore.getState().project.stocks)
      fireEvent.click(saveButton())
      const state = useCamStore.getState()
      expect(state.activeModal).toBeNull()
      expect(state.project.setups).toHaveLength(1)
      expect(state.project.setups[0].supportPlane).toEqual({ mode, offset: 0 })
      expect(state.project.setups[0].wcs.origin).toEqual({ x: 0, y: 0, z: 12 })
      expect(state.project.setups[0].wcs.label).toBe('G55')
      expect(state.project.stocks).toEqual(stocksBefore)
    },
  )

  it.each(['Manual', 'Snap'])(
    'creates with an unresolved stock-bottom grid in %s origin mode', (originMode) => {
      openNew()
      fireEvent.click(screen.getByRole('button', { name: originMode }))
      selectPlane('stock_bottom')
      expect(saveButton().disabled).toBe(false)
      expectFallback()
      fireEvent.click(saveButton())
      expect(useCamStore.getState().project.setups[0].supportPlane).toEqual({ mode: 'stock_bottom', offset: 0 })
    },
  )

  it('saves an existing unresolved setup without changing its origin or operations', () => {
    openNew()
    fireEvent.click(saveButton())
    const existing = structuredClone(useCamStore.getState().project.setups[0]) as Setup
    act(() => {
      useCamStore.getState().updateSetup(existing.id, { supportPlane: { mode: 'vise_bed', offset: 3 } })
      useCamStore.setState({ editingSetupId: existing.id })
      useCamStore.getState().openModal('edit-setup')
    })
    expect(saveButton().disabled).toBe(false)
    expectFallback()
    fireEvent.click(saveButton())
    const saved = useCamStore.getState().project.setups[0]
    expect(saved.supportPlane).toEqual({ mode: 'vise_bed', offset: 3 })
    expect(saved.wcs).toEqual(existing.wcs)
    expect(saved.operations).toEqual(existing.operations)
  })

  it('submits through the deferred Enter route with an unresolved grid', async () => {
    openNew()
    selectPlane('soft_jaw_step')
    fireEvent.keyDown(screen.getByTestId('setup-modal-panel'), { key: 'Enter' })
    await waitFor(() => expect(useCamStore.getState().project.setups).toHaveLength(1))
    expect(useCamStore.getState().project.setups[0].supportPlane?.mode).toBe('soft_jaw_step')
  })

  it('resolves after adding the missing layer and keeps invalid layer validation', () => {
    openNew()
    selectPlane('spoilboard')
    expectFallback()
    fireEvent.click(screen.getByTestId('setup-add-fixture-layer'))
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toContain('Spoilboard top at Z')
    expect(saveButton().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Fixture layer 1 name'), { target: { value: '' } })
    expect(screen.getByTestId('setup-fixture-stack-error').textContent).toContain('needs a name')
    expect(saveButton().disabled).toBe(true)
  })

  it('still blocks a bore origin until an actual circular feature is picked', () => {
    openNew()
    selectPlane('vise_bed')
    fireEvent.click(screen.getByTestId('setup-origin-mode-bore'))
    expect(saveButton().disabled).toBe(true)
    expect(useCamStore.getState().project.setups).toHaveLength(0)
  })
})
