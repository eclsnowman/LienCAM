// @vitest-environment jsdom
//
// WO-1495 / BUG-477: a canceled touch resize left the splitter drag armed.
// PanelResizer attached window pointermove/pointerup listeners on
// pointerdown but never pointercancel or lostpointercapture, and never took
// pointer capture, so Chromium's touch-emulation pointercancel (fired after
// a move) left the col-resize cursor, userSelect lock, and window listener
// live -- the next plain mouse hover (no button held) still resized the
// panel. These tests fail on main before the fix and stay green after it;
// they also cover the existing mouse-drag/keyboard-resize behavior since no
// PanelResizer test file existed before this WO.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PanelResizer } from '../../components/panels/PanelResizer'
import {
  useUiPrefs,
  PANEL_LEFT_DEFAULT, PANEL_RIGHT_DEFAULT,
} from '../../store/uiPrefs'

afterEach(cleanup)

beforeEach(() => {
  useUiPrefs.setState({
    panelLeftWidth: PANEL_LEFT_DEFAULT,
    panelRightWidth: PANEL_RIGHT_DEFAULT,
    panelLeftWidthCustomized: false,
    panelRightWidthCustomized: false,
  })
})

// jsdom implements no Pointer Capture API at all -- production code
// try/catches both calls (so it survives here unstubbed), but the
// lostpointercapture recovery test needs a real event to fire, which only
// happens on a real DOM in a real browser. Stub the two calls so the
// pointerdown handler's capture call does not silently no-op, and dispatch
// 'lostpointercapture' by hand to stand in for the browser doing it.
function stubPointerCapture(el: Element): { captured: number[]; released: number[] } {
  const captured: number[] = []
  const released: number[] = []
  ;(el as unknown as { setPointerCapture(id: number): void }).setPointerCapture = (id) => { captured.push(id) }
  ;(el as unknown as { releasePointerCapture(id: number): void }).releasePointerCapture = (id) => { released.push(id) }
  return { captured, released }
}

function firePointer(el: Element | Window, type: string, clientX: number, pointerId = 1): void {
  fireEvent(el, new PointerEvent(type, { clientX, pointerId, button: 0, bubbles: true, cancelable: true }))
}

describe('PanelResizer pointer lifecycle (WO-1495, BUG-477)', () => {
  it('pointercancel mid-drag disarms the drag: a later no-button pointermove no longer resizes, and cursor/userSelect clear', () => {
    render(<PanelResizer side="left" />)
    const handle = screen.getByRole('separator')
    stubPointerCapture(handle)

    act(() => { firePointer(handle, 'pointerdown', 100) })
    act(() => { firePointer(window, 'pointermove', 140) })
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_DEFAULT + 40)
    expect(document.body.style.cursor).toBe('col-resize')

    act(() => { firePointer(window, 'pointercancel', 140) })

    const widthAfterCancel = useUiPrefs.getState().panelLeftWidth
    // A plain hover, no button pressed, on the pointer that started the drag.
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', {
        clientX: 300, pointerId: 1, buttons: 0, bubbles: true, cancelable: true,
      }))
      window.dispatchEvent(new PointerEvent('pointermove', {
        clientX: 300, pointerId: 1, buttons: 0, bubbles: true, cancelable: true,
      }))
    })

    expect(useUiPrefs.getState().panelLeftWidth).toBe(widthAfterCancel)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('lostpointercapture (no pointerup, no pointercancel) recovers the same way', () => {
    render(<PanelResizer side="left" />)
    const handle = screen.getByRole('separator')
    stubPointerCapture(handle)

    act(() => { firePointer(handle, 'pointerdown', 100) })
    act(() => { firePointer(window, 'pointermove', 150) })
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_DEFAULT + 50)

    act(() => {
      handle.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true }))
    })

    const widthAfterLoss = useUiPrefs.getState().panelLeftWidth
    act(() => { firePointer(window, 'pointermove', 400) })

    expect(useUiPrefs.getState().panelLeftWidth).toBe(widthAfterLoss)
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })

  it('normal mouse drag still resizes and pointerup ends it cleanly', () => {
    render(<PanelResizer side="left" />)
    const handle = screen.getByRole('separator')
    stubPointerCapture(handle)

    act(() => { firePointer(handle, 'pointerdown', 100) })
    act(() => { firePointer(window, 'pointermove', 130) })
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_DEFAULT + 30)
    expect(document.body.style.cursor).toBe('col-resize')

    act(() => { firePointer(window, 'pointerup', 130) })
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    const widthAfterUp = useUiPrefs.getState().panelLeftWidth
    act(() => { firePointer(window, 'pointermove', 500) })
    expect(useUiPrefs.getState().panelLeftWidth).toBe(widthAfterUp)
  })

  it('double-click resets to default', () => {
    render(<PanelResizer side="left" />)
    const handle = screen.getByRole('separator')
    stubPointerCapture(handle)

    act(() => { firePointer(handle, 'pointerdown', 100) })
    act(() => { firePointer(window, 'pointermove', 150) })
    act(() => { firePointer(window, 'pointerup', 150) })
    expect(useUiPrefs.getState().panelLeftWidth).not.toBe(PANEL_LEFT_DEFAULT)

    fireEvent.doubleClick(handle)
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_DEFAULT)
  })

  it('arrow keys resize the panel (keyboard path unaffected by the pointer fix)', () => {
    render(<PanelResizer side="left" />)
    const handle = screen.getByRole('separator')

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_DEFAULT + 8)

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_DEFAULT)
  })

  it('unmounting mid-drag cleans up the window listener and document state', () => {
    const { unmount } = render(<PanelResizer side="left" />)
    const handle = screen.getByRole('separator')
    stubPointerCapture(handle)

    act(() => { firePointer(handle, 'pointerdown', 100) })
    act(() => { firePointer(window, 'pointermove', 150) })
    expect(document.body.style.cursor).toBe('col-resize')

    act(() => { unmount() })
    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')

    // No listener should remain to react to further movement.
    expect(() => {
      act(() => { firePointer(window, 'pointermove', 999) })
    }).not.toThrow()
  })
})
