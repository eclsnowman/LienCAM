// @vitest-environment jsdom
//
// WO-357: the probing diagram, and the arrow that says which way it goes.
//
// WO-2063 (docs/design/PROBING-SCREEN-V2.md) replaced the per-routine static
// diagrams, their manual touch buttons and the direction-word helpers with one
// step picture drawn from the routine's own plan. That the picture moves the
// way the routine moves is pinned there (probingScreenV2.wo2063.test.tsx, "the
// pictures are drawn from the plan"). What this file still pins is the part of
// WO-357 that outlives the old diagram: the machine's state stays on screen
// beside the picture, and an alarm does not take the picture or E-STOP away.

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expectOneEstopControl } from './support/estopControl'

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the store persists on every set(). Same in-memory shim the sibling probe
// tests use (probingPanel.wo297.test.tsx, probingMachineState.wo304.test.tsx).
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

const cell = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement).value

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
    mpos: null,
    wpos: null,
    homed: false,
    settings: {},
    alarm: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

describe('WO-357 machine state still stays on screen with the step picture present', () => {
  it('position, homed state and the target work offset render alongside the picture', () => {
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: true,
      wpos: { x: 1, y: 2, z: 3 },
      mpos: { x: 10, y: 20, z: 30 },
      activeWcs: 'G55',
      settings: { 130: '740.000', 131: '724.000', 132: '130.000' },
    })
    render(React.createElement(ProbingPanel))

    expect(cell('control-dro-work-x')).toContain('1.00')
    expect(cell('control-dro-work-y')).toContain('2.00')
    expect(cell('control-dro-work-z')).toContain('3.00')
    // Homed: the MACHINE column shows the real machine coordinate.
    expect(cell('control-dro-machine-x')).toContain('10.00')
    expect((screen.getByTestId('control-work-probe-wcs') as HTMLSelectElement).value).toBe('G55')
    // Not a replacement for the machine-status block - both render together.
    expect(screen.getByTestId('probe-picture')).toBeTruthy()
  })

  it('on the real Probing tab, E-STOP and the state chip stay visible next to the picture', async () => {
    const { default: App } = await import('../../App')
    useCamStore.setState({ workspace: 'cam' })
    render(React.createElement(App))

    fireEvent.click(screen.getByTestId('mode-tab-control'))
    await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })

    fireEvent.click(screen.getByTestId('control-view-probing'))
    expect(screen.getByTestId('control-probing-panel')).toBeTruthy()
    expect(screen.getByTestId('probe-picture')).toBeTruthy()

    act(() => {
      useMachineControl.setState({
        machineState: 'alarm',
        alarm: { code: 1, message: 'Hard limit', positionLost: true },
      })
    })

    expect(screen.getByTestId('control-state-chip').textContent).toBe('ALARM')
    // WO-469: exactly one E-STOP control, in whichever mode it is in.
    expectOneEstopControl()
    // The picture is still there next to them - the alarm did not unmount it.
    expect(screen.getByTestId('probe-picture')).toBeTruthy()
  }, 15000)
})
