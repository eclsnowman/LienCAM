// @vitest-environment jsdom
//
// WO-1640 - A LOADED PROGRAM FOLLOWS A WORK-OFFSET EDIT MADE AFTER IT WAS
// LOADED, G53 LINES INCLUDED.
//
// The bridge bakes the work offset in force into the staged moves at
// `loadMoves` (pendant/uccnc-bridge/Machine.cs LoadMoves: `oz =
// offsets[activeWcs, 2]`), and the file door sends `loadMoves` at LOAD. The
// reader resolves a `G53` line into work coordinates against the offset in
// force at load too. Operator edits G54 Z between air runs and real runs (the
// 09-14 session: 66.57 -> 110 -> back), so this file drives that exact gesture
// through the real session singleton and a real `UccncController` over a fake
// bridge socket, and reads what `loadMoves` carries at CYCLE START.
//
// Reproduction, before the fix: Cycle Start sent `startJob` alone. The board
// ran the list staged at 66.57 - every work move 43.43 mm LOWER than the new
// zero says, and the G53 Z190 retract at machine Z 190 only because the stale
// bake happened to cancel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { createDefaultAxisDefinition, createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { makeMachine } from '../post/helpers'
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

/** Operator's AXBB-E as the bridge reports it: no G-code interpreter. */
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

/** The G54 Operator loaded the file at (09-14), and the one he edited it to. */
const LOAD_Z = 66.57
const EDITED_Z = 110
const UNSET = { x: 0, y: 0 }

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  /** The G54 row the fake board holds - what LoadMoves would bake in. */
  g54: { x: number; y: number; z: number; a?: number; b?: number; c?: number }
  emit(message: BridgeMessage): void
}

const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    g54: { x: number; y: number; z: number; a?: number; b?: number; c?: number } = { x: 0, y: 0, z: LOAD_Z }
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const offsets = {
        G54: { ...this.g54 },
        G55: { ...UNSET },
        G56: { ...UNSET },
        G57: { ...UNSET },
        G58: { ...UNSET },
        G59: { ...UNSET },
      }
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1640-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      // Every loadMoves is recorded with the G54 Z the board holds AT THAT
      // CALL - the offset LoadMoves bakes in.
      this.sent.push(message.m === 'loadMoves'
        ? { ...message, a: { ...(message.a as object), bakedZ: this.g54.z } }
        : message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
      if (message.m === 'setWorkOffset') {
        const { wcs, ...values } = message.a as { wcs: string; x?: number; y?: number; z?: number; a?: number; b?: number; c?: number }
        if (wcs === 'G54') this.g54 = { ...this.g54, ...values }
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, offset: { ...this.g54 } },
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

const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { useCamStore } = await import('../../store')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo1640-machine'

/** Z travels 0..300 in machine coordinates, so G53 Z190 is on the table and a
 *  stale bake of it (233.43) would be too - nothing refuses it for us. */
function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 300
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  controllerDefinition.outputs = []
  return makeMachine({
    id: MACHINE_ID,
    name: 'WO-1640 Machine',
    travel: { x: 600, y: 400, z: 300 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', homePositionMm: 300 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

function idleBridgeStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 200 },
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

beforeEach(async () => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  useMachineActions.setState({ byMachine: {} })
  useMachineToolTable.setState({ byMachine: {} })
  originalProject = useCamStore.getState().project
  useCamStore.setState({ project: { ...originalProject, machine: machine(), setups: [] } })
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject, machineWorkOffsets: {} })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

async function load(name: string, text: string): Promise<void> {
  const loaded = loadGcodeTextToolpathProgram(name, text, { publishListing: true })
  await act(async () => { await vi.advanceTimersByTimeAsync(20) })
  expect(loaded).toEqual({ ok: true, reason: null })
}

async function cycleStart(): Promise<void> {
  let accepted = false
  await act(async () => {
    accepted = await executeOperatorCycleStart()
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(accepted).toBe(true)
}

async function editG54Z(z: number): Promise<void> {
  expect(setWorkOffsetValue('G54', 'Z', z)).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  expect(socket().g54.z).toBe(z)
}

const round = (z: number): number => Number(z.toFixed(4))

/** The MACHINE Z of every line move the board will run: the last loadMoves
 *  before `startJob`, each staged Z plus the G54 Z the board baked into it. */
function machineZAtStart(from = 0): number[] {
  const calls = socket().sent
  const startAt = calls.findIndex((m, index) => index >= from && m.m === 'startJob')
  expect(startAt).not.toBe(-1)
  // Whatever the board holds when it starts - staged at or before `from`.
  const staged = calls.slice(0, startAt).filter((m) => m.m === 'loadMoves').at(-1)
  expect(staged).toBeDefined()
  const a = staged!.a as { bakedZ: number; moves: { kind: string; to?: { z?: number } }[] }
  return a.moves
    .filter((move) => move.kind === 'line' && typeof move.to?.z === 'number')
    .map((move) => round(move.to!.z! + a.bakedZ))
}

const G53_NC = 'G21 G90 G54\nG0 X50 Y50 Z10\nG53 G0 Z190\nG0 X60 Y60\nM30\n'

describe('WO-1640: a loaded program follows a G54 edit made before Cycle Start', () => {
  for (const units of ['mm', 'inch'] as const) {
    it(`WO-2474 re-read reports lengths in ${units} and retains rotary offsets and rotation degrees`, async () => {
      const { useUiPrefs } = await import('../../store/uiPrefs')
      useUiPrefs.setState({ machineDisplayUnits: units })
      const configured = machine()
      configured.controllerDefinition!.axes.push(...(['A', 'B', 'C'] as const).map(axis => ({
        ...createDefaultAxisDefinition(axis), enabled: true,
      })))
      await disconnectMachine()
      useCamStore.getState().updateMachine(configured)
      await connectMachine('bridge')
      __resetEstopInterlockForTest()
      socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
      socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
      const ctrl = getMachineController()
      let degrees = 0
      vi.spyOn(ctrl as Required<Pick<typeof ctrl, 'wcsRotations'>>, 'wcsRotations').mockImplementation(() => ({ G54: degrees }))
      for (const axis of ['A', 'B', 'C'] as const) {
        expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
        await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      }
      socket().emit({ t: 'status', v: { ...idleBridgeStatus(), workPos: { x: 0, y: 0, z: 0, a: 0, b: 0, c: 0 } } } as BridgeMessage)
      await load('degree-re-read.nc', G53_NC)
      await editG54Z(EDITED_Z)
      for (const [axis, value] of [['A', 15], ['B', -25.1234], ['C', 30]] as const) {
        expect(setWorkOffsetValue('G54', axis, value)).toBe(true)
        await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      }
      degrees = 15
      socket().emit({ t: 'status', v: { ...idleBridgeStatus(), workPos: { x: 0, y: 0, z: 0, a: 45, b: -60, c: 90 } } } as BridgeMessage)
      useMachineControl.getState().clearConsole()
      await cycleStart()
      const said = consoleText()
      expect(said).toContain('read again for the new work offset')
      expect(said).toContain(units === 'mm' ? 'G54 Z 66.57 mm -> 110.00 mm' : 'G54 Z 2.621 in -> 4.331 in')
      expect(said).toContain('G54 A 0 -> 15')
      expect(said).toContain('G54 B 0 -> -25.1234')
      expect(said).toContain('G54 C 0 -> 30')
      expect(said).toContain('G54 rotation 0 -> 15 deg')
      expect(said).toContain('execution position (A 0 -> 45, B 0 -> -60, C 0 -> 90)')
      expect(said).not.toMatch(/(?:mm|in) deg/)
      useUiPrefs.setState({ machineDisplayUnits: 'mm' })
    })
  }

  it('load at G54 Z 66.57, edit to 110, Cycle Start: the board runs what a fresh load at 110 runs', async () => {
    // THE CONTROL: a fresh load at 110, run.
    await editG54Z(EDITED_Z)
    let mark = socket().sent.length
    await load('g53.nc', G53_NC)
    await cycleStart()
    const fresh = machineZAtStart(mark)
    // Work Z10 at the new zero, then G53 Z190 and the XY move that keeps it -
    // both at machine Z 190.
    expect(fresh).toEqual([round(10 + EDITED_Z), 190, 190])
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })

    // THE FINDING: load at 66.57, edit to 110, Cycle Start.
    await editG54Z(LOAD_Z)
    await load('g53.nc', G53_NC)
    await editG54Z(EDITED_Z)
    mark = socket().sent.length
    useMachineControl.setState({ consoleLines: [] })
    await cycleStart()
    expect(machineZAtStart(mark)).toEqual(fresh)
    // The G53 retract stays machine Z 190 - never 190 - 66.57 + 110.
    expect(machineZAtStart(mark)).not.toContain(round(190 - LOAD_Z + EDITED_Z))
    // Said once, in plain words.
    expect(consoleText().match(/read again for the new work offset/g)?.length).toBe(1)
  })

  it('an edit at an M0 hold: the section staged after it keeps G53 Z190 at machine Z 190', async () => {
    await load('g53-hold.nc', 'G21 G90 G54\nG0 X50 Y50 Z10\nM0\nG53 G0 Z190\nG0 X60 Y60\nM30\n')
    let mark = socket().sent.length
    await cycleStart()
    expect(machineZAtStart(mark)).toEqual([round(10 + LOAD_Z)])
    // The first section ends at the M0 and the program holds there.
    act(() => {
      socket().emit({ t: 'status', v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } } } as BridgeMessage)
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    await editG54Z(EDITED_Z)
    mark = socket().sent.length
    await cycleStart()
    // Before the fix the G53 move was resolved at 66.57 and baked at 110:
    // machine Z 233.43. It is a machine target and stays one.
    expect(machineZAtStart(mark)).toEqual([190, 190])
  })

  it('an offset left alone stages nothing new at Cycle Start and says nothing', async () => {
    await load('g53.nc', G53_NC)
    const mark = socket().sent.length
    useMachineControl.setState({ consoleLines: [] })
    await cycleStart()
    expect(socket().sent.slice(mark).map((m) => m.m)).not.toContain('loadMoves')
    expect(machineZAtStart(0)).toEqual([round(10 + LOAD_Z), 190, 190])
    expect(consoleText()).not.toMatch(/read again/)
  })
})
