// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import {
  BridgeTransport,
  type BridgeMessage,
  type BridgeVfdPush,
} from '../../lib/machine/bridgeTransport'
import {
  createSpindleStopReasonWatcher,
  SPINDLE_STOP_REASON_TEXT,
} from '../../lib/machine/machineSession'

type StopReason = BridgeVfdPush['v']['lastStopReason']

function sample(running: boolean, lastStopReason: StopReason) {
  return { running, lastStopReason }
}

function warningEvents() {
  return useCamStore.getState().consoleEvents.filter((event) =>
    event.severity === 'warning' && event.source === 'machine')
}

function spindlePanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>('[data-spindle-panel]')
  if (!panel) throw new Error('spindle panel fixture is missing')
  return panel
}

function vfdMessage(running: boolean, lastStopReason: StopReason): BridgeVfdPush {
  return {
    t: 'vfd',
    v: {
      up: true,
      running,
      faulted: false,
      runStateWord: running ? 1 : 3,
      commandWord: 0,
      setpointWord: 0,
      consecutiveFailures: 0,
      lastStopReason,
      lastError: null,
      statusWords: [],
      status: {},
      upToSpeed: null,
    },
  }
}

class FakeWebSocket {
  static latest: FakeWebSocket | null = null
  readonly url: string
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.latest = this
  }

  send(): void {
    // This suite only observes inbound frames.
  }

  close(): void {
    this.onclose?.({ code: 1000, reason: '' } as CloseEvent)
  }

  open(): void {
    this.onopen?.()
  }

  push(message: BridgeMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

describe('WO-1108 spindle stop reason', () => {
  beforeEach(() => {
    useCamStore.setState({ consoleEvents: [] } as never)
    useMachineControl.setState({ consoleLines: [] })
    document.body.innerHTML = `
      <section class="control-panel" data-spindle-panel>
        <button data-testid="control-spindle-toggle"></button>
      </section>
      <section class="control-panel" data-other-panel title="other title"></section>
    `
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    FakeWebSocket.latest = null
    document.body.innerHTML = ''
  })

  it('warns once for a quiet-link stop and keeps its reason only on the stopped spindle control', () => {
    const watch = createSpindleStopReasonWatcher()

    watch(sample(true, 'none'))
    watch(sample(false, 'serialTimeout'))
    for (let frame = 0; frame < 10; frame++) watch(sample(false, 'serialTimeout'))

    expect(warningEvents()).toHaveLength(1)
    expect(warningEvents()[0]).toMatchObject({
      severity: 'warning',
      source: 'machine',
      message: SPINDLE_STOP_REASON_TEXT.serialTimeout,
    })
    expect(warningEvents()[0].message).toMatch(/inverter/i)
    expect(useMachineControl.getState().consoleLines).toHaveLength(1)
    expect(useMachineControl.getState().consoleLines[0]).toMatchObject({
      dir: 'rx',
      text: SPINDLE_STOP_REASON_TEXT.serialTimeout,
      severity: 'warn',
    })
    expect(spindlePanel().title).toBe(SPINDLE_STOP_REASON_TEXT.serialTimeout)
    expect(document.querySelector<HTMLElement>('[data-other-panel]')?.title).toBe('other title')
  })

  it('does not narrate a stop reason when this watcher never saw the spindle running', () => {
    const warning = vi.fn()
    const title = vi.fn()
    const watch = createSpindleStopReasonWatcher({ warning, title })

    watch(sample(false, 'serialTimeout'))
    watch(sample(false, 'serialTimeout'))

    expect(warning).not.toHaveBeenCalled()
    expect(title).toHaveBeenLastCalledWith(null)
  })

  it('baselines the first historical reason, then narrates one new stop after a run', () => {
    const warning = vi.fn()
    const title = vi.fn()
    const watch = createSpindleStopReasonWatcher({ warning, title })

    watch(sample(false, 'clientGone'))
    expect(warning).not.toHaveBeenCalled()

    watch(sample(true, 'clientGone'))
    watch(sample(false, 'serialTimeout'))
    watch(sample(false, 'serialTimeout'))

    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(SPINDLE_STOP_REASON_TEXT.serialTimeout)
  })

  it('keeps none and commanded silent and clears stale hover context', () => {
    const watch = createSpindleStopReasonWatcher()

    watch(sample(true, 'none'))
    watch(sample(false, 'serialTimeout'))
    expect(spindlePanel().hasAttribute('title')).toBe(true)

    watch(sample(true, 'serialTimeout'))
    expect(spindlePanel().hasAttribute('title')).toBe(false)
    watch(sample(false, 'commanded'))
    watch(sample(false, 'none'))

    expect(warningEvents()).toHaveLength(1)
    expect(spindlePanel().hasAttribute('title')).toBe(false)
  })

  it('warns again when a new run ends for the same reason', () => {
    const watch = createSpindleStopReasonWatcher()

    watch(sample(true, 'none'))
    watch(sample(false, 'clientGone'))
    watch(sample(false, 'clientGone'))
    watch(sample(true, 'clientGone'))
    watch(sample(false, 'clientGone'))

    expect(warningEvents().map((event) => event.message)).toEqual([
      SPINDLE_STOP_REASON_TEXT.clientGone,
      SPINDLE_STOP_REASON_TEXT.clientGone,
    ])
  })

  it.each([
    ['serialTimeout', 'inverter stopped answering'],
    ['clientGone', 'this app went quiet'],
    ['closing', 'bridge is closing'],
    ['refused', 'inverter refused'],
  ] as const)('translates %s into plain operator language', (reason, words) => {
    const warning = vi.fn()
    const title = vi.fn()
    const watch = createSpindleStopReasonWatcher({ warning, title })

    watch(sample(true, 'none'))
    watch(sample(false, reason))

    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(words))
    expect(title).toHaveBeenLastCalledWith(expect.stringContaining(words))
  })

  it('observes each raw VFD frame after forwarding it to the controller path', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const order: string[] = []
    const transport = new BridgeTransport(
      'ws://127.0.0.1:8321',
      null,
      (value) => order.push(`observer:${value.lastStopReason}`),
    )
    const started = transport.start({
      onMessage: (message) => order.push(`controller:${message.t}`),
      onClose: () => undefined,
    })
    const socket = FakeWebSocket.latest
    if (!socket) throw new Error('BridgeTransport did not create a WebSocket')
    socket.open()
    await started

    socket.push(vfdMessage(false, 'serialTimeout'))

    expect(order).toEqual(['controller:vfd', 'observer:serialTimeout'])
    await transport.close()
  })
})
