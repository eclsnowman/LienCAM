// @vitest-environment jsdom
//
// WO-358: the probing diagram reacts to each touch. Slice D of
// docs/ui-ux/probing-screen-design.md - "Each touch that lands is drawn on it
// as it happens, the next expected touch is highlighted, and when the routine
// finishes the found feature is drawn where it was found."
//
// WO-2063 (docs/design/PROBING-SCREEN-V2.md) replaced the static diagram, its
// landed/next arrows, its found-feature marks and the manual touch buttons
// with one step picture that follows the machine and lights the touch where
// it meets the part (pinned in oneStepAtATime.wo2063.test.tsx). The cases that
// read those marks and their placement helpers are retired with them.
//
// What stays pinned is the part of WO-358 that is still the product's: a
// routine that is aborted, fails to touch or finds an impossible shape never
// offers a result to write, a changed setup drops a stale result, and the
// confirmation gates every work-offset write.

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    runFeatureProbeCycle: vi.fn(),
    setWorkOffsetValue: vi.fn(() => true),
  })
})

const machineSession = await import('../../lib/machine/machineSession')
const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const runFeatureProbeCycle = vi.mocked(machineSession.runFeatureProbeCycle)
const setWorkOffsetValue = vi.mocked(machineSession.setWorkOffsetValue)
type TouchKey = import('../../lib/machine/probeFeatureCycle').ProbeCycleTouchKey

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

/** A homed machine with known travel: the Probing screen can plan a run. */
function connectHomed() {
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'serial',
    machineState: 'idle',
    activeWcs: 'G54',
    homed: true,
    mpos: { x: -50, y: -50, z: -10 },
    settings: { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' },
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
}

/** Start probing, with the runner reporting each touch as it lands (as
 *  runFeatureProbeCycle does) and then ending ok or not. */
async function runRoutine(touches: Partial<Record<TouchKey, number>>, ok = true) {
  runFeatureProbeCycle.mockImplementationOnce(async (_plan, _config, _clear, onTouch) => {
    // Contacts imply actual travel. Report it so a failed fourth touch is
    // distinguished from a pre-motion refusal (WO-2557).
    const at = useMachineControl.getState().mpos!
    useMachineControl.setState({ mpos: { ...at, z: at.z - 4 } })
    for (const [key, mm] of Object.entries(touches)) onTouch?.(key as TouchKey, mm as number)
    return { ok, message: ok ? 'cycle recorded its touches.' : 'No contact detected.', touches, topMachineZ: null }
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-probe-run-guided'))
    await Promise.resolve()
  })
}

beforeEach(() => {
  __resetProbingSessionForTest()
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    machineState: 'unknown',
    activeWcs: null,
    activeTool: null,
    tlo: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
  runFeatureProbeCycle.mockReset()
  setWorkOffsetValue.mockReset()
  setWorkOffsetValue.mockReturnValue(true)
})

afterEach(() => cleanup())

describe('WO-358 the confirmation still gates every work-offset write', () => {
  it('the result shows before Confirm, but nothing is written until it is pressed', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.change(screen.getByTestId('control-work-probe-wcs'), { target: { value: 'G55' } })
    await runRoutine({ edge: 10 })

    const result = await screen.findByTestId('control-work-probe-result')
    expect(result.textContent).toContain('X face 11.50 mm.')
    expect(setWorkOffsetValue).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('control-work-probe-apply'))
    expect(setWorkOffsetValue).toHaveBeenCalledOnce()
    expect(setWorkOffsetValue).toHaveBeenCalledWith('G55', 'X', 11.5)
  })
})

describe('WO-358 an aborted or failed routine leaves the screen honest', () => {
  it('bore centre: a failed fourth touch offers no result, says where it stopped, and writes nothing', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))

    await runRoutine({ xNegative: -4, xPositive: 4, yNegative: -5 }, false)

    expect(screen.getByTestId('probing-run-state').textContent).toMatch(/^Stopped at step \d+$/)
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
  })

  it('a re-run after a failure still finishes honestly once it actually lands', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))

    await runRoutine({ xNegative: -4, xPositive: 4, yNegative: -5 }, false)
    expect(screen.queryByTestId('control-work-probe-apply')).toBeNull()

    await runRoutine({ xNegative: -4, xPositive: 4, yNegative: -5, yPositive: 5 })
    expect(screen.getByTestId('control-work-probe-apply')).toBeTruthy()
    expect(screen.queryByTestId('probing-run-state')?.textContent ?? '').not.toMatch(/Stopped/)
  })

  it('changing the edge face after a run drops the stale result', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    await runRoutine({ edge: 10 })
    expect(screen.getByTestId('control-work-probe-result').textContent).toContain('X face 11.50 mm.')

    fireEvent.change(screen.getByTestId('control-work-probe-edge-face'), { target: { value: 'Y+' } })
    // Whatever step is shown now, no face found on X is offered to write.
    const confirmIndex = screen.getAllByTestId(/^probing-step-chip-/).length
    fireEvent.click(screen.getByTestId(`probing-step-chip-${confirmIndex}`))
    expect(screen.getByTestId('control-work-probe-result').textContent).not.toContain('X face')
    expect((screen.getByTestId('control-work-probe-apply') as HTMLButtonElement).disabled).toBe(true)
  })

  it('an invalid four-touch bore (non-positive diameter) offers nothing to write', async () => {
    connectHomed()
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-bore'))

    // X- and X+ reversed relative to the routine's own convention produce a
    // non-positive diameter - calculateBoreCenter throws, exactly as WO-261
    // already proves in probeRoutines.wo261.test.ts. All four touches DO
    // land; the shape they describe is simply not a valid bore.
    await runRoutine({ xNegative: 4, xPositive: -4, yNegative: -5, yPositive: 5 })

    const confirm = screen.queryByTestId('control-work-probe-apply') as HTMLButtonElement | null
    expect(confirm === null || confirm.disabled).toBe(true)
    expect(setWorkOffsetValue).not.toHaveBeenCalled()
  })
})
