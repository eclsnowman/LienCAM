// @vitest-environment jsdom
//
// WO-985: A MACHINE WITH NO DATUM MUST SAY IT HAS NO DATUM.
//
// Operator's ruling, 2026-08-25 (on WO-969's carded question), verbatim: "if we
// unlock it allows jog moves regardless of where the machine thinks it is ...
// but no gcode can be run until home is performed. the caveat is if the user
// has no defined home switches. in that configuration the user is taking the
// responsibility on themselves ... at which point machine coordinate readout
// should probably be dashed out or something to show that it is working
// entirely in the work coordinate system."
//
// WHAT THIS SUITE DEFENDS, in the order Operator would check it:
//
//   1. THE MODE IS A PROPERTY OF THE MACHINE, ASKED ONCE. Not a per-move
//      inference - he ruled that shape on the E-STOP button (2026-08-22): the
//      control has two modes and the mode decides, "which removes the guess
//      rather than repairing it".
//   2. THE DASHED READOUT. A machine-coordinate readout showing 0.000 on a
//      machine that does not know where it is is the same lie as an E-STOP
//      polarity checkbox reading unchecked when the value is unknown
//      (WO-949). Work coordinates stay live and real.
//   3. THE NEGATIVE CONTROL. A machine that HAS a datum is completely
//      unaffected - real readout, editable, no note. The mode must not leak
//      into the general case. (WO-994 REPIN: this used to say "a machine WITH
//      switches, unhomed". Operator photographed that case reading 0.000 beside a
//      NO DATUM chip and rejected it - having switches is not having a datum,
//      HAVING HOMED is, and the dash predicate is `!homed` now. Each repinned
//      assertion carries its own note; the new behaviour is owned by
//      dashToDefine.wo994.test.tsx.) FIX ROUND 1 adds the case
//      audit round 1 named as missing: the switched machine's WORK column,
//      measured on an actual move, reaches the identical outcome the
//      switchless one does. The mode confers no motion permission at all.
//   4. NO GATE GOT MORE PERMISSIVE. The safe-Z gate still refuses on a
//      switchless machine; only the SENTENCE changed. Telling an operator to
//      home a machine that has nothing to home with sends them off to fix
//      something that was never the problem.
//   5. WORK-COORDINATE MOVES ARE PERMITTED IN THE MODE, watched moving on the
//      real simulator rather than asserted - that is the ruling.
//
// Verification style follows the established MACHINE-CONTROL split
// (droGoto.wo303.test.tsx): readout/refusal tests fake the machine-control
// store directly, and the one test that claims real motion connects the real
// simulator end to end.

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
const { JogPanel } = await import('../../components/machine/JogPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { parkCarrierMachine, saveParkMachineRecord } = await import('../../store/machineActionsStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  connectMachine,
  disconnectMachine,
  getMachineController,
  jogToSafeZ,
  zeroWorkAxes,
  __resetEstopInterlockForTest,
} = await import('../../lib/machine/machineSession')
const {
  createDefaultAxisDefinition,
  createDefaultControllerDefinition,
  machineHasNoHomeSwitches,
  withMachineSafeZ,
} = await import('../../types')
type ControllerDefinition = import('../../types').ControllerDefinition

/** A wiring diagram with nothing on the home inputs - the switchless machine.
 *  Every OTHER pin is assigned, so the mode cannot be passing by accident on
 *  "this definition is blank": it is the HOME pin the question is about. */
function switchlessDefinition(): ControllerDefinition {
  const def = createDefaultControllerDefinition()
  def.axes.forEach((a, i) => {
    a.stepPin = { port: 1, pin: 2 + i * 2, negate: false }
    a.dirPin = { port: 1, pin: 3 + i * 2, negate: false }
  })
  return def
}

/** The same machine with its home switches wired - the negative control. */
function switchedDefinition(): ControllerDefinition {
  const def = switchlessDefinition()
  def.axes.forEach((a, i) => { a.homePin = { port: 2, pin: 1 + i, negate: false } })
  return def
}

function setupMachine(
  definition: ControllerDefinition | null,
  extra: Record<string, unknown> = {},
): void {
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({
    ...machine,
    ...(definition ? { controllerDefinition: definition } : {}),
    ...extra,
  })
}

function dro(column: 'work' | 'machine', axis: 'x' | 'y' | 'z'): HTMLInputElement {
  return screen.getByTestId(`control-dro-${column}-${axis}`) as HTMLInputElement
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
// 1. THE MODE - a property of the machine, asked once, opened only on evidence
// ---------------------------------------------------------------------------

describe('WO-985 the mode: does this machine have home switches at all', () => {
  it('a machine with NO home pin on any axis is switchless - there is nothing to seek', () => {
    expect(machineHasNoHomeSwitches({ controllerDefinition: switchlessDefinition() })).toBe(true)
  })

  it('ONE assigned home pin anywhere is evidence of switches - the mode stays shut', () => {
    const def = switchlessDefinition()
    def.axes[1].homePin = { port: 2, pin: 5, negate: false }
    expect(machineHasNoHomeSwitches({ controllerDefinition: def })).toBe(false)
    expect(machineHasNoHomeSwitches({ controllerDefinition: switchedDefinition() })).toBe(false)
  })

  it('a home pin on a DISABLED spare axis does NOT change the verdict - only enabled/slaved axes are read (WO-1144 slice 1)', () => {
    // Re-pinned by WO-1144: the predicate must not use disabled A/B/C axes to
    // decide whether enabled X/Y/Z can home. Before WO-1144 this assertion
    // read `false` - a spare axis nobody wired was "evidence of switches".
    const def = switchlessDefinition()
    const spare = createDefaultAxisDefinition('A')
    spare.enabled = false
    spare.homePin = { port: 2, pin: 9, negate: false }
    def.axes.push(spare)
    expect(machineHasNoHomeSwitches({ controllerDefinition: def })).toBe(true)
  })

  it('ABSENT IS NOT SWITCHLESS: a machine nobody has described yet answers false', () => {
    // Dashing a readout on the strength of a machine nobody has described
    // would fabricate exactly the fact this order exists to stop fabricating.
    expect(machineHasNoHomeSwitches({})).toBe(false)
    expect(machineHasNoHomeSwitches(null)).toBe(false)
    expect(machineHasNoHomeSwitches(undefined)).toBe(false)
    expect(
      machineHasNoHomeSwitches({ controllerDefinition: { ...switchlessDefinition(), axes: [] } }),
    ).toBe(false)
  })

  it('the WO-301 declaration is the other way a machine says it - the ticked box', () => {
    expect(machineHasNoHomeSwitches({ noHomingSwitches: true })).toBe(true)
    expect(machineHasNoHomeSwitches({ noHomingSwitches: false })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2 + 3. THE DASHED READOUT, AND THE MACHINE WITH SWITCHES THAT IS UNAFFECTED
// ---------------------------------------------------------------------------

describe('WO-985 the DRO', () => {
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

  it('reads dashes for both coordinate rows but keeps reported Work coordinates editable', () => {
    setupMachine(switchlessDefinition())
    render(<ControlPage />)

    for (const axis of ['x', 'y', 'z'] as const) {
      expect(dro('machine', axis).value).toBe('---')
    }
    expect(dro('work', 'x').value).toBe('---')
    expect(dro('work', 'y').value).toBe('---')
    expect(dro('work', 'z').value).toBe('---')
    expect(dro('work', 'x').disabled).toBe(false)
    expect(dro('work', 'y').disabled).toBe(false)
    expect(dro('work', 'z').disabled).toBe(false)
  })

  it('says WHY, in the words Operator asked for - working in the work coordinate system', () => {
    setupMachine(switchlessDefinition())
    const linesBefore = noDatumConsoleTexts()
    render(<ControlPage />)

    expectAddedLine(linesBefore, noDatumConsoleTexts(), SWITCHLESS_NO_DATUM)
  })

  // WO-994 REPIN, 2026-08-25. Operator, at the machine: "it would be dashes when
  // it dashes it means it's undefined so you could either type it in there to
  // set the machine position if it's not homed or type it in there if it
  // dashes to set it." The dash IS the entry surface, and the predicate behind
  // it is now "the machine position is not ESTABLISHED" (`!homed`) rather than
  // "this machine has no switches". Nothing WO-985 proved is weakened; two of
  // its assertions were pinned to decisions Operator has since reversed, and they
  // are repinned onto what he ruled instead. The new behaviour is owned by
  // dashToDefine.wo994.test.tsx.
  it('the dashed cell IS editable - dashed is precisely when it must accept typing', () => {
    // This assertion used to read `.disabled).toBe(true)`, on the strength of
    // THIS FILE'S OWN line 74: "WO-986 supplies its own deliberate entry
    // surface and does not need this cell to become editable in the dashed
    // state." That sentence was written by the architect, not by Operator, three
    // orders after he had described the readout itself as the mechanism, and
    // it is the defect WO-994 exists to undo. The tie is fixed at the tie -
    // there is no second editable path around it.
    setupMachine(switchlessDefinition())
    render(<ControlPage />)
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(dro('machine', axis).value).toBe('---')
      expect(dro('machine', axis).disabled).toBe(false)
    }
  })

  it('NEGATIVE CONTROL: a machine that HAS a datum is untouched - real readout, no note', () => {
    // WO-994 REPIN. This was `switchedDefinition()` alone, unhomed, and it
    // asserted a real readout - which is exactly the reading Operator photographed
    // and rejected: 0.000/0.000/0.000 with the NO DATUM chip beside it. Having
    // home switches is not having a datum; HAVING HOMED is. The negative
    // control is repinned onto the fact that actually distinguishes the two,
    // and it still measures the same thing: the mode must not leak into a
    // machine that knows where it is.
    setupMachine(switchedDefinition())
    act(() => { useMachineControl.setState({ homed: true }) })
    render(<ControlPage />)

    expect(dro('machine', 'x').value).toBe('-123.46') // WO-2261: the DRO shows mm to two places
    expect(dro('machine', 'y').value).toBe('-78.90')
    expect(dro('machine', 'z').value).toBe('-12.50')
    expect(noDatumConsoleTexts()).toEqual([])
    expect(dro('machine', 'x').disabled).toBe(false)
  })

  it('NEGATIVE CONTROL: the switchless SENTENCE never leaks onto a machine that simply has not homed', () => {
    // WO-994 REPIN. This used to type into the machine cell of an unhomed
    // switched machine and demand "home the machine ($H) first" - a GOTO
    // refusal. That cell is a datum ENTRY now while it dashes, so the goto
    // refusal is no longer reachable from it (it survives in `evaluateGoto` as
    // the belt for a homed state that flips while a confirm card is open).
    //
    // The substance being defended is the wording, and it is unchanged and
    // still required by WO-994: a switchless machine can NEVER home, a
    // switched one simply has not homed YET, and those are two sentences that
    // must never be collapsed into one. Measured on the surface that still
    // shows them.
    setupMachine(switchedDefinition())
    const switchedBefore = noDatumConsoleTexts()
    render(<ControlPage />)

    expectAddedLine(switchedBefore, noDatumConsoleTexts(), SWITCHED_NO_DATUM)

    cleanup()
    setupMachine(switchlessDefinition())
    const switchlessBefore = noDatumConsoleTexts()
    render(<ControlPage />)

    expectAddedLine(switchlessBefore, noDatumConsoleTexts(), SWITCHLESS_NO_DATUM)
  })

  it('NEGATIVE CONTROL: the WORK column on a switched, unhomed machine is not gated on a datum', () => {
    // THE AUDIT'S FINDING, PINNED AS THE BEHAVIOUR ACTUALLY IS.
    //
    // Audit round 1 read the acceptance bullet's "still no work-coordinate
    // move" as an instruction to ADD a homing gate to the Work column on a
    // machine with switches. That gate is not implemented, deliberately, and
    // the disagreement is filed in the order's Fix round section for the
    // architect to rule on. Two reasons, both from documents that outrank the
    // bullet: Operator's authority on this very order, verbatim - "if we unlock it
    // allows jog moves regardless of where the machine thinks it is ... but no
    // gcode can be run until home is performed" - and the order's own
    // untouchable list, "jog unhomed: ALLOWED ... Do not weaken either". A
    // Work-column commit dispatches through the SAME `ctrl.jog` primitive the
    // D-pad buttons use (see `attemptGoto`'s doc), so gating it IS gating jog.
    //
    // The behaviour predates this branch and is pinned in the suite that owns
    // it - droGoto.wo303.test.tsx:141, "refuses a machine-column edit while
    // unhomed - the WORK column is unaffected by homing", which runs on the
    // default project machine, a machine WITH home switches.
    //
    // What this order IS bound by is the clause after it: "the mode must not
    // leak into the general case." That is what this test measures - the
    // switched machine's Work column lands on exactly the refusal it landed on
    // before this diff, for a reason that has nothing to do with a datum.
    setupMachine(switchedDefinition())
    render(<ControlPage />)

    const errorsBefore = consoleErrors()
    fireEvent.change(dro('work', 'x'), { target: { value: '10' } })
    fireEvent.blur(dro('work', 'x'))

    // With no controller behind the faked store it stops at `verifiedIdle`.
    // That is the refusal ORDER, not a datum check.
    expectAddedLine(
      errorsBefore,
      consoleErrors(),
      'Goto X work: refused - the machine is moving - wait for it to stop, then try again.',
    )
  })

  it('THE STATE IS DERIVED, NOT HARD-CODED: a datum makes the same machine read real again', () => {
    // This is WO-986's whole exit. That order changes the MODE (it establishes
    // a datum by hand) and does not own ControlPage.tsx - a dash hard-coded
    // into the row would strand it. Here the datum arrives as `homed`, exactly
    // as it will there, and the readout follows with no edit to this file.
    setupMachine(switchlessDefinition())
    const linesBefore = noDatumConsoleTexts()
    const { rerender } = render(<ControlPage />)
    expectAddedLine(linesBefore, noDatumConsoleTexts(), SWITCHLESS_NO_DATUM)
    expect(dro('machine', 'x').value).toBe('---')
    const linesAfterRender = noDatumConsoleTexts()

    act(() => { useMachineControl.setState({ homed: true }) })
    rerender(<ControlPage />)

    expect(dro('machine', 'x').value).toBe('-123.46') // WO-2261: the DRO shows mm to two places
    expect(noDatumConsoleTexts()).toEqual(linesAfterRender)
  })
})

// ---------------------------------------------------------------------------
// 4. THE JOG PANEL - the refusal never names a fix this machine does not have
// ---------------------------------------------------------------------------

describe('WO-985 the Safe Z control', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      alarm: null,
      homed: false,
    })
    // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about the
    // Safe Z tooltip wording, not the E-STOP latch, which starts armed by
    // default and would otherwise cover the tooltip with ESTOP_BLOCKS_MOTION.
    __resetEstopInterlockForTest()
    // WO-1702: Safe Z is one field on the machine record, not a value stored
    // separately with the wiring - written through both the library and
    // project copies so `parkCarrierMachine` sees it however it resolves.
    saveParkMachineRecord(withMachineSafeZ(parkCarrierMachine(useCamStore.getState()), -5))
  })

  afterEach(() => cleanup())

  it('on a switchless machine it never says "home the machine first" - nothing to home', () => {
    setupMachine(switchlessDefinition())
    render(<JogPanel />)

    const tip = screen.getByTestId('control-safez').getAttribute('data-tooltip') ?? ''
    expect(tip).not.toMatch(/home the machine/i)
    expect(tip).toContain('no home switches')
    expect(tip).toContain('safe Z is a machine coordinate')
  })

  it('NEGATIVE CONTROL: a machine with switches still gets the "home the machine first" tooltip', () => {
    setupMachine(switchedDefinition())
    render(<JogPanel />)

    expect(screen.getByTestId('control-safez').getAttribute('data-tooltip'))
      .toBe('Home the machine first - safe Z is a machine coordinate')
  })

  it('the control stays DISABLED either way - the wording changed, the gate did not', () => {
    setupMachine(switchlessDefinition())
    render(<JogPanel />)
    expect((screen.getByTestId('control-safez') as HTMLButtonElement).disabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. THE GATE ITSELF, AND THE MOVES THE RULING PERMITS - real simulator
// ---------------------------------------------------------------------------

// WO-2712: the initial machine X-5 has only 5 mm of positive travel before
// max zero. The same permitted 10 mm work displacements go inward (-X) on
// both machines; homing/zero gates and every switched negative control remain.
describe('WO-985 gates and motion (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    useUiPrefs.setState({ machineGotoSkipConfirm: true })
    useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
  })

  async function connectWithDefinition(definition: ControllerDefinition): Promise<void> {
    setupMachine(definition)
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(1400)
    // AFTER the connect, not before: WO-328 arms the E-STOP latch on every
    // connection transition on purpose ("there is no connection phase in
    // which still-armed is safe"), so a reset before connecting is undone by
    // the connect itself. Clearing it here is what makes the safe-Z
    // assertions below about the HOMING gate rather than about a latch that
    // sits ahead of it - the same isolation ProgramPanel.mcTier1.test.tsx
    // does, for the same reason.
    act(() => { __resetEstopInterlockForTest() })
  }

  afterEach(async () => {
    cleanup()
    act(() => { getMachineController().emergencyStop() })
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
    useUiPrefs.setState({ machineGotoSkipConfirm: false })
  })

  it('NO GATE GOT MORE PERMISSIVE: safe Z is still refused on a switchless machine', async () => {
    await connectWithDefinition(switchlessDefinition())
    const outcome = jogToSafeZ(-5, 1000)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('no home switches')
    expect(outcome.reason).not.toMatch(/home (it|them|the machine) first/i)
  })

  it('NEGATIVE CONTROL: the same gate on a machine with switches names the axes, as before', async () => {
    await connectWithDefinition(switchedDefinition())
    const outcome = jogToSafeZ(-5, 1000)

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('not been homed this session')
    expect(outcome.reason).toContain('Home it first')
  })

  it('THE RULING: a work-coordinate move is PERMITTED on a switchless machine, and it moves', async () => {
    await connectWithDefinition(switchlessDefinition())
    render(<ControlPage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1400) })
    act(() => {
      zeroWorkAxes(['X'])
      getMachineController().queryStatus()
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    const before = useMachineControl.getState().wpos!
    const targetX = Number((before.x - 10).toFixed(3))
    const errorsBefore = consoleErrors()

    expect(dro('work', 'x').value).toBe('---')
    expect(dro('work', 'x').disabled).toBe(false)
    fireEvent.change(dro('work', 'x'), { target: { value: targetX.toFixed(3) } })
    fireEvent.blur(dro('work', 'x'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(consoleErrors()).toEqual(errorsBefore)
    expect(useMachineControl.getState().wpos!.x).toBeCloseTo(targetX, 2)
    // ...and the machine column is still honest about having no datum while
    // that move happens. Permission and honesty are not traded against each
    // other here.
    expect(dro('machine', 'x').value).toBe('---')
  })

  it('NEGATIVE CONTROL, THE CASE AUDIT ROUND 1 NAMED: a work-coordinate move on a machine WITH switches, unhomed, moves too - this mode granted it nothing', async () => {
    await connectWithDefinition(switchedDefinition())
    render(<ControlPage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1400) })

    const before = useMachineControl.getState().wpos!
    const targetX = Number((before.x - 10).toFixed(3))
    const errorsBefore = consoleErrors()

    fireEvent.change(dro('work', 'x'), { target: { value: targetX.toFixed(3) } })
    fireEvent.blur(dro('work', 'x'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(consoleErrors()).toEqual(errorsBefore)
    expect(useMachineControl.getState().wpos!.x).toBeCloseTo(targetX, 2)
    // ...and the machine column is honest about having no datum while that
    // move happens, on THIS machine too.
    //
    // WO-994 REPIN. The tail used to read `.not.toBe('---')` plus "no
    // no-datum note" - the mode must not leak. What leaked was the other way
    // round: an unhomed machine WITH switches was asserting 0.000 it does not
    // have, which is the reading Operator photographed at 17:16. The move
    // assertions above are untouched, which is the part this test is for; the
    // readout now dashes here for the reason it dashes everywhere, and the
    // NOTE is what keeps the two machines distinguishable.
    expect(dro('machine', 'x').value).toBe('---')
    expect(noDatumConsoleTexts()).toEqual([SWITCHED_NO_DATUM])
  })

  it('THE MODE MUST NOT LEAK: switched and switchless answer the WORK column identically - only the machine readout differs', async () => {
    // The acceptance clause this order is actually bound by, measured rather
    // than argued. If the mode had been built as a per-move permission - the
    // guess Operator rejected on the E-STOP button - these two would diverge here.
    // They do not. The same displacement is commanded on both machines, with
    // only the home pins changed between sessions, and the ONLY
    // difference is what the machine column is willing to claim. WO-1147 makes
    // that definition immutable within a session, so the two subjects run in
    // two deliberate sessions instead of mutating one live backend.
    await connectWithDefinition(switchedDefinition())
    const switchedBefore = noDatumConsoleTexts()
    render(<ControlPage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1400) })
    expectAddedLine(switchedBefore, noDatumConsoleTexts(), SWITCHED_NO_DATUM)

    const moveWorkX = async (): Promise<number> => {
      const before = useMachineControl.getState().wpos!
      const targetX = Number((before.x - 10).toFixed(3))
      const errorsBefore = consoleErrors()
      fireEvent.change(dro('work', 'x'), { target: { value: targetX.toFixed(3) } })
      fireEvent.blur(dro('work', 'x'))
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(consoleErrors()).toEqual(errorsBefore)
      return useMachineControl.getState().wpos!.x - before.x
    }

    const withSwitches = await moveWorkX()
    const switchedReadout = dro('machine', 'x').value

    cleanup()
    act(() => { getMachineController().emergencyStop() })
    const disconnect = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnect
    const switchlessBefore = noDatumConsoleTexts()
    await connectWithDefinition(switchlessDefinition())
    render(<ControlPage />)
    expectAddedLine(switchlessBefore, noDatumConsoleTexts(), SWITCHLESS_NO_DATUM)
    act(() => {
      zeroWorkAxes(['X'])
      getMachineController().queryStatus()
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    const withoutSwitches = await moveWorkX()
    const switchlessReadout = dro('machine', 'x').value

    expect(withSwitches).toBeCloseTo(-10, 2)
    expect(withoutSwitches).toBeCloseTo(withSwitches, 2)

    // WO-994 REPIN: what differs, and what no longer does.
    //
    // Both machines dash now, because neither has a datum - "not established"
    // is the predicate, and having switches is not having homed. That is not
    // the mode leaking; it is the mode ceasing to be what decides. What still
    // separates them is the SENTENCE, which WO-994 requires stay two: a
    // switchless machine can never home, a switched one simply has not homed
    // yet. Measured here rather than argued, exactly as before.
    expect(switchedReadout).toBe('---')
    expect(switchlessReadout).toBe('---')
    expect(noDatumConsoleTexts()).toEqual([SWITCHED_NO_DATUM, SWITCHLESS_NO_DATUM])
  })
})
