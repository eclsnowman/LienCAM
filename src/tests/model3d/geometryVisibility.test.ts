// WO UI-4 acceptance #4: per-face hide via geometry collapse -- a hidden
// face's triangles collapse to a point (invisible AND, since the
// degenerate-triangle ray-intersection determinant is ~0, pick-transparent
// with NO PickEngine change). Restoring from the pristine snapshot must be
// exact (idempotent across repeated mask changes).

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { GeometryCache, PickEngine } from '../../viewport3d'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'
import { EDGE_JOIN, filletFaceId, chamferFaceId, edgeId } from '../../doc/stable-id'
import { applyGeometryVisibility, capturePristineGeometry, deriveHiddenEdgeIds } from '../../components/model3d/visibility'

const ZMAX_FACE = 'F1:BOX:face#5'

function ingestBox() {
  const cache = new GeometryCache()
  const body = cache.ingest('box1', makeBoxTessBuffers({ featureId: 'F1' }))
  return { cache, body }
}

describe('applyGeometryVisibility', () => {
  it('collapses each hidden-face triangle to zero area (each triangle collapses to ITS OWN centroid -- adjacent triangles of the same face may collapse to slightly different points, but every triangle individually becomes degenerate)', () => {
    const { body } = ingestBox()
    const pristine = capturePristineGeometry(body)
    applyGeometryVisibility(body, pristine, { hiddenFaceIds: new Set([ZMAX_FACE]), hiddenEdgeIds: new Set() })

    const index = body.geometry.getIndex()!
    const position = body.geometry.getAttribute('position')
    let checkedAny = false
    for (let t = 0; t < body.triFace.length; t++) {
      if (body.faceIds[body.triFace[t]] !== ZMAX_FACE) continue
      checkedAny = true
      const i0 = index.getX(t * 3)
      const i1 = index.getX(t * 3 + 1)
      const i2 = index.getX(t * 3 + 2)
      const p0 = new THREE.Vector3().fromBufferAttribute(position, i0)
      const p1 = new THREE.Vector3().fromBufferAttribute(position, i1)
      const p2 = new THREE.Vector3().fromBufferAttribute(position, i2)
      const area = p1.clone().sub(p0).cross(p2.clone().sub(p0)).length() * 0.5
      expect(area).toBeLessThan(1e-9)
    }
    expect(checkedAny).toBe(true)
  })

  it('is idempotent and restores exactly when the mask no longer hides that face', () => {
    const { body } = ingestBox()
    const pristine = capturePristineGeometry(body)
    applyGeometryVisibility(body, pristine, { hiddenFaceIds: new Set([ZMAX_FACE]), hiddenEdgeIds: new Set() })
    applyGeometryVisibility(body, pristine, { hiddenFaceIds: new Set(), hiddenEdgeIds: new Set() })

    const position = body.geometry.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      expect(position.getX(i)).toBeCloseTo(pristine.position[i * 3], 9)
      expect(position.getY(i)).toBeCloseTo(pristine.position[i * 3 + 1], 9)
      expect(position.getZ(i)).toBeCloseTo(pristine.position[i * 3 + 2], 9)
    }
  })

  it('a collapsed face is pick-transparent: raycasting through it hits nothing on that face', () => {
    const { cache, body } = ingestBox()
    const pristine = capturePristineGeometry(body)
    applyGeometryVisibility(body, pristine, { hiddenFaceIds: new Set([ZMAX_FACE]), hiddenEdgeIds: new Set() })
    // BVH was built at ingest time over the ORIGINAL geometry; three-mesh-bvh
    // doesn't auto-refit on position mutation, so explicitly refit here --
    // mirrors what a caller driving live face-hide would need to do too if
    // it wants tight bounds (this test proves the DEGENERATE-TRIANGLE
    // rejection works even without a refit, since raycastFirst still visits
    // the now-stale-but-still-overlapping leaf and must reject there).
    const pick = new PickEngine(cache)
    // Ray straight down the +Z face center, deep into the box -- if the face
    // were still solid this would hit it immediately at z=5.
    const hit = pick.pick('box1', { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }, 'face')
    // Either no hit at all, or a hit on a DIFFERENT face (the ray continuing
    // through the collapsed top must not resolve to ZMAX_FACE).
    if (hit !== null && hit.kind === 'face') expect(hit.id).not.toBe(ZMAX_FACE)
  })
})

// R1.2 rework (UI4.audit.json): per-face isolate must ALSO collapse the edge
// overlay for every hidden face, not just its triangles -- otherwise
// isolate mode still shows the full hidden-body wireframe. deriveHiddenEdgeIds
// derives this from each edge id's own adjacent-face-pair encoding (no
// separate edge/face adjacency data), per docs/stable-id-spec.md.
describe('deriveHiddenEdgeIds', () => {
  const faceA = 'F1:BOX:face#0'
  const faceB = 'F1:BOX:face#1'

  it('hides a real two-face edge only when BOTH adjacent faces are hidden', () => {
    const edgeId = `(${faceA}${EDGE_JOIN}${faceB})`
    expect(deriveHiddenEdgeIds([edgeId], (f) => f === faceA)).toEqual(new Set())
    expect(deriveHiddenEdgeIds([edgeId], (f) => f === faceA || f === faceB)).toEqual(new Set([edgeId]))
  })

  it('hides a seam edge (single real adjacent face) once that one face is hidden', () => {
    const seamEdge = `(${faceA}${EDGE_JOIN}seam#0)`
    expect(deriveHiddenEdgeIds([seamEdge], () => false)).toEqual(new Set())
    expect(deriveHiddenEdgeIds([seamEdge], (f) => f === faceA)).toEqual(new Set([seamEdge]))
  })

  it('never hides an orphan edge (no real face named to check)', () => {
    const orphan = `(orphan${EDGE_JOIN}seam#0)`
    expect(deriveHiddenEdgeIds([orphan], () => true)).toEqual(new Set())
  })

  it('isolating the box fixture\'s +Z face hides exactly the 8 edges not on its boundary', () => {
    const { body } = ingestBox()
    const hiddenFaces = new Set(body.faceIds.filter((id) => id !== ZMAX_FACE))
    const hiddenEdges = deriveHiddenEdgeIds(body.edgeIds, (f) => hiddenFaces.has(f))
    expect(hiddenEdges.size).toBe(8)
    for (const edgeId of hiddenEdges) expect(edgeId).not.toContain(ZMAX_FACE)
  })
})

// BK-56 regression: deriveHiddenEdgeIds used to hand-split each edge id on
// EDGE_JOIN and require EXACTLY 2 parts. A fillet/chamfer BAND face's own id
// embeds a whole nested edge id (and so a nested EDGE_JOIN), so an edge
// adjacent to a band face contains the joiner char at TWO different nesting
// depths -- the naive split produced 3+ parts and the `parts.length!==2`
// guard silently skipped the edge, no matter which faces were hidden. This
// fixture reproduces that exact shape and FAILS against the pre-WO
// implementation (verified: reverting geometryVisibility.ts's fix locally
// and re-running this file turns both assertions below false -- the edge is
// never reported hidden regardless of which faces are hidden).
describe('deriveHiddenEdgeIds -- fillet/chamfer BAND regression (BK-56)', () => {
  const faceA = 'F1:BOX:face#0'
  const faceB = 'F1:BOX:face#1'
  const faceC = 'F1:BOX:face#2'
  const innerEdge = `(${faceA}${EDGE_JOIN}${faceB})`
  const bandFace = filletFaceId('F20', innerEdge)
  const outerEdge = edgeId(bandFace, faceC)

  it('hides the band-adjacent edge once BOTH its top-level faces (band + plain) are hidden', () => {
    expect(deriveHiddenEdgeIds([outerEdge], (f) => f === bandFace || f === faceC)).toEqual(new Set([outerEdge]))
  })

  it('does not hide it when only one of the two top-level faces is hidden', () => {
    expect(deriveHiddenEdgeIds([outerEdge], (f) => f === bandFace)).toEqual(new Set())
    expect(deriveHiddenEdgeIds([outerEdge], (f) => f === faceC)).toEqual(new Set())
  })

  it('also handles a BOTH-sides-nested edge (two band faces meeting each other)', () => {
    const bandFace2 = chamferFaceId('F21', `(${faceC}${EDGE_JOIN}${faceA})`)
    const doubleNestedEdge = edgeId(bandFace, bandFace2)
    expect(deriveHiddenEdgeIds([doubleNestedEdge], () => true)).toEqual(new Set([doubleNestedEdge]))
    expect(deriveHiddenEdgeIds([doubleNestedEdge], (f) => f === bandFace)).toEqual(new Set())
  })
})

describe('applyGeometryVisibility + deriveHiddenEdgeIds together (isolate mode end-to-end on the edge overlay)', () => {
  it('collapses exactly the 8 non-boundary edges when isolating the +Z face; its 4 boundary edges stay intact', () => {
    const { body } = ingestBox()
    const pristine = capturePristineGeometry(body)
    const hiddenFaces = new Set(body.faceIds.filter((id) => id !== ZMAX_FACE))
    const hiddenEdges = deriveHiddenEdgeIds(body.edgeIds, (f) => hiddenFaces.has(f))
    applyGeometryVisibility(body, pristine, { hiddenFaceIds: hiddenFaces, hiddenEdgeIds: hiddenEdges })

    const edgePos = body.edgeGeometry.getAttribute('position')
    let collapsedCount = 0
    let intactCount = 0
    for (let e = 0; e < body.edgeIds.length; e++) {
      // Box fixture invariant: every edge is one straight segment -> exactly
      // 2 line vertices at [e*2, e*2+1] (fixtures.ts's pushEdge pushes 2 raw
      // points per edge, same 1-segment convention this suite's other tests
      // already rely on for face vertex indices).
      const p0 = new THREE.Vector3().fromBufferAttribute(edgePos, e * 2)
      const p1 = new THREE.Vector3().fromBufferAttribute(edgePos, e * 2 + 1)
      const len = p0.distanceTo(p1)
      if (hiddenEdges.has(body.edgeIds[e])) {
        expect(len).toBeLessThan(1e-9)
        collapsedCount++
      } else {
        expect(len).toBeGreaterThan(1)
        intactCount++
      }
    }
    expect(collapsedCount).toBe(8)
    expect(intactCount).toBe(4)
  })
})
