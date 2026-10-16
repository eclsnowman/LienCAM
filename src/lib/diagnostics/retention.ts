// WO-2759 audit fix round 4: the ONE retention decision for the diagnostic
// history (design section 5). Rounds 1-3 judged age, session count, bytes and
// the ordinary allowance in separate passes that each decided alone, and their
// interactions broke the design's rules (round 4: a byte pass deleted a whole
// session holding a reserved alarm while ordinary events survived). This pure
// function decides every limit together, per event, over one listing.
//
// The rules, in the order they apply:
// 1. Age: an event older than the age limit goes. A session whose own newest
//    stored event (or its start) is past the limit goes whole.
// 2. Session count: the newest sessions by latest activity are kept, the
//    caller's own live session always among them. Count and age are hard
//    limits; higher-priority events still expire by them (section 5).
// 3. Bytes: ordinary events may hold at most `maxBytes - reservedBytes`, and
//    everything together at most `maxBytes`. Once over, ordinary events go
//    first, oldest first across ALL sessions; a reserved (priority) event goes
//    only when no ordinary event is left, again oldest first. Eviction runs
//    down to 90% of the limit it passed, so a saturated writer pays for it
//    once per batch, not once per event.

import { PRIORITY_CODES, encodedSize, type DiagnosticEvent } from './schema'

export interface RetentionLimits {
  maxAgeMs: number
  maxSessions: number
  maxBytes: number
  reservedBytes: number
}

export interface RetentionRecord {
  id: string
  startedAt: number
  eventAt: number[]
  events: DiagnosticEvent[]
}

/** Below this share of a passed limit, eviction stops. */
export const EVICT_TO = 0.9

/**
 * Per record that changes: null to delete it, or a keep mask parallel to its
 * `events`. A record absent from the result stays exactly as given.
 */
export type RetentionPlan = Map<string, boolean[] | null>

const at = (r: RetentionRecord, i: number) => Number(r.eventAt?.[i]) || 0

/** A session is judged by its own newest event (its start when it has none). */
export function newestActivity(r: RetentionRecord): number {
  return (r.eventAt ?? []).reduce((max, t) => Math.max(max, Number(t) || 0), Number(r.startedAt) || 0)
}

export function planRetention(records: readonly RetentionRecord[], now: number, limits: RetentionLimits, ownId?: string): RetentionPlan {
  const plan: RetentionPlan = new Map()
  const cutoff = now - limits.maxAgeMs
  const keep = new Map<string, boolean[]>()

  // 1. Age.
  const alive: RetentionRecord[] = []
  for (const r of records) {
    if (r.id !== ownId && newestActivity(r) < cutoff) { plan.set(r.id, null); continue }
    keep.set(r.id, (r.events ?? []).map((_, i) => at(r, i) >= cutoff))
    alive.push(r)
  }

  // 2. Session count: own first, then latest activity.
  const ranked = [...alive].sort((x, y) =>
    Number(y.id === ownId) - Number(x.id === ownId)
    || newestActivity(y) - newestActivity(x)
    || (Number(y.startedAt) || 0) - (Number(x.startedAt) || 0)
    || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  const kept = ranked.slice(0, Math.max(1, limits.maxSessions))
  for (const r of ranked.slice(kept.length)) { plan.set(r.id, null); keep.delete(r.id) }

  // 3. Bytes, across every kept session at once.
  type Slot = { r: RetentionRecord; i: number; size: number; t: number; start: number }
  const ordinary: Slot[] = []
  const reserved: Slot[] = []
  let ordinaryBytes = 0
  let totalBytes = 0
  for (const r of kept) {
    const mask = keep.get(r.id)!
    r.events.forEach((e, i) => {
      if (!mask[i]) return
      const slot = { r, i, size: encodedSize(e), t: at(r, i), start: Number(r.startedAt) || 0 }
      totalBytes += slot.size
      if (PRIORITY_CODES.has(e.code)) reserved.push(slot)
      else { ordinary.push(slot); ordinaryBytes += slot.size }
    })
  }
  const ordinaryCap = limits.maxBytes - limits.reservedBytes
  if (ordinaryBytes > ordinaryCap || totalBytes > limits.maxBytes) {
    const oldestFirst = (x: Slot, y: Slot) => x.t - y.t || x.start - y.start || x.i - y.i
    ordinary.sort(oldestFirst)
    reserved.sort(oldestFirst)
    const drop = (s: Slot) => { keep.get(s.r.id)![s.i] = false; totalBytes -= s.size }
    for (const s of ordinary) {
      if (ordinaryBytes <= ordinaryCap * EVICT_TO && totalBytes <= limits.maxBytes * EVICT_TO) break
      drop(s)
      ordinaryBytes -= s.size
    }
    for (const s of reserved) {
      if (totalBytes <= limits.maxBytes * EVICT_TO) break
      drop(s)
    }
  }

  for (const r of kept) {
    const mask = keep.get(r.id)!
    if (mask.some((k) => !k)) plan.set(r.id, mask)
  }
  return plan
}

/** A record with a keep mask applied; the removed events are counted as dropped. */
export function applyKeep<T extends RetentionRecord & { dropped: number }>(r: T, mask: readonly boolean[]): T {
  const gone = mask.filter((k) => !k).length
  return {
    ...r,
    events: r.events.filter((_, i) => mask[i]),
    eventAt: r.eventAt.filter((_, i) => mask[i]),
    dropped: (Number(r.dropped) || 0) + gone,
  }
}
