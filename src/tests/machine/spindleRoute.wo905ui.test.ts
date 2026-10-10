// WO-905 (UI slice) - the spindle button picks a route instead of always
// emitting M3/M5.
//
// The panel used to send text unconditionally. The AXBB bridge refuses text,
// so on the machine we ran to 24,000 RPM on 2026-08-22 the button did
// nothing at all. GRBL keeps text - there it is correct, and the codes are
// user-overridable for odd wiring.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  commandSpindle, SPINDLE_REFUSAL,
  spindleRoute,
  __resetEstopInterlockForTest,
} from '../../lib/machine/machineSession'
import type { ControllerCapabilities, MachineController } from '../../lib/machine/controller'

beforeEach(() => {
  // The E-STOP latch is a real gate on starting a spindle, and it defaults
  // to needing a reset. Clear it explicitly so these tests are about
  // ROUTING; the gate itself is tested at the bottom of this file.
  __resetEstopInterlockForTest()
})

const CAPS = (over: Partial<ControllerCapabilities>): ControllerCapabilities => ({
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
  ...over,
})

/** Just enough controller to answer the routing question. */
function fake(caps: Partial<ControllerCapabilities>, withCalls: boolean) {
  const on = vi.fn(() => true)
  const off = vi.fn()
  const ctrl = {
    capabilities: CAPS(caps),
    ...(withCalls ? { spindleOn: on, spindleOff: off } : {}),
    status: () => ({}) as never,
  } as unknown as MachineController
  return { ctrl, on, off }
}

describe('WO-905 UI: which route the spindle takes', () => {
  it('prefers calls when the controller declares them', () => {
    const { ctrl } = fake({ spindleCommands: true, gcodeText: false }, true)

    expect(spindleRoute(ctrl)).toBe('calls')
  })

  it('falls back to text for a controller that only speaks G-code', () => {
    const { ctrl } = fake({ spindleCommands: false, gcodeText: true }, false)

    expect(spindleRoute(ctrl)).toBe('text')
  })

  it('reports unsupported when there is neither', () => {
    const { ctrl } = fake({ spindleCommands: false, gcodeText: false }, false)

    expect(spindleRoute(ctrl)).toBe('unsupported')
  })

  it('does not claim calls when the flag is set but the members are missing', () => {
    // A backend that declares the capability without implementing it would
    // otherwise route a start into `undefined?.()` and silently do nothing.
    const { ctrl } = fake({ spindleCommands: true, gcodeText: true }, false)

    expect(spindleRoute(ctrl)).toBe('text')
  })
})

describe('WO-905 UI: what each route actually sends', () => {
  it('sends RPM through the call, and no text', () => {
    const { ctrl, on } = fake({ spindleCommands: true }, true)

    const lines = vi.fn(() => ['M3 S5000'])

    const r = commandSpindle('cw', 5000, lines, ctrl)

    expect(r).toEqual({ ok: true, route: 'calls' })
    expect(on).toHaveBeenCalledWith('cw', 5000)
    // The text was never even resolved - not resolved-then-discarded.
    expect(lines).not.toHaveBeenCalled()
  })

  it('carries ccw through', () => {
    const { ctrl, on } = fake({ spindleCommands: true }, true)

    commandSpindle('ccw', 12000, () => [], ctrl)
    expect(on).toHaveBeenCalledWith('ccw', 12000)
  })

  it('refuses to start, without throwing, when there is no route', () => {
    const { ctrl } = fake({}, false)

    // WO-474 item 1 RE-PIN: a refusal now carries its own reason, so the panel
    // stops inferring one. The refusal itself is unchanged - same ok, same
    // route - and it now also says which of the four causes this was.
    expect(commandSpindle('cw', 5000, () => ['M3 S5000'], ctrl)).toEqual({
      ok: false,
      route: 'unsupported',
      reason: SPINDLE_REFUSAL.unsupported,
    })
  })
})

describe('WO-905 UI: nothing gates a stop', () => {
  it('still calls spindleOff when the route is unsupported', () => {
    const { ctrl, off } = fake({}, true)

    const r = commandSpindle('off', 0, () => [], ctrl)
    expect(off).toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })

  it('calls spindleOff on the call route', () => {
    const { ctrl, off } = fake({ spindleCommands: true }, true)

    commandSpindle('off', 0, () => [], ctrl)
    expect(off).toHaveBeenCalled()
  })
})

// NOT TESTED HERE, deliberately: that the E-STOP latch blocks a start. The
// latch can only be cleared from a test, not set, so a test for it would have
// to fake the mechanism it claims to prove. `commandSpindle` checks
// `estopNeedsReset()` on the call route - see machineSession.ts - and the
// interlock's own tests own that behaviour.
