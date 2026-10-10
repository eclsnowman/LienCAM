// cam3d L2: slicing a part too large for the waterline library in one piece
// (WO-2638; Operator ruling 2026-10-06: "If we support it... then say so", item 7).
//
// WO-284 measured the shipped wasm slicer aborting its whole module at a
// footprint / sampling ratio somewhere between 1800 (safe) and 2000 (dead).
// Until WO-2638 the bridge refused anything past 1800. It no longer does:
// the part is cut into XY tiles, each inside the measured-safe ratio, every
// tile is sliced at the operator's own sampling, and the tiles' loops are
// joined back into whole loops.
//
// Why a tile's loops are the part's loops inside it. A cutter centred at a
// point p touches only the surface within one cutter radius of p in XY. Each
// tile slices the mesh CLIPPED to its cell grown by that radius plus a guard
// of two fibres, so for every p in the cell the cutter sees exactly the
// surface it would see on the whole part. The cropped mesh's artificial edge
// makes loops of its own, but only outside the cell, and those are cut away.
//
// The join. The loops at one Z bound the region the cutter centre may not
// enter (even-odd, the library's loops never cross). Each tile's region is
// clipped to its cell, grown by one fibre into its neighbours, and the cells
// are unioned. Where two tiles overlap the union keeps the OUTER of the two
// approximations, so the seam can only move the path away from the part -
// never into it - by at most the slicer's own sampling error.
//
// Pure arithmetic and geom2d rings (callers await ensureGeom2dReady() before
// mergeTileLoops). Deterministic: fixed tile order, canonical loop output.

import type { Ring } from '../geom2d';
import { area, boolean } from '../geom2d';
import type { PartMesh } from './types';

/** The largest footprint / sampling ratio WO-284 measured safe for one slicer run (WO-330 section 3). */
export const WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO = 1800;

export interface XyBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface WaterlineTile {
  /** The part of the plane this tile answers for (grown one fibre into its neighbours). */
  cell: XyBox;
  /** The mesh is clipped to this: the cell grown by the cutter radius and a two-fibre guard. */
  box: XyBox;
}

export interface WaterlineTilePlan {
  /** Larger XY side of the part, mm. */
  footprint: number;
  /** Fibre spacing every tile is sliced at, mm. The asked-for one unless the cutter is enormous (see below). */
  sampling: number;
  /** Tile counts along X and Y. */
  nx: number;
  ny: number;
  /** Side of the largest clipped box, mm; never over ratio x sampling. */
  boxSpan: number;
  /** Row-major (Y outer, X inner). */
  tiles: WaterlineTile[];
}

/**
 * The tiles a slice needs, or null when the part fits the slicer in one piece
 * (the single-piece path is then exactly what it always was).
 */
export function waterlineTilePlan(
  bounds: PartMesh['bounds'],
  cutterRadius: number,
  sampling: number,
  maxRatio: number = WATERLINE_MAX_FOOTPRINT_SAMPLING_RATIO,
): WaterlineTilePlan | null {
  const w = bounds.max[0] - bounds.min[0];
  const h = bounds.max[1] - bounds.min[1];
  const footprint = Math.max(w, h);
  if (!(footprint / sampling > maxRatio)) return null;
  // A tile must keep more cell than margin. Only a cutter hundreds of fibres
  // wide (a 180 mm cutter at 0.1 mm sampling) fails that; it is sliced at a
  // doubled spacing until it fits rather than refused (LIENCAM rule 11).
  let s = sampling;
  for (;;) {
    const margin = cutterRadius + 2 * s;
    const cellMax = maxRatio * s - 2 * margin - 2 * s;
    if (cellMax >= 2 * margin) break;
    s *= 2;
  }
  const margin = cutterRadius + 2 * s;
  const overlap = s;
  const cellMax = maxRatio * s - 2 * margin - 2 * overlap;
  // The loops reach one cutter radius past the part; cover that and a guard.
  const reach = cutterRadius + 2 * s;
  const x0 = bounds.min[0] - reach;
  const y0 = bounds.min[1] - reach;
  const coverW = w + 2 * reach;
  const coverH = h + 2 * reach;
  const nx = Math.max(1, Math.ceil(coverW / cellMax));
  const ny = Math.max(1, Math.ceil(coverH / cellMax));
  const cw = coverW / nx;
  const ch = coverH / ny;
  const tiles: WaterlineTile[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const cell: XyBox = {
        minX: x0 + ix * cw - overlap,
        minY: y0 + iy * ch - overlap,
        maxX: x0 + (ix + 1) * cw + overlap,
        maxY: y0 + (iy + 1) * ch + overlap,
      };
      tiles.push({
        cell,
        box: { minX: cell.minX - margin, minY: cell.minY - margin, maxX: cell.maxX + margin, maxY: cell.maxY + margin },
      });
    }
  }
  return { footprint, sampling: s, nx, ny, boxSpan: Math.max(cw, ch) + 2 * overlap + 2 * margin, tiles };
}

type Vec3 = [number, number, number];

/** Sutherland-Hodgman against one vertical half-plane; exact for a planar triangle. */
function clipAgainst(poly: Vec3[], axis: 0 | 1, bound: number, keepAbove: boolean): Vec3[] {
  const out: Vec3[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const da = keepAbove ? a[axis] - bound : bound - a[axis];
    const db = keepAbove ? b[axis] - bound : bound - b[axis];
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      const p: Vec3 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
      p[axis] = bound;
      out.push(p);
    }
  }
  return out;
}

/**
 * The mesh's triangles clipped to an XY box, in the library's
 * `[[x,y,z],[x,y,z],[x,y,z]]` form. A triangle wholly inside is passed through
 * untouched; one that straddles the box is cut to it and fanned, so the
 * surface inside the box is exactly the original surface.
 */
export function cropTrianglesToBox(mesh: PartMesh, box: XyBox): number[][][] {
  const { positions, indices } = mesh;
  const out: number[][][] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const tri: Vec3[] = [];
    for (let k = 0; k < 3; k++) {
      const o = indices[t + k] * 3;
      tri.push([positions[o], positions[o + 1], positions[o + 2]]);
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of tri) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    if (maxX < box.minX || minX > box.maxX || maxY < box.minY || minY > box.maxY) continue;
    if (minX >= box.minX && maxX <= box.maxX && minY >= box.minY && maxY <= box.maxY) {
      out.push(tri);
      continue;
    }
    let poly = clipAgainst(tri, 0, box.minX, true);
    if (poly.length >= 3) poly = clipAgainst(poly, 0, box.maxX, false);
    if (poly.length >= 3) poly = clipAgainst(poly, 1, box.minY, true);
    if (poly.length >= 3) poly = clipAgainst(poly, 1, box.maxY, false);
    for (let i = 1; i + 1 < poly.length; i++) out.push([poly[0], poly[i], poly[i + 1]]);
  }
  return out;
}

function ringContains(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], yi = ring[2 * i + 1];
    const xj = ring[2 * j], yj = ring[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function reversed(ring: Ring): Ring {
  const n = ring.length / 2;
  const out = new Float64Array(ring.length);
  for (let i = 0; i < n; i++) {
    out[2 * i] = ring[2 * (n - 1 - i)];
    out[2 * i + 1] = ring[2 * (n - 1 - i) + 1];
  }
  return out;
}

/** The library's loops as a NonZero region: by nesting depth, even = outer (CCW), odd = hole (CW). */
function regionOf(loops: readonly Ring[]): Ring[] {
  return loops.map((ring, i) => {
    let depth = 0;
    for (let j = 0; j < loops.length; j++) {
      if (j !== i && ringContains(loops[j], ring[0], ring[1])) depth++;
    }
    const wantCcw = depth % 2 === 0;
    return (area(ring) > 0) === wantCcw ? ring : reversed(ring);
  });
}

const rectRing = (b: XyBox): Ring =>
  new Float64Array([b.minX, b.minY, b.maxX, b.minY, b.maxX, b.maxY, b.minX, b.maxY]);

/**
 * Join per-tile loops into the part's loops: each tile's region clipped to
 * its cell, all cells unioned. Returns the boundary rings as xyz-less point
 * lists for the caller's canonical ordering; rings smaller than one fine
 * fibre square (seam crumbs, never a real loop) are dropped.
 */
export function mergeTileLoops(
  perTile: readonly { cell: XyBox; loops: readonly Ring[] }[],
  minSampling: number,
): Ring[] {
  const pieces: Ring[] = [];
  for (const { cell, loops } of perTile) {
    if (loops.length === 0) continue;
    pieces.push(...boolean(regionOf(loops), [rectRing(cell)], 'intersect'));
  }
  if (pieces.length === 0) return [];
  const merged = boolean(pieces, pieces, 'union');
  return merged.filter((r) => Math.abs(area(r)) >= minSampling * minSampling);
}
