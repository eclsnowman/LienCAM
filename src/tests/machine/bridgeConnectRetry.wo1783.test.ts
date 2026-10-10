// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import nodeProcess from 'node:process'
import {
  BRIDGE_INITIAL_CONNECT_RETRY_MS,
  BridgeTransport,
  type BridgeMessage,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import * as session from '../../lib/machine/machineSession'

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

class FakeSocket {
  static instances: FakeSocket[] = []
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []
  closeCalls = 0
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(value: string): void { this.sent.push(value) }
  close(): void { this.closeCalls++ }
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  emit(message: BridgeMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
  hello(): void {
    this.emit({
      t: 'hello',
      v: {
        protocol: 1,
        bridge: 'old-pinned-bridge',
        capabilities: CAPABILITIES,
        readOnly: false,
      },
    })
  }
  fail(code = 1006, reason = ''): void {
    this.onerror?.()
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

const PORT_A = 20_000 + ((nodeProcess.pid * 19 + 1783) % 10_000)
const PORT_B = PORT_A + 1
let originalWebSocket: unknown

function setBridgePort(port: number): void {
  const machineId = useCamStore.getState().project.machine.id
  useUiPrefs.setState({ machineLinks: { [machineId]: { bridgePort: port } } })
}

async function settleConnected(socket: FakeSocket): Promise<void> {
  socket.open()
  socket.hello()
  await vi.advanceTimersByTimeAsync(0)
}

function captureFailure(promise: Promise<void>): Promise<Error> {
  return promise.then(
    () => { throw new Error('Expected bridge connection to fail.') },
    (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  )
}

beforeEach(async () => {
  vi.useFakeTimers()
  const global = globalThis as unknown as { WebSocket: unknown }
  originalWebSocket = global.WebSocket
  global.WebSocket = FakeSocket as unknown
  FakeSocket.instances = []
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  setBridgePort(PORT_A)
})

afterEach(async () => {
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
  const global = globalThis as unknown as { WebSocket: unknown }
  global.WebSocket = originalWebSocket
  vi.useRealTimers()
})

describe('WO-1783 bounded initial bridge retry', () => {
  it('adds no delay and no second socket when the first connection succeeds', async () => {
    // WO-1783 review gate: the success assertion must be owned by this
    // transport, not by a process-wide timer census. Other store machinery
    // (autosave debounce, watchdogs) legitimately holds pending fake timers
    // on some platforms, so "global count is zero" is not a portable oracle.
    // This unrelated timer is deliberately left pending through every
    // assertion below - it is never cleared early to make a check pass - and
    // is removed normally in the cleanup at the end.
    let unrelatedTimerFired = false
    const unrelatedTimer = setTimeout(() => { unrelatedTimerFired = true },
      BRIDGE_INITIAL_CONNECT_RETRY_MS * 3)
    const timersBeforeStart = vi.getTimerCount()

    const transport = new BridgeTransport(`ws://127.0.0.1:${PORT_A}/`)
    const started = transport.start({ onMessage: () => undefined, onClose: () => undefined })
    // First start resolves with NO fake-time advance at all: the open event
    // itself settles it, so a successful connect adds no delay.
    FakeSocket.instances[0].open()
    await started

    // Exactly one same-URL socket exists. The transport also left no timer
    // of its own pending: within this zero-time-advance window only the
    // transport could have changed the census, so it must still equal the
    // snapshot taken immediately before transport.start.
    expect(FakeSocket.instances.map((socket) => socket.url)).toEqual([
      `ws://127.0.0.1:${PORT_A}/`,
    ])
    expect(vi.getTimerCount()).toBe(timersBeforeStart)

    // Behavior owned by this transport: advancing through two full retry
    // windows creates no second socket. If the success path ever leaked a
    // retry timer, it would fire here and open a second WebSocket.
    await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS * 2)
    expect(FakeSocket.instances).toHaveLength(1)

    // The unrelated fixture is still pending (it sits at 3 windows, only 2
    // advanced): isolation was proven by the snapshot comparison, not by
    // clearing global timers early. Clean it up normally.
    expect(unrelatedTimerFired).toBe(false)
    clearTimeout(unrelatedTimer)
  })

  it('recovers through connectMachine after the old-bridge lockout window with one same-URL socket', async () => {
    const connected = session.connectMachine('bridge')
    expect(FakeSocket.instances).toHaveLength(1)
    FakeSocket.instances[0].fail(1008, 'readiness client still owns the bridge')

    await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS - 1)
    expect(FakeSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(FakeSocket.instances[1].url).toBe(FakeSocket.instances[0].url)

    await settleConnected(FakeSocket.instances[1])
    await connected
    expect(session.getMachineController().connectionPhase()).toBe('connected')
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('bounds repeated refusal at exactly two WebSockets', async () => {
    const transport = new BridgeTransport(`ws://127.0.0.1:${PORT_A}/`)
    const failed = captureFailure(
      transport.start({ onMessage: () => undefined, onClose: () => undefined }),
    )
    FakeSocket.instances[0].fail(1008, 'second session refused')
    await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS)
    FakeSocket.instances[1].fail(1008, 'second session refused')

    expect((await failed).message).toContain('after 2 attempts')
    await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS * 2)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('explicit disconnect cancels the wait and creates no retry socket', async () => {
    const connecting = session.connectMachine('bridge')
    FakeSocket.instances[0].fail()
    await session.disconnectMachine()
    await connecting

    await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(session.getMachineController().connectionPhase()).toBe('disconnected')
  })

  it('a newer URL/generation cancels the old wait and ignores its late callbacks', async () => {
    const oldConnect = session.connectMachine('bridge')
    const oldSocket = FakeSocket.instances[0]
    oldSocket.fail()
    setBridgePort(PORT_B)

    const replacement = session.connectMachine('bridge')
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeSocket.instances).toHaveLength(2)
    const replacementSocket = FakeSocket.instances[1]
    expect(replacementSocket.url).toBe(`ws://127.0.0.1:${PORT_B}/`)
    await settleConnected(replacementSocket)
    await replacement
    await oldConnect

    oldSocket.open()
    oldSocket.hello()
    await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(session.getMachineController().connectionPhase()).toBe('connected')
  })

  it('page shutdown cancels a pending attempt and its retry', async () => {
    const transport = new BridgeTransport(`ws://127.0.0.1:${PORT_A}/`)
    const stopped = captureFailure(
      transport.start({ onMessage: () => undefined, onClose: () => undefined }),
    )
    FakeSocket.instances[0].fail()
    window.dispatchEvent(new Event('pagehide'))

    expect((await stopped).message).toBe('Machine bridge connection cancelled.')
    await vi.advanceTimersByTimeAsync(BRIDGE_INITIAL_CONNECT_RETRY_MS)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
