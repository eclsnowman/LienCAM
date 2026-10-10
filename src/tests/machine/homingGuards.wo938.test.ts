// WO-938 (guard 1 only - the app-side ceiling; guard 2 split to WO-940).
//
// THE MEASUREMENT: X ran a homing cycle of 205 seconds and 5135mm counted on
// Operator's hardware, 2026-08-23. HOMING_CEILING_PER_AXIS_MS = 120000 exists
// precisely to abandon a wait like that. It never fired.
//
// ROOT CAUSE (full writeup in
// queue/WO-938-two-homing-guards-that-did-not-fire.md, "## ROOT CAUSE"):
// `callLongHoming`'s ceiling was a bare `setTimeout`, and this app runs in a
// BROWSER TAB. Chrome and Firefox both throttle `setTimeout` in a tab that is
// not the focused one - sometimes to as little as one firing a minute for a
// long-backgrounded tab - and an unattended overnight homing cycle is exactly
// that shape. The timer was not lying about existing; it was never
// guaranteed to fire ON TIME, and "on time" is the entire point of a ceiling.
//
// THE FIX: the ceiling now also carries a wall-clock deadline
// (`Date.now() + ceilingMs`, `PendingCall.ceilingDeadline`) that
// `noteBridgeLiveness()` checks on EVERY inbound frame - the same place that
// already re-arms the liveness window. A bridge that keeps talking (which it
// does; BRIDGE-PROTOCOL.md "Pushes") is what now actually catches an overrun
// `ceilingTimer` never got the chance to fire, rather than the call waiting
// on a timer the tab was never scheduled to run.
//
// THE NEGATIVE CONTROL: this file's second test reproduces the exact defect
// shape - `vi.setSystemTime()` moves the wall clock past the deadline WITHOUT
// running the fake timer queue (`vi.advanceTimersByTimeAsync` is what runs
// due callbacks; `setSystemTime` alone does not), which is a faithful stand-in
// for "the browser throttled this tab's setTimeout and it never ran." That
// test was run once against `uccncController.ts` with `ceilingDeadline` /
// `expireCeiling` deleted from the entry (the wall-clock cross-check
// disabled) and it went RED exactly as `src/tests/evidence/WO-938/` records -
// see that file for the actual failing output, captured before the guard was
// restored.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HOMING_CEILING_PER_AXIS_MS,
  HOMING_LIVENESS_MS,
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
} from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'

// ---------------------------------------------------------------------------
// Harness - same shape as src/tests/machine/homedPerAxis.wo930.test.ts
// ---------------------------------------------------------------------------

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(message: BridgeCallMessage): void { this.sent.push(message) }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
  lastCall(m: string): BridgeCallMessage {
    const last = this.sent.filter((c) => c.m === m).at(-1)
    if (!last) throw new Error(`no call sent for "${m}"; sent: ${this.sent.map((c) => c.m).join(', ')}`)
    return last
  }
}

async function connectedBridge() {
  const transport = new FakeTransport()
  const errors: string[] = []
  const controller = new UccncController({
    onConsole: (e) => {
      if (e.severity !== 'error') return
      if (e.text.startsWith('home:') || e.text.startsWith('homeAxes:')) errors.push(e.text)
    },
  })
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
    },
  })
  await connecting
  return { controller, transport, errors }
}

async function replyOk(transport: FakeTransport, method: string): Promise<void> {
  transport.emit({ t: 'reply', seq: transport.lastCall(method).seq, ok: true, v: true })
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------
// 1. THE HEADLINE - the ceiling terminates an over-budget single-axis home
// ---------------------------------------------------------------------------

describe('WO-938 guard 1: the per-axis ceiling actually terminates a running homing call', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a homing call that outlives its ceiling is abandoned, with an error naming the budget', async () => {
    // The reported shape: one axis, homed via homeAxes([axis]) - the exact
    // call homeOneAxis (JogPanel.tsx, WO-927) sends - running long while the
    // bridge stays alive and chatty the whole time, as it does in reality.
    const { controller, transport, errors } = await connectedBridge()
    expect(controller.homeAxes(['X'])).toBe(true)

    for (let elapsed = 0; elapsed < HOMING_CEILING_PER_AXIS_MS + 2000; elapsed += 500) {
      transport.emit({ t: 'status', v: controller.status() })
      await vi.advanceTimersByTimeAsync(500)
    }
    await Promise.resolve()

    expect(errors.join('\n')).toContain('budget')
    // Abandoning the WAIT is not claiming anything was homed - the whole
    // point is that the app no longer knows.
    expect(controller.homedThisSession()).toBe(false)
    expect(controller.homedAxesThisSession()).toEqual({})
  })

  // -------------------------------------------------------------------------
  // 2. THE ROOT CAUSE, REPRODUCED - a throttled setTimeout, caught anyway
  // -------------------------------------------------------------------------

  it('THE ACTUAL DEFECT: a ceilingTimer that never gets to run is still caught, by the wall clock', async () => {
    // This is the fake-timer stand-in for "the browser throttled this tab's
    // setTimeout and it never fired": vi.setSystemTime() moves Date.now()
    // WITHOUT running the fake timer queue - vi.advanceTimersByTimeAsync is
    // the only thing that runs due callbacks, and this test deliberately
    // never calls it past the deadline. If the ceiling depended on
    // ceilingTimer alone (the pre-WO-938 code), this call would NEVER
    // reject: nothing here ever lets that timer's callback run.
    const { controller, transport, errors } = await connectedBridge()
    const start = Date.now()
    expect(controller.homeAxes(['X'])).toBe(true)

    // The bridge is a SEPARATE OS process - it is not throttled by the
    // browser tab, so its pushes keep arriving on schedule the whole time.
    // Only the wall clock moves; the fake timer queue does not run.
    vi.setSystemTime(start + HOMING_CEILING_PER_AXIS_MS + 1000)
    transport.emit({ t: 'status', v: controller.status() })
    await Promise.resolve()
    await Promise.resolve()

    expect(errors.join('\n')).toContain('budget')
    expect(controller.homedThisSession()).toBe(false)
  })

  it('a call that has NOT yet reached its deadline is untouched by the wall-clock check', async () => {
    // The cross-check must not make the guard MORE eager - only catch what
    // the timer alone would have missed.
    const { controller, transport, errors } = await connectedBridge()
    const start = Date.now()
    expect(controller.homeAxes(['X'])).toBe(true)

    vi.setSystemTime(start + HOMING_CEILING_PER_AXIS_MS - 1000)
    transport.emit({ t: 'status', v: controller.status() })
    await Promise.resolve()

    expect(errors).toEqual([])
    expect(controller.homedThisSession()).toBe(false) // still running - not resolved either way
  })
})

// ---------------------------------------------------------------------------
// 3. A NORMAL CYCLE IS UNAFFECTED
// ---------------------------------------------------------------------------

describe('WO-938: a normal cycle is unaffected', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('X homes in ~1s - no error, no abandonment, the axis is recorded homed', async () => {
    const { controller, transport, errors } = await connectedBridge()
    expect(controller.homeAxes(['X'])).toBe(true)
    transport.emit({ t: 'status', v: controller.status() })
    await vi.advanceTimersByTimeAsync(1000)
    await replyOk(transport, 'homeAxes')

    expect(errors).toEqual([])
    expect(controller.homedAxesThisSession()).toEqual({ X: true })
  })

  it('Z homes in 0.8s - no error, no abandonment, the axis is recorded homed', async () => {
    const { controller, transport, errors } = await connectedBridge()
    expect(controller.homeAxes(['Z'])).toBe(true)
    transport.emit({ t: 'status', v: controller.status() })
    await vi.advanceTimersByTimeAsync(800)
    await replyOk(transport, 'homeAxes')

    expect(errors).toEqual([])
    expect(controller.homedAxesThisSession()).toEqual({ Z: true })
  })

  it('liveness (HOMING_LIVENESS_MS) is untouched: a bridge that goes silent still fails fast', async () => {
    // The binding rule: do not weaken HOMING_LIVENESS_MS. Proof it is still
    // the mechanism that catches silence, unaffected by the ceiling's new
    // wall-clock check.
    const { controller, transport, errors } = await connectedBridge()
    controller.homeAxes(['X'])
    transport.emit({ t: 'status', v: controller.status() })

    await vi.advanceTimersByTimeAsync(HOMING_LIVENESS_MS + 50)
    await Promise.resolve()

    expect(errors.join('\n')).toContain('went silent')
  })
})
