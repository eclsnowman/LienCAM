// MACHINE-CONTROL stage 10: the fixed-pad Z probe cycle runner, end to end
// through machineSession -> GrblController -> SimulatedGrblTransport, with
// results landing in the real machineControlStore.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMachineControl } from '../../store/machineControlStore'
import {
  __resetEstopInterlockForTest,
  activeToolLengthDatum,
  applyToolLengthOffset,
  clearToolLengthOffset,
  connectMachine,
  disconnectMachine,
  getMachineController,
  isProbeCycleActive,
  recoverFromProbeAlarm,
  runZProbeCycle,
  setSimulatedPart,
} from '../../lib/machine/machineSession'
import type { ZProbeConfig } from '../../lib/machine/toolTable'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { useCamStore } from '../../store'
import { createDefaultControllerDefinition } from '../../types'

// Sim: virtual pad at machine Z -40, power-on position Z -5. Feeds are fast so
// cycles finish in ~1s of simulated time.
const CONFIG: ZProbeConfig = { fastFeed: 6000, slowFeed: 600, retract: 2, maxTravel: 50, padThickness: 10 }

async function connect() {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'z-probe-negative-machine',
    name: 'Z probe negative-frame fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  // One status poll so the idle state lands before the runner's guards check it.
  await vi.advanceTimersByTimeAsync(50)
  // WO-3189 seeds the setup's stock box at every simulator connect; this
  // fixture is the machine's flat pad, so it says no part is placed. A placed
  // part replaces the pad by design (WO-416), so the pad route needs this.
  setSimulatedPart(null)
}

/** Drive a runner promise to completion under fake timers. */
async function finish<T>(p: Promise<T>, ms = 5000): Promise<T> {
  let out: T | undefined
  let done = false
  void p.then((v) => {
    out = v
    done = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  expect(done).toBe(true)
  return out!
}

beforeEach(async () => {
  vi.useFakeTimers()
  await connect()
})

afterEach(async () => {
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  vi.useRealTimers()
})

describe('runZProbeCycle', () => {
  it('workZero: probes the part and sets work Z0 at the contact (WO-2059: no pad by default)', async () => {
    const result = await finish(runZProbeCycle('workZero', CONFIG))
    expect(result.ok).toBe(true)
    expect(result.probedMachineZ).toBeCloseTo(-40, 1)
    expect(result.message).toContain('Work Z0')
    const s = useMachineControl.getState()
    // Contact at -40; the probe touched the part, so work Z0 sits at machine -40.
    expect(s.offsets.G54?.[2]).toBeCloseTo(-40, 1)
    expect(s.probe?.success).toBe(true)
    expect(s.machineState).toBe('idle')
    expect(isProbeCycleActive()).toBe(false)
  })

  it('workZero: the text backend uses the declared bottom beyond the inherited shared cap', async () => {
    const machine = useCamStore.getState().project.machine
    const controllerDefinition = createDefaultControllerDefinition()
    const z = controllerDefinition.axes.find((axis) => axis.axis === 'Z')!
    z.softLimitMin = -60
    // WO-1798 follow-up: state both ends, the way the Machine area does;
    // raw numbers without the statement pair are not a declared bottom.
    controllerDefinition.stated = [
      { controller: machine.controller, key: axisSoftLimitStatementKey('Z', 'min') },
      { controller: machine.controller, key: axisSoftLimitStatementKey('Z', 'max') },
    ]
    useCamStore.getState().setControlSessionMachine({
      ...machine,
      controllerDefinition,
      probeOverrides: undefined,
    })
    const lines: string[] = []
    const ctrl = getMachineController()
    const send = ctrl.sendCommandAwait.bind(ctrl)
    vi.spyOn(ctrl, 'sendCommandAwait').mockImplementation((line) => {
      lines.push(line)
      return send(line)
    })

    const result = await finish(runZProbeCycle('workZero', CONFIG))

    expect(result.ok).toBe(true)
    expect(lines.find((line) => line.includes('G38.2'))).toBe('G21 G91 G38.2 Z-55 F6000')
  })

  it('workZero: the text backend clamps its fine command at the same declared bottom', async () => {
    const machine = useCamStore.getState().project.machine
    const controllerDefinition = createDefaultControllerDefinition()
    const z = controllerDefinition.axes.find((axis) => axis.axis === 'Z')!
    z.softLimitMin = -40
    controllerDefinition.stated = [
      { controller: machine.controller, key: axisSoftLimitStatementKey('Z', 'min') },
      { controller: machine.controller, key: axisSoftLimitStatementKey('Z', 'max') },
    ]
    useCamStore.getState().setControlSessionMachine({
      ...machine,
      controllerDefinition,
      probeOverrides: undefined,
    })
    const lines: string[] = []
    const ctrl = getMachineController()
    const send = ctrl.sendCommandAwait.bind(ctrl)
    vi.spyOn(ctrl, 'sendCommandAwait').mockImplementation((line) => {
      lines.push(line)
      return send(line)
    })

    const result = await finish(runZProbeCycle('workZero', CONFIG))
    const probeLines = lines.filter((line) => line.includes('G38.2'))

    expect(result.ok).toBe(true)
    expect(probeLines).toEqual([
      'G21 G91 G38.2 Z-35 F6000',
      'G91 G38.2 Z-2 F600',
    ])
  })

  it('measureTool: returns the contact Z without touching the work offset', async () => {
    const result = await finish(runZProbeCycle('measureTool', CONFIG))
    expect(result.ok).toBe(true)
    expect(result.probedMachineZ).toBeCloseTo(-40, 1)
    expect(activeToolLengthDatum()).toBeCloseTo(-40, 1)
    const s = useMachineControl.getState()
    expect(s.offsets.G54?.[2] ?? 0).toBeCloseTo(0, 3) // untouched
  })

  it('a second cycle is refused while one is running', async () => {
    const first = runZProbeCycle('measureTool', CONFIG)
    const second = await runZProbeCycle('measureTool', CONFIG)
    expect(second.ok).toBe(false)
    expect(second.message).toContain('already running')
    const result = await finish(first)
    expect(result.ok).toBe(true)
  })

  it('miss: fails loudly with recovery text and recoverFromProbeAlarm restores idle', async () => {
    // Pad is at -40 but max travel only reaches -25: guaranteed miss.
    const result = await finish(runZProbeCycle('workZero', { ...CONFIG, maxTravel: 20 }))
    expect(result.ok).toBe(false)
    expect(result.probedMachineZ).toBeNull()
    expect(result.message).toContain('never made contact')
    expect(result.message).toContain('Unlock')
    expect(useMachineControl.getState().machineState).toBe('alarm')
    // Work offset untouched by the failed cycle.
    expect(useMachineControl.getState().offsets.G54?.[2] ?? 0).toBeCloseTo(0, 3)
    expect(recoverFromProbeAlarm()).toBe(true)
    await vi.advanceTimersByTimeAsync(1200) // unlock + status poll
    const s = useMachineControl.getState()
    expect(s.machineState).toBe('idle')
    expect(s.parserModal?.distanceMode).toBe('absolute') // G90 restored
  })

  it('refuses to start when the machine is not idle', async () => {
    getMachineController().jog('X', 60, 600) // 6s jog keeps the machine busy
    await vi.advanceTimersByTimeAsync(1100) // let a status poll report Jog
    const result = await finish(runZProbeCycle('workZero', CONFIG))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('idle')
  })
})

describe('tool length offset helpers', () => {
  it('G43.1 applies and G49 clears the TLO on the controller', async () => {
    expect(applyToolLengthOffset(1.5)).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(useMachineControl.getState().tlo).toBeCloseTo(1.5, 3)
    expect(clearToolLengthOffset()).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(useMachineControl.getState().tlo).toBe(0)
  })
})
