// WO-3282 (UI M2 W1-E): the one dialog stack (M2-PLAN standard 6). Dialogs, windows, confirms and
// command search join it while open; Escape closes the top one and nothing else listens.
// Order is the order dialogs opened: a dialog that re-renders keeps its place (useDialogEntry
// joins once per open and reads its Escape handler through a ref), so Escape always reaches the
// newest dialog. A close is idempotent, and closing one in the middle leaves the rest in order.
import { useEffect, useRef } from 'react'
import type { DialogStack } from '../types'

/** The stack plus what a renderer needs: the open ids bottom to top, and a change signal. */
export interface LiveDialogStack extends DialogStack {
  ids(): readonly string[]
  subscribe(listener: () => void): () => void
}

export function createDialogStack(): LiveDialogStack {
  const stack: { id: string; onEscape: () => void; token: object }[] = []
  const listeners = new Set<() => void>()
  const changed = () => { for (const l of [...listeners]) l() }
  return {
    push(id, onEscape) {
      const token = {}
      stack.push({ id, onEscape, token })
      changed()
      return () => {
        const at = stack.findIndex(e => e.token === token)
        if (at < 0) return
        stack.splice(at, 1)
        changed()
      }
    },
    top: () => stack[stack.length - 1]?.id,
    get size() { return stack.length },
    ids: () => stack.map(e => e.id),
    handleEscape() {
      const top = stack[stack.length - 1]
      if (!top) return false
      try {
        top.onEscape()
      } catch (error) {
        console.error(`dialog ${top.id} failed to close on Escape`, error)
      }
      return true
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** The app's one dialog stack. */
export const dialogStack: LiveDialogStack = createDialogStack()

/** Join `stack` while `open`. Keyed on open, id and stack only; onEscape is read through a ref,
 *  so a re-render with a new inline handler never moves this dialog above a newer one. */
export function useDialogEntry(open: boolean, id: string, onEscape: () => void, stack: DialogStack = dialogStack): void {
  const handler = useRef(onEscape)
  useEffect(() => { handler.current = onEscape })
  useEffect(() => (open ? stack.push(id, () => handler.current()) : undefined), [open, id, stack])
}
