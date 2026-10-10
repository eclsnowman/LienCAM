import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_INITIAL_CONNECT_RETRY_MS,
  BridgeTransport,
} from '../../lib/machine/bridgeTransport'

class FakeSocket {
  static instances: FakeSocket[] = []
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  closeCalls = 0
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(): void {}
  close(): void { this.closeCalls++ }
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  failError(): void { this.onerror?.() }
  failClose(code = 1006, reason = ''): void {
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

function captureFailure(promise: Promise<void>): Promise<Error> {
  return promise.then(
    () => { throw new Error('Expected bridge connection to fail.') },
    (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  )
}

describe('WO-1783 truthful bridge connection failure', () => {
  let original: unknown

  beforeEach(() => {
    vi.useFakeTimers()
    const global = globalThis as unknown as { WebSocket: unknown }
    original = global.WebSocket
    global.WebSocket = FakeSocket as unknown
    FakeSocket.instances = []
  })

  afterEach(() => {
    const global = globalThis as unknown as { WebSocket: unknown }
    global.WebSocket = original
    vi.useRealTimers()
  })

  it('keeps actual close facts when error and close arrive in either order', async () => {
    const transport = new BridgeTransport('ws://127.0.0.1:8325/')
    const failure = captureFailure(
      transport.start({ onMessage: () => undefined, onClose: () => undefined }),
    )

    const first = FakeSocket.instances[0]
    first.failError()
    first.failClose(1008, 'another machine-control session is connected')
    await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS)

    const retry = FakeSocket.instances[1]
    retry.failClose(1013, 'controller is still opening')
    retry.failError()

    expect((await failure).message).toBe(
      'Could not establish a machine bridge WebSocket at ws://127.0.0.1:8325/ after 2 attempts. '
      + 'First attempt: closed before a WebSocket session opened (code 1008: another machine-control session is connected). '
      + 'Retry: closed before a WebSocket session opened (code 1013: controller is still opening).',
    )
  })

  it('does not invent absence, refusal, a stopped process, or a Start-it remedy', async () => {
    const transport = new BridgeTransport('ws://127.0.0.1:8325/')
    const failure = captureFailure(
      transport.start({ onMessage: () => undefined, onClose: () => undefined }),
    )

    FakeSocket.instances[0].failError()
    FakeSocket.instances[0].failClose()
    await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS)
    FakeSocket.instances[1].failError()
    FakeSocket.instances[1].failClose()

    const message = (await failure).message
    expect(message).toContain('code 1006')
    expect(message).not.toMatch(/no machine bridge answered|not running|start it|refused/i)
  })

  it('keeps an established connection drop on the established-session path', async () => {
    const closes: (string | null)[] = []
    const transport = new BridgeTransport('ws://127.0.0.1:8325/')
    const started = transport.start({ onMessage: () => undefined, onClose: (reason) => closes.push(reason) })
    const socket = FakeSocket.instances[0]
    socket.open()
    await started

    socket.failClose(1006)
    expect(closes).toEqual(['the machine bridge disconnected'])
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
