// @vitest-environment jsdom
//
// WO-1663 - A USER STOP IS A STOP, NOT A FAILED CYCLE.
//
// Board, 2026-09-17 (finding j): Operator stopped his own 110,615-move file 337
// moves into a 60 s air run. The header read "Idle" + "The cycle failed.
// Resolve the error first. A toolpath program has no re-arm control", CYCLE
// START greyed, and the progress went back to "1/110615 (0%)". Nothing failed.
//
// WHAT IS PROVEN HERE, on the real session singleton talking to a real
// `UccncController` over a fake bridge socket, through the production doors
// (the file loader, CYCLE START, Stop/Reset) and the rendered transport bar
// and program panel:
//
//   - the operator's Stop mid-program reads "Stopped by the operator at line N
//     (move M of T)", never "failed" or "resolve"; the progress stays at M;
//   - the same file is staged again from its first line (selectWcs, loadMoves
//     of part 1 - no startJob), and CYCLE START is enabled and runs it from
//     the top;
//   - a controller fault still reads as a failed cycle with its reason, and
//     the E-STOP is never reported as the operator's Stop.
//
// NOT CLAIMED: hardware. Tier 1 is the next machine session.

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  type Project,
} from '../../types'
import { makeMachine } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { typedMock } from '../support/typedMock'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

/** Operator's AXBB-E through the bridge, with a small program ceiling so a short
 *  file runs as several controller-sized parts the way his 110,615 moves do. */
const PART_CAP = 10
const PROGRAM_BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
  maxProgramMoves: PART_CAP,
}

const G54_OFFSET = { x: 10, y: 5, z: 2 }

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class Fake extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor(...args: ConstructorParameters<typeof actual.BridgeTransport>) {
      super(...args)
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const offsets = {
        G54: { ...G54_OFFSET },
        G55: { ...G54_OFFSET },
        G56: { ...G54_OFFSET },
        G57: { ...G54_OFFSET },
        G58: { ...G54_OFFSET },
        G59: { ...G54_OFFSET },
      }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1663-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
      if (message.m === 'setWorkOffset') {
        const a = message.a as { x?: number; y?: number; z?: number }
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
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: Fake })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  currentOperatorTransport,
  executeOperatorCycleStart,
  executeOperatorStopReset,
} = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  operatorStopState,
  pressEstop,
} = await import('../../lib/machine/machineSession')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')

function uccncMachine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -50 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  return makeMachine({
    id: 'wo1663-machine',
    name: 'WO-1663 Test Machine',
    controller: 'uccnc',
    travel: { x: 600, y: 400, z: 200 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

function install(target: MachineConfig): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [target],
    project: { ...state.project, machine: target, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  })
}

function idleBridgeStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 20, y: 20, z: 30 },
    workPos: { x: 10, y: 15, z: 28 },
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

/** 40 moves from line 2 - a rapid every fifth so the program can split into
 *  parts of at most PART_CAP moves. Move k sits on line k + 1. */
const MOVE_COUNT = 40
const FILE = [
  'G21 G90 G54',
  'G0 Z10',
  'G0 X0 Y0',
  ...Array.from({ length: MOVE_COUNT - 2 }, (_, i) => (i % 5 === 4 ? `G0 X${i + 1} Y1` : `G1 X${i + 1} Y0 F1000`)),
  'M30',
  '',
].join('\n')
const FILE_NAME = 'operator-air-run.nc'

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function emit(message: BridgeMessage): void {
  act(() => { socket().emit(message) })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function wireSince(mark: number): string[] {
  return socket().sent.slice(mark).map((m) => m.m)
    .filter((m) => ['selectWcs', 'loadMoves', 'startJob', 'stopJob'].includes(m))
}

function loadedMoveIds(mark: number): number[][] {
  return socket().sent.slice(mark)
    .filter((m) => m.m === 'loadMoves')
    .map((m) => (m.a as { moves: { id: number }[] }).moves.map((move) => move.id))
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

function nextActionText(): string {
  return screen.getByTestId('control-next-action').textContent ?? ''
}

function progressText(): string {
  return screen.getByTestId('control-progress-text').textContent ?? ''
}

function cycleStartButton(): HTMLButtonElement {
  return screen.getByTestId('control-cyclestart') as HTMLButtonElement
}

/** Load the file, press CYCLE START, and run until `executingIndex` moves of
 *  the first part are finished - the operator is watching a live cut. */
async function loadAndRunTo(executingIndex: number): Promise<{ firstPartIds: number[] }> {
  const mark = socket().sent.length
  expect(loadGcodeTextToolpathProgram(FILE_NAME, FILE, { publishListing: true })).toEqual({ ok: true, reason: null })
  await advance(10)
  const firstPartIds = loadedMoveIds(mark)[0]
  expect(firstPartIds.length).toBeLessThanOrEqual(PART_CAP)
  expect(useMachineControl.getState().job).toMatchObject({ phase: 'ready', totalLines: MOVE_COUNT })

  await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
  emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
  emit({
    t: 'status',
    v: { ...idleBridgeStatus(), state: 'run', executingMoveId: firstPartIds[executingIndex] },
  } as BridgeMessage)
  await advance(150)
  expect(useMachineControl.getState().job.phase).toBe('streaming')
  expect(useMachineControl.getState().job.ackedLines).toBe(executingIndex)
  return { firstPartIds }
}

beforeEach(async () => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  originalProject = useCamStore.getState().project
  originalLibrary = useCamStore.getState().machineLibrary
  originalControl = useCamStore.getState().control
  install(uccncMachine())
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
  emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
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
    machineLibrary: originalLibrary,
    control: originalControl,
    machineWorkOffsets: {},
  })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  act(() => { __resetEstopInterlockForTest() })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  vi.useRealTimers()
})

describe('WO-1663: the operator\'s own Stop mid-program', () => {
  it('reads as stopped at its line, keeps the progress, and CYCLE START runs it again from the top', async () => {
    render(<><ControlTransportBar /><ProgramPanel /></>)
    const { firstPartIds } = await loadAndRunTo(5)
    // Five moves finished, the sixth running. The file's first move is on
    // line 2, so move k sits on line k + 1: the sixth is line 7.
    const stoppedLine = 7

    const mark = socket().sent.length
    act(() => { expect(executeOperatorStopReset()).toBe(true) })
    expect(wireSince(mark)).toEqual(['stopJob'])
    // The bridge answers the stop the way the board did: a 'stopped' edge,
    // then Idle.
    emit({ t: 'jobEvent', v: { event: 'stopped', fault: null } } as BridgeMessage)
    emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    await advance(300)

    const said = `Stopped by the operator at line ${stoppedLine} (move 5 of ${MOVE_COUNT}).`
    // Not a failed cycle, anywhere the operator reads.
    expect(useMachineControl.getState().job.phase).not.toBe('failed')
    expect(useMachineControl.getState().cycleEvents.at(-1)?.event).toBe('stopped')
    expect(nextActionText()).toContain(said)
    expect(nextActionText()).toContain('CYCLE START runs the program again from the start.')
    expect(nextActionText()).not.toMatch(/fail|resolve/i)
    expect(consoleText()).toContain(said)
    expect(consoleText()).not.toContain('Program parts ended; no later part was loaded.')

    // The same file is staged again from its first line - part 1, the same
    // ids - and nothing was started.
    expect(wireSince(mark)).toEqual(['stopJob', 'selectWcs', 'loadMoves'])
    expect(loadedMoveIds(mark)).toEqual([firstPartIds])
    expect(useMachineControl.getState().job).toMatchObject({ phase: 'ready', name: FILE_NAME })

    // The progress is where it stopped until CYCLE START.
    expect(progressText()).toContain(`5/${MOVE_COUNT} (24%)`)
    expect(currentOperatorTransport()).toMatchObject({ action: 'start', cycleStartEnabled: true })
    expect(cycleStartButton().disabled).toBe(false)

    // CYCLE START runs it from the top.
    const startMark = socket().sent.length
    await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
    expect(wireSince(startMark)).toEqual(['startJob'])
    emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
    emit({
      t: 'status',
      v: { ...idleBridgeStatus(), state: 'run', executingMoveId: firstPartIds[1] },
    } as BridgeMessage)
    await advance(150)
    expect(operatorStopState()).toBeNull()
    expect(useMachineControl.getState().job).toMatchObject({ phase: 'streaming', ackedLines: 1 })
    expect(progressText()).toContain(`1/${MOVE_COUNT}`)
    expect(nextActionText()).not.toContain('Stopped by the operator')
  })

  it('a one-part file stopped mid-run is staged again the same way', async () => {
    const short = ['G21 G90 G54', 'G0 Z10', 'G1 X1 F1000', 'G1 X2', 'G1 X3', 'M30', ''].join('\n')
    render(<><ControlTransportBar /><ProgramPanel /></>)
    const mark = socket().sent.length
    expect(loadGcodeTextToolpathProgram('short.nc', short, { publishListing: true }).ok).toBe(true)
    await advance(10)
    const ids = loadedMoveIds(mark)[0]
    await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
    emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
    emit({ t: 'status', v: { ...idleBridgeStatus(), state: 'run', executingMoveId: ids[2] } } as BridgeMessage)
    await advance(150)

    const stopMark = socket().sent.length
    act(() => { executeOperatorStopReset() })
    emit({ t: 'jobEvent', v: { event: 'stopped', fault: null } } as BridgeMessage)
    emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    await advance(300)

    expect(nextActionText()).toContain('Stopped by the operator at line 4 (move 2 of 4).')
    expect(nextActionText()).not.toMatch(/fail|resolve/i)
    expect(wireSince(stopMark)).toEqual(['stopJob', 'selectWcs', 'loadMoves'])
    expect(progressText()).toContain('2/4')
    expect(cycleStartButton().disabled).toBe(false)
  })
})

describe('WO-1663: a genuine fault is still a failed cycle', () => {
  it('a controller fault reads as a failed cycle with its reason, and nothing is staged', async () => {
    render(<><ControlTransportBar /><ProgramPanel /></>)
    await loadAndRunTo(5)
    const mark = socket().sent.length
    emit({
      t: 'jobEvent',
      v: { event: 'failed', fault: { code: null, message: 'Axis X following error', line: null, moveId: null } },
    } as BridgeMessage)
    emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    await advance(300)

    expect(useMachineControl.getState().job.phase).toBe('failed')
    expect(nextActionText()).toContain('The cycle failed.')
    expect(useMachineControl.getState().programReadiness.reason).toContain('Axis X following error')
    expect(consoleText()).toContain('Axis X following error')
    expect(operatorStopState()).toBeNull()
    expect(wireSince(mark)).toEqual([])
    // WO-2686 (the operator, 10-08): nothing is staged until CYCLE START, which arms
    // the file from line 1 and runs it.
    expect(cycleStartButton().disabled).toBe(false)
  })

  it('the E-STOP is never reported as the operator\'s Stop', async () => {
    render(<><ControlTransportBar /><ProgramPanel /></>)
    await loadAndRunTo(5)
    const mark = socket().sent.length
    act(() => { pressEstop() })
    emit({ t: 'jobEvent', v: { event: 'stopped', fault: null } } as BridgeMessage)
    emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    await advance(300)

    expect(operatorStopState()).toBeNull()
    expect(nextActionText()).not.toContain('Stopped by the operator')
    expect(useMachineControl.getState().job.phase).toBe('failed')
    expect(wireSince(mark).filter((m) => m === 'loadMoves' || m === 'startJob')).toEqual([])
  })
})
