// @vitest-environment jsdom

// WO-2000 (readiness walk finding 10, 2026-09-25): after probing had set G54,
// the console still said 'Work zero not set on X/Y/Z - travel is unchecked'.
// Acceptance: probe Z then X/Y -> no such line; an unset axis -> one line.
// Driven through the real machine session with the simulated controller.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { createElement } from 'react'
import { createDefaultControllerDefinition, type MachineConfig } from '../../types'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'

vi.mock('../../components/machine/ProgramPreview', () => typedMock<typeof import('../../components/machine/ProgramPreview')>({
  ProgramPreview: () => createElement('div', { 'data-testid': 'program-preview-stub' }),
}))

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  runZProbeCycle,
  setSimulatedPart,
  __resetEstopInterlockForTest,
  setWorkOffsetValue,
  transferReview,
  zeroWorkAxes,
} = await import('../../lib/machine/machineSession')

const NAG = 'Work zero not set on '
/** A distinct program per test: the review remembers the loaded program, and
 *  the same text loaded again is the same program to it. */
let programSerial = 0
function program(): string {
  programSerial += 1
  return `G21 G90 G54\n(wo2000 fixture ${programSerial})\nG1 X10 Y10 Z5 F100\nM30`
}

function machine(overrides: Partial<MachineConfig> = {}): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  controllerDefinition.axes = controllerDefinition.axes.map((axis) => ({
    ...axis,
    maxVelocity: axis.axis === 'X' ? 1000 : axis.axis === 'Y' ? 900 : 500,
    softLimitMin: 0,
    softLimitMax: axis.axis === 'X' ? 100 : axis.axis === 'Y' ? 80 : 50,
  }))
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
    controller: 'grbl' as const,
    key: axisSoftLimitStatementKey(axis.axis, end),
  })))
  return makeMachine({
    id: 'control-machine',
    name: 'Spare',
    controller: 'grbl',
    travel: { x: 100, y: 80, z: 50 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    axisLimits: {
      x: { maxCutting: 1000, maxRapid: 3000 },
      y: { maxCutting: 900, maxRapid: 3000 },
      z: { maxCutting: 500, maxRapid: 1200 },
    },
    controllerDefinition,
    maxSpindleRpm: 24000,
    ...overrides,
  })
}

function nagLines(): string[] {
  return useMachineControl.getState().consoleLines
    .map((line) => line.text)
    .filter((text) => text.startsWith(NAG))
}

function nagsAfter(mark: number): string[] {
  return useMachineControl.getState().consoleLines
    .slice(mark)
    .map((line) => line.text)
    .filter((text) => text.startsWith(NAG))
}

async function settle(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
}

describe.each(['uccnc', 'grbl'] as const)('WO-2000 (%s simulator): the work-zero nag stops once the axis is set', (controller) => {
  beforeEach(async () => {
    vi.useFakeTimers()
    const target = machine({ controller })
    const camMachine = machine({ id: 'cam-machine', name: 'LienCNC V2', controller })
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: camMachine },
      machineLibrary: [camMachine, target],
      control: { activeMachineId: target.id },
      // WO-3184: a G54 stored by an earlier test is handed to the simulator at connect.
      machineWorkOffsets: {},
    }))
    useMachineControl.setState({ activeWcs: 'G54', offsets: {}, consoleLines: [] })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(350)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    // WO-3189 seeds the setup's stock box at every simulator connect; this
    // fixture probes the machine's flat pad, so it says no part is placed (a
    // placed part replaces the pad by design, WO-416).
    setSimulatedPart(null)
  })

  afterEach(async () => {
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('probe Z, then probe X/Y: no nag remains and none is printed once they are set', async () => {
    act(() => { loadMachineProgram('probe-then-run.nc', program()) })
    expect(transferReview().result.notes.filter((note) => note.startsWith(NAG))).toHaveLength(3)

    // Probe Z (the probe confirmation writes the measured Z of G54).
    let mark = useMachineControl.getState().consoleLines.length
    act(() => { expect(setWorkOffsetValue('G54', 'Z', -42.5)).toBe(true) })
    await settle()
    expect(transferReview().result.notes).toEqual([
      'Work zero not set on X - travel on X is unchecked until you set it.',
      'Work zero not set on Y - travel on Y is unchecked until you set it.',
    ])
    expect(nagsAfter(mark).some((line) => line.startsWith(`${NAG}Z`))).toBe(false)

    // Probe X/Y - one synchronous pass, one write, as the probe panels do.
    mark = useMachineControl.getState().consoleLines.length
    act(() => {
      expect(setWorkOffsetValue('G54', 'X', 12.25)).toBe(true)
      expect(setWorkOffsetValue('G54', 'Y', 7.75)).toBe(true)
    })
    await settle()
    expect(transferReview().result.notes).toEqual([])
    expect(nagsAfter(mark)).toEqual([])
  })

  it('a typed or DRO zero of every axis leaves no nag', async () => {
    act(() => { loadMachineProgram('zero-then-run.nc', program()) })
    const mark = useMachineControl.getState().consoleLines.length
    act(() => { zeroWorkAxes(['X', 'Y', 'Z']) })
    await settle()
    expect(transferReview().result.notes).toEqual([])
    expect(nagsAfter(mark)).toEqual([])
  })

  it('an axis still unset is told exactly once', async () => {
    act(() => { loadMachineProgram('z-only.nc', program()) })
    act(() => { expect(setWorkOffsetValue('G54', 'Z', -42.5)).toBe(true) })
    await settle()
    act(() => { expect(setWorkOffsetValue('G54', 'X', 12.25)).toBe(true) })
    await settle()
    expect(transferReview().result.notes).toEqual([
      'Work zero not set on Y - travel on Y is unchecked until you set it.',
    ])
    expect(nagLines().filter((line) => line.startsWith(`${NAG}Y`))).toHaveLength(1)
    expect(nagLines().filter((line) => line.startsWith(`${NAG}X`))).toHaveLength(1)
    expect(nagLines().filter((line) => line.startsWith(`${NAG}Z`))).toHaveLength(1)
  })
})

// The pad Z0 cycle writes its zero with a contact-time G10 and stamps the axis
// AFTER that line is answered - the path the readiness walk probed.
describe.each(['uccnc', 'grbl'] as const)('WO-2000 (%s simulator): Probe work Z0 through the pad', (controller) => {
  beforeEach(async () => {
    vi.useFakeTimers()
    // Sim: virtual pad at machine Z -40, power-on Z -5 (zProbeRunner's frame).
    const base = machine({ controller })
    const target: MachineConfig = {
      ...base,
      controllerDefinition: undefined,
      travel: { x: 100, y: 100, z: 100 },
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      },
    }
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: { ...target, id: 'cam-machine', name: 'LienCNC V2' } },
      machineLibrary: [{ ...target, id: 'cam-machine', name: 'LienCNC V2' }, target],
      control: { activeMachineId: target.id },
      // WO-3184: a G54 stored by an earlier test is handed to the simulator at connect.
      machineWorkOffsets: {},
    }))
    useMachineControl.setState({ activeWcs: 'G54', offsets: {}, consoleLines: [] })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    await vi.advanceTimersByTimeAsync(50)
    // WO-3189 seeds the setup's stock box at every simulator connect; this
    // fixture probes the machine's flat pad, so it says no part is placed (a
    // placed part replaces the pad by design, WO-416).
    setSimulatedPart(null)
  })

  afterEach(async () => {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('probe Z through the pad: the Z nag is gone the moment the zero lands', async () => {
    const program = 'G21 G90 G54\nG1 X10 Y10 Z-5 F100\nM30'
    act(() => { loadMachineProgram('pad-probe.nc', program) })
    expect(transferReview().result.notes.some((note) => note.startsWith(`${NAG}Z`))).toBe(true)

    const cycle = runZProbeCycle('workZero', { fastFeed: 6000, slowFeed: 600, retract: 2, maxTravel: 50, padThickness: 10 })
    let done = false
    void cycle.finally(() => { done = true })
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(50)
    const result = await cycle
    expect(result.ok).toBe(true)
    await settle()

    expect(transferReview().result.notes.some((note) => note.startsWith(`${NAG}Z`))).toBe(false)
  })
})
