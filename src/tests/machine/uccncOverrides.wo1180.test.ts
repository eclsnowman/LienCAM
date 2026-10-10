import { describe, expect, it } from 'vitest'
import type { ConsoleEntry, ControllerCapabilities, ControllerEvents, MachineStatus } from '../../lib/machine/controller'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import { SUPPORTED_BRIDGE_PROTOCOL, UccncController } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'

type OverrideCapabilities = { feed: boolean; rapid: boolean; spindle: boolean }

const CAPS: ControllerCapabilities & { overrides: OverrideCapabilities } = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
  overrides: { feed: true, rapid: false, spindle: true },
}

const STATUS: MachineStatus = {
  state: 'idle',
  subState: null,
  machinePos: { x: 0, y: 0, z: 0 },
  workPos: { x: 0, y: 0, z: 0 },
  feedMmMin: 0,
  spindleRpm: null,
  overrides: { feed: 87, rapid: 42, spindle: 123 },
  executingMoveId: null,
  buffer: null,
  inputs: null,
  homed: null,
  spindle: null,
}

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []

  async start(events: BridgeTransportEvents): Promise<void> { this.events = events }
  send(message: BridgeCallMessage): void { this.sent.push(message) }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.events?.onMessage(message) }
}

function hello(capabilities: ControllerCapabilities): BridgeMessage {
  return {
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.2',
      capabilities,
      readOnly: false,
    },
  }
}

async function connect(
  capabilities: ControllerCapabilities,
): Promise<{
  controller: UccncController
  transport: FakeTransport
  statuses: MachineStatus[]
  consoleEntries: ConsoleEntry[]
}> {
  const statuses: MachineStatus[] = []
  const consoleEntries: ConsoleEntry[] = []
  const events: ControllerEvents = {
    onStatus: (status) => statuses.push(status),
    onConsole: (entry) => consoleEntries.push(entry),
  }
  const controller = new UccncController(events)
  const transport = new FakeTransport()
  const pending = controller.connect({ kind: 'messages', transport })
  transport.emit(hello(capabilities))
  await pending
  return { controller, transport, statuses, consoleEntries }
}

describe('WO-1180 UCCNC override telemetry', () => {
  it('publishes live percentages while the hello keeps unsupported rapid null', async () => {
    const { controller, transport, statuses } = await connect(CAPS)

    transport.emit({ t: 'status', v: STATUS })

    expect(controller.status().overrides).toEqual({ feed: 87, rapid: null, spindle: 123 })
    expect(statuses).toHaveLength(1)
    expect(statuses[0].overrides).toEqual({ feed: 87, rapid: null, spindle: 123 })
  })

  it('does not send a command for a channel hello declares unsupported', async () => {
    const { controller, transport, consoleEntries } = await connect(CAPS)

    controller.setOverride({ kind: 'rapid', to: 'percent', percent: 50 })
    expect(transport.sent.filter((call) => call.m === 'setOverride')).toHaveLength(0)
    expect(consoleEntries).toContainEqual({
      dir: 'tx',
      text: '<setOverride: bridge declared rapid override unsupported - ignoring>',
      severity: 'info',
    })

    controller.setOverride({ kind: 'feed', to: 'percent', percent: 91 })
    expect(transport.sent.filter((call) => call.m === 'setOverride')).toHaveLength(1)
    expect(transport.sent.find((call) => call.m === 'setOverride')?.a).toEqual({
      change: { kind: 'feed', to: 'percent', percent: 91 },
    })
  })

  it('keeps an older bridge frame with no overrides unknown', async () => {
    const { overrides: _overrideDeclaration, ...oldCaps } = CAPS
    const { controller, transport, statuses } = await connect(oldCaps)
    const { overrides: _overrideValues, ...oldStatus } = STATUS

    transport.emit({ t: 'status', v: oldStatus as MachineStatus })

    expect(controller.status().overrides).toBeNull()
    expect(statuses[0].overrides).toBeNull()
  })
})
