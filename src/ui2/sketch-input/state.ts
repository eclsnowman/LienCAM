// WO-3305: whether the Sketches window is open. New UI state only; nothing is saved.
import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

function set(next: boolean): void {
  if (open === next) return
  open = next
  for (const l of [...listeners]) l()
}

export const openSketchInput = (): void => set(true)
export const closeSketchInput = (): void => set(false)
export const isSketchInputOpen = (): boolean => open

export function useSketchInputOpen(): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l) } },
    () => open,
  )
}
