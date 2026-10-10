// @vitest-environment jsdom
//
// WO-1016: no-datum information and goto refusals belong in the Bottom
// Console, not in rows that push the Position panel down.

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// WO-1052 FINDING: CNCViewport's private static members are nominally untypeable
// from outside its own declaration (see owningStockViewportPick.ui64.test.tsx). Left untyped.
vi.mock('../../lib/viewport/CNCViewport', () => ({
  CNCViewport: class {
    setCameraView = vi.fn()
    fitBoundsPreservingView = vi.fn()
    fitToolpathPreservingView = vi.fn()
    setMachinePreviewCoordinateFrame = vi.fn()
    setIntendedStock = vi.fn()
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
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')
const { createDefaultControllerDefinition } = await import('../../types')
type ControllerDefinition = import('../../types').ControllerDefinition

const SWITCHED_TEXT =
  'Not homed yet - machine coordinates unknown. Press Home All, or type a machine coordinate to set it.'
const SWITCHLESS_TEXT =
  'No home switches - machine coordinates unknown. Working in work coordinates. '
  + 'Type a machine coordinate to set it.'
const MOVING_REFUSAL =
  'Goto X work: refused - the machine is moving - wait for it to stop, then try again.'

function switchlessDefinition(): ControllerDefinition {
  const definition = createDefaultControllerDefinition()
  definition.axes.forEach((axis, index) => {
    axis.stepPin = { port: 1, pin: 2 + index * 2, negate: false }
    axis.dirPin = { port: 1, pin: 3 + index * 2, negate: false }
  })
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

function dro(column: 'work' | 'machine', axis: 'x' | 'y' | 'z'): HTMLInputElement {
  return screen.getByTestId(`control-dro-${column}-${axis}`) as HTMLInputElement
}

function commit(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

function lines(text: string) {
  return useMachineControl.getState().consoleLines.filter((line) => line.text === text)
}

function seedUnhomed(definition: ControllerDefinition): void {
  useCamStore.getState().newProject()
  setupMachine(definition)
  // WO-1710: this suite's old `setSafeZ` seed wrote to the now-deleted
  // MachineActionConfig.safeZMachine store field, which nothing here ever
  // read - `control-safez`'s disabled state below is `!homed` alone in every
  // case this file exercises, so the seed carried no behaviour. Retired
  // rather than re-pinned (nothing to point at the machine record for).
  useUiPrefs.setState({ machineGotoSkipConfirm: false })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    alarm: null,
    homed: false,
    mpos: { x: -123.456, y: -78.9, z: -12.5 },
    wpos: { x: 10.5, y: 20.25, z: 3 },
    settings: {},
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
}

describe('WO-1016 no-datum console transition', () => {
  afterEach(() => cleanup())

  it('moves the switched-machine sentence verbatim and preserves every approved control', () => {
    seedUnhomed(switchedDefinition())
    const view = render(<ControlPage />)

    expect(screen.queryByTestId('control-dro-no-datum')).toBeNull()
    expect(screen.queryByTestId('control-goto-refusal')).toBeNull()
    expect(lines(SWITCHED_TEXT)).toHaveLength(1)
    expect(lines(SWITCHED_TEXT)[0]).toMatchObject({ dir: 'tx', severity: 'info' })

    for (const axis of ['x', 'y', 'z'] as const) {
      expect(dro('machine', axis).value).toBe('---')
      expect(dro('machine', axis).disabled).toBe(false)
    }
    expect(dro('work', 'x').value).toBe('---')
    expect(screen.getByTestId('control-datum-chip').textContent)
      .toBe('NO DATUM - HOME FIRST, CHECK SWITCHES')
    expect((screen.getByTestId('control-safez') as HTMLButtonElement).disabled).toBe(true)

    for (let index = 0; index < 20; index += 1) view.rerender(<ControlPage />)
    expect(lines(SWITCHED_TEXT)).toHaveLength(1)
  })

  it('keeps the switchless cure distinct and announces a real state transition once', () => {
    seedUnhomed(switchlessDefinition())
    const view = render(<ControlPage />)

    expect(lines(SWITCHLESS_TEXT)).toHaveLength(1)
    expect(lines(SWITCHED_TEXT)).toHaveLength(0)
    expect(screen.getByTestId('control-datum-chip').textContent)
      .toBe('NO DATUM - WORK COORDINATES')
    expect((screen.getByTestId('control-safez') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('control-dro-no-datum')).toBeNull()

    for (let index = 0; index < 20; index += 1) view.rerender(<ControlPage />)
    expect(lines(SWITCHLESS_TEXT)).toHaveLength(1)

    act(() => { useMachineControl.setState({ homed: true }) })
    // WO-2261: Control Main renders millimetres with two decimals.
    expect(dro('machine', 'x').value).toBe('-123.46')
    act(() => { useMachineControl.setState({ homed: false }) })
    expect(lines(SWITCHLESS_TEXT)).toHaveLength(2)
  })

  it('announces a changed unknown-datum reason without spamming either sentence', () => {
    seedUnhomed(switchedDefinition())
    const view = render(<ControlPage />)
    expect(lines(SWITCHED_TEXT)).toHaveLength(1)

    act(() => { setupMachine(switchlessDefinition()) })
    for (let index = 0; index < 20; index += 1) view.rerender(<ControlPage />)

    expect(lines(SWITCHED_TEXT)).toHaveLength(1)
    expect(lines(SWITCHLESS_TEXT)).toHaveLength(1)
  })
})

describe('WO-1016 refusal console events', () => {
  beforeEach(() => {
    seedUnhomed(switchedDefinition())
    useMachineControl.setState({ homed: true, consoleLines: [] })
  })
  afterEach(() => cleanup())

  it('keeps repeated identical refusals to one console event and renders no refusal row', () => {
    const view = render(<ControlPage />)

    for (let index = 0; index < 20; index += 1) {
      commit(dro('work', 'x'), '11.000')
      view.rerender(<ControlPage />)
    }
    expect(lines(MOVING_REFUSAL)).toHaveLength(1)
    expect(lines(MOVING_REFUSAL)[0]).toMatchObject({ dir: 'tx', severity: 'error' })
    expect(screen.queryByTestId('control-goto-refusal')).toBeNull()

    act(() => { useMachineControl.setState({ machineState: 'alarm' }) })
    commit(dro('work', 'x'), '11.000')
    expect(lines('Goto X work: refused - the machine is in alarm.')).toHaveLength(1)

    act(() => { useMachineControl.setState({ machineState: 'idle' }) })
    commit(dro('work', 'x'), '11.000')
    expect(lines(MOVING_REFUSAL)).toHaveLength(2)
  })
})

describe('WO-1016 manual datum negative control (simulator)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    setupMachine(switchlessDefinition())
    useUiPrefs.setState({ machineGotoSkipConfirm: false })
    useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    await vi.advanceTimersByTimeAsync(1400)
  })

  afterEach(async () => {
    cleanup()
    act(() => { getMachineController().emergencyStop() })
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('still sets the machine datum by typing into a dash without adding a row', async () => {
    render(<ControlPage />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1400) })

    expect(dro('machine', 'x').value).toBe('---')
    expect(dro('machine', 'x').disabled).toBe(false)
    const consoleBeforeDatum = [...useMachineControl.getState().consoleLines]
    commit(dro('machine', 'x'), '123.456')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(useMachineControl.getState().homed).toBe(true)
    expect(dro('machine', 'x').value).toBe('123.46')
    expect(useMachineControl.getState().mpos?.x).toBe(123.456)
    expect(screen.queryByTestId('control-dro-no-datum')).toBeNull()
    expect(screen.queryByTestId('control-goto-refusal')).toBeNull()
    // The existing Set acknowledgement remains; no homing announcement is added.
    expect(useMachineControl.getState().consoleLines.slice(consoleBeforeDatum.length))
      .toMatchObject([{ dir: 'tx', text: 'Set X machine position to 123.46 mm.' }])
    expect(lines('Homed - machine coordinates set.')).toHaveLength(0)
  })
})
