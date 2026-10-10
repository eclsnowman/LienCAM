// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MachineController } from '../../lib/machine/controller'

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
const { connectMachine, disconnectMachine, getMachineController, __resetEstopInterlockForTest } =
  await import('../../lib/machine/machineSession')

describe('WO-1128 one homing cycle at a time', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useCamStore.getState().newProject()
    await connectMachine('simulator')
    // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about the
    // one-cycle-at-a-time request latch, not the fresh-connect E-STOP latch.
    __resetEstopInterlockForTest()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle' })
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await disconnectMachine()
    vi.useRealTimers()
  })

  it('repeated Home All presses send one cycle and every Home control shows busy', () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    const homeAll = screen.getByTestId('control-home')
    fireEvent.click(homeAll)
    fireEvent.click(homeAll)
    fireEvent.click(homeAll)

    expect(homeAxes).toHaveBeenCalledOnce()
    expect(homeAxes).toHaveBeenCalledWith(['Z', 'X', 'Y'])
    expect((homeAll as HTMLButtonElement).disabled).toBe(true)
    expect(homeAll.getAttribute('aria-busy')).toBe('true')
    expect(homeAll.textContent).toContain('Homing...')
    for (const axis of ['z', 'x', 'y']) {
      const button = screen.getByTestId(`control-home-${axis}`)
      expect((button as HTMLButtonElement).disabled).toBe(true)
      expect(button.getAttribute('aria-busy')).toBe('true')
      expect(button.textContent).toContain('...')
    }
  })

  it('a single-axis cycle locks Home All too, then another axis works after completion', () => {
    const homeAxes = vi
      .spyOn(getMachineController() as Required<MachineController>, 'homeAxes')
      .mockReturnValue(true)
    render(<JogPanel />)

    fireEvent.click(screen.getByTestId('control-home-z'))
    fireEvent.click(screen.getByTestId('control-home-x'))
    expect(homeAxes.mock.calls).toEqual([[['Z']]])
    expect((screen.getByTestId('control-home') as HTMLButtonElement).disabled).toBe(true)

    act(() => useMachineControl.setState({ machineState: 'home' }))
    expect((screen.getByTestId('control-home') as HTMLButtonElement).disabled).toBe(true)
    act(() => useMachineControl.setState({ machineState: 'idle' }))
    expect((screen.getByTestId('control-home') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByTestId('control-home-x'))
    expect(homeAxes.mock.calls).toEqual([[['Z']], [['X']]])
  })

  it('an asynchronous refusal that never reports Home releases the request latch', () => {
    vi.spyOn(getMachineController() as Required<MachineController>, 'homeAxes').mockReturnValue(true)
    render(<JogPanel />)

    fireEvent.click(screen.getByTestId('control-home'))
    expect((screen.getByTestId('control-home') as HTMLButtonElement).disabled).toBe(true)
    act(() => vi.advanceTimersByTime(5000))
    expect((screen.getByTestId('control-home') as HTMLButtonElement).disabled).toBe(false)
  })
})
