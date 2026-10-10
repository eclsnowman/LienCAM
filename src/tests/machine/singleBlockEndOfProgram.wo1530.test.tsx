// @vitest-environment jsdom
//
// WO-1530 on the board, 2026-09-14 (build 4, frames session-block3.ws-frames.ndjson):
// Single Block started and ran one block per press, but after the LAST block
// CYCLE START stayed enabled and every further press painted a red
// "stepJob: the program has no more moves". The bridge sends NO jobEvent while
// stepping, and after each block the board rests at idle / buffer 0 / the
// block's own id - which the session read as "that move still in flight"
// (5 of 6 after the sixth block). This test replays those frames through the
// real session: connect over the bridge, load G-code text, step every block.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus, QueuedMove } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  status(v: MachineStatus): void
  homed(): void
}

const bridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

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
        v: { protocol: 1, bridge: 'WO-1530 end-of-program fake bridge', capabilities: CAPABILITIES, readOnly: false },
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
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { deriveOperatorTransport } = await import('../../lib/machine/operatorTransport')

function verdict() {
  const s = useMachineControl.getState()
  return deriveOperatorTransport({
    connectionPhase: s.connectionPhase,
    machineState: s.machineState,
    homed: true,
    activeWcs: 'G54',
    noHomeSwitches: false,
    job: s.job,
    programReadiness: { ready: true, reason: 'Program checks passed.' },
    programFit: null,
    singleBlock: s.singleBlock,
    fitTrace: null,
    toolChange: null,
    programText: s.programText,
  })
}

beforeEach(() => {
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  bridge.last = null
  useMachineControl.setState({ consoleLines: [] })
})

afterEach(async () => {
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
})

describe('WO-1530 Single Block ends with the program on a geometry bridge', () => {
  it('each stepped block counts as done at rest, and CYCLE START goes off after the last block', async () => {
    await act(async () => { await session.connectMachine('bridge') })
    const transport = bridge.last
    if (!transport) throw new Error('The fake bridge was not installed.')
    act(() => { transport.status(IDLE) })
    act(() => { transport.homed() })
    session.__resetEstopInterlockForTest()

    // The board's loadMoves at 20:21:08: six moves, ids 1..6. Armed through the
    // session exactly as a geometry load arms it, so every status frame below
    // runs the real status handler and progress translation.
    const moves: QueuedMove[] = [1, 2, 3, 4, 5, 6].map((id) => ({ id, kind: 'marker' }))
    const controller = session.getMachineController()
    act(() => {
      expect(controller.loadMoves?.(moves)).toEqual({ ok: true, reason: null })
      session.armPathFidelityFromMoves(moves, 'work')
      // What every session loader does right after staging: publish the
      // controller's own counters so the transport sees an armed job.
      useMachineControl.getState().applyJobProgress(controller.jobProgress())
    })
    expect(transport.sent.some((message) => message.m === 'loadMoves')).toBe(true)
    const ids = moves.map((move) => move.id)
    const total = ids.length

    act(() => { session.setMachineSingleBlock(true) })
    expect(verdict()).toMatchObject({ action: 'single-block', cycleStartEnabled: true })

    let previous = 0
    for (let block = 1; block <= total; block++) {
      const id = ids[block - 1]
      act(() => { expect(controller.stepJob()).toBe(true) })
      // The frame order the board sent for every press (press 5 and 6 of order A).
      act(() => { transport.status({ ...IDLE, state: 'run', buffer: { moves: 1, capacitySeconds: null }, executingMoveId: previous || id }) })
      act(() => { transport.status({ ...IDLE, state: 'run', buffer: { moves: 1, capacitySeconds: null }, executingMoveId: id }) })
      act(() => { transport.status({ ...IDLE, state: 'run', buffer: { moves: 0, capacitySeconds: null }, executingMoveId: id }) })
      act(() => { transport.status({ ...IDLE, state: 'idle', buffer: { moves: 0, capacitySeconds: null }, executingMoveId: id }) })
      previous = id

      expect(useMachineControl.getState().job.ackedLines).toBe(block)
      expect(verdict().cycleStartEnabled).toBe(block < total)
    }

    // Press 7 on the board: nothing is offered, so no red "no more moves" row can be reached.
    expect(verdict()).toMatchObject({ cycleStartEnabled: false })
  })
})
