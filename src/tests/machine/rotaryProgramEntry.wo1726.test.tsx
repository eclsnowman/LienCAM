// @vitest-environment jsdom
//
// WO-1726 - rotary words survive the application's real file and MDI doors.
// These are real machineSession entry points over the real simulator. No move
// payload is hand-built and no controller command receipt is mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultControllerDefinition, type AxisName, type MachineConfig, type Project } from '../../types'
import { makeMachine } from '../post/helpers'

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __reportWorkOffsetsForTest,
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

function rotaryMachine(rotary: readonly Extract<AxisName, 'A' | 'B' | 'C'>[]): MachineConfig {
  const definition = createDefaultControllerDefinition(['X', 'Y', 'Z', ...rotary])
  for (const axis of definition.axes) {
    axis.enabled = true
    if (axis.axis === 'X' || axis.axis === 'Y' || axis.axis === 'Z') {
      axis.softLimitMin = -1_000
      axis.softLimitMax = 1_000
    }
  }
  return makeMachine({
    id: `wo1726-${rotary.join('').toLowerCase()}`,
    name: `WO-1726 ${rotary.join('/')} machine`,
    rapidRate: 600_000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    controllerDefinition: definition,
  })
}

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

beforeEach(() => {
  vi.useFakeTimers()
  const state = useCamStore.getState()
  originalProject = state.project
  originalLibrary = state.machineLibrary
  originalControl = state.control
  useMachineControl.setState({ consoleLines: [], offsets: {} })
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(500)
    await pending
  }
  useCamStore.setState({ project: originalProject, machineLibrary: originalLibrary, control: originalControl })
  useMachineControl.setState({ consoleLines: [], offsets: {} })
  vi.useRealTimers()
})

async function connect(machine: MachineConfig): Promise<void> {
  useCamStore.setState((state) => ({
    project: { ...state.project, machine },
    machineLibrary: [machine],
    control: {
      ...state.control,
      activeMachineId: null,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  }))
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(500)
  await pending
  __resetEstopInterlockForTest()
  if (!getMachineController().home()) throw new Error('The simulator refused the homed fixture.')
  await vi.advanceTimersByTimeAsync(2_000)
  getMachineController().refreshState()
}

async function setRotaryOffsets(words: string): Promise<void> {
  const receipt = getMachineController().sendCommandAwait(`G21 G10 L2 P1 X0 Y0 Z0 ${words}`)
  if (receipt === null) throw new Error('The simulator exposed no acknowledged command route.')
  await expect(receipt).resolves.toEqual({ ok: true, message: null })
  const current = getMachineController().status().machinePos!
  const work = getMachineController().status().workPos!
  __reportWorkOffsetsForTest({
    G54: {
      x: current.x - work.x,
      y: current.y - work.y,
      z: current.z - work.z,
      ...(typeof current.a === 'number' && typeof work.a === 'number' ? { a: current.a - work.a } : {}),
      ...(typeof current.b === 'number' && typeof work.b === 'number' ? { b: current.b - work.b } : {}),
      ...(typeof current.c === 'number' && typeof work.c === 'number' ? { c: current.c - work.c } : {}),
    },
  })
}

async function runLoadedProgram(): Promise<void> {
  await expect(executeOperatorCycleStart()).resolves.toBe(true)
  // The simulator paces by the acceleration plan (WO-2024/2028), so run until
  // the job ends rather than for a fixed window; bounded at 60 s of fake time.
  for (let waited = 0; waited < 60_000 && getMachineController().hasActiveJob(); waited += 500) {
    await vi.advanceTimersByTimeAsync(500)
  }
  expect(getMachineController().hasActiveJob()).toBe(false)
}

describe('WO-1726 rotary application entry', () => {
  it('loads independent A through the production file door and observes the simulated readback', async () => {
    await connect(rotaryMachine(['A']))
    await setRotaryOffsets('A15')

    expect(loadGcodeTextToolpathProgram(
      'rotary-a.nc',
      ['G21 G90 G54', 'G1 X10 A90 F600000', 'M30'].join('\n'),
    )).toEqual({ ok: true, reason: null })
    await runLoadedProgram()

    expect(getMachineController().status().machinePos).toMatchObject({ x: 10, a: 105 })
    expect(getMachineController().status().workPos).toMatchObject({ x: 10, a: 90 })
  })

  it('runs an ordinary XY arc without turning carried A state into a rotary command', async () => {
    await connect(rotaryMachine(['A']))
    await setRotaryOffsets('A15')

    expect(loadGcodeTextToolpathProgram(
      'cartesian-arc-with-modal-a.nc',
      [
        'G21 G90 G54',
        'G1 X10 Y0 A90 F600000',
        'G2 X20 Y0 I5 J0 F600000',
        'G1 X30',
        'M30',
      ].join('\n'),
    )).toEqual({ ok: true, reason: null })
    await runLoadedProgram()

    expect(getMachineController().status().machinePos).toMatchObject({ x: 30, y: 0, a: 105 })
    expect(getMachineController().status().workPos).toMatchObject({ x: 30, y: 0, a: 90 })
  })

  it('keeps sparse B/C indexes through inch, G53, incremental, and geometry-MDI routes', async () => {
    await connect(rotaryMachine(['B', 'C']))
    await setRotaryOffsets('B45 C90')

    expect(loadGcodeTextToolpathProgram(
      'rotary-bc.nc',
      [
        'G20 G90 G54',
        'G1 X1 B60 C120 F30000',
        'G53 G0 B100 C200',
        'G91 G1 X1 B5 C10',
        'M30',
      ].join('\n'),
    )).toEqual({ ok: true, reason: null })
    await runLoadedProgram()

    expect(getMachineController().status().machinePos).toMatchObject({ x: 50.8, b: 105, c: 210 })
    expect(getMachineController().status().workPos).toMatchObject({ x: 50.8, b: 60, c: 120 })

    // Force the same real simulator behind the geometry-controller MDI door;
    // only the advertised text capability changes. The staged program and its
    // readback remain the simulator's, not a fake controller call.
    getMachineController().capabilities.gcodeText = false
    expect(sendMdiLine('G90 G1 B30 C40 F600000')).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getMachineController().status().workPos).toMatchObject({ b: 30, c: 40 })
    expect(getMachineController().status().machinePos).toMatchObject({ b: 75, c: 130 })

    expect(sendMdiLine('G90 G1 X10 Y0 F600000')).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sendMdiLine('G2 X20 Y0 I5 J0 F600000')).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getMachineController().status().workPos).toMatchObject({ x: 20, y: 0, b: 30, c: 40 })
    expect(getMachineController().status().machinePos).toMatchObject({ x: 20, y: 0, b: 75, c: 130 })
  })

  it('refuses a rotary arc before replacing the staged program', async () => {
    await connect(rotaryMachine(['A']))
    await setRotaryOffsets('A15')
    expect(loadGcodeTextToolpathProgram(
      'straight-a.nc',
      ['G21 G90 G54', 'G1 X10 A90 F600000', 'M30'].join('\n'),
    ).ok).toBe(true)
    const totalBefore = getMachineController().programProgress?.().total

    const refused = loadGcodeTextToolpathProgram(
      'rotary-arc.nc',
      ['G21 G90 G54', 'G0 X0 Y0', 'G2 X10 Y0 I5 J0 A90 F600', 'M30'].join('\n'),
    )

    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('rotary A/B/C word on an arc is not modeled')
    expect(getMachineController().programProgress?.().total).toBe(totalBefore)

    getMachineController().capabilities.gcodeText = false
    expect(sendMdiLine('G2 X20 Y0 I5 J0 A120 F600')).toBe(false)
    expect(getMachineController().programProgress?.().total).toBe(totalBefore)
  })
})
