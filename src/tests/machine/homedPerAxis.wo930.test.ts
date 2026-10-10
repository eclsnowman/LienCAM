// WO-930: HOMING ONE AXIS MUST NOT TELL THE APP THE MACHINE IS HOMED.
//
// The defect, found by the WO-927 lane and reported rather than worked around:
// both bridge-capable backends set a session-homed BOOLEAN when ANY `homeAxes`
// call completed, with no reference to the list. Homing Z alone therefore made
// `homedThisSession()` true while X and Y had never been referenced, and every
// "home the machine first" gate opened - including machineSession's automatic
// probe cycles, which then moved an axis whose machine coordinate meant
// nothing, unattended.
//
// The acceptance demo homes ONE axis. That is its whole shape.
//
// The honest truth already existed per axis. This order stops collapsing it at
// the moment it is asserted, and makes each gate ask the question it means.
//
// FOUR RULES THESE TESTS HOLD DOWN:
//   1. One axis is one axis. The negative control - a full cycle - still
//      reports homed exactly as it did before.
//   2. NO GATE IS MORE PERMISSIVE THAN IT WAS. Every case that refused before
//      still refuses; the new refusals are cases that used to pass wrongly.
//   3. A refusal NAMES the axes. "Home the machine first" to an operator who
//      has just homed an axis reads as a bug.
//   4. NO GATE MAY EVER BLOCK A STOP.
//
// Plus the second defect this order carries: `CALL_TIMEOUT_MS = 8000` applied
// to `homeAxes`, so the app abandoned any homing cycle over 8 seconds. Z homes
// in 0.8 s; X ran 55 s on 2026-08-23.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SimulatedController } from '../../lib/machine/simulatedController'
import {
  HOMED_GATE_AXES,
  describeAxisList,
  unhomedAxes,
} from '../../lib/machine/controller'
import type { ControllerEvents, JogAxis, MachineController } from '../../lib/machine/controller'
import {
  HOMING_CEILING_PER_AXIS_MS,
  HOMING_LIVENESS_MS,
  CALL_TIMEOUT_MS,
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
} from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { AxisName } from '../../types'
import { useMachineControl } from '../../store/machineControlStore'
import {
  jogToSafeZ,
  prepareMaterialFitTrace,
  runFeatureProbeCycle,
  runParkMove,
  getMachineController,
  triggerEmergencyStop,
  __resetEstopInterlockForTest,
} from '../../lib/machine/machineSession'

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

const HOME_CONVENTION = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}

function makeEvents(): ControllerEvents & { homed: Array<AxisName[] | null> } {
  const homed: Array<AxisName[] | null> = []
  return { homed, onHomed: (axes) => homed.push(axes as AxisName[] | null) }
}

async function connectedSim() {
  const events = makeEvents()
  const ctrl = new SimulatedController(events, {
    travelMm: { x: 300, y: 300, z: 100 },
    homeConvention: HOME_CONVENTION,
  })
  await ctrl.connect({ kind: 'none' })
  return { ctrl, events }
}

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
  // Only the HOMING call's failures. The keepalive fires `queryStatus` every
  // 750 ms and this fake never answers one, so its 8 s budget expires over and
  // over - harness noise, and proof in passing that an ordinary call's budget
  // is untouched by the homing change.
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

/** Answer the last `homeAxes`/`home` call OK, and let the `.then()` run. */
async function replyOk(transport: FakeTransport, method: string): Promise<void> {
  transport.emit({ t: 'reply', seq: transport.lastCall(method).seq, ok: true, v: true })
  await Promise.resolve()
  await Promise.resolve()
}

/** Axes reporting homed, in insertion order. */
function homedSoFar(ctrl: MachineController): string[] {
  return Object.entries(ctrl.status().homed ?? {}).filter(([, v]) => v).map(([k]) => k)
}

// ---------------------------------------------------------------------------
// 1. THE HEADLINE - one axis is one axis, on BOTH backends
// ---------------------------------------------------------------------------

describe('WO-930 THE HEADLINE: one axis does not claim the machine', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // THE ACCEPTANCE ITEM, on the backend the demo runs on in the office.
  it('SIMULATOR: homing Z alone leaves the machine UNHOMED, and says which axes are missing', async () => {
    const { ctrl } = await connectedSim()

    expect(ctrl.homeAxes(['Z'])).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)

    // The cycle really did finish, and Z really is referenced...
    expect(ctrl.machineState()).toBe('idle')
    expect(homedSoFar(ctrl)).toEqual(['Z'])
    expect(ctrl.homedAxesThisSession()).toEqual({ Z: true })
    // ...and that is not the same thing as the machine having a datum.
    expect(ctrl.homedThisSession()).toBe(false)
    expect(unhomedAxes(ctrl)).toEqual(['X', 'Y'])
  })

  it('SIMULATOR: homing X alone is the dangerous one, and it is refused too', async () => {
    // "Safe Z happens to be harmless. A probe cycle after homing X alone is
    // not" - it moves an axis whose machine coordinate is meaningless.
    const { ctrl } = await connectedSim()
    expect(ctrl.homeAxes(['X'])).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)

    expect(ctrl.homedThisSession()).toBe(false)
    expect(unhomedAxes(ctrl)).toEqual(['Y', 'Z'])
    // And specifically: Z has no datum, so even the "harmless" macro refuses.
    expect(unhomedAxes(ctrl, ['Z'])).toEqual(['Z'])
  })

  it('BRIDGE: a completed single-axis homeAxes call records THAT axis, not the machine', async () => {
    const { controller, transport } = await connectedBridge()

    expect(controller.homeAxes(['Z'])).toBe(true)
    await replyOk(transport, 'homeAxes')

    expect(controller.homedAxesThisSession()).toEqual({ Z: true })
    expect(controller.homedThisSession()).toBe(false)
    expect(unhomedAxes(controller)).toEqual(['X', 'Y'])
  })

  it('BRIDGE: the axes accumulate across calls - three single-axis homes ARE a homed machine', async () => {
    // The demo's own shape: home one axis, change something, home another.
    // Honesty must not mean "only a single all-at-once cycle counts".
    const { controller, transport } = await connectedBridge()

    controller.homeAxes(['Z'])
    await replyOk(transport, 'homeAxes')
    expect(controller.homedThisSession()).toBe(false)

    controller.homeAxes(['X'])
    await replyOk(transport, 'homeAxes')
    expect(controller.homedThisSession()).toBe(false)
    expect(unhomedAxes(controller)).toEqual(['Y'])

    controller.homeAxes(['Y'])
    await replyOk(transport, 'homeAxes')
    expect(controller.homedThisSession()).toBe(true)
    expect(unhomedAxes(controller)).toEqual([])
  })

  it('BRIDGE: the `homed` PUSH records exactly the axes it names', async () => {
    // The bridge announces completed cycles it was not asked for by this
    // client too (BRIDGE-PROTOCOL.md `homed.axes`). That push used to set the
    // whole flag; it now records what it says.
    const { controller, transport } = await connectedBridge()

    transport.emit({ t: 'homed', v: { axes: ['Z', 'X'] } })
    expect(controller.homedAxesThisSession()).toEqual({ Z: true, X: true })
    expect(controller.homedThisSession()).toBe(false)

    transport.emit({ t: 'homed', v: { axes: ['Y'] } })
    expect(controller.homedThisSession()).toBe(true)
  })

  it('BRIDGE: a push that names no axes is read as the whole-machine cycle it used to be', async () => {
    // This bridge always says (protocol: "`homed.axes` is never null"). An
    // older one that does not must not be BRICKED by this order - it behaves
    // exactly as it did before, which is the whole cycle.
    const { controller, transport } = await connectedBridge()
    transport.emit({ t: 'homed', v: { axes: null } })
    expect(controller.homedThisSession()).toBe(true)
  })

  it('BRIDGE: A/B/C are recorded for no gate - they are not axes any gate moves', async () => {
    const { controller, transport } = await connectedBridge()
    controller.homeAxes(['A'])
    await replyOk(transport, 'homeAxes')
    expect(controller.homedThisSession()).toBe(false)
    expect(controller.homedAxesThisSession()).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 2. THE NEGATIVE CONTROL - a full cycle reports homed exactly as today
// ---------------------------------------------------------------------------

describe('WO-930 THE NEGATIVE CONTROL: a full cycle is unchanged', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('SIMULATOR: the whole Z,X,Y cycle reports homed, same as before', async () => {
    const { ctrl, events } = await connectedSim()
    expect(ctrl.homeAxes(['Z', 'X', 'Y'])).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)

    expect(ctrl.homedThisSession()).toBe(true)
    expect(unhomedAxes(ctrl)).toEqual([])
    expect(homedSoFar(ctrl)).toEqual(['Z', 'X', 'Y'])
    expect(events.homed).toEqual([['Z', 'X', 'Y']])
  })

  it('SIMULATOR: home() - the orderless whole-machine cycle - still reports homed', async () => {
    const { ctrl } = await connectedSim()
    expect(ctrl.home()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctrl.homedThisSession()).toBe(true)
  })

  it('BRIDGE: one call carrying the whole order reports homed', async () => {
    const { controller, transport } = await connectedBridge()
    controller.homeAxes(['Z', 'X', 'Y'])
    await replyOk(transport, 'homeAxes')
    expect(controller.homedThisSession()).toBe(true)
  })

  it('a REFUSED cycle still reports nothing homed - unchanged from before', async () => {
    const { controller, transport } = await connectedBridge()
    controller.homeAxes(['Y'])
    transport.emit({
      t: 'reply',
      seq: transport.lastCall('homeAxes').seq,
      ok: false,
      error: 'refusing to home Y: the board is not holding the A slave.',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.homedThisSession()).toBe(false)
    expect(controller.homedAxesThisSession()).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 3. NOTHING GOT MORE PERMISSIVE
// ---------------------------------------------------------------------------

describe('WO-930 no gate is more permissive than it was', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a backend that cannot answer per axis behaves EXACTLY as today', () => {
    // GRBL: `$H` is one indivisible whole-machine cycle, it has no
    // `homedAxesThisSession`, and it is not in this order's owned paths. The
    // fallback is the old flag, for every axis.
    const grblShaped = { homedThisSession: () => true }
    expect(unhomedAxes(grblShaped)).toEqual([])
    expect(unhomedAxes(grblShaped, ['Z'])).toEqual([])

    const unhomed = { homedThisSession: () => false }
    expect(unhomedAxes(unhomed)).toEqual(['X', 'Y', 'Z'])
    expect(unhomedAxes(unhomed, ['Z'])).toEqual(['Z'])
  })

  it('A `noHomingSwitches` MACHINE IS UNAFFECTED: it never homed, and still has not', async () => {
    // WO-301: no datum by design and never will be. Before this order every
    // machine-coordinate gate refused there because the flag was false; after
    // it, they refuse because every axis is unhomed. Same refusal, same
    // machines, nothing newly broken - and nothing newly allowed either.
    const { ctrl } = await connectedSim()
    expect(ctrl.homedThisSession()).toBe(false)
    expect(unhomedAxes(ctrl)).toEqual(['X', 'Y', 'Z'])
    // The one thing that must NOT happen: a no-switch machine cannot be made
    // to look homed by the new per-axis path.
    expect(ctrl.homedAxesThisSession()).toEqual({})
  })

  it('an apply that names axes to re-home drops EVERY axis, not just the named ones', async () => {
    // What the position counter MEANS may have changed. Clearing only the
    // named axes would be more permissive than the boolean this replaced.
    const { controller, transport } = await connectedBridge()
    controller.homeAxes(['Z', 'X', 'Y'])
    await replyOk(transport, 'homeAxes')
    expect(controller.homedThisSession()).toBe(true)

    const applying = controller.applyMachineDefinition({} as never)
    transport.emit({
      t: 'reply',
      seq: transport.lastCall('applyMachineDefinition').seq,
      ok: true,
      v: { ok: true, error: null, reHome: ['X'], configuredThisSession: true, lines: [] },
    })
    await applying

    expect(controller.homedAxesThisSession()).toEqual({})
    expect(controller.homedThisSession()).toBe(false)
    expect(unhomedAxes(controller)).toEqual(['X', 'Y', 'Z'])
  })

  it('a disconnect drops every axis - no datum survives a link that went away', async () => {
    const { controller, transport } = await connectedBridge()
    controller.homeAxes(['Z', 'X', 'Y'])
    await replyOk(transport, 'homeAxes')
    expect(controller.homedThisSession()).toBe(true)

    await controller.disconnect()
    expect(controller.homedAxesThisSession()).toEqual({})
    expect(controller.homedThisSession()).toBe(false)
  })

  it('the gate axes are X, Y and Z - the axes this product moves by machine coordinate', () => {
    expect([...HOMED_GATE_AXES]).toEqual(['X', 'Y', 'Z'])
  })
})

// ---------------------------------------------------------------------------
// 4. THE GATES - they refuse after a single-axis home, and they say why
// ---------------------------------------------------------------------------

/** A controller stub the session gates can be pointed at: connected, idle, no
 *  job, and homed exactly on the axes given. */
function gateController(homed: Partial<Record<JogAxis, boolean>>): MachineController {
  const ctrl = getMachineController()
  vi.spyOn(ctrl, 'connectionPhase').mockReturnValue('connected')
  vi.spyOn(ctrl, 'hasActiveJob').mockReturnValue(false)
  vi.spyOn(ctrl, 'machineState').mockReturnValue('idle')
  vi.spyOn(ctrl, 'sendCommand').mockReturnValue(true)
  vi.spyOn(ctrl, 'jogToMachineZ').mockReturnValue(true)
  vi.spyOn(ctrl, 'refreshState').mockReturnValue(true)
  const withPerAxis = ctrl as MachineController & {
    homedAxesThisSession?: () => Partial<Record<JogAxis, boolean>>
  }
  withPerAxis.homedAxesThisSession = () => ({ ...homed })
  vi.spyOn(ctrl, 'homedThisSession').mockImplementation(
    () => HOMED_GATE_AXES.every((a) => homed[a] === true),
  )
  return ctrl
}

const PARK = { label: 'Front left', x: -10, y: -10 }

describe('WO-930 the gates refuse after a single-axis home, and say which axes', () => {
  beforeEach(() => {
    __resetEstopInterlockForTest()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    const ctrl = getMachineController() as MachineController & { homedAxesThisSession?: unknown }
    delete ctrl.homedAxesThisSession
  })

  // THE ACCEPTANCE ITEM: the automatic probe cycle after a single-axis home.
  it('THE PROBE CYCLE REFUSES after homing Z alone, and names X and Y', async () => {
    gateController({ Z: true })
    const result = await runFeatureProbeCycle(
      { steps: [] } as never,
      { positioningFeed: 1200, fastFeed: 300, slowFeed: 40, retract: 2, maxTravel: 30, surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10 } as never,
      true,
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('X and Y')
    expect(result.message).toContain('not been homed')
    // ...and it says WHY that matters, not just that it refused.
    expect(result.message).toContain('machine coordinate')
  })

  it('THE PROBE CYCLE STILL RUNS its gate through when every axis is homed', async () => {
    gateController({ X: true, Y: true, Z: true })
    const result = await runFeatureProbeCycle(
      { steps: [] } as never,
      { positioningFeed: 1200, fastFeed: 300, slowFeed: 40, retract: 2, maxTravel: 30, surfaceClearance: 5, overtravel: 5, crossOverLift: 10, padThickness: 10 } as never,
      true,
    )
    // Whatever else this empty plan does, it is NOT refused for homing.
    expect(result.message ?? '').not.toContain('not been homed')
  })

  it('PARK refuses after homing Z alone and names the unreferenced axes', () => {
    gateController({ Z: true })
    const result = runParkMove(PARK as never, -5)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('X and Y')
    expect(result.reason).toContain('park positions are machine coordinates')
  })

  it('PARK is allowed on a fully homed machine - the negative control', () => {
    gateController({ X: true, Y: true, Z: true })
    expect(runParkMove(PARK as never, -5).ok).toBe(true)
  })

  it('THE MATERIAL-FIT TRACE refuses after homing X alone and names Y and Z', () => {
    gateController({ X: true })
    // The trace has an earlier gate of its own ("No program is loaded"); this
    // test is about the homing one, so get past it.
    useMachineControl.setState({ programText: ['G21 G90', 'G1 X10 Y10 F600', 'M30'].join(String.fromCharCode(10)) } as never)
    const result = prepareMaterialFitTrace(-5, 1000)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Y and Z')
  })

  it('SAFE Z asks about Z ALONE - homing Z is enough, exactly as it was', () => {
    // The gate that must NOT become stricter. Safe Z moves Z and nothing else,
    // and refusing it on a machine whose Z is referenced would be a NEW
    // refusal - its own incident, on a machine someone is standing at.
    gateController({ Z: true })
    expect(jogToSafeZ(-5, 1000)).toEqual({ ok: true })
  })

  it('SAFE Z refuses after homing X alone - which the old flag ALLOWED', () => {
    // The permissiveness this order removes, on the one gate that got more
    // specific rather than stricter: the old boolean was true after any cycle,
    // so a Z move to a machine coordinate went ahead with Z unreferenced.
    gateController({ X: true })
    const result = jogToSafeZ(-5, 1000)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Z has not been homed')
    expect(result.reason).toContain('safe Z is a machine coordinate')
  })

  it('a refusal reads as an instruction, not as a bug report', () => {
    expect(describeAxisList(['Y'])).toBe('Y')
    expect(describeAxisList(['X', 'Y'])).toBe('X and Y')
    expect(describeAxisList(['X', 'Y', 'Z'])).toBe('X, Y and Z')
    expect(describeAxisList([])).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 5. NO GATE MAY EVER BLOCK A STOP
// ---------------------------------------------------------------------------

describe('WO-930 NO GATE MAY EVER BLOCK A STOP', () => {
  beforeEach(() => __resetEstopInterlockForTest())
  afterEach(() => vi.restoreAllMocks())

  it('the E-STOP fires with NOTHING homed - the honest gate sits nowhere near it', () => {
    const ctrl = gateController({})
    const stop = vi.spyOn(ctrl, 'emergencyStop').mockReturnValue(undefined)
    triggerEmergencyStop()
    expect(stop).toHaveBeenCalled()
  })

  it('and it fires after a single-axis home too', () => {
    const ctrl = gateController({ Z: true })
    const stop = vi.spyOn(ctrl, 'emergencyStop').mockReturnValue(undefined)
    triggerEmergencyStop()
    expect(stop).toHaveBeenCalled()
  })

  it('an E-STOP mid-cycle leaves the part-homed axes honest, and claims no datum', async () => {
    vi.useFakeTimers()
    try {
      const { ctrl } = await connectedSim()
      expect(ctrl.homeAxes(['Z', 'X', 'Y'])).toBe(true)
      await vi.advanceTimersByTimeAsync(520)
      expect(homedSoFar(ctrl)).toEqual(['Z'])

      ctrl.emergencyStop()
      expect(ctrl.machineState()).toBe('alarm')
      await vi.advanceTimersByTimeAsync(3000)

      // Z really did reach its switch, and says so. The machine did not.
      expect(ctrl.homedAxesThisSession()).toEqual({ Z: true })
      expect(ctrl.homedThisSession()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. THE SECOND DEFECT - what bounds a homing call
// ---------------------------------------------------------------------------

describe('WO-930 a homing call is not an 8-second call', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('THE DEFECT: a 55-second home is no longer abandoned at 8 seconds', async () => {
    // X ran 55 s on 2026-08-23. Under the old budget the app called that a
    // failure while the machine was still homing - the exact ambiguity a
    // one-shot session cannot afford.
    const { controller, transport, errors } = await connectedBridge()
    controller.homeAxes(['X'])

    // The bridge stays alive and chatty the whole time, as it does in reality
    // (status on change, and at least every 500 ms).
    for (let elapsed = 0; elapsed < 55000; elapsed += 500) {
      transport.emit({ t: 'status', v: controller.status() })
      await vi.advanceTimersByTimeAsync(500)
    }
    // Seven times the old budget, and the app has said nothing about failure.
    expect(CALL_TIMEOUT_MS).toBeLessThan(55000)
    expect(errors).toEqual([])

    await replyOk(transport, 'homeAxes')
    expect(controller.homedAxesThisSession()).toEqual({ X: true })
  })

  it('BOUND 1 - LIVENESS: a bridge that goes silent fails the call, and fast', async () => {
    // Not an unbounded wait. Silence is a dead link, not a slow axis: the
    // bridge pushes at least every 500 ms and this client pokes it every
    // 750 ms, so five seconds of nothing is a failure, caught sooner than the
    // old 8 s budget caught it.
    const { controller, transport, errors } = await connectedBridge()
    controller.homeAxes(['X'])
    transport.emit({ t: 'status', v: controller.status() })

    await vi.advanceTimersByTimeAsync(HOMING_LIVENESS_MS + 50)
    await Promise.resolve()

    expect(errors.join('\n')).toContain('went silent')
    // And the app claims NOTHING about the axis it stopped waiting for.
    expect(controller.homedThisSession()).toBe(false)
    expect(controller.homedAxesThisSession()).toEqual({})
  })

  it('BOUND 2 - CEILING: chatter cannot extend a homing cycle without limit', async () => {
    // The 55-second runaway went unnoticed for 55 seconds. A liveness window
    // alone would let a bridge that keeps talking hold the call open forever.
    const { controller, transport, errors } = await connectedBridge()
    controller.homeAxes(['X'])

    const ceiling = HOMING_CEILING_PER_AXIS_MS
    for (let elapsed = 0; elapsed < ceiling + 2000; elapsed += 1000) {
      transport.emit({ t: 'status', v: controller.status() })
      await vi.advanceTimersByTimeAsync(1000)
    }
    await Promise.resolve()

    expect(errors.join('\n')).toContain('budget')
    expect(controller.homedThisSession()).toBe(false)
  })

  it('THE CEILING SCALES WITH THE LIST: a three-axis cycle is not held to one axis budget', async () => {
    const { controller, transport, errors } = await connectedBridge()
    controller.homeAxes(['Z', 'X', 'Y'])

    for (let elapsed = 0; elapsed < HOMING_CEILING_PER_AXIS_MS + 5000; elapsed += 1000) {
      transport.emit({ t: 'status', v: controller.status() })
      await vi.advanceTimersByTimeAsync(1000)
    }
    // Well past a single axis's budget, and still waiting - because this call
    // carries three axes' worth of work.
    expect(errors).toEqual([])
    await replyOk(transport, 'homeAxes')
    expect(controller.homedThisSession()).toBe(true)
  })

  it('THE BUDGET DOES NOT BOUND MOTION - the bridge\'s own `homed` push still reconciles', async () => {
    // Abandoning the call is the app giving up on an ANSWER. Nothing here
    // stops an axis; the bridge-side backstop on travel is WO-921's and the
    // operator's is the E-STOP. What must not happen is the truth being LOST.
    const { controller, transport, errors } = await connectedBridge()
    controller.homeAxes(['X'])
    await vi.advanceTimersByTimeAsync(HOMING_LIVENESS_MS + 50)
    await Promise.resolve()
    expect(errors.join('\n')).toContain('went silent')

    // The machine finished anyway, and the push says so.
    transport.emit({ t: 'homed', v: { axes: ['X'] } })
    expect(controller.homedAxesThisSession()).toEqual({ X: true })
  })

  it('an ORDINARY call keeps its 8-second budget - only homing got a longer one', async () => {
    // The liveness re-arm must not leak into every call: a `jogStart` that the
    // bridge never answers still fails at CALL_TIMEOUT_MS even while status
    // frames keep arriving. (WO-1546 re-pin: this used `probe`, which now has
    // its own budget - the bridge polls a probe for up to five minutes.)
    const { controller, transport } = await connectedBridge()
    let settled = false
    const jogging = controller.jogStartContinuous('Z', -1, 100)
    void jogging.finally(() => { settled = true })

    for (let elapsed = 0; elapsed < CALL_TIMEOUT_MS + 1000; elapsed += 250) {
      if (elapsed === CALL_TIMEOUT_MS - 1000) expect(settled).toBe(false)
      transport.emit({ t: 'status', v: controller.status() })
      await vi.advanceTimersByTimeAsync(250)
    }
    // `jogStartContinuous` swallows the rejection into `false` rather than
    // throwing - the point is that it RESOLVED, i.e. the budget still fired.
    await expect(jogging).resolves.toBe(false)
  })
})
