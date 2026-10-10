import { describe, expect, it, vi } from 'vitest'
import { SimulatedController } from '../../lib/machine/simulatedController'
import {
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type {
  ControllerCapabilities,
  ControllerEvents,
  MachineController,
  MachineStatus,
} from '../../lib/machine/controller'

const NO_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

class WireTransport implements UccncTransport {
  private events: BridgeTransportEvents | null = null

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }

  send(_message: BridgeCallMessage): void {}

  async close(): Promise<void> {}

  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
}

async function connectedUccnc(events: ControllerEvents): Promise<{
  controller: UccncController
  transport: WireTransport
}> {
  const transport = new WireTransport()
  const controller = new UccncController(events)
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'wo1725-wire',
      capabilities: NO_CAPABILITIES,
      readOnly: false,
    },
  })
  await connecting
  return { controller, transport }
}

function uccncStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 10, y: 20, z: 30, a: 45 },
    workPos: { x: 1, y: 2, z: 3, a: 4 },
    feedMmMin: 0,
    spindleRpm: 0,
    overrides: null,
    executingMoveId: null,
    buffer: null,
    inputs: null,
    homed: { X: true, Y: true, Z: true, A: true },
    spindle: null,
  }
}

describe('WO-1725 rotary machine-position seam', () => {
  it('round-trips A through the real simulator controller and its status frame', async () => {
    const statuses: MachineStatus[] = []
    const homed: Array<readonly string[]> = []
    const controller = new SimulatedController({
      onStatus: (status) => statuses.push(status),
      onHomed: (axes) => { if (axes) homed.push(axes) },
    }, { controlAxes: ['X', 'Y', 'Z', 'A'] })

    await controller.connect({ kind: 'none' })
    try {
      const before = controller.status().machinePos
      expect(controller.setMachinePosition({ x: 10, y: 20, z: 30 })).toBe(false)
      expect(controller.status().machinePos).toEqual(before)

      expect(controller.setMachinePosition({ x: 10, y: 20, z: 30, a: 45 })).toBe(true)
      expect(controller.status().machinePos).toEqual({ x: 10, y: 20, z: 30, a: 45 })
      expect(controller.status().workPos).toEqual({ x: 10, y: 20, z: 30, a: 45 })
      expect(controller.homedAxesThisSession()).toEqual({ X: true, Y: true, Z: true })
      expect(controller.status().homed).toEqual({ X: true, Y: true, Z: true, A: true })
      expect(homed).toEqual([['X', 'Y', 'Z', 'A']])
      expect(statuses.at(-1)?.machinePos).toEqual({ x: 10, y: 20, z: 30, a: 45 })
    } finally {
      await controller.disconnect()
    }
  })

  it('keeps A live through Cartesian motion ticks and a hard-limit stop', async () => {
    vi.useFakeTimers()
    const controller = new SimulatedController({}, {
      controlAxes: ['X', 'Y', 'Z', 'A'],
      travelMm: { x: 100, y: 100, z: 100 },
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'min', machineZeroAt: 'min' },
      },
      limitWiring: { X: { minus: false, plus: true } },
    })

    await controller.connect({ kind: 'none' })
    try {
      expect(controller.setMachinePosition({ x: 10, y: 20, z: 30, a: 45 })).toBe(true)
      expect(controller.jog('X', 90, 6_000)).toBe(true)

      await vi.advanceTimersByTimeAsync(50)
      expect(controller.status().machinePos).toEqual({ x: 15, y: 20, z: 30, a: 45 })

      await vi.advanceTimersByTimeAsync(850)
      expect(controller.machineState()).toBe('alarm')
      expect(controller.status().machinePos).toEqual({ x: 100, y: 20, z: 30, a: 45 })
    } finally {
      await controller.disconnect()
      vi.useRealTimers()
    }
  })

  // Audit round 2: a Z touch-off is the first thing done before a job, and the
  // probe contact point is a bare {x,y,z}. Assigning it deleted A for good -
  // finishProbe re-bases the target from that position, so it never came back
  // and both A cells went inert.
  it('keeps A live through a Z probe touch-off', async () => {
    vi.useFakeTimers()
    const controller = new SimulatedController({}, {
      controlAxes: ['X', 'Y', 'Z', 'A'],
      travelMm: { x: 100, y: 100, z: 100 },
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'min', machineZeroAt: 'min' },
      },
    })

    await controller.connect({ kind: 'none' })
    try {
      expect(controller.setMachinePosition({ x: 10, y: 20, z: 30, a: 45 })).toBe(true)
      const touch = controller.probe('Z', -60, 60_000)
      await vi.advanceTimersByTimeAsync(60_000)
      await touch

      const after = controller.status().machinePos
      expect(after).not.toBeNull()
      expect(after!.a).toBe(45)
      expect(after!.x).toBe(10)
      expect(after!.y).toBe(20)
    } finally {
      await controller.disconnect()
      vi.useRealTimers()
    }
  })

  it('preserves rotary position and homed truth from a UCCNC wire status frame', async () => {
    const statuses: MachineStatus[] = []
    const { controller, transport } = await connectedUccnc({
      onStatus: (status) => statuses.push(status),
    })
    const status = uccncStatus()

    transport.emit({ t: 'status', v: status })

    expect(controller.status()).toEqual(status)
    expect(statuses).toEqual([status])
    expect(controller.homedAxesThisSession()).toEqual({ X: true, Y: true, Z: true })
    expect((controller as MachineController).setMachinePosition).toBeUndefined()
    await controller.disconnect()
  })
})
