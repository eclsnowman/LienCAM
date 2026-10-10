// @vitest-environment jsdom
//
// Unit/render suite for the ThemedListbox custom select (UI-BRAND-B3-1, Q-65).
// Covers EVERY keyboard behavior the lane bar requires plus the value/onChange
// contract (drop-in parity with the native <select> it replaces):
//   - Tab focus, Enter/Space open, Enter/Space select+close
//   - Arrow navigation (skips disabled), Home/End
//   - first-letter type-ahead (open: moves active; closed: changes value)
//   - Esc close-without-change + return-focus-to-trigger
//   - click-outside close, click-to-select, disabled-option handling
//   - ARIA wiring (role=combobox/listbox/option, aria-expanded,
//     aria-activedescendant, aria-selected, grouped role=group)
//   - onChange fires ONLY on a real change (same-value re-pick is a no-op)

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { ThemedListbox, type ThemedListboxItems } from '../../components/ui/ThemedListbox'

const appCss = readFileSync('src/styles/app.css', 'utf8')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const OPTS: ThemedListboxItems = [
  { value: 'draft', label: 'Draft' },
  { value: 'standard', label: 'Standard' },
  { value: 'fine', label: 'Fine' },
  { value: 'custom', label: 'Custom' },
]

// Controlled harness so the consumer's value updates propagate back in (proving
// the drop-in <select value onChange> contract end-to-end).
function Harness({
  initial = 'standard',
  options = OPTS,
  onChangeSpy,
  disabled,
}: {
  initial?: string
  options?: ThemedListboxItems
  onChangeSpy?: (v: string) => void
  disabled?: boolean
}) {
  const [value, setValue] = useState(initial)
  return (
    <ThemedListbox
      testId="lb"
      ariaLabel="Quality preset"
      value={value}
      options={options}
      disabled={disabled}
      onChange={(v) => { onChangeSpy?.(v); setValue(v) }}
    />
  )
}

const trigger = () => screen.getByTestId('lb')
const opt = (v: string) => screen.getByTestId(`lb-option-${v}`)
const queryOpt = (v: string) => screen.queryByTestId(`lb-option-${v}`)

describe('ThemedListbox', () => {
  it('renders closed showing the selected label, correct combobox ARIA', () => {
    render(<Harness />)
    const t = trigger()
    expect(t.getAttribute('role')).toBe('combobox')
    expect(t.getAttribute('aria-haspopup')).toBe('listbox')
    expect(t.getAttribute('aria-expanded')).toBe('false')
    expect(t.textContent).toContain('Standard')
    // Closed => no popup / options in the document.
    expect(queryOpt('draft')).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens on Enter, exposes role=listbox + role=option with aria-selected', () => {
    render(<Harness />)
    act(() => { fireEvent.keyDown(trigger(), { key: 'Enter' }) })
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('listbox')).not.toBeNull()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(4)
    // The selected option is aria-selected and is the active descendant.
    expect(opt('standard').getAttribute('aria-selected')).toBe('true')
    expect(trigger().getAttribute('aria-activedescendant')).toBe(opt('standard').id)
  })

  it('grows and viewport-clamps the popup while keeping full option labels readable', () => {
    const longOptions: ThemedListboxItems = [
      { value: 'pan-first', label: 'Middle-button pan + Shift + middle-button orbit' },
      { value: 'orbit-first', label: 'Middle-button orbit + Shift + middle-button pan' },
      { value: 'stock-3d', label: '3D - smooth, true undercuts and full tool-shape simulation' },
    ]
    vi.stubGlobal('innerWidth', 1200)
    render(<Harness initial="pan-first" options={longOptions} />)
    vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue({
      left: 900,
      right: 1080,
      top: 100,
      bottom: 128,
      width: 180,
      height: 28,
      x: 900,
      y: 100,
      toJSON: () => ({}),
    })

    act(() => { fireEvent.click(trigger()) })
    const popup = screen.getByRole('listbox')
    expect(popup.style.left).toBe('')
    expect(popup.style.right).toBe('120px')
    expect(popup.style.minWidth).toBe('180px')
    expect(popup.style.maxWidth).toBe('480px')
    expect(opt('pan-first').textContent).toContain(longOptions[0].label)
    expect(opt('orbit-first').textContent).toContain(longOptions[1].label)
    expect(opt('stock-3d').textContent).toContain(longOptions[2].label)

    const popupRule = appCss.match(/\.themed-listbox-popup\s*\{([^}]*)\}/s)?.[1]
    expect(popupRule).toMatch(/box-sizing:\s*border-box/)
    expect(popupRule).toMatch(/width:\s*max-content/)
    const optionLabelRule = appCss.match(/\.themed-listbox-option-label\s*\{([^}]*)\}/s)?.[1]
    expect(optionLabelRule).toMatch(/overflow-wrap:\s*anywhere/)
    expect(optionLabelRule).toMatch(/white-space:\s*normal/)
    expect(optionLabelRule).not.toMatch(/text-overflow:\s*ellipsis/)
    const closedValueRule = appCss.match(/\.themed-listbox-value\s*\{([^}]*)\}/s)?.[1]
    expect(closedValueRule).toMatch(/text-overflow:\s*ellipsis/)
    expect(closedValueRule).toMatch(/white-space:\s*nowrap/)

    vi.stubGlobal('innerWidth', 360)
    vi.mocked(trigger().getBoundingClientRect).mockReturnValue({
      left: 250,
      right: 350,
      top: 100,
      bottom: 128,
      width: 100,
      height: 28,
      x: 250,
      y: 100,
      toJSON: () => ({}),
    })
    act(() => { fireEvent(window, new Event('resize')) })
    expect(popup.style.right).toBe('10px')
    expect(popup.style.minWidth).toBe('100px')
    expect(popup.style.maxWidth).toBe('342px')
  })

  it('Space opens then selects the active option and closes (fires onChange once)', () => {
    const spy = vi.fn()
    render(<Harness onChangeSpy={spy} />)
    act(() => { fireEvent.keyDown(trigger(), { key: ' ' }) })      // open (active=standard)
    act(() => { fireEvent.keyDown(trigger(), { key: 'ArrowDown' }) }) // active -> fine
    act(() => { fireEvent.keyDown(trigger(), { key: ' ' }) })      // select fine
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('fine')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().textContent).toContain('Fine')
  })

  it('Enter selects the active option and the consumer value updates', () => {
    const spy = vi.fn()
    render(<Harness onChangeSpy={spy} />)
    act(() => { fireEvent.keyDown(trigger(), { key: 'ArrowDown' }) }) // open on ArrowDown
    // opened with active=standard; ArrowUp -> draft
    act(() => { fireEvent.keyDown(trigger(), { key: 'ArrowUp' }) })
    act(() => { fireEvent.keyDown(trigger(), { key: 'Enter' }) })
    expect(spy).toHaveBeenCalledWith('draft')
    expect(trigger().textContent).toContain('Draft')
  })

  it('ArrowDown/ArrowUp navigate and clamp (no wrap) at the ends', () => {
    render(<Harness initial="draft" />)
    act(() => { fireEvent.keyDown(trigger(), { key: 'Enter' }) }) // active = draft (first)
    // ArrowUp at the top is a clamp: active stays on draft.
    act(() => { fireEvent.keyDown(trigger(), { key: 'ArrowUp' }) })
    expect(trigger().getAttribute('aria-activedescendant')).toBe(opt('draft').id)
    act(() => { fireEvent.keyDown(trigger(), { key: 'ArrowDown' }) })
    expect(trigger().getAttribute('aria-activedescendant')).toBe(opt('standard').id)
  })

  it('Home/End jump to first/last option', () => {
    render(<Harness />)
    act(() => { fireEvent.keyDown(trigger(), { key: 'Enter' }) })
    act(() => { fireEvent.keyDown(trigger(), { key: 'End' }) })
    expect(trigger().getAttribute('aria-activedescendant')).toBe(opt('custom').id)
    act(() => { fireEvent.keyDown(trigger(), { key: 'Home' }) })
    expect(trigger().getAttribute('aria-activedescendant')).toBe(opt('draft').id)
  })

  it('type-ahead (open) moves the active option to the first letter match', () => {
    render(<Harness />)
    act(() => { fireEvent.keyDown(trigger(), { key: 'Enter' }) })
    act(() => { fireEvent.keyDown(trigger(), { key: 'f' }) }) // -> Fine
    expect(trigger().getAttribute('aria-activedescendant')).toBe(opt('fine').id)
    // Does NOT commit while open (no change until Enter/Space/click).
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('type-ahead (closed) changes the value directly like a native select', () => {
    const spy = vi.fn()
    render(<Harness onChangeSpy={spy} />)
    act(() => { fireEvent.keyDown(trigger(), { key: 'c' }) }) // -> Custom, stays closed
    expect(spy).toHaveBeenCalledWith('custom')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().textContent).toContain('Custom')
  })

  it('Escape closes WITHOUT changing the value and returns focus to the trigger', () => {
    const spy = vi.fn()
    render(<Harness onChangeSpy={spy} />)
    const t = trigger()
    act(() => { t.focus() })
    act(() => { fireEvent.keyDown(t, { key: 'Enter' }) })
    act(() => { fireEvent.keyDown(t, { key: 'ArrowDown' }) }) // move active, but not committed
    act(() => { fireEvent.keyDown(t, { key: 'Escape' }) })
    expect(spy).not.toHaveBeenCalled()
    expect(t.getAttribute('aria-expanded')).toBe('false')
    expect(t.textContent).toContain('Standard') // unchanged
    expect(document.activeElement).toBe(t)       // focus returned
  })

  it('click selects an option; re-picking the SAME value is a no-op (no onChange)', () => {
    const spy = vi.fn()
    render(<Harness onChangeSpy={spy} />)
    act(() => { fireEvent.click(trigger()) })
    act(() => { fireEvent.click(opt('fine')) })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith('fine')
    // Re-open and pick the now-current value again: native fires nothing.
    act(() => { fireEvent.click(trigger()) })
    act(() => { fireEvent.click(opt('fine')) })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('click outside closes the popup without changing the value', () => {
    const spy = vi.fn()
    render(
      <div>
        <button data-testid="outside">outside</button>
        <Harness onChangeSpy={spy} />
      </div>,
    )
    act(() => { fireEvent.click(trigger()) })
    expect(screen.getByRole('listbox')).not.toBeNull()
    act(() => { fireEvent.pointerDown(screen.getByTestId('outside')) })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('disabled options are marked, skipped by arrows, and cannot be clicked', () => {
    const spy = vi.fn()
    const opts: ThemedListboxItems = [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Bravo', disabled: true },
      { value: 'c', label: 'Charlie' },
    ]
    render(<Harness initial="a" options={opts} onChangeSpy={spy} />)
    act(() => { fireEvent.keyDown(trigger(), { key: 'Enter' }) })
    expect(opt('b').getAttribute('aria-disabled')).toBe('true')
    // ArrowDown from Alpha skips the disabled Bravo, lands on Charlie.
    act(() => { fireEvent.keyDown(trigger(), { key: 'ArrowDown' }) })
    expect(trigger().getAttribute('aria-activedescendant')).toBe(opt('c').id)
    // A direct click on the disabled option does nothing.
    act(() => { fireEvent.click(opt('b')) })
    expect(spy).not.toHaveBeenCalled()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('a disabled control does not open on click or key', () => {
    render(<Harness disabled />)
    expect(trigger().getAttribute('aria-disabled')).toBe('true')
    act(() => { fireEvent.click(trigger()) })
    expect(screen.queryByRole('listbox')).toBeNull()
    act(() => { fireEvent.keyDown(trigger(), { key: 'Enter' }) })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders grouped options with group headings and role=group', () => {
    const grouped: ThemedListboxItems = [
      { label: 'Built-in templates', options: [{ value: 'u', label: 'UCCNC' }, { value: 'g', label: 'GRBL' }] },
      { label: 'Saved posts', options: [{ value: 's', label: 'Shop Router' }] },
    ]
    render(<Harness initial="u" options={grouped} />)
    act(() => { fireEvent.click(trigger()) })
    expect(screen.getByText('Built-in templates')).not.toBeNull()
    expect(screen.getByText('Saved posts')).not.toBeNull()
    const groups = screen.getAllByRole('group')
    expect(groups).toHaveLength(2)
    // Selecting a grouped option still commits by value.
    act(() => { fireEvent.click(opt('s')) })
    expect(trigger().textContent).toContain('Shop Router')
  })

  it('falls back to the placeholder when the value matches no option', () => {
    render(
      <ThemedListbox
        testId="lb"
        ariaLabel="x"
        value="does-not-exist"
        placeholder="Pick one"
        options={OPTS}
        onChange={() => {}}
      />,
    )
    expect(trigger().textContent).toContain('Pick one')
  })
})
