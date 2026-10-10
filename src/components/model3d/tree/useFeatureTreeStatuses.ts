// WO UI-3: live status polling for the design tree.
//
// RegenScheduler (src/doc/regen/scheduler.ts) is plain data with no event
// emitter -- markDirty()/run() mutate its internal FeatureStatusStore
// synchronously (see status.ts), but nothing pushes a notification out. This
// hook polls scheduler.statuses()/diagnosticsOf() on a short interval and
// only re-renders when the SERIALIZED snapshot actually changed, so a demo
// integration driving `scheduler.run(mockOp)` (ok->dirty->running->ok,
// failed, degraded) is reflected in the tree without either side needing a
// bespoke pub/sub wire-up -- exactly the "framework socket" this WO builds
// for M4's real feature ops to plug into later.
//
// The poll interval is a UI refresh cadence, NOT a scheduling decision -- it
// never influences dirty-marking/execution order/cancellation (those stay
// entirely inside RegenScheduler, wall-clock-free per DOC-5 AC #5). Tests
// drive this deterministically with vi.useFakeTimers()/advanceTimersByTimeAsync.

import { useEffect, useRef, useState } from 'react'
import type { FeatureStatus, RegenDiagnostic } from '../../../doc'

/** The minimal read surface this hook needs -- satisfied by RegenScheduler,
 *  and trivially fakeable in tests without constructing a real FeatureDag. */
export interface FeatureStatusSource {
  statuses(): Array<[string, FeatureStatus]>
  diagnosticsOf(id: string): RegenDiagnostic[]
}

export interface FeatureStatusSnapshot {
  status: FeatureStatus
  diagnostics: RegenDiagnostic[]
}

const DEFAULT_POLL_MS = 50

function serialize(source: FeatureStatusSource, ids: readonly string[]): string {
  return JSON.stringify(
    ids.map((id) => [id, source.statuses().find(([nid]) => nid === id)?.[1] ?? 'dirty', source.diagnosticsOf(id)]),
  )
}

function snapshotFor(source: FeatureStatusSource, ids: readonly string[]): Map<string, FeatureStatusSnapshot> {
  const known = new Map(source.statuses())
  const out = new Map<string, FeatureStatusSnapshot>()
  for (const id of ids) {
    out.set(id, { status: known.get(id) ?? 'dirty', diagnostics: source.diagnosticsOf(id) })
  }
  return out
}

/**
 * Polls `source` (typically a RegenScheduler) for the current status +
 * diagnostics of each id in `nodeIds`, re-rendering the caller only when the
 * snapshot actually changes. Returns an empty map (never null/undefined) so
 * callers can render unconditionally.
 */
export function useFeatureTreeStatuses(
  source: FeatureStatusSource | undefined,
  nodeIds: readonly string[],
  pollMs: number = DEFAULT_POLL_MS,
): Map<string, FeatureStatusSnapshot> {
  const [snapshot, setSnapshot] = useState<Map<string, FeatureStatusSnapshot>>(() =>
    source ? snapshotFor(source, nodeIds) : new Map(),
  )
  const lastSerialized = useRef<string>('')

  useEffect(() => {
    if (!source) {
      setSnapshot(new Map())
      return
    }
    const tick = (): void => {
      const serialized = serialize(source, nodeIds)
      if (serialized === lastSerialized.current) return
      lastSerialized.current = serialized
      setSnapshot(snapshotFor(source, nodeIds))
    }
    tick() // paint the current state immediately (no 50ms-blank flash on mount)
    const handle = setInterval(tick, pollMs)
    return () => clearInterval(handle)
    // nodeIds is compared by content via the join below -- a stable primitive
    // dependency avoids re-subscribing every render on a fresh array literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, nodeIds.join('|'), pollMs])

  return snapshot
}
