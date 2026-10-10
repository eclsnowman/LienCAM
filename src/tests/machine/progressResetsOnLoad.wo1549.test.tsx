// @vitest-environment jsdom
//
// WO-1549, board 2026-09-14 (item 8): right after loading a fresh 6-block
// program with Single Block on, before any press, the Program panel read the
// PREVIOUS run's count ("5/6 (83%)"), and only reset to 1/6 on the first press.
//
// The controller's own `jobProgress()` already answers 0/N for a loaded,
// unstarted job (WO-1530, board build 3). The stale count came back through a
// second door: `geometryPartProgress` translates `status.executingMoveId` into
// the line-shaped progress the panel renders, and the move ids are minted per
// program (1..N). A status frame still carrying the last run's executing id -
// the board keeps it until new motion - was looked up in the NEW program's
// move list and republished as that many moves done.
//
// This test drives the real store and the real controllers (an UccncController
// over a fake bridge transport, and the SimulatedController) through the real
// load door, runs the first program to 5 of 6 under Single Block, loads a
// second 6-move program, and reads the Program panel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import type { MachineConfig, Project, Setup } from '../../types'
import { makeMachine, makeOp, makeStock, makeWcs } from '../post/helpers'
import { typedMock } from '../support/typedMock'

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

const WORK_OFFSETS = {
  G54: { x: 10, y: 5, z: 2 }, G55: { x: 110, y: 5, z: 2 },
  G56: { x: 0, y: 0, z: 0 }, G57: { x: 0, y: 0, z: 0 },
  G58: { x: 0, y: 0, z: 0 }, G59: { x: 0, y: 0, z: 0 },
}

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const bridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class Fake extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridge.last = this
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'WO-1549 progress-reset fake bridge',
          capabilities: CAPABILITIES,
          readOnly: false,
          workOffsets: { current: WORK_OFFSETS, profile: WORK_OFFSETS },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: true })
    }

    async close(): Promise<void> { this.fakeEvents = null }

    emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: Fake })
})

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => [...mem.keys()][index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } as Storage,
  configurable: true,
})

const session = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { loadGeometryProgram, connectMachine, disconnectMachine, getMachineController } = session

const TRACE = { opId: 'op1', setupId: 'setup1' }

/** An IDLE status frame, the shape Bridge.cs pushes. */
function idleBridgeStatus(executingMoveId: number | null = null): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId,
    buffer: { moves: 0, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

function machine(): MachineConfig {
  return makeMachine({
    id: 'wo1549-machine',
    name: 'WO-1549 Test Machine',
    travel: { x: 600, y: 400, z: 100 },
    rapidRate: 5000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
  })
}

function setup(): Setup {
  return {
    id: 'setup1',
    name: 'Setup 1',
    wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 10, y: 5, z: 2 } }),
    stock: makeStock({ material: 'aluminum' }),
    operations: [makeOp({ id: 'op1', name: 'Contour', type: 'contour_2d' })],
    notes: '',
  }
}

function applyProject(): void {
  useCamStore.setState((s) => ({
    project: { ...s.project, machine: machine(), setups: [setup()], activeSetupId: 'setup1' },
  }))
}

/** The board's own shape: six moves, ids 1..6 in program order. */
function sixMoveToolpath() {
  return [
    { type: 'rapid' as const, x: 10, y: 5, z: 22 },
    { type: 'feed' as const, x: 10, y: 5, z: 1, feed: 300 },
    { type: 'feed' as const, x: 60, y: 5, z: 1, feed: 900 },
    { type: 'feed' as const, x: 60, y: 45, z: 1, feed: 900 },
    { type: 'feed' as const, x: 20, y: 45, z: 1, feed: 900 },
    { type: 'feed' as const, x: 20, y: 20, z: 1, feed: 900 },
  ]
}

function load(name: string): { ok: boolean; reason: string | null } {
  return loadGeometryProgram(name, sixMoveToolpath(), TRACE)
}

/** What the panel renders, read from the store the panel subscribes to. */
function panelText(): string {
  const { job } = useMachineControl.getState()
  const pct = job.totalLines > 0 ? Math.round((job.ackedLines / job.totalLines) * 100) : 0
  return job.totalLines > 0 ? `${job.ackedLines}/${job.totalLines} (${pct}%)` : 'no program'
}

let originalProject: Project

beforeEach(() => {
  vi.useFakeTimers()
  bridge.last = null
  originalProject = useCamStore.getState().project
  applyProject()
  useMachineControl.setState({ consoleLines: [], singleBlock: false })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject })
  useMachineControl.setState({ consoleLines: [], singleBlock: false })
  vi.useRealTimers()
})

async function connect(kind: 'simulator' | 'bridge'): Promise<void> {
  const pending = connectMachine(kind)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  session.__resetEstopInterlockForTest()
  if (kind === 'simulator') {
    if (!getMachineController().home()) throw new Error('The simulator refused the homed fixture.')
    await vi.advanceTimersByTimeAsync(2_000)
  } else {
    bridge.last?.emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    bridge.last?.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const BRIDGE_STEP_FRAMES = (previous: number, id: number): MachineStatus[] => [
  { ...idleBridgeStatus(previous || id), state: 'run', buffer: { moves: 1, capacitySeconds: null } },
  { ...idleBridgeStatus(id), state: 'run', buffer: { moves: 1, capacitySeconds: null } },
  { ...idleBridgeStatus(id), state: 'run', buffer: { moves: 0, capacitySeconds: null } },
  idleBridgeStatus(id),
]

describe('WO-1549: a freshly loaded program shows 0 of N, not the last run count', () => {
  it('on a bridge: 0/6 after load, then 1/6 after the first Single Block press', async () => {
    await connect('bridge')
    const socket = bridge.last
    if (!socket) throw new Error('The fake bridge was not installed.')

    expect(load('wo1549-first')).toEqual({ ok: true, reason: null })
    await settle()
    expect(panelText()).toBe('0/6 (0%)')

    act(() => { session.setMachineSingleBlock(true) })
    const controller = getMachineController()
    const ids = [1, 2, 3, 4, 5, 6]

    let previous = 0
    for (let block = 1; block <= 5; block++) {
      const id = ids[block - 1]
      act(() => { expect(controller.stepJob()).toBe(true) })
      for (const frame of BRIDGE_STEP_FRAMES(previous, id)) {
        act(() => { socket.emit({ t: 'status', v: frame } as BridgeMessage) })
      }
      previous = id
    }
    expect(panelText()).toBe('5/6 (83%)')

    // A second, freshly loaded program. The board holds its last executing id
    // until new motion, so the very next status frame still carries id 5.
    expect(load('wo1549-second')).toEqual({ ok: true, reason: null })
    await settle()
    act(() => { socket.emit({ t: 'status', v: idleBridgeStatus(previous) } as BridgeMessage) })

    expect(panelText()).toBe('0/6 (0%)')

    act(() => { expect(controller.stepJob()).toBe(true) })
    for (const frame of BRIDGE_STEP_FRAMES(0, ids[0])) {
      act(() => { socket.emit({ t: 'status', v: frame } as BridgeMessage) })
    }
    expect(panelText()).toBe('1/6 (17%)')
  })

  it('on the simulator: 0/6 after load, then 1/6 after the first Single Block press', async () => {
    await connect('simulator')

    expect(load('wo1549-sim-first')).toEqual({ ok: true, reason: null })
    expect(panelText()).toBe('0/6 (0%)')

    act(() => { session.setMachineSingleBlock(true) })
    const controller = getMachineController()

    for (let block = 1; block <= 5; block++) {
      act(() => { expect(controller.stepJob()).toBe(true) })
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    }
    expect(panelText()).toBe('5/6 (83%)')

    // The simulator keeps the held job active under Single Block, so a load is
    // refused until Stop/Reset - press it, then load the second program.
    act(() => { controller.stopJob() })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })

    expect(load('wo1549-sim-second')).toEqual({ ok: true, reason: null })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

    expect(panelText()).toBe('0/6 (0%)')

    act(() => { expect(controller.stepJob()).toBe(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(panelText()).toBe('1/6 (17%)')
  })
})

// The panel really does render those counters - a store-only claim would not
// prove the sentence the operator read on the board.
describe('WO-1549: the Program panel renders the reset count', () => {
  it('shows 0/6 (0%) before any press on a freshly loaded program', async () => {
    await connect('simulator')
    render(<ProgramPanel />)
    expect(load('wo1549-render')).toEqual({ ok: true, reason: null })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(screen.getByTestId('control-progress-text').textContent).toBe('0/6 (0%)')
  })
})
