// viewport3d: mesh-derived face area (WO INT-1 acceptance #3 fallback).
//
// INTERFACE GAP discovered while building this WO (documented in
// coordination/reports/INT-1.report.json, not something to silently paper
// over): the frozen geom-service.ts facade's measure('area', ids) ignores
// `ids` entirely and always returns the WHOLE BODY's surface area
// (src/geom/worker/geom-engine.ts's measure() only branches on `ids` for
// kind 'length' -- see its own comment, "face-scoped distance/radius/angle
// stay Stage-2 resolver work"; area silently falls through to
// k.getSurfaceArea(shape) regardless of ids). src/geom/** is frozen and out
// of this WO's ownership, so the real fix (an id-scoped analytic face-area
// kernel call) is GEO lane's to make.
//
// Until then, this computes area by summing the tessellated triangles that
// belong to one faceId -- EXACT for planar faces (a flat polygon's
// triangulation never loses area, regardless of tessellation deflection) and
// bounded by the tessellation's deflection tolerance for curved faces. Not a
// substitute for a true kernel analytic query on curved geometry, but far
// more honest than displaying the whole body's surface area under a "face
// area" label.

import * as THREE from 'three';
import type { CachedBody } from './GeometryCache';
import type { StableId } from './types';

const A = new THREE.Vector3();
const B = new THREE.Vector3();
const C = new THREE.Vector3();
const AB = new THREE.Vector3();
const AC = new THREE.Vector3();
const CROSS = new THREE.Vector3();

/** Sum of triangle areas belonging to `faceId` in `body`'s current
 *  tessellation. Returns 0 if the face id is unknown or contributes no
 *  triangles (never throws -- callers treat this as a best-effort display
 *  value, not a fail-loud contract). */
export function faceAreaFromMesh(body: CachedBody, faceId: StableId): number {
  const index = body.geometry.getIndex();
  const position = body.geometry.getAttribute('position');
  if (index === null || position === undefined) return 0;

  let area = 0;
  const triCount = body.triFace.length;
  for (let t = 0; t < triCount; t++) {
    const faceIndex = body.triFace[t];
    if (body.faceIds[faceIndex] !== faceId) continue;
    const i0 = index.getX(t * 3);
    const i1 = index.getX(t * 3 + 1);
    const i2 = index.getX(t * 3 + 2);
    A.fromBufferAttribute(position, i0);
    B.fromBufferAttribute(position, i1);
    C.fromBufferAttribute(position, i2);
    AB.subVectors(B, A);
    AC.subVectors(C, A);
    CROSS.crossVectors(AB, AC);
    area += CROSS.length() * 0.5;
  }
  return area;
}
