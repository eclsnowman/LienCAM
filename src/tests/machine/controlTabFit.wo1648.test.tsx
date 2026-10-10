// @vitest-environment jsdom
//
// WO-1648: the Control tab's Machine panel and Spindle / Coolant panel, as the
// operator reads them.
//
//   - the disconnect button says "Disconnect", whatever the connection kind
//     (the picker beside it already names the kind);
//   - the input lights say what they are: a LIMIT caption before X / Y / Z,
//     and DOOR / HOLD in words instead of "D" / "H";
//   - the pendant button and the lamp row both stay in the machine status
//     block (the live gate measures that the pendant is on the controller-name
//     line - jsdom does not lay out);
//   - the Spindle / Coolant panel carries no row without a value or a control:
//     no telemetry row and no "not on this controller" line when the VFD is
//     absent, and no "Coolant" label over Mist / Flood. The telemetry row
//     still appears when there IS telemetry.
//   - WO-1793 (Operator MC 2026-09-20): that row shows the three measurements -
//     volts, amps, torque - with no static "Inverter" caption (it sat beside a
//     live voltage number, named nothing the operator reads, and wrapped in the
//     280px rail) and no inline power segment. RPM is already on the DRO.
//
// The pixel half - pendant on the controller-name line, first four macros
// above the fold at 1440 x 900, no lamp past the panel edge - is measured in a
// real browser by `controlRailFitsAt900.live.test.ts` (WO-1648 pass) and by
// `src/tests/evidence/WO-1648/shoot.mjs`.

import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

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

/** What the live controller reports as `status().spindle` in this file. */
let reportedSpindle: unknown = undefined

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...real,
    getMachineController: () => {
      const controller = real.getMachineController()
      return new Proxy(controller, {
        get(target, prop) {
          if (prop === 'status') return () => ({ ...target.status(), spindle: reportedSpindle })
          const value = Reflect.get(target, prop)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  })
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { SpindlePanel } = await import('../../components/machine/SpindlePanel')
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
    inputs: { ...BASE_INPUTS },
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
}

beforeEach(() => {
  memory.clear()
  reportedSpindle = undefined
  useCamStore.getState().newProject()
  useMachineToolTable.setState({ byMachine: {} })
  connectAs('simulator')
})

afterEach(() => cleanup())

describe('WO-1648: the Machine panel status block', () => {
  it.each(['simulator', 'bridge'] as const)('the disconnect button says exactly "Disconnect" on a %s connection', (kind) => {
    connectAs(kind)
    render(React.createElement(ControlPage))
    expect(screen.getByTestId('control-disconnect').textContent?.trim()).toBe('Disconnect')
  })

  it('names the input lights in words: LIMIT X Y Z, DOOR, HOLD - no bare D or H', () => {
    render(React.createElement(ControlPage))
    const row = screen.getByTestId('control-pin-leds')
    const lights = Array.from(row.querySelectorAll('.control-led')).map((el) => el.textContent)
    expect(lights).toEqual(['X', 'Y', 'Z', 'DOOR', 'HOLD', 'HOME'])
    expect(row.textContent).toContain('LIMIT')
    // The caption reads before the three limit lamps it names.
    expect(row.textContent!.indexOf('LIMIT')).toBeLessThan(row.textContent!.indexOf('XYZ'))
    expect(lights).not.toContain('D')
    expect(lights).not.toContain('H')
  })

  it('DOOR and HOLD still light from their own inputs, and say so', () => {
    render(React.createElement(ControlPage))
    const light = (text: string) =>
      Array.from(screen.getByTestId('control-pin-leds').querySelectorAll('.control-led'))
        .find((el) => el.textContent === text)!
    expect(light('DOOR').classList).not.toContain('control-led-on')
    act(() => { useMachineControl.setState({ inputs: { ...BASE_INPUTS, door: true } }) })
    expect(light('DOOR').classList).toContain('control-led-on')
    expect(light('DOOR').getAttribute('data-tooltip')).toBe('Door input TRIGGERED')
    expect(light('HOLD').classList).not.toContain('control-led-on')
    act(() => { useMachineControl.setState({ inputs: { ...BASE_INPUTS, hold: null } }) })
    expect(light('HOLD').classList).toContain('control-led-unavailable')
    // The caption is words, never a lamp that could read as lit.
    expect(screen.getByTestId('control-pin-leds').querySelector('.control-led-caption')!.classList)
      .not.toContain('control-led')
  })

  it('keeps the pendant button and the lamps in the one machine status block', () => {
    render(React.createElement(ControlPage))
    const status = screen.getByTestId('control-pin-leds').closest('.control-machine-status-row')!
    expect(status).toBeTruthy()
    expect(screen.getByTestId('pendant-status-button').parentElement).toBe(status)
    expect(status.textContent).toContain('PROBE')
    expect(status.textContent).toContain('PROBING')
  })
})

describe('WO-1648: the Spindle / Coolant panel carries no empty rows', () => {
  it('shows no telemetry row and no "not on this controller" when the controller reports no VFD', () => {
    render(React.createElement(SpindlePanel, { onOpenActions: () => {} }))
    expect(screen.queryByTestId('control-spindle-telemetry')).toBeNull()
    expect(screen.queryByText('Inverter')).toBeNull()
    expect(screen.queryByText(/not on this controller/)).toBeNull()
  })

  it('shows the three measurements with no Inverter caption and no power segment once there is telemetry', () => {
    reportedSpindle = {
      linkUp: true, running: false, volts: 220, amps: 1.5, power: 300, torque: 12, upToSpeed: null,
    }
    render(React.createElement(SpindlePanel, { onOpenActions: () => {} }))
    const row = screen.getByTestId('control-spindle-telemetry')
    const values = screen.getByTestId('control-spindle-telemetry-values')
    // The retired caption is gone even when the row renders (WO-1793).
    expect(row.textContent).not.toContain('Inverter')
    // The three measurements Operator named, with the existing honest formatting.
    expect(values.textContent).toContain('220 V')
    expect(values.textContent).toContain('1.5 A')
    expect(values.textContent).toContain('torque 12')
    // The inline power segment is retired: no field, no number, no unit.
    expect(screen.queryByTestId('control-spindle-power')).toBeNull()
    expect(row.textContent).not.toContain('300')
    expect(row.textContent).not.toMatch(/\b(VA|W)\b/)
    // RPM is not duplicated here - the DRO already carries it.
    expect(values.textContent).not.toMatch(/rpm/i)
  })

  it('keeps Mist and Flood with no "Coolant" label row over them', () => {
    render(React.createElement(SpindlePanel, { onOpenActions: () => {} }))
    expect(screen.getByTestId('control-coolant-mist')).toBeTruthy()
    expect(screen.getByTestId('control-coolant-flood')).toBeTruthy()
    expect(screen.queryByText('Coolant')).toBeNull()
    expect(screen.queryByText('Coolant / Vacuum')).toBeNull()
    // Every control the panel had is still there.
    for (const id of ['control-spindle-cw', 'control-spindle-ccw', 'control-spindle-off', 'control-spindle-gear']) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }
  })
})
