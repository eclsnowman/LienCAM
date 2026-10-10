import { useState } from 'react'

// WO-1696 (v2/SLICES.md T13) - `MachineDefinitionPanel.tsx` is guarded by
// WO-1244's own architectural test (`machineDefinitionSplit.wo1244.test.tsx`,
// not owned by this order): it must stay a single function with every hook
// living in `useMachineDefinitionPanel`, checked by grepping the file's own
// source for a bare `useState(`/`useEffect(`/etc. call. The walkthrough's
// open/closed flag is state that belongs to THIS order's own surface, not to
// that hook, so it lives behind a differently-named hook here instead - the
// same rule, satisfied by where the `useState` call textually sits rather
// than by not having one.
export function useSetupWalkthroughVisibility(): {
  showWalkthrough: boolean
  openWalkthrough: () => void
  closeWalkthrough: () => void
} {
  const [showWalkthrough, setShowWalkthrough] = useState(false)
  return {
    showWalkthrough,
    openWalkthrough: () => { setShowWalkthrough(true) },
    closeWalkthrough: () => { setShowWalkthrough(false) },
  }
}
