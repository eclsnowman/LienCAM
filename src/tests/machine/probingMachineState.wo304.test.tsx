// @vitest-environment jsdom
//
// WO-304: machine state stays on screen while probing. Operator named exactly
// what was missing (docs/ui-ux/probing-workspace-requirements.md) - four
// facts, all real, none re-derived:
//   1. where the machine is - work and machine coordinates, live.
//   2. whether it is honestly homed - machineEnvelope's three-state answer
//      (WO-292): a machine coordinate is never shown as fact while unhomed.
//   3. E-stop and alarm state.
//   4. which work offset a probe result would write to, at a glance.
//
// Facts 1/2/4 are new to ProbingPanel (this order). WO-2063 (v2 brief): fact
// 1/2 is now Main's own Position panel, WORK live before homing; fact 4 is the
// setup's Work offset control; fact 3's E-STOP sits in the Probing screen's
// right column, the one E-STOP on screen. The first describe block
// drives them from the real store, mounting only the panel - the same
// pattern probingPanel.wo297.test.tsx already established.
//
// Fact 3 was ALREADY satisfied structurally before this order touched
// anything: ControlTransportBar's state chip (sections="nav") mounts above
// every Control subview, and its transport cluster (sections="transport",
// carrying E-STOP) mounts inside ControlPage's control-aux-authority for
// every non-Main subview. ProbingPanel does not repeat either - two
// readouts of the same fact that can disagree is worse than one. The second
// describe block proves that structural claim by mounting the real App,
// navigating to the real Probing tab exactly the way an operator would, and
// reading the real E-STOP button and state chip off the page
// (controlTabMount.test.tsx's own end-to-end pattern - COHESION-STANDARD.md
// section 10: exercise the real entry point, not an isolated component).

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
// tests use (probingPanel.wo297.test.tsx, controlTabMount.test.tsx).
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

/** WO-2063: the Probing screen shows Main's own Position panel (the WO-2062
 *  extraction) with WORK live before homing. One axis row, read as the
 *  operator reads it: the WORK cell, then the MACHINE cell. */
function dro(axis: 'x' | 'y' | 'z'): { textContent: string } {
  const work = screen.getByTestId(`control-dro-work-${axis}`) as HTMLInputElement
  const machine = screen.getByTestId(`control-dro-machine-${axis}`) as HTMLInputElement
  return { textContent: `${work.value} | ${machine.value}` }
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
    mpos: null,
    wpos: null,
    homed: false,
    settings: {},
    alarm: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

describe('WO-304 the Probing tab shows where the machine is, honestly', () => {
  it('shows live WORK coordinates and gates the MACHINE column while not homed, naming the reason', () => {
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: false,
      wpos: { x: 12.5, y: -3, z: 0.25 },
      mpos: { x: 112.5, y: 97, z: 20.25 },
      settings: { 130: '740.000', 131: '724.000', 132: '130.000' },
    })
    render(React.createElement(ProbingPanel))

    // The WORK column is real live data - unaffected by homing state.
    expect(dro('x').textContent).toContain('12.50')
    expect(dro('y').textContent).toContain('-3.00')
    expect(dro('z').textContent).toContain('0.25')

    // Connected, settings known, but THIS session has not homed: the
    // MACHINE column must not show a factual-looking coordinate...
    expect(dro('x').textContent).not.toContain('112.50')
    expect(dro('y').textContent).not.toContain('97.00')
    expect(dro('z').textContent).not.toContain('20.25')
    expect(dro('x').textContent).toContain('---')

    // WO-1182: the reason is not repeated beside the column; the dash stands
    // and the console carries every reason.
    expect(screen.queryByTestId('control-probing-machine-unhomed')).toBeNull()
  })

  it('shows the real MACHINE coordinate once homed, and drops the unhomed reason', () => {
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: true,
      wpos: { x: 0, y: 0, z: 0 },
      mpos: { x: 100, y: 50, z: 10 },
      settings: { 130: '740.000', 131: '724.000', 132: '130.000' },
    })
    render(React.createElement(ProbingPanel))

    expect(dro('x').textContent).toContain('100.00')
    expect(dro('y').textContent).toContain('50.00')
    expect(dro('z').textContent).toContain('10.00')
    expect(screen.queryByTestId('control-probing-machine-unhomed')).toBeNull()
  })

  it('shows a plain dash while disconnected - no wording beside it (WO-1182)', () => {
    // Default beforeEach state: disconnected, no settings read yet.
    render(React.createElement(ProbingPanel))
    expect(screen.queryByTestId('control-probing-machine-unhomed')).toBeNull()
    expect(dro('x').textContent).toContain('---')
    expect(dro('x').textContent).not.toContain('not homed')
  })

  it('shows which work offset a probe result would write to, at a glance, and follows the selector', () => {
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle', activeWcs: 'G54' })
    render(React.createElement(ProbingPanel))
    // WO-2063: the setup's Work offset row is that glance - one control that
    // shows the offset and picks it.
    const target = screen.getByTestId('control-work-probe-wcs') as HTMLSelectElement
    expect(target.value).toBe('G54')
    fireEvent.change(target, { target: { value: 'G56' } })
    expect((screen.getByTestId('control-work-probe-wcs') as HTMLSelectElement).value).toBe('G56')
  })
})

describe('WO-304 on the real Probing tab: E-stop and alarm are visible without ProbingPanel repeating them', () => {
  it('the state chip and E-STOP stay visible after navigating to Probing, not only Main', async () => {
    const { default: App } = await import('../../App')
    useCamStore.setState({ workspace: 'cam' })
    render(React.createElement(App))

    fireEvent.click(screen.getByTestId('mode-tab-control'))
    await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })

    fireEvent.click(screen.getByTestId('control-view-probing'))
    expect(screen.getByTestId('control-probing-panel')).toBeTruthy()

    // An alarm arising while the operator is on THIS tab (not Main).
    act(() => {
      useMachineControl.setState({
        machineState: 'alarm',
        alarm: { code: 1, message: 'Hard limit', positionLost: true },
      })
    })

    expect(screen.getByTestId('control-state-chip').textContent).toBe('ALARM')
    // WO-469: exactly one E-STOP control, unchanged - asked for by control
    // rather than by one of its two mode words.
    expectOneEstopControl()

    // ProbingPanel adds only the facts that were genuinely missing (position,
    // homed reason, target offset) - it does not carry its own E-STOP, which
    // would be a second readout of the same fact.
    //
    // The companion assertion here - that this panel carries no alarm banner -
    // was DELETED on 2026-08-23, not moved. The alarm block no longer exists
    // anywhere in the app, so the query could never fail again, and an
    // assertion that cannot fail is not a test. This repo has been bitten by
    // exactly that shape before (smoke.mjs carried 8 assertions against a gate
    // that had been cleared).
    const panel = screen.getByTestId('control-probing-panel')
    expect(panel.querySelector('[data-testid="control-estop"]')).toBeTruthy()
    expect(panel.querySelector('[data-testid="control-cyclestart"]')).toBeNull()
  }, 15000)
})
