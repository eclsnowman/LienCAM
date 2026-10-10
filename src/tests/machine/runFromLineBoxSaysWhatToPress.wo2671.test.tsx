// @vitest-environment jsdom
//
// WO-2671 (machine session 2026-10-07): "it's not totally clear for the
// user what they have to hit to start. What does it mean armed review this
// plan?" The Run from line plan box - and the material fit trace confirm
// card, which said the same thing - ends with ONE plain next step: press
// CYCLE START, or Cancel to go back. No "Armed", no "fixed", and no direction
// word ("above") that is wrong at the 1680x979 layout, where CYCLE START sits
// to the RIGHT of the box.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'

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

const { useMachineControl } = await import('../../store/machineControlStore')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { __resetEstopInterlockForTest, loadMachineProgram } =
  await import('../../lib/machine/machineSession')

// The operator's file shape (final-o9-comments-first.nc): comments first, the cut at line 10.
const PROGRAM = [
  '(O9 comments first)', // 1
  '(T1 6mm flat)', // 2
  'G21 G90 G54', // 3
  'M3 S12000', // 4
  'G0 X0 Y0', // 5
  'G0 Z5', // 6
  'G1 Z-2 F300', // 7
  'G1 X10 Y0 F600', // 8
  'G1 X20 Y0', // 9
  'G1 X20 Y20', // 10
  'M5', // 11
  'M30', // 12
].join('\n')

/** The developer words and the wrong direction the operator read on the box. */
const BANNED = /\bArmed\b|\bfixed\b|\babove\b/i

async function planFromLine(line: number): Promise<void> {
  fireEvent.change(screen.getByTestId('control-runfrom-input'), {
    target: { value: String(line) },
  })
  await act(async () => {
    fireEvent.click(screen.getByTestId('control-runfrom-plan'))
  })
}

describe('WO-2671: the Run from line box says plainly what to press', () => {
  beforeEach(() => {
    loadMachineProgram('final-o9-comments-first.nc', PROGRAM)
    useMachineControl.getState().setSingleBlock(false)
  })

  afterEach(() => {
    cleanup()
    useMachineControl.getState().setSingleBlock(false)
  })

  it('ends with "Press CYCLE START to run from line 10. Cancel to go back." and no Armed/fixed/above', async () => {
    render(<ProgramPanel />)
    await planFromLine(10)

    const box = screen.getByTestId('control-runfrom-planbox')
    // The plan lines stay: what resumes and where.
    expect(screen.getByTestId('control-runfrom-target').textContent).toBe('10: G1 X20 Y20')
    expect(screen.getByTestId('control-runfrom-resume').textContent).toContain('Resume position')

    // Behaviour first (fails on main at the wording, not at a missing test id).
    expect(box.textContent).not.toMatch(BANNED)
    expect(box.textContent).toContain('Press CYCLE START to run from line 10. Cancel to go back.')
    expect(screen.getByTestId('control-runfrom-next-step').textContent).toBe(
      'Press CYCLE START to run from line 10. Cancel to go back.',
    )
    // The Cancel the sentence names is the box's own button, and it backs out.
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(box.contains(cancel)).toBe(true)
    await act(async () => { fireEvent.click(cancel) })
    expect(screen.queryByTestId('control-runfrom-planbox')).toBeNull()
  })

  it('with Single Block on, the same sentence says one block at a time', async () => {
    useMachineControl.getState().setSingleBlock(true)
    render(<ProgramPanel />)
    await planFromLine(10)

    expect(screen.getByTestId('control-runfrom-planbox').textContent).not.toMatch(BANNED)
    expect(screen.getByTestId('control-runfrom-next-step').textContent).toBe(
      'Press CYCLE START to run from line 10, one block at a time. Cancel to go back.',
    )
  })
})

describe('WO-2671: the material fit trace confirm card says it the same way', () => {
  beforeEach(() => {
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      homed: true,
      fitTrace: null,
      toolChange: null,
    })
    act(() => { __resetEstopInterlockForTest() })
  })

  afterEach(() => {
    cleanup()
    useMachineControl.setState({ fitTrace: null })
  })

  it('names CYCLE START and Cancel, with no fixed/above', () => {
    render(<><ControlTransportBar /><ProgramPanel /></>)
    act(() =>
      useMachineControl.getState().setFitTrace({
        step: 'confirm',
        message: 'The machine will raise to safe Z, then trace.',
        bounds: { minX: 10, minY: 10, maxX: 20, maxY: 20 },
        lines: ['G21 G90', 'G53 G0 Z-2', 'G1 X10 Y10 F1000'],
      }),
    )
    const card = screen.getByTestId('control-fittrace-card')
    expect(card.textContent).toContain('Press CYCLE START to trace the outline. Cancel to go back.')
    expect(card.textContent).not.toMatch(BANNED)
    // The button the sentence names is the real one, and it is live.
    expect((screen.getByTestId('control-cyclestart') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('control-fittrace-cancel').textContent).toBe('Cancel')
  })
})
