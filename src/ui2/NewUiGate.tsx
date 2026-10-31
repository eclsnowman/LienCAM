// WO-3275 (UI M2 Wave 0): the one place the app chooses its shell. Off (the default): the legacy
// element renders unchanged, with no wrapper element. On: the New UI root, loaded on demand so
// the off path ships no extra code in the main chunk.
import { lazy, Suspense, type ReactNode } from 'react'
import { applyNewUiQuery, useNewUi } from './newUiSwitch'

// The dev query flag is read once, before the first render, so ?newui=1 never mounts the old
// shell first.
if (typeof location !== 'undefined') applyNewUiQuery(location.search)

const Ui2Root = lazy(() => import('./Ui2Root').then(m => ({ default: m.Ui2Root })))

export function NewUiGate({ legacy }: { legacy: ReactNode }) {
  const on = useNewUi()
  if (!on) return <>{legacy}</>
  return (
    <Suspense fallback={null}>
      <Ui2Root />
    </Suspense>
  )
}
