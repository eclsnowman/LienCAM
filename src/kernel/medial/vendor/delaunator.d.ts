// Types for the vendored delaunator.js (see that file's header for provenance).

/** Robust orientation predicate: > 0 when (a, b, c) turn counter-clockwise,
 *  < 0 clockwise, 0 collinear. Exact (adaptive precision). */
export function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number

export default class Delaunator {
  /** Triangulate flat coordinates `[x0, y0, x1, y1, ...]`. Duplicate points are skipped. */
  constructor(coords: ArrayLike<number>)
  coords: ArrayLike<number>
  /** Point indices on the convex hull, counter-clockwise. */
  hull: Uint32Array
  /** Triangle vertex indices, three per triangle, each triangle counter-clockwise. */
  triangles: Uint32Array
  /** Twin half-edge of half-edge i, or -1 on the hull. Half-edge i starts at
   *  point triangles[i]. */
  halfedges: Int32Array
  update(): void
}
