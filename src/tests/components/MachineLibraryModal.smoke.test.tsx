// @vitest-environment jsdom
//
// React-render SMOKE test for MachineLibraryModal after adding the
// "Set as Default" affordance. tsc + the pure vitest suite do NOT catch
// render-time defects (hooks-order bugs, missing selectors); this mounts the
// modal open and asserts the Set-as-Default button renders so a later edit fails
// loudly here. Mirrors SettingsModal.smoke.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { MachineConfig } from '../../types'
import { createDefaultControllerDefinition, machineTravel } from '../../types'
import { consumeMachineDefinitionSection } from '../../components/machine/definition/machineDefinitionSectionRequest'

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

const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { useCamStore } = await import('../../store')
const realUpdateMachineInLibrary = useCamStore.getState().updateMachineInLibrary

function mk(id: string, name = id): MachineConfig {
  return {
    id, name, type: 'gantry_router', controller: 'grbl',
    travel: { x: 100, y: 100, z: 50 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }
}

// WO-1698, re-pinned for WO-1705 fix round 3 (Operator, binding: "edit either
// location... one location for data"): a machine WITH a definition still
// edits Travel right here - typing writes the axis soft limits instead of
// the standalone field, never a disabled read-out or a link elsewhere.
function mkWithDefinition(id: string, name = id): MachineConfig {
  return { ...mk(id, name), controllerDefinition: createDefaultControllerDefinition() }
}

afterEach(() => {
  cleanup()
  useCamStore.setState({ updateMachineInLibrary: realUpdateMachineInLibrary })
})

beforeEach(() => {
  act(() => {
    useCamStore.setState((s) => ({
      machineLibrary: [mk('operator', 'Operator Machine')],
      updateMachineInLibrary: realUpdateMachineInLibrary,
      appSettings: { ...s.appSettings, defaultMachineId: null },
    }))
    useCamStore.getState().closeModal()
  })
})

describe('MachineLibraryModal render smoke', () => {
  it('mounts closed without crashing', () => {
    render(<MachineLibraryModal />)
    expect(screen.queryByText('Machine Library')).toBeNull()
  })

  it('opens and renders the Set as Default affordance', () => {
    render(<MachineLibraryModal />)
    expect(screen.queryByText('Machine Library')).toBeNull()

    act(() => {
      useCamStore.getState().openModal('machine-config')
    })

    expect(screen.getByText('Machine Library')).not.toBeNull()
    // The editor auto-selects the lone machine, so the footer Set-as-Default
    // button is present (no default set yet -> "Set as Default").
    expect(screen.getByText('Set as Default')).not.toBeNull()

    act(() => {
      useCamStore.getState().closeModal()
    })
    expect(screen.queryByText('Machine Library')).toBeNull()
  })

  it('commits a numeric draft into the same Enter save action', async () => {
    const updateMachineInLibrary = vi.fn()
    act(() => { useCamStore.setState({ updateMachineInLibrary }) })
    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    fireEvent.click(screen.getByTestId('disclosure-machine-travel'))
    const travelSection = screen.getByTestId('disclosure-machine-travel').closest('.disclosure-section')
    const xTravel = travelSection?.querySelector('input') as HTMLInputElement
    fireEvent.focus(xTravel)
    fireEvent.change(xTravel, { target: { value: '275' } })
    fireEvent.keyDown(xTravel, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(updateMachineInLibrary).toHaveBeenCalledTimes(1))
    expect(updateMachineInLibrary.mock.calls[0][0]).toBe('operator')
    expect(updateMachineInLibrary.mock.calls[0][1].travel.x).toBe(275)
  })

  // WO-1693 (ADR-0049): this disclosure lost its editor - `MachineProbeDefaults`
  // now has exactly one editor, Control > Machine > Definition > Probing - and
  // became a read-out of the same record instead. Repointed off the retired
  // "stores probe motion defaults in the machine definition" (it edited an
  // `<input>` here that no longer exists by design).
  it('shows probe motion defaults as a read-out, with no editor of its own', () => {
    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    fireEvent.click(screen.getByTestId('disclosure-machine-probing-defaults'))
    const disclosure = screen.getByTestId('disclosure-machine-probing-defaults')
      .closest('.disclosure-section') as HTMLElement

    expect(disclosure.querySelectorAll('input, select, textarea').length).toBe(0)
    expect(screen.getByTestId('machine-probing-readout-slowFeed').textContent).toBe('50')
    expect(screen.getByTestId('machine-probing-readout-note').textContent)
      .toMatch(/Control.*Machine.*Definition.*Probing/)
  })

  it('Escape follows the existing save-then-close action', async () => {
    const updateMachineInLibrary = vi.fn()
    act(() => { useCamStore.setState({ updateMachineInLibrary }) })
    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    const nameRow = screen.getByText('Name').closest('.mform-row')
    const name = nameRow?.querySelector('input') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Keyboard Machine' } })
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })

    await waitFor(() => expect(useCamStore.getState().activeModal).toBeNull())
    expect(updateMachineInLibrary).toHaveBeenCalledTimes(1)
    expect(updateMachineInLibrary.mock.calls[0][1].name).toBe('Keyboard Machine')
  })

  it('leaves Enter inert when no draft can be saved', async () => {
    const updateMachineInLibrary = vi.fn()
    act(() => {
      useCamStore.setState({ machineLibrary: [], updateMachineInLibrary })
    })
    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    const ordinaryInput = document.createElement('input')
    ordinaryInput.type = 'text'
    screen.getByTestId('machine-modal-panel').append(ordinaryInput)
    fireEvent.keyDown(ordinaryInput, { key: 'Enter', code: 'Enter' })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(updateMachineInLibrary).not.toHaveBeenCalled()
    expect(useCamStore.getState().activeModal).toBe('machine-config')
  })

  it('does not save from multiline and disabled children on Enter', () => {
    const updateMachineInLibrary = vi.fn()
    act(() => { useCamStore.setState({ updateMachineInLibrary }) })
    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    const panel = screen.getByTestId('machine-modal-panel')
    const textarea = document.createElement('textarea')
    const disabledInput = document.createElement('input')
    disabledInput.type = 'text'
    disabledInput.disabled = true
    panel.append(textarea, disabledInput)

    for (const target of [textarea, disabledInput]) {
      fireEvent.keyDown(target, { key: 'Enter', code: 'Enter' })
    }
    expect(updateMachineInLibrary).not.toHaveBeenCalled()
    expect(useCamStore.getState().activeModal).toBe('machine-config')
  })

  it('routes unconsumed Escape from a multiline child through save-then-close', async () => {
    const updateMachineInLibrary = vi.fn()
    act(() => { useCamStore.setState({ updateMachineInLibrary }) })
    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    const nameRow = screen.getByText('Name').closest('.mform-row')
    const name = nameRow?.querySelector('input') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Multiline Escape Machine' } })
    const textarea = document.createElement('textarea')
    screen.getByTestId('machine-modal-panel').append(textarea)
    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' })

    await waitFor(() => expect(useCamStore.getState().activeModal).toBeNull())
    expect(updateMachineInLibrary).toHaveBeenCalledTimes(1)
    expect(updateMachineInLibrary.mock.calls[0][1].name).toBe('Multiline Escape Machine')
  })

  // WO-1698 fix round 3 (Operator, binding overrule 2026-09-19 ~11:4x CDT: "No,
  // you do not tell someone to edit somewhere else. Edit either location.
  // Saves to same data... One location for data, two lenses and touch
  // points."): a machine with a definition keeps Travel as a plain, enabled
  // editor right here - no disabled input, no hint, no link elsewhere.
  // Typing writes the axis soft limits (the same fact the Machine area's own
  // soft-limit edit writes) instead of a second copy in the flat field.
  it('a defined machine\'s Travel field stays a live editor here and writes the axis soft limits, not the flat field', () => {
    act(() => {
      useCamStore.setState({ machineLibrary: [mkWithDefinition('wo1698-defined', 'WO-1698 Router')] })
    })
    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    fireEvent.click(screen.getByTestId('disclosure-machine-travel'))
    expect(screen.queryByTestId('machine-form-travel-hint')).toBeNull()
    expect(screen.queryByTestId('machine-form-travel-open-machine-area')).toBeNull()
    const travelInputs = screen.getByTestId('disclosure-machine-travel')
      .closest('.disclosure-section')!.querySelectorAll('input')
    const xInput = travelInputs[0] as HTMLInputElement
    expect(xInput.disabled).toBe(false)

    // Editing here never navigates - it is the one editor, not a door
    // elsewhere.
    expect(useCamStore.getState().workspace).not.toBe('control')
    act(() => {
      fireEvent.change(xInput, { target: { value: '250' } })
      fireEvent.keyDown(xInput, { key: 'Enter', code: 'Enter' })
    })
    expect(useCamStore.getState().workspace).not.toBe('control')
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    const saved = useCamStore.getState().machineLibrary.find((m) => m.id === 'wo1698-defined')!
    expect(machineTravel(saved).x).toBe(250)
    // The flat legacy field is untouched - one record, not two.
    expect(saved.travel).toEqual({ x: 100, y: 100, z: 50 })
    expect(consumeMachineDefinitionSection('wo1698-defined')).toBeNull()
  })
})
