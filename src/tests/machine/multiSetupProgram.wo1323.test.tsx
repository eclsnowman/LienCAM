// @vitest-environment jsdom
//
// WO-1323 - ONE PROGRAM, TWO SETUPS, ON THE GEOMETRY ROUTE.
//
// Item 5.5's third run is the point of the item: "both setups, ONE posted
// program - does the machine SWITCH between them mid-program". On 2026-09-10
// it could not be attempted. The posted combined `.nc` needs a G-code route
// this controller does not have, and the Load menu offered setups singly, so a
// part needing two fixtures under two work offsets could not run as one
// program on the only controller the app drives.
//
// WHAT IS PROVEN HERE, THROUGH THE APPLICATION'S OWN ENTRY POINT (rule 6, and
// Operator's standing requirement that the program is "loaded via the actual UI
// like a user would"): the ProgramPanel is RENDERED and its new "All 2 setups"
// menu item is CLICKED, on the real session singleton talking to a real
// `UccncController` over a fake bridge socket, and to the simulator.
//
//   - the load line names both setups and both frames, in order, BEFORE CYCLE
//     START is offered,
//   - G54 is selected and confirmed before setup 1's moves are staged, and
//     setup 1's part ends on a RETRACT to the program's global safe height,
//   - at the boundary the program HOLDS: no G55, no setup 2 moves, and the
//     operator is told which setup runs next and in which frame,
//   - CYCLE START at the boundary selects G55 and only THEN stages setup 2 -
//     the frame change never precedes the retract,
//   - a machine reporting the tool still DOWN at the boundary gets no frame
//     change and no setup 2 at all: the program fails, naming both heights,
//   - a setup whose frame the controller does not have set refuses the WHOLE
//     program before the first move, naming the setup and the frame,
//   - single-setup loading is untouched: one selectWcs, one loadMoves, and no
//     "All setups" item when the project has one setup.
//
// THE BOUNDARY THIS ORDER OWNS IS A SAME-TOOL BOUNDARY, and that is all this
// file still measures. WO-1323 also refused a DIFFERENT-tool program at the
// door; WO-1330 turned that boundary into a tool-change sequence on Operator's
// ruling, and its own file measures it. See the note where those tests were.
//
// NOT CLAIMED: hardware. This order's Tier 1 evidence is the machine seat
// running the combined program in air on Operator's board with G54 and G55 100 mm
// apart, recording the machine coordinates the tool reached at each setup's
// first cutting move. Nothing here touches it and the desk lane does not claim
// it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import {
  createDefaultControllerDefinition,
  type MachineConfig,
  type Operation,
  type Project,
  type Setup,
  type ToolpathMove,
  type UnsentSetting,
} from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
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

/** Operator's AXBB-E as the bridge reports it: no G-code interpreter, a geometry
 *  program route, and no spindle of its own. */
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

/** G54 and G55 100 mm apart in X - item 5.5's own fixture. */
const G54_OFFSET = { x: 10, y: 5, z: 2 }
const G55_OFFSET = { x: 110, y: 5, z: 2 }
/** An incomplete bridge report: zero X/Y are real values, while omitted Z is
 *  what makes the frame not fully set on the controller. */
const OFFSET_WITHOUT_Z = { x: 0, y: 0 }

let bridgeG55Offset: { x: number; y: number; z?: number } = G55_OFFSET
/** The live bridge's half of a spindle declaration (`hello.vfd`); the machine
 *  record's half is `spindleLinkDefinition`. A program spindle intent needs
 *  BOTH, so the tests above run with neither and the spindle tests set both. */
let helloVfd: { present: boolean; verified: boolean; name: string | null } | null = null
let machineHasSpindleLink = false

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  loadMovesFrames(): { moves: { id: number; to: { x?: number; y?: number; z: number } }[] }[]
  /** Every call that reached the wire, in order, as `method(arg)` - the one
   *  place the ORDER of "select the frame" against "stage the moves" can be
   *  read without believing anything this software says about itself. */
  wireOrder(): string[]
}

const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
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
      const offsets = {
        G54: { ...G54_OFFSET },
        G55: { ...bridgeG55Offset },
        G56: { ...OFFSET_WITHOUT_Z },
        G57: { ...OFFSET_WITHOUT_Z },
        G58: { ...OFFSET_WITHOUT_Z },
        G59: { ...OFFSET_WITHOUT_Z },
      }
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1323-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
          ...(helloVfd ? { vfd: helloVfd } : {}),
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
      // A REAL BRIDGE ANSWERS EVERY CALL. The connect-time offset
      // reconciliation writes this software's stored zeros back to a bridge
      // reporting different ones and AWAITS each receipt, so a fake that
      // answered only `selectWcs` would hang the connection - which is a
      // property of the fake, never of the product.
      if (message.m === 'setWorkOffset') {
        const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, offset: { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 } },
        })
      }
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }

    loadMovesFrames(): { moves: { id: number; to: { x?: number; y?: number; z: number } }[] }[] {
      return this.sent
        .filter((m) => m.m === 'loadMoves')
        .map((m) => m.a as { moves: { id: number; to: { x?: number; y?: number; z: number } }[] })
    }

    wireOrder(): string[] {
      return this.sent
        .filter((m) => m.m === 'loadMoves' || m.m === 'selectWcs')
        .map((m) => (m.m === 'selectWcs'
          ? `selectWcs(${(m.a as { wcs: string }).wcs})`
          : `loadMoves(${(m.a as { moves: unknown[] }).moves.length})`))
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
  currentOperatorTransport,
  executeOperatorCycleStart,
} = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  setWorkOffsetValue,
  SPINDLE_SPEED_GATE,
} = await import('../../lib/machine/machineSession')

const SAMPLE_MACHINE_LINEAR_ERROR: UnsentSetting = {
  controller: 'uccnc',
  key: 'Generalsettings.Linearerror',
  value: '0.03',
}

function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -50 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 50
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  return makeMachine({
    id: 'wo1323-machine',
    name: 'WO-1323 Test Machine',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition,
    unsentSettings: [SAMPLE_MACHINE_LINEAR_ERROR],
    ...(machineHasSpindleLink
      ? { spindleLinkDefinition: {} as MachineConfig['spindleLinkDefinition'] }
      : {}),
  })
}

/** A rapid plus three feeds in WORLD coordinates, around the given origin.
 *  World Z 12 is the clearance plane the CAM used, so it is also the height
 *  every inter-setup retract lifts to. */
function toolpathAt(originX: number): ToolpathMove[] {
  return [
    { type: 'rapid', x: originX, y: 5, z: 12 },
    { type: 'feed', x: originX, y: 5, z: 1, feed: 300 },
    { type: 'feed', x: originX + 50, y: 5, z: 1, feed: 900 },
    { type: 'feed', x: originX + 50, y: 45, z: 1, feed: 900 },
  ]
}

/** The program's global safe height is WORLD Z 12 - the highest work Z either
 *  setup's toolpath reaches, lifted into the common frame - which in setup 1's
 *  frame (origin z 2) is work Z 10, and on the machine (G54 z 2) is machine
 *  Z 12. That last number is what the boundary demands the machine REPORT
 *  before the frame is allowed to change. */
const SETUP1_RETRACT_WORK_Z = 10
const SETUP1_CLEAR_MACHINE_Z = 12

function op(id: string, moves: ToolpathMove[], toolId = 't1'): Operation {
  return makeOp({ id, name: `Op ${id}`, type: 'contour_2d', toolId, status: 'ready', toolpathMoves: moves })
}

function setupAt(
  id: string,
  name: string,
  fixtureOffset: 54 | 55,
  origin: { x: number; y: number; z: number },
  operations: Operation[],
): Setup {
  return {
    id,
    name,
    wcs: makeWcs({ id: `w-${id}`, label: `G${fixtureOffset}`, fixtureOffset, origin }),
    stock: makeStock({ material: 'aluminum' }),
    operations,
    notes: '',
  }
}

const TOOLS = [
  makeTool({ id: 't1', toolNumber: 1, name: '6 mm flat end mill' }),
  makeTool({ id: 't2', toolNumber: 2, name: '3 mm ball nose', diameter: 3 }),
]

/** The two-setup project item 5.5 describes: one part, two fixtures, two work
 *  offsets 100 mm apart in X. */
function twoSetupProject({ secondTool = 't1' }: { secondTool?: string } = {}): void {
  const setups = [
    setupAt('setup1', 'Setup 1', 54, { x: 10, y: 5, z: 2 }, [op('op1', toolpathAt(10))]),
    setupAt('setup2', 'Setup 2', 55, { x: 110, y: 5, z: 2 }, [op('op2', toolpathAt(110), secondTool)]),
  ]
  applyProject(setups)
}

function applyProject(setups: Setup[]): void {
  const project = {
    ...useCamStore.getState().project,
    machine: machine(),
    setups,
    activeSetupId: setups[0].id,
    toolLibrary: TOOLS,
  }
  for (const setup of setups) {
    for (const operation of setup.operations) {
      const tool = TOOLS.find((candidate) => candidate.id === operation.toolId) ?? TOOLS[0]
      stampGenerationCurrent(project, setup, operation, tool)
    }
  }
  useCamStore.setState({ project, toolLibrary: TOOLS })
}

function idleBridgeStatus(machineZ = 0): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: machineZ },
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
  bridgeG55Offset = G55_OFFSET
  originalProject = useCamStore.getState().project
  originalToolLibrary = useCamStore.getState().toolLibrary
  twoSetupProject()
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({
    project: originalProject,
    toolLibrary: originalToolLibrary,
    // Stored work zeros survive a disconnect on purpose (WO-1042); inside one
    // test file they would carry one case's G55 into the next one's bridge.
    machineWorkOffsets: {},
  })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

async function connect(kind: 'simulator' | 'bridge'): Promise<void> {
  const pending = connectMachine(kind)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  if (kind === 'bridge') {
    act(() => {
      socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
      socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    })
  } else {
    if (!getMachineController().home()) throw new Error('The simulator refused the homed fixture.')
    await vi.advanceTimersByTimeAsync(2_000)
  }
}

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

/** THE OPERATOR'S OWN GESTURE: open the Load menu in the rendered panel and
 *  click the entry that loads every setup as one program.
 *
 *  WO-1329: and, when they want tonight's hold instead, UNTICK the box first -
 *  which is the only way any of these tests can get a hold, because the box is
 *  on when the menu opens. */
async function operatorLoadsAllSetups(
  { continueThrough = true }: { continueThrough?: boolean } = {},
): Promise<void> {
  render(<ProgramPanel />)
  act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
  const box = screen.getByTestId('control-load-all-setups-continue') as HTMLInputElement
  // OPERATOR'S REQUIREMENT 3, ASSERTED WHEREVER THE MENU IS OPENED: the box is ON
  // by default. Every hold test below has to click it off to get its hold.
  expect(box.checked).toBe(true)
  if (!continueThrough) act(() => { fireEvent.click(box) })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-load-all-setups'))
    await Promise.resolve()
  })
  // The bridge's selectWcs receipt is a promise; the program stages behind it.
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
}

/** The load line and the responsibility line a run-through load prints, in the
 *  operator's words - the two sentences WO-1329 requirement 4 asks for. */
const RUN_THROUGH_LOAD =
  'Toolpath program "Setup 1 + Setup 2 (toolpath)" loaded: 9 moves in 2 setups - '
  + 'Setup 1 in G54, then Setup 2 in G55. It runs straight through from '
  + 'G54 into G55 without stopping.'
const RUN_THROUGH_RESPONSIBILITY =
  'This program does not stop between setups, so G54 and G55 must be set to the right zeros '
  + 'before it runs. Confirming that is yours to do - check G54 and G55 at the machine, then '
  + 'press CYCLE START.'

async function operatorLoadsOneSetup(setupId: string): Promise<void> {
  render(<ProgramPanel />)
  act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
  await act(async () => {
    fireEvent.click(screen.getByTestId(`control-load-setup-item-${setupId}`))
    await Promise.resolve()
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
}

describe('WO-1323: one program carries two setups and switches frames between them', () => {
  beforeEach(async () => { await connect('bridge') })

  function emitStatus(status: MachineStatus): void {
    act(() => { socket().emit({ t: 'status', v: status } as BridgeMessage) })
  }

  function emitCompleted(): void {
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  /** Run the staged part to its end and let the controller declare it over,
   *  with the machine reporting `machineZ` when it stops. */
  function finishStagedPart(machineZ: number): void {
    emitStatus({ ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } })
    emitCompleted()
  }

  it('names both setups and both frames on the load line, before CYCLE START', async () => {
    await operatorLoadsAllSetups({ continueThrough: false })

    // 4 moves + a retract for setup 1, 4 moves for setup 2.
    expect(useMachineControl.getState().programReadiness).toMatchObject({
      ready: true,
      reason:
        'Toolpath program "Setup 1 + Setup 2 (toolpath)" loaded: 9 moves in 2 setups - '
        + 'Setup 1 in G54, then Setup 2 in G55.',
    })
    expect(currentOperatorTransport().action).toBe('start')
  })

  it('selects G54 and stages ONLY setup 1, ending on a retract to the global safe height', async () => {
    await operatorLoadsAllSetups()

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(5)'])
    const staged = socket().loadMovesFrames()[0].moves
    // Setup 1's own work coordinates (origin 10,5,2), then the retract.
    expect(staged.map((move) => move.to.z)).toEqual([10, -1, -1, -1, SETUP1_RETRACT_WORK_Z])
    expect(staged.at(-1)!.to).toMatchObject({ x: 50, y: 40, z: SETUP1_RETRACT_WORK_Z })
    expect(useMachineControl.getState().activeWcs).toBe('G54')
  })

  it('HOLDS at the boundary: no G55 and no setup 2 until the operator says go', async () => {
    await operatorLoadsAllSetups({ continueThrough: false })
    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(5)'])
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(consoleText()).toContain(
      'Setup 1 is finished and the tool has retracted clear. Set up "Setup 2", then press CYCLE '
      + 'START to run it in G55.',
    )
  })

  it('switches to G55 on CYCLE START and only THEN stages setup 2', async () => {
    await operatorLoadsAllSetups({ continueThrough: false })
    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(currentOperatorTransport().cycleStartEnabled).toBe(true)
    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })

    // THE ORDER IS THE VERDICT: the frame changes after setup 1's moves are
    // done and BEFORE any of setup 2's reach the board.
    expect(socket().wireOrder()).toEqual([
      'selectWcs(G54)',
      'loadMoves(5)',
      'selectWcs(G55)',
      'loadMoves(4)',
    ])
    const secondStage = socket().loadMovesFrames()[1].moves
    // Setup 2's OWN work coordinates: its origin is x 110, so its first move is
    // at work x 0 - the same numbers setup 1 ran, in a frame 100 mm away.
    expect(secondStage.map((move) => move.to)).toEqual([
      { x: 0, y: 0, z: 10 },
      { x: 0, y: 0, z: -1 },
      { x: 50, y: 0, z: -1 },
      { x: 50, y: 40, z: -1 },
    ])
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    expect(useMachineControl.getState().job.phase).toBe('streaming')
  })

  it('never switches while the tool is down: the frame change is refused, not deferred', async () => {
    await operatorLoadsAllSetups({ continueThrough: false })
    expect(await executeOperatorCycleStart()).toBe(true)
    // The board says the part is over while Z is still at cutting depth. That
    // is agenda FAIL #3's setup, and nothing may move in the new frame.
    finishStagedPart(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(5)'])
    expect(useMachineControl.getState().activeWcs).toBe('G54')
    expect(useMachineControl.getState().job.phase).toBe('failed')
    expect(consoleText()).toContain(
      'The tool is at machine Z 1.00 mm and Setup 1 retracts clear at machine Z 12.00 mm, so it is not '
      + 'clear of the work. G55 was not selected and "Setup 2" was not started. Nothing moved.',
    )
  })

  it('reads stage 2 live and counts the whole finished stage at the hold (board, 2026-09-11)', async () => {
    await operatorLoadsAllSetups({ continueThrough: false })
    vi.setSystemTime(new Date('2026-09-11T01:00:00Z'))
    expect(await executeOperatorCycleStart()).toBe(true)
    // The real bridge raises the lifecycle edge itself; the fake needs telling.
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
    })
    const startedAt = useMachineControl.getState().job.startedAt
    expect(startedAt).not.toBeNull()

    // Stage 1 ends. The hold reports the WHOLE finished stage, not the
    // controller's own counter, which read one short on the board.
    vi.setSystemTime(new Date('2026-09-11T01:00:30Z'))
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const held = useMachineControl.getState().job
    expect(held.phase).toBe('paused')
    expect(held.ackedLines).toBe(5)
    expect(held.totalLines).toBe(9)

    // A ten-minute hold is not running time.
    vi.setSystemTime(new Date('2026-09-11T01:10:30Z'))
    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
    const resumed = useMachineControl.getState().job
    expect(resumed.phase).toBe('streaming')
    expect(resumed.startedAt! - startedAt!).toBeGreaterThanOrEqual(10 * 60 * 1000)

    // Stage 2 runs: its ids continue the program's numbering, and the readout
    // follows them instead of freezing at the stage boundary.
    const secondIds = socket().loadMovesFrames()[1].moves.map((move) => move.id)
    emitStatus({ ...idleBridgeStatus(SETUP1_CLEAR_MACHINE_Z), state: 'run', executingMoveId: secondIds[2] })
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    const running = useMachineControl.getState().job
    expect(running.ackedLines).toBe(5 + 2)
    expect(running.totalLines).toBe(9)
  })

  it('runs the whole two-setup program to one completion', async () => {
    await operatorLoadsAllSetups({ continueThrough: false })
    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 9,
      ackedLines: 9,
    })
  })
})

/**
 * WO-1329 - THE BOUNDARY THE OPERATOR DOES NOT HAVE TO PRESS.
 *
 * OPERATOR, AT THE MACHINE 2026-09-11, watching the combined program hold between
 * setups: "What if I want to run directly from the G54 setup into G55 without
 * stopping? Is that possible?" And his ruling: "The conditions for whether it
 * continues through G54 into G55 versus not should realistically only depend on
 * whether the tool changes between those setups. If it does not, there is
 * nothing that should be stopping us... I would recommend that the checkbox be
 * ON by default... It would not be uncommon for someone with two vise locations
 * or known locations to set something up to run between those locations and do
 * it repeatedly. An operator would not like to have to hit cycle start twice
 * for every multi-setup program run."
 *
 * WHAT IS PROVEN HERE, THROUGH THE PANEL THE OPERATOR CLICKS: the box is on
 * when the Load menu opens, the load line says the program runs straight
 * through, the responsibility line names both frames, and at the boundary the
 * frame changes and stage 2 starts with NOBODY PRESSING ANYTHING - in the same
 * order, behind the same retract readback, as the held boundary. And a machine
 * that cannot prove the tool is clear stops the run-through program with the
 * sentence a held one would have used.
 */
describe('WO-1329: the box is on and the program runs straight through the boundary', () => {
  beforeEach(async () => { await connect('bridge') })

  function emitStatus(status: MachineStatus): void {
    act(() => { socket().emit({ t: 'status', v: status } as BridgeMessage) })
  }

  function finishStagedPart(machineZ: number): void {
    emitStatus({ ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  /** Every frame that moves the machine, in wire order - `startJob` included,
   *  because "the CYCLE START the operator would have pressed, pressed by the
   *  program" is a call on the wire and nothing else. */
  function wire(): string[] {
    return socket().sent
      .filter((m) => ['selectWcs', 'loadMoves', 'startJob'].includes(m.m))
      .map((m) => (m.m === 'selectWcs' ? `selectWcs(${(m.a as { wcs: string }).wcs})` : m.m))
  }

  it('says on the load line that it runs straight through, and names whose the zeros are', async () => {
    await operatorLoadsAllSetups()

    expect(useMachineControl.getState().programReadiness).toMatchObject({
      ready: true,
      reason: RUN_THROUGH_LOAD,
    })
    expect(consoleText()).toContain(RUN_THROUGH_LOAD)
    expect(consoleText()).toContain(RUN_THROUGH_RESPONSIBILITY)
    // ONCE. It is a console line, not a drumbeat.
    const said = useMachineControl.getState().consoleLines
      .filter((line) => line.text === RUN_THROUGH_RESPONSIBILITY)
    expect(said).toHaveLength(1)
    expect(said[0].severity).toBe('info')
  })

  it('crosses the boundary with nobody pressing anything: G55 and stage 2 follow the completion', async () => {
    await operatorLoadsAllSetups()
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves', 'startJob'])

    // Stage 1 ends clear of the work. NO CYCLE START FOLLOWS THIS LINE.
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(wire()).toEqual([
      'selectWcs(G54)',
      'loadMoves',
      'startJob',
      'selectWcs(G55)',
      'loadMoves',
      'startJob',
    ])
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    expect(useMachineControl.getState().job.phase).toBe('streaming')
    expect(consoleText()).toContain(
      'G55 is selected and the tool is clear - running "Setup 2" in G55.',
    )
    // The hold's sentence is never said, because there was no hold.
    expect(consoleText()).not.toContain('then press CYCLE START to run it in G55')
    // And setup 2 is staged in its OWN frame's coordinates, as it always was.
    expect(socket().loadMovesFrames()[1].moves.map((move) => move.to)).toEqual([
      { x: 0, y: 0, z: 10 },
      { x: 0, y: 0, z: -1 },
      { x: 50, y: 0, z: -1 },
      { x: 50, y: 40, z: -1 },
    ])
  })

  it('runs both setups to one completion on ONE cycle start', async () => {
    await operatorLoadsAllSetups()
    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 9,
      ackedLines: 9,
    })
  })

  it('still refuses the frame change when the machine says the tool is down', async () => {
    await operatorLoadsAllSetups()
    expect(await executeOperatorCycleStart()).toBe(true)
    // Agenda FAIL #3's setup, with nobody at the boundary to catch it. The
    // readback is what stops it, exactly as it does at a hold.
    finishStagedPart(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves', 'startJob'])
    expect(useMachineControl.getState().activeWcs).toBe('G54')
    expect(useMachineControl.getState().job.phase).toBe('failed')
    expect(consoleText()).toContain(
      'The tool is at machine Z 1.00 mm and Setup 1 retracts clear at machine Z 12.00 mm, so it is not '
      + 'clear of the work. G55 was not selected and "Setup 2" was not started. Nothing moved.',
    )
  })

  it('says whose the zeros are again at CYCLE START when the load has scrolled away', async () => {
    vi.setSystemTime(new Date('2026-09-11T09:00:00Z'))
    await operatorLoadsAllSetups()
    expect(
      useMachineControl.getState().consoleLines
        .filter((line) => line.text === RUN_THROUGH_RESPONSIBILITY),
    ).toHaveLength(1)

    // The operator loaded, then went and set the second vice.
    vi.setSystemTime(new Date('2026-09-11T09:04:00Z'))
    expect(await executeOperatorCycleStart()).toBe(true)

    expect(
      useMachineControl.getState().consoleLines
        .filter((line) => line.text === RUN_THROUGH_RESPONSIBILITY),
    ).toHaveLength(2)
  })

  it('does not repeat itself when the operator loads and starts straight away', async () => {
    vi.setSystemTime(new Date('2026-09-11T09:00:00Z'))
    await operatorLoadsAllSetups()
    vi.setSystemTime(new Date('2026-09-11T09:00:03Z'))
    expect(await executeOperatorCycleStart()).toBe(true)

    expect(
      useMachineControl.getState().consoleLines
        .filter((line) => line.text === RUN_THROUGH_RESPONSIBILITY),
    ).toHaveLength(1)
  })

  /** WO-1329 audit finding: the help text on the "All N setups" entry promised a
   *  hold at every boundary. The box beside it now opens ticked, so that entry
   *  loads a program that does not stop - an operator reading the old sentence
   *  would stand at the machine waiting for a pause that never comes. The two
   *  controls are read together and must say the same thing. */
  it('tells the operator what the All-setups entry will actually do, ticked or not', async () => {
    render(<ProgramPanel />)
    act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
    const entry = screen.getByTestId('control-load-all-setups')
    const box = screen.getByTestId('control-load-all-setups-continue') as HTMLInputElement

    expect(box.checked).toBe(true)
    expect(entry.getAttribute('data-tooltip')).toBe(
      'Load all 2 setups as one program - each runs in its own work offset, and the program '
      + 'runs straight through from one to the next without stopping',
    )

    act(() => { fireEvent.click(box) })
    expect(box.checked).toBe(false)
    expect(entry.getAttribute('data-tooltip')).toBe(
      'Load all 2 setups as one program - each runs in its own work offset, and the program '
      + 'holds between them so the work can be re-set',
    )
  })

  /** The same claim, stated as the invariant rather than as two strings: the
   *  entry may only speak of a hold when the box that would cause one is off. */
  it('never promises a hold while the box that runs it through is ticked', async () => {
    render(<ProgramPanel />)
    act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
    const entry = screen.getByTestId('control-load-all-setups')
    const box = screen.getByTestId('control-load-all-setups-continue') as HTMLInputElement

    for (const ticked of [true, false, true]) {
      if (box.checked !== ticked) act(() => { fireEvent.click(box) })
      const tip = entry.getAttribute('data-tooltip') ?? ''
      expect(box.checked).toBe(ticked)
      expect(/holds? between/i.test(tip)).toBe(!ticked)
      expect(/straight through/i.test(tip)).toBe(ticked)
    }
  })
})

describe('WO-1323: what a two-setup program refuses before the first move', () => {
  function emitNothingStaged(): void {
    expect(socket().wireOrder()).toEqual([])
  }

  it('refuses the WHOLE program when a setup names a frame the controller has not set', async () => {
    bridgeG55Offset = OFFSET_WITHOUT_Z
    await connect('bridge')
    await operatorLoadsAllSetups()

    emitNothingStaged()
    expect(useMachineControl.getState().programReadiness).toMatchObject({
      ready: false,
      reason:
        'Setup "Setup 2" runs in G55, which is not fully set on this controller, so nothing was '
        + 'staged. Set the X, Y and Z work zero for G55, then load the program again.',
    })
  })

  it('refuses two setups that share one frame - there is nothing to switch to', async () => {
    await connect('bridge')
    applyProject([
      setupAt('setup1', 'Setup 1', 54, { x: 10, y: 5, z: 2 }, [op('op1', toolpathAt(10))]),
      setupAt('setup2', 'Setup 2', 54, { x: 10, y: 5, z: 2 }, [op('op2', toolpathAt(10))]),
    ])
    await operatorLoadsAllSetups()

    emitNothingStaged()
    expect(useMachineControl.getState().programReadiness.reason).toBe(
      'Setups "Setup 1" and "Setup 2" both run in G54, so one program cannot switch between them - '
      + 'there is nothing to switch to. Give each setup its own work offset, or run them one at a '
      + 'time.',
    )
  })
})

// WO-1330 RETIRED THE BLOCK THAT STOOD HERE.
//
// It proved that a program whose setups need different tools was refused at
// the door, naming both setups and both tools, and that the continue-through
// box could not override that refusal. Operator ruled the refusal away from the
// machine on 2026-09-11: "If it does change tool, even if I check the box
// saying continue through, it should NOT continue through - it should be
// initiating a tool change sequence." Such a program now LOADS and holds as a
// tool change, so the behaviour those four tests measured is gone and keeping
// them would pin the product to a ruling its author reversed.
//
// What replaced them: `toolChangeBoundary.wo1330.test.tsx`, in this directory,
// which drives the same Load menu on the same fake bridge and measures the
// sequence the refusal used to stand in for. The half of this file that is
// about a SAME-TOOL program is untouched and still passes unchanged.

describe('WO-1323: single-setup loading is unchanged', () => {
  beforeEach(async () => { await connect('bridge') })

  it('loads exactly one setup with one frame selection and one staged list', async () => {
    await operatorLoadsOneSetup('setup1')

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(4)'])
    expect(useMachineControl.getState().programReadiness).toMatchObject({
      ready: true,
      reason: 'Toolpath program "Setup 1 (toolpath)" loaded: 4 moves, runs in G54.',
    })
  })

  it('offers no "all setups" entry when the project has one setup', async () => {
    applyProject([setupAt('setup1', 'Setup 1', 54, { x: 10, y: 5, z: 2 }, [op('op1', toolpathAt(10))])])
    render(<ProgramPanel />)
    act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })

    expect(screen.queryByTestId('control-load-all-setups')).toBeNull()
  })
})

describe('WO-1323: the simulated controller runs the same two-setup program', () => {
  beforeEach(async () => {
    await connect('simulator')
    // The simulator holds no offsets until this session sets them, which is
    // what an operator typing two zeros into the Work Offsets table does.
    //
    // Z IS ZERO ON BOTH FRAMES HERE ON PURPOSE. The simulator executes a
    // work-frame program's coordinates AS MACHINE COORDINATES - it does not add
    // `wco[activeWcs]` the way the bridge does at `loadMoves` - so a non-zero Z
    // offset would make its reported machine Z disagree with the same program's
    // on real hardware. With Z 0 the two agree and the boundary's clearance
    // readback means the same thing on both. X still differs by 100 mm, which
    // is what makes this two frames and not one. (The simulator's missing
    // program-frame offset is its own gap, noted for WO-428's parity work; it
    // is not in this order's owned paths.)
    act(() => {
      setWorkOffsetValue('G54', 'X', 0)
      setWorkOffsetValue('G54', 'Y', 0)
      setWorkOffsetValue('G54', 'Z', 0)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    act(() => {
      setWorkOffsetValue('G55', 'X', 100)
      setWorkOffsetValue('G55', 'Y', 0)
      setWorkOffsetValue('G55', 'Z', 0)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  })

  it('selects each setup\'s frame in order, through the simulator\'s own selectWcs', async () => {
    const ctrl = getMachineController()
    const selected: string[] = []
    const realSelect = ctrl.selectWcs.bind(ctrl)
    ctrl.selectWcs = (wcs) => { selected.push(wcs); return realSelect(wcs) }
    const staged: number[] = []
    const realLoad = ctrl.loadProgram!.bind(ctrl)
    ctrl.loadProgram = (program) => { staged.push(program.steps.length); return realLoad(program) }

    await operatorLoadsAllSetups({ continueThrough: false })
    expect(selected).toEqual(['G54'])
    expect(staged).toEqual([5])
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)

    // Run setup 1 to its end, with the machine parked at the retract height.
    expect(await executeOperatorCycleStart()).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(selected).toEqual(['G54'])

    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(selected).toEqual(['G54', 'G55'])
    expect(staged).toEqual([5, 4])
    expect(useMachineControl.getState().activeWcs).toBe('G55')
  })
})

// ---------------------------------------------------------------------------
// 2026-09-11, measured at the machine: with a real VFD every real program
// commands the spindle, and the all-setups door refused ALL spindle intent
// ("the up-to-speed check is armed once per load"). That premise was wrong:
// the gate runs on every start and resume, the boundary holds and stops the
// spindle, and the operator's next CYCLE START restarts and re-gates it. These
// tests are that whole shape, on the wire.
describe('WO-1323: a two-setup program carries ONE spindle intent across the boundary', () => {
  beforeEach(async () => {
    helloVfd = { present: true, verified: false, name: 'Huanyang GT' }
    machineHasSpindleLink = true
    twoSetupProject()
    await connect('bridge')
  })

  afterEach(() => {
    helloVfd = null
    machineHasSpindleLink = false
  })

  /** Every frame that moves the machine or the spindle, in wire order. */
  function wire(): string[] {
    return socket().sent
      .filter((m) => ['selectWcs', 'loadMoves', 'startJob', 'spindleOn', 'spindleOff'].includes(m.m))
      .map((m) => (m.m === 'selectWcs' ? `selectWcs(${(m.a as { wcs: string }).wcs})` : m.m))
  }

  /** One `vfd` push at `actualRpm`, the way the bridge reports the inverter. */
  function pushVfd(actualRpm: number, running = true): void {
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
          lastStopReason: 'commanded',
          lastError: null,
          statusWords: [45, 18, actualRpm, 0, 9],
          status: {},
          upToSpeed: null,
        },
      } as BridgeMessage)
    })
  }

  function emitStatus(status: MachineStatus): void {
    act(() => { socket().emit({ t: 'status', v: status } as BridgeMessage) })
  }

  function finishStagedPart(machineZ: number): void {
    emitStatus({ ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  async function operatorPressesCycleStart(): Promise<void> {
    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
  }

  it('loads, commands the spindle at CYCLE START, and holds setup 1 until the inverter is at speed', async () => {
    await operatorLoadsAllSetups()

    // THE DOOR IS OPEN. Frame selected, setup 1 staged, nothing about "one at a time".
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(consoleText()).not.toContain('Run these setups one at a time')
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves'])

    await operatorPressesCycleStart()
    // The spindle is commanded and the staged cut is HELD behind it - no startJob.
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves', 'spindleOn'])
    expect(consoleText()).toContain(SPINDLE_SPEED_GATE.waiting(12_000))

    pushVfd(12_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves', 'spindleOn', 'startJob'])
    expect(consoleText()).toContain(SPINDLE_SPEED_GATE.released(12_000))
  })

  it('stops the spindle at the boundary hold, and re-gates setup 2 behind a fresh spindle start', async () => {
    await operatorLoadsAllSetups({ continueThrough: false })
    await operatorPressesCycleStart()
    pushVfd(12_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(wire().at(-1)).toBe('startJob')

    // Setup 1 ends clear of the work. The program HOLDS - and the spindle is
    // OFF while the operator's hands are near the part.
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(wire().at(-1)).toBe('spindleOff')
    expect(wire().filter((m) => m.startsWith('selectWcs'))).toEqual(['selectWcs(G54)'])

    // CYCLE START at the hold: the spindle is commanded again, and NOTHING about
    // setup 2 reaches the board until the inverter reports speed.
    await operatorPressesCycleStart()
    expect(wire().at(-1)).toBe('spindleOn')
    expect(wire().filter((m) => m.startsWith('selectWcs'))).toEqual(['selectWcs(G54)'])
    expect(consoleText()).toContain(SPINDLE_SPEED_GATE.waiting(12_000))

    pushVfd(12_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    // THE ORDER IS THE VERDICT: spindle up, frame switched, setup 2 staged, started.
    expect(wire().slice(-4)).toEqual(['spindleOn', 'selectWcs(G55)', 'loadMoves', 'startJob'])
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    expect(useMachineControl.getState().job.phase).toBe('streaming')

    // And the program ends with the spindle off.
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(wire().at(-1)).toBe('spindleOff')
    expect(useMachineControl.getState().job.phase).toBe('complete')
  })

  // WO-1329: THE SAME BOUNDARY WITH NOBODY AT IT. The spindle was never
  // stopped, so there is no `spindleOff`/`spindleOn` pair to pay for, and the
  // up-to-speed gate - which runs on this release exactly as on every other -
  // reads the inverter still at speed and lets stage 2 go at once.
  it('runs through the boundary with the spindle up: no spindleOff, no second spindleOn', async () => {
    await operatorLoadsAllSetups()
    await operatorPressesCycleStart()
    pushVfd(12_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves', 'spindleOn', 'startJob'])

    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(wire()).toEqual([
      'selectWcs(G54)',
      'loadMoves',
      'spindleOn',
      'startJob',
      'selectWcs(G55)',
      'loadMoves',
      'startJob',
    ])
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    expect(useMachineControl.getState().job.phase).toBe('streaming')

    // And the program still ends with the spindle off.
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(wire().at(-1)).toBe('spindleOff')
    expect(useMachineControl.getState().job.phase).toBe('complete')
  })

  it('refuses two setups that ask for different spindle speeds, naming both, and stages nothing', async () => {
    const setups = [
      setupAt('setup1', 'Setup 1', 54, { x: 10, y: 5, z: 2 }, [op('op1', toolpathAt(10))]),
      setupAt('setup2', 'Setup 2', 55, { x: 110, y: 5, z: 2 }, [{
        ...op('op2', toolpathAt(110)),
        feedrateOverride: {
          enabled: true,
          rpm: 8_000,
          feedRate: 900,
          plungeRate: 300,
          rampFeedrate: 300,
          leadInFeedrate: 900,
          leadOutFeedrate: 900,
          fastTraverseFeedrate: 5000,
        },
      }]),
    ]
    applyProject(setups)
    await operatorLoadsAllSetups()

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(false)
    const said = `${readiness.reason ?? ''}
${consoleText()}`
    expect(said).toContain('"Setup 1" asks for the spindle at 12000 RPM CW and "Setup 2" at 8000 RPM CW')
    expect(said).toMatch(/run these setups one at a time/i)
    expect(wire()).toEqual([])
  })
})
