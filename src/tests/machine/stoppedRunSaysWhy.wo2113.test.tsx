// @vitest-environment jsdom
//
// WO-2113 - a stopped probing run says why, on the Probing screen.
//
// The step card's "Stopped at step N" line carries the reason in the console
// line's own words (a miss: no top within the search; a probe that never made
// contact; Stop/Reset), and the picture shows the probe where the machine
// really stopped - never resting on a top that was not found.
//
// Through the real ProbingPanel; only the routine runner is stubbed, and it
// returns the runner's own failure sentences (machineSession.ts
// runFeatureProbeCycle / executeDirectionalProbeTouch / probeCycleStoppedMessage).

import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

type CycleResult = Awaited<ReturnType<typeof import('../../lib/machine/machineSession').runFeatureProbeCycle>>
let finishCycle: ((r: CycleResult) => void) | null = null
const runFeatureProbeCycle = vi.fn(() => new Promise<CycleResult>((resolve) => { finishCycle = resolve }))
// Operator ruling WO-2600: "Stop only stops probing and can be restarted by hitting probe again."
const stopProbing = vi.fn()
const executeOperatorStopReset = vi.fn(() => true)

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle,
    stopProbing,
    setWorkOffsetValue: vi.fn(() => true),
  })
})
vi.mock('../../lib/machine/operatorTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/operatorTransport')>()
  return typedMock<typeof import('../../lib/machine/operatorTransport')>({ ...actual, executeOperatorStopReset })
})

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

const SETTINGS = { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' }
const START = { x: -50, y: -50, z: -10 }
type P = { x: number; y: number; z: number }

beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  finishCycle = null
  runFeatureProbeCycle.mockClear()
  executeOperatorStopReset.mockClear()
  stopProbing.mockClear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'serial',
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    homed: true,
    settings: SETTINGS,
    mpos: { ...START },
    wpos: { x: 5, y: 0, z: 10 },
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

/** Machine positions from `from` to `to` in `n` reports. */
function path(from: P, to: Partial<P>, n = 5): P[] {
  const end = { ...from, ...to }
  return Array.from({ length: n }, (_, i) => ({
    x: from.x + (end.x - from.x) * (i + 1) / n,
    y: from.y + (end.y - from.y) * (i + 1) / n,
    z: from.z + (end.z - from.z) * (i + 1) / n,
  }))
}

async function stream(positions: P[]) {
  for (const pos of positions) await act(async () => { useMachineControl.setState({ mpos: pos }) })
}

const realOf = () => (screen.getByTestId('probe-picture').getAttribute('data-real') ?? '').split(',').map(Number)
const lastConsoleError = () => useMachineControl.getState().consoleLines.filter((l) => l.severity === 'error').at(-1)?.text

async function startEdge() {
  render(React.createElement(ProbingPanel))
  fireEvent.click(screen.getByTestId('control-work-probe-routine-edge'))
  // Before Start the real probe stands at the operator's start.
  const drawnStart = realOf()
  await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
  expect(runFeatureProbeCycle).toHaveBeenCalledTimes(1)
  return { drawnStart }
}

describe('WO-2113 a stopped probe run says why, on the Probing screen', () => {
  it('a miss - no top within the search - says so beside "Stopped at step N"; the probe is drawn where it stopped, below the drawn top', async () => {
    const { drawnStart } = await startEdge()
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('preview')
    // The search runs its whole 25 mm and touches nothing. The report of
    // where it came to rest lands with the run's end (the simulator, 09-28:
    // the last report before it was 0.175 mm short).
    await stream(path(START, { z: START.z - 24.8 }, 10))
    const why = 'Top touch stopped: no top found within 25 mm below where the probe started (searched machine Z -10 to -35).'
    await act(async () => {
      useMachineControl.setState({ mpos: { ...START, z: START.z - 25 } })
      finishCycle!({ ok: false, message: why, touches: {}, topMachineZ: null })
    })

    expect(screen.getByTestId('probing-run-state').textContent).toBe('Stopped at step 3')
    const line = screen.getByTestId('probing-run-line')
    expect(within(line).getByTestId('probing-run-why').textContent).toBe(why)
    // The same words as the console line.
    expect(lastConsoleError()).toBe(why)
    // The step card's own line - inside the step strip, not a banner.
    expect(screen.getByTestId('probing-step-strip').contains(line)).toBe(true)

    // The picture: where the machine went (25 mm down from the start), past
    // the drawn top (z 0) - never resting on it.
    const picture = screen.getByTestId('probe-picture')
    expect(picture.getAttribute('data-mode')).toBe('after')
    const [, , z] = realOf()
    expect(z).toBeCloseTo(drawnStart[2] - 25, 3)
    expect(z).toBeLessThan(-1)
    // No touch is lit for the top that was not found.
    expect(within(picture).queryAllByTestId(/touch/).filter((el) => el.getAttribute('data-lit') === 'true')).toHaveLength(0)
  })

  it('a probe that never made contact says so; the probe is drawn past the face it never found', async () => {
    const { drawnStart } = await startEdge()
    let p = { ...START }
    const go = async (to: Partial<P>, n = 5) => { const seg = path(p, to, n); await stream(seg); p = seg.at(-1)! }
    await go({ z: -20 }) // top touch
    await go({ z: -18 }, 2) // back off
    await go({ z: -20 }, 2) // slow touch
    await go({ z: -18 }, 2) // retract
    await go({ z: -15 }) // rise to safe
    await go({ x: START.x - 16.5 }) // step out
    await go({ z: -25 }) // descend to depth
    // X+ the whole search (20 mm) - the face was not there.
    await go({ x: START.x - 16.5 + 20 }, 8)
    expect(screen.getByTestId('probing-step-sentence').textContent).toMatch(/^Probes X\+/)
    const touchStep = Number(screen.getByTestId('probe-picture').getAttribute('data-step'))
    const why = 'Edge touch stopped: The probe never made contact within 20 mm (searched machine X -66.5 to -46.5). Check the probe wiring and the pad position.'
    await act(async () => { finishCycle!({ ok: false, message: why, touches: {}, topMachineZ: -20 }) })

    expect(screen.getByTestId('probing-run-state').textContent).toBe(`Stopped at step ${touchStep}`)
    expect(screen.getByTestId('probing-run-why').textContent).toBe(why)
    expect(lastConsoleError()).toBe(why)
    // It stepped out 16.5 mm X- from the start, then went 20 mm X+: drawn
    // 3.5 mm X+ of the start - past the face it never found, which is drawn
    // between the start and the step-out.
    const [x] = realOf()
    expect(x).toBeCloseTo(drawnStart[0] - 16.5 + 20, 3)
  })

  it('Probing Stop says it stopped the run, in the runner\'s words', async () => {
    await startEdge()
    await stream(path(START, { z: START.z - 4 }, 4))
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-stop')) })
    expect(stopProbing).toHaveBeenCalledTimes(1)
    expect(executeOperatorStopReset).not.toHaveBeenCalled()
    const why = 'Edge probe: stopped by Stop during Top touch (the search). No further probe or move was sent.'
    await act(async () => { finishCycle!({ ok: false, message: why, touches: {}, topMachineZ: null, stopped: true }) })
    expect(screen.getByTestId('probing-run-state').textContent).toBe('Stopped at step 3')
    expect(screen.getByTestId('probing-run-why').textContent).toBe(why)
    // WO-2139: the runner says its own Stop/Reset line (info) - the screen
    // never prints it again, and never red: the operator's Stop is no error.
    expect(lastConsoleError()).toBeUndefined()
    // Stopped 4 mm down: drawn 4 mm down, short of the top.
    const [, , z] = realOf()
    expect(z).toBeGreaterThan(0)
  })

  it('the reason goes when the stopped picture goes: a new routine shows no stale reason', async () => {
    await startEdge()
    // This is a moved miss, not a refused start (WO-2557).
    await stream(path(START, { z: START.z - 25 }))
    const why = 'Top touch stopped: no top found within 25 mm below where the probe started (searched machine Z -10 to -35).'
    await act(async () => { finishCycle!({ ok: false, message: why, touches: {}, topMachineZ: null }) })
    expect(screen.getByTestId('probing-run-why').textContent).toBe(why)
    fireEvent.click(screen.getByTestId('control-work-probe-routine-boss'))
    expect(screen.queryByTestId('probing-run-why')).toBeNull()
    expect(screen.queryByTestId('probing-run-state')).toBeNull()
  })

  it.each([0.001, 4])('a run that moves %s mm and returns to its start still shows its stopped reason', async (mm) => {
    await startEdge()
    await stream([{ ...START, z: START.z - mm }, { ...START }])
    const why = 'Moved and returned to the start before stopping.'
    await act(async () => { finishCycle!({ ok: false, message: why, touches: {}, topMachineZ: null }) })
    expect(screen.getByTestId('probing-run-state').textContent).toBe('Stopped at step 3')
    expect(screen.getByTestId('probing-run-why').textContent).toBe(why)
  })

  it('a refused retry preserves a previous stopped run\'s picture; its reason replaces the old one (WO-2664)', async () => {
    await startEdge()
    await stream(path(START, { z: START.z - 4 }))
    const why = 'The moved run stopped.'
    await act(async () => { finishCycle!({ ok: false, message: why, touches: {}, topMachineZ: null }) })
    const before = screen.getByTestId('probing-step-card').outerHTML
    const picture = screen.getByTestId('probe-picture').outerHTML
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
    expect(screen.getByTestId('probing-step-card').outerHTML).toBe(before)
    await act(async () => { finishCycle!({ ok: false, message: 'The retry was refused before motion.', touches: {}, topMachineZ: null }) })
    expect(screen.getByTestId('probe-picture').outerHTML).toBe(picture)
    // WO-2664 (machine seat 10-07 7:40 PM): never two reasons on the screen.
    expect(screen.getByTestId('probing-run-state').textContent).toBe('Did not start')
    expect(screen.getByTestId('probing-run-why').textContent).toBe('The retry was refused before motion.')
    expect(lastConsoleError()).toBe('The retry was refused before motion.')
  })
})
