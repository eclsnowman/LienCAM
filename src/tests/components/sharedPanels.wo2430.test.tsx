// @vitest-environment jsdom
// WO-2430: the shared resizable split and collapsible panel. Drives the real
// components (pointer drag, arrow keys, double-click reset, the chevron) and
// proves sizes and collapsed state come back after a reload through the UI
// preferences store, and that no pane is ever squeezed below its minimum.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizableSplit, SPLIT_BAR_PX, splitBounds } from '../../components/common/ResizableSplit'
import { CollapsiblePanel } from '../../components/common/CollapsiblePanel'
import { PERSISTED_USER_DATA_REGISTRY } from '../../store/persistedKeys'
import { useUiPrefs } from '../../store/uiPrefs'

const uiKey = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key
const KEY = 'test-split'

function pointer(type: string, init: { clientX?: number; clientY?: number; pointerId?: number; button?: number }) {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
  const event = new Ctor(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0, button: init.button ?? 0 })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  return event
}

function mountSplit(props: Partial<Parameters<typeof ResizableSplit>[0]> = {}) {
  return render(
    <ResizableSplit
      prefKey={KEY}
      testId="split"
      sizedPane="second"
      defaultSize={280}
      minSize={240}
      maxSize={520}
      fillMinSize={440}
      label="Resize the test panels"
      first={<section data-testid="fill">fill</section>}
      second={<aside data-testid="sized">sized</aside>}
      {...props}
    />,
  )
}

const bar = () => screen.getByTestId('split-bar')
const sizedPane = () => screen.getByTestId('sized').parentElement as HTMLElement
const fillPane = () => screen.getByTestId('fill').parentElement as HTMLElement

/** Simulate an app restart: put the saved blob back after wiping live state,
 *  then rehydrate the store from storage exactly as boot does. */
async function reload() {
  const saved = window.localStorage.getItem(uiKey)
  act(() => { useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} }) })
  if (saved !== null) window.localStorage.setItem(uiKey, saved)
  await act(async () => { await useUiPrefs.persist.rehydrate() })
}

describe('WO-2430 shared ResizableSplit', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('starts at the screen default with a focusable, labelled separator', () => {
    mountSplit()
    expect(bar().getAttribute('role')).toBe('separator')
    expect(bar().getAttribute('aria-orientation')).toBe('vertical')
    expect(bar().getAttribute('aria-label')).toBe('Resize the test panels')
    expect(bar().tabIndex).toBe(0)
    expect(bar().className).toContain('panel-resizer')
    expect(bar().getAttribute('aria-valuenow')).toBe('280')
    expect(sizedPane().style.width).toBe('280px')
    expect(sizedPane().style.minWidth).toBe('240px')
    expect(fillPane().style.minWidth).toBe('440px')
  })

  it('pointer drag moves the boundary live, both ways, and stops at the bounds', () => {
    mountSplit()
    fireEvent(bar(), pointer('pointerdown', { clientX: 1000 }))
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 900 })) })
    // The sized pane is on the right, so dragging left widens it.
    expect(sizedPane().style.width).toBe('380px')
    expect(useUiPrefs.getState().panelSizes[KEY]).toBe(380)
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 1020 })) })
    expect(sizedPane().style.width).toBe('260px')
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 1500 })) })
    expect(sizedPane().style.width).toBe('240px')
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 0 })) })
    expect(sizedPane().style.width).toBe('520px')
    act(() => { window.dispatchEvent(pointer('pointerup', {})) })
    // After release, moving the pointer changes nothing.
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 900 })) })
    expect(sizedPane().style.width).toBe('520px')
  })

  it('a sized FIRST pane grows with a rightward drag', () => {
    render(
      <ResizableSplit prefKey={KEY} testId="split" sizedPane="first" defaultSize={300} minSize={200}
        maxSize={600} fillMinSize={100} label="l" first={<div data-testid="a" />} second={<div data-testid="b" />} />,
    )
    fireEvent(bar(), pointer('pointerdown', { clientX: 300 }))
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 350 })) })
    act(() => { window.dispatchEvent(pointer('pointerup', {})) })
    expect((screen.getByTestId('a').parentElement as HTMLElement).style.width).toBe('350px')
  })

  it('arrow keys step the bar (Shift = big step), Home/End go to the bounds', () => {
    mountSplit()
    fireEvent.keyDown(bar(), { key: 'ArrowLeft' })
    expect(sizedPane().style.width).toBe('288px')
    fireEvent.keyDown(bar(), { key: 'ArrowRight', shiftKey: true })
    expect(sizedPane().style.width).toBe('256px')
    fireEvent.keyDown(bar(), { key: 'ArrowRight', shiftKey: true })
    expect(sizedPane().style.width).toBe('240px')
    fireEvent.keyDown(bar(), { key: 'End' })
    expect(sizedPane().style.width).toBe('520px')
    fireEvent.keyDown(bar(), { key: 'Home' })
    expect(sizedPane().style.width).toBe('240px')
    expect(bar().getAttribute('aria-valuenow')).toBe('240')
  })

  it('an arrow key the bar uses never reaches the window, where Control jogs the machine on arrows', () => {
    const windowKeys: string[] = []
    const onWindowKey = (e: KeyboardEvent) => { windowKeys.push(e.key) }
    window.addEventListener('keydown', onWindowKey)
    try {
      mountSplit()
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Home', 'End']) fireEvent.keyDown(bar(), { key })
      // ArrowUp is not a horizontal bar key, so it passes through untouched.
      expect(windowKeys).toEqual(['ArrowUp'])
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })

  it('double-click resets to the default', () => {
    mountSplit()
    fireEvent.keyDown(bar(), { key: 'End' })
    expect(sizedPane().style.width).toBe('520px')
    fireEvent.doubleClick(bar())
    expect(sizedPane().style.width).toBe('280px')
    expect(useUiPrefs.getState().panelSizes[KEY]).toBeUndefined()
  })

  it('the size survives a reload through the UI preferences store', async () => {
    mountSplit()
    fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
    expect(sizedPane().style.width).toBe('312px')
    cleanup()
    await reload()
    expect(useUiPrefs.getState().panelSizes[KEY]).toBe(312)
    mountSplit()
    expect(sizedPane().style.width).toBe('312px')
  })

  it('never squeezes the fill pane below its minimum: the sized pane is clamped to the container', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = this.classList.contains('resizable-split') ? 900 : 0
      return { x: 0, y: 0, top: 0, left: 0, width, height: 600, right: width, bottom: 600, toJSON: () => ({}) } as DOMRect
    })
    const [lo, hi] = splitBounds(900, { minSize: 240, maxSize: 520, fillMinSize: 440 })
    expect([lo, hi]).toEqual([240, 900 - SPLIT_BAR_PX - 440])
    mountSplit()
    fireEvent.keyDown(bar(), { key: 'End' })
    expect(sizedPane().style.width).toBe(`${hi}px`)
    fireEvent(bar(), pointer('pointerdown', { clientX: 600 }))
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 0 })) })
    act(() => { window.dispatchEvent(pointer('pointerup', {})) })
    expect(sizedPane().style.width).toBe(`${hi}px`)
    // A stale stored size larger than the room is clamped on render too.
    act(() => { useUiPrefs.getState().setPanelSize(KEY, 999) })
    expect(sizedPane().style.width).toBe(`${hi}px`)
    // And the sized pane's own minimum wins over a too-small container.
    expect(splitBounds(500, { minSize: 240, maxSize: 520, fillMinSize: 440 })).toEqual([240, 240])
  })

  it('a stored size below the minimum, or junk in storage, never shrinks the pane', async () => {
    act(() => { useUiPrefs.getState().setPanelSize(KEY, 10) })
    mountSplit()
    expect(sizedPane().style.width).toBe('240px')
    cleanup()
    window.localStorage.setItem(uiKey, JSON.stringify({
      state: { panelSizes: { [KEY]: 'wide', other: -4, ok: 300 } }, version: 1,
    }))
    await act(async () => { await useUiPrefs.persist.rehydrate() })
    expect(useUiPrefs.getState().panelSizes).toEqual({ ok: 300 })
    mountSplit()
    expect(sizedPane().style.width).toBe('280px')
  })

  it('vertical orientation uses heights and up/down keys', () => {
    mountSplit({ orientation: 'vertical' })
    expect(bar().getAttribute('aria-orientation')).toBe('horizontal')
    expect(sizedPane().style.height).toBe('280px')
    fireEvent.keyDown(bar(), { key: 'ArrowUp' })
    expect(sizedPane().style.height).toBe('288px')
    fireEvent(bar(), pointer('pointerdown', { clientY: 500 }))
    act(() => { window.dispatchEvent(pointer('pointermove', { clientY: 540 })) })
    act(() => { window.dispatchEvent(pointer('pointerup', {})) })
    expect(sizedPane().style.height).toBe('248px')
  })

  it('a collapsed sized pane rests the bar: no drag, no keys, not in the tab order', () => {
    mountSplit({ orientation: 'vertical', sizedCollapsed: true })
    expect(bar().getAttribute('role')).toBeNull()
    expect(bar().tabIndex).toBe(-1)
    expect(sizedPane().style.height).toBe('')
    fireEvent.keyDown(bar(), { key: 'End' })
    fireEvent(bar(), pointer('pointerdown', { clientY: 500 }))
    act(() => { window.dispatchEvent(pointer('pointermove', { clientY: 0 })) })
    act(() => { window.dispatchEvent(pointer('pointerup', {})) })
    expect(useUiPrefs.getState().panelSizes[KEY]).toBeUndefined()
  })
})

describe('WO-2430 shared CollapsiblePanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} })
  })
  afterEach(() => { cleanup() })

  const mountPanel = (defaultCollapsed = false) => render(
    <CollapsiblePanel panelKey="test-panel" testId="p" title="Jog" defaultCollapsed={defaultCollapsed}
      headerExtra={<span data-testid="meta">meta</span>}
      collapsedSummary={<span data-testid="summary">X 1.000</span>}>
      <button data-testid="inner">Go</button>
    </CollapsiblePanel>,
  )

  it('the chevron collapses the panel to its header and back', () => {
    mountPanel()
    const toggle = screen.getByTestId('p-collapse')
    expect(toggle.className).toBe('panel-action-btn')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('Collapse the jog')
    expect(screen.getByTestId('inner')).toBeTruthy()
    expect(screen.queryByTestId('summary')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByTestId('p').getAttribute('data-collapsed')).toBe('true')
    expect(screen.queryByTestId('inner')).toBeNull()
    // The header stays: title, meta, the collapsed readout and the chevron.
    expect(screen.getByText('Jog')).toBeTruthy()
    expect(screen.getByTestId('meta')).toBeTruthy()
    expect(screen.getByTestId('summary').textContent).toBe('X 1.000')
    expect(screen.getByTestId('p-collapse').getAttribute('aria-label')).toBe('Expand the jog')
    fireEvent.click(screen.getByTestId('p-collapse'))
    expect(screen.getByTestId('inner')).toBeTruthy()
  })

  it('collapsed state survives a reload through the UI preferences store', async () => {
    mountPanel()
    fireEvent.click(screen.getByTestId('p-collapse'))
    cleanup()
    await reload()
    expect(useUiPrefs.getState().collapsedPropsGroups['test-panel']).toBe(true)
    mountPanel()
    expect(screen.getByTestId('p').getAttribute('data-collapsed')).toBe('true')
  })

  it('a panel folded by default remembers being opened', async () => {
    mountPanel(true)
    expect(screen.getByTestId('p').getAttribute('data-collapsed')).toBe('true')
    fireEvent.click(screen.getByTestId('p-collapse'))
    expect(screen.getByTestId('inner')).toBeTruthy()
    cleanup()
    await reload()
    mountPanel(true)
    expect(screen.getByTestId('p').getAttribute('data-collapsed')).toBe('false')
  })
})
