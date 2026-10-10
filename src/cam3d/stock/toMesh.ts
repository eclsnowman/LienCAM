// cam3d stock: greedy-quad display mesh of a ZDexelField.
//
// SURFACE MODEL. A z-dexel field is a set of axis-aligned material columns
// [bottom, top] over the XY grid; its boundary surface decomposes into
//  (a) TOP faces at z = top over every solid column,
//  (b) BOTTOM faces at z = bottom under every solid column,
//  (c) VERTICAL WALLS on the four cell-edge planes wherever a column's
//      interval is exposed relative to its 4-neighbor (interval difference;
//      off-grid neighbors count as air, so the field border walls fully),
//  (d) nothing over EMPTY columns (top === bottom): they are holes -- no top,
//      no bottom, and the solid neighbors wall down their whole interval.
//
// GREEDY MESHING (D-014 vertex budget): adjacent solid columns whose f32 top
// (resp. bottom) values are EXACTLY equal merge into maximal rectangles via
// the classic row-scan greedy mesher; columns with unequal values naturally
// degenerate to per-cell quads. Wall quads on the same plane merge along the
// edge direction while their exposed-segment lists stay identical, so a flat
// pocket side or the field border is ONE quad, not one per cell. An untouched
// fromBox field meshes to exactly the 6 quads of its box.
//
// BUDGET: the triangle count of the EXACT mesh is known before any buffer is
// allocated; if it exceeds the budget this throws naming the count -- it
// NEVER silently decimates (the caller chooses a coarser field instead).
//
// DETERMINISM (D-006): fixed scan orders (top rects, bottom rects, x-plane
// walls, y-plane walls; j outer / i inner everywhere), vertex dedup keyed by
// exact f32 bit patterns in first-emission order -- identical fields produce
// byte-identical positions/indices.
//
// WINDING: CCW viewed from outside the material (+z up for top faces); the
// dev viewer flat-shades with front-side culling, so outward normals are
// load-bearing here, not cosmetic.

import type { ZDexelField } from './zdexel';

/** D-014 default triangle budget for a stock display mesh. */
export const DEFAULT_TRIANGLE_BUDGET = 2_000_000;

export interface StockMesh {
  /** xyz triples, mm; deduplicated vertices. */
  positions: Float32Array;
  /** Triangle vertex indices into positions/3. */
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

/** Maximal same-value rectangle of solid columns (cell units). */
interface Rect {
  i: number;
  j: number;
  w: number;
  h: number;
  /** The shared f32 top (or bottom) value. */
  v: number;
}

/**
 * One merged wall quad. axis 0: plane x = originX + plane*cell, run spans
 * cells a0..a1 (exclusive) along y. axis 1: plane y = originY + plane*cell,
 * run along x. facing +1 = outward normal points toward +axis.
 */
interface WallQuad {
  axis: 0 | 1;
  plane: number;
  a0: number;
  a1: number;
  z0: number;
  z1: number;
  facing: 1 | -1;
}

/**
 * Greedy row-scan rectangle cover of the solid columns, merging EXACTLY
 * equal f32 values of `vals` (top or bottom array). Deterministic: j outer,
 * i inner, widest-run-first extension.
 */
function greedyRects(
  vals: Float32Array,
  top: Float32Array,
  bottom: Float32Array,
  nx: number,
  ny: number,
): Rect[] {
  const visited = new Uint8Array(nx * ny);
  const rects: Rect[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (visited[c] === 1 || !(top[c] > bottom[c])) continue;
      const v = vals[c];
      let w = 1;
      while (i + w < nx) {
        const cc = c + w;
        if (visited[cc] === 1 || !(top[cc] > bottom[cc]) || vals[cc] !== v) break;
        w++;
      }
      let h = 1;
      grow: while (j + h < ny) {
        const rowBase = (j + h) * nx + i;
        for (let k = 0; k < w; k++) {
          const cc = rowBase + k;
          if (visited[cc] === 1 || !(top[cc] > bottom[cc]) || vals[cc] !== v) break grow;
        }
        h++;
      }
      for (let jj = 0; jj < h; jj++) {
        visited.fill(1, (j + jj) * nx + i, (j + jj) * nx + i + w);
      }
      rects.push({ i, j, w, h, v });
    }
  }
  return rects;
}

/**
 * Exposed z-segments of interval [bot, top] against the neighbor interval
 * [obot, otop] (interval difference), pushed as (z0, z1, facing) triples.
 * A non-solid neighbor (or off-grid air) exposes the whole interval.
 */
function pushExposed(
  bot: number,
  top: number,
  obot: number,
  otop: number,
  neighborSolid: boolean,
  facing: 1 | -1,
  out: number[],
): void {
  if (!(top > bot)) return; // this column is empty: nothing to expose
  if (!neighborSolid) {
    out.push(bot, top, facing);
    return;
  }
  // below the neighbor's interval
  if (obot > bot) out.push(bot, obot < top ? obot : top, facing);
  // above the neighbor's interval
  if (otop < top) out.push(otop > bot ? otop : bot, top, facing);
}

function segsEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Collect merged wall quads for one plane family. axis 0 walks planes
 * i = 0..nx (x-planes, runs along y); axis 1 walks planes j = 0..ny
 * (y-planes, runs along x). Fixed scan order (plane ascending, run cell
 * ascending) for determinism.
 */
function collectWalls(field: ZDexelField, axis: 0 | 1, out: WallQuad[]): void {
  const { nx, ny, top, bottom } = field;
  const nPlanes = axis === 0 ? nx : ny;
  const runLen = axis === 0 ? ny : nx;

  for (let p = 0; p <= nPlanes; p++) {
    let runStart = 0;
    let prev: number[] = [];
    const flush = (end: number): void => {
      for (let k = 0; k < prev.length; k += 3) {
        out.push({
          axis,
          plane: p,
          a0: runStart,
          a1: end,
          z0: prev[k],
          z1: prev[k + 1],
          facing: prev[k + 2] as 1 | -1,
        });
      }
    };
    for (let a = 0; a < runLen; a++) {
      // Column A on the negative side of the plane, B on the positive side.
      const cA =
        p > 0 ? (axis === 0 ? a * nx + (p - 1) : (p - 1) * nx + a) : -1;
      const cB =
        p < nPlanes ? (axis === 0 ? a * nx + p : p * nx + a) : -1;
      const aTop = cA >= 0 ? top[cA] : 0;
      const aBot = cA >= 0 ? bottom[cA] : 0;
      const bTop = cB >= 0 ? top[cB] : 0;
      const bBot = cB >= 0 ? bottom[cB] : 0;
      const aSolid = cA >= 0 && aTop > aBot;
      const bSolid = cB >= 0 && bTop > bBot;

      const segs: number[] = [];
      if (aSolid) pushExposed(aBot, aTop, bBot, bTop, bSolid, 1, segs);
      if (bSolid) pushExposed(bBot, bTop, aBot, aTop, aSolid, -1, segs);

      if (!segsEqual(segs, prev)) {
        flush(a);
        runStart = a;
        prev = segs;
      }
    }
    flush(runLen);
  }
}

/**
 * Mesh the field's boundary surface (module header). Throws when the exact
 * mesh exceeds `triangleBudget` -- loud, never decimated.
 */
export function toMesh(
  field: ZDexelField,
  triangleBudget: number = DEFAULT_TRIANGLE_BUDGET,
): StockMesh {
  if (!Number.isFinite(triangleBudget) || triangleBudget < 1) {
    throw new Error(
      `stock toMesh: triangleBudget must be a positive number, got ${triangleBudget}.`,
    );
  }
  const { nx, ny, originX, originY, cell, top, bottom } = field;

  const topRects = greedyRects(top, top, bottom, nx, ny);
  const botRects = greedyRects(bottom, top, bottom, nx, ny);
  const walls: WallQuad[] = [];
  collectWalls(field, 0, walls);
  collectWalls(field, 1, walls);

  const quadCount = topRects.length + botRects.length + walls.length;
  const triangleCount = quadCount * 2;
  if (triangleCount > triangleBudget) {
    throw new Error(
      `stock toMesh: exact mesh needs ${triangleCount} triangles, over the ` +
        `budget of ${triangleBudget}. Refusing to decimate silently -- use a ` +
        `coarser field (larger cell size) or raise the budget.`,
    );
  }

  // ---- emission with exact-bit vertex dedup ----
  const positions = new Float32Array(quadCount * 4 * 3); // upper bound
  const indices = new Uint32Array(quadCount * 6);
  const vertIndex = new Map<string, number>();
  const scratchF = new Float32Array(3);
  const scratchU = new Uint32Array(scratchF.buffer);
  let vCount = 0;
  let iCount = 0;

  const vid = (x: number, y: number, z: number): number => {
    scratchF[0] = x;
    scratchF[1] = y;
    scratchF[2] = z;
    const key = `${scratchU[0]},${scratchU[1]},${scratchU[2]}`;
    let idx = vertIndex.get(key);
    if (idx === undefined) {
      idx = vCount++;
      const o = idx * 3;
      positions[o] = scratchF[0];
      positions[o + 1] = scratchF[1];
      positions[o + 2] = scratchF[2];
      vertIndex.set(key, idx);
    }
    return idx;
  };

  /** Emit quad v0-v1-v2-v3 as triangles (v0,v1,v2), (v0,v2,v3): CCW order in. */
  const quad = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
  ): void => {
    const a = vid(x0, y0, z0);
    const b = vid(x1, y1, z1);
    const c = vid(x2, y2, z2);
    const d = vid(x3, y3, z3);
    indices[iCount++] = a;
    indices[iCount++] = b;
    indices[iCount++] = c;
    indices[iCount++] = a;
    indices[iCount++] = c;
    indices[iCount++] = d;
  };

  // Top faces, normal +z.
  for (const r of topRects) {
    const x0 = originX + r.i * cell;
    const x1 = originX + (r.i + r.w) * cell;
    const y0 = originY + r.j * cell;
    const y1 = originY + (r.j + r.h) * cell;
    quad(x0, y0, r.v, x1, y0, r.v, x1, y1, r.v, x0, y1, r.v);
  }
  // Bottom faces, normal -z.
  for (const r of botRects) {
    const x0 = originX + r.i * cell;
    const x1 = originX + (r.i + r.w) * cell;
    const y0 = originY + r.j * cell;
    const y1 = originY + (r.j + r.h) * cell;
    quad(x0, y0, r.v, x0, y1, r.v, x1, y1, r.v, x1, y0, r.v);
  }
  // Walls. axis 0: plane x fixed, run along y; axis 1: plane y fixed, run x.
  for (const w of walls) {
    if (w.axis === 0) {
      const x = originX + w.plane * cell;
      const y0 = originY + w.a0 * cell;
      const y1 = originY + w.a1 * cell;
      if (w.facing === 1) {
        // normal +x
        quad(x, y0, w.z0, x, y1, w.z0, x, y1, w.z1, x, y0, w.z1);
      } else {
        // normal -x
        quad(x, y0, w.z0, x, y0, w.z1, x, y1, w.z1, x, y1, w.z0);
      }
    } else {
      const y = originY + w.plane * cell;
      const x0 = originX + w.a0 * cell;
      const x1 = originX + w.a1 * cell;
      if (w.facing === 1) {
        // normal +y
        quad(x0, y, w.z0, x0, y, w.z1, x1, y, w.z1, x1, y, w.z0);
      } else {
        // normal -y
        quad(x0, y, w.z0, x1, y, w.z0, x1, y, w.z1, x0, y, w.z1);
      }
    }
  }

  return {
    positions: positions.slice(0, vCount * 3),
    indices,
    vertexCount: vCount,
    triangleCount,
  };
}
