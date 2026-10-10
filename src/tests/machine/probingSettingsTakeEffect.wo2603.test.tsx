// @vitest-environment jsdom
//
// WO-2603: real UccncController over a deterministic fake bridge.
//
// Wire assertions below are desk controls, not a live desk-kit readback.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus, MachineVec3 } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

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
const G54 = { x: 0, y: 0, z: 50 }
const PROBE_CONFIG = {
  positioningFeed: 1000,
  fastFeed: 300,
  slowFeed: 50,
  retract: 2,
  maxTravel: 30,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
}

let bridgeEvents: BridgeTransportEvents | null = null
let position: MachineVec3 = { x: 100, y: 100, z: 100 }
const calls: BridgeCallMessage[] = []

function statusFrame(): BridgeMessage {
  const status: MachineStatus = {
    state: 'idle',
    subState: null,
    machinePos: { ...position },
    workPos: { ...position, z: position.z - G54.z },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: { X: true, Y: true, Z: true },
    spindle: null,
  }
  return { t: 'status', v: status } as BridgeMessage
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }
      async start(events: BridgeTransportEvents): Promise<void> {
        bridgeEvents = events
        const offsets = { G54, G55: G54, G56: G54, G57: G54, G58: G54, G59: G54 }
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'wo-2020-fake 0.0',
            capabilities: CAPABILITIES,
            readOnly: false,
            workOffsets: { current: offsets, profile: offsets },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        if (message.m !== 'queryStatus') calls.push(message)
        const answer = (value?: unknown) => bridgeEvents?.onMessage({
          t: 'reply', seq: message.seq, ok: true, v: value,
        } as BridgeMessage)
        if (message.m === 'probe') {
          const args = message.a as { axis: 'X' | 'Y' | 'Z'; targetMm: number }
          position = { ...position, [args.axis.toLowerCase()]: args.targetMm }
          bridgeEvents?.onMessage(statusFrame())
          answer({ ok: false, at: null })
          return
        }
        if (message.m === 'jogToMachineZ') {
          position = { ...position, z: (message.a as { z: number }).z }
          bridgeEvents?.onMessage(statusFrame())
        }
        if (message.m === 'jogToWorkXY') {
          const args = message.a as { x?: number; y?: number }
          position = { ...position, x: args.x ?? position.x, y: args.y ?? position.y }
          bridgeEvents?.onMessage(statusFrame())
        }
        if (message.m === 'queryStatus') {
          answer()
          bridgeEvents?.onMessage(statusFrame())
          return
        }
        answer(true)
      }
      async close(): Promise<void> {
        bridgeEvents?.onClose('closed')
        bridgeEvents = null
      }
    },
  })
})

const { controlMachine, useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runDirectionalProbeTouch,
  setSimulatedPart,
} = await import('../../lib/machine/machineSession')

const { MachineDefinitionPanel } = await import('../../components/machine/MachineDefinitionPanel')
const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { createDefaultControllerDefinition } = await import('../../types')
const { machineProbeOverride, resolveProbeConfig } = await import('../../lib/machine/toolTable')

async function connectBridge(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  bridgeEvents?.onMessage(statusFrame())
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false
  void promise.finally(() => { done = true })
  for (let i = 0; i < 20_000 && !done; i++) await vi.advanceTimersByTimeAsync(50)
  return promise
}

beforeEach(() => {
  vi.useFakeTimers()
  mem.clear()
  position = { x: 100, y: 100, z: 100 }
  calls.length = 0
  useCamStore.getState().setControlSessionMachine(null)
  useCamStore.setState((state) => ({ control: { ...state.control, activeMachineId: null } }))
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc', noHomingSwitches: false,
      homeConvention: { x: { homesToward: 'min', machineZeroAt: 'min' }, y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'max', machineZeroAt: 'min' } },
      probing: PROBE_CONFIG, probeOverrides: undefined, controllerDefinition: createDefaultControllerDefinition(['X', 'Y', 'Z']) } },
  }))
  const machine = useCamStore.getState().project.machine
  useCamStore.setState({ machineLibrary: [machine] })
  useMachineControl.setState({ consoleLines: [], parserModal: null })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

function effectiveConfig() {
  const machine = controlMachine(useCamStore.getState())
  return resolveProbeConfig(machine.probing, machineProbeOverride(machine))
}

describe('WO-2603 saved probing defaults become live', () => {
  it.each(['library', 'project'] as const)('%s save refreshes both snapshots without promoting board settings', (route) => {
    const start = useCamStore.getState().project.machine
    useCamStore.getState().setControlSessionMachine(start)
    const confirmed = structuredClone(start.controllerDefinition!)
    confirmed.homing.perAxis.Z!.backOff = 3
    useCamStore.getState().confirmControlSessionDefinition(start.id, confirmed)
    const next = {
      ...start,
      probing: { ...PROBE_CONFIG, positioningFeed: 1200, fastFeed: 333, slowFeed: 41,
        retract: 3, maxTravel: 40, surfaceClearance: 7, overtravel: 8, crossOverLift: 12, padThickness: 3.16 },
      controller: 'grbl' as const, travel: { x: 900, y: 900, z: 900 },
      controllerDefinition: createDefaultControllerDefinition(['X', 'Y']),
    }
    const save = () => route === 'library'
      ? useCamStore.getState().updateMachineInLibrary(start.id, next)
      : useCamStore.getState().setProjectMachine(next)
    save()
    expect(effectiveConfig()).toEqual(next.probing)
    expect(useCamStore.getState().control.sessionMachine!.probing).toEqual(next.probing)
    expect(useCamStore.getState().control.appliedMachine!.probing).toEqual(next.probing)
    expect(controlMachine(useCamStore.getState()).controller).toBe(start.controller)
    expect(controlMachine(useCamStore.getState()).travel).toEqual(start.travel)
    expect(controlMachine(useCamStore.getState()).controllerDefinition).toEqual(confirmed)
    useCamStore.setState((state) => ({ control: { ...state.control, appliedMachine: null } }))
    expect(effectiveConfig()).toEqual(next.probing)
  })

  it('keeps another machine save and a moved Follow CAM selection out of the connected record', () => {
    const start = useCamStore.getState().project.machine
    useCamStore.getState().setControlSessionMachine(start)
    const other = { ...start, id: 'wo2603-other', probing: { ...PROBE_CONFIG, overtravel: 19 } }
    useCamStore.getState().addMachineToLibrary(other)
    useCamStore.getState().updateMachineInLibrary(other.id, other)
    useCamStore.getState().setProjectMachine(other)
    expect(effectiveConfig().overtravel).toBe(5)
    expect(controlMachine(useCamStore.getState()).id).toBe(start.id)
  })

  it('resets removed defaults and preserves operator overrides', () => {
    const start = useCamStore.getState().project.machine
    useCamStore.getState().setControlSessionMachine({ ...start, probeOverrides: { fastFeed: 612 } })
    useCamStore.getState().updateMachineInLibrary(start.id, { probing: { ...PROBE_CONFIG, fastFeed: 333, overtravel: 8 } })
    expect(effectiveConfig()).toMatchObject({ fastFeed: 612, overtravel: 8 })
    useCamStore.getState().updateMachineInLibrary(start.id, { probing: undefined })
    expect(effectiveConfig()).toMatchObject({ fastFeed: 612, overtravel: 5 })
  })

  it('Definition Save is immediately visible to the connected panel and the next native probe wire call', async () => {
    await connectBridge()
    const generation = useCamStore.getState().control.sessionGeneration
    render(<><MachineDefinitionPanel connectionKind="bridge" /><ToolsProbePanel /></>)
    fireEvent.click(screen.getByTestId('machine-def-tab-probing'))
    const input = screen.getByRole('textbox', { name: 'Search speed (mm/min)' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '333' } })
    fireEvent.blur(input)
    fireEvent.click(screen.getByTestId('machine-def-panel-save'))
    expect(effectiveConfig().fastFeed).toBe(333)
    expect(screen.getByTestId('machine-def-panel-authority-status').getAttribute('data-authority-state')).not.toBe('pending')
    expect(screen.getByTestId('machine-def-panel-authority-status').textContent).not.toMatch(/pending.*reconnect/i)
    calls.length = 0
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-probe-z0'))
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(calls.find((call) => call.m === 'probe')?.a).toMatchObject({ axis: 'Z', feedMmMin: 333 })
    expect(useCamStore.getState().control.sessionGeneration).toBe(generation)
  })

  it.each(['X', 'Y', 'Z'] as const)('%s native miss states the correct physical check', async (axis) => {
    await connectBridge()
    const result = await settle(runDirectionalProbeTouch(axis, '-', effectiveConfig()))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('never made contact')
    expect(result.message).toContain('wiring')
    if (axis === 'Z') expect(result.message).toContain('pad position')
    else {
      expect(result.message).toContain('start position')
      expect(result.message).not.toContain('pad')
    }
    expect(calls.find((call) => call.m === 'probe')?.a).toMatchObject({ axis, targetMm: 70, feedMmMin: 300 })
  })

  it.each(['X', 'Y', 'Z'] as const)('%s text-route miss states the correct physical check', async (axis) => {
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({ ...machine, controller: 'grbl',
      controllerDefinition: undefined, unsentSettings: undefined,
      travel: { x: 400, y: 400, z: 100 }, rapidRate: 60000,
      homeConvention: { x: { homesToward: 'max', machineZeroAt: 'max' },
        y: { homesToward: 'max', machineZeroAt: 'max' }, z: { homesToward: 'max', machineZeroAt: 'max' } },
    })
    const connected = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    __resetEstopInterlockForTest()
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(3000)
    await settle(Promise.resolve(getMachineController().sendCommandAwait('G21 G90 G53 G1 X-200 Y-200 Z-40 F60000')))
    await vi.advanceTimersByTimeAsync(5000)
    // Keep the part outside every seek; null selects the simulator's fixed pad.
    expect(setSimulatedPart({ origin: { x: -390, y: -390 }, sizeX: 20, sizeY: 20,
      topZ: -80, height: 10, bowMm: 0, noiseMm: 0 })).toBe(true)
    const result = await settle(runDirectionalProbeTouch(axis, '-', effectiveConfig()))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('never made contact')
    expect(result.message).toContain('Unlock ($X)')
    if (axis === 'Z') expect(result.message).toContain('pad position')
    else {
      expect(result.message).toContain('start position')
      expect(result.message).not.toContain('pad')
    }
  })

  it('the production Rect boss button seeks 10 -> 13 -> 10 mm after Definition Save with no reconnect', async () => {
    position = { x: 100, y: 100, z: 80 }
    await connectBridge()
    const generation = useCamStore.getState().control.sessionGeneration
    render(<><MachineDefinitionPanel connectionKind="bridge" /><ProbingPanel /></>)
    fireEvent.click(screen.getByTestId('machine-def-tab-probing'))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-rectBoss'))
    fireEvent.change(screen.getByTestId('control-work-probe-top'), { target: { value: 'workZero' } })
    const rows: unknown[] = []
    for (const overtravel of [5, 8, 5]) {
      const input = screen.getByRole('textbox', { name: 'Search overtravel (mm)' })
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: String(overtravel) } })
      fireEvent.blur(input)
      fireEvent.click(screen.getByTestId('machine-def-panel-save'))
      expect(effectiveConfig().overtravel).toBe(overtravel)
      position = { x: 100, y: 100, z: 80 }
      await act(async () => { bridgeEvents?.onMessage(statusFrame()) })
      calls.length = 0
      const button = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement
      expect(button.disabled, button.outerHTML + screen.getByTestId('control-probe-setup-card').textContent).toBe(false)
      await act(async () => {
        fireEvent.click(button)
        await vi.advanceTimersByTimeAsync(5000)
      })
      const side = calls.find((call) => call.m === 'probe' && (call.a as { axis: string }).axis === 'X')
      expect(side).toBeDefined()
      const target = (side!.a as { targetMm: number }).targetMm
      // Rect boss steps out by half width + clearance + tip radius (default 1.5).
      expect(target).toBeCloseTo(100 + 12.5 + 1.5 - overtravel, 4)
      const message = useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
      expect(message).toContain('start position')
      expect(message).not.toContain('pad position')
      expect(useCamStore.getState().control.sessionGeneration).toBe(generation)
      rows.push({ overtravel, target, stoppedAt: { ...position }, calls: [...calls], message })
    }
    writeFileSync('src/tests/evidence/WO-2603/rect-boss-wire.json', JSON.stringify({
      kind: 'Production React buttons -> real UccncController -> fake bridge; not live kit evidence',
      source: Object.fromEntries(['src/store/index.ts', 'src/lib/machine/machineSession.ts'].map((path) =>
        [path, execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim()])),
      rows,
    }, null, 2) + '\n')
  })
})
