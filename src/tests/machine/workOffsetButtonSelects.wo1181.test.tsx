// @vitest-environment jsdom
//
// WO-1181: what Operator hit at the machine on 2026-09-03 running the WO-1144 test.
//
// 1. The G54 button never registered. `selectWorkOffset()` sent the selection
//    to the controller but never wrote `activeWcs`; the only writers were a
//    typed G5x MDI line (no G-code text path on the AXBB-E) and a grbl `$G`
//    modal report (the UCCNC bridge sends none). So `workGotoZeroRefusal()`
//    read `activeWcs === null` and refused Goto XY0 forever.
// 2. Fresh connect, E-STOP latched, Goto XY0: total silence - the one refusal
//    in `gotoWorkXYZero()` with no console line.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultControllerDefinition, type MachineConfig } from '../../types'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  ESTOP_BLOCKS_MOTION,
  estopNeedsReset,
  getMachineController,
  gotoWorkXYZero,
  selectWorkOffset,
} from '../../lib/machine/machineSession'

function suppliedMachine(): MachineConfig {
  const base = structuredClone(useCamStore.getState().project.machine!)
  const definition = createDefaultControllerDefinition()
  definition.axes.forEach((axis, index) => {
    axis.stepPin = { port: 1, pin: 2 + index * 2, negate: false }
    axis.dirPin = { port: 1, pin: 3 + index * 2, negate: false }
  })
  delete definition.stated
  return {
    ...base,
    id: 'wo-1181-uccnc',
    name: 'WO-1181 UCCNC',
    controller: 'uccnc',
    travel: { x: 738, y: 724.5, z: 128.9 },
    controllerDefinition: definition,
    noHomingSwitches: undefined,
    rapidRate: 60_000,
  }
}

let connected = false

async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function connect(): Promise<void> {
  const pending = connectMachine('simulator')
  await settle(300)
  await pending
  connected = true
}

beforeEach(() => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  useCamStore.setState((state) => ({
    machineWorkOffsets: {},
    control: { ...state.control, activeMachineId: null, sessionMachine: null },
  }))
  useCamStore.getState().updateMachine(suppliedMachine())
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [], activeWcs: null })
})

afterEach(async () => {
  if (connected) {
    const pending = disconnectMachine()
    await settle(100)
    await pending
    connected = false
  }
  vi.useRealTimers()
})

describe('WO-1181 the G54 button selects G54', () => {
  it('records the operator\'s press as the active work offset without waiting for a state frame', async () => {
    await connect()
    act(() => { __resetEstopInterlockForTest() })
    useMachineControl.setState({ activeWcs: null })
    // The simulator answers a selection with a synchronous `$G`-style modal
    // report, which is exactly what the UCCNC bridge never sends. Model the
    // bridge: the selection is accepted, no modal state comes back.
    const controller = getMachineController()
    vi.spyOn(controller, 'refreshState').mockReturnValue(true)

    act(() => { selectWorkOffset('G55') })

    // Synchronous on purpose: on that backend nothing else ever writes it.
    expect(useMachineControl.getState().activeWcs).toBe('G55')
  })

  it('does not claim a selection the controller refused to send', async () => {
    await connect()
    act(() => { __resetEstopInterlockForTest() })
    useMachineControl.setState({ activeWcs: null })
    const controller = getMachineController()
    const selectWcs = vi.spyOn(controller, 'selectWcs').mockReturnValue(false)

    act(() => { selectWorkOffset('G56') })

    expect(selectWcs).toHaveBeenCalledWith('G56')
    expect(useMachineControl.getState().activeWcs).toBeNull()
  })
})

describe('WO-1181 a refusal always says why', () => {
  it('Goto XY0 on a fresh unhomed connect refuses for the startup E-STOP (WO-1349)', async () => {
    await connect()
    // WO-1349 deliberately repins WO-1182: connection is the reason the
    // E-STOP latch is armed, and the idle report cannot clear it.
    expect(estopNeedsReset()).toBe(true)
    const controller = getMachineController()
    const jog = vi.spyOn(controller, 'jogToWorkXY')

    expect(gotoWorkXYZero(60_000)).toBe(false)

    expect(jog).not.toHaveBeenCalled()
    const last = useMachineControl.getState().consoleLines.at(-1)
    expect(last?.text).toContain('Goto work XY zero: refused - ')
    expect(last?.text).toContain(ESTOP_BLOCKS_MOTION)
    expect(last?.severity).toBe('error')
  })
})
