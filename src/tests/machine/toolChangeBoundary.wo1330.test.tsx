// @vitest-environment jsdom
//
// WO-1330 - A DIFFERENT-TOOL BOUNDARY IS A TOOL-CHANGE SEQUENCE, NOT A REFUSAL.
//
// OPERATOR, AT THE MACHINE, 2026-09-11, ruling on WO-1329: "If it does change tool,
// even if I check the box saying continue through, it should NOT continue
// through - it should be initiating a tool change sequence."
//
// WO-1323 refused such a program at the door, and its reason was structural
// rather than a preference: the boundary hold could ask for a re-fixture
// because that is all a paused program allowed, and a tool change needs jog to
// a safe height and a new Z work zero, both of which a paused program disabled.
// Operator's ruling makes the boundary the sequence instead, so the paused-at-a-
// tool-change program must ALLOW exactly those two things and nothing else.
//
// WHAT IS PROVEN HERE, THROUGH THE APPLICATION'S OWN ENTRY POINTS (rule 6): the
// ProgramPanel, JogPanel and OffsetsPanel are RENDERED and CLICKED and TYPED
// INTO, on the real session singleton talking to a real `UccncController` over
// a fake bridge socket.
//
//   - a two-setup program on two tools LOADS, and its load line names the
//     change and says the continue-through box does not decide it,
//   - the wire order across the boundary is
//     `completed -> spindleOff -> [jog, setWorkOffset Z] -> spindleOn(new rpm)
//     -> wait -> selectWcs -> loadMoves -> startJob`,
//   - jog is live INSIDE that hold and nowhere else in the program's life,
//   - the incoming frame's Z work zero reaches the controller there, and X and
//     Y still do not,
//   - the tool must be clear before the spindle stops and the hold opens,
//   - Stop sends at this hold exactly what it sends at any other one, and a
//     program that ends takes the hold's two permissions with it,
//   - a SAME-tool program is untouched: no tool-change hold, jog still locked
//     out, the Z cell still dead (`multiSetupProgram.wo1323.test.tsx` measures
//     the rest of it, and its 24 tests pass unchanged).
//
// NOT CLAIMED: hardware. Tier 1 for this order is the next machine session's
// two-tool two-setup program, in air, on Operator's board.

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

// The Control tab itself is rendered for its DRO zero buttons (audit, fifth
// round); its 3D viewport needs WebGL jsdom does not have. Same stub as
// `fitVerdictAfterRestore.wo1350.test.tsx`.
vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
  CNCViewport: class {
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  } as never,
}))

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

/** Operator's AXBB-E as the bridge reports it. */
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

const G54_OFFSET = { x: 10, y: 5, z: 2 }
const G55_OFFSET = { x: 110, y: 5, z: 2 }
const OFFSET_WITHOUT_Z = { x: 0, y: 0 }

/** The inverter is present on every test in this file: the tool-change hold is
 *  where the spindle stops and restarts, so a machine with no link to it could
 *  not measure the half of the sequence that matters most. */
const HELLO_VFD = { present: true, verified: false, name: 'Huanyang GT' }
/** The no-link cases (audit, third round) turn these off; `beforeEach` puts
 *  them back. */
let helloVfd: typeof HELLO_VFD | undefined = HELLO_VFD
let machineDeclaresSpindleLink = true
/** The pad cycle case (audit, sixth round) needs a bridge that takes G-code
 *  text - the pad zero is a `G10 L20` line - and a probe that touches: the hook
 *  reports the contact the way a controller's [PRB] report does. */
let bridgeTakesGcodeText = false
let reportProbeContact: (() => void) | null = null
/** The receipt-ordering cases (audit, seventh round): while on, the bridge
 *  takes an offset write - a `setWorkOffset` or a `G10` line - and holds its
 *  answer here until the test releases it. */
let holdOffsetReceipts = false
const heldOffsetReceipts: Array<() => void> = []
function releaseHeldOffsetReceipts(): void {
  holdOffsetReceipts = false
  for (const answer of heldOffsetReceipts.splice(0)) answer()
}

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  /** Every frame that moves the machine, the spindle or an offset register, in
   *  order. The one place the SEQUENCE can be read without believing anything
   *  this software says about itself. */
  wire(): string[]
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
        G55: { ...G55_OFFSET },
        G56: { ...OFFSET_WITHOUT_Z },
        G57: { ...OFFSET_WITHOUT_Z },
        G58: { ...OFFSET_WITHOUT_Z },
        G59: { ...OFFSET_WITHOUT_Z },
      }
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1330-fake 0.0',
          capabilities: { ...PROGRAM_BRIDGE_CAPABILITIES, gcodeText: bridgeTakesGcodeText },
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
          ...(helloVfd === undefined ? {} : { vfd: helloVfd }),
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
      // A REAL BRIDGE ANSWERS EVERY CALL - the connect-time offset
      // reconciliation awaits each receipt, so a fake that answered only
      // `selectWcs` would hang the connection.
      if (message.m === 'setWorkOffset') {
        const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
        const answer = (): void => this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, offset: { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 } },
        })
        if (holdOffsetReceipts) heldOffsetReceipts.push(answer)
        else answer()
      }
      if (message.m === 'sendCommandAwait') {
        const text = (message.a as { text: string }).text
        if (text.includes('G38.2')) reportProbeContact?.()
        const answer = (): void => this.fakeEvents?.onMessage({
          t: 'reply', seq: message.seq, ok: true, v: { ok: true, message: null },
        })
        if (holdOffsetReceipts && text.startsWith('G10')) heldOffsetReceipts.push(answer)
        else answer()
      }
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }

    wire(): string[] {
      const watched = [
        'selectWcs', 'loadMoves', 'startJob', 'spindleOn', 'spindleOff', 'jog', 'setWorkOffset',
        'home', 'homeAxes', 'zeroWorkAxis', 'sendCommandAwait',
      ]
      return this.sent
        .filter((m) => watched.includes(m.m))
        .map((m) => {
          if (m.m === 'sendCommandAwait') return (m.a as { text: string }).text
          if (m.m === 'selectWcs') return `selectWcs(${(m.a as { wcs: string }).wcs})`
          if (m.m === 'jog') return `jog(${(m.a as { axis: string }).axis})`
          if (m.m === 'setWorkOffset') {
            const a = m.a as { wcs: string; x?: number; y?: number; z?: number }
            const axes = (['x', 'y', 'z'] as const).filter((k) => a[k] !== undefined)
            return `setWorkOffset(${a.wcs} ${axes.join('').toUpperCase()})`
          }
          return m.m
        })
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { JogPanel } = await import('../../components/machine/JogPanel')
const { OffsetsPanel } = await import('../../components/machine/OffsetsPanel')
const {
  executeOperatorCycleStart,
  executeOperatorFeedHold,
  executeOperatorStopReset,
} = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  activeToolChangeHold,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
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
    id: 'wo1330-machine',
    name: 'WO-1330 Test Machine',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition,
    unsentSettings: [SAMPLE_MACHINE_LINEAR_ERROR],
    spindleLinkDefinition: machineDeclaresSpindleLink
      // `status` is read by the Control tab's spindle panel; empty names no field.
      ? { status: [] } as unknown as MachineConfig['spindleLinkDefinition']
      : undefined,
  })
}

function toolpathAt(originX: number): ToolpathMove[] {
  return [
    { type: 'rapid', x: originX, y: 5, z: 12 },
    { type: 'feed', x: originX, y: 5, z: 1, feed: 300 },
    { type: 'feed', x: originX + 50, y: 5, z: 1, feed: 900 },
    { type: 'feed', x: originX + 50, y: 45, z: 1, feed: 900 },
  ]
}

/** Setup 1's retract lands the tool at machine Z 12 (work Z 10 + G54 z 2),
 *  which is what the boundary demands the machine REPORT before it stops the
 *  spindle and opens the hold. */
const SETUP1_CLEAR_MACHINE_Z = 12

/** The two tools the sequence is about, as the operator reads them. */
const FLAT = 'T1 (6 mm flat end mill)'
const BALL = 'T2 (3 mm ball nose)'

/** The 6 mm flat's speed comes from the tool; the 3 mm ball runs slower, which
 *  is the whole reason WO-1329's one-intent rule has to relax at a change. */
const FLAT_RPM = 12_000
const BALL_RPM = 8_000

function op(id: string, moves: ToolpathMove[], toolId = 't1', rpm?: number): Operation {
  const base = makeOp({
    id,
    name: `Op ${id}`,
    type: 'contour_2d',
    toolId,
    status: 'ready',
    toolpathMoves: moves,
  })
  if (rpm === undefined) return base
  return {
    ...base,
    feedrateOverride: {
      enabled: true,
      rpm,
      feedRate: 900,
      plungeRate: 300,
      rampFeedrate: 300,
      leadInFeedrate: 900,
      leadOutFeedrate: 900,
      fastTraverseFeedrate: 5000,
    },
  }
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

/** OPERATOR'S PART: two fixtures, two work offsets 100 mm apart, AND TWO TOOLS -
 *  roughed with the 6 mm flat, finished with the 3 mm ball. */
function twoToolProject(): void {
  applyProject([
    setupAt('setup1', 'Setup 1', 54, { x: 10, y: 5, z: 2 }, [op('op1', toolpathAt(10))]),
    setupAt('setup2', 'Setup 2', 55, { x: 110, y: 5, z: 2 }, [op('op2', toolpathAt(110), 't2', BALL_RPM)]),
  ])
}

/** The same part on ONE tool - the program WO-1323 and WO-1329 measured, kept
 *  here so this file can show what does NOT become a tool-change hold. */
function oneToolProject(): void {
  applyProject([
    setupAt('setup1', 'Setup 1', 54, { x: 10, y: 5, z: 2 }, [op('op1', toolpathAt(10))]),
    setupAt('setup2', 'Setup 2', 55, { x: 110, y: 5, z: 2 }, [op('op2', toolpathAt(110))]),
  ])
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
  originalProject = useCamStore.getState().project
  originalToolLibrary = useCamStore.getState().toolLibrary
  // The whole offsets table, so the INCOMING frame's Z cell is on screen while
  // G54 is still the active one.
  useUiPrefs.setState({ machineOffsetsCollapsed: false })
  helloVfd = HELLO_VFD
  machineDeclaresSpindleLink = true
  bridgeTakesGcodeText = false
  reportProbeContact = null
  holdOffsetReceipts = false
  heldOffsetReceipts.length = 0
  twoToolProject()
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

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

async function connect(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
}

/** The three panels the operator works this sequence in, rendered together the
 *  way the Control tab renders them. */
function renderControl(): void {
  render(<><ProgramPanel /><JogPanel /><OffsetsPanel /></>)
}

/** THE OPERATOR'S OWN GESTURE: open the Load menu and click the entry that
 *  loads every setup as one program. The continue-through box is ON when the
 *  menu opens and every test here leaves it on unless it says otherwise -
 *  which is Operator's case. */
async function operatorLoadsAllSetups(
  { continueThrough = true }: { continueThrough?: boolean } = {},
): Promise<void> {
  renderControl()
  act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
  const box = screen.getByTestId('control-load-all-setups-continue') as HTMLInputElement
  expect(box.checked).toBe(true)
  if (!continueThrough) act(() => { fireEvent.click(box) })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-load-all-setups'))
    await Promise.resolve()
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
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

/** Run the staged part to its end and let the controller declare it over, with
 *  the machine reporting `machineZ` when it stops. */
function finishStagedPart(machineZ: number): void {
  act(() => {
    socket().emit({
      t: 'status',
      v: { ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } },
    } as BridgeMessage)
  })
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

/** Load, start, get setup 1 cutting, then end it clear of the work: the program
 *  is now standing at the tool change. */
async function runToTheToolChange(): Promise<void> {
  await operatorLoadsAllSetups()
  await operatorPressesCycleStart()
  pushVfd(FLAT_RPM)
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
}

/** The operator touches the new tool off and types its Z into a frame's Z cell
 *  - G55 unless told otherwise. The fake bridge answers with a receipt. */
async function operatorSetsZZero(cell = 'control-offset-g55-z', value = '-4.250'): Promise<void> {
  const zCell = screen.getByTestId(cell) as HTMLInputElement
  await act(async () => {
    fireEvent.change(zCell, { target: { value } })
    fireEvent.blur(zCell)
    await vi.advanceTimersByTimeAsync(10)
  })
}

describe('WO-1330: a two-tool program loads and names its tool change', () => {
  beforeEach(async () => { await connect() })

  const LOAD_LINE =
    'Toolpath program "Setup 1 + Setup 2 (toolpath)" loaded: 9 moves in 2 setups - '
    + `Setup 1 in G54 with ${FLAT}, then a TOOL CHANGE, then Setup 2 in G55 with ${BALL}.`
    + ' It stops at the tool change whether or not "Continue through the '
    + 'setups" is ticked - the spindle stops and the new tool is yours to fit and zero.'

  it('loads, and the load line names the change and both tools', async () => {
    await operatorLoadsAllSetups()

    expect(useMachineControl.getState().programReadiness).toMatchObject({
      ready: true,
      reason: LOAD_LINE,
    })
    expect(consoleText()).toContain(LOAD_LINE)
    // WO-1323's refusal is gone, and so is every sentence that carried it.
    expect(consoleText()).not.toContain('Run these setups one at a time')
    expect(consoleText()).not.toContain('would have to change tool between them')
  })

  // OPERATOR'S REQUIREMENT, VERBATIM: "even if I check the box saying continue
  // through, it should NOT continue through". The box is ticked here, and the
  // load line says out loud that it does not decide this boundary.
  it('does not promise a straight-through run while the box is ticked', async () => {
    await operatorLoadsAllSetups()

    expect(consoleText()).not.toContain('runs straight through')
    expect(consoleText()).not.toContain('does not stop between setups')
    expect(consoleText()).toContain(
      'It stops at the tool change whether or not "Continue through the setups" is ticked',
    )
  })

  it('leaves a SAME-tool program saying exactly what it said before', async () => {
    oneToolProject()
    await operatorLoadsAllSetups()

    expect(useMachineControl.getState().programReadiness).toMatchObject({
      ready: true,
      reason:
        'Toolpath program "Setup 1 + Setup 2 (toolpath)" loaded: 9 moves in 2 setups - '
        + 'Setup 1 in G54, then Setup 2 in G55. It runs straight through '
        + 'from G54 into G55 without stopping.',
    })
  })
})

describe('WO-1330: the boundary is a tool-change sequence', () => {
  beforeEach(async () => { await connect() })

  it('stops the spindle and HOLDS, naming both tools and what the hold allows', async () => {
    await runToTheToolChange()

    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(socket().wire().at(-1)).toBe('spindleOff')
    // Not one thing about setup 2 has reached the board.
    expect(socket().wire().filter((m) => m.startsWith('selectWcs'))).toEqual(['selectWcs(G54)'])
    expect(consoleText()).toContain(
      'Setup 1 is finished, the tool has retracted clear and the spindle is stopped. '
      + `Take ${FLAT} out and fit ${BALL}, then set the G55 Z work zero for it - jogging and that `
      + 'Z zero are what this hold allows. Press CYCLE START when the new tool is zeroed and '
      + '"Setup 2" runs in G55.',
    )
    expect(activeToolChangeHold()).toEqual({
      finishedName: 'Setup 1',
      nextName: 'Setup 2',
      wcs: 'G55',
      leaving: FLAT,
      fit: BALL,
    })
  })

  // THE SEQUENCE, END TO END, AS THE WIRE SAW IT. This is the order the work
  // order names, and the order is the verdict: the frame never moves before the
  // new tool is in, spinning and zeroed.
  it('runs the whole sequence in order: spindle off, jog, Z zero, spindle up, frame, moves, start', async () => {
    await runToTheToolChange()
    const beforeChange = socket().wire().length

    // The operator jogs the spindle to where they can reach it, fits the ball
    // nose, touches it off and types the new Z into G55.
    act(() => { fireEvent.pointerDown(screen.getByTestId('control-jog-z-plus')) })
    act(() => { fireEvent.pointerUp(screen.getByTestId('control-jog-z-plus')) })
    const zCell = screen.getByTestId('control-offset-g55-z') as HTMLInputElement
    await act(async () => {
      fireEvent.change(zCell, { target: { value: '-4.250' } })
      fireEvent.blur(zCell)
      await vi.advanceTimersByTimeAsync(10)
    })

    await operatorPressesCycleStart()
    // ARMED FOR THE NEW TOOL'S SPEED, and nothing of setup 2 released yet.
    expect(consoleText()).toContain(SPINDLE_SPEED_GATE.waiting(BALL_RPM))
    expect(socket().wire().at(-1)).toBe('spindleOn')

    pushVfd(BALL_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(socket().wire().slice(beforeChange - 1)).toEqual([
      'spindleOff',
      'jog(Z)',
      'setWorkOffset(G55 Z)',
      'spindleOn',
      'selectWcs(G55)',
      'loadMoves',
      'startJob',
    ])
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    expect(useMachineControl.getState().job.phase).toBe('streaming')
    expect(consoleText()).toContain(SPINDLE_SPEED_GATE.released(BALL_RPM))
    // The hold is over, so the two things it lent are lent back.
    expect(activeToolChangeHold()).toBeNull()
  })

  // THE FRAME SWITCHES ONLY AFTER THE BOARD HAS CONFIRMED THE NEW TOOL'S Z ZERO
  // (audit, fix round). CYCLE START without one sends nothing - not the
  // spindle, not the frame - and the hold, with its jog and Z cells, stays open.
  it('keeps the hold and sends nothing when CYCLE START comes before the Z zero', async () => {
    await runToTheToolChange()
    const before = socket().wire().length

    await operatorPressesCycleStart()

    expect(socket().wire().slice(before)).toEqual([])
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(activeToolChangeHold()).not.toBeNull()
    expect((screen.getByTestId('control-jog-x-plus') as HTMLButtonElement).disabled).toBe(false)
    expect(consoleText()).toContain(
      'Cycle Start: refused - the machine has not confirmed a G55 Z work zero since the tool change, '
      + 'so the spindle was not started and "Setup 2" was not started. '
      + `Set the G55 Z zero for ${BALL}, then press CYCLE START.`,
    )

    // The receipt is what opens it: the same gesture, after the Z zero, goes.
    await operatorSetsZZero()
    await operatorPressesCycleStart()
    expect(socket().wire().slice(before)).toEqual(['setWorkOffset(G55 Z)', 'spindleOn'])
  })

  it('does not count a Z zero written to a frame the next setup does not run in', async () => {
    await runToTheToolChange()
    await operatorSetsZZero('control-offset-g54-z')
    const before = socket().wire().length

    await operatorPressesCycleStart()

    expect(socket().wire().slice(before)).toEqual([])
    expect(activeToolChangeHold()).not.toBeNull()
  })

  it('runs the two-tool program to one completion', async () => {
    await runToTheToolChange()
    await operatorSetsZZero()
    await operatorPressesCycleStart()
    pushVfd(BALL_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(useMachineControl.getState().job.phase).toBe('complete')
    expect(socket().wire().at(-1)).toBe('spindleOff')
  })

  // AGENDA FAIL #3, AT A TOOL CHANGE. The check runs BEFORE the spindle stops
  // and the hold opens, because the outgoing tool's retract height is only a
  // fact about the spindle while that tool is still in it.
  it('never opens the hold while the machine says the tool is down', async () => {
    await operatorLoadsAllSetups()
    await operatorPressesCycleStart()
    pushVfd(FLAT_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    finishStagedPart(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(useMachineControl.getState().job.phase).toBe('failed')
    expect(activeToolChangeHold()).toBeNull()
    expect(socket().wire().filter((m) => m.startsWith('selectWcs'))).toEqual(['selectWcs(G54)'])
    expect(consoleText()).toContain(
      'The tool is at machine Z 1.00 mm and Setup 1 retracts clear at machine Z 12.00 mm, so it is not '
      + 'clear of the work. G55 was not selected and "Setup 2" was not started. Nothing moved.',
    )
  })

  // NOTHING ABOUT STOP CHANGES AT A TOOL CHANGE, and "nothing changes" is a
  // claim about two holds, so it is measured against the other one: the SAME
  // door, the SAME frames sent, and setup 2 not started, at a tool-change hold
  // and at WO-1323's re-fixture hold alike.
  it('sends exactly what Stop sends at any other hold, and starts no setup 2', async () => {
    await runToTheToolChange()
    await act(async () => {
      executeOperatorStopReset()
      await vi.advanceTimersByTimeAsync(10)
    })
    const afterToolChangeHold = socket().sent.map((m) => m.m).slice(-2)
    expect(socket().wire().filter((m) => m.startsWith('selectWcs'))).toEqual(['selectWcs(G54)'])

    cleanup()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
    useMachineControl.setState({ consoleLines: [] })
    oneToolProject()
    await connect()

    await operatorLoadsAllSetups({ continueThrough: false })
    await operatorPressesCycleStart()
    pushVfd(FLAT_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(useMachineControl.getState().job.phase).toBe('paused')
    await act(async () => {
      executeOperatorStopReset()
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(socket().sent.map((m) => m.m).slice(-2)).toEqual(afterToolChangeHold)
    expect(socket().wire().filter((m) => m.startsWith('selectWcs'))).toEqual(['selectWcs(G54)'])
  })

  // AND WHEN THE PROGRAM ACTUALLY ENDS, THE HOLD ENDS WITH IT. The two things
  // this hold lends are lent for the length of one tool change, so a board
  // reporting the job over takes them back - otherwise a stopped program would
  // leave jog and a live Z write standing on nothing.
  it('takes the hold with it when the program ends', async () => {
    await runToTheToolChange()
    expect(activeToolChangeHold()).not.toBeNull()

    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'stopped', fault: null } } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(useMachineControl.getState().job.phase).not.toBe('paused')
    expect(activeToolChangeHold()).toBeNull()
    expect(socket().wire().filter((m) => m.startsWith('selectWcs'))).toEqual(['selectWcs(G54)'])
  })

  // STOP MEANS STOPPED (audit, second fix round). At the boundary the board has
  // already reported setup 1 complete, so the operator's Stop goes out as a
  // reset and no job event comes back. The program must end on that gesture
  // anyway: the hold closed, nothing staged, and a CYCLE START pressed later -
  // with the new Z zero already confirmed, the worst case - runs nothing.
  // The same gesture while the new spindle is still ramping after CYCLE START:
  // the hold's permissions are already closed but the program is still standing
  // at the boundary, and Stop must end it there too.
})

// A GEOMETRY MACHINE WITHOUT A SPINDLE LINK (audit, third round). The hold
// invites the operator to take the tool out, so what it says about the spindle
// must be true: a stop is sent whenever the program itself commanded none, the
// hold says "stopped" only when that stop can reach an inverter, and otherwise
// it hands the spindle to the operator.
describe('WO-1330: the tool change on a machine without a spindle link', () => {
  async function runWithoutProgramSpindleToTheToolChange(): Promise<void> {
    twoToolProject()
    await connect()
    await operatorLoadsAllSetups()
    await operatorPressesCycleStart()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  }

  it('sends the stop and hands the spindle to the operator when nothing links it', async () => {
    helloVfd = undefined
    machineDeclaresSpindleLink = false
    await runWithoutProgramSpindleToTheToolChange()

    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(activeToolChangeHold()).not.toBeNull()
    expect(socket().wire().filter((m) => m === 'spindleOn')).toEqual([])
    expect(socket().wire().at(-1)).toBe('spindleOff')
    expect(consoleText()).not.toContain('the spindle is stopped')
    expect(consoleText()).not.toContain('the spindle stops')
    expect(consoleText()).toContain(
      'It stops at the tool change whether or not "Continue through the setups" is ticked - this '
      + 'app has no link to the spindle, so switching it off there is yours, and so is fitting and '
      + 'zeroing the new tool.',
    )
    expect(consoleText()).toContain(
      'Setup 1 is finished and the tool has retracted clear. This app has no link to the spindle, '
      + 'so it cannot stop it - switch it off at the machine. '
      + `Take ${FLAT} out and fit ${BALL}, then set the G55 Z work zero for it - jogging and that `
      + `Z zero are what this hold allows. Start the spindle at ${BALL_RPM} RPM CW for the new tool `
      + 'and press CYCLE START when it is zeroed and "Setup 2" runs in G55.',
    )
  })

  it('stops the spindle at the hold when the controller has a link the machine record does not name', async () => {
    machineDeclaresSpindleLink = false
    await runWithoutProgramSpindleToTheToolChange()

    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(activeToolChangeHold()).not.toBeNull()
    // The program commanded no spindle, and the stop still went out at the hold.
    expect(socket().wire().filter((m) => m === 'spindleOn')).toEqual([])
    expect(socket().wire().at(-1)).toBe('spindleOff')
    expect(consoleText()).toContain(
      'Setup 1 is finished, the tool has retracted clear and the spindle is stopped. ',
    )
  })
})

// THE SPINDLE INVARIANT, ACROSS EVERY CONFIGURATION (audit, fourth round):
// whatever decided the hold may stop the spindle decides CYCLE START starts it.
// If this app stopped it, the release starts it at the NEW tool's speed before
// any of setup 2 goes out. If it could not, the operator is told to switch it
// off at the hold and to start it at that speed before CYCLE START, and CYCLE
// START is their word. There is no row in which a stopped spindle stays stopped
// under setup 2.
describe('WO-1330: the spindle the hold stops is the spindle CYCLE START starts', () => {
  const rows = [
    { config: 'controller drives the spindle, record names the link', vfd: true, recordLink: true, drives: true },
    { config: 'controller drives the spindle, record does NOT name the link', vfd: true, recordLink: false, drives: true },
    { config: 'nothing can drive the spindle', vfd: false, recordLink: false, drives: false },
  ]

  it.each(rows)('$config: stop and start belong to the same owner', async ({ vfd, recordLink, drives }) => {
    helloVfd = vfd ? HELLO_VFD : undefined
    machineDeclaresSpindleLink = recordLink
    twoToolProject()
    await connect()
    await operatorLoadsAllSetups()
    await operatorPressesCycleStart()
    if (recordLink) pushVfd(FLAT_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(activeToolChangeHold()).not.toBeNull()
    const atHold = socket().wire().length
    expect(socket().wire().at(-1)).toBe('spindleOff')
    if (drives) {
      expect(consoleText()).toContain('the spindle is stopped')
    } else {
      expect(consoleText()).toContain('switch it off at the machine')
      expect(consoleText()).toContain(`Start the spindle at ${BALL_RPM} RPM CW for the new tool`)
    }

    await operatorSetsZZero()
    await operatorPressesCycleStart()
    if (drives) {
      // Held for the new tool's speed: the spindle is commanded, setup 2 is not.
      expect(socket().wire().at(-1)).toBe('spindleOn')
      expect(useMachineControl.getState().job.phase).not.toBe('streaming')
      pushVfd(BALL_RPM)
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(socket().wire().slice(atHold - 1)).toEqual([
      'spindleOff',
      'setWorkOffset(G55 Z)',
      ...(drives ? ['spindleOn'] : []),
      'selectWcs(G55)',
      'loadMoves',
      'startJob',
    ])
    expect(useMachineControl.getState().job.phase).toBe('streaming')
    expect(activeToolChangeHold()).toBeNull()
  })
})

describe('WO-1330: the hold permits jog and the new Z zero, and nothing else', () => {
  beforeEach(async () => { await connect() })

  function jogButton(): HTMLButtonElement {
    return screen.getByTestId('control-jog-x-plus') as HTMLButtonElement
  }

  /** Type a value into an offset cell and commit it the way an operator does. */
  async function commitOffset(id: string, value: string): Promise<void> {
    const cell = screen.getByTestId(id) as HTMLInputElement
    await act(async () => {
      fireEvent.change(cell, { target: { value } })
      fireEvent.blur(cell)
      await vi.advanceTimersByTimeAsync(10)
    })
  }

  // THE CONTRAST IS THE POINT, AND IT IS BETWEEN TWO PAUSED PROGRAMS. WO-1323's
  // re-fixture hold locks jog out and says so; WO-1330's tool-change hold is the
  // one paused state that does not, because the operator cannot reach the
  // spindle or touch the new tool off without it.
  it('is locked at a re-fixture hold and live at a tool-change hold', async () => {
    oneToolProject()
    await operatorLoadsAllSetups({ continueThrough: false })
    await operatorPressesCycleStart()
    pushVfd(FLAT_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(jogButton().disabled).toBe(true)
    expect(jogButton().getAttribute('data-tooltip')).toBe(
      'A program is running - jogging is locked out.',
    )

    cleanup()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
    useMachineControl.setState({ consoleLines: [] })
    twoToolProject()
    await connect()
    await runToTheToolChange()

    // Same phase, same panel, opposite answer - and the tooltip no longer
    // announces a lockout the operator is being asked to work through.
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(jogButton().disabled).toBe(false)
    expect(jogButton().getAttribute('data-tooltip')).toBe('Jog X+')
  })

  // THE PERMISSIONS END BEFORE THE INCOMING SPINDLE IS COMMANDED (audit, fix
  // round). While it ramps the program is still held at the boundary, and
  // nobody may jog or re-zero Z under a spinning tool.
  it('locks jog and the Z cells the moment CYCLE START commands the new spindle', async () => {
    await runToTheToolChange()
    await operatorSetsZZero()
    expect(jogButton().disabled).toBe(false)

    await operatorPressesCycleStart()
    // Ramping: the spindle is commanded, stage 2 is not released yet.
    expect(socket().wire().at(-1)).toBe('spindleOn')
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(activeToolChangeHold()).toBeNull()
    expect(jogButton().disabled).toBe(true)
    const ramping = socket().wire().length
    await commitOffset('control-offset-g55-z', '-9.000')
    expect(socket().wire().slice(ramping)).toEqual([])

    pushVfd(BALL_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(useMachineControl.getState().job.phase).toBe('streaming')
    expect(jogButton().disabled).toBe(true)
  })

  it('gives the hold back if a Feed Hold drops the ramp, keeping the Z zero already set', async () => {
    await runToTheToolChange()
    await operatorSetsZZero()
    await operatorPressesCycleStart()
    expect(activeToolChangeHold()).toBeNull()

    await act(async () => {
      executeOperatorFeedHold()
      await vi.advanceTimersByTimeAsync(10)
    })

    expect(socket().wire().at(-1)).toBe('spindleOff')
    expect(activeToolChangeHold()).not.toBeNull()
    expect(jogButton().disabled).toBe(false)
    expect(socket().wire().filter((m) => m.startsWith('selectWcs'))).toEqual(['selectWcs(G54)'])

    await operatorPressesCycleStart()
    expect(socket().wire().at(-1)).toBe('spindleOn')
  })

  // THE Z IT LENDS IS THE INCOMING FRAME'S (audit, attempt 4). G54 is the frame
  // setup 1 already cut in; a live Z write there would move a setup's zero
  // under a loaded program, so the hold entering G55 keeps it off the wire.
  // HOMING IS NOT LENT (audit, fix round). A homing cycle replaces the datum the
  // staged setup 2 is about to run on; the hold lends jog and the Z zero only.
  it('locks Home All and every per-axis Home at the hold, and puts no homing call on the wire', async () => {
    await runToTheToolChange()
    expect(activeToolChangeHold()).not.toBeNull()
    expect(jogButton().disabled).toBe(false)
    const before = socket().wire().length

    const homes = ['control-home', 'control-home-z', 'control-home-x', 'control-home-y']
      .map((id) => screen.getByTestId(id) as HTMLButtonElement)
    for (const home of homes) {
      expect(home.disabled).toBe(true)
      expect(home.getAttribute('data-tooltip')).toBe(
        'A tool change is holding the program - homing is locked out. Jog and the new Z zero are what this hold allows.',
      )
      await act(async () => {
        fireEvent.click(home)
        await vi.advanceTimersByTimeAsync(10)
      })
    }

    expect(socket().wire().slice(before)).toEqual([])
    expect(activeToolChangeHold()).not.toBeNull()
  })

  // THE DRO ZEROS ARE NOT LENT EITHER (audit, fifth round). G54 is still the
  // active frame at the hold - setup 2's G55 is selected only at CYCLE START - so
  // Zero X, Zero Y, Zero Z and Zero all on the Control tab would rewrite the
  // frame setup 1 cut in. The one zero the hold lends is the G55 Z cell.
  it('keeps Z off the wire when the same boundary changes no tool', async () => {
    oneToolProject()
    await operatorLoadsAllSetups({ continueThrough: false })
    await operatorPressesCycleStart()
    pushVfd(FLAT_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    finishStagedPart(SETUP1_CLEAR_MACHINE_Z)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })

    // WO-1323's hold, unchanged: it asks for a re-fixture, and a re-fixture
    // needs neither of the two things WO-1330 lends.
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(activeToolChangeHold()).toBeNull()
    expect(jogButton().disabled).toBe(true)

    const before = socket().wire().length
    await commitOffset('control-offset-g55-z', '-4.250')
    expect(socket().wire().slice(before)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ATTEMPT 6: ONE QUESTION, EVERY ROUTE.
//
// Five audits found the hold rule missing from five doors. The rule now lives
// in `workOffsetWriteRefusal`, and these tests drive EVERY route that puts a
// work offset on the controller - the Offsets cells and the shared writer the
// Offsets tab Push and Probing Confirm use, the DRO and pendant zeros, the
// pendant saved-probe apply (the fifth audit's door), the pad and mesh probe
// cycles, and the controller-reopen restore - and read the answer off the wire.
//
// The pendant's probe cycles cannot touch anything on a fake socket, so the
// pendant's stored RESULT is seeded through the two cycle functions it calls;
// the apply that follows is the pendant's own code, unmocked.
let seededSurfaceZ: number | null = null
let seededFeatureTouches: Record<string, number> | null = null
vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runZProbeCycle: (mode, config) => (
      mode === 'measureTool' && seededSurfaceZ !== null
        ? Promise.resolve({ ok: true, message: 'seeded surface', probedMachineZ: seededSurfaceZ })
        : actual.runZProbeCycle(mode, config)
    ),
    runFeatureProbeCycle: (plan, config, clear, onTouch) => (
      seededFeatureTouches !== null
        ? Promise.resolve({ ok: true, message: 'seeded feature', touches: seededFeatureTouches })
        : actual.runFeatureProbeCycle(plan, config, clear, onTouch)
    ),
  })
})

const { executePendantMachineCommand } = await import('../../lib/machine/pendantMachine')
const {
  runSurfaceMeshProbeCycle,
  runZProbeCycle,
  setWorkOffsetValue,
  workOffsetWriteRefusal,
} = await import('../../lib/machine/machineSession')

describe('WO-1330: every route that writes a work offset asks one question', () => {
  const PAD: import('../../lib/machine/toolTable').ZProbeConfig = {
    fastFeed: 6000, slowFeed: 600, retract: 2, maxTravel: 50, padThickness: 10,
  }
  type MeshInput = Parameters<typeof runSurfaceMeshProbeCycle>[0]
  const PROBE_PARAMS = {
    probeFeed: 100, searchTravel: 20, tipRadius: 1, nominalSize: 10,
    edgeAxis: 'X' as const, edgeDirection: '+' as const, pathClearConfirmed: true,
  }


  async function pendant(
    command: Parameters<typeof executePendantMachineCommand>[0],
  ): Promise<{ ok: boolean; error?: string }> {
    let outcome: { ok: boolean; error?: string } = { ok: false }
    await act(async () => {
      outcome = await executePendantMachineCommand(command, { clientId: 'wo1330-pendant', emit: () => {} })
      await vi.advanceTimersByTimeAsync(10)
    })
    return outcome
  }

  async function settle(): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  }

  beforeEach(async () => {
    seededSurfaceZ = null
    seededFeatureTouches = null
    await connect()
  })

  // THE FIFTH AUDIT'S DOOR. The pendant applies its saved result to the ACTIVE
  // frame, which at the hold is still G54 - the frame setup 1 cut in.
  // A RESTORE IS ANSWERED YES, AND IT IS NOT THE NEW TOOL'S ZERO. A board that
  // reopens at the hold gets this software's stored frames back - refusing
  // would leave setup 2 staged on the bridge's defaults - and CYCLE START still
  // waits for the operator's own G55 Z.
  it('a controller reopen at the hold restores the stored frames and does not stand in for the Z zero', async () => {
    await runToTheToolChange()
    const before = socket().wire().length

    await act(async () => {
      socket().emit({
        t: 'console',
        v: { dir: 'rx', text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 1) - this link is live.', severity: 'info' },
      } as BridgeMessage)
      await vi.advanceTimersByTimeAsync(50)
    })
    const restored = socket().wire().slice(before)
    expect(restored).toContain('setWorkOffset(G54 XYZ)')
    expect(restored).toContain('setWorkOffset(G55 XYZ)')
    expect(activeToolChangeHold()).not.toBeNull()

    const pressed = socket().wire().length
    await operatorPressesCycleStart()
    expect(socket().wire().slice(pressed)).toEqual([])
    expect(consoleText()).toContain('the machine has not confirmed a G55 Z work zero since the tool change')
  })

  // NEGATIVE CONTROL: no program, no hold - every route does what it did before.
  // OPERATOR, 2026-09-13, striking two restrictions this order had grown:
  //   "Who said stop shouldn't let it continue on with a cycle start? Who made
  //    that decision? I didn't... Stop is stop. It just means stop doing what
  //    you're doing."
  //   "who said a user can't change the work coordinate offsets they want part
  //    way through it's on them... The user would maybe want to move his work
  //    offset 1 mm to the right if he started a cut and it didn't do what he
  //    wanted. So stop imparting your own unrequested safety checks."
  // These two pin the behaviour he asked for, so it cannot drift back.
  it('lets the operator move ANY work offset during the hold - it is his call', async () => {
    await runToTheToolChange()
    const before = socket().wire().length

    // The frame that already ran, the axis that is not Z: refused before, his now.
    let accepted = false
    act(() => { accepted = setWorkOffsetValue('G54', 'X', 12) })
    await settle()
    expect(accepted).toBe(true)
    expect(socket().wire().slice(before)).toContain('setWorkOffset(G54 X)')

    // And the answer is the same for every frame and axis while the hold is open.
    for (const wcs of ['G54', 'G55'] as const) {
      for (const axis of ['X', 'Y', 'Z'] as const) expect(workOffsetWriteRefusal(wcs, [axis])).toBeNull()
    }
  })

  it('leaves the program runnable after Stop, so CYCLE START carries on', async () => {
    await runToTheToolChange()
    await act(async () => {
      executeOperatorStopReset()
      await vi.advanceTimersByTimeAsync(10)
    })
    // Stop stopped what was running. It did NOT throw the rest of the program
    // away - nothing here demands the operator load the file again.
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(consoleText()).not.toMatch(/load the program again/i)
  })
  it('outside a tool change every route writes as it always has', async () => {
    renderControl()
    const before = socket().wire().length
    for (const wcs of ['G54', 'G55'] as const) {
      for (const axis of ['X', 'Y', 'Z'] as const) expect(workOffsetWriteRefusal(wcs, [axis])).toBeNull()
    }

    let accepted = false
    act(() => { accepted = setWorkOffsetValue('G54', 'X', 12) })
    await settle()
    expect(accepted).toBe(true)
    expect(socket().wire().slice(before)).toEqual(['setWorkOffset(G54 X)'])

    seededSurfaceZ = -7
    expect(await pendant({ kind: 'probe-start', routineId: 'zSurface', params: PROBE_PARAMS })).toMatchObject({ ok: true })
    expect(await pendant({ kind: 'apply-probe-zero' })).toMatchObject({ ok: true })
    await settle()
    expect(socket().wire().slice(before)).toEqual(['setWorkOffset(G54 X)', 'setWorkOffset(G54 Z)'])

    const mesh = await runSurfaceMeshProbeCycle({ workOffset: 'G54', points: [] } as unknown as MeshInput, PAD, true)
    expect(mesh.message).toBe('The surface mesh grid is incomplete.')

    await pendant({ kind: 'zero-axes', axes: ['Z'] })
    expect(socket().wire().slice(before)).toEqual(['setWorkOffset(G54 X)', 'setWorkOffset(G54 Z)', 'zeroWorkAxis'])
    expect(consoleText()).not.toContain('A tool change is holding the program')
  })
})

// THE SIXTH AUDIT: a route the hold LENDS the incoming Z to must also COUNT.
// The pad cycle asked the question and wrote G55 Z through the pad, and CYCLE
// START still said the machine had not confirmed a G55 Z zero. Only a bridge
// that takes G-code text can run the pad cycle, so this one connects as one.
describe('WO-1330: the pad cycle zeroes the new tool and CYCLE START takes it', () => {
  const PAD: import('../../lib/machine/toolTable').ZProbeConfig = {
    fastFeed: 6000, slowFeed: 600, retract: 2, maxTravel: 50, padThickness: 10,
  }
  const PAD_CONTACT_MACHINE_Z = -40

  beforeEach(async () => {
    bridgeTakesGcodeText = true
    reportProbeContact = () => {
      useMachineControl.getState().applyOffset({ label: 'PRB', values: [0, 0, PAD_CONTACT_MACHINE_Z], probeSuccess: true })
    }
    await connect()
  })

  it('an acknowledged pad G55 Z zero releases setup 2 on the next CYCLE START', async () => {
    await runToTheToolChange()
    await act(async () => {
      await executePendantMachineCommand({ kind: 'select-wcs', wcs: 'G55' }, { clientId: 'wo1330-pad', emit: () => {} })
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    const before = socket().wire().length

    let pad: Awaited<ReturnType<typeof runZProbeCycle>> | null = null
    await act(async () => {
      pad = await runZProbeCycle('workZero', PAD)
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(pad).toMatchObject({ ok: true, probedMachineZ: PAD_CONTACT_MACHINE_Z })
    // WO-2059: Z0 at the contact - the first-time choice is no pad.
    expect(socket().wire().slice(before)).toContain('G10 L20 P0 Z0')
    expect(activeToolChangeHold()).not.toBeNull()

    const pressed = socket().wire().length
    await operatorPressesCycleStart()
    expect(consoleText()).not.toContain('the machine has not confirmed a G55 Z work zero')
    expect(socket().wire().slice(pressed)).toEqual(['spindleOn'])

    pushVfd(BALL_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(socket().wire().slice(pressed)).toEqual(['spindleOn', 'selectWcs(G55)', 'loadMoves', 'startJob'])
    expect(useMachineControl.getState().job.phase).toBe('streaming')
    expect(activeToolChangeHold()).toBeNull()
  })

  // The same pad zero into the OUTGOING frame is refused before it moves, so it
  // cannot stand in for the new tool's zero either.
})

// AUDIT, SEVENTH ROUND: A WRITE IN FLIGHT IS NOT A WRITE APPLIED. CYCLE START at
// the hold ends the hold's permissions and commands the incoming spindle, so it
// may not do either while an offset write the hold accepted is still on its way
// to the board - whether it is the first Z zero or a second one after a first
// was already confirmed, and whether it came from a cell or a pad cycle.
describe('WO-1330: CYCLE START waits for every offset receipt the hold accepted', () => {
  const PAD: import('../../lib/machine/toolTable').ZProbeConfig = {
    fastFeed: 6000, slowFeed: 600, retract: 2, maxTravel: 50, padThickness: 10,
  }
  const WAITING = 'is still waiting for the machine to confirm it, so the spindle was not started'

  async function settle(): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  }

  it('a second G55 Z still awaiting its receipt keeps the spindle off and the hold open', async () => {
    await connect()
    await runToTheToolChange()
    await operatorSetsZZero()
    holdOffsetReceipts = true
    await operatorSetsZZero('control-offset-g55-z', '-6.000')
    expect(socket().wire().at(-1)).toBe('setWorkOffset(G55 Z)')

    const pressed = socket().wire().length
    await operatorPressesCycleStart()
    expect(socket().wire().slice(pressed)).toEqual([])
    expect(consoleText()).toContain(`Cycle Start: refused - a work offset write ${WAITING}`)
    expect(activeToolChangeHold()).not.toBeNull()

    act(() => { releaseHeldOffsetReceipts() })
    await settle()
    await operatorPressesCycleStart()
    expect(socket().wire().slice(pressed)).toEqual(['spindleOn'])
    pushVfd(BALL_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(socket().wire().slice(pressed)).toEqual(['spindleOn', 'selectWcs(G55)', 'loadMoves', 'startJob'])
  })

  it('the first G55 Z still awaiting its receipt refuses as waiting, then releases once answered', async () => {
    await connect()
    await runToTheToolChange()
    holdOffsetReceipts = true
    await operatorSetsZZero()

    const pressed = socket().wire().length
    await operatorPressesCycleStart()
    expect(socket().wire().slice(pressed)).toEqual([])
    expect(consoleText()).toContain(`a work offset write ${WAITING}`)
    expect(consoleText()).not.toContain('the machine has not confirmed a G55 Z work zero')
    expect(activeToolChangeHold()).not.toBeNull()

    act(() => { releaseHeldOffsetReceipts() })
    await settle()
    await operatorPressesCycleStart()
    expect(socket().wire().slice(pressed)).toEqual(['spindleOn'])
  })

  it('a pad G55 Z zero whose G10 is unanswered keeps the spindle off until the cycle ends', async () => {
    bridgeTakesGcodeText = true
    reportProbeContact = () => {
      useMachineControl.getState().applyOffset({ label: 'PRB', values: [0, 0, -40], probeSuccess: true })
    }
    await connect()
    await runToTheToolChange()
    await act(async () => {
      await executePendantMachineCommand({ kind: 'select-wcs', wcs: 'G55' }, { clientId: 'wo1330-rx', emit: () => {} })
      await vi.advanceTimersByTimeAsync(10)
    })
    holdOffsetReceipts = true
    let pad: Awaited<ReturnType<typeof runZProbeCycle>> | null = null
    let cycle: Promise<void> = Promise.resolve()
    await act(async () => {
      cycle = runZProbeCycle('workZero', PAD).then((result) => { pad = result })
      for (let i = 0; i < 20 && heldOffsetReceipts.length === 0; i++) await vi.advanceTimersByTimeAsync(10)
    })
    expect(socket().wire().at(-1)).toBe('G10 L20 P0 Z0')
    expect(pad).toBeNull()

    const pressed = socket().wire().length
    await operatorPressesCycleStart()
    expect(socket().wire().slice(pressed)).toEqual([])
    expect(consoleText()).toContain(`the probe cycle and its work zero ${WAITING}`)

    await act(async () => {
      releaseHeldOffsetReceipts()
      for (let i = 0; i < 20 && pad === null; i++) await vi.advanceTimersByTimeAsync(10)
      await cycle
    })
    expect(pad).toMatchObject({ ok: true })
    const answered = socket().wire().length
    await operatorPressesCycleStart()
    expect(socket().wire().slice(answered)).toEqual(['spindleOn'])
  })

  // THE RAMP'S HALF OF ROW 5 (audit, eighth round). CYCLE START has closed the
  // hold and the new spindle is ramping when the controller reopens. The board
  // the operator's G55 Z receipt came from is gone, so the restore of the
  // stored frames is a write setup 2 waits for as well.
  function reopenTheController(): void {
    socket().emit({
      t: 'console',
      v: { dir: 'rx', text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 1) - this link is live.', severity: 'info' },
    } as BridgeMessage)
  }
  const STAGE_2 = /^(selectWcs|loadMoves|startJob)/

  it('a controller reopen during the new spindle ramp keeps setup 2 stopped until the restored offsets are confirmed', async () => {
    await connect()
    await runToTheToolChange()
    await operatorSetsZZero()
    await operatorPressesCycleStart()
    expect(socket().wire().at(-1)).toBe('spindleOn')

    holdOffsetReceipts = true
    const reopened = socket().wire().length
    act(() => { reopenTheController() })
    await settle()
    pushVfd(BALL_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(socket().wire().slice(reopened)).toEqual(['setWorkOffset(G54 XYZ)'])
    expect(consoleText()).toContain('waits until the machine confirms the work offsets it is still writing')

    act(() => { releaseHeldOffsetReceipts() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    pushVfd(BALL_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(socket().wire().slice(reopened).filter((m) => /^(setWorkOffset\(G5[45]|selectWcs|loadMoves|startJob)/.test(m)))
      .toEqual(['setWorkOffset(G54 XYZ)', 'setWorkOffset(G55 XYZ)', 'selectWcs(G55)', 'loadMoves', 'startJob'])
    const restoredG55 = socket().sent
      .filter((m) => m.m === 'setWorkOffset' && (m.a as { wcs: string }).wcs === 'G55')
      .at(-1)?.a as { z?: number }
    expect(restoredG55.z).toBe(-4.25)
  })

  it('a reopen during the ramp that leaves the incoming frame unconfirmed stops the spindle and gives the hold back', async () => {
    await connect()
    await runToTheToolChange()
    await operatorSetsZZero()
    await operatorPressesCycleStart()
    expect(socket().wire().at(-1)).toBe('spindleOn')

    // Nothing stored to put back: the reopened board holds only its defaults.
    act(() => { useCamStore.setState({ machineWorkOffsets: {} }) })
    const reopened = socket().wire().length
    act(() => { reopenTheController() })
    await settle()
    pushVfd(BALL_RPM)
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })

    expect(socket().wire().slice(reopened).filter((m) => STAGE_2.test(m))).toEqual([])
    expect(socket().wire().slice(reopened)).toContain('spindleOff')
    expect(activeToolChangeHold()).not.toBeNull()
    expect(consoleText()).toContain('has not confirmed the G55 work offset since')

    // The operator's Z receipt belonged to the session that ended.
    const pressed = socket().wire().length
    await operatorPressesCycleStart()
    expect(socket().wire().slice(pressed)).toEqual([])
    expect(consoleText()).toContain('the machine has not confirmed a G55 Z work zero since the tool change')
  })

  // ROW 6, the negative control: no hold, nothing new. A program that is not
  // standing at a tool change starts exactly as it did with an offset write in
  // flight - this order adds no receipt gate to an ordinary CYCLE START.
  it('outside a tool change, CYCLE START is not held behind an offset receipt', async () => {
    await connect()
    await operatorLoadsAllSetups()
    holdOffsetReceipts = true
    let accepted = false
    act(() => { accepted = setWorkOffsetValue('G56', 'X', 3) })
    await settle()
    expect(accepted).toBe(true)
    expect(socket().wire().at(-1)).toBe('setWorkOffset(G56 X)')

    const pressed = socket().wire().length
    await operatorPressesCycleStart()
    expect(consoleText()).not.toContain(WAITING)
    expect(socket().wire().slice(pressed)).toEqual(['spindleOn'])
    act(() => { releaseHeldOffsetReceipts() })
    await settle()
  })
})
