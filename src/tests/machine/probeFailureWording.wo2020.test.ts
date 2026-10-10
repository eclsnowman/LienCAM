// @vitest-environment jsdom
//
// WO-2020 - A PROBE THAT TOUCHED NEVER READS "DID NOT RUN".
//
// Tier 2: the real UccncController and machine session run over a fake bridge.
// The bridge rejects the probe call with Machine.cs's own after-contact
// sentences, exactly as Bridge.cs sends them. The application must preserve
// those sentences without turning a completed touch into a refused start.

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
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

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
const G54 = { x: 0, y: 0, z: 0 }
const PROBE_CONFIG = {
  positioningFeed: 1000,
  fastFeed: 300,
  slowFeed: 50,
  retract: 2,
  maxTravel: 30,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
}

let bridgeEvents: BridgeTransportEvents | null = null
let position: MachineVec3 = { x: 100, y: 100, z: 100 }
let probeFailure = ''

function statusFrame(): BridgeMessage {
  const status: MachineStatus = {
    state: 'idle',
    subState: null,
    machinePos: { ...position },
    workPos: { ...position },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: { X: true, Y: true, Z: true },
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
            bridge: 'wo-2020-fake 0.0',
            capabilities: CAPABILITIES,
            readOnly: false,
            workOffsets: { current: offsets, profile: offsets },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        const answer = (value?: unknown) => bridgeEvents?.onMessage({
          t: 'reply', seq: message.seq, ok: true, v: value,
        } as BridgeMessage)
        if (message.m === 'probe') {
          bridgeEvents?.onMessage({
            t: 'reply', seq: message.seq, ok: false, error: probeFailure,
          } as BridgeMessage)
          bridgeEvents?.onMessage(statusFrame())
          return
        }
        if (message.m === 'queryStatus') {
          answer()
          bridgeEvents?.onMessage(statusFrame())
          return
        }
        answer(true)
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
  connectMachine,
  disconnectMachine,
  getMachineController,
  runDirectionalProbeTouch,
} = await import('../../lib/machine/machineSession')

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  bridgeEvents?.onMessage(statusFrame())
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false
  void promise.finally(() => { done = true })
  for (let i = 0; i < 20_000 && !done; i++) await vi.advanceTimersByTimeAsync(50)
  return promise
}

beforeEach(() => {
  vi.useFakeTimers()
  mem.clear()
  position = { x: 100, y: 100, z: 100 }
  probeFailure = ''
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useMachineControl.setState({ consoleLines: [], parserModal: null })
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

const AFTER_CONTACT_FAILURES = [
  'the probe touched at machine Z 41.240, then was stopped from LienCAM before the controller finished its probe cycle; no retract was sent - jog up before the next move.',
  'the probe touched at machine Z 41.240, but the controller went into alarm (E-STOP or a limit) before its probe cycle ended, so no retract was sent. Clear the alarm, then jog up.',
  'the probe touched at machine Z 41.240, but the machine is in feed hold and the controller has not finished its probe cycle, so no retract was sent. Press Stop/Reset, then jog up.',
  'the probe touched at machine Z 41.240, but the controller did not finish its probe cycle within 5 s, so no retract was sent. Press Stop/Reset, then jog up.',
]

describe('WO-2020: probe failure wording preserves what actually happened', () => {
  it.each(AFTER_CONTACT_FAILURES)('quotes the bridge after contact: %s', async (sentence) => {
    await connectBridge()
    probeFailure = sentence

    const result = await settle(runDirectionalProbeTouch('Z', '-', PROBE_CONFIG))

    expect(result).toEqual({ ok: false, message: sentence, probedMachinePosition: null })
  })

  it('still names a probe the controller truly refused to start', async () => {
    await connectBridge()
    probeFailure = 'the controller refused to probe: UC100_MOVING'

    const result = await settle(runDirectionalProbeTouch('Z', '-', PROBE_CONFIG))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('The probe did not run: the controller refused probe Z')
    expect(result.message).toContain('the controller refused to probe: UC100_MOVING')
  })
})
