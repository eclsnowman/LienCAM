// WO-476 - does a REFUSED bridge call reach the operator console?
//
// Observed in a real browser 2026-08-22: the bridge refused spindleOn with a
// good sentence and the console gained zero lines, while the same console did
// hold earlier sendCommand refusals. Cause not established. This file starts
// by REPRODUCING at unit level - if it reproduces here the fault is in the
// controller; if it does not, the fault is in the app wiring above it, and
// that is worth knowing before touching anything.

import { describe, it, expect } from 'vitest'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'

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
  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(message: BridgeCallMessage): void { this.sent.push(message) }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
  calls(m: string): BridgeCallMessage[] { return this.sent.filter((c) => c.m === m) }
}

function recorder(): ControllerEvents & { consoles: Array<{ text: string; severity: string }> } {
  const consoles: Array<{ text: string; severity: string }> = []
  return { consoles, onConsole: (e) => consoles.push({ text: e.text, severity: e.severity }) }
}

async function connect() {
  const transport = new FakeTransport()
  const events = recorder()
  const ctrl = new UccncController(events)
  const connecting = ctrl.connect({ kind: 'messages', transport })
  await Promise.resolve()
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.4',
      capabilities: CAPS,
      readOnly: false,
      vfd: { present: true, verified: false, name: 'Huanyang GT' },
    },
  })
  await connecting
  return { ctrl, transport, events }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('WO-476: a refused call must reach the operator', () => {
  it('reports the bridge\'s own sentence when spindleOn is refused', async () => {
    const { ctrl, transport, events } = await connect()

    expect(ctrl.spindleOn?.('cw', 5000)).toBe(true)
    const call = transport.calls('spindleOn')[0]
    expect(call).toBeTruthy()

    // The bridge's real refusal, verbatim from the wire capture.
    transport.emit({
      t: 'reply',
      seq: call.seq,
      ok: false,
      error: 'this inverter\'s setup has not been checked against the hardware yet, so the spindle cannot be started.',
    })
    await flush()
    await flush()

    const errors = events.consoles.filter((c) => c.severity === 'error')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((c) => /not been checked against the hardware/i.test(c.text))).toBe(true)
  })

  it('names the CALL that was refused, not just the reason', async () => {
    const { ctrl, transport, events } = await connect()
    ctrl.spindleOn?.('cw', 5000)
    const call = transport.calls('spindleOn')[0]

    transport.emit({ t: 'reply', seq: call.seq, ok: false, error: 'nope' })
    await flush()
    await flush()

    expect(events.consoles.some((c) => /spindleOn/.test(c.text))).toBe(true)
  })

  it('says nothing when the call SUCCEEDS - silence is only correct here', async () => {
    const { ctrl, transport, events } = await connect()
    ctrl.spindleOn?.('cw', 5000)
    const call = transport.calls('spindleOn')[0]

    transport.emit({ t: 'reply', seq: call.seq, ok: true, v: true })
    await flush()
    await flush()

    expect(events.consoles.filter((c) => c.severity === 'error')).toHaveLength(0)
  })
})
