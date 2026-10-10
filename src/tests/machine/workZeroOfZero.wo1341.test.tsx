// @vitest-environment jsdom
//
// WO-1341: a bridge-reported zero is a work-offset value, not a placeholder.
// These tests cross the machine-session load door and inspect the bridge wire:
// a complete zero row stages motion, while a row with no Z value still stops
// before frame selection or staging.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import type { Project, Setup, ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeStock, makeWcs } from '../post/helpers'
import { typedMock } from '../support/typedMock'

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
}

const sockets: FakeBridgeTransport[] = []
const ZERO_OFFSET = { x: 0, y: 0, z: 0 }
let reportedG54: { x: number; y: number; z?: number } = ZERO_OFFSET
let hasProfile = true
let restoredG54Receipt = ZERO_OFFSET

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      sockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const allZero = {
        G54: { ...reportedG54 }, G55: { ...ZERO_OFFSET }, G56: { ...ZERO_OFFSET },
        G57: { ...ZERO_OFFSET }, G58: { ...ZERO_OFFSET }, G59: { ...ZERO_OFFSET },
      }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1341-fake 0.0',
          capabilities: CAPABILITIES,
          readOnly: false,
          workOffsets: { current: allZero, profile: hasProfile ? allZero : null },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
      if (message.m === 'setWorkOffset') {
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, reason: null, offset: { ...restoredG54Receipt } },
        })
      }
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGeometryProgram,
} = await import('../../lib/machine/machineSession')

function setup(): Setup {
  return {
    id: 'setup1',
    name: 'Zero datum setup',
    wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 } }),
    stock: makeStock({ material: 'aluminum' }),
    operations: [makeOp({ id: 'op1', name: 'Contour', type: 'contour_2d' })],
    notes: '',
  }
}

function moves(): ToolpathMove[] {
  return [
    { type: 'rapid', x: 0, y: 0, z: 10 },
    { type: 'feed', x: 10, y: 0, z: 0, feed: 600 },
  ]
}

let originalProject: Project
let originalMachineWorkOffsets: ReturnType<typeof useCamStore.getState>['machineWorkOffsets']

beforeEach(() => {
  vi.useFakeTimers()
  sockets.length = 0
  reportedG54 = ZERO_OFFSET
  hasProfile = true
  restoredG54Receipt = ZERO_OFFSET
  const state = useCamStore.getState()
  originalProject = state.project
  originalMachineWorkOffsets = state.machineWorkOffsets
  const machineWorkOffsets = { ...state.machineWorkOffsets }
  delete machineWorkOffsets['wo1341-machine']
  useCamStore.setState((state) => ({
    machineWorkOffsets,
    project: {
      ...state.project,
      machine: makeMachine({ id: 'wo1341-machine', rapidRate: 5000 }),
      setups: [setup()],
      activeSetupId: 'setup1',
    },
  }))
})

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
}

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject, machineWorkOffsets: originalMachineWorkOffsets })
  useMachineControl.setState({ offsets: {}, consoleLines: [] })
  clearPathFidelity()
  vi.useRealTimers()
})

function socket(): FakeBridgeTransport {
  return sockets[sockets.length - 1]
}

describe('WO-1341: zero is a reported work zero', () => {
  it('loads a program when the controller reports G54 as exactly 0, 0, 0', async () => {
    await connectBridge()
    expect(useMachineControl.getState().offsets.G54).toEqual([0, 0, 0])

    const result = loadGeometryProgram('zero datum', moves(), { opId: 'op1', setupId: 'setup1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(result).toEqual({ ok: true, reason: null })
    expect(socket().sent.map((frame) => frame.m).filter((method) =>
      method === 'selectWcs' || method === 'loadMoves'))
      .toEqual(['selectWcs', 'loadMoves'])
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })

  it('still refuses when the controller reports X and Y but no Z', async () => {
    reportedG54 = { x: 0, y: 0 }
    await connectBridge()
    expect(useMachineControl.getState().offsets.G54).toEqual([0, 0, undefined])

    const result = loadGeometryProgram('missing Z', moves(), { opId: 'op1', setupId: 'setup1' })

    expect(result).toEqual({
      ok: false,
      reason: 'G54 is not fully set on this controller, so nothing was staged. '
        + 'Set the X, Y and Z work zero for G54, then load the program again.',
    })
    expect(socket().sent.some((frame) => frame.m === 'selectWcs' || frame.m === 'loadMoves')).toBe(false)
  })

  it('loads a profile-less bridge row when its non-zero values prove it is a controller report', async () => {
    reportedG54 = { x: 100, y: 50, z: -20 }
    hasProfile = false
    await connectBridge()
    expect(useMachineControl.getState().offsets.G54).toEqual([100, 50, -20])

    const result = loadGeometryProgram('profile-less reported datum', moves(), { opId: 'op1', setupId: 'setup1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(result).toEqual({ ok: true, reason: null })
    expect(socket().sent.map((frame) => frame.m).filter((method) =>
      method === 'selectWcs' || method === 'loadMoves'))
      .toEqual(['selectWcs', 'loadMoves'])
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })

  // ZERO IS A WORK ZERO - Operator, 2026-09-12. Three tests lived here that
  // pinned the opposite: that a profile-less bridge's zeros were 'constructed'
  // and had to be refused. He overruled that in one sentence - "if it starts
  // up and it's zero and a previous one is zero it can be zero. It's not your
  // job to be the safety nazi of this program." The bridge reported the row,
  // so the row is what the controller holds.
  //
  // What still holds, and is the only distinction left, is PRESENCE: an axis
  // the controller never reported is unknown, and that case is pinned above
  // ('still refuses when the controller reports X and Y but no Z').
  it('loads a profile-less bridge reporting 0, 0, 0 - a reported zero is a work zero', async () => {
    hasProfile = false
    await connectBridge()
    expect(useMachineControl.getState().offsets.G54).toEqual([0, 0, 0])

    const result = loadGeometryProgram('profile-less zeros', moves(), { opId: 'op1', setupId: 'setup1' })

    expect(result.ok).toBe(true)
    expect(socket().sent.some((frame) => frame.m === 'selectWcs')).toBe(true)
  })
})
