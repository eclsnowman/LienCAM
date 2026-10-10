// @vitest-environment jsdom
//
// WO-1680 - THE USER'S MACROS ARE BUTTONS, AND THEIR BODIES ARE JAVASCRIPT.
//
// A machine definition carries `macros: [{ id, name, mCode?, body }]`. The
// Macros panel shows them as buttons in the user's order; pressing one runs
// its body through the real machine session - the same typed-line door - on
// the simulator. `hold()` waits for CYCLE START, Stop ends a run with nothing
// further sent, a runaway loop ends by the step budget with one console row,
// and a body that does not parse sends nothing and says where it broke.

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

const { createDefaultControllerDefinition, UNASSIGNED_PIN } = await import('../../types')
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
  sendMdiLine,
  triggerEmergencyStop,
} = await import('../../lib/machine/machineSession')
const { __resetMacroRuntimeForTest, activeMacroRun } = await import('../../lib/machine/macros/macroRuntime')

const A: MachineMacro = { id: 'a', name: 'Lights', mCode: 300, body: "line('M8')\nline('M9')" }
const B: MachineMacro = {
  id: 'b',
  name: 'Vacuum corner',
  body: "output('vacuum', true); wait(500); goTo({x:10,y:10},{machine:true})",
}
const C: MachineMacro = {
  id: 'c',
  name: 'Four stops',
  body: [
    'for (let i = 0; i < 4; i++) {',
    '  if (i === 2) hold()',
    '  line(`G21 G90 G53 G0 X${(i + 1) * 5}`)',
    '}',
  ].join('\n'),
}
const C_LINES = ['G21 G90 G53 G0 X5', 'G21 G90 G53 G0 X10', 'G21 G90 G53 G0 X15', 'G21 G90 G53 G0 X20']

function selectMachine(macros: MachineMacro[] | undefined): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo1680-macros',
    name: 'Macro test bench',
    controller: 'grbl',
    controllerDefinition: {
      ...createDefaultControllerDefinition(),
      outputs: [{ name: 'Vacuum', onCode: 'M7', offCode: 'M9', pin: { ...UNASSIGNED_PIN } }],
    },
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

let sent: string[] = []

async function connect(macros: MachineMacro[] | undefined): Promise<void> {
  vi.useFakeTimers()
  useMachineActions.setState({ byMachine: {} })
  useCamStore.getState().newProject()
  selectMachine(macros)
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

function rows(): string[] {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text)
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

afterEach(async () => {
  cleanup()
  __resetMacroRuntimeForTest()
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  vi.useRealTimers()
})

describe('WO-1680: a definition with three macros', () => {
  beforeEach(async () => {
    await connect([A, B, C])
  })

  it('the panel shows a, b, c as buttons, in order', () => {
    renderPanel()
    const grid = screen.getByTestId('control-user-macro-grid')
    expect(Array.from(grid.querySelectorAll('button')).map((b) => b.textContent)).toEqual([
      'Lights',
      'Vacuum corner',
      'Four stops',
    ])
  })

  it('a: its two lines, in order, and nothing else', async () => {
    renderPanel()
    await press('a')
    await advance(3000)
    expect(sent).toEqual(['M8', 'M9'])
    expect(activeMacroRun()).toBeNull()
  })

  it('b: the vacuum output, a 500 ms wait, then a machine-coordinate move', async () => {
    renderPanel()
    await press('b')
    await advance(300)
    expect(sent).toEqual(['M7'])
    expect(screen.getByTestId('control-user-macro-b').textContent).toBe('Vacuum corner - running')
    await advance(4000)
    expect(sent).toEqual(['M7', 'G21 G90 G53 G0 X10 Y10'])
    const s = useMachineControl.getState()
    expect(s.mpos?.x).toBeCloseTo(10, 1)
    expect(s.mpos?.y).toBeCloseTo(10, 1)
    expect(activeMacroRun()).toBeNull()
  })

  it('c: pauses at hold() and resumes on CYCLE START', async () => {
    renderPanel()
    await press('c')
    await advance(4000)
    expect(sent).toEqual(C_LINES.slice(0, 2))
    expect(activeMacroRun()?.phase).toBe('held')
    expect(rows()).toContain('Macro "Four stops" is holding - CYCLE START continues it.')
    // Still held however long it waits.
    await advance(5000)
    expect(sent).toEqual(C_LINES.slice(0, 2))

    await act(async () => {
      fireEvent.click(screen.getByTestId('control-user-macro-continue'))
    })
    await advance(5000)
    expect(sent).toEqual(C_LINES)
    expect(activeMacroRun()).toBeNull()
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(20, 1)
  })

  it('Stop during c ends it with no further line sent', async () => {
    renderPanel()
    await press('c')
    await advance(4000)
    expect(activeMacroRun()?.phase).toBe('held')
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-user-macro-stop'))
    })
    await advance(5000)
    expect(sent).toEqual(C_LINES.slice(0, 2))
    expect(activeMacroRun()).toBeNull()
    expect(rows()).toContain('Macro "Four stops" stopped.')
    // The buttons are back.
    expect(screen.queryByTestId('control-user-macro-stop')).toBeNull()
    expect((screen.getByTestId('control-user-macro-c') as HTMLButtonElement).disabled).toBe(false)
  })

  it('the E-STOP during c ends it with no further line sent', async () => {
    renderPanel()
    await press('c')
    await advance(4000)
    act(() => { triggerEmergencyStop() })
    await advance(5000)
    expect(sent.filter((line) => C_LINES.includes(line))).toEqual(C_LINES.slice(0, 2))
    expect(activeMacroRun()).toBeNull()
    expect(rows()).toContain('Macro "Four stops" stopped by the E-STOP.')
  })

  it('typed M300 runs the macro bound to it - the same body its button runs', async () => {
    expect(sendMdiLine('M300')).toBe(true)
    await advance(3000)
    expect(sent).toEqual(['M8', 'M9'])
  })
})

describe('WO-1680: bodies that cannot finish', () => {
  it('while(true){} ends by the step budget with one row, and the app stays responsive', async () => {
    await connect([{ id: 'spin', name: 'Spin', body: 'while(true){}' }])
    renderPanel()
    await press('spin')
    expect(activeMacroRun()?.macroId).toBe('spin')
    // Something else the page queued runs while the macro is still going.
    let ranWhileMacroRan = false
    setTimeout(() => { ranWhileMacroRan = activeMacroRun() !== null }, 0)
    await advance(10)
    expect(ranWhileMacroRan).toBe(true)
    for (let i = 0; i < 200 && activeMacroRun() !== null; i++) await advance(10)
    expect(activeMacroRun()).toBeNull()
    const said = rows().filter((row) => row.startsWith('Macro "Spin"'))
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/^Macro "Spin" stopped at line 1: it ran \d+ steps without one machine call/)
    expect(sent).toEqual([])
  })

  it('a body with a syntax error sends nothing and prints one row', async () => {
    await connect([{ id: 'bad', name: 'Broken', body: "line('M8')\nline('M9'" }])
    renderPanel()
    await press('bad')
    await advance(1000)
    expect(sent).toEqual([])
    expect(activeMacroRun()).toBeNull()
    expect(rows()).toEqual(['Macro "Broken" did not run: line 2, column 10: expected ")" but found the end of the macro.'])
  })
})

describe('WO-1680: a definition with zero macros', () => {
  it('shows today\'s panel unchanged', async () => {
    await connect(undefined)
    renderPanel()
    expect(screen.queryByTestId('control-user-macro-grid')).toBeNull()
    expect(screen.getByTestId('control-macros-empty').textContent).toBe('Add macros (vacuum, dust boot, lights...)')
  })
})
