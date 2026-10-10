// viewport3d GeomBridgeSession -- REAL occt-wasm kernel, WO INT-1 additions:
// measure() (acceptance #3, "values from the kernel measure API") and
// importStepFile() (acceptance #1, "Open STEP"). Mirrors
// geomBridgeSession.integration.test.ts's pattern (createLocalGeomService(),
// the exact client shape a browser caller's createGeomService() worker
// client presents).
//
// ENVIRONMENT NOTE inherited from GEO-2 (coordination/reports/GEO-2.report.json):
// Sample Parts/Tray.step (this WO's own benchmark part, 696 faces) IS present
// in this worktree now (committed 2026-07-07 after GEO-2 flagged the gap --
// see git log), but importing/tessellating it here would make this a slow
// per-run test; that full-scale proof belongs to the permanent headless smoke
// (tools/smoke/lab3d-smoke.mjs), which drives it through the REAL browser
// worker end to end. This suite proves the WIRING (measure exact values,
// importStepFile tracks handles correctly) fast, against a fabricated box
// (analytic ground truth) and the smallest real vendor STEP fixture already
// used by GEO-2's own tests.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tessQualityForTier } from '../../geom/index.ts';
import { createLocalGeomService, type GeomClient } from '../../geom/index.ts';
import { GeomBridgeSession } from '../../viewport3d/geomBridgeSession';
import type { RayLike } from '../../viewport3d/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../..');

const V = { x: 40, y: 20, z: 10 };

function ray(origin: [number, number, number], direction: [number, number, number]): RayLike {
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    direction: { x: direction[0], y: direction[1], z: direction[2] },
  };
}

function loadFileBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('GeomBridgeSession.measure (real occt-wasm kernel, analytic fixtures)', () => {
  let client: GeomClient;

  beforeAll(async () => {
    client = createLocalGeomService();
  }, 60_000);

  afterAll(async () => {
    await client.terminate();
  });

  it('body volume with no ids: exact analytic L*W*H', async () => {
    const session = new GeomBridgeSession(client);
    await session.init();
    await session.createBox('vol-box', { featureId: 'FV', size: V });

    const result = await session.measure('vol-box', 'volume');
    expect(result.kind).toBe('volume');
    expect(result.value).toBeCloseTo(V.x * V.y * V.z, 6);

    await session.disposeBody('vol-box');
  }, 60_000);

  it('whole-body area with no ids: exact analytic surface area', async () => {
    const session = new GeomBridgeSession(client);
    await session.init();
    await session.createBox('whole-area-box', { featureId: 'FWA', size: V });

    const surfaceArea = 2 * (V.x * V.y + V.x * V.z + V.y * V.z);
    const result = await session.measure('whole-area-box', 'area');
    expect(result.kind).toBe('area');
    expect(result.value).toBeCloseTo(surfaceArea, 6);

    await session.disposeBody('whole-area-box');
  }, 60_000);

  it('measure("area", [faceId]) is id-scoped: returns the ONE face\'s exact area, never the whole body (BK-20, landed via GEO-3)', async () => {
    // History: this test originally DOCUMENTED the pre-GEO-3 gap (area
    // ignored ids and returned whole-body surface) so the kernel fix could
    // not land silently -- it tripped exactly as designed at the GEO-3
    // merge, and the Architect flipped it to guard the CORRECT behavior
    // (2026-07-08). If area ever regresses to whole-body again, this fails.
    const session = new GeomBridgeSession(client);
    await session.init();
    await session.createBox('area-gap-box', { featureId: 'FA', size: V });
    await session.tessellateProgressive('area-gap-box');

    const faceHit = session.pick(['area-gap-box'], ray([20, 10, 100], [0, 0, -1]), 'face');
    expect(faceHit?.kind).toBe('face');
    if (faceHit === null || faceHit.kind !== 'face') throw new Error('unreachable');

    const oneFaceArea = V.x * V.y; // the top face's exact analytic area
    const wholeBodyArea = 2 * (V.x * V.y + V.x * V.z + V.y * V.z);
    const result = await session.measure('area-gap-box', 'area', [faceHit.id]);
    expect(result.value).toBeCloseTo(oneFaceArea, 6);
    expect(result.value).not.toBeCloseTo(wholeBodyArea, 6);

    await session.disposeBody('area-gap-box');
  }, 60_000);

  it('edge length for the xMax/zMax edge: exact analytic y-extent (straight edge)', async () => {
    const session = new GeomBridgeSession(client);
    await session.init();
    await session.createBox('edge-box', { featureId: 'FE', size: V });
    await session.tessellateProgressive('edge-box');

    // Same diagonal-approach construction as geomBridgeSession.integration.test.ts's
    // edge-pick case -- lands on the xMax/zMax edge, which spans the box's
    // Y extent (0..20) at x=40, z=10.
    const edgeHit = session.pick(['edge-box'], ray([90, 20, 40], [-50, -10, -30]), 'edge');
    expect(edgeHit?.kind).toBe('edge');
    if (edgeHit === null || edgeHit.kind !== 'edge') throw new Error('unreachable');

    const result = await session.measure('edge-box', 'length', [edgeHit.id]);
    expect(result.kind).toBe('length');
    expect(result.value).toBeCloseTo(V.y, 6);

    await session.disposeBody('edge-box');
  }, 60_000);

  it('measuring an unknown bodyId fails loud, never silently returns a stub value', async () => {
    const session = new GeomBridgeSession(client);
    await session.init();
    await expect(session.measure('never-created', 'volume')).rejects.toThrow(/no tracked handle/);
  }, 60_000);
});

describe('GeomBridgeSession.importStepFile (real occt-wasm kernel, real vendor STEP)', () => {
  let client: GeomClient;

  beforeAll(async () => {
    client = createLocalGeomService();
  }, 60_000);

  afterAll(async () => {
    await client.terminate();
  });

  it('imports a real STEP file, tracks each body under a fresh bodyId, and tessellates+measures it at a bbox-relative tier', async () => {
    const session = new GeomBridgeSession(client);
    await session.init();

    const bytes = loadFileBytes(join(REPO_ROOT, 'Sample Parts', 'Step Test With Holes.step'));
    const { bodies, diagnostics } = await session.importStepFile('IMP-TEST', bytes);

    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const d of diagnostics) expect(d.severity).not.toBe('error');
    for (const body of bodies) {
      expect(body.bodyId.startsWith('IMP-TEST:body#')).toBe(true);
      expect(body.name.length).toBeGreaterThan(0); // GEO-2 guarantee: never undefined/empty

      const handle = session.getHandle(body.bodyId);
      expect(handle).toBeDefined();
      if (handle === undefined) continue;

      const diag = await client.bboxDiagonal(handle);
      expect(diag).toBeGreaterThan(0);

      const qualities = { coarse: tessQualityForTier(diag, 'coarse'), display: tessQualityForTier(diag, 'fine') };
      const paints: string[] = [];
      const { coarse, display } = await session.tessellateProgressiveAtQuality(body.bodyId, qualities, (phase) =>
        paints.push(phase),
      );
      expect(paints).toEqual(['coarse', 'display']);
      expect(coarse.geometry.getAttribute('position').count).toBeGreaterThan(0);
      expect(display.geometry.getAttribute('position').count).toBeGreaterThan(0);

      // Real kernel volume through the exact same measure() path the UI calls
      // -- not analytically known for a real vendor part, but proves the
      // wiring returns a real positive number, not a stub/zero.
      const volume = await session.measure(body.bodyId, 'volume');
      expect(volume.value).toBeGreaterThan(0);

      await session.disposeBody(body.bodyId);
    }
  }, 120_000);
});
