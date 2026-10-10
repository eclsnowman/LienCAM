// WO-905 - the spindle, as CALLS rather than G-code text.
//
// Found at the machine 2026-08-22: the app's spindle control was entirely
// M3/M5 text, the AXBB backend refuses text, and the bridge's own spindle
// calls were reachable from nothing - so on a machine whose spindle we had
// just run to 24,000 RPM, the product had no way to start it.
//
// No running bridge is needed here: the protocol IS the contract, same rule
// as uccncController.wo421.test.ts.

import { describe, it, expect } from 'vitest'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents, MachineStatus } from '../../lib/machine/controller'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import type { MachineSpindleLinkDefinition } from '../../types'

const CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  // Whatever the bridge claims here is IGNORED - the backend derives it from
  // whether a VFD link is present. The tests below pin that.
  spindleCommands: false,
}

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
  calls(m: string): BridgeCallMessage[] {
    return this.sent.filter((c) => c.m === m)
  }
}

function recorder(): ControllerEvents & {
  consoles: Array<{ text: string; severity: string }>
  statuses: MachineStatus[]
} {
  const consoles: Array<{ text: string; severity: string }> = []
  const statuses: MachineStatus[] = []
  return {
    consoles,
    statuses,
    onConsole: (e) => consoles.push({ text: e.text, severity: e.severity }),
    onStatus: (s) => statuses.push(s),
  }
}

/** Connect with a bridge that does (or does not) declare a VFD link. */
async function connect(
  vfd: { present: boolean; verified: boolean; name: string | null } | null,
  options: { directionInverted?: () => boolean; readOnly?: boolean } = {},
) {
  const transport = new FakeTransport()
  const events = recorder()
  const ctrl = new UccncController(events, { directionInverted: options.directionInverted })
  const connecting = ctrl.connect({ kind: 'messages', transport })
  await Promise.resolve()
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.4',
      capabilities: CAPS,
      readOnly: options.readOnly === true,
      ...(vfd ? { vfd } : {}),
    },
  })
  await connecting
  return { ctrl, transport, events }
}

const GT = { present: true, verified: false, name: 'Huanyang GT' }

/** A status frame, so there is something for the vfd push to patch onto. */
function pushStatus(transport: FakeTransport): void {
  transport.emit({
    t: 'status',
    v: {
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
    } as MachineStatus,
  })
}

/** statusWords per the Huanyang GT definition: 0 volts, 1 amps, 2 actualRpm,
 *  4 torque. Measured shape - these are the five words UCCNC reads too. */
function pushVfd(transport: FakeTransport, actualRpm: number): void {
  transport.emit({
    t: 'vfd',
    v: {
      up: true,
      running: true,
      faulted: false,
      runStateWord: 2,
      commandWord: 1,
      setpointWord: 2083,
      consecutiveFailures: 0,
      lastStopReason: 'commanded',
      lastError: null,
      statusWords: [45, 18, actualRpm, 0, 9],
      status: {},
      upToSpeed: null,
    },
  })
}

function pushStoppedVfd(transport: FakeTransport): void {
  transport.emit({
    t: 'vfd',
    v: {
      up: true,
      running: false,
      faulted: false,
      runStateWord: 3,
      commandWord: 5,
      setpointWord: 0,
      consecutiveFailures: 0,
      lastStopReason: 'commanded',
      lastError: null,
      statusWords: [0, 0, 0, 0, 0],
      status: {},
      upToSpeed: null,
    },
  })
}

describe('WO-905: spindleCommands is derived from the link, not read off the wire', () => {
  it('is true when the bridge declares a VFD link', async () => {
    const { ctrl } = await connect(GT)
    expect(ctrl.capabilities.spindleCommands).toBe(true)
  })

  it('is false when there is no link, whatever the bridge claimed', async () => {
    const { ctrl } = await connect(null)
    expect(ctrl.capabilities.spindleCommands).toBe(false)
  })

  it('leaves every other capability exactly as the bridge sent it', async () => {
    const { ctrl } = await connect(GT)
    expect(ctrl.capabilities.gcodeText).toBe(false)
    expect(ctrl.capabilities.ownsSpindle).toBe(false)
    expect(ctrl.capabilities.geometryQueue).toBe(true)
  })
})

describe('WO-905: RPM becomes a setpoint word HERE, using the definition', () => {
  it('sends the call with the definition-scaled word, never a G-code line', async () => {
    const { ctrl, transport } = await connect(GT)
    expect(ctrl.spindleOn?.('cw', 5000)).toBe(true)

    const calls = transport.calls('spindleOn')
    expect(calls).toHaveLength(1)
    // 5000 RPM * 10000 / 24000 = 2083.33 -> 2083. The same word the machine
    // ran on 2026-08-22, and the same number as the macro's rpm / 2.4.
    expect(calls[0].a).toEqual({ direction: 'cw', setpointWord: 2083 })

    // Nothing text-shaped went out - that is the whole point of this order.
    expect(transport.calls('sendCommand')).toHaveLength(0)
    expect(transport.calls('sendCommandAwait')).toHaveLength(0)
  })

  it('scales the top of the range too', async () => {
    const { ctrl, transport } = await connect(GT)
    ctrl.spindleOn?.('cw', 24000)
    expect(transport.calls('spindleOn')[0].a).toEqual({ direction: 'cw', setpointWord: 10000 })
  })

  it('carries the direction through', async () => {
    const { ctrl, transport } = await connect(GT)
    ctrl.spindleOn?.('ccw', 5000)
    expect((transport.calls('spindleOn')[0].a as { direction: string }).direction).toBe('ccw')
  })

  it('refuses, and says why, when no definition is active', async () => {
    const { ctrl, transport, events } = await connect(null)
    expect(ctrl.spindleOn?.('cw', 5000)).toBe(false)
    expect(transport.calls('spindleOn')).toHaveLength(0)
    expect(events.consoles.some((c) => c.severity === 'error' && /inverter/i.test(c.text))).toBe(true)
  })

  it('reports clamping instead of silently running a wrapped word', async () => {
    const { ctrl, events } = await connect(GT)
    ctrl.spindleOn?.('cw', 999999)
    expect(events.consoles.some((c) => c.severity === 'warn' && /limited/i.test(c.text))).toBe(true)
  })
})

describe('WO-1097: the machine-owned direction flag is resolved at the wire boundary', () => {
  it('sends the drive runCcw meaning for a clockwise command after inversion', async () => {
    const inverted: MachineSpindleLinkDefinition = {
      ...HUANYANG_GT,
      provenance: { kind: 'edited-here', source: 'WO-1097 test' },
      directionInverted: true,
      directionInvertedProvenance: { kind: 'operator', source: 'WO-1097 test control' },
    }
    const { ctrl, transport } = await connect(GT, {
      directionInverted: () => inverted.directionInverted === true,
    })
    pushStoppedVfd(transport)

    const pending = ctrl.applyVfdDefinition(inverted)
    await Promise.resolve()
    const apply = transport.calls('applyVfdDefinition')[0]
    expect(apply.a.definition).toMatchObject({ directionInverted: true })
    // Simulate the bridge returning only its drive document. The app-owned
    // inversion remains the choice used at encode time, not a bridge field.
    transport.emit({
      t: 'reply', seq: apply.seq, ok: true, v: { definition: HUANYANG_GT }, error: undefined,
    })
    await expect(pending).resolves.toMatchObject({ ok: true })

    expect(ctrl.spindleOn?.('cw', 5000)).toBe(true)
    const wire = transport.calls('spindleOn')[0]
    expect(HUANYANG_GT.commands.style).toBe('value')
    if (HUANYANG_GT.commands.style === 'value') {
      expect(HUANYANG_GT.commands.values.runCcw).toBe(2)
    }
    expect(wire.a).toEqual({ direction: 'ccw', setpointWord: 2083 })
  })

  it('keeps the stored inversion on the wire when a read-only bridge refuses apply', async () => {
    const inverted: MachineSpindleLinkDefinition = {
      ...HUANYANG_GT,
      provenance: { kind: 'edited-here', source: 'WO-1097 refused-apply test' },
      directionInverted: true,
      directionInvertedProvenance: { kind: 'operator', source: 'WO-1097 test control' },
    }
    const { ctrl, transport } = await connect(GT, {
      directionInverted: () => inverted.directionInverted === true,
      readOnly: true,
    })

    await expect(ctrl.applyVfdDefinition(inverted)).resolves.toMatchObject({ ok: false })
    expect(transport.calls('applyVfdDefinition')).toHaveLength(0)
    expect(ctrl.spindleOn?.('cw', 5000)).toBe(true)
    expect(transport.calls('spindleOn')[0].a)
      .toEqual({ direction: 'ccw', setpointWord: 2083 })
  })
})

describe('WO-905: nothing gates a stop', () => {
  it('sends spindleOff even with no definition and no link', async () => {
    const { ctrl, transport } = await connect(null)
    ctrl.spindleOff?.()
    expect(transport.calls('spindleOff')).toHaveLength(1)
  })

  it('sends spindleOff without a preceding spindleOn', async () => {
    const { ctrl, transport } = await connect(GT)
    ctrl.spindleOff?.()
    expect(transport.calls('spindleOff')).toHaveLength(1)
  })
})

describe('WO-905: upToSpeed stops being null once something has commanded a speed', () => {
  it('is null before any command, even with live readings', async () => {
    const { ctrl, transport } = await connect(GT)
    pushStatus(transport)
    pushVfd(transport, 4999)
    expect(ctrl.status().spindle?.upToSpeed).toBeNull()
  })

  it('is true when the inverter is inside the definition tolerance', async () => {
    const { ctrl, transport } = await connect(GT)
    ctrl.spindleOn?.('cw', 5000)
    pushStatus(transport)
    // 4999 vs 5000 commanded: 1 RPM out, inside the +-3 band the working
    // macro uses. Exactly what the machine reported on 2026-08-22.
    pushVfd(transport, 4999)
    expect(ctrl.status().spindle?.upToSpeed).toBe(true)
  })

  it('is false while still spinning up', async () => {
    const { ctrl, transport } = await connect(GT)
    ctrl.spindleOn?.('cw', 5000)
    pushStatus(transport)
    pushVfd(transport, 3073)
    expect(ctrl.status().spindle?.upToSpeed).toBe(false)
  })

  it('goes back to null after a stop - not false, which would be a claim', async () => {
    const { ctrl, transport } = await connect(GT)
    ctrl.spindleOn?.('cw', 5000)
    pushStatus(transport)
    pushVfd(transport, 4999)
    expect(ctrl.status().spindle?.upToSpeed).toBe(true)

    ctrl.spindleOff?.()
    pushVfd(transport, 4999)
    expect(ctrl.status().spindle?.upToSpeed).toBeNull()
  })
})
