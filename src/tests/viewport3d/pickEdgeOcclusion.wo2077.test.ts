import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DoubleSide, OrthographicCamera, PerspectiveCamera, Ray, Vector3 } from 'three';
import { createLocalGeomService, tessQualityForTier } from '../../geom';
import { GeomBridgeSession } from '../../viewport3d/geomBridgeSession';
import { GeometryCache } from '../../viewport3d/GeometryCache';
import { PickEngine } from '../../viewport3d/PickEngine';
import { pickAcrossBodies } from '../../viewport3d/multiBodyPick';
import { makeBoxTessBuffers } from '../../viewport3d/fixtures';
import { screenSpaceEdgePickThresholds } from '../../viewport3d/screenSpacePick';
import { applyFrameBox } from '../../components/model3d/sceneRuntime';

// Real importStep -> production tessellation/cache -> public PickEngine path,
// also used by Model's Fillet/Chamfer hover and click via pickAcrossBodies.
// The original capture assets were not committed with REPORT.md. Reconstruct
// the default Model camera using its actual frameBox math, not a guessed pose.
describe('WO-2077 imported pocket edge visibility', () => {
  const client = createLocalGeomService();
  const session = new GeomBridgeSession(client);
  let bodyId: string;
  const camera = new PerspectiveCamera(45, 1.5, 0.1, 2000);

  beforeAll(async () => {
    await session.init();
    const bytes = readFileSync('test_fixtures/brep/fix_block_pocket.step');
    const imported = await session.importStepFile('IMP1', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    bodyId = imported.bodies[0].bodyId;
    const diagonal = await client.bboxDiagonal(session.getHandle(bodyId)!);
    const { display } = await session.tessellateProgressiveAtQuality(bodyId, {
      coarse: tessQualityForTier(diagonal, 'coarse'),
      display: tessQualityForTier(diagonal, 'fine'),
    });
    display.geometry.computeBoundingBox();
    const bounds = display.geometry.boundingBox!;
    camera.up.set(0, 0, 1);
    camera.position.set(85, -85, 65);
    applyFrameBox(camera, { target: new Vector3(), update() {} }, bounds.min, bounds.max, 1200, 800);
    camera.updateMatrixWorld(true);
  }, 60_000);

  afterAll(async () => {
    await session.disposeAllBodies();
    await client.terminate();
  });

  it.each([8, 10, 12])('takes the visible fillet rim over the hidden corner at z=%s', z => {
    const entry = session.cache.get(bodyId)!;
    const ray = new Ray(camera.position.clone(), new Vector3(0, 60, z).sub(camera.position).normalize());
    const thresholds = screenSpaceEdgePickThresholds(camera, 800, ray);
    const hit = session.pick([bodyId], ray, 'edge', thresholds);
    const expected = entry.edgeIds.find(id => id.includes('face#12') && id.includes('face#2)'));
    expect(expected).toBeDefined();
    expect(hit?.id).toBe(expected);
    expect(hit?.point.z).toBeCloseTo(20, 5);
    // Independent visibility oracle: the picked point is on the FIRST surface,
    // whereas the back corner lies ~26 mm behind the pocket-corner surface.
    const point = new Vector3(hit!.point.x, hit!.point.y, hit!.point.z);
    const sight = new Ray(camera.position.clone(), point.clone().sub(camera.position).normalize());
    const face = entry.bvh.raycastFirst(sight, DoubleSide);
    expect(face === null || face.distance >= point.distanceTo(camera.position) - 0.001).toBe(true);
    expect(session.pickEngine.pick(bodyId, ray, 'edge', thresholds)?.id).toBe(expected);
  });

  it('returns no hidden edge when the cursor is in the fillet interior away from its visible boundaries', () => {
    const ray = new Ray(camera.position.clone(), new Vector3(0, 60, 6).sub(camera.position).normalize());
    expect(session.pick([bodyId], ray, 'edge', screenSpaceEdgePickThresholds(camera, 800, ray))).toBeNull();
  });

  it('keeps a visible outer vertical edge selectable', () => {
    const ray = new Ray(camera.position.clone(), new Vector3(80, 0, 10).sub(camera.position).normalize());
    const hit = session.pick([bodyId], ray, 'edge', screenSpaceEdgePickThresholds(camera, 800, ray));
    expect(hit?.point).toEqual({ x: 80, y: 0, z: expect.closeTo(10, 5) });
  });
});

describe('WO-2077 visibility controls', () => {
  it.each(['perspective', 'orthographic'] as const)('keeps an off-cursor silhouette selectable with %s projection', projection => {
    const cache = new GeometryCache();
    cache.ingest('box', makeBoxTessBuffers({ size: { x: 20, y: 20, z: 10 } }));
    const engine = new PickEngine(cache);
    const camera = projection === 'perspective'
      ? new PerspectiveCamera(45, 1, 0.1, 2000)
      : new OrthographicCamera(-50, 50, 50, -50, 0.1, 2000);
    camera.position.set(0, -10, 100);
    camera.lookAt(0, -10, 0);
    camera.updateMatrixWorld(true);
    // Cursor misses the entire body; its nearby top silhouette must still hit.
    const ray = projection === 'perspective'
      ? new Ray(camera.position.clone(), new Vector3(0, -0.5, -95).normalize())
      : new Ray(new Vector3(0, -10.5, 100), new Vector3(0, 0, -1));
    expect(engine.pick('box', ray, 'face')).toBeNull();
    const hit = engine.pick('box', ray, 'edge', screenSpaceEdgePickThresholds(camera, 800, ray));
    expect(hit?.point).toEqual({ x: 0, y: -10, z: 5 });
    cache.disposeAll();
  });

  it('rejects a nearer screen-space candidate behind a thin wall even with a generous cursor tolerance', () => {
    const cache = new GeometryCache();
    cache.ingest('plate', makeBoxTessBuffers({ size: { x: 20, y: 20, z: 0.1 } }));
    const engine = new PickEngine(cache);
    const ray = new Ray(new Vector3(0, 0, 10), new Vector3(10, 0, -10.05).normalize());
    const hit = engine.pick('plate', ray, 'edge', { edge: 1, vertex: 1 });
    expect(hit?.point.z).toBeCloseTo(0.05, 5);
    cache.disposeAll();
  });

  it('checks other candidate bodies but ignores bodies omitted by the caller', () => {
    const cache = new GeometryCache();
    cache.ingest('rear', makeBoxTessBuffers({ size: { x: 20, y: 20, z: 10 } }));
    cache.ingest('front', makeBoxTessBuffers({ size: { x: 40, y: 40, z: 10 }, center: { x: 0, y: 0, z: 30 } }));
    const engine = new PickEngine(cache);
    const ray = new Ray(new Vector3(10, 0, 100), new Vector3(0, 0, -1));
    expect(pickAcrossBodies(cache, engine, ['rear', 'front'], ray, 'edge')).toBeNull();
    expect(pickAcrossBodies(cache, engine, ['front', 'rear'], ray, 'edge')).toBeNull();
    expect(pickAcrossBodies(cache, engine, ['rear', 'missing'], ray, 'edge')?.point.z).toBe(5);
    expect(pickAcrossBodies(cache, engine, ['rear', 'front'], ray, 'face')?.bodyId).toBe('front');
    cache.disposeAll();
  });
});
