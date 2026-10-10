// WO-472 - the app-side VFD safety follows elapsed wall-clock time from the
// last successful Modbus poll. Retry and poll cadence are transport details,
// never the threshold for stopping a commanded spindle.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  VFD_LINK_QUIET_STOP_MS,
  spindleSafetyStopIsActionable,
  vfdStopRequired,
  type VfdLinkState,
} from '../../lib/machine/vfd/vfdSafety'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents } from '../../lib/machine/controller'

const RUNNING_LINK: VfdLinkState = {
  enabled: true,
  connected: true,
  timeSinceLastSuccessMs: 0,
  bridgeConnected: true,
  clientConnected: true,
  faulted: false,
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

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }
  send(call: BridgeCallMessage): void {
    this.sent.push(call)
  }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
}

function noopEvents(onConsole: ControllerEvents['onConsole'] = () => {}): ControllerEvents {
  return {
    onStatus: () => {},
    onConsole,
    onJobEvent: () => {},
    onHomed: () => {},
    onAlarm: () => {},
  }
}

function vfdPush(up: boolean, running: boolean): Extract<BridgeMessage, { t: 'vfd' }> {
  return {
    t: 'vfd',
    v: {
      up,
      running,
      faulted: false,
      runStateWord: running ? 1 : 3,
      commandWord: 0,
      setpointWord: 0,
      consecutiveFailures: 0,
      lastStopReason: 'none',
      lastError: null,
      statusWords: [],
      status: {},
      upToSpeed: null,
    },
  }
}

async function connected(
  vfdPresent: boolean,
  events: ControllerEvents = noopEvents(),
): Promise<{ controller: UccncController; transport: FakeTransport }> {
  const transport = new FakeTransport()
  const controller = new UccncController(events)
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/wo-472',
      capabilities: NO_CAPS,
      readOnly: false,
      vfd: vfdPresent
        ? { present: true, verified: true, name: HUANYANG_GT.name }
        : { present: false, verified: false, name: null },
    },
  })
  await connecting
  return { controller, transport }
}

function spindleOffCalls(transport: FakeTransport): BridgeCallMessage[] {
  return transport.sent.filter((call) => call.m === 'spindleOff')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WO-472: the quiet-link threshold is elapsed time, not attempts', () => {
  it('matches the bridge edge exactly: 1000 ms is allowed and 1001 ms stops', () => {
    expect(vfdStopRequired({ ...RUNNING_LINK, timeSinceLastSuccessMs: VFD_LINK_QUIET_STOP_MS })).toEqual({ stop: false })
    const decision = vfdStopRequired({ ...RUNNING_LINK, timeSinceLastSuccessMs: VFD_LINK_QUIET_STOP_MS + 1 })
    expect(decision.stop).toBe(true)
    if (decision.stop) expect(decision.reason).toBe('serial-timeout')
  })

  it('uses the same boundary across irregular poll cadence', () => {
    const lastSuccessfulPollAt = 10_000
    for (const now of [10_001, 10_037, 10_619, 10_999, 11_000]) {
      expect(vfdStopRequired({ ...RUNNING_LINK, timeSinceLastSuccessMs: now - lastSuccessfulPollAt })).toEqual({ stop: false })
    }
    expect(vfdStopRequired({ ...RUNNING_LINK, timeSinceLastSuccessMs: 11_001 - lastSuccessfulPollAt }).stop).toBe(true)
  })

  it('does not let a fault bit defer the elapsed quiet-link stop', () => {
    expect(vfdStopRequired({
      ...RUNNING_LINK,
      faulted: true,
      timeSinceLastSuccessMs: VFD_LINK_QUIET_STOP_MS + 1,
    }).stop).toBe(true)
  })

  it('has no definition or attempt-count input that could tune its threshold', () => {
    expect(vfdStopRequired.length).toBe(1)
  })

  it('makes a link stop actionable only for a commanded spindle', () => {
    expect(spindleSafetyStopIsActionable(false)).toBe(false)
    expect(spindleSafetyStopIsActionable(true)).toBe(true)
  })
})

describe('WO-472: UccncController produces and consumes the real VFD link state', () => {
  it('does not stop or narrate a quiet link when the spindle was never commanded on', async () => {
    vi.useFakeTimers()
    const consoleLines: string[] = []
    const { controller, transport } = await connected(
      true,
      noopEvents((entry) => consoleLines.push(entry.text)),
    )
    try {
      transport.emit(vfdPush(true, false))
      await vi.advanceTimersByTimeAsync(500)
      transport.emit(vfdPush(false, false))
      await vi.advanceTimersByTimeAsync(VFD_LINK_QUIET_STOP_MS - 499)

      expect(spindleOffCalls(transport)).toEqual([])
      expect(consoleLines.filter((line) => line.startsWith('Spindle safety:'))).toEqual([])
    } finally {
      await controller.disconnect()
    }
  })

  it('stops after a failed/dead-link frame says running:false: no physical proof may block it', async () => {
    vi.useFakeTimers()
    const { controller, transport } = await connected(true)
    try {
      // `running` is the bridge's desired state, not physical evidence. It
      // may already be false even when its stop write did not reach the VFD.
      transport.emit(vfdPush(true, false))
      expect(controller.spindleOn('cw', 5000)).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      transport.emit(vfdPush(false, false))
      await vi.advanceTimersByTimeAsync(VFD_LINK_QUIET_STOP_MS - 500)
      expect(spindleOffCalls(transport)).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(spindleOffCalls(transport)).toHaveLength(1)

      // The bridge republishes the same dead-link snapshot. Those frames must
      // not turn one elapsed-time decision into repeated spindleOff calls.
      for (let frame = 0; frame < 3; frame++) {
        await vi.advanceTimersByTimeAsync(500)
        transport.emit(vfdPush(false, false))
      }
      expect(spindleOffCalls(transport)).toHaveLength(1)
    } finally {
      await controller.disconnect()
    }
  })

  it('stops immediately when a spindle is commanded after the quiet deadline already expired', async () => {
    vi.useFakeTimers()
    const { controller, transport } = await connected(true)
    try {
      transport.emit(vfdPush(true, false))
      await vi.advanceTimersByTimeAsync(VFD_LINK_QUIET_STOP_MS + 1)
      expect(spindleOffCalls(transport)).toEqual([])

      expect(controller.spindleOn('cw', 5000)).toBe(true)
      expect(spindleOffCalls(transport)).toHaveLength(1)
    } finally {
      await controller.disconnect()
    }
  })

  it('recovery resets the deadline from the later successful VFD frame', async () => {
    vi.useFakeTimers()
    const { controller, transport } = await connected(true)
    try {
      transport.emit(vfdPush(true, true))
      expect(controller.spindleOn('cw', 5000)).toBe(true)
      await vi.advanceTimersByTimeAsync(731)
      transport.emit(vfdPush(true, true))

      await vi.advanceTimersByTimeAsync(VFD_LINK_QUIET_STOP_MS)
      expect(spindleOffCalls(transport)).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(spindleOffCalls(transport)).toHaveLength(1)
    } finally {
      await controller.disconnect()
    }
  })

  it('does not acquire the VFD rule for a no-VFD UCCNC session', async () => {
    vi.useFakeTimers()
    const { controller, transport } = await connected(false)
    try {
      // A malformed or stale VFD push cannot create a link this hello did not
      // declare. GRBL has no such Modbus VFD producer at all.
      transport.emit(vfdPush(true, true))
      await vi.advanceTimersByTimeAsync(VFD_LINK_QUIET_STOP_MS + 1)
      expect(spindleOffCalls(transport)).toEqual([])
    } finally {
      await controller.disconnect()
    }
  })
})
