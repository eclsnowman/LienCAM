// viewport3d pickAcrossBodies: nearest-body-wins fan-out across a bodyId list
// (WO UI-2). No kernel -- mock TessBuffers via viewport3d/fixtures.ts.

import { describe, expect, it } from 'vitest';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import { PickEngine } from '../../viewport3d/PickEngine';
import { pickAcrossBodies } from '../../viewport3d/multiBodyPick';
import type { RayLike } from '../../viewport3d/types';
import { makeBoxTessBuffers } from '../../viewport3d/fixtures';

function ray(origin: [number, number, number], direction: [number, number, number]): RayLike {
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    direction: { x: direction[0], y: direction[1], z: direction[2] },
  };
}

function setup() {
  const cache = new GeometryCache();
  // Body A: 10x10x10 box centered at origin -- top face at z=5.
  cache.ingest('A', makeBoxTessBuffers({ featureId: 'A', size: { x: 10, y: 10, z: 10 }, center: { x: 0, y: 0, z: 0 } }));
  // Body B: 10x10x10 box centered at z=20 -- top face at z=25, bottom at z=15.
  cache.ingest('B', makeBoxTessBuffers({ featureId: 'B', size: { x: 10, y: 10, z: 10 }, center: { x: 0, y: 0, z: 20 } }));
  const engine = new PickEngine(cache);
  return { cache, engine };
}

describe('pickAcrossBodies', () => {
  it('returns the nearest hit across multiple bodies under one ray', () => {
    const { cache, engine } = setup();
    // Straight down from above both bodies: B's top face (z=25) is nearer
    // than A's (z=5).
    const hit = pickAcrossBodies(cache, engine, ['A', 'B'], ray([0, 0, 100], [0, 0, -1]), 'face');
    expect(hit).not.toBeNull();
    expect(hit?.bodyId).toBe('B');
  });

  it('order of bodyIds does not change which hit wins', () => {
    const { cache, engine } = setup();
    const hit = pickAcrossBodies(cache, engine, ['B', 'A'], ray([0, 0, 100], [0, 0, -1]), 'face');
    expect(hit?.bodyId).toBe('B');
  });

  it('bodies not included in bodyIds are ignored, even if geometrically nearer', () => {
    const { cache, engine } = setup();
    const hit = pickAcrossBodies(cache, engine, ['A'], ray([0, 0, 100], [0, 0, -1]), 'face');
    expect(hit).not.toBeNull();
    expect(hit?.bodyId).toBe('A');
  });

  it('bodyIds never ingested into the cache are silently skipped, not an error', () => {
    const { cache, engine } = setup();
    const hit = pickAcrossBodies(cache, engine, ['nope', 'A'], ray([0, 0, 100], [0, 0, -1]), 'face');
    expect(hit).not.toBeNull();
    expect(hit?.bodyId).toBe('A');
  });

  it('returns null when no body in the list is hit', () => {
    const { cache, engine } = setup();
    const hit = pickAcrossBodies(cache, engine, ['A', 'B'], ray([1000, 1000, 1000], [0, 0, -1]), 'face');
    expect(hit).toBeNull();
  });

  it('returns null when bodyIds is empty', () => {
    const { cache, engine } = setup();
    const hit = pickAcrossBodies(cache, engine, [], ray([0, 0, 100], [0, 0, -1]), 'face');
    expect(hit).toBeNull();
  });
});
