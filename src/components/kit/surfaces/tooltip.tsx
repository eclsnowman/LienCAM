// WO-3279: the kit Tooltip. It replaces title=: it opens after a delay on hover (at once on
// keyboard focus), shows the text and the shortcut, closes on leave, blur, press and Escape, and
// sits below its control (above when there is no room), never over it, and stays inside the
// viewport. It renders into the New UI root (a portal), outside any transformed ancestor such as
// a Window, and is placed from its own measured box, so it lands right whatever contains it.
// A tooltip stops only an Escape it uses: with no text, or none showing, the key passes through
// to the one dialog stack (a focused dialog button must close its dialog on the first Escape).
import {
  cloneElement, useEffect, useId, useLayoutEffect, useRef, useState,
  type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { TooltipProps } from '../types'

/** Hover delay before a tooltip opens. */
export const TOOLTIP_DELAY_MS = 500
const GAP = 6
/** Space kept between a tooltip and the viewport edge. */
const EDGE = 4

/** The control's box in viewport coordinates, and where its tooltip renders. */
interface Shown { readonly box: { readonly left: number; readonly top: number; readonly bottom: number }; readonly host: HTMLElement }

type Handler = ((e: never) => void) | undefined

/** The handlers a control needs to carry a tooltip, and the tooltip itself (null while it is not
 *  showing). A part that already renders its own control spreads `props` on it and renders `tip`
 *  next to it, so the control is the same element whether or not it has a tooltip text.
 *  Empty text = no tooltip: nothing shows and no key is stopped. */
export function useTooltip(text: string, shortcut?: string, testId?: string) {
  const id = useId()
  const [shown, setShown] = useState<Shown | null>(null)
  /** The control the pointer is over, until the delay has run out. */
  const [hover, setHover] = useState<HTMLElement | null>(null)
  const active = text !== ''

  const tipRef = useRef<HTMLSpanElement>(null)

  const place = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setShown({ box: { left: r.left, top: r.top, bottom: r.bottom }, host: el.closest<HTMLElement>('[data-ui2]') ?? document.body })
  }
  // Placed from the tooltip's own measured box, before paint: the offset of its containing block
  // is read with the tooltip at 0,0, so a transformed ancestor cannot shift it, and the
  // viewport edges flip it above or slide it left.
  useLayoutEffect(() => {
    const tipEl = tipRef.current
    if (!tipEl || !shown) return
    tipEl.style.setProperty('--kit-x', '0px')
    tipEl.style.setProperty('--kit-y', '0px')
    const origin = tipEl.getBoundingClientRect()
    const w = origin.width
    const h = origin.height
    const below = shown.box.bottom + GAP + h <= window.innerHeight - EDGE
    const top = below ? shown.box.bottom + GAP : Math.max(EDGE, shown.box.top - GAP - h)
    const left = Math.max(EDGE, Math.min(shown.box.left, window.innerWidth - w - EDGE))
    tipEl.style.setProperty('--kit-x', `${left - origin.left}px`)
    tipEl.style.setProperty('--kit-y', `${top - origin.top}px`)
    tipEl.dataset.placement = below ? 'below' : 'above'
    tipEl.dataset.ready = 'true'
  }, [shown])
  useEffect(() => {
    if (!hover) return undefined
    const timer = setTimeout(() => { setHover(null); place(hover) }, TOOLTIP_DELAY_MS)
    return () => clearTimeout(timer)
  }, [hover])
  const close = () => { setHover(null); setShown(null) }

  const props = {
    'aria-describedby': shown ? id : undefined,
    onMouseEnter: (e: MouseEvent<HTMLElement>) => { if (active) setHover(e.currentTarget) },
    onMouseLeave: () => close(),
    onMouseDown: (e: MouseEvent<HTMLElement>) => { e.currentTarget.dataset.kitPressed = '1'; close() },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      setHover(null)
      if (e.currentTarget.dataset.kitPressed) delete e.currentTarget.dataset.kitPressed
      else if (active) place(e.currentTarget)
    },
    onBlur: (e: FocusEvent<HTMLElement>) => { delete e.currentTarget.dataset.kitPressed; close() },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Escape' && active && shown) { e.stopPropagation(); close() }
    },
  }
  const tip: ReactNode = shown && active && createPortal(
    <span ref={tipRef} id={id} role="tooltip" className="kit-tooltip" data-kit="Tooltip" data-testid={testId}>
      <span>{text}</span>
      {shortcut && <kbd className="kit-tooltip-key">{shortcut}</kbd>}
    </span>,
    shown.host,
  )
  return { props, tip }
}

export function Tooltip(p: TooltipProps) {
  const { props, tip } = useTooltip(p.text, p.shortcut, p.testId)
  const child = p.children as ReactElement<Record<string, unknown>>
  const own = child.props as Record<string, Handler>
  const merged: Record<string, unknown> = { 'aria-describedby': props['aria-describedby'] ?? child.props['aria-describedby'] }
  for (const name of ['onMouseEnter', 'onMouseLeave', 'onMouseDown', 'onFocus', 'onBlur', 'onKeyDown'] as const) {
    const ours = props[name] as (e: never) => void
    merged[name] = (e: never) => { own[name]?.(e); ours(e) }
  }
  return (
    <>
      {cloneElement(child, merged)}
      {tip}
    </>
  )
}
