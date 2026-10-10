// @vitest-environment jsdom
//
// WO-1706 - MAKE, EDIT, REMOVE AND REORDER MACROS IN THE APP.
//
// WO-1680 put macros on the machine record and showed them as buttons.
// WO-1681 made parks into macros. Until this order there was no way in the
// app to create, rename, edit, delete or reorder one - the Macros panel's
// "Edit macros" control (MacroEditor.tsx) is that door, writing back through
// the same machine-record save path the panel's tool-change flag already
// uses (`saveParkMachineRecord`).

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')
const { __resetMacroRuntimeForTest } = await import('../../lib/machine/macros/macroRuntime')

function selectMachine(macros: MachineMacro[] | undefined): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo1706-macro-editor',
    name: 'Macro editor test bench',
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

function renderPanel(): void {
  render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
}

function openEditor(): void {
  fireEvent.click(screen.getByTestId('control-macros-edit'))
}

function currentMacros(): MachineMacro[] {
  return useCamStore.getState().project.machine.macros ?? []
}

afterEach(() => {
  cleanup()
})

describe('WO-1706: editing a machine\'s macros with no connection needed', () => {
  const A: MachineMacro = { id: 'a', name: 'Lights', body: "line('M8')\nline('M9')" }
  const B: MachineMacro = { id: 'b', name: 'Vacuum corner', body: "output('vacuum', true)" }

  beforeEach(() => {
    useMachineActions.setState({ byMachine: {} })
    useCamStore.getState().newProject()
    selectMachine([A, B])
  })

  it('add, rename, reorder and delete - the panel shows exactly the saved list, in the saved order', () => {
    renderPanel()
    openEditor()
    expect(screen.getByTestId('macro-editor-modal')).toBeTruthy()

    // Add a third macro.
    fireEvent.click(screen.getByTestId('macro-editor-add'))
    fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: 'Vacuum on' } })
    fireEvent.change(screen.getByTestId('macro-editor-body'), { target: { value: "line('M7')" } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    expect(currentMacros().map((m) => m.name)).toEqual(['Lights', 'Vacuum corner', 'Vacuum on'])

    // Rename the first.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lights' }))
    fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: 'Lights v2' } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    expect(currentMacros().map((m) => m.name)).toEqual(['Lights v2', 'Vacuum corner', 'Vacuum on'])

    // Move the third to the top.
    fireEvent.click(screen.getByRole('button', { name: 'Move Vacuum on up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move Vacuum on up' }))
    expect(currentMacros().map((m) => m.name)).toEqual(['Vacuum on', 'Lights v2', 'Vacuum corner'])

    // Delete the second (now "Vacuum corner", still in the middle).
    fireEvent.click(screen.getByRole('button', { name: 'Delete Vacuum corner' }))
    expect(currentMacros().map((m) => m.name)).toEqual(['Vacuum on', 'Lights v2'])

    fireEvent.click(screen.getByLabelText('Close'))

    const grid = screen.getByTestId('control-user-macro-grid')
    expect(Array.from(grid.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Vacuum on', 'Lights v2'])
    expect(currentMacros().map((m) => m.name)).toEqual(['Vacuum on', 'Lights v2'])
  })

  it('set and clear an M-code', () => {
    renderPanel()
    openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lights' }))
    fireEvent.change(screen.getByTestId('macro-editor-mcode'), { target: { value: '300' } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    expect(currentMacros().find((m) => m.name === 'Lights')?.mCode).toBe(300)

    // The form for "Lights" is still open after Save - the pencil now toggles it shut.
    fireEvent.change(screen.getByTestId('macro-editor-mcode'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    expect(currentMacros().find((m) => m.name === 'Lights')?.mCode).toBeUndefined()
  })

  it('two macros bound to the same M-code: the editor says which two, and keeps both', () => {
    selectMachine([{ ...A, mCode: 300 }, { ...B, mCode: 300 }])
    renderPanel()
    openEditor()
    const banner = screen.getByTestId('macro-editor-conflict-M300')
    expect(banner.textContent).toBe('M300 is bound to "Lights" and "Vacuum corner" - typing M300 runs "Lights" (the first one in the list).')
    expect(currentMacros().map((m) => m.mCode)).toEqual([300, 300])
  })

  it('a body with a syntax error saves, and the editor shows the sandbox\'s own error text for it', () => {
    renderPanel()
    openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lights' }))
    fireEvent.change(screen.getByTestId('macro-editor-body'), { target: { value: "line('M8')\nline('M9'" } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    // Saved despite not parsing (rule 11: nothing new refuses).
    expect(currentMacros().find((m) => m.id === 'a')?.body).toBe("line('M8')\nline('M9'")
    expect(screen.getByTestId('macro-editor-body-error').textContent).toBe(
      'Line 2, column 10: expected ")" but found the end of the macro.',
    )
  })

  it('the macro API list beside the body comes from the sandbox\'s own definition', async () => {
    const { MACRO_API } = await import('../../lib/machine/macros/macroRuntime')
    renderPanel()
    openEditor()
    fireEvent.click(screen.getByTestId('macro-editor-add'))
    const list = screen.getByTestId('macro-editor-api-list')
    for (const name of MACRO_API) {
      expect(list.textContent).toContain(name)
    }
  })
})

describe('WO-1706: a macro made in the editor runs through the real macro runtime', () => {
  let sent: string[] = []

  async function connect(): Promise<void> {
    vi.useFakeTimers()
    useMachineActions.setState({ byMachine: {} })
    useCamStore.getState().newProject()
    selectMachine([])
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(50)
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    const ctrl = getMachineController()
    const original = ctrl.sendCommand.bind(ctrl)
    sent = []
    vi.spyOn(ctrl, 'sendCommand').mockImplementation((text: string) => {
      sent.push(text)
      return original(text)
    })
    useMachineControl.setState({ consoleLines: [] })
  }

  afterEach(async () => {
    __resetMacroRuntimeForTest()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('add "Vacuum on" (line(\'M7\')) in the editor, then press it - M7 reaches the send door', async () => {
    await connect()
    renderPanel()
    openEditor()
    fireEvent.click(screen.getByTestId('macro-editor-add'))
    fireEvent.change(screen.getByTestId('macro-editor-name'), { target: { value: 'Vacuum on' } })
    fireEvent.change(screen.getByTestId('macro-editor-body'), { target: { value: "line('M7')" } })
    fireEvent.click(screen.getByTestId('macro-editor-save'))
    fireEvent.click(screen.getByLabelText('Close'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('control-user-macro-grid').querySelector('button')!)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(sent).toEqual(['M7'])
  })
})
