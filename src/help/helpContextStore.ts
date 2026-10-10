// Pushed help-context keys (HELP-1 S2) - a tiny SEPARATE store so surfaces
// that are invisible to the main cam store (workbench dialogs with their own
// session state, machine-control panels, dev labs) can still tell Help what
// the user is doing. One line per surface via useHelpContextKey; the main
// derivation merges these with the store-derived keys when Help opens.
// Ephemeral by design - never persisted.

import { create } from 'zustand'

interface HelpContextState {
  pushed: string[]
  push: (key: string) => void
  pop: (key: string) => void
}

export const useHelpContext = create<HelpContextState>()((set) => ({
  pushed: [],
  push: (key) => set((s) => ({ pushed: [...s.pushed, key] })),
  // Remove ONE instance (nested mounts of the same key pop cleanly).
  pop: (key) =>
    set((s) => {
      const i = s.pushed.lastIndexOf(key)
      if (i === -1) return s
      return { pushed: [...s.pushed.slice(0, i), ...s.pushed.slice(i + 1)] }
    }),
}))
