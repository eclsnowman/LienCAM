// @vitest-environment jsdom
// WO-2001: the Control tab stops nagging - the Single Block row prints only
// when the mode CHANGES, and disabled buttons say why.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const { ControlStepRow, ControlTransportBar, resetTransportStatusConsole } =
  await import('../../components/machine/ControlTransportBar')
const { RE_ARM_REFUSAL } = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')

const PROGRAM = 'G21 G90 G54\nG0 X0 Y0 Z5\nG1 X10 F300\nM30\n'

beforeEach(() => {
  cleanup()
  resetTransportStatusConsole()
  useMachineControl.setState({
    consoleLines: [],
    singleBlock: false,
    programText: PROGRAM,
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    machineState: 'idle',
    homed: true,
  })
})
afterEach(cleanup)

describe('WO-2001: Single Block console row', () => {
  it('starting and ending a run keeps the Re-arm reason in place without echoing it or "Single Block OFF"', () => {
    const job = useMachineControl.getState().job
    act(() => { useMachineControl.setState({ job: { ...job, phase: 'ready' } }) })
    render(<ControlStepRow />)
    act(() => { useMachineControl.setState({ job: { ...job, phase: 'streaming' } }) })
    const reason = screen.getByTestId('control-rearm-reason')
    expect(reason.textContent).toBe(RE_ARM_REFUSAL.running)
    act(() => { useMachineControl.setState({ job: { ...job, phase: 'ready' } }) })
    const texts = useMachineControl.getState().consoleLines.map((l) => l.text)
    expect(texts).toEqual([])
  })

  it('a real mode flip still writes its one line', () => {
    render(<ControlStepRow />)
    act(() => { useMachineControl.setState({ singleBlock: true }) })
    const texts = useMachineControl.getState().consoleLines.map((l) => l.text)
    expect(texts.filter((t) => t.includes('Single Block ON'))).toHaveLength(1)
  })
})

describe('WO-2001: disabled buttons explain themselves', () => {
  it('Feed Hold and Single Block carry a reason while disabled', () => {
    useMachineControl.setState({ connectionPhase: 'disconnected' })
    render(<ControlTransportBar />)
    const hold = screen.getByTestId('control-feedhold')
    expect(hold.hasAttribute('disabled')).toBe(true)
    expect(hold.getAttribute('data-tooltip')).toContain('Connect')
    cleanup()
    render(<ControlStepRow />)
    const sb = screen.getByTestId('control-singleblock-toggle')
    expect(sb.getAttribute('data-tooltip')).toContain('Connect')
  })
})
