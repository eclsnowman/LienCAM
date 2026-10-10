// cam3d stock: trace the XY region where material remains above a z plane.
//
// The mask is per-column boolean: solid(i, j) when the column holds material
// (top > bottom) AND its top exceeds z + epsilon. The traced region is the
// UNION OF SOLID CELL SQUARES -- block-style marching squares at cell
// resolution, not interpolated: the returned rings run along cell boundaries
// (world mm), so ring area equals solidCellCount * cell^2 exactly and the
// boundary is within one cell of the true material boundary (the field's own
// resolution; nothing downstream can know the surface finer than that).
//
// ALGORITHM (deterministic, D-006):
//  1. Emit one directed boundary edge per solid-cell side that faces air or
//     the grid border, directed so SOLID IS ON THE LEFT (bottom edge -> +x,
//     right -> +y, top -> -x, left -> -y). Cells are scanned j-outer/i-inner,
//     edges per cell in the fixed order bottom, right, top, left.
//  2. Chain edges into closed loops. At a saddle node (two solid cells
//     touching diagonally) two boundary loops share the node; the walk takes
//     the SHARPEST LEFT TURN relative to its incoming direction, which
//     resolves the saddle as 4-connectivity (diagonal contact does NOT merge
//     regions) -- a fixed, deterministic corner ordering.
//  3. Drop collinear intermediate points (all segments are axis-aligned unit
//     steps; only direction changes survive).
//
// With solid-on-left directions, outer boundaries come out CCW (positive
// area) and hole boundaries CW (negative area) -- exactly the geom2d ring
// convention, so results feed geom2d booleans/offsets directly.
//
// MEMORY (D-014): the trace allocates O(boundary) numeric arrays plus one
// Int32Array of 2 * nodeCount for the outgoing-edge slots (each node carries
// at most 2 outgoing boundary edges; only a saddle uses the second slot).

import { boolean as geom2dBoolean, type Ring } from '../geom2d';
import type { ZDexelField } from './zdexel';

/** Default epsilon (mm) for "top above z": top > z + EPS_ABOVE. */
export const EPS_ABOVE = 1e-6;

// Direction codes for unit steps between grid nodes: 0=+x, 1=+y, 2=-x, 3=-y.

/**
 * Rings (geom2d convention: CCW outers, CW holes; Float64Array xy pairs,
 * world mm) tracing where field.top > z + epsilon. Empty array when nothing
 * remains above z -- a valid result, not an error.
 *
 * When `region` rings are passed, the traced region is intersected with them
 * via geom2d (requires ensureGeom2dReady() to have resolved; the pure trace
 * itself needs no wasm). An empty intersection returns [].
 */
export function remainingAbove(
  field: ZDexelField,
  z: number,
  region?: readonly Ring[],
  epsilon: number = EPS_ABOVE,
): Ring[] {
  if (!Number.isFinite(z)) {
    throw new Error(`remainingAbove: z must be finite, got ${z}.`);
  }
  if (!Number.isFinite(epsilon) || epsilon < 0) {
    throw new Error(`remainingAbove: epsilon must be finite and >= 0, got ${epsilon}.`);
  }
  const { nx, ny, top, bottom } = field;
  const zCut = z + epsilon;

  // --- 1. mask + directed boundary edges -------------------------------
  // Node (i, j) sits at world (originX + i*cell, originY + j*cell); node id
  // = j * nodesX + i. Outgoing edge slots per node: out[2*node] / out[2*node+1]
  // hold the TARGET node id, -1 when free/consumed.
  const nodesX = nx + 1;
  const nodeCount = nodesX * (ny + 1);
  const out = new Int32Array(2 * nodeCount).fill(-1);
  // Edge starts in creation order (loop-start candidates), packed start ids
  // paired with targets so consumed edges are recognizable.
  const edgeStarts: number[] = [];
  const edgeEnds: number[] = [];

  const solid = new Uint8Array(nx * ny);
  for (let c = 0; c < solid.length; c++) {
    solid[c] = top[c] > bottom[c] && top[c] > zCut ? 1 : 0;
  }

  const addEdge = (from: number, to: number): void => {
    if (out[2 * from] === -1) out[2 * from] = to;
    else if (out[2 * from + 1] === -1) out[2 * from + 1] = to;
    else throw new Error('remainingAbove: >2 outgoing boundary edges at one node (internal bug)');
    edgeStarts.push(from);
    edgeEnds.push(to);
  };

  for (let j = 0; j < ny; j++) {
    const rowBase = j * nx;
    const nodeRow = j * nodesX;
    for (let i = 0; i < nx; i++) {
      if (solid[rowBase + i] === 0) continue;
      const bl = nodeRow + i; // bottom-left node of the cell
      const br = bl + 1;
      const tl = bl + nodesX;
      const tr = tl + 1;
      if (j === 0 || solid[rowBase - nx + i] === 0) addEdge(bl, br); // bottom, +x
      if (i === nx - 1 || solid[rowBase + i + 1] === 0) addEdge(br, tr); // right, +y
      if (j === ny - 1 || solid[rowBase + nx + i] === 0) addEdge(tr, tl); // top, -x
      if (i === 0 || solid[rowBase + i - 1] === 0) addEdge(tl, bl); // left, -y
    }
  }
  if (edgeStarts.length === 0) return [];

  // --- 2 + 3. chain into loops, dropping collinear points --------------
  const dirOf = (from: number, to: number): number => {
    const d = to - from;
    if (d === 1) return 0;
    if (d === nodesX) return 1;
    if (d === -1) return 2;
    return 3; // -nodesX
  };
  const takeEdge = (from: number, preferredDirs: readonly number[]): number => {
    for (const want of preferredDirs) {
      for (let s = 0; s < 2; s++) {
        const to = out[2 * from + s];
        if (to !== -1 && dirOf(from, to) === want) {
          out[2 * from + s] = -1;
          return to;
        }
      }
    }
    throw new Error('remainingAbove: open boundary chain (internal bug)');
  };

  const rings: Ring[] = [];
  const { originX, originY, cell } = field;
  for (let e = 0; e < edgeStarts.length; e++) {
    const start = edgeStarts[e];
    const first = edgeEnds[e];
    // Skip if this exact edge was already consumed by an earlier loop.
    if (out[2 * start] !== first && out[2 * start + 1] !== first) continue;
    // Consume the starting edge from its slot.
    if (out[2 * start] === first) out[2 * start] = -1;
    else out[2 * start + 1] = -1;

    const nodes: number[] = [start];
    let cur = first;
    let dir = dirOf(start, cur);
    while (cur !== start) {
      nodes.push(cur);
      // Sharpest left turn first, then straight, then right (saddle rule).
      const next = takeEdge(cur, [(dir + 1) & 3, dir, (dir + 3) & 3]);
      dir = dirOf(cur, next);
      cur = next;
    }

    // Drop collinear points (cyclic): keep node k only when the incoming and
    // outgoing directions differ.
    const m = nodes.length;
    const kept: number[] = [];
    for (let k = 0; k < m; k++) {
      const prev = nodes[(k + m - 1) % m];
      const nextN = nodes[(k + 1) % m];
      if (dirOf(prev, nodes[k]) !== dirOf(nodes[k], nextN)) kept.push(nodes[k]);
    }
    const ring = new Float64Array(2 * kept.length);
    for (let k = 0; k < kept.length; k++) {
      const node = kept[k];
      ring[2 * k] = originX + (node % nodesX) * cell;
      ring[2 * k + 1] = originY + Math.floor(node / nodesX) * cell;
    }
    rings.push(ring);
  }

  if (region === undefined) return rings;
  return geom2dBoolean(rings, region, 'intersect');
}
