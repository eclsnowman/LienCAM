import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

// ============================================================
// ThemedTooltip - the ONE shared, themed hover/focus hint (WO B3-2, Q-65
// verdict "ALL hints get the treatment"). Replaces every native `title=`
// bubble in src/components with a styled tooltip consistent with the design
// language (tokens.css only, zero raw hex).
// ============================================================
// DESIGN: a SINGLETON, not a per-site wrapper. One instance is mounted once
// at the app root; it attaches ONE set of document-level listeners and reads a
// plain `data-tooltip="..."` attribute off whatever control the pointer or
// keyboard focus lands on. The title= sweep therefore migrates each hint by
// renaming the attribute (`title=` -> `data-tooltip=`), keeping its text
// verbatim - no <Tooltip> wrapper per call site, no extra React nodes per
// tipped control, no per-site listeners. This is the render-cheap choice: 460+
// hint sites cost exactly one component and one listener set, versus 460+
// wrapper elements + effects a per-site component would add.
//
// BEHAVIOUR (matches a native title bubble, but themed and a11y-correct):
//   - ~500ms show delay on hover; INSTANT reshow while moving between tipped
//     controls (a grace window after the last hide), like every real tooltip.
//   - shows on KEYBOARD FOCUS too (focusin + :focus-visible), immediately.
//     Pointer-driven focus never shows or retains a tooltip.
//   - a11y: the aria-describedby pattern. While shown, the target carries
//     aria-describedby pointing at this tooltip's id (appended to any existing
//     value, restored on hide) so a screen reader announces the hint.
//   - position:FIXED, positioned from the target's rect, so it escapes a
//     modal body's overflow:auto clip; FLIPS above / clamps horizontally near
//     a viewport edge; recomputed against the rect captured at show time.
//   - NEVER traps the pointer (pointer-events:none), so it can never eat a
//     click or block a control underneath.
//   - disappears on click/pointerdown, Escape, scroll, blur, or when the
//     pointer leaves every tipped control.
//
// Authored IN PLACE per the overlay-authoring law (src/tests/ui/
// overlayAuthoringLint.test.ts): a plain JSX <div>, NO createPortal, NO
// document.body.appendChild. Mounted at the app root, its position:fixed
// resolves to viewport coordinates from anywhere.

const SHOW_DELAY_MS = 500
// Moving from one tipped control to another within this window reshows with no
// delay (standard "tooltip is already up, keep it responsive" behaviour).
const RESHOW_GRACE_MS = 300
const VIEWPORT_MARGIN = 8
// Gap between the target control and the tooltip.
const OFFSET = 6

interface TipState {
  el: HTMLElement
  text: string
  /** The target's bounding rect, captured at show time. */
  rect: DOMRect
}

interface TipPos {
  left: number
  top: number
}

const TOOLTIP_SELECTOR = '[data-tooltip]'

/** The nearest ancestor-or-self carrying a non-empty data-tooltip. */
function closestTipped(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const el = target.closest(TOOLTIP_SELECTOR)
  if (!(el instanceof HTMLElement)) return null
  const text = el.getAttribute('data-tooltip')
  return text && text.trim() !== '' ? el : null
}

export function ThemedTooltip() {
  const tipId = `tt-${useId()}`
  const [tip, setTip] = useState<TipState | null>(null)
  const [pos, setPos] = useState<TipPos | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)

  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastHiddenAt = useRef(0)
  // Mirror of the target the tip is FOR (shown OR pending) so the document
  // listeners (which do not re-bind per render) compare without a stale `tip`
  // closure. `tipShown` mirrors whether the tip is actually rendered.
  const currentEl = useRef<HTMLElement | null>(null)
  const tipShown = useRef(false)

  useEffect(() => {
    const clearTimer = () => {
      if (showTimer.current !== null) {
        clearTimeout(showTimer.current)
        showTimer.current = null
      }
    }

    const hide = () => {
      clearTimer()
      if (currentEl.current || tipShown.current) {
        lastHiddenAt.current = Date.now()
        currentEl.current = null
        tipShown.current = false
        setTip(null)
        setPos(null)
      }
    }

    const show = (el: HTMLElement) => {
      const text = el.getAttribute('data-tooltip')
      if (!text || text.trim() === '') return
      currentEl.current = el
      tipShown.current = true
      setPos(null)
      setTip({ el, text, rect: el.getBoundingClientRect() })
    }

    // `instant` shows now (focus-visible keyboard focus, or moving directly
    // between tipped controls); otherwise the ~500ms hover delay applies
    // UNLESS a tip was hidden within the grace window (keeps reshow responsive).
    const scheduleShow = (el: HTMLElement, instant: boolean) => {
      clearTimer()
      currentEl.current = el
      const doInstant = instant || Date.now() - lastHiddenAt.current < RESHOW_GRACE_MS
      if (doInstant) {
        show(el)
      } else {
        showTimer.current = setTimeout(() => {
          showTimer.current = null
          // Re-read at fire time; bail if the target changed or left the DOM.
          if (el.isConnected && currentEl.current === el) show(el)
        }, SHOW_DELAY_MS)
      }
    }

    const onPointerOver = (e: PointerEvent) => {
      const el = closestTipped(e.target)
      if (el) {
        if (el !== currentEl.current) {
          // Moving DIRECTLY from one tipped control to another: hide the old
          // hint at once and show the new one instantly (no 500ms linger).
          const hadActive = currentEl.current !== null || tipShown.current
          hide()
          scheduleShow(el, hadActive)
        }
      } else if (currentEl.current || tipShown.current) {
        hide()
      }
    }

    const onFocusIn = (e: FocusEvent) => {
      const el = closestTipped(e.target)
      if (el?.matches(':focus-visible') && el !== currentEl.current) {
        // Keyboard focus is deliberate - show immediately. Pointer-driven
        // focus is ignored so it cannot undo pointerdown/click dismissal.
        hide()
        scheduleShow(el, true)
      }
    }

    const onFocusOut = () => hide()
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    const onScrollOrDown = () => hide()

    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    document.addEventListener('keydown', onKeyDown, true)
    // Capture phase so ANY scrolling ancestor (a modal body, a panel) hides it.
    document.addEventListener('scroll', onScrollOrDown, true)
    document.addEventListener('pointerdown', onScrollOrDown, true)
    document.addEventListener('click', onScrollOrDown, true)

    return () => {
      clearTimer()
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', onScrollOrDown, true)
      document.removeEventListener('pointerdown', onScrollOrDown, true)
      document.removeEventListener('click', onScrollOrDown, true)
    }
  }, [])

  // ---- aria-describedby (append + restore) ---------------------------------
  useEffect(() => {
    const el = tip?.el
    if (!el) return
    const prev = el.getAttribute('aria-describedby')
    el.setAttribute('aria-describedby', prev ? `${prev} ${tipId}` : tipId)
    return () => {
      if (prev) el.setAttribute('aria-describedby', prev)
      else el.removeAttribute('aria-describedby')
    }
  }, [tip, tipId])

  // ---- positioning: fixed, glued to the target, flip + clamp at edges ------
  useLayoutEffect(() => {
    if (!tip) return
    const tt = tooltipRef.current
    const ttRect = tt?.getBoundingClientRect()
    const w = ttRect?.width ?? 0
    const h = ttRect?.height ?? 0
    const r = tip.rect
    const spaceBelow = window.innerHeight - r.bottom - VIEWPORT_MARGIN
    // Prefer below; flip above only when below is too tight AND above is roomier.
    const above = spaceBelow < h + OFFSET && r.top - VIEWPORT_MARGIN > spaceBelow
    let left = r.left + r.width / 2 - w / 2
    const maxLeft = window.innerWidth - w - VIEWPORT_MARGIN
    if (left > maxLeft) left = maxLeft
    if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN
    const top = above ? r.top - h - OFFSET : r.bottom + OFFSET
    setPos({ left, top })
  }, [tip])

  if (!tip) return null

  return (
    <div
      ref={tooltipRef}
      id={tipId}
      role="tooltip"
      className="themed-tooltip"
      data-testid="themed-tooltip"
      // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- the
      // ONE shared themed-tooltip singleton, already COHESIVE in the UI-70
      // census.
      data-ui78-sanctioned=""
      style={{
        left: pos?.left ?? tip.rect.left,
        top: pos?.top ?? tip.rect.bottom + OFFSET,
        // Hidden for the one measuring layout pass, then revealed in place.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {tip.text}
    </div>
  )
}
