// @vitest-environment jsdom
//
// MC-TIER1 completion: the two operator-facing Control-tab gaps this work
// order closed.
//
//   1. Run-from-line is reachable as a per-line gesture, and the caution
//      surface shows WHAT resumes (the target line's g-code) and WHERE the
//      machine will go first (the reconstructed WCS resume position) - not
//      just the modal prelude.
//   2. Single Block is a MODE on the fixed operator bar. The one CYCLE START
//      executes one block while it is on; there is no second Step control.
//
// Fail-loud posture (ADR-0003): nothing here may auto-start or auto-resume.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'

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

const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

// A program with real modal state to reconstruct: WCS, units, spindle, feed,
// then a plunge and two cuts. Line 6 is a sane resume target.
const PROGRAM = [
  'G21 G90 G54',
  'M3 S12000',
  'G0 X0 Y0',
  'G0 Z5',
  'G1 Z-2 F300',
  'G1 X10 Y0 F800',
  'G1 X10 Y10',
  'G0 Z5',
  'M5',
  'M30',
].join('\n')

/** The program uses work Z -2..5. GRBL homes at machine Z0 and travels
 * negative, so G54 Z -5 maps those moves to machine Z -7..0. */
function selectProgramMotionFixture(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'mc-tier1-program-motion-machine',
    name: 'MC-TIER1 program motion fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 0 },
    },
  })
}

async function establishProgramWorkOffset(): Promise<void> {
  if (!setWorkOffsetValue('G54', 'Z', -5)) throw new Error('The simulator refused the G54 Z fixture offset.')
  await vi.advanceTimersByTimeAsync(50)
}

function renderOperatorProgram() {
  return render(
    <>
      <ControlTransportBar />
      <ProgramPanel />
    </>,
  )
}

describe('MC-TIER1: run-from-line per-line gesture and caution surface', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useUiPrefs.setState({ machineDisplayUnits: 'mm' })
    selectProgramMotionFixture()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
    // WO-328 (47b49e15/d9557456): a session starts E-STOP-latched and
    // refuses all motion until reset, per controlTabRegrid.test.tsx.
    act(() => { __resetEstopInterlockForTest() })
    if (!getMachineController().home()) throw new Error('The simulator refused the homed fixture.')
    await vi.advanceTimersByTimeAsync(2_000)
    await establishProgramWorkOffset()
    act(() => {
      loadMachineProgram('mctier1.nc', PROGRAM)
    })
  })

  afterEach(async () => {
    cleanup()
    // A stepped job stays active with a line in flight. Without this the NEXT
    // test's step() is refused on stale in-flight state, not on its own logic.
    act(() => getMachineController().emergencyStop())
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
    act(() => useMachineControl.getState().setSingleBlock(false))
  })

  it('hovering a line offers "Run from here" and planning it opens the caution surface', async () => {
    render(<ProgramPanel />)
    expect(screen.queryByTestId('control-runfrom-here-6')).toBeNull()

    fireEvent.mouseEnter(screen.getByText('G1 X10 Y0 F800').closest('.gcode-line')!)
    const action = screen.getByTestId('control-runfrom-here-6')

    await act(async () => { fireEvent.click(action) })
    expect(screen.getByTestId('control-runfrom-planbox')).toBeTruthy()
  })

  it('the caution surface names the target line g-code and the WCS resume position', async () => {
    render(<ProgramPanel />)
    fireEvent.mouseEnter(screen.getByText('G1 X10 Y0 F800').closest('.gcode-line')!)
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-here-6')) })

    // WHAT resumes: the actual g-code of the target line, not just its number.
    expect(screen.getByTestId('control-runfrom-target').textContent).toContain('G1 X10 Y0 F800')

    // WHERE it goes first: the reconstructed position, to 2dp in mm, in WCS.
    const resume = screen.getByTestId('control-runfrom-resume').textContent ?? ''
    expect(resume).toContain('WCS')
    expect(resume).toMatch(/X\s*0\.00(?![\d.])/)
    expect(resume).toMatch(/Y\s*0\.00(?![\d.])/)
    expect(resume).toMatch(/Z\s*-2\.00(?![\d.])/)

    act(() => { useUiPrefs.setState({ machineDisplayUnits: 'inch' }) })
    const inchResume = screen.getByTestId('control-runfrom-resume').textContent ?? ''
    expect(inchResume).toMatch(/X\s*0\.000(?![\d.])/)
    expect(inchResume).toMatch(/Y\s*0\.000(?![\d.])/)
    expect(inchResume).toMatch(/Z\s*-0\.079(?![\d.])/)
    // Presentation changes; the G21 program and reconstructed mm state do not.
    expect(screen.getByTestId('control-runfrom-target').textContent).toContain('G1 X10 Y0 F800')
  })

  it('line 1 is never a resume target - there is no modal state ahead of it', () => {
    render(<ProgramPanel />)
    fireEvent.mouseEnter(screen.getByText('G21 G90 G54').closest('.gcode-line')!)
    expect(screen.queryByTestId('control-runfrom-here-1')).toBeNull()
  })

  it('right-clicking a line opens its menu and Run from here plans it', async () => {
    render(<ProgramPanel />)
    const row = screen.getByText('G1 X10 Y0 F800').closest('.gcode-line')!
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => { row.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(true)
    expect(screen.queryByTestId('control-runfrom-planbox')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByTestId('control-line-menu-runfrom')) })
    expect(screen.getByTestId('control-runfrom-planbox')).toBeTruthy()
  })

  it('arms run-from-line without a second Start button and uses canonical CYCLE START', async () => {
    renderOperatorProgram()
    fireEvent.mouseEnter(screen.getByText('G1 X10 Y0 F800').closest('.gcode-line')!)
    await act(async () => { fireEvent.click(screen.getByTestId('control-runfrom-here-6')) })

    expect(screen.getByTestId('control-runfrom-planbox')).toBeTruthy()
    expect(screen.queryByTestId('control-runfrom-start')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'CYCLE START' })).toHaveLength(1)

    await act(async () => { fireEvent.click(screen.getByTestId('control-cyclestart')) })
    expect(useMachineControl.getState().job.startedAt).not.toBeNull()
  })
})

describe('MC-TIER1: Single Block is a mode, not a bare action', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useUiPrefs.setState({ machineDisplayUnits: 'mm' })
    selectProgramMotionFixture()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
    // WO-328 (47b49e15/d9557456): a session starts E-STOP-latched and
    // refuses all motion until reset, per controlTabRegrid.test.tsx.
    act(() => { __resetEstopInterlockForTest() })
    // WO-1502: the transport keyboard shortcut only acts while the Control
    // workspace is the one showing (ControlPage stays mounted but hidden
    // elsewhere). This suite drives the operator's Control surface, so it runs
    // in that workspace.
    act(() => { useCamStore.setState({ workspace: 'control' }) })
    await establishProgramWorkOffset()
    act(() => {
      loadMachineProgram('mctier1.nc', PROGRAM)
    })
  })

  afterEach(async () => {
    cleanup()
    // A stepped job stays active with a line in flight. Without this the NEXT
    // test's step() is refused on stale in-flight state, not on its own logic.
    act(() => getMachineController().emergencyStop())
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
    act(() => useMachineControl.getState().setSingleBlock(false))
  })

  it('defaults off, toggles on, and reports its state to assistive tech', () => {
    renderOperatorProgram()
    const toggle = screen.getByTestId('control-singleblock-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    act(() => { fireEvent.click(toggle) })
    expect(useMachineControl.getState().singleBlock).toBe(true)
    expect(screen.getByTestId('control-singleblock-toggle').getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps one CYCLE START and changes its meaning to one block while the mode is on', () => {
    renderOperatorProgram()
    const starts = screen.getAllByRole('button', { name: 'CYCLE START' })
    expect(starts).toHaveLength(1)
    expect((starts[0] as HTMLButtonElement).disabled).toBe(false)

    act(() => { fireEvent.click(screen.getByTestId('control-singleblock-toggle')) })
    expect((screen.getByTestId('control-cyclestart') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('control-next-action').textContent).toMatch(/executes one block/i)
    expect(screen.queryByRole('button', { name: /step/i })).toBeNull()

    act(() => { fireEvent.click(screen.getByTestId('control-singleblock-toggle')) })
    expect((screen.getByTestId('control-cyclestart') as HTMLButtonElement).disabled).toBe(false)
  })

  it("'S' steps exactly one line while the mode is on", () => {
    renderOperatorProgram()
    act(() => { fireEvent.click(screen.getByTestId('control-singleblock-toggle')) })

    const before = useMachineControl.getState().job.sentLines
    act(() => { fireEvent.keyDown(window, { key: 's' }) })
    const after = useMachineControl.getState().job.sentLines

    expect(after).toBe(before + 1)
  })

  it("'S' does nothing while the mode is off, and never fires from a text field", () => {
    renderOperatorProgram()
    const before = useMachineControl.getState().job.sentLines

    act(() => { fireEvent.keyDown(window, { key: 's' }) })
    expect(useMachineControl.getState().job.sentLines).toBe(before)

    act(() => { fireEvent.click(screen.getByTestId('control-singleblock-toggle')) })
    const input = screen.getByTestId('control-runfrom-input')
    act(() => { fireEvent.keyDown(input, { key: 's' }) })
    expect(useMachineControl.getState().job.sentLines).toBe(before)
  })

  it('turning the mode off mid-job does not move the machine by itself', () => {
    renderOperatorProgram()
    act(() => { fireEvent.click(screen.getByTestId('control-singleblock-toggle')) })
    act(() => { getMachineController().stepJob() })

    const sentAfterStep = useMachineControl.getState().job.sentLines
    expect(sentAfterStep).toBe(1)

    // Toggling the MODE is not a motion gesture. Resuming stays the
    // operator's explicit act (ADR-0003: never auto-resume).
    act(() => { fireEvent.click(screen.getByTestId('control-singleblock-toggle')) })
    expect(useMachineControl.getState().job.sentLines).toBe(sentAfterStep)
  })
})
