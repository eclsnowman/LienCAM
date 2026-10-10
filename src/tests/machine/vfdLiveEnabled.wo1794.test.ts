// WO-1794 - hello is the first VFD fact, not a permanent latch. A definition
// accepted later in the same bridge session owns configured/enabled state;
// subsequent vfd pushes own reachability and fault state.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'
import {
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import { VFD_LINK_QUIET_STOP_MS } from '../../lib/machine/vfd/vfdSafety'

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
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

  calls(method: string): BridgeCallMessage[] {
    return this.sent.filter((message) => message.m === method)
  }

  reply(call: BridgeCallMessage, value: unknown = true): void {
    this.emit({ t: 'reply', seq: call.seq, ok: true, v: value, error: undefined })
  }
}

function events(consoleLines: string[] = []): ControllerEvents {
  return {
    onConsole: (entry) => consoleLines.push(entry.text),
    onStatus: () => {},
    onJobEvent: () => {},
    onHomed: () => {},
    onAlarm: () => {},
  }
}

async function connect(
  controller: UccncController,
  transport: FakeTransport,
  present: boolean,
): Promise<void> {
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/wo-1794',
      capabilities: NO_CAPS,
      readOnly: false,
      vfd: present
        ? {
            present: true,
            verified: false,
            name: HUANYANG_GT.name,
            definition: HUANYANG_GT,
          }
        : { present: false, verified: false, name: null, definition: null },
    },
  })
  await connecting
}

function vfdPush(
  up: boolean,
  faulted = false,
  running = false,
): Extract<BridgeMessage, { t: 'vfd' }> {
  return {
    t: 'vfd',
    v: {
      up,
      running,
      faulted,
      runStateWord: faulted ? 4 : (running ? 1 : 3),
      commandWord: running ? 1 : 5,
      setpointWord: running ? 3333 : 0,
      consecutiveFailures: up ? 0 : 1,
      lastStopReason: 'none',
      lastError: up ? null : 'poll failed',
      statusWords: up && !faulted ? [73, 18, 7999, 0, 9] : [],
      status: {},
      upToSpeed: null,
    },
  }
}

async function applyDefinition(controller: UccncController, transport: FakeTransport): Promise<void> {
  const pending = controller.applyVfdDefinition(HUANYANG_GT, { connectTimeSync: true })
  await Promise.resolve()
  const call = transport.calls('applyVfdDefinition').at(-1)
  if (!call) throw new Error('Expected applyVfdDefinition on the wire.')
  transport.reply(call, { definition: HUANYANG_GT })
  await expect(pending).resolves.toMatchObject({ ok: true, definition: HUANYANG_GT })
}

function answerLatestSpindleCall(transport: FakeTransport, method: 'spindleOn' | 'spindleOff'): void {
  const call = transport.calls(method).at(-1)
  if (!call) throw new Error(`Expected ${method} on the wire.`)
  transport.reply(call)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WO-1794: live VFD state replaces the connect-time hello latch', () => {
  it('accepts false hello -> definition receipt -> live up -> normal spindle command', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connect(controller, transport, false)

    expect(controller.capabilities.spindleCommands).toBe(false)
    await applyDefinition(controller, transport)
    expect(controller.capabilities.spindleCommands).toBe(true)

    transport.emit(vfdPush(true))
    expect(controller.spindleOn('cw', 8000)).toBe(true)
    expect(transport.calls('spindleOn')).toHaveLength(1)
    expect(transport.calls('spindleOn')[0].a).toEqual({ direction: 'cw', setpointWord: 3333 })
    expect(transport.calls('spindleOff')).toHaveLength(0)

    answerLatestSpindleCall(transport, 'spindleOn')
    await controller.disconnect()
  })

  it('keeps live down and quiet state separate from configured/enabled state', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connect(controller, transport, false)
    await applyDefinition(controller, transport)
    transport.emit(vfdPush(true))

    expect(controller.spindleOn('cw', 8000)).toBe(true)
    answerLatestSpindleCall(transport, 'spindleOn')
    await vi.advanceTimersByTimeAsync(400)
    transport.emit(vfdPush(false))
    expect(controller.capabilities.spindleCommands).toBe(true)
    expect(transport.calls('spindleOff')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(VFD_LINK_QUIET_STOP_MS - 399)
    expect(transport.calls('spindleOff')).toHaveLength(1)
    answerLatestSpindleCall(transport, 'spindleOff')

    transport.emit(vfdPush(true, true))
    expect(controller.vfdReadings()).toEqual({})
    expect(controller.capabilities.spindleCommands).toBe(true)
    await controller.disconnect()
  })

  it('retires definition state on removal while leaving STOP available', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connect(controller, transport, false)
    await applyDefinition(controller, transport)
    transport.emit(vfdPush(true))
    expect(controller.vfdReadings()).not.toEqual({})

    controller.confirmVfdLinkRemoved()
    expect(controller.capabilities.spindleCommands).toBe(false)
    expect(controller.vfdReadings()).toEqual({})
    expect(controller.spindleOn('cw', 8000)).toBe(false)
    expect(transport.calls('spindleOn')).toHaveLength(0)

    controller.spindleOff()
    expect(transport.calls('spindleOff')).toHaveLength(1)
    answerLatestSpindleCall(transport, 'spindleOff')
    await controller.disconnect()
  })

  it('resets replacement observations and ignores late frames from a retired connection', async () => {
    vi.useFakeTimers()
    const first = new FakeTransport()
    const controller = new UccncController(events())
    await connect(controller, first, true)
    first.emit(vfdPush(true))
    expect(controller.vfdReadings()).not.toEqual({})

    await applyDefinition(controller, first)
    expect(controller.vfdReadings()).toEqual({})
    first.emit(vfdPush(true))
    expect(controller.vfdReadings()).not.toEqual({})

    await controller.disconnect()
    expect(controller.capabilities.spindleCommands).toBe(false)
    expect(controller.vfdReadings()).toEqual({})

    const second = new FakeTransport()
    await connect(controller, second, false)
    first.emit(vfdPush(true))
    expect(controller.capabilities.spindleCommands).toBe(false)
    expect(controller.vfdReadings()).toEqual({})

    await applyDefinition(controller, second)
    second.emit(vfdPush(true))
    expect(controller.spindleOn('cw', 8000)).toBe(true)
    expect(first.calls('spindleOn')).toHaveLength(0)
    expect(second.calls('spindleOn')).toHaveLength(1)
    answerLatestSpindleCall(second, 'spindleOn')
    await controller.disconnect()
  })
})
