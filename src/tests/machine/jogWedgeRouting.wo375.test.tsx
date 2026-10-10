// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { JogPanel } = await import('../../components/machine/JogPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { getMachineController, __resetEstopInterlockForTest } = await import('../../lib/machine/machineSession')

const css = readFileSync('src/styles/app.css', 'utf8')

describe('WO-375 jog wedge hit regions and routing', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
    // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about wedge
    // hit-region routing, not the E-STOP latch, which starts armed by default
    // and would otherwise grey out and refuse every jog press below.
    __resetEstopInterlockForTest()
    useUiPrefs.setState({
      machineJogContinuous: false,
      machineJogStepMm: 10,
      machineJogFeedMmMin: 1000,
      machineDisplayUnits: 'mm',
      collapsedPropsGroups: {},
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
  })

  it('gives each visible triangle its own non-overlapping pointer clip', () => {
    render(<JogPanel />)
    const expected = [
      ['control-jog-y-plus', 'Y', '1', 'wedge-n'],
      ['control-jog-x-plus', 'X', '1', 'wedge-e'],
      ['control-jog-y-minus', 'Y', '-1', 'wedge-s'],
      ['control-jog-x-minus', 'X', '-1', 'wedge-w'],
    ] as const

    for (const [id, axis, sign, regionClass] of expected) {
      const button = screen.getByTestId(id)
      expect(button.dataset.jogAxis).toBe(axis)
      expect(button.dataset.jogSign).toBe(sign)
      expect(button.classList.contains(regionClass)).toBe(true)
    }

    expect(css).toContain('.control-jog-wedge.wedge-n { clip-path: polygon(0 0, 100% 0, 50% 50%); }')
    expect(css).toContain('.control-jog-wedge.wedge-e { clip-path: polygon(100% 0, 100% 100%, 50% 50%); }')
    expect(css).toContain('.control-jog-wedge.wedge-s { clip-path: polygon(100% 100%, 0 100%, 50% 50%); }')
    expect(css).toContain('.control-jog-wedge.wedge-w { clip-path: polygon(0 100%, 0 0, 50% 50%); }')
  })

  it('routes every printed direction to the matching jog axis and sign', () => {
    const jog = vi.spyOn(getMachineController(), 'jog').mockImplementation(() => true)
    render(<JogPanel />)

    for (const [id, axis, distance] of [
      ['control-jog-y-plus', 'Y', 10],
      ['control-jog-x-plus', 'X', 10],
      ['control-jog-y-minus', 'Y', -10],
      ['control-jog-x-minus', 'X', -10],
    ] as const) {
      fireEvent.pointerDown(screen.getByTestId(id))
      expect(jog).toHaveBeenLastCalledWith(axis, distance, 1000)
    }
    expect(jog).toHaveBeenCalledTimes(4)
  })

  it('offers 50 and 100 mm steps and sends the selected distance', () => {
    const jog = vi.spyOn(getMachineController(), 'jog').mockImplementation(() => true)
    render(<JogPanel />)

    const select = screen.getByTestId('control-jog-step-select') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '0.01', '0.1', '1', '10', '50', '100',
    ])

    for (const value of ['50', '100']) {
      fireEvent.change(select, { target: { value } })
      fireEvent.pointerDown(screen.getByTestId('control-jog-y-plus'))
      expect(jog).toHaveBeenLastCalledWith('Y', Number(value), 1000)
    }
  })

  it('keeps equivalent large choices when the display unit is inches', () => {
    useUiPrefs.setState({ machineDisplayUnits: 'inch' })
    render(<JogPanel />)

    const select = screen.getByTestId('control-jog-step-select') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      '0.001', '0.01', '0.1', '1', '2', '4',
    ])
  })

  it('uses one rounded frame instead of letting wedge draw order own corners', () => {
    render(<JogPanel />)
    const pad = screen.getByTestId('control-jog-y-plus').parentElement!
    expect(pad.querySelectorAll('.control-jog-frame')).toHaveLength(1)
    expect(pad.querySelectorAll('.control-jog-seams')).toHaveLength(1)
    expect(pad.querySelectorAll('.control-jog-seam')).toHaveLength(1)
    expect(css).toMatch(/\.control-jog-frame\s*\{[^}]*border-radius:\s*12px;/s)
    expect(css).toMatch(/\.control-jog-wedge \.control-jog-face\s*\{[^}]*stroke:\s*none;/s)
  })
})
