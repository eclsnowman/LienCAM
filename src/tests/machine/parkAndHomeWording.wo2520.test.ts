// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeCallMessage, BridgeMessage, BridgeTransportEvents } from '../../lib/machine/bridgeTransport'
import type { ControllerEvents, MachineStatus, MessageChannel } from '../../lib/machine/controller'
import type { AxisName } from '../../types'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size },
  clear: () => memory.clear(), getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => [...memory.keys()][index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, value) },
} satisfies Storage })

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { ControlPage } = await import('../../components/machine/ControlPage')
const { createDefaultControllerDefinition } = await import('../../types')
const session = await import('../../lib/machine/machineSession')
const { deriveOperatorTransport } = await import('../../lib/machine/operatorTransport')
const { registerMachineBackend, backendDefinitionFor } = await import('../../lib/machine/backendRegistry')
const { UccncController } = await import('../../lib/machine/uccncController')
const { SimulatedController } = await import('../../lib/machine/simulatedController')
const HOMED = 'Homed - machine coordinates set.'
const homedLines = () => useMachineControl.getState().consoleLines.filter((line) => line.text === HOMED)
const STATUS: MachineStatus = {
  state: 'idle', subState: null, machinePos: { x: 0, y: 0, z: 0 }, workPos: { x: 0, y: 0, z: 0 },
  feedMmMin: 0, spindleRpm: 0, overrides: null, buffer: null, inputs: null, executingMoveId: null,
  homed: { X: true, Y: true, Z: true }, spindle: null,
}

// Simulated board wire: the real UCCNC controller receives one homed push per
// axis, as the board did in F11. Its old datum is already known on a re-home.
class BoardWire implements MessageChannel {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  async start(events: BridgeTransportEvents) {
    this.events = events
    this.emit({ t: 'hello', v: { protocol: 1, controller: 'uccnc', bridge: 'wo2520-simulated-board',
      capabilities: { geometryQueue: true, executingMoveId: true, bufferSeconds: true,
        gcodeText: false, perAxisHoming: true, ownsSpindle: false, spindleCommands: false }, readOnly: false } })
  }
  send(raw: unknown) {
    const call = raw as BridgeCallMessage
    this.sent.push(call)
    if (call.m !== 'homeAxes') queueMicrotask(() => this.reply(call))
  }
  async close() {}
  emit(message: unknown) { this.events?.onMessage(message as BridgeMessage) }
  reply(call: BridgeCallMessage) { this.emit({ t: 'reply', seq: call.seq, ok: true, v: true }) }
  complete(axis: string) { this.emit({ t: 'status', v: { ...STATUS } }); this.emit({ t: 'homed', v: { axes: [axis] } }) }
}

let restoreBackend: (() => void) | undefined
const evidence: Record<string, unknown> = {}
function record(name: string, data: unknown) {
  evidence[name] = data
  if (process.env.WRITE_EVIDENCE === '1') {
    mkdirSync('src/tests/evidence/WO-2520', { recursive: true })
    writeFileSync('src/tests/evidence/WO-2520/readbacks.json', JSON.stringify(evidence, null, 2) + '\n')
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  useCamStore.setState({ machineDatumRevokedAxes: {} })
  const definition = createDefaultControllerDefinition()
  definition.axes.forEach((axis, index) => {
    axis.stepPin = { port: 1, pin: 2 + index * 3, negate: false }
    axis.dirPin = { port: 1, pin: 3 + index * 3, negate: false }
    axis.homePin = { port: 1, pin: 4 + index * 3, negate: false }
  })
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({ ...machine, controller: 'uccnc', controllerDefinition: definition,
    // WO-2712: these positive park coordinates describe this dedicated
    // 800 mm fixture, not the sample's inherited max/max frame or fresh G54.
    id: 'wo2520-positive-park',
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
    noHomingSwitches: false, travel: { x: 800, y: 800, z: 150 }, rapidRate: 60000 })
  useMachineControl.setState({ homed: false, consoleLines: [], settings: {} })
})
afterEach(async () => {
  cleanup()
  session.cancelGuidedToolChange()
  await session.disconnectMachine()
  restoreBackend?.()
  restoreBackend = undefined
  vi.useRealTimers()
})
async function simulator() {
  await session.connectMachine('simulator')
  session.__resetEstopInterlockForTest()
  await vi.advanceTimersByTimeAsync(1400)
}
async function board() {
  const wire = new BoardWire()
  restoreBackend = registerMachineBackend({ ...backendDefinitionFor('uccnc', 'bridge')!,
    connect: async ({ install }) => {
      const { controller } = install((events) => new UccncController(events))
      await controller.connect({ kind: 'messages', transport: wire })
    } })
  await session.connectMachine('bridge')
  session.__resetEstopInterlockForTest()
  wire.emit({ t: 'status', v: { ...STATUS } })
  render(createElement(ControlPage))
  return wire
}

describe('WO-2520 park and home wording', () => {
  it('aggregates per-axis completions on a non-UCCNC backend through the same interface', async () => {
    let events: ControllerEvents = {}
    class PerAxisController extends SimulatedController {
      homeAxes(_axes: AxisName[]): boolean { return true }
      homedThisSession(): boolean { return true }
    }
    restoreBackend = registerMachineBackend({ ...backendDefinitionFor('uccnc', 'bridge')!,
      connect: async ({ install }) => {
        const { controller } = install((installedEvents) => {
          events = installedEvents
          return new PerAxisController(installedEvents)
        })
        await controller.connect({ kind: 'none' })
      } })
    await session.connectMachine('bridge')
    session.__resetEstopInterlockForTest()
    const ctrl = session.getMachineController()
    expect(ctrl).not.toBeInstanceOf(UccncController)
    expect(ctrl.homeAxes!(['Z', 'X', 'Y'])).toBe(true)
    const counts: number[] = []
    for (const axis of ['Z', 'X', 'Y'] as const) {
      events.onHomed?.([axis])
      counts.push(homedLines().length)
    }
    expect(counts).toEqual([0, 0, 1])
    expect(ctrl.homeAxes!(['Z', 'X', 'Y', 'A'])).toBe(true)
    events.onHomed?.(['Z', 'X', 'Y', 'A'])
    expect(homedLines()).toHaveLength(2)
    record('non-uccnc', { counts, lines: homedLines() })
  })

  for (const label of ['Tool change', 'Fixed tool probe']) {
    it(`names the actual ${label} park in stopping and parking`, async () => {
      await simulator()
      const ctrl = session.getMachineController()
      expect(ctrl.home()).toBe(true)
      await vi.advanceTimersByTimeAsync(2000)
      const snapshots: { step: string; message: string; header: string }[] = []
      const off = useMachineControl.subscribe((state) => {
        if ((state.toolChange?.step === 'stopping' || state.toolChange?.step === 'parking')
          && !snapshots.some((entry) => entry.step === state.toolChange?.step)) {
          snapshots.push({ step: state.toolChange.step, message: state.toolChange.message,
            header: deriveOperatorTransport({ ...state, programHold: { owner: 'tool-change-card' } }).nextAction })
        }
      })
      const park = { id: label, label, x: label === 'Tool change' ? 730 : 20, y: 50, z: 0 }
      const parked = session.beginGuidedToolChange({ tool: 2, resumeLine: 3, park, safeZMachine: 0 })
      await vi.advanceTimersByTimeAsync(8000)
      expect(await parked).toBe(true)
      off()
      record(label, { snapshots, position: ctrl.status().machinePos })
      expect(ctrl.status().machinePos).toMatchObject({ x: park.x, y: park.y, z: park.z })
      for (const step of ['stopping', 'parking']) {
        const snapshot = snapshots.find((entry) => entry.step === step)
        expect(snapshot?.header).toContain(label)
        if (label === 'Tool change') expect(snapshot?.header).not.toContain('probe pad')
      }
    })
  }

  it('Home All on the simulator announces once, after all axes, including a repeat', async () => {
    await simulator()
    render(createElement(ControlPage))
    for (const count of [1, 2]) {
      fireEvent.click(screen.getByTestId('control-home'))
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(homedLines()).toHaveLength(count - 1)
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(homedLines()).toHaveLength(count - 1)
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(homedLines()).toHaveLength(count)
    }
    record('simulator-home-all', { lines: homedLines(), axes: session.getMachineController().homedAxesThisSession?.() })
  })

  it('Home All waits for the last per-axis board readback even when already homed', async () => {
    const wire = await board()
    fireEvent.click(screen.getByTestId('control-home'))
    const call = wire.sent.find((entry) => entry.m === 'homeAxes')!
    expect(call.a).toEqual({ axes: ['Z', 'X', 'Y'] })
    const counts: number[] = []
    for (const axis of ['Z', 'X', 'Y']) {
      act(() => wire.complete(axis))
      counts.push(homedLines().length)
    }
    record('board-home-all', { call, counts, lines: homedLines() })
    expect(counts).toEqual([0, 0, 1])
    wire.reply(call)
  })

  it('still acknowledges a single-axis home without claiming the other axes', async () => {
    await simulator()
    render(createElement(ControlPage))
    fireEvent.click(screen.getByTestId('control-home-z'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    const lines = useMachineControl.getState().consoleLines.filter((line) => line.text.startsWith('Homed'))
    record('single-axis', { lines, homed: useMachineControl.getState().homed,
      axes: session.getMachineController().homedAxesThisSession?.() })
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toContain('Homed Z')
    expect(useMachineControl.getState().homed).toBe(false)
  })

  for (const rotary of ['A', 'B', 'C'] as const) {
    it(`Home All including ${rotary} waits for the board call to settle and releases later homes`, async () => {
      const order: AxisName[] = ['Z', 'X', 'Y', rotary]
      const machine = useCamStore.getState().project.machine!
      const definition = createDefaultControllerDefinition(['X', 'Y', 'Z', rotary])
      definition.axes.forEach((axis, index) => {
        axis.enabled = true
        axis.homePin = { port: 1, pin: 4 + index * 3, negate: false }
      })
      definition.homing.order = order
      useCamStore.getState().updateMachine({ ...machine, controllerDefinition: definition })
      const wire = await board()
      fireEvent.click(screen.getByTestId('control-home'))
      const call = wire.sent.find((entry) => entry.m === 'homeAxes')!
      expect(call.a).toEqual({ axes: order })
      const counts: number[] = []
      for (const axis of ['Z', 'X', 'Y']) {
        act(() => wire.complete(axis))
        counts.push(homedLines().length)
      }
      // The rotary axis has no homed push. Only the successful call reply
      // certifies that the last axis finished, including on a re-home.
      expect(counts).toEqual([0, 0, 0])
      await act(async () => { wire.reply(call) })
      counts.push(homedLines().length)
      expect(counts).toEqual([0, 0, 0, 1])
      wire.emit({ t: 'status', v: { ...STATUS } })
      expect(homedLines()).toHaveLength(1)
      act(() => wire.complete('Z'))
      expect(homedLines()).toHaveLength(2)
      record(`board-home-all-${rotary}`, { call, counts, lines: homedLines() })
    })
  }

  it('does not announce a failed rotary Home All and releases later board homes', async () => {
    const wire = await board()
    expect(session.getMachineController().homeAxes!(['Z', 'X', 'Y', 'A'])).toBe(true)
    const call = wire.sent.find((entry) => entry.m === 'homeAxes')!
    for (const axis of ['Z', 'X', 'Y']) act(() => wire.complete(axis))
    await act(async () => { wire.emit({ t: 'reply', seq: call.seq, ok: false, error: 'Home A failed' }) })
    expect(homedLines()).toHaveLength(0)
    expect(useMachineControl.getState().consoleLines.some((line) => line.text === 'homeAxes: Home A failed')).toBe(true)
    act(() => wire.complete('Z'))
    expect(homedLines()).toHaveLength(1)
  })
})
