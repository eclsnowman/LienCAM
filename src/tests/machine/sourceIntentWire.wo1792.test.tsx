// @vitest-environment jsdom
//
// WO-1792 - SOURCE INTENT REACHES THE WIRE AFTER THE MACHINE MOVES BETWEEN
// FILE LOAD AND FIRST RELEASE.
//
// The 2026-09-20 air run ended at the right point with all six blocks counted,
// while its first Z-only block had already flown a table-wide XY diagonal. This
// test therefore observes the ordered loadMoves payload, not the final point or
// block count. Its expected path is hand-pinned from the checked-in file: the
// first G0 names Z only; the next G0 is the first line allowed to name X/Y.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'

const FIXTURE_PATH = join('src', 'tests', 'fixtures', 'machine-session', 'item8-square-z53.nc')
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8').replace(/\r\n/g, '\n')

const G54 = { x: 188.7325, y: 397.655, z: 66.57 }
/** The stale pre-home counters reconstructed from the recorded wrong turn. */
const LOAD_AT_A: MachineStatus = statusAt(
  { x: 33.6625, y: 28.13, z: 128.9 },
  { x: -155.07, y: -369.525, z: 62.33 },
)
/** Operator's reported home position immediately before the air run. */
const RELEASE_AT_B: MachineStatus = statusAt(
  { x: 738, y: 724.5, z: 128.9 },
  { x: 549.2675, y: 326.845, z: 62.33 },
)

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

interface StagedWireMove {
  id: number
  kind: string
  to?: { x?: number; y?: number; z?: number }
  feedMmMin?: number
  rapid?: true
}

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
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
      const unset = { x: 0, y: 0, z: 0 }
      const offsets = {
        G54: { ...G54 }, G55: unset, G56: unset, G57: unset, G58: unset, G59: unset,
      }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1792-fake 0.0',
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
        const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
        const offset = a.wcs === 'G54' ? G54 : { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 }
        this.fakeEvents?.onMessage({
          t: 'reply', seq: message.seq, ok: true, v: { ok: true, offset },
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

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setMachineSingleBlock,
} = await import('../../lib/machine/machineSession')

function statusAt(
  machinePos: MachineStatus['machinePos'],
  workPos: MachineStatus['workPos'],
): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos,
    workPos,
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

function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  const maxima = { X: 738, Y: 724.5, Z: 129.1 }
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -0.1 : 0
    axis.softLimitMax = maxima[axis.axis as keyof typeof maxima] ?? 100
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })))
  controllerDefinition.outputs = []
  return makeMachine({
    id: 'wo1792-machine',
    name: 'WO-1792 source-intent wire machine',
    travel: { x: 738, y: 724.5, z: 129.2 },
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'min' },
      y: { homesToward: 'max', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 128.9 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function loadMovesCalls(from = 0): Array<{ moves: StagedWireMove[]; frame?: string }> {
  return socket().sent.slice(from)
    .filter((message) => message.m === 'loadMoves')
    .map((message) => message.a as { moves: StagedWireMove[]; frame?: string })
}

function emit(message: BridgeMessage): void {
  act(() => { socket().emit(message) })
}

/** Resolve only the already-captured wire contract. Expected values below are
 * hand-authored constants, never output from the production reader/builder. */
function machinePathOnWire(moves: StagedWireMove[]): Array<{ x: number; y: number; z: number }> {
  let at = { ...RELEASE_AT_B.machinePos! }
  return moves.map((move) => {
    if (move.kind !== 'line' || !move.to) throw new Error('The control file must stage only line moves.')
    at = {
      x: move.to.x === undefined ? at.x : move.to.x + G54.x,
      y: move.to.y === undefined ? at.y : move.to.y + G54.y,
      z: move.to.z === undefined ? at.z : move.to.z + G54.z,
    }
    return at
  })
}

let originalProject: Project
let originalToolLibrary: ReturnType<typeof useCamStore.getState>['toolLibrary']

beforeEach(async () => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  useMachineActions.setState({ byMachine: {} })
  useMachineToolTable.setState({ byMachine: {} })
  originalProject = useCamStore.getState().project
  originalToolLibrary = useCamStore.getState().toolLibrary
  useCamStore.setState({
    project: { ...originalProject, machine: machine(), setups: [] },
    machineWorkOffsets: {},
  })
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  emit({ t: 'status', v: LOAD_AT_A })
})

afterEach(async () => {
  cleanup()
  setMachineSingleBlock(false)
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({
    project: originalProject,
    toolLibrary: originalToolLibrary,
    machineWorkOffsets: {},
  })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

describe('WO-1792 independent source intent -> staged wire path', () => {
  it.each([
    ['ordinary Cycle Start', false, 'startJob'],
    ['first Single Block press', true, 'stepJob'],
  ] as const)('%s restages the actual item8 path at B before release', async (_name, singleBlock, releaseCall) => {
    const sourceLines = FIXTURE.split('\n')
    expect(sourceLines[6]).toBe('G0 Z53.')
    expect(sourceLines[7]).toBe('G0 X335. Y40.')

    expect(loadGcodeTextToolpathProgram(
      'item8-square-z53.nc',
      FIXTURE,
      { publishListing: true },
    )).toEqual({ ok: true, reason: null })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(loadMovesCalls()).toHaveLength(1)

    // The same boundary as the incident: loaded against pre-home counters A,
    // then home/reposition reports B without changing the G54 table.
    emit({ t: 'status', v: RELEASE_AT_B })
    emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    if (singleBlock) setMachineSingleBlock(true)
    const releaseMark = socket().sent.length

    let accepted = false
    await act(async () => {
      accepted = await executeOperatorCycleStart()
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(accepted).toBe(true)

    const relevant = socket().sent.slice(releaseMark)
      .filter((message) => ['selectWcs', 'loadMoves', 'startJob', 'stepJob'].includes(message.m))
    expect.soft(relevant.map((message) => message.m)).toEqual(['selectWcs', 'loadMoves', releaseCall])
    const stagedAtRelease = loadMovesCalls(releaseMark)
    expect.soft(stagedAtRelease).toHaveLength(1)
    // On the negative control there is no release-time staging. Keep examining
    // the queue actually left in force so the failure names its stale A path,
    // not only the missing lifecycle call.
    const staged = stagedAtRelease[0] ?? loadMovesCalls().at(-1)!
    expect(staged.frame).toBe('work')

    const moves = staged.moves
    expect(moves).toHaveLength(6)
    expect(moves.map((move) => move.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(moves).toMatchObject([
      { kind: 'line', to: { z: 53 }, rapid: true },
      { kind: 'line', to: { x: 335, y: 40, z: 53 }, rapid: true },
      { kind: 'line', to: { x: 340, y: 40, z: 53 }, feedMmMin: 500 },
      { kind: 'line', to: { x: 340, y: 45, z: 53 }, feedMmMin: 500 },
      { kind: 'line', to: { x: 335, y: 45, z: 53 }, feedMmMin: 500 },
      { kind: 'line', to: { x: 335, y: 40, z: 53 }, feedMmMin: 500 },
    ])
    expect.soft(moves[0].to).toEqual({ z: 53 })

    // Independent machine-coordinate constants from the source and G54. The
    // endpoint and count equal the bad run; only this ordered path exposes it.
    expect.soft(machinePathOnWire(moves)).toEqual([
      { x: 738, y: 724.5, z: 119.57 },
      { x: 523.7325, y: 437.655, z: 119.57 },
      { x: 528.7325, y: 437.655, z: 119.57 },
      { x: 528.7325, y: 442.655, z: 119.57 },
      { x: 523.7325, y: 442.655, z: 119.57 },
      { x: 523.7325, y: 437.655, z: 119.57 },
    ])
  })
})
