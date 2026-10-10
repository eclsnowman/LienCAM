// @vitest-environment jsdom
//
// WO-2074 - the Routines tab's factory Bore centre and Inside corner get a
// `topZ` input, the same way bossRoutineForMachine fills the boss's
// crossOverZ (ProbeRoutineEditor.tsx WO-2052): the tab fills its default from
// the active work offset's Z0 (machine Z), named with its coordinate system
// (Operator's rule: "G54 Z 0 (machine Z 43.78)"). The routine's steps do not
// change here (WO-2065 reads this input later); the operator can still type
// a different top (e.g. a rim he touched).
//
// Negative control: before this change, FACTORY_BORE_CENTRE and the factory
// Inside corner routines (probeRoutineFactory.ts) declared no `topZ` input at
// all, so `probe-routine-input-topZ` did not exist for either routine.

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

const { ProbeRoutinesTab } = await import('../../components/machine/ProbeRoutinesTab')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

function connectedAt(wcs: 'G54' | 'G55', z: number) {
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    activeWcs: wcs,
    offsets: { [wcs]: [0, 0, z] },
    activeTool: null,
    tlo: null,
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
}

function topZRow() {
  return screen.getByTestId('probe-routine-input-topZ')
}

function topZPlaceholder(): string | null {
  return screen.getByTestId('probe-routine-input-value-topZ').getAttribute('placeholder')
}

beforeEach(() => {
  memory.clear()
  useCamStore.getState().newProject()
})

afterEach(() => cleanup())

describe('WO-2074: the factory Bore centre knows work Z0 as its top', () => {
  it('picking Bore centre fills topZ from the active work offset, named with its coordinate system', () => {
    connectedAt('G54', 43.78)
    render(createElement(ProbeRoutinesTab))
    fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.bore-centre' } })
    expect(topZPlaceholder()).toBe('default 43.78')
    expect(topZRow().textContent).toContain('G54 Z 0 (machine Z 43.78)')
  })

  it('editing the active work offset updates the shown default while Bore centre is still unedited', () => {
    connectedAt('G54', 43.78)
    render(createElement(ProbeRoutinesTab))
    fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.bore-centre' } })
    expect(topZPlaceholder()).toBe('default 43.78')
    act(() => { useMachineControl.setState({ offsets: { G54: [0, 0, 12.5] } }) })
    expect(topZPlaceholder()).toBe('default 12.5')
    expect(topZRow().textContent).toContain('G54 Z 0 (machine Z 12.5)')
  })

  it('switching the active work coordinate system renames and refills the default', () => {
    connectedAt('G54', 43.78)
    render(createElement(ProbeRoutinesTab))
    fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.bore-centre' } })
    act(() => { useMachineControl.setState({ activeWcs: 'G55', offsets: { G54: [0, 0, 43.78], G55: [0, 0, -7] } }) })
    expect(topZPlaceholder()).toBe('default -7')
    expect(topZRow().textContent).toContain('G55 Z 0 (machine Z -7)')
  })

  it('a typed value on topZ survives a work offset change (dirty pick does not follow)', () => {
    connectedAt('G54', 43.78)
    render(createElement(ProbeRoutinesTab))
    fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.bore-centre' } })
    fireEvent.change(screen.getByTestId('probe-routine-input-topZ-default'), { target: { value: '99' } })
    act(() => { useMachineControl.setState({ offsets: { G54: [0, 0, 5] } }) })
    expect((screen.getByTestId('probe-routine-input-topZ-default') as HTMLInputElement).value).toBe('99')
  })
})

describe('WO-2074: the factory Inside corner routines know work Z0 as their top', () => {
  it('picking Inside corner (front-left) fills topZ from the active work offset', () => {
    connectedAt('G54', 20)
    render(createElement(ProbeRoutinesTab))
    fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: 'factory.corner.inside.x-plus.y-plus' } })
    expect(topZPlaceholder()).toBe('default 20')
    expect(topZRow().textContent).toContain('G54 Z 0 (machine Z 20)')
  })

  it('every Inside corner variant declares the same topZ input', () => {
    connectedAt('G54', 8)
    render(createElement(ProbeRoutinesTab))
    for (const id of [
      'factory.corner.inside.x-minus.y-minus',
      'factory.corner.inside.x-plus.y-minus',
      'factory.corner.inside.x-minus.y-plus',
      'factory.corner.inside.x-plus.y-plus',
    ]) {
      fireEvent.change(screen.getByTestId('probe-routine-select'), { target: { value: id } })
      expect(topZPlaceholder()).toBe('default 8')
    }
  })
})
