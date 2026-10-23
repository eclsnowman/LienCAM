// @vitest-environment jsdom
//
// WO-2992 + WO-3079 (owner release review 2026-10-23): Control shows the active setup's notes
// behind a "Setup notes" button that opens a floating panel (nothing on the screen
// moves), readable and editable right there. The old always-on strip is gone.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const notesOf = (id: string) => useCamStore.getState().project.setups.find((setup) => setup.id === id)?.notes
const openPanel = () => fireEvent.click(screen.getByTestId('control-setup-notes-button'))

describe('setup notes on Control: button + floating panel', () => {
  it('shows no button when the project has no setup at all', () => {
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.setState((s) => ({ project: { ...s.project, setups: [], activeSetupId: null } }))
    })
    render(<ProgramPanel />)
    expect(screen.queryByTestId('control-setup-notes-button')).toBeNull()
  })

  it('takes no room until asked: closed by default, a dot only when notes exist', () => {
    seedSetups('Clamp on the left jaw', '')
    render(<ProgramPanel />)
    expect(screen.getByTestId('control-setup-notes-button')).toBeTruthy()
    expect(screen.getByTestId('control-setup-notes-dot')).toBeTruthy()
    expect(screen.queryByTestId('control-setup-notes')).toBeNull()
    act(() => { useCamStore.getState().setActiveSetup('b') })
    expect(screen.queryByTestId('control-setup-notes-dot')).toBeNull()
  })

  it('opens the active setup notes, read-only until Edit, and closes with Escape', () => {
    seedSetups('Clamp on the left jaw', '')
    render(<ProgramPanel />)
    openPanel()
    const panel = screen.getByTestId('control-setup-notes')
    expect(screen.getByTestId('control-setup-notes-text').textContent).toBe('Clamp on the left jaw')
    expect(panel.querySelector('textarea, input')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('control-setup-notes')).toBeNull()
  })

  it('edits and saves the notes right in the panel', () => {
    seedSetups('Clamp on the left jaw', '')
    render(<ProgramPanel />)
    openPanel()
    fireEvent.click(screen.getByTestId('control-setup-notes-edit-button'))
    const box = screen.getByTestId('control-setup-notes-edit') as HTMLTextAreaElement
    expect(box.value).toBe('Clamp on the left jaw')
    fireEvent.change(box, { target: { value: 'Clamp on the left jaw\nZero on the top face' } })
    fireEvent.click(screen.getByTestId('control-setup-notes-save'))
    expect(notesOf('a')).toBe('Clamp on the left jaw\nZero on the top face')
    expect(screen.getByTestId('control-setup-notes-text').textContent).toBe('Clamp on the left jaw\nZero on the top face')
  })

  it('adds notes to a setup that has none', () => {
    seedSetups('', '')
    render(<ProgramPanel />)
    openPanel()
    expect(screen.queryByTestId('control-setup-notes-text')).toBeNull()
    fireEvent.click(screen.getByTestId('control-setup-notes-edit-button'))
    fireEvent.change(screen.getByTestId('control-setup-notes-edit'), { target: { value: 'Soft jaws' } })
    fireEvent.click(screen.getByTestId('control-setup-notes-save'))
    expect(notesOf('a')).toBe('Soft jaws')
    expect(notesOf('b')).toBe('')
  })

  it('switching the active setup switches the notes', () => {
    seedSetups('first notes', 'second notes')
    render(<ProgramPanel />)
    openPanel()
    expect(screen.getByTestId('control-setup-notes-text').textContent).toBe('first notes')
    act(() => { useCamStore.getState().setActiveSetup('b') })
    expect(screen.getByTestId('control-setup-notes-text').textContent).toBe('second notes')
    act(() => { useCamStore.getState().setActiveSetup('a') })
    expect(screen.getByTestId('control-setup-notes-text').textContent).toBe('first notes')
  })
})
