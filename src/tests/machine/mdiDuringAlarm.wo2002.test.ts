// @vitest-environment jsdom
//
// WO-2002 - AN MDI LINE TYPED DURING AN ALARM NEVER RUNS LATER.
//
// Readiness walk finding 18 (architect, Simulate LienCNC V2, 2026-09-25): with
// the simulator in alarm, a typed `G0 X..` was ACCEPTED - the simulator queued
// the move behind the alarm - and it RAN the moment the operator pressed Unlock.
// A line the operator typed minutes earlier, into a machine that could not run
// it, moved the machine on a button that only means "clear the alarm".
//
// OUTCOME PINNED HERE, on the real session singleton (`sendMdiLine`, the door
// the Control page's MDI box calls) talking to BOTH controller classes:
//
//   - SimulatedController (connectMachine('simulator')), put into a real hard
//     limit alarm by jogging into its wired X+ switch;
//   - UccncController over a fake bridge socket, put into alarm by the bridge's
//     own status + alarm push frames, read off what reached THE WIRE.
//
// During an alarm a motion line is refused AT ONCE, by name, and nothing is
// sent, staged or queued; after Unlock the machine stays exactly where it was.
// The stop words (M5 / M9 / S0) still leave - stopping is never refused.
//
// NOT CLAIMED: hardware. M-MDI-ALARM is owed at the machine.

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

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class Fake extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
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
          bridge: 'wo-2002-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      // Every call is answered ok, as a healthy bridge does - so any refusal
      // this file sees is the session's own, never a wire failure.
      this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true } as BridgeMessage)
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
  ACTION_REFUSAL,
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runMachineAction,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

const ALARM_REFUSAL = 'the machine is in alarm, so the controller cannot run this line now. '
  + 'Nothing was sent or queued, and nothing will run on Unlock. Clear the alarm, then send the line again.'

function definition(): ControllerDefinition {
  const result = createDefaultControllerDefinition(['X', 'Y', 'Z'])
  result.axes = result.axes.map((axis) => ({
    ...axis,
    softLimitMin: 0,
    softLimitMax: 100,
    limitPlusPin: axis.axis === 'X' ? { port: 2, pin: 2, negate: false } : axis.limitPlusPin,
  }))
  result.stated = result.axes.flatMap((axis) => (['min', 'max'] as const).map((end) => ({
    controller: 'uccnc' as const,
    key: axisSoftLimitStatementKey(axis.axis, end),
  })))
  return result
}

function machine(): MachineConfig {
  return {
    id: 'wo2002-machine',
    name: 'WO-2002 alarm machine',
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

function install(): void {
  const target = machine()
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

describe('WO-2002: MDI during an alarm on the simulator', () => {
  async function connectAndAlarm() {
    install()
    const pending = connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(1)
    await pending
    __resetEstopInterlockForTest()
    const controller = getMachineController()
    // A real alarm, not a hand-set state: jog into the wired X+ switch.
    expect(controller.jog('X', 95, 60_000)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(controller.machineState()).toBe('alarm')
    return controller
  }

  it('refuses a typed move at once, by name, and Unlock moves nothing', async () => {
    const controller = await connectAndAlarm()
    const at = controller.status().machinePos!

    expect(sendMdiLine('G0 X20 Y30')).toBe(false)
    expect(consoleText()).toContain(`MDI G0 X20 Y30: ${ALARM_REFUSAL}`)
    expect(controller.status().buffer?.moves ?? 0).toBe(0)

    expect(controller.unlock()).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(controller.machineState()).toBe('idle')
    const after = controller.status().machinePos!
    expect(after.x).toBeCloseTo(at.x, 6)
    expect(after.y).toBeCloseTo(at.y, 6)
    expect(after.z).toBeCloseTo(at.z, 6)
  })

  it('refuses a spindle start during the alarm; the spindle never turns on Unlock', async () => {
    const controller = await connectAndAlarm()
    expect(sendMdiLine('M3 S9000')).toBe(false)
    expect(consoleText()).toContain(`MDI M3 S9000: ${ALARM_REFUSAL}`)
    expect(controller.unlock()).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(controller.status().spindleRpm ?? 0).toBe(0)
  })

  it('still lets a stop word, a mode word and a register write through during the alarm', async () => {
    const controller = await connectAndAlarm()
    expect(sendMdiLine('M5')).toBe(true)
    expect(sendMdiLine('G21 G90')).toBe(true)
    expect(sendMdiLine('G55')).toBe(true)
    expect(consoleText()).not.toContain(ALARM_REFUSAL)
    expect(controller.status().buffer?.moves ?? 0).toBe(0)
  })

  it('refuses a bare axis word and a dwell during the alarm', async () => {
    await connectAndAlarm()
    expect(sendMdiLine('X10')).toBe(false)
    expect(sendMdiLine('G4 P1')).toBe(false)
    expect(consoleText()).toContain(`MDI X10: ${ALARM_REFUSAL}`)
    expect(consoleText()).toContain(`MDI G4 P1: ${ALARM_REFUSAL}`)
  })

  it('runs a typed move normally once the alarm is cleared', async () => {
    const controller = await connectAndAlarm()
    expect(controller.unlock()).toBe(true)
    expect(sendMdiLine('G0 X20')).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(controller.status().machinePos!.x).toBeCloseTo(20, 6)
  })
})

describe('WO-2002: MDI during an alarm on the UCCNC bridge controller (wire frames)', () => {
  function socket(): FakeBridgeTransport {
    return bridgeSockets[bridgeSockets.length - 1]
  }

  function status(state: MachineStatus['state']): MachineStatus {
    return {
      state,
      subState: null,
      machinePos: { x: 50, y: 50, z: 50 },
      workPos: { x: 50, y: 50, z: 50 },
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

  const COMMANDING_CALLS = new Set([
    'loadMoves', 'loadProgram', 'startJob', 'selectWcs', 'spindleOn', 'spindleOff',
    'sendCommand', 'sendCommandAwait', 'setOutput', 'setWorkOffset',
  ])

  function commandingCallsSince(mark: number): string[] {
    return socket().sent.slice(mark).map((m) => m.m).filter((m) => COMMANDING_CALLS.has(m))
  }

  async function connectAndAlarm(): Promise<void> {
    install()
    const pending = connectMachine('bridge')
    await vi.advanceTimersByTimeAsync(300)
    await pending
    act(() => { __resetEstopInterlockForTest() })
    act(() => {
      socket().emit({ t: 'status', v: status('idle') } as BridgeMessage)
      socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    })
    act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
    act(() => {
      socket().emit({ t: 'status', v: status('alarm') } as BridgeMessage)
      socket().emit({
        t: 'alarm',
        v: { code: null, message: 'X positive limit switch was triggered.', positionLost: false },
      } as BridgeMessage)
    })
    expect(getMachineController().machineState()).toBe('alarm')
  }

  it('refuses a typed move at once: nothing staged or started on the wire, before or after Unlock', async () => {
    await connectAndAlarm()
    const mark = socket().sent.length
    const loadedBefore = useMachineControl.getState().job.name

    let sent = true
    await act(async () => { sent = sendMdiLine('G0 X20 Y30') })
    expect(sent).toBe(false)
    expect(consoleText()).toContain(`MDI G0 X20 Y30: ${ALARM_REFUSAL}`)
    expect(commandingCallsSince(mark)).toEqual([])
    // The typed line did not replace (or become) the loaded program either.
    expect(useMachineControl.getState().job.name).toBe(loadedBefore)

    expect(getMachineController().unlock()).toBe(true)
    await act(async () => {
      socket().emit({ t: 'status', v: status('idle') } as BridgeMessage)
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(commandingCallsSince(mark)).toEqual([])
    expect(useMachineControl.getState().job.name).toBe(loadedBefore)
  })

  it('refuses a bare axis word (a move in the held motion mode) without a wire call', async () => {
    await connectAndAlarm()
    const mark = socket().sent.length
    expect(sendMdiLine('X10')).toBe(false)
    expect(consoleText()).toContain(`MDI X10: ${ALARM_REFUSAL}`)
    expect(commandingCallsSince(mark)).toEqual([])
  })

  it('a frame select acts now during the alarm - it cannot run later, so it is not refused', async () => {
    await connectAndAlarm()
    const mark = socket().sent.length
    let sent = false
    await act(async () => {
      sent = sendMdiLine('G55')
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(sent).toBe(true)
    expect(consoleText()).not.toContain(ALARM_REFUSAL)
    expect(commandingCallsSince(mark)).toEqual(['selectWcs'])
  })

  it('a configured action that moves is refused naming the alarm, and nothing reaches the wire', async () => {
    await connectAndAlarm()
    const mark = socket().sent.length
    expect(runMachineAction(['G53 G0 Z90'])).toEqual({ ok: false, sent: 0, reason: ACTION_REFUSAL.alarm })
    expect(runMachineAction(['G53 G0 Z90', 'G53 G0 X0 Y0'])).toEqual({ ok: false, sent: 0, reason: ACTION_REFUSAL.alarm })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(commandingCallsSince(mark)).toEqual([])
  })

  it('stages and starts a typed move once the bridge reports idle again', async () => {
    await connectAndAlarm()
    act(() => { socket().emit({ t: 'status', v: status('idle') } as BridgeMessage) })
    const mark = socket().sent.length
    let sent = false
    await act(async () => {
      sent = sendMdiLine('G0 X20 Y30')
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(sent).toBe(true)
    const wire = commandingCallsSince(mark)
    expect(wire).toContain('loadMoves')
    expect(wire).toContain('startJob')
  })
})
