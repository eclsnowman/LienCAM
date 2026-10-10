// cam3d fixtures: small deterministic triangle-mesh builder.
//
// Shared by the procedural fixture generators. Welds vertices by exact
// coordinate (so watertight solids share indices along seams), triangulates
// quads, and computes bounds from the actual vertex data. All iteration
// order is insertion order -- fully deterministic.

import type { PartMesh } from '../kernel/types';

export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly indices: number[] = [];
  /** Weld map: exact "x|y|z" string -> vertex index. Exact-bits welding is
   *  intentional: fixture generators compute shared seam vertices with the
   *  identical arithmetic, so they weld; nothing else should. */
  private readonly weld = new Map<string, number>();

  /** Add (or reuse) a vertex; returns its index. */
  vertex(x: number, y: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`MeshBuilder: non-finite vertex (${x}, ${y}, ${z})`);
    }
    const key = `${x}|${y}|${z}`;
    const existing = this.weld.get(key);
    if (existing !== undefined) return existing;
    const idx = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.weld.set(key, idx);
    return idx;
  }

  /** Add a triangle (indices, CCW viewed from outside). */
  tri(a: number, b: number, c: number): void {
    if (a === b || b === c || c === a) {
      throw new Error(`MeshBuilder: degenerate triangle (${a}, ${b}, ${c})`);
    }
    this.indices.push(a, b, c);
  }

  /** Add a quad as two triangles (a,b,c) + (a,c,d); pass corners CCW from outside. */
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  build(): PartMesh {
    if (this.indices.length === 0) {
      throw new Error('MeshBuilder: empty mesh');
    }
    const positions = new Float32Array(this.positions);
    const indices = new Uint32Array(this.indices);
    return { positions, indices, bounds: computeBounds(positions), source: 'fixture' };
  }
}

/** Axis-aligned bounds over xyz-triple positions. */
export function computeBounds(positions: Float32Array): PartMesh['bounds'] {
  if (positions.length < 3) {
    throw new Error('computeBounds: no vertices');
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = positions[i + axis];
      if (v < min[axis]) min[axis] = v;
      if (v > max[axis]) max[axis] = v;
    }
  }
  return { min, max };
}
