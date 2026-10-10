// cam3d L4 (waterline): what happens to the loops of ONE level between the
// slicer and the linker.
//
// The slicer hands back closed cutter-location loops and nothing else -- no
// side, no direction, no slope, no clipping (WO-284: "OCL returns unordered
// closed loops and nothing about how to drive them"). This module decides:
//
//   1. WHICH SIDE THE MATERIAL IS ON (boss or pocket). The loop is where the
//      cutter at this Z touches material. Move the cutter a little toward the
//      loop's interior and a little toward its exterior and drop it (the L2
//      kernel's dropPoints, the same cutter): the side where it lands HIGHER
//      is the side with material under it. This is measured, never guessed
//      from nesting depth, because a boss inside a pocket has the same
//      nesting depth as a hole in a plate.
//   2. DIRECTION. Climb milling with a clockwise spindle keeps the material
//      on the RIGHT of the direction of travel (the same fact G41 encodes):
//      clockwise around a boss, counter-clockwise inside a pocket.
//      Conventional is the mirror; a left-hand cutter (ccw spindle) mirrors
//      again.
//   3. STEEP AREAS ONLY (optional). The slope of the cutter-location field at
//      each vertex, from the same two probes, splits a loop into the runs that
//      are at least as steep as the threshold; runs shorter than one cutter
//      diameter are confetti and are dropped.
//   4. BOUNDARY CLIP (optional). Loops are cut to the stock footprint the way
//      Parallel Finish clips its scanlines: the parts outside are dropped and
//      the loop becomes one or more open passes.
//
// Pure: kernel surface + geom2d rings only. Deterministic: fixed vertex
// order, one batched probe call per level (D-005), no RNG.

import type { CutterHandle, GeometryKernel, MeshHandle } from '../../kernel/types';
import type { Ring } from '../../geom2d';
import { area } from '../../geom2d/rings';

export type MillingDirection = 'climb' | 'conventional';
export type SpindleRotation = 'cw' | 'ccw';

/** One pass of a level: xy pairs at a fixed z, closed (implicit last->first) or open. */
export interface WaterlinePass {
  xy: Float64Array;
  z: number;
  closed: boolean;
  /** Index into the level ladder (0 = highest). */
  level: number;
  /** Material inside the loop (boss / island) or outside (pocket wall). */
  materialInside: boolean;
  /** Assigned by regionise(); -1 until then. */
  region: number;
}

const EPS = 1e-9;

/** Even-odd point-in-ring; a vertex-on-edge answer is either, which the callers tolerate. */
export function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i];
    const yi = ring[2 * i + 1];
    const xj = ring[2 * j];
    const yj = ring[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when (x, y) lies inside a ring set under nonzero winding (outers CCW, holes CW). */
export function pointInRegion(rings: readonly Ring[], x: number, y: number): boolean {
  let winding = 0;
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[2 * i];
      const yi = ring[2 * i + 1];
      const xj = ring[2 * j];
      const yj = ring[2 * j + 1];
      if (yj <= y) {
        if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) winding++;
      } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) {
        winding--;
      }
    }
  }
  return winding !== 0;
}

/** Reversed copy of an xy-pair polyline. */
export function reversedXy(xy: Float64Array): Float64Array {
  const n = xy.length / 2;
  const out = new Float64Array(xy.length);
  for (let i = 0; i < n; i++) {
    out[2 * i] = xy[2 * (n - 1 - i)];
    out[2 * i + 1] = xy[2 * (n - 1 - i) + 1];
  }
  return out;
}

/** xy length of a polyline; closed adds the last->first edge. */
export function xyLength(xy: Float64Array, closed: boolean): number {
  const n = xy.length / 2;
  let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(xy[2 * i] - xy[2 * i - 2], xy[2 * i + 1] - xy[2 * i - 1]);
  if (closed && n > 1) len += Math.hypot(xy[0] - xy[2 * n - 2], xy[1] - xy[2 * n - 1]);
  return len;
}

/**
 * Outward unit normal of every EDGE of a ring (edge i runs from vertex i to
 * vertex i + 1, cyclically). Edges, not vertices: a vertex normal is a
 * bisector, and at a sharp convex corner a probe along the bisector can miss
 * a flat cutter's contact on both sides and vote nothing. An edge midpoint
 * always has a clean normal.
 */
function edgeNormals(ring: Ring): Float64Array {
  const n = ring.length / 2;
  const ccw = area(ring) > 0;
  const out = new Float64Array(ring.length);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = ring[2 * j] - ring[2 * i];
    const ey = ring[2 * j + 1] - ring[2 * i + 1];
    const len = Math.hypot(ex, ey);
    // Right-hand normal of the edge (outward for a CCW ring).
    let nx = len > EPS ? ey / len : 0;
    let ny = len > EPS ? -ex / len : 0;
    if (!ccw) {
      nx = -nx;
      ny = -ny;
    }
    out[2 * i] = nx;
    out[2 * i + 1] = ny;
  }
  return out;
}

/**
 * Probe both sides of every EDGE midpoint of every loop in ONE kernel call
 * and return, per loop, the drop height just inside and just outside each
 * edge. `probeMm` is how far from the loop the probes sit.
 */
async function probeLoops(
  kernel: GeometryKernel,
  mesh: MeshHandle,
  cutter: CutterHandle,
  loops: readonly Ring[],
  probeMm: number,
  zSeed: number,
  signal?: AbortSignal,
): Promise<{ inside: Float64Array; outside: Float64Array }[]> {
  let total = 0;
  for (const ring of loops) total += ring.length / 2;
  const xy = new Float64Array(total * 4);
  let k = 0;
  for (const ring of loops) {
    const normals = edgeNormals(ring);
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mx = (ring[2 * i] + ring[2 * j]) / 2;
      const my = (ring[2 * i + 1] + ring[2 * j + 1]) / 2;
      const nx = normals[2 * i];
      const ny = normals[2 * i + 1];
      xy[k++] = mx - probeMm * nx; // inside (against the outward normal)
      xy[k++] = my - probeMm * ny;
      xy[k++] = mx + probeMm * nx; // outside
      xy[k++] = my + probeMm * ny;
    }
  }
  const z = total === 0 ? new Float64Array(0) : await kernel.dropPoints(mesh, cutter, xy, zSeed, { signal });
  if (z.length !== total * 2) {
    throw new Error(`waterline: kernel returned ${z.length} probe heights for ${total * 2} probes.`);
  }
  const out: { inside: Float64Array; outside: Float64Array }[] = [];
  let offset = 0;
  for (const ring of loops) {
    const n = ring.length / 2;
    const inside = new Float64Array(n);
    const outside = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      inside[i] = z[offset + 2 * i];
      outside[i] = z[offset + 2 * i + 1];
    }
    offset += 2 * n;
    out.push({ inside, outside });
  }
  return out;
}

export interface ClassifyLevelInput {
  loops: readonly Ring[];
  z: number;
  level: number;
  kernel: GeometryKernel;
  mesh: MeshHandle;
  cutter: CutterHandle;
  /** Probe standoff from the loop, mm. */
  probeMm: number;
  /** Drop floor for probes (below the part). */
  zSeed: number;
  direction: MillingDirection;
  spindle: SpindleRotation;
  /** 0 = keep everything; otherwise drop runs shallower than this angle from horizontal. */
  minSlopeDeg: number;
  /** Runs shorter than this (mm) are dropped by the slope filter. */
  minRunMm: number;
  signal?: AbortSignal;
}

/**
 * Side, direction and (optionally) the steep-only split for one level's
 * loops. Returns passes in loop order; a loop the slope filter empties
 * contributes nothing.
 */
export async function classifyLevel(input: ClassifyLevelInput): Promise<WaterlinePass[]> {
  const { loops, z, level } = input;
  if (loops.length === 0) return [];
  const probes = await probeLoops(
    input.kernel, input.mesh, input.cutter, loops, input.probeMm, input.zSeed, input.signal,
  );
  const passes: WaterlinePass[] = [];
  const wantMaterialOnRight = (input.direction === 'climb') === (input.spindle === 'cw');
  for (let li = 0; li < loops.length; li++) {
    const ring = loops[li];
    const { inside, outside } = probes[li];
    const n = ring.length / 2;
    // 1. Side: majority of edges where the cutter lands higher inside.
    let insideHigher = 0;
    for (let i = 0; i < n; i++) if (inside[i] > outside[i] + EPS) insideHigher++;
    else if (outside[i] > inside[i] + EPS) insideHigher--;
    const materialInside = insideHigher > 0;
    // 2. Direction. Walking a CCW ring keeps its interior on the LEFT.
    //    Material on the right of travel  <=>  (material inside) XOR (CCW).
    const ccw = area(ring) > 0;
    const materialOnRight = materialInside !== ccw;
    const reverse = materialOnRight !== wantMaterialOnRight;
    const oriented = reverse ? reversedXy(ring) : ring;
    // Original edge i (vertices i -> i+1) becomes, after reversal, the edge
    // starting at reversed position n-2-i (mod n).
    const orientedEdge = reverse ? (i: number) => (2 * n - 2 - i) % n : (i: number) => i;
    // 3. Steep-only split.
    if (!(input.minSlopeDeg > 0)) {
      passes.push({ xy: oriented, z, closed: true, level, materialInside, region: -1 });
      continue;
    }
    const tanMin = Math.tan((input.minSlopeDeg * Math.PI) / 180);
    const steep = new Uint8Array(n); // per ORIENTED edge
    let steepCount = 0;
    for (let i = 0; i < n; i++) {
      const slope = Math.abs(inside[i] - outside[i]) / (2 * input.probeMm);
      if (slope >= tanMin - EPS) {
        steep[orientedEdge(i)] = 1;
        steepCount++;
      }
    }
    if (steepCount === n) {
      passes.push({ xy: oriented, z, closed: true, level, materialInside, region: -1 });
      continue;
    }
    if (steepCount === 0) continue;
    // Runs of consecutive steep EDGES along the oriented ring, starting after
    // a gap so a run that wraps the seam is emitted once. A run of edges
    // a..b is the vertex chain a..b+1.
    let startAt = 0;
    while (startAt < n && steep[startAt] === 1) startAt++;
    for (let s = 0; s < n; ) {
      if (steep[(startAt + s) % n] === 0) {
        s++;
        continue;
      }
      const first = (startAt + s) % n;
      let count = 0;
      while (s < n && steep[(startAt + s) % n] === 1) {
        count++;
        s++;
      }
      const xy = new Float64Array((count + 1) * 2);
      for (let k = 0; k <= count; k++) {
        const idx = (first + k) % n;
        xy[2 * k] = oriented[2 * idx];
        xy[2 * k + 1] = oriented[2 * idx + 1];
      }
      if (xyLength(xy, false) >= input.minRunMm) {
        passes.push({ xy, z, closed: false, level, materialInside, region: -1 });
      }
    }
  }
  return passes;
}

/** Parameter of the intersection of segment a-b with segment c-d along a-b, or null. */
function segmentParam(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return Math.min(1, Math.max(0, t));
}

/**
 * Clip a pass to a containment region (outers CCW, holes CW): the pieces
 * inside are kept as open passes; a closed pass that lies entirely inside
 * stays closed. Deterministic: fixed edge order, sorted crossing parameters.
 */
function clipPassByRegion(
  pass: WaterlinePass,
  region: readonly Ring[],
  keepInside: boolean,
): WaterlinePass[] {
  const { xy, closed } = pass;
  const n = xy.length / 2;
  const edgeCount = closed ? n : n - 1;
  const pieces: number[][] = [];
  let current: number[] = [];
  let allInside = true;
  const pushPoint = (x: number, y: number) => {
    const m = current.length;
    if (m >= 2 && current[m - 2] === x && current[m - 1] === y) return;
    current.push(x, y);
  };
  const flush = () => {
    if (current.length >= 4) pieces.push(current);
    current = [];
  };
  for (let e = 0; e < edgeCount; e++) {
    const ax = xy[2 * e];
    const ay = xy[2 * e + 1];
    const j = (e + 1) % n;
    const bx = xy[2 * j];
    const by = xy[2 * j + 1];
    const params: number[] = [0, 1];
    for (const ring of region) {
      const rn = ring.length / 2;
      for (let i = 0, k = rn - 1; i < rn; k = i++) {
        const t = segmentParam(ax, ay, bx, by, ring[2 * k], ring[2 * k + 1], ring[2 * i], ring[2 * i + 1]);
        if (t !== null) params.push(t);
      }
    }
    params.sort((p, q) => p - q);
    for (let p = 0; p + 1 < params.length; p++) {
      const t0 = params[p];
      const t1 = params[p + 1];
      if (t1 - t0 < EPS) continue;
      const tm = (t0 + t1) / 2;
      const inside = pointInRegion(region, ax + (bx - ax) * tm, ay + (by - ay) * tm);
      if (inside === keepInside) {
        // Endpoints at t = 0 / 1 are the EXACT vertices, never recomputed, so
        // the seam join below (and the linker's duplicate suppression) can
        // compare them bit for bit (audit finding 2).
        if (t0 === 0) pushPoint(ax, ay);
        else pushPoint(ax + (bx - ax) * t0, ay + (by - ay) * t0);
        if (t1 === 1) pushPoint(bx, by);
        else pushPoint(ax + (bx - ax) * t1, ay + (by - ay) * t1);
      } else {
        allInside = false;
        flush();
      }
    }
  }
  if (allInside) return [pass];
  flush();
  // A closed pass whose seam (vertex 0) is inside has its first and last pieces
  // joined across the seam.
  if (closed && pieces.length >= 2) {
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    if (first[0] === last[last.length - 2] && first[1] === last[last.length - 1]) {
      pieces[0] = last.concat(first.slice(2));
      pieces.pop();
    }
  }
  return pieces.map((pts) => ({ ...pass, xy: new Float64Array(pts), closed: false }));
}

export function clipPassToRegion(pass: WaterlinePass, region: readonly Ring[]): WaterlinePass[] {
  return clipPassByRegion(pass, region, true);
}

/** Pieces outside a region, used for stock-edge extensions without altering the legacy inside pass. */
export function clipPassOutsideRegion(pass: WaterlinePass, region: readonly Ring[]): WaterlinePass[] {
  return clipPassByRegion(pass, region, false);
}

/**
 * Group passes into REGIONS (islands): a pass at a lower level joins the
 * region of a pass one level up when they are the SAME WALL continued -- the
 * same material side and their nearest vertices within `reachMm` of each
 * other (a wall drafted to 45 deg moves one stepdown per level; steeper walls
 * move less). Containment is deliberately NOT a criterion: a boss loop
 * contains every pocket loop cut into it, and grouping by containment folded
 * Operator's five-bore plate into one region, which made "region by region"
 * identical to "level by level" (WO-1176 first in-app capture). Union-find
 * over level pairs; region ids are assigned in first-appearance order, so
 * they are stable.
 */
export function regionise(passes: WaterlinePass[], reachMm: number): void {
  const parent = passes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const byLevel = new Map<number, number[]>();
  for (let i = 0; i < passes.length; i++) {
    const list = byLevel.get(passes[i].level) ?? [];
    list.push(i);
    byLevel.set(passes[i].level, list);
  }
  const levels = [...byLevel.keys()].sort((p, q) => p - q);
  const sampleStride = (p: WaterlinePass) => Math.max(1, Math.floor(p.xy.length / 2 / 64));
  const related = (upper: WaterlinePass, lower: WaterlinePass): boolean => {
    if (upper.materialInside !== lower.materialInside) return false;
    const su = sampleStride(upper);
    const sl = sampleStride(lower);
    let best = Infinity;
    for (let i = 0; i < upper.xy.length; i += 2 * su) {
      for (let j = 0; j < lower.xy.length; j += 2 * sl) {
        const d = Math.hypot(upper.xy[i] - lower.xy[j], upper.xy[i + 1] - lower.xy[j + 1]);
        if (d < best) best = d;
      }
    }
    return best <= reachMm;
  };
  for (let k = 1; k < levels.length; k++) {
    const uppers = byLevel.get(levels[k - 1]) ?? [];
    const lowers = byLevel.get(levels[k]) ?? [];
    for (const lo of lowers) {
      for (const up of uppers) {
        if (related(passes[up], passes[lo])) union(up, lo);
      }
    }
  }
  const ids = new Map<number, number>();
  for (let i = 0; i < passes.length; i++) {
    const root = find(i);
    let id = ids.get(root);
    if (id === undefined) {
      id = ids.size;
      ids.set(root, id);
    }
    passes[i].region = id;
  }
}
