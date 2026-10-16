// @vitest-environment jsdom
// WO-2728: real menu and navigation controller; full Viewport wiring is exercised
// by the companion Playwright capture against the production build.
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PerspectiveCamera } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createNavPresetController } from '../../lib/viewport/navPresetController'
import { ViewportContextMenu } from '../../components/viewport/ViewportContextMenu'

afterEach(cleanup)

function Viewport() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return <div className="viewport-canvas" onContextMenu={event => {
    event.preventDefault()
    setAt({ x: event.clientX, y: event.clientY })
  }}>
    {at && <ViewportContextMenu at={at} target={{ kind: 'empty' }}
      visibility={{ stock: true, workpiece: true, toolpath: true, grid: true }}
      onAction={() => {}} onClose={() => setAt(null)} />}
  </div>
}
function canvas() { return document.querySelector('.viewport-canvas') as HTMLElement }
function rightPointerDown(x: number, y: number) {
  fireEvent.pointerDown(canvas(), { button: 2, clientX: x, clientY: y })
}
function nativeContextMenu(x: number, y: number) {
  fireEvent.contextMenu(canvas(), { clientX: x, clientY: y })
}

describe('release-order navigation suppression remains unchanged (WO-2728)', () => {
  it.each([[140, true], [102, false], [100, false]])('release at x=%s reports drag=%s', (x, dragged) => {
    const element = document.createElement('canvas')
    const controls = new OrbitControls(new PerspectiveCamera(), element)
    controls.enabled = false // No pointer capture in jsdom; navigation tracking remains active.
    const nav = createNavPresetController(controls, element)
    try {
      fireEvent.pointerDown(element, { button: 2, clientX: 100, clientY: 100 })
      fireEvent.pointerUp(element, { button: 2, clientX: x, clientY: 100 })
      expect(nav.consumeRightButtonWasDrag(x, 100, 25)).toBe(dragged)
      expect(nav.consumeRightButtonWasDrag(x, 100, 25)).toBe(false)
    } finally { nav.dispose(); controls.dispose() }
  })
})
function move(x: number, y: number, buttons = 2, target: Window | Element = canvas()) {
  fireEvent(target, new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons }))
}
function openOnPress() {
  render(<Viewport />)
  rightPointerDown(100, 100)
  nativeContextMenu(100, 100)
  expect(screen.queryByTestId('viewport-context-menu')).not.toBeNull()
}

describe('press-order dismissal (WO-2728)', () => {
  it('closes after 10 px while right is held and leaves the pan event untouched', () => {
    openOnPress()
    const pan = vi.fn()
    canvas().addEventListener('pointermove', pan)
    move(111, 100)
    expect(screen.queryByTestId('viewport-context-menu')).toBeNull()
    expect(pan).toHaveBeenCalledOnce()
    expect(pan.mock.calls[0][0].defaultPrevented).toBe(false)
  })
  it.each([[109, 100], [106, 108], [100, 90]])('keeps jitter / the exact 10 px boundary (%s,%s)', (x, y) => {
    openOnPress()
    move(x, y)
    expect(screen.queryByTestId('viewport-context-menu')).not.toBeNull()
  })
  it('uses distance, including diagonal movement over the boundary', () => {
    openOnPress()
    move(108, 108)
    expect(screen.queryByTestId('viewport-context-menu')).toBeNull()
  })
  it.each(['pointerup', 'pointercancel', 'blur'])('stops tracking permanently after %s', (event) => {
    openOnPress()
    fireEvent(window, new Event(event))
    move(140, 100)
    expect(screen.queryByTestId('viewport-context-menu')).not.toBeNull()
  })
  it.each([0, 1, 4])('does not dismiss for buttons=%s or rearm after release', (buttons) => {
    openOnPress()
    move(140, 100, buttons)
    move(140, 100, 2)
    expect(screen.queryByTestId('viewport-context-menu')).not.toBeNull()
  })
  it('sees movement over the menu rather than only over the canvas', () => {
    openOnPress()
    move(120, 100, 2, screen.getByTestId('viewport-context-menu'))
    expect(screen.queryByTestId('viewport-context-menu')).toBeNull()
  })
  it('does not apply the opening gesture to a new press inside the menu', () => {
    openOnPress()
    fireEvent.pointerUp(canvas(), { button: 2 })
    fireEvent.pointerDown(screen.getByTestId('viewport-context-menu'), { button: 2 })
    move(140, 100)
    expect(screen.queryByTestId('viewport-context-menu')).not.toBeNull()
  })
  it('keeps a release-order click menu open while hovering its commands', () => {
    render(<Viewport />)
    rightPointerDown(100, 100)
    fireEvent.pointerUp(canvas(), { button: 2 })
    nativeContextMenu(100, 100)
    move(140, 100, 0)
    expect(screen.queryByTestId('viewport-context-menu')).not.toBeNull()
  })
  it('rearms for the next menu after a dismissed drag', () => {
    openOnPress()
    move(140, 100)
    fireEvent.pointerUp(canvas(), { button: 2 })
    rightPointerDown(200, 200)
    nativeContextMenu(200, 200)
    move(205, 200)
    expect(screen.queryByTestId('viewport-context-menu')).not.toBeNull()
    move(211, 200)
    expect(screen.queryByTestId('viewport-context-menu')).toBeNull()
  })
})



describe('menu gesture lifetime (WO-2728)', () => {
  const at = { x: 100, y: 100 }
  const props = { at, target: { kind: 'empty' as const }, visibility: { stock: true, workpiece: true, toolpath: true, grid: true }, onAction: () => {} }
  it('does not rearm after release when the parent rerenders', () => {
    const firstClose = vi.fn(), nextClose = vi.fn()
    const view = render(<ViewportContextMenu {...props} onClose={firstClose} />)
    fireEvent(window, new Event('pointerup'))
    view.rerender(<ViewportContextMenu {...props} onClose={nextClose} />)
    move(140, 100, 2, window)
    expect(firstClose).not.toHaveBeenCalled()
    expect(nextClose).not.toHaveBeenCalled()
  })
  it('uses the latest callback during the same held gesture', () => {
    const firstClose = vi.fn(), nextClose = vi.fn()
    const view = render(<ViewportContextMenu {...props} onClose={firstClose} />)
    view.rerender(<ViewportContextMenu {...props} onClose={nextClose} />)
    move(140, 100, 2, window)
    expect(firstClose).not.toHaveBeenCalled()
    expect(nextClose).toHaveBeenCalledOnce()
    move(160, 100, 2, window)
    expect(nextClose).toHaveBeenCalledOnce()
  })
  it('removes the listener on unmount', () => {
    const close = vi.fn()
    const view = render(<ViewportContextMenu {...props} onClose={close} />)
    view.unmount()
    move(140, 100, 2, window)
    expect(close).not.toHaveBeenCalled()
  })
})
