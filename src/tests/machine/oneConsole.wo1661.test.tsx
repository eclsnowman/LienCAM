// @vitest-environment jsdom

// WO-1661: ONE console. A typed MDI line is a `>` row inside the console,
// followed by the machine's replies in time order; there is no second
// history box. Up/Down in the input still recalls typed lines.
// Carries the surviving intents of WO-1344's history-box test: the refusal
// reason stays readable (now as a console row) and recall never calls the
// controller.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const sendMdiLine = vi.fn<(text: string) => boolean>()

vi.mock('../../lib/machine/machineSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/machineSession')>()
  return typedMock<typeof import('../../lib/machine/machineSession')>({ ...actual, sendMdiLine })
})

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

function input(): HTMLInputElement {
  return screen.getByTestId('control-mdi-input') as HTMLInputElement
}

function submit(line: string): void {
  fireEvent.change(input(), { target: { value: line } })
  fireEvent.keyDown(input(), { key: 'Enter' })
}

// Rows the page itself writes on mount (e.g. the not-homed sentence) are not
// this order's; every assertion reads the rows written after render().
let rowsAtMount = 0

function mount(): void {
  render(<ControlPage />)
  rowsAtMount = allConsoleRows().length
}

function consoleRows(): string[] {
  return allConsoleRows().slice(rowsAtMount)
}

function allConsoleRows(): string[] {
  if (useMachineControl.getState().consoleLines.length === 0) return []
  return Array.from(
    screen.getByTestId('control-console').querySelectorAll('.control-console-line'),
  ).map((row) => {
    const dir = row.querySelector('.control-console-dir')?.textContent ?? ''
    const text = row.querySelector('.control-console-text')?.textContent ?? ''
    return `${dir} ${text}`
  })
}

beforeEach(() => {
  sendMdiLine.mockReset()
  useUiPrefs.setState({ machineConsoleCollapsed: false })
  useMachineControl.setState({
    connectionPhase: 'connected',
    machineState: 'idle',
    consoleLines: [],
    job: { ...useMachineControl.getState().job, phase: 'empty' },
  })
})

afterEach(() => cleanup())

describe('WO-1661 one console', () => {
  it('puts each typed line in the console as a > row, followed by its replies, with no second box', () => {
    sendMdiLine.mockImplementation((line) => {
      const state = useMachineControl.getState()
      if (line === 'G91') {
        state.pushConsole('tx', 'MDI G91: incremental mode is not supported.', 'error')
        return false
      }
      state.pushConsole('rx', `MDI ${line}: one move in G54.`, 'info')
      return true
    })
    mount()
    act(() => useMachineControl.getState().pushConsole('rx', 'Controller ready', 'info'))

    for (const line of ['G0 X10', 'G91', 'M3 S1000', 'M5', 'G0 Y5']) submit(line)

    expect(screen.queryByTestId('control-mdi-history')).toBeNull()
    expect(screen.queryByTestId('control-mdi-history-entry')).toBeNull()
    expect(consoleRows()).toEqual([
      '< Controller ready',
      '> G0 X10',
      '< MDI G0 X10: one move in G54.',
      '> G91',
      '> MDI G91: incremental mode is not supported.',
      '> M3 S1000',
      '< MDI M3 S1000: one move in G54.',
      '> M5',
      '< MDI M5: one move in G54.',
      '> G0 Y5',
      '< MDI G0 Y5: one move in G54.',
    ])
  })

  it('does not show the typed line twice when the send path echoes it itself', () => {
    sendMdiLine.mockImplementation((line) => {
      const state = useMachineControl.getState()
      state.pushConsole('tx', line, 'info')
      state.pushConsole('rx', 'ok', 'info')
      return true
    })
    mount()

    submit('G0 X1')

    expect(consoleRows()).toEqual(['> G0 X1', '< ok'])
  })

  it('Up recalls the last typed line, then earlier ones; Down walks back to an empty input', () => {
    sendMdiLine.mockImplementation(() => true)
    mount()
    for (const line of ['G0 X1', 'G0 X2', 'G0 X3']) submit(line)
    expect(input().value).toBe('')

    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(input().value).toBe('G0 X3')
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(input().value).toBe('G0 X2')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(input().value).toBe('G0 X3')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(input().value).toBe('')
    expect(sendMdiLine).toHaveBeenCalledTimes(3)
  })

  it('a connected hand-off clears even a refused line, keeps its console reason, and Up recalls it', () => {
    sendMdiLine.mockImplementation((line) => {
      useMachineControl.getState().pushConsole('tx', `MDI ${line}: incremental mode is not supported.`, 'error')
      return false
    })
    mount()

    submit('G91')

    // WO-2568: connected hand-off clears independently of the session's execution verdict.
    expect(input().value).toBe('')
    expect(consoleRows()).toEqual(['> G91', '> MDI G91: incremental mode is not supported.'])
    fireEvent.change(input(), { target: { value: '' } })
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(input().value).toBe('G91')
  })
})
