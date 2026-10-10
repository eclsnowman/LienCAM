// @vitest-environment jsdom
//
// WO-1275 - MOTION BEGINS BEFORE THE SPINDLE IS AT SPEED.
//
// MEASURED, NOT INFERRED. The first program this product ever ran with its own
// spindle (`src/tests/evidence/SHAKEDOWN-2026-09-07/spindle/`):
//
//     t+0s              CYCLE START
//     t+2s    1969 rpm   the chip already reads "Running" - the machine moves
//     t+17s  18000 rpm   "up to speed"
//
// The program's third emitted move was `G1 X6.379 Z-0.243 F1500` - a CUT. So a
// 9.52 mm cutter entered the work at about a ninth of the speed its operation
// asked for. Every ingredient to notice existed: `upToSpeedToleranceRpm` is a
// validated definition field, `vfdUpToSpeed` computes the answer, the panel
// renders "up to speed" / "ramping". Nothing consulted it.
//
// WHAT IS PROVEN HERE, THROUGH THE APPLICATION'S OWN ENTRY POINTS (rule 6):
// the ProgramPanel is RENDERED and its Load menu is CLICKED, the canonical
// `executeOperatorCycleStart` / `executeOperatorFeedHold` /
// `executeOperatorStopReset` / `triggerEmergencyStop` doors are the only way
// anything starts or stops, and the verdict is always what reached the BOARD -
// the `startJob` frame on the fake bridge socket.
//
//   - a cut does NOT begin while the inverter reports below the commanded
//     speed, and DOES begin on the `vfd` push that reports arrival,
//   - the program's own APPROACH is not gated: it is staged separately and
//     RUNS while the spindle is still ramping, which is the whole of clause 3
//     ("the spindle should start before the positioning moves, so it spins up
//     DURING the approach"). The verdict is the `loadMoves` payload itself -
//     the board is holding rapids and no cut while the spindle comes up,
//   - Stop/Reset, Feed Hold and E-STOP all work while the gate is waiting, and
//     the held motion is DROPPED rather than queued behind them - proven by
//     letting the spindle reach speed afterwards and finding no `startJob`,
//   - positioning is NOT gated: a jog goes to the wire while a cut is held,
//   - a machine whose bridge reports no inverter link still runs programs,
//   - the check is re-run on every release, so a second operation at a
//     different RPM re-arms it,
//   - an inverter that never reports arrival times out with the spindle
//     STOPPED and nothing cut.
//
// NOT CLAIMED: hardware. This order's Tier 3 evidence is the machine seat
// running a TWO-SPEED program on the real AXBB-E; nothing here touches it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
  BridgeVfdFrameObserver,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import type { MachineConfig, Operation, Project, Setup, ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
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

/** Operator's AXBB-E: no G-code interpreter, geometry programs, and a spindle that
 *  lives on a separate Modbus link. `spindleCommands` is DERIVED by the backend
 *  from `hello.vfd.present`, so whatever is claimed here is ignored. */
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

/** Which inverter the bridge declares in its hello. `null` is "started without
 *  --vfd"; the unknown name is a link this build cannot decode - the case that
 *  decides what a NULL up-to-speed answer means. */
let helloVfd: { present: boolean; verified: boolean; name: string | null } | null =
  { present: true, verified: false, name: 'Huanyang GT' }

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  frames(kind: string): BridgeCallMessage[]
}

const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null
    private readonly fakeVfdObserver: BridgeVfdFrameObserver | null

    constructor(url?: string, machineId?: string | null, onVfdFrame?: BridgeVfdFrameObserver | null) {
      super(url, machineId, onVfdFrame)
      this.fakeVfdObserver = onVfdFrame ?? null
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1275-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
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
          ...(helloVfd ? { vfd: helloVfd } : {}),
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

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
      if (message.t === 'vfd') this.fakeVfdObserver?.(message.v)
    }

    frames(kind: string): BridgeCallMessage[] {
      return this.sent.filter((m) => m.m === kind)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const {
  executeOperatorCycleStart,
  executeOperatorFeedHold,
  executeOperatorStopReset,
} = await import('../../lib/machine/operatorTransport')
const {
  SPINDLE_SPEED_GATE,
  SPINDLE_UP_TO_SPEED_TIMEOUT_MS,
  spindleSpeedVerdict,
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  jogToSafeZ,
  spindleSpeedWaitRpm,
  triggerEmergencyStop,
} = await import('../../lib/machine/machineSession')

function machine(): MachineConfig {
  return makeMachine({
    id: 'wo1275-machine',
    name: 'WO-1275 Test Machine',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    // The machine record's half of the spindle declaration; the live bridge's
    // half is `hello.vfd`. A program spindle intent needs BOTH.
    spindleLinkDefinition: {} as MachineConfig['spindleLinkDefinition'],
  })
}

/** A rapid to the clearance plane, then three feeds. Move 2 is the PLUNGE -
 *  the move this whole order exists to keep out of the work below speed. */
function straightLineToolpath(): ToolpathMove[] {
  return [
    { type: 'rapid', x: 10, y: 5, z: 12 },
    { type: 'feed', x: 10, y: 5, z: 1, feed: 300 },
    { type: 'feed', x: 60, y: 5, z: 1, feed: 900 },
    { type: 'feed', x: 60, y: 45, z: 1, feed: 900 },
  ]
}

const TOOL_12K = makeTool({ id: 't1', toolNumber: 1 })
/** A second tool whose operation asks for a DIFFERENT speed - clause 4's
 *  "a spindle speed change between operations". */
const TOOL_18K = makeTool({
  id: 't2',
  toolNumber: 2,
  feedsAndSpeeds: {
    default: {
      rpm: 18_000,
      feedRate: 2_000,
      plungeRate: 400,
      depthOfCut: 2,
      stepover: 3,
      coolant: 'flood',
    },
  },
})

/** `overrideRpm` is the operation's own "Override tool feeds & speeds" spindle
 *  speed - the field the machine seat's clause-4 fixture uses, and the one
 *  `resolveSpindle` prefers over the tool's own. */
function op(id: string, toolId: string, overrideRpm?: number): Operation {
  return makeOp({
    id,
    name: `Op ${id}`,
    type: 'contour_2d',
    toolId,
    status: 'ready',
    toolpathMoves: straightLineToolpath(),
    ...(overrideRpm === undefined ? {} : {
      feedrateOverride: {
        enabled: true,
        rpm: overrideRpm,
        feedRate: 2_000,
        plungeRate: 400,
        rampFeedrate: 800,
        leadInFeedrate: 800,
        leadOutFeedrate: 800,
        fastTraverseFeedrate: 3_000,
      },
    }),
  })
}

/** The same operation with a toolpath of its own - for the approach shapes
 *  this order cares about (several rapids before the plunge). */
function opWithMoves(id: string, toolId: string, moves: ToolpathMove[]): Operation {
  return { ...op(id, toolId), toolpathMoves: moves }
}

function setupWith(operations: Operation[]): Setup {
  return {
    id: 'setup1',
    name: 'Setup 1',
    wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 10, y: 5, z: 2 } }),
    stock: makeStock({ material: 'aluminum' }),
    operations,
    notes: '',
  }
}

const TOOLS = [TOOL_12K, TOOL_18K]

function applyProject(operations: Operation[]): void {
  const setup = setupWith(operations)
  const project = {
    ...useCamStore.getState().project,
    machine: machine(),
    setups: [setup],
    activeSetupId: 'setup1',
    toolLibrary: TOOLS,
  }
  for (const operation of setup.operations) {
    const tool = TOOLS.find((candidate) => candidate.id === operation.toolId) ?? TOOLS[0]
    stampGenerationCurrent(project, setup, operation, tool)
  }
  useCamStore.setState({ project, toolLibrary: TOOLS })
}

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

let originalProject: Project
let originalToolLibrary: ReturnType<typeof useCamStore.getState>['toolLibrary']

beforeEach(() => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  helloVfd = { present: true, verified: false, name: 'Huanyang GT' }
  originalProject = useCamStore.getState().project
  originalToolLibrary = useCamStore.getState().toolLibrary
  applyProject([op('op1', 't1')])
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
}

/** One `vfd` push. `actualRpm` is status word 2 at scale `raw.value` on the
 *  Huanyang GT, so this IS the shaft speed the inverter reports. */
function pushVfd(
  actualRpm: number,
  {
    running = true,
    lastStopReason = 'commanded',
  }: {
    running?: boolean
    lastStopReason?: 'none' | 'commanded' | 'serialTimeout' | 'clientGone' | 'closing' | 'refused'
  } = {},
): void {
  act(() => {
    socket().emit({
      t: 'vfd',
      v: {
        up: true,
        running,
        faulted: false,
        runStateWord: running ? 2 : 3,
        commandWord: running ? 1 : 5,
        setpointWord: 5_000,
        consecutiveFailures: 0,
        lastStopReason,
        lastError: null,
        statusWords: [45, 18, actualRpm, 0, 9],
        status: {},
        upToSpeed: null,
      },
    } as BridgeMessage)
  })
}

/** THE OPERATOR'S OWN GESTURE: the rendered Load menu. */
async function operatorLoadsTheSetup(): Promise<void> {
  render(<ProgramPanel />)
  act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-load-setup-item-setup1'))
    await Promise.resolve()
  })
}

function startJobFrames(): number {
  return socket().frames('startJob').length
}

/** EVERY door that releases staged motion to the board. Which one a given
 *  gesture takes is the transport's business (a paused controller job resumes,
 *  an idle one re-starts); this order's business is that ALL of them are
 *  gated, so the tests count them together. */
function motionReleaseFrames(): number {
  return socket().frames('startJob').length
    + socket().frames('resumeJob').length
    + socket().frames('cycleResume').length
    + socket().frames('stepJob').length
}

/** WHAT THE BOARD IS ACTUALLY HOLDING, load by load. `a.moves` is the
 *  `loadMoves` frame's own payload, so this is the staged list itself and not
 *  the app's opinion of it. */
function stagedLoads(): { rapid: boolean }[][] {
  return socket().frames('loadMoves').map(
    (m) => (m.a as { moves: { rapid?: true }[] }).moves.map((move) => ({ rapid: move.rapid === true })),
  )
}

/** Moves in a staged load that CUT - anything the toolpath did not declare a
 *  rapid. This is the count that must be zero while the spindle is ramping. */
function cuttingMoves(load: { rapid: boolean }[]): number {
  return load.filter((move) => !move.rapid).length
}

/** THE BOARD RUNNING THE APPROACH AND ARRIVING AT ITS END: the part starts,
 *  the buffer empties, the machine reports idle, and the bridge says the
 *  staged part is complete. That handoff is where the CUT is released - or
 *  held for the spindle. */
function approachRunsToItsEnd(): void {
  act(() => { socket().emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage) })
  act(() => {
    socket().emit({
      t: 'status',
      v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
    } as BridgeMessage)
  })
  act(() => { socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage) })
}

/** The last staged part finishing: the whole program is over. */
function programRunsToItsEnd(): void {
  act(() => {
    socket().emit({
      t: 'status',
      v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
    } as BridgeMessage)
  })
  act(() => { socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage) })
}

function commandedSpindleRpm(): number[] {
  // The bridge takes a setpoint WORD; the Huanyang GT's own calibration is
  // `set.rpm / 2.4`, so this reads the word back as the RPM asked for.
  return socket().frames('spindleOn').map((m) => (m.a as { setpointWord: number }).setpointWord * 2.4)
}

function consoleText(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

/** The inverter reporting a RAMP, the way the bridge really does: a frame
 *  every 500 ms of fake time. A silent link is a DIFFERENT test - the backend's
 *  own quiet-stop watchdog stops a spindle it has stopped hearing about, and
 *  that safety has nothing to do with this gate. */
async function rampSpindle(rpms: readonly number[]): Promise<void> {
  for (const rpm of rpms) {
    pushVfd(rpm)
    await vi.advanceTimersByTimeAsync(500)
  }
}

/** Load, press CYCLE START, and leave the inverter reporting `atRpm`. */
async function cycleStartWithSpindleAt(atRpm: number): Promise<boolean> {
  await operatorLoadsTheSetup()
  pushVfd(atRpm)
  return executeOperatorCycleStart()
}

describe('WO-1275: no cut begins below the commanded speed', () => {
  beforeEach(async () => { await connectBridge() })

  it('runs the approach at 2,000 RPM and holds the CUT until the frame that reports 12,000', async () => {
    // The shakedown's own numbers, in miniature: the spindle is turning, well
    // below the speed the operation asked for, and the board is loaded.
    expect(await cycleStartWithSpindleAt(1_969)).toBe(true)

    // THE SPINDLE WAS COMMANDED, AND THE APPROACH WENT WITH IT. The board is
    // holding ONE move - the toolpath's rapid to the clearance plane - and it
    // is running it while the inverter is still at 1,969 RPM. No cutting move
    // is anywhere near the machine.
    expect(commandedSpindleRpm()).toEqual([12_000])
    expect(stagedLoads()).toHaveLength(1)
    expect(stagedLoads()[0]).toHaveLength(1)
    expect(cuttingMoves(stagedLoads()[0])).toBe(0)
    expect(startJobFrames()).toBe(1)
    expect(spindleSpeedWaitRpm()).toBeNull()

    // The approach ends. NOW the cut is staged - and it is NOT started.
    approachRunsToItsEnd()
    expect(stagedLoads()).toHaveLength(2)
    expect(cuttingMoves(stagedLoads()[1])).toBe(3)
    expect(startJobFrames()).toBe(1)
    expect(spindleSpeedWaitRpm()).toBe(12_000)
    expect(consoleText()).toContain(SPINDLE_SPEED_GATE.waiting(12_000))

    // Five seconds of ramping is still not a reason to cut. (The machine took
    // fifteen to reach 18,000 on 2026-09-07.)
    await rampSpindle([3_000, 5_000, 7_000, 9_000, 10_500, 11_400, 11_800, 11_950, 11_990])
    expect(startJobFrames()).toBe(1)

    // The inverter says it has arrived - and the cut begins on that frame.
    pushVfd(12_000)
    expect(startJobFrames()).toBe(2)
    expect(spindleSpeedWaitRpm()).toBeNull()
    expect(consoleText()).toContain(SPINDLE_SPEED_GATE.released(12_000))
  })

  it('costs NOTHING when the spindle is already turning at the commanded speed', async () => {
    // Already within the definition's 3 RPM tolerance of what the operation
    // asks for. The gate still does not take the machine's word for it at the
    // instant of Cycle Start: everything said so far was said about the speed
    // the spindle was running BEFORE this Cycle Start commanded one.
    expect(await cycleStartWithSpindleAt(12_002)).toBe(true)
    expect(startJobFrames()).toBe(1)

    // By the end of the approach the machine has spoken about THIS speed - the
    // approach's own status frames are that answer - so the cut follows it
    // without a wait at all. The whole cost of the check on a machine that was
    // already up to speed is nothing.
    approachRunsToItsEnd()

    expect(startJobFrames()).toBe(2)
    expect(spindleSpeedWaitRpm()).toBeNull()
    // Nothing was ever held, so the operator is told nothing: no wait line and
    // no release line. A check that costs nothing also says nothing.
    expect(consoleText()).not.toContain(SPINDLE_SPEED_GATE.waiting(12_000))
    expect(consoleText()).not.toContain(SPINDLE_SPEED_GATE.released(12_000))
  })

  it('gives up after the timeout with the spindle STOPPED and nothing cut', async () => {
    expect(await cycleStartWithSpindleAt(0)).toBe(true)
    approachRunsToItsEnd()
    expect(startJobFrames()).toBe(1)
    expect(spindleSpeedWaitRpm()).toBe(12_000)

    await vi.advanceTimersByTimeAsync(SPINDLE_UP_TO_SPEED_TIMEOUT_MS + 250)

    expect(startJobFrames()).toBe(1)
    expect(socket().frames('spindleOff').length).toBeGreaterThanOrEqual(1)
    expect(consoleText()).toContain(SPINDLE_SPEED_GATE.timedOut(12_000))
    // AND THE PROGRAM IS OVER, SAID OUT LOUD. The approach already ran, so
    // this is a running program being ended - not a Cycle Start that never
    // took. Leaving it reporting "streaming" with an idle board and a part
    // that will never start would be the app lying about a live machine.
    expect(useMachineControl.getState().job.phase).toBe('failed')
    // And it stays given up: a late arrival cannot resurrect the cut.
    pushVfd(12_000)
    expect(startJobFrames()).toBe(1)
  })
})

describe('WO-1276: an unexpected spindle stop ends the program immediately', () => {
  beforeEach(async () => { await connectBridge() })

  it('stops the board and never starts the next part after a serial timeout', async () => {
    expect(await cycleStartWithSpindleAt(12_000)).toBe(true)
    approachRunsToItsEnd()
    expect(startJobFrames()).toBe(2)
    act(() => { socket().emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage) })

    pushVfd(0, { running: false, lastStopReason: 'serialTimeout' })

    const message = 'Spindle stopped by the software: the inverter stopped answering.'
    expect(socket().frames('stopJob')).toHaveLength(1)
    expect(socket().frames('spindleOff').length).toBeGreaterThanOrEqual(1)
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'failed',
      error: { message },
    })
    expect(useMachineControl.getState().programReadiness).toEqual({ ready: false, reason: message })
    expect(consoleText().filter((line) => line === message)).toHaveLength(1)
    expect(spindleSpeedWaitRpm()).toBeNull()

    // A late controller completion from the stopped part cannot advance the
    // now-terminal program or put another startJob frame on the wire.
    programRunsToItsEnd()
    expect(startJobFrames()).toBe(2)
  })
})

describe('WO-1275: nothing gates a stop', () => {
  beforeEach(async () => { await connectBridge() })

  /** Let the spindle reach speed AFTER the stop. If the gate had merely queued
   *  the motion behind the stop, this is where it would escape. */
  function spindleArrivesAfterwards(): void {
    pushVfd(12_000)
    vi.advanceTimersByTime(SPINDLE_UP_TO_SPEED_TIMEOUT_MS + 1_000)
  }

  /** THE STATE EVERY TEST BELOW STOPS FROM: the approach has run, the cut is
   *  staged on the board, and the gate is holding it for the spindle. One
   *  `startJob` frame has been sent (the approach); a second one would be the
   *  cut, and the cut is what must never escape a stop. */
  async function cutIsHeldForTheSpindle(): Promise<void> {
    expect(await cycleStartWithSpindleAt(1_969)).toBe(true)
    approachRunsToItsEnd()
    expect(startJobFrames()).toBe(1)
    expect(spindleSpeedWaitRpm()).toBe(12_000)
  }

  it('Stop/Reset works while the gate waits, and the held cut never starts', async () => {
    await cutIsHeldForTheSpindle()

    expect(executeOperatorStopReset()).toBe(true)

    expect(spindleSpeedWaitRpm()).toBeNull()
    expect(socket().frames('spindleOff').length).toBeGreaterThanOrEqual(1)
    spindleArrivesAfterwards()
    expect(startJobFrames()).toBe(1)
  })

  it('Feed Hold works while the gate waits, and the held cut never starts', async () => {
    await cutIsHeldForTheSpindle()

    expect(executeOperatorFeedHold()).toBe(true)

    expect(spindleSpeedWaitRpm()).toBeNull()
    expect(socket().frames('feedHold')).toHaveLength(1)
    expect(socket().frames('spindleOff').length).toBeGreaterThanOrEqual(1)
    spindleArrivesAfterwards()
    expect(startJobFrames()).toBe(1)
  })

  it('E-STOP works while the gate waits, and the held cut never starts', async () => {
    await cutIsHeldForTheSpindle()

    act(() => { triggerEmergencyStop() })

    expect(spindleSpeedWaitRpm()).toBeNull()
    expect(socket().frames('emergencyStop')).toHaveLength(1)
    spindleArrivesAfterwards()
    expect(startJobFrames()).toBe(1)
  })

  it('a hardware E-STOP arriving on a status frame drops the held cut too', async () => {
    await cutIsHeldForTheSpindle()

    // The button on the machine. It reaches the app as an INPUT, not as a call,
    // so it never passes through the stop doors that cancel the wait - the
    // release re-asks the latch for exactly this case.
    act(() => {
      socket().emit({
        t: 'status',
        v: { ...idleBridgeStatus(), inputs: { estop: true } },
      } as BridgeMessage)
    })

    expect(spindleSpeedWaitRpm()).toBeNull()
    expect(consoleText()).toContain(SPINDLE_SPEED_GATE.cancelled('the E-STOP was set'))
    spindleArrivesAfterwards()
    expect(startJobFrames()).toBe(1)
  })
})

describe('WO-1275: positioning is never gated', () => {
  beforeEach(async () => { await connectBridge() })

  it("the PROGRAM's own approach rapids run while the spindle is still ramping", async () => {
    // OPERATOR'S CLAUSES 1 AND 3, ABOUT THE PROGRAM ITSELF AND NOT ABOUT A JOG.
    // This toolpath positions in TWO rapids before it plunges. Both of them
    // belong to the approach, so both are staged together and both run while
    // the inverter is at 900 RPM of a commanded 12,000 - which is the "spins
    // up DURING the approach" the order asks for, rather than a machine
    // standing still while the spindle winds up.
    applyProject([opWithMoves('op1', 't1', [
      { type: 'rapid', x: 40, y: 25, z: 12 },
      { type: 'rapid', x: 10, y: 5, z: 12 },
      { type: 'feed', x: 10, y: 5, z: 1, feed: 300 },
      { type: 'feed', x: 60, y: 5, z: 1, feed: 900 },
    ])])
    cleanup()
    await operatorLoadsTheSetup()
    pushVfd(900)

    expect(await executeOperatorCycleStart()).toBe(true)

    expect(stagedLoads()).toHaveLength(1)
    expect(stagedLoads()[0]).toEqual([{ rapid: true }, { rapid: true }])
    expect(startJobFrames()).toBe(1)
    expect(spindleSpeedWaitRpm()).toBeNull()

    // The plunge that follows them is the part that waits.
    approachRunsToItsEnd()
    expect(cuttingMoves(stagedLoads()[1])).toBe(2)
    expect(startJobFrames()).toBe(1)
    expect(spindleSpeedWaitRpm()).toBe(12_000)
  })

  it('a jog goes to the wire while a cut is being held for the spindle', async () => {
    expect(await cycleStartWithSpindleAt(1_969)).toBe(true)
    approachRunsToItsEnd()
    expect(spindleSpeedWaitRpm()).toBe(12_000)

    // Operator's first clause, at the operator's own door: "moving TO POSITION
    // below speed is ALLOWED."
    expect(jogToSafeZ(-5, 1_000).ok).toBe(true)

    expect(socket().frames('jogToMachineZ')).toHaveLength(1)
    // ...and holding the cut is not disturbed by having jogged.
    expect(startJobFrames()).toBe(1)
    expect(spindleSpeedWaitRpm()).toBe(12_000)
  })
})

describe('WO-1275: a machine that cannot report spindle speed still runs', () => {
  it('a bridge started without --vfd runs exactly as it did before', async () => {
    // THE ACCEPTANCE CLAUSE. No inverter link at all is a legitimate machine -
    // and reading its unanswerable up-to-speed question as "never at speed"
    // would brick it. There is no program spindle intent, so the gate is not
    // merely permissive here: it is not in the path at all.
    helloVfd = null
    await connectBridge()

    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)

    expect(startJobFrames()).toBe(1)
    expect(socket().frames('spindleOn')).toHaveLength(0)
    expect(spindleSpeedWaitRpm()).toBeNull()
    expect(consoleText()).not.toContain(SPINDLE_SPEED_GATE.noLink)
  })

  it('a controller that reports no spindle block is NOT gated - the third answer', () => {
    // A CONTROL, and labelled as one: this asks the exported decision function
    // directly rather than through the application.
    //
    // `status().spindle` is null whenever "the whole concept does not apply to
    // this connection" - GRBL, a simulator with no link, a bridge with no
    // inverter. That is the half of the null decision that must NOT wait, and
    // this is the branch that expresses it. It is written as a branch rather
    // than relied upon as an accident: on the UCCNC backend a missing
    // definition also makes `spindleOn` refuse, so the program is turned away
    // by WO-1264's own check before this is reached (proven below).
    const noLink = { status: () => ({ spindle: null }) } as unknown as
      Parameters<typeof spindleSpeedVerdict>[0]
    expect(spindleSpeedVerdict(noLink)).toBe('no-spindle-link')

    const ramping = {
      status: () => ({ spindle: { upToSpeed: false } }),
    } as unknown as Parameters<typeof spindleSpeedVerdict>[0]
    expect(spindleSpeedVerdict(ramping)).toBe('below-speed')

    // THE DEFECT, IF NULL WERE READ AS YES. It is not.
    const cannotSay = {
      status: () => ({ spindle: { upToSpeed: null } }),
    } as unknown as Parameters<typeof spindleSpeedVerdict>[0]
    expect(spindleSpeedVerdict(cannotSay)).toBe('below-speed')

    const atSpeed = {
      status: () => ({ spindle: { upToSpeed: true } }),
    } as unknown as Parameters<typeof spindleSpeedVerdict>[0]
    expect(spindleSpeedVerdict(atSpeed)).toBe('at-speed')
  })

  it('an inverter this build cannot decode is refused before the gate, spindle stopped', async () => {
    // `--vfd` WAS passed, so a program spindle intent exists - but the named
    // definition is not one this build can compile, so the backend cannot work
    // out a setpoint word at all. WO-1264's refusal stands in front of this
    // order's gate, which is the safe order for them to be in: nothing was
    // staged, nothing turned, nothing cut.
    helloVfd = { present: true, verified: false, name: 'Some Inverter We Do Not Ship' }
    await connectBridge()

    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(false)

    expect(startJobFrames()).toBe(0)
    expect(spindleSpeedWaitRpm()).toBeNull()
    expect(consoleText().some((line) => line.startsWith('Cycle Start: refused'))).toBe(true)
  })
})

describe('WO-1275: the check is re-run, never remembered', () => {
  beforeEach(async () => { await connectBridge() })

  it('a second operation at a different RPM is NOT let through on the last one\'s "up to speed"', async () => {
    // Operation one: 12,000 RPM, reached, approach run, cut released, program
    // finished. The machine's last word is "up to speed" - about TWELVE
    // thousand.
    expect(await cycleStartWithSpindleAt(12_000)).toBe(true)
    approachRunsToItsEnd()
    expect(startJobFrames()).toBe(2)
    programRunsToItsEnd()

    // Operation two asks for EIGHTEEN thousand. Nothing has arrived since to
    // revise that "up to speed", and believing it would plunge at 12,000 into
    // a cut that asked for 18,000 - a third of a defect this order exists to
    // remove. This is clause 4: the check re-arms on a speed change.
    applyProject([op('op2', 't2')])
    cleanup()
    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)

    expect(commandedSpindleRpm().at(-1)).toBe(18_000)
    // Its approach goes, as always. Its CUT does not: the only "up to speed"
    // anyone has said was about the last operation's speed.
    expect(startJobFrames()).toBe(3)
    approachRunsToItsEnd()
    expect(startJobFrames()).toBe(3)
    expect(spindleSpeedWaitRpm()).toBe(18_000)

    // Still at 12,000 - still not this operation's speed.
    pushVfd(12_000)
    expect(startJobFrames()).toBe(3)

    pushVfd(18_000)
    expect(startJobFrames()).toBe(4)
  })

  it('a ONE-SETUP two-speed program is refused at load, so clause 4 needs two setups', async () => {
    // FOR THE MACHINE SEAT, AND FOR WO-1277. The clause-4 fixture built on
    // 2026-09-07 (`SHAKEDOWN-2026-09-07/wo1275-two-speed/`) is ONE setup with
    // two operations on ONE tool at two speeds. On the geometry route - the one
    // Operator's machine actually uses - that program never reaches the board at
    // all: a staged toolpath program carries a single spindle intent, so the
    // door refuses it rather than silently collapsing two speeds into one.
    //
    // This is WO-1264's refusal, not this order's, and it is asserted here
    // because clause 4's evidence depends on it: the two-speed proof must be
    // run as two SETUPS. It also pins the refusal, so a later change that lets
    // one program carry two speeds cannot land without meeting this gate.
    applyProject([op('op1', 't1'), op('op2', 't1', 18_000)])
    cleanup()
    await operatorLoadsTheSetup()

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toContain('more than one spindle speed')
    expect(socket().frames('loadMoves')).toHaveLength(0)
    expect(motionReleaseFrames()).toBe(0)
  })

  it('a resume after a Feed Hold is checked again, not waved through', async () => {
    // The CUT is running: the approach went, the spindle was at speed, and the
    // second staged part - the one with the plunge in it - was released.
    expect(await cycleStartWithSpindleAt(12_000)).toBe(true)
    approachRunsToItsEnd()
    expect(motionReleaseFrames()).toBe(2)
    act(() => { socket().emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage) })

    // Feed Hold stops the spindle (WO-1264), so the machine is no longer at
    // speed - which is exactly the state WO-1276 found at a part boundary,
    // where the spindle died and 2,459 moves were dragged through dry.
    expect(executeOperatorFeedHold()).toBe(true)
    act(() => { socket().emit({ t: 'jobEvent', v: { event: 'paused', fault: null } } as BridgeMessage) })
    pushVfd(0, { running: false })

    // Resuming INTO a cut is a cut beginning. It waits, exactly as the first
    // one did - the staged motion this releases is the cutting part.
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(motionReleaseFrames()).toBe(2)
    expect(spindleSpeedWaitRpm()).toBe(12_000)

    pushVfd(12_000)
    expect(motionReleaseFrames()).toBe(3)
  })
})
