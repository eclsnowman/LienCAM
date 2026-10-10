/**
 * WO-1041: `setWorkOffset` - set a work offset to GIVEN VALUES.
 *
 * `zeroWorkAxis` can only zero an axis where the tool happens to be standing.
 * Without an intent that takes a NUMBER, a stored offset can never be pushed
 * back into a controller - which is why WO-1036 could remove the write into
 * Operator's UCCNC profile only by accepting that a work zero stops surviving a
 * restart. This is the half that makes restoring it possible; WO-1042 holds it
 * durably and pushes it on connect.
 *
 * Tested against a mock bridge, per docs/machine/BRIDGE-PROTOCOL.md - the
 * protocol is the contract and no running bridge is needed. The bridge half's
 * own behaviour (validate-all-before-writing, the refusals, and the observable
 * shift in workPos) is proved on the demo board in
 * `src/tests/evidence/WO-1041/`.
 */
import { describe, it, expect } from 'vitest'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'

const CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
  machineProgram: true,
}

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(message: BridgeCallMessage): void { this.sent.push(message) }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
  reply(seq: number, ok: boolean, v?: unknown, error?: string): void {
    this.emit({ t: 'reply', seq, ok, v, error })
  }
  lastCall(m: string): BridgeCallMessage {
    const calls = this.sent.filter((c) => c.m === m)
    const last = calls[calls.length - 1]
    if (!last) throw new Error(`no call sent for "${m}"`)
    return last
  }
}

async function connected(): Promise<{ ctrl: UccncController; t: FakeTransport }> {
  const t = new FakeTransport()
  const ctrl = new UccncController({})
  const started = ctrl.connect({ kind: 'messages', transport: t })
  t.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.2',
      capabilities: CAPS,
      readOnly: false,
    },
  } as BridgeMessage)
  await started
  return { ctrl, t }
}

describe('WO-1041: setWorkOffset sends the axes it was given', () => {
  it('sends only the axes present, so an omitted one is left alone', async () => {
    const { ctrl, t } = await connected()

    const p = ctrl.setWorkOffset!('G54', { x: 81.2275, z: 12.16 })
    const call = t.lastCall('setWorkOffset')
    t.reply(call.seq, true, { ok: true, reason: null, offset: { x: 81.2275, y: 0, z: 12.16 } })
    await p

    // A substituted 0 for the absent Y would silently move a zero the caller
    // never mentioned - the whole point of the partial shape.
    expect(call.a).toEqual({ wcs: 'G54', x: 81.2275, z: 12.16 })
    expect('y' in (call.a as object)).toBe(false)
  })

  it('carries the wcs so an inactive system can be set too', async () => {
    const { ctrl, t } = await connected()
    const p = ctrl.setWorkOffset!('G56', { y: -5 })
    const call = t.lastCall('setWorkOffset')
    t.reply(call.seq, true, { ok: true, reason: null, offset: { x: 0, y: -5, z: 0 } })
    await p
    expect((call.a as { wcs: string }).wcs).toBe('G56')
  })

  it('returns the receipt the bridge sent', async () => {
    const { ctrl, t } = await connected()
    const p = ctrl.setWorkOffset!('G54', { x: 1, y: 2, z: 3 })
    const call = t.lastCall('setWorkOffset')
    t.reply(call.seq, true, { ok: true, reason: null, offset: { x: 1, y: 2, z: 3 } })
    expect(await p).toEqual({ ok: true, reason: null, offset: { x: 1, y: 2, z: 3 } })
  })
})

describe('WO-1041: a refusal is the value, never the envelope', () => {
  it('reports ok:false with the bridge\'s reason, on an ok envelope', async () => {
    const { ctrl, t } = await connected()
    const p = ctrl.setWorkOffset!('G54', { x: Number.NaN })
    const call = t.lastCall('setWorkOffset')
    // The bridge answers ok=true at the FRAME level - the call was handled -
    // and puts the verdict in the value. Reading the envelope as the verdict
    // is the mistake this project has made before.
    t.reply(call.seq, true, {
      ok: false,
      reason: 'the X offset is not a finite number, so the whole call is refused - nothing was changed.',
      offset: null,
    })
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not a finite number/)
    expect(r.offset).toBeNull()
  })

  it('refuses in plain words when not connected, and sends nothing', async () => {
    const t = new FakeTransport()
    const ctrl = new UccncController({})   // never connected
    const r = await ctrl.setWorkOffset!('G54', { x: 1 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not connected/)
    expect(t.sent).toHaveLength(0)
  })
})

describe('WO-1041: it is NOT motion and must not be gated like it', () => {
  it('is sent while un-homed, because restoring an offset is what you do first', async () => {
    const { ctrl, t } = await connected()
    // No homing has happened and no status has arrived. zeroWorkAxis works
    // here; so must this. Gating it behind the motion latch would make an
    // offset unrestorable in exactly the situation where restoring one matters
    // - after an E-STOP, before anything has been re-homed.
    const p = ctrl.setWorkOffset!('G54', { x: 10 })
    const call = t.lastCall('setWorkOffset')
    t.reply(call.seq, true, { ok: true, reason: null, offset: { x: 10, y: 0, z: 0 } })
    expect((await p).ok).toBe(true)
  })
})
