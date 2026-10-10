// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineController } from '../../lib/machine/controller'
import type { MachineConfig, MachineSpindleLinkDefinition } from '../../types'

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

const { controlMachine, persistPartialize, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { createDefaultControllerDefinition } = await import('../../types')
const { HUANYANG_GT } = await import('../../lib/machine/vfd/huanyangGt')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { JogPanel } = await import('../../components/machine/JogPanel')
const session = await import('../../lib/machine/machineSession')

function machine(overrides: Partial<MachineConfig> = {}): MachineConfig {
  const definition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
  definition.homing.perAxis.Z!.backOff = 2
  return {
    id: 'wo1147-machine',
    name: 'Receipt Router',
    type: 'gantry_router',
    controller: 'grbl',
    travel: { x: 400, y: 300, z: 80 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'min' },
    },
    rapidRate: 3200,
    maxSpindleRpm: 18000,
    minSpindleRpm: 6000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    controllerDefinition: definition,
    notes: 'connection-start note',
    ...overrides,
  }
}

let originalLibrary: MachineConfig[]
let originalProject: MachineConfig

beforeEach(() => {
  originalLibrary = useCamStore.getState().machineLibrary
  originalProject = useCamStore.getState().project.machine
  const initial = machine()
  useCamStore.setState((state) => ({
    machineLibrary: [initial],
    project: { ...state.project, machine: initial },
    control: {
      activeMachineId: initial.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  }))
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    connectionKind: null,
    connectionDetail: null,
    settings: {},
    consoleLines: [],
  })
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
  useCamStore.setState((state) => ({
    machineLibrary: originalLibrary,
    project: { ...state.project, machine: originalProject },
    control: {
      activeMachineId: null,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  }))
  vi.useRealTimers()
})

describe('WO-1147 connected definition authority', () => {
  it('keeps a serial GRBL session on its receipt-bound controller and envelope after a same-id UCCNC save', () => {
    const start = useCamStore.getState().machineLibrary[0]
    act(() => { useCamStore.getState().setControlSessionMachine(start) })
    useMachineControl.setState({ connectionPhase: 'connected', connectionKind: 'serial' })

    const savedDefinition = structuredClone(start.controllerDefinition!)
    savedDefinition.homing.perAxis.Z!.backOff = 9
    const saved = machine({
      name: 'Receipt Router - future',
      notes: 'presentation may update',
      controller: 'uccnc',
      travel: { x: 900, y: 700, z: 150 },
      rapidRate: 6000,
      controllerDefinition: savedDefinition,
    })
    act(() => {
      useCamStore.getState().updateMachineInLibrary(saved.id, saved)
      useCamStore.getState().setProjectMachine(saved)
    })

    const runtime = controlMachine(useCamStore.getState())
    expect(runtime.controller).toBe('grbl')
    expect(runtime.travel).toEqual(start.travel)
    expect(runtime.rapidRate).toBe(start.rapidRate)
    expect(runtime.controllerDefinition!.homing.perAxis.Z!.backOff).toBe(2)
    expect(runtime.name).toBe(saved.name)
    expect(runtime.notes).toBe(saved.notes)
    expect(persistPartialize(useCamStore.getState()).control).toEqual({ activeMachineId: saved.id })

    render(<MachineDefinitionPanel connectionKind="serial" />)
    fireEvent.click(screen.getByTestId('machine-def-tab-controller'))
    expect(screen.getByTestId('machine-controller-setup').getAttribute('data-connection-kind'))
      .toBe('serial')
    expect(screen.getByTestId('machine-def-panel-authority-status').getAttribute('data-authority-state'))
      .toBe('pending')
    expect(screen.getByTestId('machine-def-panel-authority-status').textContent)
      .toMatch(/pending.*reconnect/i)
  })

  it('promotes only controllerDefinition after a confirmed Apply and adopts all saved fields only on reconnect', () => {
    const start = useCamStore.getState().machineLibrary[0]
    act(() => { useCamStore.getState().setControlSessionMachine(start) })
    const confirmed = structuredClone(start.controllerDefinition!)
    confirmed.homing.perAxis.X!.backOff = 7
    const saved = machine({
      controller: 'uccnc',
      travel: { x: 800, y: 600, z: 120 },
      rapidRate: 5500,
      controllerDefinition: confirmed,
    })
    act(() => { useCamStore.getState().updateMachineInLibrary(saved.id, saved) })

    expect(useCamStore.getState().confirmControlSessionDefinition(saved.id, confirmed)).toBe(true)
    const applied = controlMachine(useCamStore.getState())
    expect(applied.controllerDefinition).toEqual(confirmed)
    expect(applied.controller).toBe('grbl')
    expect(applied.travel).toEqual(start.travel)
    expect(useCamStore.getState().control.sessionMachine!.controllerDefinition)
      .toEqual(start.controllerDefinition)
    expect(useCamStore.getState().control.appliedMachine!.controllerDefinition).toEqual(confirmed)

    act(() => {
      useCamStore.getState().setControlSessionMachine(null)
      useCamStore.getState().setControlSessionMachine(saved)
    })
    expect(controlMachine(useCamStore.getState())).toEqual(saved)
    expect(useCamStore.getState().control.appliedMachine).toBeNull()
  })

  it('promotes a controller-confirmed spindle link without adopting other saved profile edits', () => {
    const start = useCamStore.getState().machineLibrary[0]
    act(() => { useCamStore.getState().setControlSessionMachine(start) })
    const confirmed: MachineSpindleLinkDefinition = {
      ...structuredClone(HUANYANG_GT),
      provenance: { kind: 'seeded-from-bridge', source: 'WO-1147 receipt' },
      status: HUANYANG_GT.status.map((field) => field.name === 'power'
        ? { name: 'power', source: 'derived', scale: 'field.volts * field.amps' }
        : structuredClone(field)),
    }
    const saved = machine({
      travel: { x: 900, y: 700, z: 150 },
      spindleLinkDefinition: confirmed,
    })
    act(() => {
      useCamStore.getState().updateMachineInLibrary(saved.id, saved)
      useCamStore.getState().setProjectMachine(saved)
    })

    expect(controlMachine(useCamStore.getState()).spindleLinkDefinition).toBeUndefined()
    expect(useCamStore.getState().confirmControlSessionSpindleLinkDefinition(saved.id, confirmed)).toBe(true)
    expect(controlMachine(useCamStore.getState()).spindleLinkDefinition).toEqual(confirmed)
    expect(controlMachine(useCamStore.getState()).travel).toEqual(start.travel)

    const appliedDefinition = structuredClone(start.controllerDefinition!)
    appliedDefinition.homing.perAxis.Z!.backOff = 11
    expect(useCamStore.getState().confirmControlSessionDefinition(saved.id, appliedDefinition)).toBe(true)
    expect(controlMachine(useCamStore.getState()).spindleLinkDefinition).toEqual(confirmed)
    expect(controlMachine(useCamStore.getState()).controllerDefinition).toEqual(appliedDefinition)
  })

  it('keeps the running simulator envelope on A after Save and rebuilds it from B after reconnect', async () => {
    vi.useFakeTimers()
    const firstConnect = session.connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(350)
    await firstConnect

    const saved = machine({ travel: { x: 910, y: 710, z: 160 } })
    act(() => { useCamStore.getState().updateMachineInLibrary(saved.id, saved) })
    session.getMachineController().querySettings()
    await vi.advanceTimersByTimeAsync(10)
    expect(useMachineControl.getState().settings).toMatchObject({ 130: '400.000', 131: '300.000', 132: '80.000' })
    expect(controlMachine(useCamStore.getState()).travel).toEqual({ x: 400, y: 300, z: 80 })

    const disconnect = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnect
    const reconnect = session.connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(350)
    await reconnect
    session.getMachineController().querySettings()
    await vi.advanceTimersByTimeAsync(10)
    expect(useMachineControl.getState().settings).toMatchObject({ 130: '910.000', 131: '710.000', 132: '160.000' })
    expect(controlMachine(useCamStore.getState()).travel).toEqual(saved.travel)
  })

  it('keeps Home All on the session order after a same-id save and labels the edit pending reconnect', async () => {
    vi.useFakeTimers()
    const start = useCamStore.getState().machineLibrary[0]
    const connect = session.connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(350)
    await connect
    session.__resetEstopInterlockForTest()

    const savedDefinition = structuredClone(start.controllerDefinition!)
    savedDefinition.homing.order = ['Y', 'X', 'Z']
    const saved = machine({ controllerDefinition: savedDefinition })
    act(() => {
      useCamStore.getState().updateMachineInLibrary(saved.id, saved)
      useCamStore.getState().setProjectMachine(saved)
    })

    const homeAxes = vi
      .spyOn(session.getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(
      <>
        <JogPanel />
        <MachineDefinitionPanel connectionKind="simulator" />
      </>,
    )
    fireEvent.click(screen.getByTestId('control-home'))

    expect(homeAxes).toHaveBeenCalledWith(start.controllerDefinition!.homing.order)
    expect(homeAxes).not.toHaveBeenCalledWith(savedDefinition.homing.order)
    expect(screen.getByTestId('machine-def-panel-authority-status').textContent)
      .toMatch(/pending.*reconnect/i)
  })

  it('refuses an invalid saved controller definition before it can become reconnect authority', async () => {
    const invalid = machine()
    invalid.controllerDefinition!.axes.push(structuredClone(invalid.controllerDefinition!.axes[0]))
    act(() => { useCamStore.getState().updateMachineInLibrary(invalid.id, invalid) })

    await expect(session.connectMachine('simulator')).rejects.toThrow(/cannot connect.*listed more than once/i)
    expect(useCamStore.getState().control.sessionMachine).toBeNull()
    expect(useMachineControl.getState().connectionKind).toBeNull()
  })
})
