// @vitest-environment jsdom
//
// React-render SMOKE test for the new MachineChoiceModal (the forced load-time
// machine picker). tsc + the pure vitest suite do NOT catch render-time defects
// (hooks-order bugs, missing selectors); this mounts the modal open and asserts
// it renders the library + Default badge so a later edit fails loudly here.
// Mirrors SettingsModal.smoke.test.tsx (localStorage shim + closed->open).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { MachineConfig } from '../../types'

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

const { MachineChoiceModal } = await import('../../components/modals/MachineChoiceModal')
const { useCamStore } = await import('../../store')

function mk(id: string, name = id): MachineConfig {
  return {
    id, name, type: 'gantry_router', controller: 'grbl',
    travel: { x: 100, y: 100, z: 50 }, rapidRate: 5000,
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }
}

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.setState((s) => ({
      machineChoiceRequired: false,
      machineLibrary: [mk('operator', 'Operator Machine'), mk('other', 'Other Machine')],
      appSettings: { ...s.appSettings, defaultMachineId: 'operator' },
    }))
  })
})

describe('MachineChoiceModal render smoke', () => {
  it('renders nothing while the choice flag is false', () => {
    render(<MachineChoiceModal />)
    expect(screen.queryByText('Choose a machine for this project')).toBeNull()
  })

  it('opens when machineChoiceRequired flips true and lists machines + default badge', () => {
    render(<MachineChoiceModal />)
    expect(screen.queryByText('Choose a machine for this project')).toBeNull()

    act(() => {
      useCamStore.getState().setMachineChoiceRequired(true)
    })

    expect(screen.getByText('Choose a machine for this project')).not.toBeNull()
    expect(screen.getByText('Operator Machine')).not.toBeNull()
    expect(screen.getByText('Other Machine')).not.toBeNull()
    // The pre-selected default is badged.
    expect(screen.getByText('Default')).not.toBeNull()
    expect(screen.getByText('Use this machine')).not.toBeNull()

    act(() => {
      useCamStore.getState().setMachineChoiceRequired(false)
    })
    expect(screen.queryByText('Choose a machine for this project')).toBeNull()
  })

  it('cannot trap: with only the generic placeholder, nothing is pickable and confirm is disabled', () => {
    // Regression guard for the first-start trap. Even if the flag is forced true
    // with a library of ONLY the generic 'default-machine', the picker offers no
    // machine (it is filtered out) and the confirm button stays disabled - so the
    // user can never bind the generic machine and re-trip the prompt.
    act(() => {
      useCamStore.setState((s) => ({
        machineChoiceRequired: false,
        machineLibrary: [mk('default-machine', 'My CNC Router')],
        appSettings: { ...s.appSettings, defaultMachineId: null },
      }))
    })
    render(<MachineChoiceModal />)
    act(() => {
      useCamStore.getState().setMachineChoiceRequired(true)
    })

    expect(screen.getByText('Choose a machine for this project')).not.toBeNull()
    expect(screen.queryByText('My CNC Router')).toBeNull()            // generic not offered
    expect(screen.getByText(/No machines in your library/)).not.toBeNull()
    const confirm = screen.getByText('Use this machine').closest('button') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })
})
