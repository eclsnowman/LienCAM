// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ControllerType, MachineConfig } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { controllerSurface } = await import('../../lib/machine/controllerSurface')
const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { PostProcessModal } = await import('../../components/modals/PostProcessModal')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

const machine: MachineConfig = {
  id: 'wo1113-machine',
  name: 'WO-1113 machine',
  type: 'gantry_router',
  controller: 'uccnc',
  travel: { x: 800, y: 600, z: 100 },
  rapidRate: 6000,
  maxSpindleRpm: 24000,
  minSpindleRpm: 8000,
  spindleDirection: 'cw',
  toolChanger: 'manual',
  coolant: false,
  notes: '',
}

function declare(controller: ControllerType): void {
  const changed = { ...machine, controller }
  act(() => {
    const state = useCamStore.getState()
    useCamStore.setState({
      machineLibrary: [changed],
      project: { ...state.project, machine: changed },
      control: { ...state.control, activeMachineId: changed.id },
    })
  })
}

function open(id: string): void {
  act(() => { useCamStore.getState().openModal(id) })
}

function close(): void {
  act(() => { useCamStore.getState().closeModal() })
}

beforeEach(() => {
  mem.clear()
  declare('uccnc')
  close()
  act(() => {
    useMachineControl.setState({
      connectionPhase: 'disconnected',
      connectionKind: 'serial',
      settings: { 20: '1', 22: '1', 30: '24000' },
      bridgeHello: null,
    })
  })
})

afterEach(() => {
  cleanup()
  close()
})

describe('WO-1113 declared controller surface', () => {
  it('maps every controller-owned fact from one typed resolver', () => {
    expect(controllerSurface({ controller: 'uccnc' })).toMatchObject({
      uccncProfile: true, bridgeSettings: true, grblSettings: false,
      macros: 'uccnc', probeVerbs: 'typed', postFlavour: 'uccnc',
      connectionKinds: ['bridge', 'simulator'],
    })
    expect(controllerSurface({ controller: 'grbl' })).toMatchObject({
      uccncProfile: false, bridgeSettings: false, grblSettings: true,
      macros: 'grbl', probeVerbs: 'text', postFlavour: 'grbl',
      connectionKinds: ['serial', 'simulator'],
    })
  })

  it('changing only the declaration flips every audited surface offline', async () => {
    render(<><MachineLibraryModal /><SettingsModal /><PostProcessModal /></>)

    open('machine-config')
    expect(await screen.findByTestId('disclosure-machine-uccnc-profile')).not.toBeNull()
    expect(screen.getByTestId('machine-library-import').getAttribute('data-tooltip'))
      .toBe('Import JSON or UCCNC .pro')
    expect(screen.getByTestId('uccnc-profile-local-input').getAttribute('accept')).toBe('.json,.pro')
    close()

    open('settings')
    expect(screen.queryByText('GRBL Controller Settings')).toBeNull()
    expect(screen.queryByTestId('settings-grbl-table')).toBeNull()
    close()

    open('post-process')
    await waitFor(() => expect(screen.getByTestId('post-definition-select').textContent).toContain('UCCNC'))
    fireEvent.click(screen.getByTestId('post-definition-select'))
    expect(screen.queryByTestId('post-definition-select-option-grbl')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    close()

    open('machine-config')
    const controllerSelect = screen.getByTestId('machine-controller-select') as HTMLSelectElement
    fireEvent.change(controllerSelect, { target: { value: 'grbl' } })
    expect(controllerSelect.value).toBe('grbl')
    await waitFor(() => expect(screen.queryByTestId('disclosure-machine-uccnc-profile')).toBeNull())
    expect(screen.getByTestId('machine-library-import').getAttribute('data-tooltip')).toBe('Import JSON')
    expect(screen.getByTestId('machine-library-import-input').getAttribute('accept')).toBe('.json')
    close()

    // Runtime state is deliberately untouched: disconnected plus stale serial.
    // The controller declaration is the only changed persisted machine fact.
    declare('grbl')

    open('settings')
    expect(await screen.findByText('GRBL Controller Settings')).not.toBeNull()
    expect(screen.getByTestId('settings-grbl-table')).not.toBeNull()
    close()

    open('post-process')
    await waitFor(() => expect(screen.getByTestId('post-definition-select').textContent).toContain('GRBL'))
    fireEvent.click(screen.getByTestId('post-definition-select'))
    expect(screen.queryByTestId('post-definition-select-option-uccnc')).not.toBeNull()
  })
})
