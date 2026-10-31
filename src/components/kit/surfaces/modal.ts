// WO-3279: focus and dialog-stack behaviour shared by Dialog, Window and Confirm. Escape is never
// read here: the shortcut manager hands it to the dialog stack.
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import { dialogStack } from '../../../commands'

const TABBABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)]
}

/** Joins the dialog stack while open (keyed on open and id only, so a new inline onClose never
 *  re-pushes the dialog above a newer one) and manages focus: in on open, back to the opener on
 *  close or unmount. Returns the Tab-trap key handler for the frame. */
export function useModal(open: boolean, id: string, onEscape: () => void, frame: RefObject<HTMLElement | null>) {
  const escape = useRef(onEscape)
  useEffect(() => { escape.current = onEscape })
  useEffect(() => (open ? dialogStack.push(id, () => escape.current()) : undefined), [open, id])
  useEffect(() => {
    const root = frame.current
    if (!open || !root) return undefined
    const opener = document.activeElement as HTMLElement | null
    const inside = tabbables(root)
    const first = root.querySelector<HTMLElement>('[data-autofocus]')
      ?? inside.find(el => !el.hasAttribute('data-kit-close')) ?? inside[0] ?? root
    first.focus()
    return () => { if (opener && opener.isConnected) opener.focus() }
  }, [open, frame])
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !frame.current) return
    const list = tabbables(frame.current)
    if (list.length === 0) return
    const at = list.indexOf(document.activeElement as HTMLElement)
    if (event.shiftKey && at <= 0) { event.preventDefault(); list[list.length - 1].focus() }
    else if (!event.shiftKey && at === list.length - 1) { event.preventDefault(); list[0].focus() }
  }
}
