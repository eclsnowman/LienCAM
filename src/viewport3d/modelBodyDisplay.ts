// INT-17A Stage 1 (B2a): turn a live Model-workbench CachedBody into the
// SERIALIZABLE display payload persisted on a CAM geometry entry, so the entry
// draws on reload with the Part tab never mounting (no kernel, no regen).
//
// The Model tab already tessellates every body into GeometryCache on regen; this
// reads that SAME buffer back out as plain number arrays (JSON-friendly), so no
// second tessellation pass runs - only the changed body is extracted per edit
// (the perf-gate invariant, G3). THREE-aware (reads BufferGeometry attributes),
// deliberately separate from the pure data adapter (modelBodyAdapter.ts).

import type { ModelBodyDisplay } from '../types'
import type { CachedBody } from './GeometryCache'

/** Extract the persisted display payload from a body's live tessellation cache
 *  entry. bbox is computed from the vertex positions directly (buildBufferGeometry
 *  does not compute one), so it is always finite and present. */
export function modelBodyDisplayFromCached(cached: CachedBody): ModelBodyDisplay {
  const posAttr = cached.geometry.getAttribute('position')
  const normAttr = cached.geometry.getAttribute('normal')
  const indexAttr = cached.geometry.getIndex()
  if (posAttr === undefined || normAttr === undefined || indexAttr === null) {
    throw new Error(
      `INT-17A: model body "${cached.bodyId}" cache entry is missing position/normal/index; cannot derive a CAM display payload.`,
    )
  }
  const positions = Array.from(posAttr.array as ArrayLike<number>)
  const normals = Array.from(normAttr.array as ArrayLike<number>)
  const indices = Array.from(indexAttr.array as ArrayLike<number>)

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  // A body with zero vertices is degenerate; keep a finite (origin) box rather
  // than Infinity, so the entry's boundingBox never poisons a downstream reader.
  if (!Number.isFinite(minX)) {
    minX = minY = minZ = 0
    maxX = maxY = maxZ = 0
  }

  return {
    positions,
    normals,
    indices,
    edgePositions: Array.from(cached.edgePositions),
    edgeOffsets: Array.from(cached.edgeOffsets),
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    // CAM-BINDING Stage 5: captured VERBATIM from the same cache entry, same
    // compact per-face (not per-triangle) scheme CachedBody already uses
    // (getBodyFaceColorSample's own `faceIds[triFace[t]]` lookup, this file's
    // header) - no new tessellation, no kernel call, just reading the buffers
    // already sitting in `cached` one field further.
    //
    // STABILITY NOTE (S5 audit Q1, disclosed NOTE, 2026-07-22): the ORDER of
    // this faceIds array (i.e. which array index a given face lands at) comes
    // from the kernel tessellation's face iteration order in geom-engine.ts's
    // tessellate(), which carries no explicit cross-version/cross-platform
    // stability guarantee. This is SAFE because ModelReference (the durable,
    // persisted pick) stores stableIds[] - the string face-id values - never a
    // local array index. A pick only ever resolves an index INTO the SAME
    // ModelBodyDisplay it was read from (see CNCViewport.ts resolveBrepHit +
    // NewOperationModal.tsx's `display.faceIds[sel.index]`), so both sides of
    // an index lookup always agree within one session even if a kernel/platform
    // change reorders this array between sessions. Do not persist a local
    // index; only stableIds cross a session boundary.
    faceIds: [...cached.faceIds],
    triFace: Array.from(cached.triFace),
    // VIEWPORT-BODY-PRESENTATION-UNIFY: carry the same stable topology
    // identity as the Model picker so CAM does not have to treat these true
    // edges as anonymous decoration. Optional on the persisted contract keeps
    // older projects loadable; a post-load Model sync fills it in.
    edgeIds: [...cached.edgeIds],
  }
}
