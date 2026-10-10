// viewport3d faceArea: mesh-derived face area (WO INT-1 fallback -- see
// faceArea.ts header for why this exists instead of the kernel measure API).
// Uses the same mock box fixture as highlight.test.ts (6 faces, per-face
// unique vertices, known analytic dimensions) -- a planar face's
// triangulated area sum is EXACT regardless of tessellation deflection, so
// this can assert exact equality, not just "close to".

import { describe, expect, it } from 'vitest';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import { faceAreaFromMesh } from '../../viewport3d/faceArea';
import { makeBoxTessBuffers } from '../../viewport3d/fixtures';

const BODY_ID = 'box-1';
const SIZE = { x: 40, y: 20, z: 10 };

describe('faceAreaFromMesh', () => {
  it('sums to the exact analytic area for each planar face of a box', () => {
    const cache = new GeometryCache();
    const body = cache.ingest(BODY_ID, makeBoxTessBuffers({ size: SIZE }));

    // Face order per fixtures.ts: -X,+X (y*z), -Y,+Y (x*z), -Z,+Z (x*y).
    const expectedAreas = [
      SIZE.y * SIZE.z,
      SIZE.y * SIZE.z,
      SIZE.x * SIZE.z,
      SIZE.x * SIZE.z,
      SIZE.x * SIZE.y,
      SIZE.x * SIZE.y,
    ];

    for (let f = 0; f < 6; f++) {
      const area = faceAreaFromMesh(body, body.faceIds[f]);
      expect(area).toBeCloseTo(expectedAreas[f], 9);
    }
  });

  it('returns 0 for an unknown face id rather than throwing', () => {
    const cache = new GeometryCache();
    const body = cache.ingest(BODY_ID, makeBoxTessBuffers({ size: SIZE }));
    expect(faceAreaFromMesh(body, 'not-a-real-face-id')).toBe(0);
  });
});
