// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeMessage } from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import { createDefaultControllerDefinition, type MachineConfig, type MachineMacro } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { controlMachine, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const session = await import('../../lib/machine/machineSession')
const {
  __resetMacroRuntimeForTest,
  activeMacroAsk,
  activeMacroRun,
  answerMacroAsk,
  runUserMacro,
} = await import('../../lib/machine/macros/macroRuntime')

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []
  closeCalls = 0
  readonly url: string

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  send(value: string): void { this.sent.push(value) }
  close(): void { this.closeCalls++ }
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  emit(message: BridgeMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
  hello(): void {
    this.emit({
      t: 'hello',
      v: {
        protocol: 1,
        bridge: 'wo-1787-old-session',
        capabilities: CAPABILITIES,
        readOnly: false,
      },
    })
  }
  fail(): void {
    this.onerror?.()
    this.onclose?.({ code: 1006, reason: '' } as CloseEvent)
  }
}

const baseMachine = useCamStore.getState().project.machine
const MACHINE_A: MachineConfig = {
  ...structuredClone(baseMachine),
  id: 'wo1787-a',
  name: 'WO-1787 Machine A',
  controller: 'uccnc',
  controllerDefinition: createDefaultControllerDefinition(),
}
const MACHINE_B: MachineConfig = {
  ...structuredClone(MACHINE_A),
  id: 'wo1787-b',
  name: 'WO-1787 Machine B',
}
const MACHINE_C: MachineConfig = {
  ...structuredClone(MACHINE_A),
  id: 'wo1787-c',
  name: 'WO-1787 Machine C',
}
const CONFIRM: MachineMacro = {
  id: 'wo1787-confirm',
  name: 'Old session question',
  body: "confirm('Resume old session?')\nsay('OLD QUESTION RESUMED')\nline('M8')",
}

let originalWebSocket: unknown

function resetSelection(): void {
  useCamStore.setState((state) => ({
    machineLibrary: [MACHINE_A, MACHINE_B, MACHINE_C],
    project: { ...state.project, machine: MACHINE_A },
    control: {
      ...state.control,
      activeMachineId: MACHINE_A.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  }))
  useMachineControl.setState((state) => ({
    connectionPhase: 'disconnected',
    connectionKind: null,
    connectionDetail: null,
    machineState: 'unknown',
    consoleLines: [],
    job: { ...state.job, phase: 'empty', name: null },
    programReadiness: { ready: false, reason: '' },
  }))
}

async function connectSimulator(): Promise<void> {
  vi.useFakeTimers()
  const connected = session.connectMachine('simulator')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
    await connected
  })
  vi.useRealTimers()
  expect(session.getMachineController().connectionPhase()).toBe('connected')
}

async function connectBridge(): Promise<FakeSocket> {
  const connected = session.connectMachine('bridge')
  const socket = FakeSocket.instances.at(-1)!
  socket.open()
  socket.hello()
  await act(async () => { await connected })
  expect(session.getMachineController().connectionPhase()).toBe('connected')
  return socket
}

function renderSelector(): HTMLSelectElement {
  render(<ControlTransportBar sections="nav" />)
  return screen.getByTestId('control-machine-select') as HTMLSelectElement
}

async function choose(select: HTMLSelectElement, machine: MachineConfig): Promise<void> {
  await act(async () => {
    fireEvent.change(select, { target: { value: machine.id } })
    await Promise.resolve()
  })
}

beforeEach(async () => {
  mem.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
  session.__resetEstopInterlockForTest()
  __resetMacroRuntimeForTest()
  resetSelection()
  FakeSocket.instances = []
  const global = globalThis as unknown as { WebSocket: unknown }
  originalWebSocket = global.WebSocket
  global.WebSocket = FakeSocket as unknown
  useUiPrefs.setState({
    machineLinks: {
      [MACHINE_A.id]: { bridgePort: 21787 },
      [MACHINE_B.id]: { bridgePort: 21788 },
      [MACHINE_C.id]: { bridgePort: 21789 },
    },
  })
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  __resetMacroRuntimeForTest()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
  const global = globalThis as unknown as { WebSocket: unknown }
  global.WebSocket = originalWebSocket
})

describe('WO-1787 machine selection owns the disconnect boundary', () => {
  it('changes an already disconnected selection without connecting or applying it', async () => {
    const select = renderSelector()

    await choose(select, MACHINE_B)

    expect(controlMachine(useCamStore.getState())).toBe(MACHINE_B)
    expect(session.getMachineController().connectionPhase()).toBe('disconnected')
    expect(FakeSocket.instances).toHaveLength(0)
    expect(useCamStore.getState().control.sessionMachine).toBeNull()
  })

  it('disconnects a live session, ends its job and open question, then selects the requested definition', async () => {
    await connectSimulator()
    const select = renderSelector()
    useMachineControl.setState((state) => ({
      job: { ...state.job, phase: 'ready', name: 'Old machine job' },
      programReadiness: { ready: true, reason: '' },
    }))
    expect(runUserMacro(CONFIRM)).toBe(true)
    const questionId = activeMacroAsk()?.id
    expect(questionId).toBeTypeOf('number')

    await choose(select, MACHINE_B)
    await waitFor(() => expect(controlMachine(useCamStore.getState())).toBe(MACHINE_B))

    expect(session.getMachineController().connectionPhase()).toBe('disconnected')
    expect(useCamStore.getState().control.sessionMachine).toBeNull()
    expect(useMachineControl.getState().job.phase).toBe('empty')
    expect(useMachineControl.getState().programReadiness.ready).toBe(false)
    expect(activeMacroRun()).toBeNull()
    expect(activeMacroAsk()).toBeNull()
    expect(answerMacroAsk(questionId!, true)).toBe(false)
    await act(async () => { await Promise.resolve() })
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .not.toContain('OLD QUESTION RESUMED')
  })

  it('cancels a connecting retry and ignores late old socket and hello callbacks', async () => {
    vi.useFakeTimers()
    const oldConnect = session.connectMachine('bridge')
    const oldSocket = FakeSocket.instances[0]
    oldSocket.fail()
    const select = renderSelector()

    await choose(select, MACHINE_B)
    await vi.advanceTimersByTimeAsync(0)
    await oldConnect

    const sentAfterSwitch = oldSocket.sent.length
    oldSocket.open()
    oldSocket.hello()
    await vi.advanceTimersByTimeAsync(12_000)

    expect(controlMachine(useCamStore.getState())).toBe(MACHINE_B)
    expect(session.getMachineController().connectionPhase()).toBe('disconnected')
    expect(FakeSocket.instances).toHaveLength(1)
    expect(oldSocket.sent).toHaveLength(sentAfterSwitch)
  })

  it('keeps only C when rapid B then C selections share a delayed disconnect', async () => {
    await connectSimulator()
    const select = renderSelector()
    const controller = session.getMachineController()
    const realDisconnect = controller.disconnect.bind(controller)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const disconnect = vi.spyOn(controller, 'disconnect').mockImplementation(async () => {
      await gate
      await realDisconnect()
    })

    fireEvent.change(select, { target: { value: MACHINE_B.id } })
    fireEvent.change(select, { target: { value: MACHINE_C.id } })
    expect(controlMachine(useCamStore.getState()).id).toBe(MACHINE_A.id)
    release()

    await waitFor(() => expect(controlMachine(useCamStore.getState())).toBe(MACHINE_C))
    expect(useCamStore.getState().control.activeMachineId).toBe(MACHINE_C.id)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(session.getMachineController().connectionPhase()).toBe('disconnected')
  })

  it('keeps A when a rapid B then A selection returns to the displayed machine', async () => {
    await connectSimulator()
    const select = renderSelector()
    const controller = session.getMachineController()
    const realDisconnect = controller.disconnect.bind(controller)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const disconnect = vi.spyOn(controller, 'disconnect').mockImplementation(async () => {
      await gate
      await realDisconnect()
    })

    fireEvent.change(select, { target: { value: MACHINE_B.id } })
    fireEvent.change(select, { target: { value: MACHINE_A.id } })
    expect(controlMachine(useCamStore.getState()).id).toBe(MACHINE_A.id)
    release()

    await waitFor(() => expect(session.getMachineController().connectionPhase()).toBe('disconnected'))
    expect(controlMachine(useCamStore.getState()).id).toBe(MACHINE_A.id)
    expect(useCamStore.getState().control.activeMachineId).toBe(MACHINE_A.id)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('treats the displayed selection as a no-op and does not disconnect it', async () => {
    await connectSimulator()
    const controller = session.getMachineController()
    const disconnect = vi.spyOn(controller, 'disconnect')

    await expect(session.selectControlMachine(MACHINE_A.id)).resolves.toBe(true)

    expect(disconnect).not.toHaveBeenCalled()
    expect(session.getMachineController().connectionPhase()).toBe('connected')
    expect(controlMachine(useCamStore.getState()).id).toBe(MACHINE_A.id)
  })

  it('retains truthful selection and connection state when disconnect fails', async () => {
    await connectSimulator()
    const select = renderSelector()
    const controller = session.getMachineController()
    const realDisconnect = controller.disconnect.bind(controller)
    vi.spyOn(controller, 'disconnect').mockRejectedValueOnce(new Error('controller did not acknowledge close'))

    await choose(select, MACHINE_B)
    await waitFor(() => expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toContain('controller did not acknowledge close'))

    expect(controlMachine(useCamStore.getState()).id).toBe(MACHINE_A.id)
    expect(session.getMachineController().connectionPhase()).toBe('connected')
    expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toContain('Control remains on WO-1787 Machine A; connection is connected.')
    vi.mocked(controller.disconnect).mockImplementation(realDisconnect)
  })

  it('disconnects a live bridge before selection and old hello cannot send or create a new session', async () => {
    const oldSocket = await connectBridge()
    const select = renderSelector()

    await choose(select, MACHINE_B)
    await waitFor(() => expect(controlMachine(useCamStore.getState())).toBe(MACHINE_B))
    const sentAfterSwitch = oldSocket.sent.length
    oldSocket.open()
    oldSocket.hello()
    await act(async () => { await Promise.resolve() })

    expect(oldSocket.closeCalls).toBeGreaterThan(0)
    expect(oldSocket.sent).toHaveLength(sentAfterSwitch)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(session.getMachineController().connectionPhase()).toBe('disconnected')
    expect(useCamStore.getState().control.sessionMachine).toBeNull()
  })
})
