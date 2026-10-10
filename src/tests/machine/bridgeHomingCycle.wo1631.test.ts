// WO-1631: WO-1157 re-applied on main - "the bridge says which homing cycle
// this is". WO-1157 itself touched only pendant/uccnc-bridge (Bridge.cs,
// Machine.cs) and BRIDGE-PROTOCOL.md: it gave the bridge a `positionKnowledge`
// fact and a per-axis `homingCycle` identity, and changed the `homed` push to
// fire once per COMPLETED CYCLE rather than once per axis per session (a
// second home of an already-homed axis used to go unreported).
//
// No src/ type consumes either new field yet (a separate, later order's job -
// see WO-1157's review). What src/ MUST already survive, honestly, is:
//
//   1. A `homed` push can now name an axis this client already has recorded.
//      That must be absorbed, not treated as a duplicate to reject or a
//      second cycle to double-count.
//   2. `positionKnowledge` / `homingCycle` are additive keys on `hello.v` and
//      `status.v`. An old browser build reading a new bridge must not choke
//      on keys it does not know, and the status-frame enrichment in
//      `readBridgeMessage` (the one place that reshapes `status.v` before the
//      rest of the app sees it) must carry them through unchanged rather than
//      stripping them.
//
// This is the Tier 2 desk evidence WO-1631 carries; the homing-cycle facts
// themselves are proved on the board (2026-09-14 session item 5), not here.

import { describe, expect, it } from 'vitest'

import { unhomedAxes } from '../../lib/machine/controller'
import { SUPPORTED_BRIDGE_PROTOCOL, UccncController } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import { readBridgeMessage } from '../../lib/machine/bridgeTransport'
import type { BridgeCallMessage, BridgeMessage, BridgeStatusPush, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(message: BridgeCallMessage): void { this.sent.push(message) }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
}

async function connectedBridge() {
  const transport = new FakeTransport()
  const controller = new UccncController({})
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.2',
      capabilities: {
        geometryQueue: true, executingMoveId: true, bufferSeconds: true,
        gcodeText: false, perAxisHoming: true,
        ownsSpindle: true, spindleCommands: false,
      },
      readOnly: false,
      // The additive WO-1157 hello facts. Not in BridgeHelloPush's type
      // (nothing in src/ consumes them yet) - that is the point being pinned.
      positionKnowledge: 'unknown',
      homingCycle: { X: null, Y: null, Z: null },
    },
  } as BridgeMessage)
  await connecting
  return { controller, transport }
}

describe('WO-1631 (WO-1157 ported): a `homed` push per completed cycle', () => {
  it('a second push for an axis already recorded homed this session is absorbed, not rejected', async () => {
    const { controller, transport } = await connectedBridge()

    transport.emit({ t: 'homed', v: { axes: ['Z'] } })
    expect(controller.homedAxesThisSession()).toEqual({ Z: true })

    // The bridge now emits one `homed` push per completed cycle, so a second
    // home of Z (nothing else changed) arrives as a second push naming the
    // same axis - exactly the shape a repeat home produces on real hardware.
    transport.emit({ t: 'homed', v: { axes: ['Z'] } })
    expect(controller.homedAxesThisSession()).toEqual({ Z: true })
    expect(unhomedAxes(controller)).toEqual(['X', 'Y'])
  })

  it('three cycles, one axis apiece, still add up to a homed machine', async () => {
    const { controller, transport } = await connectedBridge()

    transport.emit({ t: 'homed', v: { axes: ['Z'] } })
    transport.emit({ t: 'homed', v: { axes: ['X'] } })
    expect(controller.homedThisSession()).toBe(false)

    transport.emit({ t: 'homed', v: { axes: ['Y'] } })
    expect(controller.homedThisSession()).toBe(true)
    expect(unhomedAxes(controller)).toEqual([])
  })
})

describe('WO-1631 (WO-1157 ported): positionKnowledge/homingCycle are additive wire facts', () => {
  it('readBridgeMessage carries them through the status enrichment untouched', () => {
    const raw = {
      t: 'status',
      v: {
        state: 'idle',
        softLimitLatched: true,
        positionKnowledge: 'yes',
        homingCycle: { X: 1789064520124, Y: 1789064531377, Z: 1789064498220 },
      },
    }

    const message = readBridgeMessage(raw) as BridgeStatusPush

    expect(message.t).toBe('status')
    expect(message.v.softLimitLatched).toBe(true)
    expect((message.v as unknown as Record<string, unknown>).positionKnowledge).toBe('yes')
    expect((message.v as unknown as Record<string, unknown>).homingCycle).toEqual({
      X: 1789064520124, Y: 1789064531377, Z: 1789064498220,
    })
  })

  it('a status frame with no homing-cycle facts (an older bridge) is unaffected', () => {
    const raw = { t: 'status', v: { state: 'idle', softLimitLatched: false } }

    const message = readBridgeMessage(raw) as BridgeStatusPush

    expect(message.v.softLimitLatched).toBe(false)
    expect((message.v as unknown as Record<string, unknown>).positionKnowledge).toBeUndefined()
    expect((message.v as unknown as Record<string, unknown>).homingCycle).toBeUndefined()
  })
})
