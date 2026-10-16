// @vitest-environment jsdom
//
// WO-2774 - the owner 2026-10-08 5:04 AM CT (card answer): "After the alpha
// (recommended)". The card: "(1) the top-right chip reads 'Ready' beside the
// red 'Stopped at step 3' - true for the machine, but reads mixed. (2) After
// 'Did not start', the step bar still highlights step 3 from the earlier run.
// Fix: the chip and step bar agree with the stopped/not-started line."
//
// Stubs only the routine runner, with the runner's own sentences, as
// firstRefusedStartStill.wo2768 does; the header chip is the production
// MachineStatusChip reading the shared machine-control store.

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { MachineController } from '../../lib/machine/controller'

type CycleResult = Awaited<ReturnType<typeof import('../../lib/machine/machineSession').runFeatureProbeCycle>>
let finishCycle: ((r: CycleResult) => void) | null = null

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: (() => new Promise<CycleResult>((resolve) => { finishCycle = resolve })) as typeof actual.runFeatureProbeCycle,
  })
})

vi.mock('../../lib/viewport/CNCViewport', () => typedMock<typeof import('../../lib/viewport/CNCViewport')>({
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
  } as never,
}))

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { MachineStatusChip } = await import('../../components/toolbar/MachineStatusChip')
const { deriveMachineChip } = await import('../../lib/machine/machineChip')
const { getMachineController } = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

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

type P = { x: number; y: number; z: number }
const START: P = { x: -50, y: -50, z: -10 }
const TOUCHING = 'Bore probe: the probe was already touching at G54 X 0 before the move to probing depth, so that move was not sent. No further probe or move was sent.'
const STOPPED = 'Bore probe: stopped by Stop during Probe xNegative (the search). No further probe or move was sent.'

const runState = () => screen.queryByTestId('probing-run-state')?.textContent ?? null
const runLine = () => screen.queryByTestId('probing-run-line')
const chip = () => screen.getByTestId('machine-status-chip')
const stepChips = () => screen.getAllByTestId(/^probing-step-chip-/)
const current = () => stepChips().filter((el) => el.getAttribute('aria-current') === 'step' || el.className.includes('pbn-chip-current'))
const ticked = () => stepChips().filter((el) => el.getAttribute('data-done') === 'true')
const still = () => ({
  sentence: screen.getByTestId('probing-step-sentence').outerHTML,
  strip: screen.getByTestId('probing-step-strip').outerHTML,
  chip: chip().outerHTML,
})

beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected', connectionKind: 'serial', machineState: 'idle', activeWcs: 'G54',
    activeTool: null, tlo: null, homed: true, settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    mpos: { ...START }, wpos: { x: 5, y: 0, z: 10 }, consoleLines: [], toolChange: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  // The header's datum authority is the live controller: homed this session.
  const controller = getMachineController() as MachineController & Required<Pick<MachineController, 'homedAxesThisSession'>>
  vi.spyOn(controller, 'homedAxesThisSession').mockReturnValue({ X: true, Y: true, Z: true })
})
afterEach(() => {
  cleanup()
  finishCycle = null
  vi.restoreAllMocks()
})

function renderScreen() {
  render(React.createElement(React.Fragment, null,
    React.createElement(MachineStatusChip),
    React.createElement(ProbingPanel)))
  fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
}
async function pressStart() {
  await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
}
async function moved(steps = 4) {
  for (let i = 1; i <= steps; i++) await act(async () => { useMachineControl.setState({ mpos: { ...START, x: START.x - i } }) })
}
async function end(message: string) {
  await act(async () => { finishCycle!({ ok: false, touches: {}, topMachineZ: null, message, stopped: true as const }) })
}

describe('WO-2774 after a probe stop the header chip and the step bar agree with the stop line', () => {
  it('(a) a stopped run: the chip reads "Stopped" in the stop line\'s red beside "Stopped at step N"', async () => {
    renderScreen()
    expect(chip().textContent).toBe('Ready')
    await pressStart()
    await moved()
    await end(STOPPED)
    expect(runState()).toMatch(/^Stopped at step \d+$/)
    expect(chip().textContent).toBe('Stopped')
    expect(chip().getAttribute('data-state')).toBe('stopped')
    expect(chip().getAttribute('aria-label')).toBe('Machine status: Stopped')
    expect(chip().style.color).toBe('var(--accent-red)')
  })

  it('(b) a refused restart over the stop: "Did not start", no earlier-run step or ticks on the bar, chip still "Stopped"', async () => {
    renderScreen()
    await pressStart()
    await moved(12)
    await end(STOPPED)
    const stoppedAt = runState()
    expect(stoppedAt).toMatch(/^Stopped at step \d+$/)
    // The stopped run's own bar still marks where it stopped.
    expect(current()).toHaveLength(1)
    expect(ticked().length).toBeGreaterThan(0)
    await pressStart()
    await end(TOUCHING)
    expect(runState()).toBe('Did not start')
    expect(current()).toHaveLength(0)
    expect(ticked()).toHaveLength(0)
    expect(chip().textContent).toBe('Stopped')
    expect(chip().getAttribute('data-state')).toBe('stopped')
  })

  it('(c) picking a step takes the line away and the chip back to the machine reading', async () => {
    renderScreen()
    await pressStart()
    await moved()
    await end(STOPPED)
    await pressStart()
    await end(TOUCHING)
    expect(chip().textContent).toBe('Stopped')
    fireEvent.click(screen.getByTestId('probing-step-chip-1'))
    expect(runLine()).toBeNull()
    expect(chip().textContent).toBe('Ready')
    expect(chip().getAttribute('data-state')).toBe('ready')
    expect(current().map((el) => el.getAttribute('data-testid'))).toEqual(['probing-step-chip-1'])
  })

  it('a new run that moves takes the line away and the chip with it', async () => {
    renderScreen()
    await pressStart()
    await moved()
    await end(STOPPED)
    expect(chip().textContent).toBe('Stopped')
    await pressStart()
    await moved()
    expect(runLine()).toBeNull()
    expect(chip().textContent).toBe('Ready')
    await act(async () => { useMachineControl.setState({ machineState: 'run' }) })
    expect(chip().textContent).toBe('Running')
  })

  it('(d) a first refused start with no stop on screen changes nothing, header chip included (WO-2768)', async () => {
    renderScreen()
    fireEvent.click(screen.getByTestId('probing-step-chip-2'))
    const before = still()
    await pressStart()
    await end(TOUCHING)
    expect(runLine()).toBeNull()
    expect(still()).toEqual(before)
    expect(chip().textContent).toBe('Ready')
  })

  it('the stop is shown on every workspace: the chip keeps "Stopped" with the Probing screen closed', async () => {
    const view = render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    await pressStart()
    await moved()
    await end(STOPPED)
    view.unmount()
    render(React.createElement(MachineStatusChip))
    expect(chip().textContent).toBe('Stopped')
  })

  it('a disconnect ends the probing session and its stop: the chip leaves "Stopped"', async () => {
    renderScreen()
    await pressStart()
    await moved()
    await end(STOPPED)
    expect(chip().textContent).toBe('Stopped')
    await act(async () => { useMachineControl.getState().setConnection('disconnected', null) })
    expect(chip().textContent).toBe('Offline')
    expect(useMachineControl.getState().probeRunStopped).toBe(false)
  })

  it('Offline, Alarm, Held and Running still outrank a stopped probe run', () => {
    const facts = { connectionPhase: 'connected', machineState: 'idle', jobPhase: 'empty', probeRunStopped: true,
      datumResolver: { homedThisSession: () => true } } as const
    expect(deriveMachineChip(facts)).toEqual({ state: 'stopped', label: 'Stopped' })
    expect(deriveMachineChip({ ...facts, connectionPhase: 'disconnected' }).state).toBe('offline')
    expect(deriveMachineChip({ ...facts, machineState: 'alarm' }).state).toBe('alarm')
    expect(deriveMachineChip({ ...facts, machineState: 'hold' }).state).toBe('held')
    expect(deriveMachineChip({ ...facts, programM0Held: true }).state).toBe('held')
    expect(deriveMachineChip({ ...facts, toolChangeWaiting: true }).state).toBe('held')
    expect(deriveMachineChip({ ...facts, machineState: 'run' }).state).toBe('running')
    expect(deriveMachineChip({ ...facts, jobPhase: 'streaming' }).state).toBe('running')
    expect(deriveMachineChip({ ...facts, probeRunStopped: false }).state).toBe('ready')
  })
})
