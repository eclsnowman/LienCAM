// @vitest-environment jsdom
//
// WO-962 (folded into WO-1707): macro order is a deliberate, per-machine
// setting. WO-1707 retired the separate custom-button arrangement system
// (its own store, hide/show) - a macro's order now lives on the macro list
// itself, on the machine record, moved in `MacroEditor`'s own up/down - so
// this proves THAT is what the panel follows, per machine, and that moving a
// confirm-first macro never drops its guard.

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { MacroEditor } = await import('../../components/machine/MacroEditor')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { useCamStore } = await import('../../store')
const { useMachineActions, saveParkMachineRecord } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')

type MachineMacro = import('../../types').MachineMacro

const MACROS: MachineMacro[] = [
  { id: 'vacuum', name: 'Vacuum', body: "line('M8')" },
  { id: 'all-off', name: 'ALL OFF', body: "line('M5')\nline('M9')", confirm: true, color: 'red' },
  { id: 'lights', name: 'Lights', body: "line('M64 P1')" },
]

// `saveParkMachineRecord` - the same door MacroEditor's own save/move/remove
// use - writes both the library entry and the project's copy when they are
// the same machine (`parkCarrierMachine` prefers the library entry), so a
// seed through plain `setProjectMachine` alone would be invisible to it.
function seed(macros: MachineMacro[] = MACROS): void {
  const machine = useCamStore.getState().project.machine
  saveParkMachineRecord({ ...machine, macros })
}

function panelButtonLabels(): string[] {
  return within(screen.getByTestId('control-user-macro-grid'))
    .getAllByRole('button')
    .map((button) => button.textContent?.trim() ?? '')
}

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineControl.setState({
      connectionPhase: 'connected',
      machineState: 'idle',
      job: { ...useMachineControl.getState().job, phase: 'empty' },
    })
  })
})

afterEach(cleanup)

describe('WO-962/WO-1707: macro order from the macro editor', () => {
  it('reorders in the editor; the panel follows while the record stays the one source', () => {
    seed()
    render(
      <>
        <MacroEditor open onClose={() => {}} />
        <MacroPanel onOpenActions={() => {}} rpm={10000} />
      </>,
    )

    fireEvent.click(screen.getByLabelText('Move Lights up'))
    fireEvent.click(screen.getByLabelText('Move Lights up'))

    expect(panelButtonLabels()).toEqual(['Lights', 'Vacuum', 'ALL OFF'])
    expect(useCamStore.getState().project.machine.macros?.map((m) => m.name))
      .toEqual(['Lights', 'Vacuum', 'ALL OFF'])
  })

  it('moving a dangerous macro preserves confirmation before it can run', () => {
    const reordered = [MACROS[1], MACROS[0], MACROS[2]]
    seed(reordered)
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)

    expect(panelButtonLabels()).toEqual(['ALL OFF', 'Vacuum', 'Lights'])

    fireEvent.click(within(screen.getByTestId('control-user-macro-grid')).getByText('ALL OFF'))
    expect(within(screen.getByTestId('control-user-macro-grid')).getByText('Press again')).toBeTruthy()
  })

  it('keeps macro order isolated per machine', () => {
    const base = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({ ...base, id: 'router-a', macros: MACROS })
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    expect(panelButtonLabels()).toEqual(['Vacuum', 'ALL OFF', 'Lights'])
    cleanup()

    useCamStore.getState().setProjectMachine({
      ...useCamStore.getState().project.machine,
      id: 'router-b',
      macros: [MACROS[2], MACROS[1], MACROS[0]],
    })
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    expect(panelButtonLabels()).toEqual(['Lights', 'ALL OFF', 'Vacuum'])
  })
})
