// WO-422 (ADR-0041): machineSession talks to the MachineController INTERFACE,
// and connectMachine chooses the backend behind it. These tests drive the real
// session singleton - no mocked controller - and assert two things the whole
// abstraction exists for:
//
//  1. each connection kind produces a controller with the capabilities that
//     backend can honestly claim, and
//  2. capability-gated program routes are refused rather than accepted and
//     silently ignored.
//
// The bridge is exercised with a fake message channel in place of
// bridgeTransport's WebSocket: the protocol is the contract (same posture as
// WO-421's tests), and no bridge process or hardware is involved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

/** The AXBB-E's real answer: everything except the spindle (Modbus VFD on a
 *  separate link) and the G-code text path (it has no interpreter). */
const BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

// The real BridgeTransport declares private instance fields, so no class
// outside its own declaration can satisfy `typeof BridgeTransport`
// structurally - the fake must EXTEND it (see hardwareEstop.test.tsx), which
// happens inside the vi.mock factory where the real class is reachable via
// importOriginal.
interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}
const fakeBridge: { last: FakeBridgeTransport | null } = { last: null }

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  // Stands in for bridgeTransport's WebSocket. Sends hello the moment the
  // controller attaches, exactly as the bridge does.
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      fakeBridge.last = this
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: { protocol: 1, bridge: 'fake-bridge 0.0', capabilities: BRIDGE_CAPABILITIES, readOnly: false },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: FakeBridgeTransport })
})

const session = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
  }
  vi.useRealTimers()
})

async function connect(kind: 'serial' | 'simulator' | 'bridge'): Promise<void> {
  if (kind === 'bridge') {
    // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
    useCamStore.setState((state) => ({
      project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
    }))
  }
  const pending = session.connectMachine(kind)
  await vi.advanceTimersByTimeAsync(300)
  await pending
}

describe('WO-422: connectMachine picks a backend, and the session sees only the interface', () => {
  it('the simulator connects and declares BOTH the geometry and G-code text capabilities it really has (WO-433)', async () => {
    await connect('simulator')

    expect(session.getMachineController().connectionPhase()).toBe('connected')
    expect(useMachineControl.getState().connectionKind).toBe('simulator')
    // WO-433: the simulator is now the native SimulatedController (ADR-0041),
    // not GrblController over SimulatedGrblTransport - it honestly carries its
    // own interpreter for both shapes ADR-0041 exists to distinguish, unlike
    // the old GRBL-emulator-backed simulator, which could only ever claim the
    // text path.
    expect(session.controllerCapabilities()).toEqual({
      geometryQueue: true,
      executingMoveId: true,
      bufferSeconds: false,
      gcodeText: true,
      machineProgram: true,
      perAxisHoming: true,
      ownsSpindle: true,
      spindleCommands: false,
    })
  })

  it('the bridge connects to a UccncController and adopts the capabilities the bridge reported', async () => {
    await connect('bridge')

    expect(session.getMachineController().connectionPhase()).toBe('connected')
    expect(useMachineControl.getState().connectionKind).toBe('bridge')
    expect(session.controllerCapabilities()).toEqual(BRIDGE_CAPABILITIES)
    // Capabilities are the BRIDGE's answer, never a hardcoded one: this
    // backend is the only one that can claim the geometry path.
    expect(session.controllerCapabilities()?.geometryQueue).toBe(true)
  })

  it('reports no capabilities at all while nothing is connected', () => {
    expect(session.controllerCapabilities()).toBeNull()
  })

  it('switching from the bridge back to the simulator installs the native SimulatedController again', async () => {
    await connect('bridge')
    expect(session.controllerCapabilities()?.gcodeText).toBe(false)

    const pending = session.disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending

    await connect('simulator')
    expect(session.controllerCapabilities()?.gcodeText).toBe(true)
  })
})

describe('WO-422: a capability-gated route is not offered when the capability is false', () => {
  it('refuses to arm a G-code program on a controller with no interpreter, in a sentence', async () => {
    await connect('bridge')

    const result = session.loadMachineProgram('geometry-only.nc', 'G21 G90\nG1 X10 F600\n')

    expect(result.lines).toEqual([])
    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toBe(
      'G-code file refused: this controller runs setups, not G-code files - load the setup instead.',
    )
  })
})
