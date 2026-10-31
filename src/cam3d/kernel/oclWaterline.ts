// cam3d L2: the opencamlib waterline slicer -- the ONE file that knows the
// library exists (WO-1176; Operator's ruling 2026-08-12: adopt the library we
// already ship rather than the staircase route WO-275 measured).
//
// What it does: hand a PartMesh to `@opencamlib/opencamlib` (2023.01.11, the
// browserified emscripten build, LGPL 2.1 -- THIRD_PARTY_LICENSES.md), describe
// the cutter, run `AdaptiveWaterline` at ONE Z, and hand back closed
// cutter-location loops as geom2d Rings in a canonical point order. Nothing
// above this file imports the library; strategies see `WaterlineSlicer`.
//
// The four facts WO-284 measured that shape this file:
//   1. `STLSurf.addTriangle` silently does nothing (`this.triangles?.push`
//      on an undefined array); assigning `surf.triangles` is the only way to
//      fill a surface outside STLReader.
//   2. A Waterline object CANNOT be reused for a second level: `run()` does
//      not clear it, the work compounds, and the module dies by level 3 even
//      on a 60 mm part. Every level here builds a fresh object. The triangle
//      array (plain JS) is built once per mesh and handed over per level;
//      the wasm-side surface is rebuilt by the library on every setSTL.
//   3. The shipped wasm is 32-bit and hard-aborts at 2 GB. After an abort
//      EVERY later call into the module fails, so a poisoned module is
//      reported by name (`OclModulePoisonedError`) and the worker that hosts
//      it must be recycled -- the store does that. A part past the measured
//      safe footprint / sampling ratio is sliced here in XY tiles that each
//      fit, and the tiles' loops are joined (waterlineTiles.ts, WO-2638).
//   4. The geometry is deterministic but the byte order of the loops is
//      not. Each loop is rotated to start at its lexicographically smallest
//      vertex and the loop list is sorted by that vertex, so identical inputs
//      give identical bytes (D-006).
//
// AdaptiveWaterline over fixed Waterline: WO-284 section 5 -- fewer points,
// slightly better error, 1.6x faster on the 60 mm plate; 5.9 s per level on
// the 300 mm plate at sampling 1.0 / 0.1.
//
// Loading is lazy. Use the shipped native WASM factory directly: the package's
// JS wrapper leaks independently allocated inputs and copied results (WO-3134).
// Node uses the package's supported native-addon entry point, whose values are
// managed by its Node binding rather than Embind. Both loads remain injectable.

import type { CutterSpec, PartMesh } from './types';
import type { Ring } from '../geom2d';
import { ensureGeom2dReady } from '../geom2d';
import {
  cropTrianglesToBox,
  mergeTileLoops,
  waterlineTilePlan,
  WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO,
} from './waterlineTiles';

/** Fibre-grid spacing the library slices with, mm. */
export interface WaterlineSampling {
  /** Coarse fibre spacing; the size pre-flight (WO-330) is measured on this. */
  sampling: number;
  /** Adaptive subdivision floor near surface features. */
  minSampling: number;
}

/**
 * The ONE mapping from the operation's tolerance to the library's sampling.
 * At the 0.05 mm default this is 0.5 / 0.025 mm: WO-284 measured 0.0098 mm of
 * error and 0.41 s per level on the 60 mm plate for adaptive 0.5 / 0.01, and
 * the fixed-grid ladder never exceeded 0.017 mm from 0.5 mm down. Coarse
 * sampling is clamped to [0.1, 1.0] mm so a very tight tolerance cannot walk
 * a large part into the 2 GB wall by itself (see the bridge's pre-flight).
 */
export function waterlineSamplingFor(tolerance: number): WaterlineSampling {
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) {
    throw new Error(`waterline: tolerance must be a positive finite number (got ${tolerance}).`);
  }
  const sampling = Math.min(1.0, Math.max(0.1, 10 * tolerance));
  const minSampling = Math.min(sampling, Math.max(0.01, tolerance / 2));
  return { sampling, minSampling };
}

/** Thrown once the wasm module has aborted; every later call would fail. */
export class OclModulePoisonedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OclModulePoisoned';
  }
}

/** Closed cutter-location loops at one Z. Strategies depend on this, never on the library. */
export interface WaterlineSlicer {
  readonly name: string;
  /**
   * Loops for `cutter` at height `z`, as geom2d Rings (xy pairs, implicitly
   * closed) in canonical order. An empty list is a valid answer (no material
   * at or above z under the cutter). Rejects with OclModulePoisonedError when
   * the module has died.
   */
  slice(
    mesh: PartMesh,
    cutter: CutterSpec,
    z: number,
    sampling: WaterlineSampling,
  ): Promise<Ring[]>;
}

// ---- the library surface this file touches (structural; the package's own
// typings hide `chain` behind `protected`) ----------------------------------

type OclTriangles = number[][][];

interface OclOperationLike {
  chain: Promise<unknown>;
  /** Release the operation and any independently owned borrowed inputs after
   * getLoops() has copied results. The shipped wrapper only owns the operation. */
  actualClass?: { delete?: () => void };
  setSTL(surface: { triangles?: OclTriangles }): void;
  setCutter(cutter: unknown): void;
  setSampling(sampling: number): void;
  setMinSampling(minSampling: number): void;
  setZ(z: number): void;
  run(): void;
  getLoops(): Promise<number[][][]>;
}

export interface OclWaterlineModule {
  AdaptiveWaterline: new () => OclOperationLike;
  STLSurf: new () => { triangles?: OclTriangles };
  CylCutter: new (diameter: number, length: number) => unknown;
  BallCutter: new (diameter: number, length: number) => unknown;
  BullCutter: new (diameter: number, cornerRadius: number, length: number) => unknown;
}

/** Cutter length handed to the library. WO-284: accepted and ignored for
 *  reachability, so it buys nothing; a fixed generous value keeps the
 *  fingerprint independent of tool bookkeeping. */
const CUTTER_LENGTH_MM = 100;

const POISON_PATTERN = /Cannot enlarge memory|Aborted\(|native code called abort|RuntimeError/i;

// The package keeps one Emscripten module behind its loader promise. Its
// wrapper queues calls on each JS object, but native operations from separate
// wrappers still share that module. Keep an operation alive through its copied
// result and delete before allowing the next one to enter the native library.
let oclOperationTail: Promise<void> = Promise.resolve();

async function withOclOperation<T>(work: () => Promise<T>): Promise<T> {
  const previous = oclOperationTail;
  let release!: () => void;
  oclOperationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

// Native Embind values returned by constructors/vector.get are independently
// owned. Triangle and STLSurf copy inputs; setSTL/setCutter BORROW them.
interface NativeHandle { delete(): void }
interface NativePoint extends NativeHandle { x: number; y: number; z: number }
interface NativeVector<T> extends NativeHandle { size(): number; get(i: number): T }
interface NativeSurface extends NativeHandle { addTriangle(t: NativeHandle): void }
interface NativeOperation extends NativeHandle {
  setSTL(surface: NativeSurface): void;
  setCutter(cutter: NativeHandle): void;
  setSampling(n: number): void;
  setMinSampling(n: number): void;
  setZ(n: number): void;
  run(): void;
  getLoops(): NativeVector<NativeVector<NativePoint>>;
}
interface NativeModule {
  AdaptiveWaterline: new () => NativeOperation;
  Point: new (x: number, y: number, z: number) => NativePoint;
  Triangle: new (a: NativePoint, b: NativePoint, c: NativePoint) => NativeHandle;
  STLSurf: new () => NativeSurface;
  CylCutter: new (diameter: number, length: number) => NativeHandle;
  BallCutter: new (diameter: number, length: number) => NativeHandle;
  BullCutter: new (diameter: number, radius: number, length: number) => NativeHandle;
}

/** Attempt every destruction, including when an earlier destructor fails. */
function deleteNative(handles: NativeHandle[]): void {
  let failed = false;
  let failure: unknown;
  for (const handle of handles.reverse()) {
    try { handle.delete(); } catch (error) { failed = true; failure ??= error; }
  }
  if (failed) throw failure;
}

/** A cleanup failure must never replace the error that caused unwinding. */
function usingNative<T>(handles: NativeHandle[], work: () => T): T {
  let result!: T;
  let failed = false;
  let failure: unknown;
  try { result = work(); } catch (error) { failed = true; failure = error; }
  let cleanupFailure: unknown;
  try { deleteNative(handles); } catch (error) { cleanupFailure = error; }
  if (failed) throw failure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result;
}

/** Copy before releasing vector.get's by-value handles, including partial copies. */
function copyNativeLoops(raw: NativeVector<NativeVector<NativePoint>>): OclTriangles {
  return usingNative([raw], () => {
    const result: OclTriangles = [];
    for (let i = 0; i < raw.size(); i++) {
      const loop = raw.get(i);
      result.push(usingNative([loop], () => {
        const points: number[][] = [];
        for (let j = 0; j < loop.size(); j++) {
          const point = loop.get(j);
          points.push(usingNative([point], () => [point.x, point.y, point.z]));
        }
        return points;
      }));
    }
    return result;
  });
}

// Match the existing wrapper API so injected package-wrapper controls still run.
// Only this facade owns production native handles; it never patches the library.
function ownedModule(native: NativeModule): OclWaterlineModule {
  class Surface { triangles?: OclTriangles }
  class CylCutter {
    readonly diameter: number;
    readonly length: number;
    constructor(diameter: number, length: number) { this.diameter = diameter; this.length = length; }
    create() { return new native.CylCutter(this.diameter, this.length); }
  }
  class BallCutter extends CylCutter {
    create() { return new native.BallCutter(this.diameter, this.length); }
  }
  class BullCutter extends CylCutter {
    readonly radius: number;
    constructor(diameter: number, radius: number, length: number) { super(diameter, length); this.radius = radius; }
    create() { return new native.BullCutter(this.diameter, this.radius, this.length); }
  }
  class AdaptiveWaterline implements OclOperationLike {
    chain: Promise<unknown> = Promise.resolve();
    private operation = new native.AdaptiveWaterline();
    private inputs: NativeHandle[] = [];
    actualClass = { delete: () => {
      // Destroy the borrower BEFORE its surface/cutter. Clear ownership first
      // so cleanup cannot double-delete even when destruction itself fails.
      const handles = [...this.inputs, this.operation];
      this.inputs = [];
      deleteNative(handles);
    } };
    setSTL(surface: Surface) {
      this.chain = this.chain.then(() => {
        const surf = new native.STLSurf();
        this.inputs.push(surf);
        for (const vertices of surface.triangles!) {
          const temporaries: NativeHandle[] = [];
          usingNative(temporaries, () => {
            const points = vertices.map(p => {
              const point = new native.Point(p[0], p[1], p[2]);
              temporaries.push(point);
              return point;
            });
            const triangle = new native.Triangle(points[0], points[1], points[2]);
            temporaries.push(triangle);
            surf.addTriangle(triangle);
          });
        }
        this.operation.setSTL(surf);
      });
    }
    setCutter(cutter: unknown) {
      this.chain = this.chain.then(() => {
        const actual = (cutter as CylCutter).create();
        this.inputs.push(actual);
        this.operation.setCutter(actual);
      });
    }
    setSampling(n: number) { this.chain = this.chain.then(() => this.operation.setSampling(n)); }
    setMinSampling(n: number) { this.chain = this.chain.then(() => this.operation.setMinSampling(n)); }
    setZ(n: number) { this.chain = this.chain.then(() => this.operation.setZ(n)); }
    run() { this.chain = this.chain.then(() => this.operation.run()); }
    getLoops(): Promise<OclTriangles> {
      const loops = this.chain.then(() => copyNativeLoops(this.operation.getLoops()));
      this.chain = loops;
      return loops;
    }
  }
  return { AdaptiveWaterline, STLSurf: Surface, CylCutter, BallCutter, BullCutter };
}

// One shared factory/module, including across slicer instances and repeat jobs.
// A rejected load can retry; an actual native abort still poisons the worker.
let packagePromise: Promise<OclWaterlineModule> | null = null;
async function loadPackage(): Promise<OclWaterlineModule> {
  if (!packagePromise) {
    // The shipped WASM factory is compiled for web and requires window or
    // importScripts. The package main selects the platform Node addon instead.
    // Do not emulate a browser in Node or feed addon objects to Embind cleanup.
    const runtime = typeof process === 'object' && process.versions?.node
      ? import('@opencamlib/opencamlib').then(m =>
        ('default' in m ? m.default : m) as unknown as OclWaterlineModule)
      : import('@opencamlib/opencamlib/build/ocl.js')
        .then(m => m.default() as Promise<NativeModule>)
        .then(ownedModule);
    packagePromise = runtime
      .catch((error: unknown) => { packagePromise = null; throw error; });
  }
  return packagePromise;
}

/**
 * The library wants `[[x,y,z],[x,y,z],[x,y,z]]` per triangle and rebuilds it
 * as embind objects on every setSTL (11 ms per 1420 triangles, WO-284). The
 * JS array is built once per PartMesh and reused across levels.
 */
function trianglesOf(mesh: PartMesh): OclTriangles {
  const { positions, indices } = mesh;
  const out: OclTriangles = new Array(indices.length / 3);
  for (let t = 0, k = 0; t < indices.length; t += 3, k++) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    out[k] = [
      [positions[a], positions[a + 1], positions[a + 2]],
      [positions[b], positions[b + 1], positions[b + 2]],
      [positions[c], positions[c + 1], positions[c + 2]],
    ];
  }
  return out;
}

/**
 * WO-3106: OCL's facetPush tests triangle membership in XY. A vertical
 * facet has a singular XY projection; its expanded barycentric denominator
 * can acquire cancellation noise and accept contacts far beyond the facet.
 * Put an exact vertical edge first: the zero denominator then evaluates
 * exactly (both XY differences are zero). OCL rejects the singular facet
 * contact and its edge/vertex push tests still describe the same wall.
 * Cyclic rotation preserves every coordinate, edge and winding. Do not
 * perturb vertices or discard facets; the other cutter contacts need them.
 * Normalize cropped tiles too: clipping may create another vertical edge.
 */
function stableFacetOrder(triangles: OclTriangles): OclTriangles {
  return triangles.map((triangle) => {
    for (let i = 1; i < 3; i++) {
      const a = triangle[i];
      const b = triangle[(i + 1) % 3];
      if (a[0] === b[0] && a[1] === b[1]) {
        return [a, b, triangle[(i + 2) % 3]];
      }
    }
    return triangle;
  });
}

function cutterOf(mod: OclWaterlineModule, spec: CutterSpec): unknown {
  switch (spec.kind) {
    case 'flat':
      return new mod.CylCutter(spec.diameter, CUTTER_LENGTH_MM);
    case 'ball':
      return new mod.BallCutter(spec.diameter, CUTTER_LENGTH_MM);
    case 'bull':
      return new mod.BullCutter(spec.diameter, spec.cornerRadius, CUTTER_LENGTH_MM);
    case 'vbit':
      throw new Error(
        'waterline: a V-bit has no waterline cutter model in the library; use a flat, ball or bull-nose end mill.',
      );
  }
}

/**
 * One loop from the library -> a canonical Ring: consecutive duplicates and a
 * repeated closing vertex dropped, then rotated so the lexicographically
 * smallest (x, y) vertex comes first. Returns null for a degenerate loop
 * (fewer than 3 distinct vertices, or zero xy extent -- WO-284 section 4 saw
 * twelve zero-extent "loops" from short cutters).
 */
export function canonicalLoop(points: readonly (readonly number[])[]): Ring | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    const x = p[0];
    const y = p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const n = xs.length;
    if (n > 0 && xs[n - 1] === x && ys[n - 1] === y) continue;
    xs.push(x);
    ys.push(y);
  }
  while (xs.length > 1 && xs[0] === xs[xs.length - 1] && ys[0] === ys[ys.length - 1]) {
    xs.pop();
    ys.pop();
  }
  const n = xs.length;
  if (n < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
    if (xs[i] < xs[start] || (xs[i] === xs[start] && ys[i] < ys[start])) start = i;
  }
  if (!(maxX - minX > 0) || !(maxY - minY > 0)) return null;
  const ring = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = (start + i) % n;
    ring[2 * i] = xs[j];
    ring[2 * i + 1] = ys[j];
  }
  return ring;
}

/** Sort loops by their canonical first vertex so the list order is stable too. */
export function sortLoops(loops: Ring[]): Ring[] {
  return loops.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a.length - b.length);
}

export function createOclWaterlineSlicer(
  opts: {
    load?: () => Promise<OclWaterlineModule>;
    /** Tests only: the footprint / sampling ratio past which a slice is tiled. */
    maxFootprintRatio?: number;
    /** Native WASM factory injection; uses the production ownership adapter. */
    loadNative?: () => Promise<NativeModule>;
  } = {},
): WaterlineSlicer {
  const load = opts.load ?? (opts.loadNative
    ? () => opts.loadNative!().then(ownedModule)
    : loadPackage);
  const maxRatio = opts.maxFootprintRatio ?? WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO;
  let modulePromise: Promise<OclWaterlineModule> | null = null;
  let poisoned: string | null = null;
  const triangleCache = new WeakMap<PartMesh, OclTriangles>();
  // One op slices every level with the same tiles; crop each box once per mesh.
  const tileCache = new WeakMap<PartMesh, Map<string, OclTriangles>>();

  const moduleOnce = (): Promise<OclWaterlineModule> => {
    if (!modulePromise) {
      modulePromise = load().catch((err: unknown) => {
        modulePromise = null; // a failed load may be retried
        throw err;
      });
    }
    return modulePromise;
  };

  return {
    name: 'ocl-adaptive-waterline',
    async slice(mesh, cutter, z, sampling) {
      if (poisoned !== null) {
        throw new OclModulePoisonedError(
          `waterline: the slicing library aborted earlier (${poisoned}); it must be restarted before another level can run.`,
        );
      }
      if (!Number.isFinite(z)) throw new Error(`waterline: non-finite level z ${z}.`);
      if (!(sampling.sampling > 0) || !(sampling.minSampling > 0)) {
        throw new Error(`waterline: sampling must be positive (got ${sampling.sampling} / ${sampling.minSampling}).`);
      }
      const mod = await moduleOnce();
      const runOnce = (triangles: OclTriangles, coarse: number): Promise<Ring[]> => withOclOperation(async () => {
        // Fresh object per level, every time (WO-284 section 5).
        const wl = new mod.AdaptiveWaterline();
        let result: Ring[] | undefined;
        let failed = false;
        let failure: unknown;
        try {
          await wl.chain;
          const surf = new mod.STLSurf();
          surf.triangles = triangles;
          wl.setSTL(surf);
          wl.setCutter(cutterOf(mod, cutter));
          wl.setSampling(coarse);
          wl.setMinSampling(sampling.minSampling);
          wl.setZ(z);
          wl.run();
          const raw = await wl.getLoops();
          const loops: Ring[] = [];
          for (const loop of raw) {
            const ring = canonicalLoop(loop);
            if (ring !== null) loops.push(ring);
          }
          result = sortLoops(loops);
        } catch (error) {
          failed = true;
          failure = error;
        }
        // Loops are now JS coordinates. Release the operation and borrowed
        // inputs before any other level, tile, job or slicer enters WASM.
        // Queue the release behind the package wrapper's own chain: it may
        // have appended native setup while getLoops was being awaited.
        let cleanupFailure: unknown;
        if (wl.actualClass?.delete !== undefined) {
          wl.chain = wl.chain.then(
            () => { wl.actualClass?.delete?.(); },
            () => { wl.actualClass?.delete?.(); },
          );
          try { await wl.chain; } catch (error) { cleanupFailure = error; }
        }
        if (failed) throw failure;
        if (cleanupFailure !== undefined) throw cleanupFailure;
        return result!;
      });
      try {
        const plan = waterlineTilePlan(mesh.bounds, cutter.diameter / 2, sampling.sampling, maxRatio);
        if (plan === null) {
          let triangles = triangleCache.get(mesh);
          if (triangles === undefined) {
            triangles = stableFacetOrder(trianglesOf(mesh));
            triangleCache.set(mesh, triangles);
          }
          return await runOnce(triangles, sampling.sampling);
        }
        // Past the safe ratio: slice tile by tile and join (waterlineTiles.ts).
        await ensureGeom2dReady();
        let crops = tileCache.get(mesh);
        if (crops === undefined) {
          crops = new Map();
          tileCache.set(mesh, crops);
        }
        const perTile: { cell: (typeof plan.tiles)[number]['cell']; loops: Ring[] }[] = [];
        for (const tile of plan.tiles) {
          const key = `${tile.box.minX},${tile.box.minY},${tile.box.maxX},${tile.box.maxY}`;
          let triangles = crops.get(key);
          if (triangles === undefined) {
            triangles = stableFacetOrder(cropTrianglesToBox(mesh, tile.box));
            crops.set(key, triangles);
          }
          perTile.push({ cell: tile.cell, loops: triangles.length > 0 ? await runOnce(triangles, plan.sampling) : [] });
        }
        const loops: Ring[] = [];
        for (const merged of mergeTileLoops(perTile, sampling.minSampling)) {
          const pts: number[][] = [];
          for (let i = 0; i < merged.length; i += 2) pts.push([merged[i], merged[i + 1]]);
          const ring = canonicalLoop(pts);
          if (ring !== null) loops.push(ring);
        }
        return sortLoops(loops);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (POISON_PATTERN.test(message)) {
          poisoned = message.slice(0, 160);
          throw new OclModulePoisonedError(
            `waterline: the slicing library ran out of memory at z=${z} (${poisoned}). ` +
              'The 3D worker will be restarted before the next compute.',
          );
        }
        throw err;
      }
    },
  };
}
