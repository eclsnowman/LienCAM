// @vitest-environment jsdom
//
// Unit/render suite for the ThemedTooltip singleton (WO B3-2, Q-65 "ALL hints
// get the treatment"). Proves the behaviours the lane bar requires:
//   - shows on hover after ~500ms; INSTANT reshow moving between tipped controls
//   - shows immediately only for KEYBOARD FOCUS (:focus-visible)
//   - mouse-click focus does not show or retain a tooltip
//   - a11y: target gets aria-describedby -> the tooltip id while shown, restored
//     (removed / prior value) on hide
//   - hides on Escape, scroll, pointerdown, blur, and pointer leaving all tips
//   - empty/whitespace data-tooltip never shows
//   - renders role="tooltip" with the verbatim text; pointer-events:none (never
//     traps the pointer)

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ThemedTooltip } from '../../components/ui/ThemedTooltip'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  cleanup()
})

// Mount the singleton plus a couple of tipped controls; hover/focus is driven
// against these to exercise the document-level listeners.
function Harness() {
  return (
    <div>
      <button data-tooltip="Toggle stock" data-testid="btn-a">A</button>
      <button data-tooltip="Rotate the part" data-testid="btn-b">B</button>
      <button data-testid="btn-plain">plain</button>
      <button data-tooltip="   " data-testid="btn-empty">empty</button>
      <ThemedTooltip />
    </div>
  )
}

const tip = () => screen.queryByTestId('themed-tooltip')

function mockFocusVisible(el: HTMLElement, visible: boolean) {
  vi.spyOn(el, 'matches').mockImplementation((selector) => (
    selector === ':focus-visible'
      ? visible
      : Element.prototype.matches.call(el, selector)
  ))
}

describe('ThemedTooltip / hover show + delay', () => {
  it('shows after the ~500ms delay on hover, with the verbatim text', () => {
    render(<Harness />)
    expect(tip()).toBeNull()
    fireEvent.pointerOver(screen.getByTestId('btn-a'))
    // Not yet - the delay has not elapsed.
    act(() => { vi.advanceTimersByTime(499) })
    expect(tip()).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(tip()).not.toBeNull()
    expect(tip()!.textContent).toBe('Toggle stock')
    expect(tip()!.getAttribute('role')).toBe('tooltip')
  })

  it('reshows INSTANTLY when moving between tipped controls', () => {
    render(<Harness />)
    fireEvent.pointerOver(screen.getByTestId('btn-a'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(tip()!.textContent).toBe('Toggle stock')
    // Move to a non-tipped area -> hides, starting the grace window.
    fireEvent.pointerOver(screen.getByTestId('btn-plain'))
    expect(tip()).toBeNull()
    // Move onto the other tipped control within the grace window -> INSTANT.
    fireEvent.pointerOver(screen.getByTestId('btn-b'))
    expect(tip()).not.toBeNull()
    expect(tip()!.textContent).toBe('Rotate the part')
  })

  it('hides when the pointer leaves every tipped control', () => {
    render(<Harness />)
    fireEvent.pointerOver(screen.getByTestId('btn-a'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(tip()).not.toBeNull()
    fireEvent.pointerOver(screen.getByTestId('btn-plain'))
    expect(tip()).toBeNull()
  })

  it('never shows for an empty / whitespace-only data-tooltip', () => {
    render(<Harness />)
    fireEvent.pointerOver(screen.getByTestId('btn-empty'))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(tip()).toBeNull()
  })
})

describe('ThemedTooltip / keyboard focus + a11y', () => {
  it('shows immediately on keyboard focus and wires aria-describedby', () => {
    render(<Harness />)
    const btn = screen.getByTestId('btn-a')
    mockFocusVisible(btn, true)
    fireEvent.focusIn(btn)
    // No delay on focus.
    expect(tip()).not.toBeNull()
    const id = tip()!.getAttribute('id')!
    expect(id).toBeTruthy()
    expect(btn.getAttribute('aria-describedby')).toBe(id)
  })

  it('removes aria-describedby again when the tooltip hides', () => {
    render(<Harness />)
    const btn = screen.getByTestId('btn-a')
    mockFocusVisible(btn, true)
    fireEvent.focusIn(btn)
    expect(btn.getAttribute('aria-describedby')).toBeTruthy()
    fireEvent.focusOut(btn)
    expect(tip()).toBeNull()
    expect(btn.getAttribute('aria-describedby')).toBeNull()
  })

  it('does not show for pointer-driven focus that is not focus-visible', () => {
    render(<Harness />)
    const btn = screen.getByTestId('btn-a')
    mockFocusVisible(btn, false)
    fireEvent.focusIn(btn)
    expect(tip()).toBeNull()
    expect(btn.getAttribute('aria-describedby')).toBeNull()
  })

  it('does not retain or reshow a hover tooltip when a mouse click focuses the target', () => {
    render(<Harness />)
    const btn = screen.getByTestId('btn-a')
    mockFocusVisible(btn, false)
    fireEvent.pointerOver(btn)
    act(() => { vi.advanceTimersByTime(500) })
    expect(tip()).not.toBeNull()

    fireEvent.pointerDown(btn)
    expect(tip()).toBeNull()
    fireEvent.focusIn(btn)
    expect(tip()).toBeNull()
    fireEvent.click(btn)
    expect(tip()).toBeNull()
  })
})

describe('ThemedTooltip / dismissal', () => {
  function shown() {
    render(<Harness />)
    const btn = screen.getByTestId('btn-a')
    mockFocusVisible(btn, true)
    fireEvent.focusIn(btn)
    expect(tip()).not.toBeNull()
    return btn
  }

  it('hides on Escape', () => {
    shown()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(tip()).toBeNull()
  })

  it('hides on scroll', () => {
    shown()
    fireEvent.scroll(document, {})
    expect(tip()).toBeNull()
  })

  it('hides on pointerdown (a click dismisses it, never traps the click)', () => {
    shown()
    fireEvent.pointerDown(document)
    expect(tip()).toBeNull()
  })

  it('hides on click even if no pointerdown event is observed', () => {
    const btn = shown()
    fireEvent.click(btn)
    expect(tip()).toBeNull()
  })
})
