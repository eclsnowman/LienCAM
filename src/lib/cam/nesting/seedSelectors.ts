/* Seed-detection selectors (ADR 0025 §2 — seed authoring).
 *
 * A geometry IS a seed iff some nest references it as a source. There is NO
 * separate seed object: the single stored source copy per unique part IS the
 * authoring seed (ADR 0024 §2 / ADR 0025 §2). "Is a seed" is BINARY across the
 * whole project — a geometry is either referenced by at least one nest's
 * sources[] or it is not; there is no per-nest distinction.
 *
 * These are PURE functions (no store, no React, no THREE) so the tree badge, the
 * viewport seed-halo, and the unit tests all read the SAME truth from one place.
 */

import type { ImportedGeometry, NestRecord } from '../../../types'
import type { Placement } from './types'

/** Project shape this selector needs (a subset of Project) — keeps the helper
 *  callable from tests with a minimal literal and decoupled from the full type. */
interface SeedSource {
  nests?: NestRecord[]
}

/** Project shape the owner-keyed selector needs (geometry list only). */
interface OwnerSource {
  geometry?: ImportedGeometry[]
}

/** The set of geometry ids that are a nest SOURCE (i.e. a seed) anywhere in the
 *  project. A geometry referenced by several nests appears once (Set semantics).
 *  Empty when the project has no nests. */
export function seedGeometryIds(project: SeedSource): Set<string> {
  const ids = new Set<string>()
  for (const nest of project.nests ?? []) {
    for (const src of nest.sources) {
      if (src.geometryId) ids.add(src.geometryId)
    }
  }
  return ids
}

/** Convenience binary check: is THIS geometry id a seed (a nest source) in the
 *  project? Equivalent to seedGeometryIds(project).has(geometryId). */
export function isSeedGeometry(project: SeedSource, geometryId: string): boolean {
  for (const nest of project.nests ?? []) {
    for (const src of nest.sources) {
      if (src.geometryId === geometryId) return true
    }
  }
  return false
}

/** The instanceId of the SEED placement for EACH distinct partId in the nest.
 *  The seed is the lower-left instance = argmin of (x + y); deterministic
 *  tie-break: smaller x, then smaller y, then lexicographically-smaller
 *  instanceId. One seed per partId group; empty placements => empty set. Ops
 *  authored on the seed instance replicate to its copies (ADR 0024 / ADR 0025). */
export function seedPlacementIds(nest: NestRecord): Set<string> {
  const seedByPart = new Map<string, Placement>()
  for (const p of nest.placements) {
    const cur = seedByPart.get(p.partId)
    if (cur === undefined || isLowerLeft(p, cur)) {
      seedByPart.set(p.partId, p)
    }
  }
  const ids = new Set<string>()
  for (const p of seedByPart.values()) ids.add(p.instanceId)
  return ids
}

/** True when placement `a` is "more lower-left" than `b`: smaller (x + y), then
 *  smaller x, then smaller y, then lexicographically-smaller instanceId. */
function isLowerLeft(a: Placement, b: Placement): boolean {
  const sa = a.x + a.y
  const sb = b.x + b.y
  if (sa !== sb) return sa < sb
  if (a.x !== b.x) return a.x < b.x
  if (a.y !== b.y) return a.y < b.y
  return a.instanceId < b.instanceId
}

/** Pure loop-by-layer-visibility filter for the seed slot (seed layer eyes,
 *  this pass). Given seed loops tagged with `layerId` and the seed geometry's
 *  layers (each carrying a `visible` flag), keep only the loops whose owning
 *  layer is visible. A loop whose layerId has no matching layer is KEPT (treat
 *  unknown layers as visible — never silently drop geometry on a stale id).
 *  Pure (no store / React / THREE) so the viewport seed-slot build and a unit
 *  test read the same truth. */
export function visibleSeedLoops<L extends { layerId: string }>(
  loops: ReadonlyArray<L>,
  layers: ReadonlyArray<{ id: string; visible: boolean }>,
): L[] {
  const hidden = new Set<string>()
  for (const l of layers) {
    if (l.visible === false) hidden.add(l.id)
  }
  return loops.filter((loop) => !hidden.has(loop.layerId))
}

/** The set of geometry ids that are a nest's INTEGRATED SEED COPY — i.e. each
 *  ImportedGeometry whose `ownerNestId` is set (ADR 0025 §2, deep-copy seed
 *  model). createNest deep-copies every source part into such a copy; the copy
 *  is self-contained (ties to the original broken) and renders ONLY as the
 *  nest's seed slot, appears ONLY as the nest's child row, and is removed with
 *  the nest. This is the basis for suppressing owned seeds from the standalone
 *  viewport + the root/folder tree rows. Pre-existing workspace geometry
 *  (ownerNestId undefined) is NOT in this set. Empty when no geometry is owned. */
export function nestOwnedGeometryIds(project: OwnerSource): Set<string> {
  const ids = new Set<string>()
  for (const geo of project.geometry ?? []) {
    if (geo.ownerNestId) ids.add(geo.id)
  }
  return ids
}
