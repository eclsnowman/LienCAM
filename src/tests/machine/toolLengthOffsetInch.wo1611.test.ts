// WO-1611: a GRBL-path line built with a millimetre value and no units word
// is read in whatever units the operator's session (G20/G21) currently
// holds. applyToolLengthOffset's deltaMm is always mm (WO-1546: the tool
// table's own reference math), so an inch session read a 12.5 mm offset as
// 12.5 INCH - 317.5 mm, 25.4x too far. Fixed by prefixing the line with G21
// and restoring G20 after - the same shape as the pad probe's work-Z0 write
// (WO-1546) and the park move's G21 G90 prefix (WO-1548).
//
// The grep this order asked for ("any other app-built text line on the GRBL
// path that carries a millimetre value with no G21") found one more:
// sendWorkOffsetText's `G10 L2` line (the text-route setWorkOffsetValue takes
// on a controller with no typed offset call) - fixed here the same way.
// Every OTHER mm-valued line already built in machineSession.ts (the probe
// cycles, the park sequence, the mesh probe) already says G21 because it runs
// INSIDE a sequence a prior line in the same sequence already switched to
// G21; those were left alone.
//
// Driven through the real machineSession singleton connected to the native
// SimulatedController ('simulator'), which declares `gcodeText: true` and so
// takes G43.1/G49/G10 as text exactly like real GRBL - the "Tier 2 desk: GRBL
// simulator / GRBL controller wire lines in an inch session" evidence this
// order's frontmatter declares.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import {
  __resetEstopInterlockForTest,
  applyToolLengthOffset,
  clearToolLengthOffset,
  connectMachine,
  disconnectMachine,
  getMachineController,
  sendAppCommand,
  setWorkOffsetValue,
} from '../../lib/machine/machineSession'

async function connectSimulator(): Promise<void> {
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  useMachineControl.setState({ activeWcs: 'G54' })
}

/** G20, then a manual refresh - a typed MDI line's own follow-up (see
 *  runMdiWorkOffsetWrite / runParkMove) that syncs the store's held
 *  `parserModal` to what the controller now actually holds. */
async function enterInchSession(): Promise<void> {
  sendAppCommand('G20')
  getMachineController().refreshState()
}

beforeEach(() => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

describe('WO-1611: G43.1/G49 apply the same mm offset whatever units the operator holds', () => {
  it('a +12.5 mm TLO reads back as 12.5 mm in a G21 session and a G20 session alike, and the operator stays in inch', async () => {
    await connectSimulator()
    expect(getMachineController().capabilities.gcodeText).toBe(true)

    // G21 (mm) baseline.
    expect(applyToolLengthOffset(12.5)).toBe(true)
    expect(useMachineControl.getState().tlo).toBe(12.5)
    expect(clearToolLengthOffset()).toBe(true)
    expect(useMachineControl.getState().tlo).toBe(0)

    // G20 (inch), as ControlPage sends on connect when the operator's display
    // units are inch.
    await enterInchSession()
    expect(useMachineControl.getState().parserModal?.units).toBe('inch')

    // BEFORE THE FIX this read 12.5 * 25.4 = 317.5 - the exact 25.4x the WO
    // describes for a 12.5 mm offset.
    expect(applyToolLengthOffset(12.5)).toBe(true)
    expect(useMachineControl.getState().tlo).toBe(12.5)
    expect(useMachineControl.getState().parserModal?.units).toBe('inch')

    // Clearing it (G49) likewise leaves the operator's units as they were.
    expect(clearToolLengthOffset()).toBe(true)
    expect(useMachineControl.getState().tlo).toBe(0)
    expect(useMachineControl.getState().parserModal?.units).toBe('inch')
  })

  it('the wire line says G21 in an inch session, and carries no units word in an mm one', async () => {
    await connectSimulator()
    const ctrl = getMachineController()
    const send = vi.spyOn(ctrl, 'sendCommand')

    expect(applyToolLengthOffset(12.5)).toBe(true)
    expect(clearToolLengthOffset()).toBe(true)
    expect(send.mock.calls.map((call) => call[0])).toEqual(['G43.1 Z12.5', 'G49'])

    send.mockClear()
    await enterInchSession()
    send.mockClear()

    expect(applyToolLengthOffset(12.5)).toBe(true)
    expect(clearToolLengthOffset()).toBe(true)
    expect(send.mock.calls.map((call) => call[0])).toEqual(['G21 G43.1 Z12.5', 'G20', 'G49'])
  })
})

describe('WO-1611 grep: the work-offset text route (G10 L2) carries the same mm-value defect class', () => {
  it('setWorkOffsetValue in an inch session sends G21 on the G10 line and restores G20 after', async () => {
    await connectSimulator()
    await enterInchSession()
    const ctrl = getMachineController()
    const sendAwait = vi.spyOn(ctrl, 'sendCommandAwait')
    const send = vi.spyOn(ctrl, 'sendCommand')

    expect(setWorkOffsetValue('G54', 'Z', 22.5)).toBe(true)
    await vi.advanceTimersByTimeAsync(50)

    expect(sendAwait.mock.calls.map((call) => call[0])).toEqual(['G21 G10 L2 P1 Z22.5'])
    expect(send.mock.calls.map((call) => call[0])).toEqual(['G20'])
    expect(useMachineControl.getState().parserModal?.units).toBe('inch')
  })

  it('the same write in an mm session carries no units word', async () => {
    await connectSimulator()
    const ctrl = getMachineController()
    const sendAwait = vi.spyOn(ctrl, 'sendCommandAwait')

    expect(setWorkOffsetValue('G54', 'Z', 22.5)).toBe(true)
    await vi.advanceTimersByTimeAsync(50)

    expect(sendAwait.mock.calls.map((call) => call[0])).toEqual(['G10 L2 P1 Z22.5'])
  })
})
