// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')
const NOTICE = 'This is the browser demo. To run a real machine, install the desktop app.'
const noticeLines = () => useMachineControl.getState().consoleLines.filter((line) => line.text === NOTICE)

beforeEach(() => {
  act(() => {
    useMachineControl.setState(useMachineControl.getInitialState())
    useUiPrefs.setState({ machineConsoleCollapsed: false })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  window.history.replaceState({}, '', '/')
})

// The demo case deliberately exercises one entire page session, including
// remounts and clearing. Desktop cases run first and must not consume its guard.
describe.sequential('WO-2394 browser demo console notice', () => {
  it('does not add the notice in a desktop build', () => {
    vi.stubEnv('VITE_DEMO_BUILD', '')
    render(<StrictMode><ControlPage /></StrictMode>)
    expect(noticeLines()).toHaveLength(0)
    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it('does not opt an ordinary browser into the demo through its URL', () => {
    vi.stubEnv('VITE_DEMO_BUILD', 'false')
    window.history.replaceState({}, '', '?demo=true')
    render(<ControlPage />)
    expect(noticeLines()).toHaveLength(0)
    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it('adds one ordinary info row for the demo session through replay, screen changes, remount and clear', () => {
    vi.stubEnv('VITE_DEMO_BUILD', 'true')
    const view = render(<StrictMode><ControlPage /></StrictMode>)
    expect(noticeLines()).toHaveLength(1)
    expect(noticeLines()[0]).toMatchObject({ dir: 'rx', severity: 'info', text: NOTICE })
    const text = within(screen.getByTestId('control-console')).getByText(NOTICE)
    expect(text.closest('.control-console-line')).not.toBeNull()
    expect(text.closest('[role="dialog"], [role="alert"], .modal-container, .modal-backdrop')).toBeNull()
    expect(screen.getAllByText(NOTICE)).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: /^Machine$/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Main$/ }))
    view.rerender(<StrictMode><ControlPage /></StrictMode>)
    expect(noticeLines()).toHaveLength(1)
    view.unmount()
    const remount = render(<ControlPage />)
    expect(noticeLines()).toHaveLength(1)

    act(() => useMachineControl.getState().clearConsole())
    remount.unmount()
    render(<StrictMode><ControlPage /></StrictMode>)
    expect(noticeLines()).toHaveLength(0)
    expect(screen.queryByText(NOTICE)).toBeNull()
  })
})
