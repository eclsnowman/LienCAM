import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_KEEPALIVE_MS,
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
} from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'

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
  sent: Array<{ at: number; call: BridgeCallMessage }> = []

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }

  send(call: BridgeCallMessage): void {
    this.sent.push({ at: Date.now(), call })
  }

  async close(): Promise<void> {}

  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
}

function noopEvents(): ControllerEvents {
  return {
    onStatus: () => {},
    onConsole: () => {},
    onJobEvent: () => {},
    onHomed: () => {},
    onAlarm: () => {},
  }
}

function emitHello(transport: FakeTransport): void {
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'wo-1111-worker-test',
      capabilities: NO_CAPS,
      readOnly: false,
    },
  })
}

describe('the bridge keepalive in a hidden tab', () => {
  const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('document', { visibilityState: 'hidden' })

    // Capture the fake-timer functions as the Worker's independent clock, then
    // stall the page's setInterval. This models the browser condition that
    // caused the defect while still allowing six minutes to pass instantly.
    const workerSetInterval = globalThis.setInterval.bind(globalThis)
    const workerClearInterval = globalThis.clearInterval.bind(globalThis)

    class FakeWorker {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null
      private timer: ReturnType<typeof setInterval> | null = null

      postMessage(message: { type: string; intervalMs?: number }): void {
        if (message.type === 'stop') {
          this.stopTimer()
          return
        }
        if (message.type === 'start' && message.intervalMs !== undefined) {
          this.stopTimer()
          this.timer = workerSetInterval(() => {
            this.onmessage?.({ data: 'tick' } as MessageEvent<unknown>)
          }, message.intervalMs)
        }
      }

      terminate(): void {
        this.stopTimer()
      }

      private stopTimer(): void {
        if (this.timer === null) return
        workerClearInterval(this.timer)
        this.timer = null
      }
    }

    vi.stubGlobal('Worker', FakeWorker)
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:wo-1111-worker'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    vi.spyOn(globalThis, 'setInterval').mockImplementation(
      () => 1 as unknown as ReturnType<typeof setInterval>,
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    if (originalCreateObjectUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl)
    else delete (URL as { createObjectURL?: unknown }).createObjectURL
    if (originalRevokeObjectUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl)
    else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
  })

  it('keeps the 750 ms cadence for six hidden minutes while page intervals are stalled', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(noopEvents())
    const connecting = controller.connect({ kind: 'messages', transport })
    emitHello(transport)
    await connecting
    transport.sent.length = 0

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000)

    expect(document.visibilityState).toBe('hidden')
    expect(transport.sent).toHaveLength((6 * 60 * 1000) / BRIDGE_KEEPALIVE_MS)
    expect(transport.sent.every(({ call }) => call.m === 'queryStatus')).toBe(true)
    const gaps = transport.sent.slice(1).map((frame, index) => frame.at - transport.sent[index].at)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(BRIDGE_KEEPALIVE_MS - 50)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(BRIDGE_KEEPALIVE_MS + 50)
    expect(globalThis.setInterval).not.toHaveBeenCalled()

    await controller.disconnect()
  })

  it('waits for hello, stops on disconnect, and restarts after reconnect', async () => {
    const controller = new UccncController(noopEvents())
    const firstTransport = new FakeTransport()
    const firstConnect = controller.connect({ kind: 'messages', transport: firstTransport })

    await vi.advanceTimersByTimeAsync(BRIDGE_KEEPALIVE_MS * 3)
    expect(firstTransport.sent).toEqual([])

    emitHello(firstTransport)
    await firstConnect
    await vi.advanceTimersByTimeAsync(BRIDGE_KEEPALIVE_MS * 2)
    expect(firstTransport.sent).toHaveLength(2)

    await controller.disconnect()
    firstTransport.sent.length = 0
    await vi.advanceTimersByTimeAsync(BRIDGE_KEEPALIVE_MS * 2)
    expect(firstTransport.sent).toEqual([])

    const secondTransport = new FakeTransport()
    const secondConnect = controller.connect({ kind: 'messages', transport: secondTransport })
    emitHello(secondTransport)
    await secondConnect
    await vi.advanceTimersByTimeAsync(BRIDGE_KEEPALIVE_MS)
    expect(secondTransport.sent.map(({ call }) => call.m)).toEqual(['queryStatus'])

    await controller.disconnect()
  })
})
