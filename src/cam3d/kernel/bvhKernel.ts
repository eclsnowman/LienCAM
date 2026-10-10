// cam3d L2: BvhKernel -- GeometryKernel over three-mesh-bvh (preview tier).
//
// Role split (docs/3d/OCL-CAPABILITIES.md section 3 + DECISIONS.md D-010):
// spatial structures are used ONLY to cull candidate triangles; every drop
// value comes from the exact contact math in dropCutter.ts. Raster-max
// sampling is deliberately absent -- it is structurally wrong for flat
// cutters.
//
// Culling strategy (chosen for the 2s / 50k-point perf gate): a per-point
// MeshBVH.shapecast was measured at ~2.6s on the 200k-triangle benchmark --
// per-node JS callback overhead dominates. So uploadMesh builds a ONE-TIME
// spatial index from the BVH build product instead: the MeshBVH constructor
// sorts the triangle index into spatially coherent leaf order, and those
// triangles are binned into a uniform xy cell grid whose per-cell lists are
// sorted by triangle max-z DESCENDING. A drop query then runs
// branch-and-bound:
// - the running best starts at zSeed (which makes the miss policy and the
//   >= zSeed clamp fall out of the same comparison);
// - footprint cells are walked in upper-bound-DESCENDING order (deterministic
//   selection, ties by scan order), so best is near-final after the first
//   walk and the remaining cells usually prune on their bound in O(1);
// - a walked cell BREAKS at the first triangle whose zmax (plus the ball
//   distance slack) cannot beat best -- the per-cell lists are z-sorted.
//   Soundness: a contact through a triangle can never exceed that
//   triangle's own max vertex z (flat: tip z IS a surface z inside the
//   disk; ball: tip z = contact z - radius*(1 - n.z) <= contact z; bull:
//   tip z = contact z minus the torus underside height, >= 0; vbit:
//   likewise minus the cone underside height, >= 0), and
//   all contact points lie in the closed footprint disk, so cells whose
//   rect misses the disk are skipped exactly.

import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type {
  CutterHandle,
  CutterSpec,
  GeometryKernel,
  GridSpec,
  MeshHandle,
  PartMesh,
} from './types';
import { DisposalRegistry } from './registry';
import { dropTriangleBallCore, dropTriangleFlatCore } from './dropCutter';
import { dropTriangleBullCore } from './dropCutterBull';
import { coneSlopeK, dropTriangleConeCore } from './dropCutterCone';

/** Uniform xy grid over the mesh footprint; see the header for the design. */
type CellIndex = {
  gx0: number;
  gy0: number;
  gx1: number;
  gy1: number;
  csx: number;
  csy: number;
  nx: number;
  ny: number;
  /** CSR layout: cell ci owns entries[cellStart[ci] .. cellStart[ci+1]). */
  cellStart: Uint32Array;
  /** Triangle ids per cell, sorted by triZMax DESC (tie: id ASC). */
  entries: Uint32Array;
  /**
   * Gate data interleaved PER ENTRY (stride GATE_STRIDE, aligned with
   * `entries`): zmax, minX, maxX, minY, maxY of the entry's triangle. The
   * hot walk gate scans this sequentially instead of chasing five separate
   * arrays through the cache; f64 on purpose -- an f32-rounded AABB could
   * shrink and let the distance-slack gate prune a borderline contact.
   */
  entryGate: Float64Array;
  /** Max triangle zmax per cell; -Infinity for empty cells. */
  cellZMax: Float32Array;
};

const GATE_STRIDE = 5;

type MeshRecord = {
  bvh: MeshBVH;
  geometry: BufferGeometry;
  /** Kernel-owned copy of vertex positions (caller may mutate theirs). */
  positions: Float32Array;
  /** Kernel-owned index copy, REORDERED IN PLACE by the MeshBVH build into
   *  spatially coherent leaf order -- the cell index bins this order, so
   *  cell walks touch memory-adjacent triangles. */
  indices: Uint32Array;
  /** Per (reordered) triangle max vertex z, for branch-and-bound pruning. */
  triZMax: Float32Array;
  /** Per (reordered) triangle vertex coords, 9 contiguous f64 per triangle:
   *  survivors of the walk gate read these without index indirection or
   *  f32 promotion in the hot loop. Values are exact f32->f64 promotions,
   *  so results are bit-identical to reading `positions`. */
  triVerts: Float64Array;
  cells: CellIndex;
};

/**
 * cornerRadius is meaningful for 'bull' only (0 <= cornerRadius <= radius);
 * slopeK (flank rise per mm, cot of the half-angle) and tipRadius
 * (0 <= tipRadius < radius) for 'vbit' only.
 */
type CutterRecord = {
  kind: 'flat' | 'ball' | 'bull' | 'vbit';
  radius: number;
  cornerRadius: number;
  slopeK: number;
  tipRadius: number;
};

/**
 * Chunk size for cooperative yielding. ~2000 points is 10-40ms of drop work
 * on the 200k-triangle benchmark: long enough that the ~1ms macrotask yield
 * stays under a few percent overhead, short enough that a worker event loop
 * can deliver a cancel message promptly.
 */
const CHUNK_POINTS = 2048;

function abortError(): Error {
  const err = new Error('BvhKernel: operation aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) throw abortError();
}

function yieldMacrotask(): Promise<void> {
  // A macrotask (not a microtask) so a worker event loop can run queued
  // messages -- e.g. the cancel message that flips the AbortSignal. Not
  // setTimeout: browsers clamp nested timers to 4 ms and Windows Node timers
  // run at ~15 ms, which made a 750k-point field build wait ~6 s for ~0.6 s of
  // drop work (WO-2096). A MessageChannel task (browser worker) or setImmediate
  // (Node) yields to queued messages without a timer floor.
  if (typeof setImmediate === 'function') {
    return new Promise((resolve) => setImmediate(resolve));
  }
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function validateGrid(g: GridSpec): void {
  if (!Number.isInteger(g.nx) || g.nx < 1 || !Number.isInteger(g.ny) || g.ny < 1) {
    throw new Error(`BvhKernel: invalid grid nx=${g.nx} ny=${g.ny}`);
  }
  for (const [key, v] of [
    ['x0', g.x0], ['y0', g.y0], ['dx', g.dx], ['dy', g.dy], ['zSeed', g.zSeed],
  ] as const) {
    if (!Number.isFinite(v)) throw new Error(`BvhKernel: non-finite grid ${key}=${v}`);
  }
}

function buildCellIndex(
  positions: Float32Array,
  indices: Uint32Array,
  triZMax: Float32Array,
): CellIndex {
  const triCount = indices.length / 3;
  const triMinX = new Float64Array(triCount);
  const triMaxX = new Float64Array(triCount);
  const triMinY = new Float64Array(triCount);
  const triMaxY = new Float64Array(triCount);
  let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
  let spanSum = 0;
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1];
    const bx = positions[ib], by = positions[ib + 1];
    const cx = positions[ic], cy = positions[ic + 1];
    const mnx = Math.min(ax, bx, cx);
    const mxx = Math.max(ax, bx, cx);
    const mny = Math.min(ay, by, cy);
    const mxy = Math.max(ay, by, cy);
    triMinX[t] = mnx; triMaxX[t] = mxx;
    triMinY[t] = mny; triMaxY[t] = mxy;
    if (mnx < gx0) gx0 = mnx;
    if (mxx > gx1) gx1 = mxx;
    if (mny < gy0) gy0 = mny;
    if (mxy > gy1) gy1 = mxy;
    spanSum += Math.max(mxx - mnx, mxy - mny);
  }
  const spanX = Math.max(gx1 - gx0, 1e-9);
  const spanY = Math.max(gy1 - gy0, 1e-9);
  // Cell edge ~ 4 average triangle AABB spans, tuned on the wave benchmark:
  // 1.4x/2x/3x/4x/5x spans measured ball cpu 1234/891/765/742/758 ms -- the
  // per-cell setup (rect distance, slack, selection bookkeeping) costs more
  // than letting the z-sorted BREAK handle longer lists, so fewer, larger
  // cells win until cellZMax loses sharpness past ~5x. Larger cells also
  // keep duplicate entries low (a triangle lands in ~1.2 cells). Caps bound
  // memory for pathological meshes (one huge sliver, or a giant part).
  const avgSpan = spanSum / triCount;
  const target = Math.max(avgSpan * 4, Math.max(spanX, spanY) / 512, 1e-6);
  const nx = Math.max(1, Math.min(1024, Math.ceil(spanX / target)));
  const ny = Math.max(1, Math.min(1024, Math.ceil(spanY / target)));
  const csx = spanX / nx;
  const csy = spanY / ny;
  const cellCount = nx * ny;

  const clampX = (v: number): number => (v < 0 ? 0 : v >= nx ? nx - 1 : v);
  const clampY = (v: number): number => (v < 0 ? 0 : v >= ny ? ny - 1 : v);

  // Pass 1: entry counts per cell.
  const counts = new Uint32Array(cellCount);
  for (let t = 0; t < triCount; t++) {
    const ix0 = clampX(Math.floor((triMinX[t] - gx0) / csx));
    const ix1 = clampX(Math.floor((triMaxX[t] - gx0) / csx));
    const iy0 = clampY(Math.floor((triMinY[t] - gy0) / csy));
    const iy1 = clampY(Math.floor((triMaxY[t] - gy0) / csy));
    for (let jy = iy0; jy <= iy1; jy++) {
      for (let jx = ix0; jx <= ix1; jx++) counts[jy * nx + jx]++;
    }
  }
  const cellStart = new Uint32Array(cellCount + 1);
  for (let ci = 0; ci < cellCount; ci++) cellStart[ci + 1] = cellStart[ci] + counts[ci];

  // Pass 2: fill in GLOBAL z-descending triangle order so every per-cell
  // list comes out z-sorted for free (tie-break on id keeps it fully
  // deterministic).
  const order = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) order[t] = t;
  order.sort((a, b) => triZMax[b] - triZMax[a] || a - b);
  const entries = new Uint32Array(cellStart[cellCount]);
  const fill = cellStart.slice(0, cellCount);
  for (let k = 0; k < triCount; k++) {
    const t = order[k];
    const ix0 = clampX(Math.floor((triMinX[t] - gx0) / csx));
    const ix1 = clampX(Math.floor((triMaxX[t] - gx0) / csx));
    const iy0 = clampY(Math.floor((triMinY[t] - gy0) / csy));
    const iy1 = clampY(Math.floor((triMaxY[t] - gy0) / csy));
    for (let jy = iy0; jy <= iy1; jy++) {
      for (let jx = ix0; jx <= ix1; jx++) entries[fill[jy * nx + jx]++] = t;
    }
  }
  const cellZMax = new Float32Array(cellCount).fill(-Infinity);
  for (let ci = 0; ci < cellCount; ci++) {
    if (cellStart[ci] < cellStart[ci + 1]) cellZMax[ci] = triZMax[entries[cellStart[ci]]];
  }
  // Interleaved per-entry gate records so the walk reads one sequential
  // stream (the per-triangle AABB arrays above are build-time scratch).
  const entryGate = new Float64Array(entries.length * GATE_STRIDE);
  for (let k = 0; k < entries.length; k++) {
    const t = entries[k];
    const base = k * GATE_STRIDE;
    entryGate[base] = triZMax[t];
    entryGate[base + 1] = triMinX[t];
    entryGate[base + 2] = triMaxX[t];
    entryGate[base + 3] = triMinY[t];
    entryGate[base + 4] = triMaxY[t];
  }
  return { gx0, gy0, gx1, gy1, csx, csy, nx, ny, cellStart, entries, entryGate, cellZMax };
}

export class BvhKernel implements GeometryKernel {
  readonly name = 'bvh';

  private readonly meshes = new DisposalRegistry<MeshRecord>();
  private readonly cutters = new DisposalRegistry<CutterRecord>();

  /** Live handle counts, exposed for leak assertions in tests. */
  get liveMeshCount(): number {
    return this.meshes.liveCount;
  }
  get liveCutterCount(): number {
    return this.cutters.liveCount;
  }

  uploadMesh(mesh: PartMesh): MeshHandle {
    const vertexCount = mesh.positions.length / 3;
    if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0) {
      throw new Error(`BvhKernel: positions length ${mesh.positions.length} is not xyz triples`);
    }
    if (mesh.indices.length === 0 || mesh.indices.length % 3 !== 0) {
      throw new Error(`BvhKernel: indices length ${mesh.indices.length} is not triangle triples`);
    }
    for (let i = 0; i < mesh.indices.length; i++) {
      if (mesh.indices[i] >= vertexCount) {
        throw new Error(`BvhKernel: index ${mesh.indices[i]} out of range (${vertexCount} verts)`);
      }
    }
    for (let i = 0; i < mesh.positions.length; i++) {
      // NaN/Infinity would silently poison the z-sorted culling index and
      // every max comparison downstream -- fail loud at the boundary.
      if (!Number.isFinite(mesh.positions[i])) {
        throw new Error(`BvhKernel: non-finite position component at ${i}`);
      }
    }
    // Copy: the contract lets the caller mutate its arrays after upload,
    // and the BVH build reorders the index in place.
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    const bvh = new MeshBVH(geometry);
    // Everything below is computed AFTER the build, in the reordered
    // triangle order the BVH produced.
    const triCount = indices.length / 3;
    const triZMax = new Float32Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const za = positions[indices[t * 3] * 3 + 2];
      const zb = positions[indices[t * 3 + 1] * 3 + 2];
      const zc = positions[indices[t * 3 + 2] * 3 + 2];
      triZMax[t] = Math.max(za, zb, zc);
    }
    const triVerts = new Float64Array(triCount * 9);
    for (let t = 0; t < triCount; t++) {
      for (let v = 0; v < 3; v++) {
        const src = indices[t * 3 + v] * 3;
        const dst = t * 9 + v * 3;
        triVerts[dst] = positions[src];
        triVerts[dst + 1] = positions[src + 1];
        triVerts[dst + 2] = positions[src + 2];
      }
    }
    const cells = buildCellIndex(positions, indices, triZMax);
    const record: MeshRecord = { bvh, geometry, positions, indices, triZMax, triVerts, cells };
    const id = this.meshes.register(
      record,
      (r) => {
        // BufferGeometry.dispose only matters for GPU buffers, but calling
        // it keeps the lifecycle uniform if a renderer ever sees this
        // geometry; the typed arrays are freed by GC once unreferenced.
        r.geometry.dispose();
      },
      'mesh',
    );
    return id as MeshHandle;
  }

  releaseMesh(h: MeshHandle): void {
    this.meshes.dispose(h);
  }

  makeCutter(spec: CutterSpec): CutterHandle {
    if (!Number.isFinite(spec.diameter) || spec.diameter <= 0) {
      throw new Error(`BvhKernel: invalid cutter diameter ${spec.diameter}`);
    }
    const radius = spec.diameter / 2;
    let cornerRadius = 0;
    if (spec.kind === 'bull') {
      // Same tolerance as integration/cutterSpec.ts: a corner radius a
      // rounding hair above the tool radius is the ball, not an error.
      if (!Number.isFinite(spec.cornerRadius) || spec.cornerRadius < 0 || spec.cornerRadius > radius + 1e-9) {
        throw new Error(`BvhKernel: invalid bull corner radius ${spec.cornerRadius} for tool radius ${radius}`);
      }
      cornerRadius = Math.min(spec.cornerRadius, radius);
    }
    let slopeK = 0;
    let tipRadius = 0;
    if (spec.kind === 'vbit') {
      // A half-angle outside (0, 90) deg from the axis is no cone: 0 has an
      // infinite flank, 90 and beyond no flank at all.
      const angle = spec.angleFromAxisDeg;
      if (!Number.isFinite(angle) || angle <= 0 || angle >= 90) {
        throw new Error(`BvhKernel: invalid vbit angle ${angle} deg from the axis (needs 0 < angle < 90)`);
      }
      const tipDiameter = spec.tipDiameter ?? 0;
      if (!Number.isFinite(tipDiameter) || tipDiameter < 0 || tipDiameter >= spec.diameter) {
        throw new Error(`BvhKernel: invalid vbit tip diameter ${tipDiameter} for tool diameter ${spec.diameter}`);
      }
      slopeK = coneSlopeK(angle);
      tipRadius = tipDiameter / 2;
    }
    const record: CutterRecord = { kind: spec.kind, radius, cornerRadius, slopeK, tipRadius };
    const id = this.cutters.register(record, () => undefined, 'cutter');
    return id as CutterHandle;
  }

  releaseCutter(c: CutterHandle): void {
    this.cutters.dispose(c);
  }

  async dropGrid(
    m: MeshHandle,
    c: CutterHandle,
    g: GridSpec,
    opts?: { signal?: AbortSignal; onProgress?: (f: number) => void; surfaceZ?: Float64Array },
  ): Promise<Float64Array> {
    const mesh = this.meshes.lookup(m);
    const cutter = this.cutters.lookup(c);
    validateGrid(g);
    const signal = opts?.signal;
    const onProgress = opts?.onProgress;
    const surfaceZ = opts?.surfaceZ;
    if (surfaceZ !== undefined && surfaceZ.length !== g.nx * g.ny) {
      throw new Error(`BvhKernel: surfaceZ length ${surfaceZ.length} does not match grid size ${g.nx * g.ny}`);
    }
    throwIfAborted(signal); // pre-aborted: reject before any work

    const total = g.nx * g.ny;
    const out = new Float64Array(total);
    const query = makeDropQuery(mesh, cutter);
    // A zero-radius flat profile is a vertical point probe. It is internal to
    // this one batched traversal (not a second kernel call) and supplies the
    // physical surface datum needed by excess-lift strategies.
    const surfaceQuery = surfaceZ === undefined
      ? undefined
      : makeDropQuery(mesh, { kind: 'flat', radius: 0, cornerRadius: 0, slopeK: 0, tipRadius: 0 });
    const rowsPerChunk = Math.max(1, Math.round(CHUNK_POINTS / g.nx));

    let iy = 0;
    while (iy < g.ny) {
      const rowEnd = Math.min(g.ny, iy + rowsPerChunk);
      for (; iy < rowEnd; iy++) {
        const y = g.y0 + iy * g.dy;
        let idx = iy * g.nx;
        for (let ix = 0; ix < g.nx; ix++, idx++) {
          const x = g.x0 + ix * g.dx;
          out[idx] = query(x, y, g.zSeed);
          if (surfaceQuery !== undefined) surfaceZ![idx] = surfaceQuery(x, y, g.zSeed);
        }
      }
      onProgress?.((iy * g.nx) / total);
      throwIfAborted(signal); // covers abort() called from inside onProgress
      if (iy < g.ny) {
        await yieldMacrotask();
        throwIfAborted(signal); // covers cancel delivered during the yield
      }
    }
    return out;
  }

  async dropPath(
    m: MeshHandle,
    c: CutterHandle,
    xy: Float64Array,
    zSeed: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Float64Array> {
    const mesh = this.meshes.lookup(m);
    const cutter = this.cutters.lookup(c);
    if (xy.length % 2 !== 0) {
      throw new Error(`BvhKernel: dropPath xy length ${xy.length} is not (x, y) pairs`);
    }
    if (!Number.isFinite(zSeed)) {
      throw new Error(`BvhKernel: non-finite zSeed ${zSeed}`);
    }
    const signal = opts?.signal;
    throwIfAborted(signal);

    const n = xy.length / 2;
    const out = new Float64Array(n);
    const query = makeDropQuery(mesh, cutter);
    for (let i = 0; i < n; i++) {
      out[i] = query(xy[2 * i], xy[2 * i + 1], zSeed);
      if ((i + 1) % CHUNK_POINTS === 0 && i + 1 < n) {
        throwIfAborted(signal);
        await yieldMacrotask();
        throwIfAborted(signal);
      }
    }
    return out;
  }

  dropPoints(
    m: MeshHandle,
    c: CutterHandle,
    xy: Float64Array,
    zSeed: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Float64Array> {
    // Same validation, batch loop (deterministic order, one reusable query
    // closure, no per-point allocation) and per-point drop routine as
    // dropPath: dropPoints is the arbitrary-sample-set name for the same
    // operation (see the interface contract in types.ts). Delegating keeps
    // ONE copy of the loop so the two can never drift apart; byte-identical
    // results at identical coordinates fall out for free.
    return this.dropPath(m, c, xy, zSeed, opts);
  }
}

/**
 * Build a reusable single-point drop query over one mesh/cutter pair.
 * One closure serves the whole batch, so the per-point cost is cell walks
 * plus exact contact math, with no allocation.
 *
 * Ball-specific pruning (the flat prune alone measured 4.6s on the perf
 * benchmark for ball, because the ball tip rests up to R*(1-n.z) BELOW
 * nearby surface z, so zmax rarely beats best on slopes): for ANY ball
 * contact point cp at xy distance d from the cutter axis the tip sits at
 *   tip = cp.z + sqrt(R^2 - d^2) - R,
 * so a triangle's contribution is bounded by
 *   triZMax + sqrt(R^2 - dmin^2) - R
 * with dmin the axis-to-AABB xy distance -- a "distance slack" that is 0
 * under the axis and -R at the footprint rim. The slack is applied at cell
 * level (skip + z-sorted BREAK threshold, sound because every triangle in
 * a cell is at least the cell's distance away) and per triangle. Flat
 * cutters have zero slack by nature (the disk supports at cp.z directly).
 * A bull's tip sits cp.z + phi(d - Rf) with phi <= 0 non-increasing (see
 * dropCutterBull.ts), so its slack is phi(dmin - Rf): 0 over the flat core,
 * -rc at the rim -- the same bound shape, shifted out by Rf. A V-bit's
 * phi is -k * max(0, d - Rt) (see dropCutterCone.ts), also non-increasing,
 * so its slack is -k * max(0, dmin - Rt): 0 over the tip flat, -k(R - Rt)
 * at the rim.
 */
function makeDropQuery(
  mesh: MeshRecord,
  cutter: CutterRecord,
): (x: number, y: number, zSeed: number) => number {
  const { triVerts, cells } = mesh;
  const { gx0, gy0, gx1, gy1, csx, csy, nx, ny, cellStart, entries, entryGate, cellZMax } = cells;
  const radius = cutter.radius;
  const r2 = radius * radius;
  const isBall = cutter.kind === 'ball';
  const isBull = cutter.kind === 'bull';
  const isCone = cutter.kind === 'vbit';
  const slopeK = cutter.slopeK;
  const tipR = cutter.tipRadius;
  const tipR2 = tipR * tipR;
  const corner = cutter.cornerRadius;
  const flatR = radius - corner > 0 ? radius - corner : 0;
  const flatR2 = flatR * flatR;
  // Bull slack at squared axis distance d2 (<= r2): phi(sqrt(d2) - Rf).
  const bullSlack = (d2: number): number => {
    if (d2 <= flatR2) return 0;
    const u = Math.sqrt(d2) - flatR;
    const w2 = corner * corner - u * u;
    return (w2 > 0 ? Math.sqrt(w2) : 0) - corner;
  };
  // V-bit slack at squared axis distance d2 (<= r2): -k * max(0, sqrt(d2) - Rt).
  const coneSlack = (d2: number): number => (d2 <= tipR2 ? 0 : -slopeK * (Math.sqrt(d2) - tipR));
  const dropTri = isCone
    ? (
      rad: number, px: number, py: number,
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
    ): number => dropTriangleConeCore(rad, slopeK, tipR, px, py, ax, ay, az, bx, by, bz, cx, cy, cz)
    : isBull
    ? (
      rad: number, px: number, py: number,
      ax: number, ay: number, az: number,
      bx: number, by: number, bz: number,
      cx: number, cy: number, cz: number,
    ): number => dropTriangleBullCore(rad, corner, px, py, ax, ay, az, bx, by, bz, cx, cy, cz)
    : isBall ? dropTriangleBallCore : dropTriangleFlatCore;

  let qx = 0;
  let qy = 0;

  // Reusable scratch for the footprint cells of one query (allocated once
  // per batch): candidate cell ids, their distance slack, and their upper
  // bound. Sized for the largest footprint the cutter can cover.
  const maxCellsX = Math.min(nx, Math.ceil((2 * radius) / csx) + 2);
  const maxCellsY = Math.min(ny, Math.ceil((2 * radius) / csy) + 2);
  const maxCells = maxCellsX * maxCellsY;
  const candCi = new Int32Array(maxCells);
  const candSlack = new Float64Array(maxCells);
  const candBound = new Float64Array(maxCells);

  // Walk one cell's z-sorted list. `slack` is the cell-level distance slack
  // (<= 0; always 0 for flat): BREAK at the first triangle whose zmax plus
  // slack cannot beat best -- everything after it is lower still. The gate
  // reads the interleaved entryGate stream sequentially; only survivors
  // touch the (much larger) triangle vertex table.
  const walk = (ci: number, best: number, slack: number): number => {
    const end = cellStart[ci + 1];
    let threshold = best - slack;
    for (let k = cellStart[ci]; k < end; k++) {
      const gbase = k * GATE_STRIDE;
      const zTop = entryGate[gbase];
      if (zTop <= threshold) break;
      // Tighter per-triangle gate: axis distance to the triangle's own AABB.
      const mnx = entryGate[gbase + 1];
      const mxx = entryGate[gbase + 2];
      const dx = qx < mnx ? mnx - qx : qx > mxx ? qx - mxx : 0;
      const mny = entryGate[gbase + 3];
      const mxy = entryGate[gbase + 4];
      const dy = qy < mny ? mny - qy : qy > mxy ? qy - mxy : 0;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue; // AABB outside the footprint disk: no contact
      if (isBall) {
        // Skip when zTop + sqrt(r2 - d2) - radius <= best, rearranged to
        // avoid the sqrt in this hot gate: sqrt(r2 - d2) <= rhs with both
        // sides squared (rhs < 0 means the gate can never skip).
        const rhs = best + radius - zTop;
        if (rhs >= 0 && r2 - d2 <= rhs * rhs) continue;
      } else if (isBull && zTop + bullSlack(d2) <= best) {
        continue;
      } else if (isCone && zTop + coneSlack(d2) <= best) {
        continue;
      }
      // The circle-vs-AABB gate above is strictly tighter than the square
      // AABB fast path inside the public dropTriangle* wrappers, so the
      // Core variants (identical results, no recheck) are called here.
      const vbase = entries[k] * 9;
      const z = dropTri(
        radius, qx, qy,
        triVerts[vbase], triVerts[vbase + 1], triVerts[vbase + 2],
        triVerts[vbase + 3], triVerts[vbase + 4], triVerts[vbase + 5],
        triVerts[vbase + 6], triVerts[vbase + 7], triVerts[vbase + 8],
      );
      if (z > best) {
        best = z;
        threshold = best - slack;
      }
    }
    return best;
  };

  return (x: number, y: number, zSeed: number): number => {
    let best = zSeed; // doubles as the miss value and the >= zSeed clamp
    if (x + radius < gx0 || x - radius > gx1 || y + radius < gy0 || y - radius > gy1) {
      return best;
    }
    qx = x;
    qy = y;
    const fx0 = Math.floor((x - radius - gx0) / csx);
    const fx1 = Math.floor((x + radius - gx0) / csx);
    const fy0 = Math.floor((y - radius - gy0) / csy);
    const fy1 = Math.floor((y + radius - gy0) / csy);
    const ix0 = fx0 < 0 ? 0 : fx0 >= nx ? nx - 1 : fx0;
    const ix1 = fx1 < 0 ? 0 : fx1 >= nx ? nx - 1 : fx1;
    const iy0 = fy0 < 0 ? 0 : fy0 >= ny ? ny - 1 : fy0;
    const iy1 = fy1 < 0 ? 0 : fy1 >= ny ? ny - 1 : fy1;

    // Pass 1: collect footprint cells with their distance slack and upper
    // bound. Cells whose rect misses the disk are skipped exactly: every
    // contact point lies inside the closed footprint disk (and inside its
    // triangle), so such a cell holds no reachable contact.
    let m = 0;
    for (let jy = iy0; jy <= iy1; jy++) {
      const cellY0 = gy0 + jy * csy;
      const nearY = y < cellY0 ? cellY0 : y > cellY0 + csy ? cellY0 + csy : y;
      const dy = y - nearY;
      const dy2 = dy * dy;
      if (dy2 > r2) continue;
      const rowBase = jy * nx;
      for (let jx = ix0; jx <= ix1; jx++) {
        const ci = rowBase + jx;
        const zTop = cellZMax[ci];
        if (zTop <= best) continue; // empty cells land here too (-Infinity)
        const cellX0 = gx0 + jx * csx;
        const nearX = x < cellX0 ? cellX0 : x > cellX0 + csx ? cellX0 + csx : x;
        const dx = x - nearX;
        const d2 = dx * dx + dy2;
        if (d2 > r2) continue;
        const slack = isBall
          ? Math.sqrt(r2 - d2) - radius
          : isBull ? bullSlack(d2) : isCone ? coneSlack(d2) : 0;
        const bound = zTop + slack;
        if (bound <= best) continue;
        candCi[m] = ci;
        candSlack[m] = slack;
        candBound[m] = bound;
        m++;
      }
    }
    if (m === 0) return best;

    // Pass 2: walk cells strictly in bound-DESCENDING order via selection
    // (deterministic: strict > keeps the first/lowest-index cell on ties).
    // After the first walk best is near-final, so typically only a couple
    // more cells survive their bound check; selection is O(walks * m),
    // cheaper than sorting all m candidates up front, and terminates as
    // soon as no remaining bound can beat best.
    for (;;) {
      let bi = -1;
      let bb = best;
      for (let i = 0; i < m; i++) {
        if (candBound[i] > bb) {
          bb = candBound[i];
          bi = i;
        }
      }
      if (bi < 0) return best;
      candBound[bi] = -Infinity; // consumed
      best = walk(candCi[bi], best, candSlack[bi]);
    }
  };
}
