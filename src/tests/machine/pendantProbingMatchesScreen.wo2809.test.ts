// @vitest-environment jsdom
//
// WO-2809 (Operator 2026-10-14: "phone pendant must match what's on the machine
// screen. They cannot be drifted at alpha."): for every feature routine the
// phone offers, the motion the phone starts equals the motion the Probing
// screen's Start probing button starts for the same inputs - through both
// production entry points (the rendered ProbingPanel and the pendant command
// executor), over the real UccncController and a deterministic fake bridge.
// The phone's first-step sentence equals the screen's step 1 sentence.
//
// Wire assertions here are desk controls, not a live board readback.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus, MachineVec3 } from '../../lib/machine/controller'
import type { PendantCommand } from '../../lib/machine/pendantBridge'
import { makeTool } from '../post/helpers'
import { typedMock } from '../support/typedMock'
// @ts-expect-error plain .mjs module shared with the phone app
import { firstStepSentence } from '../../../pendant/app/probe-routines.mjs'

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
const START: MachineVec3 = { x: 200, y: 200, z: 70 }

let bridgeEvents: BridgeTransportEvents | null = null
let position: MachineVec3 = { ...START }
/** A routine that touches the top first (Edge, Angle, Boss, Rect boss) finds
 *  the top at TOP_Z straight under its start; every other Z probe is a
 *  descent beside the face or into the hole and finds nothing, as on a part. */
const TOP_Z = 60
let topUnderStart = false
let simulatorRoute = false
/** Fix round 3: a face that is not square - each X/Y contact moves by this
 *  much per mm the probe stands along the face from START, so two touches
 *  along it give a real (non-zero) angle. 0 everywhere else. */
let faceSkew = 0
const calls: Array<{ m: string; a: unknown }> = []

function statusFrame(): BridgeMessage {
  const status: MachineStatus = {
    state: 'idle',
    subState: null,
    machinePos: { ...position },
    workPos: { x: position.x - G54.x, y: position.y - G54.y, z: position.z - G54.z },
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
            bridge: 'wo-2809-fake 0.0',
            capabilities: CAPABILITIES,
            readOnly: false,
            workOffsets: { current: offsets, profile: offsets },
          },
        } as BridgeMessage)
      }
      send(message: BridgeCallMessage): void {
        const answer = (value?: unknown) => bridgeEvents?.onMessage({
          t: 'reply', seq: message.seq, ok: true, v: value,
        } as BridgeMessage)
        if (message.m === 'queryStatus') {
          answer()
          bridgeEvents?.onMessage(statusFrame())
          return
        }
        calls.push({ m: message.m, a: message.a })
        if (message.m === 'probe') {
          // Deterministic contact: halfway along the commanded search. Both
          // routes get the same answer for the same call, so any difference
          // in the recorded wire is a difference in what they commanded.
          const args = message.a as { axis: 'X' | 'Y' | 'Z'; targetMm: number }
          const key = args.axis.toLowerCase() as 'x' | 'y' | 'z'
          if (key === 'z') {
            const overTop = topUnderStart && position.x === START.x && position.y === START.y
              && position.z > TOP_Z && args.targetMm < TOP_Z
            position = { ...position, z: overTop ? TOP_Z : args.targetMm }
            bridgeEvents?.onMessage(statusFrame())
            answer(overTop ? { ok: true, at: { ...position } } : { ok: false, at: null })
            return
          }
          const alongKey = key === 'x' ? 'y' : 'x'
          const skew = faceSkew * (position[alongKey] - START[alongKey])
          position = { ...position, [key]: Number(((position[key] + args.targetMm) / 2 + skew).toFixed(4)) }
          bridgeEvents?.onMessage(statusFrame())
          answer({ ok: true, at: { ...position } })
          return
        }
        if (message.m === 'jogToMachineZ') {
          position = { ...position, z: (message.a as { z: number }).z }
          bridgeEvents?.onMessage(statusFrame())
        }
        if (message.m === 'jogToMachineXY') {
          const args = message.a as { x?: number; y?: number }
          position = { ...position, x: args.x ?? position.x, y: args.y ?? position.y }
          bridgeEvents?.onMessage(statusFrame())
        }
        if (message.m === 'jogToWorkXY') {
          const args = message.a as { x?: number; y?: number }
          position = { ...position, x: (args.x ?? position.x - G54.x) + G54.x, y: (args.y ?? position.y - G54.y) + G54.y }
          bridgeEvents?.onMessage(statusFrame())
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

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  setSimulatedPart,
} = await import('../../lib/machine/machineSession')
const { executePendantMachineCommand } = await import('../../lib/machine/pendantMachine')
const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { createDefaultControllerDefinition } = await import('../../types')

/** The phone's routines and the Probing screen tile each one runs. */
const ROUTINES = [
  { phone: 'edge', screen: 'edge', top: true },
  { phone: 'angle', screen: 'angle', top: true },
  { phone: 'corner', screen: 'insideCorner', top: false },
  { phone: 'bore', screen: 'bore', top: false },
  { phone: 'rectPocket', screen: 'rectPocket', top: false },
  { phone: 'boss', screen: 'boss', top: true },
  { phone: 'rectBoss', screen: 'rectBoss', top: true },
] as const

/** The phone's inputs equal to the screen's own defaults (no active tool:
 *  tip radius 1.5; sizes 25; Edge X+, Angle along X probing +). */
const PHONE_PARAMS = {
  probeFeed: 80,
  searchTravel: 20,
  tipRadius: 1.5,
  nominalSize: 25,
  edgeAxis: 'X' as const,
  edgeDirection: '+' as const,
  pathClearConfirmed: true,
}

async function connectBridge(): Promise<void> {
  if (simulatorRoute) {
    useCamStore.setState((s) => ({ project: { ...s.project, machine: { ...s.project.machine, controller: 'grbl', controllerDefinition: undefined, homeConvention: { x: { homesToward: 'max', machineZeroAt: 'max' }, y: { homesToward: 'max', machineZeroAt: 'max' }, z: { homesToward: 'max', machineZeroAt: 'max' } } } } }))
    useCamStore.setState({ machineLibrary: [useCamStore.getState().project.machine] })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    const ctrl = getMachineController()
    ctrl.home()
    await vi.advanceTimersByTimeAsync(3000)
    await settle(ctrl.sendCommandAwait('G21 G90 G10 L2 P1 X0 Y0 Z-40'))
    const send = ctrl.sendCommandAwait.bind(ctrl)
    vi.spyOn(ctrl, 'sendCommandAwait').mockImplementation((line, ...args) => {
      calls.push({ m: 'text', a: line })
      return send(line, ...args)
    })
    return
  }
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  bridgeEvents?.onMessage(statusFrame())
}

async function settle<T>(value: T | Promise<T>): Promise<T> {
  const promise = Promise.resolve(value)
  let done = false
  void promise.finally(() => { done = true })
  for (let i = 0; i < 20_000 && !done; i++) await vi.advanceTimersByTimeAsync(50)
  return promise
}

async function standAtStart(touchesTop: boolean): Promise<void> {
  if (simulatorRoute) {
    await act(async () => {
      const ctrl = getMachineController()
      const ack = await settle(ctrl.sendCommandAwait('G21 G90 G53 G0 X-200 Y-200 Z-20'))
      expect(ack?.ok, JSON.stringify(ack)).toBe(true)
      for (let i = 0; i < 2000 && !ctrl.verifiedIdle(); i++) {
        ctrl.queryStatus()
        await vi.advanceTimersByTimeAsync(50)
      }
      ctrl.queryStatus()
      await vi.advanceTimersByTimeAsync(100)
    })
    calls.length = 0
    return
  }
  position = { ...START }
  topUnderStart = touchesTop
  await act(async () => { bridgeEvents?.onMessage(statusFrame()) })
  calls.length = 0
}

beforeEach(() => {
  vi.useFakeTimers()
  mem.clear()
  __resetProbingSessionForTest()
  calls.length = 0
  position = { ...START }
  faceSkew = 0
  useCamStore.getState().setControlSessionMachine(null)
  useCamStore.setState((state) => ({ control: { ...state.control, activeMachineId: null } }))
  useCamStore.getState().newProject()
  useCamStore.setState((state) => ({
    project: {
      ...state.project,
      machine: {
        ...state.project.machine,
        controller: 'uccnc',
        noHomingSwitches: false,
        travel: { x: 600, y: 600, z: 150 },
        homeConvention: {
          x: { homesToward: 'min', machineZeroAt: 'min' },
          y: { homesToward: 'min', machineZeroAt: 'min' },
          z: { homesToward: 'max', machineZeroAt: 'min' },
        },
        probeOverrides: undefined,
        controllerDefinition: createDefaultControllerDefinition(['X', 'Y', 'Z']),
      },
    },
  }))
  const machine = useCamStore.getState().project.machine
  useCamStore.setState({ machineLibrary: [machine] })
  useMachineControl.setState({ consoleLines: [], parserModal: null, activeTool: null })
  useCamStore.setState({ toolLibrary: [] })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WO-2809 the phone pendant probes exactly as the machine screen does', () => {
  for (const route of ['native', 'simulator'] as const) {
  for (const edited of [false, true]) {
  for (const inherit of edited ? [true, false] : [false]) {
  it.each(ROUTINES)(`${route} ${edited ? (inherit ? 'edited inherited' : 'edited explicit') : 'default'} $phone: the phone starts the same motion as the Probing screen ($screen)`, async ({ phone, screen: tile, top }) => {
    simulatorRoute = route === 'simulator'
    await connectBridge()

    if (edited && inherit) {
      useCamStore.setState({ toolLibrary: [makeTool({ id: 'probe19', toolNumber: 19, name: 'Calibrated probe', type: 'probe', diameter: 2, probeEffectiveRadiusX: 0.987, probeEffectiveRadiusY: 1.012 })] })
      useMachineControl.setState({ activeTool: 19 })
    }
    if (simulatorRoute) {
      const boss = phone === 'boss' || phone === 'rectBoss'
      const inside = phone === 'bore' || phone === 'rectPocket' || phone === 'corner'
      expect(setSimulatedPart({
        origin: { x: -206, y: -206 }, sizeX: 100, sizeY: 100,
        topZ: boss ? (edited ? -60 : -50) : inside ? -40 : -30, height: 30,
        bowMm: 0, noiseMm: 0,
        boss: boss ? { cx: -200, cy: -200, diameter: 25, height: 20 } : null,
        bore: inside ? { cx: phone === 'corner' ? -190 : -200, cy: phone === 'corner' ? -190 : -200, diameter: phone === 'corner' ? 40 : 25, depth: 15 } : null,
      })).toBe(true)
    }
    // The machine screen: pick the routine, read step 1, press Start probing.
    render(createElement(ProbingPanel))
    await standAtStart(top)
    fireEvent.click(screen.getByTestId(`control-work-probe-routine-${tile}`))
    const type = (testId: string, value: string) => {
      const el = screen.getByTestId(testId)
      const input = el instanceof HTMLInputElement ? el : el.querySelector('input')!
      fireEvent.change(input, { target: { value } })
      fireEvent.blur(input)
    }
    if (edited) {
      type('control-work-probe-depth', '2')
      type('control-work-probe-face-distance', '3')
      if (phone === 'edge' || phone === 'angle') type('control-work-probe-start-within', '6')
      if (top) type('control-work-probe-top-search', '12')
      if (phone === 'boss' || phone === 'rectBoss') {
        fireEvent.change(screen.getByTestId('control-work-probe-top'), { target: { value: 'workZero' } })
        // A center hole: a downward top touch here would hit nothing.
        await standAtStart(false)
      }
      if (inherit && (phone === 'rectBoss' || phone === 'rectPocket')) {
        type('control-work-probe-nominal-x', simulatorRoute && phone === 'rectBoss' ? '28' : '32')
        type('control-work-probe-nominal-y', simulatorRoute && phone === 'rectBoss' ? '26' : '18')
      }
      if (inherit && phone === 'angle') type('control-work-probe-angle-spacing', '18')
    }
    const screenSentence = screen.getByTestId('probing-step-sentence').firstChild?.textContent ?? ''
    const run = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement
    expect(run.disabled, `${run.getAttribute('data-tooltip')} ${JSON.stringify(useMachineControl.getState().mpos)} ${JSON.stringify(useMachineControl.getState().homed)}`).toBe(false)
    await act(async () => {
      fireEvent.click(run)
      await vi.advanceTimersByTimeAsync(simulatorRoute ? 180_000 : 20_000)
    })
    const screenCalls = calls.map((call) => ({ ...call }))
    const screenEnd = { ...(simulatorRoute ? useMachineControl.getState().mpos! : position) }
    cleanup()

    // The phone: the same routine and inputs through the pendant executor.
    await standAtStart(top && !(edited && (phone === 'boss' || phone === 'rectBoss')))
    // The simulator refreshes its factory parser T0 after the desktop run.
    // Restore the SAME loaded probe input before the second entry point.
    if (edited && inherit) useMachineControl.setState({ activeTool: 19 })
    const emit = vi.fn()
    const command: PendantCommand = { kind: 'probe-start', routineId: phone, params: inherit ? { ...PHONE_PARAMS, nominalSize: -1, tipRadius: -1 } : PHONE_PARAMS }
    const preview = await executePendantMachineCommand({ ...command, params: { ...command.params, pathClearConfirmed: false } }, { clientId: 'preview', emit })
    expect(calls).toEqual([])
    if (!simulatorRoute) writeFileSync(`src/tests/evidence/WO-2809/setup-${phone}-${edited ? inherit ? 'edited' : 'explicit' : 'default'}.json`, JSON.stringify({ routine: phone, params: command.params, setup: preview.data, screenSentence }, null, 2) + '\n')
    const outcome = await settle(Promise.resolve(executePendantMachineCommand(command, { clientId: 'phone-wo2809', emit })))
    const phoneCalls = calls.map((call) => ({ ...call }))

    expect(screenCalls.some((call) => call.m === 'probe' || call.m === 'text' && String(call.a).includes('G38.2'))).toBe(true)
    expect(phoneCalls).toEqual(screenCalls)
    expect(simulatorRoute ? useMachineControl.getState().mpos : position).toEqual(screenEnd)
    expect(outcome.error ?? '').toBe('')
    expect(outcome.ok).toBe(true)

    // The phone's first step says what the screen's first step says.
    expect(screenSentence.length).toBeGreaterThan(0)
    expect(firstStepSentence(phone, { ...(preview.data as object ?? {}), edgeAxis: 'X', edgeDirection: '+', wcs: 'G54' })).toBe(screenSentence)
  }, 60_000)
  }
  }
  }
})

// WO-2809 fix round 2 (astra audit 2026-10-14): a request refused before any
// probe cycle starts must not discard this phone's previous successful
// measurement - Apply zero still writes it, as on main before the extraction.
describe('WO-2809 a refused probe start keeps the previous measurement', () => {
  const Z_SURFACE: PendantCommand = {
    kind: 'probe-start', routineId: 'zSurface', params: { ...PHONE_PARAMS, searchTravel: 20 },
  }
  const ctx = (emit = vi.fn()) => ({ clientId: 'phone-retention', emit })

  async function measureTop(): Promise<void> {
    simulatorRoute = false
    await connectBridge()
    await standAtStart(true)
    const measured = await settle(Promise.resolve(executePendantMachineCommand(Z_SURFACE, ctx())))
    expect(measured.error ?? '').toBe('')
    expect(measured).toEqual({ ok: true, data: { surfaceZ: TOP_Z } })
    expect(calls.some((call) => call.m === 'probe')).toBe(true)
    calls.length = 0
  }

  async function applyWritesMeasuredTop(): Promise<void> {
    const applied = await settle(Promise.resolve(executePendantMachineCommand({ kind: 'apply-probe-zero' }, ctx())))
    expect(applied).toEqual({ ok: true })
    expect(calls.some((call) => call.m === 'probe' || call.m.startsWith('jog'))).toBe(false)
    expect(JSON.stringify(calls)).toContain(String(TOP_Z))
  }

  it.each([
    ['search travel not beyond the retract', { searchTravel: 1 }],
    ['non-finite search travel', { searchTravel: Number.NaN }],
    ['zero probe feed', { probeFeed: 0 }],
    ['negative probe feed', { probeFeed: -5 }],
  ])('Z surface refused for %s: no motion, Apply zero still writes the measured top', async (_label, params) => {
    await measureTop()
    const refused = await executePendantMachineCommand({ ...Z_SURFACE, params: { ...Z_SURFACE.params, ...params } }, ctx())
    expect(refused.ok).toBe(false)
    expect(calls).toEqual([])
    await applyWritesMeasuredTop()
  }, 60_000)

  it('an unconfirmed Z surface or feature request with a live position refuses for confirmation, moves nothing and keeps the measurement', async () => {
    await measureTop()
    expect(useMachineControl.getState().mpos).not.toBeNull()
    for (const routineId of ['zSurface', 'bore'] as const) {
      const refused = await executePendantMachineCommand({ kind: 'probe-start', routineId, params: { ...PHONE_PARAMS, pathClearConfirmed: false } }, ctx())
      expect(refused.ok).toBe(false)
      expect(refused.error).toContain('Confirm that the probe and positioning path are clear')
    }
    expect(calls).toEqual([])
    await applyWritesMeasuredTop()
  }, 60_000)

  it('a feature start the planner refuses moves nothing and keeps the measurement', async () => {
    await measureTop()
    const refused = await executePendantMachineCommand({ kind: 'probe-start', routineId: 'bore', params: { ...PHONE_PARAMS, nominalSize: 0 } }, ctx())
    expect(refused, JSON.stringify(refused)).toEqual({ ok: false, error: 'Nominal X and Y feature sizes must be greater than zero.' })
    expect(calls).toEqual([])
    await applyWritesMeasuredTop()
  }, 60_000)
})

// WO-2809 fix round 3 (architect 2026-10-14 3:46 PM CT): the phone carries the
// screen's Angle along direction and inside-corner directions, so its result
// must read the same as the screen's. With Point 2 on the minus side the
// screen measures the line forwards (ProbingPanel angleMeasurement); the phone
// took the touches in plan order and read ~180 deg off.
describe('WO-2809 the phone measures the same result as the Probing screen', () => {
  const numbers = (text: string) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)

  it.each([
    { phone: 'angle', tile: 'angle', select: ['control-work-probe-angle-along-direction', '-'] },
    { phone: 'angle', tile: 'angle', select: ['control-work-probe-angle-along-direction', '+'] },
    { phone: 'corner', tile: 'insideCorner', select: ['control-work-probe-corner', '++'] },
  ] as const)('native $phone with $select.1: the phone result equals the screen result', async ({ phone, tile, select }) => {
    simulatorRoute = false
    await connectBridge()
    faceSkew = 0.01
    render(createElement(ProbingPanel))
    const top = phone === 'angle'
    await standAtStart(top)
    fireEvent.click(screen.getByTestId(`control-work-probe-routine-${tile}`))
    fireEvent.change(screen.getByTestId(select[0]), { target: { value: select[1] } })
    const run = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement
    expect(run.disabled, run.getAttribute('data-tooltip') ?? '').toBe(false)
    await act(async () => {
      fireEvent.click(run)
      await vi.advanceTimersByTimeAsync(20_000)
    })
    const screenCalls = calls.map((call) => ({ ...call }))
    const screenText = phone === 'angle'
      ? screen.getByTestId('control-work-probe-angle-measured').textContent ?? ''
      : screen.getByTestId('control-work-probe-result').querySelector('span')?.textContent ?? ''
    cleanup()

    await standAtStart(top)
    const outcome = await settle(Promise.resolve(executePendantMachineCommand(
      { kind: 'probe-start', routineId: phone, params: PHONE_PARAMS },
      { clientId: 'phone-wo2809-result', emit: vi.fn() },
    )))
    expect(outcome.error ?? '').toBe('')
    expect(calls).toEqual(screenCalls)
    const result = outcome.data as Record<string, number>
    if (phone === 'angle') {
      // The screen: "Measured <deg> deg from nominal X ...".
      const screenDeg = numbers(screenText)[0]
      expect(Math.abs(screenDeg), screenText).toBeGreaterThan(0.1)
      expect(Math.abs(screenDeg), screenText).toBeLessThan(5)
      expect(result.thetaDeg, `${screenText} / phone ${result.thetaDeg}`).toBeCloseTo(screenDeg, 2)
    } else {
      // The screen: the corner at X <x> Y <y>.
      const [x, y] = numbers(screenText)
      expect(result.centerX, screenText).toBeCloseTo(x, 2)
      expect(result.centerY, screenText).toBeCloseTo(y, 2)
    }
  }, 60_000)
})
