// @vitest-environment jsdom
//
// WO-2257 - a held continuous jog keeps going on the Control page, however
// many rows the console holds.
//
// Operator, 2026-09-30, at the machine: "I'm jogging over to the position and it's
// in continuous but when I click x minus it's stopping." The bridge stops a
// native jog when no jogHold arrives for 250 ms. The renderer sent its holds
// from a plain setInterval, and every status frame (40 a second while the axis
// moves) re-rendered the whole Control page - including every console row,
// each formatting its own time. With a long console the frames queued up and
// the timer waited behind them.
//
// The real ControlPage and JogPanel drive the real machine session and
// UccncController through a fake bridge; every assertion reads the bridge
// boundary or the rendered console. jsdom cannot be slow on purpose, so the
// busy renderer is modelled the way the measurement showed it: frames arrive
// back to back with time passing inside each one, and no timer gets a turn in
// between. The renderer measurement in src/tests/evidence/WO-2257/ is the
// proof; this pins the behaviour.

import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface WireCall { m: string; at: number }

interface FakeBridgeTransport extends BridgeTransport {
  wire: WireCall[]
  frame(x: number, state?: MachineStatus['state']): void
}

const bridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null, refuseJogStart: false }))

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
  machineProgram: true,
}

/** A fresh object per frame, exactly as the bridge decodes one. */
function statusFrame(x: number, state: MachineStatus['state']): MachineStatus {
  return {
    state,
    subState: null,
    machinePos: { x, y: 300, z: 100 },
    workPos: { x: x - 10, y: 290, z: 50 },
    feedMmMin: state === 'jog' ? 1500 : 0,
    spindleRpm: null,
    overrides: { feed: 100, rapid: null, spindle: 100 },
    executingMoveId: 0,
    buffer: { moves: 0, capacitySeconds: null },
    inputs: {
      estop: false,
      hardLimit: false,
      softLimit: false,
      probe: false,
      limits: null,
      door: null,
      hold: false,
    },
    homed: { X: true, Y: true, Z: true },
    spindle: null,
  }
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    wire: WireCall[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridge.last = this
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: { protocol: 1, bridge: 'WO-2257 fake bridge', capabilities: CAPABILITIES, readOnly: false },
      })
    }

    send(message: BridgeCallMessage): void {
      this.wire.push({ m: message.m, at: Date.now() })
      if (message.m === 'queryStatus') this.frame(400, 'idle')
      const v = message.m === 'jogStart'
        ? !bridge.refuseJogStart
        : message.m === 'resetToIdle' ? { ok: true, reason: null } : true
      this.emit({ t: 'reply', seq: message.seq, ok: true, v })
    }

    frame(x: number, state: MachineStatus['state'] = 'jog'): void {
      this.emit({ t: 'status', v: statusFrame(x, state) })
    }

    async close(): Promise<void> {
      this.fakeEvents = null
    }

    private emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const session = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

const DEADMAN_MS = 250
const CONSOLE_CAP = 500
/** What one queued frame costs a busy renderer: the mini PC measured holds
 *  135-359 ms apart, and 100 ms per frame is well inside that. */
const FRAME_COST_MS = 100

async function connectBridge(): Promise<FakeBridgeTransport> {
  const pending = session.connectMachine('bridge')
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  await act(async () => { await pending })
  const current = bridge.last
  if (!current) throw new Error('The fake bridge was not installed.')
  act(() => {
    current.frame(400, 'idle')
    session.__resetEstopInterlockForTest()
  })
  return current
}

/** Fill the console to the store's cap the way it fills at the machine. */
function fillConsole(rows: number): void {
  const push = useMachineControl.getState().pushConsole
  for (let i = 0; i < rows; i++) {
    push(i % 3 === 0 ? 'tx' : 'rx', `[bridge] console row ${i + 1} of a long session`, i % 17 === 0 ? 'error' : 'info')
  }
}

/** The Main screen's X- (Probing and Tools are not open). Read directly:
 *  testing-library's waitFor does not drive vitest's fake clock. */
async function xMinus(): Promise<HTMLButtonElement> {
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  const buttons = screen.getAllByTestId('control-jog-x-minus') as HTMLButtonElement[]
  expect(buttons).toHaveLength(1)
  expect(buttons[0].disabled).toBe(false)
  return buttons[0]
}

/** A renderer working through queued frames: each frame takes FRAME_COST_MS,
 *  and no timer runs until the queue is empty. */
function busyFrames(wire: FakeBridgeTransport, count: number, fromX: number): void {
  for (let i = 1; i <= count; i++) {
    vi.setSystemTime(Date.now() + FRAME_COST_MS)
    act(() => { wire.frame(fromX - i * 2.5) })
  }
}

function holdGaps(wire: WireCall[]): number[] {
  const start = wire.findIndex((call) => call.m === 'jogStart')
  const stop = wire.findIndex((call) => call.m === 'jogStop')
  const times = wire.slice(start, stop + 1)
    .filter((call) => call.m === 'jogStart' || call.m === 'jogHold' || call.m === 'jogStop')
    .map((call) => call.at)
  return times.slice(1).map((at, i) => at - times[i])
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  bridge.last = null
  bridge.refuseJogStart = false
  memory.clear()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  useMachineControl.setState({ consoleLines: [], homed: false })
  useUiPrefs.setState({
    collapsedPropsGroups: {},
    machineJogContinuous: true,
    machineConsoleCollapsed: false,
  })
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  session.__resetEstopInterlockForTest()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WO-2257: continuous jog keeps going with a full console', () => {
  it('every keep-alive reaches the bridge inside the 250 ms deadman while frames keep the page busy', async () => {
    const wire = await connectBridge()
    fillConsole(CONSOLE_CAP)
    render(<ControlPage />)
    expect(screen.getByTestId('control-console').querySelectorAll('.control-console-line'))
      .toHaveLength(CONSOLE_CAP)
    const button = await xMinus()
    wire.wire.length = 0

    act(() => { fireEvent.pointerDown(button) })
    await act(async () => { await Promise.resolve() })
    // Four seconds of a moving axis on a renderer that is never idle.
    busyFrames(wire, 40, 400)
    act(() => { fireEvent.pointerUp(button) })

    const gaps = holdGaps(wire.wire)
    expect(wire.wire.map((call) => call.m)).toContain('jogStart')
    expect(wire.wire.filter((call) => call.m === 'jogHold').length).toBeGreaterThanOrEqual(40)
    expect(Math.max(...gaps)).toBeLessThan(DEADMAN_MS)
  })

  it('a status frame leaves the console rows alone - same 500 rows, same text, same times', async () => {
    const wire = await connectBridge()
    fillConsole(CONSOLE_CAP)
    render(<ControlPage />)
    const rows = () => [...screen.getByTestId('control-console').querySelectorAll('.control-console-line')]
    const first = useMachineControl.getState().consoleLines[0]

    // Every way the console can format a row's time.
    const toLocale = vi.spyOn(Date.prototype, 'toLocaleTimeString')
    // `format` is an accessor on the prototype (it hands back a bound function).
    const format = vi.spyOn(Intl.DateTimeFormat.prototype as unknown as { format: unknown }, 'format', 'get')
    for (let i = 1; i <= 20; i++) act(() => { wire.frame(400 - i) })
    expect(toLocale.mock.calls.length + format.mock.calls.length).toBe(0)
    toLocale.mockRestore()
    format.mockRestore()

    expect(rows()).toHaveLength(CONSOLE_CAP)
    expect(rows()[0].querySelector('.control-console-text')?.textContent).toBe(first.text)
    expect(rows()[0].querySelector('.control-console-time')?.textContent)
      .toBe(new Date(first.at!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    expect(rows()[0].querySelector('.control-console-dir')?.textContent).toBe('>')

    // A new line still lands, and the cap still drops the oldest.
    act(() => { useMachineControl.getState().pushConsole('rx', 'the newest line', 'error') })
    expect(rows()).toHaveLength(CONSOLE_CAP)
    expect(rows().at(-1)?.querySelector('.control-console-text')?.textContent).toBe('the newest line')
    expect(rows().at(-1)?.className).toContain('control-console-error')
    expect(rows()[0].querySelector('.control-console-text')?.textContent)
      .toBe(useMachineControl.getState().consoleLines[0].text)
  })

  it('releasing stops at once, and no hold follows the stop as frames keep coming', async () => {
    const wire = await connectBridge()
    fillConsole(CONSOLE_CAP)
    render(<ControlPage />)
    const button = await xMinus()

    act(() => { fireEvent.pointerDown(button) })
    await act(async () => { await Promise.resolve() })
    busyFrames(wire, 10, 400)
    const releasedAt = wire.wire.length
    act(() => { fireEvent.pointerUp(button) })
    expect(wire.wire.slice(releasedAt).map((call) => call.m)).toEqual(['jogStop', 'jogCancel'])

    // The bridge keeps reporting while the axis decelerates; time runs on.
    busyFrames(wire, 10, 375)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const stopAt = wire.wire.findIndex((call) => call.m === 'jogStop')
    expect(wire.wire.slice(stopAt).filter((call) => call.m === 'jogHold')).toEqual([])
  })

  it('a refused jogStart sends no holds, from the timer or from frames', async () => {
    bridge.refuseJogStart = true
    const wire = await connectBridge()
    render(<ControlPage />)
    const button = await xMinus()

    act(() => { fireEvent.pointerDown(button) })
    await act(async () => { await Promise.resolve() })
    const refusedAt = wire.wire.findIndex((call) => call.m === 'jogStop')
    expect(refusedAt).toBeGreaterThan(-1)
    busyFrames(wire, 10, 400)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(wire.wire.slice(refusedAt).filter((call) => call.m === 'jogHold')).toEqual([])
    act(() => { fireEvent.pointerUp(button) })
  })

  it('a step jog is one move, and frames send no holds for it', async () => {
    useUiPrefs.setState({ machineJogContinuous: false })
    const wire = await connectBridge()
    fillConsole(CONSOLE_CAP)
    render(<ControlPage />)
    const button = await xMinus()
    wire.wire.length = 0

    act(() => { fireEvent.pointerDown(button) })
    busyFrames(wire, 10, 400)
    act(() => { fireEvent.pointerUp(button) })
    const methods = wire.wire.map((call) => call.m).filter((m) => m !== 'queryStatus')
    expect(methods).not.toContain('jogStart')
    expect(methods).not.toContain('jogHold')
  })
})
