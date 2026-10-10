// Replay ingest seam (DOC lane, WO DOC-2).
//
// The single place a feature's ElementMapDelta enters the document's
// ElementMap during replay/regeneration. Kept as a standalone function rather
// than folded into DOC-1's ElementMap.applyDelta so that module's core logic
// stays untouched outside the BK-6 riders -- this is DOC-2-owned, additive.

import type { ElementMapDelta } from '../geom/geom-service'
import type { DeltaSnapshots, ElementMap } from './element-map'

/**
 * Merges a delta's OPTIONAL inline `geometry` field (ICR-1, approved
 * 2026-07-07) with a companion snapshot map (the pre-ICR-1 side-channel
 * pattern ElementMap.applyDelta still accepts for producers that haven't
 * adopted inline geometry yet). Per the ICR-1 ruling ("consume them as
 * first-class") the inline field is authoritative: when both are present and
 * disagree for the same id, the INLINE value wins -- a producer emitting
 * fresh, authoritative geometry inline should never be shadowed by a stale or
 * differently-sourced companion entry for the same id.
 */
export function mergeDeltaSnapshots(delta: ElementMapDelta, companion?: DeltaSnapshots): DeltaSnapshots | undefined {
  if (!delta.geometry && !companion) return undefined
  const merged: DeltaSnapshots = { ...(companion ?? {}) }
  if (delta.geometry) {
    for (const id of Object.keys(delta.geometry)) merged[id] = delta.geometry[id]
  }
  return merged
}

/**
 * Applies one feature's delta to the document ElementMap, using
 * mergeDeltaSnapshots so inline geometry (ICR-1) always wins over a companion
 * map on disagreement. This is the seam DOC-2's Command layer and DOC-5's
 * regeneration scheduler call per feature evaluated.
 */
export function applyFeatureDelta(map: ElementMap, delta: ElementMapDelta, companion?: DeltaSnapshots): void {
  map.applyDelta(delta, mergeDeltaSnapshots(delta, companion))
}
