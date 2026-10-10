// @vitest-environment jsdom
//
// WO-1548 (WO-1545 slice 4) - TOOL-LENGTH OFFSET AND APP-ISSUED MOVES RUN AS
// GEOMETRY ON A CONTROLLER THAT TAKES NO TEXT.
//
// Driven through the REAL `UccncController` on the real session singleton,
// over a fake bridge socket that plays the board. Its shapes are the recorded
// ones (src/tests/evidence/SESSION-2026-09-14/machine-2026-09-14/):
//
//   - the hello, status frames and setWorkOffset receipt of session*.ws-frames;
//   - the safe-Z approach of toolsetter-probe-2026-09-15T01-30-29-044Z.ndjson:
//     `jogToMachineZ 120` from machine Z 128.9, answered `true`, then "run"
//     frames walking Z down (128.5275 ... 120.005) and "idle" at Z 120.
//
// The fake keeps a work-offset register, so work position = machine position
// minus the active register, exactly as the board reports it. Every claim is
// about what reached THAT WIRE.
//
// NOT CLAIMED: hardware. A TLO apply and a park on machine PC are owed (Tier 1).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineController, MachineStatus } from '../../lib/machine/controller'
import type { MachineVec3 } from '../../lib/machine/types'
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

/** The recorded Z walk of `jogToMachineZ 120` from 128.9 (01:30:29 run). */
const RECORDED_Z_WALK = [
  128.9, 128.5275, 127.9925, 127.4175, 126.8625, 126.3075, 125.775, 125.2, 124.6225, 124.09,
  123.5125, 122.96, 122.405, 121.87, 121.315, 120.74, 120.25, 120.005,
]

function boardOffsets(): Record<string, MachineVec3> {
  return {
    G54: { x: 188.7325, y: 397.655, z: 110 },
    G55: { x: 288.7325, y: 397.655, z: 110 },
    G56: { x: 0, y: 0, z: 0 },
    G57: { x: 0, y: 0, z: 0 },
    G58: { x: 0, y: 0, z: 0 },
    G59: { x: 0, y: 0, z: 0 },
  }
}

let sent: BridgeCallMessage[] = []
let bridgeEvents: BridgeTransportEvents | null = null
let board = boardOffsets()
let machinePos: MachineVec3 = { x: 738, y: 724.5, z: 128.9 }
/** Status frames still to come for the move in progress; empty = idle. */
let motion: Array<{ state: 'run' | 'idle'; pos: MachineVec3 }> = []
/** Method -> the value the board answers the next call of it with. */
let answer: Record<string, unknown> = {}

function boardStatus(state: 'run' | 'idle', pos: MachineVec3): MachineStatus {
  const g54 = board.G54
  return {
    state,
    subState: null,
    machinePos: { ...pos },
    workPos: {
      x: Number((pos.x - g54.x).toFixed(4)),
      y: Number((pos.y - g54.y).toFixed(4)),
      z: Number((pos.z - g54.z).toFixed(4)),
    },
    feedMmMin: 0,
    spindleRpm: 0,
    overrides: null,
    executingMoveId: null,
    buffer: { moves: 0, capacitySeconds: 0.1 },
    inputs: null,
    homed: { X: true, Y: true, Z: true },
    spindle: null,
  } as MachineStatus
}

/** A straight walk in `steps` frames, then idle at the target. */
function walk(from: MachineVec3, to: MachineVec3, steps = 6): Array<{ state: 'run' | 'idle'; pos: MachineVec3 }> {
  const frames: Array<{ state: 'run' | 'idle'; pos: MachineVec3 }> = []
  for (let i = 0; i < steps; i++) {
    const t = i / steps
    frames.push({
      state: 'run',
      pos: {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t,
      },
    })
  }
  frames.push({ state: 'idle', pos: { ...to } }, { state: 'idle', pos: { ...to } })
  return frames
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'liencam-uccnc-bridge/0.4',
            capabilities: BRIDGE_CAPABILITIES,
            readOnly: false,
            workOffsets: { current: boardOffsets(), profile: boardOffsets() },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        sent.push(message)
        const reply = (v: unknown) => bridgeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v })
        switch (message.m) {
          case 'queryStatus': {
            const frame = motion.shift()
            if (frame) machinePos = { ...frame.pos }
            bridgeEvents?.onMessage({ t: 'status', v: boardStatus(frame?.state ?? 'idle', machinePos) } as BridgeMessage)
            reply(true)
            return
          }
          case 'jogToMachineZ': {
            const a = message.a as { z: number }
            const refused = answer.jogToMachineZ === false
            delete answer.jogToMachineZ
            reply(!refused)
            if (refused) return
            motion = Math.abs(machinePos.z - 128.9) < 1e-9 && a.z === 120
              ? [
                  ...RECORDED_Z_WALK.map((z) => ({ state: 'run' as const, pos: { ...machinePos, z } })),
                  { state: 'idle', pos: { ...machinePos, z: 120 } },
                  { state: 'idle', pos: { ...machinePos, z: 120 } },
                ]
              : walk(machinePos, { ...machinePos, z: a.z })
            return
          }
          case 'jogToWorkXY': {
            const a = message.a as { x: number; y: number }
            reply(true)
            motion = walk(machinePos, { x: a.x + board.G54.x, y: a.y + board.G54.y, z: machinePos.z })
            return
          }
          case 'selectWcs':
            reply(true)
            return
          case 'probe':
            // The probe ran and touched nothing: the bridge's "no contact" reply.
            reply({ ok: false, at: null })
            return
          case 'setWorkOffset': {
            const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
            const row = board[a.wcs]
            board[a.wcs] = { x: a.x ?? row.x, y: a.y ?? row.y, z: a.z ?? row.z }
            reply({ ok: true, reason: null, offset: { ...board[a.wcs] } })
            return
          }
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { controlMachine, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __armEstopInterlockForTest,
  __resetEstopInterlockForTest,
  applyToolLengthOffset,
  clearToolLengthOffset,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runFeatureProbeCycle,
  runParkMove,
  runSurfaceMeshProbeCycle,
  sendAppCommand,
  sendAppCommandAwait,
} = await import('../../lib/machine/machineSession')
const { planSurfaceMesh } = await import('../../lib/machine/zSurfaceMesh')

const textFrames = () => sent.filter((m) => m.m === 'sendCommand' || m.m === 'sendCommandAwait')
const moveCalls = () => sent
  .filter((m) => m.m === 'jogToMachineZ' || m.m === 'jogToWorkXY' || m.m === 'setWorkOffset')
  .map(({ m, a }) => ({ m, a }))
const consoleText = () => useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', machinePos) } as BridgeMessage)
  await vi.advanceTimersByTimeAsync(50)
  useMachineControl.setState({ activeWcs: 'G54' })
  // Only what the app issues AFTER the connection is under test.
  sent = []
}

/** Let an awaited door run against the board's frames. */
async function settle<T>(pending: Promise<T> | null): Promise<T | null> {
  if (!pending) return null
  let value: T | null = null
  let finished = false
  void pending.then((v) => { value = v; finished = true })
  for (let i = 0; i < 400 && !finished; i++) await vi.advanceTimersByTimeAsync(50)
  return value
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  answer = {}
  motion = []
  board = boardOffsets()
  machinePos = { x: 738, y: 724.5, z: 128.9 }
  mem.clear()
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useCamStore.setState({ machineWorkOffsets: {} })
  useMachineControl.setState({ consoleLines: [], parserModal: null, offsets: {} })
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

describe('WO-1548: a park runs as machine-absolute geometry moves', () => {
  it('raises to machine safe Z, waits for the board to report idle there, then moves XY to the machine park point', async () => {
    await connectBridge()
    const rapid = controlMachine(useCamStore.getState()).rapidRate
    expect(rapid).toBeGreaterThan(0)

    const started = runParkMove({ id: 'p1', label: 'Front', x: 100, y: 50 }, 120)
    expect(started).toEqual({ ok: true })

    // Only the Z move is on the wire while the board still walks Z down.
    await vi.advanceTimersByTimeAsync(300)
    expect(moveCalls()).toEqual([{ m: 'jogToMachineZ', a: { z: 120, feedMmMin: rapid } }])
    expect(machinePos.z).toBeLessThan(128.9)
    expect(machinePos.z).toBeGreaterThan(120)

    for (let i = 0; i < 100 && Math.abs(machinePos.x - 100) > 1e-6; i++) await vi.advanceTimersByTimeAsync(50)
    // The XY call carries the machine park point in work coordinates of G54.
    expect(moveCalls()).toEqual([
      { m: 'jogToMachineZ', a: { z: 120, feedMmMin: rapid } },
      { m: 'jogToWorkXY', a: { x: Number((100 - 188.7325).toFixed(4)), y: Number((50 - 397.655).toFixed(4)), feedMmMin: rapid } },
    ])
    expect(machinePos.x).toBeCloseTo(100, 6)
    expect(machinePos.y).toBeCloseTo(50, 6)
    expect(machinePos.z).toBe(120)
    expect(textFrames()).toEqual([])
  })

  it('an awaited machine-absolute move resolves only when the board reports idle at the target', async () => {
    await connectBridge()

    let finished = false
    const pending = sendAppCommandAwait('G53 G0 Z120')!
    void pending.then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(200)
    expect(finished).toBe(false)

    const outcome = await settle(pending)
    expect(outcome).toMatchObject({ ok: true, sent: true, message: null })
    expect(machinePos.z).toBe(120)
    expect(getMachineController().status().machinePos?.z).toBe(120)
    expect(textFrames()).toEqual([])
  })

  it('a move the board refuses is named as that refusal, and nothing waits for it', async () => {
    await connectBridge()
    answer = { jogToMachineZ: false }

    const outcome = await settle(sendAppCommandAwait('G53 G0 Z120'))

    expect(outcome).toMatchObject({ ok: false, sent: true })
    expect(outcome?.message).toBe('G53 G0 Z120: the controller refused jogToMachineZ.')
    expect(consoleText()).toContain('G53 G0 Z120: the controller refused jogToMachineZ.')
    expect(machinePos.z).toBe(128.9)
  })

  it('a combined XYZ line is named and nothing moves', async () => {
    await connectBridge()

    const outcome = await settle(sendAppCommandAwait('G53 G0 X1 Y2 Z3'))

    expect(outcome).toMatchObject({ ok: false, sent: false })
    expect(outcome?.message).toContain('G53 G0 X1 Y2 Z3:')
    expect(outcome?.message).not.toContain('slice 4')
    expect(moveCalls()).toEqual([])
  })
})

describe('WO-1548: the tool-length offset reaches the moves the board runs', () => {
  it('after a TLO apply of +12.5 mm a work-Z move lands 12.5 mm higher; after G49 it does not', async () => {
    await connectBridge()
    expect(useMachineControl.getState().offsets.G54).toEqual([188.7325, 397.655, 110])

    const plain = await settle(sendAppCommandAwait('G90 G0 Z5'))
    expect(plain).toMatchObject({ ok: true })
    expect(machinePos.z).toBe(115)

    expect(applyToolLengthOffset(12.5)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(useMachineControl.getState().offsets.G54?.[2]).toBe(122.5)

    sent = []
    const offset = await settle(sendAppCommandAwait('G90 G0 Z5'))
    expect(offset).toMatchObject({ ok: true })
    expect(moveCalls()).toEqual([
      { m: 'jogToMachineZ', a: { z: 127.5, feedMmMin: controlMachine(useCamStore.getState()).rapidRate } },
    ])
    expect(machinePos.z).toBe(127.5)

    sent = []
    const cleared = await settle(sendAppCommandAwait('G49'))
    expect(cleared).toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(100)
    expect(moveCalls()).toEqual([{ m: 'setWorkOffset', a: { wcs: 'G54', z: 110 } }])
    expect(useMachineControl.getState().offsets.G54?.[2]).toBe(110)

    sent = []
    const back = await settle(sendAppCommandAwait('G90 G0 Z5'))
    expect(back).toMatchObject({ ok: true })
    expect(machinePos.z).toBe(115)
    expect(textFrames()).toEqual([])
    expect(consoleText()).not.toContain('slice 4')
  })

  it('the Clear TLO button (clearToolLengthOffset) takes the applied delta back out', async () => {
    await connectBridge()
    expect(applyToolLengthOffset(12.5)).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    sent = []

    expect(clearToolLengthOffset()).toBe(true)
    await vi.advanceTimersByTimeAsync(100)

    expect(moveCalls()).toEqual([{ m: 'setWorkOffset', a: { wcs: 'G54', z: 110 } }])
    expect(textFrames()).toEqual([])
    // With nothing applied, G49 has nothing to take out and writes nothing.
    sent = []
    expect(clearToolLengthOffset()).toBe(true)
    expect(moveCalls()).toEqual([])
  })

  it('a G43.1 line applies the offset in the line units', async () => {
    await connectBridge()

    const applied = await settle(sendAppCommandAwait('G20 G43.1 Z0.5'))
    await vi.advanceTimersByTimeAsync(100)

    expect(applied).toMatchObject({ ok: true })
    expect(moveCalls()).toEqual([{ m: 'setWorkOffset', a: { wcs: 'G54', z: 122.7 } }])
    expect(textFrames()).toEqual([])
  })
})

describe('WO-1548: fire-and-forget lines and dwells', () => {
  it('a fire-and-forget work XY move runs as jogToWorkXY; G4 waits its seconds', async () => {
    await connectBridge()
    sendAppCommand('G21 G90 G53 G0 Z120')
    for (let i = 0; i < 100 && machinePos.z !== 120; i++) await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(200)
    sent = []

    const moved = sendAppCommand('G1 X10 Y20 F600')
    expect(moved).toMatchObject({ ok: true, sent: true })
    await vi.advanceTimersByTimeAsync(50)
    expect(moveCalls()).toEqual([{ m: 'jogToWorkXY', a: { x: 10, y: 20, feedMmMin: 600 } }])

    let dwelt = false
    void sendAppCommandAwait('G4 P0.5')!.then(() => { dwelt = true })
    await vi.advanceTimersByTimeAsync(400)
    expect(dwelt).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(dwelt).toBe(true)
    expect(textFrames()).toEqual([])
  })
})

describe('WO-1548: a controller that takes text keeps its text lines (GRBL, simulator)', () => {
  it('G43.1, G49 and G53 go out as text', () => {
    const ctrl = {
      capabilities: { ...BRIDGE_CAPABILITIES, gcodeText: true },
      connectionPhase: () => 'connected',
      sendCommand: vi.fn(() => true),
      sendCommandAwait: vi.fn(() => Promise.resolve({ ok: true, message: null })),
    } as unknown as MachineController & { sendCommand: ReturnType<typeof vi.fn> }

    for (const line of ['G43.1 Z12.5', 'G49', 'G53 G0 Z0']) {
      expect(sendAppCommand(line, ctrl), line).toMatchObject({ ok: true, sent: true, translated: null })
    }
    expect(ctrl.sendCommand.mock.calls).toEqual([['G43.1 Z12.5'], ['G49'], ['G53 G0 Z0']])
  })
})

describe('WO-1548 fix: a park moves in millimetres whatever units the operator holds', () => {
  const PARK = { id: 'p1', label: 'Front', x: 100, y: 50 }

  /** Run a park to the end and return what reached the wire. */
  async function parkWire(safeZ: number): Promise<ReturnType<typeof moveCalls>> {
    sent = []
    expect(runParkMove(PARK, safeZ)).toEqual({ ok: true })
    for (let i = 0; i < 200 && Math.abs(machinePos.x - PARK.x) > 1e-6; i++) await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(500)
    return moveCalls()
  }

  it('an inch-session park sends the same machine targets as an mm-session park, and the operator is in inch again after', async () => {
    await connectBridge()
    const rapid = controlMachine(useCamStore.getState()).rapidRate

    sendAppCommand('G21')
    const mmWire = await parkWire(120)
    expect(mmWire).toEqual([
      { m: 'jogToMachineZ', a: { z: 120, feedMmMin: rapid } },
      { m: 'jogToWorkXY', a: { x: Number((100 - 188.7325).toFixed(4)), y: Number((50 - 397.655).toFixed(4)), feedMmMin: rapid } },
    ])

    // ControlPage sends G20 on connect when the display units are inch.
    machinePos = { x: 738, y: 724.5, z: 128.9 }
    // The board reports where it now stands, as the real bridge streams it
    // (WO-2437 fix round 4: a park leg the machine already stands at is not sent).
    bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', machinePos) } as BridgeMessage)
    await vi.advanceTimersByTimeAsync(50)
    sendAppCommand('G20')
    const inchWire = await parkWire(120)
    expect(inchWire).toEqual(mmWire)
    expect(machinePos.x).toBeCloseTo(100, 6)
    expect(machinePos.y).toBeCloseTo(50, 6)
    expect(machinePos.z).toBe(120)

    // The operator's next typed move is still read in inch.
    expect(useMachineControl.getState().parserModal?.units).toBe('inch')
    sent = []
    const typed = await settle(sendAppCommandAwait('G53 G0 Z4'))
    expect(typed).toMatchObject({ ok: true })
    expect(moveCalls()).toEqual([{ m: 'jogToMachineZ', a: { z: 101.6, feedMmMin: rapid } }])
    expect(textFrames()).toEqual([])
  })

  it('a negative safe Z in an inch session is not a 25.4x plunge', async () => {
    await connectBridge()
    sendAppCommand('G20')
    sent = []
    runParkMove(PARK, -5)
    await vi.advanceTimersByTimeAsync(300)
    expect(moveCalls()[0]).toEqual({ m: 'jogToMachineZ', a: expect.objectContaining({ z: -5 }) })
  })

  it('a park that fails part-way still leaves the operator in inch, and XY never moves', async () => {
    await connectBridge()
    sendAppCommand('G20')
    answer = { jogToMachineZ: false }
    sent = []
    expect(runParkMove(PARK, 120)).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(2000)

    expect(moveCalls()).toEqual([
      { m: 'jogToMachineZ', a: { z: 120, feedMmMin: controlMachine(useCamStore.getState()).rapidRate } },
    ])
    expect(consoleText()).toContain('the controller refused jogToMachineZ')
    expect(useMachineControl.getState().parserModal?.units).toBe('inch')
    sent = []
    await settle(sendAppCommandAwait('G53 G0 Z4'))
    expect(moveCalls()[0]).toEqual({ m: 'jogToMachineZ', a: expect.objectContaining({ z: 101.6 }) })
  })

  it('once the E-STOP latch needs reset, a park issues no further move', async () => {
    await connectBridge()
    expect(runParkMove(PARK, 120)).toEqual({ ok: true })
    __armEstopInterlockForTest()
    await vi.advanceTimersByTimeAsync(3000)
    expect(moveCalls()).toEqual([])
    expect(machinePos).toEqual({ x: 738, y: 724.5, z: 128.9 })
  })

  it('an E-STOP latched between the Z and XY moves stops the park before XY', async () => {
    await connectBridge()
    expect(runParkMove(PARK, 120)).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(300)
    expect(moveCalls().map((c) => c.m)).toEqual(['jogToMachineZ'])
    __armEstopInterlockForTest()
    await vi.advanceTimersByTimeAsync(5000)
    expect(moveCalls().map((c) => c.m)).toEqual(['jogToMachineZ'])
    expect(machinePos.x).toBe(738)
  })
})

describe('WO-1548 fix: probe cycles on the native probe get past the touch pre-check', () => {
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
  const FEATURE_PLAN = {
    kind: 'edge',
    steps: [
      { kind: 'position', label: 'Lift', target: { x: 738, y: 724.5, z: 125 }, axes: ['Z'] },
      {
        kind: 'touch',
        key: 'xNegative',
        label: 'X- touch',
        axis: 'X',
        direction: '-',
        travelMm: 10,
        expectedStart: { x: 738, y: 724.5, z: 125 },
      },
    ],
  } as unknown as Parameters<typeof runFeatureProbeCycle>[0]

  it('a feature probe cycle issues its first typed move and its probe call', async () => {
    await connectBridge()
    const result = await settle(runFeatureProbeCycle(FEATURE_PLAN, PROBE_CONFIG, true))

    expect(result?.message).not.toContain('not wired')
    expect(moveCalls()[0]).toEqual({ m: 'jogToMachineZ', a: { z: 125, feedMmMin: 1200 } })
    expect(sent.filter((m) => m.m === 'probe').map((m) => m.a)).toEqual([{ axis: 'X', targetMm: 728, feedMmMin: 300 }])
    expect(result).toMatchObject({ ok: false })
    expect(result?.message).toContain('never made contact')
    expect(textFrames()).toEqual([])
  })

  it('a surface mesh probe cycle issues its safe-Z move and its probe call', async () => {
    const program = [
      'G21 G90 G54', 'G0 X1 Y1 Z5', 'G1 Z-0.2 F100', 'G1 X9 Y1 F400',
      'G1 X9 Y9', 'G1 X1 Y9', 'G1 X1 Y1', 'G0 Z5', 'M30',
    ].join('\n')
    const plan = planSurfaceMesh(program, { marginMm: 1, pointsX: 3, pointsY: 3, fadeMm: 5 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    await connectBridge()
    useMachineControl.setState({ programText: program, activeWcs: 'G54' })

    const result = await settle(runSurfaceMeshProbeCycle(
      {
        points: plan.points,
        bounds: plan.setup.bounds,
        cutBounds: plan.setup.cutBounds,
        pointsX: 3,
        pointsY: 3,
        fadeMm: 5,
        safeMachineZ: 125,
        sourceProgramText: program,
        sourceName: 'mesh.nc',
        workOffset: 'G54',
      },
      PROBE_CONFIG,
      true,
    ))

    expect(result?.message).not.toContain('not wired')
    expect(moveCalls()[0]).toEqual({ m: 'jogToMachineZ', a: { z: 125, feedMmMin: 1200 } })
    expect(moveCalls()[1]?.m).toBe('jogToWorkXY')
    expect(sent.filter((m) => m.m === 'probe')).toHaveLength(1)
    expect(result).toMatchObject({ ok: false })
    expect(textFrames()).toEqual([])
  })

  it('a controller with neither text nor a native probe is refused before anything moves', async () => {
    await connectBridge()
    const ctrl = getMachineController()
    Object.defineProperty(ctrl, 'probe', { value: undefined, configurable: true, writable: true })
    try {
      const result = await settle(runFeatureProbeCycle(FEATURE_PLAN, PROBE_CONFIG, true))
      expect(result).toMatchObject({ ok: false })
      expect(result?.message).toContain('G38.2')
      expect(result?.message).toContain('not wired')
      expect(sent.filter((m) => m.m !== 'queryStatus')).toEqual([])
    } finally {
      delete (ctrl as { probe?: unknown }).probe
    }
  })
})
