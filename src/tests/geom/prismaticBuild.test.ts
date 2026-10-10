// MSH-3 geom-side prismatic bridge: rebuild + sew a PlanarFaceSet into a real
// B-rep solid on the REAL occt-wasm kernel (Node). Covers acceptance criteria
// 1 (cube -> 6 faces, exact volume, exportStep round-trip), 2 (real prismatic
// plate), 5 (deterministic ids), and 9 (wasm-handle lifecycle on the error
// path). The mesh->faceSet half runs through src/mesh/prismatic.ts so this is
// the full end-to-end converter, not a hand-authored face set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { GeomEngine } from '../../geom/worker/geom-engine.ts';
import { matchProbesToInputFaces } from '../../geom/worker/prismaticBuild.ts';
import { convertPrismaticMesh } from '../../mesh/prismatic.ts';
import { measureMesh } from '../../mesh/analysis.ts';
import { importStl } from '../../mesh/stl.ts';
import { unitCube, shuffleTriangles } from '../mesh/fixtures.ts';
import type { PlanarFaceSet } from '../../geom/geom-service.ts';
import type { FaceProbe } from '../../geom/worker/internal-types.ts';

function planeSetOf(mesh: ReturnType<typeof unitCube>, convertId: string): PlanarFaceSet {
  const r = convertPrismaticMesh(mesh, { convertId });
  if (!r.ok) throw new Error(`conversion refused: ${JSON.stringify(r)}`);
  return r.faceSet;
}

function loadPlateMesh() {
  const bytes = readFileSync('src/tests/mesh/fixtures/prismatic-plate.stl');
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return importStl(ab).mesh;
}

function fakeProbe(centroid: [number, number, number], hash: number): FaceProbe {
  return { hash, snapshot: { type: 'plane', centroid, normal: [0, 0, 1], area: 1 } };
}

describe('matchProbesToInputFaces (R1.3, unit-level: no kernel needed)', () => {
  const inputCentroids: Array<[number, number, number]> = [
    [0, 0, 0],
    [10, 0, 0],
    [0, 10, 0],
    [0, 0, 10],
  ];

  it('assigns one CNVn:face#i id per probe when every probe nearest-matches a distinct input face', () => {
    const probes = [fakeProbe([0, 0, 0], 1), fakeProbe([10, 0, 0], 2), fakeProbe([0, 10, 0], 3), fakeProbe([0, 0, 10], 4)];
    const r = matchProbesToInputFaces(probes, inputCentroids, 'CNV1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.faceMap.values()].sort()).toEqual(['CNV1:face#0', 'CNV1:face#1', 'CNV1:face#2', 'CNV1:face#3']);
    expect(r.generated).toHaveLength(4);
    // never off-grammar (no `.dup` suffix anywhere, even in the healthy path).
    for (const id of r.generated) expect(id).toMatch(/^CNV1:face#\d+$/);
  });

  it('FAILS-IF (R1.3): two probes nearest-matching the SAME input face is refused, not silently minted as face#i.1', () => {
    // Both probes sit closest to input face #1 ([10,0,0]); no `.dup` id is
    // minted -- the pre-R1 code would have returned CNV1:face#1 and
    // CNV1:face#1.1 here (ok:true), which is exactly the off-grammar lineage
    // the stable-ID spec forbids.
    const probes = [fakeProbe([10, 0, 0], 1), fakeProbe([10.1, 0, 0], 2)];
    const r = matchProbesToInputFaces(probes, inputCentroids, 'CNV1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect('duplicateInputFaceIndex' in r).toBe(true);
    if (!('duplicateInputFaceIndex' in r)) return;
    expect(r.duplicateInputFaceIndex).toBe(1);
  });

  it('FAILS-IF (MSH-4 rider a / MSH-3-R1.audit finding 2): fewer probes than input faces is refused, not silently minted as a partial map', () => {
    // The kernel returns only 2 face probes for 4 input faces (e.g. sew
    // merged/dropped two faces). Each of the 2 probes cleanly nearest-matches
    // a DISTINCT input face -- no duplicate is triggered -- so the pre-fix
    // code fell through to `ok: true` with a faceMap covering only faces #0
    // and #1, silently dropping import-rooted lineage for #2 and #3. This
    // must now be refused as an incomplete, non-bijective match.
    const probes = [fakeProbe([0, 0, 0], 1), fakeProbe([10, 0, 0], 2)];
    const r = matchProbesToInputFaces(probes, inputCentroids, 'CNV1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect('unmatchedInputFaceIndices' in r).toBe(true);
    if (!('unmatchedInputFaceIndices' in r)) return;
    expect(r.unmatchedInputFaceIndices.slice().sort((a, b) => a - b)).toEqual([2, 3]);
    expect(r.probeCount).toBe(2);
    expect(r.expectedFaceCount).toBe(4);
  });
});

describe('makeSolidFromPlanarFaces (real occt-wasm kernel)', () => {
  let engine: GeomEngine;

  beforeAll(async () => {
    engine = new GeomEngine();
    await engine.init();
  }, 60_000);

  afterAll(async () => {
    await engine.disposeKernel();
  });

  it('#1 welded cube -> 6-face solid, volume matches mesh within 1e-6, exportStep round-trips', async () => {
    const mesh = unitCube(10);
    const meshVol = measureMesh(mesh).volume; // 1000
    const faceSet = planeSetOf(mesh, 'CNV1');
    expect(faceSet.faces).toHaveLength(6);

    const res = await engine.makeSolidFromPlanarFaces(faceSet);
    expect(res.ok).toBe(true);
    expect(res.body).toBeDefined();
    expect(res.elementMap!.generated).toHaveLength(6);
    for (const id of res.elementMap!.generated) {
      expect(id).toMatch(/^CNV1:face#\d+$/);
      expect(res.elementMap!.geometry![id]).toBeDefined();
      expect(res.elementMap!.geometry![id].surfaceType).toBe('plane');
    }

    const vol = await engine.measure(res.body!, 'volume');
    expect(Math.abs(vol.value - meshVol) / meshVol).toBeLessThan(1e-6);

    // exportStep round-trip: export -> re-import -> one body with the same volume.
    const step = await engine.exportStep([res.body!]);
    expect(step.byteLength).toBeGreaterThan(0);
    const back = await engine.importStep(step, 'RT');
    expect(back.bodies).toHaveLength(1);
    const reVol = await engine.measure(back.bodies[0].handle, 'volume');
    expect(Math.abs(reVol.value - meshVol) / meshVol).toBeLessThan(1e-6);

    await engine.dispose(res.body!);
    await engine.dispose(back.bodies[0].handle);
  }, 60_000);

  it('#2 real prismatic plate -> 14-face solid, volume matches mesh within 1e-3, confidence in diagnostics', async () => {
    const mesh = loadPlateMesh();
    const meshVol = measureMesh(mesh).volume; // 100500
    const conv = convertPrismaticMesh(mesh, { convertId: 'CNVP' });
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;
    expect(conv.report.faceCount).toBe(14);

    const res = await engine.makeSolidFromPlanarFaces(conv.faceSet);
    expect(res.ok).toBe(true);
    expect(res.elementMap!.generated).toHaveLength(14);

    const vol = await engine.measure(res.body!, 'volume');
    expect(Math.abs(vol.value - meshVol) / meshVol).toBeLessThan(1e-3);

    // confidence is carried into diagnostics (info diag with minConfidence).
    const info = res.diagnostics.find((d) => d.code === 'OK' && d.params?.minConfidence !== undefined);
    expect(info).toBeDefined();
    expect(Number(info!.params!.faceCount)).toBe(14);

    await engine.dispose(res.body!);
  }, 60_000);

  it('#5 deterministic: same input -> identical ids; shuffled mesh -> identical id set + volume', async () => {
    const faceSet = planeSetOf(unitCube(10), 'CNV1');
    const a = await engine.makeSolidFromPlanarFaces(faceSet);
    const b = await engine.makeSolidFromPlanarFaces(faceSet);
    expect(a.elementMap!.generated).toEqual(b.elementMap!.generated);
    const volA = (await engine.measure(a.body!, 'volume')).value;

    const shuffledFaceSet = planeSetOf(shuffleTriangles(unitCube(10), 99) as ReturnType<typeof unitCube>, 'CNV1');
    const c = await engine.makeSolidFromPlanarFaces(shuffledFaceSet);
    expect([...c.elementMap!.generated].sort()).toEqual([...a.elementMap!.generated].sort());
    const volC = (await engine.measure(c.body!, 'volume')).value;
    expect(Math.abs(volC - volA)).toBeLessThan(1e-6);

    await engine.dispose(a.body!);
    await engine.dispose(b.body!);
    await engine.dispose(c.body!);
  }, 60_000);

  it('#9 wasm-handle lifecycle: an open (non-solid) face set fails typed SEW_FAILED and leaks no kernel handle', async () => {
    const full = planeSetOf(unitCube(10), 'CNV1');
    // Drop one face so the boundary is open -> cannot sew a closed solid.
    const open: PlanarFaceSet = { ...full, faces: full.faces.slice(0, 5) };

    const before = engine.debugKernelShapeCount();
    const res = await engine.makeSolidFromPlanarFaces(open);
    expect(res.ok).toBe(false);
    expect(res.body).toBeUndefined();
    expect(res.diagnostics.some((d) => d.code === 'SEW_FAILED')).toBe(true);
    const after = engine.debugKernelShapeCount();
    // every edge/wire/face + the orphaned sew result must be released.
    expect(after).toBe(before);
  }, 60_000);
});
