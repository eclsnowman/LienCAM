// @vitest-environment jsdom
//
// MACHINE-CONTROL stage 3 acceptance: the Control tab exists in the mode tab
// strip, a real click lazy-mounts the real ControlPage (React.lazy code
// split), and leaving the workspace RETAINS the host (display:none, not
// unmount) so a live serial session would survive tab switches. Harness
// follows partWorkbenchMount.int13a.test.tsx: Viewport mocked (WebGL out of
// scope), localStorage shimmed BEFORE the store import.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { expectNoEstopControl, expectOneEstopControl } from './support/estopControl'
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

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam' })
})

afterEach(() => {
  cleanup()
})

describe('MACHINE-CONTROL stage 3: Control tab mount and retention', () => {
  it('clicking the Control tab mounts the real ControlPage', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('mode-tab-control'))
    await waitFor(
      () => expect(screen.getByTestId('control-page')).toBeTruthy(),
      { timeout: 10000 },
    )
    expect(useCamStore.getState().workspace).toBe('control')
    // jsdom has no Web Serial - the page must say so plainly, not blow up.
    expect(screen.getByTestId('control-page').textContent).toMatch(/Chrome or\s+Edge/i)
    // WO-048 (approved uix=12 layout): ONE transport authority, now a
    // center-column cluster under the program list - the safety-bar testid
    // rides the cluster; the top strip is the nav-only subnav bar.
    const bar = screen.getByTestId('control-safety-bar')
    expect(bar.classList.contains('control-uix-transport')).toBe(true)
    expect(bar.querySelector('[data-testid="control-estop"]')).toBeTruthy()
    expect(bar.closest('.control-col-main')).toBeTruthy()
    // Single Block moved out of the transport cluster into the STEP row.
    expect(bar.querySelector('[data-testid="control-singleblock-toggle"]')).toBeNull()
    expect(
      screen.getByTestId('control-singleblock-toggle').closest('[data-testid="control-uix-steprow"]'),
    ).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'CYCLE START' })).toHaveLength(1)
    // UI-CONTROL-DENSITY-CORRECTION (Q-95) still holds: ONE Control-specific
    // chrome strip above the columns, and it carries the subview nav.
    const page = screen.getByTestId('control-page')
    expect(page.querySelectorAll(':scope > .control-safety-bar')).toHaveLength(1)
    expect(page.querySelector(':scope > nav')).toBeNull()
    expect(page.querySelector('.control-view-tabs')).toBeNull()
    const strip = screen.getByTestId('control-subnav-bar')
    expect(strip.parentElement).toBe(page)
    // The nav strip carries NO transport authority of its own.
    expect(strip.querySelector('[data-testid="control-estop"]')).toBeNull()
    const nav = strip.querySelector('.control-strip-nav')!
    expect(nav).toBeTruthy()
    // WO-917 (Operator): Diagnostics and Macros left the top row for sub-tabs
    // under Machine, and "Machine actions" became the Machine view itself.
    for (const view of ['main', 'offsets', 'tools', 'probing', 'routines', 'machine']) {
      expect(screen.getByTestId(`control-view-${view}`).closest('.control-strip-nav')).toBe(nav)
    }
    // The two that moved must NOT still be top-level tabs - otherwise the row
    // grows back to the width that made this change necessary.
    expect(screen.queryByTestId('control-view-diagnostics')).toBeNull()
    expect(screen.queryByTestId('control-view-macros')).toBeNull()
    // WO-411: Routines is its own sub-tab, right after Probing.
    const tabs = Array.from(nav.querySelectorAll('[data-testid^="control-view-"]')).map((el) => el.getAttribute('data-testid'))
    expect(tabs.indexOf('control-view-routines')).toBe(tabs.indexOf('control-view-probing') + 1)
    // WO-917: the standalone "Machine actions" modal-opener is gone from the
    // nav - it is the Machine view now, asserted in the loop above.
    expect(screen.queryByTestId('control-machine-actions')).toBeNull()
    // Embedding the nav must not have cloned the one cycle authority into it.
    expect(nav.querySelector('[data-testid="control-cyclestart"]')).toBeNull()
    // WO-115: the Program panel header strip is gone, so anchor on the
    // g-code list (always mounted) and climb to the dissolved program panel.
    const program = screen.getByTestId('control-gcode-list').closest('.control-program-panel')!
    expect(program.querySelector('[data-testid="control-start"]')).toBeNull()
    expect(program.querySelector('[data-testid="control-resume"]')).toBeNull()
    expect(program.querySelector('[data-testid="control-pause"]')).toBeNull()
    expect(program.querySelector('[data-testid="control-step"]')).toBeNull()
    // WO-048 column roles: LEFT = machine status + offsets + tool at a
    // glance; RIGHT = the motion/accessory rail with Overrides and Macros.
    const left = screen.getByTestId('control-page').querySelector('.control-col-left')!
    const right = screen.getByTestId('control-page').querySelector('.control-col-right')!
    expect(left.textContent).toContain('Work offsets')
    expect(left.textContent).not.toContain('Overrides')
    expect(right.textContent).toContain('Jog')
    expect(right.textContent).toContain('Spindle')
    expect(right.textContent).toContain('Overrides')
    expect(right.textContent).toContain('Macros')
    // WO-068: the four stacked right-rail panels ride the rail's real
    // scroll path - the same .control-col-scroll wrapper the left rail has.
    expect(right.querySelector(':scope > .control-col-scroll')).toBeTruthy()
    const macroTitle = Array.from(right.querySelectorAll('.panel-title')).find(
      (el) => el.textContent?.trim() === 'Macros',
    )
    expect(macroTitle?.closest('.control-col-scroll')).toBeTruthy()
  })

  it('switches subviews from inside the strip and keeps the strip mounted', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('mode-tab-control'))
    await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
    const columns = screen.getByTestId('control-page').querySelector('.control-columns')!
    expect(columns.hasAttribute('hidden')).toBe(false)
    expect(screen.getByTestId('control-view-main').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByTestId('control-view-offsets'))
    expect(columns.hasAttribute('hidden')).toBe(true)
    expect(screen.getByTestId('control-view-offsets').getAttribute('aria-pressed')).toBe('true')
    // WO-1086 section 9.1: a page that does not show the program keeps only
    // reaction authority. Role queries prove Feed Hold and Stop/Reset are
    // visible rather than leaking from the now-hidden Main columns.
    expect(screen.queryByRole('button', { name: 'CYCLE START' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Feed Hold' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Stop/Reset' })).toHaveLength(1)
    expect(screen.getByTestId('control-state-chip').textContent).toMatch(/\S/)

    fireEvent.click(screen.getByTestId('control-view-main'))
    expect(columns.hasAttribute('hidden')).toBe(false)
  })

  it('keeps stop-and-hold authority visible off Main while Main stays complete', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('mode-tab-control'))
    await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
    // WO-1086 section 9.1 replaces the old full-authority-off-Main contract:
    // Main keeps every program control, while ordinary auxiliary views keep
    // only E-STOP, Feed Hold, Stop/Reset and the always-visible state chip.
    // Role queries see only accessible DOM, so controls hidden with the Main
    // columns cannot satisfy these assertions.
    // WO-917 repin: Diagnostics and Macros are now Machine sub-tabs. They stay
    // in this walk BY NAME - the contract is that the one transport authority
    // is reachable in every subview, and a nav change must not be able to
    // quietly drop two of them from the guard.
    for (const view of ['main', 'offsets', 'tools', 'routines', 'diagnostics', 'macros', 'main']) {
      if (view === 'diagnostics' || view === 'macros') {
        fireEvent.click(screen.getByTestId('control-view-machine'))
        fireEvent.click(screen.getByTestId(`control-machine-tab-${view}`))
      } else {
        fireEvent.click(screen.getByTestId(`control-view-${view}`))
      }
      // WO-411: the Routines sub-tab mounts the station open, no toggle - and
      // (Operator ruling 2026-08-21: "no motion buttons on the page") NO transport row:
      // its one E-STOP appears only while a routine is running.
      if (view === 'routines') {
        expect(screen.getByTestId('control-routines-panel')).toBeTruthy()
        expect(screen.getByTestId('probe-routine-section').getAttribute('data-open')).toBe('true')
        expect(screen.queryByTestId('probe-routine-toggle')).toBeNull()
        expect(screen.queryByTestId('control-aux-authority')).toBeNull()
        // WO-469: absent in BOTH of the E-STOP control's modes - the
        // single-name query this replaces could only ever see one of them.
        expectNoEstopControl()
        for (const name of ['CYCLE START', 'Feed Hold', 'Stop/Reset']) {
          expect(screen.queryAllByRole('button', { name })).toHaveLength(0)
        }
        expect(screen.queryAllByTestId('control-singleblock-toggle')).toHaveLength(0)
        expect(screen.getByTestId('control-state-chip').textContent).toMatch(/\S/)
        continue
      }
      expectOneEstopControl() // WO-469: by control, not by mode word
      for (const name of ['Feed Hold', 'Stop/Reset']) {
        expect(screen.getAllByRole('button', { name })).toHaveLength(1)
      }
      expect(screen.getByTestId('control-state-chip').textContent).toMatch(/\S/)
      if (view === 'main') {
        expect(screen.getAllByRole('button', { name: 'CYCLE START' })).toHaveLength(1)
        expect(screen.getAllByRole('button', { name: 'Single Block' })).toHaveLength(1)
      } else {
        expect(screen.queryByRole('button', { name: 'CYCLE START' })).toBeNull()
        // ControlPage retains its STEP sibling, while WO-1086's stylesheet
        // hides that sibling after a compact transport. This jsdom test guards
        // the required adjacency; the focused CSS contract and Chromium
        // measurement prove that it renders with display:none.
        const authority = screen.getByTestId('control-aux-authority')
        const compactTransport = authority.querySelector('.control-transport-compact')
        expect(compactTransport?.querySelector('[data-testid="control-singleblock-toggle"]')).toBeNull()
        expect(compactTransport?.nextElementSibling).toBe(
          authority.querySelector('[data-testid="control-uix-steprow"]'),
        )
      }
    }
  })

  it('leaving the Control workspace hides but does NOT unmount the host', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('mode-tab-control'))
    await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
    // Back to CAM via the Setup tab (any CAM tab is a way back).
    fireEvent.click(screen.getByTestId('mode-tab-setup'))
    expect(useCamStore.getState().workspace).toBe('cam')
    const host = screen.getByTestId('control-workspace-host')
    expect(host.style.display).toBe('none')
    // Still in the DOM - the serial session's owner survives.
    expect(screen.getByTestId('control-page')).toBeTruthy()
    // And returning shows it again instantly.
    fireEvent.click(screen.getByTestId('mode-tab-control'))
    expect(screen.getByTestId('control-workspace-host').style.display).toBe('contents')
  })

  it('mounts under StrictMode without hooks-order violations', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(createElement(StrictMode, null, createElement(App)))).not.toThrow()
      fireEvent.click(screen.getByTestId('mode-tab-control'))
      await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), {
        timeout: 10000,
      })
      const hooksOrderCalls = errorSpy.mock.calls.filter(
        ([msg]) =>
          typeof msg === 'string' && /hooks|hook order|Rendered (more|fewer) hooks/i.test(msg),
      )
      expect(hooksOrderCalls).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('console lines pushed to the machine store render in the console panel', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('mode-tab-control'))
    await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })
    useMachineControl.getState().pushConsole('rx', "Grbl 1.1h ['$' for help]", 'info')
    await waitFor(() =>
      expect(screen.getByTestId('control-console').textContent).toMatch(/Grbl 1\.1h/),
    )
  })

  it('renders each pushed row\'s store time and leaves a legacy untimed row untimed', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('mode-tab-control'))
    await waitFor(() => expect(screen.getByTestId('control-page')).toBeTruthy(), { timeout: 10000 })

    const firstAt = new Date(2026, 8, 10, 8, 17, 42).getTime()
    const secondAt = firstAt + 1000
    act(() => {
      useUiPrefs.setState({ machineConsoleCollapsed: false })
      useMachineControl.setState({
        consoleLines: [
          { id: 9001, dir: 'rx', text: 'first', severity: 'info', at: firstAt },
          { id: 9002, dir: 'rx', text: 'second', severity: 'info', at: secondAt },
          { id: 9003, dir: 'rx', text: 'legacy', severity: 'info' },
        ],
      })
    })

    const rows = Array.from(screen.getByTestId('control-console').querySelectorAll('.control-console-line'))
    expect(rows).toHaveLength(3)
    expect(rows[0].querySelector('.control-console-time')?.textContent).toBe(
      new Date(firstAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    )
    expect(rows[1].querySelector('.control-console-time')?.textContent).not.toBe(
      rows[0].querySelector('.control-console-time')?.textContent,
    )
    const firstTime = rows[0].querySelector('.control-console-time') as HTMLSpanElement
    expect(firstTime.style.whiteSpace).toBe('nowrap')
    expect(firstTime.style.flexShrink).toBe('0')
    expect(firstTime.style.color).toBe('var(--text-disabled)')
    expect(rows[2].querySelector('.control-console-time')).toBeNull()

    act(() => useMachineControl.getState().pushConsole('tx', 'store clock', 'info'))
    expect(useMachineControl.getState().consoleLines.at(-1)?.at).toEqual(expect.any(Number))
  })
})
