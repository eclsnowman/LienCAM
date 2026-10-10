// viewport3d: pick across multiple cached bodies, nearest wins (WO UI-2).
//
// PickEngine.pick() only ever resolves against one bodyId's cached geometry
// (see PickEngine.ts header); a real scene has many bodies under one ray, so
// this module fans a single pick out across a caller-supplied bodyId list and
// keeps whichever hit is closest to the ray origin. Bodies not present in the
// cache (never ingested, or evicted) are silently skipped -- callers commonly
// pass a session's full known-bodyId list without pre-filtering against
// what's actually landed in the cache yet.

import type { CachedBody, GeometryCache } from './GeometryCache';
import type { PickEngine } from './PickEngine';
import {
  DEFAULT_PICK_THRESHOLDS,
  type BodyId,
  type PickHit,
  type PickThresholds,
  type RayLike,
  type SelectionFilterMode,
} from './types';

export function pickAcrossBodies(
  cache: GeometryCache,
  pickEngine: PickEngine,
  bodyIds: readonly BodyId[],
  ray: RayLike,
  filter: SelectionFilterMode,
  thresholds: PickThresholds = DEFAULT_PICK_THRESHOLDS,
  renderedBodies?: readonly CachedBody[],
): PickHit | null {
  // Selection eligibility (for example a locked edit owner) is independent
  // of presentation. Hosts supply visible bodies, including preview replacements.
  const occluders = renderedBodies ?? bodyIds.flatMap(id => {
    const body = cache.get(id);
    return body === undefined ? [] : [body];
  });
  let best: PickHit | null = null;
  for (const bodyId of bodyIds) {
    if (!cache.has(bodyId)) continue;
    const hit = pickEngine.pick(bodyId, ray, filter, thresholds, occluders);
    if (hit === null) continue;
    if (best === null || hit.distance < best.distance) best = hit;
  }
  return best;
}
