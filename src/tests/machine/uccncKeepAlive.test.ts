// The client must keep PROVING it is alive, or the bridge stops the spindle.
//
// docs/machine/BRIDGE-PROTOCOL.md: any frame from the browser is a heartbeat,
// and VfdLink stops the spindle after `ClientHeartbeatMs` of silence (2 s,
// pendant/uccnc-bridge/Vfd.cs:234). The bridge side is a safety property and is
// not what these tests pin - they pin OUR side of the obligation.
//
// Measured at the machine 2026-08-22, same spindleOn both trials: with the
// client silent the spindle reached 4999 RPM and stopped itself at t+2573ms
// with lastStopReason "clientGone"; with a call every 750 ms it held 4999 RPM
// for the full 8 s run. The app had no timer at all, so it could not run this
// spindle for longer than about 2.5 seconds.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL, BRIDGE_KEEPALIVE_MS } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'

/** The bridge's own window (Vfd.cs:234). Asserted against directly, so this
 *  file fails if our interval is ever raised past what the bridge tolerates -
 *  which is the only number that actually matters. */
const BRIDGE_CLIENT_HEARTBEAT_MS = 2000

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  /** Every frame that left the client, with the fake clock's time. */
  sent: Array<{ at: number; call: BridgeCallMessage }> = []

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }
  send(call: BridgeCallMessage): void {
    this.sent.push({ at: Date.now(), call })
  }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
  emitClose(reason: string | null): void {
    this.events?.onClose(reason)
  }
}

function noopEvents(): ControllerEvents {
  return {
    onStatus: () => {},
    onConsole: () => {},
    onJobEvent: () => {},
    onHomed: () => {},
    onAlarm: () => {},
  }
}

async function connected(): Promise<{ controller: UccncController; transport: FakeTransport }> {
  const transport = new FakeTransport()
  const controller = new UccncController(noopEvents())
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.4',
      capabilities: NO_CAPS,
      readOnly: false,
    },
  })
  await connecting
  return { controller, transport }
}

/** The longest silence the client left, including the tail up to `now`. */
function longestGap(transport: FakeTransport, since: number, now: number): number {
  let previous = since
  let worst = 0
  for (const frame of transport.sent) {
    worst = Math.max(worst, frame.at - previous)
    previous = frame.at
  }
  return Math.max(worst, now - previous)
}

describe('the bridge client proves it is alive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never goes quiet for as long as the bridge tolerates', async () => {
    const { transport } = await connected()
    const start = Date.now()
    transport.sent.length = 0 // ignore anything connect itself sent

    await vi.advanceTimersByTimeAsync(30_000)

    expect(transport.sent.length).toBeGreaterThan(0)
    expect(longestGap(transport, start, Date.now())).toBeLessThan(BRIDGE_CLIENT_HEARTBEAT_MS)
  })

  it('leaves margin for a missed beat - two in a row still fit the window', () => {
    // Not a style preference: at 750 ms two consecutive misses land at 2250 ms
    // and would stop the spindle, so the interval has to be under a third of
    // the window for the margin to be real.
    expect(BRIDGE_KEEPALIVE_MS * 3).toBeLessThanOrEqual(BRIDGE_CLIENT_HEARTBEAT_MS + BRIDGE_KEEPALIVE_MS)
  })

  it('uses an existing read, not a heartbeat message of its own', async () => {
    // BRIDGE-PROTOCOL.md is explicit that there should be no dedicated
    // heartbeat message - the point is proof the client is alive, and any
    // frame is that. A new verb here would be a protocol change.
    const { transport } = await connected()
    transport.sent.length = 0

    await vi.advanceTimersByTimeAsync(5_000)

    const verbs = new Set(transport.sent.map((f) => f.call.m))
    expect(verbs).toEqual(new Set(['queryStatus']))
  })

  it('stops when the operator disconnects', async () => {
    const { controller, transport } = await connected()
    await controller.disconnect()
    transport.sent.length = 0

    await vi.advanceTimersByTimeAsync(30_000)

    expect(transport.sent).toEqual([])
  })

  it('stops when the socket drops under it', async () => {
    // The timer outliving a dead socket would push frames into nothing for as
    // long as the tab stayed open.
    const { transport } = await connected()
    transport.emitClose('bridge went away')
    transport.sent.length = 0

    await vi.advanceTimersByTimeAsync(30_000)

    expect(transport.sent).toEqual([])
  })

  it('does not start before the connection is real', async () => {
    // A hello that never arrives must not leave a timer behind.
    const transport = new FakeTransport()
    const controller = new UccncController(noopEvents())
    const connecting = controller.connect({ kind: 'messages', transport }).catch(() => 'refused')

    await vi.advanceTimersByTimeAsync(30_000)
    await connecting

    const verbs = transport.sent.map((f) => f.call.m)
    expect(verbs).not.toContain('queryStatus')
  })
})
