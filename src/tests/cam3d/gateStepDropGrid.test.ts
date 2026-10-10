// Gate P1 integration test: STEP fixture -> tessellated PartMesh ->
// BvhKernel.dropGrid. Proves the input pipeline and the drop kernel COMPOSE:
// a real imported mesh uploads, both cutter kinds drop over its full XY
// bounds, and the results obey the kernel's own contracts (finite, seeded
// floor, bounded by the mesh top, no gouging vs an independent vertical
// raycast) deterministically across fresh import + kernel instances.
//
// Harness mirrors inputStep.test.ts (real OCCT wasm, no Worker, fixtures via
// resolveSamplePartPath -- which FAILS LOUD listing both probed paths when a
// fixture is absent; that is the established missing-fixture policy).
//
// camTolerance: step.ts has NO default (it is a required option); this gate
// uses 0.04 mm -> 0.01 mm deflection, the same value inputStep.test.ts uses
// for these exact fixtures ("fine mesh, comfortably under budget").
//
// Timing is logged via process.cpuUsage for the digest only -- this is an
// integration gate, not a perf test, so nothing is asserted on time.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadOcctModel,
  _resetOcctModelForTest,
  type OcctModelModule,
} from '../../lib/cam/geometry/occt/model/loader';
import {
  _resetStepImportCacheForTest,
  importStepToPartMesh,
  makeOcctCoreTessellator,
} from '../../cam3d/input';
import type { PartImportResult, StepTessellator } from '../../cam3d/input';
import { resolveSamplePartPath } from '../../cam3d/input/fixturePaths';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { GridSpec, PartMesh } from '../../cam3d/kernel/types';

const here = dirname(fileURLToPath(import.meta.url));
// emscripten's Node branch references CJS globals (__dirname / require); the ESM test
// runtime lacks them (same shim as inputStep.test.ts / model-core.test.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).require ??= createRequire(import.meta.url);
(globalThis as any).__dirname ??= here;
(globalThis as any).__filename ??= fileURLToPath(import.meta.url);
/* eslint-enable @typescript-eslint/no-explicit-any */

const wasmPath = join(here, '../../lib/cam/geometry/occt/model/vendor/occt-model.wasm');

const CAM_TOLERANCE = 0.04; // -> 0.01 mm deflection (see header)
const GRID_N = 64; // 64x64: modest, full-suite-friendly
const D6 = { diameter: 6 } as const;
/**
 * Upper-bound slack: a drop tip can never exceed the touched triangle's max
 * vertex z (flat: the tip IS a supported surface z; ball: tip = contact z -
 * R*(1 - n.z) <= contact z), and bounds.max[2] is the max over the same f32
 * vertices, so z <= meshMaxZ up to f64 plane-interpolation roundoff only.
 */
const EPS_TOP = 1e-6;
/** Gouge-side slack vs the independent raycast (same f32->f64 verts, f64 math). */
const EPS_GOUGE = 1e-6;

let oc: OcctModelModule;
let baseTessellator: StepTessellator;

beforeAll(async () => {
  _resetOcctModelForTest();
  oc = await loadOcctModel({ wasmBinary: readFileSync(wasmPath) });
  baseTessellator = makeOcctCoreTessellator(oc);
}, 120000);

function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(resolveSamplePartPath(name));
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

/** Fresh import: cache reset first so run 2 re-executes the real pipeline. */
async function importFresh(name: string): Promise<PartImportResult> {
  _resetStepImportCacheForTest();
  return importStepToPartMesh(fixtureBytes(name), {
    camTolerance: CAM_TOLERANCE,
    tessellator: baseTessellator,
  });
}

/** 64x64 grid spanning the mesh XY bounds; zSeed well below the part. */
function gridOver(mesh: PartMesh): GridSpec {
  const { min, max } = mesh.bounds;
  return {
    x0: min[0],
    y0: min[1],
    nx: GRID_N,
    ny: GRID_N,
    dx: (max[0] - min[0]) / (GRID_N - 1),
    dy: (max[1] - min[1]) / (GRID_N - 1),
    zSeed: min[2] - 5,
  };
}

/** Upload -> dropGrid -> release on a FRESH kernel; returns z + cpu ms. */
async function runDrop(
  mesh: PartMesh,
  kind: 'flat' | 'ball',
  g: GridSpec,
): Promise<{ z: Float64Array; cpuMs: number }> {
  const kernel = new BvhKernel();
  const m = kernel.uploadMesh(mesh);
  const c = kernel.makeCutter({ kind, ...D6 });
  try {
    const cpu0 = process.cpuUsage();
    const z = await kernel.dropGrid(m, c, g);
    const cpu = process.cpuUsage(cpu0);
    return { z, cpuMs: (cpu.user + cpu.system) / 1000 };
  } finally {
    kernel.releaseCutter(c);
    kernel.releaseMesh(m);
  }
}

/**
 * Independent gouge-side reference: vertical raycast against EVERY triangle
 * (no BVH, no cell index, no dropCutter math). Returns the highest surface z
 * whose xy projection contains (x, y), or -Infinity when uncovered (hole /
 * outside the solid). Both cutters' bottoms pass through the axis point
 * (flat disk at tip z; ball lowest point at tip z), so a non-gouging tip
 * must satisfy tip >= this value wherever it is finite.
 */
function raycastSurfaceZ(mesh: PartMesh, x: number, y: number): number {
  const pos = mesh.positions;
  const idx = mesh.indices;
  let bestZ = -Infinity;
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t] * 3;
    const ib = idx[t + 1] * 3;
    const ic = idx[t + 2] * 3;
    const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
    const bx = pos[ib], by = pos[ib + 1], bz = pos[ib + 2];
    const cx = pos[ic], cy = pos[ic + 1], cz = pos[ic + 2];
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); // 2 * signed 2D area
    if (Math.abs(d) < 1e-12) continue; // vertical / degenerate in projection
    const u = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / d;
    const v = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / d;
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
    const z = az + u * (bz - az) + v * (cz - az);
    if (z > bestZ) bestZ = z;
  }
  return bestZ;
}

/** Byte-identity across two Float64Array results (compares raw buffers). */
function assertByteIdentical(a: Float64Array, b: Float64Array, label: string): void {
  expect(b.byteLength).toBe(a.byteLength);
  const ba = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < ba.length; i++) {
    if (ba[i] !== bb[i]) {
      const j = Math.floor(i / 8);
      throw new Error(`${label}: buffers differ at byte ${i} (sample ${j}: ${a[j]} vs ${b[j]})`);
    }
  }
}

describe('Gate P1: STEP -> PartMesh -> BvhKernel.dropGrid compose', () => {
  const fixtures = ['fix_freeform.step', 'fix_plate_holes.step'];

  it.each(fixtures)(
    '%s',
    async (name) => {
      // ---- Run 1: import + drop both cutters ----
      const r1 = await importFresh(name);
      const mesh = r1.mesh;
      expect(mesh.source).toBe('step');
      expect(r1.triangleCount).toBeGreaterThan(0);
      const [minZ, maxZ] = [mesh.bounds.min[2], mesh.bounds.max[2]];
      const g = gridOver(mesh);
      const flat1 = await runDrop(mesh, 'flat', g);
      const ball1 = await runDrop(mesh, 'ball', g);

      // ---- Sanity: finite, floored at zSeed, capped by the mesh top ----
      for (const [kind, z] of [['flat', flat1.z], ['ball', ball1.z]] as const) {
        expect(z.length).toBe(g.nx * g.ny);
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < z.length; i++) {
          const v = z[i];
          if (!Number.isFinite(v)) throw new Error(`${kind}[${i}] non-finite: ${v}`);
          if (v < g.zSeed) throw new Error(`${kind}[${i}] = ${v} below zSeed ${g.zSeed}`);
          if (v > maxZ + EPS_TOP) throw new Error(`${kind}[${i}] = ${v} above mesh top ${maxZ}`);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        // The grid spans the part: at least some samples must actually
        // contact (a gate where everything missed would prove nothing).
        expect(hi).toBeGreaterThan(g.zSeed);
        console.log(`${name} ${kind}: z in [${lo.toFixed(4)}, ${hi.toFixed(4)}], cpu ${
          (kind === 'flat' ? flat1 : ball1).cpuMs.toFixed(0)} ms`);
      }

      // ---- Gouge-side cross-check vs the independent raycast ----
      // Sampled subset (stride 31 -> 133 of 4096 points) keeps the O(points
      // x triangles) brute force cheap. tip >= surface z at the axis holds
      // for BOTH cutter kinds (see raycastSurfaceZ doc).
      let covered = 0;
      let maxDeficit = -Infinity; // most negative margin observed (should stay > -EPS_GOUGE)
      for (let i = 0; i < flat1.z.length; i += 31) {
        const ix = i % g.nx;
        const iy = Math.floor(i / g.nx);
        const surf = raycastSurfaceZ(mesh, g.x0 + ix * g.dx, g.y0 + iy * g.dy);
        if (!Number.isFinite(surf)) continue; // hole or outside the solid
        covered++;
        for (const [kind, z] of [['flat', flat1.z], ['ball', ball1.z]] as const) {
          const margin = z[i] - surf;
          if (margin < -EPS_GOUGE) {
            throw new Error(
              `${name} ${kind} gouges at (${ix}, ${iy}): tip ${z[i]} < surface ${surf}`,
            );
          }
          maxDeficit = Math.max(maxDeficit, -margin);
        }
      }
      expect(covered).toBeGreaterThan(40); // the check must have teeth
      console.log(
        `${name}: ${r1.triangleCount} tris, gouge check on ${covered} covered samples, ` +
          `worst margin ${maxDeficit <= 0 ? '>= 0' : `-${maxDeficit.toExponential(3)}`}, ` +
          `z range [${minZ.toFixed(4)}, ${maxZ.toFixed(4)}]`,
      );

      // ---- Cutter relation: same footprint disk, so ball tip = max over
      // contacts of cp.z + sqrt(R^2-d^2) - R <= max(cp.z) = flat tip;
      // misses are equal (both return zSeed). ----
      for (let i = 0; i < flat1.z.length; i++) {
        if (ball1.z[i] > flat1.z[i] + 1e-9) {
          throw new Error(`${name}: ball[${i}] = ${ball1.z[i]} > flat ${flat1.z[i]}`);
        }
      }

      // ---- Determinism: fresh import (cache reset) + fresh kernels ----
      const r2 = await importFresh(name);
      expect(r2).not.toBe(r1); // cache reset really forced a re-import
      expect(r2.triangleCount).toBe(r1.triangleCount);
      expect(r2.mesh.bounds).toEqual(mesh.bounds);
      expect(r2.mesh.positions.length).toBe(mesh.positions.length);
      for (let i = 0; i < mesh.positions.length; i++) {
        if (!Object.is(mesh.positions[i], r2.mesh.positions[i])) {
          throw new Error(`${name}: re-import position[${i}] differs`);
        }
      }
      const flat2 = await runDrop(r2.mesh, 'flat', gridOver(r2.mesh));
      const ball2 = await runDrop(r2.mesh, 'ball', gridOver(r2.mesh));
      assertByteIdentical(flat1.z, flat2.z, `${name} flat dropGrid`);
      assertByteIdentical(ball1.z, ball2.z, `${name} ball dropGrid`);
    },
    240000,
  );
});
