// UccncController - tested against a mock bridge, per docs/machine/BRIDGE-PROTOCOL.md.
// No running bridge is needed: the protocol IS the contract (WO-421).

import { describe, it, expect, vi } from 'vitest'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL, CALL_TIMEOUT_MS } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents, MachineController, MachineStatus, QueuedMove } from '../../lib/machine/controller'

const ALL_CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  // Contract v2: the AXBB-E has no G-code interpreter, so even an
  // everything-else-true bridge reports the text path false.
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: true,
  spindleCommands: false,
  machineProgram: true,
}

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

/** A mock of the bridge's browser-side socket - not a mock of UccncController
 *  itself. Tests drive it exactly as a real bridge would: push hello/status/
 *  console frames, answer calls with reply frames, and close it. */
class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  closeCalls = 0

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }
  send(message: BridgeCallMessage): void {
    this.sent.push(message)
  }
  async close(): Promise<void> {
    this.closeCalls++
  }
  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
  emitClose(reason: string | null): void {
    this.events?.onClose(reason)
  }
  reply(seq: number, ok: boolean, v?: unknown, error?: string): void {
    this.emit({ t: 'reply', seq, ok, v, error })
  }
  lastCall(m?: string): BridgeCallMessage {
    const calls = m ? this.sent.filter((c) => c.m === m) : this.sent
    const last = calls[calls.length - 1]
    if (!last) throw new Error(`no call sent${m ? ` for "${m}"` : ''}`)
    return last
  }
}

interface HelloOverrides {
  protocol?: number
  bridge?: string
  capabilities?: ControllerCapabilities
  readOnly?: boolean
}

function helloMessage(overrides: HelloOverrides = {}): BridgeMessage {
  return {
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.2',
      capabilities: NO_CAPS,
      readOnly: false,
      ...overrides,
    },
  }
}

function events(): ControllerEvents & {
  statuses: MachineStatus[]
  consoles: Array<{ dir: string; text: string; severity: string }>
  jobEvents: Array<[string, unknown]>
  homings: Array<unknown>
  alarms: Array<[number | null, string, boolean]>
} {
  const statuses: MachineStatus[] = []
  const consoles: Array<{ dir: string; text: string; severity: string }> = []
  const jobEvents: Array<[string, unknown]> = []
  const homings: Array<unknown> = []
  const alarms: Array<[number | null, string, boolean]> = []
  return {
    statuses,
    consoles,
    jobEvents,
    homings,
    alarms,
    onStatus: (s) => statuses.push(s),
    onConsole: (e) => consoles.push(e),
    // WO-423 / contract v3: the pushes the bridge can honestly raise.
    onJobEvent: (event, fault) => jobEvents.push([event, fault]),
    onHomed: (axes) => homings.push(axes),
    onAlarm: (code, message, positionLost) => alarms.push([code, message, positionLost]),
  }
}

/** connect() resolves only after hello arrives; the fake transport's start()
 *  attaches the event sink synchronously, so emitting hello right after
 *  calling connect() (before awaiting it) reaches the waiter in time. */
async function connectWithHello(
  controller: UccncController,
  transport: FakeTransport,
  overrides: HelloOverrides = {},
): Promise<void> {
  const connectPromise = controller.connect({ kind: 'messages', transport })
  transport.emit(helloMessage(overrides))
  await connectPromise
}

describe('UccncController hello handshake', () => {
  it('adopts capabilities and readOnly from hello - never hardcoded', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    expect(controller.capabilities).toEqual(NO_CAPS) // safe default before any hello

    await connectWithHello(controller, transport, { capabilities: ALL_CAPS, readOnly: true })

    expect(controller.connectionPhase()).toBe('connected')
    expect(controller.capabilities).toEqual(ALL_CAPS)
  })

  it('refuses a hello with an unknown protocol version, with a plain sentence', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())

    const connectPromise = controller.connect({ kind: 'messages', transport })
    transport.emit(helloMessage({ protocol: 99 }))

    await expect(connectPromise).rejects.toThrow(/protocol/i)
    expect(controller.connectionPhase()).toBe('disconnected')
  })

  it('rejects connect() when not given a bridge transport', async () => {
    const controller = new UccncController(events())
    // Contract v3 types `transport`, so the compiler now refuses these three
    // at the call site - which is the point of the typed boundary. The RUNTIME
    // guard still has to hold for a caller that is not type-checked (a JS
    // caller, a fake in another suite), so the casts here are deliberate and
    // only exist to reach the guard being proven.
    const wrong = (t: unknown) => t as never
    await expect(controller.connect({ kind: 'messages', transport: wrong({}) })).rejects.toThrow(
      /bridge transport/i,
    )
    await expect(
      controller.connect({ kind: 'messages', transport: wrong(undefined) }),
    ).rejects.toThrow(/bridge transport/i)
    // A byte pipe is the wrong KIND of backend for this controller, and is
    // refused before anything is duck-typed.
    await expect(controller.connect({ kind: 'bytes', transport: wrong({}) })).rejects.toThrow(
      /bridge transport/i,
    )
  })
})

describe('UccncController call/reply', () => {
  it('WO-1106 sends previewProfile with only the advertised path and returns the hash reply', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport)
    const path = 'C:\\UCCNC\\Profiles\\LienCNCV2.pro'

    const pending = controller.previewProfile(path)
    const call = transport.lastCall('previewProfile')
    expect(call.a).toEqual({ path })
    const reply = {
      ok: true,
      reason: null,
      path,
      fileHash: '0123456789abcdef',
      settings: [{ section: 'FaultSignals', key: 'Enable1', value: 'True' }],
    }
    transport.reply(call.seq, true, reply)

    await expect(pending).resolves.toEqual(reply)
  })

  it('refuses awaited text locally when hello reports no text path', async () => {
    const transport = new FakeTransport()
    const ev = events()
    const controller = new UccncController(ev)
    await connectWithHello(controller, transport)

    const awaited = controller.sendCommandAwait('$H')
    expect(awaited).not.toBeNull()
    await expect(awaited!).resolves.toEqual({
      ok: false,
      message: 'This controller takes geometry, not G-code text - nothing was loaded.',
    })
    expect(transport.sent).toEqual([])
    expect(ev.consoles).toHaveLength(1)
    expect(ev.consoles[0]).toMatchObject({ dir: 'rx', severity: 'error' })
    expect(ev.consoles[0].text).toContain('sendCommandAwait')
    expect(ev.consoles[0].text).toContain('$H')
  })

  it('turns a bridge-reported failure into the typed ok:false shape', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport)

    const awaited = controller.resetToIdle()
    const call = transport.lastCall('resetToIdle')
    transport.reply(call.seq, false, undefined, 'soft limit would be exceeded')

    await expect(awaited).resolves.toEqual({
      ok: false,
      reason: 'soft limit would be exceeded',
    })
  })

  it('a call timeout surfaces a real error rather than a promise that never settles', async () => {
    vi.useFakeTimers()
    try {
      const transport = new FakeTransport()
      const controller = new UccncController(events())
      await connectWithHello(controller, transport)

      const pending = controller.resetToIdle()
      await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + 100)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/did not answer/i)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('UccncController status', () => {
  it('passes MachineStatus straight through, preserving nulls exactly', async () => {
    const transport = new FakeTransport()
    const ev = events()
    const controller = new UccncController(ev)
    await connectWithHello(controller, transport)

    const status: MachineStatus = {
      state: 'idle',
      subState: null,
      machinePos: { x: 1, y: 2, z: 3 },
      workPos: null,
      feedMmMin: null, // this controller does not report feed right now
      spindleRpm: 0, // distinct from "unknown" - actually stopped
      overrides: null,
      executingMoveId: null,
      buffer: null,
      inputs: null,
      homed: null,
      spindle: null, // no VFD link on this bridge session
    }
    transport.emit({ t: 'status', v: status })

    expect(controller.status()).toEqual(status)
    expect(controller.status().feedMmMin).toBeNull()
    expect(controller.status().spindleRpm).toBe(0)
    expect(ev.statuses).toEqual([status])
  })

  it('defaults to an honest all-unknown status before any push arrives', () => {
    const controller = new UccncController(events())
    const status = controller.status()
    expect(status.state).toBe('unknown')
    expect(status.feedMmMin).toBeNull()
    expect(status.machinePos).toBeNull()
    expect(status.spindleRpm).toBeNull()
  })
})

describe('UccncController loadMoves', () => {
  it('encodes QueuedMove[] mechanically as the loadMoves call argument', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport, { capabilities: { ...NO_CAPS, geometryQueue: true } })

    const moves: QueuedMove[] = [
      { id: 1, kind: 'line', to: { x: 10 }, feedMmMin: 600 },
      { id: 2, kind: 'marker' },
    ]
    const result = controller.loadMoves!(moves)

    expect(result).toEqual({ ok: true, reason: null })
    const call = transport.lastCall('loadMoves')
    expect(call.a).toEqual({ moves })
  })

  it('refuses when the bridge did not report geometryQueue', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport) // NO_CAPS default

    const result = controller.loadMoves!([{ id: 1, kind: 'marker' }])
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/geometry/i)
  })

  it('loadJob refuses in a plain sentence instead of parsing text (not in scope yet)', () => {
    const said: string[] = []
    const controller = new UccncController({ ...events(), onConsole: (e) => said.push(e.text) })
    // WO-423 / contract v3: LoadOutcome carries the refusal itself, so the
    // reason no longer has to be smuggled out as a console line beside an
    // empty load - an empty load and a refusal are now distinguishable.
    const refusal = {
      ok: false,
      reason: 'This controller takes geometry, not G-code text - nothing was loaded.',
    }
    expect(controller.loadJob('G0 X0\n')).toEqual(refusal)
    expect(controller.loadJobFrom('G0 X0\n', 0, [])).toEqual(refusal)
    expect(said).toEqual([])
  })

  it('routes the bridge\'s contract v3 pushes onto ControllerEvents', async () => {
    const transport = new FakeTransport()
    const ev = events()
    const controller = new UccncController(ev)
    await connectWithHello(controller, transport, { capabilities: ALL_CAPS })

    transport.emit({ t: 'jobEvent', v: { event: 'started', fault: null } })
    expect(controller.hasActiveJob()).toBe(true)
    transport.emit({
      t: 'jobEvent',
      v: {
        event: 'failed',
        // A geometry backend names the MOVE and has no firmware error numbers.
        fault: { code: null, message: 'the controller refused move 4', line: null, moveId: 4 },
      },
    })
    // A run the bridge says is over is over here too - hasActiveJob must not
    // keep claiming a job the controller already abandoned.
    expect(controller.hasActiveJob()).toBe(false)
    expect(ev.jobEvents).toEqual([
      ['started', null],
      ['failed', { code: null, message: 'the controller refused move 4', line: null, moveId: 4 }],
    ])

    transport.emit({ t: 'homed', v: { axes: ['Z', 'X', 'Y'] } })
    expect(ev.homings).toEqual([['Z', 'X', 'Y']])
    expect(controller.homedThisSession()).toBe(true)

    transport.emit({
      t: 'alarm',
      v: { code: null, message: 'A hard limit switch was hit.', positionLost: true },
    })
    expect(ev.alarms).toEqual([[null, 'A hard limit switch was hit.', true]])
  })

  it('never claims loadPreparedJob: a controller with no interpreter has no text path at all', () => {
    // Asked through the CONTRACT, which is how machineSession asks: contract v3
    // made loadPreparedJob optional, and a caller must degrade on its absence
    // rather than assume GRBL.
    const controller: MachineController = new UccncController(events())
    expect(controller.loadPreparedJob).toBeUndefined()
  })
})

describe('UccncController readOnly', () => {
  it('refuses a motion call locally when hello said readOnly, without touching the wire', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport, { readOnly: true, capabilities: ALL_CAPS })

    expect(controller.jog('X', 5, 600)).toBe(false)
    expect(controller.startJob()).toBe(false)
    expect(controller.home()).toBe(false)
    expect(transport.sent).toHaveLength(0)
  })

  it('still allows emergencyStop and feedHold while readOnly - stopping is never refused', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport, { readOnly: true })

    controller.emergencyStop()
    controller.feedHold()
    expect(transport.sent.map((c) => c.m)).toEqual(['emergencyStop', 'feedHold'])
  })
})

describe('UccncController disconnect', () => {
  it('rejects pending calls and resets capabilities when the transport closes', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    await connectWithHello(controller, transport, { capabilities: ALL_CAPS })

    const pending = controller.sendCommandAwait('$H')
    transport.emitClose('bridge process exited')

    const result = await pending!
    expect(result.ok).toBe(false)
    expect(controller.connectionPhase()).toBe('disconnected')
    expect(controller.capabilities).toEqual(NO_CAPS)
  })
})
