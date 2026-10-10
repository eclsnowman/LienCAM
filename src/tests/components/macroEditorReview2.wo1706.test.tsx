// @vitest-environment jsdom
//
// WO-1706 fresh review after the dialogOpen() fix: an open dialog (macro
// editor, machine actions) stops keyboard jog, AND keyboard jog comes back
// the moment the dialog closes - the fix must not narrow jogging when no
// dialog is on screen.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

type MachineMacro = import('../../types').MachineMacro
const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { MachineActionsModal } = await import('../../components/machine/MachineActionsModal')
const { useControlJogKeys, dialogOpen } = await import('../../hooks/useControlJogKeys')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')
const { __resetMacroRuntimeForTest } = await import('../../lib/machine/macros/macroRuntime')

const LIGHTS: MachineMacro = { id: 'lights', name: 'Lights', body: "line('M8')" }

function selectMachine(macros: MachineMacro[]): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo1706-review2',
    name: 'Review bench',
    controller: 'grbl',
    unsentSettings: undefined,
    travel: { x: 738, y: 724, z: 130 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
    macros,
  })
}

function ControlSurface() {
  useControlJogKeys()
  const [actionsOpen, setActionsOpen] = useState(false)
  return (
    <>
      <MacroPanel onOpenActions={() => setActionsOpen(true)} rpm={10000} />
      <MachineActionsModal open={actionsOpen} onClose={() => setActionsOpen(false)} />
    </>
  )
}

async function connectedOnControl(): Promise<void> {
  useMachineActions.setState({ byMachine: {} })
  useCamStore.getState().newProject()
  selectMachine([LIGHTS])
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  await vi.advanceTimersByTimeAsync(50)
  act(() => { __resetEstopInterlockForTest() })
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(2000)
  act(() => { useCamStore.getState().setWorkspace('control') })
  expect(useMachineControl.getState().connectionPhase).toBe('connected')
}

afterEach(async () => {
  cleanup()
  __resetMacroRuntimeForTest()
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  vi.useRealTimers()
})

describe('WO-1706 review 2: dialogs stop keyboard jog, closed dialogs do not', () => {
  it('arrow key jogs with no dialog, not with the macro editor open, and jogs again once it closes', async () => {
    vi.useFakeTimers()
    await connectedOnControl()
    const jog = vi.spyOn(getMachineController(), 'jog')
    render(<ControlSurface />)

    expect(dialogOpen()).toBe(false)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(jog).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('control-macros-edit'))
    expect(dialogOpen()).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    fireEvent.keyDown(document.body, { key: 'PageUp' })
    expect(jog).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('macro-editor-modal')).toBeNull()
    expect(dialogOpen()).toBe(false)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(jog).toHaveBeenCalledTimes(2)
  })

  it('the machine actions dialog stops keyboard jog while open and releases it on close', async () => {
    vi.useFakeTimers()
    await connectedOnControl()
    const jog = vi.spyOn(getMachineController(), 'jog')
    render(<ControlSurface />)

    fireEvent.click(screen.getByRole('button', { name: /machine actions/i }))
    expect(dialogOpen()).toBe(true)
    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    expect(jog).not.toHaveBeenCalled()

    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(document.querySelector('.modal-backdrop')).toBeNull()
    fireEvent.keyDown(document.body, { key: 'ArrowUp' })
    expect(jog).toHaveBeenCalledTimes(1)
  })
})
