// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import nodeProcess from 'node:process'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
  BridgeVfdFrameObserver,
} from '../../lib/machine/bridgeTransport'
import type {
  ControllerCapabilities,
  ControllerEvents,
  MachineStatus,
  SetWorkOffsetResult,
} from '../../lib/machine/controller'
import type { TransportEvents } from '../../lib/machine/types'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import type { MachineConfig, MachineSpindleLinkDefinition } from '../../types'
import { typedMock } from '../support/typedMock'

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

interface GenerationTransport extends BridgeTransport {
  autoHello: boolean
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  emitClose(reason: string): void
  reply(call: BridgeCallMessage, value: unknown): void
}

const bridge = vi.hoisted(() => ({
  instances: [] as GenerationTransport[],
  activeMachineId: null as string | null,
}))
interface GenerationSerialTransport {
  emitClose(reason: string): void
  emitText(text: string): void
}
const serial = vi.hoisted(() => ({ instances: [] as GenerationSerialTransport[] }))

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    autoHello = true
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor(
      url?: string,
      machineId?: string | null,
      onVfdFrame?: BridgeVfdFrameObserver | null,
    ) {
      super(url, machineId, onVfdFrame)
      bridge.activeMachineId = machineId ?? null
      bridge.instances.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      if (this.autoHello) this.emit({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: `WO-1148-${bridge.instances.length}`,
          capabilities: CAPABILITIES,
          readOnly: false,
          vfd: { present: false, verified: false, name: null },
        },
      })
    }

    send(message: BridgeCallMessage): void { this.sent.push(message) }
    async close(): Promise<void> { this.fakeEvents?.onClose('closed') }
    emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }
    emitClose(reason: string): void { this.fakeEvents?.onClose(reason) }
    reply(call: BridgeCallMessage, value: unknown): void {
      this.emit({ t: 'reply', seq: call.seq, ok: true, v: value })
    }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
    vfdPortLinkState: () => ({
      ...actual.vfdPortLinkState(),
      connected: bridge.instances.length > 0,
      machineId: bridge.activeMachineId,
    }),
  })
})

vi.mock('../../lib/machine/webSerialTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/webSerialTransport')>()
  class FakeWebSerialTransport extends actual.WebSerialTransport implements GenerationSerialTransport {
    private fakeEvents: TransportEvents | null = null

    static isSupported(): boolean { return true }
    static async requestPort(): Promise<SerialPort> { return {} as SerialPort }
    static async grantedPorts(): Promise<SerialPort[]> { return [] }

    constructor(port: SerialPort, baudRate?: number) {
      super(port, baudRate)
      serial.instances.push(this)
    }

    async start(events: TransportEvents): Promise<void> {
      this.fakeEvents = events
      events.onChunk(new TextEncoder().encode("Grbl 1.1h ['$' for help]\r\n"))
    }

    async write(_data: Uint8Array): Promise<void> {}
    async close(): Promise<void> { this.fakeEvents?.onClose(null) }
    emitClose(reason: string): void { this.fakeEvents?.onClose(reason) }
    emitText(text: string): void { this.fakeEvents?.onChunk(new TextEncoder().encode(text)) }
  }
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({
    ...actual,
    WebSerialTransport: FakeWebSerialTransport,
  })
})

const session = await import('../../lib/machine/machineSession')
const { HELLO_TIMEOUT_MS, UccncController } = await import('../../lib/machine/uccncController')
type ApplyVfdDefinitionResult = import('../../lib/machine/uccncController').ApplyVfdDefinitionResult
const { BridgeTransport: MockBridgeTransport } = await import('../../lib/machine/bridgeTransport')
const { useMachineControl } = await import('../../store/machineControlStore')
const { controlMachine, useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { ControlPage } = await import('../../components/machine/ControlPage')

// WO-1213: this fake-backend suite must not discover the shared supervisor on
// 8326. Use a distinct per-worker bridge port for both of its test machines.
const TEST_BRIDGE_PORT = 20_000 + ((nodeProcess.pid * 17 + 1148) % 20_000)

const originalMachineLibrary = useCamStore.getState().machineLibrary
let grblMachine: MachineConfig
let uccncMachine: MachineConfig
/** WO-2066: only a UCCNC machine has a bridge route. The bridge cases below ran
 *  on the GRBL record through the removed every-controller bridge route; they
 *  now start on this UCCNC record, which stays a different machine from
 *  `uccncMachine` for the cases that swap to another machine. */
let bridgeMachine: MachineConfig

function selectBridgeMachine(): void {
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: bridgeMachine },
    control: { activeMachineId: bridgeMachine.id, sessionMachine: null },
  }))
}

function status(x: number, state: MachineStatus['state'] = 'idle'): MachineStatus {
  return {
    state,
    subState: null,
    machinePos: { x, y: x + 1, z: x + 2 },
    workPos: { x: x - 10, y: x - 9, z: x - 8 },
    feedMmMin: x,
    spindleRpm: null,
    overrides: null,
    executingMoveId: null,
    buffer: null,
    inputs: null,
    homed: null,
    spindle: null,
  }
}

function lastCall(target: GenerationTransport, method: string): BridgeCallMessage {
  const call = [...target.sent].reverse().find((candidate) => candidate.m === method)
  if (!call) throw new Error(`No ${method} call was sent`)
  return call
}

async function flushReceipts(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
}

function controlSnapshot() {
  const state = useMachineControl.getState()
  return structuredClone({
    connectionPhase: state.connectionPhase,
    connectionKind: state.connectionKind,
    connectionDetail: state.connectionDetail,
    bridgeHello: state.bridgeHello,
    mpos: state.mpos,
    wpos: state.wpos,
    alarm: state.alarm,
    homed: state.homed,
    offsets: state.offsets,
    activeWcs: state.activeWcs,
    job: state.job,
    consoleLines: state.consoleLines,
  })
}

beforeEach(() => {
  bridge.instances = []
  bridge.activeMachineId = null
  serial.instances = []
  useCamStore.getState().newProject()
  const baseMachine = useCamStore.getState().project.machine
  grblMachine = {
    ...baseMachine,
    id: 'wo1148-grbl',
    name: 'WO-1148 GRBL machine',
    controller: 'grbl',
    controllerDefinition: undefined,
  }
  uccncMachine = {
    ...baseMachine,
    id: 'wo1148-uccnc',
    name: 'WO-1148 UCCNC machine',
    controller: 'uccnc',
    controllerDefinition: undefined,
  }
  bridgeMachine = {
    ...baseMachine,
    id: 'wo1148-bridge',
    name: 'WO-1148 bridge machine',
    controller: 'uccnc',
    controllerDefinition: undefined,
  }
  useCamStore.setState((state) => ({
    machineLibrary: [...originalMachineLibrary, grblMachine, uccncMachine, bridgeMachine],
    project: { ...state.project, machine: grblMachine },
    machineWorkOffsets: {},
    control: { activeMachineId: grblMachine.id, sessionMachine: null },
  }))
  useUiPrefs.setState({
    machineLinks: {
      [grblMachine.id]: { bridgePort: TEST_BRIDGE_PORT },
      [uccncMachine.id]: { bridgePort: TEST_BRIDGE_PORT },
      [bridgeMachine.id]: { bridgePort: TEST_BRIDGE_PORT },
    },
  })
  useMachineControl.setState((state) => ({
    connectionPhase: 'disconnected',
    connectionKind: null,
    connectionDetail: null,
    consoleLines: [],
    activeWcs: null,
    alarm: null,
    mpos: null,
    wpos: null,
    job: { ...state.job, phase: 'empty', name: null },
  }))
  session.__resetEstopInterlockForTest()
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
  session.__resetEstopInterlockForTest()
})

describe('WO-1148 backend generation ownership', () => {
  it('keeps Control transport selection stable across serial and bridge losses and machine switches', async () => {
    render(<ControlPage />)
    const kindSelect = () => screen.getByTestId('control-kind-select') as HTMLSelectElement
    const machineSelect = screen.getByTestId('control-machine-select') as HTMLSelectElement

    expect(kindSelect().value).toBe('serial')
    fireEvent.click(screen.getByTestId('control-connect'))
    await waitFor(() => expect(useMachineControl.getState().connectionPhase).toBe('connected'))
    expect(useMachineControl.getState().connectionKind).toBe('serial')

    act(() => { serial.instances[0].emitClose('unexpected serial loss') })
    await waitFor(() => expect(useMachineControl.getState()).toMatchObject({
      connectionPhase: 'disconnected',
      connectionKind: null,
    }))
    expect(useCamStore.getState().control.sessionMachine).toBeNull()

    // Negative control for ControlPage's phase guard: even if a delayed store
    // publication repeats the departed runtime identity, a disconnected
    // operator choice must win. Reverting the guard at ControlPage.tsx:615
    // snaps this selection back to serial and loops serial/bridge below.
    act(() => { useMachineControl.setState({ connectionKind: 'serial' }) })
    fireEvent.change(kindSelect(), { target: { value: 'simulator' } })
    await waitFor(() => expect(kindSelect().value).toBe('simulator'))

    fireEvent.change(machineSelect, { target: { value: uccncMachine.id } })
    await waitFor(() => expect(kindSelect().value).toBe('bridge'))
    await act(async () => { await Promise.resolve() })
    expect(kindSelect().value).toBe('bridge')
    expect(useCamStore.getState().control.activeMachineId).toBe(uccncMachine.id)

    fireEvent.click(screen.getByTestId('control-connect'))
    await waitFor(() => expect(useMachineControl.getState()).toMatchObject({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
    }))
    act(() => { bridge.instances.at(-1)?.emitClose('unexpected bridge loss') })
    await waitFor(() => expect(useMachineControl.getState()).toMatchObject({
      connectionPhase: 'disconnected',
      connectionKind: null,
    }))

    fireEvent.change(machineSelect, { target: { value: grblMachine.id } })
    await waitFor(() => expect(kindSelect().value).toBe('serial'))
    expect(useCamStore.getState().control.activeMachineId).toBe(grblMachine.id)
  })

  it('treats the bridge duplicate connected frame as detail, not a second session', async () => {
    selectBridgeMachine()
    await session.connectMachine('bridge')
    const transport = bridge.instances[0]
    const machineId = controlMachine(useCamStore.getState()).id
    useMachineControl.setState({ activeWcs: 'G54' })
    session.zeroWorkAxes(['X'])
    const zero = lastCall(transport, 'zeroWorkAxis')
    session.__resetEstopInterlockForTest()
    const boundaryCount = useMachineControl.getState().consoleLines
      .filter((line) => line.text.startsWith('--- connected to ')).length

    transport.emit({ t: 'phase', v: { phase: 'connected', version: 'WO-1148-detail-refresh' } })
    transport.reply(zero, { ok: true, wcs: 'G54', axis: 'X', offset: { x: 7, y: 8, z: 9 } })
    await flushReceipts()

    expect(session.estopNeedsReset()).toBe(false)
    expect(useMachineControl.getState().connectionDetail).toBe('WO-1148-detail-refresh')
    expect(useMachineControl.getState().consoleLines
      .filter((line) => line.text.startsWith('--- connected to '))).toHaveLength(boundaryCount)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.offset).toEqual({ x: 7 })
  })

  it('preserves an armed Step Back review across a repeated connected callback', async () => {
    await session.connectMachine('serial')
    const transport = serial.instances[0]
    transport.emitText('ok\r\nok\r\nok\r\n')
    transport.emitText('<Idle|MPos:0,0,0|WPos:0,0,0>\r\n')
    // Operator 2026-09-14 ("A: Flash, all motion off"): this test is about Step
    // Back review surviving a repeated connected callback, not the E-STOP
    // latch itself - clear it the way __resetEstopInterlockForTest lets a
    // fresh test do without a round-trip idle status report.
    session.__resetEstopInterlockForTest()
    session.loadMachineProgram(
      'duplicate-connected-step-back.nc',
      ['G21 G90 G54', 'G0 X0 Y0', 'G1 X1 F100', 'M30'].join('\n'),
      null,
    )
    const controller = session.getMachineController()
    expect(controller.startJob()).toBe(true)
    transport.emitText('ok\r\nok\r\nok\r\n')
    session.setMachineSingleBlock(true)
    const armed = await session.stepBackOneLine()
    expect(armed.ok).toBe(true)
    const review = session.runFromReview()
    expect(review).toMatchObject({ source: 'step-back', error: null })
    expect(review.plan).not.toBeNull()

    // UCCNC cannot itself arm a text-only Step Back review. The preceding test
    // proves its unsolicited connected frame reaches this same phase-edge
    // handler; this case pins the real review state on that detail-only path.
    session.buildContractEvents().onConnectionPhase?.('connected', 'duplicate-detail')

    expect(session.runFromReview()).toEqual(review)
  })

  it('ignores every delayed event and receipt from a replaced backend', async () => {
    selectBridgeMachine()
    await session.connectMachine('bridge')
    const oldTransport = bridge.instances[0]
    const machineId = controlMachine(useCamStore.getState()).id
    useMachineControl.setState({ activeWcs: 'G54' })
    session.zeroWorkAxes(['X'])
    const oldZero = lastCall(oldTransport, 'zeroWorkAxis')

    await session.connectMachine('bridge')
    const currentTransport = bridge.instances[1]
    currentTransport.emit({ t: 'status', v: status(20) })
    session.loadMachineProgram('protected-review.nc', 'G21\nG1 X1 F100', null)
    const accepted = useMachineControl.getState()
    const protectedReview = structuredClone(session.transferReview())

    oldTransport.reply(oldZero, { ok: true, wcs: 'G54', axis: 'X', offset: { x: 99, y: 99, z: 99 } })
    oldTransport.emit({ t: 'status', v: status(90, 'alarm') })
    oldTransport.emit({ t: 'alarm', v: { code: 77, message: 'late alarm', positionLost: true } })
    oldTransport.emit({ t: 'jobEvent', v: { event: 'failed', fault: { code: 77, message: 'late job', line: null, moveId: null } } })
    oldTransport.emit({ t: 'phase', v: { phase: 'connected', version: 'late-old-version' } })
    oldTransport.emitClose('late old close')
    await flushReceipts()

    expect(useMachineControl.getState()).toMatchObject({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      connectionDetail: accepted.connectionDetail,
      mpos: accepted.mpos,
      wpos: accepted.wpos,
      alarm: accepted.alarm,
      job: accepted.job,
    })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: {},
      state: 'unknown',
    })
    expect(session.transferReview()).toEqual(protectedReview)
    expect(session.getMachineController().status().machinePos?.x).toBe(20)

    session.zeroWorkAxes(['Y'])
    const currentZero = lastCall(currentTransport, 'zeroWorkAxis')
    currentTransport.reply(currentZero, { ok: true, wcs: 'G54', axis: 'Y', offset: { x: 1, y: 22, z: 3 } })
    await flushReceipts()
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.offset).toEqual({ y: 22 })

    currentTransport.emit({ t: 'alarm', v: { code: 12, message: 'current alarm', positionLost: false } })
    expect(useMachineControl.getState().alarm).toEqual({ code: 12, message: 'current alarm', positionLost: false })

    currentTransport.emit({
      t: 'jobEvent',
      v: { event: 'failed', fault: { code: 12, message: 'current job', line: null, moveId: 4 } },
    })
    expect(useMachineControl.getState().job.error).toEqual({
      code: 12,
      message: 'current job',
      line: null,
      moveId: 4,
    })

    currentTransport.emit({ t: 'phase', v: { phase: 'connected', version: 'current-version' } })
    expect(useMachineControl.getState().connectionDetail).toBe('current-version')

    currentTransport.emitClose('current close')
    expect(useMachineControl.getState()).toMatchObject({
      connectionPhase: 'disconnected',
      connectionKind: null,
    })
  })

  it.each([
    {
      settlement: 'accepted',
      receipt: { ok: true, reason: null, offset: { x: 12, y: 0, z: 0 } },
    },
    {
      settlement: 'refused',
      receipt: { ok: false, reason: 'late restore refusal', offset: null },
    },
  ] satisfies Array<{ settlement: string; receipt: SetWorkOffsetResult }>)(
    'invalidates a connect-time work-zero receipt when its session disconnects ($settlement)',
    async ({ receipt }) => {
      selectBridgeMachine()
      const machineId = controlMachine(useCamStore.getState()).id
      useCamStore.setState((state) => ({
        machineWorkOffsets: {
          ...state.machineWorkOffsets,
          [machineId]: {
            G54: { offset: { x: 12 }, state: 'sent' },
          },
        },
      }))

      const connecting = session.connectMachine('bridge')
      expect(bridge.instances).toHaveLength(1)
      const transport = bridge.instances[0]
      const target = session.getMachineController() as InstanceType<typeof UccncController>
      let settleRestore!: (value: SetWorkOffsetResult) => void
      const restore = vi.spyOn(target, 'setWorkOffset').mockImplementation(
        () => new Promise<SetWorkOffsetResult>((resolve) => { settleRestore = resolve }),
      )
      await vi.waitFor(() => expect(restore).toHaveBeenCalledWith('G54', { x: 12 }))

      transport.emitClose('disconnect before restore receipt')
      await flushReceipts()
      expect(useMachineControl.getState().connectionPhase).toBe('disconnected')
      expect(useCamStore.getState().control.sessionMachine).toBeNull()
      const disconnectedControl = controlSnapshot()
      const disconnectedOffset = structuredClone(useCamStore.getState().machineWorkOffsets[machineId]?.G54)
      const disconnectedConsole = structuredClone(useMachineControl.getState().consoleLines)

      settleRestore(receipt)
      await connecting
      await flushReceipts()

      expect(controlSnapshot()).toEqual(disconnectedControl)
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual(disconnectedOffset)
      expect(useMachineControl.getState().consoleLines).toEqual(disconnectedConsole)
      expect(useCamStore.getState().control.sessionMachine).toBeNull()
      expect(session.machineWorkOffsetWriteInFlight(machineId)).toBe(false)
    },
  )

  it('invalidates an MDI WCS acknowledgement when its session disconnects', async () => {
    await session.connectMachine('serial')
    session.__resetEstopInterlockForTest()
    const target = session.getMachineController()
    let acknowledge!: (value: { ok: boolean; message: string | null }) => void
    const receipt = new Promise<{ ok: boolean; message: string | null }>((resolve) => {
      acknowledge = resolve
    })
    const send = vi.spyOn(target, 'sendCommandAwait').mockReturnValue(receipt)

    expect(session.sendMdiLine('G55')).toBe(true)
    expect(send).toHaveBeenCalledWith('G55')
    serial.instances[0].emitClose('disconnect before MDI acknowledgement')
    expect(useMachineControl.getState().connectionPhase).toBe('disconnected')
    // The point of this assertion is that the G55 typed above did NOT survive
    // the disconnect. It used to read as null; since Operator's 2026-09-03 order
    // ("It should default to g54 unless told otherwise") a disconnect returns
    // to the app's default rather than to "no WCS at all". Still G55-free.
    expect(useMachineControl.getState().activeWcs).toBe('G54')
    expect(useCamStore.getState().control.sessionMachine).toBeNull()
    const disconnectedControl = controlSnapshot()
    const disconnectedConsole = structuredClone(useMachineControl.getState().consoleLines)

    acknowledge({ ok: true, message: null })
    await flushReceipts()

    expect(controlSnapshot()).toEqual(disconnectedControl)
    expect(useMachineControl.getState().consoleLines).toEqual(disconnectedConsole)
    expect(useCamStore.getState().control.sessionMachine).toBeNull()
  })

  it('ignores a rejected work-offset receipt from a replaced backend', async () => {
    selectBridgeMachine()
    await session.connectMachine('bridge')
    const oldController = session.getMachineController() as InstanceType<typeof UccncController>
    const oldTransport = bridge.instances[0]
    let rejectOldWrite: ((reason?: unknown) => void) | null = null
    const oldOffsetCall = vi.spyOn(oldController, 'setWorkOffset').mockImplementation(
      () => new Promise<SetWorkOffsetResult>((_resolve, reject) => { rejectOldWrite = reject }),
    )

    expect(session.setWorkOffsetValue('G54', 'X', 91)).toBe(true)
    await vi.waitFor(() => expect(oldOffsetCall).toHaveBeenCalledTimes(1))

    // Backend B belongs to another machine, so its independent receipt can
    // settle while A's machine-scoped write slot remains held by the late call.
    useCamStore.getState().setControlSessionMachine(null)
    useCamStore.getState().setControlMachineId(uccncMachine.id)
    useCamStore.getState().updateMachineInLibrary(uccncMachine.id, { noHomingSwitches: true })
    await session.connectMachine('bridge')
    const currentTransport = bridge.instances[1]
    const currentMachineId = controlMachine(useCamStore.getState()).id
    expect(currentMachineId).toBe(uccncMachine.id)
    useMachineControl.setState({ activeWcs: 'G54' })

    expect(session.setWorkOffsetValue('G54', 'Y', 22)).toBe(true)
    await Promise.resolve()
    const currentOffset = lastCall(currentTransport, 'setWorkOffset')
    currentTransport.reply(currentOffset, {
      ok: true,
      reason: null,
      offset: { x: 1, y: 22, z: 3 },
    })
    await flushReceipts()

    const acceptedOffset = structuredClone(
      useCamStore.getState().machineWorkOffsets[currentMachineId]?.G54,
    )
    const acceptedConnection = {
      connectionPhase: useMachineControl.getState().connectionPhase,
      connectionKind: useMachineControl.getState().connectionKind,
      connectionDetail: useMachineControl.getState().connectionDetail,
    }
    const acceptedConsole = structuredClone(useMachineControl.getState().consoleLines)
    expect(acceptedOffset).toEqual({ offset: { y: 22 }, state: 'sent' })
    expect(session.workGotoZeroRefusal(['Y'])).toBeNull()
    expect(session.machineWorkOffsetWriteInFlight(currentMachineId)).toBe(false)

    // Model a contract backend whose close rejects outstanding calls. The
    // transport close and promise rejection are one delayed A event here.
    const emitOldClose = oldTransport.emitClose.bind(oldTransport)
    oldTransport.emitClose = (reason) => {
      emitOldClose(reason)
      rejectOldWrite?.(new Error(reason))
    }
    oldTransport.emitClose('late old offset close')
    await flushReceipts()

    expect(useCamStore.getState().machineWorkOffsets[currentMachineId]?.G54).toEqual(acceptedOffset)
    expect(session.workGotoZeroRefusal(['Y'])).toBeNull()
    expect(session.machineWorkOffsetWriteInFlight(currentMachineId)).toBe(false)
    expect(useMachineControl.getState()).toMatchObject(acceptedConnection)
    expect(useMachineControl.getState().consoleLines).toEqual(acceptedConsole)
  })

  it('ignores a refused connect-time spindle receipt from a replaced backend', async () => {
    const spindleDefinition: MachineSpindleLinkDefinition = {
      ...HUANYANG_GT,
      provenance: { kind: 'edited-here', source: 'WO-1148 generation test' },
    }
    bridgeMachine = { ...bridgeMachine, spindleLinkDefinition: spindleDefinition }
    useCamStore.setState((state) => ({
      machineLibrary: state.machineLibrary.map((machine) => (
        machine.id === bridgeMachine.id ? bridgeMachine : machine
      )),
    }))
    selectBridgeMachine()

    const oldConnect = session.connectMachine('bridge')
    await vi.waitFor(() => expect(bridge.instances).toHaveLength(1))
    const oldTransport = bridge.instances[0]
    await vi.waitFor(() => expect(oldTransport.sent.some(
      (call) => call.m === 'applyVfdDefinition',
    )).toBe(true))
    const oldApply = lastCall(oldTransport, 'applyVfdDefinition')

    // Installing B invalidates A while A is still awaiting its connect-time
    // apply receipt. B skips its own sync because the machine-scoped slot is
    // still held by A, then becomes the only current session.
    await session.connectMachine('bridge')
    expect(bridge.instances).toHaveLength(2)
    const acceptedConnection = {
      connectionPhase: useMachineControl.getState().connectionPhase,
      connectionKind: useMachineControl.getState().connectionKind,
      connectionDetail: useMachineControl.getState().connectionDetail,
    }
    const acceptedDefinition = structuredClone(
      useCamStore.getState().project.machine.spindleLinkDefinition,
    )
    const acceptedAppliedMachine = structuredClone(useCamStore.getState().control.appliedMachine)
    const consoleCount = useCamStore.getState().consoleEvents.length

    oldTransport.reply(oldApply, {
      definition: null,
      error: 'late old connect-time refusal',
    })
    await oldConnect
    await flushReceipts()

    expect(useMachineControl.getState()).toMatchObject(acceptedConnection)
    expect(useCamStore.getState().project.machine.spindleLinkDefinition).toEqual(acceptedDefinition)
    expect(useCamStore.getState().control.appliedMachine).toEqual(acceptedAppliedMachine)
    expect(useCamStore.getState().consoleEvents.slice(consoleCount).map((event) => ({
      severity: event.severity,
      message: event.message,
    }))).toEqual([{
      severity: 'info',
      message: 'Spindle link connect receipt ignored - the backend/session or sent definition changed while the bridge was confirming it.',
    }])
    expect(useCamStore.getState().consoleEvents.map((event) => event.message))
      .not.toContain('Spindle link refused - late old connect-time refusal.')
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a late operator spindle receipt after backend replacement (%s)',
    async (settlement) => {
      const definition: MachineSpindleLinkDefinition = {
        ...HUANYANG_GT,
        provenance: { kind: 'edited-here', source: `WO-1148 ${settlement} matrix` },
      }
      selectBridgeMachine()
      await session.connectMachine('bridge')
      const oldController = session.getMachineController() as InstanceType<typeof UccncController>
      let resolveOld!: (value: ApplyVfdDefinitionResult) => void
      let rejectOld!: (reason?: unknown) => void
      const oldReceipt = new Promise<ApplyVfdDefinitionResult>((resolve, reject) => {
        resolveOld = resolve
        rejectOld = reject
      })
      const oldApply = vi.spyOn(oldController, 'applyVfdDefinition').mockReturnValue(oldReceipt)

      const pending = session.applyMachineSpindleLinkDefinition(bridgeMachine.id, definition)
      await vi.waitFor(() => expect(oldApply).toHaveBeenCalledTimes(1))

      await session.connectMachine('bridge')
      const acceptedControl = controlSnapshot()
      const acceptedSessionMachine = structuredClone(useCamStore.getState().control.sessionMachine)
      const acceptedAppliedMachine = structuredClone(useCamStore.getState().control.appliedMachine)
      const acceptedDefinition = structuredClone(useCamStore.getState().project.machine.spindleLinkDefinition)
      const acceptedConsoleEventCount = useCamStore.getState().consoleEvents.length

      if (settlement === 'resolve') {
        resolveOld({ ok: false, error: 'late old operator refusal', definition: null })
      } else {
        rejectOld(new Error('late old operator rejection'))
      }
      await pending
      await flushReceipts()

      expect(controlSnapshot()).toEqual(acceptedControl)
      expect(useCamStore.getState().control.sessionMachine).toEqual(acceptedSessionMachine)
      expect(useCamStore.getState().control.appliedMachine).toEqual(acceptedAppliedMachine)
      expect(useCamStore.getState().project.machine.spindleLinkDefinition).toEqual(acceptedDefinition)
      expect(useCamStore.getState().consoleEvents.slice(acceptedConsoleEventCount).map((event) => ({
        severity: event.severity,
        message: event.message,
      }))).toEqual([{
        severity: 'info',
        message: 'Spindle link receipt ignored - the bridge receipt belongs to a replaced backend/session or a changed definition.',
      }])
    },
  )

  it('ignores delayed GRBL job progress after replacement and accepts current progress', async () => {
    await session.connectMachine('serial')
    session.__resetEstopInterlockForTest()
    const oldController = session.getMachineController()
    const oldTransport = serial.instances[0]
    oldTransport.emitText('ok\r\nok\r\nok\r\n')
    oldTransport.emitText('<Idle|MPos:0,0,0|WPos:0,0,0>\r\n')
    expect(oldController.loadJob('G21\nG90').ok).toBe(true)
    expect(oldController.startJob()).toBe(true)

    await session.connectMachine('serial')
    session.__resetEstopInterlockForTest()
    const currentController = session.getMachineController()
    const currentTransport = serial.instances[1]
    currentTransport.emitText('ok\r\nok\r\nok\r\n')
    currentTransport.emitText('<Idle|MPos:0,0,0|WPos:0,0,0>\r\n')
    expect(currentController).not.toBe(oldController)
    expect(session.loadMachineProgram('current-progress.nc', 'G21\nG90', null).lines).toHaveLength(2)
    expect(currentController.startJob()).toBe(true)
    const beforeAck = structuredClone(useMachineControl.getState().job)
    // The progress mirror intentionally throttles same-phase acknowledgements
    // to 10 Hz. Wait past that window so the matched B callback is observable;
    // the stale A callback below is still delivered first and must stay inert.
    await new Promise((resolve) => setTimeout(resolve, 110))

    oldTransport.emitText('ok\r\n')
    expect(useMachineControl.getState().job).toEqual(beforeAck)

    currentTransport.emitText('ok\r\n')
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'streaming',
      ackedLines: 1,
      ackedSourceLine: 1,
    })
  })

  it('clears runtime identity and the session pin on an unexpected close', async () => {
    selectBridgeMachine()
    await session.connectMachine('bridge')
    expect(useCamStore.getState().control.sessionMachine).not.toBeNull()

    bridge.instances[0].emitClose('unexpected bridge loss')

    expect(useMachineControl.getState()).toMatchObject({
      connectionPhase: 'disconnected',
      connectionKind: null,
    })
    expect(useCamStore.getState().control.sessionMachine).toBeNull()
  })

  it('drops old transport callbacks after reconnecting one UCCNC controller object', async () => {
    const statuses: MachineStatus[] = []
    const phases: string[] = []
    const events: ControllerEvents = {
      onStatus: (value) => statuses.push(value),
      onConnectionPhase: (phase) => phases.push(phase),
    }
    const controller = new UccncController(events)
    const first = new MockBridgeTransport() as GenerationTransport
    await controller.connect({ kind: 'messages', transport: first })
    await controller.disconnect()
    const second = new MockBridgeTransport() as GenerationTransport
    await controller.connect({ kind: 'messages', transport: second })
    second.emit({ t: 'status', v: status(30) })
    const phaseCount = phases.length

    first.emit({ t: 'status', v: status(80, 'alarm') })
    first.emit({ t: 'phase', v: { phase: 'disconnected', version: 'old' } })
    first.emitClose('old close')

    expect(statuses).toEqual([status(30)])
    expect(phases).toHaveLength(phaseCount)
    expect(controller.connectionPhase()).toBe('connected')
    expect(controller.status().machinePos?.x).toBe(30)
    await controller.disconnect()
  })

  it('does not let an old UCCNC hello timeout disconnect a newer transport generation', async () => {
    vi.useFakeTimers()
    const controller = new UccncController({})
    try {
      const first = new MockBridgeTransport() as GenerationTransport
      first.autoHello = false
      const firstFailure = controller
        .connect({ kind: 'messages', transport: first })
        .then(() => null, (error: unknown) => error)
      await flushReceipts()

      first.emitClose('first transport closed before hello')
      expect(controller.connectionPhase()).toBe('disconnected')

      const second = new MockBridgeTransport() as GenerationTransport
      await controller.connect({ kind: 'messages', transport: second })
      second.emit({ t: 'status', v: status(30) })
      expect(controller.connectionPhase()).toBe('connected')

      await vi.advanceTimersByTimeAsync(HELLO_TIMEOUT_MS)
      expect(await firstFailure).toEqual(new Error('The machine bridge never sent its hello frame.'))
      expect(controller.connectionPhase()).toBe('connected')
      expect(controller.status().machinePos?.x).toBe(30)
      await controller.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidates prior session facts when reconnecting one installed UCCNC controller object', async () => {
    selectBridgeMachine()
    const machineId = controlMachine(useCamStore.getState()).id
    useCamStore.getState().updateMachineInLibrary(machineId, { noHomingSwitches: true })
    await session.connectMachine('bridge')
    const controller = session.getMachineController()
    expect(controller).toBeInstanceOf(UccncController)
    const first = bridge.instances[0]
    useMachineControl.setState({ activeWcs: 'G54' })
    session.zeroWorkAxes(['X'])
    const establishedZero = lastCall(first, 'zeroWorkAxis')
    first.reply(establishedZero, { ok: true, wcs: 'G54', axis: 'X', offset: { x: 5, y: 6, z: 7 } })
    await flushReceipts()
    expect(session.workGotoZeroRefusal(['X'])).toBeNull()

    session.zeroWorkAxes(['Y'])
    const staleZero = lastCall(first, 'zeroWorkAxis')
    session.__resetEstopInterlockForTest()
    await controller.disconnect()
    useCamStore.getState().setControlSessionMachine({
      ...controlMachine(useCamStore.getState()),
      controller: 'uccnc',
    })
    useMachineControl.getState().setConnectionKind('bridge')
    const second = new MockBridgeTransport() as GenerationTransport
    await controller.connect({ kind: 'messages', transport: second })
    second.emit({ t: 'status', v: status(30) })

    first.emit({ t: 'status', v: status(80, 'alarm') })
    first.emit({ t: 'phase', v: { phase: 'disconnected', version: 'old' } })
    first.emitClose('old close')
    first.reply(staleZero, { ok: true, wcs: 'G54', axis: 'Y', offset: { x: 50, y: 60, z: 70 } })
    await flushReceipts()

    expect(controller.connectionPhase()).toBe('connected')
    expect(controller.status().machinePos?.x).toBe(30)
    expect(useMachineControl.getState()).toMatchObject({
      connectionPhase: 'connected',
      connectionKind: 'bridge',
      mpos: status(30).machinePos,
    })
    // WO-1349 deliberately repins WO-1182: a reconnect is a fresh machine
    // session, so even an idle report must leave Operator's E-STOP latch armed.
    expect(session.estopNeedsReset()).toBe(true)
    expect(useCamStore.getState().machineWorkOffsets[controlMachine(useCamStore.getState()).id]?.G54?.offset)
      .toEqual({ x: 5 })
  })
})
