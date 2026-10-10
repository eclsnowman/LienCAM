import { textFor, useText } from '../../i18n'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  useUiPrefs,
  resolveEffectivePanelWidth,
  resolvePreferenceForEffectiveWidth,
  resolveUiScale,
  PANEL_LEFT_MIN, PANEL_LEFT_MAX, PANEL_LEFT_DEFAULT,
  PANEL_RIGHT_MIN, PANEL_RIGHT_MAX, PANEL_RIGHT_DEFAULT,
} from '../../store/uiPrefs'

const shellText = textFor('app-shell-settings-menus')

// ---------------------------------------------------------------------------
// PanelResizer (action-plan Phase 5, P8)
// ---------------------------------------------------------------------------
// A draggable separator on the INNER edge of a side panel. Live-resizes the
// panel within the tier-3 bounds, persists the width (ui-prefs slice survives
// reload), resets to default on double-click, and is keyboard-accessible
// (role="separator", aria-orientation="vertical", arrow keys resize). The
// focus ring is the global P3 :focus-visible system.
//
// "side" is which panel this handle controls:
//   - 'left'  handle sits on the RIGHT edge of panel-left; dragging right
//             (increasing clientX) widens it.
//   - 'right' handle sits on the LEFT edge of panel-right; dragging left
//             (decreasing clientX) widens it.

const KEY_STEP = 8       // px per arrow press
const KEY_STEP_BIG = 32  // px per Page/Shift+arrow press

export function PanelResizer({ side }: { side: 'left' | 'right' }) {
  useText('app-shell-settings-menus')
  const panelLeftWidth = useUiPrefs((s) => s.panelLeftWidth)
  const panelRightWidth = useUiPrefs((s) => s.panelRightWidth)
  const panelLeftWidthCustomized = useUiPrefs((s) => s.panelLeftWidthCustomized)
  const panelRightWidthCustomized = useUiPrefs((s) => s.panelRightWidthCustomized)
  const uiScalePreference = useUiPrefs((s) => s.uiScale)
  const setPanelWidth = useUiPrefs((s) => s.setPanelWidth)
  const resetPanelWidth = useUiPrefs((s) => s.resetPanelWidth)

  // WO-1494 (BUG-476): the same viewport/scale tracking App.tsx uses to set
  // --ui-scale, so this resizer's drag baseline/aria-valuenow/keyboard math
  // resolve through the SAME resolveEffectivePanelWidth authority App.tsx
  // renders with, instead of the raw (un-scaled) stored preference.
  const [displayMetrics, setDisplayMetrics] = useState(() => ({
    cssWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
    dpr: typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1),
  }))
  useEffect(() => {
    const syncDisplayMetrics = () => setDisplayMetrics({
      cssWidth: window.innerWidth,
      dpr: window.devicePixelRatio || 1,
    })
    window.addEventListener('resize', syncDisplayMetrics)
    return () => window.removeEventListener('resize', syncDisplayMetrics)
  }, [])
  const uiScale = resolveUiScale(uiScalePreference, displayMetrics.cssWidth, displayMetrics.dpr)
  const width = resolveEffectivePanelWidth(side, {
    panelLeftWidth, panelLeftWidthCustomized,
    panelRightWidth, panelRightWidthCustomized,
    viewportCssWidth: displayMetrics.cssWidth,
    uiScale,
  })

  const [min, max] = side === 'left'
    ? [PANEL_LEFT_MIN, PANEL_LEFT_MAX]
    : [PANEL_RIGHT_MIN, PANEL_RIGHT_MAX]
  const def = side === 'left' ? PANEL_LEFT_DEFAULT : PANEL_RIGHT_DEFAULT

  // Drag bookkeeping — captured at pointerdown so the move handler does not
  // depend on a possibly-stale width from a render closure. `pointerId` and
  // `target` let endDrag ignore a stray pointer and release the capture it
  // took; BUG-477: without them, a canceled touch drag left the window
  // pointermove listener armed for ANY later pointer movement.
  const drag = useRef<{ startX: number; startW: number; pointerId: number; target: Element } | null>(null)

  // WO-1494 fix round: `width` (and therefore the drag baseline / keyboard
  // math below) is the EFFECTIVE, possibly-compressed rendered width, but
  // `setPanelWidth` stores a PREFERENCE that resolveEffectivePanelWidth
  // compresses again on the next render. Converting the target effective
  // width back into a preference through the inverse helper is what makes
  // the stored value land on the target instead of being compressed twice.
  //
  // Read the current inputs through a ref, not useCallback deps: a drag's
  // window pointermove listener is attached once (onPointerDown) and never
  // re-subscribed mid-gesture, and setPanelWidth's own update re-renders this
  // component on every step. If setEffectiveTarget's identity depended on
  // panelLeftWidth/panelRightWidth directly, it would change on every one of
  // those re-renders, cascading through onPointerMove -> endDrag -> the
  // mount/cleanup effect below, tearing the drag listeners down and clearing
  // the cursor/userSelect lock mid-drag.
  const effectiveTargetInputsRef = useRef({
    panelLeftWidth, panelLeftWidthCustomized,
    panelRightWidth, panelRightWidthCustomized,
    viewportCssWidth: displayMetrics.cssWidth,
    uiScale,
  })
  effectiveTargetInputsRef.current = {
    panelLeftWidth, panelLeftWidthCustomized,
    panelRightWidth, panelRightWidthCustomized,
    viewportCssWidth: displayMetrics.cssWidth,
    uiScale,
  }
  const setEffectiveTarget = useCallback((targetEffectiveWidth: number) => {
    const preference = resolvePreferenceForEffectiveWidth(
      side, targetEffectiveWidth, effectiveTargetInputsRef.current,
    )
    setPanelWidth(side, preference)
  }, [side, setPanelWidth])

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!drag.current || e.pointerId !== drag.current.pointerId) return
    const dx = e.clientX - drag.current.startX
    // left panel grows as the cursor moves right; right panel grows as it moves left.
    const next = side === 'left' ? drag.current.startW + dx : drag.current.startW - dx
    setEffectiveTarget(next)
  }, [side, setEffectiveTarget])

  // Runs on every way a pointer sequence can end: pointerup, pointercancel,
  // lostpointercapture (browser-forced loss with neither of those firing),
  // and component unmount. Idempotent (checked via drag.current) so it is
  // safe to reach from more than one of those in the same gesture.
  const endDrag = useCallback(() => {
    if (!drag.current) return
    const { target, pointerId } = drag.current
    drag.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
    target.removeEventListener('lostpointercapture', endDrag)
    try { target.releasePointerCapture?.(pointerId) } catch { /* jsdom / unsupported */ }
  }, [onPointerMove])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const target = e.currentTarget
    drag.current = { startX: e.clientX, startW: width, pointerId: e.pointerId, target }
    try { target.setPointerCapture?.(e.pointerId) } catch { /* jsdom / unsupported */ }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    target.addEventListener('lostpointercapture', endDrag)
  }, [width, onPointerMove, endDrag])

  // A drag still live when the resizer itself unmounts must not leave the
  // window listener (or the col-resize cursor / userSelect lock) behind.
  useEffect(() => () => endDrag(), [endDrag])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Arrow semantics: ArrowRight always tries to move the boundary right.
    // For the left panel that WIDENS it; for the right panel that NARROWS it.
    const big = e.shiftKey
    let delta = 0
    if (e.key === 'ArrowLeft') delta = -(big ? KEY_STEP_BIG : KEY_STEP)
    else if (e.key === 'ArrowRight') delta = big ? KEY_STEP_BIG : KEY_STEP
    else if (e.key === 'PageDown') delta = -KEY_STEP_BIG
    else if (e.key === 'PageUp') delta = KEY_STEP_BIG
    else if (e.key === 'Home') { e.preventDefault(); setPanelWidth(side, min); return }
    else if (e.key === 'End') { e.preventDefault(); setPanelWidth(side, max); return }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resetPanelWidth(side); return }
    else return
    e.preventDefault()
    const signed = side === 'left' ? delta : -delta
    setEffectiveTarget(width + signed)
  }, [side, width, min, max, setEffectiveTarget, setPanelWidth, resetPanelWidth])

  return (
    <div
      className={`panel-resizer panel-resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={shellText('PanelResizer.resizePanel', { value: side === 'left' ? shellText('PanelResizer.designTree') : shellText('PanelResizer.properties') })}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => resetPanelWidth(side)}
      onKeyDown={onKeyDown}
      data-tooltip={shellText('PanelResizer.dragToResizeDoubleClickToResetPx', { def: def })}
    >
      <span className="panel-resizer-grip" aria-hidden="true" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// PanelEdgeResizer (WO-2512)
// ---------------------------------------------------------------------------
// The same bar for a right-hand panel that is not one of the CAM shell's two:
// the Model screen's tool rail. Render it just before the panel, in the row the
// panel shares with the viewport, as App.tsx does PanelResizer; it pulls the
// panel over itself by its own width (the rail's edge lies under it), so the
// viewport does not move. The width goes to uiPrefs.panelSizes[prefKey] like
// every ResizableSplit.
// Same drag, keys (8px, Shift/Page = 32px, Home/End to the bounds) and
// double-click reset as PanelResizer; dragging left widens. It lives here, not
// beside the rail, because the model3d tree may bind nothing but onClick.

export interface PanelEdgeResizerProps {
  /** uiPrefs.panelSizes key, unique per screen and panel. */
  prefKey: string
  /** The panel's width now (px): the stored size, or its default when none is stored. */
  size: number
  defaultSize: number
  minSize: number
  maxSize: number
  /** What the panel's row must keep beside it (px), so a drag never squeezes the viewport out. */
  restMinSize: number
  label: string
  testId?: string
}

/** [minSize, min(maxSize, row - restMinSize)], never below minSize. */
export function edgeResizerBounds(
  row: number | null,
  { minSize, maxSize, restMinSize }: Pick<PanelEdgeResizerProps, 'minSize' | 'maxSize' | 'restMinSize'>,
): [number, number] {
  const roomy = row === null || !(row > 0) ? maxSize : Math.min(maxSize, row - restMinSize)
  return [minSize, Math.max(minSize, roomy)]
}

/** The width (px) the panel renders at: the stored size (or its default when none
 *  is stored) held inside edgeResizerBounds for the row the panel sits in NOW,
 *  re-measured whenever that row resizes - as ResizableSplit does - so a width
 *  chosen in a wide window, or remembered from an earlier visit, never squeezes
 *  the viewport out when the row is narrower. The stored preference is kept. */
export function useEdgePanelSize(
  panelRef: RefObject<HTMLElement | null>,
  stored: number | undefined,
  { defaultSize, minSize, maxSize, restMinSize }: Pick<PanelEdgeResizerProps, 'defaultSize' | 'minSize' | 'maxSize' | 'restMinSize'>,
): number {
  const [row, setRow] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = panelRef.current?.parentElement
    if (!el) return
    const measure = () => {
      const w = el.getBoundingClientRect().width
      setRow(w > 0 ? w : null)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [panelRef])
  const [lo, hi] = edgeResizerBounds(row, { minSize, maxSize, restMinSize })
  return Math.min(hi, Math.max(lo, stored ?? defaultSize))
}

export function PanelEdgeResizer({ prefKey, size, defaultSize, minSize, maxSize, restMinSize, label, testId }: PanelEdgeResizerProps) {
  useText('app-shell-settings-menus')
  const setPanelSize = useUiPrefs((s) => s.setPanelSize)
  const resetPanelSize = useUiPrefs((s) => s.resetPanelSize)
  const barRef = useRef<HTMLDivElement>(null)
  const bounds = useCallback((): [number, number] => {
    const row = barRef.current?.parentElement?.getBoundingClientRect().width
    return edgeResizerBounds(row ?? null, { minSize, maxSize, restMinSize })
  }, [minSize, maxSize, restMinSize])
  const store = useCallback((next: number) => {
    const [lo, hi] = bounds()
    setPanelSize(prefKey, Math.min(hi, Math.max(lo, next)))
  }, [bounds, setPanelSize, prefKey])

  const drag = useRef<{ startX: number; startSize: number; pointerId: number; target: Element } | null>(null)
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    store(d.startSize - (e.clientX - d.startX))
  }, [store])
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
    if (e.button !== 0) return
    e.preventDefault()
    endDrag()
    const target = e.currentTarget
    drag.current = { startX: e.clientX, startSize: size, pointerId: e.pointerId, target }
    try { target.setPointerCapture?.(e.pointerId) } catch { /* jsdom / unsupported */ }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    target.addEventListener('lostpointercapture', endDrag)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // An arrow moves the bar that way: left widens this right-hand panel.
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP
    let next: number
    if (e.key === 'ArrowLeft') next = size + step
    else if (e.key === 'ArrowRight') next = size - step
    else if (e.key === 'PageUp') next = size + KEY_STEP_BIG
    else if (e.key === 'PageDown') next = size - KEY_STEP_BIG
    else if (e.key === 'Home') next = minSize
    else if (e.key === 'End') next = maxSize
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resetPanelSize(prefKey); return }
    else return
    e.preventDefault()
    e.stopPropagation()
    store(next)
  }

  return (
    <div
      ref={barRef}
      className="panel-resizer panel-edge-resizer"
      style={{ marginRight: 'calc(-1 * var(--panel-resizer-w))' }}
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={minSize}
      aria-valuemax={maxSize}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => resetPanelSize(prefKey)}
      onKeyDown={onKeyDown}
      data-tooltip={shellText('ResizableSplit.dragToResizeDoubleClickToResetPx', { defaultSize: Math.round(defaultSize) })}
    >
      <span className="panel-resizer-grip" aria-hidden="true" />
    </div>
  )
}
