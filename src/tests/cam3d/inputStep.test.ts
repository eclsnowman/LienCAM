// cam3d input pipeline: STEP importer tests (Node, real OCCT wasm).
//
// Harness mirrors src/tests/brep/model-core.test.ts: load the in-house OCCT
// model kernel directly with loadOcctModel({ wasmBinary }) -- no Worker --
// and drive the importer through makeOcctCoreTessellator(oc). STEP fixtures
// come from Sample Parts via the path helper (some exist only in the sibling
// main working copy).
//
// A counting tessellator wrapper makes the deflection policy and the cache
// observable without flaky timing assertions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  loadOcctModel,
  _resetOcctModelForTest,
  type OcctModelModule,
} from '../../lib/cam/geometry/occt/model/loader';
import {
  DEFAULT_TRIANGLE_BUDGET,
  _resetStepImportCacheForTest,
  getStepImportCacheStats,
  importStepToPartMesh,
  importStlToPartMesh,
  makeOcctCoreTessellator,
} from '../../cam3d/input';
import type { StepTessellationParams, StepTessellator } from '../../cam3d/input';
import type { PartImportResult } from '../../cam3d/input';
import { resolveSamplePartPath } from '../../cam3d/input/fixturePaths';

const here = dirname(fileURLToPath(import.meta.url));
// emscripten's Node branch references CJS globals (__dirname / require); the ESM test
// runtime lacks them (same shim as model-core.test.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */

const wasmPath = join(here, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm');

let oc: OcctModelModule;
let baseTessellator: StepTessellator;

/** Wrap a tessellator so tests can count calls and inspect requested params. */
function counting(base: StepTessellator): { t: StepTessellator; calls: StepTessellationParams[] } {
  const calls: StepTessellationParams[] = [];
  const t: StepTessellator = (bytes, params) => {
    calls.push({ ...params });
    return base(bytes, params);
  };
  return { t, calls };
}

function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(resolveSamplePartPath(name));
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/** PartMesh validity assertions shared across fixtures. */
function assertValidStepResult(r: PartImportResult, expectedFaceCount: number): void {
  const { positions, indices, bounds, faceIds, source } = r.mesh;
  expect(source).toBe('step');
  expect(r.triangleCount).toBe(indices.length / 3);
  expect(r.triangleCount).toBeGreaterThan(0);
  expect(r.triangleCount).toBeLessThanOrEqual(DEFAULT_TRIANGLE_BUDGET);
  expect(r.effectiveDeflectionMm).toBeGreaterThan(0);

  // No NaN/Inf; bounds match actual vertex min/max.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new Error(`non-finite position at ${i}`);
    const axis = i % 3;
    if (positions[i] < min[axis]) min[axis] = positions[i];
    if (positions[i] > max[axis]) max[axis] = positions[i];
  }
  expect(bounds.min).toEqual(min);
  expect(bounds.max).toEqual(max);

  // No degenerate triangles survive the sanity pass.
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const area =
      0.5 *
      Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (!(area > 1e-12)) throw new Error(`degenerate triangle at ${t / 3}: area=${area}`);
  }

  // D-008: one BRep face id per triangle, covering exactly the face count.
  expect(faceIds).toBeDefined();
  expect(faceIds!.length).toBe(r.triangleCount);
  let maxFaceId = 0;
  for (let i = 0; i < faceIds!.length; i++) {
    if (faceIds![i] > maxFaceId) maxFaceId = faceIds![i];
  }
  expect(maxFaceId + 1).toBe(expectedFaceCount);
}

beforeAll(async () => {
  _resetOcctModelForTest();
  oc = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
  baseTessellator = makeOcctCoreTessellator(oc);
}, 120000);

beforeEach(() => {
  _resetStepImportCacheForTest();
});

describe('STEP fixtures import to valid PartMesh', () => {
  const fixtures: Array<{ name: string; faceCount: number }> = [
    { name: 'fix_freeform.step', faceCount: 7 },
    { name: 'fix_plate_holes.step', faceCount: 12 },
    { name: 'Step Test With Holes.step', faceCount: 87 },
  ];

  it.each(fixtures)('$name', async ({ name, faceCount }) => {
    const r = await importStepToPartMesh(fixtureBytes(name), {
      camTolerance: 0.04, // -> 0.01 mm deflection: fine mesh, comfortably under budget
      tessellator: baseTessellator,
    });
    assertValidStepResult(r, faceCount);
    // eslint-disable-next-line no-console
    console.log(
      `${name}: ${r.triangleCount} triangles at effective deflection ${r.effectiveDeflectionMm} mm`,
    );
  }, 120000);
});

describe('deflection policy (D-007)', () => {
  it('camTolerance 0.01 requests linear deflection 0.0025 and angular 0.35', async () => {
    const spy = counting(baseTessellator);
    const r = await importStepToPartMesh(fixtureBytes('fix_plate_holes.step'), {
      camTolerance: 0.01,
      tessellator: spy.t,
    });
    expect(spy.calls.length).toBe(1); // under budget: no coarsening pass
    expect(spy.calls[0].linearDeflection).toBe(0.0025);
    expect(spy.calls[0].angularDeflection).toBe(0.35);
    expect(r.effectiveDeflectionMm).toBe(0.0025);
    expect(r.warnings.filter((w) => /coarsening/.test(w))).toEqual([]);
  }, 120000);

  it('a blown budget coarsens deflection, warns, and reports the effective value', async () => {
    const bytes = fixtureBytes('Step Test With Holes.step');
    // Learn the natural triangle count at camTolerance 0.01, then re-import
    // with a budget at half that: the coarsen loop MUST engage. (Overriding
    // the budget keeps the test cheap while exercising the identical loop the
    // 1.5M default uses; BRepMesh has no dry-run count prediction, so the
    // importer is tessellate-check-coarsen by design.)
    const natural = await importStepToPartMesh(bytes, {
      camTolerance: 0.01,
      tessellator: baseTessellator,
    });
    expect(natural.triangleCount).toBeGreaterThan(1000); // sanity: budget below is meaningful
    // eslint-disable-next-line no-console
    console.log(`Step Test With Holes @ 0.0025 mm: ${natural.triangleCount} triangles`);

    const budget = Math.floor(natural.triangleCount / 2);
    const spy = counting(baseTessellator);
    const r = await importStepToPartMesh(bytes, {
      camTolerance: 0.01,
      triangleBudget: budget,
      tessellator: spy.t,
    });
    expect(spy.calls.length).toBeGreaterThanOrEqual(2); // at least one coarsening retry
    expect(r.triangleCount).toBeLessThanOrEqual(budget);
    expect(r.effectiveDeflectionMm).toBeGreaterThan(0.0025);
    expect(r.warnings.some((w) => /forced coarsening/.test(w))).toBe(true);
    // eslint-disable-next-line no-console
    console.log(
      `budget ${budget}: ${r.triangleCount} triangles at effective deflection ` +
        `${r.effectiveDeflectionMm} mm after ${spy.calls.length} tessellation passes`,
    );
  }, 240000);
});

describe('tessellation cache (D-007: keyed by content hash + deflection)', () => {
  it('re-importing identical bytes + options never calls the kernel again', async () => {
    const bytes = fixtureBytes('fix_plate_holes.step');
    const spy = counting(baseTessellator);
    const opts = { camTolerance: 0.02, tessellator: spy.t };

    const r1 = await importStepToPartMesh(bytes, opts);
    const callsAfterFirst = spy.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    const r2 = await importStepToPartMesh(bytes, opts);
    expect(spy.calls.length).toBe(callsAfterFirst); // cache hit: zero new kernel calls
    expect(getStepImportCacheStats()).toMatchObject({ hits: 1, misses: 1 });
    expect(r2).toBe(r1); // same immutable result object

    // A different camTolerance is a different cache key -> kernel runs again.
    await importStepToPartMesh(bytes, { camTolerance: 0.04, tessellator: spy.t });
    expect(spy.calls.length).toBe(callsAfterFirst + 1);
    expect(getStepImportCacheStats()).toMatchObject({ hits: 1, misses: 2 });
  }, 120000);
});

describe('STL and STEP results are structurally interchangeable', () => {
  it('same field shapes; only source tag, faceIds and effectiveDeflectionMm differ', async () => {
    const step = await importStepToPartMesh(fixtureBytes('fix_freeform.step'), {
      camTolerance: 0.04,
      tessellator: baseTessellator,
    });
    const stl = await importStlToPartMesh(fixtureBytes('obj_1_Platte C.stl'));

    for (const r of [step, stl]) {
      expect(r.mesh.positions).toBeInstanceOf(Float32Array);
      expect(r.mesh.indices).toBeInstanceOf(Uint32Array);
      expect(r.mesh.bounds.min).toHaveLength(3);
      expect(r.mesh.bounds.max).toHaveLength(3);
      expect(Array.isArray(r.warnings)).toBe(true);
      expect(typeof r.triangleCount).toBe('number');
    }
    expect(step.mesh.source).toBe('step');
    expect(stl.mesh.source).toBe('stl');
    expect(step.mesh.faceIds).toBeInstanceOf(Uint32Array);
    expect(stl.mesh.faceIds).toBeUndefined();
    expect(typeof step.effectiveDeflectionMm).toBe('number');
    expect(stl.effectiveDeflectionMm).toBeUndefined();
  }, 120000);
});
