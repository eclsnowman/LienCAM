// @vitest-environment jsdom
//
// WO-1635 - MACRO AND COOLANT BUTTONS RUN ON UCCNC.
//
// Every macro button and the Flood / Mist buttons go through `runMachineAction`.
// On a controller that takes no G-code text (Operator's AXBB-E through the UCCNC
// bridge) that used to hand each line to `sendCommand`, which refuses all text:
// "This controller takes geometry, not G-code text - nothing was loaded." Operator,
// 2026-09-14: "I keep hearing the goddamn phrase we can't run G-Code."
//
// WHAT IS PROVEN HERE, on the real session singleton talking to a real
// `UccncController` over a fake bridge socket (and a real `GrblController` over
// a fake serial port), read off what reached THE WIRE:
//
//   - a macro `G53 G0 Z120` -> `selectWcs`, `loadMoves` (one rapid to machine
//     Z120), `startJob`;
//   - a macro `G4 P500` -> `loadMoves` carrying one 0.5 s dwell step, `startJob`;
//   - a two-line move macro stages ONE program, not a second line refused while
//     the first is still moving;
//   - `M8`, `M9` and `M64 P2 S8000` -> NOTHING on the wire on a machine whose
//     definition assigns no pin to them (WO-1637 added the bridge's output call;
//     outputPins.wo1637.test.ts proves the assigned case). Each is refused BY
//     WORD, naming what to fill in - never the "takes geometry" sentence;
//   - the same macros on GRBL go out as the text itself, unchanged.
//
// NOT CLAIMED: hardware. Tier 1 is a macro and Flood at the machine.

import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import type { TransportEvents } from '../../lib/machine/types'
import {
  UNASSIGNED_PIN,
  createDefaultControllerDefinition,
  type MachineConfig,
  type Project,
} from '../../types'
import { makeMachine } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { typedMock } from '../support/typedMock'
import { mdiFrameBetweenPartsMessage, mdiOutputByNumberMessage } from '../../lib/machine/operatorMessages'

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

const G54_OFFSET = { x: 10, y: 5, z: 2 }
const UNSET_OFFSET = { x: 0, y: 0, z: 0 }

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
      const offsets = {
        G54: { ...G54_OFFSET },
        G55: { ...UNSET_OFFSET },
        G56: { ...UNSET_OFFSET },
        G57: { ...UNSET_OFFSET },
        G58: { ...UNSET_OFFSET },
        G59: { ...UNSET_OFFSET },
      }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1635-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
      if (message.m === 'setWorkOffset') {
        const a = message.a as { x?: number; y?: number; z?: number }
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, offset: { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 } },
        })
      }
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

vi.mock('../../lib/machine/webSerialTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/webSerialTransport')>()
  class Fake extends actual.WebSerialTransport {
    private fakeEvents: TransportEvents | null = null
    static isSupported(): boolean { return true }
    static async requestPort(): Promise<SerialPort> { return {} as SerialPort }
    static async grantedPorts(): Promise<SerialPort[]> { return [] }
    async start(events: TransportEvents): Promise<void> {
      this.fakeEvents = events
      events.onChunk(new TextEncoder().encode("Grbl 1.1h ['$' for help]\r\n"))
    }
    async write(_data: Uint8Array): Promise<void> {}
    async close(): Promise<void> { this.fakeEvents?.onClose(null) }
  }
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({ ...actual, WebSerialTransport: Fake })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const {
  ACTION_REFUSAL,
  __armEstopInterlockForTest,
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  runMachineAction,
} = await import('../../lib/machine/machineSession')

function uccncMachine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -50 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  // WO-1649: the machine's one output list, stating flood and mist and wiring
  // neither. The profile's relay keys used to imply this list and the resolver
  // read them directly; now the list IS the statement, so a fixture that wants
  // "named but unwired" says so here.
  controllerDefinition.outputs = [
    { name: 'flood coolant', role: 'flood', onCode: 'M8', offCode: null, pin: { ...UNASSIGNED_PIN } },
    { name: 'mist coolant', role: 'mist', onCode: 'M7', offCode: null, pin: { ...UNASSIGNED_PIN } },
  ]
  return makeMachine({
    id: 'wo1635-machine',
    name: 'WO-1635 Test Machine',
    controller: 'uccnc',
    travel: { x: 600, y: 400, z: 200 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

function install(target: MachineConfig): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [target],
    project: { ...state.project, machine: target, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  })
}

function idleBridgeStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
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

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

beforeEach(() => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  originalProject = useCamStore.getState().project
  originalLibrary = useCamStore.getState().machineLibrary
  originalControl = useCamStore.getState().control
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({
    project: originalProject,
    machineLibrary: originalLibrary,
    control: originalControl,
    machineWorkOffsets: {},
  })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  useMachineActions.setState({ byMachine: {} })
  act(() => { __resetEstopInterlockForTest() })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  vi.useRealTimers()
})

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

const COMMANDING_CALLS = new Set([
  'loadMoves', 'loadProgram', 'startJob', 'selectWcs', 'spindleOn', 'spindleOff',
  'sendCommand', 'sendCommandAwait', 'setOutputInhibit',
])

function commandingCallsSince(mark: number): string[] {
  return socket().sent.slice(mark).map((m) => m.m).filter((m) => COMMANDING_CALLS.has(m))
}

interface WireStep {
  id: number
  kind: string
  to?: { x?: number; y?: number; z: number }
  seconds?: number
  rapid?: true
}

function stagedSteps(mark: number): WireStep[] {
  const load = socket().sent.slice(mark).find((m) => m.m === 'loadMoves')
  expect(load, 'a program reached the wire').toBeDefined()
  return (load!.a as { moves: WireStep[] }).moves
}

async function connectBridge(): Promise<void> {
  install(uccncMachine())
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
}

async function settle(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
}

const TEXT_REFUSAL = 'takes geometry, not G-code text'

describe('WO-1635: configured actions translate on a UCCNC controller', () => {
  beforeEach(async () => {
    await connectBridge()
  })

  it('a macro G53 G0 Z120 stages one rapid to machine Z120 and starts it', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['G53 G0 Z120'])
    await settle()
    expect(result).toEqual({ ok: true, sent: 1 })
    const wire = commandingCallsSince(mark)
    expect(wire).toContain('loadMoves')
    expect(wire.indexOf('startJob')).toBeGreaterThan(wire.indexOf('loadMoves'))
    const steps = stagedSteps(mark)
    expect(steps).toHaveLength(1)
    expect(steps[0].rapid).toBe(true)
    // Staged in G54 work coordinates: machine Z120 less the G54 Z offset of 2.
    expect(steps[0].to!.z).toBeCloseTo(120 - G54_OFFSET.z, 6)
    expect(consoleText()).not.toContain(TEXT_REFUSAL)
  })

  it('a macro G4 P500 stages the board\'s own 0.5 s dwell step and starts it', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['G4 P500'])
    await settle()
    expect(result).toEqual({ ok: true, sent: 1 })
    const steps = stagedSteps(mark)
    expect(steps.map((step) => step.kind)).toEqual(['dwell'])
    expect(steps[0].seconds).toBeCloseTo(0.5, 9)
    const wire = commandingCallsSince(mark)
    expect(wire.indexOf('startJob')).toBeGreaterThan(wire.indexOf('loadMoves'))
    expect(consoleText()).toContain('MDI G4 P500: a 0.5 s dwell in G54')
    expect(consoleText()).not.toContain(TEXT_REFUSAL)
  })

  it('consecutive move and dwell lines of one macro stage as ONE program', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['G53 G0 Z120', 'G4 P500', 'G53 G0 X100 Y50'])
    await settle()
    expect(result).toEqual({ ok: true, sent: 3 })
    expect(socket().sent.slice(mark).filter((m) => m.m === 'loadMoves')).toHaveLength(1)
    expect(stagedSteps(mark).map((step) => step.kind)).toEqual(['line', 'dwell', 'line'])
    expect(commandingCallsSince(mark).filter((m) => m === 'startJob')).toHaveLength(1)
    expect(consoleText()).not.toContain('MDI is locked out')
  })

  // WO-1637: output words switch the pins the machine definition names. This
  // record assigns none, so each is refused naming what to fill in - a pin is
  // never invented. (outputPins.wo1637.test.ts proves the assigned case.)
  it.each([
    ['M8', 'M8 switches flood coolant, and this machine definition assigns it no pin'],
    ['M9', 'M9 switches coolant and accessories, and this machine definition assigns it no pin'],
    ['M64 P2 S8000', mdiOutputByNumberMessage('M64', 'switches digital output P2 on')],
  ])('a macro %s reaches no text refusal - it is refused by word, naming what would carry it', async (line, said) => {
    const mark = socket().sent.length
    const result = runMachineAction([line])
    await settle()
    expect(result.ok).toBe(false)
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().sent.slice(mark).filter((m) => m.m === 'setOutput')).toEqual([])
    expect(consoleText()).toContain(`MDI ${line}: ${said}`)
    expect(consoleText()).not.toContain(TEXT_REFUSAL)
    expect(consoleText()).not.toContain('Refused text:')
  })

  it('the Flood button\'s default M8 takes the same route', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['M8'], { action: 'coolantFlood' })
    await settle()
    expect(result.ok).toBe(false)
    expect(commandingCallsSince(mark)).toEqual([])
    expect(consoleText()).not.toContain(TEXT_REFUSAL)
  })
})

describe('WO-1635: a text controller is unchanged', () => {
  it('the same macros on GRBL go out as the text itself', async () => {
    const target = uccncMachine()
    target.controller = 'grbl'
    target.controllerDefinition = undefined
    install(target)
    await connectMachine('serial')
    act(() => { __resetEstopInterlockForTest() })
    const ctrl = getMachineController()
    const send = vi.spyOn(ctrl, 'sendCommand')
    const lines = ['M8', 'M9', 'M64 P2 S8000', 'G4 P500', 'G53 G0 Z120']
    for (const line of lines) runMachineAction([line])
    expect(send.mock.calls.map((call) => call[0])).toEqual(lines)
    expect(consoleText()).not.toContain(TEXT_REFUSAL)
  })
})

// ---------------------------------------------------------------------------
// WO-1635 SAFETY FIX ROUND. The safety review found two ways the new staging
// route went past a guard the old text route had for free (the bridge refused
// every line of text):
//
//   DEFECT 1 - a spindle-off or coolant-off action is exempt from the E-STOP
//   latch BY IDENTITY, and that exemption covered every line of the action. On
//   UCCNC a line can now stage and START a program, so "spindle off + park Z"
//   moved the machine under a latched E-STOP. The stop word still goes; a line
//   that stages a program is refused naming the E-STOP.
//
//   DEFECT 2 - a program's own coolant action runs between two staged parts. A
//   configured action carrying G55 switched the work offset there, and the next
//   part - converted in G54 - ran with G55 selected. Between parts a frame
//   select is refused by name, the same way a move is.
// ---------------------------------------------------------------------------

const PROGRAM_CALLS = new Set(['selectWcs', 'loadMoves', 'loadProgram', 'startJob'])

describe('WO-1635 safety: no program is staged under a latched E-STOP', () => {
  beforeEach(async () => {
    await connectBridge()
    act(() => { __armEstopInterlockForTest() })
  })

  it('spindleOff [M5, G53 G0 Z0]: the stop goes, the move is refused naming the E-STOP', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['M5', 'G53 G0 Z0'], { action: 'spindleOff' })
    await settle()
    const wire = commandingCallsSince(mark)
    expect(wire.filter((m) => PROGRAM_CALLS.has(m))).toEqual([])
    expect(wire).toContain('spindleOff')
    expect(result).toEqual({ ok: false, sent: 1, reason: ACTION_REFUSAL.estop })
  })

  it('coolantOff [G53 G0 Z0]: nothing reaches the wire', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['G53 G0 Z0'], { action: 'coolantOff' })
    await settle()
    expect(commandingCallsSince(mark)).toEqual([])
    expect(result).toEqual({ ok: false, sent: 0, reason: ACTION_REFUSAL.estop })
  })

  it('spindleOff [M5, G4 P500]: the dwell is not staged or started', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['M5', 'G4 P500'], { action: 'spindleOff' })
    await settle()
    expect(commandingCallsSince(mark).filter((m) => PROGRAM_CALLS.has(m))).toEqual([])
    expect(result).toEqual({ ok: false, sent: 1, reason: ACTION_REFUSAL.estop })
  })

  it('an untyped M5 alone still goes out under the latch', async () => {
    const mark = socket().sent.length
    runMachineAction(['M5'])
    await settle()
    expect(commandingCallsSince(mark)).toContain('spindleOff')
  })
})

describe('WO-1635 safety: a text controller sends no move line under a latched E-STOP', () => {
  it('coolantOff [M9, G53 G0 Z0] on GRBL sends M9 and refuses the move', async () => {
    const target = uccncMachine()
    target.controller = 'grbl'
    target.controllerDefinition = undefined
    install(target)
    await connectMachine('serial')
    act(() => { __armEstopInterlockForTest() })
    const send = vi.spyOn(getMachineController(), 'sendCommand')
    const result = runMachineAction(['M9', 'G53 G0 Z0'], { action: 'coolantOff' })
    expect(send.mock.calls.map((call) => call[0])).toEqual(['M9'])
    expect(result).toEqual({ ok: false, sent: 1, reason: ACTION_REFUSAL.estop })
  })
})

describe("WO-1635 safety: a program's own action cannot switch the work offset between parts", () => {
  it('a flood override of G55 is refused by name between parts; the next part runs in its own frame', async () => {
    const target = uccncMachine()
    target.coolantCapability = { flood: true }
    install(target)
    useMachineActions.getState().setOverride(target.id, 'coolantFlood', ['G55'])
    const pending = connectMachine('bridge')
    await vi.advanceTimersByTimeAsync(300)
    await pending
    act(() => { __resetEstopInterlockForTest() })
    act(() => {
      socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
      socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    })

    const loaded = loadGcodeTextToolpathProgram(
      'flood-g55.nc',
      'G21 G90 G54\nG0 X0 Y0 Z10\nG1 Z-1 F300\nM8\nG1 X5 F300\nG0 Z10\nM30\n',
    )
    await settle()
    expect(loaded).toEqual({ ok: true, reason: null })
    expect(await executeOperatorCycleStart()).toBe(true)
    await settle()

    const mark = socket().sent.length
    act(() => {
      socket().emit({
        t: 'status',
        v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
      } as BridgeMessage)
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    await settle()

    const after = socket().sent.slice(mark)
    // NO FRAME CHANGE UNDER THE RUNNING JOB.
    expect(after.filter((m) => m.m === 'selectWcs').map((m) => (m.a as { wcs: string }).wcs))
      .not.toContain('G55')
    expect(consoleText()).toContain(`MDI G55: ${mdiFrameBetweenPartsMessage('55')}`)
    // THE NEXT PART STILL STAGES AND STARTS, in the frame it was read in.
    const load = after.find((m) => m.m === 'loadMoves')
    expect(load, 'the next part reached the wire').toBeDefined()
    const moves = (load!.a as { moves: WireStep[] }).moves
    expect(moves.map((move) => move.to!.x)).toEqual([5, 5])
    expect(after.map((m) => m.m)).toContain('startJob')
  })
})

// ---------------------------------------------------------------------------
// WO-1635 SAFETY FIX ROUND 2. The re-review found the round-1 guard was a MOTION
// DENYLIST read off the geometry reader, so a stop action still sent G28, $H,
// G55, G20, G91 ... under the latch, and typed MDI had no latch check at all.
// Operator's ruling (2026-09-14): every E-STOP forces CLEAR; ALL motion is off and
// refused until CLEAR. ONE RULE AT ONE DOOR: under the latch a line leaves the
// MDI door (typed, or any unit of a configured action, on every controller) only
// if it holds nothing but stop words - M5, M9, S0, N words, comments.
// ---------------------------------------------------------------------------

const { sendMdiLine } = await import('../../lib/machine/machineSession')
const ESTOP_SAID = ACTION_REFUSAL.estop

async function connectGrbl(): Promise<{ sent: () => string[] }> {
  const target = uccncMachine()
  target.controller = 'grbl'
  target.controllerDefinition = undefined
  install(target)
  await connectMachine('serial')
  act(() => { __resetEstopInterlockForTest() })
  const ctrl = getMachineController()
  const send = vi.spyOn(ctrl, 'sendCommand')
  const sendAwait = vi.spyOn(ctrl, 'sendCommandAwait')
  return {
    sent: () => [
      ...send.mock.calls.map((call) => call[0]),
      ...sendAwait.mock.calls.map((call) => call[0]),
    ],
  }
}

describe('WO-1635 safety round 2: UCCNC, latch set - only stop words leave the MDI door', () => {
  beforeEach(async () => {
    await connectBridge()
    act(() => { __armEstopInterlockForTest() })
  })

  it.each(['G53 G0 Z0', 'G55'])('typed %s: nothing on the wire, the E-STOP reason', async (line) => {
    const mark = socket().sent.length
    expect(sendMdiLine(line)).toBe(false)
    await settle()
    expect(commandingCallsSince(mark)).toEqual([])
    expect(consoleText()).toContain(`MDI ${line}: ${ESTOP_SAID}`)
  })

  it('spindleOff [G55]: nothing on the wire', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['G55'], { action: 'spindleOff' })
    await settle()
    expect(commandingCallsSince(mark)).toEqual([])
    expect(result).toEqual({ ok: false, sent: 0, reason: ESTOP_SAID })
  })

  it('spindleOff [M5]: spindleOff is sent', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['M5'], { action: 'spindleOff' })
    await settle()
    expect(commandingCallsSince(mark)).toEqual(['spindleOff'])
    expect(result).toEqual({ ok: true, sent: 1 })
  })

  it.each(['S0 M5', 'M5 M9'])('typed %s is not refused by the latch', async (line) => {
    sendMdiLine(line)
    await settle()
    expect(consoleText()).not.toContain(ESTOP_SAID)
  })
})

describe('WO-1635 safety round 2: GRBL, latch set - only stop words leave the MDI door', () => {
  it('spindleOff [G28]: nothing sent', async () => {
    const grbl = await connectGrbl()
    act(() => { __armEstopInterlockForTest() })
    const result = runMachineAction(['G28'], { action: 'spindleOff' })
    expect(grbl.sent()).toEqual([])
    expect(result).toEqual({ ok: false, sent: 0, reason: ESTOP_SAID })
  })

  it('spindleOff [M5, G28]: only M5', async () => {
    const grbl = await connectGrbl()
    act(() => { __armEstopInterlockForTest() })
    const result = runMachineAction(['M5', 'G28'], { action: 'spindleOff' })
    expect(grbl.sent()).toEqual(['M5'])
    expect(result).toEqual({ ok: false, sent: 1, reason: ESTOP_SAID })
  })

  it.each(['$H', 'G0 X10', 'G55', 'G20', 'T1 M6'])('typed %s: nothing sent, the E-STOP reason', async (line) => {
    const grbl = await connectGrbl()
    act(() => { __armEstopInterlockForTest() })
    expect(sendMdiLine(line)).toBe(false)
    expect(grbl.sent()).toEqual([])
    expect(consoleText()).toContain(`MDI ${line}: ${ESTOP_SAID}`)
  })

  it('spindleOff [$H]: nothing sent', async () => {
    const grbl = await connectGrbl()
    act(() => { __armEstopInterlockForTest() })
    const result = runMachineAction(['$H'], { action: 'spindleOff' })
    expect(grbl.sent()).toEqual([])
    expect(result).toEqual({ ok: false, sent: 0, reason: ESTOP_SAID })
  })

  it.each([
    [['M5'], 'spindleOff'],
    [['M9'], 'coolantOff'],
    [['S0 M5'], 'spindleOff'],
    [['M5 M9'], 'spindleOff'],
    [['N10 M5 (stop)'], 'spindleOff'],
  ] as const)('%j as %s is sent verbatim', async (lines, action) => {
    const grbl = await connectGrbl()
    act(() => { __armEstopInterlockForTest() })
    const result = runMachineAction([...lines], { action })
    expect(grbl.sent()).toEqual([...lines])
    expect(result).toEqual({ ok: true, sent: lines.length })
  })

  it.each(['S0 M5', 'M5 M9', 'M05'])('typed %s is sent verbatim', async (line) => {
    const grbl = await connectGrbl()
    act(() => { __armEstopInterlockForTest() })
    expect(sendMdiLine(line)).toBe(true)
    expect(grbl.sent()).toEqual([line])
  })
})

describe('WO-1635 safety round 2: latch clear - macros and typed MDI run as before', () => {
  it('UCCNC: typed G53 G0 Z0 and a move macro stage and start', async () => {
    await connectBridge()
    let mark = socket().sent.length
    expect(sendMdiLine('G53 G0 Z0')).toBe(true)
    await settle()
    expect(commandingCallsSince(mark)).toContain('startJob')
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
      socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    })
    await settle()
    mark = socket().sent.length
    const result = runMachineAction(['M5', 'G53 G0 Z120'], { action: 'spindleOff' })
    await settle()
    expect(result).toEqual({ ok: true, sent: 2 })
    expect(commandingCallsSince(mark)).toEqual(expect.arrayContaining(['spindleOff', 'loadMoves', 'startJob']))
  })

  it('GRBL: typed G0 X10 and a macro [M5, G28, $H] go out verbatim', async () => {
    const grbl = await connectGrbl()
    expect(sendMdiLine('G0 X10')).toBe(true)
    const result = runMachineAction(['M5', 'G28', '$H'], { action: 'spindleOff' })
    expect(result).toEqual({ ok: true, sent: 3 })
    expect(grbl.sent()).toEqual(['G0 X10', 'M5', 'G28', '$H'])
  })
})

describe('WO-1635 safety round 2: GRBL $ lines under the latch - only the ones that move are refused', () => {
  it.each(['$H', '$HX', '$J=G91 X1 F100'])('typed %s: nothing sent, the E-STOP reason', async (line) => {
    const grbl = await connectGrbl()
    act(() => { __armEstopInterlockForTest() })
    expect(sendMdiLine(line)).toBe(false)
    expect(grbl.sent()).toEqual([])
    expect(consoleText()).toContain(`MDI ${line}: ${ESTOP_SAID}`)
  })

  it.each(['?', '$$', '$X'])('typed %s: sent, a read or unlock cannot move the machine', async (line) => {
    const grbl = await connectGrbl()
    act(() => { __armEstopInterlockForTest() })
    expect(sendMdiLine(line)).toBe(true)
    expect(grbl.sent()).toEqual([line])
    expect(consoleText()).not.toContain(ESTOP_SAID)
  })
})
