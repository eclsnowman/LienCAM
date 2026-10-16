// @vitest-environment jsdom
import Ajv from 'ajv'
import { macroOutputSelection, selectedMacroOutput } from '../../lib/machine/macros/macroOutputSelection'
import { readFileSync } from 'node:fs'
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

// WO-2677: production panels/session/UCCNC controller, isolated fake bridge only.
// Reuses the WO-2668 board fixture with stale write replies and real readback.
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
// Raw-level override for opposite-polarity aliases; null is an unknown sample.
const rawLevels = new Map<string, boolean | null>()
let deferReads = false
const delayedReads: Array<() => void> = []

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
        const reply: BridgeMessage = {
          t: 'reply', seq: message.seq, ok: true,
          v: rawLevels.has(pinKey(args))
            ? { port: args.port, pin: args.pin, level: rawLevels.get(pinKey(args)), on: rawLevels.get(pinKey(args)) === null ? null : rawLevels.get(pinKey(args)) !== args.negate }
            : rawReadback(args, boardState.get(pinKey(args)) ?? false),
        }
        const deliver = () => this.fakeEvents?.onMessage(reply)
        if (deferReads) delayedReads.push(deliver)
        else deliver()
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
const { parkCarrierMachine } = await import('../../store/machineActionsStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { OutputsSection } = await import('../../components/machine/definition/OutputsSection')
const { watchedOutputPins } = await import('../../lib/machine/outputPinWatch')

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
      { id: 'vac-on', name: 'Vacuum on', body: "output('Vacuum', true)", drivesOutput: 'Vacuum' },
      { id: 'hello', name: 'Say hello', body: "line('M7')" },
      { id: 'pump', name: 'Pump indicator', body: "say('M7')", drivesOutput: 'Pump' },
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

describe('WO-2677: explicitly assigned macro buttons follow controller output readback', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    sockets.length = 0
    boardState.clear()
    rawLevels.clear()
    deferReads = false
    delayedReads.length = 0
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
    expect(lit('control-user-macro-vac-on')).toBe(false)

    expect(sendMdiLine('M7')).toBe(true)
    await advance(250)
    expect(boardState.get(VACUUM_PIN)).toBe(true)
    expect(useMachineControl.getState().consoleLines.map((l) => l.text)).toContain(
      'MDI M7: Vacuum on (port 3 pin 16) (controller readback confirmed).',
    )
    expect(lit('control-user-macro-vac-on')).toBe(true)

    expect(sendMdiLine('M9')).toBe(true)
    await advance(250)
    expect(boardState.get(VACUUM_PIN)).toBe(false)
    expect(lit('control-user-macro-vac-on')).toBe(false)
  })

  it('a press after MDI M7 sends the off word, not a second M7', async () => {
    renderPanels()
    expect(sendMdiLine('M7')).toBe(true)
    await advance(250)
    expect(lit('control-user-macro-vac-on')).toBe(true)

    const writesBefore = socket().sent.filter((m) => m.m === 'setOutput').length
    fireEvent.click(screen.getByTestId('control-vacuum'))
    await advance(250)
    const writes = socket().sent.filter((m) => m.m === 'setOutput').slice(writesBefore)
    expect(writes.map((m) => m.a)).toEqual([
      { port: 3, pin: 16, on: false, negate: false },
      { port: 1, pin: 17, on: false, negate: true },
    ])
    expect(lit('control-user-macro-vac-on')).toBe(false)
  })

  it('the button own press still lights and darkens it, from the readback, and says only what it did', async () => {
    renderPanels()
    fireEvent.click(screen.getByTestId('control-vacuum'))
    await advance(250)
    expect(boardState.get(VACUUM_PIN)).toBe(true)
    expect(lit('control-user-macro-vac-on')).toBe(true)
    fireEvent.click(screen.getByTestId('control-vacuum'))
    await advance(250)
    expect(boardState.get(VACUUM_PIN)).toBe(false)
    expect(lit('control-user-macro-vac-on')).toBe(false)
    // the operator 10-07 8:06 PM (WO-2664): "We should only say what the problem is.
    // Not infer that we understand the why."
    expect(consoleText()).toEqual(expect.arrayContaining(['Vacuum on (M7).', 'Vacuum off (M9).']))
    expect(consoleText().filter((line) => line.includes('because'))).toEqual([])
  })

  it('a macro switching its selected output lights itself; unassigned code never infers a selection', async () => {
    renderPanels()
    fireEvent.click(screen.getByTestId('control-user-macro-vac-on'))
    await advance(400)
    expect(boardState.get(VACUUM_PIN)).toBe(true)
    expect(lit('control-user-macro-vac-on')).toBe(true)
    // the operator 10-08 5:06 AM: "Vacuum now, macro field after alpha".
    const macro = screen.getByTestId('control-user-macro-vac-on')
    expect(macro.classList.contains('control-latched')).toBe(true)
    expect(lit('control-user-macro-hello')).toBe(false)
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
    expect(lit('control-user-macro-vac-on')).toBe(false)
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
    expect(lit('control-user-macro-vac-on')).toBe(true)
  })

  it.each([
    ['Stop/Reset', () => getMachineController().reset()],
    ['E-STOP', () => getMachineController().emergencyStop()],
  ] as const)('%s that switches the output off at the controller darkens the button', async (_name, edge) => {
    renderPanels()
    expect(sendMdiLine('M7')).toBe(true)
    await advance(250)
    expect(lit('control-user-macro-vac-on')).toBe(true)

    // The controller drops the pin itself; no word of ours switched it.
    boardState.set(VACUUM_PIN, false)
    act(() => { edge() })
    await advance(400)
    expect(lit('control-user-macro-vac-on')).toBe(false)
  })

  it('a reconnect reads the pins back: a vacuum left running shows lit', async () => {
    renderPanels()
    await disconnect()
    boardState.set(VACUUM_PIN, true)
    await connect()
    await advance(400)
    expect(lit('control-user-macro-vac-on')).toBe(true)
  })
  it('selects and persists an output; cancel, repeat save and none preserve legacy fields', async () => {
    renderPanels()
    fireEvent.click(screen.getByTestId('control-macros-edit'))
    fireEvent.click(screen.getByTestId('macro-editor-item-hello-edit'))
    const field = () => screen.getByTestId('macro-editor-output') as HTMLSelectElement
    expect(field().value).toBe('')
    fireEvent.change(field(), { target: { value: macroOutputSelection(OUTPUTS[1]) } })
    fireEvent.click(screen.getByTestId('macro-editor-cancel'))
    expect(parkCarrierMachine(useCamStore.getState()).macros!.find(m => m.id === 'hello')!.drivesOutput).toBeUndefined()
    fireEvent.click(screen.getByTestId('macro-editor-item-hello-edit'))
    fireEvent.change(field(), { target: { value: macroOutputSelection(OUTPUTS[0]) } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    const saved = () => parkCarrierMachine(useCamStore.getState()).macros!.find(m => m.id === 'hello')!
    expect(saved()).toMatchObject({ body: "line('M7')", drivesOutput: macroOutputSelection(OUTPUTS[0]) })
    expect(JSON.parse(JSON.stringify(saved())).drivesOutput).toBe(macroOutputSelection(OUTPUTS[0]))
    expect(field().value).toBe(macroOutputSelection(OUTPUTS[0]))
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    expect(saved().drivesOutput).toBe(macroOutputSelection(OUTPUTS[0]))
    fireEvent.change(field(), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    expect(saved().drivesOutput).toBeUndefined()
    fireEvent.click(screen.getByTestId('macro-editor-add'))
    expect(field().value).toBe('')
  })


  it('a read sampled before a newer write cannot replace the confirmed raw level', async () => {
    deferReads = true
    renderPanels()
    await advance(10)
    expect(delayedReads.length).toBeGreaterThan(0)
    deferReads = false
    expect(sendMdiLine('M7')).toBe(true)
    await advance(250)
    expect(lit('control-user-macro-vac-on')).toBe(true)
    await act(async () => { delayedReads.splice(0).forEach(deliver => deliver()) })
    await advance(10)
    expect(lit('control-user-macro-vac-on')).toBe(true)
    expect(lit('control-vacuum')).toBe(true)
  })

  it('a delayed old-session read cannot relight a reconnected off output', async () => {
    boardState.set(VACUUM_PIN, true)
    deferReads = true
    renderPanels()
    await advance(10)
    expect(delayedReads.length).toBeGreaterThan(0)
    await disconnect()
    boardState.set(VACUUM_PIN, false)
    deferReads = false
    await connect()
    await advance(400)
    await act(async () => { delayedReads.splice(0).forEach(deliver => deliver()) })
    await advance(10)
    expect(lit('control-user-macro-vac-on')).toBe(false)
    expect(lit('control-vacuum')).toBe(false)
  })

  it('supported output editor preserves opposite polarity definitions sharing one pin', () => {
    let configured = testMachine()
    configured.controllerDefinition!.outputs = [
      { ...OUTPUTS[0], pin: { port: 1, pin: 17, negate: false } },
      { ...OUTPUTS[1], pin: { port: 1, pin: 17, negate: false } },
    ]
    const onChange = (mut: (machine: MachineConfig) => MachineConfig) => { configured = mut(configured) }
    render(<OutputsSection machine={configured} onChange={onChange} />)
    const inverse = screen.getByRole('checkbox', { name: 'output 2 pin negate' })
    expect(inverse.getAttribute('data-tooltip')).toBe('Negate - the signal is active low')
    fireEvent.click(inverse)
    expect(configured.controllerDefinition!.outputs.map(o => o.pin)).toEqual([
      { port: 1, pin: 17, negate: false }, { port: 1, pin: 17, negate: true },
    ])
    expect(socket().sent.filter(m => m.m === 'setOutput')).toEqual([])
  })

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'R2 raw shared-pin readback applies each polarity (reverse=%s, spindle=%s)', async (reverse, spindle) => {
      await disconnect()
      const machine = testMachine()
      const outputs: MachineOutputDefinition[] = [
        { ...OUTPUTS[0], name: 'A', pin: { port: 1, pin: 17, negate: false } },
        { ...OUTPUTS[1], name: 'B', pin: { port: 1, pin: 17, negate: true } },
      ]
      machine.controllerDefinition!.outputs = outputs
      machine.macros = outputs.map(o => ({ id: o.name, name: o.name, body: "say('observe')", drivesOutput: macroOutputSelection(o) }))
      if (reverse) machine.macros.reverse()
      install(machine)
      rawLevels.set('1:17', true)
      await connect()
      render(<>{spindle && <SpindlePanel onOpenActions={() => {}} />}<MacroPanel onOpenActions={() => {}} rpm={0} /></>)
      await advance(300)
      expect(lit('control-user-macro-A')).toBe(true)
      expect(lit('control-user-macro-B')).toBe(false)
      if (spindle) expect(lit('control-vacuum')).toBe(true)
      rawLevels.set('1:17', false)
      act(() => { getMachineController().reset() })
      await advance(400)
      expect(lit('control-user-macro-A')).toBe(false)
      expect(lit('control-user-macro-B')).toBe(true)
      if (spindle) expect(lit('control-vacuum')).toBe(false)
      rawLevels.set('1:17', null)
      act(() => { getMachineController().reset() })
      await advance(400)
      expect(lit('control-user-macro-A')).toBe(false)
      expect(lit('control-user-macro-B')).toBe(false)
      await disconnect()
      expect(lit('control-user-macro-A')).toBe(false)
      expect(lit('control-user-macro-B')).toBe(false)
      rawLevels.set('1:17', true)
      await connect()
      await advance(400)
      expect(lit('control-user-macro-A')).toBe(true)
      expect(lit('control-user-macro-B')).toBe(false)
      expect(sockets.flatMap(s => s.sent).filter(m => m.m === 'setOutput')).toEqual([])
      cleanup()
      expect(watchedOutputPins()).toEqual([])
    },
  )

  it.each(['Pump', ''])('keeps the chosen %s output through save, reopen and reorder without writes', async (name) => {
    await disconnect()
    const machine = testMachine()
    const first = { ...OUTPUTS[0], name, role: undefined }
    const second = { ...OUTPUTS[1], name }
    machine.controllerDefinition!.outputs = [first, second]
    machine.macros = [{ id: 'choice', name: 'Chosen output', body: "say('unchanged')" }]
    install(machine)
    await connect()
    render(<MacroPanel onOpenActions={() => {}} rpm={0} />)
    fireEvent.click(screen.getByTestId('control-macros-edit'))
    fireEvent.click(screen.getByTestId('macro-editor-item-choice-edit'))
    const field = screen.getByTestId('macro-editor-output') as HTMLSelectElement
    fireEvent.change(field, { target: { value: field.options[2].value } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    const saved = parkCarrierMachine(useCamStore.getState()).macros![0]
    expect(saved.drivesOutput).toBe(macroOutputSelection(second))
    expect(saved.body).toBe("say('unchanged')")
    fireEvent.click(screen.getByTestId('macro-editor-cancel'))
    fireEvent.click(screen.getByTestId('macro-editor-item-choice-edit'))
    expect((screen.getByTestId('macro-editor-output') as HTMLSelectElement).value).toBe(saved.drivesOutput)
    cleanup()
    await disconnect()
    const reordered = { ...machine, controllerDefinition: { ...machine.controllerDefinition!, outputs: [second, first] }, macros: [saved] }
    install(reordered)
    boardState.set(pinKey(first.pin), true)
    boardState.set(pinKey(second.pin), false)
    await connect()
    render(<MacroPanel onOpenActions={() => {}} rpm={0} />)
    await advance(300)
    expect(lit('control-user-macro-choice')).toBe(false)
    boardState.set(pinKey(first.pin), false)
    boardState.set(pinKey(second.pin), true)
    await disconnect()
    await connect()
    await advance(300)
    expect(lit('control-user-macro-choice')).toBe(true)
    expect(sockets.flatMap(s => s.sent).filter(m => m.m === 'setOutput')).toEqual([])
    expect(selectedMacroOutput([first, second], name)).toBeUndefined()
  })

  it('lights the selected output only, including repeated M7/M9 and a custom inverted pin', async () => {
    renderPanels()
    for (const code of ['M7', 'M7', 'M9', 'M9']) {
      expect(sendMdiLine(code)).toBe(true)
      await advance(300)
      expect(lit('control-user-macro-vac-on')).toBe(code === 'M7')
      expect(lit('control-user-macro-pump')).toBe(false)
      expect(lit('control-user-macro-hello')).toBe(false)
    }
    expect(sendMdiLine('M12')).toBe(true)
    await advance(300)
    expect(lit('control-user-macro-pump')).toBe(true)
    expect(lit('control-user-macro-vac-on')).toBe(false)
    await disconnect()
    expect(lit('control-user-macro-pump')).toBe(false)
  })

})


describe('WO-2677 standalone macro schema compatibility', () => {
  const validate = new Ajv().compile(JSON.parse(readFileSync('docs/formats/macros.schema.json', 'utf8')))
  it.each([undefined, 'Vacuum', ''])('accepts old/new optional selection %s', (drivesOutput) => {
    const macro = { id: 'schema', name: 'Schema', body: "line('M7')", ...(drivesOutput === undefined ? {} : { drivesOutput }) }
    expect(validate({ format: 'liencam-macro', version: 1, macro })).toBe(true)
  })
  it.each([null, 7, true, {}, []])('rejects invalid selection %j', (drivesOutput) => {
    expect(validate({ format: 'liencam-macro', version: 1, macro: { id: 'schema', name: 'Schema', body: '', drivesOutput } })).toBe(false)
  })
})
