// @vitest-environment jsdom
//
// UCCNC-hitlist tier-1 small items: the safe-Z jog macro (machine-frame $J
// with G53 - soft limits apply, parser modal state untouched), the cycle
// event log, and the job-properties readout.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

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

const { computeJobStats } = await import('../../lib/machine/materialFit')
const { buildPreviewModel } = await import('../../lib/machine/previewGeometry')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions, parkCarrierMachine, saveParkMachineRecord } = await import('../../store/machineActionsStore')
const { useCamStore } = await import('../../store')
const { withMachineSafeZ } = await import('../../types')
const { CycleLogPanel } = await import('../../components/machine/CycleLogPanel')
const { JogPanel } = await import('../../components/machine/JogPanel')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  jogToSafeZ,
  loadMachineProgram,
} = await import('../../lib/machine/machineSession')

/** These simulator checks use positive XY and negative machine Z. */
function selectTier1MotionFixture(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'tier1-small-motion-machine',
    name: 'Tier 1 small motion fixture',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
}

describe('safe-Z jog macro (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    selectTier1MotionFixture()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    // WO-328 (47b49e15/d9557456): a session starts E-STOP-latched and
    // refuses all motion until reset, per controlTabRegrid.test.tsx.
    act(() => { __resetEstopInterlockForTest() })
  })

  afterEach(async () => {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('refuses unhomed and without a safe Z, with plain reasons', async () => {
    expect(jogToSafeZ(-2, 3000).reason).toContain('Home')
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    expect(jogToSafeZ(null, 3000).reason).toMatch(/Safe Z on the Machine tab/)
  })

  it('raises to the MACHINE-frame Z, ignoring work offsets, without touching G90/G91', async () => {
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    // A Z work offset must NOT bend the safe-Z target (G53 jog = machine frame).
    getMachineController().sendCommand('G10 L2 P1 Z-30')
    await vi.advanceTimersByTimeAsync(50)
    // Put the parser in G91 to prove the jog leaves modal state alone.
    getMachineController().sendCommand('G91')
    await vi.advanceTimersByTimeAsync(50)

    const out = jogToSafeZ(-2, 3000)
    expect(out.ok).toBe(true)
    await vi.advanceTimersByTimeAsync(3000)
    // Re-read $G: the controller must still report G91 (jogs bypass modal state).
    getMachineController().refreshState()
    await vi.advanceTimersByTimeAsync(100)
    const s = useMachineControl.getState()
    expect(s.mpos?.z).toBeCloseTo(-2, 1)
    expect(s.parserModal?.distanceMode).toBe('incremental') // G91 untouched
  })
})

describe('cycle event log', () => {
  beforeEach(() => {
    useMachineControl.setState({ cycleEvents: [], job: { ...useMachineControl.getState().job, name: 'plate.nc' } })
  })

  it('records start/pause/resume/complete and failure lines in order', () => {
    const s = useMachineControl.getState()
    s.applyJobEvent('started', null)
    s.applyJobEvent('paused', null)
    s.applyJobEvent('resumed', null)
    // WO-423: the contract's JobFault - `line` for a text backend.
    s.applyJobEvent('failed', { code: 9, message: 'locked (G1 X1)', line: 42, moveId: null })
    const events = useMachineControl.getState().cycleEvents
    expect(events.map((e) => e.event)).toEqual(['started', 'paused', 'resumed', 'failed'])
    expect(events[0].name).toBe('plate.nc')
    expect(events[3].line).toBe(42)
  })

  it('a synchronous-transport run logs started then completed EXACTLY once (reentrancy guard)', async () => {
    // The simulator acks synchronously, so the streamer's fill->ack loop is
    // reentrant: before the guard, one run logged one 'completed' per line
    // (5x), all BEFORE 'started'. The cycle log exposed it; this pins the fix.
    vi.useFakeTimers()
    try {
      useCamStore.getState().newProject()
      selectTier1MotionFixture()
      const pending = connectMachine('simulator', 115200)
      await vi.advanceTimersByTimeAsync(300)
      await pending
      await vi.advanceTimersByTimeAsync(50)
      act(() => { __resetEstopInterlockForTest() })
      expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
      useMachineControl.setState({ cycleEvents: [] })
      // WO-433: M30, not M2 - the native simulator's interpreter is scoped to
      // exactly the M-codes src/lib/post/dialects/uccnc.ts's default config
      // can emit (SUPPORTED_M in simulatedController.ts, a deliberate WO-428
      // choice), and LienCAM's own post always emits M30, never M2.
      loadMachineProgram('t.nc', 'G21\nG90\nG1 X20 Y10 F6000\nG1 X40 Y20 Z-1.5\nM30\n')
      expect(getMachineController().startJob()).toBe(true)
      await vi.advanceTimersByTimeAsync(15000)
      const events = useMachineControl.getState().cycleEvents.map((e) => e.event)
      expect(events).toEqual(['started', 'completed'])
      const done = disconnectMachine()
      await vi.advanceTimersByTimeAsync(100)
      await done
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps the log instead of growing forever', () => {
    const s = useMachineControl.getState()
    for (let i = 0; i < 60; i++) s.applyJobEvent('started', null)
    expect(useMachineControl.getState().cycleEvents.length).toBeLessThanOrEqual(50)
  })

  it('panel renders newest first and marks failures', () => {
    render(<CycleLogPanel />)
    act(() => {
      const s = useMachineControl.getState()
      s.applyJobEvent('started', null)
      s.applyJobEvent('failed', { code: 9, message: 'x', line: 7, moveId: null })
    })
    fireEvent.click(screen.getByTestId('control-cyclelog-toggle')) // default collapsed
    const rows = screen.getByTestId('control-cyclelog').querySelectorAll('.control-cyclelog-row')
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('FAILED')
    expect(rows[0].textContent).toContain('line 7')
    cleanup()
  })
})

describe('job properties', () => {
  it('computeJobStats separates cut and travel bounds and counts moves', () => {
    const model = buildPreviewModel(
      ['G21', 'G90', 'G0 X100 Y100', 'G0 X0 Y0 Z-3', 'G1 X10 Y0 F600', 'G2 X20 Y0 I5 J0', 'G0 Z5'].join(
        '\n',
      ),
    )
    const stats = computeJobStats(model)
    expect(stats.moves.feed).toBe(1)
    expect(stats.moves.arc).toBe(1)
    expect(stats.moves.rapid).toBeGreaterThanOrEqual(3)
    expect(stats.cut).not.toBeNull()
    expect(stats.cut!.minX).toBe(0)
    expect(stats.cut!.maxX).toBe(20)
    expect(stats.cut!.zMin).toBe(-3)
    expect(stats.all!.maxX).toBe(100)
  })

  // WO-414 batch 3b (Operator ruling 2026-08-21: "I don't think [Info] is currently
  // useful"): the Info chip and its readout card are deleted from
  // ProgramPanel. computeJobStats/buildPreviewModel stay pinned above - the
  // math is still used by other callers - but there is no ProgramPanel UI
  // left to open a card with.
  it('ProgramPanel renders with no Info chip or job-properties card', () => {
    useCamStore.getState().newProject()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
    loadMachineProgram('info.nc', 'G21\nG90\nG1 X10 Y10 F600\nG1 X30 Y20')
    render(<ProgramPanel />)
    expect(screen.queryByTestId('control-jobinfo-toggle')).toBeNull()
    expect(screen.queryByTestId('control-jobinfo-card')).toBeNull()
    cleanup()
  })
})

describe('JogPanel Safe Z button', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    selectTier1MotionFixture()
    useMachineActions.setState({ byMachine: {} })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
    // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about the
    // safe-Z/homed gate on the button, not the E-STOP latch.
    __resetEstopInterlockForTest()
  })

  afterEach(async () => {
    cleanup()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('is disabled until a safe Z exists, enabled homed + idle with one set', () => {
    render(<JogPanel />)
    const btn = screen.getByTestId('control-safez') as HTMLButtonElement
    expect(btn.disabled).toBe(true) // no safe Z configured
    // WO-1702: Safe Z is one field on the machine record, not a value stored
    // separately with the wiring.
    act(() => saveParkMachineRecord(withMachineSafeZ(parkCarrierMachine(useCamStore.getState()), -2)))
    expect((screen.getByTestId('control-safez') as HTMLButtonElement).disabled).toBe(false)
    act(() => useMachineControl.setState({ homed: false }))
    expect((screen.getByTestId('control-safez') as HTMLButtonElement).disabled).toBe(true)
  })
})

// WO-115: the PROGRAM header strip's two load-bearing facts (loaded file name
// and skipped-line count) moved into the controls row. WO-414 batch 3 (R9,
// Operator 2026-08-21 Approve: "3 skipped" leaves the bar): the count is now the
// program name's hover text (and a line in the Info card), still a real
// statement about what will not be sent - present even when zero. These
// exercise the real load path (the file input -> applyProgram -> local meta
// state) so the relocated readouts are asserted in the DOM, not just in the
// store.
describe('WO-115 relocated program facts (file name + skipped count)', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
  })

  afterEach(() => cleanup())

  it('renders the loaded file name and "0 skipped" when no lines are filtered', async () => {
    render(<ProgramPanel />)
    const input = screen.getByTestId('control-file-input') as HTMLInputElement
    // All-sendable program: no comments, blanks, or % markers -> skipped 0.
    fireEvent.change(input, {
      target: { files: [new File(['G21\nG90\nG1 X10 Y10 F600\nG1 X30 Y20'], 'clean.nc')] },
    })
    await waitFor(() => expect(screen.getByTestId('control-program-name')).toBeTruthy())
    const name = screen.getByTestId('control-program-name')
    expect(name.textContent).toBe('clean.nc')
    // The skipped count must remain stated at zero - it is load-bearing
    // (WO-414 R9: on the name's hover, not on the bar).
    expect(screen.queryByTestId('control-program-skipped')).toBeNull()
    expect(name.getAttribute('data-skipped')).toBe('0')
    expect(name.getAttribute('data-tooltip')).toMatch(/4 lines; 0 will not be sent/)
  })

  it('renders the loaded file name and "N skipped" (N > 0) when lines are filtered', async () => {
    render(<ProgramPanel />)
    const input = screen.getByTestId('control-file-input') as HTMLInputElement
    // A comment line, a blank line, and a % program marker: 3 skipped.
    fireEvent.change(input, {
      target: {
        files: [
          // WO-433: M30, not M2 - see the reentrancy-guard test above.
          new File(
            ['%\nG21\n(this is a comment)\n\nG90\nG1 X10 Y10 F600\nM30'],
            'with-skips.nc',
          ),
        ],
      },
    })
    await waitFor(() => expect(screen.getByTestId('control-program-name')).toBeTruthy())
    const name = screen.getByTestId('control-program-name')
    expect(name.textContent).toBe('with-skips.nc')
    expect(name.getAttribute('data-tooltip')).toMatch(/ [1-9][0-9]* will not be sent/)
    // Sanity: the three filtered lines (%, comment, blank) were counted.
    expect(Number(name.getAttribute('data-skipped'))).toBe(3)
  })
})
