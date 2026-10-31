// @vitest-environment jsdom
//
// WO-1017: on a switchless machine, a semantic work-coordinate goto needs a
// work zero established in this connection session. The operator can still
// jog to that location, the existing zero control grants only the axes it
// actually set, and a persisted numeric offset never substitutes for the act.

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    setMachinePreviewCoordinateFrame = vi.fn()
    renderToolpath = vi.fn()
    setToolMarkerPosition = vi.fn()
    dispose = vi.fn()
    setStockVisible = vi.fn()
    setWorkpieceVisible = vi.fn()
    setMachineVisible = vi.fn()
    showToolMarker = vi.fn()
    setActiveToolpathSegment = vi.fn()
    fitToolpath = vi.fn()
  },
}))

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

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runZProbeCycle,
  sendMdiLine,
  setSimulatedPart,
  setWorkOffsetValue,
  zeroWorkAxes,
} = await import('../../lib/machine/machineSession')
const {
  createDefaultAxisDefinition,
  createDefaultControllerDefinition,
} = await import('../../types')
type ControllerDefinition = import('../../types').ControllerDefinition

function switchlessDefinition(): ControllerDefinition {
  const definition = createDefaultControllerDefinition()
  definition.axes.forEach((axis, index) => {
    axis.stepPin = { port: 1, pin: 2 + index * 2, negate: false }
    axis.dirPin = { port: 1, pin: 3 + index * 2, negate: false }
  })
  // Keep the compatibility predicate under end-to-end test: a locally-created
  // empty-provenance definition is switchless based only on relevant axes, so
  // an assigned home pin on a disabled spare A axis must not change the mode.
  const spare = createDefaultAxisDefinition('A')
  spare.homePin = { port: 2, pin: 9, negate: false }
  definition.axes.push(spare)
  return definition
}

function switchedDefinition(): ControllerDefinition {
  const definition = switchlessDefinition()
  definition.axes.forEach((axis, index) => {
    axis.homePin = { port: 2, pin: 1 + index, negate: false }
  })
  return definition
}

function setupMachine(definition: ControllerDefinition): void {
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({ ...machine, controllerDefinition: definition })
}

function workDro(axis: 'x' | 'y' | 'z'): HTMLInputElement {
  return screen.getByTestId(`control-dro-work-${axis}`) as HTMLInputElement
}

function consoleErrors(): string[] {
  return useMachineControl.getState().consoleLines
    .filter((line) => line.severity === 'error')
    .map((line) => line.text)
}

async function connect(definition: ControllerDefinition): Promise<void> {
  vi.useFakeTimers()
  useCamStore.getState().newProject()
  setupMachine(definition)
  useUiPrefs.setState({ machineGotoSkipConfirm: true })
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  await vi.advanceTimersByTimeAsync(1400)
  act(() => { __resetEstopInterlockForTest() })
  // WO-3189 seeds the setup's stock box at every simulator connect; these
  // tests probe the machine's flat pad, so they say no part is placed (a
  // placed part replaces the pad by design, WO-416).
  setSimulatedPart(null)
}

async function settle(ms = 2000): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function attemptWorkGoto(axis: 'x' | 'y' | 'z', target: number): void {
  fireEvent.change(workDro(axis), { target: { value: target.toFixed(3) } })
  fireEvent.blur(workDro(axis))
}

afterEach(async () => {
  cleanup()
  act(() => { getMachineController().emergencyStop() })
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  vi.useRealTimers()
  useUiPrefs.setState({ machineGotoSkipConfirm: false })
})

it('refuses a fresh switchless work goto despite a numeric offset, then allows it after the existing zero control is used', async () => {
  await connect(switchlessDefinition())
  render(<ControlPage />)
  await settle(1400)

  // WO-2712: jog and permitted work moves go inward on the sample's
  // X -406..0 travel; initial X-5 cannot take the old +12/+10 mm steps.
  // A plain jog remains the operator's way to reach the intended zero point.
  const ctrl = getMachineController()
  const beforeJog = useMachineControl.getState().wpos!
  expect(ctrl.jog('X', -12, 600)).toBe(true)
  await settle()
  expect(useMachineControl.getState().wpos!.x).toBeCloseTo(beforeJog.x - 12, 2)

  // Model a persisted G54 value already present on fresh load. The refusal is
  // about whether zero was set this session, never whether this number is 0.
  act(() => {
    useMachineControl.setState({
      offsets: { ...useMachineControl.getState().offsets, G54: [37, -8, 4] },
    })
  })
  const beforeRefused = useMachineControl.getState().wpos!
  const errorsBefore = consoleErrors()
  attemptWorkGoto('x', beforeRefused.x + 10)

  expect(consoleErrors().slice(errorsBefore.length)).toEqual([
    'Goto X work: refused - set the G54 work zero for X here first.',
  ])
  expect(useMachineControl.getState().wpos).toEqual(beforeRefused)

  // X alone does not grant the existing two-axis goto: every moved axis needs
  // its own successful zero in this session.
  fireEvent.click(screen.getByTestId('control-zero-x'))
  act(() => { ctrl.queryStatus() })
  await settle(200)
  const xyErrorsBefore = consoleErrors()
  fireEvent.click(screen.getByTestId('control-goto-xy0'))
  expect(consoleErrors().slice(xyErrorsBefore.length)).toEqual([
    'Goto work XY zero: refused - set the G54 work zero for Y here first.',
  ])

  const beforeAllowed = useMachineControl.getState().wpos!
  attemptWorkGoto('x', beforeAllowed.x - 10)
  await settle()

  expect(consoleErrors()).toHaveLength(xyErrorsBefore.length + 1)
  expect(useMachineControl.getState().wpos!.x).toBeCloseTo(beforeAllowed.x - 10, 2)
})

it('does not carry a successful zero stamp into a replacement connection session', async () => {
  await connect(switchlessDefinition())
  render(<ControlPage />)
  await settle(1400)
  expect(zeroWorkAxes(['X']).ok).toBe(true)

  let pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  await vi.advanceTimersByTimeAsync(1400)
  act(() => {
    __resetEstopInterlockForTest()
    useMachineControl.setState({
      offsets: { ...useMachineControl.getState().offsets, G54: [37, -8, 4] },
    })
  })

  const before = useMachineControl.getState().wpos!
  const errorsBefore = consoleErrors()
  attemptWorkGoto('x', before.x - 10)

  expect(consoleErrors().slice(errorsBefore.length)).toEqual([
    'Goto X work: refused - set the G54 work zero for X here first.',
  ])
  expect(useMachineControl.getState().wpos).toEqual(before)
})

it('does not carry a G54 zero grant into G55', async () => {
  await connect(switchlessDefinition())
  render(<ControlPage />)
  await settle(1400)
  expect(useMachineControl.getState().activeWcs).toBe('G54')
  expect(zeroWorkAxes(['X']).ok).toBe(true)

  expect(sendMdiLine('G55')).toBe(true)
  await settle()
  expect(useMachineControl.getState().activeWcs).toBe('G55')

  const before = useMachineControl.getState().wpos!
  const errorsBefore = consoleErrors()
  attemptWorkGoto('x', before.x - 10)

  expect(consoleErrors().slice(errorsBefore.length)).toEqual([
    'Goto X work: refused - set the G55 work zero for X here first.',
  ])
  expect(useMachineControl.getState().wpos).toEqual(before)
})

// WO-2712: the permitted G55 move also goes inward within stated travel.
it('grants only G55 when its offset is set while G54 is active', async () => {
  await connect(switchlessDefinition())
  render(<ControlPage />)
  await settle(1400)
  expect(useMachineControl.getState().activeWcs).toBe('G54')

  expect(setWorkOffsetValue('G55', 'X', 25)).toBe(true)
  expect(useMachineControl.getState().activeWcs).toBe('G54')
  expect(sendMdiLine('G55')).toBe(true)
  await settle()
  expect(useMachineControl.getState().activeWcs).toBe('G55')

  const before = useMachineControl.getState().wpos!
  const errorsBefore = consoleErrors()
  attemptWorkGoto('x', before.x - 10)
  await settle()

  expect(consoleErrors()).toEqual(errorsBefore)
  expect(useMachineControl.getState().wpos!.x).toBeCloseTo(before.x - 10, 2)
})

it('allows a switchless work Z goto after the Probe work Z0 control establishes it this session', async () => {
  await connect(switchlessDefinition())
  render(<ControlPage />)
  await settle(1400)

  fireEvent.click(screen.getByTestId('control-view-tools'))
  const probeWorkZero = screen.getByTestId('control-probe-z0') as HTMLButtonElement
  expect(probeWorkZero.disabled).toBe(false)
  fireEvent.click(probeWorkZero)
  await settle(120_000)

  // The button's touch-off writes active work Z0 at the contact, machine Z -40
  // (WO-2059: no pad by default). That controller-confirmed write is the
  // current-session zero the goto requires.
  expect(useMachineControl.getState().offsets.G54?.[2]).toBeCloseTo(-40, 1)
  const before = useMachineControl.getState().wpos!
  const errorsBefore = consoleErrors()
  attemptWorkGoto('z', before.z + 5)
  await settle()

  expect(consoleErrors()).toEqual(errorsBefore)
  expect(useMachineControl.getState().wpos!.z).toBeCloseTo(before.z + 5, 2)
}, 15_000)

it('grants only the WCS that received the zero; a WCS typed during the cycle waits for it (WO-2146)', async () => {
  await connect(switchlessDefinition())
  render(<ControlPage />)
  await settle(1400)
  expect(useMachineControl.getState().activeWcs).toBe('G54')

  const probe = runZProbeCycle('workZero', {
    fastFeed: 6000,
    slowFeed: 600,
    retract: 2,
    maxTravel: 50,
    padThickness: 10,
  })
  // WO-2146 (Operator 2026-09-28): MDI waits for a running probe routine - the
  // typed G55 is not sent, so the frame the cycle writes stays G54.
  expect(sendMdiLine('G55')).toBe(false)
  await act(async () => { await Promise.resolve() })
  expect(useMachineControl.getState().activeWcs).toBe('G54')
  await settle(120_000)
  expect((await probe).ok).toBe(true)
  expect(useMachineControl.getState().offsets.G54?.[2]).toBeCloseTo(-40, 1)

  // G10 L20 P0 wrote G54 at contact, so the probe must not authorize G55.
  expect(sendMdiLine('G55')).toBe(true)
  await settle()
  const beforeG55 = useMachineControl.getState().wpos!
  const errorsBefore = consoleErrors()
  attemptWorkGoto('z', beforeG55.z + 5)
  expect(consoleErrors().slice(errorsBefore.length)).toEqual([
    'Goto Z work: refused - set the G55 work zero for Z here first.',
  ])
  expect(useMachineControl.getState().wpos).toEqual(beforeG55)

  // The WCS that actually received the zero is authorized.
  expect(sendMdiLine('G54')).toBe(true)
  await settle()
  const beforeG54 = useMachineControl.getState().wpos!
  attemptWorkGoto('z', beforeG54.z + 5)
  await settle()
  expect(consoleErrors()).toHaveLength(errorsBefore.length + 1)
  expect(useMachineControl.getState().wpos!.z).toBeCloseTo(beforeG54.z + 5, 2)
})

it('leaves a homed machine with switches exactly as permissive as before', async () => {
  await connect(switchedDefinition())
  expect(getMachineController().home()).toBe(true)
  await settle()
  expect(useMachineControl.getState().homed).toBe(true)
  render(<ControlPage />)
  await settle(1400)

  const before = useMachineControl.getState().wpos!
  const errorsBefore = consoleErrors()
  attemptWorkGoto('x', before.x - 10)
  await settle()

  expect(consoleErrors()).toEqual(errorsBefore)
  expect(useMachineControl.getState().wpos!.x).toBeCloseTo(before.x - 10, 2)
})
