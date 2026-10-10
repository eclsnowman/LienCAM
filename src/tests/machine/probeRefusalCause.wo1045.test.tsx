// @vitest-environment jsdom
//
// WO-1045: a probe plan refusal names the EnvelopeStatus that actually closed
// the gate. Only not-homed prescribes homing; unknown names the unread
// controller settings, no-datum keeps the switchless explanation, and a
// homed controller that has not reported MPos names that missing report.

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

const { ProbingPanel } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const SETTINGS = { 23: '0', 27: '1', 130: '100', 131: '100', 132: '50' }
const PROGRAM = [
  'G21 G90 G54',
  'G0 X0 Y0 Z5',
  'G1 Z-1 F100',
  'G1 X20 Y0 F400',
  'G1 X20 Y20',
  'G1 X0 Y20',
  'G1 X0 Y0',
].join('\n')

const UNKNOWN = "The machine's travel limits are not known yet - the controller settings have not been read."
const FEATURE_NOT_HOMED = 'Home the machine before planning an automatic probe cycle.'
const MESH_NOT_HOMED = 'Home the machine before planning mesh travel.'
const FEATURE_NO_DATUM = 'This machine has no home switches, so it has no machine datum and nothing to home - set the machine position before planning an automatic probe cycle.'
const MESH_NO_DATUM = 'This machine has no home switches, so it has no machine datum and nothing to home - set the machine position before planning mesh travel.'
const FEATURE_NO_POSITION = 'The homed machine position has not been reported yet - wait for a position update before planning an automatic probe cycle.'
const MESH_NO_POSITION = 'The homed machine position has not been reported yet - wait for a position update before planning mesh travel.'

type DrivenStatus = 'unknown' | 'not-homed' | 'homed' | 'no-datum'

function driveStatus(status: DrivenStatus, withPosition = status === 'homed'): void {
  const machine = useCamStore.getState().project.machine!
  useCamStore.getState().updateMachine({
    ...machine,
    noHomingSwitches: status === 'no-datum',
  })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    homed: status === 'homed' || status === 'unknown',
    settings: status === 'unknown' ? {} : SETTINGS,
    mpos: withPosition ? { x: -50, y: -50, z: -10 } : null,
    wpos: { x: 0, y: 0, z: 0 },
  })
}

/** WO-2063 (v2 brief): the plan text block went with the old screen. A
 *  planning refusal is now Start probing's reason - grey, with the refusal in
 *  its hover - and the same words reach the console once. A live Start
 *  probing means the routine planned. */
function visiblePlanText(): string {
  const start = screen.getByTestId('control-probe-run-guided') as HTMLButtonElement
  return start.disabled ? (start.getAttribute('data-tooltip') ?? '').trim() : 'Motion plan'
}

async function expectRefusal(expected: string): Promise<void> {
  await waitFor(() => expect(visiblePlanText()).toBe(expected))
  await waitFor(() => {
    const errors = useMachineControl.getState().consoleLines.filter((line) => line.severity === 'error')
    expect(errors.at(-1)?.text).toBe(expected)
  })
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'disconnected',
    connectionKind: 'serial',
    machineState: 'unknown',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    homed: false,
    settings: {},
    mpos: null,
    wpos: null,
    programText: PROGRAM,
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty', name: 'wo1045.nc' },
  })
})

afterEach(() => cleanup())

describe('WO-1045 probe planning refusals name their actual envelope cause', () => {
  it('drives all four statuses through the feature-cycle hint and the identical console line', async () => {
    // Reproduce the machine observation: homed is true, but unread settings
    // make the envelope status unknown. The refusal must never prescribe Home.
    driveStatus('unknown')
    render(React.createElement(ProbingPanel))
    await expectRefusal(UNKNOWN)
    expect(visiblePlanText()).not.toMatch(/\bhome\b/i)

    act(() => driveStatus('not-homed'))
    await expectRefusal(FEATURE_NOT_HOMED)

    act(() => driveStatus('no-datum'))
    await expectRefusal(FEATURE_NO_DATUM)

    // Homed is its own state. If MPos has not arrived, name that report rather
    // than falling back to the homing sentence.
    act(() => driveStatus('homed', false))
    await expectRefusal(FEATURE_NO_POSITION)

    // Once the homed position is present, the refusal disappears and the real
    // motion plan renders. This is the usable fourth-state negative control.
    act(() => driveStatus('homed', true))
    await waitFor(() => expect(visiblePlanText()).toContain('Motion plan'))
    expect(visiblePlanText()).not.toContain('reported yet')
  })

  it('uses the same four causes for mesh travel without restoring the wrong homing fallback', async () => {
    driveStatus('unknown')
    render(React.createElement(ProbingPanel))
    fireEvent.click(screen.getByTestId('control-work-probe-routine-zSurface'))
    await expectRefusal(UNKNOWN)
    expect(visiblePlanText()).not.toMatch(/\bhome\b/i)

    act(() => driveStatus('not-homed'))
    await expectRefusal(MESH_NOT_HOMED)

    act(() => driveStatus('no-datum'))
    await expectRefusal(MESH_NO_DATUM)

    act(() => driveStatus('homed', false))
    await expectRefusal(MESH_NO_POSITION)

    act(() => driveStatus('homed', true))
    await waitFor(() => expect(visiblePlanText()).toBe('Motion plan'))
    expect(visiblePlanText()).not.toContain('reported yet')
  })
})
