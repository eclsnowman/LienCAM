// WO-1176: the opencamlib adapter against the REAL wasm build.
//
// The package's `main` points at a native Node addon that is not shipped and
// its `browser` build refuses to start without a `window` (emscripten's
// environment check). Both are facts about the package, not about the app:
// the app loads the browser build inside a Web Worker, where the check
// passes because `importScripts` exists. Here the emscripten build is loaded
// directly with a `window` shim so the SAME wasm the browser runs is what
// this test measures -- a control (LIENCAM.md rule 6), never application
// truth; the in-app capture under src/tests/evidence/WO-1176/ is that.

import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import type { PartMesh } from '../../cam3d/kernel/types';
import {
  canonicalLoop, createOclWaterlineSlicer, sortLoops, waterlineSamplingFor,
  type OclWaterlineModule,
} from '../../cam3d/kernel/oclWaterline';

const g = globalThis as { window?: unknown };
let hadWindow = false;
beforeAll(() => {
  hadWindow = 'window' in g;
  if (!hadWindow) g.window = globalThis;
});
afterAll(() => {
  if (!hadWindow) delete g.window;
});

const require = createRequire(import.meta.url);
const loadEmscripten = async (): Promise<OclWaterlineModule> =>
  require('@opencamlib/opencamlib/lib/emscripten/index.js') as OclWaterlineModule;

/** A 20 x 20 x 10 box on a 40 x 40 x 2 slab (box from z 2 to 12). */
function boxOnSlab(): PartMesh {
  const b = new MeshBuilder();
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const v = (x: number, y: number, z: number) => b.vertex(x, y, z);
    const a00 = v(x0, y0, z0), a10 = v(x1, y0, z0), a11 = v(x1, y1, z0), a01 = v(x0, y1, z0);
    const t00 = v(x0, y0, z1), t10 = v(x1, y0, z1), t11 = v(x1, y1, z1), t01 = v(x0, y1, z1);
    b.quad(a00, a01, a11, a10);
    b.quad(t00, t10, t11, t01);
    b.quad(a00, a10, t10, t00);
    b.quad(a10, a11, t11, t10);
    b.quad(a11, a01, t01, t11);
    b.quad(a01, a00, t00, t01);
  };
  box(10, 10, 2, 30, 30, 12);
  box(0, 0, 0, 40, 40, 2);
  return b.build();
}

function bounds(ring: Float64Array) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
    minY = Math.min(minY, ring[i + 1]); maxY = Math.max(maxY, ring[i + 1]);
  }
  return { minX, maxX, minY, maxY };
}

describe('canonicalLoop / sortLoops', () => {
  it('rotates to the smallest vertex, drops repeats and the closing vertex, rejects degenerates', () => {
    const ring = canonicalLoop([[5, 5, 1], [0, 0, 1], [0, 0, 1], [10, 0, 1], [5, 5, 1]]);
    expect(ring).not.toBeNull();
    expect(Array.from(ring!)).toEqual([0, 0, 10, 0, 5, 5]);
    expect(canonicalLoop([[0, 0, 1], [0, 0, 1]])).toBeNull();
    expect(canonicalLoop([[0, 0, 1], [0, 5, 1], [0, 9, 1]])).toBeNull(); // zero x extent
  });
  it('sorts loops by their first vertex', () => {
    const a = new Float64Array([5, 0, 6, 0, 6, 1]);
    const b = new Float64Array([1, 0, 2, 0, 2, 1]);
    expect(sortLoops([a, b])[0]).toBe(b);
  });
});

describe('createOclWaterlineSlicer with the real wasm build', () => {
  const mesh = boxOnSlab();
  const ball4 = { kind: 'ball' as const, diameter: 4 };
  const sampling = waterlineSamplingFor(0.05);

  it('returns one loop per level, offset by the cutter radius, canonically ordered, three levels in a row', async () => {
    const slicer = createOclWaterlineSlicer({ load: loadEmscripten });
    for (const z of [11, 6, 2.5]) {
      const loops = await slicer.slice(mesh, ball4, z, sampling);
      expect(loops).toHaveLength(1);
      const b = bounds(loops[0]);
      // A 4 mm ball at a vertical wall sits 2 mm off it (plus the adaptive grid's resolution).
      expect(b.minX).toBeCloseTo(8, 0);
      expect(b.maxX).toBeCloseTo(32, 0);
      expect(b.minY).toBeCloseTo(8, 0);
      expect(b.maxY).toBeCloseTo(32, 0);
      // Canonical start: the lexicographically smallest vertex comes first.
      for (let i = 2; i < loops[0].length; i += 2) {
        const smaller = loops[0][i] < loops[0][0] || (loops[0][i] === loops[0][0] && loops[0][i + 1] < loops[0][1]);
        expect(smaller).toBe(false);
      }
    }
  }, 60_000);

  it('gives no loop above the part and the slab outline below the box', async () => {
    const slicer = createOclWaterlineSlicer({ load: loadEmscripten });
    expect(await slicer.slice(mesh, ball4, 13, sampling)).toHaveLength(0);
    const slab = await slicer.slice(mesh, ball4, 1, sampling);
    expect(slab).toHaveLength(1);
    expect(bounds(slab[0]).maxX).toBeCloseTo(42, 0);
  }, 60_000);

  it('is byte-identical across two slices of the same level (D-006)', async () => {
    const slicer = createOclWaterlineSlicer({ load: loadEmscripten });
    const a = await slicer.slice(mesh, ball4, 6, sampling);
    const b = await slicer.slice(mesh, ball4, 6, sampling);
    expect(a.map((r) => Array.from(r))).toEqual(b.map((r) => Array.from(r)));
  }, 60_000);

  it('describes flat and bull cutters to the library and refuses a V-bit by name', async () => {
    const slicer = createOclWaterlineSlicer({ load: loadEmscripten });
    const flat = await slicer.slice(mesh, { kind: 'flat', diameter: 6 }, 6, sampling);
    expect(bounds(flat[0]).minX).toBeCloseTo(7, 0);
    const bull = await slicer.slice(mesh, { kind: 'bull', diameter: 6, cornerRadius: 1 }, 6, sampling);
    expect(bounds(bull[0]).minX).toBeCloseTo(7, 0);
    await expect(slicer.slice(mesh, { kind: 'vbit', diameter: 6, angleFromAxisDeg: 45 }, 6, sampling))
      .rejects.toThrow(/V-bit/);
  }, 60_000);
});

describe('createOclWaterlineSlicer poison handling', () => {
  it('names a memory abort, and refuses every later call until restarted', async () => {
    const fake: OclWaterlineModule = {
      AdaptiveWaterline: class {
        chain = Promise.resolve();
        setSTL() {}
        setCutter() {}
        setSampling() {}
        setMinSampling() {}
        setZ() {}
        run() {
          throw new Error('Cannot enlarge memory, asked to go up to 2147487744 bytes, but the limit is 2147483648 bytes!');
        }
        async getLoops() { return []; }
      },
      STLSurf: class { triangles?: number[][][]; },
      CylCutter: class { constructor(_d: number, _l: number) {} },
      BallCutter: class { constructor(_d: number, _l: number) {} },
      BullCutter: class { constructor(_d: number, _r: number, _l: number) {} },
    };
    const slicer = createOclWaterlineSlicer({ load: async () => fake });
    const mesh = boxOnSlab();
    await expect(slicer.slice(mesh, { kind: 'flat', diameter: 6 }, 6, waterlineSamplingFor(0.05)))
      .rejects.toMatchObject({ name: 'OclModulePoisoned' });
    await expect(slicer.slice(mesh, { kind: 'flat', diameter: 6 }, 5, waterlineSamplingFor(0.05)))
      .rejects.toThrow(/aborted earlier/);
  });
});
