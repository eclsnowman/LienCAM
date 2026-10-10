// viewport3d GeomBridgeSession.adoptBody -- REAL occt-wasm kernel via the
// FROZEN facade (WO UI-10, BK-60). BK-60 was Lab3DView's "Defeature holes"
// affordance displaying its healed result by exportStep -> re-import through
// openStepFile: that leaked the intermediate defeatured worker handle (never
// disposed after export) and discarded the engine's stable-id lineage
// (re-import mints fresh ids). adoptBody lets a caller register an ALREADY-
// MINTED worker handle (e.g. defeatureBatch's result) under a bodyId with the
// same session bookkeeping createBox/createCutBox/importStepFile give theirs
// -- this test drives that against the real kernel, exactly the shape
// Lab3DView's handleDefeatureHoles now uses.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalGeomService, type GeomClient } from '../../geom/index.ts';
import type { FeatureClass, Vec3 } from '../../geom/geom-service.ts';
import { GeomBridgeSession } from '../../viewport3d/geomBridgeSession';

const BOX: Vec3 = { x: 60, y: 30, z: 12 };
const TOP = 'F1:BOX:zMax';
const HOLE_CLASSES: FeatureClass[] = ['throughHole', 'blindHole', 'counterboreStack'];

describe('GeomBridgeSession.adoptBody (real occt-wasm kernel via createLocalGeomService facade)', () => {
  let client: GeomClient;

  beforeAll(async () => {
    client = createLocalGeomService();
  }, 60_000);

  afterAll(async () => {
    await client.terminate();
  });

  it('acceptance #1: adoptBody registers a defeatureBatch-produced handle -- tessellates AND measures through the session; disposeBody releases it', async () => {
    const session = new GeomBridgeSession(client);
    await session.init();

    // Build a box with 3 blind holes -- the exact fixture shape
    // src/tests/geom/defeature.test.ts uses for the same engine API,
    // driven here through the session's own createBox (not GeomEngine
    // directly) so this proves the SAME path Lab3DView drives.
    const boxHandle = await session.createBox('pre-defeature', { featureId: 'F1', size: BOX });
    const pts: Vec3[] = [
      { x: 15, y: 15, z: 12 },
      { x: 30, y: 15, z: 12 },
      { x: 45, y: 15, z: 12 },
    ];
    const holed = await client.makeHole({
      featureId: 'H',
      body: boxHandle,
      face: TOP,
      points: pts,
      style: { kind: 'simple', diameter: 6 },
      depth: { kind: 'blind', distance: 5 },
    });
    expect(holed.ok).toBe(true);
    const holedHandle = holed.body!;

    const verdicts = await client.recognizeFeatures!(holedHandle);
    const holes = verdicts.filter((v) => v.removable && HOLE_CLASSES.includes(v.featureClass));
    expect(holes.length).toBe(3);

    const defeatured = await client.defeatureBatch!({
      featureId: 'LAB_DEFEATURE',
      body: holedHandle,
      query: { classes: HOLE_CLASSES },
    });
    expect(defeatured.ok).toBe(true);
    expect(defeatured.report?.healed).toBe(3);
    const healedHandle = defeatured.body!;
    expect(healedHandle).not.toBe(holedHandle); // defeatureBatch minted a NEW worker handle

    // adoptBody: register the ALREADY-MINTED healed handle under a fresh
    // bodyId, same bookkeeping createBox/importStepFile give theirs.
    const summary = session.adoptBody('post-defeature', healedHandle, 'pre-defeature (defeatured)');
    expect(summary).toEqual({ bodyId: 'post-defeature', name: 'pre-defeature (defeatured)' });
    expect(session.getHandle('post-defeature')).toBe(healedHandle);

    // tessellateProgressive works on the adopted body exactly as it does on
    // a created one.
    const paints: string[] = [];
    const result = await session.tessellateProgressive('post-defeature', (phase) => paints.push(phase));
    expect(paints).toEqual(['coarse', 'display']);
    expect(session.cache.has('post-defeature')).toBe(true);
    expect(result.display.geometry.getAttribute('position').count).toBeGreaterThan(0);

    // measure works on the adopted body too -- exact kernel volume, back to
    // (near enough) the sharp box's volume now the holes are healed.
    const vBox = (await session.measure('pre-defeature', 'volume')).value;
    const vHealed = (await session.measure('post-defeature', 'volume')).value;
    expect(Math.abs(vHealed - vBox)).toBeLessThan(1e-2);

    // disposeBody releases the adopted handle at the WORKER too (same proof
    // convention as geomBridgeSession.integration.test.ts's dispose case).
    await session.disposeBody('post-defeature');
    expect(session.cache.has('post-defeature')).toBe(false);
    expect(session.getHandle('post-defeature')).toBeUndefined();
    await expect(client.tessellate(healedHandle, { deflection: 0.1 })).rejects.toThrow(/unknown BodyHandle/);

    await session.disposeBody('pre-defeature');
    // defeatureBatch heals on a COPY -- its input (holedHandle) is untouched
    // and left live, same convention as createCutBox's target/tool handles
    // (viewport3d/geomBridgeSession.ts's own doc comment); clean it up
    // directly since the session never tracked it.
    await client.dispose(holedHandle);
  }, 120_000);

  it('acceptance #2 (leak test): the full defeature flow leaves exactly the DISPLAYED body tracked -- the intermediate defeatured handle is not orphaned', async () => {
    const session = new GeomBridgeSession(client);
    await session.init();

    // ---- fixture setup: an already-holed body, tracked by the session
    // under ONE bodyId -- the box-then-makeHole staging is pure test-
    // fixture construction (a stand-in for "a STEP import that already has
    // holes baked in"), NOT part of the flow under test; its staging handle
    // is cleaned up before that flow starts. ----
    const plainBox = await client.makeBox('F1', BOX);
    const pts: Vec3[] = [
      { x: 15, y: 15, z: 12 },
      { x: 30, y: 15, z: 12 },
      { x: 45, y: 15, z: 12 },
    ];
    const holed = await client.makeHole({
      featureId: 'H',
      body: plainBox.body!,
      face: TOP,
      points: pts,
      style: { kind: 'simple', diameter: 6 },
      depth: { kind: 'blind', distance: 5 },
    });
    const preDefeatureHandle = holed.body!;
    await client.dispose(plainBox.body!);

    session.adoptBody('lab-body', preDefeatureHandle, 'Imported Part'); // stand-in for importStepFile's own tracking
    await session.tessellateProgressive('lab-body'); // the display state before the defeature flow runs

    // ---- flow under test: exactly what Lab3DView's handleDefeatureHoles
    // does (recognize -> defeatureBatch -> adoptBody -> disposeBody the
    // pre-defeature body) -- NO exportStep, no re-import. ----
    const verdicts = await client.recognizeFeatures!(preDefeatureHandle);
    const holes = verdicts.filter((v) => v.removable && HOLE_CLASSES.includes(v.featureClass));
    expect(holes.length).toBe(3);
    const r = await client.defeatureBatch!({
      featureId: 'LAB_DEFEATURE',
      body: preDefeatureHandle,
      query: { classes: HOLE_CLASSES },
    });
    expect(r.ok).toBe(true);
    const healedHandle = r.body!;

    const summary = session.adoptBody('lab-body:defeatured#1', healedHandle, 'Imported Part (defeatured)');
    await session.disposeBody('lab-body'); // old body removed -- same call handleDefeatureHoles makes

    // ---- leak assertions ----
    // 1. session-side bookkeeping: the pre-defeature bodyId is untracked;
    //    the new bodyId is tracked to the EXACT healed handle -- not a
    //    re-wrap, not a second/duplicate registration.
    expect(session.getHandle('lab-body')).toBeUndefined();
    expect(session.getHandle(summary.bodyId)).toBe(healedHandle);

    // 2. worker-side proof the pre-defeature handle is truly RELEASED, not
    //    merely untracked -- same "unknown BodyHandle" proof convention as
    //    geomBridgeSession.integration.test.ts's disposeBody case.
    await expect(client.tessellate(preDefeatureHandle, { deflection: 0.1 })).rejects.toThrow(/unknown BodyHandle/);

    // 3. the intermediate defeatured handle is NOT orphaned: it is exactly
    //    the ONE body now tracked/displayed -- tessellates and measures
    //    fine through the session, same as any created/imported body.
    await session.tessellateProgressive(summary.bodyId);
    expect(session.cache.has(summary.bodyId)).toBe(true);
    await expect(session.measure(summary.bodyId, 'volume')).resolves.toMatchObject({ kind: 'volume' });

    await session.disposeBody(summary.bodyId);
  }, 120_000);
});
