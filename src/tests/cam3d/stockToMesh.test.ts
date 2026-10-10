// cam3d stock toMesh tests: exact box topology, watertightness (edge hash,
// exactly 2 triangles per edge segment after T-junction splitting), volume
// cross-check via the divergence theorem, empty-column holes, determinism
// (byte-identical output), and the loud triangle budget.
//
// WATERTIGHT CHECK METHOD: greedy meshing legitimately produces T-junctions
// (a merged rectangle edge abuts several smaller quads). The mesh is still
// watertight -- every boundary point has matching surface on both sides --
// so the checker splits every AXIS-ALIGNED edge at the endpoints of all
// collinear edges (the breakpoint set of its line) before counting. Quad
// diagonals are not axis-aligned and are counted raw (their two triangles
// are the only users). After splitting, EVERY segment must appear exactly
// twice; any other count is an open boundary or a non-manifold pinch.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRIANGLE_BUDGET,
  ZDexelField,
  removeSweep,
  toMesh,
  type Box3,
  type StockMesh,
} from '../../cam3d/stock';
import type { CutterSpec } from '../../cam3d/kernel/types';

const FLAT8: CutterSpec = { kind: 'flat', diameter: 8 };
const FLAT6: CutterSpec = { kind: 'flat', diameter: 6 };

// ---- helpers ----

/** Signed volume via the divergence theorem (positive for outward CCW). */
function signedVolume(mesh: StockMesh): number {
  const { positions, indices } = mesh;
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const bx = positions[b];
    const by = positions[b + 1];
    const bz = positions[b + 2];
    const cx = positions[c];
    const cy = positions[c + 1];
    const cz = positions[c + 2];
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** Dexel-side material volume: sum (top - bottom) * cell^2, f64 accumulated. */
function dexelVolume(field: ZDexelField): number {
  let s = 0;
  for (let c = 0; c < field.top.length; c++) {
    s += field.top[c] - field.bottom[c];
  }
  return s * field.cell * field.cell;
}

/**
 * Assert every edge segment is shared by exactly 2 triangles (see module
 * header for the T-junction splitting method). Positions are f32-exact, so
 * keys compare by exact value.
 */
function assertWatertight(mesh: StockMesh): void {
  const { positions, indices } = mesh;
  const px = (vi: number): [number, number, number] => [
    positions[vi * 3],
    positions[vi * 3 + 1],
    positions[vi * 3 + 2],
  ];

  type AxisEdge = { lo: number; hi: number };
  /** Axis-aligned edges grouped by their line: axis + the two fixed coords. */
  const lines = new Map<string, { breaks: Set<number>; edges: AxisEdge[] }>();
  /** Non-axis-aligned (diagonal) edges, counted raw. */
  const diagCounts = new Map<string, number>();

  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const p = px(indices[t + e]);
      const q = px(indices[t + ((e + 1) % 3)]);
      let axis = -1;
      let nDiff = 0;
      for (let k = 0; k < 3; k++) {
        if (p[k] !== q[k]) {
          axis = k;
          nDiff++;
        }
      }
      expect(nDiff, 'degenerate zero-length edge').toBeGreaterThan(0);
      if (nDiff === 1) {
        const oa = (axis + 1) % 3;
        const ob = (axis + 2) % 3;
        const key = `${axis}|${p[oa]}|${p[ob]}`;
        let line = lines.get(key);
        if (line === undefined) {
          line = { breaks: new Set<number>(), edges: [] };
          lines.set(key, line);
        }
        const lo = Math.min(p[axis], q[axis]);
        const hi = Math.max(p[axis], q[axis]);
        line.breaks.add(lo);
        line.breaks.add(hi);
        line.edges.push({ lo, hi });
      } else {
        const ka = p.join(',');
        const kb = q.join(',');
        const key = ka < kb ? `${ka};${kb}` : `${kb};${ka}`;
        diagCounts.set(key, (diagCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const violations: string[] = [];
  for (const [key, line] of lines) {
    const breaks = [...line.breaks].sort((a, b) => a - b);
    const segCounts = new Map<string, number>();
    for (const edge of line.edges) {
      let prev = edge.lo;
      for (const b of breaks) {
        if (b <= edge.lo) continue;
        if (b > edge.hi) break;
        const segKey = `${prev}->${b}`;
        segCounts.set(segKey, (segCounts.get(segKey) ?? 0) + 1);
        prev = b;
      }
    }
    for (const [segKey, n] of segCounts) {
      if (n !== 2) violations.push(`line ${key} seg ${segKey}: ${n} tris`);
    }
  }
  for (const [key, n] of diagCounts) {
    if (n !== 2) violations.push(`diagonal ${key}: ${n} tris`);
  }
  expect(violations).toEqual([]);
}

function bytesOf(a: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

/** Carved fixture shared by several tests: 40x40x10, flat-d8 pocket at z=6. */
function carvedField(): ZDexelField {
  const box: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 40, maxZ: 10 };
  const field = ZDexelField.fromBox(box, 0.5);
  removeSweep(field, { x0: 12, y0: 20, z0: 6, x1: 28, y1: 20, z1: 6 }, FLAT8);
  return field;
}

// ---- tests ----

describe('stock toMesh: box topology', () => {
  it('meshes an untouched fromBox field to exactly the 6 quads of a box', () => {
    const f = ZDexelField.fromBox(
      { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 6, maxZ: 4 },
      1,
    );
    const m = toMesh(f);
    // 1 top rect + 1 bottom rect + 4 merged border walls = 6 quads = 12 tris.
    expect(m.triangleCount).toBe(12);
    expect(m.indices.length).toBe(36);
    // Deduplicated corners: a box has exactly 8 vertices.
    expect(m.vertexCount).toBe(8);
    expect(m.positions.length).toBe(24);
    assertWatertight(m);
    // Outward winding: divergence-theorem volume is POSITIVE and exact.
    expect(signedVolume(m)).toBeCloseTo(10 * 6 * 4, 6);
  });

  it('meshes an everywhere-empty field (maxZ === minZ) to nothing', () => {
    const f = ZDexelField.fromBox(
      { minX: 0, minY: 0, minZ: 5, maxX: 10, maxY: 6, maxZ: 5 },
      1,
    );
    const m = toMesh(f);
    expect(m.triangleCount).toBe(0);
    expect(m.vertexCount).toBe(0);
    expect(m.indices.length).toBe(0);
  });
});

describe('stock toMesh: watertightness and volume', () => {
  it('is watertight after a removeSweep pocket (no empty columns)', () => {
    const field = carvedField();
    // Sanity: pocket carved, nothing cut through.
    let empties = 0;
    for (let c = 0; c < field.top.length; c++) {
      if (field.top[c] === field.bottom[c]) empties++;
    }
    expect(empties).toBe(0);
    const m = toMesh(field);
    expect(m.triangleCount).toBeGreaterThan(12); // more than a plain box
    assertWatertight(m);
  });

  it('mesh volume matches the dexel volume within 1e-3 relative', () => {
    const field = carvedField();
    const vDexel = dexelVolume(field);
    const vMesh = signedVolume(toMesh(field));
    expect(vDexel).toBeGreaterThan(0);
    expect(Math.abs(vMesh - vDexel) / vDexel).toBeLessThan(1e-3);
  });

  it('stays watertight with an empty region (through-cut hole)', () => {
    const field = carvedField();
    // Plunge flat d6 to the field bottom INSIDE the pocket floor: the disc
    // columns clamp to the canonical empty encoding (top === bottom).
    removeSweep(field, { x0: 20, y0: 20, z0: 10, x1: 20, y1: 20, z1: 0 }, FLAT6);
    let empties = 0;
    for (let c = 0; c < field.top.length; c++) {
      if (field.top[c] === field.bottom[c]) empties++;
    }
    expect(empties).toBeGreaterThan(0); // the hole is real
    const m = toMesh(field);
    assertWatertight(m);
    // Volume cross-check still holds with the hole excluded top AND bottom.
    const vDexel = dexelVolume(field);
    const vMesh = signedVolume(m);
    expect(Math.abs(vMesh - vDexel) / vDexel).toBeLessThan(1e-3);
  });
});

describe('stock toMesh: determinism and budget', () => {
  it('produces byte-identical output for identically-built fields (D-006)', () => {
    const build = (): ZDexelField => {
      const field = carvedField();
      removeSweep(field, { x0: 20, y0: 20, z0: 10, x1: 20, y1: 20, z1: 0 }, FLAT6);
      return field;
    };
    const a = toMesh(build());
    const b = toMesh(build());
    expect(a.vertexCount).toBe(b.vertexCount);
    expect(a.triangleCount).toBe(b.triangleCount);
    expect(bytesOf(a.positions)).toEqual(bytesOf(b.positions));
    expect(bytesOf(a.indices)).toEqual(bytesOf(b.indices));
  });

  it('fails LOUD when the exact mesh exceeds the triangle budget', () => {
    const f = ZDexelField.fromBox(
      { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 6, maxZ: 4 },
      1,
    );
    // The box needs 12 triangles; a budget of 10 must throw naming both.
    expect(() => toMesh(f, 10)).toThrow(/12 triangles/);
    expect(() => toMesh(f, 10)).toThrow(/budget of 10/);
    // And never decimates: the same field under the default budget is fine.
    expect(DEFAULT_TRIANGLE_BUDGET).toBe(2_000_000);
    expect(toMesh(f).triangleCount).toBe(12);
  });

  it('rejects a garbage budget loudly', () => {
    const f = ZDexelField.fromBox(
      { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 4, maxZ: 2 },
      1,
    );
    expect(() => toMesh(f, 0)).toThrow(/triangleBudget/);
    expect(() => toMesh(f, Number.NaN)).toThrow(/triangleBudget/);
  });
});
