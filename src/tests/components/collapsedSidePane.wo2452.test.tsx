// @vitest-environment jsdom
// WO-2452: a collapsed side-by-side sized pane shrinks to a narrow strip and
// the fill pane takes the freed width; expanding restores the stored width;
// stacked splits behave as before.

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLAPSED_STRIP_PX, ResizableSplit, SPLIT_BAR_PX } from '../../components/common/ResizableSplit'
import { PanelCollapseToggle, usePanelCollapsed } from '../../components/common/CollapsiblePanel'
import { useUiPrefs } from '../../store/uiPrefs'

const KEY = 'wo2452-split'
const CONTAINER = 1000

function Harness({ orientation }: { orientation: 'horizontal' | 'vertical' }) {
  const collapsed = usePanelCollapsed(KEY)
  return (
    <ResizableSplit
      prefKey={KEY}
      testId="split"
      orientation={orientation}
      sizedPane="first"
      defaultSize={280}
      minSize={220}
      maxSize={460}
      fillMinSize={400}
      label="Resize"
      sizedCollapsed={collapsed}
      first={<aside data-testid="sized"><PanelCollapseToggle panelKey={KEY} testId="tog" collapseTip="Collapse" expandTip="Expand" /></aside>}
      second={<section data-testid="fill">fill</section>}
    />
  )
}

const sizedPane = () => screen.getByTestId('sized').parentElement as HTMLElement
const fillPane = () => screen.getByTestId('fill').parentElement as HTMLElement
// jsdom has no layout: the width a pane gets is the container minus the bar
// minus the sized pane's declared width (the fill pane is flex: 1 1 0).
const fillWidth = () => CONTAINER - SPLIT_BAR_PX - parseFloat(sizedPane().style.width)

describe('WO-2452 collapsed side pane gives width back', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { width: CONTAINER, height: 600, top: 0, left: 0, right: CONTAINER, bottom: 600, x: 0, y: 0, toJSON: () => ({}) },
    )
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('side by side: collapsing shrinks to a strip, the fill pane grows, expanding restores', () => {
    render(<Harness orientation="horizontal" />)
    expect(sizedPane().style.width).toBe('280px')
    const before = fillWidth()
    act(() => screen.getByTestId('tog').click())
    expect(sizedPane().style.width).toBe(`${COLLAPSED_STRIP_PX}px`)
    expect(sizedPane().classList.contains('resizable-split-strip')).toBe(true)
    expect(screen.getByTestId('tog')).toBeTruthy() // expand control still present
    expect(fillWidth() - before).toBeGreaterThanOrEqual(280 - COLLAPSED_STRIP_PX)
    expect(fillPane().style.minWidth).toBe('400px')
    act(() => screen.getByTestId('tog').click())
    expect(sizedPane().style.width).toBe('280px')
    expect(sizedPane().classList.contains('resizable-split-strip')).toBe(false)
  })

  it('a dragged width is restored after collapse and expand', () => {
    useUiPrefs.getState().setPanelSize(KEY, 360)
    render(<Harness orientation="horizontal" />)
    act(() => screen.getByTestId('tog').click())
    expect(sizedPane().style.width).toBe(`${COLLAPSED_STRIP_PX}px`)
    act(() => screen.getByTestId('tog').click())
    expect(sizedPane().style.width).toBe('360px')
  })

  it('stacked split: collapsed pane takes its content height, no strip', () => {
    render(<Harness orientation="vertical" />)
    act(() => screen.getByTestId('tog').click())
    expect(sizedPane().style.height).toBe('')
    expect(sizedPane().style.flex).toBe('0 0 auto')
    expect(sizedPane().classList.contains('resizable-split-strip')).toBe(false)
  })
})
