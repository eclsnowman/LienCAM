import { useCallback, useRef } from 'react'

// WO-1376: none of the modal-backdrop dialogs moved keyboard focus into
// themselves on open, trapped Tab, or returned focus on close - the backdrop
// blocked the mouse only, so Tab walked to toolbar buttons behind the scrim
// and Enter/Space activated them while a dialog was open (Codex audit
// BUG-484). One shared hook, adopted by every dialog: attach its return value
// as the dialog panel's `ref`. All 14 dialogs are mounted unconditionally at
// App boot (App.tsx) and only the panel's own JSX subtree toggles between the
// real markup and an early `return null` - the component instance itself is
// never remounted, so it keeps re-rendering (parent re-renders, unrelated
// state changes) the whole time the dialog is closed. The hook exploits that:
// on every render where the panel is not currently mounted, it recaptures
// `document.activeElement` as the opener candidate. Render happens before
// React commits DOM mutations (including its own `autoFocus` handling), so
// the last such render before the commit that mounts the panel is the one
// that sees the true opener. Once the ref callback fires with a live node,
// capture stops (the dialog's own contents now hold focus) until the panel
// unmounts again, which re-arms capture for the next open.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function isVisible(el: HTMLElement): boolean {
  return !el.hidden && el.style.display !== 'none' && el.getAttribute('aria-hidden') !== 'true'
}

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible)
}

export function useDialogFocus<T extends HTMLElement>(): (node: T | null) => void {
  const openerRef = useRef<HTMLElement | null>(null)
  const mountedRef = useRef(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  // Recapture on every render while the panel is not mounted - see the note
  // above on why this cannot be a one-time capture or move into the ref
  // callback.
  if (!mountedRef.current) {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  return useCallback((node: T | null) => {
    if (node) {
      mountedRef.current = true
      if (!node.hasAttribute('tabindex')) node.tabIndex = -1

      // React's own autoFocus (when the dialog declares one) has already run
      // by the time a ref callback fires - only step in when nothing inside
      // the dialog ended up focused.
      if (!node.contains(document.activeElement)) {
        const first = focusableIn(node)[0] ?? node
        first.focus()
      }

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Tab') return
        const items = focusableIn(node)
        if (items.length === 0) { event.preventDefault(); return }
        const active = document.activeElement
        const index = items.indexOf(active as HTMLElement)
        const next = event.shiftKey
          ? items[index <= 0 ? items.length - 1 : index - 1]
          : items[index === -1 || index === items.length - 1 ? 0 : index + 1]
        event.preventDefault()
        next.focus()
      }
      node.addEventListener('keydown', onKeyDown)
      cleanupRef.current = () => node.removeEventListener('keydown', onKeyDown)
    } else {
      mountedRef.current = false
      cleanupRef.current?.()
      cleanupRef.current = null
      const opener = openerRef.current
      openerRef.current = null
      if (opener && document.body.contains(opener)) opener.focus()
    }
  }, [])
}
