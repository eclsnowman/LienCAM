// @vitest-environment jsdom
// WO-2878 - the Control position panel's tool chip and the TOOL glance must
// name the same tool at every step of a run.
//
// Final sweep 10-16 (simulator, run from line 1, program uses T2): the chip
// read T0 while the glance read T2. The chip read the store's `activeTool`,
// which is the controller's $G report - polled only between jobs, so it lags
// all through a run. The glance reads `useCurrentTool()`: the last T word the
// stream has passed, falling back to `activeTool`. Two sources for one fact.
// This test drives ONE machine state through a run and reads BOTH renderings
// off the rendered Control screen at each step.

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectionPhase,
  LoadOutcome,
  MachineController,
  MachineState,
  MachineStatus,
  StreamerPhase,
  StreamerProgress,
} from '../../lib/machine/controller'
import type { GrblParserState } from '../../lib/machine/types'
import { typedMock } from '../support/typedMock'

const reportedHomed: MachineStatus['homed'] = null

function stubMachineController(): MachineController {
  const jobProgress: StreamerProgress = {
    phase: 'empty', totalLines: 0, sentLines: 0, ackedLines: 0,
    ackedSourceLine: 0, sentSourceLine: 0, bytesInFlight: 0,
  }
  return {
    capabilities: {
      geometryQueue: false, executingMoveId: false, bufferSeconds: false,
      gcodeText: false, perAxisHoming: true, ownsSpindle: false, spindleCommands: false,
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    connectionPhase: vi.fn((): ConnectionPhase => 'connected'),
    firmwareVersion: vi.fn(() => null),
    machineState: vi.fn((): MachineState => 'idle'),
    status: vi.fn((): MachineStatus => ({
      state: 'idle', subState: null,
      machinePos: { x: 1, y: 2, z: 3 },
      workPos: { x: 1, y: 2, z: 3 },
      feedMmMin: 0, spindleRpm: 0, overrides: null,
      executingMoveId: null, buffer: null, inputs: null,
      homed: reportedHomed, spindle: null,
    })),
    queryStatus: vi.fn(),
    refreshState: vi.fn(() => true),
    querySettings: vi.fn(() => true),
    verifiedIdle: vi.fn(() => true),
    homedThisSession: vi.fn(() => false),
    resetInProgress: vi.fn(() => false),
    subscribeResetInProgress: vi.fn(() => () => {}),
    jog: vi.fn(() => true),
    jogToWorkXY: vi.fn(() => true),
    jogToMachineZ: vi.fn(() => true),
    jogCancel: vi.fn(),
    home: vi.fn(() => true),
    feedHold: vi.fn(),
    cycleResume: vi.fn(() => true),
    reset: vi.fn(),
    unlock: vi.fn(() => true),
    emergencyStop: vi.fn(),
    resetToIdle: vi.fn(async () => ({ ok: true, reason: null })),
    setOverride: vi.fn(),
    selectWcs: vi.fn(() => true),
    zeroWorkAxis: vi.fn(() => true),
    probe: vi.fn(async () => ({ ok: true, at: null })),
    sendCommand: vi.fn(() => true),
    sendCommandAwait: vi.fn(async () => ({ ok: true, message: null })),
    loadJob: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    loadJobFrom: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    startJob: vi.fn(() => true),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(() => true),
    stopJob: vi.fn(),
    stepJob: vi.fn(() => true),
    setSingleBlockMode: vi.fn(),
    singleBlockMode: vi.fn(() => false),
    hasActiveJob: vi.fn(() => false),
    jobProgress: vi.fn(() => jobProgress),
    stoppedJobProgress: vi.fn(() => null),
  }
}

const controller = stubMachineController()

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    getMachineController: vi.fn(() => controller),
    controllerCapabilities: vi.fn(() => controller.capabilities),
  })
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { SimulatedController } = await import('../../lib/machine/simulatedController')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

/** A $G parser report reporting `tool`, through the store action the
 *  session's onParserState calls. */
function reportTool(tool: number | null): void {
  const state: GrblParserState = {
    wcs: 'G54', units: 'mm', distanceMode: 'absolute', motionMode: 'G0',
    tool, spindle: 'off', coolant: 'off', feed: 0, spindleRpm: 0,
  }
  act(() => useMachineControl.getState().applyParserState(state))
}

/** All three renderings agree and name `tool`. */
function expectAllShow(tool: string | null): void {
  expect(chipTool()).toBe(tool)
  expect(glanceTool()).toBe(tool)
}

/** The tool number each rendering shows, or null when it shows none. */
function chipTool(): string | null {
  const chip = screen.queryByTestId('control-active-tool')
  const m = chip?.textContent?.match(/T(\d+)/)
  return m ? m[1] : null
}
/** The TOOL panel's identity: the glance when expanded, the WO-184 header
 *  readout when folded (its default). Both come from useCurrentTool(). */
function glanceTool(): string | null {
  const el = screen.queryByTestId('control-tool-glance-current') ?? screen.getByTestId('control-tool-collapsed-values')
  const m = el.textContent?.match(/T(\d+)/)
  return m ? m[1] : null
}

function setToolPanelExpanded(expanded: boolean): void {
  useUiPrefs.setState((s) => ({
    collapsedPropsGroups: { ...s.collapsedPropsGroups, 'control-tool-panel-expanded': expanded },
  }))
}

function step(ackedSourceLine: number, phase: StreamerPhase): void {
  act(() => useMachineControl.setState((s) => ({
    job: { ...s.job, phase, ackedSourceLine },
  })))
}

// A program that starts on T2 (line 1, as in the sweep) and changes to T5 on
// line 40.
const TOOL_CHANGES = [
  { sourceLine: 1, tool: 2, label: 'T2 M6' },
  { sourceLine: 40, tool: 5, label: 'T5 M6' },
]

describe.each([
  ['expanded', true],
  ['folded', false],
])('WO-2878 Control tool chip matches the TOOL glance (TOOL panel %s)', (_label, expanded) => {
  beforeEach(() => {
    setToolPanelExpanded(expanded)
    useMachineControl.setState((s) => ({
      connectionPhase: 'connected', machineState: 'idle', homed: true,
      mpos: { x: 1, y: 2, z: 3 }, wpos: { x: 1, y: 2, z: 3 },
      settings: {}, consoleLines: [],
      // The controller's last $G report, taken before the run: T0.
      activeTool: 0,
      job: { ...s.job, phase: 'ready', name: 'sweep4.nc', toolChanges: TOOL_CHANGES, ackedSourceLine: 0 },
    }))
  })

  afterEach(() => {
    cleanup()
    setToolPanelExpanded(false)
  })

  it('shows the same tool on the chip and the glance at every step of a run from line 1', () => {
    render(<ControlPage />)
    if (expanded) expect(screen.getByTestId('control-tool-glance-current')).toBeTruthy()
    else expect(screen.queryByTestId('control-tool-glance-current')).toBeNull()

    // Loaded, nothing streamed: both show what the controller reported.
    expect(glanceTool()).toBe('0')
    expect(chipTool()).toBe(glanceTool())

    // The stream passes line 1 (T2 M6) - $G is not polled mid-run, so the
    // store still says T0. This is the sweep's T0-vs-T2 frame.
    step(1, 'streaming')
    expect(glanceTool()).toBe('2')
    expect(chipTool()).toBe('2')

    step(20, 'streaming')
    expect(chipTool()).toBe(glanceTool())
    expect(chipTool()).toBe('2')

    step(20, 'paused')
    expect(chipTool()).toBe('2')
    expect(glanceTool()).toBe('2')

    step(40, 'streaming')
    expect(glanceTool()).toBe('5')
    expect(chipTool()).toBe('5')

    step(99, 'streaming')
    expect(chipTool()).toBe(glanceTool())
  })

  it('agrees with no program loaded: both follow the controller report', () => {
    act(() => useMachineControl.setState((s) => ({ activeTool: 3, job: { ...s.job, toolChanges: [], ackedSourceLine: 0 } })))
    render(<ControlPage />)
    expect(chipTool()).toBe('3')
    expect(glanceTool()).toBe('3')

    act(() => useMachineControl.setState({ activeTool: null }))
    expect(chipTool()).toBeNull()
    expect(glanceTool()).toBeNull()
  })

  // Audit 10-16 (astra): a finished program keeps its acked cursor, so the
  // stream's last T must not mask a NEWER controller report after it.
  it('after the program completes, a newer controller report (MDI T3 M6) wins on all three', () => {
    render(<ControlPage />)
    step(1, 'streaming')
    step(99, 'streaming')
    expectAllShow('5')

    // Complete, no report since: the program's last T is still the newest fact.
    step(99, 'complete')
    expectAllShow('5')

    // MDI T3 M6, then its $G report.
    reportTool(3)
    expectAllShow('3')

    // A repeat report of the same tool keeps it.
    reportTool(3)
    expectAllShow('3')
  })

  it('a report naming the same tool as the store still counts as newer once the run is over', () => {
    act(() => useMachineControl.setState({ activeTool: 3 }))
    render(<ControlPage />)
    step(1, 'streaming')
    expectAllShow('2')
    step(99, 'complete')
    expectAllShow('5')
    // activeTool was already 3 before the run; MDI T3 M6's report repeats it.
    reportTool(3)
    expectAllShow('3')
  })

  // Audit 10-16 round 2 (astra): freshness is an EVENT. A tool-setting
  // receipt that repeats the stored number changes no value, yet it is the
  // newest fact - Work Z0 / Measure T3 / a typed change all call setActiveTool.
  it('a direct receipt repeating the stored tool after completion wins on all three (setActiveTool(3))', () => {
    act(() => useMachineControl.setState({ activeTool: 3 }))
    render(<ControlPage />)
    step(1, 'streaming')
    expectAllShow('2')
    step(1, 'complete')
    expectAllShow('2')
    act(() => useMachineControl.getState().setActiveTool(3))
    expectAllShow('3')
    act(() => useMachineControl.getState().setActiveTool(4))
    expectAllShow('4')
  })

  it('a guided change reaching its fitted step after completion wins on all three', () => {
    render(<ControlPage />)
    step(99, 'streaming')
    step(99, 'complete')
    expectAllShow('5')
    act(() => useMachineControl.getState().setActiveTool(5))
    expectAllShow('5')
    // T0 fitted at a guided change (the step past the swap): a report.
    act(() => useMachineControl.getState().setToolChange({
      step: 'probing', mode: 'toolChange', tool: 0, resumeLine: 100, message: '', warnings: [],
    }))
    expectAllShow('0')
    act(() => useMachineControl.getState().setToolChange(null))
  })

  it('a second run of the program speaks over a receipt taken between runs', () => {
    render(<ControlPage />)
    step(99, 'streaming')
    step(99, 'complete')
    act(() => useMachineControl.getState().setActiveTool(3))
    expectAllShow('3')
    // Run again from line 1: the cursor re-enters T2, then T5, and the run
    // ends on T5 - the program's last tool is newer than the T3 receipt.
    step(0, 'streaming')
    step(1, 'streaming')
    expectAllShow('2')
    step(99, 'streaming')
    step(99, 'complete')
    expectAllShow('5')
  })

  it('a report during a run does not override the stream while running or held', () => {
    render(<ControlPage />)
    step(1, 'streaming')
    reportTool(0)
    expectAllShow('2')
    step(20, 'paused')
    reportTool(0)
    expectAllShow('2')
  })

  // Audit 10-16 round 3 (astra): a report that carries NO tool fact (tool
  // null - a units or MDI refresh from a driver that cannot say) is not tool
  // knowledge; the finished program's last T keeps speaking.
  it('a parser report with no tool fact after completion leaves the program tool on all three', () => {
    render(<ControlPage />)
    step(1, 'streaming')
    step(1, 'complete')
    expectAllShow('2')
    reportTool(null)
    expectAllShow('2')
    // A report that DOES carry a tool still wins, repeats included.
    reportTool(0)
    expectAllShow('0')
    reportTool(0)
    expectAllShow('0')
  })

  it('after a reconnect the controller value shows on all three', () => {
    render(<ControlPage />)
    step(99, 'streaming')
    step(99, 'complete')
    expectAllShow('5')

    act(() => useMachineControl.getState().setConnection('disconnected', null))
    act(() => useMachineControl.getState().setConnection('connected', null))
    expectAllShow(null)
    reportTool(4)
    expectAllShow('4')
  })
})

// Audit 10-16 round 3 (astra): the simulator's parserState() hard-coded
// tool 0, so the units click's refreshState replaced a finished program's T2
// with T0 on both readouts. The real SimulatedController now reports the last
// T word it executed - program or typed line - the way GRBL's $G does, and
// its reports reach the store through the same action the session uses.
const AUDIT_PROGRAM = 'T2\nG90 G94 G17 G21\nG54\nG4 P0.1\nM30\n'

describe.each([
  ['expanded', true],
  ['folded', false],
])('WO-2878 simulator tool report (TOOL panel %s)', (_label, expanded) => {
  let sim: InstanceType<typeof SimulatedController>

  beforeEach(async () => {
    vi.useFakeTimers()
    setToolPanelExpanded(expanded)
    sim = new SimulatedController({
      // machineSession's onParserState: store().applyParserState(state).
      onParserState: (state) => useMachineControl.getState().applyParserState(state),
    })
    await sim.connect({ kind: 'none' })
    useMachineControl.setState((s) => ({
      connectionPhase: 'connected', machineState: 'idle', homed: true,
      mpos: { x: 1, y: 2, z: 3 }, wpos: { x: 1, y: 2, z: 3 },
      settings: {}, consoleLines: [], activeTool: null,
      job: { ...s.job, phase: 'ready', name: 'audit-tool-refresh.nc', toolChanges: [{ sourceLine: 1, tool: 2, label: 'T2' }], ackedSourceLine: 0 },
    }))
  })

  afterEach(async () => {
    cleanup()
    setToolPanelExpanded(false)
    await sim.disconnect()
    vi.useRealTimers()
  })

  /** Run the audit's five-line program to completion on the simulator, the
   *  store's cursor following the stream as the session publishes it. */
  async function runAuditProgram(): Promise<void> {
    expect(sim.loadJob(AUDIT_PROGRAM).ok).toBe(true)
    expect(sim.startJob()).toBe(true)
    step(1, 'streaming')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(sim.hasActiveJob()).toBe(false)
    step(5, 'complete')
  }

  it('reports the program T2 after completion, and a units refresh keeps T2 on both readouts', async () => {
    act(() => { sim.refreshState() })
    render(<ControlPage />)
    expectAllShow('0') // GRBL boots at T0
    await runAuditProgram()
    expectAllShow('2')

    // The position panel's inch button: G20 then refreshState (ControlPage).
    act(() => { expect(sim.sendCommand('G20')).toBe(true); sim.refreshState() })
    expect(useMachineControl.getState().activeTool).toBe(2)
    expectAllShow('2')
  })

  it('a typed T5 on the simulator reads T5 on both readouts', async () => {
    render(<ControlPage />)
    await runAuditProgram()
    expectAllShow('2')
    act(() => { expect(sim.sendCommand('T5')).toBe(true); sim.refreshState() })
    expectAllShow('5')
    // A repeat report of the same tool still holds it.
    act(() => { sim.refreshState() })
    expectAllShow('5')
  })

  // Audit 10-16 round 4 (astra): a typed line's T word was taken before the
  // line's later refusals, so a REJECTED line changed the reported tool.
  // GRBL runs nothing of an errored line (docs/machine/GRBL-PROTOCOL.md:11).
  it('a rejected typed line (T5 G1 X1, no feed set) leaves T0 on both readouts after a units refresh', async () => {
    act(() => { sim.refreshState() })
    render(<ControlPage />)
    expectAllShow('0')
    act(() => { expect(sim.sendCommand('T5 G1 X1')).toBe(false) })
    act(() => { expect(sim.sendCommand('G20')).toBe(true); sim.refreshState() })
    expect(useMachineControl.getState().activeTool).toBe(0)
    expectAllShow('0')
  })

  it.each([
    ['T5 G10 X1', 'G10 with no L word'],
    ['T5 X1', 'a coordinate with no motion word'],
    ['T5 G38.2 Z-1', 'a probe with no feed'],
    ['T5 G4', 'a dwell with no P word'],
    ['T5 G43.1', 'G43.1 with no Z word'],
  ])('every refused typed line keeps the program tool: %s (%s)', async (line) => {
    render(<ControlPage />)
    await runAuditProgram()
    expectAllShow('2')
    act(() => { expect(sim.sendCommand(line)).toBe(false); sim.refreshState() })
    expectAllShow('2')
  })

  it('an accepted typed line carrying a T word reports that tool (T6 G4 P0.01)', async () => {
    render(<ControlPage />)
    await runAuditProgram()
    act(() => { expect(sim.sendCommand('T6 G4 P0.01')).toBe(true); sim.refreshState() })
    expectAllShow('6')
  })

  // Audit 10-16 round 5 (astra): a T word inside a comment was taken as the tool.
  it.each([['G21 (T9)'], ['G21 ; T7']])('a T word inside a comment selects no tool: %s', async (line) => {
    act(() => { sim.refreshState() })
    render(<ControlPage />)
    expectAllShow('0')
    act(() => { expect(sim.sendCommand(line)).toBe(true) })
    act(() => { expect(sim.sendCommand('G20')).toBe(true); sim.refreshState() })
    expect(useMachineControl.getState().activeTool).toBe(0)
    expectAllShow('0')
  })

  it('a soft reset returns the simulator to T0, as GRBL gc_init does', async () => {
    render(<ControlPage />)
    await runAuditProgram()
    act(() => { sim.reset(); sim.refreshState() })
    expectAllShow('0')
  })
})

// The phone's tool readouts (pendant app #gl-tool / #tl-num) come from the
// status the desktop publishes; they read the same selector as the chip.
describe('WO-2878 the phone status names the same tool as the Control screen', () => {
  it('publishes the stream tool mid-run, not the lagging controller report', async () => {
    const { PendantBridgeClient } = await import('../../lib/machine/pendantBridge')
    const sent: Array<{ type?: string; data?: { tool?: number; toolInfo?: { number?: number } } }> = []
    const socket = {
      readyState: 0,
      onopen: null as ((e: Event) => void) | null,
      onmessage: null as ((e: MessageEvent<string>) => void) | null,
      onerror: null, onclose: null,
      send: (d: string) => { sent.push(JSON.parse(d)) },
      close: () => { socket.readyState = 3 },
    }
    useMachineControl.setState((s) => ({
      connectionPhase: 'connected', activeTool: 0,
      job: { ...s.job, phase: 'streaming', toolChanges: TOOL_CHANGES, ackedSourceLine: 1 },
    }))
    const bridge = new PendantBridgeClient(vi.fn(), (() => socket) as never)
    bridge.enable('ws://127.0.0.1:8324/bridge', '1234567890abcdef')
    socket.readyState = 1
    socket.onopen?.(new Event('open'))
    socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'hello-ack', role: 'desktop' }) }))
    const status = sent.find((m) => m.type === 'status')
    expect(status?.data?.tool).toBe(2)
    expect(status?.data?.toolInfo?.number).toBe(2)
    bridge.disable()
  })
})
