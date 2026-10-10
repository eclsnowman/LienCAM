// @vitest-environment jsdom
//
// WO-1897: A G53 MOVE STAYS IN MACHINE COORDINATES THROUGH EVERY COPY.
//
// `buildStraightLineProgram` marks a G53 line machine-absolute and hangs its
// MACHINE target on the step. Two production routes then make an ordinary
// `{ ...step }` copy of that step:
//
//   1. `rebaseProgram` (src/lib/program/multiSetupProgram.ts) - every stage
//      after the first has its ids rebased so the whole program's ids stay
//      unique across a multi-setup program.
//   2. the session's `restage` (src/lib/machine/machineSession.ts, inside
//      `loadGcodeTextToolpathProgram`) - the part staged after a hold, re-read
//      against work offsets edited since the file was loaded.
//
// While those facts lived in NON-ENUMERABLE properties, both copies dropped
// them, and the step that went on the wire said nothing about machine
// coordinates and carried no machine target - an ordinary WORK move for the
// bridge to add the active work offset to.
//
// WHERE THIS FILE READS: off the step, and off the WIRE. The controller builds
// each staged move's wire form (`machineMoveWireForm`, the `toJSON` of the copy
// `UccncController.sendStagedLoad` hands over) and `bridgeTransport.send` is
// `socket.send(JSON.stringify(message))`, so a staged move's own properties are
// not what the board is told - that serialised wire form is. A test that read
// the live object would have watched a G53 line's work-coordinate bookkeeping
// value and called it the target. The restage half below reads the frame the
// real controller actually put on a fake socket.
//
// AND A STEP IS PLAIN DATA: a built program is posted to the path-fidelity
// worker by structured clone, which refuses a function (DataCloneError). The
// wire form is therefore made AT the wire, never carried on the step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { interpretGcodeProgram } from '../../lib/gcode/interpret'
import { planMultiSetupProgram, type MultiSetupInput } from '../../lib/program/multiSetupProgram'
import { machineMoveWireForm } from '../../lib/program/buildMachineProgram'
import type { ProgramStep, QueuedMove } from '../../lib/machine/controller'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import type { ToolpathMove, WCS } from '../../types'
import { makeMachine } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { typedMock } from '../support/typedMock'

/** The machine Z the G53 retract in these fixtures parks at. */
const PARK_Z = 190
/** The G54 Z in force when the file is read - what the reader bakes the G53
 *  line's work-coordinate bookkeeping value against - and the edit Operator makes
 *  between an air run and the real one (the 09-14 session). */
const LOAD_Z = 66.57
const EDITED_Z = 110

type MachineAbsoluteFacts = {
  machineAbsolute?: true
  machineTarget?: Partial<{ x: number; y: number; z: number }>
}

/** What the socket would send for these steps: the controller's wire form of
 *  each (`machineMoveWireForm`, what `sendStagedLoad`'s copy serialises to), serialised. */
function wireForm(steps: readonly ProgramStep[]): Array<Record<string, unknown>> {
  const moves = steps.map((step) => machineMoveWireForm(step as QueuedMove))
  return JSON.parse(JSON.stringify(moves)) as Array<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// COPY 1: the multi-setup id rebase.
// ---------------------------------------------------------------------------

function frame(id: string, originZ: number): WCS {
  return {
    id,
    label: id,
    fixtureOffset: id === 'G54' ? 54 : 55,
    origin: { x: 0, y: 0, z: originZ },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
  }
}

/**
 * The moves a real section hands the builder, produced by the REAL reader so
 * the machine-absolute fact on them is the reader's own and not this test's:
 * a cut, then the `G53 G0 Z190` retract that ends the section.
 */
function readerMoves(): readonly ToolpathMove[] {
  const interpreted = interpretGcodeProgram(
    `G21 G90 G54\nG1 X20 Y30 Z-2 F600\nG53 G0 Z${PARK_Z}\nM30`,
    {
      dialect: 'uccnc',
      sessionWcs: 'G54',
      initialPosition: { x: 0, y: 0, z: 0 },
      machineUnits: 'mm',
      workOffsets: { G54: { x: 0, y: 0, z: LOAD_Z } },
    },
  )
  if (!interpreted.ok) throw new Error(interpreted.refusal.message)
  return interpreted.program.stages[0].moves as readonly ToolpathMove[]
}

function setup(setupId: string, wcsId: string, originZ: number): MultiSetupInput {
  return {
    setupId,
    setupName: `Setup ${setupId}`,
    wcsId,
    wcs: frame(wcsId, originZ),
    tool: { id: 't1', label: 'T1 (6 mm flat end mill)' },
    sections: [{ opId: `${setupId}-op`, moves: readerMoves() }],
  }
}

/** Every step in the planned program that claims to be machine-absolute. */
function machineAbsoluteSteps(steps: readonly ProgramStep[]): Array<ProgramStep & MachineAbsoluteFacts> {
  return steps.filter(
    (step): step is ProgramStep & MachineAbsoluteFacts =>
      (step as MachineAbsoluteFacts).machineAbsolute === true,
  )
}

describe('WO-1897: a G53 step survives the multi-setup id rebase', () => {
  const plan = (): ReturnType<typeof planMultiSetupProgram> =>
    planMultiSetupProgram([setup('a', 'G54', 0), setup('b', 'G55', 40)], 5000, 4095)

  it('keeps machine-absolute and the machine target on BOTH stages', () => {
    const planned = plan()
    if (!planned.ok) throw new Error(planned.reason)

    // One per setup. Stage 1 is handed through untouched (id offset 0);
    // stage 2's ids are rebased, which is where the copy happens.
    const absolute = machineAbsoluteSteps(planned.plan.program.steps)
    expect(absolute).toHaveLength(2)
    for (const step of absolute) expect(step.machineTarget).toEqual({ z: PARK_Z })
  })

  it('sends the machine target on the wire from every part the controller is handed', () => {
    const planned = plan()
    if (!planned.ok) throw new Error(planned.reason)

    // `plan.parts` is what `loadProgram` hands the controller. Without the flag
    // the bridge adds the active work offset to whatever `to` says
    // (pendant/uccnc-bridge/Bridge.cs, "machineAbsolute"), so a retract that
    // must reach machine Z 190 would land at 190 plus that offset.
    const wire = planned.plan.parts
      .flatMap((part) => wireForm(part.steps))
      .filter((step) => step.machineAbsolute === true)
    expect(wire).toHaveLength(2)
    for (const step of wire) expect(step.to).toEqual({ z: PARK_Z })
  })

  it('survives structured clone - the path-fidelity worker post - with the facts intact', () => {
    const planned = plan()
    if (!planned.ok) throw new Error(planned.reason)

    // `armPathFidelityFromMoves` hands built steps to `worker.postMessage`,
    // which structured-clones them. A function on a step throws DataCloneError
    // there, from the status-sample handler, on every frame of the run.
    const program = structuredClone(planned.plan.program)
    const parts = structuredClone(planned.plan.parts)

    const absolute = machineAbsoluteSteps(program.steps)
    expect(absolute).toHaveLength(2)
    for (const step of absolute) expect(step.machineTarget).toEqual({ z: PARK_Z })

    // And the clone still goes on the wire as the machine target.
    const wire = parts
      .flatMap((part) => wireForm(part.steps))
      .filter((step) => step.machineAbsolute === true)
    expect(wire).toHaveLength(2)
    for (const step of wire) {
      expect(step.to).toEqual({ z: PARK_Z })
      expect(step).not.toHaveProperty('machineTarget')
    }
  })

  it('leaves every non-G53 step exactly as it was', () => {
    const planned = plan()
    if (!planned.ok) throw new Error(planned.reason)
    const ordinary = planned.plan.program.steps.filter(
      (step) => (step as MachineAbsoluteFacts).machineAbsolute !== true,
    )
    for (const step of ordinary) {
      expect(step).not.toHaveProperty('machineAbsolute')
      expect(step).not.toHaveProperty('machineTarget')
      expect(wireForm([step])[0]).not.toHaveProperty('machineAbsolute')
    }
  })
})

// ---------------------------------------------------------------------------
// COPY 2: the session's restage, through the real session singleton and a real
// `UccncController` over a fake bridge socket - the harness WO-1640 built for
// this exact gesture (load, edit G54 Z at a hold, Cycle Start).
// ---------------------------------------------------------------------------

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

/** Operator's AXBB-E as the bridge reports it: no G-code interpreter. */
const PROGRAM_BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const UNSET = { x: 0, y: 0 }

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  /** The G54 row the fake board holds - what LoadMoves would bake in. */
  g54: { x: number; y: number; z: number }
  emit(message: BridgeMessage): void
}

const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    g54 = { x: 0, y: 0, z: LOAD_Z }
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const offsets = {
        G54: { ...this.g54 },
        G55: { ...UNSET },
        G56: { ...UNSET },
        G57: { ...UNSET },
        G58: { ...UNSET },
        G59: { ...UNSET },
      }
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1897-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      // WHAT THE SOCKET WOULD PUT ON THE WIRE, captured as the socket captures
      // it: `JSON.stringify(message)`. Every loadMoves is recorded with the
      // G54 Z the board holds AT THAT CALL - the offset LoadMoves bakes in.
      this.sent.push(message.m === 'loadMoves'
        ? { ...(JSON.parse(JSON.stringify(message)) as BridgeCallMessage & { a: object }), a: { ...(JSON.parse(JSON.stringify(message.a)) as object), bakedZ: this.g54.z } }
        : message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
      if (message.m === 'setWorkOffset') {
        const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
        if (a.wcs === 'G54') this.g54 = { x: a.x ?? this.g54.x, y: a.y ?? this.g54.y, z: a.z ?? this.g54.z }
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, offset: { ...this.g54 } },
        })
      }
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { useCamStore } = await import('../../store')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo1897-machine'

/** Z travels 0..300 in machine coordinates, so G53 Z190 is on the table and a
 *  stale bake of it would be too - nothing refuses it for us. */
function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 300
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  controllerDefinition.outputs = []
  return makeMachine({
    id: MACHINE_ID,
    name: 'WO-1897 Machine',
    travel: { x: 600, y: 400, z: 300 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 300 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

function idleBridgeStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 200 },
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

let originalProject: Project

beforeEach(async () => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  useMachineActions.setState({ byMachine: {} })
  useMachineToolTable.setState({ byMachine: {} })
  originalProject = useCamStore.getState().project
  useCamStore.setState({ project: { ...originalProject, machine: machine(), setups: [] } })
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject, machineWorkOffsets: {} })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

async function load(name: string, text: string): Promise<void> {
  const loaded = loadGcodeTextToolpathProgram(name, text, { publishListing: true })
  await act(async () => { await vi.advanceTimersByTimeAsync(20) })
  expect(loaded).toEqual({ ok: true, reason: null })
}

async function cycleStart(): Promise<void> {
  let accepted = false
  await act(async () => {
    accepted = await executeOperatorCycleStart()
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(accepted).toBe(true)
}

async function editG54Z(z: number): Promise<void> {
  expect(setWorkOffsetValue('G54', 'Z', z)).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  expect(socket().g54.z).toBe(z)
}

/** The serialised moves of the last `loadMoves` the board was sent before it
 *  was told to start, with the G54 Z it baked into them. */
function stagedAtStart(from: number): { bakedZ: number; moves: Array<Record<string, unknown>> } {
  const calls = socket().sent
  const startAt = calls.findIndex((m, index) => index >= from && m.m === 'startJob')
  expect(startAt).not.toBe(-1)
  const staged = calls.slice(0, startAt).filter((m) => m.m === 'loadMoves').at(-1)
  expect(staged).toBeDefined()
  const a = staged!.a as { bakedZ: number; moves: Array<Record<string, unknown>> }
  return { bakedZ: a.bakedZ, moves: a.moves }
}

/** The MACHINE Z each staged line ends at, read the way the bridge reads it:
 *  a machine-absolute line's `to` IS machine coordinates, everything else is
 *  the work value the board adds the baked offset to. */
function machineZAtStart(from: number): number[] {
  const { bakedZ, moves } = stagedAtStart(from)
  return moves
    .filter((move) => move.kind === 'line' && typeof (move.to as { z?: number })?.z === 'number')
    .map((move) => {
      const z = (move.to as { z: number }).z
      return Number((move.machineAbsolute === true ? z : z + bakedZ).toFixed(4))
    })
}

const G53_HOLD_NC = `G21 G90 G54\nG0 X50 Y50 Z10\nM0\nG53 G0 Z${PARK_Z}\nG0 X60 Y60\nM30\n`

describe('WO-1897: a G53 step survives the session restage after a work-offset edit', () => {
  it('goes on the wire as its machine target, declared machine-absolute', async () => {
    await load('g53-hold.nc', G53_HOLD_NC)
    await cycleStart()
    // The first section ends at the M0 and the program holds there.
    act(() => {
      socket().emit({ t: 'status', v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } } } as BridgeMessage)
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    // The edit Operator makes at the hold. The section after it is RESTAGED - the
    // copy this order is about.
    await editG54Z(EDITED_Z)
    const mark = socket().sent.length
    await cycleStart()

    const { moves } = stagedAtStart(mark)
    const park = moves.find((move) => move.machineAbsolute === true)
    expect(park).toBeDefined()
    // Its own partial machine target, and only the axis the G53 block named:
    // X and Y are HELD by the board, exactly as they are at load.
    expect(park!.to).toEqual({ z: PARK_Z })
    // The bridge has never read `machineTarget`; a second target on the wire
    // would be a second opinion about where the tool goes.
    expect(park).not.toHaveProperty('machineTarget')
  })

  it('still parks the tool at machine Z 190, with no work offset applied to it', async () => {
    await load('g53-hold.nc', G53_HOLD_NC)
    let mark = socket().sent.length
    await cycleStart()
    expect(machineZAtStart(mark)).toEqual([Number((10 + LOAD_Z).toFixed(4))])
    act(() => {
      socket().emit({ t: 'status', v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } } } as BridgeMessage)
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    await editG54Z(EDITED_Z)
    mark = socket().sent.length
    await cycleStart()

    // The retract, and the XY move after it that holds the height it reached.
    expect(machineZAtStart(mark)).toEqual([PARK_Z, PARK_Z])
  })

  it('leaves the ordinary work moves in the same restaged part alone', async () => {
    await load('g53-hold.nc', G53_HOLD_NC)
    await cycleStart()
    act(() => {
      socket().emit({ t: 'status', v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } } } as BridgeMessage)
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    await editG54Z(EDITED_Z)
    const mark = socket().sent.length
    await cycleStart()

    const { moves } = stagedAtStart(mark)
    const ordinary = moves.filter((move) => move.machineAbsolute !== true)
    expect(ordinary).toHaveLength(1)
    // `G0 X60 Y60` at the new zero: a WORK move, re-read against the edit, with
    // nothing about machine coordinates on it.
    expect(ordinary[0]).not.toHaveProperty('machineAbsolute')
    expect(ordinary[0]).not.toHaveProperty('machineTarget')
    expect(ordinary[0].to).toEqual({ x: 60, y: 60, z: PARK_Z - EDITED_Z })
  })
})
