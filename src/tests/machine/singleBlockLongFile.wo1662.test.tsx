// @vitest-environment jsdom
//
// WO-1662, hardware session 2026-09-17 (Operator, on his 110,615-move file):
// Single Block ON + a program long enough to split into controller-sized
// parts (WO-1054) -> CYCLE START stayed greyed before the first press, even
// though it worked fine on a short, unsplit file and Single Block OFF worked
// on the SAME long file. `wholeProgramProgress` (this file) rescales the
// controller's per-PART `sentLines` to the whole program's `totalLines` but
// left `sentLines` at the part's own count - so `sentLines !== totalLines`
// for every part but the last, even though the whole-queue backend
// (UCCNC's geometry queue reports a part fully sent the instant it is
// staged) has genuinely sent everything it currently holds. operatorTransport
// reads that mismatch as "a block might still be in flight" and refuses.

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import type { MachineConfig, Project, Setup, ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeStock, makeWcs } from '../post/helpers'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  status(v: MachineStatus): void
  homed(): void
}

const bridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

// A small maxProgramMoves reproduces the same split a 110,615-move program
// hits against the board's real 4,095-move planning cap, without a fixture
// that size in the test.
const CAP = 6

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
  machineProgram: true,
  maxProgramMoves: CAP,
}

const IDLE: MachineStatus = {
  state: 'idle',
  subState: null,
  machinePos: null,
  workPos: null,
  feedMmMin: null,
  spindleRpm: null,
  overrides: null,
  executingMoveId: null,
  buffer: { moves: 0, capacitySeconds: null },
  inputs: { estop: false, hardLimit: false, softLimit: false, probe: false, limits: null, door: null, hold: false },
  homed: null,
  spindle: null,
}

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
        v: { protocol: 1, bridge: 'WO-1662 long-file fake bridge', capabilities: CAPABILITIES, readOnly: false },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: message.m === 'resetToIdle' ? { ok: true, reason: null } : true })
    }

    status(v: MachineStatus): void { this.emit({ t: 'status', v }) }
    homed(): void { this.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } }) }

    async close(): Promise<void> { this.fakeEvents = null }

    private emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }
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
const { __reportWorkOffsetsForTest } = session
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { currentOperatorTransport, executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

const TRACE = { opId: 'op1', setupId: 'setup1' }

function toolpath(count: number, rapidEvery: number): ToolpathMove[] {
  return Array.from({ length: count }, (_, index) => ({
    type: (index + 1) % rapidEvery === 0 ? 'rapid' as const : 'feed' as const,
    x: 10,
    y: 5,
    z: 2,
    ...((index + 1) % rapidEvery === 0 ? {} : { feed: 6_000 }),
  }))
}

function machine(): MachineConfig {
  return makeMachine({
    id: 'wo1662-machine',
    name: 'WO-1662 test machine',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    rapidRate: 6_000,
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

let originalProject: Project

beforeEach(async () => {
  bridge.last = null
  originalProject = useCamStore.getState().project
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: machine(), setups: [setup()], activeSetupId: 'setup1' },
  }))
  await act(async () => { await session.connectMachine('bridge') })
  const transport = bridge.last as FakeBridgeTransport | null
  if (!transport) throw new Error('The fake bridge was not installed.')
  act(() => { transport.status(IDLE) })
  act(() => { transport.homed() })
  session.__resetEstopInterlockForTest()
  act(() => { __reportWorkOffsetsForTest({ G54: { x: 10, y: 5, z: 2 } }) })
  useMachineControl.setState({ consoleLines: [] })
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    session.setMachineSingleBlock(false)
    await act(async () => { await session.disconnectMachine() })
  }
  useCamStore.setState({ project: originalProject })
  useMachineControl.setState({ consoleLines: [] })
})

// UCCNC selects the program's WCS before staging it, over a round trip to the
// bridge (machineSession.ts's `selectWcsAwait` branch) - `loadGeometryProgram`
// returns `ok: true` optimistically and the job only fills in once that reply
// lands. The fake bridge replies synchronously, so the reply is a microtask
// away, not a status frame; wait for it rather than assuming it is already in.
async function loadAndStage(name: string, moves: ToolpathMove[]): Promise<void> {
  expect(session.loadGeometryProgram(name, moves, TRACE)).toEqual({ ok: true, reason: null })
  await vi.waitFor(() => expect(useMachineControl.getState().job.phase).toBe('ready'))
}

describe('WO-1662 Single Block on a program split into controller-sized parts', () => {
  it('leaves CYCLE START enabled before the first press, on the long file and the short one', async () => {
    // The short, unsplit file: today's behaviour, unchanged.
    await loadAndStage('wo1662-short', toolpath(4, 3))
    expect(useMachineControl.getState().job).toMatchObject({ phase: 'ready', totalLines: 4, ackedLines: 0 })
    act(() => { session.setMachineSingleBlock(true) })
    expect(currentOperatorTransport()).toMatchObject({
      action: 'single-block',
      cycleStartEnabled: true,
      cycleStartDetail: 'Execute exactly one block.',
    })
    act(() => { session.setMachineSingleBlock(false) })

    // The long file: 15 moves against a 6-move controller cap, so it stages
    // as multiple parts (WO-1054) - the same shape as Operator's 110,615-move
    // file against the board's real cap.
    const count = 15
    await loadAndStage('wo1662-long', toolpath(count, 3))
    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(true)
    expect(readiness.reason).toMatch(/running in \d+ parts/)
    expect(useMachineControl.getState().job).toMatchObject({ phase: 'ready', totalLines: count, ackedLines: 0 })

    // Single Block OFF: finding (i) says this already worked on the board.
    expect(currentOperatorTransport()).toMatchObject({ action: 'start', cycleStartEnabled: true })

    // Single Block ON, before any press: this is what stayed greyed on the
    // board (WO-1662 finding i). It must be enabled, same as the short file,
    // and its tooltip must say what the press WILL do, never why it cannot
    // (rule 11 / acceptance line 2).
    act(() => { session.setMachineSingleBlock(true) })
    expect(currentOperatorTransport()).toMatchObject({
      action: 'single-block',
      cycleStartEnabled: true,
      cycleStartDetail: 'Execute exactly one block.',
    })
    render(createElement(ControlTransportBar))
    expect((screen.getByTestId('control-cyclestart') as HTMLButtonElement).disabled).toBe(false)

    // One press sends exactly one block's motion and stops; a second press
    // sends the next (acceptance line 1).
    const transport = bridge.last!
    for (const id of [1, 2]) {
      expect(await executeOperatorCycleStart()).toBe(true)
      act(() => { transport.status({ ...IDLE, state: 'run', buffer: { moves: 1, capacitySeconds: null }, executingMoveId: id }) })
      act(() => { transport.status({ ...IDLE, state: 'idle', buffer: { moves: 0, capacitySeconds: null }, executingMoveId: id }) })
      expect(useMachineControl.getState().job.ackedLines).toBe(id)
      expect(currentOperatorTransport()).toMatchObject({ action: 'single-block', cycleStartEnabled: true })
    }
  })
})
