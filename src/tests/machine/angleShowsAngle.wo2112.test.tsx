// @vitest-environment jsdom
//
// WO-2112 - after an Angle run the Probing screen shows the angle it measured.
// The headed walkthrough of 2026-09-28 3:25 AM: Angle finished (30.8 s) and
// neither the screen nor the console said what angle it found - the routine's
// last step read "Shows the angle of the line through the two points." and
// showed nothing, because no step of Angle carried the result.
//
// Through the real ProbingPanel and its Start probing; the routine runner is
// stubbed to report two touches exactly as runFeatureProbeCycle does (onTouch,
// then its result), as probeRoutines.wo261.test.ts does.

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calculateYawAngle } from '../../lib/machine/probeRoutines'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
  })
})

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

const machineSession = await import('../../lib/machine/machineSession')
const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const runFeatureProbeCycle = vi.mocked(machineSession.runFeatureProbeCycle)
const setWorkOffsetValue = vi.mocked(machineSession.setWorkOffsetValue)

type TouchKey = import('../../lib/machine/probeFeatureCycle').ProbeCycleTouchKey
type Plan = Parameters<typeof machineSession.runFeatureProbeCycle>[0]

const START = { x: -50, y: -50, z: -10 }

function connectHomed() {
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: 'G54',
    job: { ...useMachineControl.getState().job, phase: 'empty' },
    connectionKind: 'serial',
    homed: true,
    mpos: { ...START },
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
  })
}

/** Start probing on the screen; the runner reports each touch as it lands,
 *  and the probe ends where the run leaves it (point 2, `endAt`). */
async function runAngle(touches: Partial<Record<TouchKey, number>>, endAt: { x: number; y: number; z: number }) {
  let ranPlan: Plan | null = null
  runFeatureProbeCycle.mockImplementationOnce(async (plan, _config, _clear, onTouch) => {
    ranPlan = plan
    for (const [key, mm] of Object.entries(touches)) onTouch?.(key as TouchKey, mm as number)
    useMachineControl.setState({ mpos: { ...endAt } })
    return { ok: true, message: 'angle cycle recorded 2 touches.', touches, topMachineZ: null }
  })
  const start = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement
  expect(start.disabled, start.title).toBe(false)
  await act(async () => {
    fireEvent.click(start)
    await Promise.resolve()
  })
  expect(ranPlan).not.toBeNull()
  return ranPlan! as Plan
}

function said(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

/** The angle the ran plan's two points give, worked out independently. */
function expectedDeg(plan: Plan, first: number, second: number, nominal: 'X' | 'Y', direction: '+' | '-'): number {
  const along = (key: TouchKey) => {
    const step = plan.steps.find((s) => s.kind === 'touch' && s.key === key)
    if (!step || step.kind !== 'touch') throw new Error(`no ${key} touch in the plan`)
    return nominal === 'X' ? step.expectedStart.x : step.expectedStart.y
  }
  // The line's angle, taken along +nominal whichever way point 2 went.
  const points = [
    { alongMm: along('angleFirst'), triggerPositionMm: first },
    { alongMm: along('angleSecond'), triggerPositionMm: second },
  ].sort((a, b) => a.alongMm - b.alongMm)
  return calculateYawAngle({ nominalAxis: nominal, direction, tipRadiusMm: 1.5, first: points[0], second: points[1] }).thetaDeg
}

beforeEach(() => {
  memory.clear()
  __resetProbingSessionForTest()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    machineState: 'unknown',
    activeWcs: null,
    activeTool: null,
    tlo: null,
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  runFeatureProbeCycle.mockReset()
  setWorkOffsetValue.mockReset()
  setWorkOffsetValue.mockReturnValue(true)
})

afterEach(() => cleanup())

describe('WO-2112 the Angle routine shows the angle it measured', () => {
  it('front face: the result step and the console both show the measured angle and the face; nothing is written', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-angle'))
    expect((screen.getByTestId('control-work-probe-angle-face') as HTMLSelectElement).value).toBe('X+')

    // Point 2 touches the face 0.5 mm further in Y over the 25 mm spacing.
    const plan = await runAngle({ angleFirst: -40, angleSecond: -39.5 }, { x: -25, y: -60, z: -5 })
    const deg = expectedDeg(plan, -40, -39.5, 'X', '+')
    expect(deg).toBeCloseTo((Math.atan2(0.5, 25) * 180) / Math.PI, 6)
    const shown = `Measured ${deg.toFixed(3)} deg from nominal X on the front face (probe Y+).`

    // The run ends on the step that says it shows the angle - and it does.
    expect(screen.getByTestId('probing-step-sentence').textContent).toMatch(/Shows the angle of the line through the two points\.$/)
    expect(screen.getByTestId('control-work-probe-angle-measured').textContent).toBe(shown)
    expect(said()).toContain(shown)
    // Angle writes no offset. WO-2188: its Confirm offers the rotation; until
    // it is pressed nothing reaches the controller.
    expect(screen.getByTestId('control-work-probe-apply').textContent).toBe(`Rotate G54 by ${Number(deg.toFixed(3))} deg`)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
  })

  it('right face, point 2 toward -Y: the angle is the ran plan\'s, not one rebuilt from where the probe now stands', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-angle'))
    fireEvent.change(screen.getByTestId('control-work-probe-angle-face'), { target: { value: 'Y-' } })
    fireEvent.change(screen.getByTestId('control-work-probe-angle-along-direction'), { target: { value: '-' } })

    const plan = await runAngle({ angleFirst: -60, angleSecond: -60.2 }, { x: -40, y: -75, z: -5 })
    const deg = expectedDeg(plan, -60, -60.2, 'Y', '-')
    // The face leans 0.2 mm toward -X over 25 mm going +Y: a small angle,
    // never the ~180 deg a line read backwards gives.
    expect(deg).toBeCloseTo((Math.atan2(-0.2, 25) * 180) / Math.PI, 6)
    const shown = `Measured ${deg.toFixed(3)} deg from nominal Y on the right face (probe X-).`
    expect(screen.getByTestId('control-work-probe-angle-measured').textContent).toBe(shown)
    expect(said()).toContain(shown)

    // The machine reports a new position after the run: the plan on screen is
    // rebuilt from it, the measured angle stays the one the run took.
    await act(async () => { useMachineControl.setState({ mpos: { x: -90, y: -95, z: -5 } }) })
    expect(screen.getByTestId('control-work-probe-angle-measured').textContent).toBe(shown)
  })

  it('before any run the result step says there is no result yet', () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-angle'))
    const chips = screen.getAllByTestId(/^probing-step-chip-/)
    fireEvent.click(chips[chips.length - 1])
    expect(screen.getByTestId('control-work-probe-result').textContent).toBe('No result yet - run the routine first.')
  })
})
