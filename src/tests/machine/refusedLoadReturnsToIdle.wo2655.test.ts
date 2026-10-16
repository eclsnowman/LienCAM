// @vitest-environment jsdom
//
// WO-2655 - A LOAD THE BOARD REFUSES LEAVES CONTROL IN THE BOARD'S REAL STATE.
//
// Machine seat rehearsal 2026-10-07 (row z2c, origin machine/delta-e215fac80,
// README "F1"): after MDI "G53 G0 Z115" the kit's status read stalled 1.3 s+.
// Load passed `controllerJobReallyRuns` and sent loadMoves; the bridge refused
// "the board is still cutting the previous part"; Control then stayed
// "Running" / "MDI is locked out" / 1/1 (99%) for 8 minutes with nothing
// loaded and the machine idle.
//
// Driven on the real session singleton (`sendMdiLine`, the Control page's MDI
// door; `loadGcodeTextToolpathProgram`, the file door) talking to the real
// UccncController over a fake bridge socket that answers the way Machine.cs and
// Bridge.cs do: loadMoves and startJob are refused with Machine.cs's own
// StillExecutingText while the board is still executing what it was handed;
// startJob sends `started` then ok (the ok can be held, as the seat's
// routeWebSocket repro holds it ~2 s); `completed` is raised only once the
// board reads idle and still for two polls.
//
// NOT CLAIMED: hardware. The machine-seat desk kit (z2c with the held reply)
// is the end-to-end check on the native kit.

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
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
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
          bridge: 'wo-2655-fake 0.0',
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
        const moves = (message.a as { moves: Array<{ id: number; x?: number; y?: number; z?: number; machine?: boolean }> }).moves
        board.staged = moves.map((m) => ({ id: m.id, target: { x: m.x ?? board.pos.x, y: m.y ?? board.pos.y, z: m.z ?? board.pos.z } }))
        reply(true, { ok: true, reason: null })
        return
      }
      if (message.m === 'startJob') {
        // Bridge.cs "startJob": refused -> error reply, no job event.
        if (board.awaitingExecution) { reply(false, null, STILL_EXECUTING); return }
        if (board.staged.length === 0) { reply(false, null, 'no program is loaded'); return }
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
        board.staged = []
        if (board.awaitingExecution) {
          board.awaitingExecution = false
          this.deliver({ t: 'jobEvent', v: { event: 'stopped', fault: null } } as BridgeMessage)
        }
        reply(true, null)
        return
      }
      reply(true, true)
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
  runMachineAction,
} = await import('../../lib/machine/machineSession')

const MDI_LOCKED = 'A program is running - MDI is locked out.'
const NC = 'G21 G90 G54\nG0 X10 Y10 Z5\nG1 Z-1 F300\nG0 Z5\nM30\n'

function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -150 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  controllerDefinition.outputs = []
  return makeMachine({
    id: 'wo2655-machine',
    name: 'WO-2655 Machine',
    travel: { x: 600, y: 400, z: 300 },
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

function occurrences(text: string): number {
  return consoleText().split(text).length - 1
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

/** WO-2659: typed lines now defer Load. Keep these board-refusal fallback
 * proofs on a configured action sending the identical line: actions retain
 * the original busy-load contract, including stale status and late starts.
 * Recovery still uses the operator's typed MDI door below. */
async function action(line: string): Promise<boolean> {
  let sent = false
  await act(async () => {
    sent = runMachineAction([line]).ok
    await vi.advanceTimersByTimeAsync(20)
  })
  return sent
}

/** The seat's z2c row: MDI "G53 G0 Z115" with the startJob ok held ~2 s; the
 *  board makes the move and reports Idle at the target once, then its status
 *  read stalls - and the operator presses Load inside the stall. */
async function loadRefusedInsideStall(): Promise<void> {
  socket().board.holdStartReplyMs = 2000
  expect(await action('G53 G0 Z115'), consoleText()).toBe(true)
  await polls(2)
  // The stale Idle frame is all the app has: the line looks finished.
  expect(getMachineController().machineState()).toBe('idle')
  expect(socket().board.awaitingExecution).toBe(true)
  const mark = socket().sent.length
  await load('part.nc')
  // It passed the app's own guard and reached the board, which said no.
  expect(wire(mark)).toContain('loadMoves')
  expect(consoleText()).toContain(STILL_EXECUTING)
}

describe('WO-2655: a load the board refuses leaves Control in the board\'s real state', () => {
  it('held start reply + stalled status: once the board finishes, Control is not Running and MDI and Load work', async () => {
    const ctrl = getMachineController()
    await loadRefusedInsideStall()
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    expect(useMachineControl.getState().job.name).toBeNull()

    // The held start ok lands, the status read comes back, the board settles.
    await settle(2000)
    await polls(4)
    expect(socket().board.awaitingExecution).toBe(false)
    expect(ctrl.hasActiveJob()).toBe(false)

    // THE DEFECT: the store stayed streaming - Running, MDI locked, 99%.
    expect(controlReadsRunning(), JSON.stringify(useMachineControl.getState().job)).toBe(false)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    // The refusal was said once, in plain words, with the bridge's own sentence.
    expect(occurrences('The machine refused this program, so it is NOT loaded'), consoleText()).toBe(1)
    expect(occurrences(STILL_EXECUTING), consoleText()).toBe(1)

    // MDI: staged and started on the wire - no lockout.
    const mdiMark = socket().sent.length
    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
    expect(wire(mdiMark)).toEqual(expect.arrayContaining(['loadMoves', 'startJob']))
    expect(consoleText()).not.toContain(MDI_LOCKED)
    await polls(4)
    expect(controlReadsRunning()).toBe(false)

    // Load again: it loads.
    expect((await load('part.nc')).ok, consoleText()).toBe(true)
    await settle(20)
    expect(useMachineControl.getState().programReadiness.ready, consoleText()).toBe(true)
    expect(useMachineControl.getState().job.name).toBe('part.nc')
    expect(useMachineControl.getState().job.phase).toBe('ready')
  }, 30_000)

  it('while the board really is still executing, Control says so; Stop/Reset then ends it', async () => {
    const ctrl = getMachineController()
    await loadRefusedInsideStall()
    // The line is genuinely still executing on the board: Running is the truth.
    expect(ctrl.hasActiveJob()).toBe(true)
    expect(controlReadsRunning()).toBe(true)
    act(() => { executeOperatorStopReset() })
    await settle(500)
    await polls(3)
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(controlReadsRunning(), JSON.stringify(useMachineControl.getState().job)).toBe(false)
    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
    expect(consoleText()).not.toContain(MDI_LOCKED)
    expect(occurrences(STILL_EXECUTING), consoleText()).toBe(1)
  }, 30_000)

  it('a plain refused load with no stall leaves Control idle, MDI open and Load ready to try again', async () => {
    const ctrl = getMachineController()
    const REASON = 'the program frame is missing, so nothing was staged'
    socket().board.refuseNextLoad = REASON
    await load('part.nc')
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(controlReadsRunning()).toBe(false)
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)

    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
    expect(consoleText()).not.toContain(MDI_LOCKED)
    await polls(4)
    expect(controlReadsRunning()).toBe(false)
    expect((await load('part.nc')).ok, consoleText()).toBe(true)
    await settle(20)
    expect(useMachineControl.getState().programReadiness.ready, consoleText()).toBe(true)
    // The refusal was said once, in plain words, with the board's own sentence.
    expect(occurrences(REASON), consoleText()).toBe(1)
    expect(occurrences('The machine refused this program, so it is NOT loaded'), consoleText()).toBe(1)
  }, 30_000)

  it('a Cycle Start the board refuses (its startJob error reply) leaves Control not Running and MDI open', async () => {
    const ctrl = getMachineController()
    expect((await load('part.nc')).ok, consoleText()).toBe(true)
    await settle(20)
    // The board still drains something the app cannot see; it says no to the start.
    socket().board.awaitingExecution = true
    let accepted = false
    await act(async () => {
      accepted = await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(50)
    })
    const mark = socket().sent.length
    expect(socket().sent.map((m) => m.m)).toContain('startJob')
    expect(occurrences(STILL_EXECUTING), consoleText()).toBe(1)
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(controlReadsRunning(), `${accepted} ${JSON.stringify(useMachineControl.getState().job)}`).toBe(false)
    socket().board.awaitingExecution = false
    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
    expect(wire(mark)).toEqual(expect.arrayContaining(['loadMoves', 'startJob']))
    expect(consoleText()).not.toContain(MDI_LOCKED)
  }, 30_000)

  it('a load while the board visibly runs is still refused before anything reaches the board (rule 11 guard kept)', async () => {
    expect(await action('G53 G0 Z115'), consoleText()).toBe(true)
    await polls(1)
    expect(getMachineController().machineState()).toBe('run')
    const mark = socket().sent.length
    const outcome = await load('part.nc')
    expect(outcome.ok).toBe(false)
    expect(wire(mark)).not.toContain('loadMoves')
    expect(controlReadsRunning()).toBe(true)
  }, 30_000)

  // Fix round: machine-seat kit row zhs on fe746e35b (README "On the fix
  // branch"). Every inbound frame is held ~4 s except replies to later calls -
  // here from the MDI's startJob on, since the seat read hasActiveJob() true at
  // the refusal, so that start had already been sent; Load is refused at once; then the held frames
  // arrive, carrying the MDI's OWN `started` edge AFTER the refusal, and the
  // board completes. On fe746e35b that late start retired the watch and Control
  // stayed Running / 1/1 (99%) / MDI locked.
  it('zhs: refusal -> the same job\'s late started -> completed leaves Control not Running', async () => {
    const ctrl = getMachineController()
    socket().board.holdFromNextStart = true
    expect(await action('G53 G0 X50 Y50'), consoleText()).toBe(true)
    expect(socket().board.holdInbound).toBe(true)
    socket().board.answerLaterCalls = true
    const mark = socket().sent.length
    await load('part.nc')
    expect(wire(mark)).toContain('loadMoves')
    expect(consoleText()).toContain(STILL_EXECUTING)
    // Nothing of the MDI line has reached the app yet: no started, no status.
    expect(ctrl.hasActiveJob()).toBe(true)
    expect(useMachineControl.getState().job.name).toBeNull()

    // The held frames arrive in order: the MDI's replies and its late `started`.
    act(() => { socket().flushHeld() })
    await settle(20)
    expect(ctrl.hasActiveJob()).toBe(true)
    // The board finishes the line and reports it complete.
    await polls(4)
    expect(socket().board.awaitingExecution).toBe(false)
    expect(ctrl.hasActiveJob()).toBe(false)

    expect(controlReadsRunning(), JSON.stringify(useMachineControl.getState().job)).toBe(false)
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(occurrences(STILL_EXECUTING), consoleText()).toBe(1)
    const mdiMark = socket().sent.length
    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
    expect(wire(mdiMark)).toEqual(expect.arrayContaining(['loadMoves', 'startJob']))
    expect(consoleText()).not.toContain(MDI_LOCKED)
    await polls(4)
    expect((await load('part.nc')).ok, consoleText()).toBe(true)
    await settle(20)
    expect(useMachineControl.getState().programReadiness.ready, consoleText()).toBe(true)
  }, 30_000)

  // Fix round clause (b): Stop/Reset clears a stuck Running whenever the
  // controller reports no active job. zhs on fe746e35b: "reset sent, screen
  // unchanged". The stuck screen is set here directly - the store reading
  // streaming 1/1 over an idle board with no active job, exactly the frozen
  // state the seat photographed - because the branch no longer reaches it
  // through the refused load; the press itself goes through the production door.
  it('Stop/Reset over a Running screen the controller has no active job for returns Control to the board\'s state', async () => {
    const ctrl = getMachineController()
    expect(await mdi('G53 G0 Z115'), consoleText()).toBe(true)
    await polls(4)
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(socket().board.awaitingExecution).toBe(false)
    act(() => {
      useMachineControl.getState().applyJobProgress({
        phase: 'streaming',
        totalLines: 1,
        sentLines: 1,
        ackedLines: 0,
        ackedSourceLine: 0,
        sentSourceLine: 0,
        bytesInFlight: 0,
      })
    })
    expect(controlReadsRunning()).toBe(true)

    const mark = socket().sent.length
    act(() => { executeOperatorStopReset() })
    await settle(50)
    // Reset went to the board, and the screen now reads what the board holds.
    expect(wire(mark)).toContain('reset')
    expect(controlReadsRunning(), JSON.stringify(useMachineControl.getState().job)).toBe(false)
    expect(await mdi('G53 G0 Z100'), consoleText()).toBe(true)
    expect(consoleText()).not.toContain(MDI_LOCKED)
  }, 30_000)
})

// Fix round 2 (fable audit 10-07 ~11:25 AM, its repro kept as a test): after the
// refusal under the stall, a second Load the SESSION refuses before anything is
// sent must not cost the watch - the job's completion still settles Control.
async function loadText(name: string, text: string) {
  let outcome = { ok: false, reason: 'not run' as string | null }
  await act(async () => {
    outcome = loadGcodeTextToolpathProgram(name, text, { publishListing: true })
    await vi.advanceTimersByTimeAsync(20)
  })
  return outcome
}

describe('WO-2655 fix round 2: a second Load the session refuses keeps the watch', () => {
  for (const [label, text] of [
    ['soft-limit breach', 'G21 G90 G54\nG0 X5000 Y10 Z5\nM30\n'],
    ['unknown word', 'G21 G90 G54\nG999 X1\nM30\n'],
    ['empty program', '\n'],
    ['bad arc', 'G21 G90 G54\nG0 X0 Y0 Z5\nG2 X10 Y0 I0 J0 F300\nM30\n'],
  ] as const) {
    it(`refusal under the stall, then a second Load the session refuses (${label}), then completion`, async () => {
      const ctrl = getMachineController()
      await loadRefusedInsideStall()
      const mark = socket().sent.length
      const outcome = await loadText('bad.nc', text)
      expect(outcome.ok).toBe(false)
      expect(wire(mark)).toEqual([])
      await settle(2000)
      await polls(4)
      expect(ctrl.hasActiveJob()).toBe(false)
      expect(controlReadsRunning(), JSON.stringify(useMachineControl.getState().job)).toBe(false)
    }, 30_000)
  }
})
