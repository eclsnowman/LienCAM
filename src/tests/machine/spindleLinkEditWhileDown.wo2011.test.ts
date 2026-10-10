// WO-2011 - a spindle-link edit while connected is refused only when the
// software cannot tell the spindle is stopped AND it could find out: a link the
// bridge holds. With no link held (hello declared none, or the bridge refused
// the definition and closed the port it opened for it), nothing can report the
// spindle and nothing reaches the inverter, so the edit is sent and the bridge
// retries the link from it. Every refusal this controller makes is said in the
// Control console (the controller's onConsole), not only returned.
//
// Machine seat, Operator's 09-25 session: the bridge refused the connect-time
// definition (missing run-state table, WO-2009), closed the link, and every
// later edit waited for a spindle status that could never arrive. Only
// Disconnect -> edit -> Connect got out.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'
import {
  CALL_TIMEOUT_MS,
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

const EDITED = {
  ...HUANYANG_GT,
  link: { ...HUANYANG_GT.link, slaveAddress: 6 },
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

  reply(call: BridgeCallMessage, value: unknown): void {
    this.emit({ t: 'reply', seq: call.seq, ok: true, v: value, error: undefined })
  }

  /** What Bridge.cs sends when it refuses a definition: its own console line,
   * then an ok frame carrying the refusal (VfdApplyRefusal). */
  refuse(call: BridgeCallMessage, reason: string): void {
    this.emit({
      t: 'console',
      v: { dir: 'rx', text: `[bridge] the spindle definition was refused: ${reason}`, severity: 'warn' },
    } as BridgeMessage)
    this.reply(call, { ok: false, reason, definition: null })
  }
}

function events(consoleLines: string[]): ControllerEvents {
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
      bridge: 'liencam-uccnc-bridge/wo-2011',
      capabilities: NO_CAPS,
      readOnly: false,
      vfd: present
        ? { present: true, verified: false, name: HUANYANG_GT.name, definition: HUANYANG_GT }
        : { present: false, verified: false, name: null, definition: null },
    },
  })
  await connecting
}

function vfdPush(up: boolean, runStateWord: number): Extract<BridgeMessage, { t: 'vfd' }> {
  const running = runStateWord === 1
  return {
    t: 'vfd',
    v: {
      up,
      running,
      faulted: false,
      runStateWord,
      commandWord: running ? 1 : 5,
      setpointWord: running ? 3333 : 0,
      consecutiveFailures: up ? 0 : 1,
      lastStopReason: 'none',
      lastError: up ? null : 'poll failed',
      statusWords: up ? [73, 18, 7999, 0, 9] : [],
      status: {},
      upToSpeed: null,
    },
  }
}

const RUNNING = 1
const STOPPED = 3

afterEach(() => {
  vi.useRealTimers()
})

describe('WO-2011: a down spindle link can be edited while connected', () => {
  it('link refused by the bridge at connect: the edit is sent at once, applies, and the link is retried', async () => {
    vi.useFakeTimers()
    const consoleLines: string[] = []
    const transport = new FakeTransport()
    const controller = new UccncController(events(consoleLines))
    await connect(controller, transport, false)

    // The connect-time push of the saved definition - the bridge opens the
    // port, cannot classify the run state, closes it and refuses.
    const sync = controller.applyVfdDefinition(HUANYANG_GT, { connectTimeSync: true })
    await vi.advanceTimersByTimeAsync(0)
    transport.refuse(
      transport.calls('applyVfdDefinition').at(-1)!,
      'the inverter reports an unrecognised code (3). The link was closed and no command was sent.',
    )
    await expect(sync).resolves.toMatchObject({ ok: false, definition: null })
    expect(controller.capabilities.spindleCommands).toBe(false)

    // The operator's edit, still connected, no spindle status will ever come.
    const edit = controller.applyVfdDefinition(EDITED)
    await vi.advanceTimersByTimeAsync(0)
    const retry = transport.calls('applyVfdDefinition')
    expect(retry).toHaveLength(2)
    expect(retry[1].a).toEqual({ definition: EDITED })

    transport.reply(retry[1], { definition: EDITED })
    await expect(edit).resolves.toMatchObject({ ok: true, error: null, definition: EDITED })
    expect(controller.capabilities.spindleCommands).toBe(true)
    expect(consoleLines.join('\n')).not.toContain('has not confirmed the spindle is stopped')
    await controller.disconnect()
  })

  it('link the bridge confirmed removed: the edit is sent without waiting for spindle status', async () => {
    vi.useFakeTimers()
    const consoleLines: string[] = []
    const transport = new FakeTransport()
    const controller = new UccncController(events(consoleLines))
    await connect(controller, transport, true)
    transport.emit(vfdPush(true, STOPPED))
    controller.confirmVfdLinkRemoved()

    const edit = controller.applyVfdDefinition(EDITED)
    await vi.advanceTimersByTimeAsync(0)
    const call = transport.calls('applyVfdDefinition').at(-1)
    expect(call?.a).toEqual({ definition: EDITED })
    transport.reply(call!, { definition: EDITED })
    await expect(edit).resolves.toMatchObject({ ok: true, definition: EDITED })
    await controller.disconnect()
  })

  it('link up and spindle reported running: refused, nothing sent, refusal in the Control console', async () => {
    vi.useFakeTimers()
    const consoleLines: string[] = []
    const transport = new FakeTransport()
    const controller = new UccncController(events(consoleLines))
    await connect(controller, transport, true)
    transport.emit(vfdPush(true, RUNNING))

    const edit = controller.applyVfdDefinition(EDITED)
    await vi.advanceTimersByTimeAsync(0)
    await expect(edit).resolves.toMatchObject({
      ok: false,
      error: 'The spindle is running. Stop it before changing the spindle link definition.',
      definition: null,
    })
    expect(transport.calls('applyVfdDefinition')).toHaveLength(0)
    expect(consoleLines).toContain(
      'Spindle link not changed - The spindle is running. Stop it before changing the spindle link definition.',
    )
    await controller.disconnect()
  })

  it('link held but no stopped report arrives: still refused after the wait, and said in the Control console', async () => {
    vi.useFakeTimers()
    const consoleLines: string[] = []
    const transport = new FakeTransport()
    const controller = new UccncController(events(consoleLines))
    await connect(controller, transport, true)

    const edit = controller.applyVfdDefinition(EDITED)
    await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1)
    expect(transport.calls('applyVfdDefinition')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await expect(edit).resolves.toMatchObject({ ok: false, definition: null })
    expect(transport.calls('applyVfdDefinition')).toHaveLength(0)
    expect(consoleLines.some((line) => line.startsWith('Spindle link not changed - ')
      && line.includes('has not confirmed the spindle is stopped'))).toBe(true)
    await controller.disconnect()
  })

  it('link held but not answering (up: false): still refused - a held link keeps the gate', async () => {
    vi.useFakeTimers()
    const consoleLines: string[] = []
    const transport = new FakeTransport()
    const controller = new UccncController(events(consoleLines))
    await connect(controller, transport, true)

    const edit = controller.applyVfdDefinition(EDITED)
    await vi.advanceTimersByTimeAsync(0)
    transport.emit(vfdPush(false, STOPPED))
    await expect(edit).resolves.toMatchObject({ ok: false, definition: null })
    expect(transport.calls('applyVfdDefinition')).toHaveLength(0)
    expect(consoleLines.some((line) => line.includes('has not confirmed the spindle is stopped'))).toBe(true)
    await controller.disconnect()
  })

  it('link up and stopped: the edit is sent (the gate admits a confirmed stop)', async () => {
    vi.useFakeTimers()
    const consoleLines: string[] = []
    const transport = new FakeTransport()
    const controller = new UccncController(events(consoleLines))
    await connect(controller, transport, true)
    transport.emit(vfdPush(true, STOPPED))

    const edit = controller.applyVfdDefinition(EDITED)
    await vi.advanceTimersByTimeAsync(0)
    const call = transport.calls('applyVfdDefinition').at(-1)
    expect(call?.a).toEqual({ definition: EDITED })
    transport.reply(call!, { definition: EDITED })
    await expect(edit).resolves.toMatchObject({ ok: true, definition: EDITED })
    expect(consoleLines.some((line) => line.startsWith('Spindle link not changed'))).toBe(false)
    await controller.disconnect()
  })
})
