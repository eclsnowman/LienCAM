// @vitest-environment jsdom
//
// WO-1556: a connect must not FAIL to clear a stale skew.
//
// The defect, seen on the board 2026-09-14 (session.ws-frames.ndjson seq 10):
// every connect sent `applySkew {offsetMm: null}`, so a machine that had never
// carried a measurement printed
// "[bridge] gantry skew cleared - homing runs exactly as it did before any
// measurement was stored." on every connect. There was nothing to clear -
// that wording is now the bridge's job (`skewClearReportedOnlyWhenHeld.wo1556`
// pins it), not something `src/` should try to predict by skipping the call.
//
// A first fix tried to skip the connect-time clear when this app session's
// OWN memory of the endpoint already agreed nothing was held, and the
// architect HELD it: a bridge process outlives an app-window reload, so a
// fresh app session's memory starting empty says nothing about what the
// bridge is actually holding. That version could reconnect after a reload,
// see "nothing held" in its own (empty) memory, skip the clear, and leave a
// real stale 0.12 mm on the bridge for the next Home All to apply unsquared.
//
// So the fix here is: EVERY CONNECT SENDS, UNCONDITIONALLY - the definition's
// measurement, or a clear when there is none. The endpoint memory this file
// also exercises is used only to dedupe a LIVE EDIT against a state this
// session already confirmed; it never gates a connect.
//
// This file drives the REAL `UccncController` through a fake bridge transport
// fed the recorded first-connect hello from that session
// (`src/tests/evidence/SESSION-2026-09-14/machine-2026-09-14/session.ws-frames.ndjson`).
// The fake answers `applySkew` with the bridge's own readback, because the
// bridge reports what it holds ONLY there.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport as BridgeTransportType,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransportType {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  applySkewCalls(): BridgeCallMessage[]
}

const fakeBridge = vi.hoisted(() => ({
  last: null as FakeBridgeTransport | null,
  all: [] as FakeBridgeTransport[],
}))

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const framesPath = join(
    process.cwd(),
    'src', 'tests', 'evidence', 'SESSION-2026-09-14', 'machine-2026-09-14',
    'session.ws-frames.ndjson',
  )
  const frames = readFileSync(framesPath, 'utf8').split('\n').filter(Boolean).map((line) => {
    const outer = JSON.parse(line) as { dir?: string; payload?: string }
    return { dir: outer.dir, message: outer.payload ? JSON.parse(outer.payload) as BridgeMessage : null }
  })
  const recordedHello = frames.find((f) => f.message?.t === 'hello')!.message as Extract<
    BridgeMessage, { t: 'hello' }
  >
  // The recorded hello's spindle block is unrelated to the skew connect sync
  // and would itself write the machine record at connect; drop it so the fake
  // answers only the frames this order is about.
  const helloV = { ...recordedHello.v } as Record<string, unknown>
  delete helloV.vfd

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      fakeBridge.last = this
      fakeBridge.all.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({ t: 'hello', v: helloV } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m !== 'applySkew') return
      // The real bridge builds this from the value it now HOLDS, not from the
      // frame that arrived. A null offset is a clear; a number is an apply.
      const offsetMm = (message.a as { offsetMm: number | null }).offsetMm
      queueMicrotask(() => {
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { set: offsetMm !== null, offsetMm },
        })
      })
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }

    applySkewCalls(): BridgeCallMessage[] {
      return this.sent.filter((call) => call.m === 'applySkew')
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const session = await import('../../lib/machine/machineSession')

/** The one frame this defect is about, across every transport this session
 *  opened (a reconnect builds a new one with its own `sent`). */
function applySkewCalls(): BridgeCallMessage[] {
  return fakeBridge.all.flatMap((transport) => transport.applySkewCalls())
}

function offsetsSent(): Array<number | null> {
  return applySkewCalls().map((call) => (call.a as { offsetMm: number | null }).offsetMm)
}

beforeEach(async () => {
  vi.useFakeTimers()
  fakeBridge.all = []
  fakeBridge.last = null
  session.__resetBridgeConnectedThisSessionForTest()
  session.__resetSkewSyncForTest()
  useCamStore.getState().newProject()
  useCamStore.setState({ machineDatumRevokedAxes: {} })
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({
    ...machine,
    controller: 'uccnc',
    rapidRate: 5000,
    noHomingSwitches: false,
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'max', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
  })
  useCamStore.getState().updateMachineInLibrary(machine.id, {
    controller: 'uccnc',
    rapidRate: 5000,
    noHomingSwitches: false,
  })
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
  session.__resetEstopInterlockForTest()
})

afterEach(async () => {
  await act(async () => { await session.disconnectMachine() })
  vi.useRealTimers()
})

describe('WO-1556 a connect always hands the bridge the definition\'s skew', () => {
  it('sends a clear on a machine with no skew - even the very first connect', async () => {
    await act(async () => { await session.connectMachine('bridge') })
    expect(fakeBridge.last).not.toBeNull()

    expect(offsetsSent()).toEqual([null])
  })

  it('sends the stored measurement exactly once', async () => {
    const machineId = useCamStore.getState().project.machine!.id
    useCamStore.getState().updateMachineInLibrary(machineId, { skew: { offsetMm: 0.12 } })

    await act(async () => { await session.connectMachine('bridge') })

    expect(offsetsSent()).toEqual([0.12])
  })

  it('clears a skew once when it is removed while connected, and clears again on reconnect', async () => {
    const machineId = useCamStore.getState().project.machine!.id
    useCamStore.getState().updateMachineInLibrary(machineId, { skew: { offsetMm: 0.12 } })

    await act(async () => { await session.connectMachine('bridge') })
    expect(offsetsSent()).toEqual([0.12])

    // Removing the measurement in the definition editor while connected. The
    // editor writes the library carrier; the live session must reach the same
    // bridge with a clear, and only one.
    await act(async () => {
      useCamStore.getState().updateMachineInLibrary(machineId, { skew: undefined })
    })

    expect(offsetsSent()).toEqual([0.12, null])

    // A reconnect always sends again - this app session's memory of "nothing
    // held" is not proof the bridge process agrees, so the clear is repeated
    // rather than skipped.
    await act(async () => { await session.disconnectMachine() })
    await act(async () => { await session.connectMachine('bridge') })

    expect(offsetsSent()).toEqual([0.12, null, null])
  })

  it('resends a stored skew on reconnect after the bridge lost it', async () => {
    // The bridge holds the offset in memory only, so a dropped link or a
    // bridge restart loses it; the reconnect has to hand it over again.
    const machineId = useCamStore.getState().project.machine!.id
    useCamStore.getState().updateMachineInLibrary(machineId, { skew: { offsetMm: 0.12 } })

    await act(async () => { await session.connectMachine('bridge') })
    expect(offsetsSent()).toEqual([0.12])

    await act(async () => { await session.disconnectMachine() })
    await act(async () => { await session.connectMachine('bridge') })

    expect(offsetsSent()).toEqual([0.12, 0.12])
  })

  it('clears on connect even when this app session never confirmed anything held - the HELD scenario', async () => {
    // This is the exact failure the architect held: a bridge process outlives
    // an app-window reload, but the endpoint memory is module state and does
    // NOT survive one (simulated here with __resetSkewSyncForTest). A fresh
    // session that starts knowing nothing about the endpoint must still send
    // the clear - its own empty memory is not proof the bridge agrees.
    const machineId = useCamStore.getState().project.machine!.id
    useCamStore.getState().updateMachineInLibrary(machineId, { skew: { offsetMm: 0.12 } })
    await act(async () => { await session.connectMachine('bridge') })
    expect(offsetsSent()).toEqual([0.12])
    await act(async () => { await session.disconnectMachine() })

    session.__resetSkewSyncForTest()
    useCamStore.getState().updateMachineInLibrary(machineId, { skew: undefined })

    await act(async () => { await session.connectMachine('bridge') })

    expect(offsetsSent()).toEqual([0.12, null])
  })

  it('does not repeat a live edit that changes nothing the bridge does not already hold', async () => {
    const machineId = useCamStore.getState().project.machine!.id
    useCamStore.getState().updateMachineInLibrary(machineId, { skew: { offsetMm: 0.12 } })

    await act(async () => { await session.connectMachine('bridge') })
    expect(offsetsSent()).toEqual([0.12])

    // Writing the same value back through the library carrier is not a new
    // number - the endpoint memory already confirmed it, so the live-edit
    // watcher must not push a redundant frame.
    await act(async () => {
      useCamStore.getState().updateMachineInLibrary(machineId, { skew: { offsetMm: 0.12 } })
    })

    expect(offsetsSent()).toEqual([0.12])
  })
})
