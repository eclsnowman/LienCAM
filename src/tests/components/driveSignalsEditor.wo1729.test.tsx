// @vitest-environment jsdom

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
const { createDefaultControllerDefinition } = await import('../../types')
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

function machine(id: string, definition: ControllerDefinition): MachineConfig {
  const base = useCamStore.getState().project.machine
  return {
    ...base,
    id,
    name: `WO-1729 ${id}`,
    controller: 'uccnc',
    controllerDefinition: definition,
  }
}

function saved(id: string): MachineConfig {
  const found = useCamStore.getState().machineLibrary.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`machine ${id} was not saved`)
  return found
}

function productionReload(): void {
  const live = useCamStore.getState()
  const written = JSON.parse(JSON.stringify(persistPartialize({
    ...live,
    appSettings: { ...live.appSettings, liencncSeeded: true },
  }))) as unknown
  const migrated = persistMigrate(written, PERSIST_STORE_VERSION)
  useCamStore.setState(persistMerge(migrated, live))
}

function open(tab: 'controller' | 'outputs'): void {
  fireEvent.click(screen.getByTestId(`machine-def-tab-${tab}`))
}

function savePanel(): void {
  fireEvent.click(screen.getByTestId('machine-def-panel-save'))
}

function writePin(name: string, port: string, pin: string, activeLow: boolean): void {
  fireEvent.change(screen.getByLabelText(`${name} port`), { target: { value: port } })
  fireEvent.change(screen.getByLabelText(`${name} pin`), { target: { value: pin } })
  const polarity = screen.getByLabelText(`${name} negate`) as HTMLInputElement
  expect(polarity.indeterminate).toBe(true)
  fireEvent.click(polarity)
  if (!activeLow) fireEvent.click(screen.getByLabelText(`${name} negate`))
}

describe('WO-1729 definition editor', () => {
  it('renders, edits, saves, reloads and switches zero/one/two fault inputs and charge-pump states', () => {
    const neighborIo = {
      estop: { port: 1, pin: 1, negate: true },
      probe: { port: 1, pin: 2, negate: false },
      probe2: { port: 0, pin: 0, negate: null },
    }
    const neighborOutputs = [{
      name: 'Dust collector', onCode: 'M10' as const, offCode: 'M11' as const,
      pin: { port: 6, pin: 4, negate: false },
    }]
    const alphaDefinition: ControllerDefinition = {
      ...createDefaultControllerDefinition(),
      io: neighborIo,
      outputs: neighborOutputs,
    }
    const betaDefinition: ControllerDefinition = {
      ...createDefaultControllerDefinition(),
      driveFaultInputs: [
        { port: 8, pin: 1, negate: false },
        { port: 8, pin: 2, negate: true },
      ],
      chargePump: {
        enabled: true,
        pin: { port: 8, pin: 3, negate: true },
        frequencyHz: 5000,
      },
    }
    const alpha = machine('alpha', alphaDefinition)
    const beta = machine('beta', betaDefinition)
    act(() => {
      useCamStore.setState({
        machineLibrary: [alpha, beta],
        project: { ...useCamStore.getState().project, machine: alpha },
        consoleEvents: [],
      })
    })

    const view = render(<Panel machineId={alpha.id} />)
    open('controller')
    expect(screen.getByTestId('machine-def-drive-fault-inputs-none')).toBeTruthy()

    fireEvent.click(screen.getByTestId('machine-def-drive-fault-input-add'))
    writePin('drive-fault input 1', '2', '10', true)
    fireEvent.click(screen.getByTestId('machine-def-drive-fault-input-add'))
    writePin('drive-fault input 2', '3', '7', false)
    expect(screen.getAllByTestId(/^machine-def-drive-fault-input-row-/)).toHaveLength(2)
    savePanel()

    productionReload()
    expect(saved(alpha.id).controllerDefinition?.driveFaultInputs).toEqual([
      { port: 2, pin: 10, negate: true },
      { port: 3, pin: 7, negate: false },
    ])

    open('outputs')
    expect((screen.getByTestId('machine-def-charge-pump-state') as HTMLSelectElement).value)
      .toBe('absent')
    fireEvent.change(screen.getByTestId('machine-def-charge-pump-state'), {
      target: { value: 'off' },
    })
    savePanel()
    productionReload()
    expect(saved(alpha.id).controllerDefinition?.chargePump).toEqual({ enabled: false })

    fireEvent.change(screen.getByTestId('machine-def-charge-pump-state'), {
      target: { value: 'on' },
    })
    fireEvent.click(screen.getByTestId('machine-def-charge-pump-pin-define'))
    writePin('charge pump', '4', '1', false)
    const frequency = screen.getByLabelText('Charge pump frequency (Hz)')
    fireEvent.change(frequency, { target: { value: '12500' } })
    fireEvent.blur(frequency)
    savePanel()
    productionReload()
    expect(saved(alpha.id).controllerDefinition?.chargePump).toEqual({
      enabled: true,
      pin: { port: 4, pin: 1, negate: false },
      frequencyHz: 12_500,
    })

    // Machine switching changes the facts on screen instead of carrying
    // alpha's saved definition into beta's draft.
    act(() => { view.rerender(<Panel machineId={beta.id} />) })
    open('controller')
    expect(screen.getAllByTestId(/^machine-def-drive-fault-input-row-/)).toHaveLength(2)
    expect((screen.getByLabelText('drive-fault input 1 port') as HTMLInputElement).value).toBe('8')
    open('outputs')
    expect((screen.getByTestId('machine-def-charge-pump-state') as HTMLSelectElement).value)
      .toBe('on')
    expect((screen.getByLabelText('Charge pump frequency (Hz)') as HTMLInputElement).value)
      .toBe('5000')

    act(() => { view.rerender(<Panel machineId={alpha.id} />) })
    open('controller')
    fireEvent.change(screen.getByLabelText('drive-fault input 1 port'), {
      target: { value: '9' },
    })
    fireEvent.click(screen.getByTestId('machine-def-drive-fault-input-remove-1'))
    expect(screen.getAllByTestId(/^machine-def-drive-fault-input-row-/)).toHaveLength(1)
    savePanel()

    // Optional pump fields can be removed without changing the explicit On
    // statement. This proves absence is a real editable state, not a default.
    open('outputs')
    fireEvent.click(screen.getByTestId('machine-def-charge-pump-pin-clear'))
    const existingFrequency = screen.getByLabelText('Charge pump frequency (Hz)')
    fireEvent.change(existingFrequency, { target: { value: '' } })
    fireEvent.blur(existingFrequency)
    savePanel()
    productionReload()

    const reloadedAlpha = saved(alpha.id)
    expect(reloadedAlpha.controllerDefinition?.driveFaultInputs).toEqual([
      { port: 9, pin: 10, negate: true },
    ])
    expect(reloadedAlpha.controllerDefinition?.chargePump).toEqual({ enabled: true })
    expect(reloadedAlpha.controllerDefinition?.io).toEqual(neighborIo)
    expect(reloadedAlpha.controllerDefinition?.outputs).toEqual(neighborOutputs)
    expect(saved(beta.id).controllerDefinition).toEqual(betaDefinition)
  })

  it('claims the truthful wired provenance: Apply sends these settings to the bridge', () => {
    // WO-1729 native phase: Machine.cs now parses every driveFaultInputs
    // record and applies the charge pump through the real UC wrapper, so the
    // old `data-not-driven` + "saved for the bridge follow-up" provenance is
    // false. `data-wired` is the closed-list marker for "Apply writes this
    // value to the controller and the bridge acts on it". The marker claims
    // send-and-act ONLY: no physical board validation (that is hardware
    // check M15) and no frequency support (the wrapper has no frequency
    // argument, so the frequency box must not ride the wired claim).
    const definition: ControllerDefinition = {
      ...createDefaultControllerDefinition(),
      driveFaultInputs: [{ port: 2, pin: 10, negate: true }],
      chargePump: { enabled: true, pin: { port: 4, pin: 1, negate: false } },
    }
    const alpha = machine('alpha', definition)
    act(() => {
      useCamStore.setState({
        machineLibrary: [alpha],
        project: { ...useCamStore.getState().project, machine: alpha },
        consoleEvents: [],
      })
    })

    render(<Panel machineId={alpha.id} />)

    // The fault-input pin triple carries the wired marker and the truthful
    // tooltip, and its controls are marked through their wrapper.
    open('controller')
    const faultField = screen.getByTestId('machine-def-drive-fault-input-pin-0')
    expect(faultField.hasAttribute('data-wired')).toBe(true)
    expect(faultField.hasAttribute('data-not-driven')).toBe(false)
    expect(faultField.getAttribute('data-tooltip'))
      .toBe('drive-fault input 1 - port, pin, active low; Apply sends this to the bridge')
    expect((screen.getByLabelText('drive-fault input 1 negate') as HTMLInputElement)
      .closest('[data-wired]')).toBe(faultField)

    // Absent/unknown polarity is unchanged by the provenance swap: a freshly
    // added row still states nothing and shows the indeterminate dash.
    fireEvent.click(screen.getByTestId('machine-def-drive-fault-input-add'))
    const addedField = screen.getByTestId('machine-def-drive-fault-input-pin-1')
    const addedNegate = screen.getByLabelText('drive-fault input 2 negate') as HTMLInputElement
    expect(addedNegate.indeterminate).toBe(true)
    expect(addedField.hasAttribute('data-wired')).toBe(true)

    // The pump pin triple carries the same truthful provenance...
    open('outputs')
    const pumpField = screen.getByTestId('machine-def-charge-pump-pin')
    expect(pumpField.hasAttribute('data-wired')).toBe(true)
    expect(pumpField.hasAttribute('data-not-driven')).toBe(false)
    expect(pumpField.getAttribute('data-tooltip'))
      .toBe('charge pump - port, pin, active low; Apply sends this to the bridge')

    // ...and the frequency box does NOT ride the wired claim.
    expect((screen.getByLabelText('Charge pump frequency (Hz)') as HTMLInputElement)
      .closest('[data-wired]')).toBeNull()

    // The wired claim is about the SAME values the ordinary roundtrip saves:
    // one edit through the real draft, Save and production persist reload.
    // The added row's unknown polarity survives the reload as `negate: null`
    // (the coverage the phase audits named as owed), never as an invented
    // active-high or active-low.
    fireEvent.change(screen.getByLabelText('charge pump port'), { target: { value: '5' } })
    savePanel()
    productionReload()
    expect(saved('alpha').controllerDefinition?.chargePump).toEqual({
      enabled: true,
      pin: { port: 5, pin: 1, negate: false },
    })
    expect(saved('alpha').controllerDefinition?.driveFaultInputs)
      .toEqual([{ port: 2, pin: 10, negate: true }, { port: 0, pin: 0, negate: null }])
  })
})
