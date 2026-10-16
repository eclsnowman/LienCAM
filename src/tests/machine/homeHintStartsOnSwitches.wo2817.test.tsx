// @vitest-environment jsdom
//
// WO-2817: rendered guidance matches the proven Home that starts on switches.
// Oracle: the operator's words in the WO and machine-proven revert 313b6a630cfe.

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

let perAxisHoming = false
vi.mock('../../lib/machine/machineSession', async (importOriginal) => typedMock<typeof import('../../lib/machine/machineSession')>({
  ...await importOriginal<typeof import('../../lib/machine/machineSession')>(),
  controllerCapabilities: () => ({ geometryQueue: false, executingMoveId: false, bufferSeconds: false, outputInhibit: false, gcodeText: true, ownsSpindle: false, spindleCommands: false, machineProgram: false, perAxisHoming }),
}))

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

const OFF_SWITCH_INSTRUCTION = /off (?:its|the|their) home switch|check.*switch|driven into it|FIRST:/i

function renderFreshConnection(axisHoming = false): void {
  perAxisHoming = axisHoming
  seedFreshConnection()
  act(() => { __resetEstopInterlockForTest() })
  render(<ControlPage />)
}

describe('WO-2817 Home starts on the switches', () => {
  it('renders fresh-connect guidance to Home without an off-switch step', () => {
    renderFreshConnection()
    const line = screen.getByTestId('control-next-action').textContent!
    expect(line).not.toMatch(OFF_SWITCH_INSTRUCTION)
    expect(line).toContain('Home All')
    expect(line).toContain('before choosing a work-coordinate action')
  })

  it.each([false, true])('renders the Home All tooltip without an off-switch step (per-axis %s)', (axisHoming) => {
    renderFreshConnection(axisHoming)
    const hint = screen.getByTestId('control-home').getAttribute('data-tooltip')!
    expect(hint).not.toMatch(OFF_SWITCH_INSTRUCTION)
    expect(hint).toContain('Run the homing cycle')
    expect(hint).toContain(axisHoming ? 'Z, X, Y' : 'controller chooses its own axis order')
  })

  it('renders each per-axis Home tooltip without an off-switch step', () => {
    renderFreshConnection(true)
    for (const axis of ['x', 'y', 'z']) {
      const hint = screen.getByTestId(`control-home-${axis}`).getAttribute('data-tooltip')!
      expect(hint).not.toMatch(OFF_SWITCH_INSTRUCTION)
      expect(hint).toContain(`Home ${axis.toUpperCase()} ALONE`)
    }
  })

  it('renders the no-datum badge and tooltip without an off-switch step', () => {
    renderFreshConnection()
    const chip = screen.getByTestId('control-datum-chip')
    expect(chip.textContent).not.toMatch(OFF_SWITCH_INSTRUCTION)
    expect(chip.getAttribute('title')).not.toMatch(OFF_SWITCH_INSTRUCTION)
    expect(chip.getAttribute('title')).toContain('Home All')
  })

  it('keeps homed and switchless fresh-connect guidance', () => {
    renderFreshConnection()
    act(() => { useMachineControl.setState({ homed: true }) })
    expect(screen.queryByTestId('control-next-action')).toBeNull()
    act(() => { useMachineControl.setState({ activeWcs: 'G54' }) })
    expect(screen.getByTestId('control-next-action').textContent)
      .toContain('Load a checked program or prepare a material-fit trace.')
    cleanup()
    seedFreshConnection({ switchless: true })
    render(<ControlPage />)
    expect(screen.getByTestId('control-datum-chip').textContent).toContain('WORK COORDINATES')
    expect(screen.getByTestId('control-next-action').textContent).not.toMatch(/home/i)
  })
})
