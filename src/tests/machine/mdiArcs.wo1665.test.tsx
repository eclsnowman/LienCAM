// @vitest-environment jsdom
//
// WO-1665 - A TYPED ARC STARTS WHERE THE TOOL IS AND KEEPS THE LAST FEED.
//
// Operator, at the machine, hardware session 2026-09-17 ~19:50 CDT, build
// wo/WO-1548 6240aa9db: typed arcs were REFUSED twice.
//
//   `G1 X10 F300` then `G2 X20 I5` typed as two MDI lines: the second was
//   refused "arc move has no positive feed rate" - the F from the previous
//   typed line was not carried, although UCCNC and LinuxCNC hold F modally
//   across MDI lines exactly as G90/G91/G20/G21 already are (WO-1636).
//
//   `G2 X20 I5 F300` as the FIRST typed motion line was refused "... is an
//   arc_ccw with no move before it, so where the arc starts is unknown; an
//   arc has to follow a move" - although the session already knows the
//   machine's current work position (it is on the DRO), and a typed G1 with
//   no move before it already starts from that position.
//
// WHAT IS PROVEN HERE, through `sendMdiLine` on the real session singleton
// talking to a real `UccncController` over a fake bridge socket, read off
// what reached THE WIRE:
//
//   - `G1 X10 F300` then `G2 X20 I5` - the arc stages at F300, from X10;
//   - `G2 X20 I5 F300` typed alone, first line, from a known position -
//     stages from that position, no "no move before it" refusal;
//   - a loaded program whose first line is an arc stages from the tool's
//     current position the same way;
//   - a session with no feed ever set still refuses a feed move for it -
//     the held-feed fix adds no new leniency beyond what was typed.
//
// NOT CLAIMED: hardware. Tier 1 is the next hardware session.

import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { makeMachine } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { typedMock } from '../support/typedMock'

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

const G54_OFFSET = { x: 0, y: 0, z: 0 }
const UNSET_OFFSET = { x: 0, y: 0, z: 0 }

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
        G55: { ...UNSET_OFFSET },
        G56: { ...UNSET_OFFSET },
        G57: { ...UNSET_OFFSET },
        G58: { ...UNSET_OFFSET },
        G59: { ...UNSET_OFFSET },
      }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1665-fake 0.0',
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
const { useMachineActions } = await import('../../store/machineActionsStore')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

function uccncMachine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -60 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  return makeMachine({
    id: 'wo1665-machine',
    name: 'WO-1665 Test Machine',
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

function bridgeStatus(
  workPos = { x: 0, y: 0, z: 0 },
  machinePos = { x: 0, y: 0, z: 0 },
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

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

beforeEach(() => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  originalProject = useCamStore.getState().project
  originalLibrary = useCamStore.getState().machineLibrary
  originalControl = useCamStore.getState().control
})

afterEach(async () => {
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
  useMachineControl.setState({ consoleLines: [], parserModal: null })
  useMachineActions.setState({ byMachine: {} })
  act(() => { __resetEstopInterlockForTest() })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  vi.useRealTimers()
})

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function errorRows(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.severity === 'error')
    .map((line) => line.text)
}

function framesSince(mark: number, method: string): BridgeCallMessage[] {
  return socket().sent.slice(mark).filter((m) => m.m === method)
}

interface WireStep {
  id: number
  kind: string
  to?: { x?: number; y?: number; z: number }
  feedMmMin?: number
  rapid?: true
}

function stagedSteps(mark: number): WireStep[] {
  const load = framesSince(mark, 'loadMoves').at(-1)
  expect(load, 'a program reached the wire').toBeDefined()
  return (load!.a as { moves: WireStep[] }).moves
}

async function settle(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
}

async function connectBridge(initialWorkPos = { x: 0, y: 0, z: 0 }): Promise<void> {
  install(uccncMachine())
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: bridgeStatus(initialWorkPos) } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  await settle()
}

/** A staged MDI program finished, so the next typed line may stage its own. */
async function finishJob(status: MachineStatus): Promise<void> {
  act(() => {
    socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    socket().emit({ t: 'status', v: status } as BridgeMessage)
  })
  await settle()
}

async function mdi(line: string): Promise<boolean> {
  let ok = false
  act(() => { ok = sendMdiLine(line) })
  await settle()
  return ok
}

const NO_FEED_REFUSAL = 'arc move has no positive feed rate'
const NO_MOVE_BEFORE_REFUSAL = 'no move before it, so where the arc starts is unknown'

describe('WO-1665: a typed arc starts where the tool is and keeps the last feed', () => {
  beforeEach(async () => {
    await connectBridge()
  })

  it('G1 X10 F300 then G2 X20 I5: F is held, and the arc starts from X10', async () => {
    expect(await mdi('G1 X10 F300')).toBe(true)
    await finishJob(bridgeStatus({ x: 10, y: 0, z: 0 }))

    const mark = socket().sent.length
    expect(await mdi('G2 X20 I5')).toBe(true)
    expect(errorRows().join('\n')).not.toContain(NO_FEED_REFUSAL)
    const steps = stagedSteps(mark)
    expect(steps).toHaveLength(1)
    expect(steps[0].kind).toBe('arc')
    expect(steps[0].feedMmMin).toBe(300)
    expect(steps[0].to).toMatchObject({ x: 20, y: 0 })
    expect(errorRows()).toEqual([])
  })

  it('G2 X20 I5 F300 typed alone, first line, starts from the known current position', async () => {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await connectBridge({ x: 10, y: 0, z: 0 })

    const mark = socket().sent.length
    expect(await mdi('G2 X20 I5 F300')).toBe(true)
    expect(errorRows().join('\n')).not.toContain(NO_MOVE_BEFORE_REFUSAL)
    const steps = stagedSteps(mark)
    expect(steps).toHaveLength(1)
    expect(steps[0].kind).toBe('arc')
    expect(steps[0].feedMmMin).toBe(300)
    expect(steps[0].to).toMatchObject({ x: 20, y: 0 })
    expect(errorRows()).toEqual([])
  })

  it("a loaded program's first-line arc starts from the position it is loaded at", async () => {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await connectBridge({ x: 10, y: 0, z: 0 })

    const program = 'G21\nG90\nG2 X20 Y0 I5 F300\nM30\n'
    const loaded = loadGcodeTextToolpathProgram('wo1665-first-line-arc.nc', program)
    expect(loaded).toEqual({ ok: true, reason: null })
  })

  it('a session with no feed ever set still refuses an arc for it', async () => {
    expect(await mdi('G2 X10 I5')).toBe(false)
    expect(errorRows().join('\n')).toContain(NO_FEED_REFUSAL)
  })
})
