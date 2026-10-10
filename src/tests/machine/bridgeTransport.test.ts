// BridgeTransport - the WebSocket JSON message channel to a machine-local
// bridge process. The far end can move a machine, so the loopback guard is a
// safety test, not a style test. See docs/machine/BRIDGE-PROTOCOL.md.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  BRIDGE_INITIAL_CONNECT_RETRY_MS,
  BridgeTransport,
  bridgeUrl,
  isLoopbackWsUrl,
  BRIDGE_DEFAULT_PORT,
} from '../../lib/machine/bridgeTransport'
import type { BridgeTransportEvents } from '../../lib/machine/bridgeTransport'

class FakeSocket {
  static last: FakeSocket | null = null
  static instances: FakeSocket[] = []
  static OPEN = 1
  readyState = 0
  binaryType = ''
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((e: { reason: string }) => void) | null = null
  closeCalls = 0

  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.last = this
    FakeSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closeCalls++
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
}

function installFakeSocket() {
  const g = globalThis as unknown as { WebSocket: unknown }
  const original = g.WebSocket
  g.WebSocket = FakeSocket as unknown
  return () => {
    g.WebSocket = original
  }
}

function events(): BridgeTransportEvents & { messages: unknown[]; closes: (string | null)[] } {
  const messages: unknown[] = []
  const closes: (string | null)[] = []
  return {
    messages,
    closes,
    onMessage: (m) => messages.push(m),
    onClose: (r) => closes.push(r),
  }
}

describe('BridgeTransport loopback guard', () => {
  it('accepts the default loopback url', () => {
    expect(bridgeUrl()).toBe(`ws://127.0.0.1:${BRIDGE_DEFAULT_PORT}/`)
    expect(isLoopbackWsUrl(bridgeUrl())).toBe(true)
    expect(isLoopbackWsUrl('ws://localhost:8325/')).toBe(true)
  })

  it('refuses any host that is not this computer', () => {
    for (const url of [
      'ws://192.0.2.17:8325/',
      'ws://192.0.2.12:8325/',
      'ws://shop-pc.local:8325/',
      'wss://example.com/bridge',
      'http://127.0.0.1:8325/',
      'not a url',
    ]) {
      expect(isLoopbackWsUrl(url), url).toBe(false)
      expect(() => new BridgeTransport(url), url).toThrow(/only be reached on this computer/i)
    }
  })
})

describe('BridgeTransport message channel', () => {
  let restore: () => void
  beforeEach(() => {
    restore = installFakeSocket()
    FakeSocket.last = null
    FakeSocket.instances = []
  })
  afterEach(() => restore())

  it('decodes a JSON text frame into a message for onMessage', async () => {
    const t = new BridgeTransport()
    const ev = events()
    const started = t.start(ev)
    FakeSocket.last!.open()
    await started

    FakeSocket.last!.onmessage?.({ data: '{"t":"status","v":{"state":"idle"}}' })
    expect(ev.messages[0]).toEqual({ t: 'status', v: { state: 'idle' } })
  })

  it('drops a malformed frame instead of throwing', async () => {
    const t = new BridgeTransport()
    const ev = events()
    const started = t.start(ev)
    FakeSocket.last!.open()
    await started

    FakeSocket.last!.onmessage?.({ data: 'not json' })
    expect(ev.messages).toEqual([])
  })

  it('ignores a binary frame - the protocol is text-only', async () => {
    const t = new BridgeTransport()
    const ev = events()
    const started = t.start(ev)
    FakeSocket.last!.open()
    await started

    FakeSocket.last!.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer })
    expect(ev.messages).toEqual([])
  })

  it('sends a call frame as one JSON text frame', async () => {
    const t = new BridgeTransport()
    const ev = events()
    const started = t.start(ev)
    FakeSocket.last!.open()
    await started

    t.send({ t: 'call', seq: 1, m: 'jog', a: { axis: 'X', deltaMm: 5, feedMmMin: 1200 } })
    expect(FakeSocket.last!.sent[0]).toEqual(
      JSON.stringify({ t: 'call', seq: 1, m: 'jog', a: { axis: 'X', deltaMm: 5, feedMmMin: 1200 } }),
    )
  })

  it('retries once after the bounded window, then reports only known facts', async () => {
    // WO-1783 two-attempt contract: a bare pre-handshake onerror is not a
    // diagnosis. The transport waits the close-detail grace, schedules exactly
    // one fresh same-URL WebSocket at the measured 6000ms lockout window, and
    // only after that attempt fails does start() reject - truthfully, with no
    // invented absence/refusal claim and no third socket.
    vi.useFakeTimers()
    try {
      const t = new BridgeTransport()
      const url = bridgeUrl()
      const started = t.start(events())
      // Attach the rejection observer BEFORE advancing time so the final
      // two-attempt rejection can never surface as an unhandled rejection.
      const failure = started.then(
        () => { throw new Error('Expected bridge connection to fail.') },
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      )

      const first = FakeSocket.instances[0]
      first.onerror?.()
      await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS - 1)
      expect(FakeSocket.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeSocket.instances).toHaveLength(2)
      expect(FakeSocket.instances[1].url).toBe(url)

      const retry = FakeSocket.instances[1]
      retry.onerror?.()
      await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS)
      expect(FakeSocket.instances).toHaveLength(2)

      const message = (await failure).message
      expect(message).toContain('after 2 attempts')
      expect(message).toContain(url)
      expect(message).toContain('First attempt: the handshake did not complete')
      expect(message).toContain('Retry: the handshake did not complete')
      expect(message).not.toMatch(/no machine bridge answered|not running|start it|refused/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fires onClose exactly once, however it is closed', async () => {
    const t = new BridgeTransport()
    const ev = events()
    const started = t.start(ev)
    FakeSocket.last!.open()
    await started

    const socket = FakeSocket.last!
    await t.close()
    socket.onclose?.({ reason: 'late close event' })
    await t.close()

    expect(ev.closes).toEqual(['disconnect requested'])
  })

  it('surfaces an unexpected drop as a close reason', async () => {
    const t = new BridgeTransport()
    const ev = events()
    const started = t.start(ev)
    FakeSocket.last!.open()
    await started

    FakeSocket.last!.onclose?.({ reason: '' })
    expect(ev.closes).toEqual(['the machine bridge disconnected'])
  })

  it('refuses to send before start', () => {
    const t = new BridgeTransport()
    expect(() => t.send({ t: 'call', seq: 1, m: 'jog', a: {} })).toThrow(/not started/i)
  })
})
