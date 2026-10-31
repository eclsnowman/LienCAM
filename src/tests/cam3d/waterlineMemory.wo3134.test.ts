// WO-3134: every Waterline level owns one Emscripten AdaptiveWaterline.  The
// wrapper copies its loops into JavaScript, so the underlying WASM operation
// must be released before the next level begins.  Otherwise default-height
// jobs accumulate one complete OCL operation per Z level until the 2 GB module
// aborts.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { typedMock } from '../support/typedMock';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import {
  createOclWaterlineSlicer, waterlineSamplingFor, type OclWaterlineModule,
} from '../../cam3d/kernel/oclWaterline';

function boxMesh() {
  const b = new MeshBuilder();
  const v = (x: number, y: number, z: number) => b.vertex(x, y, z);
  const a = v(0, 0, 0), b0 = v(20, 0, 0), c = v(20, 20, 0), d = v(0, 20, 0);
  const e = v(0, 0, 10), f = v(20, 0, 10), g = v(20, 20, 10), h = v(0, 20, 10);
  b.quad(a, d, c, b0); b.quad(e, f, g, h);
  b.quad(a, b0, f, e); b.quad(b0, c, g, f); b.quad(c, d, h, g); b.quad(d, a, e, h);
  return b.build();
}

describe('WO-3134 waterline OCL operation lifetime', () => {
  it('releases every completed level after copying its loops, and later levels remain valid', async () => {
    let disposed = 0;
    const fake: OclWaterlineModule = {
      AdaptiveWaterline: class {
        chain = Promise.resolve();
        actualClass = { delete: () => { disposed++; } };
        setSTL() {}
        setCutter() {}
        setSampling() {}
        setMinSampling() {}
        setZ() {}
        run() {}
        async getLoops() { return [[[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]]]; }
      },
      STLSurf: class { triangles?: number[][][]; },
      CylCutter: class { constructor(_d: number, _l: number) {} },
      BallCutter: class { constructor(_d: number, _l: number) {} },
      BullCutter: class { constructor(_d: number, _r: number, _l: number) {} },
    };
    const slicer = createOclWaterlineSlicer({ load: async () => fake });
    const mesh = boxMesh();
    const sampling = waterlineSamplingFor(0.05);

    const first = await slicer.slice(mesh, { kind: 'ball', diameter: 6 }, 8, sampling);
    const second = await slicer.slice(mesh, { kind: 'ball', diameter: 6 }, 7, sampling);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(disposed).toBe(2);
  });
});

// The legacy package and the production factory use the SAME real shipped
// native module here. On old source the legacy wrapper leaks these handles;
// on final source the owned adapter releases them. No fake allocator oracle.
const nativeRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let native: any; // Embind's generated module has no declarations.
let legacy: typeof import('@opencamlib/opencamlib');
const live: Record<string, number> = {};
const allocations: Record<string, number> = {};
let failPointCopy = false;
let failTriangleCopy = false;
let failRun: string | null = null;
let failOperationDelete = false;
const destructions: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function track(handle: any, name: string) {
  live[name] = (live[name] ?? 0) + 1;
  allocations[name] = (allocations[name] ?? 0) + 1;
  const destroy = handle.delete;
  let deleted = false;
  handle.delete = function () {
    if (deleted) throw new Error(`double deletion: ${name}`);
    destroy.call(this);
    deleted = true;
    live[name]--;
    destructions.push(name);
    if (name === 'AdaptiveWaterline' && failOperationDelete) throw new Error('WO-3134 injected cleanup error');
  };
  if (name === 'outerVector' || name === 'innerVector') {
    const get = handle.get;
    handle.get = function (index: number) {
      const returned = name === 'outerVector' ? 'innerVector' : 'resultPoint';
      const value = track(get.call(this, index), returned);
      if (returned === 'resultPoint' && failPointCopy) {
        Object.defineProperty(value, 'x', { get() { throw new Error('WO-3134 injected result copy failure'); } });
      }
      return value;
    };
  }
  return handle;
}
vi.mock('@opencamlib/opencamlib', () => typedMock<typeof import('@opencamlib/opencamlib')>(legacy));
vi.mock('@opencamlib/opencamlib/build/ocl.js', () => typedMock<typeof import('@opencamlib/opencamlib/build/ocl.js')>({ default: async () => native }));

beforeAll(async () => {
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) (globalThis as { window?: unknown }).window = globalThis;
  try {
    legacy = nativeRequire('@opencamlib/opencamlib/lib/emscripten/index.js');
    native = await nativeRequire('@opencamlib/opencamlib/lib/emscripten/ocl.js').default;
  } finally {
    if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  }
  for (const name of ['AdaptiveWaterline', 'STLSurf', 'Point', 'Triangle', 'CylCutter', 'BallCutter', 'BullCutter']) {
    native[name] = new Proxy(native[name], {
      construct(target, args) { return track(Reflect.construct(target, args), name); },
    });
  }
  const surfaceAdd = native.STLSurf.prototype.addTriangle;
  native.STLSurf.prototype.addTriangle = function (triangle: unknown) {
    if (failTriangleCopy) throw new Error('WO-3134 injected triangle copy failure');
    return surfaceAdd.call(this, triangle);
  };
  const run = native.AdaptiveWaterline.prototype.run;
  native.AdaptiveWaterline.prototype.run = function () {
    if (failRun !== null) throw new Error(failRun);
    return run.call(this);
  };
  const getLoops = native.AdaptiveWaterline.prototype.getLoops;
  native.AdaptiveWaterline.prototype.getLoops = function () {
    return track(getLoops.call(this), 'outerVector');
  };

});

function nativeSnapshot() { return { ...live }; }
function expectReleased(before: Record<string, number>) {
  for (const name of Object.keys(live)) expect(live[name] - (before[name] ?? 0), `unreleased native ${name}`).toBe(0);
}

describe('WO-3134 real shipped-native ownership', () => {
  const mesh = boxMesh();
  const sampling = waterlineSamplingFor(0.05);
  const ball = { kind: 'ball' as const, diameter: 6 };

  it('releases independent inputs and result handles and preserves copied loops across jobs and slicers', async () => {
    const before = nativeSnapshot();
    const slicer = createOclWaterlineSlicer({ loadNative: async () => native });
    const first = await slicer.slice(mesh, ball, 8, sampling);
    const saved = first.map(ring => Array.from(ring));
    const repeated = await createOclWaterlineSlicer({ loadNative: async () => native }).slice(mesh, ball, 8, sampling);
    await slicer.slice(mesh, { kind: 'flat', diameter: 6 }, 7, sampling);
    await slicer.slice(mesh, { kind: 'bull', diameter: 6, cornerRadius: 1 }, 6, sampling);
    expect(first).toHaveLength(1);
    expect(first.map(ring => Array.from(ring))).toEqual(saved);
    expect(repeated.map(ring => Array.from(ring))).toEqual(saved);
    for (const name of ['AdaptiveWaterline', 'STLSurf', 'Point', 'Triangle', 'BallCutter', 'CylCutter', 'BullCutter', 'outerVector', 'innerVector', 'resultPoint']) {
      expect(allocations[name], `real allocation exercised: ${name}`).toBeGreaterThan(0);
    }
    expectReleased(before);
    const lastOp = destructions.lastIndexOf('AdaptiveWaterline');
    expect(destructions.lastIndexOf('STLSurf')).toBeGreaterThan(lastOp);
    expect(destructions.lastIndexOf('BullCutter')).toBeGreaterThan(lastOp);
  }, 60_000);

  it('cleans partially built triangles and recovers on a later level', async () => {
    const before = nativeSnapshot();
    const slicer = createOclWaterlineSlicer({ loadNative: async () => native });
    failTriangleCopy = true;
    try { await expect(slicer.slice(mesh, ball, 8, sampling)).rejects.toThrow('injected triangle copy failure'); }
    finally { failTriangleCopy = false; }
    expectReleased(before);
    expect(await slicer.slice(mesh, ball, 7, sampling)).toHaveLength(1);
    expectReleased(before);
  }, 60_000);

  it('cleans partial copied results and preserves subsequent output', async () => {
    const before = nativeSnapshot();
    const slicer = createOclWaterlineSlicer({ loadNative: async () => native });
    failPointCopy = true;
    try { await expect(slicer.slice(mesh, ball, 8, sampling)).rejects.toThrow('injected result copy failure'); }
    finally { failPointCopy = false; }
    expectReleased(before);
    expect(await slicer.slice(mesh, ball, 8, sampling)).toHaveLength(1);
    expectReleased(before);
  }, 60_000);

  it('releases inputs on a native run error and retains poisoned-slicer recovery policy', async () => {
    const before = nativeSnapshot();
    const slicer = createOclWaterlineSlicer({ loadNative: async () => native });
    failRun = 'Aborted(WO-3134 injected native error; no real module abort)';
    failOperationDelete = true;
    try { await expect(slicer.slice(mesh, ball, 8, sampling)).rejects.toMatchObject({ name: 'OclModulePoisoned' }); }
    finally { failRun = null; failOperationDelete = false; }
    expectReleased(before);
    await expect(slicer.slice(mesh, ball, 7, sampling)).rejects.toThrow('aborted earlier');
    expect(await createOclWaterlineSlicer({ loadNative: async () => native }).slice(mesh, ball, 7, sampling)).toHaveLength(1);
    expectReleased(before);
  }, 60_000);
});

// This must use the actual published factory selection, with no window shim,
// mock module, injected allocator or substitute planning result.
describe('WO-3134 supported Node runtime', () => {
  it('slices and repeats through the unmocked default loader with no DOM', async () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    vi.doUnmock('@opencamlib/opencamlib');
    vi.doUnmock('@opencamlib/opencamlib/build/ocl.js');
    vi.resetModules();
    const actual = await import('../../cam3d/kernel/oclWaterline');
    const mesh = boxMesh();
    const sampling = actual.waterlineSamplingFor(0.05);
    const slicer = actual.createOclWaterlineSlicer();
    const first = await slicer.slice(mesh, { kind: 'ball', diameter: 6 }, 8, sampling);
    const repeated = await actual.createOclWaterlineSlicer().slice(mesh, { kind: 'ball', diameter: 6 }, 8, sampling);
    expect(first).toHaveLength(1);
    expect(repeated.map(ring => Array.from(ring))).toEqual(first.map(ring => Array.from(ring)));
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    // Vite supplies named CJS interop that a direct Node import does not.
    // Execute the same production source with Node's type stripper as well.
    const direct = execFileSync(process.execPath, [
      '--experimental-strip-types', '--loader', './src/tests/evidence/WO-3134/node-ts-resolve.mjs',
      'src/tests/evidence/WO-3134/node-runtime-probe.mjs',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(JSON.parse(direct)).toMatchObject({ dom: false, injectedModule: false, loops: 1, repeatedEqual: true });
  }, 60_000);
});
