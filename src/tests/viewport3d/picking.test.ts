// viewport3d PickEngine: BVH face raycast + edge/vertex proximity picking,
// resolved to stable ids on the box fixture (AC2).

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

function setup() {
  const fixture = makeBoxFixture(); // sx=40, sy=20, sz=10
  const cache = new GeometryCache();
  cache.ingest(BODY_ID, fixture.buffers);
  const engine = new PickEngine(cache);
  return { fixture, cache, engine };
}

describe('PickEngine', () => {
  it('resolves an unknown body to null', () => {
    const { engine } = setup();
    const hit = engine.pick('nope', ray([0, 0, 100], [0, 0, -1]), 'body');
    expect(hit).toBeNull();
  });

  it('face filter: BVH raycast resolves via triFace to the correct face stable id', () => {
    const { fixture, engine } = setup();
    // Straight down onto the +Z (top) face center.
    const hit = engine.pick(BODY_ID, ray([20, 10, 100], [0, 0, -1]), 'face');
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe('face');
    expect(hit?.id).toBe(fixture.faceIds.posZ);
    expect(hit?.point.z).toBeCloseTo(10, 5);
  });

  it('face filter: resolves the correct face on a different side of the same body', () => {
    const { fixture, engine } = setup();
    // From +X looking toward -X, hits the posX face.
    const hit = engine.pick(BODY_ID, ray([100, 10, 5], [-1, 0, 0]), 'face');
    expect(hit?.kind).toBe('face');
    expect(hit?.id).toBe(fixture.faceIds.posX);
    expect(hit?.point.x).toBeCloseTo(40, 5);
  });

  it('body filter: any hit on the mesh resolves to the bodyId, not a face id', () => {
    const { engine } = setup();
    const hit = engine.pick(BODY_ID, ray([20, 10, 100], [0, 0, -1]), 'body');
    expect(hit?.kind).toBe('body');
    expect(hit?.id).toBe(BODY_ID);
  });

  it('edge filter: proximity pick resolves the correct edge stable id', () => {
    const { fixture, engine } = setup();
    const sample = fixture.edgeSamples.find(
      (s) => s.expectedEdgeId === `E:${fixture.faceIds.posX}|${fixture.faceIds.posZ}`,
    );
    expect(sample).toBeDefined();
    const [mx, my, mz] = sample!.midpoint;
    // Approach diagonally (not axis-aligned) so the ray cannot be exactly
    // collinear with any other (axis-aligned) box edge on its way in.
    const hit = engine.pick(
      BODY_ID,
      ray([mx + 50, my + 10, mz + 30], [-50, -10, -30]),
      'edge',
    );
    expect(hit?.kind).toBe('edge');
    expect(hit?.id).toBe(sample!.expectedEdgeId);
  });

  it('edge filter: a ray through a face interior (far from any edge) misses', () => {
    const { engine } = setup();
    const hit = engine.pick(BODY_ID, ray([20, 10, 100], [0, 0, -1]), 'edge');
    expect(hit).toBeNull();
  });

  it('vertex filter: proximity pick resolves a BridgeVertexRef carrying the correct adjacent edge ids', () => {
    const { fixture, engine } = setup();
    const corner = fixture.corners[6]; // v6 = (sx, sy, sz)
    const [cx, cy, cz] = corner.position;
    // Approach diagonally in x/y at constant z=cz: v6's vertical neighbor
    // (v2, directly below at z=0) sits off this ray's z-plane, so it can't
    // tie with v6 the way a purely vertical ray would.
    const hit = engine.pick(BODY_ID, ray([cx + 30, cy + 30, cz], [-1, -1, 0]), 'vertex');
    expect(hit).not.toBeNull();
    if (hit === null) throw new Error('unreachable');
    expect(hit.kind).toBe('vertex');
    // Narrowing on hit.kind is required to reach .adjacentEdgeIds -- a
    // vertex hit's id is a BridgeVertexRef, not a StableId (R1.2); the type
    // system does not expose adjacentEdgeIds on the other PickHit variants.
    if (hit.kind !== 'vertex') throw new Error('unreachable');
    expect([...hit.id.adjacentEdgeIds].sort()).toEqual(corner.expectedAdjacentEdgeIds);
    expect(hit.point).toEqual({ x: cx, y: cy, z: cz });
  });

  it('vertex filter: repeated picks at the same corner are deterministic', () => {
    const { fixture, engine } = setup();
    const corner = fixture.corners[0];
    const [cx, cy, cz] = corner.position;
    const r = ray([cx + 20, cy + 20, cz + 20], [-1, -1, -1]);
    const first = engine.pick(BODY_ID, r, 'vertex');
    const second = engine.pick(BODY_ID, r, 'vertex');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null || first.kind !== 'vertex' || second.kind !== 'vertex') {
      throw new Error('unreachable');
    }
    expect([...first.id.adjacentEdgeIds].sort()).toEqual([...second.id.adjacentEdgeIds].sort());
    expect([...first.id.adjacentEdgeIds].sort()).toEqual(corner.expectedAdjacentEdgeIds);
  });

  it('vertex filter: a ray far from any vertex misses', () => {
    const { fixture, engine } = setup();
    // Face center of +Z, far from all 8 corners at the default threshold.
    void fixture;
    const hit = engine.pick(BODY_ID, ray([20, 10, 100], [0, 0, -1]), 'vertex');
    expect(hit).toBeNull();
  });

  // R1.1 regression (WO UI-1-R1). Pre-fix, GeometryCache.ingest() derived
  // version from `prior?.version ?? 0`, and evict() deletes the prior entry
  // -- so a bodyId evicted then re-ingested restarts at version 1. PickEngine
  // memoizes its derived vertex list by (bodyId, version), so the SAME
  // (bodyId=X, version=1) key came back after reingest, and the memo handed
  // back body A's stale vertex positions for body B's geometry. Reproduces
  // codex audit evidence exactly (40x20x10 -> evict -> reingest 80x20x10
  // under the same bodyId): confirmed FAILING against the pre-fix code by
  // temporarily reverting GeometryCache.ingest()'s version line to
  // `(prior?.version ?? 0) + 1` and rerunning this test in isolation -- the
  // second pick returned null instead of the new corner (matching the
  // audit's exact repro symptom), then reverted back to the fix.
  it('vertex pick reflects new geometry after evict() + reingest of the same bodyId (R1.1)', () => {
    const cache = new GeometryCache();
    const engine = new PickEngine(cache);

    const first = makeBoxFixture(40, 20, 10);
    cache.ingest(BODY_ID, first.buffers);
    const firstCorner = first.corners[6]; // v6 = (40, 20, 10)
    const [fx, fy, fz] = firstCorner.position;
    const firstHit = engine.pick(BODY_ID, ray([fx + 30, fy + 30, fz], [-1, -1, 0]), 'vertex');
    expect(firstHit).not.toBeNull();

    cache.evict(BODY_ID);

    // Different geometry under the SAME bodyId (audit's exact repro numbers).
    const second = makeBoxFixture(80, 20, 10);
    cache.ingest(BODY_ID, second.buffers);
    const secondCorner = second.corners[6]; // v6 = (80, 20, 10) -- didn't exist in `first`
    const [sx, sy, sz] = secondCorner.position;
    const secondHit = engine.pick(BODY_ID, ray([sx + 30, sy + 30, sz], [-1, -1, 0]), 'vertex');

    expect(secondHit).not.toBeNull();
    if (secondHit === null || secondHit.kind !== 'vertex') throw new Error('unreachable');
    expect(secondHit.point).toEqual({ x: sx, y: sy, z: sz });
    expect([...secondHit.id.adjacentEdgeIds].sort()).toEqual(secondCorner.expectedAdjacentEdgeIds);

    // The old corner position no longer exists on the new (wider) body --
    // a stale memo would still report it; the fixed cache must not.
    const staleHit = engine.pick(BODY_ID, ray([fx + 30, fy + 30, fz], [-1, -1, 0]), 'vertex');
    expect(staleHit).toBeNull();
  });
});
