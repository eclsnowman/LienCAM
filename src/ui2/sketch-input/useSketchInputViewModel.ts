// WO-3305: what the Sketches window shows, gathered once per change of the project or the window.
import { useEffect, useMemo } from 'react'
import { useCamStore } from '../../store'
import { resolveMessage } from '../../notices'
import type { Availability } from '../../commands/types'
import type { Tone } from '../../components/kit/types'
import { addSketchInput, listSketchInputs, syncSketchInputs, type SketchInputEntry } from './actions'

export interface SketchInputRow {
  key: string
  name: string
  /** Ready or in use; a refused sketch has no pill, its reason says why. */
  pill?: { tone: Tone; label: string }
  status?: 'ok' | 'warn'
  /** The app's own reason a refused sketch cannot be machined, in full. */
  reason?: string
  availability: Availability
  inUse: boolean
}

const READY: Availability = { ready: true }

function rowOf(entry: SketchInputEntry): SketchInputRow {
  if (entry.status === 'refused' && entry.reason) {
    return {
      key: entry.key, name: entry.name, inUse: false, status: 'warn',
      reason: resolveMessage(entry.reason.key, entry.reason.params),
      availability: { ready: false, reason: entry.reason.key, params: entry.reason.params },
    }
  }
  const inUse = entry.status === 'in-use'
  return {
    key: entry.key, name: entry.name, inUse, availability: READY,
    status: inUse ? 'ok' : undefined,
    pill: inUse
      ? { tone: 'ok', label: resolveMessage('ui2-sketch-input.wo3305:inUse') }
      : { tone: 'neutral', label: resolveMessage('ui2-sketch-input.wo3305:available') },
  }
}

export function useSketchInputViewModel(open: boolean): {
  rows: SketchInputRow[]
  use(key: string): void
} {
  const project = useCamStore((s) => s.project)
  // Opening the window brings every sketch in use up to date first (a store write: never in render).
  useEffect(() => {
    if (open) syncSketchInputs()
  }, [open])
  const entries = useMemo(() => {
    if (!open) return []
    return listSketchInputs()
    // project: the list follows every project change while the window is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project])
  return {
    // Refused sketches last: the window's first focus lands on a row that can be used, not on a reason tip.
    rows: [...entries.filter((e) => e.status !== 'refused'), ...entries.filter((e) => e.status === 'refused')].map(rowOf),
    use(key) {
      const entry = entries.find((e) => e.key === key)
      if (entry && entry.status === 'available') addSketchInput(entry.modelItemId, entry.nodeId)
    },
  }
}
