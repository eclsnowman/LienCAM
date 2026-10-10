// cam3d rough: point-format converters between the geom2d flat Ring
// (Float64Array xy pairs) and the {x,y}[] / [x,y][] loop shapes the rougher's
// higher layers and the fixtures speak.
//
// FAIL LOUD (ADR-0003): malformed input (odd-length ring, non-finite
// coordinate, too-few points) THROWS here rather than silently producing a
// degenerate loop that a later boolean would swallow into an empty result.
//
// These are pure and allocation-simple; the round-trip ringToLoop/loopToRing
// is an exact identity (same f64 values, no rounding), which the gate asserts.

import type { Ring } from '../geom2d';

/** A single planar point in the loop representation. */
export interface Pt {
  x: number;
  y: number;
}

/** A closed loop as an array of points (first point NOT repeated at the end). */
export type Loop = Pt[];

function assertRing(ring: Ring, label: string): void {
  if (ring.length % 2 !== 0) {
    throw new Error(`rough/convert ${label}: ring has odd length ${ring.length} (must be xy pairs).`);
  }
  if (ring.length < 6) {
    throw new Error(
      `rough/convert ${label}: ring is degenerate (${ring.length / 2} points; a ring needs >= 3).`,
    );
  }
  for (let k = 0; k < ring.length; k++) {
    if (!Number.isFinite(ring[k])) {
      throw new Error(`rough/convert ${label}: non-finite coordinate at index ${k} (${ring[k]}).`);
    }
  }
}

/** Flat Ring [x0,y0,x1,y1,...] -> [{x,y},...]. Walks i += 2. */
export function ringToLoop(ring: Ring): Loop {
  assertRing(ring, 'ringToLoop');
  const out: Loop = new Array(ring.length / 2);
  for (let i = 0, k = 0; i < ring.length; i += 2, k++) {
    out[k] = { x: ring[i], y: ring[i + 1] };
  }
  return out;
}

/** [{x,y},...] -> flat Ring Float64Array. */
export function loopToRing(loop: Loop): Ring {
  if (loop.length < 3) {
    throw new Error(`rough/convert loopToRing: loop has ${loop.length} points (a ring needs >= 3).`);
  }
  const ring = new Float64Array(loop.length * 2);
  for (let k = 0; k < loop.length; k++) {
    const p = loop[k];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error(`rough/convert loopToRing: non-finite point at index ${k} (${p.x}, ${p.y}).`);
    }
    ring[2 * k] = p.x;
    ring[2 * k + 1] = p.y;
  }
  return ring;
}

/** [[x,y],...] tuple loop (fixture boundary format) -> flat Ring Float64Array. */
export function tupleLoopToRing(pts: ReadonlyArray<readonly [number, number]>): Ring {
  if (pts.length < 3) {
    throw new Error(
      `rough/convert tupleLoopToRing: loop has ${pts.length} points (a ring needs >= 3).`,
    );
  }
  const ring = new Float64Array(pts.length * 2);
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      throw new Error(
        `rough/convert tupleLoopToRing: non-finite point at index ${k} (${p[0]}, ${p[1]}).`,
      );
    }
    ring[2 * k] = p[0];
    ring[2 * k + 1] = p[1];
  }
  return ring;
}

/** Convenience: convert a whole ring set to loops. */
export function ringsToLoops(rings: readonly Ring[]): Loop[] {
  return rings.map((r) => ringToLoop(r));
}

/** Convenience: convert a whole set of loops to rings. */
export function loopsToRings(loops: readonly Loop[]): Ring[] {
  return loops.map((l) => loopToRing(l));
}
