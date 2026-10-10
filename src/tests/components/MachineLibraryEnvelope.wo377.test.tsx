// @vitest-environment jsdom
//
// WO-377: the Machine Library shows the SIGNED machine range beside each axis
// (live with switch end / zero end / travel) and says in plain words where
// home lands; max/max and min/min save as typed with the negative-coordinate
// result explained, never silently rewritten.
//
// WO-1775: the fixture's controller follows the behavior each case proves.
// WO-1755 made GRBL-family zero fixed at the homing switch
// (`controllerZeroIsHomeSwitch`), so a 'grbl' record has no configurable
// zero-location editor. The cases that drive that editor declare 'uccnc';
// the GRBL fixed-switch-zero envelope facts stay 'grbl'.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ControllerType, MachineConfig } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { useCamStore } = await import('../../store')
const realUpdateMachineInLibrary = useCamStore.getState().updateMachineInLibrary

/** Operator's machine as stored. `controller` is part of the fixture on purpose
 *  (WO-1775): 'grbl' omits the "machine zero location" editor entirely because
 *  its firmware pins zero to the home switch (`controllerZeroIsHomeSwitch`,
 *  WO-1755); the configurable zero-end behavior is proven on 'uccnc'. The id
 *  stays 'operator' either way - only the controller adapts to the behavior. */
function sampleMachineMachine(controller: ControllerType = 'grbl'): MachineConfig {
  return {
    id: 'operator', name: 'Operator Machine', type: 'gantry_router', controller,
    travel: { x: 738, y: 724.5, z: 128.9 }, rapidRate: 5000,
    homeConvention: {
      x: { homesToward: 'max', machineZeroAt: 'max' },
      y: { homesToward: 'max', machineZeroAt: 'max' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
    maxSpindleRpm: 24000, minSpindleRpm: 8000, spindleDirection: 'cw',
    toolChanger: 'manual', coolant: false, notes: '',
  }
}

function openModal(controller: ControllerType = 'grbl') {
  act(() => { useCamStore.setState({ machineLibrary: [sampleMachineMachine(controller)] }) })
  render(<MachineLibraryModal />)
  act(() => { useCamStore.getState().openModal('machine-config') })
  fireEvent.click(screen.getByTestId('disclosure-machine-home-convention'))
}

const rangeText = (axis: string) => screen.getByTestId(`machine-envelope-range-${axis}`).textContent
const sentence = (axis: string) => screen.getByTestId(`machine-envelope-sentence-${axis}`).textContent ?? ''

afterEach(() => {
  cleanup()
  useCamStore.setState({ updateMachineInLibrary: realUpdateMachineInLibrary })
})

beforeEach(() => {
  act(() => {
    useCamStore.setState((s) => ({
      machineLibrary: [sampleMachineMachine()],
      updateMachineInLibrary: realUpdateMachineInLibrary,
      appSettings: { ...s.appSettings, defaultMachineId: null, displayUnits: 'mm' },
    }))
    useCamStore.getState().closeModal()
  })
})

describe('WO-377 Machine Library signed envelope preview', () => {
  it("shows Operator's max/max Y 724.5 as -724.5 .. 0 with home at the maximum end", () => {
    openModal()
    expect(rangeText('y')).toBe('-724.5 .. 0')
    expect(rangeText('x')).toBe('-738 .. 0')
    expect(rangeText('z')).toBe('-128.9 .. 0')
    expect(screen.getByTestId('machine-envelope-range-y').getAttribute('data-envelope-negative')).toBe('true')
    expect(sentence('y')).toContain('Y runs -724.5 to 0')
    expect(sentence('y')).toContain('home lands at Y 0, the maximum end')
    expect(sentence('y')).toContain('entirely in negative Y')
    expect(sentence('y')).toContain('saved as typed')
  })

  it('updates live for every switch/zero combination', () => {
    // The four switch/zero combinations need the configurable zero-end
    // editor, which a GRBL-family controller does not offer (WO-1755);
    // UCCNC does. Every range/sentence assertion below is unchanged.
    openModal('uccnc')
    const sw = screen.getByLabelText('Y home switch location') as HTMLSelectElement
    const zero = screen.getByLabelText('Y machine zero location') as HTMLSelectElement

    fireEvent.change(zero, { target: { value: 'min' } })      // max/min
    expect(rangeText('y')).toBe('0 .. 724.5')
    expect(sentence('y')).toContain('home lands at Y 724.5, the maximum end')
    expect(screen.getByTestId('machine-envelope-range-y').getAttribute('data-envelope-negative')).toBe('false')

    fireEvent.change(sw, { target: { value: 'min' } })        // min/min
    expect(rangeText('y')).toBe('0 .. 724.5')
    expect(sentence('y')).toContain('home lands at Y 0, the minimum end')
    expect(sentence('y')).not.toContain('negative')

    fireEvent.change(zero, { target: { value: 'max' } })      // min/max
    expect(rangeText('y')).toBe('-724.5 .. 0')
    expect(sentence('y')).toContain('home lands at Y -724.5, the minimum end')
    expect(sentence('y')).toContain('entirely in negative Y')

    fireEvent.change(sw, { target: { value: 'max' } })        // back to max/max
    expect(rangeText('y')).toBe('-724.5 .. 0')
    expect(sentence('y')).toContain('home lands at Y 0, the maximum end')
  })

  it('follows a travel edit live', () => {
    openModal()
    fireEvent.click(screen.getByTestId('disclosure-machine-travel'))
    const travelSection = screen.getByTestId('disclosure-machine-travel').closest('.disclosure-section')
    const yInput = travelSection?.querySelectorAll('input')[1] as HTMLInputElement
    fireEvent.focus(yInput)
    fireEvent.change(yInput, { target: { value: '600' } })
    fireEvent.blur(yInput)
    expect(rangeText('y')).toBe('-600 .. 0')
    expect(sentence('y')).toContain('Y runs -600 to 0')
  })

  it('saves max/max as typed - no silent rewrite of the negative result', () => {
    // Types the X zero-end editor twice, so it needs the controller that
    // has one (UCCNC); the as-typed save result asserted below is unchanged.
    const updateMachineInLibrary = vi.fn()
    act(() => { useCamStore.setState({ updateMachineInLibrary }) })
    openModal('uccnc')
    fireEvent.change(screen.getByLabelText('X machine zero location'), { target: { value: 'min' } })
    fireEvent.change(screen.getByLabelText('X machine zero location'), { target: { value: 'max' } })
    fireEvent.click(screen.getByText('Save Changes'))
    expect(updateMachineInLibrary).toHaveBeenCalledTimes(1)
    expect(updateMachineInLibrary.mock.calls[0][0]).toBe('operator')
    const saved = updateMachineInLibrary.mock.calls[0][1] as MachineConfig
    expect(saved.homeConvention?.y).toEqual({ homesToward: 'max', machineZeroAt: 'max' })
    expect(saved.homeConvention?.x).toEqual({ homesToward: 'max', machineZeroAt: 'max' })
    expect(saved.travel.y).toBe(724.5)
  })

  it('says "no datum" when the machine declares no homing switches', () => {
    openModal()
    const toggle = screen.getByRole('checkbox') as HTMLInputElement
    fireEvent.click(toggle)
    expect(rangeText('y')).toBe('no datum')
    expect(screen.getByTestId('machine-envelope-sentence-none').textContent).toContain('No homing switches')
  })
})
