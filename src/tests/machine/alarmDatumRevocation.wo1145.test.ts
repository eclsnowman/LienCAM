import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import {
  unhomedAxes,
  type ControllerCapabilities,
  type ControllerEvents,
  type MachineStatus,
} from '../../lib/machine/controller'
import { GrblController, type GrblControllerEvents } from '../../lib/machine/grbl/controller'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'
import {
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const STATUS: MachineStatus = {
  state: 'idle',
  subState: null,
  machinePos: { x: 0, y: 0, z: 0 },
  workPos: { x: 0, y: 0, z: 0 },
  feedMmMin: 0,
  spindleRpm: 0,
  overrides: null,
  executingMoveId: null,
  buffer: null,
  inputs: null,
  homed: { X: true, Y: true, Z: true },
  spindle: null,
}

class FakeGrblTransport implements MachineTransport {
  private events: TransportEvents | null = null

  async start(events: TransportEvents): Promise<void> {
    this.events = events
  }

  async write(): Promise<void> {}

  async close(): Promise<void> {}

  feed(text: string): void {
    this.events?.onChunk(new TextEncoder().encode(text))
  }
}

class FakeUccncTransport implements UccncTransport {
  private events: BridgeTransportEvents | null = null
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
}

async function connectedGrbl(onAlarm?: GrblControllerEvents['onAlarm']) {
  const transport = new FakeGrblTransport()
  const controller = new GrblController({ onAlarm })
  const connecting = controller.connect({ kind: 'bytes', transport })
  await vi.advanceTimersByTimeAsync(0)
  transport.feed("Grbl 1.1h ['$' for help]\n")
  await connecting
  return { controller, transport }
}

async function connectUccnc(controller: UccncController) {
  const transport = new FakeUccncTransport()
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'WO-1145 fake bridge',
      capabilities: CAPABILITIES,
      readOnly: false,
    },
  })
  await connecting
  return { controller, transport }
}

async function connectedUccnc(events: ControllerEvents = {}) {
  return connectUccnc(new UccncController(events))
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('WO-1145 GRBL position-lost alarms revoke the datum', () => {
  it.each([1, 3, 9])(
    'revokes before publishing ALARM:%i and stays revoked through unlock and idle',
    async (code) => {
      let controller!: GrblController
      const publishedState: Array<{ homed: boolean; axes: object | undefined }> = []
      const connected = await connectedGrbl(() => {
        publishedState.push({
          homed: controller.homedThisSession(),
          axes: controller.homedAxesThisSession?.(),
        })
      })
      controller = connected.controller

      expect(controller.home()).toBe(true)
      connected.transport.feed('ok\n')
      expect(controller.homedThisSession()).toBe(true)

      connected.transport.feed(`ALARM:${code}\n`)

      expect(publishedState).toEqual([
        { homed: false, axes: { X: false, Y: false, Z: false } },
      ])
      expect(controller.homedThisSession()).toBe(false)
      expect(controller.homedAxesThisSession()).toEqual({ X: false, Y: false, Z: false })
      expect(unhomedAxes(controller)).toEqual(['X', 'Y', 'Z'])

      expect(controller.unlock()).toBe(true)
      connected.transport.feed('ok\n')
      connected.transport.feed('<Idle|MPos:0,0,0>\n')
      expect(unhomedAxes(controller)).toEqual(['X', 'Y', 'Z'])

      expect(controller.home()).toBe(true)
      connected.transport.feed('ok\n')
      expect(controller.homedAxesThisSession()).toEqual({ X: true, Y: true, Z: true })
    },
  )

  it('retains a valid datum for ALARM:2', async () => {
    const { controller, transport } = await connectedGrbl()
    expect(controller.home()).toBe(true)
    transport.feed('ok\n')

    transport.feed('ALARM:2\n')

    expect(controller.homedThisSession()).toBe(true)
    expect(controller.homedAxesThisSession()).toEqual({ X: true, Y: true, Z: true })
    expect(unhomedAxes(controller)).toEqual([])
  })
})

describe('WO-1145 UCCNC position-lost alarms revoke the datum', () => {
  it('revokes before publication, rejects stale status, and restores only homed axes', async () => {
    let controller!: UccncController
    const publishedAxes: object[] = []
    const connected = await connectedUccnc({
      onAlarm: () => publishedAxes.push(controller.homedAxesThisSession()),
    })
    controller = connected.controller
    connected.transport.emit({ t: 'status', v: STATUS })
    expect(controller.homedThisSession()).toBe(true)

    connected.transport.emit({
      t: 'alarm',
      v: { code: 1, message: 'Hard limit', positionLost: true },
    })

    expect(publishedAxes).toEqual([{ X: false, Y: false, Z: false }])
    expect(unhomedAxes(controller)).toEqual(['X', 'Y', 'Z'])

    connected.transport.emit({ t: 'status', v: STATUS })
    expect(controller.homedAxesThisSession()).toEqual({ X: false, Y: false, Z: false })

    connected.transport.emit({ t: 'homed', v: { axes: ['Z'] } })
    connected.transport.emit({ t: 'status', v: STATUS })
    expect(controller.homedAxesThisSession()).toEqual({ X: false, Y: false, Z: true })
    expect(unhomedAxes(controller)).toEqual(['X', 'Y'])

    connected.transport.emit({ t: 'homed', v: { axes: ['X', 'Y'] } })
    expect(controller.homedAxesThisSession()).toEqual({ X: true, Y: true, Z: true })
    expect(unhomedAxes(controller)).toEqual([])
  })

  it('retains a valid datum for a position-retained alarm and drops it on disconnect', async () => {
    const { controller, transport } = await connectedUccnc()
    transport.emit({ t: 'status', v: STATUS })

    transport.emit({
      t: 'alarm',
      v: { code: 2, message: 'Position retained', positionLost: false },
    })

    expect(controller.homedAxesThisSession()).toEqual({ X: true, Y: true, Z: true })
    await controller.disconnect()
    expect(controller.homedAxesThisSession()).toEqual({})
    expect(controller.homedThisSession()).toBe(false)
  })
})
