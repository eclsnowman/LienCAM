// WO-915 - the live apply: change a pin, apply, jog, watch which axis moves.
//
// Tested against a mock bridge, the same way every other bridge behaviour is
// (WO-421): no bridge process is needed because the protocol IS the contract.
// What CANNOT be tested here is what the controller does with the values -
// that lives in Machine.cs and needs hardware. This file pins down the browser
// half: that the definition crosses the wire UNTRANSLATED, that a refusal
// never reaches the wire at all, and that "homed" is dropped whenever the
// bridge says what the position counter means has changed.

import { describe, it, expect, vi } from 'vitest'
import {
  UccncController,
  SUPPORTED_BRIDGE_PROTOCOL,
  APPLY_DEFINITION_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
} from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type {
  BridgeApplyDefinitionReply,
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'
import {
  createDefaultControllerDefinition,
  type ControllerDefinition,
} from '../../types'

const CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  closeCalls = 0

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }
  send(message: BridgeCallMessage): void {
    this.sent.push(message)
  }
  async close(): Promise<void> {
    this.closeCalls++
  }
  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
  reply(seq: number, ok: boolean, v?: unknown, error?: string): void {
    this.emit({ t: 'reply', seq, ok, v, error })
  }
  calls(m: string): BridgeCallMessage[] {
    return this.sent.filter((c) => c.m === m)
  }
  lastCall(m: string): BridgeCallMessage {
    const found = this.calls(m)
    const last = found[found.length - 1]
    if (!last) throw new Error(`no call sent for "${m}"`)
    return last
  }
}

function helloMessage(readOnly = false): BridgeMessage {
  return {
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.4',
      capabilities: CAPS,
      readOnly,
    },
  }
}

async function connected(
  events: ControllerEvents = {},
  readOnly = false,
): Promise<{ controller: UccncController; transport: FakeTransport }> {
  const controller = new UccncController(events)
  const transport = new FakeTransport()
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit(helloMessage(readOnly))
  await connecting
  return { controller, transport }
}

/** A definition with real wiring in it, built from the shipped defaults so the
 *  test tracks WO-912's shape rather than a hand-copy of it. */
function wiredDefinition(): ControllerDefinition {
  const def = createDefaultControllerDefinition(['X', 'Y', 'Z'])
  const x = def.axes[0]
  x.stepPin = { port: 1, pin: 15, negate: false }
  x.dirPin = { port: 1, pin: 16, negate: true }
  x.homePin = { port: 2, pin: 1, negate: false }
  x.stepsPerUnit = 400
  const y = def.axes[1]
  y.stepPin = { port: 1, pin: 13, negate: false }
  y.dirPin = { port: 1, pin: 14, negate: false }
  y.slaveAxis = 'A'
  def.io.estop = { port: 2, pin: 6, negate: true }
  return def
}

function bridgeReply(over: Partial<BridgeApplyDefinitionReply> = {}): BridgeApplyDefinitionReply {
  return {
    ok: true,
    error: null,
    configuredThisSession: true,
    reHome: [],
    lines: [{ text: '[bridge] axis X applied and read back: step=10', severity: 'info' }],
    ...over,
  }
}

describe('WO-915 the live apply - what crosses the wire', () => {
  it('sends the definition to the bridge VERBATIM - the app never translates a pin', async () => {
    const { controller, transport } = await connected()
    const definition = wiredDefinition()
    const pending = controller.applyMachineDefinition(definition)
    const call = transport.lastCall('applyMachineDefinition')
    transport.reply(call.seq, true, bridgeReply())
    await pending

    // Deep equality against the object handed in: anything that rewrote a pin
    // on the way out - a lookup, a fallback, a "helpful" normalisation - fails
    // here. THE PIN RULE (WO-912): a pin is carried, not computed.
    expect(call.a).toEqual({ definition })
    const sentX = (call.a.definition as ControllerDefinition).axes[0]
    expect(sentX.stepPin).toEqual({ port: 1, pin: 15, negate: false })
    expect(sentX.dirPin).toEqual({ port: 1, pin: 16, negate: true })
  })

  it('carries a pin as (port, pin) only - no UC pin number appears on the wire', async () => {
    const { controller, transport } = await connected()
    const pending = controller.applyMachineDefinition(wiredDefinition())
    const call = transport.lastCall('applyMachineDefinition')
    transport.reply(call.seq, true, bridgeReply())
    await pending

    // Every pin-shaped object on the frame has exactly the three keys WO-912
    // declares. A translated pin would have to arrive as a fourth key or as a
    // replaced number, and both are caught here.
    const frame = JSON.parse(JSON.stringify(call.a)) as Record<string, unknown>
    const pins: Record<string, unknown>[] = []
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      const obj = node as Record<string, unknown>
      if ('port' in obj && 'pin' in obj) pins.push(obj)
      for (const value of Object.values(obj)) walk(value)
    }
    walk(frame)
    expect(pins.length).toBeGreaterThan(0)
    for (const pin of pins) {
      expect(Object.keys(pin).sort()).toEqual(['negate', 'pin', 'port'])
    }
  })

  it('is declared as a capability by presence, so a backend without it is asked nothing', async () => {
    const { controller } = await connected()
    expect(typeof controller.applyMachineDefinition).toBe('function')
  })
})

describe('WO-915 the live apply - what the bridge answers', () => {
  it('reports a clean apply as ok, with the bridge lines intact', async () => {
    const { controller, transport } = await connected()
    const pending = controller.applyMachineDefinition(wiredDefinition())
    const call = transport.lastCall('applyMachineDefinition')
    transport.reply(
      call.seq,
      true,
      bridgeReply({
        lines: [
          { text: '[bridge] axis X applied and read back: step=10 dir=11', severity: 'info' },
          { text: '[bridge] gantry OK: the board has Y slaved to A', severity: 'info' },
        ],
      }),
    )
    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(result.configuredThisSession).toBe(true)
    expect(result.lines).toHaveLength(2)
  })

  it('SAFETY: an apply that invalidates the counter drops "homed this session"', async () => {
    // steps/unit, soft limits, homing direction, homing value and any axis pin
    // change all alter WHAT THE POSITION COUNTER MEANS. Keeping "homed" across
    // one makes every later move wrong by a constant, silently.
    const { controller, transport } = await connected()
    const home = controller.home()
    expect(home).toBe(true)
    transport.reply(transport.lastCall('home').seq, true, true)
    await Promise.resolve()
    expect(controller.homedThisSession()).toBe(true)

    const pending = controller.applyMachineDefinition(wiredDefinition())
    const call = transport.lastCall('applyMachineDefinition')
    transport.reply(call.seq, true, bridgeReply({ reHome: ['X', 'Y'] }))
    const result = await pending

    expect(result.reHome).toEqual(['X', 'Y'])
    expect(controller.homedThisSession()).toBe(false)
  })

  it('SAFETY: a HALF-applied definition is not ok, and also drops "homed"', async () => {
    const { controller, transport } = await connected()
    controller.home()
    transport.reply(transport.lastCall('home').seq, true, true)
    await Promise.resolve()
    expect(controller.homedThisSession()).toBe(true)

    const pending = controller.applyMachineDefinition(wiredDefinition())
    const call = transport.lastCall('applyMachineDefinition')
    transport.reply(
      call.seq,
      true,
      bridgeReply({
        ok: false,
        error:
          'the machine definition was NOT fully applied, so the board is now part old and part new',
        configuredThisSession: false,
        reHome: [],
        lines: [
          {
            text: '[bridge] APPLY FAILED axis Y - stepPin (UC pin): asked for 18, the board holds 0',
            severity: 'error',
          },
        ],
      }),
    )
    const result = await pending

    expect(result.ok).toBe(false)
    expect(result.configuredThisSession).toBe(false)
    expect(result.error).toMatch(/part old and part new/)
    // The failing field, the value asked for and the value read - all three.
    expect(result.lines[0].text).toMatch(/asked for 18, the board holds 0/)
    expect(controller.homedThisSession()).toBe(false)
  })

  it('a refusal that never reached the board is an answer, not a thrown error', async () => {
    const { controller, transport } = await connected()
    const pending = controller.applyMachineDefinition(wiredDefinition())
    const call = transport.lastCall('applyMachineDefinition')
    transport.reply(
      call.seq,
      true,
      bridgeReply({
        ok: false,
        error: 'the machine is moving. Changing a step pin mid-motion is a fault injection',
        configuredThisSession: true,
        lines: [],
      }),
    )
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/the machine is moving/)
    // Nothing was written, so the session stays configured as it was.
    expect(result.configuredThisSession).toBe(true)
  })
})

describe('WO-915 the live apply - refusals that never reach the wire', () => {
  it('refuses before connect, and sends nothing', async () => {
    const controller = new UccncController({})
    const result = await controller.applyMachineDefinition(wiredDefinition())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Not connected/)
    expect(result.configuredThisSession).toBe(false)
  })

  it('refuses on a READ-ONLY bridge without sending a frame', async () => {
    const { controller, transport } = await connected({}, true)
    const result = await controller.applyMachineDefinition(wiredDefinition())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/read only/)
    expect(transport.calls('applyMachineDefinition')).toHaveLength(0)
  })
})

describe('WO-915 the live apply - the call budget', () => {
  it('gets a longer budget than an ordinary call, because it clears the e-stop latch first', async () => {
    // The bridge clears the controller's e-stop latch before writing anything -
    // measured to need two Stop() calls, allowed up to six 250 ms apart - then
    // writes and reads back every axis. Timing out at the ordinary budget would
    // report a failure while the apply was still landing.
    expect(APPLY_DEFINITION_TIMEOUT_MS).toBeGreaterThan(CALL_TIMEOUT_MS)

    vi.useFakeTimers()
    try {
      const { controller } = await connected()
      const pending = controller.applyMachineDefinition(wiredDefinition())
      const settled = vi.fn()
      void pending.then(settled)

      vi.advanceTimersByTime(CALL_TIMEOUT_MS + 1000)
      await Promise.resolve()
      expect(settled).not.toHaveBeenCalled()

      vi.advanceTimersByTime(APPLY_DEFINITION_TIMEOUT_MS)
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/did not answer/)
      // A timeout mid-apply says nothing about what the controller now holds,
      // so it claims neither "configured" nor "still homed".
      expect(result.configuredThisSession).toBe(false)
      expect(controller.homedThisSession()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
