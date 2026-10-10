// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ControlStepRow, ControlTransportBar } from '../../components/machine/ControlTransportBar'
import { __resetEstopInterlockForTest } from '../../lib/machine/machineSession'
import { useMachineControl } from '../../store/machineControlStore'

function setReadyFit(state: 'partial' | 'outside'): void {
  useMachineControl.setState((current) => ({
    connectionPhase: 'connected',
    connectionKind: 'simulator',
    machineState: 'idle',
    homed: true,
    activeWcs: 'G54',
    job: {
      ...current.job,
      phase: 'ready',
      name: 'fit.nc',
      totalLines: 2,
      sentLines: 0,
      ackedLines: 0,
    },
    programText: 'G1 X10\nM30',
    programReadiness: { ready: true, reason: 'Program checks passed.' },
    programFit: {
      state,
      sentence: state === 'outside'
        ? 'OUTSIDE - Program (after G54) lies entirely off the table on X (X: program 10..20, table -100..0, machine coordinates).'
        : 'PARTLY OUTSIDE - Program (after G54) runs partly off the table on X (X: program -10..10, table -100..0, machine coordinates).',
    },
    singleBlock: true,
    fitTrace: null,
    toolChange: null,
  }))
}

function renderBoth(): void {
  render(
    <>
      <ControlTransportBar sections="row" />
      <ControlStepRow />
    </>,
  )
}

beforeEach(() => {
  cleanup()
  __resetEstopInterlockForTest()
})

afterEach(() => {
  cleanup()
  __resetEstopInterlockForTest()
})

describe('WO-1155 transport control parity', () => {
  it('disables CYCLE START and Step for an outside program', () => {
    setReadyFit('outside')
    renderBoth()

    expect((screen.getByTestId('control-cyclestart') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('control-step-forward') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('control-next-action').textContent).toContain('entirely off the table on X')
    expect(screen.queryByTestId('control-program-fit')).toBeNull()
  })

  it('keeps CYCLE START and Step enabled for a partial program', () => {
    setReadyFit('partial')
    renderBoth()

    expect((screen.getByTestId('control-cyclestart') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByTestId('control-step-forward') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('control-next-action').textContent)
      .toBe('Single Block is ON. CYCLE START executes one block.')
  })
})
