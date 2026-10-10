// @vitest-environment jsdom
//
// WO-2152 - after a top search finds nothing, the picture does not draw the
// probe inside the part.
//
// Rehearsal 2026-09-28 (shots/s10-miss-after.png): Edge, Top = Touch it first,
// the search ran its whole distance over nothing and the stopped step's Front
// view drew the probe ball below the "top" line, inside the grey part. The
// drawn top is only where the plan expected it; the search went its whole
// distance and found nothing, so the probe ended ABOVE the real top. The
// drawn probe stops a clear gap above the drawn top; `data-real` keeps where
// the machine really went, and the stopped sentence is unchanged.
//
// Through the real ProbingPanel; only the routine runner is stubbed, returning
// the runner's own miss sentence (as stoppedRunSaysWhy.wo2113).

import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

type CycleResult = Awaited<ReturnType<typeof import('../../lib/machine/machineSession').runFeatureProbeCycle>>
let finishCycle: ((r: CycleResult) => void) | null = null
const runFeatureProbeCycle = vi.fn(() => new Promise<CycleResult>((resolve) => { finishCycle = resolve }))
const executeOperatorStopReset = vi.fn(() => true)

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle,
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

/** The drawn probe in the side view: its ball's centre, radius and bottom (px). */
function drawnBall() {
  const probe = within(screen.getByTestId('probe-side-view')).getByTestId('probe-side-probe')
  const ball = probe.querySelector('circle')!
  const cx = Number(ball.getAttribute('cx'))
  const cy = Number(ball.getAttribute('cy'))
  const r = Number(ball.getAttribute('r'))
  return { cx, cy, r, bottom: cy + r }
}

/** The top of the drawn part under x (px): the highest material edge there. */
function partTopUnder(x: number): number {
  const rects = Array.from(screen.getByTestId('probe-side-view').querySelectorAll('rect.control-probe-diagram-stock'))
  const tops = rects
    .filter((r) => Number(r.getAttribute('x')) <= x && x <= Number(r.getAttribute('x')) + Number(r.getAttribute('width')))
    .map((r) => Number(r.getAttribute('y')))
  expect(tops.length).toBeGreaterThan(0)
  return Math.min(...tops)
}

async function startRoutine(routine: 'edge' | 'outsideCorner') {
  render(React.createElement(ProbingPanel))
  fireEvent.click(screen.getByTestId(`control-work-probe-routine-${routine}`))
  const drawnStart = realOf()
  await act(async () => { fireEvent.click(screen.getByTestId('control-probe-run-guided')) })
  expect(runFeatureProbeCycle).toHaveBeenCalledTimes(1)
  // WO-2557: the preview remains selected until the first motion report.
  expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('preview')
  return { drawnStart }
}

const MISS = 'Top touch stopped: no top found within 25 mm below where the probe started (searched machine Z -10 to -35).'

async function missTheTop() {
  // The search runs its whole 25 mm and touches nothing; the rest position
  // lands with the run's end (as the simulator reports it).
  await stream(path(START, { z: START.z - 24.8 }, 10))
  await act(async () => {
    useMachineControl.setState({ mpos: { ...START, z: START.z - 25 } })
    finishCycle!({ ok: false, message: MISS, touches: {}, topMachineZ: null })
  })
}

describe('WO-2152 the picture after a top search finds nothing', () => {
  for (const routine of ['edge', 'outsideCorner'] as const) {
    it(`${routine}: the stopped step draws the probe above the drawn top, never sunk into the part; the sentence and the real position are unchanged`, async () => {
      const { drawnStart } = await startRoutine(routine)
      await missTheTop()

      const stepNo = Number(screen.getByTestId('probe-picture').getAttribute('data-step'))
      expect(screen.getByTestId('probing-run-state').textContent).toBe(`Stopped at step ${stepNo}`)
      // The stopped-step sentence, word for word the runner's.
      expect(screen.getByTestId('probing-run-why').textContent).toBe(MISS)
      expect(screen.getByTestId('probing-step-sentence').textContent).toContain('Touches the top')
      expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('after')

      // Where the machine really went (WO-2113): 25 mm below the drawn start.
      const [, , z] = realOf()
      expect(z).toBeCloseTo(drawnStart[2] - 25, 3)

      // The drawn probe: over the part, its ball's bottom a clear gap above
      // the drawn top - not inside the grey part (s10-miss-after.png).
      const ball = drawnBall()
      const top = partTopUnder(ball.cx)
      expect(ball.bottom).toBeLessThan(top - 10)
      // No touch lit for the top that was not found.
      expect(within(screen.getByTestId('probe-picture')).queryAllByTestId('probe-touch-lit')).toHaveLength(0)
    })
  }

  it('a Stop above the top is drawn where it stopped (not moved)', async () => {
    await startRoutine('edge')
    const before = drawnBall()
    await stream(path(START, { z: START.z - 2 }, 4))
    await act(async () => { fireEvent.click(screen.getByTestId('control-probe-stop')) })
    const why = 'Edge probe: stopped by Stop/Reset during Top touch (the search). No further probe or move was sent.'
    await act(async () => { finishCycle!({ ok: false, message: why, touches: {}, topMachineZ: null, stopped: true }) })
    expect(screen.getByTestId('probing-run-state').textContent).toBe('Stopped at step 3')
    // 2 mm down from the drawn start, the drawn ball 2 mm lower than it began.
    const after = drawnBall()
    const k = (after.cy - before.cy) / 2
    expect(k).toBeGreaterThan(0)
    const [, , z] = realOf()
    const top = partTopUnder(after.cx)
    // The ball sits where the machine is: its height above the top, at the
    // picture's own scale (k px per mm, measured from the 2 mm it moved).
    expect(top - after.cy).toBeCloseTo((z + 1.5) * k, 0)
  })

  it('a touched top is unchanged: a run that touches and finishes draws the probe where the plan ends', async () => {
    await startRoutine('edge')
    await stream(path(START, { z: -20 }, 5))
    await stream(path({ ...START, z: -20 }, { z: -18 }, 2))
    const touchedStep = Number(screen.getByTestId('probe-picture').getAttribute('data-step'))
    expect(touchedStep).toBeGreaterThan(0)
    await act(async () => { finishCycle!({ ok: true, touches: {}, topMachineZ: -20 } as unknown as CycleResult) })
    expect(screen.getByTestId('probe-picture').getAttribute('data-mode')).toBe('after')
    expect(screen.queryByTestId('probing-run-why')).toBeNull()
  })
})
