// @vitest-environment jsdom
//
// WO-1707 FIX ROUND - the audit's findings, proven behaviourally.
//
// 1. THE MOVE IS ONE-TIME. A pre-1707 custom button is written onto the
//    machine record's macro list once, and the older list (and its
//    arrangement entry) is cleared. Deleting the moved button in the macro
//    editor deletes it: it does not come back, not on the next read, not
//    after the older store rehydrates again. A hidden button moves across
//    hidden, never lost. A machine with no custom buttons is not touched.
// 2. A FORMER BUTTON SENDS EXACTLY AS IT DID. Its body is one `lines(...)`
//    call, which runs `runMachineAction` - the path the button always took.
//    On a geometry controller (Operator's AXBB-E through the UCCNC bridge,
//    `gcodeText: false`) a two-line move button stages ONE program, the same
//    staged send `runMachineAction` makes for those lines.
// 3. (macroRefusal.wo981.test.tsx) a transport refusal is not labelled as an
//    E-STOP refusal.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import type { TransportEvents } from '../../lib/machine/types'
import {
  UNASSIGNED_PIN,
  createDefaultControllerDefinition,
  type MachineConfig,
  type Project,
} from '../../types'
import type { CustomAction } from '../../lib/machine/machineActions'
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

const G54_OFFSET = { x: 10, y: 5, z: 2 }
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
          bridge: 'wo-1707-fake 0.0',
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

vi.mock('../../lib/machine/webSerialTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/webSerialTransport')>()
  class Fake extends actual.WebSerialTransport {
    private fakeEvents: TransportEvents | null = null
    static isSupported(): boolean { return true }
    static async requestPort(): Promise<SerialPort> { return {} as SerialPort }
    static async grantedPorts(): Promise<SerialPort[]> { return [] }
    async start(events: TransportEvents): Promise<void> {
      this.fakeEvents = events
      events.onChunk(new TextEncoder().encode("Grbl 1.1h ['$' for help]\r\n"))
    }
    async write(_data: Uint8Array): Promise<void> {}
    async close(): Promise<void> { this.fakeEvents?.onClose(null) }
  }
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({ ...actual, WebSerialTransport: Fake })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { MacroEditor } = await import('../../components/machine/MacroEditor')
const { __resetMacroRuntimeForTest, checkMacroBody } = await import('../../lib/machine/macros/macroRuntime')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runMachineAction,
} = await import('../../lib/machine/machineSession')

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
  // WO-1649: the machine's one output list, stating flood and mist and wiring
  // neither. The profile's relay keys used to imply this list and the resolver
  // read them directly; now the list IS the statement, so a fixture that wants
  // "named but unwired" says so here.
  controllerDefinition.outputs = [
    { name: 'flood coolant', role: 'flood', onCode: 'M8', offCode: null, pin: { ...UNASSIGNED_PIN } },
    { name: 'mist coolant', role: 'mist', onCode: 'M7', offCode: null, pin: { ...UNASSIGNED_PIN } },
  ]
  return makeMachine({
    id: 'wo1707-bridge',
    name: 'WO-1707 bridge bench',
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

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

beforeEach(() => {
  bridgeSockets.length = 0
  originalProject = useCamStore.getState().project
  originalLibrary = useCamStore.getState().machineLibrary
  originalControl = useCamStore.getState().control
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
})

afterEach(async () => {
  cleanup()
  __resetMacroRuntimeForTest()
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
  useMachineControl.setState({ consoleLines: [] })
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  act(() => { __resetEstopInterlockForTest() })
  vi.useRealTimers()
})

function record(id: string): MachineConfig {
  return useCamStore.getState().machineLibrary.find((m) => m.id === id)!
}

/** A pre-1707 custom list, as the older persisted store holds it. */
function seedCustom(machineId: string, custom: CustomAction[], arrangement?: { order: string[]; hidden: string[] }): void {
  useMachineActions.setState((s) => ({
    byMachine: {
      ...s.byMachine,
      [machineId]: { overrides: {}, custom, parks: [], safeZMachine: null },
    },
    macroArrangementByMachine: arrangement
      ? { ...s.macroArrangementByMachine, [machineId]: arrangement }
      : s.macroArrangementByMachine,
  }))
}

const VACUUM: CustomAction = { id: 'vacuum', label: 'Vacuum', color: 'green', lines: ['M8'] }
const LIGHTS: CustomAction = { id: 'lights', label: 'Lights', color: 'neutral', lines: ['M64 P1'] }
const DUST: CustomAction = { id: 'dust', label: 'Dust boot', color: 'amber', lines: ['M64 P2'], confirm: true }

describe('WO-1707 fix 1: the custom buttons move onto the record ONCE', () => {
  beforeEach(() => {
    install(uccncMachine())
  })

  it('moves them in the arranged order, hidden kept hidden, and empties the older store', () => {
    const own = { id: 'wipe', name: 'Wipe down', body: "line('M64 P3')" }
    useCamStore.getState().updateMachineInLibrary('wo1707-bridge', { macros: [own] })
    seedCustom('wo1707-bridge', [VACUUM, LIGHTS, DUST], { order: ['dust', 'vacuum', 'lights'], hidden: ['lights'] })

    const macros = record('wo1707-bridge').macros ?? []
    expect(macros.map((m) => m.id)).toEqual(['dust', 'vacuum', 'lights', 'wipe'])
    expect(macros.find((m) => m.id === 'lights')?.hidden).toBe(true)
    expect(macros.find((m) => m.id === 'dust')).toMatchObject({ name: 'Dust boot', color: 'amber', confirm: true })
    expect(macros.find((m) => m.id === 'vacuum')?.hidden).toBeUndefined()
    // The project's own copy of the machine carries the same list.
    expect(useCamStore.getState().project.machine.macros).toEqual(macros)
    // The older list and its arrangement are gone.
    expect(useMachineActions.getState().byMachine['wo1707-bridge'].custom).toEqual([])
    expect(useMachineActions.getState().macroArrangementByMachine['wo1707-bridge']).toBeUndefined()
    // Every moved body parses.
    for (const m of macros) expect(checkMacroBody(m.body).ok).toBe(true)
  })

  it('a hidden button stays off the panel but is still in the macro editor', () => {
    seedCustom('wo1707-bridge', [VACUUM, LIGHTS], { order: ['vacuum', 'lights'], hidden: ['lights'] })
    render(<><MacroPanel onOpenActions={() => {}} rpm={10000} /><MacroEditor open onClose={() => {}} /></>)
    expect(screen.getByTestId('control-user-macro-vacuum')).toBeTruthy()
    expect(screen.queryByTestId('control-user-macro-lights')).toBeNull()
    expect(screen.getByTestId('macro-editor-item-lights-name').textContent).toBe('Lights')
    fireEvent.click(screen.getByTestId('macro-editor-item-lights-edit'))
    expect((screen.getByTestId('macro-editor-shown') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByTestId('macro-editor-shown'))
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    expect(screen.getByTestId('control-user-macro-lights')).toBeTruthy()
  })

  it('a moved button deleted in the macro editor stays gone - after a re-read and after the older store reloads', async () => {
    seedCustom('wo1707-bridge', [VACUUM, LIGHTS])
    render(<MacroEditor open onClose={() => {}} />)
    expect(screen.getByTestId('macro-editor-item-vacuum-name').textContent).toBe('Vacuum')

    fireEvent.click(screen.getByTestId('macro-editor-item-vacuum-delete'))
    // NEGATIVE CONTROL: on the audited branch (a read-time fold) the button
    // reappeared right here.
    expect(screen.queryByTestId('macro-editor-item-vacuum-name')).toBeNull()
    expect(screen.getByTestId('macro-editor-item-lights-name')).toBeTruthy()

    // Reload: the older store rehydrates from what it persisted (the cleared
    // list, saved by the move), and the machine record is loaded again.
    await act(async () => { await useMachineActions.persist.rehydrate() })
    act(() => { useCamStore.getState().updateMachineInLibrary('wo1707-bridge', { ...record('wo1707-bridge') }) })
    cleanup()
    render(<MacroEditor open onClose={() => {}} />)
    expect(screen.queryByTestId('macro-editor-item-vacuum-name')).toBeNull()
    expect(record('wo1707-bridge').macros?.map((m) => m.id)).toEqual(['lights'])
    expect(useMachineActions.getState().byMachine['wo1707-bridge'].custom).toEqual([])
  })

  it('a machine with no custom buttons is not touched, and the same button arriving twice is not doubled', () => {
    const before = record('wo1707-bridge')
    const beforeProject = useCamStore.getState().project.machine
    seedCustom('wo1707-bridge', [])
    expect(record('wo1707-bridge')).toBe(before)
    expect(useCamStore.getState().project.machine).toBe(beforeProject)

    seedCustom('wo1707-bridge', [VACUUM])
    seedCustom('wo1707-bridge', [VACUUM])
    expect(record('wo1707-bridge').macros?.map((m) => m.id)).toEqual(['vacuum'])
  })
})

const TWO_MOVES = ['G0 X10', 'G0 Y10']

interface StagedSend {
  loads: number
  starts: number
  steps: unknown[]
}

function stagedSince(mark: number): StagedSend {
  const sent = socket().sent.slice(mark)
  const loads = sent.filter((m) => m.m === 'loadMoves')
  return {
    loads: loads.length,
    starts: sent.filter((m) => m.m === 'startJob').length,
    steps: loads.flatMap((m) => (m.a as { moves: unknown[] }).moves),
  }
}

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

async function connectBridge(): Promise<void> {
  install(uccncMachine())
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
}

async function disconnect(): Promise<void> {
  cleanup()
  __resetMacroRuntimeForTest()
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(300)
  await pending
}

describe('WO-1707 fix 2: a former button sends exactly as runMachineAction did', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('a two-line move button on a geometry controller stages ONE program, identical to runMachineAction', async () => {
    // What the button sent before WO-1707: `runMachineAction(lines)`.
    await connectBridge()
    expect(getMachineController().capabilities.gcodeText).toBe(false)
    let mark = socket().sent.length
    expect(runMachineAction([...TWO_MOVES])).toEqual({ ok: true, sent: 2 })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const before = stagedSince(mark)
    await disconnect()

    // The same button, moved onto the record and pressed on the Macros panel.
    await connectBridge()
    seedCustom('wo1707-bridge', [{ id: 'xy', label: 'Go XY', color: 'green', lines: [...TWO_MOVES] }])
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    mark = socket().sent.length
    await act(async () => { fireEvent.click(screen.getByTestId('control-user-macro-xy')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    const after = stagedSince(mark)

    expect(before.loads).toBe(1)
    expect(before.starts).toBe(1)
    expect(before.steps).toHaveLength(2)
    // NEGATIVE CONTROL: line-by-line (the audited branch's one `line()` per
    // G-code line) staged the first move alone - one load of ONE step, and
    // the second line waited on the machine - not this.
    expect(after).toEqual(before)
    expect(useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')).not.toContain('MDI is locked out')
  })
})
