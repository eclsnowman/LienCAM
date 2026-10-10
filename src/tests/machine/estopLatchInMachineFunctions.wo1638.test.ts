// @vitest-environment jsdom
//
// WO-1638 - THE E-STOP LATCH IS ENFORCED WHERE MOTION STARTS, NOT ONLY IN THE BUTTONS.
//
// Operator's ruling 2026-09-14: every connect and every E-STOP forces CLEAR; all
// motion is off until CLEAR. Every button already checks the latch first. The
// WO-1635 safety review found the calls BELOW the buttons did not: with the
// latch set, `startMachineJob` and the controller's `startJob`, `resumeJob`,
// `cycleResume`, `stepJob`, `jogToWorkXY` and `jogToMachineZ` reached the board.
//
// WHAT IS PROVEN HERE, on the real session singleton talking to a real
// `UccncController` over a fake bridge socket and a real `GrblController` over a
// fake serial port, read off what reached THE WIRE:
//
//   - latch set: each call returns false, the backend method is never entered,
//     nothing of it reaches the wire, and the console names the E-STOP;
//   - latch clear: each call reaches the backend exactly as before;
//   - latch set: feed hold, stop, reset, E-STOP, spindle off, jog cancel and a
//     work-offset write still go out.
//
// NOT CLAIMED: hardware. Tier 2 desk evidence only.

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
const serialWrites: string[] = []

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
          bridge: 'wo-1638-fake 0.0',
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
    async write(data: Uint8Array): Promise<void> { serialWrites.push(new TextDecoder().decode(data)) }
    async close(): Promise<void> { this.fakeEvents?.onClose(null) }
  }
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({ ...actual, WebSerialTransport: Fake })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { UccncController } = await import('../../lib/machine/uccncController')
const { GrblController } = await import('../../lib/machine/grbl/controller')
const {
  ESTOP_BLOCKS_MOTION,
  __armEstopInterlockForTest,
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setWorkOffsetValue,
  startMachineJob,
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
    id: 'wo1638-machine',
    name: 'WO-1638 Test Machine',
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
  serialWrites.length = 0
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
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
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

type Ctrl = ReturnType<typeof getMachineController>

/** Each call that starts, resumes or steps motion, by the controller member
 *  it enters. Its wire name is the member name less any `Await`. */
const MOTION_CALLS: Array<{
  name: 'startJob' | 'resumeJob' | 'cycleResume' | 'stepJob' | 'jogToWorkXY' | 'jogToMachineZ'
    | 'jogToWorkXYAwait' | 'jogToMachineZAwait'
  invoke: (c: Ctrl) => boolean | Promise<boolean> | null | undefined
}> = [
  { name: 'startJob', invoke: (c) => c.startJob() },
  { name: 'resumeJob', invoke: (c) => c.resumeJob() },
  { name: 'cycleResume', invoke: (c) => c.cycleResume() },
  { name: 'stepJob', invoke: (c) => c.stepJob() },
  { name: 'jogToWorkXY', invoke: (c) => c.jogToWorkXY(10, 20, 1000) },
  { name: 'jogToMachineZ', invoke: (c) => c.jogToMachineZ(-10, 1000) },
  { name: 'jogToWorkXYAwait', invoke: (c) => c.jogToWorkXYAwait?.(10, 20, 1000) },
  { name: 'jogToMachineZAwait', invoke: (c) => c.jogToMachineZAwait?.(-10, 1000) },
]

const UCCNC_MOTION_WIRE = new Set([
  'startJob', 'resumeJob', 'cycleResume', 'stepJob', 'jogToWorkXY', 'jogToMachineZ',
  'loadMoves', 'loadProgram', 'spindleOn',
])

function uccncMotionSince(mark: number): string[] {
  return socket().sent.slice(mark).map((m) => m.m).filter((m) => UCCNC_MOTION_WIRE.has(m))
}

/** GRBL's status poll is a lone '?'. Anything else written is a command. */
function grblWritesSince(mark: number): string[] {
  return serialWrites.slice(mark).filter((w) => w !== '?')
}

async function connectGrbl(): Promise<void> {
  const target = uccncMachine()
  target.controller = 'grbl'
  target.controllerDefinition = undefined
  // This boundary test does not exercise homing. Declare its synthetic GRBL
  // fixture switchless so Step reaches the E-STOP wrapper under test.
  target.noHomingSwitches = true
  install(target)
  await connectMachine('serial')
  await settle()
  act(() => { __resetEstopInterlockForTest() })
}

describe('WO-1638: UCCNC - motion calls below the UI refuse under the E-STOP latch', () => {
  it.each(MOTION_CALLS)('$name: latch set -> nothing on the wire, E-STOP reason', async ({ name, invoke }) => {
    const spy = vi.spyOn(UccncController.prototype, name)
    await connectBridge()
    act(() => { __armEstopInterlockForTest() })
    const mark = socket().sent.length
    const result = await invoke(getMachineController())
    await settle()
    expect(result).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect(uccncMotionSince(mark)).toEqual([])
    expect(consoleText()).toContain(`refused - ${ESTOP_BLOCKS_MOTION}`)
  })

  it.each(MOTION_CALLS)('$name: latch clear -> reaches the controller as today', async ({ name, invoke }) => {
    const spy = vi.spyOn(UccncController.prototype, name)
    await connectBridge()
    const mark = socket().sent.length
    const result = invoke(getMachineController())
    await settle()
    expect(result).not.toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(uccncMotionSince(mark)).toContain(name.replace(/Await$/, ''))
    expect(consoleText()).not.toContain(ESTOP_BLOCKS_MOTION)
  })
})

describe('WO-1638: GRBL - motion calls below the UI refuse under the E-STOP latch', () => {
  // GRBL's controller has no Await variants; the six it has are proven here.
  type GrblCall = (typeof MOTION_CALLS)[number] & { name: Exclude<(typeof MOTION_CALLS)[number]['name'], `${string}Await`> }
  const grblCalls = MOTION_CALLS.filter((c): c is GrblCall => !c.name.endsWith('Await'))

  it.each(grblCalls)('$name: latch set -> nothing on the wire, E-STOP reason', async ({ name, invoke }) => {
    const spy = vi.spyOn(GrblController.prototype, name)
    await connectGrbl()
    act(() => { __armEstopInterlockForTest() })
    const mark = serialWrites.length
    const result = await invoke(getMachineController())
    await settle()
    expect(result).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    expect(grblWritesSince(mark)).toEqual([])
    expect(consoleText()).toContain(`refused - ${ESTOP_BLOCKS_MOTION}`)
  })

  it.each(grblCalls)('$name: latch clear -> reaches the controller as today', async ({ name, invoke }) => {
    const spy = vi.spyOn(GrblController.prototype, name)
    await connectGrbl()
    invoke(getMachineController())
    await settle()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(consoleText()).not.toContain(ESTOP_BLOCKS_MOTION)
  })
})

const PROGRAM = 'G21 G90 G54\nG0 X0 Y0 Z10\nG1 Z-1 F300\nG1 X5 F300\nG0 Z10\nM30\n'

describe('WO-1638: Cycle Start below the button refuses with a program loaded', () => {
  beforeEach(async () => {
    await connectBridge()
    const loaded = loadGcodeTextToolpathProgram('wo1638.nc', PROGRAM)
    await settle()
    expect(loaded).toEqual({ ok: true, reason: null })
  })

  it('startMachineJob: latch set -> no startJob on the wire, the E-STOP named', async () => {
    act(() => { __armEstopInterlockForTest() })
    const mark = socket().sent.length
    expect(startMachineJob()).toBe(false)
    await settle()
    expect(uccncMotionSince(mark)).toEqual([])
    expect(consoleText()).toContain(`Cycle Start: refused - ${ESTOP_BLOCKS_MOTION}`)
  })

  it('executeOperatorCycleStart: latch set -> no startJob on the wire', async () => {
    act(() => { __armEstopInterlockForTest() })
    const mark = socket().sent.length
    expect(await executeOperatorCycleStart()).toBe(false)
    await settle()
    expect(uccncMotionSince(mark)).toEqual([])
  })

  it('startMachineJob: latch clear -> startJob goes out as today', async () => {
    const mark = socket().sent.length
    expect(startMachineJob()).toBe(true)
    await settle()
    expect(uccncMotionSince(mark)).toContain('startJob')
  })
})

describe('WO-1638: what only stops, and offset writes, still go out under the latch', () => {
  beforeEach(async () => {
    await connectBridge()
    act(() => { __armEstopInterlockForTest() })
  })

  it.each([
    ['feedHold', (c: Ctrl) => c.feedHold()],
    ['stopJob', (c: Ctrl) => c.stopJob()],
    ['reset', (c: Ctrl) => c.reset()],
    ['emergencyStop', (c: Ctrl) => c.emergencyStop()],
    ['spindleOff', (c: Ctrl) => c.spindleOff?.()],
    ['jogCancel', (c: Ctrl) => c.jogCancel()],
  ] as const)('%s reaches the wire', async (wireName, invoke) => {
    const mark = socket().sent.length
    invoke(getMachineController())
    await settle()
    expect(socket().sent.slice(mark).map((m) => m.m)).toContain(wireName)
  })

  it('a work-offset write is not motion and goes out', async () => {
    const mark = socket().sent.length
    expect(setWorkOffsetValue('G54', 'X', 5)).toBe(true)
    await settle()
    expect(socket().sent.slice(mark).map((m) => m.m)).toContain('setWorkOffset')
  })
})
