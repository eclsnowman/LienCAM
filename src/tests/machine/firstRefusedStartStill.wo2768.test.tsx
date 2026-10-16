// @vitest-environment jsdom
//
// WO-2768 - the owner 2026-10-13 7:28 PM (card): "Fix it now". Since WO-2665 the
// very first refused probe start put "Did not start" and its cause in red on
// the step card. His 10-04 ruling (WO-2557): a refused start leaves the screen
// still; the reason is in the console. The red "Did not start" line belongs
// only over an EXISTING stop (WO-2664 decision 2).
//
// Stubs only the routine runner, with the runner's own sentence, as
// probingStopSaysWhy.wo2664 part 2 does. The production desk-simulator routes
// are refusedProbeStartKeepsScreenStill.wo2557 and wo2664 part 1.

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

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

const runLine = () => screen.queryByTestId('probing-run-line')
const runState = () => screen.queryByTestId('probing-run-state')?.textContent ?? null
const runWhy = () => screen.queryByTestId('probing-run-why')
const red = (el: HTMLElement | null) => el?.style.color === 'var(--accent-red)'
const still = () => ({
  sentence: screen.getByTestId('probing-step-sentence').outerHTML,
  strip: screen.getByTestId('probing-step-strip').outerHTML,
  chips: screen.getAllByTestId(/probing-step-chip-/).map((el) => [el.getAttribute('data-current'), el.getAttribute('data-done'), el.className]),
})

beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected', connectionKind: 'serial', machineState: 'idle', activeWcs: 'G54',
    activeTool: null, tlo: null, homed: true, settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    mpos: { ...START }, wpos: { x: 5, y: 0, z: 10 }, consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})
afterEach(() => {
  cleanup()
  finishCycle = null
})

async function pressStart() {
  await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
}
async function moved() {
  for (let i = 1; i <= 4; i++) await act(async () => { useMachineControl.setState({ mpos: { ...START, x: START.x + i } }) })
}
async function end(message: string, stopped = true) {
  await act(async () => { finishCycle!({ ok: false, touches: {}, topMachineZ: null, message, ...(stopped ? { stopped: true as const } : {}) }) })
}

describe('WO-2768 a first refused probe start keeps the screen still', () => {
  // The console line itself comes from the real runner (stopped results are
  // said there, not by the panel): wo2557 asserts it on the desk simulator.
  it('the very first refused start: no run line, the card unchanged', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    fireEvent.click(screen.getByTestId('probing-step-chip-2'))
    const before = still()
    await pressStart()
    await end(TOUCHING)
    expect(runLine()).toBeNull()
    expect(runState()).toBeNull()
    expect(runWhy()).toBeNull()
    expect(still()).toEqual(before)
    // A second refusal in a row is no different.
    await pressStart()
    await end(TOUCHING)
    expect(runLine()).toBeNull()
    expect(still()).toEqual(before)
  })

  it('a stop the operator already dismissed (a step picked) is not an existing stop: a refused start keeps the screen still', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    await pressStart()
    await moved()
    await end(STOPPED)
    expect(runState()).toMatch(/^Stopped at step \d+$/)
    fireEvent.click(screen.getByTestId('probing-step-chip-1'))
    expect(runLine()).toBeNull()
    const before = still()
    await pressStart()
    await end(TOUCHING)
    expect(runLine()).toBeNull()
    expect(still()).toEqual(before)
  })

  it('over an existing stop, a refused start still replaces its reason with "Did not start" in red (WO-2664 unchanged)', async () => {
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))
    await pressStart()
    await moved()
    await end(STOPPED)
    expect(runWhy()?.textContent).toBe('Stopped by Stop.')
    await pressStart()
    await end(TOUCHING)
    expect(runState()).toBe('Did not start')
    expect(runWhy()?.textContent).toBe('Probe already touching.')
    expect(red(screen.getByTestId('probing-run-state'))).toBe(true)
    expect(red(runWhy())).toBe(true)
    expect(screen.getAllByTestId('probing-run-why')).toHaveLength(1)
    // A second refusal over the same stop keeps the one red line.
    await pressStart()
    await end(TOUCHING)
    expect(runState()).toBe('Did not start')
    expect(screen.getAllByTestId('probing-run-why')).toHaveLength(1)
  })
})
