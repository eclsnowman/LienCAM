// @vitest-environment jsdom
//
// WO-2512 (Operator ruling 2026-10-03: "drag the bar to the left and instead of it being three icons wide it
// could be four (dynamic button layout)"): the Model screen's right-hand tool rail can be dragged
// wider through the panel-resize bar every other panel uses, never narrower than its default, the
// width is remembered with the other panel sizes, and every button grid on the rail fills the width
// (at least three columns, a new column each time one more button-width fits). The column count
// itself is browser layout; the real-Chromium half measures it (src/tests/evidence/WO-2512/).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Box, Circle } from 'lucide-react'
import { WorkbenchToolRail, type RailSection } from '../../components/model3d/workbench/WorkbenchToolRail'
import { useUiPrefs } from '../../store/uiPrefs'

const sections: RailSection[] = [
  { id: 'form-create', title: 'Start from', tools: [
    { testId: 't-box', label: 'Box', icon: Box, onClick: () => {} },
    { testId: 't-cyl', label: 'Cylinder', icon: Circle, onClick: () => {} },
  ] },
  { id: 'sketch-to-solid', title: 'Sketch to solid', tools: [
    { testId: 't-pull', label: 'Pull', icon: Circle, onClick: () => {} },
  ] },
]
const mount = (sketchActive = false) => render(
  <div data-testid="row"><WorkbenchToolRail sketchActive={sketchActive} modelingSections={sections} sketchHistoryTools={[]} onFinishSketch={() => {}} /></div>,
)
const rail = () => screen.getByTestId('workbench-right-rail')
const bar = () => screen.getByTestId('workbench-rail-resizer')
const stored = () => useUiPrefs.getState().panelSizes['workbench-rail']
const grids = () => Array.from(rail().querySelectorAll<HTMLElement>('.sketch-tool-grid'))
const REFLOW = 'repeat(auto-fill, minmax(min(4.875rem, calc(100% / 3 - 0.125rem)), 1fr))'

describe('WO-2512: the tool rail widens and its buttons reflow', () => {
  beforeEach(() => { window.localStorage.clear(); useUiPrefs.setState({ panelSizes: {} }) })
  afterEach(() => cleanup())

  it('at rest: the stylesheet width stands, the bar is the shared resize separator, every group fills its width', () => {
    mount()
    expect(rail().style.width).toBe('')
    expect(bar().getAttribute('role')).toBe('separator')
    expect(bar().classList.contains('panel-resizer')).toBe(true)
    expect(bar().querySelector('.panel-resizer-grip')).not.toBeNull()
    expect(bar().getAttribute('aria-valuenow')).toBe('260')
    expect(bar().getAttribute('aria-valuemin')).toBe('260')
    expect(grids()).toHaveLength(2)
    for (const g of grids()) expect(g.style.gridTemplateColumns).toBe(REFLOW)
  })

  it('dragging the left edge left widens the rail live; dragging back narrows it to its default, no further', () => {
    mount()
    fireEvent.pointerDown(bar(), { button: 0, clientX: 1000, pointerId: 1 })
    act(() => { window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 900, pointerId: 1 })) })
    expect(stored()).toBe(360)
    expect(rail().style.width).toBe('360px')
    expect(rail().style.minWidth).toBe('360px')
    act(() => { window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 1200, pointerId: 1 })) })
    expect(stored()).toBe(260)
    expect(rail().style.width).toBe('260px')
    act(() => { window.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1 })) })
    act(() => { window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 500, pointerId: 1 })) })
    expect(stored()).toBe(260)
  })

  it('keys step it like every resize bar: Left widens, Right narrows, Home/End go to the bounds', () => {
    mount()
    fireEvent.keyDown(bar(), { key: 'ArrowLeft' })
    expect(stored()).toBe(268)
    fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
    expect(stored()).toBe(300)
    fireEvent.keyDown(bar(), { key: 'ArrowRight' })
    expect(stored()).toBe(292)
    fireEvent.keyDown(bar(), { key: 'End' })
    expect(stored()).toBe(520)
    fireEvent.keyDown(bar(), { key: 'Home' })
    expect(stored()).toBe(260)
  })

  it('never squeezes the viewport: the row keeps 480 px beside the rail', () => {
    mount()
    const row = screen.getByTestId('row')
    row.getBoundingClientRect = () => ({ width: 820, height: 600, top: 0, left: 0, right: 820, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    fireEvent.keyDown(bar(), { key: 'End' })
    expect(stored()).toBe(340)
  })

  // Audit 2026-10-03: a width chosen in a wide window must give way when the row narrows,
  // and a remembered width must render inside the row it comes back to; the stored
  // preference itself is kept.
  it('a wide rail gives way when the window narrows: the viewport keeps its 480 px, the stored width stays', () => {
    const observers: Array<() => void> = []
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { observers.push(cb) } observe() {} disconnect() {} })
    let rowWidth = 1312
    const rect = (w: number) => ({ width: w, height: 600, top: 0, left: 0, right: w, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
    const real = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (this as HTMLElement).dataset?.testid === 'row' ? rect(rowWidth) : real.call(this)
    })
    try {
      mount()
      fireEvent.keyDown(bar(), { key: 'End' })
      expect(stored()).toBe(520)
      expect(rail().style.width).toBe('520px')
      rowWidth = 512
      act(() => { for (const cb of observers) cb() })
      expect(rail().style.width).toBe('260px')
      expect(rail().style.minWidth).toBe('260px')
      expect(stored()).toBe(520)
      rowWidth = 900
      act(() => { for (const cb of observers) cb() })
      expect(rail().style.width).toBe('420px')
      rowWidth = 1600
      act(() => { for (const cb of observers) cb() })
      expect(rail().style.width).toBe('520px')
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    }
  })

  it('a remembered wide rail comes back inside a narrow window', () => {
    const real = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (this as HTMLElement).dataset?.testid === 'row'
        ? { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }
        : real.call(this)
    })
    try {
      useUiPrefs.getState().setPanelSize('workbench-rail', 520)
      mount()
      expect(rail().style.width).toBe('320px')
      expect(stored()).toBe(520)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('the width is remembered: a fresh mount comes back at it, and double-click goes back to the default', () => {
    useUiPrefs.getState().setPanelSize('workbench-rail', 352)
    mount()
    expect(rail().style.width).toBe('352px')
    expect(bar().getAttribute('aria-valuenow')).toBe('352')
    fireEvent.doubleClick(bar())
    expect(stored()).toBeUndefined()
    expect(rail().style.width).toBe('')
  })

  it('a stored width outside the bounds renders inside them', () => {
    useUiPrefs.getState().setPanelSize('workbench-rail', 120)
    mount()
    expect(rail().style.width).toBe('260px')
    cleanup()
    useUiPrefs.getState().setPanelSize('workbench-rail', 2000)
    mount()
    expect(rail().style.width).toBe('520px')
  })

  it('compact keeps its own packed grid; the rail still resizes', () => {
    mount()
    fireEvent.click(screen.getByTestId('workbench-rail-compact'))
    for (const g of grids()) expect(g.style.gridTemplateColumns).toBe('')
    fireEvent.keyDown(bar(), { key: 'ArrowLeft' })
    expect(rail().style.width).toBe('268px')
  })

  it('the sketch tool groups reflow the same way', () => {
    mount(true)
    expect(rail().getAttribute('data-rail-mode')).toBe('sketch')
    expect(grids().length).toBeGreaterThan(3)
    for (const g of grids()) expect(g.style.gridTemplateColumns).toBe(REFLOW)
  })
})
