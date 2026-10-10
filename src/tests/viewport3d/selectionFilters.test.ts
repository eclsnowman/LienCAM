// viewport3d selection filters: body/face/edge/vertex modes gate what the
// SAME ray resolves to (AC4). One ray, landing just inside the top face and
// close to (but not on) one of its edges, far from every vertex --
// each filter mode reads a different layer of the same geometry.

import { describe, expect, it } from 'vitest';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import { PickEngine } from '../../viewport3d/PickEngine';
import type { RayLike } from '../../viewport3d/types';
import { makeBoxFixture } from './fixtures';

const BODY_ID = 'box-1';

function ray(origin: [number, number, number], direction: [number, number, number]): RayLike {
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    direction: { x: direction[0], y: direction[1], z: direction[2] },
  };
}

describe('selection filter gating', () => {
  it('body/face/edge/vertex modes each resolve the same ray to their own granularity', () => {
    const fixture = makeBoxFixture(); // sx=40, sy=20, sz=10
    const cache = new GeometryCache();
    cache.ingest(BODY_ID, fixture.buffers);
    const engine = new PickEngine(cache);

    // Lands on the top face at (39.9, 18, 10): 0.1 units inside the
    // posX/posZ edge (x=40 exactly, within the default 0.25 edge
    // threshold), ~2 units from that edge's nearest vertex (outside the
    // default 0.4 vertex threshold). Tilted in y (not a pure vertical ray)
    // so the mirror-image edge on the BOTTOM face (posX/negZ, same x=40
    // line) lands nowhere near this ray -- a straight-down ray would be
    // equidistant from both and the "closest" edge would depend on
    // iteration order instead of actual proximity.
    const point: [number, number, number] = [39.9, 10, 20];
    const dir: [number, number, number] = [0, 8, -10];

    const bodyHit = engine.pick(BODY_ID, ray(point, dir), 'body');
    expect(bodyHit?.kind).toBe('body');
    expect(bodyHit?.id).toBe(BODY_ID);

    const faceHit = engine.pick(BODY_ID, ray(point, dir), 'face');
    expect(faceHit?.kind).toBe('face');
    expect(faceHit?.id).toBe(fixture.faceIds.posZ);

    const edgeHit = engine.pick(BODY_ID, ray(point, dir), 'edge');
    expect(edgeHit?.kind).toBe('edge');
    expect(edgeHit?.id).toBe(`E:${fixture.faceIds.posX}|${fixture.faceIds.posZ}`);

    const vertexHit = engine.pick(BODY_ID, ray(point, dir), 'vertex');
    expect(vertexHit).toBeNull();
  });

  it('vertex mode alone surfaces a corner that face/body/edge modes on a face-interior ray never would', () => {
    const fixture = makeBoxFixture();
    const cache = new GeometryCache();
    cache.ingest(BODY_ID, fixture.buffers);
    const engine = new PickEngine(cache);

    const corner = fixture.corners[6];
    const [cx, cy, cz] = corner.position;
    const hit = engine.pick(BODY_ID, ray([cx + 30, cy + 30, cz], [-1, -1, 0]), 'vertex');
    expect(hit).not.toBeNull();
    if (hit === null) throw new Error('unreachable');
    expect(hit.kind).toBe('vertex');
    if (hit.kind !== 'vertex') throw new Error('unreachable');
    expect([...hit.id.adjacentEdgeIds].sort()).toEqual(corner.expectedAdjacentEdgeIds);
  });
});
