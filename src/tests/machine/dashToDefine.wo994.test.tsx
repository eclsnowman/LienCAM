// @vitest-environment jsdom
//
// WO-994: THE DASH IS THE ENTRY SURFACE - TYPE INTO IT TO DEFINE IT.
//
// Operator, 2026-08-25 at the machine, verbatim: "on a machine that doesn't have
// homing switches or before it's been homed ... it won't automatically assume
// machine position is zero. it would be dashes when it dashes it means it's
// undefined so you could either type it in there to set the machine position
// if it's not homed or type it in there if it dashes to set it."
//
// He had already ruled it in writing, three orders earlier, inside WO-985's
// own authority block. What lost it was an ARCHITECT sentence in WO-985 line
// 74 - "WO-986 supplies its own deliberate entry surface and does not need
// this cell to become editable in the dashed state" - an implementation
// decision presented as a constraint. That sentence is where the deleted
// button came from, and it is the defect this suite pins shut.
//
// WHAT THIS SUITE DEFENDS, in the order Operator would check it:
//
//   1. THE DISAMBIGUATION RULE, WHICH IS HIS AND WHICH REMOVES THE HAZARD.
//          cell shows DASHES (undefined) -> typing SETS the machine position
//          cell shows a NUMBER (defined) -> typing is a GOTO
//      Derived from the DISPLAYED state - not a mode flag, not a modifier
//      key, not a second control. The cell cannot mean both because it
//      cannot show both.
//   2. THE NEGATIVE CONTROL THAT MATTERS MOST. On a machine with no datum,
//      typing NEVER COMMANDS MOTION. Measured on the real simulator, on the
//      controller's own motion primitives and its own idle proof - not by
//      observing that a different branch was taken.
//   3. THE DASH FIRES WIDELY ENOUGH NOW. A machine WITH switches that has
//      not homed shows DASHES, not 0.000. That is the regression in Operator's
//      17:16 screenshot: the MACHINE column reading 0.000/0.000/0.000 with
//      the NO DATUM chip beside it, same row, same moment.
//   4. A HOMED MACHINE IS COMPLETELY UNAFFECTED - real numbers, goto on
//      type, no dashes anywhere.
//   5. THE TWO REASONS STAY TWO SENTENCES. A switchless machine can never
//      home; a switched one simply has not homed yet.
//
// Verification style follows the established MACHINE-CONTROL split
// (droGoto.wo303.test.tsx): readout/refusal tests fake the machine-control
// store directly, and every test that claims something about MOTION connects
// the real simulator end to end.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  },
}))

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

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')
const { createDefaultControllerDefinition } = await import('../../types')
type ControllerDefinition = import('../../types').ControllerDefinition

/** A wiring diagram with nothing on the home inputs - the switchless machine.
 *  Every other pin is assigned, so the mode cannot be passing by accident on
 *  "this definition is blank". Same fixture as switchlessMode.wo985. */
function switchlessDefinition(): ControllerDefinition {
  const def = createDefaultControllerDefinition()
  def.axes.forEach((a, i) => {
    a.stepPin = { port: 1, pin: 2 + i * 2, negate: false }
    a.dirPin = { port: 1, pin: 3 + i * 2, negate: false }
  })
  return def
}

/** The same machine with its home switches wired. */
function switchedDefinition(): ControllerDefinition {
  const def = switchlessDefinition()
  def.axes.forEach((a, i) => { a.homePin = { port: 2, pin: 1 + i, negate: false } })
  return def
}

function setupMachine(definition: ControllerDefinition): void {
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({ ...machine, controllerDefinition: definition })
}

function dro(column: 'work' | 'machine', axis: 'x' | 'y' | 'z'): HTMLInputElement {
  return screen.getByTestId(`control-dro-${column}-${axis}`) as HTMLInputElement
}

function commit(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

const SWITCHLESS_NO_DATUM = 'No home switches - machine coordinates unknown. Working in work '
  + 'coordinates. Type a machine coordinate to set it.'
const SWITCHED_NO_DATUM = 'Not homed yet - machine coordinates unknown. Press Home All, or type a '
  + 'machine coordinate to set it.'

function noDatumConsoleTexts(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) =>
      line.severity === 'info'
      && (line.text === SWITCHLESS_NO_DATUM || line.text === SWITCHED_NO_DATUM),
    )
    .map((line) => line.text)
}

function consoleErrors(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.severity === 'error')
    .map((line) => line.text)
}

function expectAddedLine(linesBefore: string[], linesAfter: string[], expected: string): void {
  expect(linesAfter).toHaveLength(linesBefore.length + 1)
  expect(linesAfter.slice(linesBefore.length)).toEqual([expected])
}

// ---------------------------------------------------------------------------
// 3. THE DASH FIRES ON "NOT ESTABLISHED", NOT ON "HAS NO SWITCHES"
// ---------------------------------------------------------------------------

describe('WO-994 the dashed machine readout', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineGotoSkipConfirm: false })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      alarm: null,
      homed: false,
      mpos: { x: -123.456, y: -78.9, z: -12.5 },
      wpos: { x: 10.5, y: 20.25, z: 3 },
      settings: {},
      consoleLines: [],
      job: { ...useMachineControl.getState().job, phase: 'empty' },
    })
  })

  afterEach(() => cleanup())

  it('THE SCREENSHOT: a machine WITH switches that has not homed reads dashes, not 0.000', () => {
    // Operator's 17:16 photograph, as a test. Before this order the MACHINE column
    // read real numbers here - a machine position the machine does not have -
    // WITH the no-datum chip displayed beside it in the same row.
    setupMachine(switchedDefinition())
    const linesBefore = noDatumConsoleTexts()
    render(<ControlPage />)

    for (const axis of ['x', 'y', 'z'] as const) {
      expect(dro('machine', axis).value).toBe('---')
    }
    // Work is derived from Machine, so an unknown Machine position cannot
    // produce a confident-looking offset-derived Work number.
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(dro('work', axis).value).toBe('---')
    }
    expectAddedLine(linesBefore, noDatumConsoleTexts(), SWITCHED_NO_DATUM)
  })

  it('a switchless machine still reads dashes - WO-985 is not weakened, only widened', () => {
    setupMachine(switchlessDefinition())
    render(<ControlPage />)

    for (const axis of ['x', 'y', 'z'] as const) {
      expect(dro('machine', axis).value).toBe('---')
    }
  })

  it('NEGATIVE CONTROL: a HOMED machine has no dashes anywhere and no no-datum note', () => {
    setupMachine(switchedDefinition())
    act(() => { useMachineControl.setState({ homed: true }) })
    const linesBefore = noDatumConsoleTexts()
    render(<ControlPage />)

    expect(dro('machine', 'x').value).toBe('-123.46')
    expect(dro('machine', 'y').value).toBe('-78.90')
    expect(dro('machine', 'z').value).toBe('-12.50')
    expect(dro('work', 'x').value).toBe('10.50')
    expect(noDatumConsoleTexts()).toEqual(linesBefore)
  })

  // -------------------------------------------------------------------------
  // 5. THE TWO REASONS STAY TWO SENTENCES
  // -------------------------------------------------------------------------

  it('a switchless machine is never told to home - there is nothing to home with', () => {
    setupMachine(switchlessDefinition())
    const linesBefore = noDatumConsoleTexts()
    render(<ControlPage />)

    expectAddedLine(linesBefore, noDatumConsoleTexts(), SWITCHLESS_NO_DATUM)
  })

  it('a switched machine that has simply not homed YET is told to home, and offered the type-in too', () => {
    setupMachine(switchedDefinition())
    const linesBefore = noDatumConsoleTexts()
    render(<ControlPage />)

    expectAddedLine(linesBefore, noDatumConsoleTexts(), SWITCHED_NO_DATUM)
  })
})

// ---------------------------------------------------------------------------
// 1. THE DISAMBIGUATION RULE - read off the DISPLAYED state
// ---------------------------------------------------------------------------

describe('WO-994 the disambiguation rule', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineGotoSkipConfirm: false })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      alarm: null,
      homed: false,
      mpos: { x: 0, y: 0, z: 0 },
      wpos: { x: 0, y: 0, z: 0 },
      settings: {},
      consoleLines: [],
      job: { ...useMachineControl.getState().job, phase: 'empty' },
    })
  })

  afterEach(() => cleanup())

  it('THE REVERSAL OF WO-985 LINE 74: a dashed cell IS editable - dashed is when it must accept typing', () => {
    for (const def of [switchlessDefinition(), switchedDefinition()]) {
      setupMachine(def)
      render(<ControlPage />)
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(dro('machine', axis).value).toBe('---')
        expect(dro('machine', axis).disabled).toBe(false)
      }
      cleanup()
    }
  })

  it('a dashed cell does NOT route to the goto path - no confirm card, and no homing refusal', () => {
    // The old behaviour typed into this cell and got "home the machine ($H)
    // first". Under the rule the cell is not a goto at all while it dashes,
    // so the refusal it lands on (no real controller behind the faked store)
    // is the DATUM seam's own, about connecting - never about homing.
    setupMachine(switchedDefinition())
    render(<ControlPage />)

    const errorsBefore = consoleErrors()
    commit(dro('machine', 'x'), '10')

    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expectAddedLine(
      errorsBefore,
      consoleErrors(),
      'Set X machine position: refused - The software stop is latched. Press CLEAR to reset it.',
    )
    expect(useMachineControl.getState().mpos).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('a NUMBERED cell is still a goto - the same machine, one flag apart', () => {
    // The SAME machine as the test above, differing only in whether a datum
    // exists. That is the whole rule: nothing about the machine decides which
    // gesture a typed number is, only what the cell is showing.
    setupMachine(switchedDefinition())
    act(() => { useMachineControl.setState({ homed: true }) })
    render(<ControlPage />)

    expect(dro('machine', 'x').value).toBe('0.00')
    const errorsBefore = consoleErrors()
    commit(dro('machine', 'x'), '-10')

    // It reached the GOTO path, and the refusal it lands on says so: with no
    // real controller behind the faked store it stops at `verifiedIdle`, the
    // LAST check in `evaluateGoto`, which the datum seam's refusals cannot
    // produce and which nothing before it in the goto order intercepted.
    // (The watched, actually-moving proof is in the simulator describe.)
    expectAddedLine(
      errorsBefore,
      consoleErrors(),
      'Goto X machine: refused - the machine is moving - wait for it to stop, then try again.',
    )
  })

  it('an unparseable value does nothing at all - no refusal, no datum, no card', () => {
    setupMachine(switchlessDefinition())
    render(<ControlPage />)

    const input = dro('machine', 'x')
    const errorsBefore = consoleErrors()
    commit(input, 'not-a-number')

    expect(input.value).toBe('---')
    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expect(consoleErrors()).toEqual(errorsBefore)
    expect(useMachineControl.getState().homed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2 + 4. THE REAL SIMULATOR - everything this suite claims about MOTION
// ---------------------------------------------------------------------------

describe('WO-994 typing into the dash (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineGotoSkipConfirm: false })
    // The faked describes above write this same module-level store; reset the
    // fields they set so nothing leaks into a real-simulator run.
    useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
    setupMachine(switchlessDefinition())
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    // The E-STOP interlock starts latched on every fresh connection (WO-328),
    // and `setMachinePosition` is one of the gestures it gates. Clearing it is
    // what an operator does with the reset control before touching anything;
    // setMachinePosition.wo986's own beforeEach does exactly this.
    __resetEstopInterlockForTest()
    await vi.advanceTimersByTimeAsync(1400)
  })

  afterEach(async () => {
    cleanup()
    act(() => { getMachineController().emergencyStop() })
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  /** ControlPage's connect-time G20/G21 sync makes verifiedIdle() false for a
   *  moment on a fresh mount; settling past it is environment bookkeeping.
   *  (droGoto.wo303's own `renderControl`.) */
  async function renderControl(): Promise<void> {
    render(<ControlPage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1400) })
  }

  it('THE HEADLINE: typing into a dashed cell ESTABLISHES the datum - the readout stops dashing and the gates open', async () => {
    const noDatumBefore = noDatumConsoleTexts()
    await renderControl()
    expectAddedLine(noDatumBefore, noDatumConsoleTexts(), SWITCHLESS_NO_DATUM)
    expect(dro('machine', 'x').value).toBe('---')
    expect(useMachineControl.getState().homed).toBe(false)
    const noDatumAfterRender = noDatumConsoleTexts()

    commit(dro('machine', 'x'), '123.456')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    // The position became REAL...
    expect(useMachineControl.getState().mpos!.x).toBeCloseTo(123.456, 3)
    expect(dro('machine', 'x').value).toBe('123.46')
    // ...the readout stopped dashing on every axis, because a datum is a
    // whole-machine fact (see attemptSetMachineDatum's decide-and-log)...
    expect(dro('machine', 'y').value).not.toBe('---')
    expect(dro('machine', 'z').value).not.toBe('---')
    expect(noDatumConsoleTexts()).toEqual(noDatumAfterRender)
    // ...and the coordinate gates opened.
    expect(useMachineControl.getState().homed).toBe(true)
    expect(getMachineController().homedThisSession()).toBe(true)
  })

  it('THE NEGATIVE CONTROL THAT MATTERS MOST: typing into a dashed cell NEVER COMMANDS MOTION', async () => {
    await renderControl()
    const ctrl = getMachineController()
    // Every primitive this app can move the machine with. A datum entry must
    // touch none of them - asserted on the CONTROLLER, not on which branch
    // the component happened to take.
    const jog = vi.spyOn(ctrl, 'jog')
    const jogToWorkXY = vi.spyOn(ctrl, 'jogToWorkXY')
    const jogToMachineZ = vi.spyOn(ctrl, 'jogToMachineZ')
    const sendCommand = vi.spyOn(ctrl, 'sendCommand')

    commit(dro('machine', 'x'), '123.456')

    expect(jog).not.toHaveBeenCalled()
    expect(jogToWorkXY).not.toHaveBeenCalled()
    expect(jogToMachineZ).not.toHaveBeenCalled()
    expect(sendCommand).not.toHaveBeenCalled()
    // The controller's OWN proof that nothing is queued or in flight. It goes
    // false the instant any command is written, before any status poll - so a
    // move that had been accepted could not leave this true.
    expect(ctrl.verifiedIdle()).toBe(true)
    expect(useMachineControl.getState().machineState).toBe('idle')
    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()

    // And nothing travels afterwards: a rapid takes wall time, a datum does
    // not. The number is already final, and it is still final three seconds
    // later.
    expect(useMachineControl.getState().mpos!.x).toBeCloseTo(123.456, 3)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(useMachineControl.getState().mpos!.x).toBeCloseTo(123.456, 3)
    expect(jog).not.toHaveBeenCalled()
  })

  it('the same is true with the confirm card turned off - skip-confirm is a GOTO preference, not a datum one', async () => {
    useUiPrefs.setState({ machineGotoSkipConfirm: true })
    await renderControl()
    const jog = vi.spyOn(getMachineController(), 'jog')

    commit(dro('machine', 'z'), '-40.000')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(jog).not.toHaveBeenCalled()
    expect(useMachineControl.getState().mpos!.z).toBeCloseTo(-40, 3)
  })

  it('NEGATIVE CONTROL: once the datum exists a machine cell is a GOTO again, and it really moves', async () => {
    // 4, watched rather than assumed: this is the behaviour that must not
    // regress. The machine here reached its datum through the very mechanism
    // the test above exercises, so the two halves of the rule are measured
    // against the same session.
    await renderControl()
    commit(dro('machine', 'x'), '0.000')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(useMachineControl.getState().homed).toBe(true)
    expect(dro('machine', 'x').value).toBe('0.00')

    commit(dro('machine', 'x'), '-50.000')
    const dialog = screen.getByTestId('control-goto-confirm')
    expect(dialog.textContent).toContain('MACHINE')
    expect(dialog.textContent).toContain('G53 G0 X')
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(useMachineControl.getState().mpos!.x).toBeCloseTo(-50, 1)
  })
})
