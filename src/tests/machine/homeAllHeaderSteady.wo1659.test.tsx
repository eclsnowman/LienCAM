// @vitest-environment jsdom
//
// WO-1659: The header reads Homing for the whole Home All, not Not homed | Idle between axes.
//
// The board finding, 2026-09-17 (docs/machine/NEXT-HARDWARE-SESSION.md, phase 2.3):
// During one Home All the header chips dropped to "Not homed | Idle" three times between axes
// (00:16:16.6, :25.8, :37.8Z) while the bridge was homing X then Y.
//
// Acceptance:
// 1. From the Home All press until the last axis reports homed, the header says the cycle is running;
//    the gap between one axis finishing and the next starting never reads as idle or as not homed.
// 2. A genuine stop mid-cycle (E-STOP, abort, fault) still shows immediately - this is not a delay filter.
// 3. Replay the recorded 2026-09-17 frame timeline through the real controller class:
//    the header never shows Idle or Not homed between axes; inject an abort frame in a gap and it shows at once.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport as BridgeTransportType,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'
import { UccncController } from '../../lib/machine/uccncController'

interface FakeBridgeTransport extends BridgeTransportType {
  sent: BridgeCallMessage[]
  lastSeq: number
  emitStatus(v: MachineStatus): void
  emitAlarm(code: number | null, message: string, positionLost?: boolean): void
  emitReply(seq: number, ok: boolean, v?: unknown, error?: string): void
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

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    lastSeq = 0
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
          bridge: 'WO-1659 fake bridge',
          capabilities: CAPABILITIES,
          readOnly: false,
        },
      })
    }

    frame: MachineStatus | null = null

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      this.lastSeq = message.seq
      if (message.m === 'resetToIdle') {
        this.emit({ t: 'reply', seq: message.seq, ok: true, v: { ok: true, reason: null } })
        return
      }
      if (message.m === 'queryStatus') {
        this.emit({ t: 'status', v: this.frame ?? baseStatus({ state: 'idle' }) })
        this.emit({ t: 'reply', seq: message.seq, ok: true, v: true })
        return
      }
      if (message.m === 'homeAxes' || message.m === 'home') {
        // Homing is a long call in flight, completed by test resolution
        return
      }
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: true })
    }

    emitStatus(v: MachineStatus): void {
      this.emit({ t: 'status', v })
    }

    emitAlarm(code: number | null, message: string, positionLost = true): void {
      this.emit({
        t: 'alarm',
        v: { code, message, positionLost },
      } as unknown as BridgeMessage)
    }

    emitReply(seq: number, ok: boolean, v: unknown = true, error?: string): void {
      this.emit({ t: 'reply', seq, ok, v, error } as BridgeMessage)
    }

    async close(): Promise<void> {
      this.fakeEvents = null
    }

    private emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
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
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { MachineStatusChip } = await import('../../components/toolbar/MachineStatusChip')
const session = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

function baseStatus(overrides: Partial<MachineStatus> = {}): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: 0,
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    executingMoveId: null,
    buffer: null,
    probeCycle: null,
    inputs: {
      estop: false,
      hardLimit: false,
      softLimit: false,
      probe: false,
      limits: null,
      door: null,
      hold: null,
    },
    homed: { X: false, Y: false, Z: false },
    spindle: null,
    ...overrides,
  }
}

async function connectBridge(): Promise<FakeBridgeTransport> {
  await act(async () => { await session.connectMachine('bridge') })
  const transport = bridge.last
  if (!transport) throw new Error('fake bridge transport was not created')
  await act(async () => {
    await session.resetEstop()
  })
  return transport
}

beforeEach(() => {
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  bridge.last = null
  useCamStore.setState({ machineDatumRevokedAxes: {} })
  useUiPrefs.setState({ machineGotoSkipConfirm: true })
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [], wpos: null, mpos: null })
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    const pending = session.disconnectMachine()
    await pending
  })
})

describe('WO-1659: Home All header steady state', () => {
  it('direct UccncController: gap frames between axes remain state=home and never drop to idle', async () => {
    let latestStatus: MachineStatus | null = null
    const ctrl = new UccncController({
      onStatus: (st) => { latestStatus = st },
    })

    const transport = {
      isSupported: () => true,
      sent: [] as BridgeCallMessage[],
      fakeEvents: null as BridgeTransportEvents | null,
      async start(events: BridgeTransportEvents) {
        this.fakeEvents = events
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'test',
            capabilities: CAPABILITIES,
            readOnly: false,
          },
        })
      },
      send(msg: BridgeCallMessage) { this.sent.push(msg) },
      async close() {},
    }

    await ctrl.connect({ kind: 'messages', transport: transport as unknown as BridgeTransportType })
    // Initial status before homing: idle, unhomed
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'idle', homed: { X: false, Y: false, Z: false } }),
    })
    expect(ctrl.status().state).toBe('idle')
    expect(ctrl.homedThisSession()).toBe(false)

    const getStatusState = () => (latestStatus as MachineStatus | null)?.state

    // Press Home All: homing sequence X, gap, Y, gap, Z
    const ok = ctrl.homeAxes(['X', 'Y', 'Z'])
    expect(ok).toBe(true)
    // Immediately upon call, state becomes 'home'
    expect(ctrl.status().state).toBe('home')
    expect(getStatusState()).toBe('home')

    // 1. X is homing
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'home', homed: { X: false, Y: false, Z: false } }),
    })
    expect(ctrl.status().state).toBe('home')

    // 2. GAP between X and Y: board reports state='idle', but only X is homed
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'idle', homed: { X: true, Y: false, Z: false } }),
    })
    // Must remain 'home', NOT 'idle'
    expect(ctrl.status().state).toBe('home')
    expect(getStatusState()).toBe('home')
    expect(ctrl.homedThisSession()).toBe(false)

    // 3. Y is homing
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'home', homed: { X: true, Y: false, Z: false } }),
    })
    expect(ctrl.status().state).toBe('home')

    // 4. GAP between Y and Z: board reports state='idle', X and Y homed, Z not yet
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'idle', homed: { X: true, Y: true, Z: false } }),
    })
    // Must remain 'home', NOT 'idle'
    expect(ctrl.status().state).toBe('home')
    expect(getStatusState()).toBe('home')
    expect(ctrl.homedThisSession()).toBe(false)

    // 5. Z is homing
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'home', homed: { X: true, Y: true, Z: false } }),
    })
    expect(ctrl.status().state).toBe('home')

    // 6. Last axis reports homed: board reports state='idle' and all axes homed
    // While the homing call is still in flight (settling), state remains 'home'
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'idle', homed: { X: true, Y: true, Z: true } }),
    })
    expect(ctrl.status().state).toBe('home')
    expect(getStatusState()).toBe('home')

    // 7. Bridge replies to homeAxes call
    transport.fakeEvents!.onMessage({
      t: 'reply',
      seq: transport.sent[0].seq,
      ok: true,
      v: true,
    })
    await Promise.resolve()
    // Now the cycle is complete, transitions directly to idle and homed
    expect(ctrl.status().state).toBe('idle')
    expect(getStatusState()).toBe('idle')
    expect(ctrl.homedThisSession()).toBe(true)
  })

  it('rendered header chips across the 2026-09-17 timeline: never show Not homed | Idle between axes', async () => {
    const transport = await connectBridge()
    transport.emitStatus(baseStatus({ state: 'idle', homed: { X: false, Y: false, Z: false } }))

    render(
      <div>
        <MachineStatusChip />
        <ControlTransportBar sections="row" />
      </div>,
    )

    const statusChip = () => screen.getByTestId('machine-status-chip').textContent?.trim()
    const stateChip = () => screen.getByTestId('control-state-chip').textContent?.trim()
    const headerReading = () => `${statusChip()} | ${stateChip()}`

    // Before Home All press: unhomed, idle
    expect(headerReading()).toBe('Not homed | Idle')

    const ctrl = session.getMachineController()
    expect(ctrl).not.toBeNull()

    // Press Home All (recorded order Z, X, Y)
    act(() => {
      ctrl.homeAxes?.(['Z', 'X', 'Y'])
    })

    // Immediately from press, header reads Running | Homing
    expect(headerReading()).toBe('Running | Homing')

    // Frame 1 (00:16:15.8): Z is homing
    act(() => {
      transport.emitStatus(baseStatus({ state: 'home', homed: { X: false, Y: false, Z: false } }))
    })
    expect(headerReading()).toBe('Running | Homing')

    // Frame 2 (00:16:16.6 - GAP 1 after Z): bridge sent state=idle, homed={Z: true}
    act(() => {
      transport.emitStatus(baseStatus({ state: 'idle', homed: { X: false, Y: false, Z: true } }))
    })
    // DEFECT WAS: dropped to "Not homed | Idle"
    // ACCEPTANCE: stays "Running | Homing"
    expect(headerReading()).toBe('Running | Homing')

    // Frame 3 (00:16:17.0): X is homing
    act(() => {
      transport.emitStatus(baseStatus({ state: 'home', homed: { X: false, Y: false, Z: true } }))
    })
    expect(headerReading()).toBe('Running | Homing')

    // Frame 4 (00:16:25.8 - GAP 2 after X): bridge sent state=idle, homed={Z: true, X: true}
    act(() => {
      transport.emitStatus(baseStatus({ state: 'idle', homed: { X: true, Y: false, Z: true } }))
    })
    // DEFECT WAS: dropped to "Not homed | Idle"
    // ACCEPTANCE: stays "Running | Homing"
    expect(headerReading()).toBe('Running | Homing')

    // Frame 5 (00:16:26.1): Y is homing
    act(() => {
      transport.emitStatus(baseStatus({ state: 'home', homed: { X: true, Y: false, Z: true } }))
    })
    expect(headerReading()).toBe('Running | Homing')

    // Frame 6 (00:16:37.8 - settling gap before reply): Y finished, all axes homed, bridge returns state=idle
    act(() => {
      transport.emitStatus(baseStatus({ state: 'idle', homed: { X: true, Y: true, Z: true } }))
    })
    // In the settling gap, header holds steady as Running | Homing
    expect(headerReading()).toBe('Running | Homing')

    // Frame 7 (00:16:38.1 - completion): bridge returns reply for homeAxes
    await act(async () => {
      transport.emitReply(transport.lastSeq, true)
    })
    // Transitions directly to Ready | Idle
    expect(headerReading()).toBe('Ready | Idle')
  })

  it('injecting an abort frame (alarm push) in a gap shows ALARM immediately', async () => {
    const transport = await connectBridge()
    transport.emitStatus(baseStatus({ state: 'idle', homed: { X: false, Y: false, Z: false } }))

    render(
      <div>
        <MachineStatusChip />
        <ControlTransportBar sections="row" />
      </div>,
    )

    const statusChip = () => screen.getByTestId('machine-status-chip').textContent?.trim()
    const stateChip = () => screen.getByTestId('control-state-chip').textContent?.trim()
    const headerReading = () => `${statusChip()} | ${stateChip()}`

    const ctrl = session.getMachineController()
    act(() => {
      ctrl.homeAxes?.(['X', 'Y', 'Z'])
    })
    expect(headerReading()).toBe('Running | Homing')

    // X homes
    act(() => {
      transport.emitStatus(baseStatus({ state: 'home', homed: { X: false, Y: false, Z: false } }))
    })
    expect(headerReading()).toBe('Running | Homing')

    // GAP 1: X finished, in gap before Y
    act(() => {
      transport.emitStatus(baseStatus({ state: 'idle', homed: { X: true, Y: false, Z: false } }))
    })
    expect(headerReading()).toBe('Running | Homing')

    // INJECT ABORT FRAME (t: 'alarm') in the gap
    act(() => {
      transport.emitAlarm(3, 'Emergency stop active during cycle', true)
    })

    // Shows ALARM immediately - not a delay filter
    expect(statusChip()).toBe('Alarm')
    expect(stateChip()).toBe('ALARM')

    // Subsequent status frame while stopped remains in alarm
    act(() => {
      transport.emitStatus(baseStatus({ state: 'alarm', homed: { X: true, Y: false, Z: false } }))
    })
    expect(statusChip()).toBe('Alarm')
    expect(stateChip()).toBe('ALARM')
  })

  it('injecting an abort frame (status state=alarm) in a gap shows ALARM immediately', async () => {
    const transport = await connectBridge()
    transport.emitStatus(baseStatus({ state: 'idle', homed: { X: false, Y: false, Z: false } }))

    render(
      <div>
        <MachineStatusChip />
        <ControlTransportBar sections="row" />
      </div>,
    )

    const statusChip = () => screen.getByTestId('machine-status-chip').textContent?.trim()
    const stateChip = () => screen.getByTestId('control-state-chip').textContent?.trim()

    const ctrl = session.getMachineController()
    act(() => {
      ctrl.homeAxes?.(['X', 'Y', 'Z'])
    })

    // GAP 1: X finished, state was idle in gap
    act(() => {
      transport.emitStatus(baseStatus({ state: 'idle', homed: { X: true, Y: false, Z: false } }))
    })
    expect(stateChip()).toBe('Homing')

    // INJECT ABORT STATUS (state='alarm') in the gap
    act(() => {
      transport.emitStatus(baseStatus({ state: 'alarm', homed: { X: true, Y: false, Z: false } }))
    })

    expect(statusChip()).toBe('Alarm')
    expect(stateChip()).toBe('ALARM')
  })

  it('injecting a physical E-STOP frame in a gap shows E-STOP immediately', async () => {
    const transport = await connectBridge()
    transport.emitStatus(baseStatus({ state: 'idle', homed: { X: false, Y: false, Z: false } }))

    render(
      <div>
        <MachineStatusChip />
        <ControlTransportBar sections="row" />
      </div>,
    )

    const statusChip = () => screen.getByTestId('machine-status-chip').textContent?.trim()
    const stateChip = () => screen.getByTestId('control-state-chip').textContent?.trim()

    const ctrl = session.getMachineController()
    act(() => {
      ctrl.homeAxes?.(['X', 'Y', 'Z'])
    })

    // GAP 1: in gap
    act(() => {
      transport.emitStatus(baseStatus({ state: 'idle', homed: { X: true, Y: false, Z: false } }))
    })
    expect(stateChip()).toBe('Homing')

    // INJECT HARDWARE E-STOP in the gap (board reports state='alarm' and inputs.estop=true)
    act(() => {
      transport.emitStatus(baseStatus({
        state: 'alarm',
        inputs: {
          estop: true,
          hardLimit: false,
          softLimit: false,
          probe: false,
          limits: null,
          door: null,
          hold: null,
        },
        homed: { X: true, Y: false, Z: false },
      }))
    })

    // WO-3098 (1524d1213d): the header shares Control's latched E-STOP label.
    expect(statusChip()).toBe('E-STOP')
    expect(stateChip()).toBe('E-STOP')
  })

  it('single axis homing settles to idle when that axis completes without holding whole-machine homing', async () => {
    let latestStatus: MachineStatus | null = null
    const ctrl = new UccncController({
      onStatus: (st) => { latestStatus = st },
    })

    const transport = {
      isSupported: () => true,
      sent: [] as BridgeCallMessage[],
      fakeEvents: null as BridgeTransportEvents | null,
      async start(events: BridgeTransportEvents) {
        this.fakeEvents = events
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'test',
            capabilities: CAPABILITIES,
            readOnly: false,
          },
        })
      },
      send(msg: BridgeCallMessage) { this.sent.push(msg) },
      async close() {},
    }

    await ctrl.connect({ kind: 'messages', transport: transport as unknown as BridgeTransportType })
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'idle', homed: { X: false, Y: false, Z: false } }),
    })

    const getStatusState = () => (latestStatus as MachineStatus | null)?.state

    // Home Z alone
    ctrl.homeAxes(['Z'])
    expect(ctrl.status().state).toBe('home')

    // Z is homing
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'home', homed: { X: false, Y: false, Z: false } }),
    })
    expect(ctrl.status().state).toBe('home')

    // Z finishes moving: homed={Z: true}, state=idle
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'idle', homed: { X: false, Y: false, Z: true } }),
    })
    // Gap before reply stays 'home'
    expect(ctrl.status().state).toBe('home')

    // Bridge replies to homeAxes
    transport.fakeEvents!.onMessage({
      t: 'reply',
      seq: transport.sent[0].seq,
      ok: true,
      v: true,
    })
    await Promise.resolve()
    // Since only Z was requested, all requested axes are homed -> settles to idle!
    expect(ctrl.status().state).toBe('idle')
    expect(getStatusState()).toBe('idle')
    // Whole machine is not homed (X and Y remain unreferenced)
    expect(ctrl.homedThisSession()).toBe(false)
  })

  it('direct UccncController: re-homing an already-homed axis holds state=home across idle status frames until completed', async () => {
    let latestStatus: MachineStatus | null = null
    const ctrl = new UccncController({
      onStatus: (st) => { latestStatus = st },
    })

    const transport = {
      isSupported: () => true,
      sent: [] as BridgeCallMessage[],
      fakeEvents: null as BridgeTransportEvents | null,
      async start(events: BridgeTransportEvents) {
        this.fakeEvents = events
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'test',
            capabilities: CAPABILITIES,
            readOnly: false,
          },
        })
      },
      send(msg: BridgeCallMessage) { this.sent.push(msg) },
      async close() {},
    }

    await ctrl.connect({ kind: 'messages', transport: transport as unknown as BridgeTransportType })
    // Machine already homed: X, Y, Z homed=true, state=idle
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'idle', homed: { X: true, Y: true, Z: true } }),
    })
    expect(ctrl.status().state).toBe('idle')
    expect(ctrl.homedThisSession()).toBe(true)

    const getStatusState = () => (latestStatus as MachineStatus | null)?.state

    // Re-home Z alone
    ctrl.homeAxes(['Z'])
    expect(ctrl.status().state).toBe('home')
    expect(getStatusState()).toBe('home')

    // Routine poll landing before board motion / during gap: state='idle', homed still true for all axes
    // AUDIT REPRODUCTION: previously this frame cleared activeHoming because allRequestedHomed was true
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'idle', homed: { X: true, Y: true, Z: true } }),
    })
    // MUST remain 'home', NOT settle back to 'idle'
    expect(ctrl.status().state).toBe('home')
    expect(getStatusState()).toBe('home')

    // Active motion frame
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'home', homed: { X: true, Y: true, Z: true } }),
    })
    expect(ctrl.status().state).toBe('home')

    // Settling gap frame before reply
    transport.fakeEvents!.onMessage({
      t: 'status',
      v: baseStatus({ state: 'idle', homed: { X: true, Y: true, Z: true } }),
    })
    expect(ctrl.status().state).toBe('home')

    // Bridge replies to homeAxes
    transport.fakeEvents!.onMessage({
      t: 'reply',
      seq: transport.sent[0].seq,
      ok: true,
      v: true,
    })
    await Promise.resolve()
    // Only now does the cycle complete and settle to idle
    expect(ctrl.status().state).toBe('idle')
    expect(getStatusState()).toBe('idle')
    expect(ctrl.homedThisSession()).toBe(true)
  })

  it('rendered header chips: re-homing an already-homed axis never drops back to Ready | Idle early', async () => {
    const transport = await connectBridge()
    // Machine is already homed
    await act(async () => {
      transport.emitStatus(baseStatus({ state: 'idle', homed: { X: true, Y: true, Z: true } }))
    })

    render(
      <div>
        <MachineStatusChip />
        <ControlTransportBar sections="row" />
      </div>,
    )

    const statusChip = () => screen.getByTestId('machine-status-chip').textContent?.trim()
    const stateChip = () => screen.getByTestId('control-state-chip').textContent?.trim()
    const headerReading = () => `${statusChip()} | ${stateChip()}`

    // Before re-home press: already homed, idle
    expect(headerReading()).toBe('Ready | Idle')

    const ctrl = session.getMachineController()
    expect(ctrl).not.toBeNull()

    // Re-home Z
    act(() => {
      ctrl.homeAxes?.(['Z'])
    })
    expect(headerReading()).toBe('Running | Homing')

    // Frame 1: bridge poll frame carrying state=idle and homed={X:true, Y:true, Z:true}
    act(() => {
      transport.emitStatus(baseStatus({ state: 'idle', homed: { X: true, Y: true, Z: true } }))
    })
    // Must remain Running | Homing, NOT drop to Ready | Idle
    expect(headerReading()).toBe('Running | Homing')

    // Frame 2: moving
    act(() => {
      transport.emitStatus(baseStatus({ state: 'home', homed: { X: true, Y: true, Z: true } }))
    })
    expect(headerReading()).toBe('Running | Homing')

    // Frame 3: settling
    act(() => {
      transport.emitStatus(baseStatus({ state: 'idle', homed: { X: true, Y: true, Z: true } }))
    })
    expect(headerReading()).toBe('Running | Homing')

    // Completion reply
    await act(async () => {
      transport.emitReply(transport.lastSeq, true)
    })
    expect(headerReading()).toBe('Ready | Idle')
  })
})
