// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { ProbingPanel, __resetProbingSessionForTest } = await import('../../components/machine/ProbingPanel')
const { ProbeRoutinesTab } = await import('../../components/machine/ProbeRoutinesTab')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
type Step = import('../../store/machineControlStore').ToolChangeStep

function toolChange(step: Step) {
  useMachineControl.setState({ toolChange: {
    mode: 'toolChange', step, tool: 2, resumeLine: 6,
    message: 'Measuring the new tool on the tool setter...', warnings: [],
  } })
}

function input(probe: boolean | null) {
  act(() => useMachineControl.setState({
    inputs: { ...useMachineControl.getState().inputs!, probe },
  }))
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  __resetProbingSessionForTest()
  useMachineToolTable.setState({ byMachine: {} })
  useMachineControl.setState({
    connectionPhase: 'connected', connectionKind: 'simulator', machineState: 'idle',
    activeWcs: 'G54', activeTool: null, tlo: null, homed: false, settings: {},
    mpos: null, wpos: null, toolChange: null, spindleRpm: 0,
    reportedAccessories: { spindle: 'off', flood: false, mist: false },
    inputs: { estop: false, hardLimit: false, softLimit: false, probe: false,
      limits: { x: false, y: false, z: false }, door: false, hold: false },
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})
afterEach(cleanup)

const surfaces = [
  { name: 'Probing', component: ProbingPanel, lamp: 'probing-lamp-probe' },
  { name: 'Routines', component: ProbeRoutinesTab, lamp: 'routines-lamp-probe' },
  { name: 'tool-change measure', component: ProgramPanel, lamp: 'toolchange-lamp-probe' },
]

describe('WO-2553 shared PROBE lamp on every probing surface', () => {
  for (const surface of surfaces) {
    it(`${surface.name}: follows the real store input and unavailable pin`, () => {
      toolChange('probing')
      render(React.createElement(surface.component))
      for (const [value, state] of [[true, 'on'], [false, 'off'], [null, 'unavailable']] as const) {
        input(value)
        expect(screen.getByTestId(surface.lamp).classList.contains(`probe-lamp-${state}`)).toBe(true)
        expect(screen.getAllByTestId(surface.lamp)).toHaveLength(1)
      }
    })

    it(`${surface.name}: retains spindle speed and reported-running suppression`, () => {
      toolChange('probing')
      input(true)
      render(React.createElement(surface.component))
      for (const [spindleRpm, spindle] of [[1, 'off'], [0, 'cw'], [null, 'ccw']] as const) {
        act(() => useMachineControl.setState({ spindleRpm,
          reportedAccessories: { spindle, flood: false, mist: false } }))
        expect(screen.getByTestId(surface.lamp).classList.contains('probe-lamp-unavailable')).toBe(true)
        expect(screen.getByTestId(surface.lamp).getAttribute('data-tooltip'))
          .toBe('PROBE: not read while the spindle turns')
      }
      act(() => useMachineControl.setState({ spindleRpm: 0,
        reportedAccessories: { spindle: 'off', flood: false, mist: false } }))
      expect(screen.getByTestId(surface.lamp).classList.contains('probe-lamp-on')).toBe(true)
    })
  }

  it('Probing: stays in the common header for every routine including Measure tool', () => {
    render(<ProbingPanel />)
    const picker = screen.getByTestId('control-probe-routine-bar')
    for (const button of within(picker).getAllByRole('button')) {
      fireEvent.click(button)
      input(true)
      expect(within(picker).getByTestId('probing-lamp-probe').classList.contains('probe-lamp-on')).toBe(true)
    }
  })

  it('Routines: stays live with the selected editor and checked run panel', () => {
    useCamStore.getState().setProjectMachine({ ...useCamStore.getState().project.machine,
      travel: { x: 800, y: 800, z: 80 },
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', machineZeroAt: 'max' },
      } })
    useMachineControl.setState({ homed: true, mpos: { x: 100, y: 100, z: -10 },
      settings: { 130: '800', 131: '800', 132: '80', 23: '3', 27: '1' } })
    render(<ProbeRoutinesTab />)
    fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.edge.x-minus' } })
    fireEvent.click(screen.getByTestId('probe-routine-check'))
    expect(screen.queryByTestId('probe-routine-run-panel'), screen.getByTestId('probe-routine-preview').textContent).toBeTruthy()
    for (const probe of [true, false]) {
      input(probe)
      expect(screen.getByTestId('routines-lamp-probe').classList.contains(probe ? 'probe-lamp-on' : 'probe-lamp-off')).toBe(true)
    }
  })

  it('tool-change: keeps the lamp through all steps; clamp pause does not add one', () => {
    toolChange('probing')
    render(<ProgramPanel />)
    for (const step of ['stopping', 'parking', 'awaiting-swap', 'probing', 'arming', 'ready', 'failed'] as const) {
      act(() => toolChange(step))
      input(true)
      const card = screen.getByTestId('control-toolchange-card')
      const lamp = within(card).getByTestId('toolchange-lamp-probe')
      expect(lamp.classList.contains('probe-lamp-on')).toBe(true)
      // The lamp belongs to the title row, never an adjacent preview overlay.
      expect(lamp.parentElement === card.querySelector('.control-tc-title')?.parentElement).toBe(true)
      expect(lamp.parentElement?.className).toBe('control-tc-header')
      input(false)
      expect(within(card).getByTestId('toolchange-lamp-probe').classList.contains('probe-lamp-off')).toBe(true)
    }
    act(() => useMachineControl.setState({ toolChange: {
      ...useMachineControl.getState().toolChange!, mode: 'clampPause',
    } }))
    expect(screen.queryByTestId('toolchange-lamp-probe')).toBeNull()
  })

  it('Tools retains exactly one existing PROBE lamp', () => {
    render(<ToolsProbePanel />)
    expect(screen.getAllByTestId('tools-probe-lamp-probe')).toHaveLength(1)
  })
})
