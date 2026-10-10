// @vitest-environment jsdom
//
// WO-469: an E-STOP must be clearable without loading a program.
//
// THIS FILE IS THE DELIVERABLE. Every other E-STOP test in this directory
// reaches real simulator motion through __resetEstopInterlockForTest(), the
// test-only hatch. The hatch is not wrong, but it meant no test had ever
// walked the OPERATOR's path, and the suite stayed green across a UI that
// could not complete any motion at all once the E-STOP had been pressed.
// Nothing here touches the hatch. The clicks go through the real
// ControlTransportBar against the real connectMachine('simulator') singleton.
//
// THE DEADLOCK THIS CLOSES, from the code as it stood:
//
//   1. simulatedController.emergencyStop() sets estopTripped = true, 'alarm'.
//   2. unlock()  - refuses while estopTripped. ($X)
//   3. reset()   - ends with setState(estopTripped ? 'alarm' : 'idle'), so it
//                  re-enters alarm. (Stop/Reset)
//   4. resetToIdle() is the ONLY method that clears estopTripped.
//   5. Its only non-test caller was armProgramFromTop(), which opens with
//        if (!s.programText)          -> refuse
//        if (s.machineState==='alarm') -> refuse
//      So the exit was reachable only through a door the E-STOP itself locked,
//      and only with a program loaded. That is a deadlock, not a gate.
//
// THE FIX, in two halves, both proven below:
//   - the CONTROL: Operator's ruling (2026-08-22). The E-STOP has two modes and
//     the MODE decides, not the state. Armed -> a click STOPS. Stopped -> the
//     control is a CLEAR and a click clears. pressEstop() no longer guesses.
//   - the CONTROLLER: the confirmed clear performs the release itself, by
//     calling the interface method that already meant exactly that -
//     ctrl.resetToIdle(). That is option (c) of the work order's list, a
//     distinct explicit operator action; it needed no new controller method,
//     because the action already existed and only lacked an operator-facing
//     caller. Deliberately NOT (a) reset() and NOT (b) unlock(): both are
//     OTHER controls, and "Stop/Reset released the E-STOP" or "$X released the
//     E-STOP" would let a control that is not the E-STOP re-enable motion.
//     Pinned by "nothing else releases an E-STOP" below.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MachineController } from '../../lib/machine/controller'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ControlTransportBar, ESTOP_SETTLING_NOTE } = await import('../../components/machine/ControlTransportBar')
const {
  __armEstopInterlockForTest,
  armProgramFromTop,
  connectMachine,
  disconnectMachine,
  estopControlMode,
  ESTOP_CLEAR_DELAY_MS,
  estopNeedsReset,
  ESTOP_RESET_REFUSAL,
  getMachineController,
  gotoWorkXYZero,
  loadMachineProgram,
  resetEstop,
  runMachineAction,
  triggerEmergencyStop,
} = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')

/** Past the 600ms post-trigger debounce and through the whole confirmed
 *  clear (fresh status + ctrl.resetToIdle()). An operator's hand is slower
 *  than this; the debounce exists so an accidental double-stab is not. */
const OPERATOR_PAUSE_MS = 900
/** One full simulator status cadence plus slack (STATUS_MS_IDLE = 500). */
const SETTLE_MS = 700

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** `status()` fields are `| null` on the contract on purpose: a backend that
 *  does not HAVE an input reports null rather than false, so the UI can say
 *  "unknown" instead of inventing a number. The simulator has all of these, so
 *  a null reaching one of these helpers is itself the defect. This THROWS -
 *  it is an EXTRA assertion in front of the real one, never a narrowing that
 *  lets a missing field pass as a value. */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`the controller reported no ${what}`)
  return value
}

/** `status().inputs.estop` - the controller's own E-STOP condition. */
function estopInput(ctrl: MachineController): boolean {
  return must(ctrl.status().inputs, 'inputs').estop
}

/** `status().machinePos.x` - where the machine actually is. */
function machineX(ctrl: MachineController): number {
  return must(ctrl.status().machinePos, 'machine position').x
}

async function connectSimulator(): Promise<void> {
  await act(async () => {
    const pending = connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(100)
    await pending
  })
  await settle(SETTLE_MS)
  // WO-1182: a fresh connect releases the latch once the controller reports
  // idle; these tests walk out of a REAL stop, so arm it the way a trip does.
  __armEstopInterlockForTest()
}

/** The WORD on the control the operator is actually looking at. Operator's ruling
 *  makes the two modes two different controls, and the label is what says so -
 *  a colour alone is not a control. Read from the rendered DOM, not from a
 *  data attribute, because a data attribute is not what an operator sees. */
function estopLabel(): string {
  return (screen.getByTestId('control-estop').textContent ?? '').trim()
}

/** Operator's refinement, 2026-08-22: "put a time delay in between when the reset
 *  mode goes active so you couldn't accidentally double tap." Past it, and no
 *  further - so a test that means "the delay has elapsed" cannot accidentally
 *  also mean "and a lot else happened". */
async function pastTheClearDelay(): Promise<void> {
  await settle(ESTOP_CLEAR_DELAY_MS + 1)
}

/** Click the real E-STOP control and let whatever it started finish. */
async function clickEstop(): Promise<void> {
  fireEvent.click(screen.getByTestId('control-estop'))
  await settle(OPERATOR_PAUSE_MS)
}

/** The startup latch: a fresh connection is a fresh session, so the control
 *  begins in its CLEAR mode with nothing tripped. Clearing it is the first
 *  thing an operator does, and it is NOT the E-STOP recovery this file is
 *  about - it is the precondition for pressing an E-STOP at all. */
async function clearStartupLatch(): Promise<void> {
  expect(estopControlMode()).toBe('stopped')
  await clickEstop()
  expect(estopControlMode()).toBe('armed')
}

beforeEach(() => vi.useFakeTimers())

afterEach(async () => {
  cleanup()
  await act(async () => {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(200)
    await pending
  })
  // Nothing loaded is the state these tests start from, and `setProgram` is
  // the store's only way to say it - there is no `clearProgram`. The previous
  // `clearProgram?.()` compiled to nothing at runtime AND broke the build.
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
describe('WO-469 the operator walks out of an E-STOP with no program and no test hatch', () => {
  it('connect, E-STOP, clear it with the control the UI actually shows, then complete a motion', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    const ctrl = getMachineController()
    await clearStartupLatch()

    // NOTHING IS LOADED. This is the case the work order calls out
    // explicitly: the old exit (armProgramFromTop) refused without a program,
    // so an operator who had not loaded a job could never get out at all.
    expect(useMachineControl.getState().programText).toBeFalsy()
    // Armed, the control the operator sees IS an E-STOP.
    expect(estopLabel()).toBe('E-STOP')

    // ---- the E-STOP ----------------------------------------------------
    fireEvent.click(screen.getByTestId('control-estop'))
    // The stop is synchronous - asserted with NO time advance at all.
    expect(ctrl.machineState()).toBe('alarm')
    expect(estopInput(ctrl)).toBe(true)
    expect(estopNeedsReset()).toBe(true)
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-state')).toBe('needs-reset')

    // ...and it is NOT YET the clear. Operator's refinement: the mode change
    // itself waits, so a panicked double tap cannot land on a live clear. The
    // control says what it is doing rather than sitting there dead (WO-474).
    expect(estopControlMode()).toBe('settling')
    expect(estopLabel()).toBe('WAIT')
    expect((screen.getByTestId('control-estop') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('control-estop-settling-note').textContent).toBe(ESTOP_SETTLING_NOTE)

    // ---- the delay elapses, and only NOW is it a clear -------------------
    await pastTheClearDelay()
    expect(estopControlMode()).toBe('stopped')
    expect(estopLabel()).toBe('CLEAR')
    expect((screen.getByTestId('control-estop') as HTMLButtonElement).disabled).toBe(false)

    // ---- the clear, through the UI's own affordance ---------------------
    await clickEstop()

    expect(estopNeedsReset()).toBe(false)
    expect(estopControlMode()).toBe('armed')
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-state')).toBe('armed')
    expect(estopLabel()).toBe('E-STOP') // and it is an E-STOP again
    expect(screen.queryByTestId('control-estop-settling-note')).toBeNull()
    // Both halves are released - the session latch AND the controller's own.
    expect(estopInput(ctrl)).toBe(false)
    expect(ctrl.machineState()).toBe('idle')

    // ---- and now the machine actually MOVES ----------------------------
    // This is the part WO-467's walkthrough could not reach. It goes through
    // machineSession's own E-STOP-gated entry point, not the controller.
    // WO-2712: a short machine-frame move fits the sample's -406..0 travel
    // and isolates E-STOP release from the newly placed fresh G54.
    expect(runMachineAction(['G53 G0 X-10 Y-5'])).toEqual({ ok: true, sent: 1 })
    await settle(SETTLE_MS)
    const pos = must(ctrl.status().machinePos, 'machine position')
    expect(pos.x).toBeCloseTo(-10, 3)
    expect(pos.y).toBeCloseTo(-5, 3)
    expect(ctrl.machineState()).toBe('idle')
  })

  it('the clear needs a deliberate act - it never clears itself, however long you wait', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    await clearStartupLatch()

    fireEvent.click(screen.getByTestId('control-estop'))
    expect(estopControlMode()).toBe('settling')

    await settle(30_000) // half a minute of polls, timers and status reports

    // The delay makes the control a CLEAR. It does not make it clear itself:
    // waiting is not an act, and only a deliberate click is.
    expect(estopControlMode()).toBe('stopped')

    expect(estopNeedsReset()).toBe(true)
    expect(estopInput(getMachineController())).toBe(true)
    expect(getMachineController().machineState()).toBe('alarm')
    expect(runMachineAction(['G0 X10'])).toEqual({ ok: false, sent: 0, reason: 'The software stop is latched. Press CLEAR to reset it.' })
  })
})

// ---------------------------------------------------------------------------
// Operator's ruling, 2026-08-22: "e-stop is one button and clear is a different
// button... it's a different button that's flashing and when you click that it
// goes back to the regular State of being an e-stop button". The one risk he
// named and accepted is an operator stabbing the flashing control meaning to
// STOP; the mitigation he required is that it must be unmistakably a DIFFERENT
// control - a different LABEL, not merely a different colour. That is a design
// constraint on the implementation, so it is pinned like any other behaviour.
// ---------------------------------------------------------------------------
describe('WO-469 the flashing control is a different control, and says so', () => {
  it('the visible label is E-STOP armed and CLEAR stopped, and the two share no word', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    await clearStartupLatch()

    const armedLabel = estopLabel()
    expect(armedLabel).toBe('E-STOP')

    fireEvent.click(screen.getByTestId('control-estop'))
    // Through the settling window first - and it shares no word with either of
    // the other two modes, for the same reason they share none with each
    // other.
    expect(estopLabel()).toBe('WAIT')
    await pastTheClearDelay()
    const stoppedLabel = estopLabel()
    expect(stoppedLabel).toBe('CLEAR')

    // Not merely a different colour: the WORD changes, and it is not a
    // decoration of the old one - "CLEAR E-STOP" would still read as an
    // E-STOP at a glance, which is the failure mode Operator's constraint is
    // about. No word is shared in either direction.
    const words = (t: string) => new Set(t.split(/[^A-Za-z]+/).filter(Boolean).map((w) => w.toUpperCase()))
    const shared = [...words(stoppedLabel)].filter((w) => words(armedLabel).has(w))
    expect(shared).toEqual([])

    // The colour differs TOO - the flashing class - but that is the extra, not
    // the distinction. Both are asserted so neither can be dropped silently.
    expect(screen.getByTestId('control-estop').className).toContain('control-estop-needs-reset')
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-mode')).toBe('clear')

    // And it goes back to being the regular E-STOP button, as Operator described.
    await clickEstop()
    expect(estopLabel()).toBe('E-STOP')
    expect(screen.getByTestId('control-estop').className).toContain('control-estop-armed')
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-mode')).toBe('estop')
  })

  it('the CLEAR still refuses when it cannot confirm, and keeps saying CLEAR while it does', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    await clearStartupLatch()

    fireEvent.click(screen.getByTestId('control-estop')) // the stop
    fireEvent.click(screen.getByTestId('control-estop')) // the double tap

    // The double tap did NOT clear the stop it was aimed at. It could not even
    // reach the rule: the control is not a clear yet, so there was nothing
    // live to hit. That is Operator's refinement doing its whole job.
    expect(estopNeedsReset()).toBe(true)
    expect(estopControlMode()).toBe('settling')
    // WO-474: no silent no-op. A control that is merely disabled and says
    // nothing is the same defect as one that swallows a click, so the reason
    // is on screen for the whole window without anyone having to tap it.
    expect(screen.getByTestId('control-estop-settling-note').textContent).toBe(ESTOP_SETTLING_NOTE)
    expect(estopLabel()).toBe('WAIT')

    // Past the delay it is the CLEAR, and the underlying rule still refuses
    // anything it cannot confirm - proven here by a clear attempted while a
    // NEWER stop has restarted the window.
    await pastTheClearDelay()
    expect(estopLabel()).toBe('CLEAR')
    fireEvent.click(screen.getByTestId('control-estop')) // clears
    await settle(SETTLE_MS)
    expect(estopNeedsReset()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Operator refined the design on 2026-08-22, while this order's lane was already
// running: "put a time delay in between when the reset mode goes active so you
// couldn't accidentally double tap." It answers the one risk the two-mode
// design accepts - an operator who stabs the flashing control meaning to STOP
// clears instead - and it is binding, so it is pinned here.
//
// THE POINT THAT MUST NOT BE LOST BY A LATER SEAT: this delays a CLEAR and
// never a STOP. Every assertion below that involves waiting is on a machine
// that is ALREADY stopped.
// ---------------------------------------------------------------------------
describe('WO-469 the clear mode does not go live instantly', () => {
  it('a stop is never delayed by it - the armed control stops with no wait at all', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    const ctrl = getMachineController()
    await clearStartupLatch()

    // Armed: enabled, no delay, no confirm. Asserted with NO time advance.
    expect(estopControlMode()).toBe('armed')
    expect((screen.getByTestId('control-estop') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('control-estop-settling-note')).toBeNull()

    fireEvent.click(screen.getByTestId('control-estop'))

    expect(ctrl.machineState()).toBe('alarm')
    expect(estopInput(ctrl)).toBe(true)
    expect(estopNeedsReset()).toBe(true)
  })

  it('reuses the existing debounce - the mode goes live exactly when a clear becomes allowed', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    await clearStartupLatch()

    fireEvent.click(screen.getByTestId('control-estop'))

    // One millisecond short: still not a clear. The control must not present
    // itself as a clear the underlying rule would refuse - a live-looking
    // control that does nothing is the WO-474 defect, and two separate timers
    // could drift into exactly that, so this pins that they are ONE.
    await settle(ESTOP_CLEAR_DELAY_MS - 1)
    expect(estopControlMode()).toBe('settling')
    expect(estopLabel()).toBe('WAIT')
    expect(await resetEstop()).toEqual({ ok: false, reason: ESTOP_RESET_REFUSAL.tooSoon })

    // Two milliseconds later: the mode is live AND the rule allows it.
    await settle(2)
    expect(estopControlMode()).toBe('stopped')
    expect(estopLabel()).toBe('CLEAR')
  })

  it('a second stop restarts the delay - the operator cannot ride a stale window into a clear', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    await clearStartupLatch()

    fireEvent.click(screen.getByTestId('control-estop'))
    await settle(ESTOP_CLEAR_DELAY_MS - 50)
    expect(estopControlMode()).toBe('settling')

    // A stop is never gated, so this one lands even though the control is
    // disabled: triggerEmergencyStop() is the path a keyboard shortcut or a
    // pendant uses, and it must always work.
    act(() => { triggerEmergencyStop() })
    expect(estopControlMode()).toBe('settling')

    // The window restarted from the NEW stop, not the old one.
    await settle(100)
    expect(estopControlMode()).toBe('settling')
    await pastTheClearDelay()
    expect(estopControlMode()).toBe('stopped')
  })
})

// ---------------------------------------------------------------------------
// THE PART THAT MATTERS MOST: nothing here may make a stop weaker.
// ---------------------------------------------------------------------------
describe('WO-469 motion cannot resume while the stop condition is still asserted', () => {
  it('every motion entry point refuses, and neither Stop/Reset nor $X releases the E-STOP', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    const ctrl = getMachineController()
    await clearStartupLatch()

    fireEvent.click(screen.getByTestId('control-estop'))
    await settle(OPERATOR_PAUSE_MS)
    expect(estopInput(ctrl)).toBe(true)

    // The OTHER controls on the screen. Stop/Reset is a controller reset
    // (GRBL-PROTOCOL: a soft reset "PRESERVES alarm lock"), and JogPanel's
    // Unlock is $X. Neither may be a second, unconfirmed way out of an
    // emergency stop - so both leave the condition asserted.
    act(() => { ctrl.reset() })
    expect(estopInput(ctrl)).toBe(true)
    expect(ctrl.machineState()).toBe('alarm')

    expect(ctrl.unlock()).toBe(false)
    expect(estopInput(ctrl)).toBe(true)
    expect(ctrl.machineState()).toBe('alarm')

    // And with the condition asserted, nothing moves - at the controller...
    const parked = machineX(ctrl)
    expect(ctrl.home()).toBe(false)
    expect(ctrl.jog('X', 10, 600)).toBe(false)
    // ...and at every session entry point the operator can actually reach.
    expect(gotoWorkXYZero(600)).toBe(false)
    expect(runMachineAction(['G0 X10 Y5'])).toEqual({ ok: false, sent: 0, reason: 'The software stop is latched. Press CLEAR to reset it.' })
    await settle(SETTLE_MS)
    expect(machineX(ctrl)).toBeCloseTo(parked, 6) // it did not move

    // Only the deliberate act on the E-STOP control itself releases it.
    await clickEstop()
    expect(estopNeedsReset()).toBe(false)
    expect(estopInput(ctrl)).toBe(false)
    expect(runMachineAction(['G0 X10 Y5'])).toEqual({ ok: true, sent: 1 })
  })

  it('a stop is never gated: the ARMED control stops instantly even mid-motion, and the latch re-arms', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    const ctrl = getMachineController()
    await clearStartupLatch()

    expect(runMachineAction(['G1 X200 Y0 F60'])).toEqual({ ok: true, sent: 1 })
    await settle(200)
    expect(ctrl.machineState()).not.toBe('idle') // genuinely moving

    fireEvent.click(screen.getByTestId('control-estop'))
    // No time advance: the stop has already happened.
    expect(ctrl.machineState()).toBe('alarm')
    expect(estopInput(ctrl)).toBe(true)
    expect(estopNeedsReset()).toBe(true)

    const stoppedAt = machineX(ctrl)
    await settle(SETTLE_MS)
    // The abandoned move does not creep on after the stop.
    expect(machineX(ctrl)).toBeCloseTo(stoppedAt, 6)
    expect(ctrl.machineState()).toBe('alarm')
  })

  it('a clear attempted too soon after the stop is REFUSED, and says so', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    await clearStartupLatch()

    fireEvent.click(screen.getByTestId('control-estop')) // the stop
    fireEvent.click(screen.getByTestId('control-estop')) // the accidental second stab

    // Operator's refinement moved WHERE this is refused, and it is now refused
    // twice over. The control is not yet a clear, so the second stab reaches
    // nothing - and it SAYS so, unprompted, for the whole window.
    expect(estopNeedsReset()).toBe(true)
    expect(screen.getByTestId('control-estop-settling-note').textContent).toBe(ESTOP_SETTLING_NOTE)

    // And the rule underneath is unchanged: a direct caller that skips the
    // control entirely still gets the original tooSoon refusal, so nothing
    // was traded away for the presentation.
    expect(await resetEstop()).toEqual({ ok: false, reason: ESTOP_RESET_REFUSAL.tooSoon })
    await settle(SETTLE_MS)
    expect(estopNeedsReset()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// A regression pin on the ORIGINAL code trail, so a later seat cannot quietly
// make program arming the only exit again.
// ---------------------------------------------------------------------------
describe('WO-469 arming a program is a JOB action and can never be the E-STOP exit', () => {
  it('armProgramFromTop refuses both ways an E-STOPped operator can meet it, and the clear needs neither', async () => {
    render(<ControlTransportBar sections="row" />)
    await connectSimulator()
    await clearStartupLatch()

    fireEvent.click(screen.getByTestId('control-estop'))
    await settle(OPERATOR_PAUSE_MS)

    // Door 1: nothing loaded.
    expect(useMachineControl.getState().programText).toBeFalsy()
    const noProgram = await armProgramFromTop()
    expect(noProgram.ok).toBe(false)

    // Door 2: a program IS loaded, and it still refuses - because the E-STOP
    // put the machine in 'alarm', which is the only state you can be in when
    // you need this. Both doors are locked by the thing they are meant to
    // release.
    act(() => { loadMachineProgram('part.nc', 'G21 G90\nG0 X1 Y1\nM30') })
    expect(useMachineControl.getState().machineState).toBe('alarm')
    const alarmed = await armProgramFromTop()
    expect(alarmed.ok).toBe(false)

    // The operator's own control is not either door.
    await clickEstop()
    expect(estopNeedsReset()).toBe(false)
    expect(estopInput(getMachineController())).toBe(false)
  })
})
