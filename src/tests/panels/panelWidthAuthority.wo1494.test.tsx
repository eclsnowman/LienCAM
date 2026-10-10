// @vitest-environment jsdom
//
// WO-1494 (BUG-475/BUG-476, shared cause): App.tsx's rendered panel style, the
// stored preference clamp, and PanelResizer's drag baseline/aria-valuenow/
// keyboard-step math each held a different partial truth about "how wide is
// this panel right now" — none reconciled against the others or against the
// viewport. These tests fail on main (verified by running this file against
// main's App.tsx/PanelResizer.tsx/uiPrefs.ts) and pass once every read goes
// through the one authority, resolveEffectivePanelWidth.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
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

// Viewport is out of this WO's owned paths and constructs a real WebGL
// context on mount, which jsdom cannot provide (same constraint documented in
// AppBottomConsole.smoke.test.tsx) — stub it so App can render at all.
vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const {
  useUiPrefs,
  resolveEffectivePanelWidth,
  APP_MAIN_MIN_WIDTH,
  PANEL_LEFT_MIN, PANEL_LEFT_MAX, PANEL_LEFT_DEFAULT,
  PANEL_RIGHT_MIN, PANEL_RIGHT_DEFAULT,
  PANEL_LEFT_WIDE_DEFAULT, PANEL_RIGHT_WIDE_DEFAULT,
} = await import('../../store/uiPrefs')

function setViewport(width: number, height: number, dpr = 1): void {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: height })
  Object.defineProperty(window, 'devicePixelRatio', { writable: true, configurable: true, value: dpr })
}

function panelStyleWidth(container: HTMLElement, selector: string): number {
  const el = container.querySelector<HTMLElement>(selector)
  if (!el) throw new Error(`missing ${selector}`)
  const px = el.style.width
  if (!px.endsWith('px')) throw new Error(`${selector} width is not a px value: ${px}`)
  return Number(px.slice(0, -2))
}

function resizerFor(side: 'left' | 'right'): HTMLElement {
  return screen.getByRole('separator', {
    name: side === 'left' ? 'Resize design tree panel' : 'Resize properties panel',
  })
}

afterEach(() => {
  cleanup()
  setViewport(1024, 768, 1)
})

beforeEach(() => {
  mem.clear()
  setViewport(1024, 768, 1)
  useUiPrefs.setState({
    panelLeftWidth: PANEL_LEFT_DEFAULT,
    panelRightWidth: PANEL_RIGHT_DEFAULT,
    panelLeftWidthCustomized: false,
    panelRightWidthCustomized: false,
    uiScale: 'auto',
  })
  useCamStore.getState().newProject()
})

describe('resolveEffectivePanelWidth (the one authority, WO-1494)', () => {
  it('passes stored widths through unchanged when the viewport comfortably fits both panels', () => {
    const inputs = {
      panelLeftWidth: PANEL_LEFT_DEFAULT, panelLeftWidthCustomized: false,
      panelRightWidth: PANEL_RIGHT_DEFAULT, panelRightWidthCustomized: false,
      viewportCssWidth: 1920, uiScale: 1,
    }
    expect(resolveEffectivePanelWidth('left', inputs)).toBe(PANEL_LEFT_DEFAULT)
    expect(resolveEffectivePanelWidth('right', inputs)).toBe(PANEL_RIGHT_DEFAULT)
  })

  it('BUG-475: compresses both panels (never below their own min) when the sum would leave .app-main below its usable minimum', () => {
    const inputs = {
      panelLeftWidth: 460, panelLeftWidthCustomized: true,
      panelRightWidth: 452, panelRightWidthCustomized: true,
      viewportCssWidth: 900, uiScale: 1,
    }
    const left = resolveEffectivePanelWidth('left', inputs)
    const right = resolveEffectivePanelWidth('right', inputs)
    expect(left).toBe(333)
    expect(right).toBe(327)
    expect(left).toBeGreaterThanOrEqual(PANEL_LEFT_MIN)
    expect(right).toBeGreaterThanOrEqual(PANEL_RIGHT_MIN)
    expect(900 - (left + right)).toBe(APP_MAIN_MIN_WIDTH)
  })

  it('BUG-476: the wide-screen default scales by uiScale exactly like the CSS rem path it replaces', () => {
    const inputs = {
      panelLeftWidth: PANEL_LEFT_DEFAULT, panelLeftWidthCustomized: false,
      panelRightWidth: PANEL_RIGHT_DEFAULT, panelRightWidthCustomized: false,
      viewportCssWidth: 3840, uiScale: 1.5,
    }
    expect(resolveEffectivePanelWidth('left', inputs)).toBe(PANEL_LEFT_WIDE_DEFAULT * 1.5)
    expect(resolveEffectivePanelWidth('right', inputs)).toBe(PANEL_RIGHT_WIDE_DEFAULT * 1.5)
  })
})

describe('App + PanelResizer share the one panel-width authority (WO-1494)', () => {
  it('criterion 1 (BUG-475 repro): shrinking to 900x700 with 460/452px panels leaves .app-main at the usable minimum, not 0px, and both panels stay present', () => {
    useUiPrefs.setState({
      panelLeftWidth: 460, panelLeftWidthCustomized: true,
      panelRightWidth: 452, panelRightWidthCustomized: true,
    })
    setViewport(900, 700, 1)
    const { container } = render(<App />)

    const leftW = panelStyleWidth(container, '.panel-left')
    const rightW = panelStyleWidth(container, '.panel-right')
    const mainW = 900 - (leftW + rightW)

    expect(mainW).toBeGreaterThanOrEqual(APP_MAIN_MIN_WIDTH)
    expect(mainW).not.toBe(0)
    expect(leftW).toBeGreaterThanOrEqual(PANEL_LEFT_MIN)
    expect(rightW).toBeGreaterThanOrEqual(PANEL_RIGHT_MIN)
    expect(container.querySelector('.panel-left')).toBeTruthy()
    expect(container.querySelector('.panel-right')).toBeTruthy()
  })

  it('criterion 2 (BUG-476 repro): at 3840x1600/DPR1 (auto-scale 150%), the resizer baseline/aria-valuenow equals the actually-rendered CSS width, not the raw unscaled preference', () => {
    setViewport(3840, 1600, 1)
    const { container } = render(<App />)

    const renderedLeftW = panelStyleWidth(container, '.panel-left')
    expect(renderedLeftW).toBe(PANEL_LEFT_WIDE_DEFAULT * 1.5) // 480 — scaled, not the raw 280 default
    expect(renderedLeftW).not.toBe(PANEL_LEFT_DEFAULT)

    const handle = resizerFor('left')
    expect(handle.getAttribute('aria-valuenow')).toBe(String(renderedLeftW))
  })

  it('criterion 3: a single ArrowRight on the left resizer at that same wide/auto-scaled state widens the panel from its actual rendered width', () => {
    setViewport(3840, 1600, 1)
    const { container } = render(<App />)

    const before = panelStyleWidth(container, '.panel-left')
    const handle = resizerFor('left')
    expect(handle.getAttribute('aria-valuenow')).toBe(String(before))

    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    const after = panelStyleWidth(container, '.panel-left')
    expect(after).toBeGreaterThan(before)
    expect(useUiPrefs.getState().panelLeftWidth).toBeLessThanOrEqual(PANEL_LEFT_MAX)
  })

  it('fix round (audit FAIL): ArrowRight/ArrowLeft in the COMPRESSED state still move the rendered panel in the expected direction', () => {
    // Audit repro exactly: 400/452 stored (customized) at 900x700 compresses
    // the left panel to 310px effective. Before the fix, `setPanelWidth`
    // stored the EFFECTIVE width + step (318) as the new preference, which
    // resolveEffectivePanelWidth then compressed a SECOND time down to 273 —
    // an ArrowRight that shrank the rendered panel instead of widening it.
    useUiPrefs.setState({
      panelLeftWidth: 400, panelLeftWidthCustomized: true,
      panelRightWidth: 452, panelRightWidthCustomized: true,
    })
    setViewport(900, 700, 1)
    const { container } = render(<App />)
    const handle = resizerFor('left')

    const before = panelStyleWidth(container, '.panel-left')
    expect(before).toBe(310) // sanity: still in the compressed branch

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    const afterRight = panelStyleWidth(container, '.panel-left')
    expect(afterRight).toBeGreaterThan(before)
    expect(handle.getAttribute('aria-valuenow')).toBe(String(afterRight))

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    const afterLeft = panelStyleWidth(container, '.panel-left')
    expect(afterLeft).toBeLessThan(afterRight)
  })

  it('fix round (audit FAIL): dragging right in the COMPRESSED state still widens the rendered panel', () => {
    useUiPrefs.setState({
      panelLeftWidth: 400, panelLeftWidthCustomized: true,
      panelRightWidth: 452, panelRightWidthCustomized: true,
    })
    setViewport(900, 700, 1)
    const { container } = render(<App />)
    const handle = resizerFor('left')
    ;(handle as unknown as { setPointerCapture(id: number): void }).setPointerCapture = () => {}
    ;(handle as unknown as { releasePointerCapture(id: number): void }).releasePointerCapture = () => {}

    const before = panelStyleWidth(container, '.panel-left')
    fireEvent(handle, new PointerEvent('pointerdown', {
      clientX: 100, pointerId: 1, button: 0, bubbles: true, cancelable: true,
    }))
    fireEvent(window, new PointerEvent('pointermove', {
      clientX: 140, pointerId: 1, bubbles: true, cancelable: true,
    }))
    const afterDragRight = panelStyleWidth(container, '.panel-left')
    expect(afterDragRight).toBeGreaterThan(before)
  })

  it('re-queue audit FAIL: narrowing a panel already at its MIN in a compressed window never raises its stored preference or disturbs the other panel', () => {
    // Audit repro exactly: 800x700, left=220 (already at PANEL_LEFT_MIN,
    // customized), right=460 (customized). Before this fix,
    // resolvePreferenceForEffectiveWidth inverted the compression formula
    // for the ArrowLeft target (212, below the left panel's own floor) and
    // landed on 280 — HIGHER than the 220 already stored — which also
    // shrank the right panel's effective width as an unwanted side effect.
    useUiPrefs.setState({
      panelLeftWidth: PANEL_LEFT_MIN, panelLeftWidthCustomized: true,
      panelRightWidth: 460, panelRightWidthCustomized: true,
    })
    setViewport(800, 700, 1)
    const { container } = render(<App />)
    const handle = resizerFor('left')

    const leftBefore = panelStyleWidth(container, '.panel-left')
    const rightBefore = panelStyleWidth(container, '.panel-right')
    expect(leftBefore).toBe(PANEL_LEFT_MIN) // sanity: floored, in the compressed branch

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })

    expect(useUiPrefs.getState().panelLeftWidth).toBeLessThanOrEqual(PANEL_LEFT_MIN)
    const leftAfter = panelStyleWidth(container, '.panel-left')
    const rightAfter = panelStyleWidth(container, '.panel-right')
    expect(leftAfter).toBe(PANEL_LEFT_MIN)
    expect(rightAfter).toBe(rightBefore)
  })

  it('criterion 6: normal (non-wide, non-shrunk) viewport keyboard resize and reset behave exactly as before — no regression', () => {
    setViewport(1024, 768, 1)
    render(<App />)
    const handle = resizerFor('left')

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_DEFAULT + 8)

    fireEvent.keyDown(handle, { key: 'Enter' })
    expect(useUiPrefs.getState().panelLeftWidth).toBe(PANEL_LEFT_DEFAULT)
    expect(useUiPrefs.getState().panelLeftWidthCustomized).toBe(false)
  })
})
