import { describe, expect, it } from 'vitest'
import { SUPPORTED_BRIDGE_PROTOCOL, UccncController } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'

const NO_TEXT: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: true,
  spindleCommands: false,
}

const TEXT_REFUSAL = 'This controller takes geometry, not G-code text - nothing was loaded.'

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

  replyAll(): void {
    for (const call of this.sent) {
      this.emit({ t: 'reply', seq: call.seq, ok: true, v: { ok: true, message: null } })
    }
  }
}

function recorder(): ControllerEvents & {
  consoles: Array<{ dir: string; text: string; severity: string }>
} {
  const consoles: Array<{ dir: string; text: string; severity: string }> = []
  return {
    consoles,
    onConsole: (line) => consoles.push(line),
  }
}

async function connect(gcodeText: boolean) {
  const transport = new FakeTransport()
  const events = recorder()
  const controller = new UccncController(events)
  const connecting = controller.connect({ kind: 'messages', transport })
  await Promise.resolve()
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/wo-1021',
      capabilities: { ...NO_TEXT, gcodeText },
      readOnly: false,
    },
  })
  await connecting
  return { controller, events, transport }
}

describe('WO-1021: a controller without a text path refuses text locally', () => {
  it('lets connection state outrank capability refusal', () => {
    const events = recorder()
    const controller = new UccncController(events)

    expect(controller.sendCommand('G10 L20 P0 X0')).toBe(false)
    expect(controller.sendCommandAwait('G38.2 Z-10 F100')).toBeNull()
    expect(events.consoles).toEqual([])
  })

  it('refuses both text entry points without sending and reports each refusal once', async () => {
    const { controller, events, transport } = await connect(false)

    expect(controller.sendCommand('G10 L20 P0 X0')).toBe(false)
    await expect(controller.sendCommandAwait('G38.2 Z-10 F100')).resolves.toEqual({
      ok: false,
      message: TEXT_REFUSAL,
    })

    expect(transport.sent).toEqual([])
    expect(events.consoles).toHaveLength(2)
    expect(events.consoles[0]).toMatchObject({ dir: 'rx', severity: 'error' })
    expect(events.consoles[0].text).toContain('sendCommand')
    expect(events.consoles[0].text).toContain(TEXT_REFUSAL)
    expect(events.consoles[0].text).toContain('G10 L20 P0 X0')
    expect(events.consoles[1]).toMatchObject({ dir: 'rx', severity: 'error' })
    expect(events.consoles[1].text).toContain('sendCommandAwait')
    expect(events.consoles[1].text).toContain(TEXT_REFUSAL)
    expect(events.consoles[1].text).toContain('G38.2 Z-10 F100')
  })

  it('preserves both text paths when a future bridge declares them', async () => {
    const { controller, events, transport } = await connect(true)

    expect(controller.sendCommand('G10 L20 P0 X0')).toBe(true)
    const awaited = controller.sendCommandAwait('G38.2 Z-10 F100')
    expect(awaited).not.toBeNull()
    expect(transport.sent.map((call) => [call.m, call.a])).toEqual([
      ['sendCommand', { text: 'G10 L20 P0 X0' }],
      ['sendCommandAwait', { text: 'G38.2 Z-10 F100' }],
    ])

    transport.replyAll()
    await expect(awaited).resolves.toEqual({ ok: true, message: null })
    expect(events.consoles).toEqual([])
  })

  it('does not gate stop or reset calls when text is unavailable', async () => {
    const { controller, transport } = await connect(false)

    controller.stopJob()
    controller.feedHold()
    controller.reset()
    controller.spindleOff()
    controller.emergencyStop()

    expect(transport.sent.map((call) => call.m)).toEqual([
      'stopJob',
      'feedHold',
      'reset',
      'spindleOff',
      'emergencyStop',
    ])
    transport.replyAll()
  })
})
