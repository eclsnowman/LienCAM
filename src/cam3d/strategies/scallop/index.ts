// Constant-scallop finishing: contour a geodesic distance field over the
// cutter-location surface, then hand every contour to the shared path builder.

import type { CutterSpec, GeometryKernel, MeshHandle } from '../../kernel/types';
import type { Ring } from '../../geom2d';
import { validateRings } from '../../geom2d/rings';
import type { ToolpathIR } from '../../ir/types';
import { buildLinkedPath, type PathBuildHeights } from '../../pathbuild';
import { classifyProbedDrops, probeSeedBelow } from '../../kernel/dropClassify';

export type ScallopDirection = 'climb' | 'conventional';

export interface ScallopFinishInput {
  mesh: MeshHandle;
  cutter: CutterSpec;
  scallopHeight: number;
  tolerance: number;
  surfaceStockToLeave?: number;
  minFinishZ?: number;
  direction: ScallopDirection;
  boundary?: readonly Ring[];
  xyBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  heights: PathBuildHeights;
  zSeed: number;
}

type Point3 = { x: number; y: number; z: number; key: string };
type Segment = { a: Point3; b: Point3; used: boolean };

const EPS = 1e-9;

function fail(message: string): never {
  const error = new Error(`scallopFinish: ${message}`);
  error.name = 'ScallopFinishError';
  throw error;
}

export function effectiveScallopRadius(cutter: CutterSpec): number {
  switch (cutter.kind) {
    case 'ball':
    case 'flat':
      return cutter.diameter / 2;
    case 'bull':
      return cutter.cornerRadius;
    case 'vbit':
      fail('a V-bit profile is not modelled for constant scallop');
  }
}

/** Exact chord spacing that leaves cusp h under a circular profile radius r. */
export function stepoverForScallop(radius: number, scallopHeight: number): number {
  if (!(radius > 0) || !Number.isFinite(radius)) fail(`invalid effective cutter radius ${radius}`);
  if (!(scallopHeight > 0) || !Number.isFinite(scallopHeight)) {
    fail(`scallopHeight must be finite and > 0, got ${scallopHeight}`);
  }
  if (scallopHeight >= radius) {
    fail(`scallopHeight ${scallopHeight} must be smaller than cutter radius ${radius}`);
  }
  return 2 * Math.sqrt(radius * radius - (radius - scallopHeight) ** 2);
}

function cutterIdOf(spec: CutterSpec): string {
  if (spec.kind === 'bull') return `bull-d${spec.diameter}-cr${spec.cornerRadius}`;
  if (spec.kind === 'vbit') return `vbit-d${spec.diameter}-a${spec.angleFromAxisDeg}`;
  return `${spec.kind}-d${spec.diameter}`;
}

function pointInRegion(x: number, y: number, rings: readonly Ring[]): boolean {
  let winding = 0;
  for (const ring of rings) {
    const count = ring.length / 2;
    for (let i = 0, j = count - 1; i < count; j = i++) {
      const ax = ring[2 * j];
      const ay = ring[2 * j + 1];
      const bx = ring[2 * i];
      const by = ring[2 * i + 1];
      const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
      if (Math.abs(cross) <= EPS && x >= Math.min(ax, bx) - EPS && x <= Math.max(ax, bx) + EPS &&
          y >= Math.min(ay, by) - EPS && y <= Math.max(ay, by) + EPS) return true;
      if (ay <= y) {
        if (by > y && cross > 0) winding++;
      } else if (by <= y && cross < 0) {
        winding--;
      }
    }
  }
  return winding !== 0;
}

class MinHeap {
  private readonly values: Array<{ index: number; distance: number }> = [];

  push(index: number, distance: number): void {
    let at = this.values.length;
    this.values.push({ index, distance });
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.values[parent].distance <= distance) break;
      this.values[at] = this.values[parent];
      at = parent;
    }
    this.values[at] = { index, distance };
  }

  pop(): { index: number; distance: number } | undefined {
    if (this.values.length === 0) return undefined;
    const root = this.values[0];
    const tail = this.values.pop()!;
    if (this.values.length === 0) return root;
    let at = 0;
    while (true) {
      const left = at * 2 + 1;
      if (left >= this.values.length) break;
      const right = left + 1;
      const child = right < this.values.length && this.values[right].distance < this.values[left].distance
        ? right : left;
      if (this.values[child].distance >= tail.distance) break;
      this.values[at] = this.values[child];
      at = child;
    }
    this.values[at] = tail;
    return root;
  }
}

function buildDistanceField(
  nx: number,
  ny: number,
  inside: Uint8Array,
  xs: Float64Array,
  ys: Float64Array,
  zs: Float64Array,
): Float64Array {
  const distance = new Float64Array(nx * ny);
  distance.fill(Infinity);
  const heap = new MinHeap();
  const neighbors = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1] as const;

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const index = iy * nx + ix;
      if (!inside[index]) continue;
      let boundary = ix === 0 || iy === 0 || ix === nx - 1 || iy === ny - 1;
      for (let n = 0; n < neighbors.length && !boundary; n += 2) {
        const jx = ix + neighbors[n];
        const jy = iy + neighbors[n + 1];
        if (!inside[jy * nx + jx]) boundary = true;
      }
      if (boundary) {
        distance[index] = 0;
        heap.push(index, 0);
      }
    }
  }

  for (let item = heap.pop(); item !== undefined; item = heap.pop()) {
    if (item.distance !== distance[item.index]) continue;
    const ix = item.index % nx;
    const iy = Math.floor(item.index / nx);
    for (let n = 0; n < neighbors.length; n += 2) {
      const jx = ix + neighbors[n];
      const jy = iy + neighbors[n + 1];
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      const next = jy * nx + jx;
      if (!inside[next]) continue;
      const weight = Math.hypot(xs[next] - xs[item.index], ys[next] - ys[item.index], zs[next] - zs[item.index]);
      const candidate = item.distance + weight;
      if (candidate + EPS < distance[next]) {
        distance[next] = candidate;
        heap.push(next, candidate);
      }
    }
  }
  return distance;
}

function edgePoint(
  a: number,
  b: number,
  key: string,
  level: number,
  field: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  zs: Float64Array,
): Point3 {
  const denominator = field[b] - field[a];
  const t = Math.abs(denominator) <= EPS ? 0.5 : Math.max(0, Math.min(1, (level - field[a]) / denominator));
  return {
    x: xs[a] + (xs[b] - xs[a]) * t,
    y: ys[a] + (ys[b] - ys[a]) * t,
    z: zs[a] + (zs[b] - zs[a]) * t,
    key,
  };
}

function segmentsAtLevel(
  nx: number,
  ny: number,
  inside: Uint8Array,
  field: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  zs: Float64Array,
  level: number,
): Segment[] {
  const segments: Segment[] = [];
  for (let iy = 0; iy < ny - 1; iy++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const bl = iy * nx + ix;
      const br = bl + 1;
      const tl = bl + nx;
      const tr = tl + 1;
      if (!inside[bl] || !inside[br] || !inside[tr] || !inside[tl]) continue;
      const corners = [bl, br, tr, tl] as const;
      const edgeDefs = [
        [bl, br, `h:${iy}:${ix}`],
        [br, tr, `v:${iy}:${ix + 1}`],
        [tl, tr, `h:${iy + 1}:${ix}`],
        [bl, tl, `v:${iy}:${ix}`],
      ] as const;
      const crossings: Point3[] = [];
      for (const [a, b, key] of edgeDefs) {
        const highA = field[a] >= level;
        const highB = field[b] >= level;
        if (highA !== highB) crossings.push(edgePoint(a, b, key, level, field, xs, ys, zs));
      }
      if (crossings.length === 2) {
        segments.push({ a: crossings[0], b: crossings[1], used: false });
      } else if (crossings.length === 4) {
        const centerHigh = corners.reduce((sum, index) => sum + field[index], 0) / 4 >= level;
        const pairs = centerHigh ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];
        for (const [a, b] of pairs) segments.push({ a: crossings[a], b: crossings[b], used: false });
      }
    }
  }
  return segments;
}

function stitchSegments(segments: Segment[]): Float64Array[] {
  const byKey = new Map<string, number[]>();
  const add = (key: string, index: number): void => {
    const entries = byKey.get(key);
    if (entries) entries.push(index);
    else byKey.set(key, [index]);
  };
  segments.forEach((segment, index) => {
    add(segment.a.key, index);
    add(segment.b.key, index);
  });

  const paths: Float64Array[] = [];
  const starts = segments.map((_, index) => index).sort((a, b) => {
    const aOpen = (byKey.get(segments[a].a.key)?.length === 1 || byKey.get(segments[a].b.key)?.length === 1) ? 0 : 1;
    const bOpen = (byKey.get(segments[b].a.key)?.length === 1 || byKey.get(segments[b].b.key)?.length === 1) ? 0 : 1;
    return aOpen - bOpen || a - b;
  });
  for (const startIndex of starts) {
    if (segments[startIndex].used) continue;
    const start = segments[startIndex];
    const startAtA = byKey.get(start.a.key)?.length === 1 || byKey.get(start.b.key)?.length !== 1;
    let point = startAtA ? start.a : start.b;
    const points: number[] = [point.x, point.y, point.z];
    let segmentIndex = startIndex;
    while (true) {
      const segment = segments[segmentIndex];
      segment.used = true;
      point = segment.a.key === point.key ? segment.b : segment.a;
      points.push(point.x, point.y, point.z);
      const next = (byKey.get(point.key) ?? []).find(index => !segments[index].used);
      if (next === undefined) break;
      segmentIndex = next;
    }
    if (points.length >= 6) paths.push(new Float64Array(points));
  }
  return paths;
}

function signedArea(path: Float64Array): number {
  let area = 0;
  const count = path.length / 3;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    area += path[3 * j] * path[3 * i + 1] - path[3 * i] * path[3 * j + 1];
  }
  return area / 2;
}

function reversePath(path: Float64Array): Float64Array {
  const out = new Float64Array(path.length);
  const count = path.length / 3;
  for (let i = 0; i < count; i++) out.set(path.subarray((count - i - 1) * 3, (count - i) * 3), i * 3);
  return out;
}

function orientPath(path: Float64Array, direction: ScallopDirection): Float64Array {
  const wantClockwise = direction === 'climb';
  return (signedArea(path) < 0) === wantClockwise ? path : reversePath(path);
}

function clipAtMinZ(paths: readonly Float64Array[], minZ: number): Float64Array[] {
  const result: Float64Array[] = [];
  for (const path of paths) {
    let part: number[] = [];
    const flush = (): void => {
      if (part.length >= 6) result.push(new Float64Array(part));
      part = [];
    };
    for (let i = 0; i < path.length; i += 3) {
      if (path[i + 2] >= minZ) part.push(path[i], path[i + 1], path[i + 2]);
      else flush();
    }
    flush();
  }
  return result;
}

export async function scallopFinish(
  kernel: GeometryKernel,
  input: ScallopFinishInput,
  opts?: {
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
    /** WO-1540: plain-language notice for the app console when part of the region is left out. */
    onNotice?: (message: string) => void;
  },
): Promise<ToolpathIR> {
  const { cutter, tolerance, heights, zSeed } = input;
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) fail(`tolerance must be finite and > 0, got ${tolerance}`);
  if (!Number.isFinite(zSeed)) fail(`zSeed must be finite, got ${zSeed}`);
  const allowance = input.surfaceStockToLeave ?? 0;
  if (!(allowance >= 0) || !Number.isFinite(allowance)) fail(`stockToLeave must be finite and >= 0, got ${allowance}`);
  const radius = effectiveScallopRadius(cutter);
  const stepover = stepoverForScallop(radius, input.scallopHeight);

  let rings: readonly Ring[];
  if (input.boundary) {
    validateRings(input.boundary, 'scallopFinish boundary');
    rings = input.boundary;
  } else if (input.xyBounds) {
    const b = input.xyBounds;
    if (!(b.minX < b.maxX) || !(b.minY < b.maxY)) fail('xyBounds must have positive width and height');
    rings = [new Float64Array([b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY])];
  } else {
    fail('either boundary or xyBounds is required');
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      minY = Math.min(minY, ring[i + 1]);
      maxX = Math.max(maxX, ring[i]);
      maxY = Math.max(maxY, ring[i + 1]);
    }
  }
  const nx = Math.max(2, Math.ceil((maxX - minX) / tolerance) + 1);
  const ny = Math.max(2, Math.ceil((maxY - minY) / tolerance) + 1);
  const dx = (maxX - minX) / (nx - 1);
  const dy = (maxY - minY) / (ny - 1);
  const cutterHandle = kernel.makeCutter(cutter);
  try {
    // One surface batch for the whole operation. Everything after this point is
    // deterministic field relaxation and contour extraction in worker memory.
    // WO-1281: probed one millimetre BELOW the floor (waterline's rule, see
    // kernel/dropClassify.ts) so a cell with nothing under the cutter is known
    // as a MISS; `rawZ` is bit-identical to a probe at zSeed.
    const probed = await kernel.dropGrid(input.mesh, cutterHandle, {
      x0: minX, y0: minY, nx, ny, dx, dy, zSeed: probeSeedBelow(zSeed),
    }, { signal: opts?.signal, onProgress: fraction => opts?.onProgress?.(fraction * 0.45) });
    const { z: rawZ, hit } = classifyProbedDrops(probed, zSeed);
    const count = nx * ny;
    const inside = new Uint8Array(count);
    const xs = new Float64Array(count);
    const ys = new Float64Array(count);
    const zs = new Float64Array(count);
    // WO-1281: the mask is the CONTACT region, not the containment ring. A
    // cell inside the ring whose footprint meets no part is a miss: it never
    // enters the distance field, so the field's seeds are the cutter-contact
    // silhouette (tangency for free), the field never marches across a stock
    // margin at floor height or up the part's cliff, and no contour can be
    // routed through ground with nothing to finish. A finish cuts only where
    // the cutter meets the part.
    //
    // TWO RULES, OPPOSITE SIDES OF THE SAME BOUNDARY, both correct. This one
    // stops cutting where there is no part. The stock-edge overrun (WO-1271
    // for parallel, WO-1282 for scallop) does the reverse: it lets the cutter
    // centre run PAST a stock or part-bounds edge so the rim clears it instead
    // of leaving a fin. For scallop the overrun arrives as a WIDER containment
    // region from the adapter (integration/scallop3dOperation.ts), because the
    // field has no lattice to anchor and this region is what seeds it -- and
    // then the mask below is what makes that band safe AND what bounds it:
    // a centre further from the part than the cutter reaches has nothing under
    // its footprint, so it is a miss, so it never enters the field. Ask for
    // ten millimetres of overrun on a three millimetre tool and the contact
    // silhouette still answers with one radius.
    let skippedCells = 0;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const index = iy * nx + ix;
        const x = minX + ix * dx;
        const y = minY + iy * dy;
        const inRegion = pointInRegion(x, y, rings);
        if (inRegion && hit[index] === 0) skippedCells++;
        inside[index] = inRegion && hit[index] === 1 ? 1 : 0;
        let dzdx = 0;
        let dzdy = 0;
        if (allowance > 0) {
          const lx = iy * nx + Math.max(0, ix - 1);
          const rx = iy * nx + Math.min(nx - 1, ix + 1);
          const by = Math.max(0, iy - 1) * nx + ix;
          const ty = Math.min(ny - 1, iy + 1) * nx + ix;
          dzdx = (rawZ[rx] - rawZ[lx]) / ((Math.min(nx - 1, ix + 1) - Math.max(0, ix - 1)) * dx);
          dzdy = (rawZ[ty] - rawZ[by]) / ((Math.min(ny - 1, iy + 1) - Math.max(0, iy - 1)) * dy);
        }
        const inverseNormalLength = 1 / Math.hypot(dzdx, dzdy, 1);
        xs[index] = x - allowance * dzdx * inverseNormalLength;
        ys[index] = y - allowance * dzdy * inverseNormalLength;
        zs[index] = rawZ[index] + allowance * inverseNormalLength;
      }
    }

    if (!inside.some(v => v === 1)) {
      fail(
        'the containment region has no part surface under it: every grid cell missed the mesh. ' +
          'Nothing to finish there; check the stock outline and the part placement.',
      );
    }
    const distance = buildDistanceField(nx, ny, inside, xs, ys, zs);
    let maxDistance = 0;
    let unreachable = 0;
    for (let i = 0; i < distance.length; i++) {
      if (!inside[i]) continue;
      if (!Number.isFinite(distance[i])) unreachable++;
      else maxDistance = Math.max(maxDistance, distance[i]);
    }
    if (unreachable > 0) {
      console.warn(`[scallop3d] distance field could not reach ${unreachable} contained grid cells`);
      opts?.onNotice?.(
        `${unreachable} grid cell(s) inside the region could not be reached by the scallop pattern and were left unfinished.`,
      );
    }
    opts?.onProgress?.(0.7);

    const passes: Float64Array[] = [];
    const levelCount = Math.floor(maxDistance / stepover + EPS);
    for (let levelIndex = 1; levelIndex <= levelCount; levelIndex++) {
      const level = levelIndex * stepover;
      const levelPaths = stitchSegments(segmentsAtLevel(nx, ny, inside, distance, xs, ys, zs, level))
        .map(path => orientPath(path, input.direction))
        .sort((a, b) => signedArea(b) - signedArea(a) || a[0] - b[0] || a[1] - b[1]);
      passes.push(...levelPaths);
      opts?.onProgress?.(0.7 + 0.2 * levelIndex / Math.max(1, levelCount));
    }
    const finishPasses = input.minFinishZ === undefined ? passes : clipAtMinZ(passes, input.minFinishZ);
    if (finishPasses.length === 0) fail('containment region produced no scallop contours');

    const normalStep = Math.max(tolerance, Math.min(stepover / 4, radius / 4));
    const sampleOffsetSurfaceZ = async (xy: Float64Array): Promise<Float64Array> => {
      const center = await kernel.dropPoints(input.mesh, cutterHandle, xy, zSeed, { signal: opts?.signal });
      if (allowance === 0) return center;
      const neighborXY = new Float64Array(xy.length * 4);
      for (let i = 0; i < xy.length / 2; i++) {
        const x = xy[2 * i];
        const y = xy[2 * i + 1];
        neighborXY.set([x - normalStep, y, x + normalStep, y, x, y - normalStep, x, y + normalStep], i * 8);
      }
      const neighborZ = await kernel.dropPoints(input.mesh, cutterHandle, neighborXY, zSeed, { signal: opts?.signal });
      const offsetZ = new Float64Array(center.length);
      for (let i = 0; i < center.length; i++) {
        const dzdx = (neighborZ[i * 4 + 1] - neighborZ[i * 4]) / (2 * normalStep);
        const dzdy = (neighborZ[i * 4 + 3] - neighborZ[i * 4 + 2]) / (2 * normalStep);
        offsetZ[i] = center[i] + allowance / Math.hypot(dzdx, dzdy, 1);
      }
      return offsetZ;
    };
    const moves = await buildLinkedPath(finishPasses, heights, {
      stepover,
      cutterContactRadiusMm: cutter.diameter / 2,
      connectorSampleStep: Math.min(tolerance, stepover / 2),
      zigzag: false,
    }, sampleOffsetSurfaceZ);
    opts?.onProgress?.(1);
    return {
      moves,
      meta: {
        strategyId: 'scallop_finish',
        cutterId: cutterIdOf(cutter),
        params: {
          scallopHeight: input.scallopHeight,
          stepover,
          tolerance,
          gridCellSize: Math.max(dx, dy),
          gridNx: nx,
          gridNy: ny,
          direction: input.direction,
          zSeed,
          clearanceZ: heights.clearanceZ,
          retractZ: heights.retractZ,
          boundaryRingCount: input.boundary?.length ?? 0,
          ...(allowance > 0 ? { surfaceStockToLeave: allowance } : {}),
          ...(input.minFinishZ !== undefined ? { minFinishZ: input.minFinishZ } : {}),
          ...(unreachable > 0 ? { unreachableGridCells: unreachable } : {}),
          // WO-1281: recorded ONLY when a cell was skipped, so a region-filling
          // part keeps its legacy fingerprint.
          ...(skippedCells > 0 ? { skippedGridCells: skippedCells } : {}),
        },
      },
    };
  } finally {
    kernel.releaseCutter(cutterHandle);
  }
}
