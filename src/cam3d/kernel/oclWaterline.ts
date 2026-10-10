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
// Loading: the 8.6 MB module is imported lazily on the first slice so the
// other 3D families never pay for it. The loader is injectable because the
// package's `main` field points at a native Node addon that is not shipped;
// tests load the emscripten build directly (with a `window` shim the module
// checks for) through `createOclWaterlineSlicer({ load })`.

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

/** Default production loader: the package root, which bundlers resolve to the browser build. */
async function loadPackage(): Promise<OclWaterlineModule> {
  const m = (await import('@opencamlib/opencamlib')) as unknown as
    | OclWaterlineModule
    | { default: OclWaterlineModule };
  const mod = 'AdaptiveWaterline' in m ? m : (m as { default: OclWaterlineModule }).default;
  if (!mod || typeof mod.AdaptiveWaterline !== 'function') {
    throw new Error('waterline: @opencamlib/opencamlib loaded but exposes no AdaptiveWaterline.');
  }
  return mod;
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
  } = {},
): WaterlineSlicer {
  const load = opts.load ?? loadPackage;
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
      const runOnce = async (triangles: OclTriangles, coarse: number): Promise<Ring[]> => {
        // Fresh object per level, every time (WO-284 section 5).
        const wl = new mod.AdaptiveWaterline();
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
        return sortLoops(loops);
      };
      try {
        const plan = waterlineTilePlan(mesh.bounds, cutter.diameter / 2, sampling.sampling, maxRatio);
        if (plan === null) {
          let triangles = triangleCache.get(mesh);
          if (triangles === undefined) {
            triangles = trianglesOf(mesh);
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
            triangles = cropTrianglesToBox(mesh, tile.box);
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
