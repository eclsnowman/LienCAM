// WO-922: the home switches reach the operator.
//
// THE INCIDENT, 2026-08-23. X ran 229 mm the wrong way during homing because
// its home switch was ALREADY MADE and never released. Nobody could see that
// from LienCAM - the made switch was only found afterwards, by opening
// UCCNC's own I/O monitor. The app carried no home-input state at all.
//
// `inputs.hardLimit` could not have helped either: X has
// Limitminuspinnumber=0 / Limitpluspinnumber=0 - NO limit inputs wired - so
// that aggregate boolean can never trip on that axis, and a single boolean
// has no way of SAYING so.
//
// So the assertion this whole file exists for is the three-way one:
//
//     true   wired, made right now
//     false  wired, currently open
//     null   NO INPUT IS WIRED FOR THIS AXIS      <- the missing fact
//     absent no such axis on this machine
//
// Anything that collapses `null` into `false` puts the blindness back.
//
// SCOPE: this is the APP HALF ONLY. The bridge half is WO-923 and had NOT
// landed when this was written - `Machine.cs`'s status builder (its `inp`
// block) still sets only estop / hardLimit / softLimit / probe / limits /
// door / hold. So the fields are OPTIONAL, and the negative control below -
// an older bridge that sends none of them still connects and changes nothing
// - is an acceptance item, not a nicety.
//
// No bridge process, no hardware, no UI: this order adds none. Same
// mock-transport posture as helloUccnc.wo911.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import { SimulatedController } from '../../lib/machine/simulatedController'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type {
  ControllerCapabilities,
  ControllerEvents,
  MachineStatus,
} from '../../lib/machine/controller'
import { useMachineControl } from '../../store/machineControlStore'

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

/** A mock of the bridge's browser-side socket, exactly as
 *  helloUccnc.wo911.test.ts and uccncController.wo421.test.ts drive one. */
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
}

function controllerEvents(): ControllerEvents {
  return {
    onStatus: () => {},
    onConsole: () => {},
    onJobEvent: () => {},
    onHomed: () => {},
    onAlarm: () => {},
  }
}

async function connect(controller: UccncController, transport: FakeTransport): Promise<void> {
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.2',
      capabilities: NO_CAPS,
      readOnly: false,
    },
  } as BridgeMessage)
  await connecting
}

/** Everything a v4 bridge already sends, and nothing more - the shape
 *  `Machine.cs` produces TODAY. */
const V4_INPUTS: NonNullable<MachineStatus['inputs']> = {
  estop: false,
  hardLimit: false,
  softLimit: false,
  probe: false,
  limits: null,
  door: null,
  hold: false,
}

/**
 * THE NIGHT OF 2026-08-23, as a frame.
 *
 * X's home switch is made and stuck (`home.X === true`), Y and Z are wired
 * and open (`false`), and X/Y/Z have NO limit inputs wired at all (`null`,
 * NOT `false`). A/B/C are absent: this is a three-axis machine.
 */
const INCIDENT_INPUTS: NonNullable<MachineStatus['inputs']> = {
  ...V4_INPUTS,
  home: { X: true, Y: false, Z: false },
  limitMinus: { X: null, Y: null, Z: null },
  limitPlus: { X: null, Y: null, Z: null },
}

function statusFrame(inputs: MachineStatus['inputs']): MachineStatus {
  return {
    state: 'home',
    subState: null,
    machinePos: { x: -229, y: 0, z: 0 },
    workPos: { x: -229, y: 0, z: 0 },
    feedMmMin: 1500,
    spindleRpm: null,
    overrides: { feed: 100, rapid: null, spindle: 100 },
    executingMoveId: null,
    buffer: null,
    inputs,
    homed: { X: false, Y: false, Z: false },
    spindle: null,
  }
}

/** Exactly what `machineSession.applyContractStatus` does with a frame -
 *  reproduced here rather than imported, because `machineSession.ts` is not
 *  this order's to touch, and this proves the argument list it ALREADY passes
 *  carries the new fields with it untouched. */
function pushIntoStore(status: MachineStatus): void {
  const store = useMachineControl.getState()
  store.applyStatus(
    status.state,
    status.subState,
    status.machinePos,
    status.workPos,
    status.feedMmMin,
    status.spindleRpm,
    status.overrides,
    status.inputs,
    store.reportedAccessories,
  )
}

beforeEach(() => {
  // A clean store between cases: 'disconnected' is the store's own reset for
  // every machine-derived readout, `inputs` included.
  useMachineControl.getState().setConnection('disconnected', null)
})

describe('WO-922 / the contract: null is "no input wired", false is "wired and open"', () => {
  it('a status push carrying the incident lands in the controller with all three values distinct', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(controllerEvents())
    await connect(controller, transport)

    transport.emit({ t: 'status', v: statusFrame(INCIDENT_INPUTS) } as BridgeMessage)

    const inputs = controller.status().inputs
    // The fact nobody could see on the night: X's home switch is MADE.
    expect(inputs?.home?.X).toBe(true)
    // ...and the other two are wired and open, which is a different fact again.
    expect(inputs?.home?.Y).toBe(false)
    expect(inputs?.home?.Z).toBe(false)
    // The second gap: X has no limit inputs at all. `null`, and it must
    // survive as `null` - never coalesced to `false`.
    expect(inputs?.limitMinus?.X).toBe(null)
    expect(inputs?.limitPlus?.X).toBe(null)
    expect(inputs?.limitMinus?.X).not.toBe(false)
    expect(inputs?.limitPlus?.X).not.toBe(false)
    // Whole-object equality, so a helpful default sneaking in anywhere fails.
    expect(inputs).toEqual(INCIDENT_INPUTS)
  })

  it('an absent axis key is not the same as a null one - "no such axis" vs "axis with no input"', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(controllerEvents())
    await connect(controller, transport)

    transport.emit({ t: 'status', v: statusFrame(INCIDENT_INPUTS) } as BridgeMessage)

    const home = controller.status().inputs?.home
    expect(home).toBeDefined()
    // X is present and made; A is not a key at all - this machine has no A.
    expect('X' in home!).toBe(true)
    expect('A' in home!).toBe(false)
    // Both read as nullish through optional chaining, which is exactly why a
    // reader that cares must use `in`, not `?? null`.
    expect(home!.A).toBeUndefined()
  })

  it('a mixed machine round-trips true, false and null on the SAME axis map', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(controllerEvents())
    await connect(controller, transport)

    const mixed: NonNullable<MachineStatus['inputs']> = {
      ...V4_INPUTS,
      home: { X: true, Y: false, Z: null },
      limitMinus: { X: null, Y: false, Z: true },
      limitPlus: { X: null, Y: null, Z: false },
    }
    transport.emit({ t: 'status', v: statusFrame(mixed) } as BridgeMessage)

    expect(controller.status().inputs).toEqual(mixed)
    // Z has no home switch wired; Y has one and it is open. Not the same.
    expect(controller.status().inputs?.home?.Z).toBe(null)
    expect(controller.status().inputs?.home?.Y).toBe(false)
  })
})

describe('WO-922 / the store: the facts reach machineControlStore', () => {
  it('the incident frame reaches the store per axis, with null preserved', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(controllerEvents())
    await connect(controller, transport)
    transport.emit({ t: 'status', v: statusFrame(INCIDENT_INPUTS) } as BridgeMessage)

    pushIntoStore(controller.status())

    const stored = useMachineControl.getState().inputs
    expect(stored?.home?.X).toBe(true)
    expect(stored?.home?.Y).toBe(false)
    expect(stored?.limitMinus?.X).toBe(null)
    expect(stored?.limitPlus?.X).toBe(null)
    expect(stored).toEqual(INCIDENT_INPUTS)
  })

  it('disconnect clears them - no stale switch reading survives into the next session', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(controllerEvents())
    await connect(controller, transport)
    transport.emit({ t: 'status', v: statusFrame(INCIDENT_INPUTS) } as BridgeMessage)
    pushIntoStore(controller.status())
    expect(useMachineControl.getState().inputs?.home?.X).toBe(true)

    useMachineControl.getState().setConnection('disconnected', null)
    expect(useMachineControl.getState().inputs).toBe(null)

    // And the controller itself forgets too, rather than answering the next
    // session with the last one's switches.
    await controller.disconnect()
    expect(controller.status().inputs).toBe(null)
  })
})

describe('WO-922 / NEGATIVE CONTROL: an older bridge that sends none of this', () => {
  // The order is not done without this. WO-923 has not landed; every live
  // bridge today sends a v4 `inputs` block and nothing more. It must connect
  // and behave EXACTLY as it does now.
  it('a status push with no input fields still connects and changes nothing', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(controllerEvents())
    await connect(controller, transport)
    expect(controller.connectionPhase()).toBe('connected')

    transport.emit({ t: 'status', v: statusFrame(V4_INPUTS) } as BridgeMessage)
    pushIntoStore(controller.status())

    expect(controller.connectionPhase()).toBe('connected')
    // Key for key the v4 block: the new fields are ABSENT, not defaulted to
    // `{}` (which a readout would render as "every axis unwired") and not
    // defaulted to `false` (which would render as "every switch open" - a
    // machine shown as safe on no evidence).
    const stored = useMachineControl.getState().inputs
    expect(stored).toEqual(V4_INPUTS)
    expect(stored?.home).toBeUndefined()
    expect(stored?.limitMinus).toBeUndefined()
    expect(stored?.limitPlus).toBeUndefined()
    expect(stored?.home).not.toEqual({})
    // The v4 facts still arrive untouched.
    expect(stored?.estop).toBe(false)
    expect(stored?.hardLimit).toBe(false)
    expect(stored?.hold).toBe(false)
  })

  it('a frame with inputs: null at all (the bridge knowing nothing) stays null, not an empty shell', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(controllerEvents())
    await connect(controller, transport)

    transport.emit({ t: 'status', v: statusFrame(null) } as BridgeMessage)
    pushIntoStore(controller.status())

    expect(controller.status().inputs).toBe(null)
    expect(useMachineControl.getState().inputs).toBe(null)
  })
})

describe('WO-922 / the simulator reports something honest', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const HOME_CONVENTION = {
    x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
    y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
    z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  }

  async function simulator(): Promise<SimulatedController> {
    const ctrl = new SimulatedController(
      {
        onStatus: () => {},
        onConsole: () => {},
        onJobEvent: () => {},
        onHomed: () => {},
        onAlarm: () => {},
      },
      { travelMm: { x: 300, y: 300, z: 100 }, homeConvention: HOME_CONVENTION },
    )
    await ctrl.connect({ kind: 'none' })
    return ctrl
  }

  it('idle: all three home switches wired and open, no limit inputs wired anywhere', async () => {
    const ctrl = await simulator()
    const inputs = ctrl.status().inputs

    expect(inputs?.home).toEqual({ X: false, Y: false, Z: false })
    expect(inputs?.limitMinus).toEqual({ X: null, Y: null, Z: null })
    expect(inputs?.limitPlus).toEqual({ X: null, Y: null, Z: null })
    // The per-axis nulls agree with the aggregate it already reported.
    expect(inputs?.limits).toBe(null)
    await ctrl.disconnect()
  })

  it('THE POINT: the home switch of the axis being homed reads MADE while it homes', async () => {
    const ctrl = await simulator()
    expect(ctrl.status().inputs?.home?.X).toBe(false)

    // Homes one axis at a time, front of the queue first (WO-914).
    expect(ctrl.homeAxes(['X', 'Y', 'Z'])).toBe(true)
    expect(ctrl.status().state).toBe('home')
    expect(ctrl.status().inputs?.home).toEqual({ X: true, Y: false, Z: false })

    // X finishes its slot (HOMING_MS 1500 / 3 axes = 500 ms each); Y's switch
    // is the one made now, X's has released.
    await vi.advanceTimersByTimeAsync(550)
    expect(ctrl.status().inputs?.home).toEqual({ X: false, Y: true, Z: false })

    // ...and once the whole cycle is done, every switch is open again.
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctrl.status().state).toBe('idle')
    expect(ctrl.status().inputs?.home).toEqual({ X: false, Y: false, Z: false })
    await ctrl.disconnect()
  })

  it('the simulator never claims a limit input it does not have - null, never false', async () => {
    const ctrl = await simulator()
    ctrl.homeAxes(['X'])
    await vi.advanceTimersByTimeAsync(2000)

    const inputs = ctrl.status().inputs
    for (const axis of ['X', 'Y', 'Z'] as const) {
      expect(inputs?.limitMinus?.[axis]).toBe(null)
      expect(inputs?.limitPlus?.[axis]).toBe(null)
      expect(inputs?.limitMinus?.[axis]).not.toBe(false)
    }
    // A/B/C are not keys: a three-axis machine, not six axes with no inputs.
    expect('A' in inputs!.home!).toBe(false)
    await ctrl.disconnect()
  })
})
