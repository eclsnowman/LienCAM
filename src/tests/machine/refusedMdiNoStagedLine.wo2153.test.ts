// @vitest-environment jsdom
//
// WO-2153 - A TYPED MDI LINE THAT DOES NOT RUN NEVER SAYS "STAGED AND STARTED".
//
// Pin rehearsal 2026-09-28 (.planning/rehearsal-2026-09-28/
// PIN-REHEARSAL-e9f30691e.txt, lines 15 and 49): a line typed while a probe
// ran printed "MDI ...: ... staged and started." and THEN the bridge's red
// "startJob: refusing to move: a probe is running ...". The row was written the
// moment the start was sent; the bridge's answer came one round trip later.
//
// Driven on the real session singleton (`sendMdiLine`, the door the Control
// page's MDI box calls; `runDirectionalProbeTouch`, the session's probe door)
// talking to the real UccncController over a fake bridge socket that answers
// the way Bridge.cs does, ONE ROUND TRIP LATER like a real socket: a probe call
// holds the machine until it answers; a startJob during it gets an error reply
// and no job event; a startJob otherwise gets `started`, then ok.
//
// Since WO-2146 (landed on main first) a line typed during the APP'S OWN probe
// routine is held at the MDI door and never sent, so the bridge refusal is now
// reached by a probe the controller runs that the app did not start (UCCNC's
// own probe screen or macro): `startBoardProbe` below. The rehearsal shape -
// the app's own probe - is pinned too: it must still never say "staged and
// started".
//
// NOT CLAIMED: hardware. The rehearsal kit is the end-to-end check against the
// UCCNC bridge on the simulated board.

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

/** The bridge's answer takes this long to come back - a real socket round trip. */
const ROUND_TRIP_MS = 5

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  heldProbe: BridgeCallMessage | null
  finishProbe(z: number): void
  /** A probe the controller runs on its own (not the app's routine). */
  startBoardProbe(): void
  endBoardProbe(z: number): void
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
    private boardProbing = false
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
          bridge: 'wo-2153-fake 0.0',
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
        this.heldProbe = message
        this.fakeEvents?.onMessage({ t: 'status', v: bridgeStatus('run') } as BridgeMessage)
        return
      }
      if (message.m === 'startJob') {
        // Bridge.cs "startJob", one round trip later: a refused start is an
        // error reply and no job event; an accepted one sends `started`, then ok.
        const probing = this.heldProbe !== null || this.boardProbing
        setTimeout(() => {
          if (probing) { reply(false, null, BRIDGE_REFUSAL); return }
          this.fakeEvents?.onMessage({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
          reply(true, true)
        }, ROUND_TRIP_MS)
        return
      }
      if (message.m === 'jogToMachineZ') {
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

    startBoardProbe(): void {
      this.boardProbing = true
      this.fakeEvents?.onMessage({ t: 'status', v: bridgeStatus('run') } as BridgeMessage)
    }

    endBoardProbe(z: number): void {
      this.boardProbing = false
      this.fakeEvents?.onMessage({ t: 'status', v: bridgeStatus('idle', z) } as BridgeMessage)
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
const STARTED = 'staged and started.'
/** What this line has always printed when it ran (today's main, recorded). */
const ROW_Z90 = 'MDI G53 G0 Z90: one move in G54, ending at G54 Z 90.00 mm (machine Z 90.00 mm), staged and started.'

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
    id: 'wo2153-machine',
    name: 'WO-2153 refused MDI machine',
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

function lines(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

function consoleText(): string {
  return lines().join('\n')
}

/** The console rows that describe the typed line `text` (never its echo). */
function rowsFor(text: string): string[] {
  return lines().filter((line) => line.startsWith(`MDI ${text}:`))
}

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function callsSince(mark: number): string[] {
  return socket().sent.slice(mark).map((m) => m.m)
}

async function finishTouch(touch: Promise<{ ok: boolean }>, z: number): Promise<{ ok: boolean }> {
  let done = false
  void touch.then(() => { done = true })
  for (let pass = 0; pass < 20 && !done; pass++) {
    await act(async () => {
      if (socket().heldProbe !== null) socket().finishProbe(z)
      await vi.advanceTimersByTimeAsync(200)
    })
  }
  if (!done) throw new Error(`probe never finished:
${consoleText()}
${socket().sent.map((m) => m.m).join(',')}`)
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

async function typeMdi(text: string): Promise<boolean> {
  let sent = false
  await act(async () => {
    sent = sendMdiLine(text)
    await vi.advanceTimersByTimeAsync(20)
  })
  return sent
}

/** Wrapped, so awaiting the start does not await the probe itself. */
async function startProbe(): Promise<{ touch: Promise<{ ok: boolean }> }> {
  let probe: Promise<{ ok: boolean }> | null = null
  await act(async () => {
    probe = runDirectionalProbeTouch('Z', '-', PROBE)
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(socket().heldProbe, consoleText()).not.toBeNull()
  return { touch: probe! }
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

describe('WO-2153: only a line that started says "staged and started"', () => {
  it('a line the bridge refuses during a probe says only why it did not run', async () => {
    await connectIdleHomed()
    // A probe the controller runs itself: the app holds no probe lock, so the
    // MDI door sends the start and the BRIDGE refuses it.
    act(() => { socket().startBoardProbe() })
    expect(getMachineController().machineState()).toBe('run')

    const mark = socket().sent.length
    await typeMdi('G53 G0 Z90')
    expect(callsSince(mark)).toContain('startJob')

    // The machine's own answer, once - and nothing claiming the line ran.
    expect(consoleText().split(BRIDGE_REFUSAL).length - 1, consoleText()).toBe(1)
    expect(consoleText(), consoleText()).not.toContain(STARTED)
    expect(rowsFor('G53 G0 Z90'), consoleText()).toEqual([])

    // The probe ends and a later line starts: THAT line says so, once, and the
    // refused line's sentence never turns up late on the back of its start.
    act(() => { socket().endBoardProbe(42) })
    await typeMdi('G53 G0 Z95')
    expect(rowsFor('G53 G0 Z95'), consoleText()).toHaveLength(1)
    expect(rowsFor('G53 G0 Z95')[0]).toContain(STARTED)
    expect(rowsFor('G53 G0 Z90'), consoleText()).toEqual([])
  }, 30_000)

  it('a line typed during the app probe routine (the rehearsal) never says "staged and started"', async () => {
    await connectIdleHomed()
    const { touch: probe } = await startProbe()

    // WO-2146 holds it at the door: nothing sent, nothing claiming it ran.
    const mark = socket().sent.length
    expect(await typeMdi('G53 G0 Z90'), consoleText()).toBe(false)
    expect(callsSince(mark)).not.toContain('startJob')
    expect(consoleText(), consoleText()).not.toContain(STARTED)
    expect(consoleText(), consoleText()).not.toContain(BRIDGE_REFUSAL)

    // The probe ends and a later line starts: THAT line says so, once, and the
    // held line's sentence never turns up late.
    expect((await finishTouch(probe, 42)).ok, consoleText()).toBe(true)
    await typeMdi('G53 G0 Z95')
    expect(rowsFor('G53 G0 Z95'), consoleText()).toHaveLength(1)
    expect(rowsFor('G53 G0 Z95')[0]).toContain(STARTED)
    expect(consoleText(), consoleText()).not.toContain('G53 G0 Z90: one move')
  }, 30_000)

  it('a line on an idle machine prints exactly what it printed before', async () => {
    await connectIdleHomed()
    expect(await typeMdi('G53 G0 Z90'), consoleText()).toBe(true)
    expect(getMachineController().hasActiveJob()).toBe(true)
    expect(rowsFor('G53 G0 Z90'), consoleText()).toEqual([ROW_Z90])
  }, 30_000)

  it('a line the busy board accepts says "staged and started" once, when the board says it started', async () => {
    await connectIdleHomed()
    // The board reads busy (a jog it is finishing), but nothing owns it: the
    // bridge takes the start.
    act(() => { socket().emit({ t: 'status', v: bridgeStatus('jog') } as BridgeMessage) })
    const mark = socket().sent.length
    await act(async () => {
      sendMdiLine('G53 G0 Z90')
      await vi.advanceTimersByTimeAsync(ROUND_TRIP_MS - 4)
    })
    // Sent, not yet answered: nothing claims it started.
    expect(callsSince(mark)).toContain('startJob')
    expect(rowsFor('G53 G0 Z90'), consoleText()).toEqual([])
    // The board answers `started`: the row, exactly as it always read.
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(getMachineController().hasActiveJob()).toBe(true)
    expect(rowsFor('G53 G0 Z90'), consoleText()).toEqual([ROW_Z90])
    expect(consoleText()).not.toContain(BRIDGE_REFUSAL)
  }, 30_000)
})
