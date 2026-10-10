// viewport3d: mesh-derived feature anchor point (WO UI-58-R1 minor finding).
//
// A supplement-list row click has no real viewport raycast hit (unlike a
// click-select), so it needs a stand-in world point to anchor the value entry
// at. Before this fix the stand-in was the OWNING BODY's whole bounding-box
// top-center -- provably far from an off-center hole, and not the same
// effect as a viewport click on the WO's own "behaves as a click-select"
// contract. This computes the centroid of ONLY the matched feature's own
// tessellated triangles (same triFace/faceIds scan faceAreaFromMesh already
// uses), landing the anchor ON the feature regardless of where it sits on
// the body.

import * as THREE from 'three';
import type { CachedBody } from './GeometryCache';
import type { StableId } from './types';

const P = new THREE.Vector3();

/** Vertex-averaged centroid of every triangle whose faceId is in `faceIds`.
 *  Returns undefined if `body` has no matching triangles (unknown ids, or a
 *  stale cache) -- callers fall back to a coarser anchor (e.g. the body
 *  bounding box) rather than anchoring at the origin. */
export function featureAnchorFromMesh(body: CachedBody, faceIds: readonly StableId[]): { x: number; y: number; z: number } | undefined {
  const index = body.geometry.getIndex();
  const position = body.geometry.getAttribute('position');
  if (index === null || position === undefined || faceIds.length === 0) return undefined;

  const wanted = new Set(faceIds);
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let vertexCount = 0;
  const triCount = body.triFace.length;
  for (let t = 0; t < triCount; t++) {
    const faceIndex = body.triFace[t];
    if (!wanted.has(body.faceIds[faceIndex])) continue;
    for (let k = 0; k < 3; k++) {
      const vi = index.getX(t * 3 + k);
      P.fromBufferAttribute(position, vi);
      sumX += P.x;
      sumY += P.y;
      sumZ += P.z;
      vertexCount += 1;
    }
  }
  if (vertexCount === 0) return undefined;
  return { x: sumX / vertexCount, y: sumY / vertexCount, z: sumZ / vertexCount };
}
