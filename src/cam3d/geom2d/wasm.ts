// cam3d geom2d: clipper2-wasm singleton init + Ring marshalling.
//
// DELIBERATE DUPLICATION (layering): this small init pattern also lives in
// src/lib/cam/face2d/clipperOffset.ts and
// src/lib/cam/adaptiveClearing2d/engine/clipperEngine.ts. cam3d is greenfield
// and must not depend on 2D-operation code, so the glue is copied here rather
// than imported -- a third wasm module instance is the accepted cost of a
// clean layer boundary (same call the AC engine made; see its header TODO
// about eventually hoisting ONE shared module).
//
// SCALING / RESOLUTION: clipper2 clips in Int64 internally; the D API scales
// mm coordinates by 10^PRECISION on the way in and back on the way out. With
// PRECISION = 6 (same convention as face2d/clipperOffset.ts) the coordinate
// resolution is 1e-6 mm (one nanometre) -- far below any machining tolerance,
// and Int64 range still allows coordinates out to ~9e12 mm, so overflow is a
// non-issue for CAM-scale parts.
//
// embind DISPOSAL RULES for this build (proven empirically by the AC engine's
// leak probes -- emscripten memory never shrinks, so misses are permanent):
//   - every class instance has a real .delete(); call it directly, never
//     `delete?.()` (optional chaining silently no-ops and hides the leak).
//   - PathsD.get(i) returns a NEW wasm-heap COPY each call; delete each one.
//   - PathD.view() returns a Float64Array over wasm memory, stride 3
//     (x, y, z): nothing to free, but the view is invalidated by memory
//     growth -- copy out immediately.

// @ts-expect-error - clipper2-wasm's default export is the untyped Emscripten
// factory; the package ships no typing for the factory call itself.
import Clipper2ZFactory from 'clipper2-wasm';
// Vite emits the .wasm as an asset and serves it at this URL. Emscripten's
// default bare-filename resolution fails inside bundled Web Workers, so we
// point locateFile at the resolved URL in the browser. Under Node (vitest)
// the default path works, so we leave it alone there.
import wasmUrl from 'clipper2-wasm/dist/es/clipper2z.wasm?url';

import type { Ring } from './rings';

/** mm coordinates are scaled by 10^6 into Int64: resolution 1e-6 mm. */
export const PRECISION = 6;

// --- minimal structural typing of the clipper2-wasm surface we use ---------
// The package's factory is untyped; rather than spraying `any`, we declare
// the handful of members this module touches. Opaque enum values are objects
// carrying a numeric .value.

interface WasmHandle {
  delete(): void;
}

export interface PathDLike extends WasmHandle {
  size(): number;
  /** Float64Array over wasm memory, stride 3 (x, y, z). Copy out immediately. */
  view(): Float64Array;
}

export interface PathsDLike extends WasmHandle {
  size(): number;
  /** Returns a heap COPY -- caller must delete it. */
  get(i: number): PathDLike;
  push_back(p: PathDLike): void;
}

interface EnumValue {
  readonly value: number;
}

export interface Clipper2Module {
  MakePathD(flatXy: number[]): PathDLike;
  PathsD: new () => PathsDLike;
  InflatePathsD(
    paths: PathsDLike,
    delta: number,
    joinType: EnumValue,
    endType: EnumValue,
    miterLimit: number,
    precision: number,
    arcTolerance: number,
  ): PathsDLike;
  IntersectD(s: PathsDLike, c: PathsDLike, fillRule: EnumValue, precision: number): PathsDLike;
  UnionD(s: PathsDLike, c: PathsDLike, fillRule: EnumValue, precision: number): PathsDLike;
  DifferenceD(s: PathsDLike, c: PathsDLike, fillRule: EnumValue, precision: number): PathsDLike;
  XorD(s: PathsDLike, c: PathsDLike, fillRule: EnumValue, precision: number): PathsDLike;
  JoinType: { Square: EnumValue; Round: EnumValue; Miter: EnumValue };
  EndType: { Polygon: EnumValue };
  FillRule: { EvenOdd: EnumValue; NonZero: EnumValue };
}

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

let mod: Clipper2Module | null = null;
let initPromise: Promise<void> | null = null;

/** Initialise clipper2-wasm once for geom2d. Safe to call repeatedly. */
export function ensureGeom2dReady(): Promise<void> {
  if (mod) return Promise.resolve();
  if (!initPromise) {
    const opts = isNode
      ? {}
      : { locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p) };
    initPromise = (Clipper2ZFactory as (o: object) => Promise<Clipper2Module>)(opts).then(
      (m) => {
        mod = m;
      },
    );
  }
  return initPromise;
}

/** True once the wasm module is loaded and the sync ops may be called. */
export function geom2dReady(): boolean {
  return mod !== null;
}

/** Fail loud when called before init -- never a silent fallback. */
export function requireMod(): Clipper2Module {
  if (!mod) {
    throw new Error(
      'geom2d: clipper2 is not initialised (await ensureGeom2dReady() before calling offset/boolean).',
    );
  }
  return mod;
}

/**
 * Run `fn`, deleting every wasm handle registered via `own` on the way out
 * (success or throw). Deletion is deterministic, in reverse creation order.
 */
export function withWasm<T>(fn: (own: <H extends WasmHandle>(h: H) => H) => T): T {
  const owned: WasmHandle[] = [];
  const own = <H extends WasmHandle>(h: H): H => {
    owned.push(h);
    return h;
  };
  try {
    return fn(own);
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) owned[i].delete();
  }
}

/** Marshal rings into a PathsD the caller owns (register it with `own`). */
export function toPathsD(rings: readonly Ring[]): PathsDLike {
  const m = requireMod();
  const paths = new m.PathsD();
  try {
    for (const ring of rings) {
      // Array.from: MakePathD wants a plain number[] of xy pairs.
      const pd = m.MakePathD(Array.from(ring));
      try {
        paths.push_back(pd);
      } finally {
        pd.delete();
      }
    }
  } catch (e) {
    paths.delete();
    throw e;
  }
  return paths;
}

/**
 * Copy a PathsD out to plain Rings via the stride-3 view (zero per-vertex
 * handles). Does NOT delete `paths` -- the caller owns it. Rings shorter than
 * 3 points cannot come back from clipper's closed-polygon ops, but we guard
 * anyway rather than emit a degenerate ring downstream.
 */
export function fromPathsD(paths: PathsDLike): Ring[] {
  const out: Ring[] = [];
  const count = paths.size();
  for (let i = 0; i < count; i++) {
    const p = paths.get(i); // heap COPY -- must be deleted
    try {
      const n = p.size();
      const v = p.view(); // stride 3: x, y, z
      if (v.length !== n * 3) {
        throw new Error(
          `geom2d: unexpected PathD.view() layout (${v.length} doubles for ${n} points).`,
        );
      }
      if (n >= 3) {
        const ring = new Float64Array(n * 2);
        for (let j = 0, k = 0; j < n; j++, k += 3) {
          ring[2 * j] = v[k];
          ring[2 * j + 1] = v[k + 1];
        }
        out.push(ring);
      }
    } finally {
      p.delete();
    }
  }
  return out;
}
