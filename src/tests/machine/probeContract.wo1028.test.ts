import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ControllerCapabilities,
  MachineStatus,
} from '../../lib/machine/controller'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import { GrblController } from '../../lib/machine/grbl/controller'
import { SimulatedController } from '../../lib/machine/simulatedController'
import {
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'
import { FakeBytePipe } from '../helpers/fakeBytePipe'

const START = { x: 5, y: 5, z: -5 }
const TARGET_Z = -100
const CONTACT = { x: 5, y: 5, z: -40 }
const SIMULATOR_START = { x: -5, y: -5, z: -5 }
const SIMULATOR_CONTACT = { x: -5, y: -5, z: -97 }
const FEED = 6000

const NO_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

const KNOWN_STATUS: MachineStatus = {
  state: 'idle',
  subState: null,
  machinePos: START,
  workPos: START,
  feedMmMin: 0,
  spindleRpm: 0,
  overrides: null,
  executingMoveId: null,
  buffer: null,
  inputs: null,
  homed: null,
  spindle: null,
}

class ProbeBridgeTransport implements UccncTransport {
  private events: BridgeTransportEvents | null = null
  readonly sent: BridgeCallMessage[] = []

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }

  send(message: BridgeCallMessage): void {
    this.sent.push(message)
  }

  async close(): Promise<void> {}

  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }

  lastCall(method: string): BridgeCallMessage {
    const call = this.sent.filter((candidate) => candidate.m === method).at(-1)
    if (!call) throw new Error(`No ${method} call was sent.`)
    return call
  }
}

async function connectBridge(): Promise<{
  controller: UccncController
  transport: ProbeBridgeTransport
}> {
  const controller = new UccncController({})
  const transport = new ProbeBridgeTransport()
  const pending = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'probe-contract-test',
      capabilities: NO_CAPABILITIES,
      readOnly: false,
    },
  })
  await pending
  transport.emit({ t: 'status', v: KNOWN_STATUS })
  return { controller, transport }
}

async function connectGrbl(): Promise<{
  controller: GrblController
  pipe: FakeBytePipe
}> {
  const controller = new GrblController({})
  const pipe = new FakeBytePipe()
  const pending = controller.connect({ kind: 'bytes', transport: pipe })
  await vi.advanceTimersByTimeAsync(0)
  pipe.feed("Grbl 1.1h ['$' for help]\r\n")
  await pending
  pipe.clearWritten()
  return { controller, pipe }
}

function reportKnownGrblPosition(pipe: FakeBytePipe): void {
  pipe.feed('<Idle|MPos:5.000,5.000,-5.000|FS:0,0>\r\n')
  pipe.clearWritten()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('WO-1028 absolute machine-frame probe contract', () => {
  it('the native simulator treats targetMm as an absolute machine target and returns machine coordinates', async () => {
    const controller = new SimulatedController({}, {
      part: {
        origin: { x: -10, y: -10 },
        sizeX: 10,
        sizeY: 10,
        topZ: SIMULATOR_CONTACT.z,
        height: 10,
        bowMm: 0,
        noiseMm: 0,
      },
    })
    await controller.connect({ kind: 'none' })
    expect(controller.status().machinePos).toEqual(SIMULATOR_START)
    expect(controller.jog('Z', 10, FEED)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(controller.status().machinePos).toEqual({ ...SIMULATOR_START, z: 5 })

    const pending = controller.probe('Z', TARGET_Z, FEED)
    await vi.advanceTimersByTimeAsync(1100)

    await expect(pending).resolves.toEqual({ ok: true, at: SIMULATOR_CONTACT })
    await controller.disconnect()
  })

  it('the bridge sends the absolute machine target unchanged and returns its machine-frame readback', async () => {
    const { controller, transport } = await connectBridge()

    const pending = controller.probe('Z', TARGET_Z, FEED)
    const call = transport.lastCall('probe')
    expect(call.a).toEqual({ axis: 'Z', targetMm: TARGET_Z, feedMmMin: FEED })
    transport.emit({ t: 'reply', seq: call.seq, ok: true, v: { ok: true, at: CONTACT } })

    await expect(pending).resolves.toEqual({ ok: true, at: CONTACT })
    await controller.disconnect()
  })

  it('GRBL converts the absolute machine target to relative G91 travel and returns [PRB] machine coordinates', async () => {
    const { controller, pipe } = await connectGrbl()
    pipe.feed('<Idle|MPos:5.000,5.000,-5.000|FS:0,0>\r\n')
    pipe.clearWritten()

    const pending = controller.probe('Z', TARGET_Z, FEED)
    await vi.advanceTimersByTimeAsync(0)
    expect(pipe.writtenItems()).toContain('G21 G91 G38.2 Z-95 F6000')

    pipe.feed('[PRB:5.000,5.000,-40.000:1]\r\nok\r\n')
    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toEqual({ ok: true, at: CONTACT })
    expect(pipe.writtenItems()).toContain('G90')
    await controller.disconnect()
  })

  it('GRBL restores G90 when the probe command cannot be queued after a machine position is known', async () => {
    const { controller, pipe } = await connectGrbl()
    reportKnownGrblPosition(pipe)
    const sendCommandAwait = vi.fn(() => null)
    const failureController = controller as unknown as {
      sendCommandAwait: typeof sendCommandAwait
    }
    failureController.sendCommandAwait = sendCommandAwait

    await expect(controller.probe('Z', TARGET_Z, FEED)).resolves.toEqual({
      ok: false,
      at: null,
    })

    expect(sendCommandAwait).toHaveBeenCalledWith('G21 G91 G38.2 Z-95 F6000')
    expect(pipe.writtenItems()).toContain('G90')
    await controller.disconnect()
  })

  it('GRBL restores G90 when the controller rejects the probe command after a machine position is known', async () => {
    const { controller, pipe } = await connectGrbl()
    reportKnownGrblPosition(pipe)
    const sendCommandAwait = vi.fn(() => Promise.resolve({ ok: false, message: 'error:9' }))
    const failureController = controller as unknown as {
      sendCommandAwait: typeof sendCommandAwait
    }
    failureController.sendCommandAwait = sendCommandAwait

    await expect(controller.probe('Z', TARGET_Z, FEED)).resolves.toEqual({
      ok: false,
      at: null,
    })

    expect(sendCommandAwait).toHaveBeenCalledWith('G21 G91 G38.2 Z-95 F6000')
    expect(pipe.writtenItems()).toContain('G90')
    await controller.disconnect()
  })

  it('GRBL restores G90 when an accepted probe reports no contact before timeout', async () => {
    const { controller, pipe } = await connectGrbl()
    reportKnownGrblPosition(pipe)

    const pending = controller.probe('Z', TARGET_Z, FEED)
    await vi.advanceTimersByTimeAsync(0)
    expect(pipe.writtenItems()).toContain('G21 G91 G38.2 Z-95 F6000')
    pipe.feed('ok\r\n')
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(pending).resolves.toEqual({ ok: false, at: null })
    expect(pipe.writtenItems()).toContain('G90')
    await controller.disconnect()
  })

  it('GRBL refuses with a named reason when no machine position has been reported', async () => {
    const { controller, pipe } = await connectGrbl()

    await expect(controller.probe('Z', TARGET_Z, FEED)).resolves.toEqual({
      ok: false,
      at: null,
      reason: 'Cannot probe without a reported machine position.',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(pipe.writtenItems()).toContain('G90')
    expect(pipe.writtenItems().some((line) => line.includes('G38.2'))).toBe(false)
    await controller.disconnect()
  })
})
