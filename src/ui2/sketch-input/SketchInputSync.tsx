// WO-3305: keeps every sketch in use following its sketch. It runs on mount and whenever the
// operator leaves the Model workspace (where sketches on model planes and faces are edited), so
// the operations on a changed sketch are outdated before the next compute. Draws nothing.
import { useEffect } from 'react'
import { useCamStore } from '../../store'
import { syncSketchInputs } from './actions'

export function SketchInputSync() {
  useEffect(() => {
    syncSketchInputs()
    return useCamStore.subscribe((s, prev) => {
      if (prev.workspace === 'part' && s.workspace !== 'part') syncSketchInputs()
    })
  }, [])
  return null
}
