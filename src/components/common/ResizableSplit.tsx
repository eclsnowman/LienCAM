import { textFor, useText } from '../../i18n'
// ResizableSplit - WO-2430: the ONE shared way to split a screen into two
// panes the user can resize (Operator 2026-10-02: "Let's look at the panel
// resizing flexibility we implemented on the Main screen and see if we can
// make that a UI standard wherever possible"; COHESION-STANDARD s26).
//
// It behaves like Control > Main's column bars (ControlColResizer,
// ProgramDivider) and the CAM shell's PanelResizer, so they feel the same:
//   - pointer drag on the bar moves the boundary live;
//   - arrow keys step it (8px, Shift = 32px), Home/End go to the bounds;
//   - double-click resets the screen's default;
//   - the same .panel-resizer hover/focus look and grip.
//
// One pane carries the stored size (px, uiPrefs.panelSizes[prefKey]); the
// other fills the rest. Neither pane ever goes below its declared minimum:
// the sized pane is clamped to [minSize, maxSize] AND to what the container
// leaves after the fill pane's minimum, so no drag, key or stale stored value
// can squeeze a panel until it clips its controls.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useUiPrefs } from '../../store/uiPrefs'
import './panels.css'

const shellText = textFor('app-shell-settings-menus')

/** The bar's thickness (px). It replaces the 8px gap the panes used to sit
 *  apart by, so adopting the split moves no panel edge. */
export const SPLIT_BAR_PX = 8

/** A collapsed side-by-side sized pane shrinks to this strip (px): just wide
 *  enough for its expand control. The fill pane takes the rest. */
export const COLLAPSED_STRIP_PX = 36

const KEY_STEP = 8
const KEY_STEP_BIG = 32

export interface ResizableSplitProps {
  /** uiPrefs key for the sized pane, unique per screen and panel. */
  prefKey: string
  /** 'horizontal' = panes side by side (a vertical bar); 'vertical' = stacked. */
  orientation?: 'horizontal' | 'vertical'
  /** Which pane carries the stored size; the other fills the rest. */
  sizedPane: 'first' | 'second'
  defaultSize: number
  minSize: number
  maxSize: number
  /** The fill pane never shrinks below this (px). */
  fillMinSize: number
  /** Accessible name of the bar, e.g. "Resize Tools and jog panels". */
  label: string
  first: ReactNode
  second: ReactNode
  /** The sized pane is collapsed to its header: it takes its content size
   *  along the split axis and the bar rests. A vertical split shrinks it to
   *  its header; a horizontal one shrinks it to a narrow strip that shows only
   *  its expand control. Either way the fill pane takes the freed room. */
  sizedCollapsed?: boolean
  className?: string
  testId?: string
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** The size the sized pane may have in a container of `container` px:
 *  [minSize, min(maxSize, container - bar - fillMinSize)]. When the container
 *  cannot satisfy both minimums the sized pane keeps its own minimum and the
 *  screen's scroll takes the rest; it is never driven below it. */
export function splitBounds(
  container: number | null,
  { minSize, maxSize, fillMinSize }: Pick<ResizableSplitProps, 'minSize' | 'maxSize' | 'fillMinSize'>,
): [number, number] {
  const roomy = container === null || !(container > 0)
    ? maxSize
    : Math.min(maxSize, container - SPLIT_BAR_PX - fillMinSize)
  return [minSize, Math.max(minSize, roomy)]
}

export function ResizableSplit({
  prefKey,
  orientation = 'horizontal',
  sizedPane,
  defaultSize,
  minSize,
  maxSize,
  fillMinSize,
  label,
  first,
  second,
  sizedCollapsed = false,
  className,
  testId,
}: ResizableSplitProps) {
  useText('app-shell-settings-menus')
  const stored = useUiPrefs((s) => s.panelSizes[prefKey])
  const setPanelSize = useUiPrefs((s) => s.setPanelSize)
  const resetPanelSize = useUiPrefs((s) => s.resetPanelSize)
  const horizontal = orientation === 'horizontal'

  const rootRef = useRef<HTMLDivElement>(null)
  const [container, setContainer] = useState<number | null>(null)
  const measure = useCallback((): number | null => {
    const el = rootRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    const v = horizontal ? r.width : r.height
    return v > 0 ? v : null
  }, [horizontal])
  useLayoutEffect(() => {
    setContainer(measure())
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setContainer(measure()))
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  const [lo, hi] = splitBounds(container, { minSize, maxSize, fillMinSize })
  const size = clamp(stored ?? defaultSize, lo, hi)

  // Drag bookkeeping captured at pointerdown, so the window listener never
  // reads a stale size from a render closure (PanelResizer's BUG-477 lesson:
  // every way a pointer sequence ends tears the listeners down).
  const drag = useRef<{ start: number; startSize: number; pointerId: number; target: Element } | null>(null)
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const pos = horizontal ? e.clientX : e.clientY
    const delta = sizedPane === 'first' ? pos - d.start : d.start - pos
    const [dlo, dhi] = splitBounds(measure(), { minSize, maxSize, fillMinSize })
    setPanelSize(prefKey, clamp(d.startSize + delta, dlo, dhi))
  }, [horizontal, sizedPane, measure, minSize, maxSize, fillMinSize, setPanelSize, prefKey])
  const endDrag = useCallback(() => {
    const d = drag.current
    if (!d) return
    drag.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
    d.target.removeEventListener('lostpointercapture', endDrag)
    try { d.target.releasePointerCapture?.(d.pointerId) } catch { /* jsdom / unsupported */ }
  }, [onPointerMove])
  useEffect(() => () => endDrag(), [endDrag])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || sizedCollapsed) return
    e.preventDefault()
    endDrag()
    const target = e.currentTarget
    drag.current = { start: horizontal ? e.clientX : e.clientY, startSize: size, pointerId: e.pointerId, target }
    try { target.setPointerCapture?.(e.pointerId) } catch { /* jsdom / unsupported */ }
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    target.addEventListener('lostpointercapture', endDrag)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (sizedCollapsed) return
    const back = horizontal ? 'ArrowLeft' : 'ArrowUp'
    const fwd = horizontal ? 'ArrowRight' : 'ArrowDown'
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP
    let next: number
    // An arrow moves the BAR that way: towards the sized pane shrinks it.
    if (e.key === back || e.key === fwd) {
      const towardsSecond = e.key === fwd
      next = size + (towardsSecond === (sizedPane === 'first') ? step : -step)
    } else if (e.key === 'Home') next = lo
    else if (e.key === 'End') next = hi
    else return
    e.preventDefault()
    // The bar owns this key. On Control, arrow keys also JOG THE MACHINE
    // through a window keydown listener (useControlJogKeys) that does not
    // look at defaultPrevented, so the key must not reach the window.
    e.stopPropagation()
    setPanelSize(prefKey, clamp(next, lo, hi))
  }

  // Collapsed: the stored size is untouched, so expanding restores it.
  const sizedStyle: CSSProperties = sizedCollapsed
    ? horizontal
      ? { flex: `0 0 ${COLLAPSED_STRIP_PX}px`, width: COLLAPSED_STRIP_PX, minWidth: 0 }
      : { flex: '0 0 auto' }
    : horizontal
      ? { flex: `0 0 ${size}px`, width: size, minWidth: minSize }
      : { flex: `0 0 ${size}px`, height: size, minHeight: minSize }
  const stripClass = sizedCollapsed && horizontal ? ' resizable-split-strip' : ''
  const fillStyle: CSSProperties = horizontal ? { minWidth: fillMinSize } : { minHeight: fillMinSize }
  const firstStyle = sizedPane === 'first' ? sizedStyle : fillStyle
  const secondStyle = sizedPane === 'second' ? sizedStyle : fillStyle

  return (
    <div
      ref={rootRef}
      className={`resizable-split resizable-split-${orientation}${className ? ` ${className}` : ''}`}
      data-testid={testId}
    >
      <div
        className={`resizable-split-pane ${sizedPane === 'first' ? `resizable-split-sized${stripClass}` : 'resizable-split-fill'}`}
        style={firstStyle}
      >
        {first}
      </div>
      <div
        className={`panel-resizer resizable-split-bar${sizedCollapsed ? ' resizable-split-bar-resting' : ''}`}
        data-testid={testId ? `${testId}-bar` : undefined}
        role={sizedCollapsed ? undefined : 'separator'}
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-label={label}
        aria-valuenow={Math.round(size)}
        aria-valuemin={lo}
        aria-valuemax={Math.round(hi)}
        tabIndex={sizedCollapsed ? -1 : 0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => { if (!sizedCollapsed) resetPanelSize(prefKey) }}
        data-tooltip={shellText('ResizableSplit.dragToResizeDoubleClickToResetPx', { defaultSize: defaultSize })}
      >
        <span className="panel-resizer-grip" aria-hidden="true" />
      </div>
      <div
        className={`resizable-split-pane ${sizedPane === 'second' ? `resizable-split-sized${stripClass}` : 'resizable-split-fill'}`}
        style={secondStyle}
      >
        {second}
      </div>
    </div>
  )
}
