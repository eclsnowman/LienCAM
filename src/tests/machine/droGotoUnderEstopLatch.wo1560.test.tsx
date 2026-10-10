// @vitest-environment jsdom
//
// WO-1560: the TYPED DRO GOTO was never tested under the E-STOP latch.
//
// Operator's ruling, 2026-09-14: after an E-STOP, ALL motion is off until CLEAR.
// It passed on the board for jog, Home All and Goto XY0. The typed DRO goto -
// type a coordinate into a cell and commit it - is the path WO-1545's session
// left uncovered, so this order pins it.
//
// The operator path is the real one: the Control page rendered through the real
// store, driven by the real UccncController over a fake bridge transport, fed
// the board's own recorded E-STOP frames from the 2026-09-14 session
// (`session-estopfix.ws-frames.ndjson`). Nothing here reaches a controller
// method directly to make the motion; the commit is the DRO cell's own blur,
// exactly as an operator types-and-tabs.
//
// THE SHARP CASE, AND WHY THE RECORDED IDLE FRAME MATTERS. A stop frame reports
// `state: 'alarm'`, and ControlPage's own `evaluateGoto` refuses on that alone -
// so a test that stopped at the alarm frame would prove only that `machineState`
// is read. The latch is a SESSION state that outlives the alarm: the board can
// settle to idle (a recorded frame, `inputs.estop: false`) while the E-STOP is
// still physically held and the latch is still set - so the DRO cell becomes
// editable and the goto reaches the controller's motion boundary. There the
// wrapped `ctrl.jog` must refuse, and no motion frame may reach the transport.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

// The Control page mounts the 3D viewport. This order is about the DRO and the
// motion boundary, not the render of the model, so the viewport is stubbed the
// same way workZeroBeforeMove.wo1017 does.
vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  // CNCViewport has private members, so a jsdom stub cannot be structurally
  // assignable to its constructor type. The export key remains checked here.
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  } as never,
}))

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  /** Feed one frame exactly as the bridge's socket would deliver it. */
  status(v: MachineStatus): void
}

const bridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null, readOnly: false }))

// The recorded hello's own capabilities (the AXBB-E bridge): geometry queue,
// no G-code text path, per-axis homing.
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
  buffer: null,
  inputs: {
    estop: false,
    hardLimit: false,
    softLimit: false,
    probe: false,
    limits: null,
    door: null,
    hold: false,
  },
  homed: null,
  spindle: null,
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
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
        v: {
          protocol: 1,
          bridge: 'WO-1560 fake bridge (recorded E-STOP frames)',
          capabilities: CAPABILITIES,
          readOnly: bridge.readOnly,
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      // The board answers a status query with a fresh idle report, which is what
      // resetEstop()'s confirm reads. Everything else gets a plain ok; the
      // CLEAR's own release call gets the contract's receipt shape.
      if (message.m === 'queryStatus') this.status(IDLE)
      this.emit({
        t: 'reply',
        seq: message.seq,
        ok: true,
        v: message.m === 'resetToIdle' ? { ok: true, reason: null } : true,
      })
    }

    status(v: MachineStatus): void {
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

const { ControlPage } = await import('../../components/machine/ControlPage')
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

/** The frame the physical E-STOP produced on the board: alarm, `estop: true`. */
function incidentEstopFrame(frames: MachineStatus[]): MachineStatus {
  const frame = frames.find((f) => f.inputs?.estop === true)
  if (!frame) throw new Error('the recorded session carries no E-STOP status frame')
  return frame
}

/** The first frame AFTER the trip where the board reports a settled idle with a
 *  live machine/work position. The latch is still set; this is the state the
 *  DRO cell is editable in. */
function settledIdleFrame(frames: MachineStatus[]): MachineStatus {
  const start = frames.findIndex((f) => f.inputs?.estop === true)
  for (let i = start + 1; i < frames.length; i++) {
    const f = frames[i]
    if (f.state === 'idle' && f.machinePos && f.workPos && f.inputs?.estop === false) return f
  }
  throw new Error('the recorded session has no settled idle frame after the E-STOP')
}

function consoleErrors(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.severity === 'error')
    .map((line) => line.text)
}

/** The operator's own gesture: type into the Work column and leave the cell. */
function commitWorkGoto(axis: 'x' | 'y' | 'z', targetMm: number): void {
  const cell = screen.getByTestId(`control-dro-work-${axis}`) as HTMLInputElement
  fireEvent.change(cell, { target: { value: targetMm.toFixed(3) } })
  fireEvent.blur(cell)
}

function jogFrames(messages: BridgeCallMessage[]): BridgeCallMessage[] {
  return messages.filter((message) => message.m === 'jog')
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
  vi.useFakeTimers()
  bridge.last = null
  bridge.readOnly = false
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
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
  useUiPrefs.setState({ machineGotoSkipConfirm: false })
  vi.useRealTimers()
})

describe('WO-1560 a typed DRO goto cannot move the machine while the E-STOP latch is set', () => {
  it('refuses the typed Work goto before CLEAR (no motion frame) and sends it after CLEAR', async () => {
    const recorded = recordedStatusFrames()
    const incident = incidentEstopFrame(recorded)
    const settled = settledIdleFrame(recorded)
    const targetWorkX = settled.workPos!.x

    const transport = await connectBridge()
    // A fresh connection starts latched. Clear it the way the operator does -
    // through the product's own CLEAR seam - so the trip below is a real trip
    // and not the connect-only interlock.
    await act(async () => {
      expect(await session.resetEstop()).toEqual({ ok: true })
    })
    expect(session.estopNeedsReset()).toBe(false)

    render(<ControlPage />)
    await settle(0)

    // ---- the trip: the board's own recorded E-STOP frame -------------------
    act(() => { transport.status(incident) })
    expect(session.estopNeedsReset()).toBe(true)
    expect(session.estopTripNeedsReset()).toBe(true)
    expect(useMachineControl.getState().machineState).toBe('alarm')

    // The board settles to idle with a live position while the latch is STILL
    // set - the case the alarm-frame-only test would miss. The Work cell is now
    // editable; the session latch is what must stop the move.
    act(() => { transport.status(settled) })
    expect(useMachineControl.getState().machineState).toBe('idle')
    expect(session.estopNeedsReset()).toBe(true)
    expect(consoleErrors()).not.toContain('Goto X work: refused - the controller declined the move.')

    // ---- the typed goto under the latch: nothing may reach the transport ---
    const beforeRefused = transport.sent.length
    commitWorkGoto('x', targetWorkX + 10)

    expect(jogFrames(transport.sent.slice(beforeRefused))).toEqual([])
    // WO-1563: the controller never saw this move - our own latch held it - so
    // the row names the E-STOP and CLEAR, and never blames the controller.
    expect(consoleErrors()).toContain('Goto X work: not sent - the E-STOP needs CLEAR first.')
    expect(consoleErrors()).not.toContain('Goto X work: refused - the controller declined the move.')
    // The refusal is the latch, not a lucky coincidence of state: it is still set.
    expect(session.estopNeedsReset()).toBe(true)

    // ---- CLEAR, then the SAME typed goto moves -----------------------------
    // Past the post-trigger debounce; the CLEAR is a deliberate act.
    await settle(700)
    await act(async () => {
      expect(await session.resetEstop()).toEqual({ ok: true })
    })
    expect(session.estopNeedsReset()).toBe(false)

    // The CLEAR's own confirm reports idle with no position; restore the
    // operator's live DRO from the same recorded frame before retrying.
    act(() => { transport.status(settled) })
    expect(useMachineControl.getState().machineState).toBe('idle')

    const beforeMove = transport.sent.length
    const errorsBeforeMove = consoleErrors()
    commitWorkGoto('x', targetWorkX + 10)

    const sentJog = jogFrames(transport.sent.slice(beforeMove))
    expect(sentJog).toHaveLength(1)
    expect(sentJog[0].a).toMatchObject({ axis: 'X' })
    // The target is typed to three decimals, so the delta carries that
    // formatting's half-thousandth; the commanded displacement is the point.
    expect((sentJog[0].a as { deltaMm: number }).deltaMm).toBeCloseTo(10, 2)
    expect(consoleErrors()).toEqual(errorsBeforeMove)
  })

  // WO-1563's other half: "the controller declined the move" must survive for a
  // controller that genuinely refuses. `jog` is a synchronous fire-and-forget
  // on every backend, so the decline this row can report is the backend's own
  // motion boundary - here a bridge that announced itself READ ONLY, which is
  // the controller saying it will not move. The latch is clear, so the E-STOP
  // sentence must NOT be what appears.
  it('still says the controller declined the move when a non-latch backend refuses it', async () => {
    bridge.readOnly = true
    const recorded = recordedStatusFrames()
    const settled = settledIdleFrame(recorded)
    const targetWorkX = settled.workPos!.x

    const transport = await connectBridge()
    await act(async () => {
      expect(await session.resetEstop()).toEqual({ ok: true })
    })
    expect(session.estopNeedsReset()).toBe(false)

    render(<ControlPage />)
    await settle(0)
    act(() => { transport.status(settled) })
    expect(useMachineControl.getState().machineState).toBe('idle')

    const beforeMove = transport.sent.length
    commitWorkGoto('x', targetWorkX + 10)

    expect(jogFrames(transport.sent.slice(beforeMove))).toEqual([])
    expect(consoleErrors()).toContain('Goto X work: refused - the controller declined the move.')
    expect(consoleErrors()).not.toContain('Goto X work: not sent - the E-STOP needs CLEAR first.')
  })
})
