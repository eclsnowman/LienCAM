// cam3d L4: ParallelFinishStrategy -- raster (parallel-pass) finishing.
//
// A pure L2/L3 recipe (MISSION layering rule): it consumes ONLY the
// GeometryKernel surface (dropPoints batches), geom2d ring data, and the L5
// path builder. No three-mesh-bvh / clipper2 imports, ever.
//
// Shape of the computation:
// 1. Build the containment region: boundary rings if given, else the part's
//    xy bounds rectangle (passed in by the caller -- the kernel surface has
//    no mesh-bounds query; the op layer owns the PartMesh and its bounds).
// 2. Lay scanlines across the region in a frame rotated by angleDeg
//    (world-space samples, the mesh is never rotated; 0/90/180/270 deg use
//    exact axis vectors so axis-aligned passes are bit-exact).
// 3. Clip each scanline to the region (segments fully outside are dropped,
//    crossing segments clipped) with a deterministic nonzero-winding line
//    clip over the geom2d ring convention (outers CCW, holes CW).
// 4. Sample each clipped span at the chordal step, drop ALL samples of a
//    pass in ONE dropPoints batch (batch boundary, D-005), assemble passes
//    in deterministic (scanline index, span order, param order) order.
// 5. Feed the path builder (zigzag, stay-down links, ramp lead-ins) and
//    wrap the result in the one ToolpathIR format (D-012: dense polylines,
//    no 3D arcs; op-layer mapping to ToolpathMove[] is NOT this layer).

import type { CutterHandle, CutterSpec, GeometryKernel, MeshHandle } from '../kernel/types';
import type { Ring } from '../geom2d';
import { validateRings } from '../geom2d/rings';
import type { ToolpathIR } from '../ir/types';
import { buildLinkedPath, type PathBuildHeights } from '../pathbuild';
import { classifyProbedDrops, probeSeedBelow } from '../kernel/dropClassify';

export type ParallelFinishInput = {
  /** Mesh handle previously uploaded to the SAME kernel. */
  mesh: MeshHandle;
  /** Cutter spec; the strategy makes and releases its own handle. */
  cutter: CutterSpec;
  /** Pass spacing, mm (> 0). */
  stepover: number;
  /** Pass direction, degrees CCW from +X. 0/90/180/270 are exact. */
  angleDeg: number;
  /** Max chordal deviation of the sampled polyline from the surface, mm. */
  tolerance: number;
  /**
   * Material left normal to the sampled 3D cutter-location surface, mm.
   * Zero/undefined preserves the original drop-cutter output byte-for-byte.
   */
  surfaceStockToLeave?: number;
  /**
   * Shallow areas only: 0/undefined = whole part; otherwise discard samples
   * steeper than this angle from horizontal and split passes at each gap.
   */
  maxSlopeDeg?: number;
  /** Lowest cutter-tip Z to finish. Undefined finishes the full surface. */
  minFinishZ?: number;
  /** Containment region (geom2d convention: outers CCW, holes CW). */
  boundary?: readonly Ring[];
  /**
   * Containment fallback when no boundary is given: the part's xy bounds.
   * Required in that case (the L2 kernel surface has no bounds query; the
   * caller owns the PartMesh). Ignored when boundary is present.
   */
  xyBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  heights: PathBuildHeights;
  /** Drop floor / miss value, mm (typically stock bottom or table). */
  zSeed: number;
  /**
   * WO-1271. The region the tool CENTRE may occupy: the containment region
   * dilated outward by the stock-edge overrun, so a round cutter clears the
   * containment edge instead of stopping with its axis on it. Must be a
   * superset of the containment region (geom2d convention). Samples inside
   * it but outside the containment region are OVERRUN samples: they cut
   * whatever the drop cutter finds there and, where it finds nothing (a
   * miss returns zSeed), hold the height of the nearest sample on the same
   * pass that did -- an overrun never plunges to the floor. Scanlines stay
   * anchored to the containment region's extent, so every pass inside it is
   * byte-identical to the same input without this field; the overrun band
   * only adds passes beyond it. Undefined = no overrun (the legacy path).
   */
  overrunBoundary?: readonly Ring[];
};

/** Two coordinates within this of the scanline count as ON it (collinear). */
const COLLINEAR_EPS = 1e-12;
/** Spans shorter than this are degenerate (tangencies) and dropped. */
const MIN_SPAN = 1e-9;

function fail(msg: string): never {
  const error = new Error(`parallelFinish: ${msg}`);
  error.name = 'ParallelFinishError';
  throw error;
}

/**
 * Offset drop-cutter samples along the local 3D surface normal. The normal is
 * derived from deterministic central differences in both X and Y:
 * n = normalize(-dz/dx, -dz/dy, 1). This deliberately moves XY as well as Z;
 * it is not a fake axial allowance.
 */
export function offsetDropSamplesAlongNormals(
  xy: Float64Array,
  centerZ: Float64Array,
  neighborZ: Float64Array,
  derivativeStep: number,
  allowance: number,
): Float64Array {
  const count = xy.length / 2;
  if (centerZ.length !== count) {
    fail(`surface-offset center sample count ${centerZ.length} does not match XY count ${count}`);
  }
  if (neighborZ.length !== count * 4) {
    fail(`surface-offset neighbor sample count ${neighborZ.length} does not match ${count * 4}`);
  }
  if (!(derivativeStep > 0) || !Number.isFinite(derivativeStep)) {
    fail(`invalid surface-normal derivative step ${derivativeStep}`);
  }
  if (!(allowance >= 0) || !Number.isFinite(allowance)) {
    fail(`surfaceStockToLeave must be finite and >= 0, got ${allowance}`);
  }

  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const base = i * 4;
    const dzdx = (neighborZ[base + 1] - neighborZ[base]) / (2 * derivativeStep);
    const dzdy = (neighborZ[base + 3] - neighborZ[base + 2]) / (2 * derivativeStep);
    const invLength = 1 / Math.hypot(dzdx, dzdy, 1);
    out[3 * i] = xy[2 * i] - allowance * dzdx * invLength;
    out[3 * i + 1] = xy[2 * i + 1] - allowance * dzdy * invLength;
    out[3 * i + 2] = centerZ[i] + allowance * invLength;
  }
  return out;
}

/**
 * Keep only shallow samples, splitting at every removed steep span so the
 * linker cannot bridge across a region assigned to a steep-area strategy.
 * The derivative samples are the same samples used by surface-stock offset;
 * callers that need both perform one neighbor drop batch, never two.
 */
export function splitParallelPassByMaxSlope(
  pass: Float64Array,
  neighborZ: Float64Array,
  derivativeStep: number,
  maxSlopeDeg: number,
): Float64Array[] {
  const count = pass.length / 3;
  if (pass.length < 6 || pass.length % 3 !== 0) {
    fail(`cannot slope-filter malformed pass with ${count} points`);
  }
  if (neighborZ.length !== count * 4) {
    fail(`slope-filter neighbor sample count ${neighborZ.length} does not match ${count * 4}`);
  }
  if (!(derivativeStep > 0) || !Number.isFinite(derivativeStep)) {
    fail(`invalid surface-normal derivative step ${derivativeStep}`);
  }
  if (!(maxSlopeDeg > 0) || !(maxSlopeDeg <= 90) || !Number.isFinite(maxSlopeDeg)) {
    fail(`maxSlopeDeg must be finite and in (0, 90], got ${maxSlopeDeg}`);
  }
  if (maxSlopeDeg === 90) return [pass];

  const maxGradient = Math.tan((maxSlopeDeg * Math.PI) / 180);
  const result: Float64Array[] = [];
  let segment: number[] = [];
  const finish = (): void => {
    if (segment.length >= 6) result.push(new Float64Array(segment));
    segment = [];
  };

  for (let i = 0; i < count; i++) {
    const base = i * 4;
    const dzdx = (neighborZ[base + 1] - neighborZ[base]) / (2 * derivativeStep);
    const dzdy = (neighborZ[base + 3] - neighborZ[base + 2]) / (2 * derivativeStep);
    if (Math.hypot(dzdx, dzdy) <= maxGradient) {
      segment.push(pass[3 * i], pass[3 * i + 1], pass[3 * i + 2]);
    } else {
      finish();
    }
  }
  finish();
  return result;
}

type FilteredPassTrack = {
  passes: Float64Array[];
  lastRow: number;
  tMin: number;
  tMax: number;
};

function passTRange(pass: Float64Array, ux: number, uy: number): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pass.length; i += 3) {
    const t = pass[i] * ux + pass[i + 1] * uy;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return [min, max];
}

/**
 * Keep slope-filtered pieces from adjacent scanlines next to each other in the
 * linker input. Flattening every row first presents the removed steep span as
 * the next candidate and strands the corresponding shallow piece on the next
 * row. Tracks change only candidate order; buildLinkedPath still proves or
 * refuses every individual connector.
 */
function orderFilteredPassTracks(
  rows: readonly (readonly Float64Array[])[],
  ux: number,
  uy: number,
  stepover: number,
): Float64Array[] {
  const tracks: FilteredPassTrack[] = [];
  for (let row = 0; row < rows.length; row++) {
    const claimed = new Set<number>();
    for (const pass of rows[row]) {
      const [tMin, tMax] = passTRange(pass, ux, uy);
      let bestTrack = -1;
      let bestOverlap = -Infinity;
      let bestGap = Infinity;
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        if (track.lastRow !== row - 1 || claimed.has(i)) continue;
        const overlap = Math.min(tMax, track.tMax) - Math.max(tMin, track.tMin);
        const gap = overlap >= 0
          ? 0
          : Math.max(tMin, track.tMin) - Math.min(tMax, track.tMax);
        if (gap > 2 * stepover + MIN_SPAN) continue;
        if (overlap > bestOverlap || (overlap === bestOverlap && gap < bestGap)) {
          bestTrack = i;
          bestOverlap = overlap;
          bestGap = gap;
        }
      }
      if (bestTrack < 0) {
        tracks.push({ passes: [pass], lastRow: row, tMin, tMax });
      } else {
        const track = tracks[bestTrack];
        track.passes.push(pass);
        track.lastRow = row;
        track.tMin = tMin;
        track.tMax = tMax;
        claimed.add(bestTrack);
      }
    }
  }
  return tracks.flatMap(track => track.passes);
}

function appendPoint(points: number[], x: number, y: number, z: number): void {
  const n = points.length;
  if (n >= 3 && points[n - 3] === x && points[n - 2] === y && points[n - 1] === z) return;
  points.push(x, y, z);
}

/**
 * Clip and split sampled finish passes at a lowest-Z plane. Intersections are
 * linearly inserted so a pass never silently jumps across the requested limit.
 */
export function clipParallelPassesAtMinZ(
  passes: readonly Float64Array[],
  minFinishZ: number,
): Float64Array[] {
  if (!Number.isFinite(minFinishZ)) fail(`minFinishZ must be finite, got ${minFinishZ}`);
  const clipped: Float64Array[] = [];

  const finish = (points: number[]): void => {
    if (points.length >= 6) clipped.push(new Float64Array(points));
    points.length = 0;
  };

  for (const pass of passes) {
    if (pass.length < 6 || pass.length % 3 !== 0) {
      fail(`cannot depth-clip malformed pass with ${pass.length / 3} points`);
    }
    let segment: number[] = [];
    let ax = pass[0];
    let ay = pass[1];
    let az = pass[2];
    let aInside = az >= minFinishZ;
    if (aInside) appendPoint(segment, ax, ay, az);

    for (let i = 1; i < pass.length / 3; i++) {
      const bx = pass[3 * i];
      const by = pass[3 * i + 1];
      const bz = pass[3 * i + 2];
      const bInside = bz >= minFinishZ;

      if (aInside !== bInside) {
        const t = (minFinishZ - az) / (bz - az);
        const ix = ax + t * (bx - ax);
        const iy = ay + t * (by - ay);
        if (aInside) {
          appendPoint(segment, ix, iy, minFinishZ);
          finish(segment);
        } else {
          appendPoint(segment, ix, iy, minFinishZ);
        }
      }
      if (bInside) appendPoint(segment, bx, by, bz);

      ax = bx;
      ay = by;
      az = bz;
      aInside = bInside;
    }
    finish(segment);
  }
  return clipped;
}

/**
 * Uniform chordal samples of the span [t0, t1]: nSeg = ceil(len / step)
 * segments, t = t0 + len * i / nSeg. The legacy whole-span sampling and the
 * WO-1271 overrun segments share this ONE formula so an in-region span
 * samples bit-identically whether or not an overrun band surrounds it.
 */
export function spanSamples(
  t0: number,
  t1: number,
  step: number,
  includeStart: boolean,
  includeEnd: boolean,
): number[] {
  const len = t1 - t0;
  const nSeg = Math.max(1, Math.ceil(len / step - 1e-9));
  const out: number[] = [];
  for (let i = includeStart ? 0 : 1; i <= (includeEnd ? nSeg : nSeg - 1); i++) {
    out.push(t0 + (len * i) / nSeg);
  }
  return out;
}

/**
 * WO-1279. Pass samples are probed below the drop floor so a MISS is a value
 * no real contact can produce; the rule lives beside the kernel contract
 * (kernel/dropClassify.ts, shared with scallop since WO-1281). Re-exported
 * here for the strategy's own tests.
 */
export { MISS_PROBE_MARGIN_MM } from '../kernel/dropClassify';

/**
 * WO-1279. A run end cut short by a miss is refined by bisection between the
 * last hit and the first miss until the gap is this small, so the pass ends
 * at tangency with the part silhouette instead of up to one chord step short
 * of it (which would leave a smaller edition of the WO-1271 wedge).
 */
const MISS_REFINE_TOLERANCE_MM = 0.01;
const MISS_REFINE_MAX_ITERATIONS = 10;

/**
 * WO-1279. Classify a batch of drop-cutter samples: `z` holds the heights a
 * probe at `zSeed` would have returned (bit-identical: hits are the contact
 * height, misses are exactly zSeed) and `hit[i]` says whether anything lay
 * under the footprint at all. Probing one millimetre below the floor is what
 * makes the two distinguishable; the kernel's own contract cannot.
 *
 * The point-list wrapper around kernel/dropClassify.ts. WO-1279 deferred the
 * rule's home until a second consumer existed; WO-1281 (scallop, a grid
 * consumer) decided it: the RULE lives beside the kernel contract, and each
 * consumer keeps a wrapper of its own shape.
 */
export async function dropPointsClassified(
  kernel: GeometryKernel,
  mesh: MeshHandle,
  cutter: CutterHandle,
  xy: Float64Array,
  zSeed: number,
  signal?: AbortSignal,
): Promise<{ z: Float64Array; hit: Uint8Array }> {
  const probed = await kernel.dropPoints(mesh, cutter, xy, probeSeedBelow(zSeed), { signal });
  return classifyProbedDrops(probed, zSeed);
}

/**
 * WO-1271 miss-hold. An overrun sample whose drop MISSED (z <= zSeed, the
 * kernel's miss value) takes the height of the nearest sample on the pass
 * that hit, so the cutter holds the surface height it just left instead of
 * plunging to the floor beyond the edge. Only overrun samples are ever
 * rewritten; in-region samples keep the kernel's answer untouched. Returns
 * false when the whole pass missed (nothing to cut: the caller drops it).
 * `neighborZ` (4 probes per sample, when present) is patched the same way
 * so a surface normal at the edge is level, not a cliff into the miss.
 */
export function holdOverrunMisses(
  z: Float64Array,
  overrun: Uint8Array,
  zSeed: number,
  neighborZ?: Float64Array,
): boolean {
  const n = z.length;
  const hit: number[] = [];
  for (let i = 0; i < n; i++) if (z[i] > zSeed) hit.push(i);
  if (hit.length === 0) return false;
  for (let i = 0; i < n; i++) {
    if (overrun[i] === 0) continue;
    if (z[i] <= zSeed) {
      let best = hit[0];
      let bestDist = Math.abs(hit[0] - i);
      for (const h of hit) {
        const d = Math.abs(h - i);
        if (d < bestDist) {
          best = h;
          bestDist = d;
        }
      }
      z[i] = z[best];
    }
    if (neighborZ !== undefined) {
      for (let j = 0; j < 4; j++) {
        if (neighborZ[4 * i + j] <= zSeed) neighborZ[4 * i + j] = z[i];
      }
    }
  }
  return true;
}

/** WO-1615. Refinement stops splitting at this many levels (a safety bound). */
const CHORD_REFINE_MAX_LEVELS = 20;

/**
 * WO-1615. Refine a sampled pass until no chord between neighbouring samples
 * runs off the cutter-location surface by more than the tolerance. The
 * chordal step assumes curvature radius >= the cutter radius, which a concave
 * corner breaks: next to a wall the drop height jumps from the floor to the
 * rim within a fraction of a step, and the straight chord across that jump
 * drove the ball sideways into the wall (SH-7, tray: 1.1 mm into the part).
 *
 * Each chord's quarter points are dropped (one batch per level); a chord with
 * any of them more than the tolerance off the chord is split at its middle.
 * Splitting stops once a chord is no wider than a tenth of the tolerance in
 * XY: across a vertical cliff that chord reaches at most that far sideways.
 * Every inserted point is a true drop point. A probe that misses the mesh is
 * not judged (nothing under it to cut). Returns the input arrays untouched
 * when nothing needed refining.
 */
export async function refinePassChords(
  xy: Float64Array,
  z: Float64Array,
  drop: (xy: Float64Array) => Promise<Float64Array>,
  tolerance: number,
  zSeed: number,
): Promise<{ xy: Float64Array; z: Float64Array; inserted: number }> {
  type Seg = {
    ax: number; ay: number; az: number;
    bx: number; by: number; bz: number;
    /** The midpoint and its drop height, when an earlier level already probed it. */
    m?: [number, number, number];
    left?: Seg; right?: Seg;
  };
  // The chordal step already holds a surface that curves no tighter than the
  // cutter to this deviation, so a smooth surface is never split; only where
  // that assumption breaks (a crease or a cliff) does a chord fail it.
  const limit = tolerance;
  const minGap = tolerance / 10;
  const roots: Seg[] = [];
  for (let i = 0; i + 1 < z.length; i++) {
    roots.push({
      ax: xy[2 * i], ay: xy[2 * i + 1], az: z[i],
      bx: xy[2 * i + 2], by: xy[2 * i + 3], bz: z[i + 1],
    });
  }
  const at = (s: Seg, t: number): [number, number] => [s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t];
  let pending = roots.filter(s => Math.hypot(s.bx - s.ax, s.by - s.ay) > minGap);
  let inserted = 0;
  for (let level = 0; level < CHORD_REFINE_MAX_LEVELS && pending.length > 0; level++) {
    // Quarter, mid and three-quarter points of every chord in one batch: a
    // midpoint alone passes an S-shaped wall profile whose middle happens to
    // sit on the chord. The quarter points become the children's midpoints.
    const sampleXY = new Float64Array(pending.length * 6);
    for (let q = 0; q < pending.length; q++) {
      for (let k = 0; k < 3; k++) {
        const [x, y] = at(pending[q], (k + 1) / 4);
        sampleXY[6 * q + 2 * k] = x;
        sampleXY[6 * q + 2 * k + 1] = y;
      }
    }
    const sampleZ = await drop(sampleXY);
    const next: Seg[] = [];
    for (let q = 0; q < pending.length; q++) {
      const s = pending[q];
      const z1 = sampleZ[3 * q];
      const zm = s.m?.[2] ?? sampleZ[3 * q + 1];
      const z3 = sampleZ[3 * q + 2];
      const off = (zz: number, t: number): boolean =>
        zz > zSeed && Math.abs(zz - (s.az + (s.bz - s.az) * t)) > limit;
      if (!(zm > zSeed) || !(off(z1, 0.25) || off(zm, 0.5) || off(z3, 0.75))) continue;
      // Split exactly where the heights were probed, so every point is a true drop.
      const mx = s.m?.[0] ?? sampleXY[6 * q + 2];
      const my = s.m?.[1] ?? sampleXY[6 * q + 3];
      const q1: [number, number, number] = [sampleXY[6 * q], sampleXY[6 * q + 1], z1];
      const q3: [number, number, number] = [sampleXY[6 * q + 4], sampleXY[6 * q + 5], z3];
      s.left = { ax: s.ax, ay: s.ay, az: s.az, bx: mx, by: my, bz: zm, ...(z1 > zSeed ? { m: q1 } : {}) };
      s.right = { ax: mx, ay: my, az: zm, bx: s.bx, by: s.by, bz: s.bz, ...(z3 > zSeed ? { m: q3 } : {}) };
      inserted++;
      for (const child of [s.left, s.right]) {
        if (Math.hypot(child.bx - child.ax, child.by - child.ay) > minGap) next.push(child);
      }
    }
    pending = next;
  }
  if (inserted === 0) return { xy, z, inserted };

  const outXY: number[] = [xy[0], xy[1]];
  const outZ: number[] = [z[0]];
  const emit = (s: Seg): void => {
    if (s.left !== undefined && s.right !== undefined) {
      emit(s.left);
      emit(s.right);
      return;
    }
    outXY.push(s.bx, s.by);
    outZ.push(s.bz);
  };
  for (const s of roots) emit(s);
  return { xy: Float64Array.from(outXY), z: Float64Array.from(outZ), inserted };
}

/**
 * Rotated sampling frame: u = pass direction, v = stepover direction
 * (u rotated +90 deg). Multiples of 90 deg return exact axis vectors so
 * axis-aligned scanlines produce bit-exact axis coordinates.
 */
function frameFor(angleDeg: number): { ux: number; uy: number; vx: number; vy: number } {
  const a = ((angleDeg % 360) + 360) % 360;
  if (a === 0) return { ux: 1, uy: 0, vx: 0, vy: 1 };
  if (a === 90) return { ux: 0, uy: 1, vx: -1, vy: 0 };
  if (a === 180) return { ux: -1, uy: 0, vx: 0, vy: -1 };
  if (a === 270) return { ux: 0, uy: -1, vx: 1, vy: 0 };
  const rad = (a * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { ux: c, uy: s, vx: -s, vy: c };
}

/**
 * Clip the scanline { world = t*u + vk*v : t in R } to the region enclosed
 * by `rings` (nonzero winding; outers CCW, holes CW). Returns merged,
 * ascending, disjoint [t0, t1] spans. Deterministic: fixed edge iteration
 * order, index-stable sort keys.
 *
 * Vertex-on-line robustness: a point with signed offset s = 0 is classified
 * on the <= side (half-open rule), so a boundary passing through a vertex
 * crosses exactly once and a tangent vertex yields a zero-width span
 * (dropped by MIN_SPAN downstream). Edges lying ON the line (both |s| <=
 * eps) are collected as forced spans so a boundary edge coinciding with an
 * extreme scanline still produces its pass.
 */
function clipScanline(
  rings: readonly Ring[],
  ux: number,
  uy: number,
  vx: number,
  vy: number,
  vk: number,
): Array<[number, number]> {
  const crossT: number[] = [];
  const crossDir: number[] = [];
  const spans: Array<[number, number]> = [];
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[2 * j];
      const ay = ring[2 * j + 1];
      const bx = ring[2 * i];
      const by = ring[2 * i + 1];
      const sa = ax * vx + ay * vy - vk;
      const sb = bx * vx + by * vy - vk;
      const ta = ax * ux + ay * uy;
      const tb = bx * ux + by * uy;
      if (Math.abs(sa) <= COLLINEAR_EPS && Math.abs(sb) <= COLLINEAR_EPS) {
        spans.push(ta <= tb ? [ta, tb] : [tb, ta]);
        continue;
      }
      const aBelow = sa <= 0;
      const bBelow = sb <= 0;
      if (aBelow === bBelow) continue;
      const lam = sa / (sa - sb);
      // Downward crossing (above -> below/eq) winds +1 for a CCW outer:
      // sweeping t ascending, inside spans carry nonzero accumulated winding.
      crossT.push(ta + lam * (tb - ta));
      crossDir.push(aBelow ? -1 : 1);
    }
  }
  const order: number[] = crossT.map((_, i) => i);
  order.sort((a, b) => crossT[a] - crossT[b] || crossDir[a] - crossDir[b] || a - b);
  let w = 0;
  let start = 0;
  for (const idx of order) {
    const t = crossT[idx];
    const wNext = w + crossDir[idx];
    if (w === 0 && wNext !== 0) start = t;
    else if (w !== 0 && wNext === 0) spans.push([start, t]);
    w = wNext;
  }
  // Merge winding spans with collinear-edge spans (and each other).
  spans.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s[0] <= last[1] + MIN_SPAN) {
      if (s[1] > last[1]) last[1] = s[1];
    } else {
      merged.push([s[0], s[1]]);
    }
  }
  return merged;
}

function cutterIdOf(spec: CutterSpec): string {
  switch (spec.kind) {
    case 'flat':
    case 'ball':
      return `${spec.kind}-d${spec.diameter}`;
    case 'bull':
      return `bull-d${spec.diameter}-cr${spec.cornerRadius}`;
    case 'vbit':
      return `vbit-d${spec.diameter}-a${spec.angleFromAxisDeg}`;
  }
}

/**
 * Parallel finishing over the containment region. Returns the IR program;
 * deterministic for identical inputs (D-006).
 */
export async function parallelFinish(
  kernel: GeometryKernel,
  input: ParallelFinishInput,
  opts?: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<ToolpathIR> {
  const { mesh, cutter, stepover, angleDeg, tolerance, heights, zSeed } = input;
  const surfaceStockToLeave = input.surfaceStockToLeave ?? 0;
  const maxSlopeDeg = input.maxSlopeDeg ?? 0;
  if (!(stepover > 0) || !Number.isFinite(stepover)) fail(`invalid stepover ${stepover}`);
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) fail(`invalid tolerance ${tolerance}`);
  if (!Number.isFinite(angleDeg)) fail(`non-finite angleDeg ${angleDeg}`);
  if (!Number.isFinite(zSeed)) fail(`non-finite zSeed ${zSeed}`);
  if (!(surfaceStockToLeave >= 0) || !Number.isFinite(surfaceStockToLeave)) {
    fail(`surfaceStockToLeave must be finite and >= 0, got ${surfaceStockToLeave}`);
  }
  if (!(maxSlopeDeg >= 0) || !(maxSlopeDeg <= 90) || !Number.isFinite(maxSlopeDeg)) {
    fail(`maxSlopeDeg must be finite and in [0, 90], got ${maxSlopeDeg}`);
  }
  if (input.minFinishZ !== undefined && !Number.isFinite(input.minFinishZ)) {
    fail(`minFinishZ must be finite when provided, got ${input.minFinishZ}`);
  }
  if (!(cutter.diameter > 0) || !Number.isFinite(cutter.diameter)) {
    fail(`invalid cutter diameter ${cutter.diameter}`);
  }

  // Containment rings: boundary, else the xy-bounds rectangle (CCW outer).
  let rings: readonly Ring[];
  if (input.boundary !== undefined) {
    validateRings(input.boundary, 'parallelFinish boundary');
    rings = input.boundary;
  } else {
    const b = input.xyBounds;
    if (b === undefined) {
      fail('either boundary or xyBounds is required (kernel has no mesh-bounds query)');
    }
    if (!(b.minX < b.maxX) || !(b.minY < b.maxY)) {
      fail(`degenerate xyBounds [${b.minX}, ${b.maxX}] x [${b.minY}, ${b.maxY}]`);
    }
    rings = [new Float64Array([b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY])];
  }

  // WO-1271: the tool-centre region. Undefined keeps the legacy path literally
  // unchanged (centreRings IS rings, and no sample is ever flagged overrun).
  const overrunRings = input.overrunBoundary;
  if (overrunRings !== undefined) validateRings(overrunRings, 'parallelFinish overrunBoundary');
  const centreRings: readonly Ring[] = overrunRings ?? rings;

  const { ux, uy, vx, vy } = frameFor(angleDeg);
  const vRange = (set: readonly Ring[]): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const ring of set) {
      for (let i = 0; i < ring.length; i += 2) {
        const v = ring[i] * vx + ring[i + 1] * vy;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return [lo, hi];
  };
  // Scanlines are anchored on the CONTAINMENT extent (vmin), never on the
  // centre region's, so an overrun band changes no interior pass position.
  const [vmin, vmax] = vRange(rings);
  const [vminC, vmaxC] = overrunRings !== undefined ? vRange(centreRings) : [vmin, vmax];

  // Chordal sampling step along a pass. Finishing a surface whose local
  // curvature radius is >= the cutter radius R (the regime a finish cutter
  // actually follows), a chord of length s deviates from the arc by
  // ~ s^2 / (8 * rho) with rho >= R, so requiring deviation <= tolerance
  // gives   step <= sqrt(8 * tolerance * R),
  // clamped to [tolerance, stepover]: never finer than the tolerance itself
  // (point counts explode for no fidelity gain) and never coarser than one
  // stepover (a pass should sample at least as densely as passes are spaced).
  const cutterR = cutter.diameter / 2;
  const step = Math.min(Math.max(Math.sqrt(8 * tolerance * cutterR), tolerance), stepover);

  const scanlineCount = Math.floor((vmax - vmin) / stepover + 1e-9) + 1;
  // WO-1271: extra scanlines on the SAME vmin + k * stepover lattice, k < 0
  // below the containment and k >= scanlineCount above it, as far as the
  // centre region reaches. Legacy: kFirst = 0, kLast = scanlineCount - 1.
  const kFirst = overrunRings === undefined ? 0 : -Math.floor((vmin - vminC) / stepover + 1e-9);
  const kLast = overrunRings === undefined
    ? scanlineCount - 1
    : Math.floor((vmaxC - vmin) / stepover + 1e-9);
  const scanlineTotal = kLast - kFirst + 1;
  let overrunPassesDropped = 0;
  // WO-1279 accounting: in-region samples that missed the mesh and were not
  // emitted, run ends refined to tangency, and runs dropped for holding no hit.
  let skippedSamples = 0;
  let refinedEnds = 0;
  let emptyRunsDropped = 0;
  // WO-1615: points inserted so no chord cuts below the drop surface.
  let refinedChords = 0;
  const cutterH = kernel.makeCutter(cutter);
  try {
    const normalStep = Math.max(tolerance, Math.min(stepover / 4, cutterR / 4));
    const sampleNeighborZ = async (xy: Float64Array): Promise<Float64Array> => {
      const neighborXY = new Float64Array(xy.length * 4);
      for (let i = 0; i < xy.length / 2; i++) {
        const x = xy[2 * i];
        const y = xy[2 * i + 1];
        const base = i * 8;
        neighborXY[base] = x - normalStep;
        neighborXY[base + 1] = y;
        neighborXY[base + 2] = x + normalStep;
        neighborXY[base + 3] = y;
        neighborXY[base + 4] = x;
        neighborXY[base + 5] = y - normalStep;
        neighborXY[base + 6] = x;
        neighborXY[base + 7] = y + normalStep;
      }
      return kernel.dropPoints(
        mesh,
        cutterH,
        neighborXY,
        zSeed,
        { signal: opts?.signal },
      );
    };
    const offsetPass = (
      xy: Float64Array,
      centerZ: Float64Array,
      neighborZ: Float64Array,
    ): Float64Array => {
      return offsetDropSamplesAlongNormals(
        xy,
        centerZ,
        neighborZ,
        normalStep,
        surfaceStockToLeave,
      );
    };
    const sampleOffsetSurfaceZ = async (xy: Float64Array): Promise<Float64Array> => {
      const centerZ = await kernel.dropPoints(mesh, cutterH, xy, zSeed, { signal: opts?.signal });
      if (surfaceStockToLeave === 0) return centerZ;
      const offset = offsetPass(xy, centerZ, await sampleNeighborZ(xy));
      const z = new Float64Array(centerZ.length);
      for (let i = 0; i < z.length; i++) z[i] = offset[3 * i + 2];
      return z;
    };

    // Deterministic pass assembly: scanline index ascending, span order
    // ascending (clipScanline returns sorted spans), param order ascending.
    // Zigzag direction alternation is the path builder's job.
    const passes: Float64Array[] = [];
    const filteredRows: Float64Array[][] = [];
    for (let k = kFirst; k <= kLast; k++) {
      const filteredRow: Float64Array[] = [];
      const vk = vmin + k * stepover;
      const spans = clipScanline(centreRings, ux, uy, vx, vy, vk);
      // WO-1271: the containment spans on this scanline, to tell in-region
      // samples from overrun ones. Legacy (no overrun): centreRings IS rings.
      const innerSpans = overrunRings === undefined ? spans : clipScanline(rings, ux, uy, vx, vy, vk);
      for (const [t0, t1] of spans) {
        const len = t1 - t0;
        if (len < MIN_SPAN) continue; // tangency: no material span
        // Sample parameters along the pass and an overrun flag per sample.
        // Legacy: one uniform span, nothing flagged. Overrun: each in-region
        // span inside [t0, t1] samples EXACTLY as the legacy path would, and
        // the gaps before, between and after them sample at the same chord
        // step with their shared endpoints owned by the in-region span.
        let ts: number[];
        const flags: number[] = [];
        if (overrunRings === undefined) {
          ts = spanSamples(t0, t1, step, true, true);
          for (let i = 0; i < ts.length; i++) flags.push(0);
        } else {
          ts = [];
          const parts = innerSpans.filter(
            ([a, b]) => a >= t0 - MIN_SPAN && b <= t1 + MIN_SPAN && b - a >= MIN_SPAN,
          );
          let cursor = t0;
          let atStart = true;
          for (const [a, b] of parts) {
            if (a - cursor > MIN_SPAN) {
              for (const t of spanSamples(cursor, a, step, atStart, false)) {
                ts.push(t);
                flags.push(1);
              }
            }
            for (const t of spanSamples(a, b, step, true, true)) {
              ts.push(t);
              flags.push(0);
            }
            cursor = b;
            atStart = false;
          }
          if (t1 - cursor > MIN_SPAN) {
            for (const t of spanSamples(cursor, t1, step, atStart, true)) {
              ts.push(t);
              flags.push(1);
            }
          }
        }
        const nPts = ts.length;
        if (nPts < 2) continue;
        const xy = new Float64Array(nPts * 2);
        for (let i = 0; i < nPts; i++) {
          const t = ts[i];
          xy[2 * i] = t * ux + vk * vx;
          xy[2 * i + 1] = t * uy + vk * vy;
        }
        // ONE drop batch per pass (batched boundary, D-005 spirit). The
        // signal (if any) is threaded so a cancel aborts between batches --
        // kernels honor it per the L2 contract. WO-1279: probed below the
        // floor so a miss is known as a miss; `z` is bit-identical to a probe
        // at zSeed (hits are contact heights, misses are exactly zSeed).
        const { z, hit } = await dropPointsClassified(kernel, mesh, cutterH, xy, zSeed, opts?.signal);
        let neighborZ: Float64Array | undefined;
        if (surfaceStockToLeave > 0 || maxSlopeDeg > 0) {
          neighborZ = await sampleNeighborZ(xy);
        }
        if (overrunRings !== undefined) {
          // WO-1271: OUTSIDE the containment, a miss holds the nearest surface
          // height (the overrun band exists to reach the edge, and its samples
          // sit at most a radius from part). This rule never touches an
          // in-region sample.
          const overrun = Uint8Array.from(flags);
          if (!holdOverrunMisses(z, overrun, zSeed, neighborZ)) {
            // Every sample missed: a pass wholly beyond the part. Nothing to
            // cut there, so it is dropped rather than driven along the floor.
            overrunPassesDropped++;
            continue;
          }
        }
        // WO-1279: INSIDE the containment, a miss is not a cut. A finish cuts
        // only where the cutter meets the part: an in-region sample with
        // nothing under the footprint is skipped, the pass splits there, and
        // a run that holds no true hit (an overrun tail left stranded beyond
        // a skipped margin) is dropped. The two rules above and here pull in
        // opposite directions on purpose and are kept apart on purpose.
        const skip = new Uint8Array(nPts);
        for (let i = 0; i < nPts; i++) {
          if (flags[i] === 0 && hit[i] === 0) {
            skip[i] = 1;
            skippedSamples++;
          }
        }
        // Runs of consecutive kept samples, each with its own refined ends.
        type Run = { a: number; b: number; head?: [number, number]; tail?: [number, number] };
        const runs: Run[] = [];
        for (let i = 0; i < nPts; i++) {
          if (skip[i] === 1) continue;
          let j = i;
          while (j + 1 < nPts && skip[j + 1] === 0) j++;
          let anyHit = false;
          for (let q = i; q <= j && !anyHit; q++) anyHit = hit[q] === 1;
          if (anyHit) runs.push({ a: i, b: j });
          else emptyRunsDropped++;
          i = j;
        }
        // Refine every run end that a skipped miss cut short: bisect between
        // the last hit and the first miss (all pending ends of this pass in
        // one probe batch per iteration) until the gap is MISS_REFINE_TOLERANCE_MM.
        type Pending = { run: Run; side: 'head' | 'tail'; tHit: number; tMiss: number; zHit: number };
        const pending: Pending[] = [];
        for (const run of runs) {
          if (run.a > 0 && skip[run.a - 1] === 1 && hit[run.a] === 1) {
            pending.push({ run, side: 'head', tHit: ts[run.a], tMiss: ts[run.a - 1], zHit: z[run.a] });
          }
          if (run.b + 1 < nPts && skip[run.b + 1] === 1 && hit[run.b] === 1) {
            pending.push({ run, side: 'tail', tHit: ts[run.b], tMiss: ts[run.b + 1], zHit: z[run.b] });
          }
        }
        for (let iter = 0; iter < MISS_REFINE_MAX_ITERATIONS && pending.length > 0; iter++) {
          const live = pending.filter(p => Math.abs(p.tHit - p.tMiss) > MISS_REFINE_TOLERANCE_MM);
          if (live.length === 0) break;
          const mid = new Float64Array(live.length * 2);
          const tMid = new Float64Array(live.length);
          for (let q = 0; q < live.length; q++) {
            const t = (live[q].tHit + live[q].tMiss) / 2;
            tMid[q] = t;
            mid[2 * q] = t * ux + vk * vx;
            mid[2 * q + 1] = t * uy + vk * vy;
          }
          const probe = await dropPointsClassified(kernel, mesh, cutterH, mid, zSeed, opts?.signal);
          for (let q = 0; q < live.length; q++) {
            if (probe.hit[q] === 1) {
              live[q].tHit = tMid[q];
              live[q].zHit = probe.z[q];
            } else {
              live[q].tMiss = tMid[q];
            }
          }
        }
        for (const p of pending) {
          const original = p.side === 'head' ? ts[p.run.a] : ts[p.run.b];
          if (Math.abs(p.tHit - original) <= 1e-12) continue; // nothing gained
          p.run[p.side] = [p.tHit, p.zHit];
          refinedEnds++;
        }
        // Neighbour probes for the refined points (normals for allowance / slope).
        let refinedNeighborZ: Float64Array | undefined;
        const refinedXY: number[] = [];
        if (neighborZ !== undefined) {
          for (const run of runs) {
            for (const end of [run.head, run.tail]) {
              if (end === undefined) continue;
              refinedXY.push(end[0] * ux + vk * vx, end[0] * uy + vk * vy);
            }
          }
          if (refinedXY.length > 0) refinedNeighborZ = await sampleNeighborZ(Float64Array.from(refinedXY));
        }
        let refinedIndex = 0;
        for (const run of runs) {
          const count = run.b - run.a + 1 + (run.head ? 1 : 0) + (run.tail ? 1 : 0);
          const rxy = new Float64Array(count * 2);
          const rz = new Float64Array(count);
          const rn = neighborZ !== undefined ? new Float64Array(count * 4) : undefined;
          let w = 0;
          const put = (x: number, y: number, zz: number, nb: Float64Array | undefined, nbOffset: number): void => {
            rxy[2 * w] = x;
            rxy[2 * w + 1] = y;
            rz[w] = zz;
            if (rn !== undefined && nb !== undefined) for (let q = 0; q < 4; q++) rn[4 * w + q] = nb[nbOffset + q];
            w++;
          };
          if (run.head) {
            put(run.head[0] * ux + vk * vx, run.head[0] * uy + vk * vy, run.head[1], refinedNeighborZ, 4 * refinedIndex);
            refinedIndex++;
          }
          for (let i = run.a; i <= run.b; i++) put(xy[2 * i], xy[2 * i + 1], z[i], neighborZ, 4 * i);
          if (run.tail) {
            put(run.tail[0] * ux + vk * vx, run.tail[0] * uy + vk * vy, run.tail[1], refinedNeighborZ, 4 * refinedIndex);
            refinedIndex++;
          }
          if (count < 2) continue;
          // WO-1615: no chord between samples may cut below the drop surface.
          const refined = await refinePassChords(
            rxy,
            rz,
            (mid) => kernel.dropPoints(mesh, cutterH, mid, zSeed, { signal: opts?.signal }),
            tolerance,
            zSeed,
          );
          refinedChords += refined.inserted;
          const px = refined.xy;
          const pz = refined.z;
          let pn: Float64Array | undefined = rn;
          if (rn !== undefined && refined.inserted > 0) {
            const reprobed = await sampleNeighborZ(px);
            // The overrun miss-hold, applied to the re-probed neighbours too.
            if (overrunRings !== undefined) {
              for (let i = 0; i < reprobed.length; i++) if (reprobed[i] <= zSeed) reprobed[i] = pz[i >> 2];
            }
            pn = reprobed;
          }
          const pCount = pz.length;
          let pass: Float64Array;
          if (surfaceStockToLeave === 0) {
            // Keep the legacy path structurally identical for byte-compatible output.
            pass = new Float64Array(pCount * 3);
            for (let i = 0; i < pCount; i++) {
              pass[3 * i] = px[2 * i];
              pass[3 * i + 1] = px[2 * i + 1];
              pass[3 * i + 2] = pz[i];
            }
          } else {
            pass = offsetPass(px, pz, pn!);
          }
          if (maxSlopeDeg > 0) {
            const pieces = splitParallelPassByMaxSlope(pass, pn!, normalStep, maxSlopeDeg);
            passes.push(...pieces);
            filteredRow.push(...pieces);
          } else {
            passes.push(pass);
            filteredRow.push(pass);
          }
        }
      }
      filteredRows.push(filteredRow);
      // Coarse progress over the scan phase (the bulk of the work); linking
      // is the remaining tail. Scaled to 0.9 so the caller can post a final
      // 1.0 after the whole op settles.
      opts?.onProgress?.((0.9 * (k - kFirst + 1)) / scanlineTotal);
    }
    if (passes.length === 0) {
      if (skippedSamples > 0 || overrunPassesDropped > 0) {
        fail(
          'the containment region has no part surface under it: every sample missed the mesh. ' +
            'Nothing to finish there; check the stock outline and the part placement.',
        );
      }
      fail('containment region produced no passes (boundary empty or degenerate)');
    }
    // Track ordering keeps split pieces on adjacent scanlines next to each
    // other in the linker input: the slope filter's pieces (WO-1190 era) and,
    // WO-1279, runs split around a skipped margin or a nest gap. A row with
    // one unsplit pass per scanline orders identically either way, but the
    // legacy path is kept literally on `passes`.
    const orderedPasses = maxSlopeDeg > 0 || skippedSamples > 0
      ? orderFilteredPassTracks(filteredRows, ux, uy, stepover)
      : passes;
    const finishPasses = input.minFinishZ === undefined
      ? orderedPasses
      : clipParallelPassesAtMinZ(orderedPasses, input.minFinishZ);
    if (finishPasses.length === 0) {
      fail(
        `finish depth limit minZ=${input.minFinishZ} removed every surface pass; ` +
        `lower the limit or leave it blank`,
      );
    }

    const link = (group: readonly Float64Array[]) => buildLinkedPath(
      group,
      heights,
      // rampAngleDeg 10 / zigzag true / stay-down deviation defaults.
      // cutterContactRadiusMm (WO-127) is the stay-down CLEARED-TERRITORY
      // proof, not a tuning knob: cutting a pass sweeps the tool body through a
      // corridor of this radius, and a link that stays inside it runs over
      // ground this very cutter just cut. cutterR is diameter / 2 (line ~337).
      { stepover, cutterContactRadiusMm: cutterR },
      sampleOffsetSurfaceZ,
    );
    const moves = await link(finishPasses);

    return {
      moves,
      meta: {
        strategyId: 'parallel_finish',
        cutterId: cutterIdOf(cutter),
        params: {
          stepover,
          angleDeg,
          tolerance,
          zSeed,
          clearanceZ: heights.clearanceZ,
          retractZ: heights.retractZ,
          sampleStep: step,
          boundaryRingCount: input.boundary !== undefined ? input.boundary.length : 0,
          // WO-1271: recorded ONLY when an overrun band was asked for, so the
          // legacy fingerprint is untouched.
          ...(overrunRings !== undefined
            ? { overrunRingCount: overrunRings.length, overrunPassesDropped }
            : {}),
          // WO-1279: recorded ONLY when a miss was skipped, so a region-filling
          // part keeps its legacy fingerprint.
          ...(skippedSamples > 0 ? { skippedSamples, refinedEnds, emptyRunsDropped } : {}),
          // WO-1615: recorded ONLY when a chord was refined.
          ...(refinedChords > 0 ? { refinedChords } : {}),
          // WO-127: recorded ONLY when the caller proved a material top, so an
          // unproven run is visibly missing the key rather than carrying a
          // number nobody proved (and existing IR fingerprints are unchanged).
          ...(heights.materialTopZ !== undefined ? { materialTopZ: heights.materialTopZ } : {}),
          ...(surfaceStockToLeave > 0 ? { surfaceStockToLeave, normalStep } : {}),
          ...(maxSlopeDeg > 0 ? { maxSlopeDeg, normalStep } : {}),
          ...(input.minFinishZ !== undefined ? { minFinishZ: input.minFinishZ } : {}),
        },
      },
    };
  } finally {
    kernel.releaseCutter(cutterH);
  }
}
