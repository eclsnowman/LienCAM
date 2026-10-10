// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BoundingBox, PhysicalStock, Vec3 } from '../../types'

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

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    },
  }
}

const viseStock: PhysicalStock = {
  id: 'vise-stock',
  name: 'Vise stock',
  mode: 'explicit',
  fixtureOffset: 55,
  bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 80, z: 12 }),
  position: { x: 0, y: 0, z: 0 },
}

function commitNumber(label: string, value: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  memory.clear()
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 12 } }),
    setWCSOrigin: () => {},
    exitWCSGizmoMode: () => {},
    exitStockCornerPickMode: () => {},
    exitVertexPickMode: () => {},
  }
  useCamStore.setState((state) => ({
    activeModal: null,
    editingSetupId: null,
    project: {
      ...state.project,
      stocks: [viseStock],
      geometry: [{ stockId: viseStock.id }] as typeof state.project.geometry,
      nests: [],
      setups: [],
      activeSetupId: null,
      activeOperationId: null,
    },
    projectHistory: [],
    sketchHistory: [],
    projectFuture: [],
    sketchFuture: [],
  }))
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-227 SetupModal fixture stack', () => {
  it('authors and saves a spoilboard + vise + soft-jaw G55 support plane', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    expect((screen.getByTestId('stock-work-offset-select') as HTMLSelectElement).value).toBe('55')
    for (let index = 0; index < 3; index++) fireEvent.click(screen.getByTestId('setup-add-fixture-layer'))

    const types = [
      screen.getByLabelText('Fixture layer 1 type'),
      screen.getByLabelText('Fixture layer 2 type'),
      screen.getByLabelText('Fixture layer 3 type'),
    ]
    fireEvent.change(types[0], { target: { value: 'spoilboard' } })
    fireEvent.change(types[1], { target: { value: 'vise' } })
    fireEvent.change(types[2], { target: { value: 'soft_jaw' } })
    fireEvent.change(screen.getByLabelText('Fixture layer 1 name'), { target: { value: 'MDF spoilboard' } })
    fireEvent.change(screen.getByLabelText('Fixture layer 2 name'), { target: { value: 'Kurt vise' } })
    fireEvent.change(screen.getByLabelText('Fixture layer 3 name'), { target: { value: 'Op 2 soft jaws' } })
    commitNumber('Fixture layer 1 height', '19')
    commitNumber('Fixture layer 2 height', '75')
    commitNumber('Fixture layer 3 height', '20')
    fireEvent.change(screen.getByTestId('setup-support-plane-mode'), { target: { value: 'soft_jaw_step' } })
    commitNumber('Support plane signed offset', '-2')

    const readout = screen.getByTestId('setup-support-plane-readout').textContent ?? ''
    expect(readout).toContain('Soft-jaw step at Z 112')
    expect(readout).toContain('G55 Z+100')

    fireEvent.click(screen.getByLabelText('Show fixture layer 2'))
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toContain('Z 112')
    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))

    const saved = useCamStore.getState().project.setups[0]
    expect(saved.wcs.label).toBe('G55')
    expect(saved.wcs.origin).toEqual({ x: 0, y: 0, z: 12 })
    expect(saved.fixtureStack).toEqual([
      { id: expect.any(String), name: 'MDF spoilboard', type: 'spoilboard', height: 19, visible: true },
      { id: expect.any(String), name: 'Kurt vise', type: 'vise', height: 75, visible: false },
      { id: expect.any(String), name: 'Op 2 soft jaws', type: 'soft_jaw', height: 20, visible: true },
    ])
    expect(saved.supportPlane).toEqual({ mode: 'soft_jaw_step', offset: -2 })
  })

  it('resolves stock-bottom from the bound stock rather than scene-wide viewport bounds', () => {
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        stocks: [{ ...viseStock, position: { x: 0, y: 0, z: 7 } }],
      },
    }))
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    commitNumber('Support plane signed offset', '1.5')
    fireEvent.change(screen.getByTestId('setup-support-plane-mode'), { target: { value: 'stock_bottom' } })

    // The viewport mock reports scene-wide min Z0; the selected stock's
    // authoritative world bottom is Z7, matching Viewport's resolver path.
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toContain('Stock bottom at Z 8.5')
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
  })

  it('shows honest unresolved states, then supports custom and stock-bottom modes', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    fireEvent.change(screen.getByTestId('setup-support-plane-mode'), { target: { value: 'vise_bed' } })
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toBe('Grid: machine table (plane unavailable).')
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
    expect((screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))
    const saved = useCamStore.getState().project.setups[0]
    expect(saved.supportPlane).toEqual({ mode: 'vise_bed', offset: 0 })
    act(() => {
      useCamStore.setState({ editingSetupId: saved.id })
      useCamStore.getState().openModal('edit-setup')
    })
    expect((screen.getByTestId('setup-support-plane-mode') as HTMLSelectElement).value).toBe('vise_bed')
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toBe('Grid: machine table (plane unavailable).')
    expect((screen.getByRole('button', { name: /Save Setup/ }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId('setup-add-fixture-layer'))
    fireEvent.change(screen.getByLabelText('Fixture layer 1 type'), { target: { value: 'vise' } })
    commitNumber('Fixture layer 1 height', '75')
    expect((screen.getByTestId('setup-support-plane-mode') as HTMLSelectElement).value).toBe('vise_bed')
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toContain('Vise bed at Z 75')
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toContain('G55 Z+63')

    fireEvent.change(screen.getByTestId('setup-support-plane-mode'), { target: { value: 'custom' } })
    commitNumber('Custom support plane Z', '-6')
    commitNumber('Support plane signed offset', '1.5')
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toContain('Custom plane at Z -4.5')

    fireEvent.change(screen.getByTestId('setup-support-plane-mode'), { target: { value: 'stock_bottom' } })
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toContain('Stock bottom at Z 1.5')
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Manual' }))
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toBe('Grid: machine table (plane unavailable).')
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
    expect((screen.getByRole('button', { name: /Save Setup/ }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Snap' }))
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toBe('Grid: machine table (plane unavailable).')
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
    expect((screen.getByRole('button', { name: /Save Setup/ }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Stock Corner' }))
    expect(screen.getByTestId('setup-support-plane-readout').textContent).toContain('Stock bottom at Z 1.5')
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Save Setup/ }))
    expect(useCamStore.getState().project.setups[0].supportPlane).toEqual({ mode: 'stock_bottom', offset: 1.5 })
  })
})
