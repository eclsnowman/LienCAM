// @vitest-environment jsdom
//
// WO-1706 REVIEW (safety path) - editing macros must never move the machine,
// and must never lose what a park macro carries.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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
const { useControlJogKeys } = await import('../../hooks/useControlJogKeys')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')
const { __resetMacroRuntimeForTest } = await import('../../lib/machine/macros/macroRuntime')

const PARK: MachineMacro = {
  id: 'park-1',
  name: 'Probe pad',
  body: 'goTo({ x: 12.5, y: 700, z: -2 }, { zFirst: false })',
  mCode: 250,
  usedForToolChange: true,
}
const LIGHTS: MachineMacro = { id: 'lights', name: 'Lights', body: "line('M8')" }

function selectMachine(macros: MachineMacro[]): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo1706-review',
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

function currentMacros(): MachineMacro[] {
  return useCamStore.getState().project.machine.macros ?? []
}

function ControlSurface() {
  useControlJogKeys()
  return <MacroPanel onOpenActions={() => {}} rpm={10000} />
}

afterEach(() => {
  cleanup()
})

describe('WO-1706 review: rename / reorder keep a park macro intact', () => {
  it('renaming a park keeps its body byte-for-byte, its M-code and its tool-change flag; reorder keeps every entry once', () => {
    useMachineActions.setState({ byMachine: {} })
    useCamStore.getState().newProject()
    selectMachine([LIGHTS, PARK])
    render(<ControlSurface />)
    fireEvent.click(screen.getByTestId('control-macros-edit'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Probe pad' }))
    fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: 'Pad' } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    const park = currentMacros().find((m) => m.id === 'park-1')!
    expect(park).toEqual({ ...PARK, name: 'Pad' })

    fireEvent.click(screen.getByRole('button', { name: 'Move Pad up' }))
    expect(currentMacros().map((m) => m.id)).toEqual(['park-1', 'lights'])
    expect(currentMacros()[0]).toEqual({ ...PARK, name: 'Pad' })

    // Two adds in a row get two distinct ids.
    for (const name of ['One', 'Two']) {
      fireEvent.click(screen.getByTestId('macro-editor-add'))
      fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: name } })
      fireEvent.click(screen.getByTestId('macro-editor-save'))
      fireEvent.click(screen.getByTestId('macro-editor-cancel'))
    }
    const ids = currentMacros().map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(4)
  })
})

describe('WO-1706 review: the editor open must not let a key move the machine', () => {
  afterEach(async () => {
    __resetMacroRuntimeForTest()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('arrow key with focus on the editor\'s own Move-up button does not jog', async () => {
    vi.useFakeTimers()
    useMachineActions.setState({ byMachine: {} })
    useCamStore.getState().newProject()
    selectMachine([LIGHTS, PARK])
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    act(() => { useCamStore.getState().setWorkspace('control') })
    expect(useMachineControl.getState().connectionPhase).toBe('connected')

    const jog = vi.spyOn(getMachineController(), 'jog')
    render(<ControlSurface />)
    fireEvent.click(screen.getByTestId('control-macros-edit'))
    expect(screen.getByTestId('macro-editor-modal')).toBeTruthy()

    // The operator clicks "Move Probe pad up" (a browser focuses the button it
    // clicked), then presses the Up arrow key to keep moving it.
    const up = screen.getByRole('button', { name: 'Move Probe pad up' })
    up.focus()
    fireEvent.click(up)
    const down = screen.getByRole('button', { name: 'Move Probe pad down' })
    down.focus()
    fireEvent.keyDown(down, { key: 'ArrowUp' })

    expect(jog).not.toHaveBeenCalled()
  })
})
