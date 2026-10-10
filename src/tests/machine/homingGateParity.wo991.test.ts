// WO-991: the app makes the same homing decision as the machine bridge before
// Cycle Start, a work-zero goto, or a machine-Z goto reaches a backend. The
// relative-jog escape hatch remains open while unhomed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import {
  createDefaultControllerDefinition,
  type ControllerDefinition,
} from '../../types'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  gotoWorkXYZero,
  jogToSafeZ,
  loadMachineProgram,
} from '../../lib/machine/machineSession'
import {
  currentOperatorTransport,
  executeOperatorCycleStart,
} from '../../lib/machine/operatorTransport'

const PROGRAM = ['G21 G90 G54', 'G0 X1 Y1 Z1', 'M30'].join('\n')

function switchedDefinition(): ControllerDefinition {
  const definition = createDefaultControllerDefinition()
  definition.axes.forEach((axis, index) => {
    axis.homePin = { port: 2, pin: index + 1, negate: false }
    axis.softLimitMin = 0
    axis.softLimitMax = 100
  })
  return definition
}

function consoleErrors(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.severity === 'error')
    .map((line) => line.text)
}

async function settle(ms = 2_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

async function homeAxes(axes: Array<'X' | 'Y' | 'Z'>): Promise<void> {
  const ctrl = getMachineController()
  if (!ctrl.homeAxes?.(axes)) throw new Error(`The simulator refused to home ${axes.join(', ')}.`)
  await settle()
}

describe('WO-991 homing gate parity', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    const machine = useCamStore.getState().project.machine!
    useCamStore.getState().updateMachine({
      ...machine,
      controllerDefinition: switchedDefinition(),
    })
    useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })

    const pending = connectMachine('simulator', 115200)
    await settle(300)
    await pending
    __resetEstopInterlockForTest()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (getMachineController().connectionPhase() !== 'disconnected') {
      getMachineController().emergencyStop()
      const pending = disconnectMachine()
      await settle(200)
      await pending
    }
    vi.useRealTimers()
  })

  it('refuses Cycle Start before the backend call, names every missing axis, and opens after homing', async () => {
    loadMachineProgram('homing-gate.nc', PROGRAM)
    expect(currentOperatorTransport()).toMatchObject({ action: 'start', cycleStartEnabled: true })

    const startJob = vi.spyOn(getMachineController(), 'startJob')
    expect(await executeOperatorCycleStart()).toBe(false)
    expect(startJob).not.toHaveBeenCalled()
    expect(consoleErrors()).toContain(
      'Cycle Start: refused - X, Y and Z have not been homed this session. '
      + 'Home them first - program motion depends on machine zero.',
    )

    await homeAxes(['X', 'Y', 'Z'])
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(startJob).toHaveBeenCalledTimes(1)
  })

  it('refuses work XY before the backend call, asks only for X and Y, and opens when they are homed', async () => {
    const jogToWorkXY = vi.spyOn(getMachineController(), 'jogToWorkXY')
    expect(gotoWorkXYZero(600)).toBe(false)
    expect(jogToWorkXY).not.toHaveBeenCalled()
    expect(consoleErrors()).toContain(
      'Goto work XY zero: refused - X and Y have not been homed this session. '
      + 'Home them first - a work offset is measured from machine zero.',
    )

    await homeAxes(['X', 'Y'])
    expect(gotoWorkXYZero(600)).toBe(true)
    expect(jogToWorkXY).toHaveBeenCalledTimes(1)
  })

  it('refuses machine Z before the backend call, asks only for Z, and opens when it is homed', async () => {
    // WO-2712: machine Z is -95..0 on the max-homed sample. The same
    // valid -10 target must be refused before homing and accepted after.
    const jogToMachineZ = vi.spyOn(getMachineController(), 'jogToMachineZ')
    expect(jogToSafeZ(-10, 600)).toEqual({
      ok: false,
      reason: 'Z has not been homed this session. Home it first - safe Z is a machine coordinate.',
    })
    expect(jogToMachineZ).not.toHaveBeenCalled()

    await homeAxes(['Z'])
    expect(jogToSafeZ(-10, 600)).toEqual({ ok: true })
    expect(jogToMachineZ).toHaveBeenCalledTimes(1)
  })

  it('still allows relative jog while unhomed so an axis can escape a limit switch', async () => {
    const ctrl = getMachineController()
    const before = ctrl.status().machinePos!.x

    expect(ctrl.jog('X', 5, 600)).toBe(true)
    await settle(1_000)

    expect(ctrl.status().machinePos!.x).toBeGreaterThan(before)
    expect(ctrl.homedThisSession()).toBe(false)
  })
})
