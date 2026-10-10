// WO UI-4 acceptance #4: per-face hide, implemented as a geometry-collapse
// patch on the SAME per-vertex buffers highlight.ts/appearance already
// touch -- no shader/material change, no geometry rebuild, no BVH rebuild.
//
// A hidden face's 3 triangle vertices (per fixtures.ts's/geom-engine.ts's
// tessellate() invariant that a face's mesh vertices are never shared with a
// neighboring face -- see highlight.ts's own header) are all moved to that
// triangle's centroid, collapsing it to zero area: invisible (nothing to
// rasterize) AND pick-transparent (a degenerate triangle's ray intersection
// determinant is ~0, so PickEngine's BVH raycastFirst correctly reports no
// hit there -- no PickEngine change needed). A pristine snapshot of the
// original positions is captured once (capturePristineGeometry, call right
// after GeometryCache.ingest()) so re-applying the mask after a visibility
// change always starts from the TRUE positions rather than compounding a
// prior collapse.
//
// BVH bounding volumes are built once at ingest and are NOT refit after a
// collapse -- a stale (too-large) leaf bound just means the BVH traversal
// still visits that leaf; the leaf-level ray-triangle test against the now-
// degenerate triangle is what actually rejects the hit. Slightly less
// efficient than a refit, never incorrect.

import * as THREE from 'three'
import type { CachedBody } from '../../../viewport3d'
import type { StableId } from '../../../geom/geom-service'
import { parseStableId } from '../../../doc/stable-id'

export interface PristineGeometrySnapshot {
  position: Float32Array
  edgePosition: Float32Array
}

export interface VisibilityMask {
  hiddenFaceIds: ReadonlySet<StableId>
  hiddenEdgeIds: ReadonlySet<StableId>
}

/** Snapshot a CachedBody's current (un-collapsed) vertex positions. Call
 *  once right after the body is ingested/re-ingested -- calling it AFTER a
 *  collapse has already been applied would freeze the collapsed state as
 *  "pristine". */
export function capturePristineGeometry(body: CachedBody): PristineGeometrySnapshot {
  const position = body.geometry.getAttribute('position') as THREE.BufferAttribute
  const edgePosition = body.edgeGeometry.getAttribute('position') as THREE.BufferAttribute
  return {
    position: Float32Array.from(position.array as ArrayLike<number>),
    edgePosition: Float32Array.from(edgePosition.array as ArrayLike<number>),
  }
}

/** Mirrors highlight.ts's private computeEdgeVertexOffsets exactly (same
 *  buildEdgeLineGeometry write-order invariant) -- duplicated rather than
 *  imported since highlight.ts doesn't export it and this WO doesn't own
 *  edits to that file's internals. */
function computeEdgeVertexOffsets(body: CachedBody): Uint32Array {
  const { edgeOffsets, edgeIds } = body
  const offsets = new Uint32Array(edgeIds.length + 1)
  let w = 0
  for (let e = 0; e < edgeIds.length; e++) {
    offsets[e] = w
    const start = edgeOffsets[e]
    const end = edgeOffsets[e + 1]
    const segmentCount = end > start + 1 ? end - start - 1 : 0
    w += segmentCount * 2
  }
  offsets[edgeIds.length] = w
  return offsets
}

/** R1.2 rework (UI4.audit.json): derive which edges to collapse from which
 *  faces are hidden -- no side-channel edge/face adjacency data needed,
 *  because an edge's own StableId already IS the unordered pair of its
 *  adjacent face ids, `(faceA EDGE_JOIN faceB)` (or `(faceA EDGE_JOIN
 *  seam#k)` for a single-adjacent-face seam edge), per
 *  docs/stable-id-spec.md and src/geom/worker/stable-id.ts's edgeId().
 *  An edge is hidden when every REAL face named in it is hidden; a seam
 *  edge needs only its one face hidden; an id the shared parser doesn't
 *  recognize as a 2-operand edge (or the `orphan` seam case, which names no
 *  real face) is never hidden.
 *
 *  BK-56: this used to hand-split on EDGE_JOIN with a `parts.length===2`
 *  guard, which silently skipped any edge adjacent to a fillet/chamfer BAND
 *  face -- a band face's own id embeds a nested edge id (and so a nested
 *  EDGE_JOIN), so the naive split produced 3+ parts and got dropped. The
 *  shared parseStableId is depth-aware: a band-face operand comes back as
 *  ONE intact string, so the 2-operand check is correct even when an
 *  operand is itself a nested id. */
export function deriveHiddenEdgeIds(edgeIds: readonly StableId[], isFaceHidden: (faceId: StableId) => boolean): Set<StableId> {
  const hidden = new Set<StableId>()
  for (const edgeId of edgeIds) {
    const parsed = parseStableId(edgeId)
    if (parsed.kind !== 'edge' || parsed.operands.length !== 2) continue
    const [a, b] = parsed.operands
    if (a.isOrphan) continue
    if (b.isSeam ? isFaceHidden(a.raw) : isFaceHidden(a.raw) && isFaceHidden(b.raw)) hidden.add(edgeId)
  }
  return hidden
}

/** Restore every vertex to its pristine position, then collapse the
 *  triangles/segments named in `mask` to a point. Idempotent -- safe to call
 *  on every visibility-state change regardless of what the previous mask
 *  was. */
export function applyGeometryVisibility(body: CachedBody, pristine: PristineGeometrySnapshot, mask: VisibilityMask): void {
  const posAttr = body.geometry.getAttribute('position') as THREE.BufferAttribute
  const index = body.geometry.getIndex()
  if (index === null) throw new Error('geometryVisibility: body.geometry has no index buffer')

  ;(posAttr.array as Float32Array).set(pristine.position)
  if (mask.hiddenFaceIds.size > 0) {
    for (let t = 0; t < body.triFace.length; t++) {
      const faceIndex = body.triFace[t]
      const faceId = body.faceIds[faceIndex]
      if (!mask.hiddenFaceIds.has(faceId)) continue
      const i0 = index.getX(t * 3)
      const i1 = index.getX(t * 3 + 1)
      const i2 = index.getX(t * 3 + 2)
      const cx = (pristine.position[i0 * 3] + pristine.position[i1 * 3] + pristine.position[i2 * 3]) / 3
      const cy = (pristine.position[i0 * 3 + 1] + pristine.position[i1 * 3 + 1] + pristine.position[i2 * 3 + 1]) / 3
      const cz = (pristine.position[i0 * 3 + 2] + pristine.position[i1 * 3 + 2] + pristine.position[i2 * 3 + 2]) / 3
      posAttr.setXYZ(i0, cx, cy, cz)
      posAttr.setXYZ(i1, cx, cy, cz)
      posAttr.setXYZ(i2, cx, cy, cz)
    }
  }
  posAttr.needsUpdate = true

  const edgePosAttr = body.edgeGeometry.getAttribute('position') as THREE.BufferAttribute
  ;(edgePosAttr.array as Float32Array).set(pristine.edgePosition)
  if (mask.hiddenEdgeIds.size > 0) {
    const offsets = computeEdgeVertexOffsets(body)
    for (let e = 0; e < body.edgeIds.length; e++) {
      if (!mask.hiddenEdgeIds.has(body.edgeIds[e])) continue
      const start = offsets[e]
      const end = offsets[e + 1]
      if (end <= start) continue
      const fx = pristine.edgePosition[start * 3]
      const fy = pristine.edgePosition[start * 3 + 1]
      const fz = pristine.edgePosition[start * 3 + 2]
      for (let vi = start; vi < end; vi++) edgePosAttr.setXYZ(vi, fx, fy, fz)
    }
  }
  edgePosAttr.needsUpdate = true
}
