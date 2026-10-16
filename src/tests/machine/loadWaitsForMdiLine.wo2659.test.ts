// @vitest-environment jsdom
// WO-2659: production session and UccncController over the WO-2659 fake-board bridge.
// Completion follows Machine.cs: idle and unchanged position across two polls.
// No hardware or physical motion.

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
import { createDefaultControllerDefinition, type MachineConfig, type Project, type Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
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
  holdSelectWcs: boolean
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
      holdSelectWcs: false,
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
          bridge: 'wo-2659-fake 0.0',
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
      if (message.m === 'selectWcs' && board.holdSelectWcs) return
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
  loadGcodeFile,
  loadSetupToolpathProgram,
  loadSetupsToolpathProgram,
  runMachineAction,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

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
    id: 'wo2659-machine',
    name: 'WO-2659 Machine',
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

function preparedSetup(route: 'single' | 'multiple' | 'posted' = 'single'): string {
  const tool = makeTool({ id: 'prepared-tool', toolNumber: 1 })
  const setup: Setup = {
    id: 'prepared-setup', name: 'Prepared setup', notes: '',
    wcs: makeWcs({ fixtureOffset: 54, origin: { x: 10, y: 5, z: 2 } }),
    stock: makeStock(),
    operations: [makeOp({ id: 'prepared-op', toolId: tool.id, status: 'ready', toolpathMoves: [
      { type: 'rapid', x: 20, y: 20, z: 10 },
      { type: 'feed', x: 25, y: 20, z: 1, feed: 300 },
      { type: 'rapid', x: 25, y: 20, z: 10 },
    ] })],
  }
  const setups = [setup]
  if (route !== 'single') {
    const second = structuredClone(setup)
    second.id = 'prepared-second'
    second.name = 'Second setup'
    second.operations[0].id = 'second-op'
    setups.push(second)
  }
  if (route === 'posted') setup.machineActions = [{
    id: 'pause', name: 'Pause', kind: 'operator_stop', enabled: true,
    afterOpId: setup.operations[0].id, message: 'Inspect',
  }]
  const project = { ...useCamStore.getState().project, setups, toolLibrary: [tool], nests: [], stocks: [] }
  for (const candidate of setups) stampGenerationCurrent(project, candidate, candidate.operations[0], tool)
  useCamStore.setState({ project, toolLibrary: [tool] })
  return setup.id
}

let originalTools: ReturnType<typeof useCamStore.getState>['toolLibrary']
let originalPreparation: ReturnType<typeof useCamStore.getState>['stageOperationsForEmission']
let originalProject: Project

beforeEach(async () => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  delete PROGRAM_BRIDGE_CAPABILITIES.maxProgramMoves
  useMachineActions.setState({ byMachine: {} })
  originalProject = useCamStore.getState().project
  originalTools = useCamStore.getState().toolLibrary
  originalPreparation = useCamStore.getState().stageOperationsForEmission
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
  useCamStore.setState({ project: originalProject, toolLibrary: originalTools, stageOperationsForEmission: originalPreparation, machineWorkOffsets: {} })
  clearPathFidelity()
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  useMachineControl.setState({ consoleLines: [], alarm: null })
  vi.useRealTimers()
})

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


async function movingMdi(): Promise<void> {
  expect(await mdi('G53 G0 Z115'), consoleText()).toBe(true)
  await polls(1)
  expect(getMachineController().machineState()).toBe('run')
  expect(socket().board.awaitingExecution).toBe(true)
}

function requestFile(name: string) {
  return loadGcodeFile(name, NC, null)
}

async function finishLine(): Promise<void> {
  await polls(2)
  await settle(20)
}

describe('WO-2659: Load waits for the moving typed MDI line', () => {
  it('keeps the moving line until completed, then stages the requested file once without starting it', async () => {
    await movingMdi()
    const mark = socket().sent.length
    expect(requestFile('next.nc')).toEqual({ door: 'program', ok: true, reason: null })
    expect(consoleText()).toContain('Load of "next.nc" waits for the MDI line to finish.')
    expect(wire(mark)).not.toContain('loadMoves')
    await polls(1) // First Idle is not the bridge's completed edge.
    expect(socket().board.awaitingExecution).toBe(true)
    expect(wire(mark)).not.toContain('loadMoves')
    await polls(1)
    await settle(20)
    expect(wire(mark).filter((m) => m === 'loadMoves')).toHaveLength(1)
    expect(wire(mark)).not.toContain('startJob')
    expect(useMachineControl.getState().job.name).toBe('next.nc')
    expect(useMachineControl.getState().job.phase).toBe('ready')
    expect(consoleText()).toContain('The MDI line finished; loading "next.nc".')
  })

  it('replaces the file beneath MDI without first restaging that old file', async () => {
    expect(requestFile('before.nc')).toMatchObject({ ok: true })
    await settle(20)
    await movingMdi()
    const mark = socket().sent.length
    expect(requestFile('after.nc')).toMatchObject({ ok: true })
    expect(useMachineControl.getState().job.name).toBe('before.nc')
    await finishLine()
    expect(wire(mark).filter((m) => m === 'loadMoves')).toHaveLength(1)
    expect(wire(mark)).not.toContain('startJob')
    expect(useMachineControl.getState().job.name).toBe('after.nc')
  })

  it('the direct interpreted-file door also waits and delivers its staging callback only after completion', async () => {
    await movingMdi()
    const staged = vi.fn()
    const mark = socket().sent.length
    expect(loadGcodeTextToolpathProgram('direct.nc', NC, { publishListing: true, onStageResult: staged }).ok).toBe(true)
    expect(staged).not.toHaveBeenCalled()
    expect(wire(mark)).not.toContain('loadMoves')
    await finishLine()
    expect(staged).toHaveBeenCalledWith({ ok: true, reason: null })
    expect(useMachineControl.getState().job.name).toBe('direct.nc')
  })

  it('requires Idle even after completion, and releases on the later status', async () => {
    await movingMdi()
    const mark = socket().sent.length
    requestFile('late-idle.nc')
    socket().board.awaitingExecution = false
    socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    await settle(20)
    expect(wire(mark)).not.toContain('loadMoves')
    await polls(1)
    expect(wire(mark).filter((m) => m === 'loadMoves')).toHaveLength(1)
    expect(wire(mark)).not.toContain('startJob')
  })

  it('a different job start cancels the old waiting request', async () => {
    await movingMdi()
    const mark = socket().sent.length
    requestFile('old-run.nc')
    socket().emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
    await finishLine()
    expect(wire(mark)).not.toContain('loadMoves')
    expect(consoleText()).toContain('Load of "old-run.nc" canceled: the machine session or program changed.')
  })

  it('waits through every board-sized part of one typed return line', async () => {
    getMachineController().capabilities.maxProgramMoves = 1
    expect(await mdi('G28 X50 Y30 Z100'), consoleText()).toBe(true)
    await polls(1)
    expect(getMachineController().machineState()).toBe('run')
    requestFile('after-parts.nc')
    await finishLine() // Only the first board-sized part has finished.
    expect(useMachineControl.getState().job.name).not.toBe('after-parts.nc')
    for (let i = 0; i < 150 && useMachineControl.getState().job.name !== 'after-parts.nc'; i++) await polls(1)
    expect(useMachineControl.getState().job.name, consoleText()).toBe('after-parts.nc')
    expect(consoleText()).not.toContain('Load of "after-parts.nc" canceled:')
    expect(useMachineControl.getState().job.phase).toBe('ready')
  })

  it('does not queue an internal staging callback that would start motion', async () => {
    await movingMdi()
    const start = vi.fn(() => true)
    const mark = socket().sent.length
    expect(loadGcodeTextToolpathProgram('internal.nc', NC, { publishListing: true, onStaged: start }).ok).toBe(false)
    await finishLine()
    expect(start).not.toHaveBeenCalled()
    expect(wire(mark)).not.toContain('loadMoves')
    expect(consoleText()).not.toContain('waits for the MDI line')
  })

  it('keeps the old-file restoration fenced while the replacement WCS receipt is held', async () => {
    requestFile('before.nc')
    await settle(20)
    await movingMdi()
    const mark = socket().sent.length
    requestFile('after.nc')
    socket().board.holdSelectWcs = true
    await finishLine()
    await polls(1) // Status during the held receipt must not restore before.nc.
    const selects = socket().sent.slice(mark).filter((message) => message.m === 'selectWcs')
    expect(selects, consoleText()).toHaveLength(1)
    expect(wire(mark)).not.toContain('loadMoves')
    socket().board.holdSelectWcs = false
    for (const message of selects) socket().emit({ t: 'reply', seq: message.seq, ok: true, v: true } as BridgeMessage)
    await settle(20)
    expect(wire(mark).filter((method) => method === 'loadMoves')).toHaveLength(1)
    expect(wire(mark)).not.toContain('startJob')
    expect(useMachineControl.getState().job.name).toBe('after.nc')
  })

  it.each([false, true])('Load entered at first Idle waits for completion (superseding=%s)', async (superseding) => {
    await movingMdi()
    const mark = socket().sent.length
    if (superseding) requestFile('earlier.nc')
    await polls(1)
    expect(getMachineController().machineState()).toBe('idle')
    expect(socket().board.awaitingExecution).toBe(true)
    requestFile('first-idle.nc')
    await settle(20)
    expect(consoleText()).toContain('Load of "first-idle.nc" waits for the MDI line to finish.')
    expect(wire(mark)).not.toContain('loadMoves')
    await polls(1)
    await settle(20)
    expect(wire(mark).filter((method) => method === 'loadMoves')).toHaveLength(1)
    expect(useMachineControl.getState().job.name).toBe('first-idle.nc')
    expect(consoleText()).not.toContain(STILL_EXECUTING)
  })

  // WO-2833 round 5 (the operator, 10-15: "a refused Load disarms A too -
  // Cycle Start greyed until a file is armed"): the operator's deferred file
  // Load, refused by the reader, disarms the armed original - it is not
  // staged again after the line. Round 6: a setup Load is a Load too (below).
  it('a deferred file Load the reader refuses disarms the original file: nothing is staged again or loaded', async () => {
    requestFile('before.nc')
    await settle(20)
    await movingMdi()
    const mark = socket().sent.length
    expect(loadGcodeFile('invalid.nc', 'G999 X1\nM30\n', null)).toMatchObject({ ok: true })
    await finishLine()
    expect(useMachineControl.getState().job.name).toBeNull()
    expect(useMachineControl.getState().programReadiness.ready, consoleText()).toBe(false)
    expect(consoleText()).not.toContain('"before.nc" is staged again')
    expect(wire(mark)).not.toContain('loadMoves')
    expect(wire(mark)).not.toContain('startJob')
  })

  // WO-2833 round 6 (architect 10-15 11:13): the Load menu's "Load a posted
  // setup or open a g-code file" is one Load, so a deferred setup Load refused
  // after asynchronous preparation disarms the original file as a refused file
  // does - it is not staged again after the line.
  it('holds old-file restoration through asynchronous setup preparation; the refused setup disarms the original file', async () => {
    requestFile('before.nc')
    await settle(20)
    await movingMdi()
    const mark = socket().sent.length
    const pending = loadSetupToolpathProgram('missing-setup')
    await finishLine()
    expect((await pending).ok).toBe(false)
    await settle(20)
    expect(useMachineControl.getState().job.name).toBeNull()
    expect(useMachineControl.getState().programReadiness.ready, consoleText()).toBe(false)
    expect(consoleText()).not.toContain('"before.nc" is staged again')
    expect(wire(mark)).not.toContain('loadMoves')
    expect(wire(mark)).not.toContain('startJob')
  })

  it('the newest waiting Load supersedes the previous one', async () => {
    await movingMdi()
    const mark = socket().sent.length
    requestFile('first.nc')
    requestFile('second.nc')
    await finishLine()
    expect(wire(mark).filter((m) => m === 'loadMoves')).toHaveLength(1)
    expect(useMachineControl.getState().job.name).toBe('second.nc')
    expect(consoleText()).toContain('Load of "first.nc" canceled: another Load replaced the waiting request.')
  })

  it.each(['stopJob', 'reset', 'emergencyStop'] as const)('%s cancels Load before any later completion', async (method) => {
    await movingMdi()
    const mark = socket().sent.length
    requestFile('canceled.nc')
    act(() => { getMachineController()[method]() })
    await finishLine()
    expect(wire(mark)).not.toContain('loadMoves')
    expect(consoleText()).toContain('Load of "canceled.nc" canceled:')
    expect(useMachineControl.getState().job.name).not.toBe('canceled.nc')
  })

  it('a failed line cancels Load, including a later stale completed event', async () => {
    await movingMdi()
    const mark = socket().sent.length
    requestFile('fault.nc')
    socket().emit({ t: 'jobEvent', v: { event: 'failed', fault: null } } as BridgeMessage)
    await finishLine()
    expect(wire(mark)).not.toContain('loadMoves')
    expect(consoleText()).toContain('Load of "fault.nc" canceled: the MDI line failed.')
  })

  it('an alarm without a job terminal event cancels the waiting Load', async () => {
    await movingMdi()
    const mark = socket().sent.length
    requestFile('alarm.nc')
    socket().board.state = 'alarm'
    socket().emit({ t: 'status', v: statusOf(socket().board) } as BridgeMessage)
    await finishLine()
    expect(wire(mark)).not.toContain('loadMoves')
    expect(consoleText()).toContain('Load of "alarm.nc" canceled:')
  })

  it('disconnect and reconnect cannot inherit or release an old Load', async () => {
    await movingMdi()
    const old = socket()
    requestFile('old-session.nc')
    const disconnect = disconnectMachine()
    await settle(300)
    await disconnect
    const connect = connectMachine('bridge')
    await settle(300)
    await connect
    const mark = socket().sent.length
    old.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    await polls(3)
    expect(wire(mark)).not.toContain('loadMoves')
    expect(useMachineControl.getState().job.name).not.toBe('old-session.nc')
    expect(consoleText()).toContain('Load of "old-session.nc" canceled: the machine connection changed.')
  })

  it('expires after the established 30-second settle budget without stopping the line', async () => {
    await movingMdi()
    const mark = socket().sent.length
    requestFile('expired.nc')
    await settle(30_001)
    expect(wire(mark)).not.toContain('loadMoves')
    expect(wire(mark)).not.toContain('stopJob')
    expect(socket().board.awaitingExecution).toBe(true)
    expect(consoleText()).toContain('Load of "expired.nc" canceled: the MDI line did not finish within 30 seconds.')
    await finishLine()
    expect(wire(mark)).not.toContain('loadMoves')
  })

  it('refuses an actual program run with the original message', async () => {
    expect((await load('program.nc')).ok).toBe(true)
    await act(async () => { await executeOperatorCycleStart() })
    await polls(1)
    const mark = socket().sent.length
    const result = requestFile('not-now.nc')
    expect(result).toMatchObject({ ok: false, reason: 'The program is still running - Feed Hold, then Stop, before loading another.' })
    expect(wire(mark)).not.toContain('loadMoves')
    expect(consoleText()).not.toContain('waits for the MDI line')
  })

  it.each([['G53 G0 Z115'], ['G53 G0 Z115', 'G53 G0 X100']])('does not mistake an action for a typed line (%s)', async (...lines) => {
    expect(runMachineAction(lines).ok).toBe(true)
    await settle(20)
    await polls(1)
    expect(requestFile('not-an-action.nc')).toMatchObject({ ok: false })
    expect(consoleText()).not.toContain('waits for the MDI line')
  })


  it('loads a prepared setup after typed MDI completes', async () => {
    const setupId = preparedSetup()
    await movingMdi()
    const pending = loadSetupToolpathProgram(setupId)
    await finishLine()
    expect(await pending).toEqual({ ok: true, reason: null })
    await settle(20)
    expect(useMachineControl.getState().job.name).toBe('Prepared setup (toolpath)')
  })

  it.each((['single', 'multiple', 'posted'] as const).flatMap((route) =>
    (['new Load', 'Stop', 'reconnect'] as const).map((action) => ({ route, action })),
  ))('cancels deferred $route setup during held CAM preparation on $action', async ({ route, action }) => {
    const setupId = preparedSetup(route)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prepare = vi.fn(async () => { await gate; return { recomputed: [], restore: () => {} } })
    useCamStore.setState({ stageOperationsForEmission: prepare })
    await movingMdi()
    let outcome: { ok: boolean; reason: string | null } | undefined
    const pending = (route === 'single' ? loadSetupToolpathProgram(setupId)
      : loadSetupsToolpathProgram(useCamStore.getState().project.setups.map((setup) => setup.id)))
      .then((value) => { outcome = value })
    await finishLine()
    expect(prepare).toHaveBeenCalledOnce()
    expect(outcome).toBeUndefined()
    if (action === 'new Load') {
      expect(requestFile('newer.nc')).toMatchObject({ ok: true })
      await settle(20)
      expect(useMachineControl.getState().job.name).toBe('newer.nc')
    } else if (action === 'Stop') {
      act(() => { executeOperatorStopReset() })
      await settle(20)
    } else {
      const disconnect = disconnectMachine()
      await settle(300)
      await disconnect
      const connect = connectMachine('bridge')
      await settle(300)
      await connect
      act(() => { __resetEstopInterlockForTest() })
      socket().poll()
      socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    }
    // Cancellation resolves even if CAM never releases its computation.
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome?.reason).toContain('canceled')
    const mark = socket().sent.length
    release()
    await settle(20)
    await pending
    expect(wire(mark)).not.toContain('loadMoves')
    expect(wire(mark)).not.toContain('selectWcs')
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome?.reason).toContain('canceled')
    if (action === 'new Load') expect(useMachineControl.getState().job.name).toBe('newer.nc')
  })

  it.each([false, true])('setup Load waits before preparing a setup and Stop resolves its promise (multiple=%s)', async (multiple) => {
    await movingMdi()
    const mark = socket().sent.length
    let outcome: { ok: boolean; reason: string | null } | undefined
    const pending = (multiple ? loadSetupsToolpathProgram(['absent-a', 'absent-b']) : loadSetupToolpathProgram('absent-a'))
      .then((value) => { outcome = value })
    await settle(20)
    expect(outcome).toBeUndefined()
    expect(wire(mark)).not.toContain('loadMoves')
    act(() => { executeOperatorStopReset() })
    await settle(20)
    await pending
    expect(outcome).toMatchObject({ ok: false })
    expect(outcome?.reason).toContain('canceled')
  })
})
