// WO-441/442 - the VFD reads in real units, and a typed home to publish them.
//
// WO-427 wired the spindle link and left one defect behind:
// `MachineStatus.spindleRpm` carried the raw `actualRpm` register word,
// right by luck for Operator's Huanyang GT because its scale happens to be the
// identity. WO-441 fixed the decode but had nowhere honest to put the rest of
// it - `hello.vfd` and the `vfd` push were not yet variants of
// `BridgeMessage` / `BridgeHelloPush` (bridgeTransport.ts), and
// `MachineStatus` had no slot for volts/amps/torque/power/upToSpeed - so both
// were read/held defensively (`as unknown as`, a bare `vfdReadings()`) rather
// than widening shared types out of that WO's scope. This suite now proves
// the whole chain, WO-442's part included:
//
//   1. vfdRuntime.ts's `vfdDecodePush` actually applies a definition's scale
//      expressions to a `vfd` push's raw `statusWords` - including a
//      NON-identity scale, which is the case the bridge can never decode
//      (Vfd.cs's header: one expression evaluator in the product, and it is
//      not in C#).
//   2. UccncController consumes that push and publishes the decoded real
//      unit into `MachineStatus.spindleRpm`, replacing the bridge's own raw
//      pass-through - never zero, never a stale reading, when the link is
//      down, faulted, or no definition matched at all.
//   3. UccncController ALSO publishes volts/amps/torque/power/upToSpeed onto
//      `MachineStatus.spindle` - null (the whole block) while no definition
//      is active, an object with each field independently null once one is,
//      never a zero standing in for "the inverter reported nothing".

import { describe, it, expect } from 'vitest'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents, MachineStatus } from '../../lib/machine/controller'
import { HUANYANG_GT, VFD_DEFINITIONS } from '../../lib/machine/vfd/huanyangGt'
import { compileVfdDefinition, vfdDecodePush, vfdIsUpToSpeed, vfdSetpointWord } from '../../lib/machine/vfd/vfdRuntime'
import type { VfdDefinition } from '../../lib/machine/vfd/vfdDefinition'

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

/** A mock of the bridge's browser-side socket, matching the pattern in
 *  uccncController.wo421.test.ts. WO-442: `hello.vfd` and the `vfd` push are
 *  now real `BridgeMessage` variants (bridgeTransport.ts), so `emit` takes
 *  `BridgeMessage` directly rather than `unknown` - the whole point of this
 *  WO is that this boundary no longer needs a defensive cast to reach. */
class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }
  send(message: BridgeCallMessage): void {
    this.sent.push(message)
  }
  async close(): Promise<void> {
    // nothing to do
  }
  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
}

type HelloVfd = NonNullable<Extract<BridgeMessage, { t: 'hello' }>['v']['vfd']>

function helloMessage(vfd: HelloVfd | null): Extract<BridgeMessage, { t: 'hello' }> {
  return {
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.3',
      capabilities: NO_CAPS,
      readOnly: false,
      vfd: vfd ?? { present: false, verified: false, name: null },
    },
  }
}

/** Only `up`/`faulted`/`statusWords` affect the DECODE (`vfdRuntime.ts`'s
 *  `vfdDecodePush`) - everything else in a real `vfd` push is filled with an
 *  inert default so each test states only what it means to vary.
 *
 *  `running` is only what the bridge last commanded. The inverter's own answer
 *  to "are you turning" comes from `runStateWord`, and that is what is
 *  published to `status.spindle.running`. */
function vfdPush(sample: {
  up: boolean
  faulted: boolean
  statusWords: number[]
  running?: boolean
  runStateWord?: number
}): Extract<BridgeMessage, { t: 'vfd' }> {
  return {
    t: 'vfd',
    v: {
      up: sample.up,
      running: sample.running ?? false,
      faulted: sample.faulted,
      runStateWord: sample.runStateWord ?? (sample.running === true ? 1 : 3),
      commandWord: 0,
      setpointWord: 0,
      consecutiveFailures: 0,
      lastStopReason: 'none',
      lastError: null,
      statusWords: sample.statusWords,
      status: {},
      upToSpeed: null,
    },
  }
}

function events(): ControllerEvents & { statuses: MachineStatus[] } {
  const statuses: MachineStatus[] = []
  return { statuses, onStatus: (s) => statuses.push(s) }
}

async function connectWithHello(
  controller: UccncController,
  transport: FakeTransport,
  vfd: HelloVfd | null = null,
): Promise<void> {
  const connectPromise = controller.connect({ kind: 'messages', transport })
  transport.emit(helloMessage(vfd))
  await connectPromise
}

const BASE_STATUS: MachineStatus = {
  state: 'idle',
  subState: null,
  machinePos: null,
  workPos: null,
  feedMmMin: null,
  spindleRpm: null,
  overrides: null,
  executingMoveId: null,
  buffer: null,
  inputs: null,
  homed: null,
  spindle: null,
}

/** volts, amps, actualRpm, (unused), torque - Operator's status block shape. */
function statusWords(actualRpm: number): number[] {
  return [230, 5, actualRpm, 0, 40]
}

describe('vfdRuntime.vfdDecodePush - the bridge vfd push, decoded (WO-441)', () => {
  const compiled = compileVfdDefinition(HUANYANG_GT)
  if (!compiled.ok) throw new Error('HUANYANG_GT must compile for this suite to mean anything')
  const { definition, compiled: scales } = compiled

  it("round-trips Operator's RPM / 2.4 setpoint against a decoded actual", () => {
    const commandedRpm = 12000
    const setpoint = vfdSetpointWord(definition, scales, commandedRpm)
    expect(setpoint.ok).toBe(true)
    if (!setpoint.ok) return
    expect(setpoint.word).toBe(5000) // 12000 / 2.4, Operator's own calibration
    expect(setpoint.clamped).toBe(false)

    // The inverter reports actual RPM directly (identity scale) - simulate it
    // having reached the commanded speed exactly.
    const decoded = vfdDecodePush(definition, scales, {
      up: true,
      faulted: false,
      statusWords: statusWords(commandedRpm),
    })
    expect(decoded.actualRpm).toBe(commandedRpm)
    expect(decoded.volts).toBe(230)
    expect(decoded.amps).toBe(5)
    expect(decoded.torque).toBe(40)
    expect(decoded.power).toBe(230 * 5) // derived: field.volts * field.amps

    expect(vfdIsUpToSpeed(definition, commandedRpm, decoded.actualRpm)).toBe(true)
    expect(vfdIsUpToSpeed(definition, commandedRpm, commandedRpm - 1000)).toBe(false)
    // Operator's own tolerance is +/-3 rpm.
    expect(vfdIsUpToSpeed(definition, commandedRpm, commandedRpm + 3)).toBe(true)
    expect(vfdIsUpToSpeed(definition, commandedRpm, commandedRpm + 4)).toBe(false)
  })

  it('reports nothing when the last poll got no reply, or the inverter is faulted - never a stale number', () => {
    const words = statusWords(12000)
    expect(vfdDecodePush(definition, scales, { up: false, faulted: false, statusWords: words })).toEqual({})
    expect(vfdDecodePush(definition, scales, { up: true, faulted: true, statusWords: words })).toEqual({})
    expect(vfdDecodePush(definition, scales, { up: false, faulted: true, statusWords: words })).toEqual({})
  })

  it('decodes a NON-identity scale to a real value on the TS side - which the bridge cannot do at all', () => {
    // A hypothetical inverter reporting frequency x100 rather than RPM
    // directly - the exact case from the WO's "why": "an inverter reporting,
    // say, frequency x100, the DRO would read 5000 while the spindle turned
    // 3000" if the raw word were trusted.
    const nonIdentityDefinition: VfdDefinition = {
      ...HUANYANG_GT,
      id: 'test-frequency-x100',
      status: HUANYANG_GT.status.map((field) =>
        field.name === 'actualRpm' && field.source === 'register'
          ? { ...field, scale: 'raw.value / 100' }
          : field,
      ),
    }
    const otherCompiled = compileVfdDefinition(nonIdentityDefinition)
    expect(otherCompiled.ok).toBe(true)
    if (!otherCompiled.ok) return

    const rawWord = 500000 // 5000 rpm reported as frequency x100
    const decoded = vfdDecodePush(otherCompiled.definition, otherCompiled.compiled, {
      up: true,
      faulted: false,
      statusWords: [230, 5, rawWord, 0, 40],
    })
    // TypeScript decoded the real value - the whole point of "one evaluator,
    // and it is in TypeScript".
    expect(decoded.actualRpm).toBe(5000)

    // What the BRIDGE would do with the same definition: Vfd.cs's
    // `LoadStatusFieldNames` names a status word only when its scale is
    // textually the identity (`raw.value` or the plain number `1`). This
    // field's scale is neither, so the bridge never names it, and
    // `MachineStatus.spindleRpm` (set from that name - Bridge.cs's `Sampled`
    // handler, Machine.cs's `SpindleRpm`) stays null rather than reporting
    // the raw word (500000) or a half-converted guess.
    const actualRpmField = nonIdentityDefinition.status.find((f) => f.name === 'actualRpm')
    const scale = actualRpmField && actualRpmField.source === 'register' ? actualRpmField.scale : undefined
    const bridgeWouldNameIt = scale === 'raw.value' || scale === 1
    expect(bridgeWouldNameIt).toBe(false)
  })
})

describe('UccncController - publishing the decoded VFD reading (WO-441)', () => {
  it('passes spindleRpm straight through, unchanged, when no VFD definition matched hello', async () => {
    const transport = new FakeTransport()
    const ev = events()
    const controller = new UccncController(ev)
    await connectWithHello(controller, transport, { present: false, verified: false, name: null })

    transport.emit({ t: 'status', v: { ...BASE_STATUS, spindleRpm: 12000 } })

    expect(controller.status().spindleRpm).toBe(12000) // exactly what the bridge sent
    expect(controller.vfdReadings()).toEqual({})
    expect(controller.vfdUpToSpeed(12000)).toBeNull()
    // WO-442: `spindle` is left exactly as the bridge sent it too (never, on
    // this wire today), same as `spindleRpm` here - so it stays whatever
    // BASE_STATUS already declares, `null`.
    expect(controller.status().spindle).toBeNull()
  })

  it('overrides spindleRpm with the decoded actual once the vfd push arrives', async () => {
    const transport = new FakeTransport()
    const ev = events()
    const controller = new UccncController(ev)
    await connectWithHello(controller, transport, { present: true, verified: false, name: 'Huanyang GT' })

    // The bridge's own raw pass-through - right by luck for Operator's inverter,
    // but this proves the TS decode (not luck) is what ends up on screen.
    transport.emit({ t: 'status', v: { ...BASE_STATUS, spindleRpm: 999 } })
    expect(controller.status().spindleRpm).toBe(999)
    // WO-442: a definition is active (hello matched it), so `spindle` is
    // already an object - just every field null, since no `vfd` push has
    // arrived to decode yet. Never a zero standing in for "nothing yet".
    expect(controller.status().spindle).toEqual({
      volts: null,
      amps: null,
      torque: null,
      power: null,
      upToSpeed: null,
      // Null, not false: before any push the inverter has not said whether it
      // is turning, and false would be a claim that it is stopped.
      running: null,
      linkUp: null,
    })

    transport.emit(vfdPush({ up: true, faulted: false, statusWords: statusWords(12000) }))

    expect(controller.status().spindleRpm).toBe(12000)
    expect(ev.statuses[ev.statuses.length - 1]?.spindleRpm).toBe(12000)
    expect(controller.vfdReadings()).toEqual({ volts: 230, amps: 5, actualRpm: 12000, torque: 40, power: 1150 })
    expect(controller.vfdUpToSpeed(12000)).toBe(true)
    expect(controller.vfdUpToSpeed(11000)).toBe(false)
    // WO-442: the same decoded reading, published where SpindlePanel.tsx can
    // reach it. `upToSpeed` stays null - this controller tracks no commanded
    // RPM to compare against yet (see UccncController.vfdUpToSpeed's note).
    expect(controller.status().spindle).toEqual({
      volts: 230,
      amps: 5,
      torque: 40,
      power: 1150,
      upToSpeed: null,
      running: false,
      linkUp: true,
    })
    expect(ev.statuses[ev.statuses.length - 1]?.spindle).toEqual({
      volts: 230,
      amps: 5,
      torque: 40,
      power: 1150,
      upToSpeed: null,
      running: false,
      linkUp: true,
    })

    // A later `status` push keeps the decoded reading rather than reverting
    // to whatever raw number the bridge happens to send with it.
    transport.emit({ t: 'status', v: { ...BASE_STATUS, spindleRpm: 7 } })
    expect(controller.status().spindleRpm).toBe(12000)
    expect(controller.status().spindle?.volts).toBe(230)
  })

  it("publishes the inverter's own operating-state word, never our commanded-running latch", async () => {
    // WO-1097: `running` is the bridge's desired/commanded state. Only 0x1001
    // says whether the inverter is turning, and its direction value must not be
    // interpreted as the commanded direction.
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport, { present: true, verified: false, name: 'Huanyang GT' })

    // A status frame first: before one arrives `status()` is the empty status,
    // whose `spindle` is null for a reason unrelated to this flag.
    transport.emit({ t: 'status', v: { ...BASE_STATUS, spindleRpm: 0 } })

    // Before any VFD push: unknown, and said so. Never false.
    expect(controller.status().spindle?.running).toBeNull()

    transport.emit(vfdPush({
      up: true, faulted: false, statusWords: statusWords(5000),
      running: false, runStateWord: 2,
    }))
    expect(controller.status().spindle?.running).toBe(true)

    // The stop the operator did not ask for - the case that bit at the machine.
    transport.emit(vfdPush({
      up: true, faulted: false, statusWords: statusWords(5000),
      running: true, runStateWord: 3,
    }))
    expect(controller.status().spindle?.running).toBe(false)
  })

  it('goes null - never zero, never a stale reading - when the link drops or the inverter faults', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport, { present: true, verified: false, name: 'Huanyang GT' })

    transport.emit({ t: 'status', v: { ...BASE_STATUS, spindleRpm: 5000 } })
    transport.emit(vfdPush({ up: true, faulted: false, statusWords: statusWords(12000) }))
    expect(controller.status().spindleRpm).toBe(12000)

    transport.emit(vfdPush({ up: false, faulted: false, statusWords: statusWords(12000) }))
    expect(controller.status().spindleRpm).toBeNull()
    expect(controller.vfdReadings()).toEqual({})
    // The link dropping nulls out every field on `spindle` too - never a
    // stale 230V/5A left over from the last good sample.
    expect(controller.status().spindle).toEqual({
      volts: null,
      amps: null,
      torque: null,
      power: null,
      upToSpeed: null,
      running: null,
      linkUp: false,
    })

    transport.emit(vfdPush({ up: true, faulted: false, statusWords: statusWords(12000) }))
    expect(controller.status().spindleRpm).toBe(12000)

    transport.emit(vfdPush({ up: true, faulted: true, statusWords: statusWords(12000) }))
    expect(controller.status().spindleRpm).toBeNull()
    expect(controller.vfdReadings()).toEqual({})
    expect(controller.status().spindle?.volts).toBeNull() // faulted - nothing honest to report
  })

  it('an unrecognised definition name in hello leaves decoding off, same as none configured at all', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport, { present: true, verified: false, name: 'Some Other VFD' })

    transport.emit({ t: 'status', v: { ...BASE_STATUS, spindleRpm: 4321 } })
    transport.emit(vfdPush({ up: true, faulted: false, statusWords: statusWords(12000) }))

    expect(controller.status().spindleRpm).toBe(4321) // untouched
    expect(controller.vfdReadings()).toEqual({})
    expect(controller.vfdUpToSpeed(4321)).toBeNull()
    expect(controller.status().spindle).toBeNull() // no definition adopted at all
  })

  it('clears the decoded definition and readings on disconnect - no stale reading survives a reconnect', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport, { present: true, verified: false, name: 'Huanyang GT' })
    transport.emit({ t: 'status', v: { ...BASE_STATUS, spindleRpm: 1 } })
    transport.emit(vfdPush({ up: true, faulted: false, statusWords: statusWords(12000) }))
    expect(controller.vfdReadings().actualRpm).toBe(12000)

    await controller.disconnect()

    expect(controller.vfdReadings()).toEqual({})
    expect(controller.vfdUpToSpeed(12000)).toBeNull()
    expect(controller.status().spindleRpm).toBeNull() // teardown clears lastStatus entirely
    expect(controller.status().spindle).toBeNull() // and the whole telemetry block with it
  })

  it('with no definition loaded at all, every VFD-derived reading is null - never zero, never invented', () => {
    const controller = new UccncController(events())
    expect(controller.status().spindleRpm).toBeNull()
    expect(controller.vfdReadings()).toEqual({})
    expect(controller.vfdUpToSpeed(12000)).toBeNull()
    expect(controller.status().spindle).toBeNull()
  })

  it('a field the active definition never names renders as absent, never as zero - WO-442', async () => {
    // A stripped-down Huanyang GT with `torque` and its derived `power`
    // removed from the register map entirely - the same "this inverter does
    // not report it" case BRIDGE-PROTOCOL.md describes for a field with no
    // matching word, distinct from "the last poll failed" (already covered
    // above). A distinct `name` so `adoptVfdDefinition`'s lookup in
    // `VFD_DEFINITIONS` (Operator's shipped Huanyang GT, by name) finds THIS one
    // rather than the real entry also present in that list.
    const noTorqueDefinition: VfdDefinition = {
      ...HUANYANG_GT,
      id: 'test-no-torque',
      name: 'Huanyang GT (test fixture, no torque/power)',
      status: HUANYANG_GT.status.filter((field) => field.name !== 'torque' && field.name !== 'power'),
    }
    expect(compileVfdDefinition(noTorqueDefinition).ok).toBe(true)

    const definitions = VFD_DEFINITIONS as VfdDefinition[]
    const before = definitions.length
    definitions.push(noTorqueDefinition)
    try {
      const transport = new FakeTransport()
      const controller = new UccncController(events())
      await connectWithHello(controller, transport, {
        present: true,
        verified: false,
        name: noTorqueDefinition.name,
      })

      transport.emit({ t: 'status', v: { ...BASE_STATUS, spindleRpm: 0 } })
      transport.emit(vfdPush({ up: true, faulted: false, statusWords: statusWords(12000) }))

      const spindle = controller.status().spindle
      expect(spindle?.volts).toBe(230) // this field IS in the register map
      expect(spindle?.amps).toBe(5)
      // Never reported by this (hypothetical) definition - absent, not 0.
      expect(spindle?.torque).toBeNull()
      expect(spindle?.power).toBeNull()
    } finally {
      definitions.length = before // never leave a test fixture in the shipped list
    }
  })
})
