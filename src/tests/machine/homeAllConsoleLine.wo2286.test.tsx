// @vitest-environment jsdom
// Real ControlPage -> real machineSession -> real controllers. Only hardware
// transports are fake; the simulator's homing completes on its own clock.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControllerEvents, MachineStatus, MessageChannel } from '../../lib/machine/controller'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { TransportEvents } from '../../lib/machine/types'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, value) },
  } satisfies Storage,
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { createDefaultControllerDefinition } = await import('../../types')
const session = await import('../../lib/machine/machineSession')
const { registerMachineBackend, backendDefinitionFor } = await import('../../lib/machine/backendRegistry')
const { GrblController } = await import('../../lib/machine/grbl/controller')
const { UccncController } = await import('../../lib/machine/uccncController')
const { LinuxCncController } = await import('../../lib/machine/linuxcnc/linuxcncController')

const HOMED = 'Homed - machine coordinates set.'
const ADVICE = 'Not homed yet - machine coordinates unknown. Press Home All, or type a machine coordinate to set it.'
const homedLines = () => useMachineControl.getState().consoleLines.filter((line) => line.text === HOMED)
const BASE_STATUS: MachineStatus = {
  state: 'idle', subState: null, machinePos: { x: 0, y: 0, z: 0 }, workPos: { x: 0, y: 0, z: 0 },
  feedMmMin: 0, spindleRpm: 0, overrides: null, executingMoveId: null, buffer: null,
  inputs: null, homed: { X: false, Y: false, Z: false }, spindle: null,
}
const CAPS = {
  geometryQueue: true, executingMoveId: true, bufferSeconds: true, gcodeText: false,
  perAxisHoming: true, ownsSpindle: false, spindleCommands: false,
}

class FakeMessages implements MessageChannel {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  constructor(privateController: 'uccnc' | 'linuxcnc') { this.controller = privateController }
  controller: 'uccnc' | 'linuxcnc'
  async start(events: BridgeTransportEvents) {
    this.events = events
    this.emit({ t: 'hello', v: {
      protocol: 1, bridge: 'wo2286-fake-wire', controller: this.controller,
      capabilities: CAPS, readOnly: false,
    } })
  }
  send(raw: unknown) {
    const message = raw as BridgeCallMessage
    this.sent.push(message)
    // Reply asynchronously: LinuxCNC registers the waiter after writing.
    queueMicrotask(() => this.emit({ t: 'reply', seq: message.seq, ok: true, v: true }))
  }
  async close() {}
  emit(message: unknown) { this.events?.onMessage(message as BridgeMessage) }
  status(homed: MachineStatus['homed']) { this.emit({ t: 'status', v: { ...BASE_STATUS, homed } }) }
  complete(axes: string[]) {
    // LinuxCNC's homed event clears revocations; its status is the datum authority.
    this.status({ X: axes.includes('X'), Y: axes.includes('Y'), Z: axes.includes('Z') })
    this.emit({ t: 'homed', v: { axes } })
  }
}

class FakeBytes {
  events: TransportEvents | null = null
  sent: string[] = []
  async start(events: TransportEvents) { this.events = events }
  async write(data: Uint8Array) {
    const text = new TextDecoder().decode(data)
    this.sent.push(text)
    if (text.endsWith('\n') && text !== '$H\n') queueMicrotask(() => this.feed('ok\r\n'))
  }
  async close() {}
  feed(text: string) { this.events?.onChunk(new TextEncoder().encode(text)) }
}

let restoreBackend: (() => void) | undefined
beforeEach(() => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  useCamStore.setState({ machineDatumRevokedAxes: {} })
  const machine = useCamStore.getState().project.machine!
  const definition = createDefaultControllerDefinition()
  definition.axes.forEach((axis, index) => {
    axis.stepPin = { port: 1, pin: 2 + index * 3, negate: false }
    axis.dirPin = { port: 1, pin: 3 + index * 3, negate: false }
    axis.homePin = { port: 1, pin: 4 + index * 3, negate: false }
  })
  useCamStore.getState().updateMachine({ ...machine, controller: 'uccnc', noHomingSwitches: false, controllerDefinition: definition })
  useMachineControl.setState({ homed: false, consoleLines: [], settings: {} })
})
afterEach(async () => {
  cleanup()
  await session.disconnectMachine()
  restoreBackend?.()
  restoreBackend = undefined
  vi.useRealTimers()
})

async function connectSimulator() {
  await session.connectMachine('simulator')
  session.__resetEstopInterlockForTest()
  await vi.advanceTimersByTimeAsync(1400)
  return render(<ControlPage />)
}

function expectCompletion(view: ReturnType<typeof render>) {
  expect(useMachineControl.getState().homed).toBe(true)
  expect(homedLines()).toHaveLength(1)
  expect(homedLines()[0]).toMatchObject({ dir: 'rx', severity: 'info' })
  const homingLines = useMachineControl.getState().consoleLines.filter((line) => line.text === ADVICE || line.text === HOMED)
  expect(homingLines.at(-1)?.text).toBe(HOMED)
  for (let index = 0; index < 5; index++) view.rerender(<ControlPage />)
  expect(homedLines()).toHaveLength(1)
  const toggle = screen.getByTestId('control-console-toggle')
  if (toggle.getAttribute('aria-label')?.includes('Expand')) fireEvent.click(toggle)
  expect(screen.getByTestId('control-console').textContent).toContain(HOMED)
}

async function connectMessages(controller: 'uccnc' | 'linuxcnc') {
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({ ...machine, controller })
  const kind = controller === 'uccnc' ? 'bridge' : 'gateway'
  const wire = new FakeMessages(controller)
  restoreBackend = registerMachineBackend({
    ...backendDefinitionFor(controller, kind)!,
    connect: async ({ install }) => {
      const { controller: ctrl } = install((events) => controller === 'uccnc'
        ? new UccncController(events) : new LinuxCncController(events))
      await ctrl.connect({ kind: 'messages', transport: wire })
    },
  })
  await session.connectMachine(kind)
  session.__resetEstopInterlockForTest()
  wire.status(BASE_STATUS.homed)
  return { wire, view: render(<ControlPage />) }
}

describe('WO-2286 Home All completion in the Control console', () => {
  it('keeps typed datum acknowledgement distinct and reports a later axis home', async () => {
    const view = await connectSimulator()
    const input = screen.getByTestId('control-dro-machine-x') as HTMLInputElement
    expect(input.value).toBe('---')
    fireEvent.change(input, { target: { value: '123.456' } })
    fireEvent.blur(input)
    expect(session.getMachineController().status().machinePos?.x).toBe(123.456)
    expect(useMachineControl.getState().homed).toBe(true)
    expect(homedLines()).toHaveLength(0)
    expect(useMachineControl.getState().consoleLines.filter((line) => (
      line.text === 'Set X machine position to 123.46 mm.'
    ))).toHaveLength(1)

    fireEvent.click(screen.getByTestId('control-home-z'))
    expect(homedLines()).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expectCompletion(view)
  })

  it('reports exactly once after the built-in simulator homes, including a second Home All', async () => {
    const view = await connectSimulator()
    expect(useMachineControl.getState().consoleLines.some((line) => line.text === ADVICE)).toBe(true)
    fireEvent.click(screen.getByTestId('control-home'))
    expect(homedLines()).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expectCompletion(view)
    fireEvent.click(screen.getByTestId('control-home'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(homedLines()).toHaveLength(2)
  })

  it('keeps Z-only homing honest on the simulator', async () => {
    await connectSimulator()
    fireEvent.click(screen.getByTestId('control-home-z'))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({ Z: true })
    expect(useMachineControl.getState().homed).toBe(false)
    expect(homedLines()).toHaveLength(0)
    expect(useMachineControl.getState().consoleLines.some((line) => line.text === 'Homing Z.')).toBe(true)
  })

  for (const controller of ['uccnc', 'linuxcnc'] as const) {
    it(`reports ${controller} completion even when the homed status precedes the event`, async () => {
      const { wire, view } = await connectMessages(controller)
      fireEvent.click(screen.getByTestId('control-home'))
      expect(wire.sent.find((call) => call.m === 'homeAxes')?.a).toEqual({ axes: ['Z', 'X', 'Y'] })
      expect(homedLines()).toHaveLength(0)
      act(() => wire.complete(['Z', 'X', 'Y']))
      expectCompletion(view)
      act(() => { for (let i = 0; i < 20; i++) wire.status({ X: true, Y: true, Z: true }) })
      expect(homedLines()).toHaveLength(1)
    })

    it(`does not claim the whole ${controller} machine homed after Z alone`, async () => {
      const { wire } = await connectMessages(controller)
      fireEvent.click(screen.getByTestId('control-home-z'))
      act(() => wire.complete(['Z']))
      expect(useMachineControl.getState().homed).toBe(false)
      expect(homedLines()).toHaveLength(0)
    })
  }

  it('reports GRBL $H completion once and ignores subsequent status reports', async () => {
    const machine = useCamStore.getState().project.machine!
    useCamStore.getState().updateMachine({ ...machine, controller: 'grbl' })
    const wire = new FakeBytes()
    restoreBackend = registerMachineBackend({
      ...backendDefinitionFor('grbl', 'serial')!,
      connect: async ({ install }) => {
        const { controller: ctrl } = install((events: ControllerEvents) => {
          const grbl = new GrblController({
            ...events,
            onStatus: () => events.onStatus?.(grbl.status()),
          })
          return grbl
        })
        const pending = ctrl.connect({ kind: 'bytes', transport: wire })
        await vi.advanceTimersByTimeAsync(0)
        wire.feed("Grbl 1.1h ['$' for help]\r\n")
        await pending
      },
    })
    await session.connectMachine('serial')
    session.__resetEstopInterlockForTest()
    await vi.advanceTimersByTimeAsync(0)
    wire.feed('<Idle|MPos:0,0,0|WCO:0,0,0>\r\n')
    const view = render(<ControlPage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    fireEvent.click(screen.getByTestId('control-home'))
    expect(wire.sent).toContain('$H\n')
    expect(homedLines()).toHaveLength(0)
    act(() => wire.feed('ok\r\n'))
    expectCompletion(view)
    act(() => { for (let i = 0; i < 20; i++) wire.feed('<Idle|MPos:0,0,0|WCO:0,0,0>\r\n') })
    expect(homedLines()).toHaveLength(1)
  })
})
