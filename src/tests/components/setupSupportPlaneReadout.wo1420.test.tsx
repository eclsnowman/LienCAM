// @vitest-environment jsdom
//
// WO-1420: an unresolved support plane must not print a numeric grid elevation.
// The resolver returns resolved:false with a fallback baseZ of 0 when a mode has
// no matching fixture layer; the readout used to render that fallback as if it
// were a real elevation. WO-2635 keeps that honesty while reporting the
// machine-table fallback and allowing the unresolved reference to be saved.

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

function readoutText(): string {
  return screen.getByTestId('setup-support-plane-readout').textContent ?? ''
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

describe('WO-1420 unresolvable support plane readout', () => {
  it('replaces the numeric Z and WCS offset when the plane has no matching layer', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    // Baseline: the default machine-table plane resolves and prints numbers.
    expect(readoutText()).toContain('at Z')

    fireEvent.change(screen.getByTestId('setup-support-plane-mode'), { target: { value: 'fixed_jaw_shelf' } })

    const readout = readoutText()
    expect(readout).toBe('Grid: machine table (plane unavailable).')
    // No fake numeric elevation or WCS offset leaks through.
    expect(readout).not.toContain('at Z')
    expect(readout).not.toMatch(/G\d+ Z[+-]/)
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
    expect((screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /Create Setup/ }))
    const saved = useCamStore.getState().project.setups[0]
    expect(saved.supportPlane).toEqual({ mode: 'fixed_jaw_shelf', offset: 0 })
    act(() => {
      useCamStore.setState({ editingSetupId: saved.id })
      useCamStore.getState().openModal('edit-setup')
    })
    expect((screen.getByTestId('setup-support-plane-mode') as HTMLSelectElement).value).toBe('fixed_jaw_shelf')
    expect(readoutText()).toBe('Grid: machine table (plane unavailable).')
    expect((screen.getByRole('button', { name: /Save Setup/ }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId('setup-add-fixture-layer'))
    fireEvent.change(screen.getByLabelText('Fixture layer 1 type'), { target: { value: 'fixed_jaw' } })
    commitNumber('Fixture layer 1 height', '19')
    expect((screen.getByTestId('setup-support-plane-mode') as HTMLSelectElement).value).toBe('fixed_jaw_shelf')
    expect(readoutText()).toContain('Fixed-jaw shelf at Z 19')
    expect(readoutText()).toContain('G55 Z+7')
    fireEvent.click(screen.getByRole('button', { name: /Save Setup/ }))
    expect(useCamStore.getState().project.setups[0].supportPlane).toEqual({ mode: 'fixed_jaw_shelf', offset: 0 })
    expect(useCamStore.getState().project.setups[0].fixtureStack?.[0].height).toBe(19)
  })

  it('restores the real elevation when switching from an unresolved mode to a valid one', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    fireEvent.change(screen.getByTestId('setup-support-plane-mode'), { target: { value: 'vise_bed' } })
    expect(readoutText()).toBe('Grid: machine table (plane unavailable).')
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
    expect((screen.getByRole('button', { name: /Create Setup/ }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(screen.getByTestId('setup-support-plane-mode'), { target: { value: 'custom' } })
    commitNumber('Custom support plane Z', '-6')
    commitNumber('Support plane signed offset', '1.5')

    expect(readoutText()).toContain('Custom plane at Z -4.5')
    expect(readoutText()).toContain('G55 Z-16.5')
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
  })

  it('leaves a resolved readout byte-identical to the pre-fix output', () => {
    render(<SetupModal />)
    act(() => { useCamStore.getState().openModal('new-setup') })

    // Machine table with the default zero offset is a resolved plane.
    expect(readoutText()).toContain('Machine table at Z')
    expect(readoutText()).toMatch(/G\d+ Z[+-]/)
    expect(screen.queryByTestId('setup-fixture-stack-error')).toBeNull()
  })
})
