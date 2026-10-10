// WO-1202: the simulator reports and acts on the selected machine's limit
// wiring. Every case enters through machineSession.connectMachine so the
// production construction path, not a hand-built option bag, is the subject.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} from '../../lib/machine/machineSession'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import {
  createDefaultControllerDefinition,
  type ControllerDefinition,
  type MachineConfig,
} from '../../types'

const HARD_LIMIT_REASON = 'X positive limit switch was triggered at the end of declared travel. '
  + 'Motion was stopped.'
const HARD_LIMIT_MINUS_REASON = 'X negative limit switch was triggered at the end of declared travel. '
  + 'Motion was stopped.'
const SOFT_LIMIT_REASON = 'X positive soft limit was exceeded in motion. Motion was stopped.'

function definition(wired: boolean, side: 'minus' | 'plus' = 'plus'): ControllerDefinition {
  const result = createDefaultControllerDefinition(['X', 'Y', 'Z'])
  result.axes = result.axes.map((axis) => ({
    ...axis,
    softLimitMin: 0,
    softLimitMax: 100,
    limitMinusPin: wired && side === 'minus' && axis.axis === 'X'
      ? { port: 2, pin: 1, negate: false }
      : axis.limitMinusPin,
    limitPlusPin: wired && side === 'plus' && axis.axis === 'X'
      ? { port: 2, pin: 2, negate: false }
      : axis.limitPlusPin,
  }))
  result.stated = result.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
    controller: 'uccnc' as const,
    key: axisSoftLimitStatementKey(axis.axis, end),
  })))
  return result
}

function machine(wired: boolean, side: 'minus' | 'plus' = 'plus'): MachineConfig {
  return {
    id: `wo1202-${wired ? 'wired' : 'unwired'}`,
    name: `WO-1202 ${wired ? 'wired' : 'unwired'} limits`,
    type: 'gantry_router',
    controller: 'uccnc',
    travel: { x: 100, y: 100, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    rapidRate: 60_000,
    minSpindleRpm: 0,
    maxSpindleRpm: 24_000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
    controllerDefinition: definition(wired, side),
  }
}

async function connectSelectedMachine(wired: boolean, side: 'minus' | 'plus' = 'plus') {
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: machine(wired, side) },
    control: {
      ...state.control,
      activeMachineId: null,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  }))
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(1)
  await pending
  __resetEstopInterlockForTest()
  return getMachineController()
}

describe('WO-1202 simulated limit inputs through machineSession', () => {
  let originalMachine: MachineConfig
  let originalControl: ReturnType<typeof useCamStore.getState>['control']
  let originalConsoleLines: ReturnType<typeof useMachineControl.getState>['consoleLines']

  beforeEach(() => {
    vi.useFakeTimers()
    const state = useCamStore.getState()
    originalMachine = state.project.machine
    originalControl = structuredClone(state.control)
    originalConsoleLines = [...useMachineControl.getState().consoleLines]
    useMachineControl.setState({ consoleLines: [], alarm: null })
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      await disconnectMachine()
    }
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: originalMachine },
      control: originalControl,
    }))
    useMachineControl.setState({ consoleLines: originalConsoleLines, alarm: null })
    vi.useRealTimers()
  })

  it('distinguishes wired-open inputs from an unwired machine', async () => {
    const wired = await connectSelectedMachine(true)
    expect(wired.status().inputs).toMatchObject({
      hardLimit: false,
      softLimit: false,
      limits: { x: false, y: false, z: false },
      limitMinus: { X: null, Y: null, Z: null },
      limitPlus: { X: false, Y: null, Z: null },
    })
    await disconnectMachine()

    const unwired = await connectSelectedMachine(false)
    expect(unwired.status().inputs).toMatchObject({
      hardLimit: false,
      softLimit: false,
      limits: null,
      limitMinus: { X: null, Y: null, Z: null },
      limitPlus: { X: null, Y: null, Z: null },
    })
  })

  it('makes the wired X+ switch at travel end, alarms, and prints its named reason', async () => {
    const controller = await connectSelectedMachine(true)
    expect(controller.status().machinePos?.x).toBe(5)
    // This case isolates limit behavior, not the fresh-connect E-STOP latch.
    __resetEstopInterlockForTest()

    expect(controller.jog('X', 95, 60_000)).toBe(true)
    expect(controller.machineState()).toBe('jog')
    await vi.advanceTimersByTimeAsync(100)

    expect(controller.status().inputs).toMatchObject({
      hardLimit: true,
      softLimit: false,
      limits: { x: true, y: false, z: false },
      limitMinus: { X: null },
      limitPlus: { X: true },
    })
    expect(controller.machineState()).toBe('alarm')
    expect(useMachineControl.getState().alarm?.message).toBe(HARD_LIMIT_REASON)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toBe(`Alarm: ${HARD_LIMIT_REASON} No re-home needed - the position readout shows where the machine is now.`)
  })

  it('releases a wired X- switch after homing and trips it on later motion', async () => {
    const controller = await connectSelectedMachine(true, 'minus')
    if (!controller.homeAxes) throw new Error('The simulator must support per-axis homing.')
    // This case isolates limit behavior after an operator CLEAR.
    __resetEstopInterlockForTest()

    expect(controller.homeAxes(['X'])).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(controller.machineState()).toBe('idle')
    expect(controller.status().machinePos?.x).toBe(0)
    expect(controller.status().inputs).toMatchObject({
      hardLimit: false,
      limits: { x: false, y: false, z: false },
      home: { X: false },
      limitMinus: { X: false },
      limitPlus: { X: null },
    })
    expect(useMachineControl.getState().alarm).toBeNull()

    expect(controller.jog('X', 5, 60_000)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(controller.status().inputs?.limitMinus?.X).toBe(false)

    expect(controller.jog('X', -5, 60_000)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(controller.machineState()).toBe('alarm')
    expect(controller.status().inputs).toMatchObject({
      hardLimit: true,
      limits: { x: true, y: false, z: false },
      limitMinus: { X: true },
    })
    expect(useMachineControl.getState().alarm?.message).toBe(HARD_LIMIT_MINUS_REASON)
  })

  it('keeps the program-start envelope refusal before any motion begins', async () => {
    const controller = await connectSelectedMachine(false)
    expect(controller.setMachinePosition?.({ x: 5, y: 5, z: 5 })).toBe(true)
    if (!controller.loadMoves) throw new Error('The simulator must support machine programs.')
    controller.loadMoves([
      { id: 1, kind: 'line', to: { x: 100.02 }, feedMmMin: 60_000 },
    ])

    expect(controller.startJob()).toBe(false)
    expect(controller.machineState()).toBe('alarm')
    expect(controller.status().machinePos?.x).toBe(5)
    expect(useMachineControl.getState().alarm?.message)
      .toBe("This program would move outside the machine's declared travel - refusing to start it.")
  })

  it('names the program\'s unset work offset and the control that fixes it (machine session 10-08, Full Suite G57)', async () => {
    const controller = await connectSelectedMachine(false)
    expect(controller.setMachinePosition?.({ x: 5, y: 5, z: 5 })).toBe(true)
    if (!controller.loadMoves) throw new Error('The simulator must support machine programs.')
    useMachineControl.setState({
      programText: 'G90 G21\nG57\nG0 X100.02',
      offsets: { G54: [300, 300, 8], G57: [0, 0, 0] },
    })
    controller.loadMoves([
      { id: 1, kind: 'line', to: { x: 100.02 }, feedMmMin: 60_000 },
    ])

    expect(controller.startJob()).toBe(false)
    const refusal = useMachineControl.getState().consoleLines
      .map((line) => line.text)
      .find((text) => text.includes('declared travel'))
    expect(refusal).toContain('The program runs in G57, whose zero is not set (0, 0, 0). Set the G57 zero on the Offsets tab, then press CYCLE START.')
    expect(refusal).not.toContain('No re-home needed')
  })

  it('keeps the pre-flight refusal and catches a tolerated in-flight overshoot as a soft limit', async () => {
    const controller = await connectSelectedMachine(false)
    // This case isolates limit behavior, not the fresh-connect E-STOP latch.
    __resetEstopInterlockForTest()

    expect(controller.jog('X', 95.02, 60_000)).toBe(false)
    expect(controller.machineState()).toBe('idle')
    expect(controller.status().inputs?.softLimit).toBe(false)

    // The shared 0.01 mm fit tolerance admits this endpoint at pre-flight.
    // Motion integration then observes the actual out-of-envelope endpoint.
    expect(controller.jog('X', 95.005, 60_000)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)

    expect(controller.machineState()).toBe('alarm')
    expect(controller.status().machinePos?.x).toBeCloseTo(100.005, 6)
    expect(controller.status().inputs).toMatchObject({
      hardLimit: false,
      softLimit: true,
      limits: null,
      limitPlus: { X: null },
    })
    expect(useMachineControl.getState().alarm?.message).toBe(SOFT_LIMIT_REASON)
  })
})
