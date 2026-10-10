// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PendantBridgeClient,
  type PendantCommand,
  type PendantCommandExecutor,
  type PendantWebSocketFactory,
} from '../../lib/machine/pendantBridge'

class FakeSocket {
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  closeCalls = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }

  close() {
    this.closeCalls++
    this.readyState = 3
  }

  open() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  receive(message: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
  }
}

function command(requestId: string, clientId: string, intent: PendantCommand) {
  return { type: 'command', requestId, clientId, command: intent }
}

describe('PendantBridgeClient', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('authenticates the desktop and publishes status only after broker acknowledgement', () => {
    const socket = new FakeSocket()
    const bridge = new PendantBridgeClient(vi.fn(), (() => socket) as PendantWebSocketFactory)
    bridge.enable('ws://127.0.0.1:8324/bridge', '1234567890abcdef')
    expect(bridge.snapshot().phase).toBe('connecting')
    socket.open()
    expect(socket.sent).toContainEqual({ type: 'hello', role: 'desktop', pairingToken: '1234567890abcdef' })
    expect(socket.sent.some((entry) => entry.type === 'status')).toBe(false)

    socket.receive({ type: 'hello-ack', role: 'desktop', lanIps: ['192.0.2.14'], port: 8324 })
    expect(bridge.snapshot()).toMatchObject({ phase: 'connected', lanIps: ['192.0.2.14'], brokerPort: 8324 })
    expect(socket.sent.some((entry) => entry.type === 'status')).toBe(true)
    expect(socket.sent.find((entry) => entry.type === 'status')).toMatchObject({
      data: { theme: 'default', colorMode: 'dark' },
    })
    socket.receive({ type: 'clients', connectedPendants: 2 })
    expect(bridge.snapshot().connectedPendants).toBe(2)
    bridge.disable()
  })

  it('serializes ordinary commands while feed hold bypasses the queue', async () => {
    const socket = new FakeSocket()
    let releaseFirst!: () => void
    const order: string[] = []
    const executor: PendantCommandExecutor = vi.fn(async (intent) => {
      order.push(`start:${intent.kind}`)
      if (intent.kind === 'jog-step') await new Promise<void>((resolve) => { releaseFirst = resolve })
      order.push(`end:${intent.kind}`)
      return { ok: true }
    })
    const bridge = new PendantBridgeClient(executor, (() => socket) as PendantWebSocketFactory)
    bridge.enable('ws://127.0.0.1:8324/bridge', '1234567890abcdef')
    socket.open()
    socket.receive({ type: 'hello-ack', role: 'desktop' })
    socket.receive(command('one', 'phone-a', { kind: 'jog-step', axis: 'X', deltaMm: 1, feedMmMin: 500 }))
    socket.receive(command('two', 'phone-b', { kind: 'zero-axes', axes: ['X'] }))
    await vi.waitFor(() => expect(order).toEqual(['start:jog-step']))
    socket.receive(command('stop', 'phone-b', { kind: 'feed-hold' }))
    await vi.waitFor(() => expect(order).toContain('end:feed-hold'))
    expect(order).not.toContain('start:zero-axes')
    releaseFirst()
    await vi.waitFor(() => expect(order).toContain('end:zero-axes'))
    expect(bridge.snapshot().lastActivity).toBe('Remote zero-axes accepted.')
    bridge.disable()
  })

  it('renews one continuous jog without queueing motion and cancels it on the desktop watchdog', async () => {
    const socket = new FakeSocket()
    const executed: PendantCommand[] = []
    const bridge = new PendantBridgeClient(
      async (intent) => {
        executed.push(intent)
        return { ok: true }
      },
      (() => socket) as PendantWebSocketFactory,
    )
    bridge.enable('ws://127.0.0.1:8324/bridge', '1234567890abcdef')
    socket.open()
    socket.receive({ type: 'hello-ack', role: 'desktop' })
    const jog: PendantCommand = { kind: 'jog-continuous', axis: 'Y', direction: 1, feedMmMin: 800 }
    socket.receive(command('j1', 'phone-a', jog))
    await vi.waitFor(() => expect(executed).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(200)
    socket.receive(command('j2', 'phone-a', jog))
    await vi.advanceTimersByTimeAsync(300)
    expect(executed.filter((entry) => entry.kind === 'jog-continuous')).toHaveLength(1)
    expect(executed.some((entry) => entry.kind === 'jog-cancel')).toBe(false)
    await vi.advanceTimersByTimeAsync(51)
    expect(executed.at(-1)).toEqual({ kind: 'jog-cancel' })
    bridge.disable()
  })

  it.each([
    ['renews', true],
    ['still cancels on disable', false],
  ])('WO-2468: a late refusal of an earlier press of the same button leaves the newer hold alone - %s', async (_label, renew) => {
    const socket = new FakeSocket()
    const executed: PendantCommand[] = []
    let refuseOldPress!: () => void
    const bridge = new PendantBridgeClient(
      async (intent) => {
        executed.push(intent)
        const starts = executed.filter((entry) => entry.kind === 'jog-continuous').length
        if (intent.kind === 'jog-continuous' && starts === 1) {
          await new Promise<void>((resolve) => { refuseOldPress = resolve })
          return { ok: false, error: 'The controller refused the jog.' }
        }
        return { ok: true }
      },
      (() => socket) as PendantWebSocketFactory,
    )
    bridge.enable('ws://127.0.0.1:8324/bridge', '1234567890abcdef')
    socket.open()
    socket.receive({ type: 'hello-ack', role: 'desktop' })
    const jog: PendantCommand = { kind: 'jog-continuous', axis: 'X', direction: 1, feedMmMin: 800 }
    socket.receive(command('old-press', 'phone-a', jog))
    socket.receive(command('release', 'phone-a', { kind: 'jog-cancel' }))
    await vi.waitFor(() => expect(executed.map((entry) => entry.kind)).toEqual(['jog-continuous', 'jog-cancel']))
    socket.receive(command('new-press', 'phone-a', jog))
    await vi.waitFor(() => expect(executed).toHaveLength(3))
    refuseOldPress()
    await vi.waitFor(() => expect(socket.sent).toContainEqual(expect.objectContaining({ requestId: 'old-press', ok: false })))

    if (renew) {
      socket.receive(command('new-keepalive', 'phone-a', jog))
      await vi.advanceTimersByTimeAsync(0)
      expect(socket.sent).toContainEqual(expect.objectContaining({ requestId: 'new-keepalive', ok: true }))
      expect(executed.map((entry) => entry.kind)).toEqual(['jog-continuous', 'jog-cancel', 'jog-continuous'])
    } else {
      bridge.disable()
      expect(executed.map((entry) => entry.kind)).toEqual(['jog-continuous', 'jog-cancel', 'jog-continuous', 'jog-cancel'])
    }
    bridge.disable()
  })

  it('rejects malformed commands before they reach the machine executor', async () => {
    const socket = new FakeSocket()
    const executor = vi.fn(async () => ({ ok: true }))
    const bridge = new PendantBridgeClient(executor, (() => socket) as PendantWebSocketFactory)
    bridge.enable('ws://127.0.0.1:8324/bridge', '1234567890abcdef')
    socket.open()
    socket.receive({ type: 'hello-ack', role: 'desktop' })
    socket.receive({ type: 'command', requestId: 'bad', clientId: 'phone-a', command: { kind: 'raw-gcode', line: 'G0 X10' } })
    await Promise.resolve()
    expect(executor).not.toHaveBeenCalled()
    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'command-result', requestId: 'bad', clientId: 'phone-a', ok: false,
    }))
    bridge.disable()
  })
})
