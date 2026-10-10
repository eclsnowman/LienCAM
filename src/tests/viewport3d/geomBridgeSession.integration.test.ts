// viewport3d GeomBridgeSession -- REAL occt-wasm kernel via the FROZEN facade
// (WO UI-2 acceptance #1/#3/#4). Mirrors GEO-1's integration-test pattern
// (init/makeBox/cut/tessellate/dispose against the real kernel in Node), but
// driven through createLocalGeomService() (src/geom/index.ts) rather than
// `new GeomEngine()` directly -- this is exactly the client shape a browser
// caller's createGeomService() worker client presents.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalGeomService, type GeomClient } from '../../geom/index.ts';
import { GeomBridgeSession } from '../../viewport3d/geomBridgeSession';
import type { RayLike } from '../../viewport3d/types';

const V = { x: 40, y: 20, z: 10 };
const TOOL_V = { x: 10, y: 10, z: 20 };

function ray(origin: [number, number, number], direction: [number, number, number]): RayLike {
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    direction: { x: direction[0], y: direction[1], z: direction[2] },
  };
}

describe('GeomBridgeSession (real occt-wasm kernel via createLocalGeomService facade)', () => {
  let client: GeomClient;

  beforeAll(async () => {
    client = createLocalGeomService();
  }, 60_000);

  afterAll(async () => {
    await client.terminate();
  });

  it('init -> createBox -> createCutBox -> tessellateProgressive -> pick -> dispose round trip (cache + worker-side proof)', async () => {
    const session = new GeomBridgeSession(client);

    const phases: Array<[number, string]> = [];
    const info = await session.init((pct, phase) => phases.push([pct, phase]));
    expect(info.backend).toBe('occt-wasm');
    expect(phases.length).toBeGreaterThanOrEqual(2);

    const plainHandle = await session.createBox('plain-box', { featureId: 'FP', size: V });
    expect(typeof plainHandle).toBe('number');

    const cutHandle = await session.createCutBox('cut-box', {
      featureId: 'F1',
      size: V,
      toolFeatureId: 'F2',
      toolSize: TOOL_V,
    });
    expect(typeof cutHandle).toBe('number');
    expect(cutHandle).not.toBe(plainHandle);

    const cutPaints: string[] = [];
    const cutResult = await session.tessellateProgressive('cut-box', (phase) => cutPaints.push(phase));
    expect(cutPaints).toEqual(['coarse', 'display']);
    expect(session.cache.has('cut-box')).toBe(true);
    expect(session.cache.get('cut-box')).toBe(cutResult.display);
    expect(cutResult.display.geometry.getAttribute('position').count).toBeGreaterThan(0);

    await session.tessellateProgressive('plain-box');
    expect(session.cache.has('plain-box')).toBe(true);

    // pickAcrossBodies: nearest of the two live bodies under one ray.
    const hit = session.pick(['plain-box', 'cut-box'], ray([20, 10, 100], [0, 0, -1]), 'body');
    expect(hit).not.toBeNull();

    // disposeBody: cache entry gone AND the worker-side handle is provably
    // released -- GeomEngine.#rec (src/geom/worker/geom-engine.ts) throws
    // `unknown BodyHandle ${h}` for any op against a disposed handle, so a
    // subsequent tessellate() against the captured handle rejecting IS the
    // proof (confirmed by reading dispose()/tessellate()/#rec before writing
    // this assertion -- dispose is NOT a silent no-op for unknown handles).
    await session.disposeBody('cut-box');
    expect(session.cache.has('cut-box')).toBe(false);
    await expect(client.tessellate(cutHandle, { deflection: 0.1 })).rejects.toThrow(/unknown BodyHandle/);

    await session.disposeBody('plain-box');
    expect(session.cache.has('plain-box')).toBe(false);
    await expect(client.tessellate(plainHandle, { deflection: 0.1 })).rejects.toThrow(/unknown BodyHandle/);

    // disposeBody on an already-untracked bodyId is a safe no-op.
    await expect(session.disposeBody('cut-box')).resolves.toBeUndefined();
  }, 120_000);

  it('face/edge/vertex picks on real tessellation; resolve() confirms face ids exact', async () => {
    const session = new GeomBridgeSession(client);
    await session.init();
    const handle = await session.createBox('pick-box', { featureId: 'FPK', size: V });
    await session.tessellateProgressive('pick-box');

    // Face pick straight down onto the top (zMax) face.
    const faceHit = session.pick(['pick-box'], ray([20, 10, 100], [0, 0, -1]), 'face');
    expect(faceHit?.kind).toBe('face');
    if (faceHit === null || faceHit.kind !== 'face') throw new Error('unreachable');
    const [faceResolved] = await client.resolve(handle, [faceHit.id]);
    expect(faceResolved.status).toBe('exact');
    expect(faceResolved.type).toBe('face');

    // Edge pick: diagonal approach (not axis-aligned) to the xMax/zMax edge
    // midpoint (40,10,10) -- same construction as PickEngine's own unit
    // tests (src/tests/viewport3d/picking.test.ts), box dims match (40,20,10).
    const edgeHit = session.pick(['pick-box'], ray([90, 20, 40], [-50, -10, -30]), 'edge');
    expect(edgeHit?.kind).toBe('edge');
    if (edgeHit === null || edgeHit.kind !== 'edge') throw new Error('unreachable');
    expect(typeof edgeHit.id).toBe('string');

    // WO-1411 closed the resolver gap this test used to pin: GeomEngine.resolve()
    // now resolves edge (and vertex) StableIds, so a picked edge is 'exact'.
    const [edgeResolved] = await client.resolve(handle, [edgeHit.id]);
    expect(edgeResolved.status).toBe('exact');
    expect(edgeResolved.type).toBe('edge');

    // Vertex pick: corner (40,20,10) -- keep z constant so the ray can't tie
    // with a vertically-neighboring corner (same trick as the unit tests).
    const vertexHit = session.pick(['pick-box'], ray([70, 50, 10], [-1, -1, 0]), 'vertex');
    expect(vertexHit?.kind).toBe('vertex');
    if (vertexHit === null || vertexHit.kind !== 'vertex') throw new Error('unreachable');
    // FAILS-IF guard (acceptance #3): a vertex hit's id must never present as
    // a bare StableId string.
    expect(typeof vertexHit.id).not.toBe('string');
    expect(Array.isArray(vertexHit.id.adjacentEdgeIds)).toBe(true);
    expect(vertexHit.id.adjacentEdgeIds.length).toBeGreaterThan(0);

    // The vertex's adjacent edge ids resolve through the same edge branch.
    const adjacentResolved = await client.resolve(handle, [...vertexHit.id.adjacentEdgeIds]);
    for (const r of adjacentResolved) expect(r.status).toBe('exact');

    await session.disposeBody('pick-box');
  }, 60_000);

  it('selection filter modes gate the same ray to their own subshape kind, on real tessellation', async () => {
    const session = new GeomBridgeSession(client);
    await session.init();
    await session.createBox('filter-box', { featureId: 'FFL', size: V });
    await session.tessellateProgressive('filter-box');

    // Lands on the top face at (39.9, 10, 10): 0.1 units inside the
    // xMax/zMax edge (within the default 0.25 edge threshold), far from that
    // edge's nearest vertex (outside the default 0.4 vertex threshold) --
    // same construction as src/tests/viewport3d/selectionFilters.test.ts,
    // box dims match (40,20,10).
    const point: [number, number, number] = [39.9, 10, 20];
    const dir: [number, number, number] = [0, 8, -10];

    const bodyHit = session.pick(['filter-box'], ray(point, dir), 'body');
    expect(bodyHit?.kind).toBe('body');

    const faceHit = session.pick(['filter-box'], ray(point, dir), 'face');
    expect(faceHit?.kind).toBe('face');

    const edgeHit = session.pick(['filter-box'], ray(point, dir), 'edge');
    expect(edgeHit?.kind).toBe('edge');

    const vertexHit = session.pick(['filter-box'], ray(point, dir), 'vertex');
    expect(vertexHit).toBeNull();

    await session.disposeBody('filter-box');
  }, 60_000);
});
