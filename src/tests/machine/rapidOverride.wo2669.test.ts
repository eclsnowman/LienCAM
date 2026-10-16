// @vitest-environment jsdom
//
// Part 1 - simulator characterization (October 13): what the browser simulator
// and the UccncController wire boundary do with a rapid request. Unchanged.
// Part 2 - WO-2669 route A (the owner 2026-10-13 9:09 PM CT, "Build A - slower G0"):
// on the UC100 the app sends each G0 at the machine rapid x Rapid %. Proven on
// the real session singleton, its production file door and a real
// UccncController over a fake bridge socket, read off what reached the wire.
// NOT CLAIMED: the board. The air-cut row (Rapid 25 %: G0 at 2000) is owed.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SimulatedController, SIMULATOR_DEFAULT_RAPID_MM_MIN } from '../../lib/machine/simulatedController'
import { SUPPORTED_BRIDGE_PROTOCOL, UccncController, type UccncTransport } from '../../lib/machine/uccncController'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerEvents, MachineStatus, QueuedMove } from '../../lib/machine/controller'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { makeMachine } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
} satisfies Storage })

/** A fake AXBB-E bridge socket: the hello the board's bridge sent on 10-07
 *  (feed and spindle overrides, no rapid). It takes every load and runs a
 *  started job until the test finishes it. */
let board: {
  sent: BridgeCallMessage[]
  /** Set: the board answers the next loads with this refusal. */
  refuseLoad: string | null
  /** The moves of the last load the board took - what it holds. */
  moves: QueuedMove[]
  emit(message: BridgeMessage): void
  status(state: MachineStatus['state']): void
  finish(): void
} | null = null
vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  const { typedMock } = await import('../support/typedMock')
  const G54 = { x: 10, y: 5, z: 2 }
  class FakeBoard extends actual.BridgeTransport {
    static isSupported() { return true }
    sent: BridgeCallMessage[] = []
    refuseLoad: string | null = null
    fakeEvents: BridgeTransportEvents | null = null
    moves: QueuedMove[] = []
    pos = { x: 0, y: 0, z: 0 }
    constructor(...args: ConstructorParameters<typeof actual.BridgeTransport>) { super(...args); board = this }
    emit(message: BridgeMessage) { this.fakeEvents?.onMessage(message) }
    status(state: MachineStatus['state']) {
      this.emit({ t: 'status', v: {
        state, subState: null, machinePos: { ...this.pos },
        workPos: { x: this.pos.x - G54.x, y: this.pos.y - G54.y, z: this.pos.z - G54.z },
        feedMmMin: 0, spindleRpm: null, overrides: { feed: 100, rapid: null, spindle: 100 },
        executingMoveId: 0, buffer: { moves: null, capacitySeconds: null }, inputs: null, homed: null, spindle: null,
      } } as BridgeMessage)
    }
    finish() {
      for (const move of this.moves) if (move.kind === 'line' || move.kind === 'arc') {
        for (const axis of ['x', 'y', 'z'] as const) if (move.to[axis] !== undefined) this.pos[axis] = move.to[axis]! + G54[axis]
      }
      this.status('idle')
      this.emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    }
    async start(events: BridgeTransportEvents) {
      this.fakeEvents = events
      const offsets = Object.fromEntries(['G54', 'G55', 'G56', 'G57', 'G58', 'G59']
        .map((wcs) => [wcs, wcs === 'G54' ? { ...G54 } : { x: 0, y: 0, z: 0 }]))
      this.emit({ t: 'hello', v: {
        protocol: 1, bridge: 'wo-2669 fake AXBB-E', readOnly: false,
        capabilities: { geometryQueue: true, executingMoveId: true, bufferSeconds: true, gcodeText: false,
          machineProgram: true, perAxisHoming: true, ownsSpindle: false, spindleCommands: false,
          overrides: { feed: true, rapid: false, spindle: true } },
        workOffsets: { current: offsets, profile: offsets },
      } } as unknown as BridgeMessage)
    }
    send(message: BridgeCallMessage) {
      this.sent.push(message)
      const refused = message.m === 'loadMoves' ? this.refuseLoad : null
      if (message.m === 'loadMoves' && refused === null) this.moves = (message.a as { moves: QueuedMove[] }).moves
      if (message.m === 'startJob' || message.m === 'resumeJob') this.status('run')
      this.emit({ t: 'reply', seq: message.seq, ok: true,
        v: message.m === 'loadMoves' ? { ok: refused === null, reason: refused } : true })
    }
    async close() { this.fakeEvents?.onClose('closed') }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: FakeBoard })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useCamStore } = await import('../../store')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { OverridePanel } = await import('../../components/machine/OverridePanel')
const {
  __resetEstopInterlockForTest, clearPathFidelity, connectMachine, disconnectMachine,
  getMachineController, loadGcodeTextToolpathProgram, appRapidOverrideNote,
} = await import('../../lib/machine/machineSession')

const live: Array<{ disconnect(): Promise<void> }> = []
const events = (): ControllerEvents => ({ onStatus: vi.fn(), onConsole: vi.fn() })
const pct = [25, 50, 100] as const
// Whole 50 ms simulator ticks: no partial-tick extrapolation.
const SAMPLE_MS = 1000
beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-13T12:00:00Z') }))
afterEach(async () => { for (const ctrl of live.splice(0)) await ctrl.disconnect(); vi.useRealTimers() })

async function simulator() {
  const ctrl = new SimulatedController(events(), {
    travelMm: { x: 1000, y: 1000, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
  })
  live.push(ctrl)
  await ctrl.connect({ kind: 'none' })
  return ctrl
}
async function travel(ctrl: SimulatedController, ms = SAMPLE_MS) {
  const before = ctrl.status().machinePos!.x
  await vi.advanceTimersByTimeAsync(ms)
  return ctrl.status().machinePos!.x - before
}
function start(ctrl: SimulatedController, body: string) {
  expect(ctrl.loadJob(`G21 G90 ${body}\nM30\n`).ok).toBe(true)
  expect(ctrl.startJob()).toBe(true)
  expect(ctrl.machineState()).toBe('run')
}
function row(name: string, data: Record<string, unknown>) {
  console.info('WO2669 ' + JSON.stringify({ name, backend: 'browser SimulatedController; not UC100 hardware', ...data }))
}

describe('WO-2669 browser simulator response characterization', () => {
  it.each(pct)('G0 rapid=%i changes readback but currently not travel', async (percent) => {
    const ctrl = await simulator()
    ctrl.setOverride({ kind: 'rapid', to: 'percent', percent })
    start(ctrl, 'G0 X800')
    const distance = await travel(ctrl)
    expect(ctrl.status().overrides).toEqual({ feed: 100, rapid: percent, spindle: 100 })
    expect(distance).toBeCloseTo(SIMULATOR_DEFAULT_RAPID_MM_MIN * SAMPLE_MS / 60000, 5)
    row('G0 rapid request', { percent, distance, ms: SAMPLE_MS, reportedFeed: ctrl.status().feedMmMin })
  })

  it.each(pct)('G1 remains at its programmed feed with rapid=%i', async (percent) => {
    const ctrl = await simulator()
    ctrl.setOverride({ kind: 'rapid', to: 'percent', percent })
    start(ctrl, 'G1 X800 F600')
    expect(await travel(ctrl)).toBeCloseTo(600 * SAMPLE_MS / 60000, 5)
    expect(ctrl.status().feedMmMin).toBe(600)
  })

  it.each(pct)('feed=%i scales both parsed G0 and G1 in this simulator', async (percent) => {
    for (const [word, rate] of [['G0', SIMULATOR_DEFAULT_RAPID_MM_MIN], ['G1', 600]] as const) {
      const ctrl = await simulator()
      ctrl.setOverride({ kind: 'feed', to: 'percent', percent })
      start(ctrl, `${word} X800 F600`)
      const distance = await travel(ctrl)
      expect(distance).toBeCloseTo(rate * percent / 100 * SAMPLE_MS / 60000, 5)
      row('feed coupling', { word, percent, distance, ms: SAMPLE_MS })
      await ctrl.disconnect()
      live.splice(live.indexOf(ctrl), 1)
    }
  })

  it('changing rapid during motion does not slow active or already queued G0', async () => {
    const ctrl = await simulator()
    start(ctrl, 'G0 X65\nG0 X800')
    expect(ctrl.status().buffer!.moves).toBe(3) // two motions and the M30 marker
    const active = await travel(ctrl, 450)
    ctrl.setOverride({ kind: 'rapid', to: 'percent', percent: 25 })
    const after = await travel(ctrl, 450)
    const queued = await travel(ctrl, 450)
    expect(active).toBeCloseTo(30, 5)
    expect(after).toBeCloseTo(active, 5)
    expect(queued).toBeCloseTo(active, 5)
    row('mid-program rapid', { active, after, queued, readback: ctrl.status().overrides })
  })

  it('feed change affects the current move on the next simulation ticks', async () => {
    const ctrl = await simulator()
    start(ctrl, 'G0 X800')
    const full = await travel(ctrl)
    ctrl.setOverride({ kind: 'feed', to: 'percent', percent: 25 })
    const quarter = await travel(ctrl)
    expect(quarter).toBeCloseTo(full / 4, 5)
    expect(ctrl.status().overrides!.rapid).toBe(100)
    row('mid-motion feed', { full, quarter, ms: SAMPLE_MS })
  })

  it('rapid changes do not change jog distance or spindle override readback', async () => {
    const ctrl = await simulator()
    ctrl.setOverride({ kind: 'spindle', to: 'percent', percent: 75 })
    expect(ctrl.jog('X', 200, 600)).toBe(true)
    const before = await travel(ctrl)
    ctrl.setOverride({ kind: 'rapid', to: 'percent', percent: 25 })
    const after = await travel(ctrl)
    expect(after).toBeCloseTo(before, 5)
    expect(ctrl.status().overrides).toEqual({ feed: 100, rapid: 25, spindle: 75 })
  })
})

class Wire implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  async start(callbacks: BridgeTransportEvents) { this.events = callbacks }
  send(message: BridgeCallMessage) { this.sent.push(message) }
  async close() {}
  emit(message: BridgeMessage) { this.events?.onMessage(message) }
}

describe('WO-2669 real UccncController wire boundary (in-memory transport control)', () => {
  it.each(pct)('current rapid=false hello prevents sending rapid=%i; feed/spindle remain independent', async (percent) => {
    const ctrl = new UccncController(events())
    live.push(ctrl)
    const wire = new Wire()
    const connecting = ctrl.connect({ kind: 'messages', transport: wire })
    wire.emit({ t: 'hello', v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL, bridge: 'wo2669-test-control', readOnly: false,
      capabilities: { geometryQueue: true, executingMoveId: true, bufferSeconds: true, gcodeText: false,
        perAxisHoming: true, ownsSpindle: false, spindleCommands: false,
        overrides: { feed: true, rapid: false, spindle: true } },
    } } as unknown as BridgeMessage)
    await connecting
    ctrl.setOverride({ kind: 'rapid', to: 'percent', percent })
    expect(wire.sent.filter(call => call.m === 'setOverride')).toEqual([])
    ctrl.setOverride({ kind: 'feed', to: 'percent', percent: 50 })
    ctrl.setOverride({ kind: 'spindle', to: 'percent', percent: 75 })
    const calls = wire.sent.filter(call => call.m === 'setOverride')
    expect(calls.map(call => call.a)).toEqual([
      { change: { kind: 'feed', to: 'percent', percent: 50 } },
      { change: { kind: 'spindle', to: 'percent', percent: 75 } },
    ])
    console.info('WO2669 wire ' + JSON.stringify({ rapidRequested: percent, calls }))
  })
})

// ---------------------------------------------------------------------------
// Part 2 - route A on the UC100, through the production session route.
// ---------------------------------------------------------------------------

/** the owner's machine rapid: every G0 left as feedMmMin 8000 on 10-07. */
const RAPID = 8000
const CUT = 300

function uc100Machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -150 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({ controller: 'uccnc' as const, key: axisSoftLimitStatementKey(axis.axis, end) })))
  controllerDefinition.outputs = []
  return makeMachine({
    id: 'wo2669-uc100', name: 'WO-2669 UC100', travel: { x: 600, y: 400, z: 300 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -150 },
    },
    rapidRate: RAPID, controllerDefinition,
  })
}

const ONE_PART = `G21 G90 G54\nG0 X10 Y10 Z5\nG1 X20 F${CUT}\nG0 X30\nM30\n`
/** M0 splits the staged program: part 2 is handed to the board only when the
 *  operator presses Cycle Start at the stop - it is "not yet sent" until then. */
const TWO_PARTS = `G21 G90 G54\nG0 X10 Y10 Z5\nG1 X20 F${CUT}\nM0\nG0 X30\nG1 X40 F${CUT}\nM30\n`

let savedProject: Project
const wireLog: unknown[] = []

async function settle(ms = 20) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
function loads(): QueuedMove[][] {
  return board!.sent.filter((m) => m.m === 'loadMoves').map((m) => (m.a as { moves: QueuedMove[] }).moves)
}
function lines(moves: QueuedMove[]) { return moves.filter((m) => m.kind === 'line') }
function rapidFeeds(moves: QueuedMove[]) { return lines(moves).filter((m) => m.rapid === true).map((m) => m.feedMmMin) }
function cutFeeds(moves: QueuedMove[]) { return lines(moves).filter((m) => m.rapid !== true).map((m) => m.feedMmMin) }
function setRapid(percent: number) { act(() => { getMachineController().setOverride({ kind: 'rapid', to: 'percent', percent }) }) }
function consoleText() { return useMachineControl.getState().consoleLines.map((l) => l.text).join('\n') }
async function load(text: string) {
  let outcome: { ok: boolean; reason: string | null } = { ok: false, reason: 'not run' }
  await act(async () => {
    outcome = loadGcodeTextToolpathProgram('wo2669.nc', text, { publishListing: true })
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(outcome, consoleText()).toEqual({ ok: true, reason: null })
}
async function cycleStart() {
  let accepted = false
  await act(async () => { accepted = await executeOperatorCycleStart(); await vi.advanceTimersByTimeAsync(20) })
  expect(accepted, consoleText()).toBe(true)
}
function evidence(name: string, data: Record<string, unknown>) {
  const row = { name, backend: 'real session + UccncController over a fake AXBB-E socket; not hardware', ...data }
  wireLog.push(row)
  console.info('WO2669 route-A ' + JSON.stringify(row))
}

describe('WO-2669 route A: the UC100 sends each G0 at the machine rapid x Rapid %', () => {
  beforeEach(async () => {
    board = null
    useMachineActions.setState({ byMachine: {} })
    savedProject = useCamStore.getState().project
    useCamStore.setState({ project: { ...savedProject, machine: uc100Machine(), setups: [] } })
    const pending = connectMachine('bridge')
    await vi.advanceTimersByTimeAsync(300)
    await pending
    act(() => { __resetEstopInterlockForTest() })
    act(() => {
      board!.status('idle')
      board!.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    })
    useMachineControl.getState().clearConsole()
  })

  afterEach(async () => {
    cleanup()
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
    }
    useCamStore.setState({ project: savedProject, machineWorkOffsets: {} })
    clearPathFidelity()
    useMachineControl.setState({ consoleLines: [] })
    if (process.env.WRITE_EVIDENCE === '1') {
      const dir = join(process.cwd(), 'src/tests/evidence/WO-2669')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'route-a-wire-log.json'), JSON.stringify(wireLog, null, 2) + '\n')
    }
  })

  it('the Overrides panel shows a working Rapid control, not "not on this controller"', async () => {
    render(createElement(OverridePanel))
    expect(screen.queryByText('not on this controller')).toBeNull()
    expect(useMachineControl.getState().overrides.rapid).toBe(100)
    expect(useMachineControl.getState().overrideAvailability.rapid).toBe('supported')
    act(() => { fireEvent.click(screen.getByTestId('control-ovr-rapid-25')) })
    expect(useMachineControl.getState().overrides.rapid).toBe(25)
    // A later status frame from the board (rapid null) does not undo it.
    act(() => { board!.status('idle') })
    expect(useMachineControl.getState().overrides.rapid).toBe(25)
    expect(screen.getByTestId('control-ovr-rapid-25').className).toContain('control-chip-active')
    // One plain line says what it does: from the next moves sent.
    expect(consoleText()).toMatch(/Rapid 25%: every G0 not yet sent to the board goes out at 2000 mm\/min \(25% of 8000\)/)
    // JRO does nothing to program G0 on this board, so nothing rapid goes on the wire.
    expect(board!.sent.filter((m) => m.m === 'setOverride')).toEqual([])
  })

  it.each([100, 50, 25])('Rapid %i%%: every G0 goes out at that share of the rapid, every G1 at its own feed', async (percent) => {
    setRapid(percent)
    await load(ONE_PART)
    const moves = loads().at(-1)!
    expect(rapidFeeds(moves).length).toBeGreaterThan(0)
    expect(rapidFeeds(moves).every((f) => f === RAPID * percent / 100), JSON.stringify(moves)).toBe(true)
    expect(cutFeeds(moves).length).toBeGreaterThan(0)
    expect(cutFeeds(moves).every((f) => f === CUT)).toBe(true)
    expect(useMachineControl.getState().overrides.rapid).toBe(percent)
    // Feed % is untouched: no override call left at all.
    expect(board!.sent.filter((m) => m.m === 'setOverride')).toEqual([])
    evidence('G0 at rapid percent', { percent, rapidFeeds: rapidFeeds(moves), cutFeeds: cutFeeds(moves) })
  })

  it('a change while a program is loaded but not started stages it again at the new rapid', async () => {
    await load(ONE_PART)
    expect(rapidFeeds(loads().at(-1)!).every((f) => f === RAPID)).toBe(true)
    const before = loads().length
    setRapid(50)
    await settle()
    expect(loads().length).toBe(before + 1)
    expect(rapidFeeds(loads().at(-1)!).every((f) => f === RAPID / 2)).toBe(true)
    expect(cutFeeds(loads().at(-1)!).every((f) => f === CUT)).toBe(true)
    expect(board!.sent.map((m) => m.m)).not.toContain('startJob')
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    evidence('restaged before start', { from: 100, to: 50, rapidFeeds: rapidFeeds(loads().at(-1)!) })
  })

  it('a change mid-run reaches only the G0s not yet sent; moves already sent keep their speed', async () => {
    await load(TWO_PARTS)
    const partOne = loads().at(-1)!
    expect(rapidFeeds(partOne).every((f) => f === RAPID)).toBe(true)
    await cycleStart()
    expect(useMachineControl.getState().machineState).toBe('run')
    const sentBefore = loads().length
    setRapid(25)
    await settle()
    // Nothing is swapped under the running program.
    expect(loads().length).toBe(sentBefore)
    expect(rapidFeeds(partOne).every((f) => f === RAPID)).toBe(true)
    // Part one ends at M0; the operator's Cycle Start hands part two over.
    act(() => { board!.finish() })
    await settle(500)
    await cycleStart()
    expect(loads().length).toBe(sentBefore + 1)
    const partTwo = loads().at(-1)!
    expect(rapidFeeds(partTwo).length).toBeGreaterThan(0)
    expect(rapidFeeds(partTwo).every((f) => f === RAPID / 4), JSON.stringify(partTwo)).toBe(true)
    expect(cutFeeds(partTwo).every((f) => f === CUT)).toBe(true)
    evidence('mid-run change', { partOneRapid: rapidFeeds(partOne), partTwoRapid: rapidFeeds(partTwo), partTwoCut: cutFeeds(partTwo) })
  })

  it('the panel says in one line what Rapid does on this controller', async () => {
    render(createElement(OverridePanel))
    expect(screen.getByTestId('control-ovr-rapid-note').textContent)
      .toBe('G0 at 8000 mm/min, from next moves sent')
    act(() => { fireEvent.click(screen.getByTestId('control-ovr-rapid-25')) })
    expect(screen.getByTestId('control-ovr-rapid-note').textContent)
      .toBe('G0 at 2000 mm/min, from next moves sent')
    evidence('panel note', { note: screen.getByTestId('control-ovr-rapid-note').textContent })
  })

  it('a re-stage the board refuses puts the Rapid % back to what the board holds', async () => {
    await load(ONE_PART)
    render(createElement(OverridePanel))
    const before = loads().length
    board!.refuseLoad = 'the board is busy'
    act(() => { fireEvent.click(screen.getByTestId('control-ovr-rapid-25')) })
    await settle()
    // The re-stage at 25 % went out and the board refused it ...
    expect(loads().length).toBe(before + 1)
    expect(rapidFeeds(loads().at(-1)!).every((f) => f === RAPID / 4)).toBe(true)
    // ... so it still holds the program at 100 %, and so does the panel.
    expect(useMachineControl.getState().overrides.rapid).toBe(100)
    expect(screen.getByTestId('control-ovr-rapid-100').className).toContain('control-chip-active')
    expect(screen.getByTestId('control-ovr-rapid-note').textContent).toBe('G0 at 8000 mm/min, from next moves sent')
    act(() => { board!.status('idle') })
    expect(useMachineControl.getState().overrides.rapid).toBe(100)
    expect(consoleText()).toMatch(/Rapid 25%: the board kept the loaded program at 100% - the board is busy/)
    // The next program handed over goes out at the 100 % the panel shows.
    board!.refuseLoad = null
    await load(ONE_PART)
    expect(rapidFeeds(loads().at(-1)!).every((f) => f === RAPID)).toBe(true)
    evidence('refused re-stage reverts', { asked: 25, shown: useMachineControl.getState().overrides.rapid })
  })

  it('a refusal of an older re-stage does not undo a newer one the board took', async () => {
    await load(ONE_PART)
    act(() => {
      board!.refuseLoad = 'the board is busy'
      getMachineController().setOverride({ kind: 'rapid', to: 'percent', percent: 50 })
      board!.refuseLoad = null
      getMachineController().setOverride({ kind: 'rapid', to: 'percent', percent: 25 })
    })
    await settle()
    expect(rapidFeeds(loads().at(-1)!).every((f) => f === RAPID / 4)).toBe(true)
    expect(useMachineControl.getState().overrides.rapid).toBe(25)
  })

  // Review 10-14 1:55 AM CT: two Rapid changes inside one board round trip.
  // Whatever the board answers, the panel shows the rapid the board holds and
  // Cycle Start runs the board's copy at exactly that rapid.
  it.each([
    ['refused', 'refused', 100],
    ['taken', 'refused', 50],
    ['refused', 'taken', 25],
  ] as const)('re-stages at 50 %% (%s) then 25 %% (%s) in one round trip: panel and run both at %i %%', async (first, second, held) => {
    await load(ONE_PART)
    render(createElement(OverridePanel))
    act(() => {
      board!.refuseLoad = first === 'refused' ? 'the board is busy' : null
      getMachineController().setOverride({ kind: 'rapid', to: 'percent', percent: 50 })
      board!.refuseLoad = second === 'refused' ? 'the board is busy' : null
      getMachineController().setOverride({ kind: 'rapid', to: 'percent', percent: 25 })
    })
    await settle()
    board!.refuseLoad = null
    expect(rapidFeeds(board!.moves).every((f) => f === RAPID * held / 100), JSON.stringify(board!.moves)).toBe(true)
    expect(useMachineControl.getState().overrides.rapid).toBe(held)
    expect(screen.getByTestId(`control-ovr-rapid-${held}`).className).toContain('control-chip-active')
    expect(appRapidOverrideNote()).toBe(`G0 at ${RAPID * held / 100} mm/min, from next moves sent`)
    act(() => { board!.status('idle') })
    expect(useMachineControl.getState().overrides.rapid).toBe(held)
    // Cycle Start hands nothing new over: the board runs what it holds.
    const sentBefore = loads().length
    await cycleStart()
    expect(loads().length).toBe(sentBefore)
    expect(board!.sent.at(-1)!.m).toBe('startJob')
    expect(rapidFeeds(board!.moves).every((f) => f === RAPID * held / 100)).toBe(true)
    expect(useMachineControl.getState().overrides.rapid).toBe(held)
    evidence('two re-stages in one round trip', { first, second, boardHeldRapid: rapidFeeds(board!.moves), shown: held })
  })

  it('a load the board refused is never staged again by a Rapid change', async () => {
    await load(ONE_PART)
    const held = board!.moves
    board!.refuseLoad = 'the board is busy'
    await act(async () => {
      loadGcodeTextToolpathProgram('wo2669-refused.nc', `G21 G90 G54\nG0 X50 Y50 Z5\nG1 X60 F${CUT}\nM30\n`, { publishListing: true })
      await vi.advanceTimersByTimeAsync(20)
    })
    board!.refuseLoad = null
    const sentBefore = loads().length
    setRapid(50)
    await settle()
    // Whatever goes out now is the program the board holds, never the refused one.
    for (const moves of loads().slice(sentBefore)) {
      expect(lines(moves).map((m) => m.to), JSON.stringify(moves)).toEqual(lines(held).map((m) => m.to))
    }
    expect(lines(board!.moves).map((m) => m.to)).toEqual(lines(held).map((m) => m.to))
  })
})
