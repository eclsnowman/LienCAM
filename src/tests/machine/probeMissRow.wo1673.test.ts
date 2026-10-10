// @vitest-environment jsdom
//
// WO-1673 - A PROBE THAT ENDS WITHOUT CONTACT PRINTS ONE APP ROW.
//
// On the board 2026-09-17 a deliberate Probe work Z0 miss (the machine came to
// rest at machine Z 78.9, WO-1628 PASS) printed nothing from the app; the only
// console record was the bridge's own "[bridge] ... found no contact" frame.
// This drives the REAL `UccncController` over the fake bridge with Operator's
// capabilities (`gcodeText: false`) and a probe reply `{ok:false, at:null}`,
// and asserts the app's own row: which probe, "no contact", and the position it
// ended at in both frames (WO-1667's formatter).
//
// NOT CLAIMED: hardware. Tier 1 is the next machine session.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus, MachineVec3 } from '../../lib/machine/controller'
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

const BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

/** G54 on Operator's machine the night of the finding (machine = work + 66.57). */
const G54 = { x: 188.7325, y: 397.655, z: 66.57 }

let sent: BridgeCallMessage[] = []
let bridgeEvents: BridgeTransportEvents | null = null
let position: MachineVec3 = { x: 100, y: 100, z: 78.9 }
let homedReport: MachineStatus['homed'] = { X: true, Y: true, Z: true }
/** What the next probe calls answer, in order. */
let probeReplies: Array<(seq: number) => BridgeMessage> = []

function statusFrame(): BridgeMessage {
  const status: MachineStatus = {
    state: 'idle',
    subState: null,
    machinePos: { ...position },
    workPos: { x: position.x - G54.x, y: position.y - G54.y, z: position.z - G54.z },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: homedReport,
    spindle: null,
  }
  return { t: 'status', v: status } as BridgeMessage
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        const offsets = { G54, G55: G54, G56: G54, G57: G54, G58: G54, G59: G54 }
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'wo-1673-fake 0.0',
            capabilities: BRIDGE_CAPABILITIES,
            readOnly: false,
            workOffsets: { current: offsets, profile: offsets },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        sent.push(message)
        const answer = (v?: unknown) => bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v } as BridgeMessage)
        const a = message.a as Record<string, number | string | undefined>
        switch (message.m) {
          case 'selectWcs':
            answer(true)
            return
          case 'jogToMachineZ':
            position = { ...position, z: Number(a.z) }
            answer(true)
            bridgeEvents?.onMessage(statusFrame())
            return
          case 'jogToWorkXY':
            position = { ...position, x: Number(a.x) + G54.x, y: Number(a.y) + G54.y }
            answer(true)
            bridgeEvents?.onMessage(statusFrame())
            return
          case 'queryStatus':
            answer()
            bridgeEvents?.onMessage(statusFrame())
            return
          case 'probe': {
            const next = probeReplies.shift()
            if (!next) return
            const frame = next(message.seq) as { v?: { at?: MachineVec3 | null } }
            // A miss comes to rest at the target: the bridge reports the machine
            // released at the search end, with no contact point.
            if (frame.v?.at) position = { ...frame.v.at }
            else if (frame.v) position = { ...position, [String(a.axis).toLowerCase()]: Number(a.targetMm) }
            bridgeEvents?.onMessage(frame as BridgeMessage)
            bridgeEvents?.onMessage(statusFrame())
            return
          }
          default:
            answer(true)
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  __reportWorkOffsetsForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runDirectionalProbeTouch,
  runZProbeCycle,
} = await import('../../lib/machine/machineSession')

const PROBE_CONFIG = {
  positioningFeed: 1000,
  fastFeed: 400,
  slowFeed: 50,
  retract: 2,
  maxTravel: 30,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
}

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  bridgeEvents?.onMessage(statusFrame())
  sent = []
}

/** Let a cycle's polling loops run on fake time until it settles. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false
  void promise.finally(() => { done = true })
  for (let i = 0; i < 20_000 && !done; i++) await vi.advanceTimersByTimeAsync(50)
  return promise
}

/** The console rows the APP printed (never the bridge's own frames). */
function appRows(): string[] {
  return useMachineControl.getState().consoleLines
    .map((entry) => entry.text)
    .filter((text) => !text.startsWith('[bridge]'))
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  probeReplies = []
  position = { x: 100, y: 100, z: 78.9 }
  homedReport = { X: true, Y: true, Z: true }
  mem.clear()
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useMachineControl.setState({ consoleLines: [], parserModal: null, activeWcs: 'G54', offsets: {} })
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

describe('WO-1673 a probe that ends without contact prints one app row', () => {
  it('Probe work Z0 miss: one row naming the probe, no contact, both frames of the end position', async () => {
    await connectBridge()
    __reportWorkOffsetsForTest({ G54: { ...G54 } })
    const before = appRows().length
    probeReplies = [(seq) => ({ t: 'reply', seq, ok: true, v: { ok: false, at: null } }) as BridgeMessage]

    const result = await settle(runZProbeCycle('workZero', PROBE_CONFIG))

    expect(result.ok).toBe(false)
    expect(result.probedMachineZ).toBeNull()
    // The search ran 30 mm down from machine Z 78.9 and came to rest at 48.9;
    // on Operator's G54 (machine = work + 66.57) that is work Z -17.67.
    expect(position).toEqual({ x: 100, y: 100, z: 48.9 })
    const miss = appRows().slice(before).filter((text) => /no contact/i.test(text))
    expect(miss).toHaveLength(1)
    expect(miss[0]).toContain('Probe work Z0')
    expect(miss[0]).toContain('G54 Z -17.67')
    expect(miss[0]).toContain('(machine Z 48.90 mm)')
  })

  it('Measure tool miss: the row names the measure, not a bare axis', async () => {
    await connectBridge()
    __reportWorkOffsetsForTest({ G54: { ...G54 } })
    const before = appRows().length
    probeReplies = [(seq) => ({ t: 'reply', seq, ok: true, v: { ok: false, at: null } }) as BridgeMessage]

    const result = await settle(runZProbeCycle('measureTool', PROBE_CONFIG))

    expect(result.ok).toBe(false)
    const miss = appRows().slice(before).filter((text) => /no contact/i.test(text))
    expect(miss).toHaveLength(1)
    expect(miss[0]).toContain('Measure tool')
  })

  it('a directional touch miss names the axis and direction, and still prints exactly one row', async () => {
    await connectBridge()
    __reportWorkOffsetsForTest({ G54: { ...G54 } })
    const before = appRows().length
    probeReplies = [(seq) => ({ t: 'reply', seq, ok: true, v: { ok: false, at: null } }) as BridgeMessage]

    const result = await settle(runDirectionalProbeTouch('X', '+', PROBE_CONFIG))

    expect(result.ok).toBe(false)
    const miss = appRows().slice(before).filter((text) => /no contact/i.test(text))
    expect(miss).toHaveLength(1)
    expect(miss[0]).toContain('Probe X+')
    expect(miss[0]).toContain('(machine X')
  })

  it('a refused probe call is not a miss and prints no miss row', async () => {
    await connectBridge()
    __reportWorkOffsetsForTest({ G54: { ...G54 } })
    const before = appRows().length
    probeReplies = [
      (seq) => ({ t: 'reply', seq, ok: false, error: 'the controller refused to probe: UC100_MOVING' }) as BridgeMessage,
    ]

    const result = await settle(runZProbeCycle('measureTool', PROBE_CONFIG))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('UC100_MOVING')
    expect(appRows().slice(before).filter((text) => /no contact/i.test(text))).toHaveLength(0)
  })
})
