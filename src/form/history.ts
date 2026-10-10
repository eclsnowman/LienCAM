// Form - undo/redo inside the form: whole-cage snapshots (cages are small).

import type { Cage } from './cage'
import { cloneCage } from './cage'

export const FORM_HISTORY_LIMIT = 200

export interface FormHistory {
  past: Cage[]
  future: Cage[]
}

export function emptyHistory(): FormHistory {
  return { past: [], future: [] }
}

/** Record `before` as an undo step (call before applying a change). Clears redo. */
export function pushHistory(h: FormHistory, before: Cage): FormHistory {
  const past = [...h.past, cloneCage(before)]
  if (past.length > FORM_HISTORY_LIMIT) past.shift()
  return { past, future: [] }
}

export function undoCage(h: FormHistory, current: Cage): { history: FormHistory; cage: Cage } | null {
  if (h.past.length === 0) return null
  const cage = h.past[h.past.length - 1]
  return { history: { past: h.past.slice(0, -1), future: [...h.future, cloneCage(current)] }, cage: cloneCage(cage) }
}

export function redoCage(h: FormHistory, current: Cage): { history: FormHistory; cage: Cage } | null {
  if (h.future.length === 0) return null
  const cage = h.future[h.future.length - 1]
  return { history: { past: [...h.past, cloneCage(current)], future: h.future.slice(0, -1) }, cage: cloneCage(cage) }
}
