// @vitest-environment jsdom
//
// WO-1267 - THE HANDLE ON THE GEOMETRY DOOR.
//
// WO-1019 built a second program route for a controller with no G-code
// interpreter (Operator's AXBB-E) and slice 1c deliberately left it unwired:
// "which operator control builds the active setup's toolpath and calls it is
// slice 1d". Slice 1d never came, so `loadGeometryProgram` had NO PRODUCTION
// CALLER at all. On the real machine the operator's Load posted G-code the
// board cannot read, the program armed EMPTY, "Re-arm from start" sat lit and
// did nothing, and CYCLE START could never enable.
//
// WHAT IS PROVEN HERE, THROUGH THE APPLICATION'S OWN ENTRY POINT (rule 6):
// the ProgramPanel is RENDERED and its "Load setup" menu item is CLICKED, on
// the real session singleton talking to a real `UccncController` over a fake
// bridge socket. No test on the acceptance path calls a session load function
// directly - the whole point of this order is that the OPERATOR can reach it.
//
//   - a setup loaded on a geometry controller ARMS, and the canonical CYCLE
//     START verdict is ENABLED with action 'start',
//   - the program that reached the board is the setup's own toolpath, in WORK
//     coordinates, and it left as `loadMoves` frames - no G-code was posted,
//   - 4,797 motion moves - the machine seat's baseline - arm as 2 PARTS and
//     the operator is told so,
//   - a setup with nothing generated, and a setup needing a tool change, are
//     REFUSED with nothing staged,
//   - a TEXT controller is untouched: the same Load posts G-code, stores the
//     text, and still offers "Re-arm from start".
//
// NOT CLAIMED: hardware. This order's Tier 3 evidence is the machine seat
// arming and running on the real AXBB-E; nothing here touches it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineProgram, MachineStatus } from '../../lib/machine/controller'
import {
  createDefaultControllerDefinition,
  type MachineConfig,
  type MachineSpindleDriveDefinition,
  type Operation,
  type Project,
  type Setup,
  type Tool,
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

/** The UPDATED AXBB-E bridge: no G-code interpreter, plus the geometry-program
 *  route WO-1019 added. This is the board this order exists for. */
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

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  autoConfirmWcs: boolean
  emit(message: BridgeMessage): void
  loadMovesFrames(): { moves: unknown[]; frame?: string }[]
}

const bridgeSockets: FakeBridgeTransport[] = []
type BridgeSpindleSupport = { vfd: boolean; board: boolean }
let bridgeSpindleSupport: BridgeSpindleSupport = { vfd: false, board: false }

// The real BridgeTransport declares private instance fields, so the fake must
// EXTEND it inside the mock factory, where the real class is reachable.
vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    autoConfirmWcs = true
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
          bridge: 'wo-1267-fake 0.0',
          capabilities: {
            ...PROGRAM_BRIDGE_CAPABILITIES,
            ...(bridgeSpindleSupport.board ? { boardSpindleCommands: true } : {}),
          },
          readOnly: false,
          vfd: bridgeSpindleSupport.vfd
            ? { present: true, verified: false, name: 'WO-1267 fake VFD' }
            : { present: false, verified: false, name: null },
          workOffsets: {
            current: {
              G54: { x: 10, y: 5, z: 2 },
              G55: { x: 110, y: 5, z: 2 },
              G56: { x: 0, y: 0 },
              G57: { x: 0, y: 0 },
              G58: { x: 0, y: 0 },
              G59: { x: 0, y: 0 },
            },
            profile: {
              G54: { x: 10, y: 5, z: 2 },
              G55: { x: 110, y: 5, z: 2 },
              G56: { x: 0, y: 0 },
              G57: { x: 0, y: 0 },
              G58: { x: 0, y: 0 },
              G59: { x: 0, y: 0 },
            },
          },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'selectWcs' && this.autoConfirmWcs) {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }

    /** The only route anything reaches the board's staged list by. */
    loadMovesFrames(): { moves: unknown[]; frame?: string }[] {
      return this.sent
        .filter((m) => m.m === 'loadMoves')
        .map((m) => m.a as { moves: unknown[]; frame?: string })
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { UccncController } = await import('../../lib/machine/uccncController')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const {
  currentOperatorTransport,
  executeOperatorCycleStart,
  executeOperatorFeedHold,
  executeOperatorStopReset,
} = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  controllerNeedsToolpathProgram,
  disconnectMachine,
  getMachineController,
  stagedGeometryProgramPath,
} = await import('../../lib/machine/machineSession')

/** Operator's real `Linearerror`, carried verbatim by the profile importer. */
const SAMPLE_MACHINE_LINEAR_ERROR: UnsentSetting = {
  controller: 'uccnc',
  key: 'Generalsettings.Linearerror',
  value: '0.03',
}

function machine(
  withSpindle = false,
  spindleDrive?: MachineSpindleDriveDefinition,
): MachineConfig {
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
    id: 'wo1267-machine',
    name: 'WO-1267 Test Machine',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition,
    unsentSettings: [SAMPLE_MACHINE_LINEAR_ERROR],
    ...(withSpindle
      ? { spindleLinkDefinition: {} as MachineConfig['spindleLinkDefinition'] }
      : {}),
    ...(spindleDrive !== undefined ? { spindleDrive } : {}),
  })
}

/** A rapid plus three feeds, in WORLD coordinates. The setup's WCS origin is
 *  NOT the world origin, so the world->work transform is really exercised.
 *
 *  Z 12 is the setup's CLEARANCE plane in world terms (a 10 mm clearance over a
 *  WCS origin at z 2). A generated toolpath that never reaches its own
 *  clearance plane is not a current one, so this is what the freshness gate
 *  both doors ask expects to see. */
function straightLineToolpath(): ToolpathMove[] {
  return [
    { type: 'rapid', x: 10, y: 5, z: 12 },
    { type: 'feed', x: 10, y: 5, z: 1, feed: 300 },
    { type: 'feed', x: 60, y: 5, z: 1, feed: 900 },
    { type: 'feed', x: 60, y: 45, z: 1, feed: 900 },
  ]
}

/** `count` moves that stay inside the envelope, lifting to a RAPID every 100 -
 *  the shape of a real raster, and the only shape a program over the board's
 *  cap can legally be split at (a part must end on a rapid). */
function longToolpath(count: number): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  for (let i = 0; i < count; i++) {
    const x = 10 + (i % 400) * 0.5
    const y = 5 + (i % 300) * 0.5
    moves.push(i % 100 === 0 ? { type: 'rapid', x, y, z: 12 } : { type: 'feed', x, y, z: 1, feed: 900 })
  }
  return moves
}

/** The machine-session shape recorded for WO-1322: three positioning moves
 * followed by 155 cutting moves, staged as two controller jobs by the spindle
 * gate while remaining one 158-move operator program. */
function recorded158MoveToolpath(): ToolpathMove[] {
  return [
    { type: 'rapid', x: 10, y: 5, z: 12 },
    { type: 'rapid', x: 20, y: 5, z: 12 },
    { type: 'rapid', x: 20, y: 10, z: 12 },
    ...Array.from({ length: 155 }, (_, index): ToolpathMove => ({
      type: 'feed',
      x: 20 + (index % 100),
      y: 10 + Math.floor(index / 100),
      z: 1,
      feed: 900,
    })),
  ]
}

function op(id: string, moves: ToolpathMove[], toolId = 't1'): Operation {
  return makeOp({ id, name: `Op ${id}`, type: 'contour_2d', toolId, status: 'ready', toolpathMoves: moves })
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

/** Real tools, because BOTH doors resolve one: the text door posts with it and
 *  the toolpath door hashes it into the freshness fingerprint. */
const TOOLS = [makeTool({ id: 't1', toolNumber: 1 }), makeTool({ id: 't2', toolNumber: 2 })]

function applyProject(
  operations: Operation[],
  { stale = false, spindle = false, spindleDrive, fixtureOffset = 54 }:
  {
    stale?: boolean
    spindle?: boolean
    spindleDrive?: MachineSpindleDriveDefinition
    fixtureOffset?: 54 | 55 | 56
  } = {},
): void {
  const setup = setupWith(operations)
  setup.wcs = makeWcs({
    id: 'w1',
    label: `G${fixtureOffset}`,
    fixtureOffset,
    origin: { x: 10, y: 5, z: 2 },
  })
  const project = {
    ...useCamStore.getState().project,
    machine: machine(spindle, spindleDrive),
    setups: [setup],
    activeSetupId: 'setup1',
    toolLibrary: TOOLS,
  }
  // Stamp each operation generation-current, exactly as a real regenerate
  // leaves it. Without this BOTH doors refuse for staleness - which is the
  // product behaviour, and is what the `stale` case below asserts.
  if (!stale) {
    for (const operation of setup.operations) {
      const tool = TOOLS.find((candidate) => candidate.id === operation.toolId) ?? TOOLS[0]
      stampGenerationCurrent(project, setup, operation, tool)
    }
  }
  useCamStore.setState({ project, toolLibrary: TOOLS })
}

/** The IDLE status frame the bridge pushes. CYCLE START is gated on idle, so a
 *  bridge test that never emits one can never reach the start verdict at all. */
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

function runningBridgeStatus(executingMoveId: number | null): MachineStatus {
  return {
    ...idleBridgeStatus(),
    state: 'run',
    executingMoveId,
    // Deliberately useless as execution progress: the bridge can push the
    // entire queue before the board has executed its first move.
    buffer: { moves: 0, capacitySeconds: null },
  }
}

let originalProject: Project
let originalToolLibrary: ReturnType<typeof useCamStore.getState>['toolLibrary']

beforeEach(() => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  bridgeSpindleSupport = { vfd: false, board: false }
  originalProject = useCamStore.getState().project
  originalToolLibrary = useCamStore.getState().toolLibrary
  applyProject([op('op1', straightLineToolpath())])
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

async function connect(
  kind: 'simulator' | 'bridge',
  spindleSupport: Partial<BridgeSpindleSupport> = {},
): Promise<void> {
  bridgeSpindleSupport = { vfd: false, board: false, ...spindleSupport }
  const pending = connectMachine(kind)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  if (kind === 'bridge') {
    act(() => {
      bridgeSockets[bridgeSockets.length - 1].emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
      bridgeSockets[bridgeSockets.length - 1].emit({
        t: 'homed',
        v: { axes: ['X', 'Y', 'Z'] },
      } as BridgeMessage)
    })
  } else {
    if (!getMachineController().home()) throw new Error('The simulator refused the homed fixture.')
    await vi.advanceTimersByTimeAsync(2_000)
  }
}

async function disconnectCurrentController(): Promise<void> {
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(300)
  await pending
}

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

/** The index entry for one step, as a MOTION trace. A motion step indexed as an
 *  action step carries no operation at all, so that is a failure here rather
 *  than something to type-guard past. */
function traceOf(
  program: MachineProgram,
  id: number,
): { opId: string; setupId: string; moveOrdinal: number } {
  const entry = program.index[id]
  if (entry === undefined) throw new Error(`Step ${id} has no index entry at all.`)
  if (!('opId' in entry)) throw new Error(`Step ${id} is indexed as an action step, not a move.`)
  return entry
}

/** THE OPERATOR'S OWN GESTURE: open the Load menu in the rendered panel and
 *  click the setup. This is the handle the door did not have. */
async function operatorLoadsTheSetup(): Promise<void> {
  render(<ProgramPanel />)
  act(() => { fireEvent.click(screen.getByTestId('control-load-menu')) })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-load-setup-item-setup1'))
    await Promise.resolve()
  })
  // WO-3125/WO-3292: the G-code text route's Setup Load spans several real
  // tasks (MessageChannel, not faked timers); wait for it to finish.
  const load = await import('../../lib/machine/setupLoadPreparation')
  for (let i = 0; i < 500 && (load.setupLoadInProgress() || load.setupLoadAdoptionInProgress()); i++) {
    await act(async () => { await load.yieldSetupLoadTask() })
  }
}

describe('WO-1267: a setup loads on a controller with no G-code interpreter', () => {
  beforeEach(async () => { await connect('bridge') })

  it('WO-1312 waits for the G55 echo before staging the first move', async () => {
    applyProject([op('op1', straightLineToolpath())], { fixtureOffset: 55 })
    useMachineControl.setState((state) => ({
      offsets: { ...state.offsets, G55: [288.7325, 397.655, 110] },
    }))
    socket().autoConfirmWcs = false

    await operatorLoadsTheSetup()

    const selection = socket().sent.find((frame) => frame.m === 'selectWcs')
    expect(selection?.a).toEqual({ wcs: 'G55' })
    expect(socket().loadMovesFrames()).toHaveLength(0)
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: false,
      reason: 'Waiting for the controller to confirm G55 before staging this program.',
    })

    await act(async () => {
      socket().emit({ t: 'reply', seq: selection!.seq, ok: true, v: true } as BridgeMessage)
      await Promise.resolve()
    })

    expect(socket().sent.map((frame) => frame.m).filter((method) =>
      method === 'selectWcs' || method === 'loadMoves'))
      .toEqual(['selectWcs', 'loadMoves'])
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    expect(useMachineControl.getState().programReadiness.reason)
      .toContain('4 moves, runs in G55')
  })

  it('WO-1312 refuses an unset setup frame before selection or motion staging', async () => {
    applyProject([op('op1', straightLineToolpath())], { fixtureOffset: 56 })

    await operatorLoadsTheSetup()

    expect(socket().sent.some((frame) => frame.m === 'selectWcs')).toBe(false)
    expect(socket().loadMovesFrames()).toHaveLength(0)
    expect(useMachineControl.getState().programReadiness).toEqual({
      ready: false,
      reason: 'G56 is not fully set on this controller, so nothing was staged. '
        + 'Set the X, Y and Z work zero for G56, then load the program again.',
    })
  })

  it('WO-1312 refuses when the controller does not echo the selected frame', async () => {
    applyProject([op('op1', straightLineToolpath())], { fixtureOffset: 55 })
    socket().autoConfirmWcs = false
    await operatorLoadsTheSetup()
    const selection = socket().sent.find((frame) => frame.m === 'selectWcs')!

    await act(async () => {
      socket().emit({
        t: 'reply', seq: selection.seq, ok: false, error: 'G55 selection was refused',
      } as BridgeMessage)
      await Promise.resolve()
    })

    expect(socket().loadMovesFrames()).toHaveLength(0)
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    expect(useMachineControl.getState().programReadiness.reason)
      .toContain('did not confirm G55 (G55 selection was refused), so nothing was staged')
  })

  it('the Load menu arms the program, and CYCLE START enables', async () => {
    expect(controllerNeedsToolpathProgram()).toBe(true)

    await operatorLoadsTheSetup()

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(true)
    expect(readiness.reason).toContain('Toolpath program "Setup 1 (toolpath)" loaded')
    expect(readiness.reason).toContain('4 moves, runs in G54')
    // The canonical verdict - the one gesture that can begin motion.
    const transport = currentOperatorTransport()
    expect(transport.cycleStartEnabled).toBe(true)
    expect(transport.action).toBe('start')
  })

  it('the toolpath reached the BOARD, in work coordinates', async () => {
    await operatorLoadsTheSetup()

    const frames = socket().loadMovesFrames()
    expect(frames).toHaveLength(1)
    expect(frames[0].frame).toBe('work')
    expect(frames[0].moves).toHaveLength(4)
    // WORLD (60,45,1) under a WCS origin of (10,5,2) is WORK (50,40,-1).
    expect((frames[0].moves[3] as { to: { x: number; y: number; z: number } }).to)
      .toEqual({ x: 50, y: 40, z: -1 })
  })

  it('WO-1322 draws the exact staged geometry path and the connected machine envelope', async () => {
    await operatorLoadsTheSetup()

    const staged = socket().loadMovesFrames().flatMap((frame) => frame.moves) as Array<{
      id: number
      kind: 'line'
      to: { x: number; y: number; z: number }
      rapid?: true
    }>
    const preview = stagedGeometryProgramPath()
    expect(preview).not.toBeNull()
    expect(preview!.moveLines).toEqual(staged.map((move) => move.id))
    expect(preview!.moves.map((move) => ({
      x: move.x,
      y: move.y,
      z: move.z,
      rapid: move.type === 'rapid',
    }))).toEqual(staged.map((move) => ({
      x: move.to.x,
      y: move.to.y,
      z: move.to.z,
      rapid: move.rapid === true,
    })))

    expect(screen.queryByText('Path preview appears when a program is loaded.')).toBeNull()
    const grid = screen.getByTestId('program-preview-grid-label') as HTMLSelectElement
    fireEvent.change(grid, { target: { value: 'machine' } })
    expect(grid.selectedOptions[0]?.textContent).toBe('Machine')
  })

  it('adaptive deferred roles are bounded by the driven machine, not the CAM machine', async () => {
    applyProject([op('op1', [
      { type: 'rapid', x: 10, y: 5, z: 12, role: 'rapid' },
      { type: 'feed', x: 10, y: 5, z: 1, feed: 321, role: 'lead_in' },
      { type: 'feed', x: 40, y: 5, z: 1, role: 'fast_traverse' },
      { type: 'feed', x: 60, y: 5, z: 1, role: 'finish' },
    ])])
    // Control is allowed to drive a machine other than the CAM project's
    // 5000 mm/min machine. The live session snapshot is the motion authority.
    act(() => {
      useCamStore.getState().setControlSessionMachine({
        ...machine(),
        id: 'driven-machine',
        name: 'Driven Test Machine',
        rapidRate: 1500,
      })
    })

    await operatorLoadsTheSetup()

    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    const staged = socket().loadMovesFrames()[0].moves as { feedMmMin: number; rapid?: boolean }[]
    expect(staged.map((move) => move.feedMmMin)).toEqual([1500, 321, 1500, 2000])
    expect(staged[2].rapid).not.toBe(true)
    expect(staged[3].rapid).not.toBe(true)
  })

  it('no G-code was posted for a board that cannot read any', async () => {
    await operatorLoadsTheSetup()

    // A toolpath program genuinely has no TEXT. Storing the posted G-code was
    // what left "Re-arm from start" lit over an armed-empty job: the control is
    // derived from `programText`, so the text was the lie the button believed.
    expect(useMachineControl.getState().programText).toBeNull()
    expect(useMachineControl.getState().job.name).toBe('Setup 1 (toolpath)')
    expect(socket().sent.filter((m) => m.m === 'loadJob')).toHaveLength(0)
    expect(currentOperatorTransport().reArm.offered).toBe(false)
  })

  it("the machine seat's 4,797-move baseline arms as 2 parts and says how many", async () => {
    applyProject([op('op1', longToolpath(4_797))])

    await operatorLoadsTheSetup()

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(true)
    expect(readiness.reason).toBe('program has 4797 moves - running in 2 parts')
    expect(currentOperatorTransport().cycleStartEnabled).toBe(true)
    // Only the FIRST part is staged; the rest follow at part boundaries, and it
    // ends on a rapid rather than at the cap - never mid-cut.
    const first = socket().loadMovesFrames()[0].moves
    expect(first.length).toBeLessThanOrEqual(4_095)
    expect((first[first.length - 1] as { rapid?: boolean }).rapid).toBe(true)
  })

  it('a setup with nothing generated is refused, and nothing is staged', async () => {
    applyProject([makeOp({ id: 'op1', status: 'pending', toolpathMoves: [] })])

    await operatorLoadsTheSetup()

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toContain('has no computed toolpath to send')
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)
    expect(socket().loadMovesFrames()).toHaveLength(0)
  })

  // WO-1653: THE MOMENT CODE LEAVES THE APP. A toolpath that no longer
  // matches its inputs is no longer refused outright - it is recomputed here,
  // silently, exactly as Post now does (rule 11: the software can do it, so
  // it does). This fixture's op is a bare hand-built stand-in with no Smart
  // Height authority at all, so the recompute genuinely CANNOT run - proving
  // the refusal below is the "cannot compute" case rule 11 still allows, not
  // the old blanket staleness refusal.
  it('a toolpath that genuinely cannot be recomputed is refused - it is not silently sent stale', async () => {
    applyProject([op('op1', straightLineToolpath())], { stale: true })

    await operatorLoadsTheSetup()

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toContain('has no computed toolpath to send')
    expect(socket().loadMovesFrames()).toHaveLength(0)
  })

  // WO-2013 re-pin (Operator at the machine, 2026-09-25): this used to be REFUSED -
  // "a toolpath program carries motion only - it cannot stop for a tool
  // change". The posted file of the same setup runs and stops at the change,
  // so the setup door now posts it and stages it through the file door. The
  // whole-run behaviour is pinned in loadMultiToolSetup.wo2013.test.ts.
  it('a setup needing a tool change loads as its posted program instead of being refused', async () => {
    applyProject([
      op('op1', straightLineToolpath(), 't1'),
      op('op2', straightLineToolpath(), 't2'),
    ])

    await operatorLoadsTheSetup()

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready, readiness.reason ?? '').toBe(true)
    expect(readiness.reason ?? '').not.toContain('it cannot stop for a tool change')
    expect(useMachineControl.getState().job.name).toBe('Setup 1 (posted)')
    expect(socket().loadMovesFrames().length).toBeGreaterThan(0)
    expect(currentOperatorTransport().cycleStartEnabled).toBe(true)
  })

  it('two operations on one tool load as ONE program, in operation order', async () => {
    applyProject([
      op('op1', straightLineToolpath()),
      op('op2', straightLineToolpath()),
    ])

    await operatorLoadsTheSetup()

    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    const frames = socket().loadMovesFrames()
    expect(frames).toHaveLength(1)
    expect(frames[0].moves).toHaveLength(8)
    // Ids are the PROGRAM's, minted once across both operations - two builds
    // would have restarted them at 1 and collided on the board.
    expect(frames[0].moves.map((move) => (move as { id: number }).id))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  // FIX ROUND 1, DEFECT 1. `collectToolpathSections` DROPS an operation whose
  // moves are empty (`nestRuntime.ts`), and the sum-is-zero guard above only
  // fires when EVERY section is empty. So one moveless operation among
  // survivors used to arm as if complete: readiness ready, CYCLE START
  // enabled, and the part missing a cut nobody was told about. The G-code door
  // has refused exactly this since CAM-12 (`buildPostInput.ts` re-adds the
  // dropped op so OP_NO_TOOLPATH refuses it loudly); this is the same refusal
  // on the other door to the same machine.
  it('an enabled operation with no moves is REFUSED by name, not silently left out', async () => {
    applyProject([
      op('op1', straightLineToolpath()),
      op('op2', []),
      op('op3', straightLineToolpath()),
    ])

    await operatorLoadsTheSetup()

    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(false)
    // The operation is NAMED - "something is missing" is not an answer the
    // operator can act on.
    expect(readiness.reason).toContain('Op op2')
    expect(readiness.reason).toContain('has no moves to send')
    expect(currentOperatorTransport().cycleStartEnabled).toBe(false)
    // Nothing reached the board: the two operations that DO have moves were not
    // staged as a stand-in for the setup the operator asked for.
    expect(socket().loadMovesFrames()).toHaveLength(0)
    // Said in words on the console, like every other refusal on this door.
    expect(useMachineControl.getState().consoleLines.some((line) => line.text.includes('Op op2')))
      .toBe(true)
  })

  // FIX ROUND 1, DEFECT 2. `status.executingMoveId` is attributed against
  // `program.index[id].opId` while the machine is cutting, and the builder
  // stamps ONE trace over the whole program - so without the per-section
  // correction every move after the first operation would report a plausible,
  // WRONG operation name. Read off the program that actually reached the
  // controller, not off an internal.
  it('a step from the SECOND operation is attributed to the second operation', async () => {
    applyProject([
      op('op1', straightLineToolpath()),
      op('op2', straightLineToolpath()),
    ])

    const ctrl = getMachineController()
    const staged: MachineProgram[] = []
    const original = ctrl.loadProgram!.bind(ctrl)
    ctrl.loadProgram = (program: MachineProgram) => {
      staged.push(program)
      return original(program)
    }
    try {
      await operatorLoadsTheSetup()
    } finally {
      ctrl.loadProgram = original
    }

    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(staged).toHaveLength(1)
    const program = staged[0]
    const steps = program.steps as readonly { id: number }[]
    expect(steps).toHaveLength(8)
    // Four moves each: steps 0-3 are op1's, steps 4-7 are op2's.
    expect(traceOf(program, steps[0].id).opId).toBe('op1')
    expect(traceOf(program, steps[3].id).opId).toBe('op1')
    expect(traceOf(program, steps[4].id).opId).toBe('op2')
    expect(traceOf(program, steps[7].id).opId).toBe('op2')
    // The ordinal stays the PROGRAM's, so a part boundary inside op2 still
    // slices the same list the ids were minted over.
    expect(traceOf(program, steps[4].id).moveOrdinal).toBe(4)
    expect(traceOf(program, steps[4].id).setupId).toBe('setup1')
  })
})

describe('WO-1273: geometry progress reaches the operator readout', () => {
  beforeEach(async () => { await connect('bridge', { vfd: true }) })

  function emitStatus(status: MachineStatus): void {
    act(() => { socket().emit({ t: 'status', v: status } as BridgeMessage) })
  }

  function emitCompleted(): void {
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  it('advances from executing move ids, holds on an absent id, and reaches total at completion', async () => {
    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)

    emitStatus(runningBridgeStatus(1))
    expect(useMachineControl.getState().job.ackedLines).toBe(0)

    await vi.advanceTimersByTimeAsync(101)
    emitStatus(runningBridgeStatus(3))
    expect(useMachineControl.getState().job).toMatchObject({ totalLines: 4, ackedLines: 2 })
    expect(screen.getByText(/2\/4 \(19%\)/)).toBeTruthy()

    // No id is no new execution fact. It must neither reset nor infer motion
    // from the deliberately empty buffer above.
    emitStatus(runningBridgeStatus(null))
    expect(useMachineControl.getState().job.ackedLines).toBe(2)

    emitCompleted()
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 4,
      ackedLines: 4,
    })
    expect(screen.getByText(/4\/4 \(100%\)/)).toBeTruthy()

    emitStatus({ ...idleBridgeStatus(), executingMoveId: 4 })
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 4,
      ackedLines: 4,
    })
    expect(screen.getByText(/4\/4 \(100%\)/)).toBeTruthy()
  })

  it('keeps an operator-stopped single job below 100 percent', async () => {
    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)

    emitStatus(runningBridgeStatus(3))
    expect(useMachineControl.getState().job).toMatchObject({ totalLines: 4, ackedLines: 2 })
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'stopped', fault: null } } as BridgeMessage)
    })

    expect(useMachineControl.getState().job).toMatchObject({ totalLines: 4, ackedLines: 2 })
    expect(screen.getByText(/2\/4 \(19%\)/)).toBeTruthy()
  })

  it('keeps the recorded 3 plus 155 run at 158 of 158 after the late idle status', async () => {
    applyProject([op('op1', recorded158MoveToolpath())], { spindle: true })
    const ctrl = getMachineController()
    ctrl.spindleOn = vi.fn(() => true)
    ctrl.spindleOff = vi.fn()

    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)

    const positioning = socket().loadMovesFrames()[0].moves as { id: number }[]
    expect(positioning).toHaveLength(3)
    emitStatus({ ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } })
    emitCompleted()

    const cut = socket().loadMovesFrames()[1].moves as { id: number }[]
    expect(cut).toHaveLength(155)
    emitStatus({ ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } })
    emitCompleted()
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 158,
      sentLines: 158,
      ackedLines: 158,
    })

    // The bridge's status channel may deliver the final Idle snapshot after
    // its completed lifecycle event. That frame still names move 158; it must
    // not reinterpret the final move as merely executing and regress to 157.
    emitStatus({ ...idleBridgeStatus(), executingMoveId: cut.at(-1)!.id })
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 158,
      sentLines: 158,
      ackedLines: 158,
    })
    expect(screen.getByText(/158\/158 \(100%\)/)).toBeTruthy()
  })

  it('keeps one whole-program count across a controller-sized part boundary', async () => {
    applyProject([op('op1', longToolpath(4_797))])
    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
    })

    const firstPart = socket().loadMovesFrames()[0].moves as { id: number }[]
    await vi.advanceTimersByTimeAsync(101)
    emitStatus(runningBridgeStatus(firstPart[100].id))
    expect(useMachineControl.getState().job.ackedLines).toBe(100)

    // The bridge declares the first part complete only after its idle status.
    // That terminal is both the visible boundary and the splitter's advance
    // authority, so part two is loaded exactly once.
    emitStatus({ ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } })
    emitCompleted()
    const frames = socket().loadMovesFrames()
    expect(frames).toHaveLength(2)
    const boundary = firstPart.length
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'streaming',
      totalLines: 4_797,
      ackedLines: boundary,
    })

    const secondPart = frames[1].moves as { id: number }[]
    emitStatus(runningBridgeStatus(secondPart[0].id))
    expect(useMachineControl.getState().job.ackedLines).toBe(boundary)
    await vi.advanceTimersByTimeAsync(101)
    emitStatus(runningBridgeStatus(secondPart[10].id))
    expect(useMachineControl.getState().job.ackedLines).toBe(boundary + 10)

    emitStatus({ ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } })
    emitCompleted()
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 4_797,
      ackedLines: 4_797,
    })
  })
})

describe('WO-1264: a toolpath program owns its spindle lifecycle', () => {
  beforeEach(async () => { await connect('bridge', { vfd: true }) })

  function installDeclaredSpindle({ acceptsStart = true } = {}): {
    spindleOn: ReturnType<typeof vi.fn>
    spindleOff: ReturnType<typeof vi.fn>
  } {
    applyProject([op('op1', straightLineToolpath())], { spindle: true })
    const ctrl = getMachineController()
    const spindleOn = vi.fn(() => acceptsStart)
    const spindleOff = vi.fn()
    ctrl.spindleOn = spindleOn
    ctrl.spindleOff = spindleOff
    return { spindleOn, spindleOff }
  }

  function emitJob(event: 'started' | 'paused' | 'resumed' | 'stopped' | 'completed'): void {
    act(() => { socket().emit({ t: 'jobEvent', v: { event, fault: null } }) })
  }

  /** WO-1275: a program this session commands a spindle for is staged as
   *  APPROACH then CUT, so its first `completed` is a part boundary and not
   *  the end of the operator's program. The board reaches that boundary by
   *  reporting idle with an empty buffer, exactly as WO-1054's handoff has
   *  always required. */
  function emitPartComplete(): void {
    act(() => {
      socket().emit({
        t: 'status',
        v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
      } as BridgeMessage)
    })
    emitJob('completed')
  }

  it('starts at the tool-resolved RPM/direction and stops on normal completion', async () => {
    const { spindleOn, spindleOff } = installDeclaredSpindle()
    await operatorLoadsTheSetup()

    expect(await executeOperatorCycleStart()).toBe(true)
    expect(spindleOn).toHaveBeenCalledWith('cw', 12_000)
    expect(socket().sent.filter((message) => message.m === 'startJob')).toHaveLength(1)

    emitJob('started')
    // The approach finishes; the program is NOT over and the spindle stays on.
    emitPartComplete()
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'streaming',
      totalLines: 4,
      ackedLines: 1,
    })
    expect(spindleOff).not.toHaveBeenCalled()
    expect(socket().sent.filter((message) => message.m === 'startJob')).toHaveLength(2)

    // The cut finishes. THAT is normal completion, and the spindle stops.
    emitPartComplete()
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 4,
      sentLines: 4,
      ackedLines: 4,
    })
    expect(screen.getByText(/4\/4 \(100%\)/)).toBeTruthy()
    expect(spindleOff).toHaveBeenCalled()
  })

  it('stops on Feed Hold, restarts before resume, and stops on Stop/Reset', async () => {
    const { spindleOn, spindleOff } = installDeclaredSpindle()
    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)
    emitJob('started')

    expect(executeOperatorFeedHold()).toBe(true)
    expect(spindleOff).toHaveBeenCalled()
    emitJob('paused')

    expect(await executeOperatorCycleStart()).toBe(true)
    expect(spindleOn).toHaveBeenCalledTimes(2)
    emitJob('resumed')

    expect(executeOperatorStopReset()).toBe(true)
    expect(spindleOff.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses motion and commands OFF when the spindle start is refused', async () => {
    const { spindleOn, spindleOff } = installDeclaredSpindle({ acceptsStart: false })
    await operatorLoadsTheSetup()

    expect(await executeOperatorCycleStart()).toBe(false)
    expect(spindleOn).toHaveBeenCalledWith('cw', 12_000)
    expect(spindleOff).toHaveBeenCalled()
    expect(socket().sent.filter((message) => message.m === 'startJob')).toHaveLength(0)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toContain('Cycle Start: refused')
  })

  it('keeps 4,095 motion moves under the board cap while spindle frames stay out of loadMoves', async () => {
    const { spindleOn } = installDeclaredSpindle()
    applyProject([op('op1', longToolpath(4_095))], { spindle: true })

    await operatorLoadsTheSetup()

    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(useMachineControl.getState().programReadiness.reason).toContain('4095 moves')
    // A LOAD TURNS NOTHING. The spindle is Cycle Start's business.
    expect(spindleOn).not.toHaveBeenCalled()

    // WO-1275 stages the approach separately from the cut, so this program
    // reaches the board as two loads. Every one of its moves still gets there,
    // neither load is over the cap, and - the point of this test - a spindle
    // frame never takes one of the board's move slots.
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(spindleOn).toHaveBeenCalledWith('cw', 12_000)
    emitJob('started')
    emitPartComplete()

    const frames = socket().loadMovesFrames()
    const staged = frames.flatMap((frame) => frame.moves)
    expect(staged).toHaveLength(4_095)
    expect(frames.every((frame) => frame.moves.length <= 4_095)).toBe(true)
    expect(staged.every((step) => (step as { kind: string }).kind !== 'spindle')).toBe(true)
  })

  it('drives the same program lifecycle from board spindle support advertised at hello', async () => {
    await disconnectCurrentController()
    applyProject([op('op1', straightLineToolpath())], {
      spindleDrive: { kind: 'relay' },
    })
    await connect('bridge', { board: true })
    const ctrl = getMachineController()
    const spindleOn = vi.fn(() => true)
    const spindleOff = vi.fn()
    ctrl.spindleOn = spindleOn
    ctrl.spindleOff = spindleOff

    expect(ctrl.capabilities.spindleCommands).toBe(true)
    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(spindleOn).toHaveBeenCalledWith('cw', 12_000)
    emitJob('started')
    emitPartComplete()
    emitPartComplete()
    expect(spindleOff).toHaveBeenCalled()
  })

  it.each([
    { label: 'no spindle declared', spindle: false, spindleDrive: undefined, removeVfd: false },
    { label: 'no live VFD route', spindle: true, spindleDrive: undefined, removeVfd: true },
    { label: 'an explicit manual drive', spindle: false, spindleDrive: { kind: 'manual' } as const, removeVfd: false },
  ])('runs unchanged with $label', async ({ spindle, spindleDrive, removeVfd }) => {
    applyProject([op('op1', straightLineToolpath())], { spindle, spindleDrive })
    const ctrl = getMachineController()
    if (removeVfd) {
      if (!(ctrl instanceof UccncController)) throw new Error('Expected the UCCNC controller fixture.')
      ctrl.confirmVfdLinkRemoved()
    }
    const spindleOn = vi.fn(() => true)
    ctrl.spindleOn = spindleOn
    ctrl.spindleOff = vi.fn()

    await operatorLoadsTheSetup()
    expect(socket().loadMovesFrames()[0].moves.map((step) => (step as { id: number }).id))
      .toEqual([1, 2, 3, 4])
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(spindleOn).not.toHaveBeenCalled()
  })
})

describe('WO-1267: a controller that runs G-code text is completely unchanged', () => {
  beforeEach(async () => { await connect('simulator') })

  it('the same Load menu posts G-code, stores the text, and still offers Re-arm from start', async () => {
    expect(controllerNeedsToolpathProgram()).toBe(false)

    await operatorLoadsTheSetup()

    const state = useMachineControl.getState()
    expect(state.programText).toContain('G1')
    expect(state.job.name).toBe('Setup 1 (posted)')
    // The text door's own re-arm control is still on the screen.
    expect(currentOperatorTransport().reArm.offered).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WO-1286: a traverse's feed comes from the MACHINE, resolved at the door.
//
// The adaptive engine emits fast_traverse (a G1 keep-down move at depth) and
// finish moves with no baked feed, by design (ADR-0001). The door is the layer
// that knows the machine, exactly as it is for the spindle, so it resolves
// the operation's feeds against the machine's rapid rate and stamps the two
// role feeds before the builder sees the program. Every other feed-less move
// still refuses by name: this resolves two roles, it does not invent feeds.
// ---------------------------------------------------------------------------
describe('WO-1286: fast_traverse and finish feeds are resolved at the door, from the machine', () => {
  beforeEach(async () => { await connect('bridge') })

  /** WORLD coordinates: a plunge, a cut, a feed-less traverse, a feed-less
   *  finish lap, all inside the travel under the (10, 5, 2) work origin. */
  function toolpathWithRoleFeeds(): ToolpathMove[] {
    return [
      { type: 'rapid', x: 10, y: 5, z: 12, role: 'rapid' },
      { type: 'feed', x: 10, y: 5, z: 1, feed: 300, role: 'plunge' },
      { type: 'feed', x: 60, y: 5, z: 1, feed: 900, role: 'cut' },
      { type: 'feed', x: 60, y: 45, z: 1, role: 'fast_traverse' },
      { type: 'feed', x: 10, y: 45, z: 1, role: 'finish' },
    ]
  }
  function stagedFeeds(): number[] {
    const frames = socket().loadMovesFrames()
    expect(frames).toHaveLength(1)
    return frames[0].moves.map((m) => (m as { feedMmMin: number }).feedMmMin)
  }
  /** Replace t1 in the library BEFORE applyProject stamps the operation
   *  generation-current, because the freshness fingerprint hashes the tool. */
  function withTool(overrides: Partial<Tool['feedsAndSpeeds'][string]>): void {
    const t1 = makeTool({ id: 't1', toolNumber: 1 })
    t1.feedsAndSpeeds = { default: { ...t1.feedsAndSpeeds.default, ...overrides } }
    TOOLS[0] = t1
  }
  afterEach(() => { TOOLS[0] = makeTool({ id: 't1', toolNumber: 1 }) })

  it("the tool's own fast-traverse and finish rates reach the board; the cut's feed is untouched", async () => {
    withTool({ fastTraverseFeedrate: 3500, finishFeedrate: 1500 })
    applyProject([op('op1', toolpathWithRoleFeeds())])
    await operatorLoadsTheSetup()
    // rapid at the machine rate, plunge, cut, traverse, finish
    expect(stagedFeeds()).toEqual([5000, 300, 900, 3500, 1500])
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
  })

  it('with no rates of its own, a traverse runs at the machine rapid and a finish lap at the cutting feed', async () => {
    applyProject([op('op1', toolpathWithRoleFeeds())])
    // makeTool: feedRate 2000, no fastTraverseFeedrate, no finishFeedrate.
    expect(await stagedFeedsAfterLoad()).toEqual([5000, 300, 900, 5000, 2000])
  })

  it("a traverse never exceeds the machine's rapid rate, whatever the tool asks for", async () => {
    withTool({ fastTraverseFeedrate: 9000 })
    applyProject([op('op1', toolpathWithRoleFeeds())])
    expect((await stagedFeedsAfterLoad())[3]).toBe(5000)
  })

  it('a feed-less move of any OTHER role is still refused by name, and nothing is staged', async () => {
    const moves = toolpathWithRoleFeeds()
    moves[2] = { type: 'feed', x: 60, y: 5, z: 1, role: 'cut' }
    applyProject([op('op1', moves)])
    await operatorLoadsTheSetup()
    expect(socket().loadMovesFrames()).toHaveLength(0)
    const readiness = useMachineControl.getState().programReadiness
    expect(readiness.ready).toBe(false)
    expect(readiness.reason).toMatch(/Move 2 is a feed move with no feed rate/)
  })

  // A missing tool never reaches the feed resolution through THIS door: the
  // freshness check refuses it first. The single-operation face is where that
  // refusal is reachable, and it is pinned in geometryProgramLoad.wo1031.

  async function stagedFeedsAfterLoad(): Promise<number[]> {
    await operatorLoadsTheSetup()
    return stagedFeeds()
  }
})

describe('WO-1273: geometry progress reaches the operator readout', () => {
  beforeEach(async () => { await connect('bridge') })

  function emitStatus(status: MachineStatus): void {
    act(() => { socket().emit({ t: 'status', v: status } as BridgeMessage) })
  }

  function emitCompleted(): void {
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
  }

  it('advances from executing move ids, holds on an absent id, and reaches total at completion', async () => {
    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)

    emitStatus(runningBridgeStatus(1))
    expect(useMachineControl.getState().job.ackedLines).toBe(0)

    await vi.advanceTimersByTimeAsync(101)
    emitStatus(runningBridgeStatus(3))
    expect(useMachineControl.getState().job).toMatchObject({ totalLines: 4, ackedLines: 2 })
    expect(screen.getByText(/2\/4 \(19%\)/)).toBeTruthy()

    // No id is no new execution fact. It must neither reset nor infer motion
    // from the deliberately empty buffer above.
    emitStatus(runningBridgeStatus(null))
    expect(useMachineControl.getState().job.ackedLines).toBe(2)

    emitCompleted()
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 4,
      ackedLines: 4,
    })
    expect(screen.getByText(/4\/4 \(100%\)/)).toBeTruthy()
  })

  it('keeps one whole-program count across a controller-sized part boundary', async () => {
    applyProject([op('op1', longToolpath(4_797))])
    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
    })

    const firstPart = socket().loadMovesFrames()[0].moves as { id: number }[]
    await vi.advanceTimersByTimeAsync(101)
    emitStatus(runningBridgeStatus(firstPart[100].id))
    expect(useMachineControl.getState().job.ackedLines).toBe(100)

    // The bridge declares the first part complete only after its idle status.
    // That terminal is both the visible boundary and the splitter's advance
    // authority, so part two is loaded exactly once.
    emitStatus({ ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } })
    emitCompleted()
    const frames = socket().loadMovesFrames()
    expect(frames).toHaveLength(2)
    const boundary = firstPart.length
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'streaming',
      totalLines: 4_797,
      ackedLines: boundary,
    })

    const secondPart = frames[1].moves as { id: number }[]
    emitStatus(runningBridgeStatus(secondPart[0].id))
    expect(useMachineControl.getState().job.ackedLines).toBe(boundary)
    await vi.advanceTimersByTimeAsync(101)
    emitStatus(runningBridgeStatus(secondPart[10].id))
    expect(useMachineControl.getState().job.ackedLines).toBe(boundary + 10)

    emitStatus({ ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } })
    emitCompleted()
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 4_797,
      ackedLines: 4_797,
    })
  })
})

describe('WO-1264: a toolpath program owns its spindle lifecycle', () => {
  beforeEach(async () => { await connect('bridge', { vfd: true }) })

  function installDeclaredSpindle({ acceptsStart = true } = {}): {
    spindleOn: ReturnType<typeof vi.fn>
    spindleOff: ReturnType<typeof vi.fn>
  } {
    applyProject([op('op1', straightLineToolpath())], { spindle: true })
    const ctrl = getMachineController()
    const spindleOn = vi.fn(() => acceptsStart)
    const spindleOff = vi.fn()
    ctrl.spindleOn = spindleOn
    ctrl.spindleOff = spindleOff
    return { spindleOn, spindleOff }
  }

  function emitJob(event: 'started' | 'paused' | 'resumed' | 'stopped' | 'completed'): void {
    act(() => { socket().emit({ t: 'jobEvent', v: { event, fault: null } }) })
  }

  /** WO-1275: a program this session commands a spindle for is staged as
   *  APPROACH then CUT, so its first `completed` is a part boundary and not
   *  the end of the operator's program. The board reaches that boundary by
   *  reporting idle with an empty buffer, exactly as WO-1054's handoff has
   *  always required. */
  function emitPartComplete(): void {
    act(() => {
      socket().emit({
        t: 'status',
        v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
      } as BridgeMessage)
    })
    emitJob('completed')
  }

  it('starts at the tool-resolved RPM/direction and stops on normal completion', async () => {
    const { spindleOn, spindleOff } = installDeclaredSpindle()
    await operatorLoadsTheSetup()

    expect(await executeOperatorCycleStart()).toBe(true)
    expect(spindleOn).toHaveBeenCalledWith('cw', 12_000)
    expect(socket().sent.filter((message) => message.m === 'startJob')).toHaveLength(1)

    emitJob('started')
    // The approach finishes; the program is NOT over and the spindle stays on.
    emitPartComplete()
    expect(spindleOff).not.toHaveBeenCalled()
    expect(socket().sent.filter((message) => message.m === 'startJob')).toHaveLength(2)

    // The cut finishes. THAT is normal completion, and the spindle stops.
    emitPartComplete()
    expect(spindleOff).toHaveBeenCalled()
  })

  it('stops on Feed Hold, restarts before resume, and stops on Stop/Reset', async () => {
    const { spindleOn, spindleOff } = installDeclaredSpindle()
    await operatorLoadsTheSetup()
    expect(await executeOperatorCycleStart()).toBe(true)
    emitJob('started')

    expect(executeOperatorFeedHold()).toBe(true)
    expect(spindleOff).toHaveBeenCalled()
    emitJob('paused')

    expect(await executeOperatorCycleStart()).toBe(true)
    expect(spindleOn).toHaveBeenCalledTimes(2)
    emitJob('resumed')

    expect(executeOperatorStopReset()).toBe(true)
    expect(spindleOff.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses motion and commands OFF when the spindle start is refused', async () => {
    const { spindleOn, spindleOff } = installDeclaredSpindle({ acceptsStart: false })
    await operatorLoadsTheSetup()

    expect(await executeOperatorCycleStart()).toBe(false)
    expect(spindleOn).toHaveBeenCalledWith('cw', 12_000)
    expect(spindleOff).toHaveBeenCalled()
    expect(socket().sent.filter((message) => message.m === 'startJob')).toHaveLength(0)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toContain('Cycle Start: refused')
  })

  it('keeps 4,095 motion moves under the board cap while spindle frames stay out of loadMoves', async () => {
    const { spindleOn } = installDeclaredSpindle()
    applyProject([op('op1', longToolpath(4_095))], { spindle: true })

    await operatorLoadsTheSetup()

    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(useMachineControl.getState().programReadiness.reason).toContain('4095 moves')
    // A LOAD TURNS NOTHING. The spindle is Cycle Start's business.
    expect(spindleOn).not.toHaveBeenCalled()

    // WO-1275 stages the approach separately from the cut, so this program
    // reaches the board as two loads. Every one of its moves still gets there,
    // neither load is over the cap, and - the point of this test - a spindle
    // frame never takes one of the board's move slots.
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(spindleOn).toHaveBeenCalledWith('cw', 12_000)
    emitJob('started')
    emitPartComplete()

    const frames = socket().loadMovesFrames()
    const staged = frames.flatMap((frame) => frame.moves)
    expect(staged).toHaveLength(4_095)
    expect(frames.every((frame) => frame.moves.length <= 4_095)).toBe(true)
    expect(staged.every((step) => (step as { kind: string }).kind !== 'spindle')).toBe(true)
  })

  it.each([
    { label: 'no spindle declared', spindle: false, spindleDrive: undefined, removeVfd: false },
    { label: 'no live VFD route', spindle: true, spindleDrive: undefined, removeVfd: true },
    { label: 'an explicit manual drive', spindle: false, spindleDrive: { kind: 'manual' } as const, removeVfd: false },
  ])('runs unchanged with $label', async ({ spindle, spindleDrive, removeVfd }) => {
    applyProject([op('op1', straightLineToolpath())], { spindle, spindleDrive })
    const ctrl = getMachineController()
    if (removeVfd) {
      if (!(ctrl instanceof UccncController)) throw new Error('Expected the UCCNC controller fixture.')
      ctrl.confirmVfdLinkRemoved()
    }
    const spindleOn = vi.fn(() => true)
    ctrl.spindleOn = spindleOn
    ctrl.spindleOff = vi.fn()

    await operatorLoadsTheSetup()
    expect(socket().loadMovesFrames()[0].moves.map((step) => (step as { id: number }).id))
      .toEqual([1, 2, 3, 4])
    expect(await executeOperatorCycleStart()).toBe(true)
    expect(spindleOn).not.toHaveBeenCalled()
  })
})

describe('WO-1267: a controller that runs G-code text is completely unchanged', () => {
  beforeEach(async () => { await connect('simulator') })

  it('the same Load menu posts G-code, stores the text, and still offers Re-arm from start', async () => {
    expect(controllerNeedsToolpathProgram()).toBe(false)

    await operatorLoadsTheSetup()

    const state = useMachineControl.getState()
    expect(state.programText).toContain('G1')
    expect(state.job.name).toBe('Setup 1 (posted)')
    // The text door's own re-arm control is still on the screen.
    expect(currentOperatorTransport().reArm.offered).toBe(true)
  })
})
