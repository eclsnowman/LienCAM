// Store tests for the default-machine feature:
//   - newProject binds the resolvable default profile (copy), else generic fallback
//   - setDefaultMachineId persists to appSettings
//   - removeMachineFromLibrary of the current default clears defaultMachineId
//
// Drives the REAL store actions (the same ones the Machine Library modal and the
// New button call). The store is a process singleton, so each test seeds the
// slices it touches up front.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type { MachineConfig } from '../../types'

const GENERIC_ID = 'default-machine'

function mk(id: string, name = id): MachineConfig {
  return {
    id,
    name,
    type: 'gantry_router',
    controller: 'grbl',
    travel: { x: 100, y: 100, z: 50 },
    rapidRate: 5000,
    maxSpindleRpm: 24000,
    minSpindleRpm: 8000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
  }
}

const sampleMachine = mk('operator-machine', 'Operator Machine')

beforeEach(() => {
  // Reset the slices these tests depend on to a known baseline.
  useCamStore.setState((s) => ({
    machineLibrary: [sampleMachine],
    appSettings: { ...s.appSettings, defaultMachineId: null },
  }))
})

describe('default-machine store behavior', () => {
  it('setDefaultMachineId persists into appSettings', () => {
    useCamStore.getState().setDefaultMachineId('operator-machine')
    expect(useCamStore.getState().appSettings.defaultMachineId).toBe('operator-machine')

    useCamStore.getState().setDefaultMachineId(null)
    expect(useCamStore.getState().appSettings.defaultMachineId).toBeNull()
  })

  it('newProject binds a COPY of the resolvable default machine', () => {
    useCamStore.getState().setDefaultMachineId('operator-machine')
    useCamStore.getState().newProject()

    const m = useCamStore.getState().project.machine
    expect(m.id).toBe('operator-machine')
    expect(m.name).toBe('Operator Machine')
    // A copy, not the library reference (mutating the project must not mutate
    // the library entry).
    expect(m).not.toBe(sampleMachine)
  })

  it('newProject falls back to the generic machine when no default is set', () => {
    // defaultMachineId is null (beforeEach).
    useCamStore.getState().newProject()
    expect(useCamStore.getState().project.machine.id).toBe(GENERIC_ID)
  })

  it('newProject falls back to generic when the default id does not resolve', () => {
    useCamStore.getState().setDefaultMachineId('ghost-id')
    useCamStore.getState().newProject()
    expect(useCamStore.getState().project.machine.id).toBe(GENERIC_ID)
  })

  it('removeMachineFromLibrary clears defaultMachineId when the default is removed', () => {
    useCamStore.getState().setDefaultMachineId('operator-machine')
    useCamStore.getState().removeMachineFromLibrary('operator-machine')

    expect(useCamStore.getState().appSettings.defaultMachineId).toBeNull()
    expect(useCamStore.getState().machineLibrary.some((m) => m.id === 'operator-machine')).toBe(false)
  })

  it('removeMachineFromLibrary leaves defaultMachineId intact when a different machine is removed', () => {
    useCamStore.setState({ machineLibrary: [sampleMachine, mk('other')] })
    useCamStore.getState().setDefaultMachineId('operator-machine')
    useCamStore.getState().removeMachineFromLibrary('other')

    expect(useCamStore.getState().appSettings.defaultMachineId).toBe('operator-machine')
  })
})
