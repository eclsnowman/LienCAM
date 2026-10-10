// @vitest-environment jsdom
//
// WO-1658: ONE CLEAR press is ONE resetToIdle on the wire and ONE console row.
//
// The board finding, 2026-09-17 (docs/machine/NEXT-HARDWARE-SESSION.md, phase
// 2.2): with the machine's physical E-STOP held, one CLEAR press sent THREE
// `resetToIdle` calls (seq 1409 / 1412 / 1415 inside 1.4 s) and printed "The
// E-STOP button on the machine is still pressed" three times.
//
// This drives the REAL UccncController over a fake bridge transport that
// behaves like the recorded bridge: status frames carry `inputs.estop: true`
// (the board's own frame from the 2026-09-14 session), every queryStatus is
// answered by a status frame a few milliseconds later, and resetToIdle is
// refused ~110 ms after it is sent, exactly as the 2026-09-17 replies were.
// The product's own E-STOP control, mounted in the product's own Control page,
// is clicked once.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport as BridgeTransportType,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransportType {
  sent: BridgeCallMessage[]
  /** What the board reports on every status frame. */
  frame: MachineStatus
  /** Verdict the controller's resetToIdle() call gets back. */
  resetResult: { ok: boolean; reason: string | null }
  emitStatus(v: MachineStatus): void
  emitHeldAlarm(): void
  /** Board variant: the input reads released for a moment inside a refused
   *  reset, then held again, and the bridge re-sends its alarm. */
  flapOnReset: boolean
}

const bridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

// The recorded hello's own capabilities (the AXBB-E bridge).
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

const HELD_REFUSAL = { ok: false, reason: 'the controller did not settle to idle after a reset' }

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    frame = null as unknown as MachineStatus
    resetResult: { ok: boolean; reason: string | null } = HELD_REFUSAL
    flapOnReset = false
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
          bridge: 'WO-1658 fake bridge (physical E-STOP held)',
          capabilities: CAPABILITIES,
          readOnly: false,
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'resetToIdle') {
        // The recorded bridge answered a held-E-STOP reset ~110 ms later.
        const verdict = this.resetResult
        if (this.flapOnReset && !verdict.ok) {
          const held = this.frame
          setTimeout(() => this.emitStatus({ ...held, state: 'idle', inputs: { ...held.inputs!, estop: false } }), 20)
          setTimeout(() => { this.emitStatus(held); this.emitHeldAlarm() }, 60)
        }
        setTimeout(() => this.emit({ t: 'reply', seq: message.seq, ok: true, v: verdict }), 110)
        return
      }
      if (message.m === 'queryStatus' && this.frame) {
        const frame = this.frame
        setTimeout(() => this.emitStatus(frame), 5)
      }
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: true })
    }

    emitStatus(v: MachineStatus): void {
      this.emit({ t: 'status', v })
    }

    /** The bridge's own alarm frame for the physical button, as recorded 2026-09-17 00:11:44.517Z. */
    emitHeldAlarm(): void {
      this.emit({
        t: 'alarm',
        v: { code: null, message: 'Emergency stop is active. Release it, then re-home before moving.', positionLost: true },
      } as unknown as BridgeMessage)
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
const session = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useCamStore } = await import('../../store')
const { ControlPage } = await import('../../components/machine/ControlPage')

const EVIDENCE = join(
  process.cwd(),
  'src', 'tests', 'evidence', 'SESSION-2026-09-14', 'machine-2026-09-14',
  'session-estopfix.ws-frames.ndjson',
)

/** The board's own frame while the physical E-STOP was held: alarm, `estop: true`. */
function heldEstopFrame(): MachineStatus {
  for (const line of readFileSync(EVIDENCE, 'utf8').split('\n')) {
    if (!line) continue
    const outer = JSON.parse(line) as { dir?: string; payload?: string }
    if (outer.dir !== 'rx' || !outer.payload) continue
    const payload = JSON.parse(outer.payload) as { t?: string; v?: MachineStatus }
    if (payload.t === 'status' && payload.v?.inputs?.estop === true) return payload.v
  }
  throw new Error('the recorded session carries no E-STOP status frame')
}

/** The same frame after the operator let the button out: idle, `estop: false`. */
function releasedIdleFrame(held: MachineStatus): MachineStatus {
  return { ...held, state: 'idle', inputs: { ...held.inputs!, estop: false } }
}

function resetFrames(transport: FakeBridgeTransport): BridgeCallMessage[] {
  return transport.sent.filter((m) => m.m === 'resetToIdle')
}

function errorRows(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.severity === 'error')
    .map((line) => line.text)
}

async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function connectBridge(): Promise<FakeBridgeTransport> {
  await act(async () => { await session.connectMachine('bridge') })
  const transport = bridge.last
  if (!transport) throw new Error('the fake bridge was not installed')
  return transport
}

beforeEach(() => {
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  vi.useFakeTimers()
  bridge.last = null
  useUiPrefs.setState({ machineGotoSkipConfirm: true })
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [], wpos: null, mpos: null })
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(200)
    await pending
  })
  vi.useRealTimers()
})

describe('WO-1658 one CLEAR press sends one reset', () => {
  it('with the physical E-STOP held, one click is one resetToIdle frame and one refusal row', async () => {
    const held = heldEstopFrame()
    const transport = await connectBridge()
    transport.frame = held
    act(() => { transport.emitStatus(held); transport.emitHeldAlarm() })
    expect(session.estopNeedsReset()).toBe(true)
    await settle(1000)

    render(<ControlTransportBar sections="row" />)
    const control = screen.getByTestId('control-estop')
    expect(control.getAttribute('data-estop-mode')).toBe('clear')
    const rowsBefore = errorRows().length

    fireEvent.click(control)
    // Longer than the 1.4 s the board took to send its three.
    await settle(4000)

    expect(resetFrames(transport)).toHaveLength(1)
    const rows = errorRows().slice(rowsBefore)
    expect(rows).toEqual([session.ESTOP_RESET_REFUSAL.buttonStillPressed])
    expect(session.estopNeedsReset()).toBe(true)
  })

  it('with the input flapping inside the refused reset, one click is still one resetToIdle frame', async () => {
    const held = heldEstopFrame()
    const transport = await connectBridge()
    transport.frame = held
    transport.flapOnReset = true
    act(() => { transport.emitStatus(held); transport.emitHeldAlarm() })
    await settle(1000)

    render(<ControlTransportBar sections="row" />)
    const rowsBefore = errorRows().length
    fireEvent.click(screen.getByTestId('control-estop'))
    await settle(4000)

    expect(resetFrames(transport)).toHaveLength(1)
    expect(errorRows().slice(rowsBefore).filter((row) => !row.startsWith('Alarm')))
      .toEqual([session.ESTOP_RESET_REFUSAL.buttonStillPressed])
    expect(session.estopNeedsReset()).toBe(true)
  })

  it('hosted in the Control page, one click is one resetToIdle frame and one refusal row', async () => {
    useCamStore.setState({ workspace: 'control' })
    const held = heldEstopFrame()
    const transport = await connectBridge()
    transport.frame = held
    act(() => { transport.emitStatus(held); transport.emitHeldAlarm() })
    await settle(1000)

    render(<ControlPage />)
    const controls = screen.getAllByTestId('control-estop')
    expect(controls).toHaveLength(1)
    const rowsBefore = errorRows().length

    fireEvent.click(controls[0])
    await settle(4000)

    expect(resetFrames(transport)).toHaveLength(1)
    expect(errorRows().slice(rowsBefore)).toEqual([session.ESTOP_RESET_REFUSAL.buttonStillPressed])
  })

  it('after the button is released, one click is one resetToIdle frame and the machine is idle', async () => {
    const held = heldEstopFrame()
    const transport = await connectBridge()
    transport.frame = held
    act(() => { transport.emitStatus(held); transport.emitHeldAlarm() })
    await settle(1000)

    render(<ControlTransportBar sections="row" />)
    fireEvent.click(screen.getByTestId('control-estop'))
    await settle(4000)
    expect(resetFrames(transport)).toHaveLength(1)

    // Operator lets the button out; the board says idle, and a reset now succeeds.
    const released = releasedIdleFrame(held)
    transport.frame = released
    transport.resetResult = { ok: true, reason: null }
    act(() => { transport.emitStatus(released) })
    await settle(1000)
    const rowsBefore = errorRows().length

    fireEvent.click(screen.getByTestId('control-estop'))
    await settle(4000)

    expect(resetFrames(transport)).toHaveLength(2)
    expect(errorRows().slice(rowsBefore)).toEqual([])
    expect(session.estopNeedsReset()).toBe(false)
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-mode')).not.toBe('clear')
  })
})
