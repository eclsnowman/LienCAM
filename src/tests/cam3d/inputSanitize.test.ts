// cam3d input pipeline: sanity/repair pass unit tests.
//
// The pass is shared by the STL and STEP importers, so these tests exercise
// it directly on hand-built meshes: degenerate dropping (+ counting warning),
// positionally-welded watertightness detection (STL soups and STEP per-face
// vertex blocks both duplicate coordinates), loud NaN/Inf rejection, bounds
// recomputation, and faceIds lockstep filtering.

import { describe, expect, it } from 'vitest';
import { sanitizeTriangleMesh } from '../../cam3d/input/sanitize';

/** Regular tetrahedron-ish solid on 4 shared (indexed) vertices. */
function indexedTetra(): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array([
    0, 0, 0, // v0
    10, 0, 0, // v1
    0, 10, 0, // v2
    0, 0, 10, // v3
  ]);
  // CCW from outside.
  const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  return { positions, indices };
}

/** The same tetra as a triangle SOUP: 12 vertices, no index sharing. */
function soupTetra(): { positions: Float32Array; indices: Uint32Array } {
  const t = indexedTetra();
  const positions = new Float32Array(t.indices.length * 3);
  const indices = new Uint32Array(t.indices.length);
  for (let i = 0; i < t.indices.length; i++) {
    positions.set(t.positions.subarray(t.indices[i] * 3, t.indices[i] * 3 + 3), i * 3);
    indices[i] = i;
  }
  return { positions, indices };
}

describe('sanitizeTriangleMesh', () => {
  it('passes a watertight indexed solid through untouched (no warnings)', () => {
    const { positions, indices } = indexedTetra();
    const s = sanitizeTriangleMesh(positions, indices);
    expect(s.warnings).toEqual([]);
    expect(s.watertight).toBe(true);
    expect(s.droppedDegenerateTriangles).toBe(0);
    expect(Array.from(s.indices)).toEqual(Array.from(indices));
  });

  it('detects watertightness through duplicated vertices (STEP/STL-style soup)', () => {
    // Index-identity edge counting would call this fully open (every edge
    // used once); the positional weld must recognize it as closed.
    const { positions, indices } = soupTetra();
    const s = sanitizeTriangleMesh(positions, indices);
    expect(s.watertight).toBe(true);
    expect(s.warnings).toEqual([]);
  });

  it('warns (does not block) on an open mesh: a single triangle', () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const s = sanitizeTriangleMesh(positions, indices);
    expect(s.watertight).toBe(false);
    expect(s.warnings.length).toBe(1);
    expect(s.warnings[0]).toMatch(/not watertight/);
    expect(s.warnings[0]).toMatch(/3 boundary edges/);
    expect(s.indices.length).toBe(3); // still imported
  });

  it('drops repeated-index, coincident-corner and zero-area triangles with a counting warning', () => {
    const { positions: tp, indices: ti } = indexedTetra();
    // Append: v4 duplicates v1's coordinates; v5 is collinear on v0->v1.
    const positions = new Float32Array([...tp, 10, 0, 0, 5, 0, 0]);
    const indices = new Uint32Array([
      ...ti,
      0, 1, 1, // repeated index
      0, 1, 4, // coincident corners (v4 === v1 positionally)
      0, 5, 1, // exactly collinear -> zero area
    ]);
    const s = sanitizeTriangleMesh(positions, indices);
    expect(s.droppedDegenerateTriangles).toBe(3);
    expect(s.indices.length).toBe(ti.length); // the 4 good tetra faces survive
    expect(s.warnings.some((w) => /Dropped 3 exactly-degenerate triangles/.test(w))).toBe(true);
    // The surviving tetra is still watertight.
    expect(s.watertight).toBe(true);
  });

  it('filters faceIds in lockstep with dropped triangles', () => {
    const { positions: tp, indices: ti } = indexedTetra();
    const positions = new Float32Array([...tp]);
    const indices = new Uint32Array([...ti.slice(0, 6), 0, 1, 1, ...ti.slice(6)]);
    const faceIds = new Uint32Array([0, 1, 99, 2, 3]); // 99 rides the degenerate
    const s = sanitizeTriangleMesh(positions, indices, faceIds);
    expect(s.droppedDegenerateTriangles).toBe(1);
    expect(Array.from(s.faceIds ?? [])).toEqual([0, 1, 2, 3]);
  });

  it('rejects NaN vertices loudly', () => {
    const positions = new Float32Array([0, 0, 0, 10, NaN, 0, 0, 10, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    expect(() => sanitizeTriangleMesh(positions, indices)).toThrow(/non-finite coordinate at vertex 1/);
  });

  it('rejects Infinity vertices loudly', () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, Infinity]);
    const indices = new Uint32Array([0, 1, 2]);
    expect(() => sanitizeTriangleMesh(positions, indices)).toThrow(/non-finite/);
  });

  it('recomputes bounds from actual vertex data', () => {
    const positions = new Float32Array([-5, 2, 0, 10, 0, -3, 0, 10, 7]);
    const indices = new Uint32Array([0, 1, 2]);
    const s = sanitizeTriangleMesh(positions, indices);
    expect(s.bounds.min).toEqual([-5, 0, -3]);
    expect(s.bounds.max).toEqual([10, 10, 7]);
  });

  it('throws when every triangle is degenerate', () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0]);
    const indices = new Uint32Array([0, 0, 1]);
    expect(() => sanitizeTriangleMesh(positions, indices)).toThrow(/all 1 triangles are degenerate/);
  });

  it('throws on structural garbage: bad lengths, out-of-range indices, faceIds mismatch', () => {
    const good = indexedTetra();
    expect(() => sanitizeTriangleMesh(new Float32Array([1, 2]), good.indices)).toThrow(/multiple of 3/);
    expect(() => sanitizeTriangleMesh(good.positions, new Uint32Array([0, 1]))).toThrow(/multiple of 3/);
    expect(() => sanitizeTriangleMesh(good.positions, new Uint32Array([0, 1, 7]))).toThrow(/out of range/);
    expect(() => sanitizeTriangleMesh(good.positions, good.indices, new Uint32Array([1]))).toThrow(
      /faceIds length/,
    );
  });
});
