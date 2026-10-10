// @vitest-environment jsdom
//
// WO-038: console collapse must actually condense. Collapsed, the console's
// rendered content is EXACTLY one row - the most recent console line (with the
// expand chevron riding inline) - plus the MDI input row. No "Console" panel
// header, no Clear button, no other line rows. Expanding restores the full
// console, and the single collapsed row tracks new traffic live. Assertions
// count RENDERED rows, not CSS class names (jsdom has no layout; the height
// claim - equal small footprint for EMPTY and POPULATED collapsed consoles -
// is proven by src/tests/evidence/WO-041/ real-browser measurements).
// Harness follows controlTabMount.test.tsx: Viewport mocked, localStorage
// shimmed BEFORE the store import.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
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

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

async function mountControlTab() {
  render(<App />)
  fireEvent.click(screen.getByTestId('mode-tab-control'))
  await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
}

function consolePanel(): Element {
  return screen.getByTestId('control-console').closest('.control-console-panel')!
}

function lineRows(): NodeListOf<Element> {
  return screen.getByTestId('control-console').querySelectorAll('.control-console-line')
}

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam' })
  useMachineControl.getState().clearConsole()
  useUiPrefs.setState({ machineConsoleCollapsed: true })
})

afterEach(() => {
  cleanup()
})

describe('WO-038: console collapse condenses to last line + MDI', () => {
  it('collapsed renders exactly the last console line plus the MDI row - no header', async () => {
    await mountControlTab()
    const push = useMachineControl.getState().pushConsole
    push('tx', 'G21', 'info')
    push('rx', 'ok', 'info')
    push('tx', 'G0 X5', 'info')

    await waitFor(() => expect(lineRows()).toHaveLength(1))
    // The one rendered row is the MOST RECENT line, not the first.
    expect(lineRows()[0].textContent).toContain('G0 X5')
    expect(screen.getByTestId('control-console').textContent).not.toContain('G21')
    // The MDI input row is still there, inside the same panel.
    expect(consolePanel().querySelector('[data-testid="control-mdi-input"]')).toBeTruthy()
    // No panel header collapsed: no "Console" title, no Clear button.
    expect(consolePanel().querySelector('.panel-header')).toBeNull()
    expect(screen.queryByText('Console')).toBeNull()
    expect(screen.queryByText('Clear')).toBeNull()
    // The expand affordance rides inline instead.
    expect(screen.getByLabelText('Expand the console')).toBeTruthy()
  })

  it('the collapsed single row tracks new console traffic live', async () => {
    await mountControlTab()
    const push = useMachineControl.getState().pushConsole
    push('tx', '$H', 'info')
    await waitFor(() => expect(lineRows()[0].textContent).toContain('$H'))

    push('rx', 'error:9 G-code locked out during alarm or jog state.', 'error')
    await waitFor(() => expect(lineRows()[0].textContent).toContain('error:9'))
    // Still exactly one row - live update replaces, never accumulates.
    expect(lineRows()).toHaveLength(1)
    expect(screen.getByTestId('control-console').textContent).not.toContain('$H')
  })

  it('expanding restores the full console and header; collapsing condenses again', async () => {
    await mountControlTab()
    const push = useMachineControl.getState().pushConsole
    push('tx', 'G21', 'info')
    push('rx', 'ok', 'info')
    push('tx', 'G90', 'info')
    await waitFor(() => expect(lineRows()).toHaveLength(1))

    fireEvent.click(screen.getByTestId('control-console-toggle'))
    expect(useUiPrefs.getState().machineConsoleCollapsed).toBe(false)
    await waitFor(() => expect(lineRows()).toHaveLength(3))
    // Header chrome is back: title, collapse chevron, Clear.
    expect(consolePanel().querySelector('.panel-header')).toBeTruthy()
    expect(screen.getByText('Console')).toBeTruthy()
    expect(screen.getByText('Clear')).toBeTruthy()
    expect(screen.getByLabelText('Collapse the console')).toBeTruthy()

    fireEvent.click(screen.getByTestId('control-console-toggle'))
    expect(useUiPrefs.getState().machineConsoleCollapsed).toBe(true)
    await waitFor(() => expect(lineRows()).toHaveLength(1))
    expect(lineRows()[0].textContent).toContain('G90')
  })

  it('collapsed with an empty console shows the connect hint row and the MDI input', async () => {
    await mountControlTab()
    expect(lineRows()).toHaveLength(0)
    expect(screen.getByTestId('control-console').textContent).toMatch(/Connect to .+ or simulate it/)
    expect(consolePanel().querySelector('[data-testid="control-mdi-input"]')).toBeTruthy()
    expect(consolePanel().querySelector('.panel-header')).toBeNull()
    // The expand affordance stays reachable from the empty collapsed row.
    expect(screen.getByLabelText('Expand the console')).toBeTruthy()
  })

  it('WO-041: clearing while collapsed swaps the line row for the placeholder, nothing else', async () => {
    await mountControlTab()
    const push = useMachineControl.getState().pushConsole
    push('tx', 'G21', 'info')
    push('rx', 'ok', 'info')
    await waitFor(() => expect(lineRows()).toHaveLength(1))

    useMachineControl.getState().clearConsole()
    await waitFor(() => expect(lineRows()).toHaveLength(0))
    // The placeholder replaces the line row inside the same collapsed body -
    // still no header, still the MDI row, still the inline expand chevron.
    expect(screen.getByTestId('control-console').querySelector('.panel-empty')).toBeTruthy()
    expect(consolePanel().querySelector('.panel-header')).toBeNull()
    expect(consolePanel().querySelector('[data-testid="control-mdi-input"]')).toBeTruthy()
    expect(screen.getByLabelText('Expand the console')).toBeTruthy()

    // New traffic replaces the placeholder with a single line row again.
    push('tx', 'G90', 'info')
    await waitFor(() => expect(lineRows()).toHaveLength(1))
    expect(screen.getByTestId('control-console').querySelector('.panel-empty')).toBeNull()
  })
})
