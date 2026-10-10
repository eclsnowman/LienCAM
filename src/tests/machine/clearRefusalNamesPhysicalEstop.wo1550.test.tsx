// @vitest-environment jsdom
//
// WO-1550: a CLEAR refused while the physical E-STOP is held must SAY the
// button is still pressed.
//
// The defect, seen on the board 2026-09-14: with the physical E-STOP held,
// pressing CLEAR was correctly refused, but the console read a run-on -
// "The controller did not confirm it returned to a safe idle, so the E-STOP
// stays set. the controller did not settle to idle after a reset" - and never
// named the one fact the operator could act on, even though the board's own
// status frames carry `inputs.estop: true`.
//
// This file drives the REAL UccncController over a fake bridge transport, fed
// the recorded status frames from that session
// (`src/tests/evidence/SESSION-2026-09-14/machine-2026-09-14/session-estopfix.ws-frames.ndjson`),
// and clicks the product's own E-STOP control. The refusal must go where
// Operator ruled it always goes - the console - and must name the physical button.

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
  /** Frame emitted in answer to the next queryStatus(). */
  nextStatus: MachineStatus | null
  /** Verdict the controller's resetToIdle() call gets back. */
  resetResult: { ok: boolean; reason: string | null }
  emitStatus(v: MachineStatus): void
}

const bridge = vi.hoisted(() => ({
  last: null as FakeBridgeTransport | null,
  readOnly: false,
}))

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

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    nextStatus: MachineStatus | null = null
    resetResult: { ok: boolean; reason: string | null } = {
      ok: false,
      reason: 'the controller did not settle to idle after a reset',
    }
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
          bridge: 'WO-1550 fake bridge (recorded E-STOP frames)',
          capabilities: CAPABILITIES,
          readOnly: bridge.readOnly,
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'queryStatus' && this.nextStatus) this.emitStatus(this.nextStatus)
      this.emit({
        t: 'reply',
        seq: message.seq,
        ok: true,
        v: message.m === 'resetToIdle' ? this.resetResult : true,
      })
    }

    emitStatus(v: MachineStatus): void {
      this.emit({ t: 'status', v })
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
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

const EVIDENCE = join(
  process.cwd(),
  'src', 'tests', 'evidence', 'SESSION-2026-09-14', 'machine-2026-09-14',
  'session-estopfix.ws-frames.ndjson',
)

function recordedStatusFrames(): MachineStatus[] {
  const frames: MachineStatus[] = []
  for (const line of readFileSync(EVIDENCE, 'utf8').split('\n')) {
    if (!line) continue
    const outer = JSON.parse(line) as { dir?: string; payload?: string }
    if (outer.dir !== 'rx' || !outer.payload) continue
    const payload = JSON.parse(outer.payload) as { t?: string; v?: MachineStatus }
    if (payload.t !== 'status' || !payload.v) continue
    frames.push(payload.v)
  }
  return frames
}

/** The board's own frame while the physical E-STOP was held: alarm, `estop: true`. */
function incidentEstopFrame(frames: MachineStatus[]): MachineStatus {
  const frame = frames.find((f) => f.inputs?.estop === true)
  if (!frame) throw new Error('the recorded session carries no E-STOP status frame')
  return frame
}

/** The same recorded frame with the input released - a control for the case
 *  where the button is NOT held but the release still failed. */
function releasedAlarmFrame(frames: MachineStatus[]): MachineStatus {
  const frame = incidentEstopFrame(frames)
  return { ...frame, inputs: { ...frame.inputs!, estop: false } }
}

function consoleErrors(): string[] {
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
  bridge.readOnly = false
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

describe('WO-1550 a refused CLEAR names the physical E-STOP button', () => {
  it('with the board reporting inputs.estop true, the console row says the button is still pressed', async () => {
    const incident = incidentEstopFrame(recordedStatusFrames())
    const transport = await connectBridge()
    transport.nextStatus = incident

    // The board's own recorded E-STOP frame: the latch arms and the control
    // becomes a CLEAR after the settling delay.
    act(() => { transport.emitStatus(incident) })
    expect(session.estopNeedsReset()).toBe(true)
    await settle(700)

    render(<ControlTransportBar sections="row" />)
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-mode')).toBe('clear')

    fireEvent.click(screen.getByTestId('control-estop'))
    await settle(700)

    const refusals = consoleErrors()
    expect(refusals).toContain(session.ESTOP_RESET_REFUSAL.buttonStillPressed)
    // The old run-on must be gone for this case: the physical button is the
    // named cause, not a generic settling failure.
    expect(refusals.some((r) => r.includes(session.ESTOP_RESET_REFUSAL.notReleased))).toBe(false)
    // The latch stays set - only the sentence changed, never the safety gate.
    expect(session.estopNeedsReset()).toBe(true)
  })

  it('with inputs.estop false and the release still failing, no sentence starts lower-case', async () => {
    const released = releasedAlarmFrame(recordedStatusFrames())
    const transport = await connectBridge()
    transport.nextStatus = released

    render(<ControlTransportBar sections="row" />)
    expect(screen.getByTestId('control-estop').getAttribute('data-estop-mode')).toBe('clear')

    fireEvent.click(screen.getByTestId('control-estop'))
    await settle(700)

    const refusals = consoleErrors()
    const row = refusals.find((r) => r.includes(session.ESTOP_RESET_REFUSAL.notReleased))
    expect(row).toBeDefined()
    // The controller's own sentence is appended as its OWN capitalised
    // sentence - never "...stays set. the controller did not settle...".
    expect(row).toContain('The controller did not settle to idle after a reset.')
    expect(row).not.toMatch(/\.\s+[a-z]/)
  })
})
