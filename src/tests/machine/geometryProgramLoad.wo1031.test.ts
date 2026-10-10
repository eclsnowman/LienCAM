// WO-1031 (WO-1019 slice 1c, ADR-0043 sections 3-4) - the app layer that turns
// a toolpath into a LOADED, RUNNABLE geometry program. The minimal
// all-or-nothing door, with NO app-side staged flag at all.
//
// WHAT IS PROVEN HERE, AND WHAT IS NOT:
//
//   PROVEN, on the real session singleton against the real SimulatedController
//   (no mocked controller, no stubbed builder): a straight-line toolpath is
//   built, staged on the controller, started through the PRODUCT's own Cycle
//   Start (`executeOperatorCycleStart`), held, resumed and stopped; the moves
//   the machine flies are in WORK coordinates; the path-fidelity check is armed
//   BY THE LOAD, so a geometry run is measured - "measure OUR software".
//
//   PROVEN: VALIDATE BEFORE SEND. Every refusal - no program capability, an
//   action step, a machine with no declared rapid rate, a setup that is
//   gone, a job already running - sends NOTHING: `loadMoves` is never called
//   and the controller's staged program is exactly what it was before.
//
//   PROVEN: THE CONTROLLER IS THE ONLY SOURCE OF TRUTH FOR "A PROGRAM IS
//   STAGED". Loading B over A leaves the CONTROLLER holding B; there is no
//   app-side staged flag anywhere in this slice, so there is no second copy to
//   go stale - that is what closed the cross-controller class the first three
//   attempts kept re-opening.
//
//   PROVEN: AND THE APP DOES NOT CARRY THE PREVIOUS CONTROLLER SESSION'S
//   ANSWER ACROSS A BOUNDARY EITHER. "The fresh controller refuses by its own
//   gate" is TRUE OF THE SIMULATOR AND FALSE OF THE BOARD THIS ORDER EXISTS
//   FOR: `UccncController.startJob()` (uccncController.ts:969) checks only that
//   motion is allowed and then sends the frame. So at every connection
//   transition the app RE-READS the live controller's own job progress and
//   drops a readiness that still claims ready when that controller reports it
//   holds nothing. Proven on the wire for three routes - a disconnect and
//   reconnect, a swap onto an UPDATED bridge, and a swap onto an UN-UPDATED one
//   (no `machineProgram` at all, the case audit round 6 found open) - by the
//   only honest measure of a refused start: NO `startJob` FRAME LEFT THE APP.
//
//   PROVEN with a fake bridge message channel in place of the WebSocket (the
//   WO-422 posture - the protocol is the contract): a backend that does not
//   declare `machineProgram` is refused BEFORE anything is sent, and the
//   EXISTING G-code-text refusal on that same geometry backend is untouched.
//
//   NOT CLAIMED, and deliberately absent from this slice: the load-time zero
//   snapshot and the re-zero guard on Cycle Start. Both need the active work
//   offset, which the AXBB-E bridge does not report today; they land on top of
//   WO-1032. Until then the bridge path loads and runs without the stale-zero
//   guard, which is stated in the work order and in `machineSession.ts`.
//
//   NOT CLAIMED: hardware. Nothing here touches Operator's machine.

import { buildBoreToolpath } from '../../lib/cam/bore2d'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { buildAdaptiveClearingToolpath } from '../../lib/cam/adaptiveClearing2d/engine'
import { ensureEngineClipperReady } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import type {
  ACParams, ACWorkerPayload, BoreParams, BoreWorkerPayload, FaceWorkerPayload, LoopData,
} from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams } from '../../types'
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
  MachineStatus,
  QueuedMove,
} from '../../lib/machine/controller'
import type { MachineConfig, Project, Setup, Tool, ToolpathMove, UnsentSetting } from '../../types'
import { makeMachine, makeOp, makeStock, makeWcs } from '../post/helpers'
import { typedMock } from '../support/typedMock'

/**
 * A bridge that does EVERYTHING the AXBB-E does except geometry programs -
 * `machineProgram` is absent, which reads as false (WO-1023's rule). This is
 * the shape an un-updated bridge reports, and `gcodeText: false` is permanent
 * on it: the board has no interpreter. Both halves of one acceptance line.
 */
const OLD_BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

/**
 * An UPDATED bridge - the same AXBB-E, plus the geometry-program route
 * (`machineProgram`). This is the board the straight-line benchmark actually
 * runs on.
 */
const PROGRAM_BRIDGE_CAPABILITIES: ControllerCapabilities = {
  ...OLD_BRIDGE_CAPABILITIES,
  machineProgram: true,
}

/** Which bridge the next connection reports itself as. */
let bridgeCapabilities: ControllerCapabilities = OLD_BRIDGE_CAPABILITIES

// The real BridgeTransport declares private instance fields, so no class
// outside its own declaration can satisfy `typeof BridgeTransport`
// structurally - the fake must EXTEND it (see hardwareEstop.test.tsx), which
// happens inside the vi.mock factory where the real class is reachable via
// importOriginal.
interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  frames(method: string): BridgeCallMessage[]
  loadMovesFrames(): { moves: unknown[]; frame?: string }[]
}

/** Every fake transport this file has built, newest last - a reconnect makes a
 *  NEW `UccncController` over a NEW socket to the SAME bridge process, so the
 *  frames have to be read per socket rather than in one pile. */
const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  // Stands in for bridgeTransport's WebSocket - the WO-422 test's fake,
  // verbatim in behaviour: hello the moment the controller attaches.
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1031-fake 0.0',
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

    /** Push a frame at the controller the way the real bridge would. */
    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }

    /** Every frame of one method this socket carried, in order. `startJob` is the
     *  frame that BEGINS MOTION on the board (`Bridge.cs` -> `Machine.StartJob`),
     *  so "no start frame reached the wire" is the only honest way to say a start
     *  was refused - the app's own return value is an account, not the act. */
    frames(method: string): BridgeCallMessage[] {
      return this.sent.filter((m) => m.m === method)
    }

    /** The `loadMoves` frames this socket carried, in order - the ONLY way
     *  anything reaches or leaves the bridge's staged list (`Bridge.cs:2239` ->
     *  `Machine.LoadMoves`). */
    loadMovesFrames(): { moves: unknown[]; frame?: string }[] {
      return this.sent
        .filter((m) => m.m === 'loadMoves')
        .map((m) => m.a as { moves: unknown[]; frame?: string })
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: FakeBridgeTransport })
})

/**
 * THE BUILDER IS REAL EXCEPT WHERE ONE TEST NEEDS A PROGRAM IT CANNOT PRODUCE.
 *
 * The straight-line builder emits `line` steps and refuses everything else, so
 * an ACTION-step program - the case the door has to refuse BEFORE sending
 * anything - cannot be reached through it. `override` injects exactly that one
 * program, for exactly that one test; it is null everywhere else and every
 * other test runs the real builder end to end.
 */
const build = vi.hoisted(() => ({ override: null as unknown }))

vi.mock('../../lib/program/buildMachineProgram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/program/buildMachineProgram')>()
  return typedMock<typeof import('../../lib/program/buildMachineProgram')>({
    ...actual,
    buildStraightLineProgram: (
      ...args: Parameters<typeof actual.buildStraightLineProgram>
    ): ReturnType<typeof actual.buildStraightLineProgram> =>
      (build.override as ReturnType<typeof actual.buildStraightLineProgram> | null)
      ?? actual.buildStraightLineProgram(...args),
  })
})

const session = await import('../../lib/machine/machineSession')
const {
  currentOperatorTransport,
  executeOperatorCycleStart,
  executeOperatorFeedHold,
  executeOperatorStopReset,
  RE_ARM_LABEL,
} = await import('../../lib/machine/operatorTransport')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')

const {
  armProgramFromTop,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGeometryProgram,
  loadMachineProgram,
  pathFidelityReport,
  RE_ARM_REFUSAL,
  setPathToleranceMm,
  __resetEstopInterlockForTest,
} = session

const TRACE = { opId: 'op1', setupId: 'setup1' }

const TEXT_ON_GEOMETRY_BACKEND =
  'G-code file refused: this controller runs setups, not G-code files - load the setup instead.'

/** Operator's real `Linearerror`, carried verbatim by the profile importer. Present
 *  so the run's fidelity verdict is MEASURED rather than UNKNOWN. */
const SAMPLE_MACHINE_LINEAR_ERROR: UnsentSetting = {
  controller: 'uccnc',
  key: 'Generalsettings.Linearerror',
  value: '0.03',
}

function machine(over: Partial<MachineConfig> = {}): MachineConfig {
  return makeMachine({
    id: 'wo1031-machine',
    name: 'WO-1031 Test Machine',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    unsentSettings: [SAMPLE_MACHINE_LINEAR_ERROR],
    ...over,
  })
}

/** A setup whose WCS origin is NOT the world origin, so the world->work
 *  transform is actually exercised rather than being an identity no-op. */
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

/** A rapid plus three feeds - the acceptance's own toolpath. WORLD coordinates,
 *  chosen so every resolved work coordinate stays inside the travel envelope. */
function straightLineToolpath(): ToolpathMove[] {
  return [
    { type: 'rapid', x: 10, y: 5, z: 22 },
    { type: 'feed', x: 10, y: 5, z: 1, feed: 300 },
    { type: 'feed', x: 60, y: 5, z: 1, feed: 900 },
    { type: 'feed', x: 60, y: 45, z: 1, feed: 900 },
  ]
}

function toolpathWithArc(): ToolpathMove[] {
  return [
    ...straightLineToolpath(),
    { type: 'arc_cw', x: 40, y: 45, z: 1, cx: 50, cy: 45, feed: 900 },
  ]
}

/** WO-1337: a HELICAL arc - the same arc, ramping 5 mm down as it sweeps. The
 *  builder refused this by name until WO-1337; it now stages as one arc step
 *  carrying the endpoint Z it ramps to. */
function toolpathWithHelicalArc(): ToolpathMove[] {
  return [
    ...straightLineToolpath(),
    { type: 'arc_cw', x: 40, y: 45, z: -4, cx: 50, cy: 45, feed: 900 },
  ]
}

/** An arc this builder still refuses by name, and always has: start and end
 *  coincide, so which way and how far round is ambiguous. WO-1337 lifted the
 *  HELICAL refusal and not this one, which is why the "a refused load changes
 *  nothing" proof below now uses it. */
function toolpathWithFullCircleArc(): ToolpathMove[] {
  return [
    ...straightLineToolpath(),
    { type: 'arc_cw', x: 60, y: 45, z: 1, cx: 50, cy: 45, feed: 900 },
  ]
}

const TEXT_PROGRAM = ['G21 G90 G54', 'G0 X0 Y0 Z5', 'M30'].join('\n')

/** An IDLE status frame, the shape `Bridge.cs` pushes. The bridge is the only
 *  thing that can make the app's machine state `idle`, and CYCLE START is gated
 *  on idle - so a bridge test that never emits one can never reach the start
 *  path at all, and would prove nothing about a start being refused. */
function idleBridgeStatus(): MachineStatus {
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

function projectWith(over: Partial<Project> = {}): Partial<Project> {
  return { machine: machine(), setups: [setup()], activeSetupId: 'setup1', ...over }
}

function applyProject(over: Partial<Project> = {}): void {
  useCamStore.setState((s) => ({ project: { ...s.project, ...projectWith(over) } }))
}

let originalProject: Project

beforeEach(() => {
  vi.useFakeTimers()
  build.override = null
  bridgeCapabilities = OLD_BRIDGE_CAPABILITIES
  bridgeSockets.length = 0
  originalProject = useCamStore.getState().project
  applyProject()
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  build.override = null
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

async function disconnect(): Promise<void> {
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(300)
  await pending
}

/** Read the machine's modal state the way the Offsets panel does, so nothing in
 *  the store is a value this test typed. */
function readMachineState(): void {
  getMachineController().refreshState()
}

function loadTheStraightLine(): { ok: boolean; reason: string | null } {
  return loadGeometryProgram('wo1031', straightLineToolpath(), TRACE)
}

/** What the CONTROLLER says it is holding - the only source of truth this
 *  slice recognises for "a program is staged". */
function stagedOnController(): number | undefined {
  return getMachineController().programProgress?.().total
}

describe('WO-1031: loadGeometryProgram loads and runs on the simulator', () => {
  beforeEach(async () => {
    await connect('simulator')
    readMachineState()
  })

  it('stages the built program on the controller and reports it ready', () => {
    const result = loadTheStraightLine()

    expect(result).toEqual({ ok: true, reason: null })
    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(true)
    expect(readiness.reason).toContain('Toolpath program "wo1031" loaded')
    expect(readiness.reason).toContain('4 moves, runs in G54')
    // The operator hears it on the surface this machine's messages go to.
    expect(useMachineControl.getState().consoleLines.map((line) => line.text))
      .toContain(readiness.reason)
    // Every step reached the controller, and the store's counters were re-read
    // off it rather than assumed.
    expect(stagedOnController()).toBe(4)
    expect(useMachineControl.getState().job.totalLines).toBe(4)
  })

  it('the program the controller got is in WORK coordinates - the setup origin is subtracted', async () => {
    expect(loadTheStraightLine().ok).toBe(true)

    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)

    // The last move is WORLD (60,45,1) under a WCS origin of (10,5,2), so its
    // WORK coordinate is (50,40,-1). If the world->work transform were skipped
    // the machine would end at (60,45,1); if it were applied twice, at
    // (40,35,-3). This is the assertion that tells those three apart.
    //
    // Work reads as machine here only because the offset register is 0,0,0 on a
    // fresh simulator - the simulator's `loadMoves` stages what it is given
    // (the BRIDGE is what adds `offsets[activeWcs]`, ADR-0043 section 3).
    expect(getMachineController().status().machinePos).toEqual({ x: 50, y: 40, z: -1 })
  })

  it('runs, holds, resumes and stops through the operator transport', async () => {
    expect(loadTheStraightLine().ok).toBe(true)
    const ctrl = getMachineController()

    // The PRODUCT's Cycle Start, not the controller's: this only fires because
    // the load left readiness ready and the job phase 'ready'.
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(60)
    expect(ctrl.hasActiveJob()).toBe(true)
    expect(ctrl.programProgress?.().executingId).toBe(1)

    expect(executeOperatorFeedHold()).toBe(true)
    const heldAt = ctrl.status().machinePos
    await vi.advanceTimersByTimeAsync(500)
    expect(ctrl.status().machinePos).toEqual(heldAt)

    expect(ctrl.resumeJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(200)

    expect(executeOperatorStopReset()).toBe(true)
    const stoppedAt = ctrl.status().machinePos
    await vi.advanceTimersByTimeAsync(500)
    expect(ctrl.status().machinePos).toEqual(stoppedAt)
    expect(ctrl.hasActiveJob()).toBe(false)

    // A stopped job leaves the CONTROLLER holding nothing, and the controller
    // is the one that says so - no app flag was written or read to get here.
    expect(stagedOnController()).toBe(0)
    expect(ctrl.startJob()).toBe(false)
  })

  it('a completed geometry run was OBSERVED - the fidelity check was armed by the load', async () => {
    expect(loadTheStraightLine().ok).toBe(true)
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)

    const report = pathFidelityReport()
    expect(report).not.toBeNull()
    if (report === null) return
    // THE POINT OF THE ORDER: "measure OUR software". Before this door existed,
    // every geometry load ended on the WO-1008 refusal that named WO-1019.
    expect(report.reason).not.toBe('no commanded move list was recorded for this job.')
    expect(report.attribution).toBe('executing-move')
    expect(report.samples.attributed).toBeGreaterThan(3)
    // The tolerance came off THIS machine's profile (Linearerror=0.03), so the
    // verdict is measured rather than unknown.
    expect(report.toleranceMm).toBe(0.03)
    expect(report.verdict).toBe('clean')
  })

  it('a second load REPLACES the first on the controller - one staged program, never two', () => {
    expect(loadTheStraightLine().ok).toBe(true)
    expect(stagedOnController()).toBe(4)

    // Half the toolpath, so the replacement is visible in the CONTROLLER's own
    // count rather than only in the app's story about it.
    const shorter = straightLineToolpath().slice(0, 2)
    expect(loadGeometryProgram('wo1031-shorter', shorter, TRACE)).toEqual({ ok: true, reason: null })

    expect(stagedOnController()).toBe(2)
    expect(useMachineControl.getState().job.totalLines).toBe(2)
    expect(useMachineControl.getState().programReadiness.reason).toContain('2 moves, runs in G54')
  })
})

// ALL-OR-NOTHING. Three audit rounds found the same class of hazard: a program
// staged on the controller while the app's state said something else. The cure
// is that NOTHING is sent until every check has passed, so a refusal has
// nothing to take back. Each test below starts from a GOOD LOAD - the state
// where a refusal has something to damage - and proves the controller was never
// touched.
describe('WO-1031: every refusal sends NOTHING to the controller', () => {
  beforeEach(async () => {
    await connect('simulator')
    readMachineState()
  })

  /** Load a good program, then watch the controller while the next load
   *  refuses. `loadMoves` is the ONLY way anything reaches a geometry
   *  controller's queue - staging it or emptying it - so a spy that never fires
   *  is the proof that the machine was not touched either way. */
  function afterAGoodLoad(): { loadMoves: ReturnType<typeof vi.spyOn> } {
    expect(loadTheStraightLine().ok).toBe(true)
    expect(stagedOnController()).toBe(4)
    const ctrl = getMachineController() as unknown as { loadMoves: (m: QueuedMove[]) => unknown }
    return { loadMoves: vi.spyOn(ctrl, 'loadMoves') }
  }

  function expectMachineUntouched(
    spy: ReturnType<typeof vi.spyOn>,
    reason: string | null,
    stagedMoves = 4,
  ): void {
    expect(reason).not.toBeNull()
    expect(spy).not.toHaveBeenCalled()
    // The program that WAS loaded is still exactly where it was, and the
    // controller is what says so.
    expect(stagedOnController()).toBe(stagedMoves)
    // ...and the operator is told why the new one was refused, which also
    // closes the transport's Cycle Start until a load succeeds.
    expect(useMachineControl.getState().programReadiness).toEqual({ ready: false, reason })
    expect(useMachineControl.getState().consoleLines.map((line) => line.text)).toContain(reason)
    spy.mockRestore()
  }

  it('an ARC loads natively (WO-1285): the controller receives one arc step, centre and all', () => {
    const { loadMoves } = afterAGoodLoad()

    const result = loadGeometryProgram('wo1031-arc', toolpathWithArc(), TRACE)

    if (!result.ok) throw new Error(result.reason ?? 'refused without a reason')
    const staged = (loadMoves.mock.calls[loadMoves.mock.calls.length - 1] as unknown as [QueuedMove[]])[0]
    const arc = staged.find((m) => m.kind === 'arc')
    expect(arc).toBeDefined()
    if (arc?.kind !== 'arc') return
    // World (40, 45) about (50, 45) under the setup's work origin (10, 5, 2).
    expect(arc.to).toEqual({ x: 30, y: 40, z: -1 })
    expect(arc.centre).toEqual({ x: 40, y: 40, z: -1 })
    expect(arc.clockwise).toBe(true)
  })

  it('a HELICAL arc loads natively too (WO-1337): one arc step, ramping to its endpoint Z', () => {
    const { loadMoves } = afterAGoodLoad()

    // The same arc as above, ramping from work z 1 down to work z -4 as it
    // sweeps. Until WO-1337 this load was REFUSED at the door.
    const result = loadGeometryProgram('wo1031-helix', toolpathWithHelicalArc(), TRACE)

    if (!result.ok) throw new Error(result.reason ?? 'refused without a reason')
    const staged = (loadMoves.mock.calls[loadMoves.mock.calls.length - 1] as unknown as [QueuedMove[]])[0]
    const arc = staged.find((m) => m.kind === 'arc')
    expect(arc).toBeDefined()
    if (arc?.kind !== 'arc') return
    // World (40, 45, -4) about (50, 45) under the setup's work origin
    // (10, 5, 2): the XY is the WO-1285 arc's, and the Z is 6 mm below the
    // feed move that precedes it (work z -1), which is the ramp.
    expect(arc.to).toEqual({ x: 30, y: 40, z: -6 })
    expect(arc.centre).toEqual({ x: 40, y: 40, z: -6 })
    expect(arc.clockwise).toBe(true)
    // It is ONE step, not a chord fan: the whole program is the four straight
    // moves plus this one arc.
    expect(staged.filter((m) => m.kind === 'arc')).toHaveLength(1)
    expect(staged).toHaveLength(5)
  })

  it('WO-1285: an arc whose ENDS are inside the travel but whose bulge is not is refused by name, before the controller sees it', () => {
    const { loadMoves } = afterAGoodLoad()
    // The session's Y travel is 0..400 (machine zero at the min end). Work origin
    // y = 5, so world y = 385 is work y = 380: both ends inside. The
    // counter-clockwise semicircle of radius 30 about (60, 385) sweeps to
    // world y = 415 - off the table - which an endpoint box cannot see.
    const bulging: ToolpathMove[] = [
      { type: 'rapid', x: 90, y: 385, z: 22 },
      { type: 'feed', x: 90, y: 385, z: 1, feed: 300 },
      { type: 'arc_ccw', x: 30, y: 385, z: 1, cx: 60, cy: 385, feed: 900 },
    ]
    const result = loadGeometryProgram('wo1285-bulge', bulging, TRACE)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/an arc/)
    expect(result.reason).toMatch(/outside the Y travel/)
    expect(result.reason).toMatch(/both of its ends are inside/)
    expect(result.reason).toMatch(/bulges off the table/)
    expectMachineUntouched(loadMoves, result.reason)

    // The same ends swept the other way stay on the table and load.
    const inside: ToolpathMove[] = [
      { type: 'rapid', x: 90, y: 385, z: 22 },
      { type: 'feed', x: 90, y: 385, z: 1, feed: 300 },
      { type: 'arc_cw', x: 30, y: 385, z: 1, cx: 60, cy: 385, feed: 900 },
    ]
    const ok = loadGeometryProgram('wo1285-inside', inside, TRACE)
    if (!ok.ok) throw new Error(ok.reason ?? 'refused without a reason')
  })

  // WO-1285: THE THREE ARC EMITTERS, built by their own engines, LOAD.
  // World coordinates are placed inside the 600 x 400 table (work origin
  // (10, 5, 2)), so the only thing that used to refuse them - the builder
  // meeting an arc - is what this proves gone.
  const ENGINE_TOOL = {
    id: 't-arc', name: 'O6 flat', type: 'flat_end_mill',
    diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 2 } },
  } as Tool
  const ENGINE_HEIGHTS: HeightParams = {
    clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute', bottomHeight: -2, bottomHeightMode: 'absolute',
  }
  const ENGINE_PASSES: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  const ENGINE_LINKING: LinkingParams = {
    entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
    retractType: 'full', transitionType: 'safe_height',
  }
  function circleLoop(cx: number, cy: number, r: number): LoopData {
    const points = []
    for (let i = 0; i < 48; i++) points.push({ x: cx + r * Math.cos((2 * Math.PI * i) / 48), y: cy + r * Math.sin((2 * Math.PI * i) / 48) })
    return { id: 'circle', closed: true, type: 'contour', points }
  }
  function rectLoop(x0: number, y0: number, w: number, h: number): LoopData {
    return { id: 'rect', closed: true, type: 'contour', points: [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }] }
  }
  function expectLoads(name: string, moves: ToolpathMove[], loadMoves: ReturnType<typeof vi.spyOn>, arcsExpected: boolean): number {
    const emitted = moves.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw').length
    expect(emitted > 0, `${name} emits arcs`).toBe(arcsExpected)
    const result = loadGeometryProgram(name, moves, TRACE)
    if (!result.ok) throw new Error(`${name}: ${result.reason ?? 'refused'}`)
    const staged = (loadMoves.mock.calls[loadMoves.mock.calls.length - 1] as unknown as [QueuedMove[]])[0]
    expect(staged.filter((m) => m.kind === 'arc').length, `${name} stages every arc natively`).toBe(emitted)
    expect(staged.length, `${name}: one slot per move, no chords`).toBe(moves.length)
    return emitted
  }

  it('WO-1285: a BORE, built by bore2d, loads with native arcs', () => {
    const { loadMoves } = afterAGoodLoad()
    const payload: BoreWorkerPayload = {
      opId: 'op', setupId: 's',
      params: { geometryId: 'g', loopIds: [], direction: 'climb', sortStrategy: 'none' } as BoreParams,
      heights: ENGINE_HEIGHTS, passes: ENGINE_PASSES, linking: ENGINE_LINKING, tool: ENGINE_TOOL,
      loops: [circleLoop(150, 150, 8)], wcsOrigin: { x: 0, y: 0, z: 0 },
    }
    expectLoads('wo1285-bore', buildBoreToolpath(payload), loadMoves, true)
  })

  it('WO-1285: a FACE with smooth transitions, built by face2d, loads with native arcs', async () => {
    await ensureClipperReady()
    const { loadMoves } = afterAGoodLoad()
    const payload: FaceWorkerPayload = {
      opId: 'op', setupId: 'su',
      params: {
        boundarySource: 'stock', geometryId: '__stock__', loopIds: [],
        stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
        pattern: 'linear', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
        passExtension: 5, chipThinning: false,
        bothSidesPerLevel: false, floorStockToLeave: 0, finishPass: false,
        entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0,
        keepToolDown: true, maxStayDownDistance: Infinity, extendBeforeRetract: false,
        transition: 'smooth', tolerance: 0.01,
      },
      heights: ENGINE_HEIGHTS, passes: { ...ENGINE_PASSES, stepover: 4 }, linking: ENGINE_LINKING,
      tool: ENGINE_TOOL, loops: [rectLoop(100, 100, 60, 30)], wcsOrigin: { x: 0, y: 0, z: 0 },
    }
    expectLoads('wo1285-face', buildFaceToolpath(payload), loadMoves, true)
  })

  // MEASURED, not assumed, two facts about the 2D adaptive engine on a closed
  // rectangular pocket (40 x 30, O6, 1 mm lead radii, wall finish on and off):
  //   1. it emits NO arc today. The WO-449 gated connection supersedes the
  //      configured lead-in arc and the lead-out resolves to nothing on a lap
  //      that closes on itself (engine-index.test.ts pins the same stream; the
  //      only adaptive test that sees an arc mocks the feature result to get one).
  //   2. WO-1286 resolves its feed-less fast_traverse and finish roles at this
  //      machine boundary, from the operation/tool/machine feed table. The
  //      engine still invents no numeric feed.
  function adaptivePayload(wallFinish: boolean): ACWorkerPayload {
    return {
      opId: 'op1', setupId: 's1',
      params: {
        geometryId: 'g1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
        stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
        helixDiameter: 5, tolerance: 0.02, wallFinish,
      } as ACParams,
      heights: ENGINE_HEIGHTS, passes: { ...ENGINE_PASSES, stepover: 1.2, stockToLeave: 0.5 },
      linking: { ...ENGINE_LINKING, entryType: 'ramp_helical', rampLength: 10, leadInRadius: 1, leadOutRadius: 1 },
      tool: ENGINE_TOOL, loops: [rectLoop(100, 100, 40, 30)], wcsOrigin: { x: 0, y: 0, z: 0 },
    }
  }

  for (const wallFinish of [false, true]) {
    it(`WO-1286: a 2D ADAPTIVE${wallFinish ? ' with a wall finish' : ''} loads after machine-side role feed resolution and emits no arc`, async () => {
      await ensureEngineClipperReady()
      const adaptiveSetup = setup()
      adaptiveSetup.operations = [makeOp({
        id: 'op1',
        name: 'Adaptive',
        type: 'adaptive_clearing_2d',
        toolId: ENGINE_TOOL.id,
      })]
      applyProject({ setups: [adaptiveSetup], toolLibrary: [ENGINE_TOOL] })
      const { loadMoves } = afterAGoodLoad()
      const moves = await buildAdaptiveClearingToolpath(adaptivePayload(wallFinish))
      expect(moves.length).toBeGreaterThan(100)
      expect(moves.some((m) => m.role === 'fast_traverse' && m.feed === undefined)).toBe(true)
      expect(moves.some((m) => m.role === 'finish')).toBe(wallFinish)
      expect(moves.some((m) => m.type === 'arc_cw' || m.type === 'arc_ccw'), 'no lead arc resolves on a closed lap').toBe(false)
      const result = loadGeometryProgram('wo1285-adaptive', moves, TRACE)
      expect(result.ok, result.reason ?? 'refused without a reason').toBe(true)
      expect(loadMoves).toHaveBeenCalled()
      const staged = loadMoves.mock.calls.at(-1)?.[0] as QueuedMove[]
      const stagedMotion = staged.filter(
        (move): move is Extract<QueuedMove, { kind: 'line' | 'arc' }> =>
          move.kind === 'line' || move.kind === 'arc',
      )
      expect(staged).toHaveLength(moves.length)
      expect(stagedMotion).toHaveLength(staged.length)
      expect(stagedMotion.every((move) => move.feedMmMin > 0)).toBe(true)
      expect(stagedMotion.filter((move) => move.feedMmMin === machine().rapidRate).length)
        .toBeGreaterThan(0)
    }, 120_000)
  }

  it('a machine with no resolvable rapid rate is refused BY NAME - no feed is invented', async () => {
    await disconnect()
    applyProject({ machine: machine({ rapidRate: 0 }) })
    await connect('simulator')
    readMachineState()

    // Configure the no-rapid machine before this session starts. The product
    // correctly refuses every geometry program on that definition, so this is
    // a controller-side CONTROL payload, not application truth: it exists only
    // to prove the later product refusal leaves an existing queue untouched.
    const ctrl = getMachineController() as unknown as { loadMoves: (m: QueuedMove[]) => unknown }
    expect(ctrl.loadMoves([
      { id: 901, kind: 'line', to: { x: 1, y: 1, z: 1 }, feedMmMin: 300 },
    ])).toEqual({ ok: true, reason: null })
    expect(stagedOnController()).toBe(1)
    const loadMoves = vi.spyOn(ctrl, 'loadMoves')

    const result = loadGeometryProgram('wo1031-again', straightLineToolpath(), TRACE)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/declares no rapid rate/)
    expect(result.reason).toMatch(/never invented/)
    expectMachineUntouched(loadMoves, result.reason, 1)
  })

  it('a setup the project does not have is refused rather than resolved against a guess', () => {
    const { loadMoves } = afterAGoodLoad()

    const result = loadGeometryProgram('wo1031-again', straightLineToolpath(), {
      opId: 'op1',
      setupId: 'setup-that-was-deleted',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/setup-that-was-deleted/)
    expectMachineUntouched(loadMoves, result.reason)
  })

  it('an ACTION-step parts refusal keeps its own reason instead of inventing an over-cap refusal', () => {
    const { loadMoves } = afterAGoodLoad()
    // A program the straight-line builder cannot produce: motion plus one
    // spindle action. The controller would refuse it too ("action steps are not
    // wired yet") - the point is that it is never ASKED.
    const withAction: MachineProgram = {
      frame: 'work',
      units: 'mm',
      steps: [
        { id: 1, kind: 'line', to: { x: 0, y: 0, z: 20 }, feedMmMin: 5000, rapid: true },
        { id: 2, kind: 'spindle', direction: 'cw', rpm: 12_000 },
      ],
      index: {
        1: { opId: 'op1', setupId: 'setup1', moveOrdinal: 0 },
        2: { action: true },
      },
    }
    build.override = { ok: true, program: withAction }

    const result = loadGeometryProgram('wo1031-action', straightLineToolpath(), TRACE)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe(
      'This program contains action steps; action steps are not wired for program parts yet.',
    )
    expect(result.reason).not.toMatch(/board can only hold|continuous cutting stretch/)
    expectMachineUntouched(loadMoves, result.reason)
  })

  it('refuses a load while a job is running, and changes nothing at all', async () => {
    expect(loadTheStraightLine().ok).toBe(true)
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(60)
    const ctrl = getMachineController()
    expect(ctrl.hasActiveJob()).toBe(true)
    const readinessBefore = useMachineControl.getState().programReadiness
    const loadMoves = vi.spyOn(
      ctrl as unknown as { loadMoves: (m: QueuedMove[]) => unknown },
      'loadMoves',
    )

    const result = loadGeometryProgram('wo1031-again', straightLineToolpath(), TRACE)

    expect(result).toEqual({
      ok: false,
      reason: 'The program is still running - Feed Hold, then Stop, before loading another.',
    })
    // The run is untouched: still executing, still staged, still described - an
    // unstage here would have emptied the queue under a moving machine, and
    // even readiness is left alone because the running program's own truth is
    // what it is currently telling the operator.
    expect(loadMoves).not.toHaveBeenCalled()
    expect(ctrl.hasActiveJob()).toBe(true)
    expect(useMachineControl.getState().programReadiness).toEqual(readinessBefore)
    loadMoves.mockRestore()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(ctrl.status().machinePos).toEqual({ x: 50, y: 40, z: -1 })
  })
})

// THE CROSS-CONTROLLER CLASS, CLOSED IN BOTH LAYERS.
//
// Attempts 1-3 each kept an app-side "a geometry program is staged" flag, and
// each audit round found a new way for that single global to disagree with the
// board across a connect/disconnect/swap - a Cycle Start armed against a
// controller that never received anything. Deleting the flag closed the app's
// half: the authority to start lives with the CONTROLLER THAT WOULD EXECUTE.
//
// The controller's half is only as strong as the backend's own gate, and the
// two backends differ: `SimulatedController.startJob()` refuses with an empty
// queue, `UccncController.startJob()` has no such check at all. So neither
// layer is trusted alone here. These tests assert BOTH - that the app stopped
// claiming a program the live controller does not hold, AND that the
// controller underneath starts nothing - and they assert the second one on the
// wire wherever a bridge is involved, because the app's own return value is an
// account of a refusal while an empty wire IS the refusal.
describe('WO-1031: a fresh controller after a reconnect holds nothing, and starts nothing', () => {
  it('a disconnect and reconnect leaves a controller that holds nothing, and it refuses', async () => {
    await connect('simulator')
    readMachineState()
    expect(loadTheStraightLine().ok).toBe(true)
    const staged = getMachineController()
    expect(staged.programProgress?.().total).toBe(4)

    await disconnect()
    await connect('simulator')
    readMachineState()

    // A DIFFERENT controller object, which never received the program.
    const fresh = getMachineController()
    expect(fresh).not.toBe(staged)
    expect(fresh.programProgress?.().total).toBe(0)

    // BOTH LAYERS, ASSERTED SEPARATELY. The app no longer carries the previous
    // session's account across the boundary (WO-1031 audit round 5): it re-read
    // this controller, which holds nothing, so readiness and the job phase both
    // say so and the operator verdict cannot derive a start. AND the simulator's
    // own `startJob` gate refuses underneath that. Neither is trusted alone -
    // `UccncController.startJob` has no such gate, which is exactly why the app
    // layer must stop claiming a program is staged.
    expect(useMachineControl.getState().job.phase).toBe('empty')
    expect(useMachineControl.getState().job.totalLines).toBe(0)
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)

    const restingAt = fresh.status().machinePos
    expect(fresh.startJob()).toBe(false)
    expect(await executeOperatorCycleStart()).toBe(false)
    expect(fresh.hasActiveJob()).toBe(false)
    // ...and it is not merely "refused synchronously": nothing moves afterwards
    // either, which is the assertion a retained program would fail.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fresh.hasActiveJob()).toBe(false)
    expect(fresh.status().machinePos).toEqual(restingAt)
  })

  it('a reconnect onto a DIFFERENT backend cannot inherit the simulator load', async () => {
    await connect('simulator')
    readMachineState()
    expect(loadTheStraightLine().ok).toBe(true)

    await disconnect()
    // The bridge in this file has no `machineProgram` capability, so a
    // surviving app-side claim would point at a board that refuses programs
    // outright. There is no such claim to survive.
    await connect('bridge')

    expect(getMachineController().programProgress?.().total).toBe(0)
    expect(await executeOperatorCycleStart()).toBe(false)
    expect(getMachineController().hasActiveJob()).toBe(false)
  })
})

// THE SAME DOOR ON THE BOARD IT WAS WRITTEN FOR - a bridge that DOES declare
// the program route. The protocol is the contract (WO-422 posture), so this
// asserts the frames on the wire rather than the app's account of them.
describe('WO-1031: the program reaches the bridge as one staging frame', () => {
  beforeEach(() => {
    bridgeCapabilities = PROGRAM_BRIDGE_CAPABILITIES
  })

  it('stages four moves in the work frame, and a replacement load overwrites them', async () => {
    await connect('bridge')
    const socket = bridgeSockets[bridgeSockets.length - 1]
    expect(session.controllerCapabilities()?.machineProgram).toBe(true)

    expect(loadTheStraightLine()).toEqual({ ok: true, reason: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.loadMovesFrames()).toHaveLength(1)
    expect(socket.loadMovesFrames()[0].moves).toHaveLength(4)
    expect(socket.loadMovesFrames()[0].frame).toBe('work')

    // The controller's staged queue is ITS to manage: a second load overwrites
    // the first (`Machine.LoadMoves`), so the app sends one frame and no
    // separate disarm it could get out of order.
    expect(loadGeometryProgram('wo1031-shorter', straightLineToolpath().slice(0, 2), TRACE).ok)
      .toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.loadMovesFrames()).toHaveLength(2)
    expect(socket.loadMovesFrames()[1].moves).toHaveLength(2)
  })
})

// AUDIT ROUND 5 - "AN UPDATED BRIDGE RECONNECT CAN SEND CYCLE START WITHOUT A
// FRESH LOAD". The half of that finding which is TRUE is the half about the
// backend: `UccncController.startJob()` (uccncController.ts:969) checks only
// that motion is allowed and then sends the frame - unlike
// `SimulatedController.startJob()`, it has NO staged-program gate. So the app
// may not lean on "the fresh controller refuses by its own gate" the way
// attempt 4's comment claimed; on the bridge there is no such gate.
//
// The half that does NOT hold is the route: a DISCONNECT already clears the
// app's claim, in the store itself (`machineControlStore.setConnection`, on
// `main`: `phase === 'disconnected'` resets `job` to empty and readiness to
// "Reconnect and reload the program."). The first test pins that, because a
// property nobody asserts is a property that quietly disappears.
//
// The hole the finding was pointing at is REAL one step over: a backend SWAP
// never publishes `disconnected` at all, so nothing cleared the app's claim,
// and the fresh `UccncController` - with no gate of its own - would be sent a
// start frame for a program it never received. The second test pins that, on
// the wire, where the app's own return value cannot flatter it.
describe('WO-1031: an UPDATED bridge cannot be started for a program it never received', () => {
  beforeEach(() => {
    bridgeCapabilities = PROGRAM_BRIDGE_CAPABILITIES
  })

  it('a disconnect clears the app claim, so the reconnected session starts nothing', async () => {
    await connect('bridge')
    const first = bridgeSockets[bridgeSockets.length - 1]
    first.emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)

    expect(loadTheStraightLine()).toEqual({ ok: true, reason: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(first.loadMovesFrames()).toHaveLength(1)
    // THE CONTROL CASE: in this state the product's own CYCLE START is live and
    // WOULD start this program. Without it, everything below could pass for an
    // unrelated reason - a machine that was never idle, a verdict that never
    // reaches `start` - and prove nothing at all.
    expect(useMachineControl.getState().job.phase).toBe('ready')
    expect(currentOperatorTransport().action).toBe('start')

    await disconnect()
    await connect('bridge')
    const second = bridgeSockets[bridgeSockets.length - 1]
    expect(second).not.toBe(first)
    second.emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    expect(session.controllerCapabilities()?.machineProgram).toBe(true)
    expect(useMachineControl.getState().machineState).toBe('idle')

    expect(getMachineController().programProgress?.().total).toBe(0)
    expect(useMachineControl.getState().job.phase).toBe('empty')
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)
    expect(await executeOperatorCycleStart()).toBe(false)
    // NO START FRAME REACHED THE BRIDGE. The app's `false` is an account of a
    // refusal; an empty wire IS the refusal (`Bridge.cs` -> `Machine.StartJob`
    // is the only thing that begins motion on the board).
    expect(second.frames('startJob')).toEqual([])
    expect(second.loadMovesFrames()).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(second.frames('startJob')).toEqual([])
    expect(getMachineController().hasActiveJob()).toBe(false)
  })

  it('a backend SWAP publishes no disconnect, and still starts nothing on the new board', async () => {
    await connect('simulator')
    readMachineState()
    expect(loadTheStraightLine()).toEqual({ ok: true, reason: null })
    expect(useMachineControl.getState().job.phase).toBe('ready')
    expect(currentOperatorTransport().action).toBe('start')

    // STRAIGHT ONTO THE BRIDGE, with no disconnect in between - so the store's
    // own `phase === 'disconnected'` reset never runs and the app's "a program
    // is ready" claim from the SIMULATOR session is still standing when a
    // brand-new UccncController becomes the live backend. This bridge declares
    // `machineProgram`, so it is a board the app believes it can start, and its
    // `startJob` has no staged-program gate to catch the mistake.
    await connect('bridge')
    const socket = bridgeSockets[bridgeSockets.length - 1]
    socket.emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    expect(session.controllerCapabilities()?.machineProgram).toBe(true)
    expect(useMachineControl.getState().machineState).toBe('idle')

    // The app re-read the controller at the boundary instead of carrying the
    // previous session's answer forward, so it claims exactly what THIS
    // controller holds: nothing.
    expect(getMachineController().programProgress?.().total).toBe(0)
    expect(useMachineControl.getState().job.phase).toBe('empty')
    expect(useMachineControl.getState().job.totalLines).toBe(0)
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)

    expect(currentOperatorTransport().action).not.toBe('start')
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)
    expect(await executeOperatorCycleStart()).toBe(false)
    // The assertion that fails without the boundary re-read: a start frame for
    // a program this bridge never received.
    expect(socket.frames('startJob')).toEqual([])
    // ...and nothing was staged behind the operator's back to make the refusal
    // safe. The boundary sends NOTHING; it only stops the app lying.
    expect(socket.loadMovesFrames()).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket.frames('startJob')).toEqual([])
    expect(getMachineController().hasActiveJob()).toBe(false)
  })

  it('a load in the NEW session is what makes CYCLE START live again - the operator reloads', async () => {
    await connect('simulator')
    readMachineState()
    expect(loadTheStraightLine().ok).toBe(true)

    await connect('bridge')
    const socket = bridgeSockets[bridgeSockets.length - 1]
    socket.emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)

    // The boundary clear is not a dead end - it names the way out ("load the
    // program again"), and taking it works. A guard that cannot be satisfied is
    // just a broken product.
    expect(loadTheStraightLine()).toEqual({ ok: true, reason: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.loadMovesFrames()).toHaveLength(1)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(currentOperatorTransport().action).toBe('start')
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(socket.frames('startJob')).toHaveLength(1)
  })
})

// AUDIT ROUND 6 - "AN OLD-BRIDGE BACKEND SWAP STILL INHERITS THE SIMULATOR'S
// READY GEOMETRY JOB", and it is right.
//
// Round 5's boundary re-read asked the destination controller for its
// capability first and returned early when it did not declare
// `machineProgram`. An UN-UPDATED bridge is exactly such a destination - its
// `hello` carries no `machineProgram` at all - so on a SWAP (which publishes no
// `disconnected`, so the store's own reset never runs) the simulator session's
// `job.phase: 'ready'` and ready readiness were still standing over a brand-new
// `UccncController`. `deriveOperatorTransport` still derived `start` from them,
// and `UccncController.startJob()` (uccncController.ts:969) has no
// staged-program gate: it checks motion is allowed and sends the frame. A start
// frame for a program that board never received.
//
// THE CAPABILITY WAS THE WRONG QUESTION. What makes the app's claim stale is
// that the CONTROLLER CHANGED, not what the new controller can do - and a
// controller with no program route holds no program by definition, which is the
// strongest possible reason to stop claiming it holds one. So the boundary
// re-read now runs on every backend, and this pins the case that was open.
describe('WO-1031: an UN-UPDATED bridge cannot be started for a program it never received', () => {
  it('a backend swap onto a bridge with NO program route starts nothing', async () => {
    await connect('simulator')
    readMachineState()
    expect(loadTheStraightLine()).toEqual({ ok: true, reason: null })
    // THE CONTROL CASE: the product's own CYCLE START is live here and would
    // start this program. Without it the assertions below could pass for an
    // unrelated reason and prove nothing.
    expect(useMachineControl.getState().job.phase).toBe('ready')
    expect(currentOperatorTransport().action).toBe('start')

    // STRAIGHT ONTO THE OLD BRIDGE - no disconnect, so the store's
    // `phase === 'disconnected'` reset never runs; and no `machineProgram`, so
    // this is the destination round 5's capability check skipped.
    await connect('bridge')
    const socket = bridgeSockets[bridgeSockets.length - 1]
    socket.emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    expect(session.controllerCapabilities()?.machineProgram).toBeFalsy()
    expect(useMachineControl.getState().machineState).toBe('idle')

    // The app re-read THIS controller, which holds nothing, and says so.
    expect(getMachineController().programProgress?.().total).toBe(0)
    expect(useMachineControl.getState().job.phase).toBe('empty')
    expect(useMachineControl.getState().job.totalLines).toBe(0)
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)

    expect(currentOperatorTransport().action).not.toBe('start')
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)
    expect(await executeOperatorCycleStart()).toBe(false)
    // THE ASSERTION THAT FAILS WITHOUT THE FIX: no start frame on the wire.
    // `UccncController.startJob` has no gate of its own, so the app's `false`
    // is only an account of a refusal - an empty wire IS the refusal.
    expect(socket.frames('startJob')).toEqual([])
    // ...and nothing was staged behind the operator's back to make the refusal
    // safe. The boundary sends NOTHING; it only stops the app lying.
    expect(socket.loadMovesFrames()).toEqual([])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket.frames('startJob')).toEqual([])
    expect(getMachineController().hasActiveJob()).toBe(false)
  })

  it('the geometry load in the new session is still refused by name - the swap changed nothing else', async () => {
    await connect('simulator')
    readMachineState()
    expect(loadTheStraightLine().ok).toBe(true)

    await connect('bridge')
    const socket = bridgeSockets[bridgeSockets.length - 1]
    socket.emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)

    // The way out on THIS board is not "reload" - the board cannot run a
    // toolpath program at all, and it says which sentence applies.
    const result = loadTheStraightLine()
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/cannot run a toolpath program/)
    expect(socket.loadMovesFrames()).toEqual([])
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)
  })
})

describe('WO-1031: a geometry backend that cannot run programs yet', () => {
  beforeEach(async () => {
    await connect('bridge')
  })

  it('is refused before anything is sent, and the TEXT refusal is untouched', () => {
    expect(session.controllerCapabilities()?.machineProgram).toBeFalsy()
    expect(session.controllerCapabilities()?.gcodeText).toBe(false)
    const socket = bridgeSockets[bridgeSockets.length - 1]

    const result = loadTheStraightLine()

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/cannot run a toolpath program/)
    // Nothing reached the wire at all - not a staging frame, not a disarm.
    expect(socket.loadMovesFrames()).toEqual([])
    expect(getMachineController().programProgress?.().total).toBe(0)

    // A geometry backend refuses G-code TEXT at load time, in one actionable
    // sentence, because the setup is the runnable artifact on this controller.
    loadMachineProgram('wo1031.nc', TEXT_PROGRAM)
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: false,
      reason: TEXT_ON_GEOMETRY_BACKEND,
    })
  })
})

// The two doors do not reach into each other's state. `loadMachineProgram` is
// byte-unchanged by this order, and this pins the half a diff cannot: that its
// BEHAVIOUR is identical whether or not a geometry program was loaded first.
describe('WO-1031: the text door behaves the same with a geometry program loaded', () => {
  beforeEach(async () => {
    await connect('simulator')
    readMachineState()
  })

  it('loads text exactly as it does on a session that never saw this door', () => {
    loadMachineProgram('wo1031.nc', TEXT_PROGRAM)
    const withoutGeometry = useMachineControl.getState().programReadiness

    expect(loadTheStraightLine().ok).toBe(true)
    loadMachineProgram('wo1031.nc', TEXT_PROGRAM)

    expect(useMachineControl.getState().programReadiness).toEqual(withoutGeometry)
    expect(useMachineControl.getState().job.name).toBe('wo1031.nc')
    expect(useMachineControl.getState().programText).toBe(TEXT_PROGRAM)
  })
})

// AUDIT ROUND 7. A load through EITHER door makes that program THE session's
// program, and the other door's identity is not left standing behind it.
//
// The hazard the audit named: `loadGeometryProgram` used to update only the
// controller's queue, the job counters and readiness, leaving the store's
// `programText` and `job.name` describing the TEXT program that was loaded
// before it. `deriveReArm` reads `programText`, so it still offered an ENABLED
// "Re-arm from start", and `armProgramFromTop` follows that offer straight into
// `loadMachineProgram(job.name, programText)` - which replaces the staged
// geometry program with the previous text one. A control labelled "re-arm THIS
// program" arming a DIFFERENT one is the split-authority defect this order has
// been chased for, wearing the text door's clothes.
//
// The cure is identity, not a new gate: a successful geometry load calls
// `setProgram(name, null)`, so the session says what the controller holds. Every
// text-only path (`armProgramFromTop`, `armRunFromLine`, `stepBack`,
// `prepareMaterialFitTrace`) already refuses on a null `programText`, so one
// honest statement closes all of them at once instead of four new checks.
describe('WO-1031: a geometry load ends the previous text program, it does not shadow it', () => {
  beforeEach(async () => {
    await connect('simulator')
    readMachineState()
  })

  it('leaves no re-armable text program behind - the stale offer is gone', async () => {
    // The state the hazard needs: a real text program, really armed, with the
    // re-arm control really offered and enabled.
    loadMachineProgram('previous.nc', TEXT_PROGRAM)
    expect(useMachineControl.getState().programText).toBe(TEXT_PROGRAM)
    expect(currentOperatorTransport().reArm).toMatchObject({ offered: true, enabled: true })

    expect(loadTheStraightLine()).toEqual({ ok: true, reason: null })

    // THE SESSION NOW DESCRIBES WHAT THE CONTROLLER HOLDS, not what it held.
    expect(useMachineControl.getState().job.name).toBe('wo1031')
    expect(useMachineControl.getState().programText).toBeNull()
    expect(useMachineControl.getState().job.toolChanges).toEqual([])

    // So the offer is withdrawn rather than left pointing at the wrong program.
    expect(currentOperatorTransport().reArm).toMatchObject({ offered: false, enabled: false })
    // ...and the action behind it refuses even when called directly, so this
    // holds for a caller that never read the verdict.
    expect(await armProgramFromTop()).toEqual({ ok: false, reason: RE_ARM_REFUSAL.noProgram })

    // The only measure that matters: the CONTROLLER still holds the geometry
    // program. A refused re-arm that had gone through would leave the
    // simulator holding the 3-line text program instead of the 4 moves.
    expect(stagedOnController()).toBe(4)
    expect(useMachineControl.getState().job.totalLines).toBe(4)
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: true,
      reason: 'Toolpath program "wo1031" loaded: 4 moves, runs in G54.',
    })
  })

  it('and CYCLE START begins the GEOMETRY program - the machine goes where the toolpath goes', async () => {
    loadMachineProgram('previous.nc', TEXT_PROGRAM)
    expect(loadTheStraightLine()).toEqual({ ok: true, reason: null })

    // Withdrawing the re-arm offer did not cost the load its Cycle Start.
    expect(currentOperatorTransport()).toMatchObject({ action: 'start', cycleStartEnabled: true })
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)

    // The straight line's last move in WORK coordinates. The text program ends
    // at (0,0,5), so this tells the two programs apart by where the machine is
    // standing rather than by what the app says it ran. WO-2004: the simulator
    // holds G54 (10,5,2) here and, like the bridge, stages the program's work
    // coordinates through it - so the work position is the toolpath's, and the
    // machine stands at work + G54.
    expect(getMachineController().status().workPos).toEqual({ x: 50, y: 40, z: -1 })
    expect(getMachineController().status().machinePos).toEqual({ x: 60, y: 45, z: 1 })
  })

  it('a REFUSED geometry load leaves the text program exactly as it was - identity moves only on success', () => {
    loadMachineProgram('previous.nc', TEXT_PROGRAM)
    const stagedText = stagedOnController()
    const before = useMachineControl.getState()

    // A FULL CIRCLE: the builder refuses it by name, so nothing was sent and
    // nothing is replaced. This test used to use a HELICAL arc, which WO-1337
    // now stages - the proof is about what a refusal does to the loaded
    // program, so it moved to a refusal the builder still makes.
    const refused = loadGeometryProgram('wo1031-arc', toolpathWithFullCircleArc(), TRACE)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toMatch(/full circle/)

    const after = useMachineControl.getState()
    expect(after.programText).toBe(TEXT_PROGRAM)
    expect(after.job.name).toBe('previous.nc')
    expect(stagedOnController()).toBe(stagedText)
    expect(after.programContext).toBe(before.programContext)
    // The operator's way back to the text program is still open, because that
    // is still the program the controller is holding.
    expect(currentOperatorTransport().reArm).toMatchObject({ offered: true, enabled: true })
  })

  it('and the CONTROLLER refusing is a refusal too - identity waits for the board to accept', () => {
    loadMachineProgram('previous.nc', TEXT_PROGRAM)
    const stagedText = stagedOnController()

    // A program the door's own checks pass - every step is a `line` - but the
    // CONTROLLER refuses: two steps share an id, which `validateMachineProgram`
    // rejects inside `loadProgram`. This is the only refusal that arrives AFTER
    // the door has finished validating, so it is the one case that can tell
    // "identity moves when the board accepts" apart from "identity moves when
    // the door is happy".
    const duplicateIds: MachineProgram = {
      frame: 'work',
      units: 'mm',
      steps: [
        { id: 1, kind: 'line', to: { x: 0, y: 0, z: 20 }, feedMmMin: 5000, rapid: true },
        { id: 1, kind: 'line', to: { x: 0, y: 0, z: 1 }, feedMmMin: 300 },
      ],
      index: { 1: { opId: 'op1', setupId: 'setup1', moveOrdinal: 0 } },
    }
    build.override = { ok: true, program: duplicateIds }

    const result = loadGeometryProgram('wo1031-dupe', straightLineToolpath(), TRACE)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/used more than once/)
    // Nothing was staged, so nothing about the previous program changed either.
    expect(stagedOnController()).toBe(stagedText)
    expect(useMachineControl.getState().programText).toBe(TEXT_PROGRAM)
    expect(useMachineControl.getState().job.name).toBe('previous.nc')
    expect(currentOperatorTransport().reArm).toMatchObject({ offered: true, enabled: true })
  })
})

// ---------------------------------------------------------------------------
// A FINISHED GEOMETRY RUN - THE 2026-08-26 22:17Z AUDIT FINDING.
//
// A run that ENDS is the one state where the app had a way out to offer and
// named the wrong one. `deriveCycleVerdict`'s complete/failed sentences named
// the re-arm control unconditionally (WO-082 put it there, because they used to
// name a way out with no way to take it), while `deriveReArm` HIDES that control
// for a program with no text - which is every toolpath program, because a
// toolpath genuinely has none. So an operator whose geometry run finished was
// told to press a button that is not on the screen: WO-082's dead end, re-opened
// from the geometry side by this order's own door.
//
// These tests read `currentOperatorTransport()` after a real run on the
// simulator rather than deriving a verdict from a hand-built input, so what is
// asserted is what the operator's panel would actually show.
// ---------------------------------------------------------------------------
describe('WO-1031: a finished geometry run names a way out that exists', () => {
  beforeEach(async () => {
    await connect('simulator')
    readMachineState()
  })

  it('a COMPLETED geometry run withdraws the re-arm offer, and names no hidden control', async () => {
    expect(loadTheStraightLine().ok).toBe(true)
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(useMachineControl.getState().job.phase).toBe('complete')

    const state = currentOperatorTransport()
    // The control is genuinely not rendered - ControlTransportBar draws it only
    // on `offered` - so no sentence may send the operator to it.
    expect(state.reArm.offered).toBe(false)
    expect(state.nextAction).not.toContain(RE_ARM_LABEL)
    expect(state.cycleStartDetail).not.toContain(RE_ARM_LABEL)
    // What it says instead is the way out that DOES exist for a toolpath.
    expect(state.nextAction).toBe(
      'Cycle complete. A toolpath program has no re-arm control - load the toolpath again to run it.',
    )
    expect(state.cycleStartDetail).toBe('No program is armed - load the toolpath again.')
    expect(state.cycleStartEnabled).toBe(false)
  })

  it('a FAILED geometry run says the same - a cut-short run is no more re-armable', async () => {
    expect(loadTheStraightLine().ok).toBe(true)
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(60)
    expect(getMachineController().hasActiveJob()).toBe(true)

    // A soft reset mid-run: the simulator abandons the program (phase 'failed')
    // and returns to idle, which is the one failure route that does not park the
    // machine in alarm - alarm has its own sentence and never reaches this one.
    getMachineController().reset()
    await vi.advanceTimersByTimeAsync(60)
    expect(useMachineControl.getState().job.phase).toBe('failed')
    expect(useMachineControl.getState().machineState).toBe('idle')

    const state = currentOperatorTransport()
    expect(state.reArm.offered).toBe(false)
    expect(state.nextAction).not.toContain(RE_ARM_LABEL)
    expect(state.cycleStartDetail).not.toContain(RE_ARM_LABEL)
    expect(state.nextAction).toBe(
      'The cycle failed. Resolve the error first. A toolpath program has no re-arm control - '
      + 'load the toolpath again to run it.',
    )
    expect(state.cycleStartDetail).toBe('No program is armed - load the toolpath again.')
    expect(state.cycleStartEnabled).toBe(false)
  })

  it('and the way out it names is REAL - loading the toolpath again arms CYCLE START', async () => {
    expect(loadTheStraightLine().ok).toBe(true)
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)

    // The sentence's instruction, followed literally. A message that names a
    // way out is only honest if taking it works.
    expect(loadTheStraightLine().ok).toBe(true)
    expect(currentOperatorTransport()).toMatchObject({ action: 'start', cycleStartEnabled: true })
    expect(stagedOnController()).toBe(4)
  })

  it('the TEXT path is untouched - it still names the control that IS on the screen', async () => {
    loadMachineProgram('previous.nc', TEXT_PROGRAM)
    expect(currentOperatorTransport()).toMatchObject({ action: 'start', cycleStartEnabled: true })
    expect(await executeOperatorCycleStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(useMachineControl.getState().job.phase).toBe('complete')
    const state = currentOperatorTransport()
    // Here the control really is rendered, so naming it is the honest sentence
    // and WO-082's fix stands exactly as it was.
    expect(state.reArm.offered).toBe(true)
    // WO-2686: and CYCLE START, also on the screen, runs it again from line 1.
    expect(state).toMatchObject({ action: 'arm-start', cycleStartEnabled: true })
    expect(state.nextAction).toBe('Cycle complete. CYCLE START runs the program from line 1.')
    expect(state.cycleStartDetail).toBe('Arm the program from line 1 and run it.')
  })
})
