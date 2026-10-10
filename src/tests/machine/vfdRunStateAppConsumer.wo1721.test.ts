// WO-1721 - app-side run-state classification follows the definition which
// the bridge confirmed for this exact link. No model-name or numeric fallback.

import { describe, expect, it } from 'vitest'
import {
  VfdPortLink,
  vfdSpindleTurning,
  type BridgeCallMessage,
  type BridgeMessage,
  type BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'
import {
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import type { VfdDefinition, VfdRunStateValue } from '../../lib/machine/vfd/vfdDefinition'

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

const ALTERNATE_VALUES: VfdRunStateValue[] = [
  { value: 0, meaning: 'stopped' },
  { value: 1, meaning: 'running' },
  { value: 7, meaning: 'faulted' },
]

function definition(name: string, values?: VfdRunStateValue[]): VfdDefinition {
  const result = structuredClone(HUANYANG_GT)
  result.id = name.toLowerCase().replaceAll(' ', '-')
  result.name = name
  if (values === undefined) delete result.registers.runState.values
  else result.registers.runState.values = values
  return result
}

const ALTERNATE = definition('Alternate stopped-zero drive', ALTERNATE_VALUES)
const HOT_APPLY = definition('Hot-applied meanings', [
  { value: 0, meaning: 'running' },
  { value: 7, meaning: 'faulted' },
  { value: 9, meaning: 'stopped' },
])

function vfd(word: number, options: { up?: boolean; port?: string | null } = {}): Extract<BridgeMessage, { t: 'vfd' }> {
  return {
    t: 'vfd',
    v: {
      up: options.up ?? true,
      running: false,
      faulted: false,
      runStateWord: word,
      commandWord: 5,
      setpointWord: 0,
      consecutiveFailures: 0,
      lastStopReason: 'commanded',
      lastError: null,
      statusWords: [],
      status: {},
      upToSpeed: null,
      ...('port' in options ? { port: options.port } : {}),
    },
  }
}

function hello(
  present: boolean,
  declared: VfdDefinition | null,
): Extract<BridgeMessage, { t: 'hello' }> {
  return {
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/wo-1721',
      capabilities: NO_CAPS,
      readOnly: false,
      vfd: present
        ? { present: true, verified: false, name: declared?.name ?? 'Unknown drive', definition: declared }
        : { present: false, verified: false, name: null, definition: null },
    },
  }
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
}

function controllerEvents(): ControllerEvents {
  return {
    onConsole: () => {},
    onStatus: () => {},
    onJobEvent: () => {},
    onHomed: () => {},
    onAlarm: () => {},
  }
}

async function connectController(
  controller: UccncController,
  transport: FakeTransport,
  present: boolean,
  declared: VfdDefinition | null,
): Promise<void> {
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit(hello(present, declared))
  await connecting
}

async function answerApply(
  controller: UccncController,
  transport: FakeTransport,
  candidate: VfdDefinition,
  connectTimeSync = false,
): Promise<void> {
  const before = transport.calls('applyVfdDefinition').length
  const pending = controller.applyVfdDefinition(candidate, { connectTimeSync })
  await Promise.resolve()
  const calls = transport.calls('applyVfdDefinition')
  expect(calls).toHaveLength(before + 1)
  expect(calls.at(-1)?.a.definition).toEqual(candidate)
  transport.reply(calls.at(-1)!, { definition: candidate })
  await expect(pending).resolves.toMatchObject({ ok: true, definition: candidate })
}

describe('WO-1721 shared app run-state classifier', () => {
  it('matches native meaning semantics for Operator and a different definition', () => {
    expect(vfdSpindleTurning(vfd(1).v, HUANYANG_GT)).toBe(true)
    expect(vfdSpindleTurning(vfd(2).v, HUANYANG_GT)).toBe(true)
    expect(vfdSpindleTurning(vfd(3).v, HUANYANG_GT)).toBe(false)
    expect(vfdSpindleTurning(vfd(4).v, HUANYANG_GT)).toBeNull()
    expect(vfdSpindleTurning(vfd(5).v, HUANYANG_GT)).toBeNull()

    expect(vfdSpindleTurning(vfd(0).v, ALTERNATE)).toBe(false)
    expect(vfdSpindleTurning(vfd(1).v, ALTERNATE)).toBe(true)
    expect(vfdSpindleTurning(vfd(7).v, ALTERNATE)).toBeNull()
    expect(vfdSpindleTurning(vfd(99).v, ALTERNATE)).toBeNull()
    expect(vfdSpindleTurning(vfd(0, { up: false }).v, ALTERNATE)).toBeNull()
    expect(vfdSpindleTurning(vfd(3).v, definition('No table'))).toBeNull()
    expect(vfdSpindleTurning(vfd(3).v, null)).toBeNull()
  })

  it('uses only the confirmed document through hello, hot apply, port replacement, removal and reconnect', async () => {
    const calls: BridgeCallMessage[] = []
    const link = new VfdPortLink((message) => calls.push(message), () => {}, 100, 'alternate-machine')

    link.handleFrame(hello(true, HUANYANG_GT))
    link.handleFrame(vfd(0, { port: 'COM3' }))
    expect(link.state().spindleTurning).toBeNull()

    // An editor draft is not a machine fact. Only the confirmed publish seam
    // changes which table decodes later frames from this link.
    const draft = ALTERNATE
    expect(draft.registers.runState.values?.[0]).toEqual({ value: 0, meaning: 'stopped' })
    link.handleFrame(vfd(0))
    expect(link.state().spindleTurning).toBeNull()
    link.publishApplied(draft)
    link.handleFrame(vfd(0))
    expect(link.state().spindleTurning).toBe(false)

    const moving = link.selectPort('COM4')
    const moveCall = calls.at(-1)!
    expect(moveCall.m).toBe('setVfdPort')
    link.handleFrame({ t: 'reply', seq: moveCall.seq, ok: true, v: true, error: undefined })
    await expect(moving).resolves.toEqual({ ok: true, error: null })
    link.handleFrame(vfd(0, { port: 'COM4' }))
    expect(link.state()).toMatchObject({ reportedPort: 'COM4', spindleTurning: false, applied: draft })

    link.publishApplied(HOT_APPLY)
    link.handleFrame(vfd(0))
    expect(link.state().spindleTurning).toBe(true)
    link.handleFrame(vfd(9))
    expect(link.state().spindleTurning).toBe(false)

    const removing = link.clearDefinition()
    const removeCall = calls.at(-1)!
    expect(removeCall.m).toBe('applyVfdDefinition')
    link.handleFrame({
      t: 'reply', seq: removeCall.seq, ok: true, v: { ok: true, definition: null }, error: undefined,
    })
    await expect(removing).resolves.toEqual({ ok: true, error: null })
    link.handleFrame(vfd(9))
    expect(link.state()).toMatchObject({ linkPresent: false, applied: null, spindleTurning: null })

    link.close()
    const reconnected = new VfdPortLink(() => {}, () => {}, 100, 'alternate-machine')
    reconnected.handleFrame(hello(true, HUANYANG_GT))
    reconnected.handleFrame(vfd(9))
    expect(reconnected.state().spindleTurning).toBeNull()
  })
})

describe('WO-1721 controller applies the table confirmed for its live link', () => {
  it('uses hello state, then a checked apply receipt, and refuses running/faulted/unknown words', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(controllerEvents())
    await connectController(controller, transport, true, ALTERNATE)

    transport.emit(vfd(0))
    await answerApply(controller, transport, HOT_APPLY)

    transport.emit(vfd(9))
    await answerApply(controller, transport, ALTERNATE)

    for (const word of [1, 7, 99]) {
      transport.emit(vfd(word))
      const before = transport.calls('applyVfdDefinition').length
      const result = await controller.applyVfdDefinition(HOT_APPLY)
      expect(result.ok).toBe(false)
      expect(transport.calls('applyVfdDefinition')).toHaveLength(before)
      expect(result.error).toMatch(word === 1 ? /spindle is running/i : /not confirmed.*stopped/i)
    }

    // STOP remains a direct wire call even when the state word is unknown.
    controller.spindleOff()
    expect(transport.calls('spindleOff')).toHaveLength(1)
    await controller.disconnect()
  })

  it('preserves the no-link connect-time creation route without guessing stopped', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(controllerEvents())
    await connectController(controller, transport, false, null)

    await answerApply(controller, transport, ALTERNATE, true)
    transport.emit(vfd(0))
    await answerApply(controller, transport, HOT_APPLY)
    await controller.disconnect()
  })
})
