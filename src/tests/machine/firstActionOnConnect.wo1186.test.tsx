// @vitest-environment jsdom
//
// WO-1186: the Control page must put a datum ahead of a work-coordinate goto
// on a fresh connection. This mounts the application page rather than testing
// a hand-built transport input, so the banner and offer order are both real UI.

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

vi.mock('../../components/machine/ProgramPanel', () => typedMock<typeof import('../../components/machine/ProgramPanel')>({
  ProgramPanel: () => <></>,
}))

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { createDefaultControllerDefinition } = await import('../../types')
const { __resetEstopInterlockForTest } = await import('../../lib/machine/machineSession')

function seedFreshConnection({ switchless = false }: { switchless?: boolean } = {}): void {
  useCamStore.getState().newProject()
  const machine = useCamStore.getState().project.machine!
  const controllerDefinition = createDefaultControllerDefinition()
  controllerDefinition.axes.forEach((axis, index) => {
    axis.stepPin = { port: 1, pin: 2 + index * 2, negate: false }
    axis.dirPin = { port: 1, pin: 3 + index * 2, negate: false }
    if (!switchless) axis.homePin = { port: 2, pin: 1 + index, negate: false }
  })
  useCamStore.getState().updateMachine({ ...machine, controllerDefinition })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    machineState: 'idle',
    homed: false,
    activeWcs: null,
    mpos: { x: 0, y: 0, z: 0 },
    wpos: { x: 0, y: 0, z: 0 },
    settings: {},
    programText: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
}

afterEach(() => cleanup())

describe('WO-1186 first Control-page action after connect', () => {
  it('orders fresh connection guidance by datum, then active work offset', () => {
    seedFreshConnection()
    // The existing fresh-connection E-STOP clear remains the first safety
    // action. This test verifies the next guidance once that established
    // interlock is clear, before either Home or Goto has been chosen.
    act(() => { __resetEstopInterlockForTest() })
    render(<ControlPage />)

    expect(screen.getByTestId('control-next-action').textContent)
      .toContain('Before using Home All, check each axis is off its home switch')
    expect(screen.getByTestId('control-next-action').textContent).not.toContain('Goto XY0')
    expect(screen.getByTestId('control-home')).toBeTruthy()
    expect((screen.getByTestId('control-goto-xy0') as HTMLButtonElement).disabled).toBe(false)

    act(() => { useMachineControl.setState({ homed: true }) })

    expect(screen.queryByTestId('control-next-action')).toBeNull()

    act(() => { useMachineControl.setState({ activeWcs: 'G54' }) })

    expect(screen.getByTestId('control-next-action').textContent)
      .toContain('Load a checked program or prepare a material-fit trace.')
    expect((screen.getByTestId('control-goto-xy0') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not offer homing on a switchless fresh connection', () => {
    seedFreshConnection({ switchless: true })
    act(() => { __resetEstopInterlockForTest() })
    render(<ControlPage />)

    expect(screen.getByTestId('control-datum-chip').textContent).toContain('WORK COORDINATES')
    expect(screen.getByTestId('control-next-action').textContent)
      .toContain('Load a checked program or prepare a material-fit trace.')
    expect(screen.getByTestId('control-next-action').textContent).not.toMatch(/home/i)
  })
})
