import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportBinaryStl } from '../../mesh/stl';
import { createMeshWorkerApi, type MeshWorkerApi } from '../../mesh/worker/mesh-service';
import type { MeshBuffers, MeshOperationResult, Vec3 } from '../../mesh/types';
import { binaryStlFixture, sphereApprox, unitCube } from './fixtures';

function cloneMesh(mesh: MeshBuffers): MeshBuffers {
  return { positions: new Float32Array(mesh.positions), indices: new Uint32Array(mesh.indices) };
}

function translateMesh(mesh: MeshBuffers, offset: Vec3): MeshBuffers {
  const positions = new Float32Array(mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += offset[0];
    positions[i + 1] += offset[1];
    positions[i + 2] += offset[2];
  }
  return { positions, indices: new Uint32Array(mesh.indices) };
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

function exportMesh(mesh: MeshBuffers): ArrayBuffer {
  return exportBinaryStl(mesh).bytes;
}

function expectDeterministic(left: MeshBuffers, right: MeshBuffers): void {
  expect(sameBytes(exportMesh(left), exportMesh(right))).toBe(true);
}

function capTriangleCount(mesh: MeshBuffers, z: number): number {
  let count = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    let onPlane = true;
    for (let j = 0; j < 3; j++) {
      const vertex = mesh.indices[i + j] * 3;
      onPlane = onPlane && Math.abs(mesh.positions[vertex + 2] - z) < 1e-6;
    }
    if (onPlane) count += 1;
  }
  return count;
}

describe('replayable manifold mesh operations', () => {
  let api: MeshWorkerApi;

  beforeAll(async () => {
    api = createMeshWorkerApi();
    await api.init({ requireManifold: true });
  });

  afterAll(async () => {
    await api.dispose();
  });

  it('performs watertight booleans with analytical cube volumes', async () => {
    const left = unitCube();
    const right = translateMesh(unitCube(), [0.5, 0, 0]);
    const cases = [
      ['union', 1.5],
      ['intersect', 0.5],
      ['difference', 0.5],
    ] as const;

    for (const [operation, volume] of cases) {
      const first = (await api.boolean(cloneMesh(left), cloneMesh(right), { operation })).value;
      const second = (await api.boolean(cloneMesh(left), cloneMesh(right), { operation })).value;
      expect(first.report.watertight).toBe(true);
      expect(first.measures.volume).toBeCloseTo(volume, 6);
      expectDeterministic(first.mesh, second.mesh);
    }
  });

  it('throws loudly on an unsupported boolean operation instead of returning undefined (MSH-2-R1.3)', async () => {
    await expect(
      api.boolean(unitCube(), translateMesh(unitCube(), [0.5, 0, 0]), { operation: 'xor' as unknown as 'union' }),
    ).rejects.toThrow(/unsupported boolean operation: xor/);
  });

  it('cuts a unit cube into capped watertight halves', async () => {
    const cut = (await api.planeCut(unitCube(), { normal: [0, 0, 1], offset: 0.5, keep: 'both' })).value;
    expect(cut.positive).toBeDefined();
    expect(cut.negative).toBeDefined();
    const positive = cut.positive as MeshOperationResult;
    const negative = cut.negative as MeshOperationResult;

    expect(positive.mesh.positions.buffer).not.toBe(negative.mesh.positions.buffer);
    expect(positive.report.watertight).toBe(true);
    expect(negative.report.watertight).toBe(true);
    expect(positive.measures.volume).toBeCloseTo(0.5, 6);
    expect(negative.measures.volume).toBeCloseTo(0.5, 6);
    expect(capTriangleCount(positive.mesh, 0.5)).toBeGreaterThan(0);
    expect(capTriangleCount(negative.mesh, 0.5)).toBeGreaterThan(0);

    const repeat = (await api.planeCut(unitCube(), { normal: [0, 0, 1], offset: 0.5, keep: 'positive' })).value;
    expectDeterministic(positive.mesh, (repeat.positive as MeshOperationResult).mesh);
  });

  it('hollows a cube and fails loudly when wall thickness cannot fit', async () => {
    const result = (await api.hollow(unitCube(), { thickness: 0.1 })).value;
    expect(result.report.watertight).toBe(true);
    expect(result.measures.volume).toBeCloseTo(1 - 0.8 ** 3, 2);

    const repeat = (await api.hollow(unitCube(), { thickness: 0.1 })).value;
    expectDeterministic(result.mesh, repeat.mesh);
    await expect(api.hollow(unitCube(), { thickness: 0.5 })).rejects.toThrow(/half of the minimum mesh extent/);
  });

  it('mirrors and composes transforms without losing manifold validity', async () => {
    const mirrored = (await api.mirror(unitCube(), { normal: [1, 0, 0] })).value;
    expect(mirrored.report.watertight).toBe(true);
    expect(mirrored.measures.volume).toBeCloseTo(1, 6);
    // MSH-2-R1.2: `volume` is Math.abs()'d and cannot catch a winding
    // inversion; assert the real (signed) orientation is outward-positive so
    // a mirror regression that flips normals inward actually fails this test.
    expect(mirrored.measures.signedVolume).toBeGreaterThan(0);
    expect(mirrored.measures.signedVolume).toBeCloseTo(1, 6);

    let current = unitCube();
    for (let i = 0; i < 4; i++) current = (await api.transform(current, { rotateDegrees: [0, 0, 90] })).value.mesh;
    const rotatedMeasures = await api.measure(current);
    expect(rotatedMeasures.volume).toBeCloseTo(1, 6);
    expect(rotatedMeasures.signedVolume).toBeGreaterThan(0);
    expect(rotatedMeasures.signedVolume).toBeCloseTo(1, 6);
    expect(rotatedMeasures.bbox.min[0]).toBeCloseTo(0, 6);
    expect(rotatedMeasures.bbox.min[1]).toBeCloseTo(0, 6);
    expect(rotatedMeasures.bbox.max[0]).toBeCloseTo(1, 6);
    expect(rotatedMeasures.bbox.max[1]).toBeCloseTo(1, 6);

    let repeatCurrent = unitCube();
    for (let i = 0; i < 4; i++) repeatCurrent = (await api.transform(repeatCurrent, { rotateDegrees: [0, 0, 90] })).value.mesh;
    expectDeterministic(current, repeatCurrent);

    const repeat = (await api.mirror(unitCube(), { normal: [1, 0, 0] })).value;
    expectDeterministic(mirrored.mesh, repeat.mesh);
  });

  it('decimates a 100k triangle sphere near a 10k target deterministically', async () => {
    const sphere = sphereApprox(1, 320, 158);
    expect(sphere.indices.length / 3).toBeGreaterThan(100000);

    const first = (await api.decimate(cloneMesh(sphere), { targetTriangleCount: 10000 })).value;
    const second = (await api.decimate(cloneMesh(sphere), { targetTriangleCount: 10000 })).value;
    const triangleCount = first.mesh.indices.length / 3;

    expect(Math.abs(triangleCount - 10000) / 10000).toBeLessThanOrEqual(0.1);
    expect(Math.abs(first.measures.volume - 4.188107081668595) / 4.188107081668595).toBeLessThanOrEqual(0.02);
    expect(first.report.watertight).toBe(true);
    expectDeterministic(first.mesh, second.mesh);
  }, 30000);

  it('replays a six operation mesh chain byte-identically from the same STL', async () => {
    async function replay(): Promise<ArrayBuffer> {
      const imported = (await api.importStl(binaryStlFixture())).value.mesh;
      const moved = (await api.transform(imported, JSON.parse(JSON.stringify({ translate: [0.25, 0, 0] })))).value.mesh;
      const mirrored = (await api.mirror(moved, JSON.parse(JSON.stringify({ normal: [1, 0, 0] })))).value.mesh;
      const cut = (await api.planeCut(mirrored, JSON.parse(JSON.stringify({ normal: [0, 0, 1], offset: 0.2, keep: 'positive' })))).value;
      const hollowed = (await api.hollow((cut.positive as MeshOperationResult).mesh, JSON.parse(JSON.stringify({ thickness: 0.05 })))).value.mesh;
      const decimated = (await api.decimate(hollowed, JSON.parse(JSON.stringify({ tolerance: 0 })))).value.mesh;
      const unioned = (await api.boolean(decimated, unitCube(), JSON.parse(JSON.stringify({ operation: 'union' })))).value.mesh;
      return exportMesh(unioned);
    }

    expect(sameBytes(await replay(), await replay())).toBe(true);
  });
});
