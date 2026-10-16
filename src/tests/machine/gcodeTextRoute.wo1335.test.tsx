// @vitest-environment jsdom
//
// WO-1335 - A POSTED .nc LOADS AND RUNS ON A CONTROLLER WHOSE WIRE TAKES NO TEXT.
//
// Operator, at the machine 2026-09-11, having asked before: "the software has to be
// able to run a g code and run it on ours - if you need to build a translator or
// do whatever you got to goddamn do ... A CNC control software that cannot load
// the most standard file format for controlling a CNC is not complete (.gcode
// and .nc)." The same minute, on his AXBB-E: Load -> Open file... -> two-setup.nc
// did NOTHING. No console line, no staged moves, the previous program still
// loaded. The bridge declares `gcodeText: false` and always will - the UC100 API
// takes segments - so the text door handed a program to a controller that had no
// interpreter for it and nothing happened.
//
// WHAT IS PROVEN HERE, THROUGH THE APPLICATION'S OWN ENTRY POINT (rule 6, and
// Operator's standing requirement that the program is "loaded via the actual UI like
// a user would"): the ProgramPanel is RENDERED, "Open file..." is CLICKED and a
// real File carrying the post's own output for the WO-1323 two-setup fixture is
// handed to the file input, on the real session singleton talking to a real
// `UccncController` over a fake bridge socket.
//
//   - the load line names the file, the move count, the frames in order and the
//     spindle speed, BEFORE CYCLE START is offered,
//   - THE EQUALITY THIS ORDER IS ACCEPTED ON: the moves the file stages are the
//     moves the toolpath route stages for the same two setups, frame by frame,
//     move for move - both routes measured in the SAME test, on the SAME kind of
//     wire, through the SAME rendered panel. The file route stages ONE move
//     more, and it is named: the postamble `G0 Z10` the file itself ends with,
//     which a toolpath has no postamble to emit.
//   - G54 is selected and confirmed before the first move is staged; at the
//     section boundary the program HOLDS, names the file and the next frame, and
//     G55 is selected on the operator's CYCLE START and only THEN is the rest
//     staged - the same order the toolpath route observes,
//   - a machine reporting the tool still DOWN at the boundary gets no frame
//     change and no second section,
//   - a file naming a frame the controller has not set is refused WHOLE, naming
//     the line, and nothing reaches the wire,
//   - a word this route cannot honour is refused by line and word, and the
//     previously loaded program is untouched.
//
// NOT CLAIMED: hardware. This order's Tier 1 evidence is the machine seat
// opening the posted two-setup.nc on Operator's board and recording the first cut of
// each section. Nothing here touches it and the desk lane does not claim it.

import { readFileSync } from 'node:fs'
import { mdiOutputByNumberMessage } from '../../lib/machine/operatorMessages'
import { join } from 'node:path'
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
  UNASSIGNED_PIN,
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
const ZERO_OFFSET = { x: 0, y: 0, z: 0 }
/** An incomplete bridge report: zero X/Y are real values, while omitted Z is
 *  what makes the frame not fully set on the controller. */
const OFFSET_WITHOUT_Z = { x: 0, y: 0 }

type FixtureOffset = { x: number; y: number; z?: number }

let bridgeG54Offset: FixtureOffset = G54_OFFSET
let bridgeG55Offset: FixtureOffset = G55_OFFSET
/** The corpus run uses a machine the corpus files were plausibly posted for -
 *  a bigger table with its work zeros well inside it. Nothing about the checks
 *  changes with it; only the table does. */
let corpusMachine = false
/** The live bridge's half of a spindle declaration (`hello.vfd`); the machine
 *  record's half is `spindleLinkDefinition`. A program spindle intent needs
 *  BOTH, so the tests above run with neither and the spindle tests set both. */
let helloVfd: { present: boolean; verified: boolean; name: string | null } | null = null
let machineHasSpindleLink = false
/** WO-1335 fix round 3: whether the MACHINE RECORD states a flood output.
 *  Operator's rule for the Control page's buttons ("If they do not, don't even show
 *  the buttons ... I have no coolant at all") is the same rule the file route
 *  applies, so this fixture carries both answers. The default fixture states
 *  nothing, which is every test above. */
let machineStatesFlood = false

/** One staged move EXACTLY AS THE BRIDGE RECEIVES IT. Everything the word
 *  table's sentences are about - is it a rapid, what feed does it carry, is it
 *  an arc and where is its centre - is in this payload, so those sentences are
 *  proven against the wire rather than against the interpreter. */
interface StagedWireMove {
  id: number
  kind: string
  to?: { x?: number; y?: number; z: number }
  feedMmMin?: number
  rapid?: true
  centre?: { x: number; y: number; z: number }
  clockwise?: boolean
  seconds?: number
}

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  loadMovesFrames(): { moves: StagedWireMove[] }[]
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
        G54: { ...bridgeG54Offset },
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
          bridge: 'wo-1335-fake 0.0',
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

    loadMovesFrames(): { moves: StagedWireMove[] }[] {
      return this.sent
        .filter((m) => m.m === 'loadMoves')
        .map((m) => m.a as { moves: StagedWireMove[] })
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
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
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
  sendMdiLine,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

const SAMPLE_MACHINE_LINEAR_ERROR: UnsentSetting = {
  controller: 'uccnc',
  key: 'Generalsettings.Linearerror',
  value: '0.03',
}

function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = corpusMachine
      ? (axis.axis === 'Z' ? -150 : 0)
      : (axis.axis === 'Z' ? -50 : 0)
    axis.softLimitMax = corpusMachine
      ? (axis.axis === 'X' ? 1200 : axis.axis === 'Y' ? 900 : 150)
      : (axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 50)
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  // WO-1649: the machine's one output list - flood and mist NAMED and neither
  // WIRED, which is what this file has always tested and what the profile's
  // relay keys used to say implicitly. It is stated for both fixtures on
  // purpose: whether the machine HAS coolant on the end of the wire is
  // `coolantCapability` (`machineStatesFlood` below), a different question from
  // which pin M8 switches, and the two tests here are exactly that pair.
  controllerDefinition.outputs = [
    { name: 'flood coolant', role: 'flood', onCode: 'M8', offCode: null, pin: { ...UNASSIGNED_PIN } },
    { name: 'mist coolant', role: 'mist', onCode: 'M7', offCode: null, pin: { ...UNASSIGNED_PIN } },
  ]
  return makeMachine({
    id: 'wo1323-machine',
    name: 'WO-1323 Test Machine',
    travel: corpusMachine ? { x: 1200, y: 900, z: 300 } : { x: 600, y: 400, z: 100 },
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
    ...(machineStatesFlood ? { coolantCapability: { flood: true } } : {}),
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
  corpusMachine = false
  machineStatesFlood = false
  useMachineActions.setState({ byMachine: {} })
  useMachineToolTable.setState({ byMachine: {} })
  bridgeG54Offset = G54_OFFSET
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

function emitStatus(status: MachineStatus): void {
  act(() => { socket().emit({ t: 'status', v: status } as BridgeMessage) })
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

/** THE OPERATOR'S OWN GESTURE: open the Load menu in the rendered panel and
 *  click the entry that loads every setup as one program. */
async function operatorLoadsAllSetups(): Promise<void> {
  render(<ProgramPanel />)
  act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-load-all-setups'))
    await Promise.resolve()
  })
  // The bridge's selectWcs receipt is a promise; the program stages behind it.
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
}


const { loadGcodeTextToolpathProgram } = await import('../../lib/machine/machineSession')
const { interpretGcodeProgram } = await import('../../lib/gcode/interpret')

/** THE POST'S OWN OUTPUT for the two-setup fixture above - the bytes
 *  `postProject(project, [setup1, setup2], uccnc, { mode: 'combined' })` emits,
 *  captured 2026-09-11. This is a FILE, not a payload: it goes in through the
 *  file input exactly as one off Operator's disk would. */
const TWO_SETUP_NC = [
  'G90 G94 G17 G21 G64',
  '( Setup 1 )',
  'G54',
  '( Op op1 )',
  'T1',
  'M3 S12000',
  'M8',
  'G0 X0 Y0 Z10',
  'G1 Z-1 F300',
  'X50 F900',
  'Y40',
  'G0 Z10',
  '( Setup 2 )',
  'G55',
  '( Op op2 )',
  'G0 X0 Y0 Z10',
  'G1 Z-1 F300',
  'X50 F900',
  'Y40',
  'M5',
  'M9',
  'G0 Z10',
  'M30',
  '',
].join('\n')

/** A File the panel's own input accepts. jsdom's Blob.text is not guaranteed in
 *  every environment this suite runs in, so the text is attached explicitly -
 *  a fake of the FILE API, never of the product. */
function programFile(name: string, text: string): File {
  const file = new File([text], name, { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: async () => text })
  return file
}

/** THE OPERATOR'S OWN GESTURE: open the Load menu in the rendered panel, choose
 *  "Open file...", and hand the hidden input a file. */
async function operatorOpensFile(name: string, text: string): Promise<void> {
  // One panel at a time: a second load in one test re-renders rather than
  // stacking a second copy of the same menu on the document.
  cleanup()
  render(<ProgramPanel />)
  act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
  act(() => { fireEvent.click(screen.getByTestId('control-open-file')) })
  const input = screen.getByTestId('control-file-input') as HTMLInputElement
  await act(async () => {
    fireEvent.change(input, { target: { files: [programFile(name, text)] } })
    await Promise.resolve()
    await Promise.resolve()
  })
  // file.text() is a promise, and the bridge's selectWcs receipt is another;
  // the program stages behind both.
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
}

describe('WO-1335: a posted .nc loads and runs through the geometry queue', () => {
  beforeEach(async () => { await connect('bridge') })

  function finishStagedPart(machineZ: number): void {
    emitStatus({ ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  /** Run a loaded two-section program from CYCLE START through its boundary to
   *  the second section being staged. Identical for both routes on purpose:
   *  the operator does the same thing either way. */
  async function runThroughTheBoundary(): Promise<void> {
    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
  }

  it('names the file, the moves, the frames in order and the spindle before CYCLE START', async () => {
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)

    expect(useMachineControl.getState().programReadiness).toMatchObject({
      ready: true,
      // THREE SECTIONS FOR TWO SETUPS, and the load line says why: the file
      // stops its spindle on line 20 and then retracts on line 22, so that
      // retract is a section of its own that runs with the spindle off.
      // IT NOW NAMES THE TOOL, AND SAYS WHAT IT READ AND CARRIED WITHOUT
      // CHANGING (architect re-scope: "words that change nothing this route can
      // honour are ACCEPTED and said once, not refused").
      reason:
        'Program "two-setup.nc" loaded: 10 moves in 3 sections - G54, then G55, then G55 - the '
        + 'spindle at 12000 RPM CW, which this machine has no link to drive - start it yourself '
        + 'before CYCLE START. It runs one tool: T1 (6 mm flat end mill). '
        + 'The file commands flood coolant, and this machine states no such output - switch it on '
        + 'at the machine. The file stops the spindle on line 20 - the moves after it run with the '
        + 'spindle off. Read and carried by this route without changing it: G64 (path blending - a '
        + 'controller hint; this route stages the moves the file states and the board blends them '
        + 'by its own settings); G94 (feed per minute - the only feed mode this app has, so it '
        + 'changes nothing).',
    })
    expect(currentOperatorTransport().action).toBe('start')
  })

  it('WO-2642: a file opened from disk names the library tool even when this project gives another tool that number', async () => {
    // Rholand 10-06 8:30 PM: the project's per-program numbers describe only programs
    // posted from it. An unrelated .nc using T1 still reads the library's T1.
    useCamStore.setState((s) => ({ project: { ...s.project, postToolNumbers: { t2: 1 } } }))
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)
    expect(useMachineControl.getState().programReadiness?.reason).toContain('It runs one tool: T1 (6 mm flat end mill).')
  })

  it('selects G54 and stages ONLY the G54 section before the operator starts', async () => {
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(5)'])
    const staged = socket().loadMovesFrames()[0].moves
    // The file's OWN numbers, in the file's own order, ending on the file's own
    // inter-section retract. Nothing appended, nothing dropped.
    expect(staged.map((move) => move.to)).toEqual([
      { x: 0, y: 0, z: 10 },
      { x: 0, y: 0, z: -1 },
      { x: 50, y: 0, z: -1 },
      { x: 50, y: 40, z: -1 },
      { x: 50, y: 40, z: 10 },
    ])
    expect(useMachineControl.getState().activeWcs).toBe('G54')
  })

  it('stages a G4 dwell on the wire between the moves around it', async () => {
    await operatorOpensFile(
      'dwell.nc',
      'G21 G90 G54\nG0 X0 Y0 Z10\nG4 P500\nG1 X10 F300\nM30\n',
    )

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(3)'])
    expect(socket().loadMovesFrames()[0].moves).toMatchObject([
      { kind: 'line', to: { x: 0, y: 0, z: 10 } },
      { kind: 'dwell', seconds: 0.5 },
      { kind: 'line', to: { x: 10, y: 0, z: 10 } },
    ])
    expect(useMachineControl.getState().programReadiness.reason).toContain(
      'G4 P (0.5s) (dwell will execute on the controller for 0.5 seconds)',
    )
  })

  it('stages a G4 dwell that follows the final stage-closing word', async () => {
    await operatorOpensFile(
      'spin-down-dwell.nc',
      'G21 G90 G54\nM3 S12000\nG1 X10 F300\nM5\nG4 P500\nM30\n',
    )

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(1)'])
    expect(socket().loadMovesFrames()[0].moves).toMatchObject([
      { kind: 'line', to: { x: 10 } },
    ])
    expect(socket().loadMovesFrames()[0].moves[0].to).toEqual({ x: 10 })
    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(1)', 'loadMoves(1)'])
    expect(socket().loadMovesFrames()[1].moves).toMatchObject([
      { kind: 'dwell', seconds: 0.5 },
    ])
    expect(useMachineControl.getState().programReadiness.reason).toContain(
      'G4 P (0.5s) (dwell will execute on the controller for 0.5 seconds)',
    )
  })

  it('loads 200,000 staged moves without an argument-count ceiling', async () => {
    const lines = ['G21', 'G90', 'G54', 'M3 S12000', 'G0 X10 Y10 Z5', 'G1 Z-1 F600']
    for (let n = 0; n < 200_000; n++) {
      lines.push(`G1 X${n % 100} Y${n % 2}`)
    }
    lines.push('G0 Z5', 'M5', 'M30')

    await operatorOpensFile('long-finish.nc', `${lines.join('\n')}\n`)

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready, readiness.reason ?? '(no reason given)').toBe(true)
    expect(socket().loadMovesFrames()[0].moves.length).toBeGreaterThan(0)
  }, 120_000)

  it('HOLDS at the section boundary and names the file, then switches on CYCLE START', async () => {
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)
    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    // No G55 and no second section until the operator says go.
    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(5)'])
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(consoleText()).toContain(
      '"two-setup.nc" has finished everything it runs in G54 and the tool has lifted to where the '
      + 'file left it. Set up for G55, then press CYCLE START to run the rest.',
    )

    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(socket().wireOrder()).toEqual([
      'selectWcs(G54)',
      'loadMoves(5)',
      'selectWcs(G55)',
      'loadMoves(4)',
    ])
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    expect(useMachineControl.getState().job.phase).toBe('streaming')
  })

  /** THE M5 IS NOT A HOLD. The file stops its spindle on line 20 and moves
   *  again on line 22, so the program runs straight on - the operator is never
   *  asked to press a button the file did not ask for - and the retract is
   *  staged as its own part with the spindle stopped in the gap before it. */
  it('runs on through the M5 without asking the operator, and stages the retract after it', async () => {
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)
    await runThroughTheBoundary()
    const beforeM5 = consoleText()

    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(socket().wireOrder()).toEqual([
      'selectWcs(G54)',
      'loadMoves(5)',
      'selectWcs(G55)',
      'loadMoves(4)',
      'loadMoves(1)',
    ])
    // The post-M5 move is the file's own final retract, and nothing held.
    expect(socket().loadMovesFrames().at(-1)!.moves.map((move) => move.to))
      .toEqual([{ x: 50, y: 40, z: 10 }])
    // NOT PAUSED, and nothing asked the operator for anything: the file did not
    // ask to stop here, so neither does the program.
    expect(useMachineControl.getState().job.phase).not.toBe('paused')
    expect(consoleText().slice(beforeM5.length)).not.toContain('CYCLE START')
  })

  it('never switches while the tool is down: the frame change is refused, not deferred', async () => {
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)
    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(5)'])
    expect(useMachineControl.getState().activeWcs).toBe('G54')
    expect(useMachineControl.getState().job.phase).toBe('failed')
    expect(consoleText()).toContain('The tool is at machine Z 1.00 mm')
  })

  /** A ONE-SECTION FILE IS THE UNCHANGED SINGLE-LOAD PATH. Nothing about this
   *  order may make a plain file behave like a multi-part program: one
   *  selectWcs, one loadMoves, one completion, and no boundary hold anywhere. */
  it('runs a one-section file as an ordinary single load', async () => {
    await operatorOpensFile(
      'one-section.nc',
      'G21 G90 G54\nG0 X0 Y0 Z10\nG1 Z-1 F300\nX20 F600\nG0 Z10\nM30\n',
    )

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(4)'])
    expect(useMachineControl.getState().programReadiness).toMatchObject({
      ready: true,
      reason: 'Program "one-section.nc" loaded: 4 moves in G54 - no spindle command.',
    })

    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(consoleText()).not.toContain('press CYCLE START to run the rest')
  })

  /** M0 IS THE BOUNDARY, WITHOUT THE FRAME CHANGE. The file stops where it says
   *  it stops, the operator is told which line, and CYCLE START runs the rest in
   *  the SAME frame - no second selectWcs to a frame nobody asked for. */
  it('holds at an M0 in the same frame and continues on CYCLE START', async () => {
    await operatorOpensFile(
      'hold.nc',
      'G21 G90 G54\nG0 X0 Y0 Z10\nG1 Z-1 F300\nG0 Z10\nM0\nG0 X20\nG1 Z-1 F300\nG0 Z10\nM30\n',
    )
    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(3)'])

    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(consoleText()).toContain(
      '"hold.nc" stopped at the M0 on line 5. Press CYCLE START to run the rest in G54.',
    )

    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(socket().wireOrder()).toEqual([
      'selectWcs(G54)',
      'loadMoves(3)',
      'selectWcs(G54)',
      'loadMoves(3)',
    ])
    expect(useMachineControl.getState().job.phase).toBe('streaming')
  })

  it('runs the whole file to one completion', async () => {
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)
    await runThroughTheBoundary()
    // Section 2 ends at the M5; section 3 is the retract after it, advanced to
    // without an operator gesture.
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 10,
      ackedLines: 10,
    })
  })

  /**
   * THE DESK ACCEPTANCE OF THIS ORDER, IN ONE TEST.
   *
   * "A posted file of the two-setup project stages the same moves as Load ->
   * All setups does - that equality is the desk acceptance." So both routes run
   * here, one after the other, on the same project, the same panel and the same
   * kind of wire, and what reached the wire is compared frame by frame.
   *
   * THE ONE DIFFERENCE, NAMED RATHER THAN HIDDEN: the file ends with the post's
   * postamble retract (`G0 Z10`, line 22). A toolpath has no postamble, so the
   * toolpath route's last stage ends on its last cut. Every other move, in both
   * frames, is identical - including the inter-section lift, which the file
   * states itself and this route therefore does not invent.
   *
   * That one move is now staged as its own part, because the file stops the
   * spindle on line 20 before making it (M5). Both frames still carry exactly
   * the toolpath route's moves; the difference is a third frame with the one
   * move in it, and no `selectWcs` in front of it.
   */
  it('stages the same moves the toolpath route stages, move for move, in both frames', async () => {
    await operatorLoadsAllSetups()
    await runThroughTheBoundary()
    const toolpathOrder = socket().wireOrder()
    const toolpathFrames = socket().loadMovesFrames().map((frame) => frame.moves.map((m) => m.to))

    // A SECOND CONNECTION, so the file route meets a wire with nothing on it -
    // the same state the operator's machine is in when they open a file.
    await act(async () => {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
    })
    cleanup()
    await connect('bridge')
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)
    await runThroughTheBoundary()
    // On to the end: the M5's section boundary needs no operator gesture.
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const fileOrder = socket().wireOrder()
    const fileFrames = socket().loadMovesFrames().map((frame) => frame.moves.map((m) => m.to))

    // THE BOUNDARY AND BOTH FRAMES, IN THE SAME ORDER. The only difference is
    // the file's own postamble retract, staged after its M5.
    expect(toolpathOrder).toEqual(['selectWcs(G54)', 'loadMoves(5)', 'selectWcs(G55)', 'loadMoves(4)'])
    expect(fileOrder).toEqual([
      'selectWcs(G54)',
      'loadMoves(5)',
      'selectWcs(G55)',
      'loadMoves(4)',
      'loadMoves(1)',
    ])

    // MOVE FOR MOVE. Both frames are identical outright.
    expect(fileFrames[0]).toEqual(toolpathFrames[0])
    expect(fileFrames[1]).toEqual(toolpathFrames[1])
    // And the extra one is the postamble lift the FILE ends with, in the frame
    // it was already in - no second selectWcs in front of it.
    expect(fileFrames[2]).toEqual([{ x: 50, y: 40, z: 10 }])

    // THE ARTEFACT, WRITTEN ONLY WHEN ASKED (WO-1093's rule): what actually
    // reached the wire on both routes, so the comparison above can be read by
    // someone who did not run the test. Never written by an ordinary slice.
    if (process.env.WRITE_EVIDENCE === '1') {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync('src/tests/evidence/WO-1335', { recursive: true })
      writeFileSync(
        'src/tests/evidence/WO-1335/wire-both-routes.json',
        `${JSON.stringify({
          note: 'Captured from the rendered ProgramPanel over a fake bridge socket, '
            + 'src/tests/machine/gcodeTextRoute.wo1335.test.tsx. Desk evidence (Tier 2) only.',
          toolpathRoute: { order: toolpathOrder, frames: toolpathFrames },
          fileRoute: { order: fileOrder, frames: fileFrames },
        }, null, 2)}
`,
      )
      writeFileSync('src/tests/evidence/WO-1335/two-setup.nc', TWO_SETUP_NC)
    }
  })
})

describe('WO-1335: what a posted file refuses before the first move', () => {
  it('stages NONE of the file when it names a frame the controller has not set', async () => {
    bridgeG55Offset = OFFSET_WITHOUT_Z
    await connect('bridge')
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)

    expect(socket().wireOrder()).toEqual([])
    // WO-1980: the file is kept for G55 rather than refused; nothing is staged
    // until G55 is known, and Cycle Start before then says so.
    expect(useMachineControl.getState().programReadiness).toMatchObject({
      ready: false,
      reason: '"two-setup.nc" waits for G55 - set G55 first.',
    })
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .toContain('it runs in G55 from line 14')
  })

  it('converts an inch file and stages canonical millimetres', async () => {
    await connect('bridge')
    await operatorOpensFile('inches.nc', 'G90\nG20\nG54\nG0 X1 Y1 Z1\nM30\n')

    expect(socket().wireOrder()).toEqual(['selectWcs(G54)', 'loadMoves(1)'])
    expect(socket().loadMovesFrames()[0].moves[0].to).toEqual({ x: 25.4, y: 25.4, z: 25.4 })
    expect(useMachineControl.getState().programReadiness.reason).toContain('millimetres')
  })

  it('refuses a file whose move leaves the table, naming the line', async () => {
    await connect('bridge')
    // G54 sits at machine X 10 and the table ends at 600, so work X 700 is off it.
    await operatorOpensFile('offtable.nc', 'G21 G90 G54\nG0 X1 Y1 Z1\nG0 X700\nM30\n')

    expect(socket().wireOrder()).toEqual([])
    expect(useMachineControl.getState().programReadiness.reason).toContain('line 3')
  })

  // WO-2833 (the operator, 10-15: "a refused Load disarms A too - Cycle
  // Start greyed until a file is armed") replaces WO-2686 fix round 6's "the
  // accepted file keeps its readiness, untouched" for a file that is armed.
  it('a later file the reader refuses stages nothing and disarms the armed file: CYCLE START greyed', async () => {
    await connect('bridge')
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(currentOperatorTransport().cycleStartEnabled).toBe(true)
    const stagedBefore = socket().wireOrder()
    const lastId = useMachineControl.getState().consoleLines.at(-1)?.id ?? 0

    // G91 IS NOW CONVERTED and G28 runs homed or not (WO-1644), so the
    // refusing word here is one the dialect's word table does not carry.
    await operatorOpensFile('bad.nc', 'G21 G90 G54\nG33 X1\nG0 X1\nM30\n')
    // Nothing of bad.nc reaches the board.
    expect(socket().wireOrder()).toEqual(stagedBefore)
    // The refusal is one red console line.
    const said = useMachineControl.getState().consoleLines
      .filter((line) => line.id > lastId && line.text.includes('G33 is not in the'))
    expect(said.map((line) => line.severity)).toEqual(['error'])
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    // two-setup.nc is disarmed: nothing is armed, and CYCLE START is greyed.
    expect(useMachineControl.getState().job.name).toBeNull()
    expect(useMachineControl.getState().job.phase).not.toBe('ready')
    expect(currentOperatorTransport()).toMatchObject({ cycleStartEnabled: false, cycleStartDetail: 'No program is armed.' })
  })

  it('refuses a file on a controller with no program route at all', async () => {
    // Never connected: nothing declares a program route, so there is nothing to
    // stage a file onto and the refusal says which move to make next.
    const loaded = loadGcodeTextToolpathProgram('two-setup.nc', TWO_SETUP_NC)
    expect(loaded.ok).toBe(false)
    expect(loaded.reason).toContain('it reports no program route')
  })
})

// ---------------------------------------------------------------------------
// OPERATOR'S ACCEPTANCE, item 2, THE HALF THAT MATTERS AT THE MACHINE: "never
// partially executed, never silently dropped ... a test per case showing
// NOTHING REACHED THE WIRE."
//
// The interpreter's own negative corpus lives in
// `src/tests/gcode/interpret.wo1335.test.ts` and proves each case refuses at
// the right line carrying no program. This drives the SAME corpus through the
// rendered panel onto a real `UccncController` over the bridge socket, and
// checks the only thing a board cares about: the `sent` list is empty.
//
// AND IT CHECKS THE SECOND THING, which is what a "silent no-op" was: the
// operator is TOLD. Every refusal lands in the console naming the line.
// ---------------------------------------------------------------------------

const { NEGATIVE_CORPUS } = await import('../gcode/interpret.wo1335.test')

describe('WO-1335 acceptance item 2: a malformed file reaches no wire and is never silent', () => {
  beforeEach(async () => { await connect('bridge') })

  it.each(NEGATIVE_CORPUS.map((entry) => [entry.name, entry] as const))(
    'nothing reaches the board: %s',
    async (name, entry) => {
      // The G53 case needs a frame the controller has not reported; this bridge
      // reports every frame, so it is exercised against G56 - unset here.
      // ONE CASE IS NOT A PRODUCT CASE: the live door always declares
      // millimetres, so "no units word and no machine units" cannot be reached
      // through it. The interpreter's own corpus proves that refusal; driving
      // it here would be testing a caller this product does not have.
      if (entry.machineUnits === undefined && 'machineUnits' in entry) return
      const gcode = name.includes('G53') ? entry.gcode.replace('G54', 'G56') : entry.gcode
      // EVERYTHING THE CONNECTION ITSELF SENT, BEFORE THE FILE - the handshake,
      // the single-block mode, the offset reconciliation. The file must add
      // NOTHING to this list; comparing against an empty one would be comparing
      // against a connection that never happened.
      const beforeTheFile = socket().sent.map((m) => m.m)
      await operatorOpensFile('bad.nc', gcode)

      // NOTHING. Not a selectWcs, not a loadMoves, not a startJob.
      expect(socket().sent.map((m) => m.m)).toEqual(beforeTheFile)
      expect(socket().wireOrder()).toEqual([])
      expect(useMachineControl.getState().programReadiness.ready).toBe(false)
      // AND THE OPERATOR WAS TOLD, which is the whole difference from the
      // silent no-op Operator watched on 2026-09-11.
      expect(consoleText()).toContain('bad.nc')
      expect(consoleText()).toContain(`Line ${entry.line}:`)
    },
  )
})

// ---------------------------------------------------------------------------
// OPERATOR'S ACCEPTANCE, item 1, third part: "the simulator run of each corpus file
// to completion with the staged moves compared against the file."
//
// Run here against the BRIDGE rather than the simulator, which is strictly
// stronger for the question asked - "exactly what goes through the bridge" is
// read off the bridge's own `loadMoves` frames - and every loadable corpus file
// is run to its LAST part, with what was staged compared against what the
// interpreter read from the file, move for move.
// ---------------------------------------------------------------------------

const RUNNABLE_CORPUS = [
  'src/tests/fixtures/foreign-gcode/liencam-own-post-baseline.nc',
  'src/tests/evidence/WO-240/wo240-export.nc',
  'src/tests/evidence/WO-023/wo023-square.nc',
  'src/tests/evidence/WO-1171/same-program-grblhal.nc',
  // EVERY LOADABLE CORPUS FILE, which now means these two as well. They read
  // correctly (`interpret.wo1335.test.ts` pins both as LOADING) but were posted
  // for machines whose work zeros sit elsewhere: their work coordinates run to
  // X -354 / Y -347, so against the 600x400 fixture with G54 at machine X 10
  // they are off the table and the travel check refuses them by line. That was
  // the check doing its job on a table those files were never posted for, and
  // leaving them out of the run meant acceptance item 1 was short by two files.
  // The fixture below is therefore a machine they FIT - a bigger table with the
  // work zeros far enough from the limits - and the travel check is unchanged
  // and still proven by the `offtable.nc` case above.
  'src/tests/evidence/WO-387/wo387-mesh-sim.nc',
  'src/tests/evidence/WO-416/mesh-program.nc',
  // THE THREE THE ARCHITECT'S RE-SCOPE UNBLOCKED, and the first of them is one
  // of the two files the acceptance names by name: our own post's 237-line
  // two-setup program, which was refused at line 86 for the `T2 M6` in its own
  // output. It now loads, holds at the tool change, and runs to the end.
  'src/tests/evidence/WO-1312/two-setup-combined-posted.nc',
  'src/tests/evidence/WO-1277/two-speed-same-tool.nc',
  'src/tests/evidence/WO-023/wo023-g91.nc',
]

/** The corpus fixture's zeros: far enough from the machine limits that a file
 *  posted in negative work coordinates still lands on the table. */
const CORPUS_G54_OFFSET = { x: 400, y: 400, z: 60 }
const CORPUS_G55_OFFSET = { x: 500, y: 400, z: 60 }

describe('WO-1335 acceptance item 1: every loadable corpus file runs to completion', () => {
  beforeEach(async () => {
    // These files were posted for real machines and reach real coordinates, so
    // the travel the program is checked against is the whole board, and the
    // work zeros are where such a machine's are. The check itself is unchanged -
    // it is the TABLE that is bigger, not the rule.
    corpusMachine = true
    bridgeG54Offset = CORPUS_G54_OFFSET
    bridgeG55Offset = CORPUS_G55_OFFSET
    twoSetupProject()
    await connect('bridge')
  })

  it.each(RUNNABLE_CORPUS.map((path) => [path.split('/').at(-1)!, path] as const))(
    '%s',
    async (name, path) => {
      const { readFileSync } = await import('node:fs')
      const text = readFileSync(path, 'utf8')

      // WHAT THE FILE SAYS, read independently of the door, so the comparison
      // below is against the FILE and not against the door's own opinion.
      const read = interpretGcodeProgram(text, {
        dialect: 'uccnc',
        sessionWcs: 'G54',
        initialPosition: { x: 0, y: 0, z: 0 },
        machineUnits: 'mm',
        workOffsets: {
          G54: { ...CORPUS_G54_OFFSET },
          G55: { ...CORPUS_G55_OFFSET },
          G56: { ...ZERO_OFFSET },
          G57: { ...ZERO_OFFSET },
          G58: { ...ZERO_OFFSET },
          G59: { ...ZERO_OFFSET },
        },
      })
      if (!read.ok) throw new Error(`${name} was refused: ${read.refusal.message}`)

      await operatorOpensFile(name, text)
      expect(useMachineControl.getState().programReadiness.ready).toBe(true)

      // RUN IT TO THE END, crossing every boundary the file declares. A
      // boundary the FILE holds at (an M0, or a frame change) needs the
      // operator's CYCLE START; one that is only the file's own M5 does not -
      // the file runs straight through it, so the program must too.
      const stages = read.program.stages
      // EVERY REASON THIS ROUTE HOLDS, spelled out - a frame change, a stop the
      // file states, a tool change, a macro this app cannot run, and (on this
      // fixture, which declares no spindle link) a spindle the file starts and
      // the machine cannot command. Each is something the OPERATOR has to do.
      const holdsBefore = (index: number): boolean => index > 0 && index < stages.length && (
        stages[index].wcs !== stages[index - 1].wcs
        || stages[index - 1].ends.kind === 'hold'
        || stages[index - 1].ends.kind === 'tool-change'
        || stages[index - 1].ends.kind === 'macro'
        || stages[index].heldBefore !== null
        || stages[index].macroBefore !== null
        || stages[index].toolChangeBefore !== null
        // A SPINDLE THIS FIXTURE CANNOT COMMAND, started OR changed: cutting
        // the next section at the previous section's speed is the same class of
        // wrong as cutting it with the spindle off.
        || (stages[index].spindleOn && (
          !stages[index - 1].spindleOn
          || stages[index].spindle?.rpm !== stages[index - 1].spindle?.rpm
          || stages[index].spindle?.direction !== stages[index - 1].spindle?.direction
        ))
      )
      expect(await executeOperatorCycleStart()).toBe(true)
      let lastZ = 0
      for (let stage = 0; stage < stages.length; stage++) {
        const finished = stages[stage]
        // A stop-only stage (an M0 right after an M6, owner ruling 10-04) has no moves:
        // the machine is still where the stage before it left it.
        lastZ = finished.moves.at(-1)?.z ?? lastZ
        const offset = finished.wcs === 'G55' ? CORPUS_G55_OFFSET : CORPUS_G54_OFFSET
        emitStatus({
          ...idleBridgeStatus(lastZ + offset.z),
          buffer: { moves: 0, capacitySeconds: null },
        })
        act(() => {
          socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        if (holdsBefore(stage + 1)) {
          expect(useMachineControl.getState().job.phase).toBe('paused')
          await act(async () => {
            await executeOperatorCycleStart()
            await vi.advanceTimersByTimeAsync(10)
          })
        }
      }

      // EVERY MOVE THE FILE COMMANDS, IN ORDER, WITH EXACTLY THE AXES THE FILE
      // HAS ESTABLISHED - read back off the bridge's own frames. Omitted axes
      // stay omitted on the wire, then the independent modal reconstruction
      // below proves that sparse shape still describes the complete geometry.
      // A stop-only stage (an M0 right after an M6, owner ruling 10-04) is staged as one
      // zero-length dwell so the hold has something to hold before; it is not motion.
      const staged = socket().loadMovesFrames().flatMap((frame) => frame.moves
        .filter((m) => !(m.kind === 'dwell' && !m.to))
        .map((m) => m.to))
      const commanded = stages.flatMap((stage) =>
        stage.moves.map((move) => ({ x: move.x, y: move.y, z: move.z })))
      const sourceIntent = stages.flatMap((stage) => stage.moves.map((move) => {
        const axes = (move as typeof move & { executionAxes?: readonly ('x' | 'y' | 'z')[] }).executionAxes
        return Object.fromEntries((axes ?? ['x', 'y', 'z']).map((axis) => [axis, move[axis]]))
      }))
      expect(staged).toEqual(sourceIntent)
      let modal = { x: 0, y: 0, z: 0 }
      const stagedGeometry = staged.map((to) => {
        if (!to) throw new Error('The corpus comparison expects every staged item to be a motion move.')
        modal = { x: to.x ?? modal.x, y: to.y ?? modal.y, z: to.z ?? modal.z }
        return { ...modal }
      })
      expect(stagedGeometry).toEqual(commanded)
      // AND THE FRAMES, IN THE FILE'S OWN ORDER - never a frame the file did
      // not ask for. A section that ends at an M5 changes no frame, so the
      // comparison is between the two sequences with their repeats collapsed.
      const collapse = (frames: string[]): string[] =>
        frames.filter((frame, index) => index === 0 || frame !== frames[index - 1])
      const selected = socket().sent
        .filter((m) => m.m === 'selectWcs')
        .map((m) => (m.a as { wcs: string }).wcs)
      expect(collapse(selected)).toEqual(collapse(read.program.frames))
      expect(useMachineControl.getState().job.phase).toBe('complete')
    },
  )

  it("OPENS OPERATOR'S OWN FUSION FILE, through the panel, with an EMPTY tool library", async () => {
    // THE REGRESSION THIS ORDER EXISTS FOR, and it is deliberately measured the
    // way he hits it: the real 2.4 MB file, handed to the rendered panel's file
    // input, on a session whose tool library knows nothing about tool 19.
    //
    // The old test that claimed this file ran passed
    // `resolveToolLengthShiftMm: () => ({ ok: true, shiftMm: 0 })` - a stub that
    // handed the reader the answer the product refused to give. It proved a
    // path no operator can take. Nothing is stubbed here.
    const text = readFileSync(
      join(__dirname, '../fixtures/foreign-gcode/fusion-liencnc-v2-sample.nc'),
      'utf8',
    )
    expect(useCamStore.getState().toolLibrary.some((t) => t.toolNumber === 19)).toBe(false)

    await operatorOpensFile('Fusion Example for LienCAM.nc', text)

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready, readiness.reason ?? '(no reason given)').toBe(true)
    // The words that used to end this file's load, absent from the outcome.
    expect(readiness.reason).not.toContain('was not loaded')
    expect(readiness.reason).not.toContain('Tool Library')
    expect(consoleText()).toContain('G43 H19 on line 22 shifts Z by zero')
    // WO-1677: zero here because THIS machine's tool table holds no measured
    // length for tool 19 - what the operator's controller answers for an
    // unmeasured row - and the load line says so, once.
    expect(consoleText()).toContain('tool 19 has no measured length on this machine')
    // And the moves reached the wire, in bulk - not an empty "load" that
    // reported success and staged nothing.
    expect(socket().loadMovesFrames().length).toBeGreaterThan(0)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// FIX ROUND, AUDIT FINDING 1, ON THE WIRE.
//
// "M5 is accepted but silently discarded before later staged motion." The
// finding named the exact consequence: `two-setup.nc` stops its spindle on line
// 20 and retracts on line 22, so on a machine with the VFD link that retract ran
// with the spindle still commanded on, and no test observed an OFF command
// before it - the fixture above declares `spindleCommands: false`, so there was
// nothing to observe.
//
// This is that machine: the bridge declares an inverter, the machine record
// carries the link, and what reaches the wire is read back in order.
// ---------------------------------------------------------------------------

describe("WO-1335 fix round: the file's M5 reaches the inverter before the move after it", () => {
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
      .map((m) => (m.m === 'selectWcs'
        ? `selectWcs(${(m.a as { wcs: string }).wcs})`
        : m.m === 'loadMoves'
          ? `loadMoves(${(m.a as { moves: unknown[] }).moves.length})`
          : m.m))
  }

  /** One `vfd` push at `actualRpm`, the way the bridge reports the inverter. */
  function pushVfd(actualRpm: number): void {
    act(() => {
      socket().emit({
        t: 'vfd',
        v: {
          up: true,
          running: true,
          faulted: false,
          runStateWord: 2,
          commandWord: 1,
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

  function finishStagedPart(machineZ: number): void {
    emitStatus({ ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  async function runSectionAtSpeed(): Promise<void> {
    pushVfd(12_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  }

  it('commands the spindle OFF at line 20, and stages the retract only after it', async () => {
    await operatorOpensFile('two-setup.nc', TWO_SETUP_NC)
    expect(await executeOperatorCycleStart()).toBe(true)
    await runSectionAtSpeed()
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves(5)', 'spindleOn', 'startJob'])

    // Section 1 ends at the file's own lift, the program holds for G55, and
    // WO-1323's rule stops the spindle while the operator is at the part.
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(wire().at(-1)).toBe('spindleOff')

    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
    await runSectionAtSpeed()
    expect(wire().slice(-4)).toEqual(['spindleOn', 'selectWcs(G55)', 'loadMoves(4)', 'startJob'])

    // THE M5 ON LINE 20. Section 2 ends there, and what the wire must show next
    // is the inverter stopped BEFORE the retract on line 22 is staged.
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(wire().slice(-3)).toEqual(['spindleOff', 'loadMoves(1)', 'startJob'])
    expect(socket().loadMovesFrames().at(-1)!.moves.map((move) => move.to))
      .toEqual([{ x: 50, y: 40, z: 10 }])
    expect(consoleText()).toContain(
      'Line 20: M5 - the spindle is stopped before the next move.',
    )
  })

  it('does not re-command the spindle at a hold that comes after the M5', async () => {
    // The file stops its spindle, lifts, stops the PROGRAM, and moves again.
    // The hold's CYCLE START is the same door that re-commands the spindle at a
    // section boundary - and here it must not, because the file stopped it.
    await operatorOpensFile(
      'stop-then-hold.nc',
      [
        'G21 G90 G54',
        'M3 S12000',
        'G0 X0 Y0 Z10',
        'G1 Z-1 F300',
        'G0 Z10',
        'M5',
        'G0 X5',
        'M0',
        'G0 X0 Y0',
        'M30',
        '',
      ].join('\n'),
    )
    expect(await executeOperatorCycleStart()).toBe(true)
    await runSectionAtSpeed()
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves(3)', 'spindleOn', 'startJob'])

    // The M5 on line 6: stopped, then the lift after it staged and run.
    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(wire().slice(-3)).toEqual(['spindleOff', 'loadMoves(1)', 'startJob'])

    // The M0 on line 8: the program holds, and the operator starts it again.
    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(useMachineControl.getState().job.phase).toBe('paused')
    const atTheHold = wire().length
    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(300)
    })

    // NOT ONE spindleOn: the file's intent was retired at line 6, not paused.
    expect(wire().slice(atTheHold)).toEqual(['selectWcs(G54)', 'loadMoves(1)', 'startJob'])
  })

  /** A FILE WHOSE M3 COMES AFTER SOME POSITIONING. CYCLE START must not start a
   *  spindle the file has not started yet - the word is commanded at the line
   *  that states it, and the moves behind it wait for speed. */
  it('starts the spindle at the file\'s own M3, not at CYCLE START', async () => {
    await operatorOpensFile(
      'late-spindle.nc',
      'G21 G90 G54\nG0 X0 Y0 Z10\nM3 S12000\nG1 Z-1 F300\nX20 F600\nG0 Z10\nM30\n',
    )
    expect(await executeOperatorCycleStart()).toBe(true)
    // The positioning move went with no spindle command at all.
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves(1)', 'startJob'])

    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    // The cut is staged and the spindle commanded - and NOTHING is released:
    // no startJob until the inverter reports speed, exactly as CYCLE START's
    // own gate holds it.
    expect(wire().slice(-2)).toEqual(['loadMoves(3)', 'spindleOn'])
    expect(consoleText()).toContain('Line 3: M3 - the spindle is commanded at 12000 RPM CW')

    await runSectionAtSpeed()
    expect(wire().at(-1)).toBe('startJob')
  })

  it('stops, dwells, then restarts across M5 / G4 / M3 in source order', async () => {
    await operatorOpensFile(
      'stop-dwell-restart.nc',
      [
        'G21 G90 G54', 'M3 S12000', 'G1 X10 F300', 'M5', 'G4 P500',
        'M3 S12000', 'G1 X20', 'M30', '',
      ].join('\n'),
    )
    expect(await executeOperatorCycleStart()).toBe(true)
    await runSectionAtSpeed()
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves(1)', 'spindleOn', 'startJob'])

    finishStagedPart(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(wire().slice(-3)).toEqual(['spindleOff', 'loadMoves(1)', 'startJob'])
    expect(socket().loadMovesFrames().at(-1)!.moves).toMatchObject([
      { kind: 'dwell', seconds: 0.5 },
    ])

    finishStagedPart(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(wire().slice(-2)).toEqual(['loadMoves(1)', 'spindleOn'])
    expect(wire().at(-1)).not.toBe('startJob')
    await runSectionAtSpeed()
    expect(wire().at(-1)).toBe('startJob')
  })
})

// ---------------------------------------------------------------------------
// THE AUDIT'S SECOND BLOCKING FINDING, 2026-09-11:
//
//   "a mid-file `M3` after earlier motion is not safely actionable on a machine
//    without a spindle link ... `applyGcodeSpindleWord` merely logs 'Start it at
//    the machine' ... `releasePart()` then runs immediately. Thus a file shaped
//    as positioning, `M3 S...`, then cutting motion gives the operator no hold
//    in which to start the spindle; the following cut is released automatically
//    ... turns the warning into an instruction the operator cannot perform
//    before the move it governs."
//
// The architect agreed and ruled: "A program that asks for a spindle this
// machine cannot command must HOLD there, say so, and wait for CYCLE START -
// the same shape as every other hold."
//
// THIS IS THE ORDINARY NO-LINK FIXTURE - `helloVfd` null and no
// `spindleLinkDefinition`, which is exactly the machine the audit named as
// uncovered. The old late-M3 test above runs the VFD-linked one and stays.
// ---------------------------------------------------------------------------

describe('WO-1335 fix round 2: a spindle this machine cannot command HOLDS at its own line', () => {
  beforeEach(async () => {
    twoSetupProject()
    await connect('bridge')
  })

  /** Every frame that moves the machine or the spindle, in wire order. */
  function wire(): string[] {
    return socket().sent
      .filter((m) => ['selectWcs', 'loadMoves', 'startJob', 'spindleOn', 'spindleOff'].includes(m.m))
      .map((m) => (m.m === 'selectWcs'
        ? `selectWcs(${(m.a as { wcs: string }).wcs})`
        : m.m === 'loadMoves'
          ? `loadMoves(${(m.a as { moves: unknown[] }).moves.length})`
          : m.m))
  }

  function finishStagedPart(machineZ: number): void {
    emitStatus({ ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  const LATE_SPINDLE = 'G21 G90 G54\nG0 X0 Y0 Z10\nM3 S12000\nG1 Z-1 F300\nX20 F600\nG0 Z10\nM30\n'

  it('holds before the cut the M3 governs, and names what the operator must do', async () => {
    await operatorOpensFile('late-spindle.nc', LATE_SPINDLE)
    expect(await executeOperatorCycleStart()).toBe(true)

    // The positioning move runs; nothing else is staged behind it yet.
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves(1)', 'startJob'])

    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    // THE HOLD. Before the fix this edge staged the cut and released it in the
    // same breath, so "start it at the machine" named something nobody could do
    // in time. Now the program is PAUSED and the wire has gained nothing.
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves(1)', 'startJob'])
    expect(consoleText()).toContain(
      '"late-spindle.nc" asks for the spindle at 12000 RPM CW on line 3, and this machine has no '
      + 'link to start it. Start the spindle at the machine, then press CYCLE START to run the rest.',
    )
  })

  it('runs the cut only after the operator presses CYCLE START', async () => {
    await operatorOpensFile('late-spindle.nc', LATE_SPINDLE)
    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(useMachineControl.getState().job.phase).toBe('paused')

    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
    // ONLY NOW are the three cutting moves staged and released - and no spindle
    // command went out at all, because this machine has no link to send one on.
    expect(wire().slice(-3)).toEqual(['selectWcs(G54)', 'loadMoves(3)', 'startJob'])
    expect(wire().some((entry) => entry.startsWith('spindle'))).toBe(false)
    expect(consoleText()).toContain(
      'Line 3: M3 - the file runs the next moves at 12000 RPM CW, and this machine has no link to '
      + 'start the spindle. Running on with the spindle you started.',
    )
  })
})

// ---------------------------------------------------------------------------
// THE ARCHITECT'S RE-SCOPE, ON THE WIRE. Each bullet of the new dialect,
// driven through the rendered panel onto a real `UccncController`.
// ---------------------------------------------------------------------------

describe('WO-1335 fix round 2: the re-scoped dialect, measured on the wire', () => {
  beforeEach(async () => {
    twoSetupProject()
    await connect('bridge')
  })

  function finishStagedPart(machineZ: number): void {
    emitStatus({ ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  /** Every move that reached the bridge, in order, across every frame. */
  function stagedMoves(): { x?: number; y?: number; z: number }[] {
    return socket().loadMovesFrames().flatMap(
      (frame) => frame.moves.flatMap((move) => move.to === undefined ? [] : [move.to]),
    )
  }

  it('holds at a tool change and names BOTH tools by their library names', async () => {
    // Our own post's shape: finish with T1, stop, lift, fit T2, carry on. It was
    // refused at the door before the re-scope, and the file the acceptance names
    // died on exactly this line.
    await operatorOpensFile(
      'two-tool.nc',
      [
        'G21 G90 G54', 'T1 M6', 'M3 S12000', 'G0 X0 Y0 Z10', 'G1 Z-1 F300',
        'G0 Z10', 'M5', 'T2 M6', 'M3 S12000', 'G0 X5 Y5 Z10', 'M30', '',
      ].join('\n'),
    )
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(consoleText()).toContain(
      'It runs 2 tools: T1 (6 mm flat end mill), then T2 (3 mm ball nose) - it holds at each change.',
    )

    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(consoleText()).toContain(
      '"two-tool.nc" has finished everything it cuts with T1 (6 mm flat end mill) and asks for '
      + 'T2 (3 mm ball nose) on line 8. The spindle is stopped and the tool is where the file left '
      + 'it: fit T2 (3 mm ball nose), set its Z zero, then press CYCLE START to run the rest.',
    )

    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
    // AND THE REST RUNS. Every move the file commands reached the wire, in the
    // file's own order - nothing was dropped at the boundary.
    expect(stagedMoves()).toEqual([
      { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 10 }, { x: 5, y: 5, z: 10 },
    ])
  })

  it('holds at a macro call it cannot run, naming it by number', async () => {
    // Fusion's UCCNC post emits `M2001` ("Park Position to Screw Down
    // Material"). Refusing it turns away a whole file for one line; dropping it
    // runs past something the operator was meant to do.
    await operatorOpensFile('macro.nc', 'G21 G90 G54\nG0 X0 Y0 Z10\nM2001\nG0 X5\nM30\n')
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(consoleText()).toContain(
      'The file calls a macro this app cannot run (M2001 on line 3) - the program holds there so '
      + 'you can do it at the machine.',
    )

    expect(await executeOperatorCycleStart()).toBe(true)
    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(consoleText()).toContain(
      '"macro.nc" stopped at the M2001 macro call on line 3, which this app cannot run. Do at the '
      + 'machine whatever that macro does, then press CYCLE START to run the rest.',
    )

    await act(async () => {
      await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(stagedMoves()).toEqual([{ x: 0, y: 0, z: 10 }, { x: 5, y: 0, z: 10 }])
  })

  it('stages the absolute moves an incremental file means', async () => {
    await operatorOpensFile(
      'incremental.nc',
      'G21 G90 G54\nG0 X0 Y0 Z10\nG91\nG0 X1\nX2\nG90\nG0 X10\nM30\n',
    )
    expect(stagedMoves()).toEqual([
      { x: 0, y: 0, z: 10 }, { x: 1, y: 0, z: 10 }, { x: 3, y: 0, z: 10 }, { x: 10, y: 0, z: 10 },
    ])
  })

  /** T3 exists in the session's library only where a test needs a third
   *  number; it stands 20 mm further out of the holder than T1 and T2. */
  function libraryWithT3(): void {
    useCamStore.setState({
      toolLibrary: [
        ...useCamStore.getState().toolLibrary,
        makeTool({ id: 't3', toolNumber: 3, name: 'long reach', overallLength: 80 }),
      ],
    })
  }

  it('loads a G43 H the tool library knows, and says the shift is zero', async () => {
    // THE ORDINARY CASE, AND WHAT EVERY UCCNC POST EMITS: `T3 M6 ... G43 H3`.
    libraryWithT3()
    await operatorOpensFile('tlo.nc', 'G21 G90 G54\nT3 M6\nG43 H3\nG0 X0 Y0 Z10\nG49\nG0 Z10\nM30\n')
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(stagedMoves()).toEqual([{ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }])
    expect(consoleText()).toContain('G43 H3 on line 3 shifts Z by zero')
  })

  it('WO-1677: a G43 H a MACHINE tool table has MEASURED shifts by that length, not zero', async () => {
    // THE ACCEPTANCE CLAIM: machine A, tool 3 measured 45.2 mm - the load
    // line states that length, not the unmeasured-row zero, and the Z the
    // H governs is STAGED carrying it (Z-40 -> 5.2); the Z after G49 is not.
    // The file's Z sits low so the lifted move stays inside this fixture's
    // +50 Z travel - the travel check now sees the true machine Z.
    // Only the session's own tool table answers for H, which is why this is
    // set on `useMachineToolTable`, not the project's library.
    libraryWithT3()
    const toolTableMachineId = useCamStore.getState().project.machine!.id
    const table = useMachineToolTable.getState()
    table.addTool(toolTableMachineId, 1)
    table.addTool(toolTableMachineId, 3)
    table.recordProbedZ(toolTableMachineId, 1, 0, Date.now())
    table.recordProbedZ(toolTableMachineId, 3, 45.2, Date.now())
    table.setReference(toolTableMachineId, 1)
    await operatorOpensFile('tlo-measured.nc', 'G21 G90 G54\nT3 M6\nG43 H3\nG0 X0 Y0 Z-40\nG49\nG0 Z10\nM30\n')
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(stagedMoves().map((to) => ({ ...to, z: Number(to.z.toFixed(4)) })))
      .toEqual([{ x: 0, y: 0, z: 5.2 }, { x: 0, y: 0, z: 10 }])
    expect(consoleText()).toContain(
      "G43 H3 on line 3 shifts Z by 45.20 mm, tool 3's measured length on this machine",
    )
    expect(consoleText()).not.toContain('no measured length')
  })

  it('WO-1677: a G43 H a MACHINE tool table has NOT measured shifts by zero, and says so once', async () => {
    // MACHINE B: the same file, an empty tool table - the operator's own
    // controller would apply zero for an unmeasured row, so this does too,
    // and names the tool so it is never a silent zero.
    libraryWithT3()
    await operatorOpensFile('tlo-unmeasured.nc', 'G21 G90 G54\nT3 M6\nG43 H3\nG0 X0 Y0 Z10\nG49\nG0 Z10\nM30\n')
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(stagedMoves()).toEqual([{ x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }])
    const text = consoleText()
    expect(text).toContain('G43 H3 on line 3 shifts Z by zero - tool 3 has no measured length on this machine')
    expect(text.match(/no measured length/g)?.length).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 2026-09-12: THE REFUSALS THAT USED TO LIVE HERE ARE GONE, AND THIS IS WHY.
  //
  // Operator, at the machine, on his own Fusion file: "This is not acceptable. DO
  // not do this shit. This file runs just fine in the UCCNC software. If yours
  // does not it is your fault, not the gcode file."
  //
  // It died at line 22 on `G43 H19` because his Tool Library carried no tool
  // numbered 19 - Fusion's numbering, not LienCAM's - and the sentence the app
  // printed asked him to go renumber his library. Behind that gate sat a
  // resolver whose only successful answer was zero. Three refusals guarded a
  // constant.
  //
  // WO-1677: the H is resolved against the machine's tool table and its
  // length is folded into every Z it governs, so the staged moves carry it
  // and no work offset is written. A tool with no measured length applies zero - what UCCNC's
  // and LinuxCNC's tables answer for an unmeasured row - and the load line
  // says so once. So these three LOAD, on any table.
  // -------------------------------------------------------------------------

  it('loads a G43 H no tool in the library carries - the number indexes nothing here', async () => {
    await operatorOpensFile('tlo-unknown.nc', 'G21 G90 G54\nT9 M6\nG43 H9\nG0 X0 Y0 Z10\nM30\n')
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(stagedMoves()).toEqual([{ x: 0, y: 0, z: 10 }])
    expect(consoleText()).toContain('G43 H9 on line 3 shifts Z by zero')
  })

  it('loads an H naming a tool that is not in the spindle, staging the file own Z', async () => {
    libraryWithT3()
    await operatorOpensFile('tlo-other.nc', 'G21 G90 G54\nT1 M6\nG43 H3\nG0 X0 Y0 Z10\nM30\n')
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(stagedMoves()).toEqual([{ x: 0, y: 0, z: 10 }])
  })

  it('loads an H naming a tool a standalone T only preselected', async () => {
    libraryWithT3()
    await operatorOpensFile(
      'preselect.nc',
      'G21 G90 G54\nT1 M6\nM3 S12000\nG0 X0 Y0 Z10\nT2\nG43 H1\nG1 Z-1 F300\nG0 Z10\nM30\n',
    )
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(stagedMoves()).toEqual([
      { x: 0, y: 0, z: 10 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 10 },
    ])
    // A preselect fits nothing, so this program runs ONE tool and holds at no
    // tool change - the console says so from the in-spindle state.
    expect(consoleText()).toContain('It runs one tool: T1 (6 mm flat end mill).')
  })

})

// ---------------------------------------------------------------------------
// FIX ROUND 3, AUDIT FINDING 1: THE COOLANT A FILE ASKS FOR TAKES THE MACHINE'S
// OWN COOLANT PATH.
//
// The audit failed round 2 on the word table claiming "a configured coolant
// output is sent through the machine's action lines" while `applyGcodeCoolantWord`
// only wrote a console warning. The architect ruled the TABLE right and the code
// short: "SpindlePanel commands Mist/Flood through `runMachineAction`, and it
// only shows those buttons on a machine that declares the outputs ... So M7/M8/M9
// from a file take THAT SAME PATH when the machine record declares the output,
// and print one console line naming what the file asked for when it does not."
//
// What is measured below, on both kinds of machine:
//   - a machine whose record STATES flood: the machine's OWN configured flood
//     line is sent, at the line the file states it, and the machine's flood
//     output comes ON - read off the controller's own accessory report, not off
//     anything this software says about itself,
//   - an operator OVERRIDE for that action: the override goes, never a
//     hardcoded M8,
//   - a machine that states NO such output: nothing is sent, and the word is
//     named once as the operator's to switch,
//   - Operator's own class of machine (a geometry controller that takes no command
//     lines at all): the controller is still ASKED, and its refusal is named at
//     the line instead of being swallowed,
//   - and the operator's own MDI is still locked out for the whole length of a
//     running program, which is the rule the file's own words travel past.
// ---------------------------------------------------------------------------

describe("WO-1335 fix round 3: a file's coolant takes the machine's own coolant path", () => {
  beforeEach(async () => {
    twoSetupProject()
  })

  function finishStagedPart(machineZ: number): void {
    emitStatus({ ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  const COOLANT_NC = 'G21 G90 G54\nM8\nG0 X0 Y0 Z10\nG1 Z-1 F300\nM9\nG0 Z10\nM30\n'

  it('states no such output: nothing is sent, and the word is named once at its line', async () => {
    await connect('bridge')
    await operatorOpensFile('coolant.nc', COOLANT_NC)
    expect(consoleText()).toContain(
      'The file commands flood coolant, and this machine states no such output - switch it on at '
      + 'the machine.',
    )

    expect(await executeOperatorCycleStart()).toBe(true)
    // THE PREAMBLE M8 FALLS DUE AT THE RELEASE, not at load: a machine sitting
    // loaded is not a machine that should be wet.
    expect(consoleText()).toContain(
      'Line 2: the file switches flood coolant on here, and this machine states no such output - '
      + 'switch it at the machine.',
    )
    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(consoleText()).toContain(
      'Line 5: the file switches coolant off here, and this machine states no such output - switch '
      + 'it at the machine.',
    )
    // NOTHING WAS ASKED OF THE CONTROLLER. A machine that states no output has
    // none to switch, so the wire carries motion and nothing else.
    expect(consoleText()).not.toContain('Refused text:')
    expect(socket().sent.some((m) => m.m === 'sendCommand' || m.m === 'sendCommandAwait')).toBe(false)
    // AND IT RAN STRAIGHT ON - a coolant word is not a hold; the file did not
    // ask the operator to do anything before the next move.
    expect(useMachineControl.getState().job.phase).not.toBe('paused')
    expect(socket().loadMovesFrames().at(-1)!.moves.map((move) => move.to))
      .toEqual([{ x: 0, y: 0, z: 10 }])
  })

  it('states flood: the controller is ASKED at the line, and its refusal is named', async () => {
    // OPERATOR'S OWN CLASS OF MACHINE. The bridge declares `gcodeText: false` - the
    // AXBB-E has no interpreter and Bridge.cs refuses `sendCommand` outright -
    // so the very same coolant path the Control page's Mist/Flood buttons take
    // is refused by the controller. What matters here is that the route TOOK
    // it: the controller was handed the machine's own flood line and said no,
    // and the operator is told at the line rather than left with silence.
    machineStatesFlood = true
    twoSetupProject()
    await connect('bridge')
    await operatorOpensFile('coolant.nc', COOLANT_NC)
    // A stated output is not reported as missing on the load line.
    expect(useMachineControl.getState().programReadiness.reason)
      .not.toContain('states no such output')

    expect(await executeOperatorCycleStart()).toBe(true)
    // THE CONTROLLER'S OWN WORDS, which can only exist if `sendCommand('M8')`
    // was actually called on it - past the MDI lockout, with the machine's own
    // resolved flood line.
    // WO-1635: the machine's own flood line is TRANSLATED - never handed to
    // `sendCommand`. WO-1637: into the definition's pins, and this record
    // assigns no flood relay, so it is refused naming the setting. WO-1649:
    // the setting it names is the OUTPUT in the machine definition, said in the
    // definition's own words rather than a UCCNC profile key.
    expect(consoleText()).toContain(
      'MDI M8: M8 switches flood coolant, and this machine definition assigns it no pin - '
      + 'fill in the pin of the "flood coolant" output in the machine definition',
    )
    expect(consoleText()).not.toContain('Refused text:')
    expect(consoleText()).toContain(
      'Line 2: the file switches flood coolant on here, and it could not be sent',
    )
    expect(consoleText()).toContain('switch it at the machine.')

    finishStagedPart(12)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    // AND THE M9 TAKES THE SAME PATH - the one shared accessory stop.
    expect(consoleText()).toContain('MDI M9: M9 switches coolant and accessories, and this machine definition assigns it no pin')
    expect(consoleText()).toContain('Line 5: the file switches coolant off here, and it could not be sent')
  })

  it("sends the operator's own override for the action, never a hardcoded M8", async () => {
    machineStatesFlood = true
    twoSetupProject()
    const machineId = useCamStore.getState().project.machine!.id
    useMachineActions.getState().setOverride(machineId, 'coolantFlood', ['M64 P2'])
    await connect('bridge')
    await operatorOpensFile('coolant.nc', COOLANT_NC)
    expect(await executeOperatorCycleStart()).toBe(true)
    // THE WIRING THIS MACHINE ACTUALLY HAS. A flood valve on a digital output
    // answers a file exactly as it answers the button.
    expect(consoleText()).toContain(`MDI M64 P2: ${mdiOutputByNumberMessage('M64', 'switches digital output P2 on')}`)
    expect(consoleText()).not.toContain('MDI M8:')
  })

  it('still locks the OPERATOR out of MDI while the program runs', async () => {
    // The window the file's own words travel through is open around one action
    // call and nothing else. This is the rule it must not have widened.
    machineStatesFlood = true
    twoSetupProject()
    await connect('bridge')
    await operatorOpensFile('coolant.nc', COOLANT_NC)
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(sendMdiLine('M8')).toBe(false)
    expect(consoleText()).toContain('A program is running - MDI is locked out.')
  })
})

// ---------------------------------------------------------------------------
// THE SAME PATH ON A CONTROLLER THAT TAKES COMMAND LINES - which is where the
// word "sent" in the table can be read off the MACHINE rather than off a
// refusal. The simulator owns its own accessories and reports them, so what is
// asserted here is the machine's FLOOD OUTPUT, on and off at the file's own
// lines.
//
// Entered through `loadGcodeTextToolpathProgram` rather than the panel's file
// input, and that is deliberate, not a shortcut: the panel picks the file door
// by capability (`controllerNeedsToolpathProgram`), so a controller that takes
// text takes the TEXT door and never reaches the interpreter. This is the
// interpreter route, on the session singleton, against a real controller that
// can actually switch an output.
// ---------------------------------------------------------------------------

describe('WO-1335 fix round 3: the flood output actually comes ON at the file\'s own line', () => {
  beforeEach(async () => {
    machineStatesFlood = true
    twoSetupProject()
    await connect('simulator')
    // The simulator boots with every work zero unset, and this route refuses a
    // file whose frame is not fully set - correctly. Set G54 the way the
    // operator would, through the session's own door.
    for (const axis of ['X', 'Y', 'Z'] as const) {
      setWorkOffsetValue('G54', axis, axis === 'Z' ? -10 : 100)
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    }
  })

  it("switches the machine's flood output on at M8 and off at M9", async () => {
    const loaded = loadGcodeTextToolpathProgram(
      'coolant.nc',
      'G21 G90 G54\nM8\nG0 X0 Y0 Z10\nG1 Z-1 F300\nM9\nG0 Z10\nM30\n',
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(loaded).toEqual({ ok: true, reason: null })
    // NOT WET AT LOAD. The word falls due when the motion it governs is
    // released, not when the program is loaded.
    expect(useMachineControl.getState().reportedAccessories?.flood ?? false).toBe(false)

    expect(await executeOperatorCycleStart()).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    // THE MACHINE'S OWN OUTPUT, as the machine reports it.
    expect(useMachineControl.getState().reportedAccessories?.flood).toBe(true)
    expect(consoleText()).toContain('Line 2: the file switches flood coolant on here - sent as M8.')

    // RUN THE CUT OUT so the M9 section falls due.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(useMachineControl.getState().reportedAccessories?.flood).toBe(false)
    expect(consoleText()).toContain('Line 5: the file switches coolant off here - sent as M9.')
  })
})

// ---------------------------------------------------------------------------
// THE FILE THE ACCEPTANCE NAMES, BY NAME. The architect's re-scope:
// "two-setup-combined-posted.nc blocked at line 86 by `T2 M6` - a tool change
// in OUR OWN post's output ... Our own two-setup posted file is the fixture."
//
// The corpus run above proves it loads and runs to completion. This proves the
// one thing a loop cannot: what the operator READS at that tool change.
// ---------------------------------------------------------------------------

describe("WO-1335 fix round 2: our own posted two-setup file, tool change and all", () => {
  beforeEach(async () => {
    corpusMachine = true
    bridgeG54Offset = CORPUS_G54_OFFSET
    bridgeG55Offset = CORPUS_G55_OFFSET
    twoSetupProject()
    await connect('bridge')
  })

  it('loads, and holds at line 86 naming both tools and the frame the rest runs in', async () => {
    const { readFileSync } = await import('node:fs')
    const text = readFileSync('src/tests/evidence/WO-1312/two-setup-combined-posted.nc', 'utf8')
    await operatorOpensFile('two-setup-combined-posted.nc', text)

    // IT LOADS. Before the re-scope this was `REFUSED at line 86`.
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(consoleText()).toContain(
      'It runs 2 tools: T1 (6 mm flat end mill), then T2 (3 mm ball nose) - it holds at each change.',
    )

    // Section 1 (G54), then the frame boundary, then the section that ends at
    // the tool change - run each to its end and take the operator's CYCLE START
    // wherever the file holds.
    expect(await executeOperatorCycleStart()).toBe(true)
    const step = async (machineZ: number): Promise<void> => {
      emitStatus({ ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } })
      act(() => {
        socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    }
    const cycleStart = async (): Promise<void> => {
      await act(async () => {
        await executeOperatorCycleStart()
        await vi.advanceTimersByTimeAsync(10)
      })
    }

    // The G54 section ends on the file's own lift to work Z15 (machine Z75 with
    // this fixture's zeros), and the program holds for G55.
    await step(75)
    expect(useMachineControl.getState().job.phase).toBe('paused')
    await cycleStart()

    // The G55 section's first part ends at the file's own M5/lift, and THAT is
    // the tool change on line 86.
    await step(75)
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(consoleText()).toContain(
      '"two-setup-combined-posted.nc" has finished everything it cuts with T1 (6 mm flat end mill) '
      + 'and asks for T2 (3 mm ball nose) on line 86. The spindle is stopped and the tool is where '
      + 'the file left it: fit T2 (3 mm ball nose), set its Z zero, then press CYCLE START to run '
      + 'the rest.',
    )
    // The M0 on line 87 is in the file, so it stops on its own after this hold (owner ruling 10-04).
    expect(consoleText()).not.toContain('satisfied by the tool change')
  })
})

describe('WO-1345: streaming load lines state the program without inventing a ceiling', () => {
  beforeEach(async () => {
    corpusMachine = true
    bridgeG54Offset = CORPUS_G54_OFFSET
    bridgeG55Offset = CORPUS_G55_OFFSET
    twoSetupProject()
    useCamStore.setState({
      toolLibrary: [
        ...TOOLS,
        makeTool({ id: 't19', toolNumber: 19, name: 'Operator file tool' }),
      ],
    })
    await connect('bridge')
  })

  it('records the exact operator text for Operator file and a short file', async () => {
    const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
    const loadLine = async (name: string, text: string): Promise<string> => {
      const loaded = loadGcodeTextToolpathProgram(name, text)
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      expect(loaded.ok).toBe(true)
      expect(useMachineControl.getState().programReadiness.ready).toBe(true)
      return useMachineControl.getState().programReadiness.reason ?? ''
    }

    const short = await loadLine(
      'short.nc',
      'G21 G90 G54\nG0 X0 Y0 Z10\nG1 Z-1 F300\nX20 F600\nG0 Z10\nM30\n',
    )
    expect(short).toBe('Program "short.nc" loaded: 4 moves in G54 - no spindle command.')

    const sampleMachine = await loadLine(
      'fusion-liencnc-v2-sample.nc',
      readFileSync('src/tests/fixtures/foreign-gcode/fusion-liencnc-v2-sample.nc', 'utf8'),
    )
    // WO-2764: WO-2478 (2fe053181) gives the file's M9 after its M2001 park macro its own
    // command section, so the M9 is sent even if the macro changed coolant.
    expect(sampleMachine).toContain('Program "fusion-liencnc-v2-sample.nc" loaded: 110615 moves in 6 sections')
    expect(sampleMachine).not.toMatch(/4,?09[56]|board holds|board can only hold/i)

    const report = [
      '# WO-1345 load-line evidence',
      '',
      'Generated through `loadGcodeTextToolpathProgram`, the application production load door.',
      '',
      '## fusion-liencnc-v2-sample.nc',
      '',
      `> ${sampleMachine}`,
      '',
      '## short.nc',
      '',
      `> ${short}`,
      '',
    ].join('\n')
    const evidencePath = 'src/tests/evidence/WO-2474/baselines/WO-1345-load-lines.md'
    if (process.env.WRITE_EVIDENCE === '1') {
      mkdirSync('src/tests/evidence/WO-2474/baselines', { recursive: true })
      writeFileSync(evidencePath, report)
    }
    // WO-2764: the one change since the baseline is WO-2478's sixth section (the M9 after M2001).
    expect(readFileSync(evidencePath, 'utf8').replace(/\r\n/g, '\n')
      .replace('110615 moves in 5 sections - G54, then G54, then G54, then G54, then G54 -',
        '110615 moves in 6 sections - G54, then G54, then G54, then G54, then G54, then G54 -')).toBe(report)
  })
})

// ---------------------------------------------------------------------------
// ARCHITECT RE-SCOPE: "Two spindle speeds in one file are allowed. The
// up-to-speed gate re-arms on every release (proven tonight across a setup
// boundary), so the one-intent rule that belongs to the multi-setup toolpath
// route must not leak into the file route."
//
// This is that claim on the wire, on a machine that CAN drive the inverter:
// the second speed is commanded at its own line and the moves behind it wait
// for it, exactly as the first one did.
// ---------------------------------------------------------------------------

describe('WO-1335 fix round 2: a second spindle speed reaches the inverter at its own line', () => {
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

  function wire(): string[] {
    return socket().sent
      .filter((m) => ['selectWcs', 'loadMoves', 'startJob', 'spindleOn', 'spindleOff'].includes(m.m))
      .map((m) => (m.m === 'selectWcs'
        ? `selectWcs(${(m.a as { wcs: string }).wcs})`
        : m.m === 'loadMoves'
          ? `loadMoves(${(m.a as { moves: unknown[] }).moves.length})`
          : m.m))
  }

  /** The inverter setpoint word of every `spindleOn` that reached the bridge,
   *  in order - which is what the wire actually carries (the controller scales
   *  RPM into the VFD's own register). Two DIFFERENT words is the proof that a
   *  second speed reached the machine and was not collapsed into the first. */
  function commandedSetpoints(): number[] {
    return socket().sent
      .filter((m) => m.m === 'spindleOn')
      .map((m) => (m.a as { setpointWord: number }).setpointWord)
  }

  function pushVfd(actualRpm: number): void {
    act(() => {
      socket().emit({
        t: 'vfd',
        v: {
          up: true, running: true, faulted: false, runStateWord: 2, commandWord: 1,
          setpointWord: 5_000, consecutiveFailures: 0, lastStopReason: 'commanded',
          lastError: null, statusWords: [45, 18, actualRpm, 0, 9], status: {}, upToSpeed: null,
        },
      } as BridgeMessage)
    })
  }

  it('commands 8000 at line 6 after 12000 at line 2, and holds the cut for it', async () => {
    await operatorOpensFile(
      'two-speed.nc',
      [
        'G21 G90 G54', 'M3 S12000', 'G0 X0 Y0 Z10', 'G1 Z-1 F300',
        'G0 Z10', 'M3 S8000', 'G1 X20 F600', 'M5', 'M30', '',
      ].join('\n'),
    )
    expect(useMachineControl.getState().programReadiness.reason)
      .toContain('the spindle at 12000 RPM CW, then 8000 RPM CW')

    expect(await executeOperatorCycleStart()).toBe(true)
    pushVfd(12_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(wire()).toEqual(['selectWcs(G54)', 'loadMoves(3)', 'spindleOn', 'startJob'])
    const first = commandedSetpoints()
    expect(first).toHaveLength(1)

    // THE SECOND SPEED. The section ends at line 6, the inverter is commanded
    // at the NEW speed in the gap, and nothing is released until it reports it.
    emitStatus({ ...idleBridgeStatus(12), buffer: { moves: 0, capacitySeconds: null } })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(wire().slice(-2)).toEqual(['loadMoves(1)', 'spindleOn'])
    const both = commandedSetpoints()
    expect(both).toHaveLength(2)
    // AND THE SECOND IS A DIFFERENT SETPOINT - a slower one, because 8000 is
    // slower than 12000. A route that carried one intent would repeat the first.
    expect(both[1]).toBeLessThan(both[0])
    expect(consoleText()).toContain('Line 6: M3 - the spindle is commanded at 8000 RPM CW')

    pushVfd(8_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(wire().at(-1)).toBe('startJob')
  })
})

// ---------------------------------------------------------------------------
// OPERATOR'S ACCEPTANCE, item 1: THE WORD TABLE, GENERATED FROM WHAT THE ROUTE WAS
// OBSERVED TO DO - AND FROM NOTHING ELSE.
//
// FIX ROUND 3, THE AUDIT'S OTHER FINDING, AND THE ARCHITECT CALLED IT THE MORE
// IMPORTANT HALF: "The table copies `row.translation` into the artifact without
// asserting it, so the declared evidence stays green while the document makes a
// false wire-level claim. Every row's translation must be asserted against
// observed behaviour - the staged wire calls, or the console line, or the
// refusal - so a row that lies fails the test that generates it."
//
// HOW THAT IS MADE TRUE HERE, mechanically rather than by care:
//
//  1. A row carries CLAIMS, not prose. Each claim is a sentence bolted to a
//     function that proves it (`WORD_TABLE` in `interpret.wo1335.test.ts`).
//  2. A claim is proven against a `WordObservation`, which holds ONLY what this
//     route was observed to do: the moves that reached the bridge, the order of
//     the wire calls, the console the operator read, the load refusal, and how
//     many times the program held. There is no interpreter object in it, so a
//     wire-level sentence CANNOT be carried on an interpreter-level assertion -
//     which is exactly the trap the audit caught.
//  3. Every proven claim is recorded in `PROVEN` as it passes.
//  4. The artifact is rendered from `PROVEN`. A sentence that was not proven
//     this run is not in the table, and the writer FAILS rather than printing
//     a row it cannot stand behind.
//
// Every row is loaded through the RENDERED PANEL with "Open file...", on the
// real session singleton talking to a real `UccncController` over the bridge
// socket, and every loadable one is run to completion through its holds.
// ---------------------------------------------------------------------------

const { WORD_TABLE } = await import('../gcode/interpret.wo1335.test')
type WordTableRow = (typeof WORD_TABLE)[number]
type WordTableObservation = Parameters<WordTableRow['claims'][number]['proves']>[0]

/** Every claim proven in THIS run, keyed `word :: sentence`. The artifact is
 *  written from this set and never from the table, so an unproven sentence
 *  cannot reach the document. */
const PROVEN = new Map<string, { row: WordTableRow; from: string; says: string }>()

const claimKey = (word: string, says: string): string => `${word} :: ${says}`

describe('WO-1335 acceptance item 1: every word, proven on the wire it reaches', () => {
  /** Load one row's program through the panel and run it to the end, crossing
   *  every hold the file states, then report ONLY what was observed. */
  async function runRow(row: WordTableRow): Promise<WordTableObservation> {
    // THE MACHINE THE ROW DECLARES, connected per row. Coolant's translation
    // DEPENDS on what the record states, so the two answers are two rows
    // against two fixtures - never one sentence proven against whichever
    // machine happened to be connected, which is the shape the audit caught.
    machineStatesFlood = row.statesCoolant === true
    twoSetupProject()
    // `G43 H3` resolves against the SESSION'S OWN tool library, by the number
    // H states - the row's own file fits T3 with an M6 before it offsets to it.
    useCamStore.setState({
      toolLibrary: [
        ...useCamStore.getState().toolLibrary,
        makeTool({ id: 't3', toolNumber: 3, name: 'long reach', overallLength: 80 }),
      ],
    })
    await connect('bridge')
    await operatorOpensFile(`${row.word.replace(/[^A-Za-z0-9]+/g, '-')}.nc`, row.program)
    const readiness = useMachineControl.getState().programReadiness
    let holds = 0
    if (readiness.ready) {
      expect(await executeOperatorCycleStart()).toBe(true)
      for (let guard = 0; guard < 16; guard++) {
        if (useMachineControl.getState().job.phase === 'complete') break
        // THE BOARD REPORTS ITSELF IDLE WHERE THE LAST STAGED MOVE LEFT IT, in
        // machine coordinates - which is the frame a boundary's clearance check
        // reads, and the frame the file's own numbers are NOT in. A dwell has
        // no endpoint and moves nothing, so the board stays where the last
        // move with one left it - WO-2478 stages a motionless macro section as
        // one zero dwell (WO-2764).
        const last = socket().loadMovesFrames().flatMap((frame) => frame.moves)
          .filter((move) => move.to !== undefined).at(-1)?.to
        const offset = useMachineControl.getState().activeWcs === 'G55' ? G55_OFFSET : G54_OFFSET
        emitStatus({
          ...idleBridgeStatus((last?.z ?? 0) + offset.z),
          buffer: { moves: 0, capacitySeconds: null },
        })
        act(() => {
          socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
        })
        await act(async () => { await vi.advanceTimersByTimeAsync(10) })
        if (useMachineControl.getState().job.phase === 'paused') {
          holds++
          await act(async () => {
            await executeOperatorCycleStart()
            await vi.advanceTimersByTimeAsync(10)
          })
        }
      }
    }
    return {
      readiness: { ready: readiness.ready, reason: readiness.reason ?? '' },
      staged: socket().loadMovesFrames().flatMap((frame) => frame.moves),
      calls: socket().wireOrder(),
      console: consoleText(),
      holds,
    }
  }

  it.each(WORD_TABLE.map((row) => [row.word, row] as const))('%s', async (_word, row) => {
    const seen = await runRow(row)

    // THE RESULT COLUMN, ASSERTED. A row that says it is refused is refused at
    // that line with nothing on the wire; a row that says it loads, loads.
    if (row.refusedAtLine !== null) {
      expect(seen.readiness.ready).toBe(false)
      expect(seen.readiness.reason).toContain(`Line ${row.refusedAtLine}`)
      expect(seen.staged).toEqual([])
    } else {
      if (!seen.readiness.ready) throw new Error(`${row.word} was refused: ${seen.readiness.reason}`)
      // THE STAGED COLUMN, READ OFF THE BRIDGE. Not off the interpreter: what
      // this table is about is what reaches the machine. The column describes
      // geometry endpoints; typed action steps such as G4 are asserted by their
      // row's wire claim instead of being misread as an undefined endpoint.
      if (row.staged) {
        expect(seen.staged.flatMap((move) => move.to === undefined ? [] : [move.to])).toEqual(row.staged)
      }
    }

    // AND EVERY SENTENCE THE TABLE WILL PRINT.
    for (const claim of row.claims) {
      claim.proves(seen)
      PROVEN.set(claimKey(row.word, claim.says), { row, from: claim.from, says: claim.says })
    }
  })

  it('renders the table to evidence FROM THE CLAIMS IT JUST PROVED', async () => {
    // No connection is needed here: this reads what the rows above proved.
    // THE GUARD THE AUDIT ASKED FOR. Every sentence in the table was proven a
    // few milliseconds ago, against the wire, the console or the refusal. A row
    // whose claim did not run - or ran and threw - is missing here, and this
    // fails rather than writing a document nobody can stand behind.
    const missing = WORD_TABLE.flatMap((row) =>
      row.claims
        .filter((claim) => !PROVEN.has(claimKey(row.word, claim.says)))
        .map((claim) => claimKey(row.word, claim.says)))
    expect(missing, 'the table may only print sentences this run proved').toEqual([])

    if (process.env.WRITE_EVIDENCE !== '1') return
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync('src/tests/evidence/WO-1335', { recursive: true })
    const rows = WORD_TABLE.map((row) => {
      const translation = row.claims
        .map((claim) => {
          const proven = PROVEN.get(claimKey(row.word, claim.says))!
          return `${proven.says.replace(/\s+/g, ' ')} _(proven: ${proven.from})_`
        })
        .join('. ')
      return `| \`${row.word}\` | ${row.meaning} | ${translation} | `
        + `\`${row.program.replace(/\n/g, ' / ').trim()}\` | `
        + `${row.refusedAtLine === null ? 'loads' : `refused at line ${row.refusedAtLine}`} |`
    })
    writeFileSync(
      'src/tests/evidence/WO-1335/word-table.md',
      '# WO-1335 - every word, and what this route turns it into\n\n'
      + 'Generated by `src/tests/machine/gcodeTextRoute.wo1335.test.tsx` (`WRITE_EVIDENCE=1`).\n\n'
      + 'Every row below is a real program, loaded through the rendered Program panel with\n'
      + '"Open file..." onto a real controller over the bridge socket, and run to completion\n'
      + 'through every hold it states. **Every sentence in the third column was proven against\n'
      + 'what the route was OBSERVED to do** - the staged wire calls, the console line the\n'
      + 'operator read, or the load refusal - and the `(proven: ...)` note says which. The\n'
      + 'generator writes only sentences that passed in the same run, so a row that lies fails\n'
      + 'the test that writes it.\n\n'
      + '| Word | Means | What this route does with it | Program tested | Result |\n'
      + '| --- | --- | --- | --- | --- |\n'
      + `${rows.join('\n')}\n`,
    )
  })
})

// ---------------------------------------------------------------------------
// AUDIT ROUND 4's behaviour defect: the run carried the program's FIRST spindle
// intent into every configured coolant action line, so a `{rpm}` in an
// operator's own flood line named the speed the file opened with rather than
// the speed the part being staged runs at. A second speed is permitted on this
// route (the re-scope above), which is exactly when the two differ.
// ---------------------------------------------------------------------------

describe('WO-1335 fix round 4: a configured coolant line carries the speed THIS part runs at', () => {
  beforeEach(async () => {
    helloVfd = { present: true, verified: false, name: 'Huanyang GT' }
    machineHasSpindleLink = true
    machineStatesFlood = true
    twoSetupProject()
    await connect('bridge')
  })

  afterEach(() => {
    helloVfd = null
    machineHasSpindleLink = false
  })

  it('substitutes the second speed, not the first, into the machine`s own flood line', async () => {
    const machineId = useCamStore.getState().project.machine!.id
    useMachineActions.getState().setOverride(machineId, 'coolantFlood', ['M64 P2 S{rpm}'])
    await operatorOpensFile(
      'two-speed-coolant.nc',
      [
        'G21 G90 G54', 'M3 S12000', 'G0 X0 Y0 Z10', 'G1 Z-1 F300',
        'G0 Z10', 'M3 S8000', 'M8', 'G1 X20 F600', 'M5', 'M30', '',
      ].join('\n'),
    )
    expect(await executeOperatorCycleStart()).toBe(true)
    act(() => {
      socket().emit({
        t: 'vfd',
        v: {
          up: true, running: true, faulted: false, runStateWord: 2, commandWord: 1,
          setpointWord: 5_000, consecutiveFailures: 0, lastStopReason: 'commanded',
          lastError: null, statusWords: [45, 18, 12_000, 0, 9], status: {}, upToSpeed: null,
        },
      } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    // THE M8 FALLS DUE AT THE SECOND SECTION, and the file has already moved the
    // spindle to 8000 by the time that section is staged.
    emitStatus({ ...idleBridgeStatus(12), buffer: { moves: 0, capacitySeconds: null } })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    // WHAT THE TRANSLATION WAS HANDED - the substituted line itself, read off its
    // refusal by word (WO-1635: the bridge has no output call).
    expect(consoleText()).toContain(`MDI M64 P2 S8000: ${mdiOutputByNumberMessage('M64', 'switches digital output P2 on')}`)
    expect(consoleText()).not.toContain('MDI M64 P2 S12000')
  })
})
