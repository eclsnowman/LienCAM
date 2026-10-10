import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { debugLiveHandleCount } from '../../mesh/manifoldOps';
import { createMeshWorkerApi, type MeshWorkerApi } from '../../mesh/worker/mesh-service';
import type { MeshBuffers, Vec3 } from '../../mesh/types';
import { sphereApprox, unitCube } from './fixtures';

// MSH-2-R1.1: manifold-3d Manifold instances are embind wasm-backed and MUST
// be explicitly .delete()'d -- there is no GC for the wasm heap. The base
// MSH-2 implementation disposed nothing (audit MAJOR finding); this soak test
// asserts the fix's leak-observable invariant: debugLiveHandleCount() (the
// module-level tracked-solid count in src/mesh/manifoldOps.ts) must return to
// its pre-op baseline of 0 after EVERY op, across a sustained run of mixed
// ops sharing one worker (one ManifoldKernel / one manifold-3d module
// instance) lifetime -- exactly the "long-lived worker replaying op chains"
// scenario the audit warned would grow the wasm heap unbounded.
//
// FAILS-IF (recorded in coordination/reports/MSH-2-R1.report.json): removing
// any single `mint()`/`solid.delete()` site in manifoldOps.ts makes this test
// fail on the very next op of that kind, because the leaked solid stays in
// `liveHandles` forever (it is never released) and every subsequent
// assertion in the loop trips.
function translateMesh(mesh: MeshBuffers, offset: Vec3): MeshBuffers {
  const positions = new Float32Array(mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += offset[0];
    positions[i + 1] += offset[1];
    positions[i + 2] += offset[2];
  }
  return { positions, indices: new Uint32Array(mesh.indices) };
}

describe('manifold-3d wasm handle disposal (MSH-2-R1.1 soak)', () => {
  let api: MeshWorkerApi;

  beforeAll(async () => {
    api = createMeshWorkerApi();
    await api.init({ requireManifold: true });
  }, 30000);

  afterAll(async () => {
    await api.dispose();
  });

  it('never leaks a manifold-3d wasm handle across >= 200 mixed ops in one worker lifetime', async () => {
    expect(debugLiveHandleCount()).toBe(0);

    const cubeA = unitCube();
    const cubeB = translateMesh(unitCube(), [0.5, 0, 0]);
    const sphere = sphereApprox(1, 24, 12);
    const sphereTarget = Math.max(20, Math.floor(sphere.indices.length / 3 / 2));

    // One "cycle" touches every op family the audit called out by name:
    // boolean/planeCut/hollow-small/mirror/transform/decimate-small. The two
    // planeCut variants specifically cover BOTH the "keep both" path (two
    // extracted results) and the "keep one, discard the other split half"
    // path -- the discarded half was exactly the kind of solid that leaked
    // pre-fix.
    const cycle: Array<() => Promise<unknown>> = [
      () => api.boolean(cubeA, cubeB, { operation: 'union' }),
      () => api.boolean(cubeA, cubeB, { operation: 'difference' }),
      () => api.boolean(cubeA, cubeB, { operation: 'intersect' }),
      () => api.planeCut(unitCube(), { normal: [0, 0, 1], offset: 0.5, keep: 'both' }),
      () => api.planeCut(unitCube(), { normal: [0, 0, 1], offset: 0.3, keep: 'positive' }),
      () => api.hollow(unitCube(), { thickness: 0.1 }),
      () => api.mirror(unitCube(), { normal: [1, 0, 0] }),
      () => api.transform(unitCube(), { rotateDegrees: [0, 0, 45], translate: [0.1, 0.2, 0.3], scale: 1.5 }),
      () => api.decimate(sphere, { targetTriangleCount: sphereTarget }),
    ];

    const totalOps = cycle.length * 24; // 216, >= 200 required by MSH-2-R1.1 acceptance
    expect(totalOps).toBeGreaterThanOrEqual(200);

    for (let i = 0; i < totalOps; i++) {
      const op = cycle[i % cycle.length];
      await op();
      // Leak-observable invariant: after every single op the tracked-handle
      // count must be back at the pre-op baseline (0). A leaked solid from
      // ANY op in the cycle trips this on the very next iteration.
      expect(debugLiveHandleCount()).toBe(0);
    }
  }, 60000);
});
