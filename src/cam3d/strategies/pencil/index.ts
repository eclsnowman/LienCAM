// Pencil cleanup: find ridges in the excess lift caused by simultaneous
// cutter contact on both sides of a concave corner, thin them, then exact-drop
// the resulting corner curves before passing them to the shared linker.

import type { CutterSpec, GeometryKernel, MeshHandle } from '../../kernel/types';
import type { Ring } from '../../geom2d';
import { validateRings } from '../../geom2d/rings';
import type { ToolpathIR } from '../../ir/types';
import { buildLinkedPath, type PathBuildHeights } from '../../pathbuild';

export type PencilDirection = 'climb' | 'conventional';

export interface PencilFinishInput {
  mesh: MeshHandle;
  cutter: CutterSpec;
  tolerance: number;
  stockToLeave?: number;
  minFinishZ?: number;
  direction: PencilDirection;
  boundary?: readonly Ring[];
  xyBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  heights: PathBuildHeights;
  zSeed: number;
}

const EPS = 1e-9;
const NEIGHBORS = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1] as const;

function fail(message: string): never {
  const error = new Error(`pencilFinish: ${message}`);
  error.name = 'PencilFinishError';
  throw error;
}

export function effectivePencilRadius(cutter: CutterSpec): number {
  if (cutter.kind === 'ball') return cutter.diameter / 2;
  if (cutter.kind === 'bull') return cutter.cornerRadius;
  fail('pencil requires a ball or bull-nose end mill with a rolling corner radius');
}

function cutterIdOf(spec: CutterSpec): string {
  return spec.kind === 'bull' ? `bull-d${spec.diameter}-cr${spec.cornerRadius}` : `ball-d${spec.diameter}`;
}

function pointInRegion(x: number, y: number, rings: readonly Ring[]): boolean {
  let winding = 0;
  for (const ring of rings) {
    const count = ring.length / 2;
    for (let i = 0, j = count - 1; i < count; j = i++) {
      const ax = ring[2 * j], ay = ring[2 * j + 1];
      const bx = ring[2 * i], by = ring[2 * i + 1];
      const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
      if (Math.abs(cross) <= EPS && x >= Math.min(ax, bx) - EPS && x <= Math.max(ax, bx) + EPS &&
          y >= Math.min(ay, by) - EPS && y <= Math.max(ay, by) + EPS) return true;
      if (ay <= y) {
        if (by > y && cross > 0) winding++;
      } else if (by <= y && cross < 0) winding--;
    }
  }
  return winding !== 0;
}

function boundsOf(input: PencilFinishInput): { rings: readonly Ring[]; minX: number; minY: number; maxX: number; maxY: number } {
  let rings: readonly Ring[];
  if (input.boundary) {
    validateRings(input.boundary, 'pencilFinish boundary');
    rings = input.boundary;
  } else if (input.xyBounds) {
    const b = input.xyBounds;
    if (!(b.minX < b.maxX) || !(b.minY < b.maxY)) fail('xyBounds must have positive width and height');
    rings = [new Float64Array([b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY])];
  } else fail('either boundary or xyBounds is required');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]); minY = Math.min(minY, ring[i + 1]);
    maxX = Math.max(maxX, ring[i]); maxY = Math.max(maxY, ring[i + 1]);
  }
  return { rings, minX, minY, maxX, maxY };
}

/** Zhang-Suen thinning preserves the positive band's component and branch
 * topology. Its geometric midline is only a tracing scaffold; it is snapped
 * to the cutter-location minimum below before becoming a toolpath. */
function thinBandForTopology(source: Uint8Array, nx: number, ny: number): Uint8Array {
  const out = source.slice();
  const remove: number[] = [];
  const p = (x: number, y: number): number => out[y * nx + x];
  let changed = true;
  while (changed) {
    changed = false;
    for (let phase = 0; phase < 2; phase++) {
      remove.length = 0;
      for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
        const i = y * nx + x;
        if (!out[i]) continue;
        const q = [p(x, y - 1), p(x + 1, y - 1), p(x + 1, y), p(x + 1, y + 1),
          p(x, y + 1), p(x - 1, y + 1), p(x - 1, y), p(x - 1, y - 1)];
        const count = q.reduce((sum, value) => sum + value, 0);
        if (count < 2 || count > 6) continue;
        let transitions = 0;
        for (let k = 0; k < 8; k++) if (!q[k] && q[(k + 1) % 8]) transitions++;
        if (transitions !== 1) continue;
        const a = phase === 0 ? q[0] * q[2] * q[4] : q[0] * q[2] * q[6];
        const b = phase === 0 ? q[2] * q[4] * q[6] : q[0] * q[4] * q[6];
        if (a === 0 && b === 0) remove.push(i);
      }
      if (remove.length > 0) changed = true;
      for (const i of remove) out[i] = 0;
    }
  }
  return out;
}

function adjacent(index: number, field: Uint8Array, nx: number, ny: number, allowed?: Set<number>): number[] {
  const x = index % nx, y = Math.floor(index / nx), result: number[] = [];
  for (let n = 0; n < NEIGHBORS.length; n += 2) {
    const xx = x + NEIGHBORS[n], yy = y + NEIGHBORS[n + 1];
    if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
    const j = yy * nx + xx;
    if (field[j] && (allowed === undefined || allowed.has(j))) result.push(j);
  }
  return result.sort((a, b) => a - b);
}

function componentWalk(component: readonly number[], skeleton: Uint8Array, nx: number, ny: number): number[] {
  const set = new Set(component);
  const endpoints = component.filter(index => adjacent(index, skeleton, nx, ny, set).length === 1).sort((a, b) => a - b);
  // NOT `Math.min(...component)` (WO-1806). A closed ridge loop has no
  // endpoint, so that spread passed EVERY cell of the component as a call
  // argument, and the component is as large as the grid allows. It was not
  // the measured cause of the September 20 overflow (the failing step spread
  // only 5644 arguments) but its width has no bound, so it does not get to
  // stay. Same value, no stack cost.
  let smallest = component[0];
  for (const index of component) if (index < smallest) smallest = index;
  const start = endpoints[0] ?? smallest;
  if (component.every(index => adjacent(index, skeleton, nx, ny, set).length <= 2)) {
    const walk: number[] = [start];
    let previous = -1, current = start;
    while (true) {
      const next = adjacent(current, skeleton, nx, ny, set).find(index => index !== previous && !walk.includes(index));
      if (next === undefined) break;
      previous = current; current = next; walk.push(current);
    }
    return walk;
  }
  /**
   * A BRANCHING RIDGE IS WALKED ON THE HEAP, NEVER ON THE CALL STACK (WO-1806).
   *
   * This walk used to recurse: `visit(next)` once per unvisited neighbour.
   * Its depth is the length of the DFS path through the component, not the
   * length of the final toolpath, so one ordinary corner ridge nested it
   * thousands of frames deep. Measured on the `engagement-pocket-rest-pencil`
   * benchmark chain, step `pencil-2-ball`: a single branching component of
   * 5644 cells reached 5642 nested frames. That is close enough to V8's
   * default ~1 MB stack that the SAME source on the SAME box both survived it
   * and died on it in different runs, and on the ARM64 build box it died every
   * time -- which is what `--stack-size=2500` was quietly hiding. Grid cells
   * scale as (part extent / tolerance)^2, so a finer tolerance or a bigger
   * part walks deeper: there is no depth this could have been tuned to.
   *
   * The emission order is the recursion's, exactly: push a cell on arrival,
   * and push the parent again each time a child subtree finishes. Popping a
   * frame here IS that child returning, so the re-push happens in the same
   * place. Neighbours are read once on arrival and each is tested for
   * membership at the moment it is consumed, as the `for`/`if` pair did.
   */
  const visited = new Set<number>(), walk: number[] = [];
  const pending: Array<{ index: number; neighbors: number[]; cursor: number }> = [];
  const arrive = (index: number): void => {
    visited.add(index); walk.push(index);
    pending.push({ index, neighbors: adjacent(index, skeleton, nx, ny, set), cursor: 0 });
  };
  arrive(start);
  while (pending.length > 0) {
    const frame = pending[pending.length - 1];
    if (frame.cursor >= frame.neighbors.length) {
      pending.pop();
      if (pending.length > 0) walk.push(pending[pending.length - 1].index);
      continue;
    }
    const next = frame.neighbors[frame.cursor++];
    if (!visited.has(next)) arrive(next);
  }
  return walk;
}

function traceSkeleton(skeleton: Uint8Array, nx: number, ny: number, minX: number, minY: number, dx: number, dy: number): Float64Array[] {
  const seen = new Uint8Array(skeleton.length), paths: Float64Array[] = [];
  for (let seed = 0; seed < skeleton.length; seed++) {
    if (!skeleton[seed] || seen[seed]) continue;
    const component: number[] = [], pending = [seed]; seen[seed] = 1;
    while (pending.length) {
      const index = pending.pop()!; component.push(index);
      for (const j of adjacent(index, skeleton, nx, ny)) if (!seen[j]) { seen[j] = 1; pending.push(j); }
    }
    if (component.length < 2) {
      console.warn(`[pencil3d] unresolved one-cell corner ridge at grid index ${seed}`);
      continue;
    }
    const xyz: number[] = [];
    for (const index of componentWalk(component, skeleton, nx, ny)) {
      xyz.push(minX + (index % nx) * dx, minY + Math.floor(index / nx) * dy, 0);
    }
    paths.push(new Float64Array(xyz));
  }
  return paths;
}

function snapToCutterLocationMinimum(
  path: Float64Array,
  band: Uint8Array,
  skeleton: Uint8Array,
  rawZ: Float64Array,
  nx: number,
  ny: number,
  minX: number,
  minY: number,
  dx: number,
  dy: number,
  searchRadius: number,
): Float64Array {
  const result: number[] = [];
  const pointCount = path.length / 3;
  const sampleStep = Math.min(dx, dy) / 2;
  const sampleCount = Math.ceil(searchRadius / sampleStep);
  const inBandHalo = (index: number): boolean => {
    if (band[index]) return true;
    const x = index % nx, y = Math.floor(index / nx);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = x + ox, yy = y + oy;
      if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && band[yy * nx + xx]) return true;
    }
    return false;
  };
  const distinctPoint = (start: number, step: number, x: number, y: number): [number, number] | undefined => {
    for (let i = start; i >= 0 && i < pointCount; i += step) {
      const px = path[i * 3], py = path[i * 3 + 1];
      if (Math.hypot(px - x, py - y) > EPS) return [px, py];
    }
    return undefined;
  };
  const skeletonTangent = (x: number, y: number): [number, number] | undefined => {
    const centerX = Math.round((x - minX) / dx);
    const centerY = Math.round((y - minY) / dy);
    const points: Array<[number, number]> = [];
    for (let oy = -4; oy <= 4; oy++) for (let ox = -4; ox <= 4; ox++) {
      const gx = centerX + ox, gy = centerY + oy;
      if (gx >= 0 && gy >= 0 && gx < nx && gy < ny && skeleton[gy * nx + gx]) {
        points.push([minX + gx * dx, minY + gy * dy]);
      }
    }
    if (points.length < 3) return undefined;
    const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
    const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length;
    let xx = 0, xy = 0, yy = 0;
    for (const point of points) {
      const px = point[0] - meanX, py = point[1] - meanY;
      xx += px * px;
      xy += px * py;
      yy += py * py;
    }
    const discriminant = Math.hypot(xx - yy, 2 * xy);
    if (discriminant <= EPS || discriminant < (xx + yy) * 0.25) return undefined;
    const angle = Math.atan2(2 * xy, xx - yy) / 2;
    return [Math.cos(angle), Math.sin(angle)];
  };

  for (let i = 0; i < pointCount; i++) {
    const x = path[i * 3], y = path[i * 3 + 1];
    const previous = distinctPoint(i - 1, -1, x, y);
    const next = distinctPoint(i + 1, 1, x, y);
    const localTangent = skeletonTangent(x, y);
    const tx = localTangent?.[0] ?? (next?.[0] ?? x) - (previous?.[0] ?? x);
    const ty = localTangent?.[1] ?? (next?.[1] ?? y) - (previous?.[1] ?? y);
    const tangentLength = Math.hypot(tx, ty);
    if (tangentLength <= EPS) {
      result.push(x, y, 0);
      continue;
    }
    const normalX = -ty / tangentLength, normalY = tx / tangentLength;
    let bestX = x, bestY = y, bestZ = Infinity, bestDistance = Infinity;
    const sampled = new Set<number>();
    /**
     * THE SEARCH IS CONFINED TO THE ONE BAND THIS SCAFFOLD POINT SITS IN.
     *
     * Sweeping the whole +/-(2r+cell) line and merely SKIPPING the cells that
     * fall outside the band lets the walk cross the dead ground between two
     * separate corners and snap onto a NEIGHBOUR's band whenever that
     * neighbour holds a lower cutter-location height - which it does on every
     * descending step. Measured on `steps(4, 40, 3)`: the first band's own
     * minimum is the halo cell at 6.000, the next band starts at 5.977, the
     * neighbour wins by 23 microns, and the near corner then receives no pass
     * at all while its pass is re-emitted on a convex rollover that cuts
     * nothing.
     *
     * So each direction walks OUTWARD from the scaffold point and STOPS at the
     * first cell outside the band-or-halo. A cell already sampled is stepped
     * over rather than treated as a boundary: the sample step is half a cell,
     * so consecutive stations legitimately land on the same cell.
     */
    const consider = (index: number, gx: number, gy: number): void => {
      const candidateDistance = Math.hypot(minX + gx * dx - x, minY + gy * dy - y);
      if (rawZ[index] < bestZ - EPS || (Math.abs(rawZ[index] - bestZ) <= EPS && candidateDistance < bestDistance)) {
        bestX = minX + gx * dx;
        bestY = minY + gy * dy;
        bestZ = rawZ[index];
        bestDistance = candidateDistance;
      }
    };
    const visit = (distance: number): 'sampled' | 'repeat' | 'outside' => {
      const gx = Math.round((x + normalX * distance - minX) / dx);
      const gy = Math.round((y + normalY * distance - minY) / dy);
      if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) return 'outside';
      const index = gy * nx + gx;
      if (sampled.has(index)) return 'repeat';
      if (!inBandHalo(index) || !Number.isFinite(rawZ[index])) return 'outside';
      sampled.add(index);
      consider(index, gx, gy);
      return 'sampled';
    };
    visit(0);
    for (const sign of [1, -1]) {
      for (let k = 1; k <= sampleCount; k++) {
        if (visit(sign * k * sampleStep) === 'outside') break;
      }
    }
    if (result.length < 3 || Math.hypot(bestX - result[result.length - 3], bestY - result[result.length - 2]) > EPS) {
      result.push(bestX, bestY, 0);
    }
  }
  return new Float64Array(result);
}

function resampleXY(path: Float64Array, spacing: number): Float64Array {
  const xy: number[] = [path[0], path[1]];
  for (let i = 3; i < path.length; i += 3) {
    const ax = path[i - 3], ay = path[i - 2], bx = path[i], by = path[i + 1];
    const length = Math.hypot(bx - ax, by - ay);
    const segments = Math.max(1, Math.ceil(length / spacing));
    for (let j = 1; j <= segments; j++) {
      const t = j / segments; xy.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return new Float64Array(xy);
}

function appendPoint(points: number[], x: number, y: number, z: number): void {
  const n = points.length;
  if (n >= 3 && points[n - 3] === x && points[n - 2] === y && points[n - 1] === z) return;
  points.push(x, y, z);
}

/** Split a sampled corner track at its lowest finish plane. Boundary
 * intersections are retained so no surviving endpoints are joined across a
 * removed middle section. Each returned piece is linked independently. */
function splitPassAtMinZ(pass: Float64Array, minFinishZ: number): Float64Array[] {
  const split: Float64Array[] = [];
  let piece: number[] = [];
  const finishPiece = (): void => {
    if (piece.length >= 6) split.push(new Float64Array(piece));
    piece = [];
  };

  let ax = pass[0], ay = pass[1], az = pass[2];
  let aInside = az >= minFinishZ;
  if (aInside) appendPoint(piece, ax, ay, az);
  for (let i = 1; i < pass.length / 3; i++) {
    const bx = pass[i * 3], by = pass[i * 3 + 1], bz = pass[i * 3 + 2];
    const bInside = bz >= minFinishZ;
    if (aInside !== bInside) {
      const t = (minFinishZ - az) / (bz - az);
      const ix = ax + t * (bx - ax), iy = ay + t * (by - ay);
      appendPoint(piece, ix, iy, minFinishZ);
      if (aInside) finishPiece();
    }
    if (bInside) appendPoint(piece, bx, by, bz);
    ax = bx; ay = by; az = bz; aInside = bInside;
  }
  finishPiece();
  return split;
}

export async function pencilFinish(
  kernel: GeometryKernel,
  input: PencilFinishInput,
  opts?: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<ToolpathIR> {
  const { tolerance, zSeed, heights } = input;
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) fail(`tolerance must be finite and > 0, got ${tolerance}`);
  if (!Number.isFinite(zSeed)) fail(`zSeed must be finite, got ${zSeed}`);
  const allowance = input.stockToLeave ?? 0;
  if (!(allowance >= 0) || !Number.isFinite(allowance)) fail(`stockToLeave must be finite and >= 0, got ${allowance}`);
  const radius = effectivePencilRadius(input.cutter);
  const { rings, minX, minY, maxX, maxY } = boundsOf(input);
  const nx = Math.max(3, Math.ceil((maxX - minX) / tolerance) + 1);
  const ny = Math.max(3, Math.ceil((maxY - minY) / tolerance) + 1);
  const dx = (maxX - minX) / (nx - 1), dy = (maxY - minY) / (ny - 1);
  // Ridge detection deliberately uses only the rolling corner radius. Exact
  // path Z must use the physical cutter: a bull is a disk Minkowski-summed
  // with that ball and lies higher than the corner ball alone on every slope.
  const detectionHandle = kernel.makeCutter({ kind: 'ball', diameter: radius * 2 });
  let cutterHandle = detectionHandle;
  try {
    if (input.cutter.kind === 'bull') {
      try {
        cutterHandle = kernel.makeCutter(input.cutter);
      } catch {
        fail('bull-nose drop is unavailable in the active geometry kernel');
      }
    }
    const surfaceZ = new Float64Array(nx * ny);
    const rawZ = await kernel.dropGrid(input.mesh, detectionHandle, {
      x0: minX, y0: minY, nx, ny, dx, dy, zSeed,
    }, { signal: opts?.signal, surfaceZ, onProgress: fraction => opts?.onProgress?.(fraction * 0.45) });
    const inside = new Uint8Array(nx * ny), excess = new Float64Array(nx * ny);
    let maxExcess = 0;
    for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const i = y * nx + x, worldX = minX + x * dx, worldY = minY + y * dy;
      if (!pointInRegion(worldX, worldY, rings)) continue;
      inside[i] = 1;
      const dzdx = (surfaceZ[i + 1] - surfaceZ[i - 1]) / (2 * dx);
      const dzdy = (surfaceZ[i + nx] - surfaceZ[i - nx]) / (2 * dy);
      // For z=a*x+b*y+c, a ball tip on that ONE plane is
      // surfaceZ + r*(sqrt(1+a^2+b^2)-1). Flat limit a=b=0 gives zero
      // lift; any uniform slope gives exactly its single-contact lift. Only
      // simultaneous contact across a concavity raises rawZ above it.
      const singleContact = surfaceZ[i] + radius * (Math.sqrt(1 + dzdx * dzdx + dzdy * dzdy) - 1);
      excess[i] = Math.max(0, rawZ[i] - singleContact);
      maxExcess = Math.max(maxExcess, excess[i]);
    }
    const threshold = Math.max(tolerance * 0.25, 1e-7);
    const band = new Uint8Array(nx * ny);
    for (let i = 0; i < band.length; i++) if (inside[i] && excess[i] > threshold) band[i] = 1;
    const skeleton = thinBandForTopology(band, nx, ny);
    const topologyTraces = traceSkeleton(skeleton, nx, ny, minX, minY, dx, dy);
    const traced = topologyTraces.map(path => snapToCutterLocationMinimum(
      path, band, skeleton, rawZ, nx, ny, minX, minY, dx, dy, radius * 2 + Math.max(dx, dy),
    ));
    opts?.onProgress?.(0.65);
    if (traced.length === 0) fail('no concave corner ridge exceeded the tolerance-derived excess threshold');

    const normalStep = Math.max(tolerance, radius / 4);
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

    const passes: Float64Array[] = [];
    for (const path of traced) {
      const xy = resampleXY(path, tolerance);
      const z = await sampleOffsetSurfaceZ(xy);
      const xyz: number[] = [];
      for (let i = 0; i < z.length; i++) {
        xyz.push(xy[i * 2], xy[i * 2 + 1], z[i]);
      }
      const depthPasses = input.minFinishZ === undefined
        ? [new Float64Array(xyz)]
        : splitPassAtMinZ(new Float64Array(xyz), input.minFinishZ);
      for (const pass of depthPasses) if (pass.length >= 6) {
        if (input.direction === 'conventional') {
          const reversed = new Float64Array(pass.length);
          for (let i = 0, n = pass.length / 3; i < n; i++) reversed.set(pass.subarray((n - i - 1) * 3, (n - i) * 3), i * 3);
          passes.push(reversed);
        } else passes.push(pass);
      }
    }
    if (passes.length === 0) fail('all traced corner ridges were removed by the finish-depth limit');
    const moves = await buildLinkedPath(passes, heights, {
      stepover: radius, cutterContactRadiusMm: input.cutter.diameter / 2,
      connectorSampleStep: tolerance, zigzag: false,
    }, sampleOffsetSurfaceZ);
    opts?.onProgress?.(1);
    return { moves, meta: { strategyId: 'pencil_finish', cutterId: cutterIdOf(input.cutter), params: {
      tolerance, gridCellSize: Math.max(dx, dy), gridNx: nx, gridNy: ny,
      excessThreshold: threshold, maxExcess, tracedPolylineCount: passes.length,
      direction: input.direction, zSeed, clearanceZ: heights.clearanceZ, retractZ: heights.retractZ,
      boundaryRingCount: input.boundary?.length ?? 0,
      ...(allowance > 0 ? { stockToLeave: allowance } : {}),
      ...(input.minFinishZ !== undefined ? { minFinishZ: input.minFinishZ } : {}),
    } } };
  } finally {
    if (cutterHandle !== detectionHandle) kernel.releaseCutter(cutterHandle);
    kernel.releaseCutter(detectionHandle);
  }
}
