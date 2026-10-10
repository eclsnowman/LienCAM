// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  type MachineOutputDefinition,
  type Project,
} from '../../types'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'

// WO-2668, the operator 2026-10-07 at the machine: "Yes we should link those." Measured:
// MDI M7 read back "Vacuum on (port 3 pin 16) (controller readback confirmed)"
// and control-vacuum stayed dark. the operator 10-08 5:06 AM: "Vacuum now, macro field
// after alpha" - so the Vacuum button follows its pin by every route, and the
// macro buttons keep main's look (WO-2677 does them after the alpha).
//
// The production door end to end: the Control panels as rendered, sendMdiLine /
// the panel's own press / a macro button / a loaded program -> machineSession ->
// UccncController -> a fake bridge wire whose board keeps each pin's level.
// Nothing here sets the store's output state by hand; the button lights from
// what the wire answered.

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

interface OutputArgs { port: number; pin: number; on: boolean; negate: boolean }
interface ReadArgs { port: number; pin: number; negate: boolean }

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const sockets: FakeBridgeTransport[] = []
/** The board: each pin's state, the definition's polarity applied. */
const boardState = new Map<string, boolean>()

function pinKey(args: { port: number; pin: number }): string {
  return `${args.port}:${args.pin}`
}

function rawReadback(args: ReadArgs, on: boolean): Record<string, unknown> {
  return { port: args.port, pin: args.pin, ucPin: 99, level: on !== args.negate, on }
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class Fake extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor(...args: ConstructorParameters<typeof actual.BridgeTransport>) {
      super(...args)
      sockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const zero = { x: 0, y: 0, z: 0 }
      const offsets = { G54: zero, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-2668-fake 0.0',
          capabilities: CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'setOutput') {
        const args = message.a as unknown as OutputArgs
        const prior = boardState.get(pinKey(args)) ?? false
        boardState.set(pinKey(args), args.on)
        // As recorded on the board (WO-1800): the write reply carries the
        // sample from before the write; the later getOutput reads the truth.
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: rawReadback(args, prior) })
        return
      }
      if (message.m === 'getOutput') {
        const args = message.a as unknown as ReadArgs
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: rawReadback(args, boardState.get(pinKey(args)) ?? false),
        })
        return
      }
      this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
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
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { SpindlePanel } = await import('../../components/machine/SpindlePanel')
const { MacroPanel } = await import('../../components/machine/MacroPanel')

// the machine wiring as measured: the vacuum on M7, port 3 pin 16, no mist
// and no flood, M9 the shared off. A pump with its own words beside it.
const VACUUM_PIN = '3:16'
const OUTPUTS: MachineOutputDefinition[] = [
  { name: 'Vacuum', role: 'vacuum', onCode: 'M7', offCode: null, pin: { port: 3, pin: 16, negate: false } },
  { name: 'Pump', onCode: 'M12', offCode: 'M13', pin: { port: 1, pin: 17, negate: true } },
]

function testMachine(): MachineConfig {
  const definition = createDefaultControllerDefinition()
  for (const axis of definition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -50 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  definition.stated = definition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  definition.outputs = OUTPUTS
  return {
    ...makeMachine({
      id: 'wo2668-machine',
      name: 'WO-2668 Test Machine',
      controller: 'uccnc',
      travel: { x: 600, y: 400, z: 200 },
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'min', homePositionMm: -50 },
      },
      rapidRate: 5000,
      controllerDefinition: definition,
    }),
    coolant: false,
    coolantCapability: { mist: false, flood: false },
    macros: [
      { id: 'vac-on', name: 'Vacuum on', body: "output('Vacuum', true)" },
      { id: 'hello', name: 'Say hello', body: "say('hello')" },
    ],
  }
}

function install(machine: MachineConfig): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [machine],
    project: { ...state.project, machine, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: machine.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  })
}

function socket(): FakeBridgeTransport {
  return sockets[sockets.length - 1]
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function connect(): Promise<void> {
  const pending = connectMachine('bridge')
  await advance(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
}

async function disconnect(): Promise<void> {
  const pending = disconnectMachine()
  await advance(300)
  await pending
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

function consoleText(): string[] {
  return useMachineControl.getState().consoleLines.map((l) => l.text)
}

function lit(testId: string): boolean {
  return screen.getByTestId(testId).classList.contains('control-latched')
}

function renderPanels(): void {
  render(
    <>
      <SpindlePanel onOpenActions={() => {}} />
      <MacroPanel onOpenActions={() => {}} rpm={0} />
    </>,
  )
}

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

describe('WO-2668: the Vacuum button on Control shows the vacuum output real state', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    sockets.length = 0
    boardState.clear()
    originalProject = useCamStore.getState().project
    originalLibrary = useCamStore.getState().machineLibrary
    originalControl = useCamStore.getState().control
    install(testMachine())
    await connect()
  })

  afterEach(async () => {
    cleanup()
    if (getMachineController().connectionPhase() !== 'disconnected') await disconnect()
    useCamStore.setState({
      project: originalProject,
      machineLibrary: originalLibrary,
      control: originalControl,
      machineWorkOffsets: {},
    })
    clearPathFidelity()
    useMachineControl.setState({ consoleLines: [] })
    useMachineActions.setState({ byMachine: {} })
    act(() => { __resetEstopInterlockForTest() })
    act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
    vi.useRealTimers()
  })

  it('MDI M7 lights the Vacuum button and MDI M9 darkens it (the measured defect)', async () => {
    renderPanels()
    await advance(50)
    expect(lit('control-vacuum')).toBe(false)

    expect(sendMdiLine('M7')).toBe(true)
    await advance(250)
    expect(boardState.get(VACUUM_PIN)).toBe(true)
    expect(useMachineControl.getState().consoleLines.map((l) => l.text)).toContain(
      'MDI M7: Vacuum on (port 3 pin 16) (controller readback confirmed).',
    )
    expect(lit('control-vacuum')).toBe(true)

    expect(sendMdiLine('M9')).toBe(true)
    await advance(250)
    expect(boardState.get(VACUUM_PIN)).toBe(false)
    expect(lit('control-vacuum')).toBe(false)
  })

  it('a press after MDI M7 sends the off word, not a second M7', async () => {
    renderPanels()
    expect(sendMdiLine('M7')).toBe(true)
    await advance(250)
    expect(lit('control-vacuum')).toBe(true)

    const writesBefore = socket().sent.filter((m) => m.m === 'setOutput').length
    fireEvent.click(screen.getByTestId('control-vacuum'))
    await advance(250)
    const writes = socket().sent.filter((m) => m.m === 'setOutput').slice(writesBefore)
    expect(writes.map((m) => m.a)).toEqual([
      { port: 3, pin: 16, on: false, negate: false },
      { port: 1, pin: 17, on: false, negate: true },
    ])
    expect(lit('control-vacuum')).toBe(false)
  })

  it('the button own press still lights and darkens it, from the readback, and says only what it did', async () => {
    renderPanels()
    fireEvent.click(screen.getByTestId('control-vacuum'))
    await advance(250)
    expect(boardState.get(VACUUM_PIN)).toBe(true)
    expect(lit('control-vacuum')).toBe(true)
    fireEvent.click(screen.getByTestId('control-vacuum'))
    await advance(250)
    expect(boardState.get(VACUUM_PIN)).toBe(false)
    expect(lit('control-vacuum')).toBe(false)
    // the operator 10-07 8:06 PM (WO-2664): "We should only say what the problem is.
    // Not infer that we understand the why."
    expect(consoleText()).toEqual(expect.arrayContaining(['Vacuum on (M7).', 'Vacuum off (M9).']))
    expect(consoleText().filter((line) => line.includes('because'))).toEqual([])
  })

  it('a macro switching the output lights the Vacuum button; the macro button keeps its own look', async () => {
    renderPanels()
    fireEvent.click(screen.getByTestId('control-user-macro-vac-on'))
    await advance(400)
    expect(boardState.get(VACUUM_PIN)).toBe(true)
    expect(lit('control-vacuum')).toBe(true)
    // the operator 10-08 5:06 AM: "Vacuum now, macro field after alpha".
    const macro = screen.getByTestId('control-user-macro-vac-on')
    expect(macro.classList.contains('control-latched')).toBe(false)
    expect(macro.hasAttribute('data-output-on')).toBe(false)
  })

  it("a loaded program's M7 lights the Vacuum button", async () => {
    act(() => {
      socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
      socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    })
    renderPanels()
    const loaded = loadGcodeTextToolpathProgram(
      'vacuum.nc',
      'G21 G90 G54\nG0 X0 Y0 Z10\nG1 Z-1 F300\nM7\nG1 X5 F300\nG0 Z10\nM30\n',
    )
    await advance(10)
    expect(loaded).toEqual({ ok: true, reason: null })
    expect(lit('control-vacuum')).toBe(false)
    expect(await executeOperatorCycleStart()).toBe(true)
    await advance(10)
    const writesBefore = socket().sent.filter((m) => m.m === 'setOutput').length
    act(() => {
      socket().emit({
        t: 'status',
        v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
      } as BridgeMessage)
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    // Under the job-end read's 250 ms: the light is the write's own receipt.
    await advance(200)
    const writes = socket().sent.filter((m) => m.m === 'setOutput').slice(writesBefore)
    expect(writes.map((m) => m.a)).toEqual([{ port: 3, pin: 16, on: true, negate: false }])
    expect(boardState.get(VACUUM_PIN)).toBe(true)
    expect(lit('control-vacuum')).toBe(true)
  })

  it.each([
    ['Stop/Reset', () => getMachineController().reset()],
    ['E-STOP', () => getMachineController().emergencyStop()],
  ] as const)('%s that switches the output off at the controller darkens the button', async (_name, edge) => {
    renderPanels()
    expect(sendMdiLine('M7')).toBe(true)
    await advance(250)
    expect(lit('control-vacuum')).toBe(true)

    // The controller drops the pin itself; no word of ours switched it.
    boardState.set(VACUUM_PIN, false)
    act(() => { edge() })
    await advance(400)
    expect(lit('control-vacuum')).toBe(false)
  })

  it('a reconnect reads the pins back: a vacuum left running shows lit', async () => {
    renderPanels()
    await disconnect()
    boardState.set(VACUUM_PIN, true)
    await connect()
    await advance(400)
    expect(lit('control-vacuum')).toBe(true)
  })
})
