// WO-415: the active work offset follows G54..G59 words the controller
// acknowledges mid-run (streamed program line) and in the MDI, not only $G
// at connect. Simulator transport = a GRBL made of software; no polling added.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  sendMdiLine,
  wcsWordInLine,
} from '../../lib/machine/machineSession'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'

const PROGRAM = [
  'G21 G90 G54',
  'G0 Z5',
  'G0 X1 Y1',
  'G57 ( second setup )',
  'G0 X2 Y2',
  'G0 Z5',
].join('\n')

describe('wcsWordInLine', () => {
  it('finds the last G5x word, ignores comments, G59.1 and G5 alone', () => {
    expect(wcsWordInLine('G57 ( second setup )')).toBe('G57')
    expect(wcsWordInLine('G54 G55')).toBe('G55')
    expect(wcsWordInLine('G0 X1 ( G58 )')).toBeNull()
    expect(wcsWordInLine('G59.1')).toBeNull()
    expect(wcsWordInLine('G5 X1')).toBeNull()
    expect(wcsWordInLine('g056')).toBe('G56')
  })
})

describe('WO-415 activeWcs follows acknowledged G5x words', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    // WO-2712: both setups sit near the simulator's initial -5,-5,-5,
    // inside the sample's stated negative travel; G57 is no longer at table zero.
    const cam = useCamStore.getState()
    for (const wcs of ['G54', 'G57'] as const) {
      cam.setMachineWorkOffset(cam.project.machine.id, wcs, { x: -5, y: -5, z: -5 }, 'not-sent')
    }
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    expect(useMachineControl.getState().activeWcs).toBe('G54')
  })

  afterEach(async () => {
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('a streamed G57 line, once acknowledged, flips activeWcs to G57', async () => {
    const ctrl = getMachineController()
    loadMachineProgram('wo415.nc', PROGRAM)
    expect(ctrl.startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    const s = useMachineControl.getState()
    expect(s.job.ackedLines).toBe(6)
    expect(s.activeWcs).toBe('G57')
  })

  it('an MDI G55 line, once acknowledged, flips activeWcs to G55', async () => {
    expect(sendMdiLine('G55')).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    // The controller agrees: $G reports the same offset.
    getMachineController().refreshState()
    await vi.advanceTimersByTimeAsync(20)
    expect(useMachineControl.getState().activeWcs).toBe('G55')
  })

  it('an MDI line without a G5x word leaves activeWcs alone', async () => {
    expect(sendMdiLine('G0 X0')).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    expect(useMachineControl.getState().activeWcs).toBe('G54')
  })
})
