// @vitest-environment jsdom
//
// WO-2137 - AN MDI LINE THE BRIDGE TURNS AWAY DURING A PROBE NEVER LEAVES THE
// APP THINKING A PROGRAM RUNS.
//
// Rehearsal 2026-09-28, bite 1 (.planning/rehearsal-2026-09-28/REPORT.md,
// logs/repro-lockout-run2.json / -run3.json): an MDI line typed while Tools >
// Measure T19 ran went out as loadMoves + startJob. The bridge refused the
// start ("refusing to move: a probe is running on the controller ...") - that
// answer is right - but UccncController.startJob() had already set its job
// flag, and a refusal sends no job event, so nothing cleared it. Once the
// measure ended and the machine sat idle, every Start probing printed "A
// program is running - probing is locked out." and every MDI "... MDI is
// locked out." until Stop/Reset.
//
// Driven here on the real session singleton (`sendMdiLine`, the door the
// Control page's MDI box calls; `runDirectionalProbeTouch`, the session's
// probe door) talking to the real UccncController over a fake bridge socket
// that answers the way Bridge.cs does: a probe call holds the machine until it
// answers; a startJob during it gets an error reply and no job event; a
// startJob otherwise gets `started` then ok.
//
// NOT CLAIMED: hardware. The rehearsal kit (repro-lockout.mjs) is the
// end-to-end check against the UCCNC bridge on the simulated board.

import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import type { ZProbeConfig } from '../../lib/machine/toolTable'
import {
  createDefaultControllerDefinition,
  type ControllerDefinition,
  type MachineConfig,
} from '../../types'
import { typedMock } from '../support/typedMock'

const PROGRAM_BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

/** Machine.cs's own words for this refusal, byte for byte (RefuseMotion). */
const BRIDGE_REFUSAL = 'refusing to move: a probe is running on the controller and owns the '
  + 'machine until it finishes. A move accepted now could be buffered and run the '
  + 'moment the cycle ends, which is an axis moving with nobody having asked it to. '
  + 'Stop the cycle first if you need to move.'

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  /** The probe call the board is still running, if any. */
  heldProbe: BridgeCallMessage | null
  /** The board finishes the probe: it touched at `z`, and the machine is idle. */
  finishProbe(z: number): void
}

const bridgeSockets: FakeBridgeTransport[] = []

function bridgeStatus(state: MachineStatus['state'], z = 50): MachineStatus {
  return {
    state,
    subState: null,
    machinePos: { x: 50, y: 50, z },
    workPos: { x: 50, y: 50, z },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class Fake extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    heldProbe: BridgeCallMessage | null = null
    private fakeEvents: BridgeTransportEvents | null = null

    constructor(...args: ConstructorParameters<typeof actual.BridgeTransport>) {
      super(...args)
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const zero = { x: 0, y: 0, z: 0 }
      const offsets = { G54: zero, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-2137-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      const reply = (ok: boolean, v: unknown, error?: string) => this.fakeEvents?.onMessage(
        { t: 'reply', seq: message.seq, ok, v, ...(error === undefined ? {} : { error }) } as BridgeMessage,
      )
      if (message.m === 'probe') {
        // The probe owns the machine until it answers (Machine.cs longOp).
        this.heldProbe = message
        this.fakeEvents?.onMessage({ t: 'status', v: bridgeStatus('run') } as BridgeMessage)
        return
      }
      if (message.m === 'startJob') {
        // Bridge.cs "startJob": a refused start is an error reply and no job
        // event; an accepted one sends `started`, then ok.
        if (this.heldProbe !== null) { reply(false, null, BRIDGE_REFUSAL); return }
        this.fakeEvents?.onMessage({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
        reply(true, true)
        return
      }
      if (message.m === 'jogToMachineZ') {
        // The probe's own pull-off: the board goes there and reads idle.
        reply(true, true)
        const z = (message.a as { z: number }).z
        this.fakeEvents?.onMessage({ t: 'status', v: bridgeStatus('idle', z) } as BridgeMessage)
        return
      }
      reply(true, message.m === 'loadMoves' ? { ok: true, reason: null } : true)
    }

    finishProbe(z: number): void {
      const held = this.heldProbe
      if (held === null) throw new Error('no probe is running')
      this.heldProbe = null
      this.fakeEvents?.onMessage({ t: 'status', v: bridgeStatus('idle', z) } as BridgeMessage)
      this.fakeEvents?.onMessage({
        t: 'reply', seq: held.seq, ok: true, v: { ok: true, at: { x: 50, y: 50, z } },
      } as BridgeMessage)
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: Fake })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runDirectionalProbeTouch,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

const PROBE: ZProbeConfig = { fastFeed: 600, slowFeed: 60, retract: 2, maxTravel: 10, padThickness: 0 }
const MDI_LOCKED = 'A program is running - MDI is locked out.'
const PROBING_LOCKED = 'A program is running - probing is locked out.'

function definition(): ControllerDefinition {
  const result = createDefaultControllerDefinition(['X', 'Y', 'Z'])
  result.axes = result.axes.map((axis) => ({ ...axis, softLimitMin: 0, softLimitMax: 100 }))
  result.stated = result.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
    controller: 'uccnc' as const,
    key: axisSoftLimitStatementKey(axis.axis, end),
  })))
  return result
}

function machine(): MachineConfig {
  return {
    id: 'wo2137-machine',
    name: 'WO-2137 refused MDI machine',
    type: 'gantry_router',
    controller: 'uccnc',
    travel: { x: 100, y: 100, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    rapidRate: 60_000,
    minSpindleRpm: 0,
    maxSpindleRpm: 24_000,
    spindleDirection: 'cw',
    toolChanger: 'manual',
    coolant: false,
    notes: '',
    controllerDefinition: definition(),
  }
}

function install(target: MachineConfig): void {
  useCamStore.setState((state) => ({
    machineLibrary: [target],
    project: { ...state.project, machine: target, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  }))
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function callsSince(mark: number): string[] {
  return socket().sent.slice(mark).map((m) => m.m)
}

async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

/** The board finishes every pass of the touch (fast, then slow) at `z`. */
async function finishTouch(touch: Promise<{ ok: boolean }>, z: number): Promise<{ ok: boolean }> {
  let done = false
  void touch.then(() => { done = true })
  for (let pass = 0; pass < 20 && !done; pass++) {
    await act(async () => {
      if (socket().heldProbe !== null) socket().finishProbe(z)
      await vi.advanceTimersByTimeAsync(200)
    })
  }
  return touch
}

async function connectIdleHomed(): Promise<void> {
  install(machine())
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: bridgeStatus('idle') } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
  expect(getMachineController().machineState()).toBe('idle')
}

let originalState: ReturnType<typeof useCamStore.getState>

beforeEach(() => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  originalState = useCamStore.getState()
  useMachineControl.setState({ consoleLines: [], alarm: null })
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({
    project: originalState.project,
    machineLibrary: originalState.machineLibrary,
    control: originalState.control,
  })
  act(() => { __resetEstopInterlockForTest() })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  useMachineControl.setState({ consoleLines: [], alarm: null })
  vi.useRealTimers()
})

describe('WO-2137: an MDI line the bridge refuses during a probe leaves no program running', () => {
  it('once the probe ends and the machine is idle, Start probing and MDI work at once', async () => {
    await connectIdleHomed()
    const ctrl = getMachineController()

    // The probe starts and owns the machine.
    let probe: Promise<{ ok: boolean }> | null = null
    await act(async () => {
      probe = runDirectionalProbeTouch('Z', '-', PROBE)
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(socket().heldProbe, consoleText()).not.toBeNull()

    // The operator types an MDI line meanwhile. WO-2146 (Operator 2026-09-28): the
    // app holds it - nothing of it reaches the bridge while the probe runs.
    const typedMark = socket().sent.length
    await act(async () => {
      expect(sendMdiLine('G53 G0 Z90')).toBe(false)
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(callsSince(typedMark)).not.toContain('startJob')
    // A start that does reach the bridge during the probe is turned away.
    const mark = socket().sent.length
    await act(async () => {
      ctrl.startJob()
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(callsSince(mark)).toContain('startJob')
    // The machine's own answer, once.
    expect(consoleText().split(BRIDGE_REFUSAL).length - 1, consoleText()).toBe(1)
    // The refused start is not a running program, even while the probe still runs.
    expect(ctrl.hasActiveJob()).toBe(false)

    // The probe ends; the machine is idle.
    expect((await finishTouch(probe!, 42)).ok, consoleText()).toBe(true)
    expect(ctrl.machineState()).toBe('idle')
    expect(ctrl.hasActiveJob()).toBe(false)

    // Start probing: it probes - no lockout.
    const probeMark = socket().sent.length
    let again: Promise<{ ok: boolean }> | null = null
    await act(async () => {
      again = runDirectionalProbeTouch('Z', '-', PROBE)
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(callsSince(probeMark), consoleText()).toContain('probe')
    expect((await finishTouch(again!, 41)).ok, consoleText()).toBe(true)

    // MDI: staged AND started on the wire - no lockout.
    const mdiMark = socket().sent.length
    let sent = false
    await act(async () => {
      sent = sendMdiLine('G53 G0 Z95')
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(sent, consoleText()).toBe(true)
    expect(callsSince(mdiMark)).toEqual(expect.arrayContaining(['loadMoves', 'startJob']))
    expect(ctrl.hasActiveJob()).toBe(true)

    expect(consoleText()).not.toContain(PROBING_LOCKED)
    expect(consoleText()).not.toContain(MDI_LOCKED)
    // The first refusal was said once and never repeated.
    expect(consoleText().split(BRIDGE_REFUSAL).length - 1).toBe(1)
  }, 30_000)

  it('a start the bridge accepts still reads as running until the bridge says it ended', async () => {
    await connectIdleHomed()
    const ctrl = getMachineController()
    let sent = false
    await act(async () => {
      sent = sendMdiLine('G53 G0 Z90')
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(sent, consoleText()).toBe(true)
    expect(ctrl.hasActiveJob()).toBe(true)
    expect(sendMdiLine('G53 G0 Z80')).toBe(false)
    expect(consoleText()).toContain(MDI_LOCKED)
    act(() => { socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage) })
    expect(ctrl.hasActiveJob()).toBe(false)
  }, 30_000)

  it('a start the bridge never answers is not taken back - the job may be running', async () => {
    await connectIdleHomed()
    const ctrl = getMachineController()
    const transport = socket()
    const send = transport.send.bind(transport)
    transport.send = (message: BridgeCallMessage) => {
      if (message.m === 'startJob') { transport.sent.push(message); return }
      send(message)
    }
    await act(async () => {
      sendMdiLine('G53 G0 Z90')
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(ctrl.hasActiveJob()).toBe(true)
    await settle(10_000)
    expect(consoleText()).toContain('did not answer "startJob" in time')
    expect(ctrl.hasActiveJob()).toBe(true)
  }, 30_000)

  it('Stop/Reset after a refused start still ends everything', async () => {
    await connectIdleHomed()
    const ctrl = getMachineController()
    let probe: Promise<{ ok: boolean }> | null = null
    await act(async () => {
      probe = runDirectionalProbeTouch('Z', '-', PROBE)
      await vi.advanceTimersByTimeAsync(20)
    })
    await act(async () => {
      sendMdiLine('G53 G0 Z90')
      await vi.advanceTimersByTimeAsync(20)
    })
    act(() => { ctrl.stopJob() })
    expect(ctrl.hasActiveJob()).toBe(false)
    await finishTouch(probe!, 42)
    expect(ctrl.hasActiveJob()).toBe(false)
  }, 30_000)
})
