// @vitest-environment jsdom
//
// WO-1681 REVIEW (safety path) - PARK AND TOOL-CHANGE MOTION, ON THE WIRE.
//
// Driven through the REAL `UccncController` on the real session singleton,
// over a fake bridge socket that plays Operator's AXBB-E (hello, status frames and
// jog-call shapes as in toolLengthAndParkMoves.wo1548). Machine facts from
// docs/machine/MACHINE-SEAT-HANDOFF.md: home corner machine 738 / 724.5 /
// 128.9, G54 = 188.7325 / 397.655 / 110, Safe Z 120 (his .pro), corners
// M200-M203 at machine Z 128. Z machine zero is at the BOTTOM (min), so a low
// machine Z is the dangerous one. Every claim is about what reached the wire.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
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

const G54 = { x: 188.7325, y: 397.655, z: 110 }
const HOME: MachineVec3 = { x: 738, y: 724.5, z: 128.9 }

function boardOffsets(): Record<string, MachineVec3> {
  return {
    G54: { ...G54 },
    G55: { x: 288.7325, y: 397.655, z: 110 },
    G56: { x: 0, y: 0, z: 0 },
    G57: { x: 0, y: 0, z: 0 },
    G58: { x: 0, y: 0, z: 0 },
    G59: { x: 0, y: 0, z: 0 },
  }
}

/** One leg the board was told to move, normalised to MACHINE coordinates.
 *  `zAtStart` is the machine Z the board was at when this leg began. */
interface Leg { axes: 'Z' | 'XY' | 'XYZ'; x?: number; y?: number; z?: number; machineFrame: boolean; zAtStart: number; via: string }
interface WireMove { m: string; a: unknown; zWhenSent: number }
let sent: BridgeCallMessage[] = []
let wire: WireMove[] = []
let legs: Leg[] = []
let bridgeEvents: BridgeTransportEvents | null = null
let board = boardOffsets()
let machinePos: MachineVec3 = { ...HOME }
type Frame = { state: 'run' | 'idle'; pos: MachineVec3; event?: 'completed'; leg?: Leg }
let motion: Frame[] = []
let loaded: Array<{ id: number; to: Partial<MachineVec3>; machineAbsolute?: boolean }> = []
let jobRunning = false
let held = false
let boardAlarm = false
/** WO-2255 (B-3, Operator's board 09-30): report idle at the START (and call the job complete) for this many polls before
 *  the move shows as running - the real board's early idle. `neverMoves`: the move never runs at all. */
let lateStartPolls = 0
let neverMoves = false

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

/** One status frame from the board: the next frame of the move in progress
 *  (or a hold / alarm report). The bridge pushes these by itself; the
 *  controller's keepalive `queryStatus` also asks for one. */
function boardStatusTick(): void {
  if (!bridgeEvents) return
  if (boardAlarm || held) {
    // Re-review: an alarm (motion gone) or a feed hold (motion paused).
    if (boardAlarm) motion = []
    bridgeEvents.onMessage({
      t: 'status', v: boardStatus((boardAlarm ? 'alarm' : 'hold') as 'idle', machinePos),
    } as BridgeMessage)
    return
  }
  const frame = motion.shift()
  if (frame) machinePos = { ...frame.pos }
  if (frame?.leg) legs.push({ ...frame.leg })
  bridgeEvents.onMessage({ t: 'status', v: boardStatus(frame?.state ?? 'idle', machinePos) } as BridgeMessage)
  if (frame?.event === 'completed' && jobRunning) {
    jobRunning = false
    bridgeEvents.onMessage({ t: 'jobEvent', v: { event: 'completed' } } as unknown as BridgeMessage)
  }
}
function walk(from: MachineVec3, to: MachineVec3, steps = 8): Array<{ state: 'run' | 'idle'; pos: MachineVec3 }> {
  const frames: Array<{ state: 'run' | 'idle'; pos: MachineVec3 }> = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    frames.push({
      state: 'run',
      pos: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t },
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
            boardStatusTick()
            reply(true)
            return
          }
          case 'jogToMachineZ': {
            const a = message.a as { z: number }
            wire.push({ m: message.m, a: message.a, zWhenSent: machinePos.z })
            reply(true)
            motion = walk(machinePos, { ...machinePos, z: a.z })
            motion[0].leg = { axes: 'Z', z: a.z, machineFrame: true, zAtStart: machinePos.z, via: 'jogToMachineZ' }
            return
          }
          case 'jogToWorkXY': {
            const a = message.a as { x: number; y: number }
            wire.push({ m: message.m, a: message.a, zWhenSent: machinePos.z })
            reply(true)
            const to = { x: a.x + board.G54.x, y: a.y + board.G54.y, z: machinePos.z }
            motion = walk(machinePos, to)
            motion[0].leg = { axes: 'XY', x: to.x, y: to.y, machineFrame: false, zAtStart: machinePos.z, via: 'jogToWorkXY' }
            return
          }
          case 'loadMoves': {
            wire.push({ m: message.m, a: message.a, zWhenSent: machinePos.z })
            loaded = JSON.parse(JSON.stringify((message.a as { moves: typeof loaded }).moves ?? [])) as typeof loaded
            reply({ ok: true, reason: null })
            return
          }
          case 'startJob': {
            wire.push({ m: message.m, a: message.a, zWhenSent: machinePos.z })
            reply(true)
            jobRunning = true
            bridgeEvents?.onMessage({ t: 'jobEvent', v: { event: 'started' } } as unknown as BridgeMessage)
            let at = { ...machinePos }
            const frames: Frame[] = []
            for (const mv of loaded) {
              const abs = mv.machineAbsolute === true
              const target = {
                x: typeof mv.to.x !== 'number' ? at.x : mv.to.x + (abs ? 0 : board.G54.x),
                y: typeof mv.to.y !== 'number' ? at.y : mv.to.y + (abs ? 0 : board.G54.y),
                z: typeof mv.to.z !== 'number' ? at.z : mv.to.z + (abs ? 0 : board.G54.z),
              }
              const hasXY = typeof mv.to.x === 'number' || typeof mv.to.y === 'number'
              const hasZ = typeof mv.to.z === 'number'
              const leg: Leg = {
                axes: hasXY && hasZ ? 'XYZ' : hasZ ? 'Z' : 'XY',
                ...(hasXY ? { x: target.x, y: target.y } : {}),
                ...(hasZ ? { z: target.z } : {}),
                machineFrame: abs,
                zAtStart: at.z,
                via: 'loadMoves',
              }
              const w: Frame[] = walk(at, target).filter((f) => f.state === 'run')
              w[0].leg = leg
              frames.push(...w)
              at = target
            }
            frames.push({ state: 'idle', pos: { ...at } }, { state: 'idle', pos: { ...at }, event: 'completed' })
            if (lateStartPolls > 0 || neverMoves) {
              const start = { ...machinePos }
              const early: Frame[] = Array.from({ length: neverMoves ? 40 : lateStartPolls }, (_, i) => (
                i === 0 ? { state: 'idle', pos: start, event: 'completed' } : { state: 'idle', pos: start }
              ))
              motion = neverMoves ? early : [...early, ...frames.map((f) => (f.event === 'completed' ? { state: f.state, pos: f.pos } : f))]
              return
            }
            motion = frames
            return
          }
          case 'feedHold':
            // Re-review: a feed hold pauses the move where it is.
            wire.push({ m: message.m, a: message.a, zWhenSent: machinePos.z })
            held = true
            reply(true)
            return
          case 'reset':
          case 'stopJob':
          case 'emergencyStop':
            // The board stops where it is and reports idle there.
            wire.push({ m: message.m, a: message.a, zWhenSent: machinePos.z })
            held = false
            motion = []
            reply(true)
            if (jobRunning) {
              jobRunning = false
              bridgeEvents?.onMessage({ t: 'jobEvent', v: { event: 'stopped' } } as unknown as BridgeMessage)
            }
            return
          default:
            reply(true)
        }
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const {
  createDefaultControllerDefinition,
  positionMacroBody,
  parsePositionMacroBody,
  UCCNC_SAFE_Z_KEY,
  machineSafeZ,
  withControllerSetting,
} = await import('../../types')
type MachineConfig = import('../../types').MachineConfig
type MachineMacro = import('../../types').MachineMacro
const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { machineParkList, toolChangePark, toolChangeMacroPark } = await import('../../lib/machine/machineActions')
const { previewLocalUccncProfile } = await import('../../lib/machine/uccncProfileImport')
const { activeMacroRun, stopUserMacro, __resetMacroRuntimeForTest } = await import('../../lib/machine/macros/macroRuntime')
const { executeOperatorFeedHold, executeOperatorStopReset } = await import('../../lib/machine/operatorTransport')
const {
  __armEstopInterlockForTest,
  __resetEstopInterlockForTest,
  beginGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  triggerEmergencyStop,
  runParkMove,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

// Operator's corners, as his M200-M203 macro files state them (machine mm).
const CORNERS = [
  { id: 'park-m200', name: 'Park position 1', x: 738, y: 724.5, z: 128, mCode: 200 },
  { id: 'park-m201', name: 'Park position 2', x: 738, y: 50, z: 128, mCode: 201 },
  { id: 'park-m202', name: 'Park position 3', x: 50, y: 50, z: 128, mCode: 202 },
  { id: 'park-m203', name: 'Park position 4', x: 50, y: 724.5, z: 128, mCode: 203 },
]
const cornerMacros = (flagId: string | null = null): MachineMacro[] => CORNERS.map((c) => ({
  id: c.id,
  name: c.name,
  mCode: c.mCode,
  body: positionMacroBody({ x: c.x, y: c.y, z: c.z, zFirst: true }),
  ...(c.id === flagId ? { usedForToolChange: true } : {}),
}))

const MACHINE_ID = 'wo1681-review-axbb'

function sampleMachineLikeMachine(extra: Partial<MachineConfig> & Record<string, unknown>): MachineConfig {
  const base = useCamStore.getState().project.machine
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = 0
    axis.softLimitMax = axis.axis === 'Z' ? 130 : 740
  }
  return {
    ...base,
    id: MACHINE_ID,
    name: 'WO-1681 review AXBB-E',
    controller: 'uccnc',
    controllerDefinition,
    unsentSettings: undefined,
    travel: { x: 740, y: 740, z: 130 },
    rapidRate: 6000,
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'min' },
      y: { homesToward: 'max', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'min' },
    },
    referencePositions: undefined,
    macros: [],
    safeZMachine: 120,
    ...extra,
  } as MachineConfig
}

const txLines = () => useMachineControl.getState().consoleLines.filter((l) => l.dir === 'tx').map((l) => l.text)
const r3 = (n: number | undefined) => (n === undefined ? undefined : Number(n.toFixed(3)))
/** Every leg the board actually began, in order, in machine mm. */
const legSummary = () => legs.map((l) => ({ axes: l.axes, x: r3(l.x), y: r3(l.y), z: r3(l.z), zAtStart: r3(l.zAtStart) }))

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  bridgeEvents?.onMessage({ t: 'status', v: boardStatus('idle', machinePos) } as BridgeMessage)
  await vi.advanceTimersByTimeAsync(50)
  useMachineControl.setState({ activeWcs: 'G54' })
  sent = []
  wire = []
  legs = []
  useMachineControl.setState({ consoleLines: [] })
}

/** Advance until the board is part-way through the Z leg of a park. */
async function untilZLegUnderway(fromZ = HOME.z, toZ = 128): Promise<void> {
  const lo = Math.min(fromZ, toZ)
  const hi = Math.max(fromZ, toZ)
  const between = () => machinePos.z > lo && machinePos.z < hi && Math.abs(machinePos.z - toZ) > (hi - lo) / 3
  for (let i = 0; i < 400 && !(legs.length === 1 && between()); i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  }
  expect(legs.map((l) => l.axes)).toEqual(['Z'])
  expect(between()).toBe(true)
}

async function runOut(ms = 20000): Promise<void> {
  for (let t = 0; t < ms; t += 250) await act(async () => { await vi.advanceTimersByTimeAsync(250) })
}

/** The exact park the review asks for: Z alone to its height, then XY at that
 *  height - both legs in machine coordinates, nothing else moving. */
function expectCornerPark(c: { x: number; y: number; z: number }, zLeg = c.z): void {
  expect(legSummary()).toEqual([
    { axes: 'Z', x: undefined, y: undefined, z: zLeg, zAtStart: HOME.z },
    { axes: 'XY', x: c.x, y: c.y, z: undefined, zAtStart: zLeg },
  ])
  // Every staged move the board was handed is a G53 (machine-absolute) move.
  for (const w of wire.filter((e) => e.m === 'loadMoves')) {
    for (const mv of (w.a as { moves: Array<{ machineAbsolute?: boolean }> }).moves) expect(mv.machineAbsolute).toBe(true)
  }
  expect(machinePos.x).toBeCloseTo(c.x, 6)
  expect(machinePos.y).toBeCloseTo(c.y, 6)
  expect(machinePos.z).toBeCloseTo(zLeg, 6)
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  wire = []
  legs = []
  loaded = []
  jobRunning = false
  held = false
  boardAlarm = false
  lateStartPolls = 0
  neverMoves = false
  motion = []
  board = boardOffsets()
  machinePos = { ...HOME }
  mem.clear()
  __resetMacroRuntimeForTest()
  useCamStore.getState().newProject()
  useCamStore.setState({ machineWorkOffsets: {} })
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useMachineControl.setState({ consoleLines: [], parserModal: null, offsets: {}, toolChange: null })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  __resetMacroRuntimeForTest()
  vi.useRealTimers()
})

describe('Q1: a park macro is Z first, then XY, machine coordinates - every door', () => {
  beforeEach(() => {
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({ macros: cornerMacros() }))
  })

  it('panel button: G21 G90 G53 G0 Z128, then G21 G90 G53 G0 X738 Y50', async () => {
    await connectBridge()
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    await act(async () => { fireEvent.click(screen.getByTestId('control-user-macro-park-m201')) })
    await runOut()
    expect(txLines().filter((t) => t.startsWith('G21'))).toEqual(['G21 G90 G53 G0 Z128', 'G21 G90 G53 G0 X738 Y50'])
    expectCornerPark(CORNERS[1])
    expect(activeMacroRun()).toBeNull()
  })

  it('typed M201 in MDI runs the same two lines', async () => {
    await connectBridge()
    expect(sendMdiLine('M201')).toBe(true)
    await runOut()
    expect(txLines().filter((t) => t.startsWith('G21'))).toEqual(['G21 G90 G53 G0 Z128', 'G21 G90 G53 G0 X738 Y50'])
    expectCornerPark(CORNERS[1])
  })

  it('G30 P2 reaches the same corner, Z first', async () => {
    await connectBridge()
    expect(sendMdiLine('G21 G30 P2')).toBe(true)
    await runOut()
    expectCornerPark(CORNERS[1])
  })

  it('the tool change at M6 parks at the flagged macro: its own machine Z first, then its XY', async () => {
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({ macros: cornerMacros('park-m202') }))
    await connectBridge()
    const machine = useCamStore.getState().project.machine
    const config = useMachineActions.getState().configFor(MACHINE_ID)
    const park = toolChangePark(machine, config, machineParkList(machine, config))
    expect(park?.id).toBe('park-m202')
    let done: boolean | null = null
    void beginGuidedToolChange({ tool: 2, resumeLine: 1, park: park!, safeZMachine: 120 }).then((v) => { done = v })
    await runOut(15000)
    expect(done).toBe(true)
    expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')
    // WO-2437 fix round 4: the bridge's guided park goes to the park's own Z, as
    // every other door does (main: the machine's safe Z 120).
    expectCornerPark(CORNERS[2])
  })
})

describe('Q2: the tool change parks only at the flagged macro, never a guess or a stale id', () => {
  it('no flag and four position macros: no tool-change park (manual M6 hold)', () => {
    const machine = sampleMachineLikeMachine({ macros: cornerMacros() })
    const config = { overrides: {}, custom: [] }
    const parks = machineParkList(machine, config)
    expect(parks).toHaveLength(4)
    expect(toolChangeMacroPark(machine, parks)).toBeNull()
    expect(toolChangePark(machine, config, parks)).toBeNull()
  })

  it('a stale wiring toolChangeParkId naming a macro never resolves a park once the record is macros', () => {
    useMachineActions.setState({
      byMachine: { [MACHINE_ID]: { overrides: {}, custom: [], toolChangeParkId: 'park-m203' } },
    })
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({ macros: cornerMacros() }))
    const machine = useCamStore.getState().project.machine
    // Adoption of a record that is already macros bakes nothing.
    expect(machine.macros?.some((m) => m.usedForToolChange)).toBe(false)
    const config = useMachineActions.getState().configFor(MACHINE_ID)
    expect(toolChangePark(machine, config, machineParkList(machine, config))).toBeNull()
  })

  it('a stale id naming a deleted park (wiring parks, pre-1670) resolves nothing either', () => {
    useMachineActions.setState({
      byMachine: {
        [MACHINE_ID]: {
          overrides: {},
          custom: [],
          parks: [{ id: 'old-pad', label: 'Old pad', x: 5, y: 5, z: 20 }],
          toolChangeParkId: 'old-pad',
        },
      },
    })
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({ macros: cornerMacros() }))
    const machine = useCamStore.getState().project.machine
    const config = useMachineActions.getState().configFor(MACHINE_ID)
    const parks = machineParkList(machine, config)
    expect(parks.map((p) => p.id)).not.toContain('old-pad')
    expect(toolChangePark(machine, config, parks)).toBeNull()
  })
})

describe('Q3: E-STOP latch and a user Stop', () => {
  beforeEach(() => {
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({ macros: cornerMacros() }))
  })

  it('latched E-STOP: button, typed M-code and G30 send no move', async () => {
    await connectBridge()
    act(() => { __armEstopInterlockForTest() })
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    await act(async () => { fireEvent.click(screen.getByTestId('control-user-macro-park-m201')) })
    await runOut(3000)
    sendMdiLine('M202')
    await runOut(3000)
    sendMdiLine('G21 G30 P3')
    await runOut(3000)
    expect(legs).toEqual([])
    expect(wire.filter((w) => w.m === 'loadMoves' || w.m === 'startJob' || w.m.startsWith('jogTo'))).toEqual([])
    expect(machinePos).toEqual(HOME)
  })

  it('an E-STOP latched during the Z leg: XY never follows', async () => {
    await connectBridge()
    expect(sendMdiLine('M202')).toBe(true)
    await untilZLegUnderway()
    act(() => { __armEstopInterlockForTest() })
    await runOut()
    expect(legs.map((l) => l.axes)).toEqual(['Z'])
    expect(machinePos.x).toBe(HOME.x)
  })

  it('Stop/Reset during the Z leg: the park ends, XY never follows', async () => {
    await connectBridge()
    expect(sendMdiLine('M202')).toBe(true)
    await untilZLegUnderway()
    act(() => { executeOperatorStopReset() })
    await runOut()
    expect(wire.map((w) => w.m).some((m) => m === 'stopJob' || m === 'reset')).toBe(true)
    expect(legs.map((l) => l.axes)).toEqual(['Z'])
    expect(machinePos.x).toBe(HOME.x)
    expect(activeMacroRun()).toBeNull()
  })

  it('the dangerous shape of it: tool low at machine Z 30, park, Stop/Reset at ~Z 60 - XY must not rapid at that height', async () => {
    machinePos = { x: 400, y: 400, z: 30 }
    await connectBridge()
    expect(sendMdiLine('M202')).toBe(true)
    await untilZLegUnderway(30, 128)
    const stoppedNear = machinePos.z
    act(() => { executeOperatorStopReset() })
    await runOut()
    expect(stoppedNear).toBeLessThan(100)
    // Red today: the macro sees Idle after the Stop and stages
    // `G21 G90 G53 G0 X50 Y50` at the Z the Stop left it at.
    expect(legSummary().filter((l) => l.axes !== 'Z')).toEqual([])
    expect(machinePos.x).toBe(400)
  })

  it('negative control - the pre-1681 park door (runParkMove): Stop/Reset during the Z leg, XY never follows', async () => {
    await connectBridge()
    expect(runParkMove({ id: 'c3', label: 'Corner 3', x: 50, y: 50, z: 128 }, 120)).toEqual({ ok: true })
    await untilZLegUnderway()
    act(() => { executeOperatorStopReset() })
    await runOut(20000)
    expect(legs.map((l) => l.axes)).toEqual(['Z'])
    expect(machinePos.x).toBe(HOME.x)
  })

  it('the macro Stop during the Z leg: XY never follows', async () => {
    await connectBridge()
    expect(sendMdiLine('M202')).toBe(true)
    await untilZLegUnderway()
    act(() => { stopUserMacro() })
    await runOut()
    expect(legs.map((l) => l.axes)).toEqual(['Z'])
    expect(machinePos.x).toBe(HOME.x)
  })
})

describe('Q4: Operator\'s imported profile keeps raw macros and derives exact positions', () => {
  const ROOT = process.cwd()
  const PRO = readFileSync(join(ROOT, 'docs/machine/profiles/LienCNCV2.pro'), 'utf8')
  const MACRO_DIR = join(ROOT, 'src/tests/evidence/WO-1548/machine-2026-09-17/macros')
  const MACROS = readdirSync(MACRO_DIR).map((name) => ({
    name: `Macro_LienCNCV2/${name}`,
    text: readFileSync(join(MACRO_DIR, name), 'utf8'),
  }))

  it('his M200-M203 stay raw while their four G30 positions remain exact (0.001 mm)', () => {
    const preview = previewLocalUccncProfile(null, 'LienCNCV2.pro', PRO, MACROS)
    const got = Object.entries(preview.referencePositions ?? {}).map(([point, position]) => ({
      point: Number(point),
      ...position,
    }))
    expect(got).toHaveLength(4)
    CORNERS.forEach((c, i) => {
      expect(got[i].point).toBe(i + 1)
      expect(Math.abs(got[i].x - c.x)).toBeLessThan(0.001)
      expect(Math.abs(got[i].y - c.y)).toBeLessThan(0.001)
      expect(Math.abs(got[i].z - c.z)).toBeLessThan(0.001)
      const imported = preview.parkMacros?.find((macro) => macro.mCode === c.mCode)
      const source = MACROS.find((file) => file.name.endsWith(`/M${c.mCode}.txt`))
      expect(imported?.body).toBe(source?.text)
      expect(parsePositionMacroBody(imported?.body ?? '')).toBeNull()
    })
    expect(machineSafeZ({ controllerDefinition: preview.definition ?? undefined })?.z ?? 120).toBe(120)
  })

  it('G30 runs the derived park on the wire while unsupported raw C# sends no motion', async () => {
    const preview = previewLocalUccncProfile(null, 'LienCNCV2.pro', PRO, MACROS)
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({
      macros: preview.parkMacros,
      referencePositions: preview.referencePositions,
    }))
    await connectBridge()

    expect(sendMdiLine('G21 G30 P2')).toBe(true)
    await runOut()
    expectCornerPark(CORNERS[1])

    legs = []
    wire = []
    useMachineControl.setState({ consoleLines: [] })
    expect(sendMdiLine('M200')).toBe(false)
    await runOut(1000)
    expect(legs).toEqual([])
    expect(wire.filter((entry) => ['loadMoves', 'startJob', 'jogToMachineZ', 'jogToWorkXY'].includes(entry.m))).toEqual([])
    expect(useMachineControl.getState().consoleLines.some(({ text }) => (
      text.includes('Macro "UCCNC M200" did not run')
    ))).toBe(true)
  })

  it('a WO-1670-era record of his parks folds to macros unchanged, and his TC choice becomes the flag', () => {
    useMachineActions.setState({
      byMachine: { [MACHINE_ID]: { overrides: {}, custom: [], toolChangeParkId: 'park-m201' } },
    })
    const def = createDefaultControllerDefinition()
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({
      macros: undefined,
      safeZMachine: undefined,
      controllerDefinition: {
        ...def,
        settings: withControllerSetting(def.settings, 'uccnc', UCCNC_SAFE_Z_KEY, { kind: 'number', value: 120 }),
      },
      parks: CORNERS.map((c) => ({
        id: c.id, label: c.name, x: c.x, y: c.y, z: c.z, zFirst: true, mCode: c.mCode,
        source: { kind: 'imported', file: `M${c.mCode}.txt` },
      })),
    } as unknown as Partial<MachineConfig>))
    const loaded = useCamStore.getState().project.machine
    expect('parks' in loaded).toBe(false)
    expect(loaded.macros?.map((m) => [m.id, m.mCode, m.usedForToolChange ?? false, parsePositionMacroBody(m.body)])).toEqual(
      CORNERS.map((c) => [c.id, c.mCode, c.id === 'park-m201', { x: c.x, y: c.y, z: c.z, zFirst: true }]),
    )
  })
})

describe('Q1 (conversion): a legacy park with no Z never becomes a move to a height nobody stated', () => {
  // WO-1670's Park section made parks with `z: null` ("the machine's safe Z")
  // and never required a safe Z. Such a park used to REFUSE to run
  // (buildParkSequence: "states no Z and this machine has no safe Z").
  it('converted and pressed, it does not drive Z to machine Z 0 (the bottom here) and then XY', async () => {
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({
      macros: undefined,
      safeZMachine: undefined,
      parks: [{ id: 'front', label: 'Front', x: 100, y: 50, z: null, zFirst: true, mCode: 300, source: { kind: 'typed' } }],
    } as unknown as Partial<MachineConfig>))
    const loaded = useCamStore.getState().project.machine
    expect(machineSafeZ(loaded)).toBeNull()
    await connectBridge()
    sendMdiLine('M300')
    await runOut(20000)
    // What the board began: no Z leg to machine Z 0, no XY leg begun there.
    expect(legSummary().filter((l) => l.axes === 'Z').map((l) => l.z)).not.toContain(0)
    expect(legSummary().filter((l) => l.axes !== 'Z' && l.zAtStart === 0)).toEqual([])
  })
})

// ---- RE-REVIEW (fix round d716c7a28..e6750f87b) ----
// Every way the board can stop ends a running macro and nothing further is
// sent - for a park AND for a user macro with several goTo legs - and a leg
// counts as done only at its target.
describe('Re-review: every stop ends a running macro; a leg counts only at its target', () => {
  // Several goTo legs, machine coordinates (a work-frame goTo is staged as one
  // XYZ move this fake does not model; not claimed here).
  const MULTI: MachineMacro = {
    id: 'multi',
    name: 'Multi',
    mCode: 310,
    body: [
      'goTo({ x: 400, y: 400, z: 128 })',
      'goTo({ x: 300, y: 300, z: 120 })',
      'goTo({ x: 200, y: 200, z: 110 })',
    ].join('\n'),
  }

  beforeEach(() => {
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({ macros: [...cornerMacros(), MULTI] }))
  })

  /** Run out with the board also pushing its own status frames (as the real
   *  bridge does), not only answering the keepalive. */
  async function pushedRunOut(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 100) {
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      act(() => { boardStatusTick() })
    }
  }

  /** Advance until the board has begun leg `n` (1-based) and is mid-way. */
  async function untilLegMidway(n: number): Promise<void> {
    for (let i = 0; i < 600 && !(legs.length === n && motion.filter((f) => f.state === 'run').length >= 3); i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(5) })
      if (i % 10 === 9) act(() => { boardStatusTick() })
    }
    expect(legs.length).toBe(n)
    expect(motion.filter((f) => f.state === 'run').length).toBeGreaterThanOrEqual(3)
  }

  it('the several-leg user macro runs every leg to its target when nothing stops it', async () => {
    await connectBridge()
    expect(sendMdiLine('M310')).toBe(true)
    await pushedRunOut(30000)
    expect(legSummary().map((l) => [l.axes, l.x, l.y, l.z])).toEqual([
      ['Z', undefined, undefined, 128],
      ['XY', 400, 400, undefined],
      ['Z', undefined, undefined, 120],
      ['XY', 300, 300, undefined],
      ['Z', undefined, undefined, 110],
      ['XY', 200, 200, undefined],
    ])
    expect(activeMacroRun()).toBeNull()
  })

  const STOPS: Array<[string, () => Promise<void>]> = [
    ['transport Stop/Reset', async () => { act(() => { executeOperatorStopReset() }) }],
    ['feed hold, then Stop/Reset', async () => {
      act(() => { executeOperatorFeedHold() })
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      act(() => { executeOperatorStopReset() })
    }],
    ['an alarm on the board', async () => { boardAlarm = true }],
    ['the E-STOP', async () => { act(() => { triggerEmergencyStop() }) }],
    ['a lost connection', async () => {
      const pending = disconnectMachine()
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      await pending
    }],
    ['the board stopping on its own (no app Stop): the leg never reached its target', async () => {
      motion = [{ state: 'idle', pos: { ...machinePos } }, { state: 'idle', pos: { ...machinePos } }]
      if (jobRunning) {
        jobRunning = false
        bridgeEvents?.onMessage({ t: 'jobEvent', v: { event: 'stopped' } } as unknown as BridgeMessage)
      }
    }],
  ]

  for (const [label, stop] of STOPS) {
    for (const [macroName, code, stopAtLeg] of [['park M202', 'M202', 1], ['user macro M310', 'M310', 1], ['user macro M310', 'M310', 3]] as const) {
      it(`${label} during leg ${stopAtLeg} of ${macroName}: the macro ends, no further leg`, async () => {
        machinePos = { x: 400, y: 400, z: 30 }
        await connectBridge()
        expect(sendMdiLine(code)).toBe(true)
        await untilLegMidway(stopAtLeg)
        await stop()
        await pushedRunOut(30000)
        expect(legs.length).toBe(stopAtLeg)
        expect(activeMacroRun()).toBeNull()
      })
    }
  }
})


// WO-2255 (B-3, Operator's machine 2026-09-30, Park 3 at G55 rot 30): the macro checked arrival ~70 ms after the send, on
// the board's first idle-with-no-job report, while the move had not shown as running yet - it stopped after the Z
// leg ("did not reach the position ... names") and the X/Y leg was never sent.
describe('B-3: a leg whose move starts a poll late still reaches its target (WO-2255)', () => {
  beforeEach(() => {
    useCamStore.getState().setProjectMachine(sampleMachineLikeMachine({ macros: cornerMacros() }))
  })

  for (const polls of [1, 2, 3]) {
    it(`the board reads idle (job complete) at the start for ${polls} poll(s) before each leg moves: both legs run, no stop`, async () => {
      lateStartPolls = polls
      await connectBridge()
      render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
      await act(async () => { fireEvent.click(screen.getByTestId('control-user-macro-park-m201')) })
      await runOut()
      expect(txLines().some((t) => t.includes('did not reach the position'))).toBe(false)
      expect(txLines().filter((t) => t.startsWith('G21'))).toEqual(['G21 G90 G53 G0 Z128', 'G21 G90 G53 G0 X738 Y50'])
      expectCornerPark(CORNERS[1])
      expect(activeMacroRun()).toBeNull()
    })
  }

  it('a move that never runs still ends the macro at the Z leg (the X/Y leg is never sent)', async () => {
    neverMoves = true
    await connectBridge()
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    await act(async () => { fireEvent.click(screen.getByTestId('control-user-macro-park-m201')) })
    await runOut()
    expect(txLines().some((t) => t.includes('did not reach the position "G21 G90 G53 G0 Z128" names'))).toBe(true)
    expect(txLines().filter((t) => t.startsWith('G21'))).toEqual(['G21 G90 G53 G0 Z128'])
    expect(activeMacroRun()).toBeNull()
  })
})
