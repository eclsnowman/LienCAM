// WO-1023: a machine ACTION and a machine PROGRAM have a type.
//
// This order builds TYPES and moves no caller, so most of what has to be
// proven is proven by the COMPILER: the fixtures below construct one of every
// `MachineAction` member, and `visitAction` switches over all of them and ends
// in `assertNever`. Deleting a member breaks the fixture that constructs it;
// adding one breaks every switch that forgot it. Neither check greps a source
// file - both are the type system refusing to compile this test.
//
// The runtime half is the part a type cannot state: what
// `validateMachineProgram` REFUSES and why, and that every backend answers the
// two new questions ("can you run a program", "which step is executing")
// honestly rather than aspirationally.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RESERVED_PROGRAM_ID,
  validateMachineProgram,
} from '../../lib/machine/controller'
import type {
  MachineAction,
  MachineController,
  MachineProgram,
  ProgramIndex,
  ProgramStep,
  QueuedMove,
} from '../../lib/machine/controller'
import { SimulatedController } from '../../lib/machine/simulatedController'
import { GrblController } from '../../lib/machine/grbl/controller'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, ControllerEvents, MachineStatus } from '../../lib/machine/controller'

// ---------------------------------------------------------------------------
// 1. The type itself: one of every member, and an exhaustive visitor.
// ---------------------------------------------------------------------------

/** The drop-in guard. Reached only if a `MachineAction` member exists that the
 *  switch above it does not handle - which is a COMPILE error, because the
 *  unhandled member is not assignable to `never`. The throw is the runtime
 *  belt to the compiler's braces. */
function assertNever(value: never): never {
  throw new Error(`unhandled MachineAction member: ${JSON.stringify(value)}`)
}

/**
 * One of EVERY member of the union. A member deleted from `MachineAction`
 * makes its entry here fail to compile (excess/unknown properties, or an
 * unassignable `kind`), which is the acceptance criterion "deleting any member
 * from the union makes it fail to compile".
 *
 * Ids are 1..n only so each fixture is distinguishable; nothing here depends
 * on their order.
 */
const ONE_OF_EACH_ACTION: MachineAction[] = [
  { id: 1, kind: 'spindle', direction: 'cw', rpm: 18000 },
  { id: 2, kind: 'spindle', direction: 'ccw', rpm: 12000 },
  { id: 3, kind: 'spindle', direction: 'off' },
  { id: 4, kind: 'coolant', channel: 'flood', on: true },
  { id: 5, kind: 'coolant', channel: 'mist', on: false },
  { id: 6, kind: 'coolant', channel: 'air', on: true },
  { id: 7, kind: 'dwell', seconds: 1.5 },
  { id: 8, kind: 'toolChange', toolNumber: 4, description: '6mm 3-flute flat' },
  { id: 9, kind: 'toolChange', toolNumber: 5, description: null },
  { id: 10, kind: 'toolLengthOffset', deltaMm: 42.125 },
  { id: 11, kind: 'workOffset', op: 'select', wcs: 'G54' },
  { id: 12, kind: 'workOffset', op: 'write', wcs: 'G55', axis: 'Z', valueMm: -12.5 },
  { id: 13, kind: 'park', parkId: 'toolChange', safeZMachineMm: -2, x: 0, y: 300 },
  { id: 14, kind: 'pause', message: 'Clear the chips before the finishing pass.' },
]

/**
 * The exhaustive visitor. It deliberately narrows PAST `kind` where a kind
 * carries more than one member - `spindle` by direction, `workOffset` by op -
 * so those inner unions are guarded too, rather than collapsing into one arm
 * that a new member could hide inside.
 */
function visitAction(action: MachineAction): string {
  switch (action.kind) {
    case 'spindle':
      if (action.direction === 'off') return 'spindle:off'
      return `spindle:${action.direction}:${action.rpm}`
    case 'coolant':
      return `coolant:${action.channel}:${action.on}`
    case 'dwell':
      return `dwell:${action.seconds}`
    case 'toolChange':
      return `toolChange:${action.toolNumber}:${action.description ?? '(no description)'}`
    case 'toolLengthOffset':
      return `tlo:${action.deltaMm}`
    case 'workOffset':
      return action.op === 'select'
        ? `wcs:select:${action.wcs}`
        : `wcs:write:${action.wcs}:${action.axis}:${action.valueMm}`
    case 'park':
      return `park:${action.parkId}:${action.safeZMachineMm}:${action.x}:${action.y}`
    case 'pause':
      return `pause:${action.message}`
    default:
      return assertNever(action)
  }
}

describe('WO-1023 MachineAction - the type is the contract', () => {
  it('visits every member exhaustively, with a never guard as the default arm', () => {
    // The compiler proved exhaustiveness. This asserts the fixture set really
    // does reach every arm, so a member that stopped being constructed above
    // could not sit unnoticed behind a still-compiling switch.
    const visited = ONE_OF_EACH_ACTION.map(visitAction)
    expect(visited).toHaveLength(14)
    expect(new Set(ONE_OF_EACH_ACTION.map((a) => a.kind))).toEqual(
      new Set(['spindle', 'coolant', 'dwell', 'toolChange', 'toolLengthOffset', 'workOffset', 'park', 'pause']),
    )
    expect(visited).toContain('spindle:off')
    expect(visited).toContain('wcs:write:G55:Z:-12.5')
    expect(assertNever).toBeTypeOf('function')
  })

  it('gives every member an id, so a step is addressable whatever it is', () => {
    for (const action of ONE_OF_EACH_ACTION) {
      expect(Number.isInteger(action.id), `${action.kind} must carry a whole-number id`).toBe(true)
      expect(action.id).toBeGreaterThan(RESERVED_PROGRAM_ID)
    }
  })

  it('carries NO G-code text and NO controller name in any member', () => {
    // Rule 1 and rule 2 from the type's own doc, checked against the VALUES a
    // member can hold rather than against the source: a member that had a
    // `gcode: "M8"` field, or a `controller: "grbl"` field, fails here.
    const GCODE_WORD = /^[GMTSF]-?\d+(\.\d+)?$/i
    const CONTROLLER_NAMES = ['grbl', 'uccnc', 'uc100', 'axbb', 'mach3', 'mach4', 'linuxcnc']
    for (const action of ONE_OF_EACH_ACTION) {
      for (const [key, value] of Object.entries(action)) {
        const where = `${action.kind}.${key}`
        expect(key.toLowerCase(), `${where} must not be a text/dialect field`).not.toMatch(
          /^(gcode|gcodeline|line|lines|text|command|dialect|controller|controllertype|backend)$/,
        )
        if (typeof value !== 'string') continue
        // `wcs` is a `WcsId`, the product's OWN vocabulary for a work offset -
        // the same type `MachineController.selectWcs` already takes on every
        // backend, GRBL included. It is spelled like a G-code word because the
        // industry names the registers that way, not because a dialect leaked
        // in: nothing renders a `WcsId` to a wire without a backend's own
        // translation. Every other string field is held to the rule.
        if (key === 'wcs') continue
        expect(value, `${where} must not be a G-code word`).not.toMatch(GCODE_WORD)
        for (const name of CONTROLLER_NAMES) {
          expect(value.toLowerCase(), `${where} must not name a controller`).not.toContain(name)
        }
      }
    }
  })

  it('reuses the QueuedMove dwell rather than declaring a second one', () => {
    // `DwellStep` is an alias of the motion vocabulary's dwell, so a dwell
    // built as a move IS a valid action and vice versa. If the two ever became
    // separate shapes, one of these two assignments stops compiling.
    const asMove: QueuedMove = { id: 7, kind: 'dwell', seconds: 1.5 }
    const asAction: MachineAction = asMove.kind === 'dwell' ? asMove : ONE_OF_EACH_ACTION[6]
    const asStep: ProgramStep = asAction
    expect(visitAction(asAction)).toBe('dwell:1.5')
    expect(asStep.id).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// 2. MachineProgram + validateMachineProgram
// ---------------------------------------------------------------------------

function indexFor(steps: ProgramStep[]): ProgramIndex {
  const index: ProgramIndex = {}
  let ordinal = 0
  for (const step of steps) {
    const isMove = step.kind === 'line' || step.kind === 'arc' || step.kind === 'marker'
    index[step.id] = isMove ? { opId: 'op-1', setupId: 'setup-1', moveOrdinal: ordinal++ } : { action: true }
  }
  return index
}

/** The acceptance program: rapid line, feed line, spindle off. */
function goodProgram(): MachineProgram {
  const steps: ProgramStep[] = [
    { id: 1, kind: 'line', to: { x: 10, y: 10, z: 5 }, feedMmMin: 4000, rapid: true },
    { id: 2, kind: 'line', to: { x: 50, y: 10, z: -1 }, feedMmMin: 600 },
    { id: 3, kind: 'spindle', direction: 'off' },
  ]
  return { frame: 'work', units: 'mm', steps, index: indexFor(steps) }
}

/** A refusal must be readable at the machine: a sentence, not a code. */
function expectRefusal(result: { ok: true } | { ok: false; reason: string }, ...mustMention: string[]): string {
  expect(result.ok).toBe(false)
  const reason = result.ok ? '' : result.reason
  expect(reason.length).toBeGreaterThan(20)
  for (const fragment of mustMention) expect(reason).toContain(fragment)
  return reason
}

describe('WO-1023 validateMachineProgram - refuses by name, never repairs', () => {
  it('accepts a three-step program: rapid line, feed line, spindle off', () => {
    expect(validateMachineProgram(goodProgram())).toEqual({ ok: true })
  })

  it('refuses a duplicate id, naming it', () => {
    const program = goodProgram()
    program.steps[2] = { id: 2, kind: 'spindle', direction: 'off' }
    expectRefusal(validateMachineProgram(program), 'id 2', 'unique')
  })

  it('refuses the reserved id 0, naming it', () => {
    const steps: ProgramStep[] = [{ id: 0, kind: 'line', to: { x: 1 }, feedMmMin: 100 }]
    const program: MachineProgram = { frame: 'work', units: 'mm', steps, index: { 0: { action: true } } }
    expectRefusal(validateMachineProgram(program), 'id 0', 'reserved')
  })

  it('refuses a line with no positive feed, and does NOT invent one', () => {
    const program = goodProgram()
    const before = JSON.stringify(program)
    program.steps[1] = { id: 2, kind: 'line', to: { x: 50 }, feedMmMin: 0 }
    const reason = expectRefusal(validateMachineProgram(program), 'id 2', 'feed')
    expect(reason).toContain('line')
    // The validator is pure: it must not have written a feed into the step it
    // refused. Compare the step it touched, not the whole program.
    const step = program.steps[1] as Extract<QueuedMove, { kind: 'line' }>
    expect(step.feedMmMin).toBe(0)
    expect(before).not.toBe(JSON.stringify(program)) // the test mutated it, not the validator
  })

  it('refuses an arc with no positive feed, naming the arc', () => {
    const program = goodProgram()
    program.steps[1] = {
      id: 2,
      kind: 'arc',
      to: { x: 50, y: 50, z: -1 },
      centre: { x: 50, y: 30, z: -1 },
      clockwise: true,
      plane: 'xy',
      feedMmMin: Number.NaN,
    }
    expectRefusal(validateMachineProgram(program), 'id 2', 'arc', 'feed')
  })

  it('refuses an undeclared frame', () => {
    const program = { ...goodProgram(), frame: undefined } as unknown as MachineProgram
    expectRefusal(validateMachineProgram(program), 'frame', 'nothing')
  })

  it('refuses a frame that is not work coordinates, saying which it got', () => {
    const program = { ...goodProgram(), frame: 'machine' } as unknown as MachineProgram
    expectRefusal(validateMachineProgram(program), 'frame', '"machine"')
  })

  it('refuses undeclared units', () => {
    const program = { ...goodProgram(), units: undefined } as unknown as MachineProgram
    expectRefusal(validateMachineProgram(program), 'units', 'nothing')
  })

  it('refuses units that are not millimetres, saying which it got', () => {
    const program = { ...goodProgram(), units: 'inch' } as unknown as MachineProgram
    expectRefusal(validateMachineProgram(program), 'units', '"inch"')
  })

  it('refuses a step whose id is missing from the index, naming it', () => {
    const program = goodProgram()
    delete program.index[3]
    expectRefusal(validateMachineProgram(program), 'id 3', 'index')
  })

  it('accepts an action step at any position - a program is ONE ordered list', () => {
    const steps: ProgramStep[] = [
      { id: 1, kind: 'workOffset', op: 'select', wcs: 'G54' },
      { id: 2, kind: 'spindle', direction: 'cw', rpm: 18000 },
      { id: 3, kind: 'line', to: { x: 10, y: 10, z: 5 }, feedMmMin: 4000, rapid: true },
      { id: 4, kind: 'dwell', seconds: 0.5 },
      { id: 5, kind: 'line', to: { x: 10, y: 10, z: -1 }, feedMmMin: 300 },
      { id: 6, kind: 'toolChange', toolNumber: 2, description: null },
      { id: 7, kind: 'pause', message: 'Check the part is still clamped.' },
      { id: 8, kind: 'spindle', direction: 'off' },
    ]
    const program: MachineProgram = { frame: 'work', units: 'mm', steps, index: indexFor(steps) }
    expect(validateMachineProgram(program)).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// 3. The backends: capability honesty, the refusal, and id-shaped progress.
// ---------------------------------------------------------------------------

function makeEvents(): ControllerEvents {
  return { onStatus: vi.fn(), onConsole: vi.fn(), onJobEvent: vi.fn(), onAlarm: vi.fn(), onJobProgress: vi.fn() }
}

const HOME_CONVENTION = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}

/**
 * GRBL's events type is its own (`GrblControllerEvents`), and its class-level
 * assignability to `MachineController` is the known, out-of-scope mismatch
 * `grblControllerContract.wo418` already documents. This order is about the
 * two optional program members, which are absent regardless - so the cast is
 * narrowed to exactly that question rather than papering over the mismatch.
 */
function grblController(): MachineController {
  return new GrblController({}) as unknown as MachineController
}

async function connectedSim(): Promise<SimulatedController> {
  const ctrl = new SimulatedController(makeEvents(), {
    travelMm: { x: 300, y: 300, z: 100 },
    homeConvention: HOME_CONVENTION,
  })
  await ctrl.connect({ kind: 'none' })
  return ctrl
}

/** The bridge's browser-side socket, faked. Same shape the WO-421 suite uses -
 *  the protocol IS the contract, so no bridge process is needed. */
class FakeBridge implements UccncTransport {
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
}

const GEOMETRY_CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

function bridgeStatus(executingMoveId: number | null, bufferMoves: number | null): MachineStatus {
  return {
    state: 'run',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 600,
    spindleRpm: null,
    overrides: null,
    executingMoveId,
    buffer: { moves: bufferMoves, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

async function connectedBridge(): Promise<{ ctrl: UccncController; transport: FakeBridge }> {
  const transport = new FakeBridge()
  const ctrl = new UccncController(makeEvents())
  const connecting = ctrl.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/test',
      capabilities: GEOMETRY_CAPS,
      readOnly: false,
    },
  })
  await connecting
  return { ctrl, transport }
}

describe('WO-1023 capabilities.machineProgram - honest, not aspirational', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('only a backend that can RUN a program claims machineProgram', async () => {
    // WO-1030 taught the simulator to run pure-motion programs. GRBL still
    // has no program door, and this UCCNC fixture deliberately models an old
    // bridge whose hello has no machineProgram key.
    const sim = await connectedSim()
    const grbl = grblController()
    const { ctrl: bridge } = await connectedBridge()
    expect(sim.capabilities.machineProgram, 'simulated can run pure-motion programs').toBe(true)
    expect(grbl.capabilities.machineProgram === true, 'grbl must not claim machineProgram').toBe(false)
    expect(bridge.capabilities.machineProgram === true, 'old uccnc bridge must not claim machineProgram').toBe(false)
  })

  it('GRBL implements neither program member - a text controller has no program door', () => {
    const grbl = grblController()
    expect(grbl.loadProgram).toBeUndefined()
    expect(grbl.programProgress).toBeUndefined()
  })

  it('the simulated backend refuses an action-bearing program by name and starts nothing', async () => {
    const ctrl = await connectedSim()
    const result = ctrl.loadProgram(goodProgram())
    expect(result).toEqual({
      ok: false,
      reason: 'This program contains action steps; action steps are not wired yet.',
    })
    expect(result.reason).not.toMatch(/WO-\d+/) // plain words, not an order number
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(ctrl.jobProgress().phase).toBe('empty')
    // A refusal that had loaded the moves anyway is the half-path this forbids.
    expect(ctrl.startJob()).toBe(false)
    expect(ctrl.programProgress()).toEqual({
      executingId: null,
      lastCompletedId: null,
      total: 0,
      queuedOnController: 0,
    })
  })

  it('an old bridge refuses loadProgram by name, sends nothing and starts nothing', async () => {
    const { ctrl, transport } = await connectedBridge()
    const before = transport.sent.length
    const result = ctrl.loadProgram(goodProgram())
    expect(result).toEqual({
      ok: false,
      reason: 'This bridge does not understand geometry programs; update the bridge.',
    })
    expect(result.reason).not.toMatch(/WO-\d+/)
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(transport.sent.slice(before).map((c) => c.m)).not.toContain('loadMoves')
    expect(ctrl.programProgress().total).toBe(0)
  })
})

describe('WO-1023 programProgress - progress by id, beside the line-shaped one', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports the last completed id and a null executing id once the simulator is idle', async () => {
    const ctrl = await connectedSim()
    const moves: QueuedMove[] = [
      { id: 11, kind: 'line', to: { x: 20, y: 20, z: 10 }, feedMmMin: 4000, rapid: true },
      { id: 22, kind: 'line', to: { x: 40, y: 20, z: 10 }, feedMmMin: 600 },
      { id: 33, kind: 'line', to: { x: 40, y: 40, z: 10 }, feedMmMin: 600 },
    ]
    expect(ctrl.loadMoves(moves).ok).toBe(true)
    expect(ctrl.programProgress()).toEqual({
      executingId: null,
      lastCompletedId: null,
      total: 3,
      queuedOnController: 0,
    })

    expect(ctrl.startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(ctrl.jobProgress().phase).toBe('complete')
    expect(ctrl.programProgress()).toEqual({
      executingId: null,
      lastCompletedId: 33,
      total: 3,
      queuedOnController: 0,
    })
  })

  it('reports the executing id and buffer occupancy mid-run, and never counts from an id', async () => {
    const ctrl = await connectedSim()
    const moves: QueuedMove[] = [
      { id: 11, kind: 'line', to: { x: 20, y: 20, z: 10 }, feedMmMin: 60 },
      { id: 22, kind: 'line', to: { x: 40, y: 20, z: 10 }, feedMmMin: 60 },
      { id: 33, kind: 'line', to: { x: 40, y: 40, z: 10 }, feedMmMin: 60 },
    ]
    expect(ctrl.loadMoves(moves).ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(200)

    const progress = ctrl.programProgress()
    expect(progress.executingId).toBe(11)
    expect(progress.total).toBe(3)
    expect(progress.queuedOnController).toBe(3)
    // Ids are ours and sparse: 11 executing must never be read as "11 done".
    expect(progress.lastCompletedId).toBeNull()
  })

  it('the bridge reports what it is told, and infers a completion only from a hand-over', async () => {
    const { ctrl, transport } = await connectedBridge()
    expect(ctrl.loadMoves([{ id: 11, kind: 'line', to: { x: 1 }, feedMmMin: 600 }]).ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)

    transport.emit({ t: 'status', v: bridgeStatus(11, 3) })
    expect(ctrl.programProgress()).toEqual({
      executingId: 11,
      lastCompletedId: null, // 11 is RUNNING; nothing has finished yet
      total: 1,
      queuedOnController: 3,
    })

    transport.emit({ t: 'status', v: bridgeStatus(22, 2) })
    expect(ctrl.programProgress()).toEqual({
      executingId: 22,
      lastCompletedId: 11, // the board moved on, so 11 finished
      total: 1,
      queuedOnController: 2,
    })

    // The connect sentinel is not a move: a drop to 0 completes nothing, and
    // 0 is not reported as an executing STEP either - `RESERVED_PROGRAM_ID` is
    // the wire's way of saying "nothing started", which this contract spells
    // null. Handing the 0 back would name a step id no program may mint.
    transport.emit({ t: 'status', v: bridgeStatus(0, 0) })
    expect(ctrl.programProgress().lastCompletedId).toBe(11)
    expect(ctrl.programProgress().executingId).toBeNull()
  })

  it('never carries an executing id from a prior job into the next as a completion', async () => {
    const { ctrl, transport } = await connectedBridge()

    // Job 1 runs and is stopped while 11 is still the last id the bridge named.
    expect(ctrl.loadMoves([{ id: 11, kind: 'line', to: { x: 1 }, feedMmMin: 600 }]).ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    transport.emit({ t: 'status', v: bridgeStatus(11, 1) })
    ctrl.stopJob()
    // The stale frame is still the controller's latest status - deliberately,
    // the DRO must not blank between jobs.
    expect(ctrl.status().executingMoveId).toBe(11)

    // Job 2 is loaded and started. Its FIRST status names a different move.
    expect(ctrl.loadMoves([{ id: 101, kind: 'line', to: { x: 2 }, feedMmMin: 600 }]).ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    transport.emit({ t: 'status', v: bridgeStatus(101, 1) })

    // 11 belongs to a job that is gone. Nothing has finished in job 2 yet, and
    // no completion of 11 was ever reported by bridge or board.
    expect(ctrl.programProgress()).toEqual({
      executingId: 101,
      lastCompletedId: null,
      total: 1,
      queuedOnController: 1,
    })

    // The chain still works INSIDE job 2.
    transport.emit({ t: 'status', v: bridgeStatus(102, 1) })
    expect(ctrl.programProgress().lastCompletedId).toBe(101)
  })

  it('ends the hand-over chain at a job boundary the BRIDGE declares', async () => {
    const { ctrl, transport } = await connectedBridge()
    expect(ctrl.loadMoves([{ id: 11, kind: 'line', to: { x: 1 }, feedMmMin: 600 }]).ok).toBe(true)
    transport.emit({ t: 'jobEvent', v: { event: 'started', fault: null } })
    transport.emit({ t: 'status', v: bridgeStatus(11, 1) })

    // The bridge ends job 1 and starts job 2 on its own - no local loadMoves or
    // startJob in between, so nothing local clears the cursor.
    transport.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } })
    transport.emit({ t: 'jobEvent', v: { event: 'started', fault: null } })
    transport.emit({ t: 'status', v: bridgeStatus(101, 1) })

    expect(ctrl.programProgress().executingId).toBe(101)
    expect(ctrl.programProgress().lastCompletedId).toBeNull()
  })

  it('never reports the move that was in flight when the job stopped as completed', async () => {
    const { ctrl, transport } = await connectedBridge()
    expect(ctrl.loadMoves([{ id: 11, kind: 'line', to: { x: 1 }, feedMmMin: 600 }]).ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    transport.emit({ t: 'status', v: bridgeStatus(11, 3) })
    transport.emit({ t: 'status', v: bridgeStatus(22, 2) })
    expect(ctrl.programProgress().lastCompletedId).toBe(11)

    ctrl.stopJob()
    // 22 was interrupted, which is the opposite of completed - and the stopped
    // job's ids say nothing about the next one.
    expect(ctrl.programProgress()).toEqual({
      executingId: 22,
      lastCompletedId: null,
      total: 0,
      queuedOnController: 2,
    })
  })

  it('reports null buffer occupancy when the bridge reports none - never 0', async () => {
    const { ctrl, transport } = await connectedBridge()
    transport.emit({ t: 'status', v: bridgeStatus(null, null) })
    expect(ctrl.programProgress().queuedOnController).toBeNull()
    expect(ctrl.programProgress().executingId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 3b. ATTEMPT 2: the id-cursor CLASS, pinned at EVERY job boundary.
//
// Three audit rounds found three holes in one thing, each at a different job
// boundary, each because ONE of the two progress cursors was cleared there and
// the other was not. The implementation now clears both from a single method
// (`resetProgressCursors`); these tests pin the property that made a fourth
// hole possible - "no fact from the previous job survives ANY boundary" - once
// per boundary, so a boundary added later without the call is a red test and
// not a fourth audit.
//
// Each case drives job 1 to a REAL completed id (a hand-over the controller
// actually witnessed, so BOTH cursors hold a genuine fact), crosses exactly
// one boundary, and asserts:
//   (a) at the boundary, the completed cursor is empty;
//   (b) the next job's first status reports that job's id and NO completion -
//       neither the previous job's completed id nor a false completion of the
//       move that was in flight when the boundary was crossed;
//   (c) the hand-over chain still WORKS inside the next job - the fix is not
//       "never record anything".
// ---------------------------------------------------------------------------

/**
 * Job 1, driven to a completed id the controller genuinely witnessed: 11 hands
 * over to 22, so `lastCompletedMoveId` holds 11 and the hand-over witness holds
 * 22. Anything either cursor reports after this that still mentions 11 or 22 is
 * a fact from a job that has ended.
 */
async function bridgeMidJob(): Promise<{ ctrl: UccncController; transport: FakeBridge }> {
  const { ctrl, transport } = await connectedBridge()
  expect(
    ctrl.loadMoves([
      { id: 11, kind: 'line', to: { x: 1 }, feedMmMin: 600 },
      { id: 22, kind: 'line', to: { x: 2 }, feedMmMin: 600 },
    ]).ok,
  ).toBe(true)
  expect(ctrl.startJob()).toBe(true)
  transport.emit({ t: 'status', v: bridgeStatus(11, 2) })
  transport.emit({ t: 'status', v: bridgeStatus(22, 1) })
  // The precondition every case below depends on: a real completed id, and a
  // real in-flight id, both belonging to job 1.
  expect(ctrl.programProgress().lastCompletedId).toBe(11)
  expect(ctrl.programProgress().executingId).toBe(22)
  return { ctrl, transport }
}

/** The next job's two frames, and what they must say. Shared by every case so
 *  no boundary is pinned more weakly than any other. */
function expectNextJobStartsClean(ctrl: UccncController, transport: FakeBridge): void {
  transport.emit({ t: 'status', v: bridgeStatus(101, 1) })
  expect(ctrl.programProgress().executingId).toBe(101)
  expect(ctrl.programProgress().lastCompletedId).toBeNull()
  // ...and the chain is alive, not disabled.
  transport.emit({ t: 'status', v: bridgeStatus(102, 1) })
  expect(ctrl.programProgress().lastCompletedId).toBe(101)
}

const JOB2_MOVES: QueuedMove[] = [
  { id: 101, kind: 'line', to: { x: 3 }, feedMmMin: 600 },
  { id: 102, kind: 'line', to: { x: 4 }, feedMmMin: 600 },
]

describe('WO-1023 attempt 2 - no job-progress fact survives ANY job boundary', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('boundary: loadMoves - a new program is a new id space', async () => {
    const { ctrl, transport } = await bridgeMidJob()
    expect(ctrl.loadMoves(JOB2_MOVES).ok).toBe(true)
    expect(ctrl.programProgress().lastCompletedId).toBeNull()
    expect(ctrl.startJob()).toBe(true)
    expectNextJobStartsClean(ctrl, transport)
  })

  it('boundary: startJob - a re-arm of the loaded queue starts from nothing', async () => {
    // No reload: the same queue is re-armed. `startJob` is the ONLY boundary
    // crossed, so if it cleared just the witness the completed id 11 would
    // still be reported inside the new run.
    const { ctrl, transport } = await bridgeMidJob()
    expect(ctrl.startJob()).toBe(true)
    expect(ctrl.programProgress().lastCompletedId).toBeNull()
    expectNextJobStartsClean(ctrl, transport)
  })

  it('boundary: stopJob - the interrupted run is not the next run', async () => {
    const { ctrl, transport } = await bridgeMidJob()
    ctrl.stopJob()
    expect(ctrl.programProgress().lastCompletedId).toBeNull()
    // 22 was interrupted, which is the opposite of completed - and the DRO
    // deliberately keeps showing it, which is why the completed cursor, not
    // `lastStatus`, is what has to be empty.
    expect(ctrl.programProgress().executingId).toBe(22)
    expect(ctrl.loadMoves(JOB2_MOVES).ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    expectNextJobStartsClean(ctrl, transport)
  })

  it('boundary: teardown - progress does not survive a disconnect', async () => {
    const { ctrl, transport } = await bridgeMidJob()
    await ctrl.disconnect()
    expect(ctrl.programProgress().lastCompletedId).toBeNull()
    expect(ctrl.programProgress().executingId).toBeNull()

    // Reconnect on a fresh socket and run a second job: the chain works again
    // from scratch, with nothing carried across the session boundary.
    const next = new FakeBridge()
    const connecting = ctrl.connect({ kind: 'messages', transport: next })
    next.emit({
      t: 'hello',
      v: {
        protocol: SUPPORTED_BRIDGE_PROTOCOL,
        bridge: 'liencam-uccnc-bridge/test',
        capabilities: GEOMETRY_CAPS,
        readOnly: false,
      },
    })
    await connecting
    expect(ctrl.loadMoves(JOB2_MOVES).ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    expectNextJobStartsClean(ctrl, next)
    // `transport` is the socket the disconnect closed; it is not the one the
    // second job ran on, which is the point of the case.
    expect(transport).not.toBe(next)
  })

  // The three bridge-declared END events. Each is followed by a bridge-declared
  // 'started' with no local loadMoves or startJob in between - the exact shape
  // of the third audit finding (uccncController.ts:1265), where nothing local
  // was there to clear anything.
  const BRIDGE_END_EVENTS = ['stopped', 'completed', 'failed'] as const
  for (const event of BRIDGE_END_EVENTS) {
    it('boundary: bridge jobEvent ' + event + ' - the job is over here too', async () => {
      const { ctrl, transport } = await bridgeMidJob()
      transport.emit({
        t: 'jobEvent',
        v: {
          event,
          fault:
            event === 'failed'
              ? { code: 7, message: 'The drive faulted mid-cut.', line: null, moveId: 22 }
              : null,
        },
      })
      expect(ctrl.programProgress().lastCompletedId).toBeNull()
      transport.emit({ t: 'jobEvent', v: { event: 'started', fault: null } })
      expectNextJobStartsClean(ctrl, transport)
    })
  }

  it('boundary: bridge jobEvent started alone - a bridge-started job inherits nothing', async () => {
    // No end event at all: the bridge simply declares a new job while this end
    // still holds job 1's completed id.
    const { ctrl, transport } = await bridgeMidJob()
    transport.emit({ t: 'jobEvent', v: { event: 'started', fault: null } })
    expect(ctrl.programProgress().lastCompletedId).toBeNull()
    expectNextJobStartsClean(ctrl, transport)
  })

  it('NOT boundaries: paused and resumed leave the chain intact - the same job runs on', async () => {
    // The other half of the property. A fix that cleared the cursors on every
    // event would pass every case above and make a resumed job forget what it
    // finished before the pause, which is a different lie in the same field.
    const { ctrl, transport } = await bridgeMidJob()
    transport.emit({ t: 'jobEvent', v: { event: 'paused', fault: null } })
    expect(ctrl.programProgress().lastCompletedId).toBe(11)
    transport.emit({ t: 'jobEvent', v: { event: 'resumed', fault: null } })
    expect(ctrl.programProgress().lastCompletedId).toBe(11)

    // ...and the hand-over that spans the pause still completes 22, because the
    // witness survived it too.
    transport.emit({ t: 'status', v: bridgeStatus(33, 1) })
    expect(ctrl.programProgress().lastCompletedId).toBe(22)
  })

  it('clears every progress cursor from ONE place, so a new boundary cannot clear half of them', async () => {
    // The class, stated as behaviour rather than as a grep: whatever the
    // boundary, the two facts a job leaves behind - "what finished" and "what
    // was in flight" - go empty TOGETHER. A boundary that cleared only the
    // witness would report 11 at (a); one that cleared only the completed id
    // would falsely complete 22 into the next job at (b). Every boundary this
    // controller has is run through the same pair of assertions.
    const crossings: Array<[string, (c: UccncController, t: FakeBridge) => void]> = [
      ['loadMoves', (c) => void c.loadMoves(JOB2_MOVES)],
      ['startJob', (c) => void c.startJob()],
      ['stopJob', (c) => c.stopJob()],
      ['jobEvent:started', (_c, t) => t.emit({ t: 'jobEvent', v: { event: 'started', fault: null } })],
      ['jobEvent:stopped', (_c, t) => t.emit({ t: 'jobEvent', v: { event: 'stopped', fault: null } })],
      ['jobEvent:completed', (_c, t) => t.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } })],
      [
        'jobEvent:failed',
        (_c, t) =>
          t.emit({
            t: 'jobEvent',
            v: { event: 'failed', fault: { code: 7, message: 'fault', line: null, moveId: 22 } },
          }),
      ],
    ]
    for (const [name, cross] of crossings) {
      const { ctrl, transport } = await bridgeMidJob()
      cross(ctrl, transport)
      expect(ctrl.programProgress().lastCompletedId, name + ': completed cursor must be empty').toBeNull()
      // Re-arm through the route that boundary leaves open and take the next
      // job's first frame: no completion may appear out of the old job's
      // in-flight id.
      if (!ctrl.hasActiveJob()) {
        ctrl.loadMoves(JOB2_MOVES)
        ctrl.startJob()
      }
      transport.emit({ t: 'status', v: bridgeStatus(101, 1) })
      expect(ctrl.programProgress().lastCompletedId, name + ': no false completion in the next job').toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. QueuedMove.rapid - additive, and ignored by every backend that exists.
// ---------------------------------------------------------------------------

describe('WO-1023 QueuedMove.rapid - additive and harmless today', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the simulated backend accepts and runs a move carrying rapid, unchanged', async () => {
    const withFlag = await connectedSim()
    const without = await connectedSim()
    const flagged: QueuedMove[] = [{ id: 1, kind: 'line', to: { x: 30, y: 30, z: 10 }, feedMmMin: 600, rapid: true }]
    const plain: QueuedMove[] = [{ id: 1, kind: 'line', to: { x: 30, y: 30, z: 10 }, feedMmMin: 600 }]

    expect(withFlag.loadMoves(flagged)).toEqual({ ok: true, reason: null })
    expect(without.loadMoves(plain)).toEqual({ ok: true, reason: null })
    expect(withFlag.startJob()).toBe(true)
    expect(without.startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)

    // Ignored means IGNORED: same end position, same progress, no alarm.
    expect(withFlag.status().machinePos).toEqual(without.status().machinePos)
    expect(withFlag.jobProgress()).toEqual(without.jobProgress())
    expect(withFlag.programProgress()).toEqual(without.programProgress())
  })

  it('the bridge backend accepts a move carrying rapid and passes it through untouched', async () => {
    const { ctrl, transport } = await connectedBridge()
    const moves: QueuedMove[] = [
      { id: 1, kind: 'line', to: { x: 10, y: 10, z: 5 }, feedMmMin: 4000, rapid: true },
      { id: 2, kind: 'line', to: { x: 20, y: 10, z: 5 }, feedMmMin: 600 },
    ]
    expect(ctrl.loadMoves(moves)).toEqual({ ok: true, reason: null })
    const call = transport.sent.filter((c) => c.m === 'loadMoves').at(-1)
    expect(call).toBeDefined()
    // The flag reaches the wire as-is - the app does not strip it, and does
    // not turn it into a feed of its own.
    expect((call!.a as { moves: QueuedMove[] }).moves).toEqual(moves)
  })
})
