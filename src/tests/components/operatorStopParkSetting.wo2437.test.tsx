// @vitest-environment jsdom
//
// WO-2437 fix round 3 - Operator ruling 2026-10-02 4:26 PM: where an operator stop parks
// is "User setable". The machine definition edits one stored value
// (`operatorStopPark`, machine coordinates) from both lenses - the G30 section
// on Overview and All Settings - and Save + the persistence reload keep it.
// Unset, the stop uses the machine's Park 1.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MachineConfig } from '../../types'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { AXIS_NAMES, createDefaultControllerDefinition, positionMacroBody } = await import('../../types')
const { workholdingStopPark } = await import('../../lib/machine/macros/clampPauseMacro')
const { PERSIST_STORE_VERSION, persistMerge, persistMigrate, persistPartialize, useCamStore } = await import('../../store')

afterEach(() => {
  cleanup()
  memory.clear()
})

const PARK_1 = { x: 738, y: 724.5, z: 128 }

// GRBL keeps the All Settings table small; the setting is not controller-specific.
function machineWithPark1(withDefinition: boolean): MachineConfig {
  const current = useCamStore.getState().project.machine
  return {
    ...current,
    id: `wo2437-${withDefinition ? 'def' : 'plain'}`,
    name: 'WO-2437 park setting',
    controller: 'grbl',
    controllerDefinition: withDefinition ? createDefaultControllerDefinition(AXIS_NAMES) : undefined,
    macros: [{ id: 'park-1', name: 'Park 1', body: positionMacroBody({ ...PARK_1, zFirst: true }) }],
    operatorStopPark: undefined,
  }
}

function mount(machine: MachineConfig, tab: string | null): void {
  act(() => {
    useCamStore.setState({
      machineLibrary: [machine],
      project: { ...useCamStore.getState().project, machine },
      consoleEvents: [],
    })
  })
  render(<MachineDefinitionPanel />)
  if (tab !== null) act(() => { fireEvent.click(screen.getByTestId(`machine-def-tab-${tab}`)) })
}

function type(input: HTMLInputElement, value: string): void {
  act(() => { fireEvent.focus(input) })
  act(() => { fireEvent.change(input, { target: { value } }) })
  act(() => { fireEvent.blur(input) })
}

function save(id: string): MachineConfig {
  act(() => { fireEvent.click(screen.getByTestId('machine-def-panel-save')) })
  return useCamStore.getState().machineLibrary.find((entry) => entry.id === id)!
}

function reloadThroughProductionStore(machine: MachineConfig): MachineConfig {
  const current = useCamStore.getState()
  const live = {
    ...current,
    machineLibrary: [machine],
    project: { ...current.project, machine },
    appSettings: { ...current.appSettings, liencncSeeded: true },
  }
  const written = JSON.parse(JSON.stringify(persistPartialize(live)))
  const migrated = persistMigrate(written, PERSIST_STORE_VERSION)
  return persistMerge(migrated, live).machineLibrary.find((entry) => entry.id === machine.id)!
}

describe('WO-2437 the operator-stop park is a machine-definition setting', () => {
  it('All Settings: typing X sets the park from Park 1, Save and reload keep it, the stop parks there; blank clears it', () => {
    const machine = machineWithPark1(true)
    expect(workholdingStopPark(machine, undefined)).toMatchObject(PARK_1)
    mount(machine, 'allSettings')

    const x = screen.getByLabelText('park.operatorStop.x') as HTMLInputElement
    expect(x.value).toBe('')
    type(x, '50')
    const saved = save(machine.id)
    expect(saved.operatorStopPark).toEqual({ x: 50, y: 724.5, z: 128 })
    expect(workholdingStopPark(saved, undefined)).toMatchObject({ x: 50, y: 724.5, z: 128 })
    expect(reloadThroughProductionStore(saved).operatorStopPark).toEqual({ x: 50, y: 724.5, z: 128 })

    expect((screen.getByLabelText('park.operatorStop.x') as HTMLInputElement).value).toBe('50')
    type(screen.getByLabelText('park.operatorStop.z') as HTMLInputElement, '')
    const cleared = save(machine.id)
    expect(cleared.operatorStopPark ?? null).toBeNull()
    expect(workholdingStopPark(cleared, undefined)).toMatchObject(PARK_1)
  })

  it('Overview, beside the G30 points: the same field, machine coordinates, blank shows Park 1', () => {
    const machine = machineWithPark1(false)
    mount(machine, null)
    const section = screen.getByTestId('machine-def-operator-stop-park')
    expect(section.textContent).toContain('Machine coordinates (mm)')
    const y = screen.getByLabelText('Operator stop park Y machine coordinate') as HTMLInputElement
    expect(y.value).toBe('')
    expect(y.placeholder).toBe('724.5')
    type(y, '600')
    expect(save(machine.id).operatorStopPark).toEqual({ x: 738, y: 600, z: 128 })
  })
})
