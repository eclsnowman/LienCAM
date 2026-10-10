// @vitest-environment jsdom
//
// WO-1729 validation-navigation repair.
//
// `definitionProblemGroup` (DefinitionNavigation.tsx) owns which of the seven
// outer tabs badges a validation complaint. Before this repair it recognized
// e-stop (Controller) and probe / probe 2 (Probing) and sent EVERY other
// matched pin label to Machine - so a range or duplicate fault on a
// drive-fault input or the charge pump badged Machine, while the editors for
// those pins live on Controller (DriveFaultInputsSection) and Outputs
// (ChargePumpSection). These tests prove the repair through the REAL panel:
//
//   1. an invalid-range drive-fault pin badges Controller, not Machine, and
//      the badged tab opens the existing control;
//   2. an invalid-range charge-pump pin badges Outputs, not Machine;
//   3. duplicate-label precedence is kept: the census names the first
//      claimant, so a pin shared by a drive-fault input and the pump badges
//      Controller, while a pin shared with an AXIS pin still badges Machine
//      (the axis default is untouched);
//   4. the old e-stop / probe / probe 2 / axis / homing routes are unchanged
//      and the badges stay total over the validator.
//
// Negative control (recorded in the WO): cases 1-3 fail against the pre-fix
// grouping at the badge assertions themselves, not at import or compile.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { ControllerDefinition, MachineConfig } from '../../types'

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
type PanelProps = import('../../components/machine/MachineDefinitionPanel').MachineDefinitionPanelProps
const Panel = MachineDefinitionPanel as ComponentType<PanelProps>
const { createDefaultControllerDefinition, validateControllerDefinition } = await import('../../types')
const { useCamStore } = await import('../../store')

const state = () => useCamStore.getState()

function machine(definition: ControllerDefinition): MachineConfig {
  return {
    ...state().project.machine,
    id: 'wo1729-nav',
    name: 'WO-1729 nav',
    controller: 'uccnc',
    controllerDefinition: definition,
  }
}

function mount(definition: ControllerDefinition): MachineConfig {
  const m = machine(definition)
  act(() => {
    useCamStore.setState({
      machineLibrary: [m],
      project: { ...state().project, machine: m },
      consoleEvents: [],
    })
  })
  render(<Panel machineId={m.id} />)
  return m
}

const open = (tab: string) => { fireEvent.click(screen.getByTestId(`machine-def-tab-${tab}`)) }
const badge = (tab: string): string | null =>
  screen.queryByTestId(`machine-def-tab-badge-${tab}`)?.textContent ?? null

afterEach(() => {
  cleanup()
  memory.clear()
})

describe('WO-1729 drive-signal problems badge the tab that owns the editor', () => {
  it('an invalid drive-fault pin badges Controller, not Machine, and opens its control', () => {
    const def = createDefaultControllerDefinition()
    mount(def)
    open('controller')
    fireEvent.click(screen.getByTestId('machine-def-drive-fault-input-add'))
    fireEvent.change(screen.getByLabelText('drive-fault input 1 port'), { target: { value: '2' } })

    // The validator really emits the complaint the badge must account for.
    expect(validateControllerDefinition({
      ...createDefaultControllerDefinition(),
      driveFaultInputs: [{ port: 2, pin: 0, negate: null }],
    })).toEqual([
      'The drive fault input 1 pin is port 2 pin 0; port and pin must both be'
      + ' whole numbers above zero (or both zero for unassigned).',
    ])

    expect(badge('controller')).toBe('1')
    expect(badge('machine')).toBeNull()
    expect(badge('outputs')).toBeNull()
    expect(screen.getByTestId('machine-def-panel-summary').textContent).toContain('1 to fix')

    // The badge survives a trip across the bar, and the Controller tab opens
    // the existing control showing the offending value.
    open('overview')
    expect(badge('controller')).toBe('1')
    open('controller')
    expect(screen.getByTestId('machine-def-drive-fault-inputs')).toBeTruthy()
    expect((screen.getByLabelText('drive-fault input 1 port') as HTMLInputElement).value).toBe('2')
  })

  it('an invalid charge-pump pin badges Outputs, not Machine, and opens its control', () => {
    mount(createDefaultControllerDefinition())
    open('outputs')
    fireEvent.change(screen.getByTestId('machine-def-charge-pump-state'), { target: { value: 'on' } })
    fireEvent.click(screen.getByTestId('machine-def-charge-pump-pin-define'))
    fireEvent.change(screen.getByLabelText('charge pump port'), { target: { value: '4' } })

    expect(badge('outputs')).toBe('1')
    expect(badge('machine')).toBeNull()
    expect(badge('controller')).toBeNull()

    open('overview')
    expect(badge('outputs')).toBe('1')
    open('outputs')
    expect(screen.getByTestId('machine-def-charge-pump')).toBeTruthy()
    expect((screen.getByLabelText('charge pump port') as HTMLInputElement).value).toBe('4')
  })

  it('keeps duplicate-label precedence: fault-vs-pump badges Controller, axis-vs-pump still Machine', () => {
    // A drive-fault input stated first claims 5:2, the pump collides with it.
    // The census names the first claimant, so the complaint belongs to the
    // tab that editor lives on - Controller - not to Outputs and not to
    // Machine.
    const shared: ControllerDefinition = {
      ...createDefaultControllerDefinition(),
      driveFaultInputs: [{ port: 5, pin: 2, negate: false }],
      chargePump: { enabled: true, pin: { port: 5, pin: 2, negate: false } },
    }
    expect(validateControllerDefinition(shared)).toEqual([
      'Port 5 pin 2 is claimed by both drive fault input 1 and charge pump.',
    ])
    mount(shared)
    expect(badge('controller')).toBe('1')
    expect(badge('outputs')).toBeNull()
    expect(badge('machine')).toBeNull()
    cleanup()

    // The same pump pin shared with an AXIS pin keeps the pre-existing route:
    // the axis label wins the census order and the fault badges Machine.
    const axisShared: ControllerDefinition = {
      ...createDefaultControllerDefinition(),
      axes: createDefaultControllerDefinition().axes.map((a) => (
        a.axis === 'X' ? { ...a, stepPin: { port: 7, pin: 9, negate: false } } : a
      )),
      chargePump: { enabled: true, pin: { port: 7, pin: 9, negate: false } },
    }
    expect(validateControllerDefinition(axisShared)).toEqual([
      'Port 7 pin 9 is claimed by both X step and charge pump.',
    ])
    mount(axisShared)
    expect(badge('machine')).toBe('1')
    expect(badge('outputs')).toBeNull()
    expect(badge('controller')).toBeNull()
  })

  it('preserves the e-stop, probe, axis and homing routes and stays total', () => {
    const base = createDefaultControllerDefinition()
    const [x] = base.axes
    const def: ControllerDefinition = {
      ...base,
      axes: [{ ...x, stepPin: { port: 3, pin: -1, negate: null } }],
      io: {
        estop: { port: 1, pin: -1, negate: null },
        probe: { port: 1, pin: -2, negate: null },
        probe2: { port: 1, pin: -3, negate: null },
      },
      homing: { ...base.homing, order: ['X', 'X'] },
    }
    const problems = validateControllerDefinition(def)
    expect(problems).toHaveLength(5)
    mount(def)
    expect(badge('controller')).toBe('1') // e-stop -> Controller (pre-existing)
    expect(badge('probing')).toBe('2')   // probe + probe 2 -> Probing (pre-existing)
    expect(badge('machine')).toBe('2')   // axis pin + homing -> Machine (pre-existing)
    expect(badge('outputs')).toBeNull()
    // Totality: the seven badges still sum to the raw problem count.
    const sum = ['overview', 'machine', 'spindle', 'outputs', 'probing', 'controller', 'allSettings']
      .reduce((s, key) => s + Number(badge(key) ?? '0'), 0)
    expect(sum).toBe(problems.length)
  })
})
