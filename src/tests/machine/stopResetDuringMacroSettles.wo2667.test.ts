import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { createDefaultControllerDefinition, type MachineConfig, type MachineMacro, type Project } from '../../types'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'

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

const PROGRAM_BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

/** Machine.cs StillExecutingText, byte for byte. */
const STILL_EXECUTING = 'the board is still cutting the previous part - every move was sent, but the '
  + 'machine has not finished executing them. Wait for the program to complete, or '
  + 'press Stop.'

const G54_OFFSET = { x: 10, y: 5, z: 2 }

interface Pos { x: number; y: number; z: number }

/** The board, as Machine.cs keeps it. */
interface Board {
  pos: Pos
  state: MachineStatus['state']
  staged: Array<{ id: number; target: Pos }>
  awaitingExecution: boolean
  /** Machine.cs lastCompletion* / hadStablePoll. */
  last: Pos | null
  hadStable: boolean
  /** Hold the startJob ok this long (ms); the `started` event still goes first. */
  holdStartReplyMs: number
  /** The board's CurrentID: the last move it ran. */
  executingId: number
  /** Refuse the next loadMoves with this sentence (any other Machine.LoadMoves refusal). */
  refuseNextLoad: string | null
  /** Refuse the next startJob with this sentence (Bridge.cs error reply, no job event). */
  refuseNextStart: string | null
  /** Seat row zhs: every inbound frame (status, job events, replies) is held
   *  until `flushHeld()`... */
  holdInbound: boolean
  /** ...starting at the next startJob, before its `started` edge goes out... */
  holdFromNextStart: boolean
  /** ...except the replies to calls sent once this is set. */
  answerLaterCalls: boolean
}

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  board: Board
  emit(message: BridgeMessage): void
  /** One status poll: the board moves to its target and reports; completion is checked. */
  poll(): void
  /** The held frames arrive, in the order the bridge sent them. */
  flushHeld(): void
  /** One status poll MID-MOVE: the board reports Run at `z`, short of its target. */
  pollAt(z: number): void
  /** The controller faults: the board halts where it is and the bridge raises `failed`. */
  fault(message: string): void
}

const bridgeSockets: FakeBridgeTransport[] = []

function statusOf(board: Board): MachineStatus {
  return {
    state: board.state,
    subState: null,
    machinePos: { ...board.pos },
    workPos: { x: board.pos.x - G54_OFFSET.x, y: board.pos.y - G54_OFFSET.y, z: board.pos.z - G54_OFFSET.z },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: board.executingId,
    buffer: { moves: 0, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class Fake extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    board: Board = {
      pos: { x: 0, y: 0, z: 0 },
      state: 'idle',
      staged: [],
      awaitingExecution: false,
      last: null,
      hadStable: false,
      holdStartReplyMs: 0,
      executingId: 0,
      refuseNextLoad: null,
      refuseNextStart: null,
      holdInbound: false,
      holdFromNextStart: false,
      answerLaterCalls: false,
    }
    private held: BridgeMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null
    private pendingTarget: { id: number; target: Pos } | null = null

    constructor(...args: ConstructorParameters<typeof actual.BridgeTransport>) {
      super(...args)
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const unset = { x: 0, y: 0, z: 0 }
      const offsets = { G54: { ...G54_OFFSET }, G55: unset, G56: unset, G57: unset, G58: unset, G59: unset }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-2667-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    private deliver(message: BridgeMessage, laterCallReply = false): void {
      if (this.board.holdInbound && !laterCallReply) this.held.push(message)
      else this.fakeEvents?.onMessage(message)
    }

    flushHeld(): void {
      this.board.holdInbound = false
      this.board.answerLaterCalls = false
      for (const message of this.held.splice(0)) this.fakeEvents?.onMessage(message)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      const laterCall = this.board.answerLaterCalls
      const reply = (ok: boolean, v: unknown, error?: string) => this.deliver(
        { t: 'reply', seq: message.seq, ok, v, ...(error === undefined ? {} : { error }) } as BridgeMessage,
        laterCall,
      )
      const board = this.board
      if (message.m === 'loadMoves') {
        // Bridge.cs "loadMoves": answered in-process, the refusal in the value.
        if (board.awaitingExecution) { reply(true, { ok: false, reason: STILL_EXECUTING }); return }
        if (board.refuseNextLoad !== null) {
          const reason = board.refuseNextLoad
          board.refuseNextLoad = null
          reply(true, { ok: false, reason })
          return
        }
        type WireMove = { id: number; to?: { x?: number; y?: number; z?: number }; machineAbsolute?: boolean }
        // What goes on the wire: a move serialises itself (toJSON) in the bridge's frame.
        const moves = (JSON.parse(JSON.stringify(message.a)) as { moves: WireMove[] }).moves
        // A move is in G54 unless it is machineAbsolute (G53); the board keeps machine position.
        const at = (m: WireMove, axis: 'x' | 'y' | 'z') => {
          const v = m.to?.[axis]
          return v === undefined ? board.pos[axis] : m.machineAbsolute ? v : v + G54_OFFSET[axis]
        }
        board.staged = moves.map((m) => ({ id: m.id, target: { x: at(m, 'x'), y: at(m, 'y'), z: at(m, 'z') } }))
        reply(true, { ok: true, reason: null })
        return
      }
      if (message.m === 'startJob') {
        // Bridge.cs "startJob": refused -> error reply, no job event.
        if (board.awaitingExecution) { reply(false, null, STILL_EXECUTING); return }
        if (board.staged.length === 0) { reply(false, null, 'no program is loaded'); return }
        if (board.refuseNextStart !== null) {
          const reason = board.refuseNextStart
          board.refuseNextStart = null
          reply(false, null, reason)
          return
        }
        if (board.holdFromNextStart) { board.holdFromNextStart = false; board.holdInbound = true }
        this.deliver({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
        // The push: every move reaches the board at once; it now executes them.
        this.pendingTarget = board.staged[board.staged.length - 1]
        board.staged = []
        board.awaitingExecution = true
        board.last = null
        board.hadStable = false
        if (board.holdStartReplyMs > 0) setTimeout(() => reply(true, true), board.holdStartReplyMs)
        else reply(true, true)
        return
      }
      if (message.m === 'stopJob') {
        // StopWithDeccel: the board halts where it is; nothing more executes.
        this.pendingTarget = null
        board.staged = []
        if (board.awaitingExecution) {
          board.awaitingExecution = false
          this.deliver({ t: 'jobEvent', v: { event: 'stopped', fault: null } } as BridgeMessage)
        }
        reply(true, null)
        return
      }
      if (message.m === 'resetToIdle') { reply(true, { ok: true, reason: null }); return }
      if (message.m === 'emergencyStop') {
        // Machine.cs EmergencyStop: SetEstopState + Stop(); jobAbort only - a
        // pushed job's completion watcher still reports it at rest.
        this.pendingTarget = null
      }
      reply(true, true)
    }

    fault(message: string): void {
      this.pendingTarget = null
      this.board.awaitingExecution = false
      this.deliver({ t: 'jobEvent', v: { event: 'failed', fault: { code: null, message, line: null, moveId: null } } } as BridgeMessage)
    }

    pollAt(z: number): void {
      const board = this.board
      board.pos = { ...board.pos, z }
      board.state = 'run'
      if (this.pendingTarget !== null) board.executingId = this.pendingTarget.id
      this.deliver({ t: 'status', v: statusOf(board) } as BridgeMessage)
      if (board.awaitingExecution) { board.hadStable = false; board.last = { ...board.pos } }
    }

    poll(): void {
      const board = this.board
      if (this.pendingTarget !== null) {
        board.pos = { ...this.pendingTarget.target }
        board.executingId = this.pendingTarget.id
        this.pendingTarget = null
        board.state = 'run'
      } else {
        board.state = 'idle'
      }
      this.deliver({ t: 'status', v: statusOf(board) } as BridgeMessage)
      // Machine.cs CheckExecutionComplete / BoardCameToRest.
      if (!board.awaitingExecution) return
      if (board.state !== 'idle') { board.hadStable = false; board.last = { ...board.pos }; return }
      const same = board.last !== null
        && board.last.x === board.pos.x && board.last.y === board.pos.y && board.last.z === board.pos.z
      board.last = { ...board.pos }
      if (!same) { board.hadStable = false; return }
      if (!board.hadStable) { board.hadStable = true; return }
      board.hadStable = false
      board.awaitingExecution = false
      this.deliver({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: Fake })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useCamStore } = await import('../../store')
const { executeOperatorCycleStart, executeOperatorStopReset } = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')
const { __resetMacroRuntimeForTest, activeMacroRun, runUserMacro } = await import('../../lib/machine/macros/macroRuntime')
const { currentOperatorTransport, executeOperatorFeedHold } = await import('../../lib/machine/operatorTransport')
const { estopNeedsReset, resetEstop, triggerEmergencyStop } = await import('../../lib/machine/machineSession')

const MDI_LOCKED = 'A program is running - MDI is locked out.'
const NC = 'G21 G90 G54\nG0 X10 Y10 Z5\nG1 Z-1 F300\nG0 Z5\nM30\n'

/** The seat's "Park 4": one machine-frame Z leg, `G21 G90 G53 G0 Z128`. */
const PARK4: MachineMacro = { id: 'park4', name: 'Park 4', body: 'goTo({ x: 50, y: 724.5, z: 128 })' }

function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -150 : 0
    axis.softLimitMax = axis.axis === 'X' ? 800 : axis.axis === 'Y' ? 800 : 150
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  controllerDefinition.outputs = []
  return makeMachine({
    id: 'wo2667-machine',
    name: 'WO-2667 Machine',
    macros: [PARK4],
    travel: { x: 800, y: 800, z: 300 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -150 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

function wire(from = 0): string[] {
  return socket().sent.slice(from).map((m) => m.m)
}

async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** `n` status polls, 250 ms apart. */
async function polls(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      socket().poll()
      await vi.advanceTimersByTimeAsync(250)
    })
  }
}

let originalProject: Project

beforeEach(async () => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  useMachineActions.setState({ byMachine: {} })
  originalProject = useCamStore.getState().project
  useCamStore.setState({ project: { ...originalProject, machine: machine(), setups: [] } })
  useMachineControl.setState({ consoleLines: [], alarm: null })
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().poll()
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
})

afterEach(async () => {
  act(() => { __resetMacroRuntimeForTest() })
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject, machineWorkOffsets: {} })
  clearPathFidelity()
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  useMachineControl.setState({ consoleLines: [], alarm: null })
  vi.useRealTimers()
})

/** What the Control page reads: `programRunning` (ControlPage.tsx) is exactly
 *  this phase test, and it is what puts "Running" up and locks the MDI box. */
function controlReadsRunning(): boolean {
  const phase = useMachineControl.getState().job.phase
  return phase === 'streaming' || phase === 'paused'
}

async function mdi(line: string): Promise<boolean> {
  let sent = false
  await act(async () => {
    sent = sendMdiLine(line)
    await vi.advanceTimersByTimeAsync(20)
  })
  return sent
}

async function load(name: string): Promise<{ ok: boolean; reason: string | null }> {
  let outcome: { ok: boolean; reason: string | null } = { ok: false, reason: 'not run' }
  await act(async () => {
    outcome = loadGcodeTextToolpathProgram(name, NC, { publishListing: true })
    await vi.advanceTimersByTimeAsync(20)
  })
  return outcome
}

function jobText(): string {
  return JSON.stringify(useMachineControl.getState().job)
}

/** The 8:00 PM row, up to the press: machine X300 Y275 Z98, "Park 4" started. */
async function startPark4(): Promise<number> {
  socket().board.pos = { x: 300, y: 275, z: 98 }
  act(() => { socket().poll() })
  const mark = socket().sent.length
  await act(async () => {
    expect(runUserMacro(PARK4)).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
  })
  expect(wire(mark), consoleText()).toEqual(expect.arrayContaining(['loadMoves', 'startJob']))
  expect(activeMacroRun()?.name).toBe('Park 4')
  return mark
}

describe('WO-2667: one Stop/Reset during a macro settles Control to the board\'s real state', () => {
  for (const loaded of [false, true]) it(`8:00 PM row (file loaded: ${loaded}): Stop/Reset mid-move, after the push finished, settles Ready/Idle on the first press`, async () => {
    const ctrl = getMachineController()
    if (loaded) { expect((await load('part.nc')).ok, consoleText()).toBe(true); await settle(20) }
    await startPark4()
    await act(async () => { socket().pollAt(105.08); await vi.advanceTimersByTimeAsync(250) })
    expect(controlReadsRunning(), jobText()).toBe(true)
    const press = socket().sent.length
    act(() => { expect(executeOperatorStopReset()).toBe(true) })
    await settle(50)
    expect(wire(press)).toContain('stopJob')
    await polls(3)
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(getMachineController().machineState()).toBe('idle')
    expect(consoleText()).toContain('Macro "Park 4" stopped: the machine was stopped.')
    expect(activeMacroRun()).toBeNull()
    await settle(50_000)
    expect(controlReadsRunning(), jobText()).toBe(false)
    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
    expect(consoleText()).not.toContain(MDI_LOCKED)
  }, 30_000)

  it('Stop/Reset before the board has reported any motion settles Ready/Idle on the first press', async () => {
    const ctrl = getMachineController()
    await startPark4()
    expect(controlReadsRunning(), jobText()).toBe(true)
    const press = socket().sent.length
    act(() => { expect(executeOperatorStopReset()).toBe(true) })
    await settle(50)
    expect(wire(press)).toContain('stopJob')
    await polls(3)
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(activeMacroRun()).toBeNull()
    expect(controlReadsRunning(), jobText()).toBe(false)
    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
    expect(consoleText()).not.toContain(MDI_LOCKED)
  }, 30_000)

  it('Stop/Reset mid-move when the board then reports no executing move id settles on the first press', async () => {
    const ctrl = getMachineController()
    await startPark4()
    await act(async () => { socket().pollAt(105.08); await vi.advanceTimersByTimeAsync(250) })
    act(() => { expect(executeOperatorStopReset()).toBe(true) })
    await settle(50)
    socket().board.executingId = 0
    await polls(3)
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(controlReadsRunning(), jobText()).toBe(false)
    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
  }, 30_000)

  async function expectSettled(): Promise<void> {
    expect(getMachineController().hasActiveJob()).toBe(false)
    expect(activeMacroRun()).toBeNull()
    expect(controlReadsRunning(), jobText()).toBe(false)
    // The transport bar's own verdict (ControlTransportBar reads exactly this).
    expect(currentOperatorTransport().nextAction).not.toContain('Program is running')
    const mark = socket().sent.length
    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
    expect(wire(mark)).toEqual(expect.arrayContaining(['loadMoves', 'startJob']))
    expect(consoleText()).not.toContain(MDI_LOCKED)
  }

  it('Feed Hold then Stop/Reset during the macro settles on the first Stop/Reset', async () => {
    await startPark4()
    await act(async () => { socket().pollAt(105.08); await vi.advanceTimersByTimeAsync(250) })
    act(() => { expect(executeOperatorFeedHold()).toBe(true) })
    expect(wire()).toContain('pauseJob')
    // Bridge.cs Dispatch: the hold's own edge; the board decelerates to Hold.
    socket().board.state = 'hold'
    await act(async () => {
      socket().emit({ t: 'jobEvent', v: { event: 'paused', fault: null } } as BridgeMessage)
      socket().emit({ t: 'status', v: statusOf(socket().board) } as BridgeMessage)
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(controlReadsRunning(), jobText()).toBe(true)
    const press = socket().sent.length
    act(() => { expect(executeOperatorStopReset()).toBe(true) })
    await settle(50)
    expect(wire(press)).toContain('stopJob')
    await polls(3)
    await expectSettled()
  }, 30_000)

  it('E-STOP during the macro: once the board is at rest and the E-STOP is cleared, Control is not Running', async () => {
    await startPark4()
    await act(async () => { socket().pollAt(105.08); await vi.advanceTimersByTimeAsync(250) })
    act(() => { triggerEmergencyStop() })
    expect(wire()).toContain('emergencyStop')
    await polls(4)
    expect(consoleText()).toContain('Macro "Park 4" stopped by the E-STOP.')
    await settle(2000)
    // CLEAR: the reset waits on the board's own status reports.
    let result: { ok: boolean; reason?: string | null } = { ok: false, reason: 'not run' }
    const pending = resetEstop().then((r) => { result = r })
    await polls(12)
    await act(async () => { await pending })
    expect(result.ok, `${result.reason ?? ''}\n${consoleText()}`).toBe(true)
    expect(estopNeedsReset()).toBe(false)
    await expectSettled()
  }, 30_000)

  it('a controller fault (the bridge\'s failed edge) during the macro leaves Control not Running', async () => {
    await startPark4()
    await act(async () => { socket().pollAt(105.08); await vi.advanceTimersByTimeAsync(250) })
    await act(async () => { socket().fault('drive fault'); await vi.advanceTimersByTimeAsync(50) })
    await polls(3)
    await settle(10_000)
    expect(consoleText()).toContain('Macro "Park 4" stopped')
    await expectSettled()
  }, 30_000)

  it('a controller fault before the board has reported any motion leaves Control not Running', async () => {
    await startPark4()
    await act(async () => { socket().fault('drive fault'); await vi.advanceTimersByTimeAsync(50) })
    await polls(3)
    await settle(10_000)
    expect(consoleText()).toContain('Macro "Park 4" stopped')
    await expectSettled()
  }, 30_000)

  it('a startJob the board refuses leaves Control not Running and the macro ended', async () => {
    socket().board.refuseNextStart = 'a probe owns the machine'
    await act(async () => {
      expect(runUserMacro(PARK4)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(wire()).toContain('startJob')
    await polls(3)
    await settle(10_000)
    await expectSettled()
  }, 30_000)

  it('normal completion: the whole park runs, X/Y after Z, and Control returns to Ready/Idle', async () => {
    const mark = await startPark4()
    for (let i = 0; i < 12 && activeMacroRun() !== null; i++) await polls(1)
    expect(activeMacroRun()).toBeNull()
    expect(socket().sent.slice(mark).filter((m) => m.m === 'startJob'), consoleText()).toHaveLength(2)
    expect(socket().board.pos).toEqual({ x: 50, y: 724.5, z: 128 })
    expect(consoleText()).not.toContain('Macro "Park 4" stopped')
    await expectSettled()
  }, 30_000)

  it('Stop/Reset after the macro finished sends reset and leaves Control Ready/Idle', async () => {
    await startPark4()
    for (let i = 0; i < 12 && activeMacroRun() !== null; i++) await polls(1)
    const press = socket().sent.length
    act(() => { expect(executeOperatorStopReset()).toBe(true) })
    await settle(50)
    expect(wire(press)).toContain('reset')
    expect(wire(press)).not.toContain('stopJob')
    await polls(2)
    await expectSettled()
  }, 30_000)

  it('program run (Load + Cycle Start) stopped before its first motion frame does not stay Running', async () => {
    expect((await load('part.nc')).ok, consoleText()).toBe(true)
    await settle(20)
    await act(async () => { expect(await executeOperatorCycleStart()).toBe(true); await vi.advanceTimersByTimeAsync(50) })
    expect(controlReadsRunning(), jobText()).toBe(true)
    act(() => { expect(executeOperatorStopReset()).toBe(true) })
    await settle(50)
    await polls(4)
    await settle(500)
    expect(controlReadsRunning(), jobText()).toBe(false)
    expect(useMachineControl.getState().job.name).toBe('part.nc')
  }, 30_000)
})
