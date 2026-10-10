// @vitest-environment jsdom
//
// WO-1833 (BUG-546): toolbar buttons keep their names when their labels hide.
//
// TopToolbar labels its seven buttons with visible text plus data-tooltip.
// src/app.css hides that text at the compact widths -- `.toolbar-section-right
// .tb-btn span { display: none }` below 1525px and the same for
// `.toolbar-section-left .tb-btn span` below 1365px -- and display:none removes
// the text from the accessible-name computation (accname step 2A, implemented
// by dom-accessibility-api). data-tooltip is a plain data attribute that
// assistive technology does not read. So at the widths where the icon is all
// that is left, each button had NO accessible name at all.
//
// The house census (iconButtonAriaLabelCensus.test.tsx) cannot catch this: it
// reads the JSX, sees a text-span child and passes the button. Only a render
// test with the span actually hidden proves the defect -- which is what the
// compact case below does. The fix shape is the NumericInput pattern:
// aria-label defaults to the same string the tooltip already uses (Redo's
// follows its existing computed label).
//
// Defect proof (RED before the fix): the compact-case getByRole lookups fail
// because with the span hidden the buttons have no name; the full-width lookups
// by the TOOLTIP string also fail (the only name there was the short span text,
// e.g. "New", not "New project"). The control fixture pins that a hidden span
// really does strip the name in this environment, so the seven passes prove
// the aria-labels, not a toothless query.

import { describe, it, expect, afterEach } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the Zustand store persists on every set(). Install an in-memory Storage shim
// BEFORE importing the store (same pattern as appHeaderBrand.wo268.test.tsx).
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

const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { useCamStore } = await import('../../store')

const injectedStyles: HTMLStyleElement[] = []
function injectCss(css: string): void {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  injectedStyles.push(style)
}

afterEach(() => {
  cleanup()
  injectedStyles.splice(0).forEach((s) => s.remove())
  act(() => { useCamStore.setState({ canRedo: false, canUndo: false }) })
})

/** The seven commands, identified by the span text the operator sees at full
 *  width. Located through the DOM (not by accessible name) so the same helper
 *  works with the labels hidden and before the fix lands. */
const COMMANDS = ['New', 'Open', 'Save', 'Undo', 'Redo', 'Settings', 'Help'] as const

function toolbarButtons(): HTMLButtonElement[] {
  const header = document.querySelector('header.top-toolbar')
  expect(header).not.toBeNull()
  return COMMANDS.map((label) => {
    const span = Array
      .from(header!.querySelectorAll('.tb-btn span'))
      .find((el) => el.textContent === label)
    expect(span, `visible label span "${label}" is rendered`).toBeTruthy()
    const btn = span!.closest('button') as HTMLButtonElement | null
    expect(btn, `span "${label}" sits inside a button`).not.toBeNull()
    return btn!
  })
}

describe('WO-1833: TopToolbar buttons resolve by accessible name at every width', () => {
  it('full width: each button resolves by the name its tooltip already uses, and aria-label equals data-tooltip', () => {
    render(<TopToolbar />)
    for (const btn of toolbarButtons()) {
      const tooltip = btn.getAttribute('data-tooltip')
      expect(tooltip, 'every command carries a tooltip to name it from').toBeTruthy()
      // The house pattern (NumericInput.tsx): the accessible name IS the
      // tooltip string -- no new wording invented.
      expect(btn.getAttribute('aria-label')).toBe(tooltip)
      expect(
        screen.getByRole('button', { name: tooltip! }),
        `button named "${tooltip}" resolves`,
      ).toBe(btn)
    }
  })

  it('compact width (labels hidden by CSS, as app.css does below 1525/1365px): all seven STILL resolve by name', () => {
    render(<TopToolbar />)
    // Simulate the state where the app.css media rules match. jsdom does not
    // evaluate @media, so inject the declarations the breakpoint applies.
    injectCss('.tb-btn span { display: none; }')
    const buttons = toolbarButtons()
    // The simulation took hold -- without this the seven passes below would be
    // vacuous (and the control fixture shows a hidden span really strips the
    // name from content in this environment).
    const probeSpan = buttons[0].querySelector('span')!
    expect(getComputedStyle(probeSpan).display).toBe('none')

    for (const btn of buttons) {
      const tooltip = btn.getAttribute('data-tooltip')!
      expect(
        screen.getByRole('button', { name: tooltip }),
        `icon-only button still resolves as "${tooltip}"`,
      ).toBe(btn)
    }
  })

  it('control: a button whose only name source is a hidden span has NO accessible name here (census blind spot made visible)', () => {
    render(
      <button data-testid="fixture-btn" data-tooltip="Fixture hint">
        <span className="fixture-label">FixtureLabel</span>
      </button>,
    )
    injectCss('.fixture-label { display: none; }')
    expect(getComputedStyle(screen.getByTestId('fixture-btn').querySelector('span')!).display).toBe('none')
    // Found in the DOM when not filtering by name...
    expect(screen.getByTestId('fixture-btn')).toBeTruthy()
    // ...but the hidden text no longer names it: exactly the state the JSX
    // census cannot see and the operator's screen reader hits.
    expect(screen.queryByRole('button', { name: 'FixtureLabel' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Fixture hint' })).toBeNull()
  })

  it('Redo names itself with its EXISTING computed label, and follows it (no hardcoded string)', () => {
    render(<TopToolbar />)
    const redo = toolbarButtons()[4]
    // Default history: nothing to redo -- name tracks the computed tooltip.
    expect(redo.getAttribute('aria-label')).toBe('Nothing to redo')
    expect(redo.getAttribute('data-tooltip')).toBe('Nothing to redo')

    act(() => { useCamStore.setState({ canRedo: true }) })
    // After a redoable action the SAME computed label (with its shortcut hint)
    // is both the tooltip and the accessible name.
    expect(redo.getAttribute('data-tooltip')).toBe('Redo (Ctrl+Shift+Z)')
    expect(redo.getAttribute('aria-label')).toBe('Redo (Ctrl+Shift+Z)')
    expect(screen.getByRole('button', { name: 'Redo (Ctrl+Shift+Z)' })).toBe(redo)
  })
})
