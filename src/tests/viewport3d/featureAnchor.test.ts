// viewport3d featureAnchor: mesh-derived feature anchor point (WO UI-58-R1
// minor finding -- the supplement-list anchor must derive from the matched
// feature's own faces, not the owning body's whole bounding box). Same mock
// box fixture as faceArea.test.ts/highlight.test.ts (6 faces, per-face
// unique vertices, known analytic dimensions).

import { describe, expect, it } from 'vitest';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import { featureAnchorFromMesh } from '../../viewport3d/featureAnchor';
import { makeBoxTessBuffers } from '../../viewport3d/fixtures';

const BODY_ID = 'box-1';
const SIZE = { x: 40, y: 20, z: 10 };

describe('featureAnchorFromMesh', () => {
  it('centers on a single planar face, OFF the body bounding-box center for an off-center box', () => {
    const cache = new GeometryCache();
    // Face order per fixtures.ts: -X,+X (index 0,1), -Y,+Y (2,3), -Z,+Z (4,5).
    // Centered at a non-origin point so "body bbox top-center" and "this
    // face's own centroid" would disagree if the code fell back to the bbox.
    const center = { x: 12, y: -6, z: 3 };
    const body = cache.ingest(BODY_ID, makeBoxTessBuffers({ size: SIZE, center }));

    const topFaceAnchor = featureAnchorFromMesh(body, [body.faceIds[5]]);
    expect(topFaceAnchor).toBeDefined();
    expect(topFaceAnchor!.x).toBeCloseTo(center.x, 9);
    expect(topFaceAnchor!.y).toBeCloseTo(center.y, 9);
    expect(topFaceAnchor!.z).toBeCloseTo(center.z + SIZE.z / 2, 9);

    // A side face (+X) anchors at its own plane, not the top face's.
    const sideFaceAnchor = featureAnchorFromMesh(body, [body.faceIds[1]]);
    expect(sideFaceAnchor).toBeDefined();
    expect(sideFaceAnchor!.x).toBeCloseTo(center.x + SIZE.x / 2, 9);
    expect(sideFaceAnchor!.z).toBeCloseTo(center.z, 9);
  });

  it('averages across every faceId in a multi-face feature (e.g. a counterbore stack)', () => {
    const cache = new GeometryCache();
    const body = cache.ingest(BODY_ID, makeBoxTessBuffers({ size: SIZE }));
    // The two Z faces (-Z at z=-5, +Z at z=+5) have equal vertex counts, so
    // their combined centroid lands back on z=0 -- proving this is a real
    // vertex average across ALL supplied faceIds, not just the first.
    const combined = featureAnchorFromMesh(body, [body.faceIds[4], body.faceIds[5]]);
    expect(combined).toBeDefined();
    expect(combined!.z).toBeCloseTo(0, 9);
  });

  it('returns undefined for an unknown face id rather than falling back silently', () => {
    const cache = new GeometryCache();
    const body = cache.ingest(BODY_ID, makeBoxTessBuffers({ size: SIZE }));
    expect(featureAnchorFromMesh(body, ['not-a-real-face-id'])).toBeUndefined();
  });

  it('returns undefined for an empty faceIds list', () => {
    const cache = new GeometryCache();
    const body = cache.ingest(BODY_ID, makeBoxTessBuffers({ size: SIZE }));
    expect(featureAnchorFromMesh(body, [])).toBeUndefined();
  });
});
