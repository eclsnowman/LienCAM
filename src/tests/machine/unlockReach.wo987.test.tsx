// @vitest-environment jsdom
//
// WO-987: Unlock must be reachable at first power-up, when the connected
// machine is idle but its position is still unknown. The button remains the
// existing alarm-clear control; these tests change only when it can be pressed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { JogPanel } = await import('../../components/machine/JogPanel')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { getMachineController, __resetEstopInterlockForTest } = await import('../../lib/machine/machineSession')

function unlockButton(): HTMLButtonElement {
  return screen.getByTestId('control-unlock') as HTMLButtonElement
}

describe('WO-987 Unlock reachability', () => {
  beforeEach(() => {
    mem.clear()
    useCamStore.getState().newProject()
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: false,
      alarm: null,
    })
    // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about
    // Unlock's OWN reachability gate, not the E-STOP latch.
    __resetEstopInterlockForTest()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('reaches the existing unlock command when connected, idle, and unhomed', () => {
    const unlock = vi.spyOn(getMachineController(), 'unlock').mockReturnValue(true)
    render(<JogPanel />)

    const button = unlockButton()
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('data-tooltip'))
      .toBe('Clear the alarm lock ($X) - confirm position is safe first')
    fireEvent.click(button)

    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it('keeps the existing alarm-clear path reachable', () => {
    useMachineControl.setState({ machineState: 'alarm' })
    const unlock = vi.spyOn(getMachineController(), 'unlock').mockReturnValue(true)
    render(<JogPanel />)

    fireEvent.click(unlockButton())

    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it('watches a disconnected press fail before it can call unlock', () => {
    useMachineControl.setState({ connectionPhase: 'disconnected' })
    const unlock = vi.spyOn(getMachineController(), 'unlock').mockReturnValue(true)
    render(<JogPanel />)

    fireEvent.click(unlockButton())

    expect(unlock).not.toHaveBeenCalled()
  })
})
