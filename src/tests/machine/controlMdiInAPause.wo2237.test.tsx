// @vitest-environment jsdom
//
// WO-2237: the Control page's own MDI box follows the operator authority table.
// A program paused at rest takes a typed line (the line turns the pause into a
// kept stop); a running program and the tool-change hold keep the box locked
// with the sentence it always had.
//
// Fix round (architect 4:25 AM CT): the jog, Safe Z, spindle and output
// buttons follow the same rule, and every one of them - the MDI box too -
// reads the session's verdict that this pause takes a command. A hold another
// flow owns (clamp card, probe, Step Back, ...) keeps them locked, as on main.
// The store below stands in for a live pause, so the session's verdict is
// given here; keptStopAtPause.wo2237 drives the verdict itself on a board.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

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

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

let pauseTakesCommands = true
vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...actual,
    pausedProgramTakesCommands: () => pauseTakesCommands,
  })
})

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { __resetEstopInterlockForTest } = await import('../../lib/machine/machineSession')

const LOCKED = 'A program is running - MDI is locked out.'
const JOG_LOCKED = 'A program is running - jogging is locked out.'

async function mountControlTab() {
  render(<App />)
  fireEvent.click(screen.getByTestId('mode-tab-control'))
  await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
}

function mdiInput(): HTMLInputElement {
  return screen.getByTestId('control-mdi-input') as HTMLInputElement
}

function button(testid: string): HTMLButtonElement {
  return screen.getByTestId(testid) as HTMLButtonElement
}

function program(machineState: 'hold' | 'run', phase: 'paused' | 'streaming') {
  act(() => {
    useMachineControl.setState((s) => ({
      connectionPhase: 'connected',
      machineState,
      job: { ...s.job, name: 'wo2237.nc', phase },
    }))
  })
}

beforeEach(() => {
  pauseTakesCommands = true
  act(() => { __resetEstopInterlockForTest() })
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam' })
  useMachineControl.getState().clearConsole()
  useUiPrefs.setState({ machineConsoleCollapsed: false })
})

afterEach(() => {
  cleanup()
  useMachineControl.setState({ connectionPhase: 'disconnected', machineState: 'unknown' })
})

describe('WO-2237: the Control page MDI box in a pause', () => {
  it('a program paused at rest: the box is open and a typed line is not refused by the page', async () => {
    await mountControlTab()
    program('hold', 'paused')
    await waitFor(() => expect(mdiInput().disabled).toBe(false))
    expect(mdiInput().placeholder).not.toBe(LOCKED)
    fireEvent.change(mdiInput(), { target: { value: 'G91 G0 Z5' } })
    fireEvent.keyDown(mdiInput(), { key: 'Enter' })
    const text = useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
    expect(text).not.toContain(LOCKED)
    expect(text).toContain('G91 G0 Z5')
  })

  it('a running program keeps the box locked with its sentence', async () => {
    await mountControlTab()
    program('run', 'streaming')
    await waitFor(() => expect(mdiInput().disabled).toBe(true))
    expect(mdiInput().placeholder).toBe(LOCKED)
  })

  it('a program paused at rest: jog and the spindle stop are open too', async () => {
    await mountControlTab()
    program('hold', 'paused')
    await waitFor(() => expect(button('control-spindle-off').disabled).toBe(false))
    expect(button('control-jog-x-plus').disabled).toBe(false)
  })

  it('a hold another flow owns keeps MDI, jog and the spindle locked, as before', async () => {
    pauseTakesCommands = false
    await mountControlTab()
    program('hold', 'paused')
    await waitFor(() => expect(mdiInput().disabled).toBe(true))
    expect(mdiInput().placeholder).toBe(LOCKED)
    expect(button('control-spindle-off').disabled).toBe(true)
    expect(button('control-jog-x-plus').disabled).toBe(true)
    expect(button('control-jog-x-plus').getAttribute('data-tooltip')).toBe(JOG_LOCKED)
  })
})
