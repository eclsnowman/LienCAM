// WO-1044 / WO-1054 - EVERY LOAD STAYS UNDER THE BOARD'S MOVE CAP. A LONG
// OPERATOR PROGRAM RUNS AS EXPLICIT RAPID-BOUNDARY PARTS, NEVER A REMAINDER.
//
// THE DEFECT, AND IT IS MEASURED, NOT INFERRED. On Operator's machine on
// 2026-08-26 with Operator present (`src/tests/evidence/CHORD-AB-2026-08-26/`,
// commit f7285554) the AXBB-E through the bridge executed `moveCount mod 4096`
// of a staged program: 6284 moves failed 100% of the time (4/4, twice, on two
// different chords) and 4274 failed 75% (3/4) - 4274 accepted moves, 178
// executed. The board ACCEPTS every move, reports buffer-full ZERO times and
// then flies the wrong number. There is no signal from the board at all, so
// the only possible defence is the product's, before the program is loaded.
//
// WHAT IS PROVEN HERE:
//
//   PROVEN, on the real session singleton against the real SimulatedController
//   (no mocked controller, no stubbed builder): 4095 moves load once and a
//   splittable 4096-move operator program is staged as capped parts. The
//   simulator carries the real cap so a ceiling test can reach is proved.
//
//   PROVEN: THE SPLIT IS THE PRODUCT'S, BEFORE THE WIRE. With the controller's
//   own `loadProgram` replaced by a stub, it sees only the first capped part.
//   The bridge likewise receives one under-cap `loadMoves` frame at a time.
//
//   PROVEN: THE BACKENDS REFUSE TOO, independently of the door - a second lock,
//   so a future caller of `loadProgram` cannot route around the first.
//
//   PROVEN: THE CAP IS THE CONTROLLER'S, NOT A CONSTANT IN THE APP. A bridge
//   that advertises `maxProgramMoves` in its hello is obeyed at ITS number; a
//   bridge that advertises none - every bridge shipped so far - gets 4095, and
//   a garbage value gets 4095 rather than a permissive `Infinity`.
//
//   PROVEN: THE SPLIT IS PLANNED AND THE BOUNDARIES LAND ON RAPIDS. Every part
//   is within the cap, the parts cover the program exactly once in order, and
//   each boundary is a rapid. A stretch with no rapid to break on is REFUSED
//   by name rather than cut mid-feed.
//
//   PROVEN in programParts.wo1054.test.ts: the session runs every part in
//   sequence as one operator program, with whole-program progress and stop/
//   fault negative controls.
//
//   NOT CLAIMED: hardware. Nothing here touches Operator's machine.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type {
  ControllerCapabilities,
  MachineProgram,
  ProgramStep,
  QueuedMove,
} from '../../lib/machine/controller'
import type { MachineConfig, Project, Setup, ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeStock, makeWcs } from '../post/helpers'
import { typedMock } from '../support/typedMock'

/** An un-updated AXBB-E bridge: geometry programs, and NO declared move cap -
 *  the shape every bridge shipped so far reports. */
const BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
  machineProgram: true,
}

/** A bridge that has MEASURED its own board and says so. Eight is not a real
 *  board's number; it is a number a test can reach in a millisecond, which is
 *  the whole point of the cap being a capability rather than a constant. */
const BRIDGE_WITH_DECLARED_CAP: ControllerCapabilities = {
  ...BRIDGE_CAPABILITIES,
  maxProgramMoves: 8,
}

let bridgeCapabilities: ControllerCapabilities = BRIDGE_CAPABILITIES

// The real BridgeTransport declares private instance fields, so no class
// outside its own declaration can satisfy `typeof BridgeTransport`
// structurally - the fake must EXTEND it (see hardwareEstop.test.tsx), which
// happens inside the vi.mock factory where the real class is reachable via
// importOriginal.
interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  loadMovesFrames(): { moves: unknown[]; frame?: string }[]
}
const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  // Stands in for bridgeTransport's WebSocket - the WO-422/WO-1031 fake,
  // verbatim in behaviour: hello the moment the controller attaches.
  class FakeBridgeTransport extends actual.BridgeTransport {
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridgeSockets.push(this)
    }

    /** Required by the real BridgeTransport's static side (WO-960 typedMock
     *  conversion) - never consulted by this fixture, which is always "the
     *  bridge". */
    static isSupported(): boolean {
      return true
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1044-fake 0.0',
          capabilities: bridgeCapabilities,
          readOnly: false,
          workOffsets: {
            current: {
              G54: { x: 10, y: 5, z: 2 }, G55: { x: 110, y: 5, z: 2 },
              G56: { x: 0, y: 0, z: 0 }, G57: { x: 0, y: 0, z: 0 },
              G58: { x: 0, y: 0, z: 0 }, G59: { x: 0, y: 0, z: 0 },
            },
            profile: {
              G54: { x: 10, y: 5, z: 2 }, G55: { x: 110, y: 5, z: 2 },
              G56: { x: 0, y: 0, z: 0 }, G57: { x: 0, y: 0, z: 0 },
              G58: { x: 0, y: 0, z: 0 }, G59: { x: 0, y: 0, z: 0 },
            },
          },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    /** The `loadMoves` frames this socket carried. That frame is the ONLY way
     *  anything reaches the bridge's staged list (`Bridge.cs:2239` ->
     *  `Machine.LoadMoves`), so "no such frame" is the proof that the board was
     *  never handed the program. */
    loadMovesFrames(): { moves: unknown[]; frame?: string }[] {
      return this.sent
        .filter((m) => m.m === 'loadMoves')
        .map((m) => m.a as { moves: unknown[]; frame?: string })
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: FakeBridgeTransport })
})

const { buildStraightLineProgram } = await import('../../lib/program/buildMachineProgram')
const { assessProgramCapacity, describeOverCapRefusal, isStagedMove } = await import(
  '../../lib/program/programCapacity'
)
const { DEFAULT_MAX_PROGRAM_MOVES, resolveMaxProgramMoves } = await import(
  '../../lib/machine/controller'
)
const {
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGeometryProgram,
  clearPathFidelity,
  setPathToleranceMm,
  __resetEstopInterlockForTest,
} = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')

const TRACE = { opId: 'op1', setupId: 'setup1' }
const RAPID_FEED = 5000

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A toolpath of exactly `count` moves: a rapid, then feeds. Every coordinate
 * stays inside the travel envelope after the world->work transform, so nothing
 * here is refused for a reason this order is not about.
 */
function toolpath(count: number): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  for (let i = 0; i < count; i++) {
    const x = 10 + (i % 100)
    const y = 5 + (i % 60)
    if (i === 0) moves.push({ type: 'rapid', x, y, z: 22 })
    else moves.push({ type: 'feed', x, y, z: 1, feed: 900 })
  }
  return moves
}

/** A built program of exactly `count` moves, through the REAL builder. */
function program(count: number): MachineProgram {
  const built = buildStraightLineProgram(toolpath(count), makeWcs(), RAPID_FEED, TRACE)
  if (!built.ok) throw new Error(`expected a program, got refusal: ${built.reason}`)
  if (built.motionCount !== count) {
    throw new Error(`builder counted ${built.motionCount} moves, not ${count}`)
  }
  return built.program
}

/**
 * Motion steps written out by hand: `R` a rapid, `F` a feed. The split rule is
 * entirely about WHERE the rapids are, and a string says that in one glance
 * where a generated toolpath hides it.
 */
function steps(shape: string): ProgramStep[] {
  return [...shape].map((mark, i): QueuedMove => {
    if (mark !== 'R' && mark !== 'F') throw new Error(`unknown step mark "${mark}"`)
    return {
      id: i + 1,
      kind: 'line',
      to: { x: i, y: 0, z: 0 },
      feedMmMin: mark === 'R' ? RAPID_FEED : 900,
      ...(mark === 'R' ? { rapid: true as const } : {}),
    }
  })
}

function machine(over: Partial<MachineConfig> = {}): MachineConfig {
  return makeMachine({
    id: 'wo1044-machine',
    name: 'WO-1044 Test Machine',
    travel: { x: 600, y: 400, z: 100 },
    rapidRate: RAPID_FEED,
    ...over,
  })
}

function setup(): Setup {
  return {
    id: 'setup1',
    name: 'Setup 1',
    wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 10, y: 5, z: 2 } }),
    stock: makeStock({ material: 'aluminum' }),
    operations: [makeOp({ id: 'op1', name: 'Contour', type: 'contour_2d' })],
    notes: '',
  }
}

let originalProject: Project

beforeEach(() => {
  vi.useFakeTimers()
  bridgeCapabilities = BRIDGE_CAPABILITIES
  bridgeSockets.length = 0
  originalProject = useCamStore.getState().project
  useCamStore.setState((s) => ({
    project: { ...s.project, machine: machine(), setups: [setup()], activeSetupId: 'setup1' },
  }))
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject })
  clearPathFidelity()
  setPathToleranceMm(null)
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

async function connect(kind: 'simulator' | 'bridge'): Promise<void> {
  const pending = connectMachine(kind)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  if (kind === 'simulator') {
    if (!getMachineController().home()) throw new Error('The simulator refused the homed fixture.')
    await vi.advanceTimersByTimeAsync(2_000)
  }
}

function consoleText(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

/** What the CONTROLLER says it is holding - the only source of truth this
 *  series recognises for "a program is staged". */
function stagedOnController(): number | undefined {
  return getMachineController().programProgress?.().total
}

// ---------------------------------------------------------------------------
// 1. The cap itself: whose number is it?
// ---------------------------------------------------------------------------

describe('WO-1044: the cap is the CONTROLLER\'s number, and absence is not permission', () => {
  const base: ControllerCapabilities = { ...BRIDGE_CAPABILITIES }

  it('is 4095 when the backend declares none - the board wraps at 4096, so 4095 is the last program that survives', () => {
    expect(DEFAULT_MAX_PROGRAM_MOVES).toBe(4095)
    expect(resolveMaxProgramMoves(base)).toBe(4095)
  })

  it('is the bridge\'s own number when its hello declares one', () => {
    expect(resolveMaxProgramMoves({ ...base, maxProgramMoves: 8 })).toBe(8)
    expect(resolveMaxProgramMoves({ ...base, maxProgramMoves: 12_000 })).toBe(12_000)
  })

  it('falls back to 4095 for every value that is not a usable count - never to "no limit"', () => {
    for (const declared of [0, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveMaxProgramMoves({ ...base, maxProgramMoves: declared })).toBe(4095)
    }
    // The shape that arrives from the far side of a `JSON.parse`, where a
    // declared type is a claim rather than a fact.
    const fromTheWire = { ...base, maxProgramMoves: '8000' } as unknown as ControllerCapabilities
    expect(resolveMaxProgramMoves(fromTheWire)).toBe(4095)
  })
})

// ---------------------------------------------------------------------------
// 2. The measurement and the split PLAN - pure, so the app, the backends and
//    this test all get the same answer.
// ---------------------------------------------------------------------------

describe('WO-1044: assessProgramCapacity measures the program against the cap', () => {
  it('counts every step that occupies a board slot, not only the cuts', () => {
    const withNonLines: ProgramStep[] = [
      ...steps('RF'),
      { id: 90, kind: 'dwell', seconds: 1 },
      { id: 91, kind: 'marker' },
    ]
    expect(withNonLines.filter(isStagedMove)).toHaveLength(4)
    expect(assessProgramCapacity(withNonLines, 4095).count).toBe(4)
  })

  it('4095 fits and 4096 does not - the exact edge the board wraps at', () => {
    const at = assessProgramCapacity(program(4095).steps, 4095)
    expect(at).toMatchObject({ count: 4095, cap: 4095, fits: true })
    expect(at.parts).toEqual([{ start: 0, end: 4095, count: 4095 }])

    const over = assessProgramCapacity(program(4096).steps, 4095)
    expect(over).toMatchObject({ count: 4096, cap: 4095, fits: false })
  })

  it('plans the split on RAPIDS, taking as much as each part legally can', () => {
    // Cap 4: the last rapid within reach of move 1 is at index 3, and the last
    // within reach of move 5 is at index 6. Feeds are never cut through.
    const plan = assessProgramCapacity(steps('FFFRFRFFF'), 4)
    expect(plan.fits).toBe(false)
    expect(plan.splitRefusal).toBeNull()
    expect(plan.parts).toEqual([
      { start: 0, end: 4, count: 4 },
      { start: 4, end: 6, count: 2 },
      { start: 6, end: 9, count: 3 },
    ])
  })

  it('every planned part is within the cap, covers the program once in order, and ENDS on a rapid', () => {
    // A realistic shape: a rapid every 700 moves, which no single part can hold
    // at a cap of 1000.
    const shape = [...Array(5_000)].map((_, i) => (i % 700 === 0 ? 'R' : 'F')).join('')
    const motion = steps(shape).filter(isStagedMove)
    const plan = assessProgramCapacity(motion, 1_000)

    expect(plan.parts).not.toBeNull()
    const parts = plan.parts ?? []
    expect(parts.length).toBeGreaterThan(1)

    let cursor = 0
    for (const [i, part] of parts.entries()) {
      expect(part.start).toBe(cursor)
      expect(part.count).toBe(part.end - part.start)
      expect(part.count).toBeGreaterThan(0)
      expect(part.count).toBeLessThanOrEqual(1_000)
      // Every part but the last hands over ON A RAPID: the tool is positioning,
      // not cutting, when the program stops to be reloaded.
      if (i < parts.length - 1) {
        const last = motion[part.end - 1]
        expect(last.kind === 'line' && last.rapid).toBe(true)
      }
      cursor = part.end
    }
    expect(cursor).toBe(plan.count)
  })

  it('REFUSES to plan a split when the stretch it must break in has no rapid - never cuts mid-feed', () => {
    const plan = assessProgramCapacity(steps('RFFFFFFFFF'), 4)
    expect(plan.fits).toBe(false)
    expect(plan.parts).toBeNull()
    expect(plan.splitRefusal).toBe(
      'one continuous cutting stretch of 9 moves has no rapid to split at; the board holds 4.',
    )
    expect(describeOverCapRefusal(plan)).toMatch(/It cannot be broken up either/)
  })

  it('refuses to plan against a cap that is not a usable number of moves', () => {
    for (const cap of [0, -5, 2.5]) {
      const plan = assessProgramCapacity(steps('RFFF'), cap)
      expect(plan.fits).toBe(false)
      expect(plan.parts).toBeNull()
      expect(plan.splitRefusal).toMatch(/not a usable number of moves/)
    }
  })

  it('says the sentence WO-1044 asked for, with the real numbers off the machine', () => {
    // 6284 moves is the run that failed 100% of the time on Operator's machine.
    const plan = assessProgramCapacity(program(6284).steps, 4095)
    const sentence = describeOverCapRefusal(plan)
    expect(sentence).toContain('This program has 6284 moves; the board can only hold 4095 at once.')
    // And it never reads as though something was handled.
    expect(sentence).toContain('Nothing was sent')
    expect(sentence).not.toMatch(/truncat/i)
  })
})

// ---------------------------------------------------------------------------
// 3. THE PRODUCT'S DOOR - on the real session, against the real simulator.
// ---------------------------------------------------------------------------

describe('WO-1044: loadGeometryProgram refuses an over-cap program on the simulator', () => {
  beforeEach(async () => {
    await connect('simulator')
    getMachineController().refreshState()
  })

  it('loads 4095 moves and says the count on the console before Cycle Start', () => {
    const result = loadGeometryProgram('wo1044-at-the-cap', toolpath(4095), TRACE)

    expect(result).toEqual({ ok: true, reason: null })
    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(true)
    expect(readiness.reason).toContain('4095 moves, runs in G54')
    expect(readiness.reason).not.toContain('the board holds')
    expect(consoleText()).toContain(readiness.reason)
    // The whole program reached the controller - all 4095 of it.
    expect(stagedOnController()).toBe(4095)
    // Said BEFORE Cycle Start: nothing has been started, and this line is
    // already on the console the operator is reading.
    expect(getMachineController().hasActiveJob()).toBe(false)
  })

  it('accepts 4096 as two parts and stages only the first capped part', () => {
    // Start from a good load, so the replacement is measured too.
    expect(loadGeometryProgram('wo1044-good', toolpath(10), TRACE).ok).toBe(true)
    expect(stagedOnController()).toBe(10)
    const ctrl = getMachineController() as unknown as { loadMoves: (m: QueuedMove[]) => unknown }
    const loadMoves = vi.spyOn(ctrl, 'loadMoves')

    const result = loadGeometryProgram('wo1044-over', toolpath(4096), TRACE)

    expect(result).toEqual({ ok: true, reason: null })
    expect(loadMoves).toHaveBeenCalledTimes(1)
    expect(loadMoves.mock.calls[0][0]).toHaveLength(1)
    expect(stagedOnController()).toBe(1)
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: true,
      reason: 'program has 4096 moves - running in 2 parts',
    })
    expect(consoleText()).toContain(
      'Toolpath program "wo1044-over" loaded: 4096 moves, runs in G54.',
    )
    expect(consoleText()).toContain('program has 4096 moves - running in 2 parts')
    loadMoves.mockRestore()
  })

  it('and 6284 moves with no rapid boundary stages as one streamed program', () => {
    const result = loadGeometryProgram('wo1044-6284', toolpath(6284), TRACE)

    expect(result).toEqual({ ok: true, reason: null })
    expect(stagedOnController()).toBe(6_284)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(consoleText().join('\n')).not.toMatch(/shorten the toolpath|cannot be broken up/i)
  })

  it('is the PRODUCT\'s split: a backend that would accept anything sees only the first capped part', () => {
    const ctrl = getMachineController() as unknown as {
      loadProgram: (p: MachineProgram) => { ok: boolean; reason: string | null }
    }
    // A stub with no cap, no validation and no opinion - the shape of a future
    // backend, or of the bridge before it learned to refuse.
    const acceptsAnything = vi
      .spyOn(ctrl, 'loadProgram')
      .mockReturnValue({ ok: true, reason: null })

    const result = loadGeometryProgram('wo1044-stub', toolpath(4096), TRACE)

    expect(result).toEqual({ ok: true, reason: null })
    expect(acceptsAnything).toHaveBeenCalledTimes(1)
    expect(acceptsAnything.mock.calls[0][0].steps).toHaveLength(1)
    acceptsAnything.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 4. THE BACKENDS' OWN LOCK - so a second caller of `loadProgram` cannot route
//    around the door.
// ---------------------------------------------------------------------------

describe('WO-1081: SimulatedController does not turn a window into a program limit', () => {
  beforeEach(async () => {
    await connect('simulator')
  })

  it('accepts and stages a continuous program beyond 4095 moves', () => {
    const ctrl = getMachineController()
    expect(ctrl.loadProgram?.(program(4095))).toEqual({ ok: true, reason: null })
    expect(stagedOnController()).toBe(4095)

    expect(ctrl.loadProgram?.(program(4096))).toEqual({ ok: true, reason: null })
    expect(stagedOnController()).toBe(4096)
  })
})

describe('WO-1081: the bridge route streams beyond the stationary part size', () => {
  beforeEach(async () => {
    await connect('bridge')
  })

  it('accepts an over-cap operator program and sends only its first capped part', async () => {
    const socket = bridgeSockets[bridgeSockets.length - 1]

    const result = loadGeometryProgram('wo1044-bridge-over', toolpath(4096), TRACE)

    expect(result).toEqual({ ok: true, reason: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.loadMovesFrames()).toHaveLength(1)
    expect(socket.loadMovesFrames()[0].moves).toHaveLength(1)
    expect(consoleText()).toContain('program has 4096 moves - running in 2 parts')
  })

  it('UccncController.loadProgram sends an over-cap program to the paced bridge', () => {
    const socket = bridgeSockets[bridgeSockets.length - 1]

    const outcome = getMachineController().loadProgram?.(program(4096))

    expect(outcome).toEqual({ ok: true, reason: null })
    expect(socket.loadMovesFrames()).toHaveLength(1)
    expect(socket.loadMovesFrames()[0].moves).toHaveLength(4096)
  })

  it('a program at the cap DOES reach the wire - the refusal is a ceiling, not a wall', async () => {
    const socket = bridgeSockets[bridgeSockets.length - 1]

    expect(loadGeometryProgram('wo1044-bridge-at', toolpath(4095), TRACE).ok).toBe(true)
    await Promise.resolve()
    await Promise.resolve()

    const frames = socket.loadMovesFrames()
    expect(frames).toHaveLength(1)
    expect(frames[0].moves).toHaveLength(4095)
    expect(frames[0].frame).toBe('work')
  })
})

describe('WO-1044: a bridge that declares its own cap is obeyed at ITS number', () => {
  beforeEach(async () => {
    bridgeCapabilities = BRIDGE_WITH_DECLARED_CAP
    await connect('bridge')
  })

  it('splits at the bridge\'s 8, not at the app\'s 4095', async () => {
    const socket = bridgeSockets[bridgeSockets.length - 1]

    const result = loadGeometryProgram('wo1044-declared', toolpath(9), TRACE)

    expect(result).toEqual({ ok: true, reason: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.loadMovesFrames()).toHaveLength(1)
    expect(socket.loadMovesFrames()[0].moves).toHaveLength(1)
    expect(useMachineControl.getState().programReadiness.reason)
      .toBe('program has 9 moves - running in 2 parts')

    // ...and eight loads, on the same connection, without presenting the
    // bridge's stationary part size as a program-length ceiling.
    expect(loadGeometryProgram('wo1044-declared-ok', toolpath(8), TRACE).ok).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.loadMovesFrames()).toHaveLength(2)
    expect(socket.loadMovesFrames()[1].moves).toHaveLength(8)
    expect(useMachineControl.getState().programReadiness.reason)
      .toBe('Toolpath program "wo1044-declared-ok" loaded: 8 moves, runs in G54.')
  })
})
