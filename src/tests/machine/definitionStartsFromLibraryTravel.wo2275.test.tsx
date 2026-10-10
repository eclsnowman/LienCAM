// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AXIS_NAMES, createDefaultControllerDefinition, machineTravel, type MachineConfig } from '../../types'
import { makeMachine } from '../post/helpers'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
} satisfies Storage })

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')

describe('WO-2275 Define starts from Machine Library travel', () => {
  let original: ReturnType<typeof useCamStore.getState>
  let originalControl: ReturnType<typeof useMachineControl.getState>
  beforeEach(() => {
    original = useCamStore.getState()
    originalControl = useMachineControl.getState()
    useCamStore.setState({ machineLibrary: [], control: {
      activeMachineId: null, sessionMachine: null, appliedMachine: null,
    } })
    useMachineControl.setState({ connectionPhase: 'disconnected', connectionKind: null, consoleLines: [] })
  })
  afterEach(() => {
    cleanup()
    useCamStore.setState(original)
    useMachineControl.setState(originalControl)
  })

  function define(overrides: Partial<MachineConfig> = {}) {
    const machine = makeMachine({
      id: 'wo-2275', name: 'Library router', controller: 'grbl',
      travel: { x: 610, y: 450, z: 120 }, controllerDefinition: undefined,
      homeConvention: {
        x: { homesToward: 'max', machineZeroAt: 'max' },
        y: { homesToward: 'max', machineZeroAt: 'max' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      }, ...overrides,
    })
    // The same production adoption/selection actions used by the library.
    useCamStore.getState().addMachineToLibrary(machine)
    useCamStore.getState().setProjectMachine(machine)
    render(<MachineDefinitionPanel />)
    fireEvent.click(screen.getByTestId('machine-def-panel-define'))
    fireEvent.click(screen.getByTestId('machine-def-tab-machine'))
    // Define is only an edit: neither persistent carrier nor the live board
    // receives a definition until the existing Save/Apply gestures run.
    expect(useCamStore.getState().machineLibrary[0].controllerDefinition).toBeUndefined()
    expect(useCamStore.getState().project.machine.controllerDefinition).toBeUndefined()
    expect(useCamStore.getState().control.appliedMachine).toBeNull()
    expect(useMachineControl.getState().consoleLines).toEqual([])
  }

  function limits(axis: string) {
    return ['minimum', 'maximum'].map((end) =>
      Number((screen.getByLabelText(`${axis} soft limit ${end}`) as HTMLInputElement).value))
  }

  it('carries 610/450/120 into the draft at the stated maximum home end', () => {
    define()
    expect(limits('X')).toEqual([-610, 0])
    expect(limits('Y')).toEqual([-450, 0])
    expect(limits('Z')).toEqual([-120, 0])
    fireEvent.click(screen.getByTestId('machine-def-panel-save'))
    const machine = useCamStore.getState().machineLibrary[0]
    expect(machineTravel(machine)).toEqual({ x: 610, y: 450, z: 120 })
    const defaults = createDefaultControllerDefinition(AXIS_NAMES)
    expect(machine.controllerDefinition?.homing).toEqual(defaults.homing)
    expect(machine.controllerDefinition?.io).toEqual(defaults.io)
    expect(machine.controllerDefinition?.axes.map((axis) => ({ ...axis, softLimitMin: 0, softLimitMax: 0 })))
      .toEqual(defaults.axes)
    fireEvent.click(screen.getByTestId('machine-def-tab-overview'))
    expect(screen.getByTestId('machine-def-overview-card-machine').textContent)
      .toContain('X 610 x Y 450 x Z 120')
  })

  it('keeps unknown travel as the existing 0/0 placeholders', () => {
    define({ travel: { x: 0, y: 0, z: 0 } })
    for (const axis of ['X', 'Y', 'Z']) expect(limits(axis)).toEqual([0, 0])
    fireEvent.click(screen.getByTestId('machine-def-panel-save'))
    expect(useCamStore.getState().machineLibrary[0].controllerDefinition)
      .toEqual(createDefaultControllerDefinition(AXIS_NAMES))
  })

  it('places mixed minimum and opposite-zero ends with the same travel lens', () => {
    define({ controller: 'uccnc', homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'max', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'max' },
    } })
    expect(limits('X')).toEqual([0, 610])
    expect(limits('Y')).toEqual([0, 450])
    expect(limits('Z')).toEqual([-120, 0])
  })

  it('seeds only known axes and uses the library default when no home end is stored', () => {
    define({ travel: { x: 610, y: 0, z: 120 }, homeConvention: undefined })
    expect(limits('X')).toEqual([-610, 0])
    expect(limits('Y')).toEqual([0, 0])
    expect(limits('Z')).toEqual([-120, 0])
  })
})
