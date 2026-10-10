import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
  BridgeVfdFrameObserver,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineController, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

// WO-2041 (machine session 2026-09-26, finding F11): Stop/Reset pressed during
// a Measure crossing halted the machine and Z held, but the console blamed a
// soft limit and a truncated move. These drive the operator's Stop/Reset door
// (executeOperatorStopReset) against a connected fake bridge and feed the
// bridge's own WO-934 / WO-933 report lines back through the session.

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

interface FakeTransportShape {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const bridge = vi.hoisted(() => ({ instances: [] as FakeTransportShape[] }))

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport implements FakeTransportShape {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor(url?: string, machineId?: string | null, onVfdFrame?: BridgeVfdFrameObserver | null) {
      super(url, machineId, onVfdFrame)
      bridge.instances.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: { protocol: 1, bridge: 'WO-2041-fake-bridge', capabilities: CAPABILITIES, readOnly: false },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void { this.sent.push(message) }
    async close(): Promise<void> { this.fakeEvents?.onClose(null) }
    emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const session = await import('../../lib/machine/machineSession')
const { executeOperatorStopReset } = await import('../../lib/machine/operatorTransport')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

// The crossing the 09-26 session stopped: machine X 462.082 Y 522.760, Z held 128.1.
const TRUNCATED =
  '[bridge] THE MOVE WAS TRUNCATED AND IT REPORTED SUCCESS. an absolute XY move to X730 Y50 asked for 527.4 mm '
  + 'and the machine moved 283.1 mm - short by 244.3 mm. The usual cause is a SOFT LIMIT clamping the move instead '
  + 'of refusing it: the controller does exactly as much as it is allowed and reports ok. Measured 2026-08-23 on '
  + 'this machine, a 1 mm jog produced 0.1 mm and reported success. Do not read the earlier success as the full '
  + 'distance having happened.'
const NEVER_RAN =
  '[bridge] THE MACHINE ACCEPTED A MOVE AND DID NOT MAKE IT. an absolute Z move to Z128.1 was accepted by the '
  + 'controller (rc=0) and after 1500 ms nothing has moved and the board reports Idle. Acceptance is not execution: '
  + 'the move is in the buffer and is not being run. Do NOT read the earlier success as the move having happened.'

function status(state: MachineStatus['state']): MachineStatus {
  return {
    state,
    subState: null,
    machinePos: { x: 462.082, y: 522.76, z: 128.1 },
    workPos: { x: 462.082, y: 522.76, z: 128.1 },
    feedMmMin: state === 'run' ? 3000 : 0,
    spindleRpm: 0,
    overrides: null,
    executingMoveId: null,
    buffer: null,
    inputs: null,
    homed: { X: true, Y: true, Z: true },
    spindle: null,
  }
}

function bridgeSays(transport: FakeTransportShape, text: string): void {
  transport.emit({ t: 'console', v: { dir: 'rx', text, severity: 'warn' } } as BridgeMessage)
}

function consoleLines(): Array<{ text: string; severity: string }> {
  return useMachineControl.getState().consoleLines.map(({ text, severity }) => ({ text, severity }))
}

// Architect re-scope 2026-09-26 1:05 PM CT: a report names the operator's Stop
// only when it is about the move that was in flight at the press, read from
// the report's own words. So every case sends its crossing through the
// production controller first; the bridge's report names the move it watched.
type Crossing = (ctrl: MachineController) => boolean
/** The crossing TRUNCATED names: "an absolute XY move to X730 Y50". */
const CROSSING_TO_XY: Crossing = (ctrl) => ctrl.jogToWorkXY(730, 50, 3000)
/** The crossing NEVER_RAN names: "an absolute Z move to Z128.1". */
const CROSSING_TO_Z: Crossing = (ctrl) => ctrl.jogToMachineZ(128.1, 600)
/** A crossing neither report names: a report about X730 Y50 is not its report. */
const OTHER_CROSSING: Crossing = (ctrl) => ctrl.jogToWorkXY(432.5125, 346.995, 3000)

async function connectedMidCrossing(crossing: Crossing = CROSSING_TO_XY): Promise<FakeTransportShape> {
  await session.connectMachine('bridge')
  expect(useMachineControl.getState().connectionPhase).toBe('connected')
  const transport = bridge.instances[bridge.instances.length - 1]
  // The operator has cleared the connect-time E-STOP latch: moves may go out.
  session.__resetEstopInterlockForTest()
  transport.emit({ t: 'status', v: status('idle') } as BridgeMessage)
  expect(crossing(session.getMachineController())).toBe(true)
  transport.emit({ t: 'status', v: status('run') } as BridgeMessage)
  transport.sent = []
  useMachineControl.setState({ consoleLines: [] })
  return transport
}

function pressStopReset(transport: FakeTransportShape, boardCall: 'reset' | 'stopJob' = 'reset'): void {
  expect(executeOperatorStopReset()).toBe(true)
  // The press reached the board: this is the production Stop/Reset door.
  expect(transport.sent.map((call) => call.m)).toContain(boardCall)
  transport.emit({ t: 'status', v: status('idle') } as BridgeMessage)
}

beforeEach(() => {
  bridge.instances = []
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useMachineControl.setState({ connectionPhase: 'disconnected', connectionKind: null, consoleLines: [] })
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
})

describe('WO-2041 a Stop during a crossing is named as the operator\'s Stop', () => {
  it('says the operator stopped it, never a soft limit, when the crossing is cut short by Stop/Reset', async () => {
    const transport = await connectedMidCrossing()

    pressStopReset(transport)
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: session.OPERATOR_STOP_HALTED_NOTICE, severity: 'info' })
    expect(session.OPERATOR_STOP_HALTED_NOTICE).toBe(
      'Stopped by the operator: the machine halted and is holding where it stopped.',
    )
    for (const { text } of lines) {
      expect(text).not.toMatch(/SOFT LIMIT|TRUNCATED|REPORTED SUCCESS/i)
    }
  })

  it('names the Stop the same way when the crossing belongs to a running program (Stop, not Reset)', async () => {
    const transport = await connectedMidCrossing()
    vi.spyOn(session.getMachineController(), 'hasActiveJob').mockReturnValue(true)

    pressStopReset(transport, 'stopJob')
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: session.OPERATOR_STOP_HALTED_NOTICE, severity: 'info' })
    expect(lines.map(({ text }) => text)).not.toContain(TRUNCATED)
  })

  it('names a Stop that landed before the move began the same way, not as a move that never ran', async () => {
    const transport = await connectedMidCrossing(CROSSING_TO_Z)

    pressStopReset(transport)
    bridgeSays(transport, NEVER_RAN)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: session.OPERATOR_STOP_HALTED_NOTICE, severity: 'info' })
    expect(lines.map(({ text }) => text)).not.toContain(NEVER_RAN)
  })

  it('keeps the bridge diagnosis word for word when no Stop was pressed', async () => {
    const transport = await connectedMidCrossing()

    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })

  it('keeps a completed move diagnosis when Reset is pressed after motion ended but before its report', async () => {
    const transport = await connectedMidCrossing()
    // The crossing moves, is genuinely cut short and comes to rest on its own.
    transport.emit({ t: 'status', v: status('run') } as BridgeMessage)
    transport.emit({ t: 'status', v: status('idle') } as BridgeMessage)

    pressStopReset(transport)
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })

  it('spends one Stop on one move: a later truncated move keeps its diagnosis', async () => {
    const transport = await connectedMidCrossing()

    pressStopReset(transport)
    bridgeSays(transport, TRUNCATED)
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines.filter(({ text }) => text === session.OPERATOR_STOP_HALTED_NOTICE)).toHaveLength(1)
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
  })

  it('keeps the diagnosis when Reset was pressed at rest and a new move then truncates within seconds', async () => {
    const transport = await connectedMidCrossing(OTHER_CROSSING)
    transport.emit({ t: 'status', v: status('idle') } as BridgeMessage)

    pressStopReset(transport)
    // A new move starts after the Reset and is genuinely cut short.
    transport.emit({ t: 'status', v: status('run') } as BridgeMessage)
    transport.emit({ t: 'status', v: status('idle') } as BridgeMessage)
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })

  it('keeps the diagnosis for a move started after the stopped crossing came to rest', async () => {
    const transport = await connectedMidCrossing(OTHER_CROSSING)

    pressStopReset(transport)
    transport.emit({ t: 'status', v: status('jog') } as BridgeMessage)
    transport.emit({ t: 'status', v: status('idle') } as BridgeMessage)
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })

  it('still names the Stop when the stopped crossing reports run while it decelerates', async () => {
    const transport = await connectedMidCrossing()

    expect(executeOperatorStopReset()).toBe(true)
    transport.emit({ t: 'status', v: status('run') } as BridgeMessage)
    transport.emit({ t: 'status', v: status('idle') } as BridgeMessage)
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: session.OPERATOR_STOP_HALTED_NOTICE, severity: 'info' })
    expect(lines.map(({ text }) => text)).not.toContain(TRUNCATED)
  })

  // Architect re-scope 2026-09-26: the Stop wording binds to a move the
  // controller accepted BEFORE the Stop. A move accepted after it keeps
  // today's diagnosis, whatever the frames or the timing.
  it('keeps the never-ran diagnosis for a later accepted move that never enters a moving state', async () => {
    const transport = await connectedMidCrossing(OTHER_CROSSING)

    pressStopReset(transport)
    // The stopped crossing is at rest. Reset again, at rest, then a new move
    // is accepted and never runs - no moving-state frame ever arrives.
    pressStopReset(transport)
    expect(session.getMachineController().jogToMachineZ(128.1, 600)).toBe(true)
    expect(transport.sent.map((call) => call.m)).toContain('jogToMachineZ')
    bridgeSays(transport, NEVER_RAN)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: NEVER_RAN, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })

  it('keeps the truncation diagnosis for a move accepted after a Reset at rest, with no frame in between', async () => {
    const transport = await connectedMidCrossing(OTHER_CROSSING)
    transport.emit({ t: 'status', v: status('idle') } as BridgeMessage)

    expect(executeOperatorStopReset()).toBe(true)
    expect(session.getMachineController().jogToWorkXY(730, 50, 3000)).toBe(true)
    expect(transport.sent.map((call) => call.m)).toContain('jogToWorkXY')
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })

  it('keeps the truncation diagnosis for a move accepted while the stopped crossing still decelerates', async () => {
    const transport = await connectedMidCrossing(OTHER_CROSSING)

    expect(executeOperatorStopReset()).toBe(true)
    expect(session.getMachineController().jog('Z', 5, 600)).toBe(true)
    expect(transport.sent.map((call) => call.m)).toContain('jog')
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })

  // Architect note 2026-09-26 12:40 PM CT: a call is not an acceptance. A
  // later move spends the Stop only when its own answer says the controller
  // accepted it; a refused answer leaves the stopped crossing's report named
  // as the operator's Stop.
  function answer(transport: FakeTransportShape, method: string, reply: { ok: boolean; v?: unknown; error?: string }): void {
    const call = transport.sent.find((sent) => sent.m === method)
    expect(call, `${method} reached the bridge`).toBeDefined()
    transport.emit({ t: 'reply', seq: call!.seq, ...reply } as BridgeMessage)
  }

  async function stoppedCrossingThenRefused(send: (transport: FakeTransportShape) => Promise<unknown>): Promise<void> {
    const transport = await connectedMidCrossing()

    pressStopReset(transport)
    await send(transport)
    // The bridge's watch is still the stopped crossing's: its report arrives.
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: session.OPERATOR_STOP_HALTED_NOTICE, severity: 'info' })
    expect(lines.map(({ text }) => text)).not.toContain(TRUNCATED)
  }

  it('still names the Stop when a continuous jog after it is refused', async () => {
    await stoppedCrossingThenRefused(async (transport) => {
      const started = session.getMachineController().jogStartContinuous!('X', 1, 3000)
      answer(transport, 'jogStart', { ok: true, v: false })
      expect(await started).toBe(false)
    })
  })

  it('still names the Stop when an awaited move to work X Y after it is refused', async () => {
    await stoppedCrossingThenRefused(async (transport) => {
      const moved = session.getMachineController().jogToWorkXYAwait!(730, 50, 3000)
      expect(moved).not.toBeNull()
      answer(transport, 'jogToWorkXY', { ok: true, v: false })
      expect(await moved).toBe(false)
    })
  })

  it('still names the Stop when an awaited move to machine Z after it is rejected', async () => {
    await stoppedCrossingThenRefused(async (transport) => {
      const moved = session.getMachineController().jogToMachineZAwait!(128.1, 600)
      expect(moved).not.toBeNull()
      answer(transport, 'jogToMachineZ', { ok: false, error: 'the controller refused the move' })
      await expect(moved).rejects.toThrow()
    })
  })

  it('still names the Stop when a probe after it is refused', async () => {
    await stoppedCrossingThenRefused(async (transport) => {
      const touched = session.getMachineController().probe('Z', 20, 100)
      answer(transport, 'probe', { ok: true, v: { ok: false, at: null } })
      expect((await touched).ok).toBe(false)
    })
  })

  it('keeps the truncation diagnosis for an awaited move accepted after the Stop', async () => {
    const transport = await connectedMidCrossing(OTHER_CROSSING)

    pressStopReset(transport)
    const moved = session.getMachineController().jogToWorkXYAwait!(730, 50, 3000)
    expect(moved).not.toBeNull()
    answer(transport, 'jogToWorkXY', { ok: true, v: true })
    expect(await moved).toBe(true)
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })

  // Fourth audit (2026-09-26): Cycle Resume only releases feed hold on the
  // bridge; it arms no new move watch, so the stopped crossing's report is
  // still the stopped crossing's.
  it('still names the Stop when Cycle Resume is accepted before the stopped crossing reports', async () => {
    const transport = await connectedMidCrossing()

    pressStopReset(transport)
    expect(session.getMachineController().cycleResume()).toBe(true)
    expect(transport.sent.map((call) => call.m)).toContain('cycleResume')
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: session.OPERATOR_STOP_HALTED_NOTICE, severity: 'info' })
    expect(lines.map(({ text }) => text)).not.toContain(TRUNCATED)
  })

  it('keeps the truncation diagnosis when the move the Stop halted is asked for again and accepted', async () => {
    const transport = await connectedMidCrossing()

    pressStopReset(transport)
    // The same move again: the report cannot say which of the two it is about.
    expect(session.getMachineController().jogToWorkXY(730, 50, 3000)).toBe(true)
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })

  it('names the Stop for a stopped jog, reading the jog the bridge reports as numbers', async () => {
    const transport = await connectedMidCrossing((ctrl) => ctrl.jog('X', -738, 3000))

    pressStopReset(transport)
    bridgeSays(
      transport,
      '[bridge] THE MOVE WAS TRUNCATED AND IT REPORTED SUCCESS. a jog of -738 mm on X at 3000 mm/min asked for '
        + '738 mm and the machine moved 518.495 mm - short by 219.505 mm. The usual cause is a SOFT LIMIT clamping '
        + 'the move instead of refusing it: the controller does exactly as much as it is allowed and reports ok.',
    )

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: session.OPERATOR_STOP_HALTED_NOTICE, severity: 'info' })
    for (const { text } of lines) expect(text).not.toMatch(/SOFT LIMIT|TRUNCATED/)
  })

  it('keeps the diagnosis for a report that arrives long after the Stop - it is about a later move', async () => {
    const transport = await connectedMidCrossing()
    let now = 10_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)

    pressStopReset(transport)
    now += 3_500
    bridgeSays(transport, TRUNCATED)

    const lines = consoleLines()
    expect(lines).toContainEqual({ text: TRUNCATED, severity: 'warn' })
    expect(lines.map(({ text }) => text)).not.toContain(session.OPERATOR_STOP_HALTED_NOTICE)
  })
})
