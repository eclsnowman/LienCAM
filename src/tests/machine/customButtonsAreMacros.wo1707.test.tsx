// @vitest-environment jsdom
//
// WO-1707 - CUSTOM BUTTONS ARE MACROS.
//
// The older custom-button system (`CustomAction` - label, colour, G-code
// lines, optional confirm - stored per machine in `useMachineActions`,
// edited in `MachineActionsModal`) is moved ONCE onto the machine record's
// macro list (`machineActionsStore`'s one-time move): a custom button
// becomes a macro whose body is one `lines(...)` call (runMachineAction, the
// path it always took; `{rpm}` resolves at press time), carrying its colour and
// confirm-first flag. The Macros panel shows ONE grid; pressing a former
// custom button sends the same lines through the same door as before.

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

const { createDefaultControllerDefinition } = await import('../../types')
type MachineMacro = import('../../types').MachineMacro
const { useCamStore } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { MacroPanel } = await import('../../components/machine/MacroPanel')
const { MacroEditor } = await import('../../components/machine/MacroEditor')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')
const { __resetMacroRuntimeForTest } = await import('../../lib/machine/macros/macroRuntime')

const MACHINE_ID = 'wo1707-machine'
const REAL_MACRO: MachineMacro = { id: 'wipe', name: 'Wipe down', body: "line('M64 P3')" }

function selectMachine(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-1707 test bench',
    controller: 'grbl',
    controllerDefinition: createDefaultControllerDefinition(),
    unsentSettings: undefined,
    travel: { x: 738, y: 724, z: 130 },
    rapidRate: 60000,
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'max', machineZeroAt: 'max' },
    },
    macros: [REAL_MACRO],
  })
}

let sent: string[] = []

/** Seeds this machine exactly as a pre-WO-1707 session would have: two
 *  custom buttons (one confirm-first, one carrying `{rpm}`) in the older
 *  store, and one ordinary macro already on the definition. */
async function connect(): Promise<void> {
  vi.useFakeTimers()
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useCamStore.getState().newProject()
  selectMachine()
  useMachineActions.setState({
    byMachine: {
      [MACHINE_ID]: {
        overrides: {},
        custom: [
          { id: 'vacuum', label: 'Vacuum', color: 'green', lines: ['M8'] },
          { id: 'spindle-fast', label: 'Spin 8k', color: 'amber', lines: ['M3 S{rpm}'], confirm: true },
        ],
        parks: [],
      },
    },
    macroArrangementByMachine: {},
  })
  act(() => { useUiPrefs.setState({ machineSpindleRpm: 8000 }) })
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

function renderPanel(): void {
  render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
}

async function press(id: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`control-user-macro-${id}`))
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(async () => {
  await connect()
})

afterEach(async () => {
  cleanup()
  __resetMacroRuntimeForTest()
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  vi.useRealTimers()
})

describe('WO-1707: two folded custom buttons and one macro', () => {
  it('the panel shows all three in ONE grid, in order: the custom buttons first, then the macro', () => {
    renderPanel()
    const grid = screen.getByTestId('control-user-macro-grid')
    expect(Array.from(grid.querySelectorAll('button')).map((b) => b.getAttribute('data-testid')))
      .toEqual([
        'control-user-macro-vacuum',
        'control-user-macro-spindle-fast',
        'control-user-macro-wipe',
      ])
    // NEGATIVE CONTROL: on the pre-fix panel this is a second grid, holding
    // the same two buttons a second time.
    expect(screen.queryByTestId('control-macro-grid')).toBeNull()
  })

  it('Vacuum sends the same one line the old custom-button door sent', async () => {
    renderPanel()
    await press('vacuum')
    await advance(3000)
    expect(sent).toEqual(['M8'])
  })

  it('the {rpm} button asks first - confirm-first survives the fold - then sends the dialed RPM', async () => {
    renderPanel()
    const btn = screen.getByTestId('control-user-macro-spindle-fast')
    fireEvent.click(btn)
    expect(btn.textContent).toBe('Press again')
    expect(sent).toEqual([])
    fireEvent.click(btn)
    await advance(3000)
    expect(sent).toEqual(['M3 S8000'])
  })

  it('the pre-existing macro still runs, alongside the folded buttons', async () => {
    renderPanel()
    await press('wipe')
    await advance(3000)
    expect(sent).toEqual(['M64 P3'])
  })

  it('the macro editor lists all three and edits any of them', () => {
    render(<MacroEditor open onClose={() => {}} />)
    expect(screen.getByTestId('macro-editor-item-vacuum-name').textContent).toBe('Vacuum')
    expect(screen.getByTestId('macro-editor-item-spindle-fast-name').textContent).toBe('Spin 8k')
    expect(screen.getByTestId('macro-editor-item-wipe-name').textContent).toBe('Wipe down')
    fireEvent.click(screen.getByTestId('macro-editor-item-spindle-fast-edit'))
    expect((screen.getByTestId('macro-editor-body') as HTMLTextAreaElement).value)
      .toBe('lines("M3 S{rpm}")')
    expect((screen.getByTestId('macro-editor-confirm') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('macro-editor-color-amber').className).toContain('control-color-active')
  })
})

describe('WO-1707: the Actions modal no longer edits user buttons', () => {
  it('"Add / edit macros" opens the macro editor, not an inline custom-button form', async () => {
    const { MachineActionsModal } = await import('../../components/machine/MachineActionsModal')
    render(<MachineActionsModal open onClose={() => {}} />)
    expect(screen.queryByText('Vacuum')).toBeNull()
    fireEvent.click(screen.getByTestId('control-action-add'))
    expect(screen.getByTestId('macro-editor-modal')).toBeTruthy()
    expect(screen.getByTestId('macro-editor-item-vacuum-name').textContent).toBe('Vacuum')
  })
})
