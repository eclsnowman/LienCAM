// WO-1022: setting work zero goes through the INTERFACE INTENT, never through
// G-code text.
//
// The defect, measured: `zeroWorkAxes` built `G10 L20 P0 X0 Y0 Z0` and pushed
// it through `sendCommand`. That is text above the machine-control boundary.
// The AXBB-E backend refuses text, so at the machine the Zero button did
// nothing - and until WO-1021 it reported success while doing it. Every
// backend already implements `zeroWorkAxis(axis)` (ADR-0041), so there is
// nothing to branch on: the session says WHAT, the backend decides HOW.
//
// These tests drive the REAL `zeroWorkAxes` against the real
// SimulatedController and against recording stubs. Nothing here greps the
// source: the "no text is sent" claim is asserted on a stub's CALL LOG, which
// is what an AXBB-E would actually see.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  zeroWorkAxes,
} from '../../lib/machine/machineSession'
import type { JogAxis, MachineController } from '../../lib/machine/controller'
import { useMachineControl } from '../../store/machineControlStore'
import { useCamStore } from '../../store'

/** A controller that records every intent it is asked for and every line of
 *  text anyone tries to push through it. `zeroWorkAxis` answers from `refuse`,
 *  so a partial refusal is expressible without mocking `zeroWorkAxes` itself. */
function recordingController(refuse: JogAxis[] = []) {
  const log: string[] = []
  const ctrl = {
    zeroWorkAxis(axis: JogAxis): boolean {
      log.push(`zeroWorkAxis:${axis}`)
      return !refuse.includes(axis)
    },
    sendCommand(text: string): boolean {
      log.push(`sendCommand:${text}`)
      return true
    },
    refreshState(): boolean {
      log.push('refreshState')
      return true
    },
  } as unknown as MachineController
  return { ctrl, log }
}

describe('WO-1022 zeroWorkAxes drives the interface intent, not G-code text', () => {
  beforeEach(() => {
    useMachineControl.getState().clearConsole()
  })

  it('asks for exactly one zeroWorkAxis per axis, in order, and sends NO text', () => {
    const { ctrl, log } = recordingController()
    const result = zeroWorkAxes(['X', 'Y', 'Z'], ctrl)

    expect(log.filter((e) => e.startsWith('zeroWorkAxis'))).toEqual([
      'zeroWorkAxis:X',
      'zeroWorkAxis:Y',
      'zeroWorkAxis:Z',
    ])
    // The whole point of the order: an AXBB-E sees no text at all.
    expect(log.filter((e) => e.startsWith('sendCommand'))).toEqual([])
    expect(log).toContain('refreshState')
    expect(result).toEqual({ ok: true, zeroed: ['X', 'Y', 'Z'], refused: [] })
  })

  it('a refused axis does not abort the rest: X and Z are still zeroed', () => {
    const { ctrl, log } = recordingController(['Y'])
    const result = zeroWorkAxes(['X', 'Y', 'Z'], ctrl)

    expect(result.ok).toBe(false)
    expect(result.zeroed).toEqual(['X', 'Z'])
    expect(result.refused).toEqual(['Y'])
    // Y was ATTEMPTED - a skipped axis and a refused axis are different facts.
    expect(log.filter((e) => e.startsWith('zeroWorkAxis'))).toEqual([
      'zeroWorkAxis:X',
      'zeroWorkAxis:Y',
      'zeroWorkAxis:Z',
    ])
    // The readout is re-read even on a partial refusal, so it shows what is
    // TRUE rather than what was asked for.
    expect(log).toContain('refreshState')
  })

  it('one plain console line names the refused axis, and only the refused one', () => {
    const { ctrl } = recordingController(['Y'])
    zeroWorkAxes(['X', 'Y', 'Z'], ctrl)

    const lines = useMachineControl.getState().consoleLines
    expect(lines).toHaveLength(1)
    expect(lines[0].severity).toBe('error')
    expect(lines[0].text).toContain('Y')
    expect(lines[0].text).toBe(
      'The machine would not set work zero for Y. Work zero was set for X and Z.',
    )
  })

  it('says nothing in the console when every axis was accepted', () => {
    const { ctrl } = recordingController()
    zeroWorkAxes(['X', 'Y'], ctrl)
    expect(useMachineControl.getState().consoleLines).toEqual([])
  })

  it('an empty axis list touches nothing at all - no intent, no text, no re-read', () => {
    const { ctrl, log } = recordingController()
    const result = zeroWorkAxes([], ctrl)
    expect(log).toEqual([])
    expect(result).toEqual({ ok: true, zeroed: [], refused: [] })
    expect(useMachineControl.getState().consoleLines).toEqual([])
  })

  it('names every refused axis when the controller refuses all three', () => {
    const { ctrl } = recordingController(['X', 'Y', 'Z'])
    const result = zeroWorkAxes(['X', 'Y', 'Z'], ctrl)
    expect(result).toEqual({ ok: false, zeroed: [], refused: ['X', 'Y', 'Z'] })
    const lines = useMachineControl.getState().consoleLines
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('The machine would not set work zero for X, Y and Z.')
  })
})

describe('WO-1022 against the SimulatedController, which zeroes natively', () => {
  let simulatorFixtureNumber = 0

  beforeEach(async () => {
    vi.useFakeTimers()
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: `wo1022-negative-machine-${++simulatorFixtureNumber}`,
      name: 'WO-1022 negative-frame fixture',
      controller: 'grbl',
      controllerDefinition: undefined,
      unsentSettings: undefined,
      travel: { x: 100, y: 100, z: 100 },
      rapidRate: 60000,
      homeConvention: {
        x: { homesToward: 'max', machineZeroAt: 'max' },
        y: { homesToward: 'max', machineZeroAt: 'max' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      },
    })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about
    // zeroWorkAxes intent against a real jog, not the fresh-connect E-STOP
    // latch, which would otherwise refuse the jog moves below.
    __resetEstopInterlockForTest()
    useMachineControl.getState().clearConsole()
  })

  afterEach(async () => {
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  /** Move off the connect position so "the offset equals where we were" is a
   *  claim with content on every axis. */
  async function jogTo(): Promise<{ x: number; y: number; z: number }> {
    const ctrl = getMachineController()
    expect(ctrl.jog('X', -12, 2000)).toBe(true)
    expect(ctrl.jog('Y', -7.5, 2000)).toBe(true)
    expect(ctrl.jog('Z', -3, 2000)).toBe(true)
    await vi.advanceTimersByTimeAsync(4000)
    const at = ctrl.status().machinePos!
    expect(at).not.toEqual({ x: 0, y: 0, z: 0 })
    return at
  }

  it('zeroWorkAxes(X,Y) sets the active offset to the current position and leaves Z alone', async () => {
    const ctrl = getMachineController()
    const before = ctrl.status().workPos!
    const at = await jogTo()

    const result = zeroWorkAxes(['X', 'Y'])
    expect(result).toEqual({ ok: true, zeroed: ['X', 'Y'], refused: [] })
    // WO-1042/1083: the zero is confirmed by the controller's RECEIPT, and the
    // re-read that publishes the new offset rows follows it - on the simulator
    // exactly as on the bridge. Let that land before reading them.
    await vi.advanceTimersByTimeAsync(50)

    // The simulator's ACTIVE work offset, read back the way the Offsets panel
    // reads it - through the $# rows refreshState emits.
    const g54 = useMachineControl.getState().offsets['G54']
    expect(g54[0]).toBeCloseTo(at.x, 6)
    expect(g54[1]).toBeCloseTo(at.y, 6)
    expect(g54[2]).toBe(0) // Z offset untouched

    // The readout agrees: work X and Y are zero, Z is not (it moved, and its
    // offset did not).
    await vi.advanceTimersByTimeAsync(400)
    const wpos = useMachineControl.getState().wpos!
    expect(wpos.x).toBeCloseTo(0, 6)
    expect(wpos.y).toBeCloseTo(0, 6)
    expect(wpos.z).toBeCloseTo(before.z - 3, 6)
    expect(useMachineControl.getState().consoleLines).toEqual([])
  })

  it('zeroWorkAxes(Z) alone zeroes only Z', async () => {
    const ctrl = getMachineController()
    const at = await jogTo()

    expect(zeroWorkAxes(['Z'])).toEqual({ ok: true, zeroed: ['Z'], refused: [] })
    await vi.advanceTimersByTimeAsync(50)

    const g54 = useMachineControl.getState().offsets['G54']
    expect(g54[0]).toBe(0)
    expect(g54[1]).toBe(0)
    expect(g54[2]).toBeCloseTo(at.z, 6)

    await vi.advanceTimersByTimeAsync(400)
    const wpos = useMachineControl.getState().wpos!
    expect(wpos.z).toBeCloseTo(0, 6)
    expect(wpos.x).toBeCloseTo(at.x, 6)
    expect(wpos.y).toBeCloseTo(at.y, 6)
    // The controller itself agrees with the store - the readout is not a
    // separate opinion.
    expect(ctrl.status().workPos!.z).toBeCloseTo(0, 6)
  })
})
