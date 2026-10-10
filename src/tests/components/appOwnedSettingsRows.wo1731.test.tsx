// @vitest-environment jsdom
//
// WO-1731 - APP-OWNED FACTS STAY APP-OWNED IN ALL SETTINGS.
//
// A `liencam.*` definition key is not a GRBL register. This drives the real
// All Settings table through the panel so the proof covers the rendered value,
// the edit door, Save, and the same persistence reload a browser refresh uses.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ControllerType, MachineConfig } from '../../types'

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
const { buildAllSettingsRows } = await import('../../components/machine/definition/AllSettingsTable')
const {
  AXIS_NAMES,
  LIENCAM_SAFE_Z_KEY,
  createDefaultControllerDefinition,
  machineSafeZ,
  withMachineSafeZ,
} = await import('../../types')
const {
  PERSIST_STORE_VERSION,
  persistMerge,
  persistMigrate,
  persistPartialize,
  useCamStore,
} = await import('../../store')

afterEach(() => {
  cleanup()
  memory.clear()
})

function appSafeZMachine(controller: ControllerType): MachineConfig {
  const current = useCamStore.getState().project.machine
  return withMachineSafeZ({
    ...current,
    id: `wo1731-${controller}`,
    name: `WO-1731 ${controller}`,
    controller,
    controllerDefinition: createDefaultControllerDefinition(AXIS_NAMES),
    safeZMachine: undefined,
    grblSettings: undefined,
  }, 42)
}

function mount(machine: MachineConfig): void {
  act(() => {
    useCamStore.setState({
      machineLibrary: [machine],
      project: { ...useCamStore.getState().project, machine },
      consoleEvents: [],
    })
  })
  render(<MachineDefinitionPanel />)
  act(() => { fireEvent.click(screen.getByTestId('machine-def-tab-allSettings')) })
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

describe.each(['grbl', 'generic', 'uccnc'] as const)(
  'WO-1731 %s app-owned All Settings row',
  (controller) => {
    it('renders, edits, saves and reloads through the app authority without a controller-register write', () => {
      const machine = appSafeZMachine(controller)
      expect(machineSafeZ(machine)).toEqual({ z: 42, from: 'app' })
      mount(machine)

      const input = screen.getByLabelText(LIENCAM_SAFE_Z_KEY) as HTMLInputElement
      expect(input.value).toBe('42')
      act(() => { fireEvent.change(input, { target: { value: '57' } }) })
      act(() => { fireEvent.blur(input) })
      act(() => { fireEvent.click(screen.getByTestId('machine-def-panel-save')) })

      const saved = useCamStore.getState().machineLibrary.find((entry) => entry.id === machine.id)!
      expect(machineSafeZ(saved)).toEqual({ z: 57, from: 'app' })
      expect(Object.keys(saved.grblSettings ?? {})).not.toContain('NaN')

      const rows = buildAllSettingsRows(saved).filter((row) => row.key === LIENCAM_SAFE_Z_KEY)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ source: 'app', value: '57' })

      const reloaded = reloadThroughProductionStore(saved)
      expect(machineSafeZ(reloaded)).toEqual({ z: 57, from: 'app' })
      expect(buildAllSettingsRows(reloaded).find((row) => row.key === LIENCAM_SAFE_Z_KEY))
        .toMatchObject({ source: 'app', value: '57' })
    })
  },
)
