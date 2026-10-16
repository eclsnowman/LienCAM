// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { createDefaultControllerDefinition, machineHomeConvention, type MachineConfig } from '../../types'
import { typedMock } from '../support/typedMock'
import { createSampleMachine } from '../../lib/machine/sampleMachine'
import { GENERIC_MACHINE_ID } from '../../lib/machine/machineChoice'
import { resolveMachineMotion } from '../../lib/machine/resolvedMachineMotion'

vi.mock('../../components/machine/ProgramPreview', () => typedMock<typeof import('../../components/machine/ProgramPreview')>({
  ProgramPreview: () => createElement('div', { 'data-testid': 'program-preview-stub' }),
}))

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  transferReview,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

// The machine seat's 10-07 desk file: a plain X/Y/Z program, comments first,
// whose first commanded axis is Z on line 6.
const PLAIN_FILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/final-session-programs/final-o9-comments-first.nc'),
  'utf8',
)
const initial = useCamStore.getInitialState()
const initialControl = useMachineControl.getState()

async function connectSimulatorWith(machine: MachineConfig): Promise<void> {
  useCamStore.setState({
    project: { ...initial.project, machine },
    machineLibrary: [machine],
  })
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(350)
  await pending
  await vi.advanceTimersByTimeAsync(50)
}

function load(): ReturnType<typeof loadMachineProgram> {
  return loadMachineProgram('final-o9-comments-first.nc', PLAIN_FILE, null)
}

describe('WO-2674 the sample router loads a plain file with no red line', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useCamStore.setState(initial, true)
    useMachineControl.setState({ ...initialControl, consoleLines: [] })
  })

  afterEach(async () => {
    cleanup()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
    useCamStore.setState(initial, true)
  })

  it('a fresh profile Controls the shipped sample router', () => {
    const fresh = useCamStore.getInitialState()
    expect(fresh.project.machine.id).toBe(GENERIC_MACHINE_ID)
    expect(fresh.project.machine).toEqual(createSampleMachine())
    expect(fresh.machineLibrary).toEqual([createSampleMachine()])
  })

  it('loads the plain X/Y/Z file on the fresh-profile sample with no refusal', async () => {
    const sample = useCamStore.getInitialState().project.machine
    await connectSimulatorWith(sample)
    const loaded = load()

    const { result } = transferReview()
    // On main this was three refusals; the desk check saw the first, Z on line 6.
    expect(result.refusals).toEqual([])
    expect(result.warnings).toEqual([])
    // WO-2775: the simulator reports its default G54 at connect, so Load
    // checks travel on every axis and no longer emits an unchecked-zero note.
    expect(result.notes).toEqual([])
    expect(JSON.stringify(useMachineControl.getState().consoleLines))
      .not.toContain('has no controller definition or resolved')
    expect(loaded.overlongLines).toEqual([])
    expect(loaded.lines.length).toBe(10)
    expect(useMachineControl.getState().programText).toBe(PLAIN_FILE)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })

  it('home, then Cycle Start runs the plain file - no envelope alarm moved downstream', async () => {
    const sample = useCamStore.getInitialState().project.machine
    await connectSimulatorWith(sample)
    // Clear the fresh-connection E-STOP latch, as the operator does.
    __resetEstopInterlockForTest()
    load()
    const ctrl = getMachineController()
    expect(ctrl.homeAxes?.(['X', 'Y', 'Z'])).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(await executeOperatorCycleStart()).toBe(true)
    const errors = useMachineControl.getState().consoleLines
      .filter((line) => line.severity === 'error')
      .map((line) => line.text)
    expect(errors).toEqual([])
  })

  it('the sample record: no definition; its stated travel and home end place the envelope (WO-2712)', () => {
    const sample = createSampleMachine()
    expect(sample.controllerDefinition).toBeUndefined()
    expect(machineHomeConvention(sample)).toEqual({
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'max', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    })
    const motion = resolveMachineMotion({ machine: sample, connectionKind: 'simulator' })
    for (const key of ['x', 'y', 'z'] as const) {
      expect(motion.axes[key].definitionState).toBe('missing-definition')
      expect(motion.axes[key].effective).toMatchObject({ min: key === 'z' ? -95 : -406, max: 0 })
    }
  })

  it('a machine with no definition and no stated home end still gets the line', async () => {
    // Same record as the sample, but a chosen machine: not the placeholder.
    // WO-2712: the sample now states its home end; this record does not.
    const unplaced: MachineConfig = { ...createSampleMachine(), id: 'unplaced-router', name: 'Unplaced router' }
    delete unplaced.homeConvention
    await connectSimulatorWith(unplaced)
    load()

    // The WO-1150 fail-closed contract, unchanged: nothing places this travel.
    expect(transferReview().result.refusals).toEqual([
      'X is commanded on line 7, but Unplaced router has no controller definition or resolved X Machine-page travel envelope.',
      'Y is commanded on line 7, but Unplaced router has no controller definition or resolved Y Machine-page travel envelope.',
      'Z is commanded on line 6, but Unplaced router has no controller definition or resolved Z Machine-page travel envelope.',
    ])
  })

  it('a sample whose definition disables Z still gets the disabled-axis line', async () => {
    const controllerDefinition = createDefaultControllerDefinition()
    controllerDefinition.axes = controllerDefinition.axes.map((axis) => axis.axis === 'Z'
      ? { ...axis, enabled: false }
      : axis)
    const noZ = { ...createSampleMachine(), name: 'Two-axis sample', controllerDefinition }
    await connectSimulatorWith(noZ)
    load()

    expect(transferReview().result.refusals)
      .toContain('Z is commanded on line 6, but Two-axis sample defines Z as disabled.')
  })
})
