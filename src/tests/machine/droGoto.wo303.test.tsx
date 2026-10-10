// @vitest-environment jsdom
//
// WO-303: type a number into the readout to go there. Operator's authority note
// (queue/WO-303-type-a-number-into-the-readout-to-go-there.md): typing a
// coordinate into a DRO readout is essentially an MDI G0 <axis><value> - one
// axis, one rapid, through the same jog seam the D-pad buttons already use -
// behind a confirm dialog (with a "do not ask again" checkbox) and the same
// refusals every other motion path in this app already enforces.
//
// This is attempt 3. Two earlier attempts were substantiated-audit-FAILed on
// this exact WO (both preserved on salvage branches, see the queue file):
//   - attempt 1: a card-wide "Enter = confirm" keyboard shortcut, tried two
//     different ways, fired on the card's OWN Cancel/close buttons and on a
//     focus-steal side effect. This attempt does not implement that shortcut
//     at all (see GotoConfirmDialog's doc comment in ControlPage.tsx) - the
//     "keyboard scoping" describe block below proves the removal is safe.
//   - attempt 2: the confirm-time re-derivation read the last REPORTED
//     position/state, which can lag behind a jog that is queued or in flight
//     but not yet reported. This attempt gates the delta on
//     GrblController.verifiedIdle() (WO-087) instead, which flips false the
//     INSTANT any command is written, not on the next status poll. The
//     "confirm card vs concurrent motion" describe block reproduces both of
//     that audit's named repros against this fix.
//
// Two verification styles, matching the established MACHINE-CONTROL split
// (toolsProbePanel.test.tsx): refusal-path tests fake the machine-control
// store directly (fast, synchronous - the machine never needs to actually be
// there for a REFUSAL); the tests that assert real motion connect the real
// simulator end to end (parkPositions.test.tsx's own pattern).

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
  loadMachineProgram,
} = await import('../../lib/machine/machineSession')

function dro(column: 'work' | 'machine', axis: 'x' | 'y' | 'z'): HTMLInputElement {
  return screen.getByTestId(`control-dro-${column}-${axis}`) as HTMLInputElement
}

function commit(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

function consoleErrors(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.severity === 'error')
    .map((line) => line.text)
}

/** WO-1016 repins must prove this action added this exact refusal. */
function expectAddedConsoleError(errorsBefore: string[], expected: string): void {
  const errorsAfter = consoleErrors()
  expect(errorsAfter).toHaveLength(errorsBefore.length + 1)
  expect(errorsAfter.slice(errorsBefore.length)).toEqual([expected])
}

/** The WO-303 simulator cases predate the seeded LienCNC profile and exercise
 * a conventional negative machine frame. State that machine fact in the
 * profile instead of asking fake GRBL settings to override the simulator. */
function selectNegativeMachineFixture(xTravel = 738): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo303-negative-machine',
    name: 'WO-303 negative-frame fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: xTravel, y: 724, z: 130 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'max', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
}

/**
 * Render ControlPage and settle. ControlPage stays mounted for the life of a
 * real session (App.tsx retains it, display:none, across tab switches) - it
 * only ever mounts fresh WHILE disconnected in production. Every test here
 * instead connects first and mounts fresh while already connected, which
 * fires the component's G20/G21-sync-on-connect effect (sendCommand + two
 * refreshState queries) on mount - traffic a real session never sees at this
 * point. That traffic makes verifiedIdle() false for a moment, exactly like
 * any other command would; settling past it here (once, centrally) is
 * environment bookkeeping, not a second production behavior under test.
 */
async function renderControl(): Promise<void> {
  render(<ControlPage />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1400) })
}

// ---------------------------------------------------------------------------
// Refusals - the machine store is faked directly (toolsProbePanel.test.tsx's
// own pattern): a refusal must hold with no real controller behind it at
// all. These all sit ahead of the verifiedIdle() check in evaluateGoto's
// order, so none of them depend on a real connected/idle controller.
// ---------------------------------------------------------------------------
describe('WO-303 refusals', () => {
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
      job: { ...useMachineControl.getState().job, phase: 'empty' },
    })
  })

  afterEach(() => cleanup())

  it('refuses a machine-column target outside the envelope, naming the number and the limit', () => {
    useMachineControl.setState({
      homed: true,
      mpos: { x: 0, y: 0, z: 0 },
      wpos: { x: 0, y: 0, z: 0 },
      // far-corner default (no $23/$27 read): X reachable in [-740, 0].
      settings: { 130: '740.000', 131: '724.000', 132: '130.000' },
    })
    render(<ControlPage />)

    const errorsBefore = consoleErrors()
    commit(dro('machine', 'x'), '50')

    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expectAddedConsoleError(
      errorsBefore,
      "Goto X machine: refused - 50.00 mm is outside the machine's travel (-740.00 to 0.00 mm).",
    )
    expect(useMachineControl.getState().mpos).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('never GOES anywhere from the machine column while unhomed - the WORK column is unaffected by homing', () => {
    // WO-994 REPIN, 2026-08-25. This asserted the machine-column refusal
    // "home the machine ($H) first". While unhomed that cell now DASHES and a
    // typed number SETS the machine position instead of commanding a move -
    // Operator, at the machine: "when it dashes it means it's undefined so you
    // could either type it in there to set the machine position". The goto
    // refusal survives in `evaluateGoto` as the belt for a homed state that
    // flips while a confirm card is open, but the DRO cell no longer reaches
    // it, so this test can no longer name it.
    //
    // WHAT IT DEFENDS IS UNCHANGED AND IS THE SAFETY CLAIM: an unhomed machine
    // column does not MOVE the machine, and the WORK column is a different
    // story. Both are still measured here, and the positive half - that the
    // typed number establishes a datum - is owned by
    // dashToDefine.wo994.test.tsx.
    useMachineControl.setState({
      homed: false,
      mpos: { x: -5, y: -5, z: -5 },
      wpos: { x: -5, y: -5, z: -5 },
    })
    render(<ControlPage />)

    const datumErrorsBefore = consoleErrors()
    commit(dro('machine', 'x'), '10')

    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    // The datum seam's own refusal (nothing is connected behind this faked
    // store), never a goto's - and never a move.
    expectAddedConsoleError(
      datumErrorsBefore,
      'Set X machine position: refused - The software stop is latched. Press CLEAR to reset it.',
    )
    expect(useMachineControl.getState().mpos).toEqual({ x: -5, y: -5, z: -5 })

    // The WORK column is a different story: unhomed does not block it, and
    // (with no real controller connected) it fails only the verifiedIdle
    // check - proving the refusal ORDER, not the substance, differs here.
    const workErrorsBefore = consoleErrors()
    commit(dro('work', 'x'), '10')
    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expectAddedConsoleError(
      workErrorsBefore,
      'Goto X work: refused - the machine is moving - wait for it to stop, then try again.',
    )
  })

  it('refuses while the machine is in alarm', () => {
    useMachineControl.setState({
      machineState: 'alarm',
      homed: true,
      mpos: { x: 0, y: 0, z: 0 },
      wpos: { x: 0, y: 0, z: 0 },
    })
    render(<ControlPage />)

    const errorsBefore = consoleErrors()
    commit(dro('work', 'x'), '10')

    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expectAddedConsoleError(errorsBefore, 'Goto X work: refused - the machine is in alarm.')
    expect(useMachineControl.getState().wpos).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('refuses when the machine has not proven it is idle (no real controller connected)', () => {
    useMachineControl.setState({
      homed: true,
      mpos: { x: 0, y: 0, z: 0 },
      wpos: { x: 0, y: 0, z: 0 },
    })
    render(<ControlPage />)

    const errorsBefore = consoleErrors()
    commit(dro('work', 'x'), '10')

    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expectAddedConsoleError(
      errorsBefore,
      'Goto X work: refused - the machine is moving - wait for it to stop, then try again.',
    )
    expect(useMachineControl.getState().wpos).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('Escape and an unparseable value change nothing - no dialog, no refusal, no motion', () => {
    useMachineControl.setState({
      homed: true,
      mpos: { x: 0, y: 0, z: 0 },
      wpos: { x: 1.5, y: 2, z: 3 },
    })
    render(<ControlPage />)
    const input = dro('work', 'x')
    const shown = input.value // "1.500"
    const errorsBefore = consoleErrors()

    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe(shown)
    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expect(screen.queryByTestId('control-goto-refusal')).toBeNull()
    expect(consoleErrors()).toEqual(errorsBefore)

    fireEvent.change(input, { target: { value: 'not-a-number' } })
    fireEvent.blur(input)
    expect(input.value).toBe(shown)
    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expect(screen.queryByTestId('control-goto-refusal')).toBeNull()
    expect(consoleErrors()).toEqual(errorsBefore)

    expect(useMachineControl.getState().wpos).toEqual({ x: 1.5, y: 2, z: 3 })
  })
})

// ---------------------------------------------------------------------------
// Real motion - connected to the real simulator (parkPositions.test.tsx's own
// pattern), so the assertions are on the ACTUAL reported position, not a
// mock. The beforeEach's connect + settle window is what gets
// verifiedIdle() to true before each test's first commit().
// ---------------------------------------------------------------------------
describe('WO-303 motion (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    selectNegativeMachineFixture()
    useUiPrefs.setState({ machineGotoSkipConfirm: false })
    // The "refusals" describe above fakes homed/settings directly on this
    // SAME module-level store - reset both so nothing it left behind leaks
    // into the real simulator session.
    useMachineControl.setState({ homed: false, settings: {} })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(1400)
    // These cases isolate DRO motion after the startup E-STOP was cleared.
    __resetEstopInterlockForTest()
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
  })

  afterEach(async () => {
    cleanup()
    act(() => { getMachineController().emergencyStop() })
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('typing a WORK coordinate and confirming issues one rapid to that work coordinate on that axis alone', async () => {
    await renderControl()
    const before = useMachineControl.getState().wpos!
    const targetX = Number((before.x - 10).toFixed(3))

    commit(dro('work', 'x'), targetX.toFixed(3))
    const dialog = screen.getByTestId('control-goto-confirm')
    expect(dialog.textContent).toContain('WORK')
    expect(dialog.textContent).toContain('G0 X')
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    const after = useMachineControl.getState().wpos!
    expect(after.x).toBeCloseTo(targetX, 1)
    expect(after.y).toBeCloseTo(before.y, 1)
    expect(after.z).toBeCloseTo(before.z, 1)
  })

  it('typing a MACHINE coordinate and confirming issues one rapid to that machine coordinate on that axis alone', async () => {
    act(() => { getMachineController().home() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    await renderControl()
    const before = useMachineControl.getState().mpos! // {0,0,0} post-home

    commit(dro('machine', 'x'), '-50.000')
    const dialog = screen.getByTestId('control-goto-confirm')
    expect(dialog.textContent).toContain('MACHINE')
    expect(dialog.textContent).toContain('G53 G0 X')
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    const after = useMachineControl.getState().mpos!
    expect(after.x).toBeCloseTo(-50, 1)
    expect(after.y).toBeCloseTo(before.y, 1)
    expect(after.z).toBeCloseTo(before.z, 1)
  })

  it('refuses while a program is running, and leaves the machine unmoved', async () => {
    await renderControl()
    // Enough lines that the 128-byte RX-buffer window cannot stuff (and so
    // cannot ack) all of them synchronously - machineControlSafety.test.tsx's
    // own "mid-stream" precedent. A single G4 dwell acks and completes
    // instantly in this simulator, so it cannot hold the job open on its own.
    const longProgram = Array.from({ length: 30 }, (_, i) => `G1 X-${i} F100`).join('\n')
    act(() => { loadMachineProgram('wo303.nc', longProgram) })
    act(() => { getMachineController().startJob() })
    expect(getMachineController().hasActiveJob()).toBe(true)

    const before = useMachineControl.getState().wpos!
    const errorsBefore = consoleErrors()
    commit(dro('work', 'x'), (before.x + 5).toFixed(3))

    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expectAddedConsoleError(errorsBefore, 'Goto X work: refused - a program is running.')
    expect(useMachineControl.getState().wpos).toEqual(before)
  })

  it('Cancel leaves the machine unmoved', async () => {
    await renderControl()
    const before = useMachineControl.getState().wpos!
    commit(dro('work', 'x'), (before.x - 20).toFixed(3))
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()

    fireEvent.click(screen.getByTestId('control-goto-confirm-cancel'))
    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    expect(useMachineControl.getState().wpos).toEqual(before)
  })

  it('the header close (X) button also cancels, leaving the machine unmoved', async () => {
    await renderControl()
    const before = useMachineControl.getState().wpos!
    commit(dro('work', 'x'), (before.x - 20).toFixed(3))
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()

    fireEvent.click(screen.getByTestId('control-goto-confirm-close'))
    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    expect(useMachineControl.getState().wpos).toEqual(before)
  })

  it('"do not ask again" suppresses the dialog and still moves; clearing it brings the dialog back', async () => {
    act(() => { getMachineController().home() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    await renderControl()

    commit(dro('machine', 'x'), '-10.000')
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()
    fireEvent.click(screen.getByTestId('control-goto-confirm-suppress'))
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })

    expect(useUiPrefs.getState().machineGotoSkipConfirm).toBe(true)
    expect(useMachineControl.getState().mpos!.x).toBeCloseTo(-10, 1)
    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()

    // Suppressed: the SAME edit on another axis moves with no dialog at all.
    commit(dro('machine', 'y'), '-10.000')
    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(useMachineControl.getState().mpos!.y).toBeCloseTo(-10, 1)

    // Clearing the pref brings the dialog back.
    act(() => { useUiPrefs.setState({ machineGotoSkipConfirm: false }) })
    commit(dro('machine', 'z'), '-10.000')
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(useMachineControl.getState().mpos!.z).toBeCloseTo(-10, 1)
  })

  it('skip-confirm surfaces a refusal (and reverts the DRO) instead of silently doing nothing', async () => {
    // WO-994 REPIN, 2026-08-25. The refusal this reached used to be "home the
    // machine ($H) first", typed into an unhomed machine cell. That cell is a
    // datum entry now while it dashes (see dashToDefine.wo994.test.tsx), so
    // this drives the SAME claim - skip-confirm suppresses the card, never the
    // refusal, and a refused commit still reverts the cell - through a machine
    // that HAS a datum and a refusal that is squarely a goto's. The envelope
    // is the refusal used because it is the one this simulator produces
    // deterministically: it homes at 0 and travels negative, so +10 is off the
    // end of the table.
    useUiPrefs.setState({ machineGotoSkipConfirm: true })
    act(() => { getMachineController().home() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    await renderControl()
    const input = dro('machine', 'x')
    const shown = input.value
    expect(shown).not.toBe('---')

    const errorsBefore = consoleErrors()
    commit(input, '10')

    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expectAddedConsoleError(
      errorsBefore,
      "Goto X machine: refused - 10.00 mm is outside the machine's travel (-738.00 to 0.00 mm).",
    )
    expect(input.value).toBe(shown)
  })
})

// ---------------------------------------------------------------------------
// WO-389/WO-1755: the simulator follows the selected machine profile, while
// GRBL itself fixes machine zero at the homing switch. A max-homed GRBL axis
// therefore accepts DRO targets in -travel..0 on X, Y and Z alike.
// ---------------------------------------------------------------------------
describe('WO-389/WO-1755 negative machine-coordinate DRO motion (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      // WO-2712: this is a distinct max-homed fixture with work zero at home,
      // not the shipped sample whose fresh G54 is on the simulated part.
      id: 'wo1755-negative-machine',
      travel: { x: 738, y: 724.5, z: 128.9 },
      rapidRate: 60000,
      homeConvention: {
        x: { homesToward: 'max', machineZeroAt: 'max' },
        y: { homesToward: 'max', machineZeroAt: 'max' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      },
    })
    useUiPrefs.setState({ machineGotoSkipConfirm: true })
    useMachineControl.setState({ homed: false, settings: {} })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(1400)
    __resetEstopInterlockForTest()
    act(() => { getMachineController().home() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  })

  afterEach(async () => {
    cleanup()
    act(() => { getMachineController().emergencyStop() })
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('accepts an absolute -30 mm work target on X, Y and Z after homing at max', async () => {
    await renderControl()
    expect(useMachineControl.getState().wpos).toEqual({ x: 0, y: 0, z: 0 })

    for (const axis of ['x', 'y', 'z'] as const) {
      const errorsBefore = consoleErrors()
      commit(dro('work', axis), '-30')
      expect(screen.queryByTestId('control-goto-refusal')).toBeNull()
      expect(consoleErrors()).toEqual(errorsBefore)
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(useMachineControl.getState().wpos![axis]).toBeCloseTo(-30, 1)
    }

    expect(useMachineControl.getState().mpos).toEqual({ x: -30, y: -30, z: -30 })
  })
})

// ---------------------------------------------------------------------------
// Keyboard scoping and focus. WO-303's queue file records two substantiated
// audit FAILs from earlier attempts at giving this card a card-wide
// "Enter = confirm" shortcut (a window listener that fired on any page
// Enter, then a container-scoped one that fired on the card's OWN
// Cancel/close buttons because their native Enter-click races an ancestor
// keydown listener). This attempt implements no such shortcut - Move/Cancel
// fire only from a click, or from Tab-focusing that specific button and
// using the browser's own Enter/Space default action. These tests prove
// that absence is safe (Enter on Cancel does not move anything) and that
// the one shortcut this attempt DOES keep (Escape, unambiguous regardless of
// which element inside the card has focus) still works. They also prove the
// card does not steal focus - the OTHER mechanism the second attempt-1
// audit round found reopened the same bug class.
// ---------------------------------------------------------------------------
describe('WO-303 confirm-card keyboard and focus', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    selectNegativeMachineFixture()
    useUiPrefs.setState({ machineGotoSkipConfirm: false })
    useMachineControl.setState({ homed: false, settings: {} })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(1400)
    __resetEstopInterlockForTest()
  })

  afterEach(async () => {
    cleanup()
    act(() => { getMachineController().emergencyStop() })
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('opening the card does not steal focus from wherever the operator already was', async () => {
    await renderControl()
    const mdiInput = screen.getByTestId('control-mdi-input')
    mdiInput.focus()
    expect(document.activeElement).toBe(mdiInput)

    const before = useMachineControl.getState().wpos!
    commit(dro('work', 'x'), (before.x + 10).toFixed(3))
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()

    // A non-modal card must leave focus where the operator put it - not on
    // itself, and not on the MDI box either (blur() moved it off already).
    expect(document.activeElement).not.toBe(screen.getByTestId('control-goto-confirm'))
  })

  it('Enter pressed on the card\'s own Cancel button does not move the machine', async () => {
    await renderControl()
    const before = useMachineControl.getState().wpos!
    commit(dro('work', 'x'), (before.x + 10).toFixed(3))
    const cancelBtn = screen.getByTestId('control-goto-confirm-cancel')

    fireEvent.keyDown(cancelBtn, { key: 'Enter' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    expect(useMachineControl.getState().wpos).toEqual(before)
  })

  it('Enter pressed on the card\'s own close button does not move the machine', async () => {
    await renderControl()
    const before = useMachineControl.getState().wpos!
    commit(dro('work', 'x'), (before.x + 10).toFixed(3))
    const closeBtn = screen.getByTestId('control-goto-confirm-close')

    fireEvent.keyDown(closeBtn, { key: 'Enter' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    expect(useMachineControl.getState().wpos).toEqual(before)
  })

  it('Enter pressed on the "do not ask again" checkbox does not move the machine', async () => {
    await renderControl()
    const before = useMachineControl.getState().wpos!
    commit(dro('work', 'x'), (before.x + 10).toFixed(3))
    const checkbox = screen.getByTestId('control-goto-confirm-suppress')

    fireEvent.keyDown(checkbox, { key: 'Enter' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    // Still pending - a stray Enter on the checkbox neither confirmed nor
    // moved the machine.
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()
    expect(useMachineControl.getState().wpos).toEqual(before)
  })

  it('Escape pressed anywhere inside the card cancels it, leaving the machine unmoved', async () => {
    await renderControl()
    const before = useMachineControl.getState().wpos!
    commit(dro('work', 'x'), (before.x + 10).toFixed(3))
    const checkbox = screen.getByTestId('control-goto-confirm-suppress')

    fireEvent.keyDown(checkbox, { key: 'Escape' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    expect(screen.queryByTestId('control-goto-confirm')).toBeNull()
    expect(useMachineControl.getState().wpos).toEqual(before)
  })

  it('Escape pressed in an unrelated DRO cell does not cancel the pending goto', async () => {
    await renderControl()
    const before = useMachineControl.getState().wpos!
    commit(dro('work', 'x'), (before.x + 10).toFixed(3))
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()

    fireEvent.keyDown(dro('work', 'z'), { key: 'Escape' })

    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()
  })

  it('Tab-focusing the Move button and pressing Enter confirms through the button\'s own native action', async () => {
    await renderControl()
    const before = useMachineControl.getState().wpos!
    const targetX = Number((before.x - 10).toFixed(3))
    commit(dro('work', 'x'), targetX.toFixed(3))
    const moveBtn = screen.getByTestId('control-goto-confirm-move')

    // jsdom does not implement the browser's native "Enter activates the
    // focused button" default action, so this proves the card's own keydown
    // handler does not intercept a button-targeted Enter (it has no Enter
    // branch at all) - the click below is what real Enter-on-a-button
    // resolves to.
    fireEvent.keyDown(moveBtn, { key: 'Enter' })
    expect(useMachineControl.getState().wpos).toEqual(before)
    fireEvent.click(moveBtn)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(useMachineControl.getState().wpos!.x).toBeCloseTo(targetX, 1)
  })
})

// ---------------------------------------------------------------------------
// Confirm card vs concurrent motion - the substantiated attempt-2 audit
// finding this attempt is built to close. Both repros fire a jog UNDER the
// open card and then press Move with NO time advance in between, so the jog
// is guaranteed still in flight/unreported - the exact gap verifiedIdle()
// (not machineState/mpos/wpos) exists to catch. The correct outcome is a
// REFUSAL, not an overshoot: composing onto motion that has not been proven
// finished would repeat the audit's finding.
// ---------------------------------------------------------------------------
describe('WO-303 confirm card vs concurrent motion', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    // Audit repro B's own stated machine: X reachable in [-100, 0].
    selectNegativeMachineFixture(100)
    useUiPrefs.setState({ machineGotoSkipConfirm: false })
    useMachineControl.setState({ homed: false, settings: {} })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(1400)
    __resetEstopInterlockForTest()
    act(() => { getMachineController().home() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  })

  afterEach(async () => {
    cleanup()
    act(() => { getMachineController().emergencyStop() })
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('AUDIT B repro: a D-pad jog fired under the open card refuses Move instead of composing onto it', async () => {
    useUiPrefs.setState({ machineJogStepMm: 10 })
    await renderControl()
    commit(dro('machine', 'x'), '-90.000')
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()

    // The card is non-modal by design - the D-pad stays live underneath it.
    // No time advance: the jog write has happened (controllerActivity has
    // already moved) but nothing has been reported back yet.
    fireEvent.pointerDown(screen.getByTestId('control-jog-x-minus'))
    fireEvent.pointerUp(screen.getByTestId('control-jog-x-minus'))

    const errorsBefore = consoleErrors()
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    // Refused, not overshot: the card is gone (evaluateGoto always closes
    // it) but no SECOND rapid was issued on top of the jog.
    expectAddedConsoleError(
      errorsBefore,
      'Goto X machine: refused - the machine is moving - wait for it to stop, then try again.',
    )
    const finalX = useMachineControl.getState().mpos!.x
    // The D-pad's own 10mm-step jog completed (it was never refused - only
    // the goto was) and landed inside the envelope; the goto's own -90 rapid
    // did not additionally fire on top of it.
    expect(finalX).toBeCloseTo(-10, 0)
    expect(finalX).toBeGreaterThanOrEqual(-100)
  })

  it('AUDIT C repro: one arrow-key jog fired under the open card refuses Move instead of composing onto it', async () => {
    useCamStore.setState({ workspace: 'control' })
    // The console is a capped ring; count from an empty one so an old error
    // rolling off cannot mask the one this test adds (WO-1182).
    useMachineControl.setState({ consoleLines: [] })
    await renderControl()
    commit(dro('machine', 'x'), '-20.000')
    const dialog = screen.getByTestId('control-goto-confirm')
    expect(dialog).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    // No time advance - the arrow jog's write has happened, nothing reported.
    const errorsBefore = consoleErrors()
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expectAddedConsoleError(
      errorsBefore,
      'Goto X machine: refused - the machine is moving - wait for it to stop, then try again.',
    )
    const finalX = useMachineControl.getState().mpos!.x
    expect(finalX).not.toBeCloseTo(-20, 1)
    expect(finalX).toBeGreaterThanOrEqual(-100)
  })

  it('once the jog is proven finished (a settle window passes), Move on a freshly-typed target still works', async () => {
    await renderControl()
    fireEvent.pointerDown(screen.getByTestId('control-jog-x-minus'))
    fireEvent.pointerUp(screen.getByTestId('control-jog-x-minus'))
    // Let the jog finish AND be reported (verifiedIdle proven true again)
    // before opening the card at all.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    commit(dro('machine', 'x'), '-90.000')
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()
    const errorsBefore = consoleErrors()
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(screen.queryByTestId('control-goto-refusal')).toBeNull()
    expect(consoleErrors()).toEqual(errorsBefore)
    expect(useMachineControl.getState().mpos!.x).toBeCloseTo(-90, 1)
  })

  it('re-runs the refusal checks (not just the delta) at confirm time: an alarm arising while the card is open refuses Move instead of executing it', async () => {
    await renderControl()
    const before = useMachineControl.getState().mpos!
    commit(dro('machine', 'x'), '-90.000')
    expect(screen.getByTestId('control-goto-confirm')).toBeTruthy()

    // The card passed its checks at open time (idle); the machine alarms
    // while it sits open, same as a hard-limit trip mid-read of the card.
    act(() => { useMachineControl.setState({ machineState: 'alarm' }) })

    const errorsBefore = consoleErrors()
    fireEvent.click(screen.getByTestId('control-goto-confirm-move'))
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })

    expectAddedConsoleError(errorsBefore, 'Goto X machine: refused - the machine is in alarm.')
    expect(useMachineControl.getState().mpos).toEqual(before)
  })
})
