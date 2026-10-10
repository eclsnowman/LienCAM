import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulatedController } from '../../lib/machine/simulatedController'
import {
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'
import type {
  ControllerCapabilities,
  ControllerEvents,
  MachineProgram,
  MachineStatus,
} from '../../lib/machine/controller'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'

const HOME_CONVENTION = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}

const BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: true,
  spindleCommands: false,
  machineProgram: true,
}

const OLD_BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: true,
  spindleCommands: false,
}

function events(): ControllerEvents {
  return {
    onStatus: vi.fn(),
    onParserState: vi.fn(),
    onConnectionPhase: vi.fn(),
    onConsole: vi.fn(),
    onClose: vi.fn(),
    onReady: vi.fn(),
    onJobEvent: vi.fn(),
    onJobProgress: vi.fn(),
    onHomed: vi.fn(),
    onAlarm: vi.fn(),
    onAccessories: vi.fn(),
    onSetting: vi.fn(),
  }
}

function machineProgram(steps: MachineProgram['steps']): MachineProgram {
  const index: MachineProgram['index'] = {}
  steps.forEach((step, moveOrdinal) => {
    index[step.id] = { opId: 'op-1', setupId: 'setup-1', moveOrdinal }
  })
  return { frame: 'work', units: 'mm', steps, index }
}

function threeMoveProgram(): MachineProgram {
  return machineProgram([
    { id: 1, kind: 'line', to: { x: 20 }, feedMmMin: 6000 },
    { id: 2, kind: 'line', to: { y: 20 }, feedMmMin: 6000 },
    { id: 3, kind: 'line', to: { z: 20 }, feedMmMin: 6000 },
  ])
}

async function simulated(): Promise<SimulatedController> {
  const controller = new SimulatedController(events(), {
    travelMm: { x: 300, y: 300, z: 100 },
    homeConvention: HOME_CONVENTION,
  })
  await controller.connect({ kind: 'none' })
  return controller
}

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []

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

  reply(seq: number): void {
    this.emit({ t: 'reply', seq, ok: true })
  }
}

async function uccnc(capabilities: ControllerCapabilities): Promise<{
  controller: UccncController
  transport: FakeTransport
}> {
  const controller = new UccncController(events())
  const transport = new FakeTransport()
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'wo-1030-fake',
      capabilities,
      readOnly: false,
    },
  })
  await connecting
  return { controller, transport }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('WO-1030 MachineProgram execution slice', () => {
  it('runs, reports progress, holds on pause, resumes, and stops on the simulator', async () => {
    const controller = await simulated()

    expect(controller.capabilities.machineProgram).toBe(true)
    expect(controller.loadProgram(threeMoveProgram())).toEqual({ ok: true, reason: null })
    expect(controller.programProgress()).toEqual({
      executingId: null,
      lastCompletedId: null,
      total: 3,
      queuedOnController: 0,
    })
    expect(controller.startJob()).toBe(true)

    await vi.advanceTimersByTimeAsync(60)
    expect(controller.programProgress()).toMatchObject({
      executingId: 1,
      lastCompletedId: null,
      total: 3,
    })

    controller.pauseJob()
    const heldAt = controller.status().machinePos as NonNullable<MachineStatus['machinePos']>
    await vi.advanceTimersByTimeAsync(500)
    expect(controller.status().machinePos).toEqual(heldAt)
    expect(controller.programProgress().executingId).toBe(1)

    expect(controller.resumeJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(150)
    expect(controller.programProgress()).toMatchObject({
      executingId: 2,
      lastCompletedId: 1,
      total: 3,
    })

    controller.stopJob()
    const stoppedAt = controller.status().machinePos
    await vi.advanceTimersByTimeAsync(500)
    expect(controller.status().machinePos).toEqual(stoppedAt)
    expect(controller.hasActiveJob()).toBe(false)
    expect(controller.programProgress()).toEqual({
      executingId: null,
      lastCompletedId: null,
      total: 0,
      queuedOnController: 0,
    })
  })

  it('refuses action steps by name without arming either backend', async () => {
    const program = machineProgram([
      { id: 1, kind: 'line', to: { x: 20 }, feedMmMin: 6000 },
      { id: 2, kind: 'spindle', direction: 'cw', rpm: 12000 },
    ])
    const simulator = await simulated()
    const bridge = await uccnc(BRIDGE_CAPABILITIES)

    expect(simulator.loadProgram(program)).toEqual({
      ok: false,
      reason: 'This program contains action steps; action steps are not wired yet.',
    })
    expect(simulator.hasActiveJob()).toBe(false)
    expect(bridge.controller.loadProgram(program)).toEqual({
      ok: false,
      reason: 'This program contains action steps; action steps are not wired yet.',
    })
    expect(bridge.transport.sent).toEqual([])
  })

  it.each([
    ['duplicate id', [
      { id: 1, kind: 'line' as const, to: { x: 20 }, feedMmMin: 6000 },
      { id: 1, kind: 'line' as const, to: { y: 20 }, feedMmMin: 6000 },
    ], /used more than once/],
    ['reserved id zero', [
      { id: 0, kind: 'line' as const, to: { x: 20 }, feedMmMin: 6000 },
    ], /reserved/],
    ['missing feed', [
      { id: 1, kind: 'line' as const, to: { x: 20 }, feedMmMin: 0 },
    ], /no feed rate/],
  ])('refuses a %s program with the validator reason', async (_name, steps, reason) => {
    const controller = await simulated()
    const result = controller.loadProgram(machineProgram(steps))

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(reason)
    expect(controller.hasActiveJob()).toBe(false)
    expect(controller.programProgress().total).toBe(0)
  })

  it('forwards validator refusals on UCCNC without sending anything', async () => {
    const { controller, transport } = await uccnc(BRIDGE_CAPABILITIES)
    const invalid = machineProgram([
      { id: 1, kind: 'line', to: { x: 20 }, feedMmMin: 6000 },
      { id: 1, kind: 'line', to: { y: 20 }, feedMmMin: 6000 },
    ])

    const result = controller.loadProgram(invalid)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/used more than once/)
    expect(transport.sent).toEqual([])
  })

  it('uses only the machineProgram hello key and sends loadMoves with the work frame', async () => {
    const oldBridge = await uccnc(OLD_BRIDGE_CAPABILITIES)
    expect(oldBridge.controller.capabilities.machineProgram).toBeFalsy()
    expect(oldBridge.controller.loadProgram(threeMoveProgram())).toEqual({
      ok: false,
      reason: 'This bridge does not understand geometry programs; update the bridge.',
    })
    expect(oldBridge.transport.sent).toEqual([])

    const currentBridge = await uccnc(BRIDGE_CAPABILITIES)
    expect(currentBridge.controller.capabilities.machineProgram).toBe(true)
    const program = threeMoveProgram()
    expect(currentBridge.controller.loadProgram(program)).toEqual({ ok: true, reason: null })
    expect(currentBridge.controller.programProgress().total).toBe(3)
    expect(currentBridge.transport.sent).toHaveLength(1)
    expect(currentBridge.transport.sent[0]).toMatchObject({ t: 'call', m: 'loadMoves' })
    expect(currentBridge.transport.sent[0].a).toEqual({
      moves: program.steps,
      frame: 'work',
    })
    currentBridge.transport.reply(currentBridge.transport.sent[0].seq)
  })
})
