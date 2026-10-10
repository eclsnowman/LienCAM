// @vitest-environment jsdom
//
// WO-1715 - A MACRO CAN ASK THE OPERATOR A QUESTION.
//
// confirm(), choose() and ask() open a dialog and pause the macro until it is
// answered, handing the answer back to the script. While the dialog is open
// nothing is sent and the jog keys are gated (`dialogOpen`); Stop and the
// E-STOP end the run and close it. Every run goes through the real Macros
// panel, the real macro runtime and the simulator's session - the dialog is
// the one the runtime mounts itself.

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
const {
  __resetMacroRuntimeForTest,
  activeMacroAsk,
  activeMacroRun,
  askAnswerValue,
  checkMacroBody,
} = await import('../../lib/machine/macros/macroRuntime')
const { dialogOpen, jogKeysAllowed } = await import('../../hooks/useControlJogKeys')

const VACUUM: MachineMacro = {
  id: 'vac',
  name: 'Vacuum',
  mCode: 310,
  body: "if (confirm('Vacuum on?')) output('Vacuum', true)\nline('G4 P0.01')",
}
const BRANCH: MachineMacro = {
  id: 'branch',
  name: 'Pick a side',
  body: [
    "const side = choose('Which side?', ['Left', 'Right'])",
    "if (side === 'Left') line('G21 G90 G53 G0 X5')",
    "else if (side === 'Right') line('G21 G90 G53 G0 X25')",
    "else say('none: ' + side)",
  ].join('\n'),
}
const DEPTH: MachineMacro = {
  id: 'depth',
  name: 'Depth',
  body: [
    "const x = ask('How far in X?', 12)",
    "say('type ' + typeof x)",
    'if (x !== null) goTo({ x: x })',
  ].join('\n'),
}
const TWO_LINES: MachineMacro = {
  id: 'two',
  name: 'Two lines',
  body: "line('M8')\nif (confirm('Go on?')) line('M9')\nline('M8')",
}

function selectMachine(macros: MachineMacro[]): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: 'wo1715-ask',
    name: 'Macro ask bench',
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

async function connect(macros: MachineMacro[]): Promise<void> {
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
  useCamStore.setState({ workspace: 'control' })
}

function rows(): string[] {
  return useMachineControl.getState().consoleLines.map((entry) => entry.text)
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

async function click(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId))
  })
}

beforeEach(async () => {
  await connect([VACUUM, BRANCH, DEPTH, TWO_LINES])
  render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
})

afterEach(async () => {
  cleanup()
  act(() => { __resetMacroRuntimeForTest() })
  const pending = disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  vi.useRealTimers()
})

describe('WO-1715: confirm()', () => {
  it('OK sends the output; the dialog shows the question and gates the jog keys while open', async () => {
    await press('vac')
    await advance(500)
    expect(screen.getByTestId('macro-ask-dialog').getAttribute('data-kind')).toBe('confirm')
    expect(screen.getByTestId('macro-ask-text').textContent).toBe('Vacuum on?')
    expect(dialogOpen()).toBe(true)
    expect(jogKeysAllowed()).toBe(false)
    expect(sent).toEqual([])
    expect(rows()).toContain('Macro "Vacuum" is waiting for an answer: Vacuum on?')
    // However long it waits, nothing goes out.
    await advance(10000)
    expect(sent).toEqual([])

    await click('macro-ask-ok')
    await advance(3000)
    expect(sent).toEqual(['M7', 'G4 P0.01'])
    expect(screen.queryByTestId('macro-ask-dialog')).toBeNull()
    expect(dialogOpen()).toBe(false)
    expect(activeMacroRun()).toBeNull()
  })

  it('Cancel returns false: the output is skipped and the script carries on', async () => {
    await press('vac')
    await advance(500)
    await click('macro-ask-cancel')
    await advance(3000)
    expect(sent).toEqual(['G4 P0.01'])
    expect(activeMacroRun()).toBeNull()
  })

  it('Escape is Cancel too', async () => {
    await press('vac')
    await advance(500)
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await advance(3000)
    expect(sent).toEqual(['G4 P0.01'])
  })

  it('a program reaches it the one existing way: the macro\'s bound M-code', async () => {
    act(() => { sendMdiLine('M310') })
    await advance(500)
    expect(screen.getByTestId('macro-ask-text').textContent).toBe('Vacuum on?')
    await click('macro-ask-ok')
    await advance(3000)
    expect(sent).toEqual(['M7', 'G4 P0.01'])
  })
})

describe('WO-1715: choose() is a decision tree', () => {
  it('Left drives one line', async () => {
    await press('branch')
    await advance(500)
    expect(screen.getByTestId('macro-ask-option-0').textContent).toBe('Left')
    expect(screen.getByTestId('macro-ask-option-1').textContent).toBe('Right')
    await click('macro-ask-option-0')
    await advance(4000)
    expect(sent).toEqual(['G21 G90 G53 G0 X5'])
  })

  it('Right drives a different line', async () => {
    await press('branch')
    await advance(500)
    await click('macro-ask-option-1')
    await advance(4000)
    expect(sent).toEqual(['G21 G90 G53 G0 X25'])
  })

  it('Cancel returns null to the script', async () => {
    await press('branch')
    await advance(500)
    await click('macro-ask-close')
    await advance(1000)
    expect(sent).toEqual([])
    expect(rows()).toContain('none: null')
  })
})

describe('WO-1715: ask() returns what was typed', () => {
  it('a typed number comes back as a number and drives goTo', async () => {
    await press('depth')
    await advance(500)
    const input = screen.getByTestId('macro-ask-input') as HTMLInputElement
    expect(input.value).toBe('12')
    await act(async () => {
      fireEvent.change(input, { target: { value: '30' } })
    })
    await click('macro-ask-ok')
    await advance(4000)
    expect(rows()).toContain('type number')
    expect(sent).toEqual(['G21 G90 G53 G0 X30'])
    expect(useMachineControl.getState().mpos?.x).toBeCloseTo(30, 1)
  })

  it('Cancel returns null and nothing moves', async () => {
    await press('depth')
    await advance(500)
    await click('macro-ask-cancel')
    await advance(2000)
    expect(rows()).toContain('type object')
    expect(sent).toEqual([])
  })

  it('text that is not a number comes back as the text', () => {
    expect(askAnswerValue(' 2.5 ')).toBe(2.5)
    expect(askAnswerValue('-4')).toBe(-4)
    expect(askAnswerValue('left')).toBe('left')
    expect(askAnswerValue('')).toBe('')
  })
})

describe('WO-1715: stops while the dialog is open', () => {
  it('no line is sent while the dialog is open; Stop macro ends the run and sends nothing further', async () => {
    await press('two')
    await advance(1500)
    expect(sent).toEqual(['M8'])
    expect(activeMacroAsk()).not.toBeNull()
    await advance(10000)
    expect(sent).toEqual(['M8'])

    await click('macro-ask-stop')
    await advance(5000)
    expect(sent).toEqual(['M8'])
    expect(activeMacroRun()).toBeNull()
    expect(activeMacroAsk()).toBeNull()
    expect(screen.queryByTestId('macro-ask-dialog')).toBeNull()
    expect(rows()).toContain('Macro "Two lines" stopped.')
  })

  it('the Macros panel\'s own Stop does the same', async () => {
    await press('two')
    await advance(1500)
    await click('control-user-macro-stop')
    await advance(5000)
    expect(sent).toEqual(['M8'])
    expect(screen.queryByTestId('macro-ask-dialog')).toBeNull()
  })

  it('the E-STOP ends the run and closes the dialog with nothing more sent', async () => {
    await press('two')
    await advance(1500)
    expect(sent).toEqual(['M8'])
    act(() => { triggerEmergencyStop() })
    await advance(5000)
    expect(sent.filter((line) => line === 'M9' || line === 'M8')).toEqual(['M8'])
    expect(activeMacroRun()).toBeNull()
    expect(screen.queryByTestId('macro-ask-dialog')).toBeNull()
    expect(rows()).toContain('Macro "Two lines" stopped by the E-STOP.')
  })

  it('an answer to a question that has closed reaches nothing', async () => {
    await press('two')
    await advance(1500)
    const id = activeMacroAsk()!.id
    await click('macro-ask-stop')
    await advance(1000)
    const { answerMacroAsk } = await import('../../lib/machine/macros/macroRuntime')
    expect(answerMacroAsk(id, true)).toBe(false)
    await advance(3000)
    expect(sent).toEqual(['M8'])
  })
})

describe('WO-1715: bad arguments', () => {
  it('choose() without a list ends the macro naming the line', async () => {
    const bad: MachineMacro = { id: 'bad', name: 'Bad', body: "line('M8')\nchoose('Pick')" }
    await connect([bad])
    cleanup()
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    await press('bad')
    await advance(2000)
    expect(sent).toEqual(['M8'])
    expect(rows().some((r) => r.startsWith('Macro "Bad" stopped at line 2: choose:'))).toBe(true)
    expect(checkMacroBody(bad.body).ok).toBe(true)
  })
})
