// @vitest-environment jsdom
// WO-2431: Control > Offsets - the quick card and the setup workspace sit
// either side of the shared ResizableSplit; the workspace folds to its header.
// Drives the real ControlPage: drag, arrow keys, double-click reset,
// collapse + reopen, reload of the UI preferences, control census.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ControlPage } from '../../components/machine/ControlPage'
import { offsetsSplitPx } from '../../components/machine/OffsetsWorkspace'
import { splitBounds } from '../../components/common/ResizableSplit'
import { useUiPrefs } from '../../store/uiPrefs'
import { PERSISTED_USER_DATA_REGISTRY } from '../../store/persistedKeys'

const uiKey = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key
const KEY = 'control-offsets-quick'

function pointer(type: string, init: { clientX?: number; pointerId?: number }) {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
  const event = new Ctor(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  return event
}

const bar = () => screen.getByTestId('control-offsets-split-bar')
const quickPane = () => screen.getByLabelText('Quick work offsets').parentElement as HTMLElement

function mount() {
  render(<ControlPage />)
  fireEvent.click(screen.getByTestId('control-view-offsets'))
}

async function reload() {
  const saved = window.localStorage.getItem(uiKey)
  act(() => { useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} }) })
  if (saved !== null) window.localStorage.setItem(uiKey, saved)
  await act(async () => { await useUiPrefs.persist.rehydrate() })
}

describe('WO-2431 Control > Offsets shared panels', () => {
  beforeEach(() => {
    useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {}, machineOffsetsCollapsed: true })
  })
  afterEach(() => cleanup())

  it('starts at the quick card\'s long-standing 350px and keeps every control', () => {
    mount()
    expect(quickPane().style.width).toBe('350px')
    expect(screen.getByTestId('control-offsets-table')).toBeTruthy()
    expect(screen.getByTestId('control-offsets-toggle')).toBeTruthy()
    expect(screen.getByTestId('offsets-workspace-push-all')).toBeTruthy()
    for (const wcs of ['g54', 'g55', 'g56', 'g57', 'g58', 'g59']) {
      expect(screen.getByTestId(`offsets-workspace-row-${wcs}`)).toBeTruthy()
    }
  })

  it('starts at the old 21.875rem at every UI scale (350 / 437.5 / 525px)', () => {
    for (const [scale, px] of [[1, '350px'], [1.25, '437.5px'], [1.5, '525px']] as const) {
      act(() => { useUiPrefs.setState({ uiScale: scale, panelSizes: {} }) })
      mount()
      expect(quickPane().style.width).toBe(px)
      cleanup()
    }
    act(() => { useUiPrefs.setState({ uiScale: 'auto' }) })
  })

  it('scales the minimum, maximum and workspace room with the UI scale', () => {
    for (const [scale, min, max, room] of [[1, 350, 560, 1000], [1.25, 437.5, 700, 1250], [1.5, 525, 840, 1363]] as const) {
      const s = offsetsSplitPx(scale, 1920)
      expect([s.minPx, s.maxPx, s.workspaceMinPx]).toEqual([min, max, room])
      // Measured widths at 1920x1080: Home keeps the default 350px cells (narrower
      // truncates a value such as 432.512 - audit 5), End
      // never leaves the workspace less than the scaled room, so its Push
      // buttons are clipped no more than main's 21.875rem layout (1359px at 150%).
      const [lo, hi] = splitBounds(1896, { minSize: s.minPx, maxSize: s.maxPx, fillMinSize: s.workspaceMinPx })
      expect(lo).toBe(min)
      expect(hi).toBeGreaterThanOrEqual(s.defaultPx)
      expect(1896 - 8 - hi).toBeGreaterThanOrEqual(Math.min(1896 - 8 - s.defaultPx, room))
    }
    for (const [scale, px] of [[1.25, 438], [1.5, 525]] as const) {
      act(() => { useUiPrefs.setState({ uiScale: scale, panelSizes: {} }) })
      mount()
      fireEvent.keyDown(bar(), { key: 'Home' })
      expect(quickPane().style.width).toBe(`${px}px`)
      cleanup()
    }
    act(() => { useUiPrefs.setState({ uiScale: 'auto' }) })
  })

  it('drags the bar, steps it with arrow keys, resets on double-click, and reloads the size', async () => {
    mount()
    act(() => { bar().dispatchEvent(pointer('pointerdown', { clientX: 350 })) })
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 410 })) })
    act(() => { window.dispatchEvent(pointer('pointerup', { clientX: 410 })) })
    expect(quickPane().style.width).toBe('410px')
    expect(useUiPrefs.getState().panelSizes[KEY]).toBe(410)

    fireEvent.keyDown(bar(), { key: 'ArrowRight' })
    expect(quickPane().style.width).toBe('418px')
    fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
    expect(quickPane().style.width).toBe('386px')

    await reload()
    expect(quickPane().style.width).toBe('386px')

    fireEvent.doubleClick(bar())
    expect(quickPane().style.width).toBe('350px')
  })

  it('never shrinks the quick card below its minimum', () => {
    mount()
    fireEvent.keyDown(bar(), { key: 'Home' })
    expect(quickPane().style.width).toBe('350px')
    fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
    expect(quickPane().style.width).toBe('350px')
  })

  it('collapses the workspace to its header, reopens it, and remembers the fold across a reload', async () => {
    mount()
    expect(screen.getByTestId('offsets-workspace-row-g54')).toBeTruthy()
    fireEvent.click(screen.getByTestId('offsets-workspace-collapse'))
    expect(screen.queryByTestId('offsets-workspace-row-g54')).toBeNull()
    expect(screen.getByTestId('offsets-workspace-collapse').getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId('offsets-workspace-push-all')).toBeTruthy()
    // The folded workspace releases its reserved width (CSS drops the minimum).
    expect(screen.getByTestId('control-offsets-split').className).toContain('control-offsets-view-folded')

    await reload()
    expect(screen.queryByTestId('offsets-workspace-row-g54')).toBeNull()
    expect(screen.getByTestId('control-offsets-split').className).toContain('control-offsets-view-folded')

    fireEvent.click(screen.getByTestId('offsets-workspace-collapse'))
    expect(screen.getByTestId('offsets-workspace-row-g54')).toBeTruthy()
    expect(screen.getByTestId('control-offsets-split').className).not.toContain('control-offsets-view-folded')
  })
})
