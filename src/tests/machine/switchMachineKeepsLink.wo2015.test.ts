// @vitest-environment jsdom
//
// WO-2015 - SWITCHING CONTROL'S MACHINE KEEPS THE LINK WHEN IT CAN.
//
// Operator's 09-25 session: with LienCNC V2 connected over the bridge and a program
// loaded, choosing the LIBRARY copy of LienCNC V2 in Control's machine dropdown
// (Control was following the CAM setup's copy of the same machine) disconnected
// the controller and dropped the program with a RED row "Program parts ended
// because the machine connection changed: disconnect requested No later part
// was loaded."
//
// WHAT IS PROVEN HERE, on the real session singleton talking to a real
// `UccncController` over a fake bridge socket, through the production doors
// (connect, the file loader and the rendered Control machine dropdown):
//   - a record on the same controller and the same bridge port keeps the
//     socket, the connection and the loaded program, whatever its record id -
//     the other copy of the same machine, and a separate record with its own id;
//   - any other switch (another port, another controller) behaves as before
//     WO-2015: it disconnects at once, and the program it ends is said in the
//     console - including when the operator returns to the displayed machine
//     while that disconnect is still in flight (audit 2's sequence).
//
// NOT CLAIMED: hardware. The same-machine switch sends nothing to the board;
// the machine seat confirms at the next session.

import { createElement, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
  maxProgramMoves: 10,
}

const G54_OFFSET = { x: 10, y: 5, z: 2 }

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  closes: number
  emit(message: BridgeMessage): void
}

const bridgeSockets: FakeBridgeTransport[] = []
/** When set, a socket close waits for it - a disconnect held in flight. */
let closeGate: Promise<void> | null = null

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class Fake extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    closes = 0
    private fakeEvents: BridgeTransportEvents | null = null

    constructor(...args: ConstructorParameters<typeof actual.BridgeTransport>) {
      super(...args)
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const offsets = Object.fromEntries(
        ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'].map((wcs) => [wcs, { ...G54_OFFSET }]),
      )
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-2015-fake 0.0',
          capabilities: CAPABILITIES,
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
      this.closes++
      if (closeGate) await closeGate
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: Fake })
})

const { controlMachine, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
} = await import('../../lib/machine/machineSession')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')

function lienCnc(): MachineConfig {
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
    id: 'wo2015-liencnc-v2',
    name: 'LienCNC V2',
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

/** The CAM setup's copy and the library's copy of ONE machine: same id, same
 *  controller, separately stored records. */
const PROJECT_COPY = lienCnc()
const LIBRARY_COPY: MachineConfig = { ...structuredClone(PROJECT_COPY), notes: 'library copy' }
/** A separately created record (its own id) for the same controller; neither
 *  record saves a bridge port, so both dial the same default endpoint. */
const SAME_PORT_TWIN: MachineConfig = {
  ...structuredClone(PROJECT_COPY),
  id: 'wo2015-liencnc-v2-spare',
  name: 'LienCNC V2 spare record',
}
/** A different controller altogether. */
const GRBL_MACHINE: MachineConfig = {
  ...structuredClone(PROJECT_COPY),
  id: 'wo2015-shop-grbl',
  name: 'Shop GRBL',
  controller: 'grbl',
}

const MOVE_COUNT = 40
const FILE = [
  'G21 G90 G54',
  'G0 Z10',
  'G0 X0 Y0',
  ...Array.from({ length: MOVE_COUNT - 2 }, (_, i) => (i % 5 === 4 ? `G0 X${i + 1} Y1` : `G1 X${i + 1} Y0 F1000`)),
  'M30',
  '',
].join('\n')
const FILE_NAME = 'operator-session.nc'

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function idleStatus(): MachineStatus {
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

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function renderControl(): HTMLSelectElement {
  render(createElement<NonNullable<ComponentProps<typeof ControlTransportBar>>>(
    ControlTransportBar, { sections: 'nav' }))
  return screen.getByTestId('control-machine-select') as HTMLSelectElement
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(select, { target: { value } })
    await vi.advanceTimersByTimeAsync(50)
  })
}

function linesSince(mark: number) {
  return useMachineControl.getState().consoleLines.slice(mark)
}

function consoleMark(): number {
  return useMachineControl.getState().consoleLines.length
}

async function loadProgram(): Promise<void> {
  expect(loadGcodeTextToolpathProgram(FILE_NAME, FILE, { publishListing: true }))
    .toEqual({ ok: true, reason: null })
  await advance(10)
  expect(useMachineControl.getState().job).toMatchObject({ phase: 'ready', totalLines: MOVE_COUNT })
  expect(useMachineControl.getState().programReadiness.ready).toBe(true)
}

beforeEach(async () => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  originalProject = useCamStore.getState().project
  originalLibrary = useCamStore.getState().machineLibrary
  originalControl = useCamStore.getState().control
  const state = useCamStore.getState()
  // Operator's state: Control follows the CAM setup, whose machine is the project
  // copy of LienCNC V2; the library holds its own copy and another machine.
  useCamStore.setState({
    machineLibrary: [LIBRARY_COPY, GRBL_MACHINE],
    project: { ...state.project, machine: PROJECT_COPY, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: null,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  })
  useMachineControl.setState({ consoleLines: [] })
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => { socket().emit({ t: 'status', v: idleStatus() } as BridgeMessage) })
  act(() => { socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage) })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  expect(getMachineController().connectionPhase()).toBe('connected')
})

afterEach(async () => {
  cleanup()
  closeGate = null
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

describe('WO-2015: the other copy of the same machine keeps the link', () => {
  it('library copy and back: connection, socket and loaded program all survive, no red row', async () => {
    const select = renderControl()
    await loadProgram()
    const link = socket()
    const sentBefore = link.sent.length
    const sessionMachine = useCamStore.getState().control.sessionMachine
    const mark = consoleMark()

    await choose(select, LIBRARY_COPY.id)

    expect(getMachineController().connectionPhase()).toBe('connected')
    expect(bridgeSockets).toHaveLength(1)
    expect(link.closes).toBe(0)
    expect(link.sent.length).toBe(sentBefore)
    expect(useCamStore.getState().control.sessionMachine).toBe(sessionMachine)
    expect(useCamStore.getState().control.activeMachineId).toBe(LIBRARY_COPY.id)
    expect(select.value).toBe(LIBRARY_COPY.id)
    expect(useMachineControl.getState().job).toMatchObject({ phase: 'ready', name: FILE_NAME })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    const said = linesSince(mark)
    expect(said).toHaveLength(1)
    expect(said[0].severity).toBe('info')
    expect(said[0].text).toContain('the connection and the loaded program stay')

    // ...and back to Follow CAM (the project copy): the same, again.
    await choose(select, '')

    expect(getMachineController().connectionPhase()).toBe('connected')
    expect(link.closes).toBe(0)
    expect(link.sent.length).toBe(sentBefore)
    expect(select.value).toBe('')
    expect(useCamStore.getState().control.activeMachineId).toBeNull()
    expect(useMachineControl.getState().job).toMatchObject({ phase: 'ready', name: FILE_NAME })
    expect(linesSince(mark).some((line) => line.severity === 'error')).toBe(false)
    expect(linesSince(mark).map((line) => line.text).join('\n')).not.toContain('Program parts ended')
  })
})

describe('WO-2015: a different record on the same controller and bridge port keeps the link', () => {
  it('no saved port on either record: link and program stay; the record takes over at the next connect', async () => {
    useCamStore.setState({ machineLibrary: [LIBRARY_COPY, SAME_PORT_TWIN, GRBL_MACHINE] })
    const select = renderControl()
    await loadProgram()
    const link = socket()
    const sentBefore = link.sent.length
    const sessionMachine = useCamStore.getState().control.sessionMachine
    const mark = consoleMark()

    await choose(select, SAME_PORT_TWIN.id)

    expect(getMachineController().connectionPhase()).toBe('connected')
    expect(bridgeSockets).toHaveLength(1)
    expect(link.closes).toBe(0)
    expect(link.sent.length).toBe(sentBefore)
    expect(useCamStore.getState().control.sessionMachine).toBe(sessionMachine)
    expect(controlMachine(useCamStore.getState()).id).toBe(PROJECT_COPY.id)
    expect(useCamStore.getState().control.activeMachineId).toBe(SAME_PORT_TWIN.id)
    expect(useMachineControl.getState().job).toMatchObject({ phase: 'ready', name: FILE_NAME })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    const said = linesSince(mark)
    expect(said).toHaveLength(1)
    expect(said[0].severity).toBe('info')
    expect(said[0].text).toBe(
      'LienCNC V2 spare record uses the same controller on the same port, so the connection '
        + "and the loaded program stay. Control keeps LienCNC V2's settings until you "
        + 'disconnect; LienCNC V2 spare record takes over at the next connect.',
    )

    const pending = disconnectMachine()
    await advance(300)
    await pending
    expect(controlMachine(useCamStore.getState())).toBe(SAME_PORT_TWIN)
  })

  it('choosing the connected row again withdraws the waiting choice', async () => {
    useCamStore.setState({ machineLibrary: [LIBRARY_COPY, SAME_PORT_TWIN, GRBL_MACHINE] })
    const select = renderControl()
    await choose(select, SAME_PORT_TWIN.id)
    expect(useCamStore.getState().control.activeMachineId).toBe(SAME_PORT_TWIN.id)

    await choose(select, '')

    expect(getMachineController().connectionPhase()).toBe('connected')
    expect(useCamStore.getState().control.activeMachineId).toBeNull()
    const pending = disconnectMachine()
    await advance(300)
    await pending
    expect(controlMachine(useCamStore.getState()).id).toBe(PROJECT_COPY.id)
  })

  it('a different saved bridge port is a different endpoint: disconnects as before', async () => {
    useCamStore.setState({ machineLibrary: [LIBRARY_COPY, SAME_PORT_TWIN, GRBL_MACHINE] })
    const links = useUiPrefs.getState().machineLinks
    useUiPrefs.setState({ machineLinks: { ...links, [SAME_PORT_TWIN.id]: { bridgePort: 50123 } } })
    try {
      const select = renderControl()
      const link = socket()

      await choose(select, SAME_PORT_TWIN.id)
      await advance(300)

      expect(getMachineController().connectionPhase()).toBe('disconnected')
      expect(link.closes).toBeGreaterThan(0)
      expect(controlMachine(useCamStore.getState())).toBe(SAME_PORT_TWIN)
    } finally {
      useUiPrefs.setState({ machineLinks: links })
    }
  })
})

describe('WO-2015: a different controller behaves as before', () => {
  it('disconnects at once with no question, and says the program it ended', async () => {
    const select = renderControl()
    await loadProgram()
    const link = socket()
    const mark = consoleMark()

    await choose(select, GRBL_MACHINE.id)
    await advance(300)

    expect(getMachineController().connectionPhase()).toBe('disconnected')
    expect(link.closes).toBeGreaterThan(0)
    expect(controlMachine(useCamStore.getState())).toBe(GRBL_MACHINE)
    expect(select.value).toBe(GRBL_MACHINE.id)
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    const said = linesSince(mark).map((line) => line.text).join('\n')
    expect(said).toContain('Program parts ended because the machine connection changed')
    expect(said).not.toContain('takes over at the next connect')
  })

  it('returning to the displayed machine while that disconnect is in flight never unloads silently', async () => {
    const select = renderControl()
    await loadProgram()
    const link = socket()
    const mark = consoleMark()
    let releaseClose!: () => void
    closeGate = new Promise<void>((resolve) => { releaseClose = resolve })

    // Audit 2's sequence: LienCNC V2 -> Shop GRBL, then back to LienCNC V2
    // (Follow CAM) before the disconnect has finished.
    await choose(select, GRBL_MACHINE.id)
    expect(link.closes).toBe(1)
    await choose(select, '')
    closeGate = null
    releaseClose()
    await advance(300)

    expect(getMachineController().connectionPhase()).toBe('disconnected')
    expect(controlMachine(useCamStore.getState()).id).toBe(PROJECT_COPY.id)
    expect(useCamStore.getState().control.activeMachineId).toBeNull()
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    const ended = linesSince(mark).filter((line) =>
      line.text.includes('Program parts ended because the machine connection changed'))
    expect(ended).toHaveLength(1)
    // WO-3127 (6051538432) reports an ordinary requested Disconnect as an info
    // console row and keeps its failed job lifecycle; only an unrequested
    // boundary stays an error. The bar here is that it is never silent.
    expect(ended[0].severity).toBe('info')
  })
})
