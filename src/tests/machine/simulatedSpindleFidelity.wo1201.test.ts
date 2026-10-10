// WO-1201: the native simulator is built from the selected machine's spindle
// facts, then reports a timed shaft-speed model through MachineStatus. These
// tests deliberately enter through machineSession.connectMachine('simulator')
// rather than constructing SimulatedController with a hand-built option bag.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  sendMdiLine,
} from '../../lib/machine/machineSession'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import type { MachineConfig, MachineSpindleLinkDefinition } from '../../types'

const LINK = structuredClone(HUANYANG_GT) as MachineSpindleLinkDefinition
const MAX_CLAMP = 'M3 S13000 was clamped to 12000 RPM: this machine allows 6000-12000 RPM.'
const MIN_CLAMP = 'M3 S5000 was clamped to 6000 RPM: this machine allows 6000-12000 RPM.'
const DIRECTION_REFUSAL = "M4 was refused: this machine's spindle is configured for clockwise rotation only."

function machine(spindleLinkDefinition: MachineSpindleLinkDefinition | null): MachineConfig {
  return {
    id: 'wo1201-simulated-spindle',
    name: 'WO-1201 simulated spindle',
    type: 'gantry_router',
    controller: 'uccnc',
    travel: { x: 300, y: 300, z: 100 },
    rapidRate: 4000,
    minSpindleRpm: 6000,
    maxSpindleRpm: 12000,
    spindleDirection: 'cw',
    spindleLinkDefinition,
    toolChanger: 'manual',
    coolant: false,
    notes: '',
  }
}

async function connectSelectedMachine(spindleLinkDefinition: MachineSpindleLinkDefinition | null) {
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: machine(spindleLinkDefinition) },
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

describe('WO-1201 simulated spindle fidelity through machineSession', () => {
  let originalMachine: MachineConfig
  let originalControl: ReturnType<typeof useCamStore.getState>['control']
  let originalConsoleLines: ReturnType<typeof useMachineControl.getState>['consoleLines']

  beforeEach(() => {
    vi.useFakeTimers()
    const state = useCamStore.getState()
    originalMachine = state.project.machine
    originalControl = structuredClone(state.control)
    originalConsoleLines = [...useMachineControl.getState().consoleLines]
    useMachineControl.setState({ consoleLines: [] })
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      await disconnectMachine()
    }
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: originalMachine },
      control: originalControl,
    }))
    useMachineControl.setState({ consoleLines: originalConsoleLines })
    vi.useRealTimers()
  })

  it('clamps speeds to the selected machine range and names each clamp once in the console', async () => {
    const controller = await connectSelectedMachine(LINK)

    expect(sendMdiLine('M3 S13000')).toBe(true)
    expect(sendMdiLine('M3 S5000')).toBe(true)
    expect(controller.status().spindleRpm).toBe(0)

    const clamps = useMachineControl.getState().consoleLines
      .filter((line) => line.text === MAX_CLAMP || line.text === MIN_CLAMP)
    expect(clamps.map((line) => line.text)).toEqual([MAX_CLAMP, MIN_CLAMP])
    expect(clamps.every((line) => line.severity === 'warn')).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(controller.status().spindleRpm).toBe(6000)
  })

  it('refuses the disallowed M4 direction by name on both MDI and program paths', async () => {
    const controller = await connectSelectedMachine(LINK)

    expect(sendMdiLine('M4 S9000')).toBe(false)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toBe(DIRECTION_REFUSAL)
    expect(controller.loadJob('G21 G90\nM4 S9000\nM30')).toEqual({
      ok: false,
      reason: `Line 2: ${DIRECTION_REFUSAL}`,
    })
  })

  it('ramps up, becomes up-to-speed by the shared VFD tolerance, then ramps down after M5', async () => {
    const controller = await connectSelectedMachine(LINK)

    expect(sendMdiLine('M3 S9000')).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    const rampingUp = controller.status()
    expect(rampingUp.spindleRpm).toBeGreaterThan(0)
    expect(rampingUp.spindleRpm).toBeLessThan(9000)
    expect(rampingUp.spindle).toMatchObject({ running: true, linkUp: true, upToSpeed: false })
    expect(rampingUp.spindle).toMatchObject({ volts: null, amps: null, torque: null, power: null })

    await vi.advanceTimersByTimeAsync(450)
    const atSpeed = controller.status()
    expect(atSpeed.spindleRpm).toBe(9000)
    expect(atSpeed.spindle?.upToSpeed).toBe(true)

    expect(sendMdiLine('M5')).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    const rampingDown = controller.status()
    expect(rampingDown.spindleRpm).toBeGreaterThan(0)
    expect(rampingDown.spindleRpm).toBeLessThan(9000)
    expect(rampingDown.spindle).toMatchObject({ running: true, linkUp: true, upToSpeed: false })

    await vi.advanceTimersByTimeAsync(450)
    const stopped = controller.status()
    expect(stopped.spindleRpm).toBe(0)
    expect(stopped.spindle).toMatchObject({ running: false, linkUp: true, upToSpeed: false })

    console.info(
      `WO-1201 spindle transcript: M3 S9000 -> ramping rpm=${rampingUp.spindleRpm} upToSpeed=${rampingUp.spindle?.upToSpeed}`
      + ` -> at-speed rpm=${atSpeed.spindleRpm} upToSpeed=${atSpeed.spindle?.upToSpeed}`
      + ` -> M5 ramping rpm=${rampingDown.spindleRpm} running=${rampingDown.spindle?.running}`
      + ` -> stopped rpm=${stopped.spindleRpm} running=${stopped.spindle?.running}`,
    )
  })

  it('keeps the whole spindle block null when the selected machine has no link definition', async () => {
    const controller = await connectSelectedMachine(null)

    expect(controller.status().spindle).toBeNull()
    expect(sendMdiLine('M3 S9000')).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(controller.status().spindleRpm).toBeGreaterThan(0)
    expect(controller.status().spindleRpm).toBeLessThan(9000)
    expect(controller.status().spindle).toBeNull()
  })
})
