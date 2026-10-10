// @vitest-environment jsdom
//
// WO-2075: the PROBE lamp (`ProbeLamp.tsx`, one component on the Control
// screen, the Probing panel and the Tools/Probe panel) shows "not read" -
// greyed like the existing unavailable look, tooltip "PROBE: not read while
// the spindle turns" - whenever the spindle is reported turning (rpm > 0,
// including the ramp up), whatever the probe input says. Stopped, it shows
// the input exactly as before. PROBING (a separate signal, a cycle in
// process) is unaffected.
//
// Why (machine seat, 09-26 wire recording): spindle stopped 41.6 min -> 0
// false probe pulses; spindle turning 24.1 min -> 186 false pulses (median
// 33 ms, max 118 ms, first at ~5000 rpm on the ramp). Real touches last
// 53-216 ms, so no debounce threshold separates them; "spindle turning" does.

import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
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

const { ControlPage } = await import('../../components/machine/ControlPage')
const { ToolsProbePanel } = await import('../../components/machine/ToolsProbePanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')

const BASE_INPUTS = {
  estop: false,
  hardLimit: false,
  softLimit: false,
  probe: false,
  limits: { x: false, y: false, z: false },
  door: false,
  hold: false,
}

function connectAs(kind: 'simulator' | 'bridge' | 'serial'): void {
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: kind,
    machineState: 'idle',
    activeWcs: 'G54',
    activeTool: null,
    tlo: null,
    homed: false,
    settings: {},
    mpos: null,
    wpos: null,
    spindleRpm: 0,
    reportedAccessories: { spindle: 'off', flood: false, mist: false },
    inputs: { ...BASE_INPUTS },
    probeCycle: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
}

function setSignals(
  probe: boolean | null,
  spindleRpm: number | null,
  probeCycle: boolean | null = null,
  spindleAccessory: 'cw' | 'ccw' | 'off' = 'off',
): void {
  act(() => {
    useMachineControl.setState({
      inputs: { ...BASE_INPUTS, probe },
      spindleRpm,
      probeCycle,
      reportedAccessories: { spindle: spindleAccessory, flood: false, mist: false },
    })
  })
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  connectAs('simulator')
})

afterEach(() => cleanup())

type Lit = 'on' | 'off' | 'unavailable'

function classOf(testId: string): Lit {
  const el = screen.getByTestId(testId)
  if (el.classList.contains('probe-lamp-on')) return 'on'
  if (el.classList.contains('probe-lamp-unavailable')) return 'unavailable'
  expect(el.classList.contains('probe-lamp-off')).toBe(true)
  return 'off'
}

function tooltipOf(testId: string): string | null {
  return screen.getByTestId(testId).getAttribute('data-tooltip')
}

const SURFACES: Array<{
  name: string
  render: () => void
  probeTestId: string
  probingTestId: string
}> = [
  {
    name: 'Control screen',
    render: () => render(React.createElement(ControlPage)),
    probeTestId: 'control-lamp-probe',
    probingTestId: 'control-lamp-probing',
  },
  {
    name: 'Tools/Probe panel',
    render: () => render(React.createElement(ToolsProbePanel)),
    probeTestId: 'tools-probe-lamp-probe',
    probingTestId: 'tools-probe-lamp-probing',
  },
]

describe('WO-2075 PROBE lamp is not read while the spindle turns', () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it('spindle stopped: PROBE reads the input exactly as before', () => {
        setSignals(true, 0)
        surface.render()
        expect(classOf(surface.probeTestId)).toBe('on')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: the probe input is triggered (a touch)')

        setSignals(false, 0)
        expect(classOf(surface.probeTestId)).toBe('off')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: the probe input is clear')

        setSignals(null, 0)
        expect(classOf(surface.probeTestId)).toBe('unavailable')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: not reported by this controller')
      })

      it('spindle turning at speed: PROBE greys out and says why, whatever the input says', () => {
        setSignals(true, 24000)
        surface.render()
        expect(classOf(surface.probeTestId)).toBe('unavailable')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: not read while the spindle turns')

        setSignals(false, 24000)
        expect(classOf(surface.probeTestId)).toBe('unavailable')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: not read while the spindle turns')

        setSignals(null, 24000)
        expect(classOf(surface.probeTestId)).toBe('unavailable')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: not read while the spindle turns')
      })

      it('the ramp up (any rpm > 0) already greys PROBE', () => {
        setSignals(true, 1)
        surface.render()
        expect(classOf(surface.probeTestId)).toBe('unavailable')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: not read while the spindle turns')
      })

      it('startup: reported running (cw) with RPM still at 0 already greys PROBE', () => {
        setSignals(true, 0, null, 'cw')
        surface.render()
        expect(classOf(surface.probeTestId)).toBe('unavailable')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: not read while the spindle turns')
      })

      it('startup: reported running (ccw) with RPM null already greys PROBE', () => {
        setSignals(true, null, null, 'ccw')
        surface.render()
        expect(classOf(surface.probeTestId)).toBe('unavailable')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: not read while the spindle turns')
      })

      it('coast-down: RPM reaches 0 before the reported state clears to off - PROBE stays unavailable', () => {
        setSignals(true, 24000, null, 'cw')
        surface.render()
        expect(classOf(surface.probeTestId)).toBe('unavailable')

        setSignals(true, 0, null, 'cw')
        expect(classOf(surface.probeTestId)).toBe('unavailable')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: not read while the spindle turns')
      })

      it('spinning down back to 0 restores the real input only once both RPM and the reported state clear', () => {
        setSignals(true, 24000, null, 'cw')
        surface.render()
        expect(classOf(surface.probeTestId)).toBe('unavailable')

        setSignals(true, 0, null, 'off')
        expect(classOf(surface.probeTestId)).toBe('on')
        expect(tooltipOf(surface.probeTestId)).toBe('PROBE: the probe input is triggered (a touch)')
      })

      it('PROBING is unaffected: it keeps reading probeCycle while the spindle turns', () => {
        setSignals(false, 24000, true)
        surface.render()
        expect(classOf(surface.probingTestId)).toBe('on')
        expect(tooltipOf(surface.probingTestId)).toBe('PROBING: a probe cycle is in process')
        // PROBE still greys out on the same frame.
        expect(classOf(surface.probeTestId)).toBe('unavailable')

        setSignals(false, 24000, false)
        expect(classOf(surface.probingTestId)).toBe('off')

        setSignals(false, 24000, null)
        expect(classOf(surface.probingTestId)).toBe('unavailable')
        expect(tooltipOf(surface.probingTestId)).toBe('PROBING: not reported by this controller')
      })
    })
  }

  // Negative control named by the WO: on today's main a probe=true frame with
  // the spindle at 24000 lights PROBE. This proves the fix, not just the lamp.
  it('negative control: spindle at speed no longer lights PROBE from a true input', () => {
    setSignals(true, 24000)
    render(React.createElement(ControlPage))
    expect(classOf('control-lamp-probe')).not.toBe('on')
  })
})
