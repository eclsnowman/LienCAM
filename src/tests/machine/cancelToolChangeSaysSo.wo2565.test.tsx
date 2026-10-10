// @vitest-environment jsdom
// Card boundary checks complement the real bridge/simulator flows in WO-2521.
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useMachineControl } from '../../store/machineControlStore'
import type { ToolChangeState } from '../../store/machineControlStore'
import { useCamStore } from '../../store'
import { ProgramPanel } from '../../components/machine/ProgramPanel'
import { cancelGuidedToolChange, cancelGuidedToolChangeByOperator } from '../../lib/machine/machineSession'

function showCard(step: ToolChangeState['step'], tool: number | null = 19, mode: ToolChangeState['mode'] = 'toolChange') {
  act(() => useMachineControl.getState().setToolChange({ mode, step, tool, resumeLine: 4, message: 'Test boundary', warnings: [] }))
  render(createElement(ProgramPanel))
}

describe('WO-2565: the card reports only its operator cancellation and keeps the fitted record', () => {
  beforeEach(() => {
    useCamStore.getState().newProject()
    useMachineControl.setState({ activeTool: 3, toolChange: null, consoleLines: [] })
  })
  afterEach(() => { cleanup(); cancelGuidedToolChange() })

  it('unknown spindle tool omits the spindle sentence', () => {
    useMachineControl.setState({ activeTool: null })
    showCard('awaiting-swap')
    fireEvent.click(screen.getByTestId('control-tc-cancel'))
    expect(useMachineControl.getState().consoleLines).toEqual([
      expect.objectContaining({ severity: 'info', text: 'Tool change to T19 cancelled - nothing was measured.' }),
    ])
    expect(useMachineControl.getState().activeTool).toBeNull()
  })

  it('ready means the swap happened: Cancel keeps T19 and does not claim nothing was measured', () => {
    showCard('ready')
    expect(useMachineControl.getState().activeTool).toBe(19)
    fireEvent.click(screen.getByTestId('control-tc-cancel'))
    expect(useMachineControl.getState().activeTool).toBe(19)
    expect(useMachineControl.getState().consoleLines).toEqual([
      expect.objectContaining({ severity: 'info', text: 'Tool change to T19 cancelled. T19 is still the tool in the spindle.' }),
    ])
  })

  for (const swapped of [false, true]) {
    it(`Close on a failed card reports once, swap confirmed = ${swapped}`, () => {
      if (swapped) useMachineControl.getState().setToolChange({ mode: 'toolChange', step: 'probing', tool: 19, resumeLine: 4, message: 'Measuring', warnings: [] })
      showCard('failed')
      expect(screen.getByTestId('control-tc-cancel').textContent).toBe('Close')
      fireEvent.click(screen.getByTestId('control-tc-cancel'))
      const tool = swapped ? 19 : 3
      expect(useMachineControl.getState().activeTool).toBe(tool)
      expect(useMachineControl.getState().consoleLines).toEqual([
        expect.objectContaining({ severity: 'info', text: `Tool change to T19 closed. T${tool} is still the tool in the spindle.` }),
      ])
    })
  }

  it('after a probe miss returns to awaiting-swap, Cancel names the already fitted tool', () => {
    useMachineControl.getState().setToolChange({ mode: 'toolChange', step: 'probing', tool: 19, resumeLine: 4, message: 'Measuring', warnings: [] })
    showCard('awaiting-swap')
    fireEvent.click(screen.getByTestId('control-tc-cancel'))
    expect(useMachineControl.getState().activeTool).toBe(19)
    expect(useMachineControl.getState().consoleLines).toEqual([
      expect.objectContaining({ severity: 'info', text: 'Tool change to T19 cancelled - nothing was measured. T19 is still the tool in the spindle.' }),
    ])
  })

  it('silent cleanup, an absent card and clamp pauses do not acquire tool-change messages', () => {
    showCard('awaiting-swap')
    act(() => cancelGuidedToolChange())
    cancelGuidedToolChangeByOperator()
    expect(useMachineControl.getState().consoleLines).toHaveLength(0)
    cleanup()
    showCard('awaiting-swap', null, 'clampPause')
    fireEvent.click(screen.getByTestId('control-tc-cancel'))
    expect(useMachineControl.getState().consoleLines).toHaveLength(0)
    expect(useMachineControl.getState().activeTool).toBe(3)
  })
})
