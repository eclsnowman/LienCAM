// @vitest-environment jsdom
//
// WO-1554: a FIRST connect must not say "Machine datum remains revoked after
// reconnect".
//
// The defect, seen on the board 2026-09-14 (session.capture.log line 17): the
// very first connect of an app session printed
// "Machine datum remains revoked after reconnect - home again in LienCAM
// before moving." There was no earlier connection in that session to reconnect
// to. `machineDatumRevokedAxes` is persisted, so a datum revoked by an E-STOP
// in a PREVIOUS session is restored on load and was read as a same-session
// reconnect.
//
// This file drives the REAL UccncController over a fake bridge transport fed
// the recorded first-connect frames from that session
// (`src/tests/evidence/SESSION-2026-09-14/machine-2026-09-14/session.ws-frames.ndjson`).
// The first connect stays silent; once a datum is revoked in this session,
// disconnect/reconnect prints the line.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport as BridgeTransportType,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransportType {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const fakeBridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

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
  // The recorded spindle block carries a VFD definition whose connect-time
  // apply is unrelated to this order's datum wording; drop it so the fake
  // answers only the frames this defect is about.
  const helloV = { ...recordedHello.v } as Record<string, unknown>
  delete helloV.vfd

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      fakeBridge.last = this
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({ t: 'hello', v: helloV } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const session = await import('../../lib/machine/machineSession')

const REVOKED_LINE = 'Machine datum remains revoked after reconnect'

function revokedLines(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.text.includes(REVOKED_LINE))
    .map((line) => line.text)
}

/** The board's own first-connect status frame, read from the recorded session. */
function recordedFirstStatus(): MachineStatus {
  const framesPath = join(
    process.cwd(),
    'src', 'tests', 'evidence', 'SESSION-2026-09-14', 'machine-2026-09-14',
    'session.ws-frames.ndjson',
  )
  for (const line of readFileSync(framesPath, 'utf8').split('\n')) {
    if (!line) continue
    const outer = JSON.parse(line) as { dir?: string; payload?: string }
    if (outer.dir !== 'rx' || !outer.payload) continue
    const payload = JSON.parse(outer.payload) as { t?: string; v?: MachineStatus }
    if (payload.t === 'status' && payload.v) return payload.v
  }
  throw new Error('the recorded session carries no status frame')
}

beforeEach(async () => {
  vi.useFakeTimers()
  session.__resetBridgeConnectedThisSessionForTest()
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
  useUiPrefs.setState({ machineGotoSkipConfirm: true })
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
  session.__resetEstopInterlockForTest()
})

afterEach(async () => {
  await act(async () => { await session.disconnectMachine() })
  vi.useRealTimers()
})

describe('WO-1554 first connect does not claim a reconnected datum', () => {
  it('stays silent on a first connect with a persisted revocation, then prints on a real reconnect', async () => {
    const machineId = useCamStore.getState().project.machine!.id
    // The persisted store from an earlier app session: the datum was revoked
    // by an E-STOP before this page ever connected.
    useCamStore.setState({ machineDatumRevokedAxes: { [machineId]: ['X', 'Y', 'Z'] } })

    await act(async () => { await session.connectMachine('bridge') })
    expect(fakeBridge.last).not.toBeNull()

    // First connect: no earlier connection to "re"connect to.
    expect(revokedLines()).toHaveLength(0)

    act(() => { fakeBridge.last!.emit({ t: 'status', v: recordedFirstStatus() }) })
    expect(revokedLines()).toHaveLength(0)

    // Home the machine, then lose the datum to a position-lost alarm.
    act(() => {
      fakeBridge.last!.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } })
      fakeBridge.last!.emit({
        t: 'status',
        v: { ...recordedFirstStatus(), homed: { X: true, Y: true, Z: true } },
      })
    })
    act(() => {
      fakeBridge.last!.emit({
        t: 'alarm',
        v: { code: 1, message: 'Hard limit', positionLost: true },
      })
    })
    expect(useCamStore.getState().machineDatumRevokedAxes[machineId]).toEqual(['X', 'Y', 'Z'])

    // Now a disconnect/reconnect is a real reconnect in the same session.
    await act(async () => { await session.disconnectMachine() })
    await act(async () => { await session.connectMachine('bridge') })

    expect(revokedLines()).toHaveLength(1)
  })
})