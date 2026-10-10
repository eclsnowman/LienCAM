// WO-1006 - THE MEASURED SQUARING OFFSET ON ITS WAY TO THE BRIDGE.
//
// WHAT `src/` DOES IN THIS FEATURE, IN FULL: it hands the bridge one signed
// millimetre value and reads back what the bridge says it now holds. Operator,
// 2026-08-26: "you are not performing a coordinate transform ... it is a one
// time offset after homing and then you slave the drives together in sync from
// then on." So there is no transform here to test, no toolpath to check and no
// per-move arithmetic anywhere - those would all be the design he ruled out.
//
// The homing sequence itself lives in `pendant/uccnc-bridge/Machine.cs` and is
// proved on the demo board by `src/tests/evidence/WO-1006/square-the-gantry.mjs`
// (29/29, transcript beside it). A unit test cannot stand in for that and this
// file does not pretend to: what it pins is the WIRE and the READBACK.
//
// SIX THINGS, AND FIVE OF THEM ARE ABOUT WHAT MUST **NOT** HAPPEN:
//
//   1. The value crosses the wire as `applySkew {offsetMm}` - and `homeAxes`
//      keeps the signature it had, because nothing about homing may change
//      shape for a feature the operator has not turned on.
//   2. ABSENT IS NOT ZERO. `null` clears; it never stores a measured zero.
//   3. A MEASURED ZERO SURVIVES AS ITSELF - "I checked and it was square" is a
//      real and different claim.
//   4. THE RECEIPT IS CHECKED, NOT ECHOED. A bridge that answers with a
//      different number, or with nothing, has not confirmed anything.
//   5. A MACHINE WITH NO MEASUREMENT IS SILENT. Connecting one says nothing to
//      the operator and cannot invent a skew anywhere along the path.
//   6. AN OLD BRIDGE THAT REFUSES THE CALL IS SILENT TOO WHEN THERE IS NOTHING
//      TO APPLY, and LOUD when there is - a bridge that never heard of
//      `applySkew` cannot be holding one either, so a failed CLEAR has changed
//      nothing and has nothing to report.

import { describe, it, expect } from 'vitest'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'
import { machineSkew, describeSkew } from '../../types'
import type { MachineConfig } from '../../types'

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

/** The bridge's browser-side socket, answering exactly as the real one does. */
class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  /** What the bridge will answer the next `applySkew` with. */
  answer: (call: BridgeCallMessage) => { ok: boolean; v?: unknown; error?: string } = (call) => ({
    ok: true,
    // The real bridge builds this from the value it now HOLDS.
    v: {
      set: (call.a as { offsetMm: number | null }).offsetMm !== null,
      offsetMm: (call.a as { offsetMm: number | null }).offsetMm,
    },
  })

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }
  send(message: BridgeCallMessage): void {
    this.sent.push(message)
    if (message.m !== 'applySkew') return
    const reply = this.answer(message)
    queueMicrotask(() => {
      this.events?.onMessage({ t: 'reply', seq: message.seq, ok: reply.ok, v: reply.v, error: reply.error })
    })
  }
  async close(): Promise<void> {}
  calls(m: string): BridgeCallMessage[] {
    return this.sent.filter((c) => c.m === m)
  }
}

function events(): ControllerEvents {
  return {
    onStatus: () => {},
    onConsole: () => {},
    onJobEvent: () => {},
    onHomed: () => {},
    onAlarm: () => {},
  }
}

async function connected(
  transport: FakeTransport,
  capabilities: ControllerCapabilities = NO_CAPS,
): Promise<UccncController> {
  const controller = new UccncController(events())
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.events?.onMessage({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.2',
      capabilities,
      readOnly: false,
    },
  } as BridgeMessage)
  await connecting
  return controller
}

describe('WO-1006 the squaring offset on the wire', () => {
  it('sends the stored millimetres as applySkew, and confirms what the bridge holds', async () => {
    const transport = new FakeTransport()
    const controller = await connected(transport)

    const result = await controller.applySkew(-0.75)

    expect(transport.calls('applySkew')).toHaveLength(1)
    expect(transport.calls('applySkew')[0].a).toEqual({ offsetMm: -0.75 })
    expect(result).toEqual({ ok: true, error: null, set: true, offsetMm: -0.75 })
  })

  it('sends a MEASURED ZERO as itself - "I checked and it was square" is a real claim', async () => {
    const transport = new FakeTransport()
    const controller = await connected(transport)

    const result = await controller.applySkew(0)

    expect(transport.calls('applySkew')[0].a).toEqual({ offsetMm: 0 })
    expect(result.set).toBe(true)
    expect(result.offsetMm).toBe(0)
  })

  it('CLEARS with null and never stores a zero in its place', async () => {
    const transport = new FakeTransport()
    const controller = await connected(transport)

    const result = await controller.applySkew(null)

    expect(transport.calls('applySkew')[0].a).toEqual({ offsetMm: null })
    expect(result).toEqual({ ok: true, error: null, set: false, offsetMm: null })
  })

  it('does NOT change the shape of anything else on the wire - homeAxes is untouched', async () => {
    const transport = new FakeTransport()
    const controller = await connected(transport, { ...NO_CAPS, perAxisHoming: true })

    await controller.applySkew(-0.75)
    void controller.homeAxes(['Z', 'X', 'Y'])
    await Promise.resolve()

    const home = transport.calls('homeAxes')[0]
    expect(home.a).toEqual({ axes: ['Z', 'X', 'Y'] })
    expect(Object.keys(home.a as object)).toEqual(['axes'])
  })

  it('REFUSES A RECEIPT THAT DISAGREES - the reply is a readback, never an echo', async () => {
    const transport = new FakeTransport()
    transport.answer = () => ({ ok: true, v: { set: true, offsetMm: -0.5 } })
    const controller = await connected(transport)

    const result = await controller.applySkew(-0.75)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/did not confirm/i)
  })

  it('refuses a receipt that claims a value for a CLEAR', async () => {
    const transport = new FakeTransport()
    transport.answer = () => ({ ok: true, v: { set: true, offsetMm: 0 } })
    const controller = await connected(transport)

    const result = await controller.applySkew(null)

    expect(result.ok).toBe(false)
  })

  it('reports an OLD BRIDGE that does not know the call instead of claiming success', async () => {
    const transport = new FakeTransport()
    transport.answer = () => ({ ok: false, error: "the bridge does not know the method 'applySkew'" })
    const controller = await connected(transport)

    const result = await controller.applySkew(-0.75)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/applySkew/)
  })

  it('refuses to put a non-number on the wire at all', async () => {
    const transport = new FakeTransport()
    const controller = await connected(transport)

    const result = await controller.applySkew(Number.NaN)

    expect(result.ok).toBe(false)
    expect(transport.calls('applySkew')).toHaveLength(0)
  })

  it('says it is not connected rather than sending into a closed socket', async () => {
    const controller = new UccncController(events())

    const result = await controller.applySkew(-0.75)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not connected/i)
  })
})

describe('WO-1006 what the stored measurement means', () => {
  const machineWith = (skew: unknown) => ({ skew } as unknown as Pick<MachineConfig, 'skew'>)

  it('UNSET IS NOT ZERO, so a machine nobody measured sends null and not 0', () => {
    expect(machineSkew(machineWith(undefined))).toBeNull()
    expect(machineSkew(machineWith(null))).toBeNull()
    // WO-996's degrees shape cannot become millimetres and must never be read
    // as one - it has no offsetMm at all.
    expect(machineSkew(machineWith({ angleDeg: 0.2 }))).toBeNull()
  })

  it('A MEASURED ZERO IS CARRIED, because it is a different claim from unset', () => {
    expect(machineSkew(machineWith({ offsetMm: 0 }))).toEqual({ offsetMm: 0 })
  })

  it('the app still says plainly that IT does not apply the number', () => {
    // The squaring happens in the bridge's homing cycle. Nothing in this
    // application applies anything, which is what this sentence claims and
    // what must stay true of `src/`.
    expect(describeSkew({ offsetMm: -0.75 })).toContain('not applied')
    expect(describeSkew(null)).toBe('Not measured')
  })
})
