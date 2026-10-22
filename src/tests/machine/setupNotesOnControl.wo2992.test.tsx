// @vitest-environment jsdom
//
// WO-2992: Control's program card shows the active setup's notes read-only
// when they are not empty, and nothing when they are.

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  } as unknown as typeof import('../../lib/viewport/CNCViewport').CNCViewport,
}))

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useCamStore } = await import('../../store')

type Setup = import('../../types').Setup

afterEach(cleanup)

const setupNamed = (id: string, notes: string) => ({
  id, name: `Setup ${id}`,
  wcs: {
    id: `w-${id}`, label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  },
  operations: [],
  notes,
}) as unknown as Setup

function seedSetups(notesA: string, notesB: string) {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({
      project: { ...s.project, setups: [setupNamed('a', notesA), setupNamed('b', notesB)], activeSetupId: 'a', activeOperationId: null },
    }))
  })
}

describe('WO-2992 setup notes on Control', () => {
  it('shows no block when the active setup has no notes', () => {
    seedSetups('', 'other')
    render(<ProgramPanel />)
    expect(screen.queryByTestId('control-setup-notes')).toBeNull()
  })

  it('shows no block when the project has no setup at all', () => {
    act(() => { useCamStore.getState().newProject() })
    render(<ProgramPanel />)
    expect(screen.queryByTestId('control-setup-notes')).toBeNull()
  })

  it('shows the active setup notes, read-only', () => {
    seedSetups('Clamp on the left jaw', '')
    render(<ProgramPanel />)
    const block = screen.getByTestId('control-setup-notes')
    expect(block.textContent).toContain('Clamp on the left jaw')
    expect(block.querySelector('textarea, input')).toBeNull()
  })

  it('switching the active setup switches the notes', () => {
    seedSetups('first notes', 'second notes')
    render(<ProgramPanel />)
    expect(screen.getByTestId('control-setup-notes').textContent).toContain('first notes')
    act(() => { useCamStore.getState().setActiveSetup('b') })
    expect(screen.getByTestId('control-setup-notes').textContent).toContain('second notes')
    act(() => { useCamStore.getState().setActiveSetup('a') })
    expect(screen.getByTestId('control-setup-notes').textContent).toContain('first notes')
  })
})
