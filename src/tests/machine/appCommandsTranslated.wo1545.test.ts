// @vitest-environment jsdom
//
// WO-1545 slice 1 - EVERY G-CODE LINE THE APP ITSELF ISSUES GOES THROUGH THE
// TRANSLATOR, AND NONE OF THEM REACHES A GEOMETRY CONTROLLER AS TEXT.
//
// Operator at the machine, 2026-09-14: "I keep hearing the goddamn phrase we can't
// run G-Code. This needs to not be the case anymore." The app's own features
// wrote raw lines (`sendCommand`), the UCCNC backend refused text, and the app
// called that the machine's limit. The Z probe cycle even reported "the probe
// never made contact within 50 mm" for a command that was never sent.
//
// Driven here through the REAL `UccncController` on the real session singleton,
// over a fake bridge socket reporting Operator's capabilities (`gcodeText: false`).
// Every assertion about the controller is about what reached THAT WIRE:
//
//   - the modal senders (G20/G21/G90/G91: units sync, probe restore, alarm
//     recovery) put NOTHING on the wire and the modal state is held locally;
//   - a sender whose native call is a later slice (probe, work offset, TLO,
//     moves) is named with its slice - never a controller limit, never a miss;
//   - no connect-time "no G-code text path" sentence exists any more;
//   - a controller that takes text (GRBL, the simulator) still gets the line.
//
// NOT CLAIMED: hardware. Slice 1 has no board readback; the board proof in the
// order (probe touch, offset write, TLO, park) belongs to slices 2-4.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineController, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

/** Operator's AXBB-E as the bridge reports it: no interpreter on the wire. */
const BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

/** Every call the app put on the wire. */
let sent: BridgeCallMessage[] = []
let bridgeEvents: BridgeTransportEvents | null = null

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        const zero = { x: 0, y: 0, z: 0 }
        const offsets = { G54: zero, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'wo-1545-fake 0.0',
            capabilities: BRIDGE_CAPABILITIES,
            readOnly: false,
            workOffsets: { current: offsets, profile: offsets },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        sent.push(message)
        // A real bridge answers the calls the connect-time reconciliation awaits.
        if (message.m === 'selectWcs') {
          bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
        }
        if (message.m === 'setWorkOffset') {
          const a = message.a as { x?: number; y?: number; z?: number }
          bridgeEvents?.onMessage({
            t: 'reply',
            seq: message.seq,
            ok: true,
            v: { ok: true, offset: { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 } },
          })
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  clearToolLengthOffset,
  connectMachine,
  disconnectMachine,
  getMachineController,
  recoverFromProbeAlarm,
  runDirectionalProbeTouch,
  runSurfaceMeshProbeCycle,
  sendAppCommand,
  sendAppCommandAwait,
} = await import('../../lib/machine/machineSession')
const appCommand = await import('../../lib/gcode/appCommand')

const PROBE_CONFIG = {
  positioningFeed: 1200,
  fastFeed: 300,
  slowFeed: 40,
  retract: 2,
  maxTravel: 30,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
}

function idleStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

const textFrames = () => sent.filter((m) => m.m === 'sendCommand' || m.m === 'sendCommandAwait')
const consoleText = () => useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  bridgeEvents?.onMessage({ t: 'status', v: idleStatus() } as BridgeMessage)
  // Only what the app issues AFTER the connection is under test.
  sent = []
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  mem.clear()
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useMachineControl.setState({ consoleLines: [], parserModal: null })
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

describe('WO-1545: modal senders on a controller that takes geometry', () => {
  it('holds G20/G21/G90/G91 locally and puts nothing on the wire', async () => {
    await connectBridge()
    const ctrl = getMachineController()

    for (const line of ['G20', 'G91']) {
      const outcome = sendAppCommand(line)
      expect(outcome, line).toMatchObject({ ok: true, sent: false, translated: 'modal', message: null })
    }
    expect(appCommand.appCommandModal(ctrl)).toEqual({ units: 'inch', distanceMode: 'incremental' })
    // The Control page chip and the pendant read the modal state from the store.
    expect(useMachineControl.getState().parserModal).toMatchObject({ units: 'inch', distanceMode: 'incremental' })

    const awaited = await sendAppCommandAwait('G21 G90')
    expect(awaited).toMatchObject({ ok: true, sent: false, translated: 'modal' })
    expect(appCommand.appCommandModal(ctrl)).toEqual({ units: 'mm', distanceMode: 'absolute' })

    expect(textFrames()).toEqual([])
    expect(consoleText()).not.toMatch(/geometry, not G-code text|no G-code text path/)
  })

  it('recovers from a probe alarm without sending G90/G20 as text', async () => {
    await connectBridge()
    sendAppCommand('G20')
    sent = []

    recoverFromProbeAlarm()

    expect(textFrames()).toEqual([])
    expect(appCommand.appCommandModal(getMachineController())).toEqual({ units: 'inch', distanceMode: 'absolute' })
  })

  it('starts every new connection from the power-on modal state', async () => {
    await connectBridge()
    sendAppCommand('G20')
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending

    await connectBridge()
    expect(appCommand.appCommandModal(getMachineController())).toEqual({ units: 'mm', distanceMode: 'absolute' })
  })

  it('says no "no G-code text path" sentence at connect', async () => {
    await connectBridge()
    bridgeEvents?.onMessage({ t: 'phase', v: { phase: 'connected', version: 'wo-1545-fake 0.0' } } as BridgeMessage)
    expect(consoleText()).not.toContain('no G-code text path')
    expect(consoleText()).not.toContain('cannot run the probe routines')
  })
})

describe('WO-1545: senders whose native call is a later slice', () => {
  // WO-1546 re-pin: slice 2 wired the probe cycle to the native probe call
  // (full coverage in probingNativeProbe.wo1546.test.ts).
  it('sends the Z probe cycle as the native probe call, never as text or a probe miss', async () => {
    await connectBridge()

    const pending = runDirectionalProbeTouch('Z', '-', PROBE_CONFIG)
    await vi.advanceTimersByTimeAsync(50)
    expect(sent.find((m) => m.m === 'probe')?.a).toEqual({ axis: 'Z', targetMm: -30, feedMmMin: 300 })
    expect(textFrames()).toEqual([])

    // This fake never answers the probe; the connection closing ends the cycle.
    const closing = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await closing
    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('never made contact')
    expect(result.message).not.toContain('WO-1545 slice 2')
    expect(result.message).not.toMatch(/geometry, not G-code text|no G-code text path/)
  })

  it('names the settings line; the pad zero (WO-1547), G49 and the park move (WO-1548) run; nothing reaches the wire as text', async () => {
    await connectBridge()
    useMachineControl.setState({ activeWcs: 'G54' })

    // WO-1547 re-pin: slice 3 wired the offset line to setWorkOffset.
    const zero = await sendAppCommandAwait('G10 L20 P0 Z10')
    expect(zero).toMatchObject({ ok: true, sent: true })
    expect(sent.find((m) => m.m === 'setWorkOffset')?.a).toEqual({ wcs: 'G54', z: -10 })

    // WO-1548 re-pin: slice 4 wired G49 and moves (toolLengthAndParkMoves.wo1548.test.ts
    // drives them against the board's frames). With no offset applied G49 changes nothing.
    expect(clearToolLengthOffset()).toBe(true)
    expect(consoleText()).not.toContain('slice 4')

    const park = sendAppCommand('G53 G0 Z0')
    expect(park).toMatchObject({ ok: true, sent: true, translated: null })

    const setting = await sendAppCommandAwait('$110=5000')
    expect(setting).toMatchObject({ ok: false, sent: false, translated: 'noEquivalent' })
    expect(setting?.message).toContain('$110=5000')
    expect(setting?.message).toContain('machine definition')

    expect(textFrames()).toEqual([])
  })
})

describe('WO-1545: the translator reads the line', () => {
  it('classifies each app-issued line; a modal word beside an unwired command is not applied', () => {
    expect(appCommand.planAppCommand('G20')).toEqual({ kind: 'modal', units: 'inch', distanceMode: null })
    expect(appCommand.planAppCommand('G21 G91')).toEqual({ kind: 'modal', units: 'mm', distanceMode: 'incremental' })
    expect(appCommand.planAppCommand('G21 G91 G38.2 Z-50 F300')).toMatchObject({ kind: 'notWired', slice: 2 })
    expect(appCommand.planAppCommand('G10 L2 P1 X1')).toMatchObject({ kind: 'notWired', slice: 3 })
    expect(appCommand.planAppCommand('G43.1 Z0.5')).toMatchObject({ kind: 'notWired', slice: 4 })
    expect(appCommand.planAppCommand('G49')).toMatchObject({ kind: 'notWired', slice: 4 })
    expect(appCommand.planAppCommand('G91 G0 Z2')).toMatchObject({ kind: 'notWired', slice: 4 })
    expect(appCommand.planAppCommand('M8')).toMatchObject({ kind: 'noEquivalent' })
  })
})

describe('WO-1545: a controller that takes text keeps its text lines (GRBL, simulator)', () => {
  function textController(): MachineController & {
    sendCommand: ReturnType<typeof vi.fn>
    sendCommandAwait: ReturnType<typeof vi.fn>
  } {
    return {
      capabilities: { ...BRIDGE_CAPABILITIES, gcodeText: true },
      connectionPhase: () => 'connected',
      sendCommand: vi.fn(() => true),
      sendCommandAwait: vi.fn(() => Promise.resolve({ ok: false, message: 'ALARM:5' })),
    } as unknown as MachineController & {
      sendCommand: ReturnType<typeof vi.fn>
      sendCommandAwait: ReturnType<typeof vi.fn>
    }
  }

  it('sends the modal line as text and reports it sent', () => {
    const ctrl = textController()
    const outcome = appCommand.sendAppCommand(ctrl, 'G20')
    expect(ctrl.sendCommand).toHaveBeenCalledWith('G20')
    expect(outcome).toMatchObject({ ok: true, sent: true, translated: null })
  })

  it('passes the controller reply through, so a real miss stays a miss', async () => {
    const ctrl = textController()
    const outcome = await appCommand.sendAppCommandAwait(ctrl, 'G21 G91 G38.2 Z-30 F300')
    expect(ctrl.sendCommandAwait).toHaveBeenCalledWith('G21 G91 G38.2 Z-30 F300')
    expect(outcome).toEqual({ ok: false, message: 'ALARM:5', sent: true, translated: null, modal: null })
  })
})

// Independent review, 2026-09-15: on UCCNC "Run Z surface" disarmed the loaded
// program (readiness "cycle in progress", mesh cleared) and only THEN found its
// first move was not wired - leaving Start blocked for a cycle that never ran.
describe('WO-1545: an unwired mesh probe cycle leaves the loaded program armed', () => {
  // WO-1548 re-pin: the moves run now, and a controller with the native probe
  // call runs the touch too (toolLengthAndParkMoves.wo1548.test.ts drives that
  // cycle). Only a controller with neither text nor a probe call is left to name
  // the touch - modelled here by taking the probe call away.
  it('on a controller with no probe call, names the unwired touch before disarming anything, and sends nothing', async () => {
    const { planSurfaceMesh } = await import('../../lib/machine/zSurfaceMesh')
    const program = [
      'G21 G90 G54', 'G0 X1 Y1 Z5', 'G1 Z-0.2 F100', 'G1 X9 Y1 F400',
      'G1 X9 Y9', 'G1 X1 Y9', 'G1 X1 Y1', 'G0 Z5', 'M30',
    ].join('\n')
    const plan = planSurfaceMesh(program, { marginMm: 1, pointsX: 3, pointsY: 3, fadeMm: 5 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return

    await connectBridge()
    const ctrl = getMachineController()
    // Homing is a precondition of the cycle, not what this test is about.
    if (typeof ctrl.homedAxesThisSession === 'function') {
      vi.spyOn(ctrl as { homedAxesThisSession: () => unknown }, 'homedAxesThisSession').mockReturnValue(null)
    }
    vi.spyOn(ctrl, 'homedThisSession').mockReturnValue(true)
    const armed = { ready: true, reason: 'Program armed.' }
    const previousMesh = { active: true, sourceName: 'previous.nc' } as never
    useMachineControl.setState({
      programText: program,
      activeWcs: 'G54',
      programReadiness: armed,
      surfaceMesh: previousMesh,
    })

    Object.defineProperty(ctrl, 'probe', { value: undefined, configurable: true, writable: true })
    sent = []
    let result: Awaited<ReturnType<typeof runSurfaceMeshProbeCycle>>
    try {
      result = await runSurfaceMeshProbeCycle(
        {
          points: plan.points,
          bounds: plan.setup.bounds,
          cutBounds: plan.setup.cutBounds,
          pointsX: 3,
          pointsY: 3,
          fadeMm: 5,
          safeMachineZ: 100,
          sourceProgramText: program,
          sourceName: 'mesh.nc',
          workOffset: 'G54',
        },
        PROBE_CONFIG,
        true,
      )
    } finally {
      delete (ctrl as { probe?: unknown }).probe
    }

    expect(result.ok).toBe(false)
    expect(result.message).toContain('G38.2')
    expect(result.message).toContain('WO-1545 slice 2')
    expect(useMachineControl.getState().programReadiness).toEqual(armed)
    expect(useMachineControl.getState().surfaceMesh).toBe(previousMesh)
    expect(sent.filter((m) => m.m !== 'queryStatus')).toEqual([])
  })
})
