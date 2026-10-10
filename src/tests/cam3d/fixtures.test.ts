// cam3d fixture validity + analytic-truth tests.
//
// Every fixture: finite positions, valid index range, no zero-area
// triangles, bounds that match actual vertex extents. Closed solids:
// positive signed volume (proves consistent CCW-from-outside winding AND
// watertightness in one number -- an open or inverted mesh cannot hit the
// exact analytic volume).

import { describe, expect, it } from 'vitest';
import type { PartMesh } from '../../cam3d/kernel/types';
import { hemisphereOnSlab, pocketBox, sphere, steps, wave } from '../../cam3d/fixtures';

type Vec3 = [number, number, number];

function vertexAt(mesh: PartMesh, idx: number): Vec3 {
  return [mesh.positions[idx * 3], mesh.positions[idx * 3 + 1], mesh.positions[idx * 3 + 2]];
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

/** Divergence-theorem signed volume; positive iff winding is CCW-from-outside. */
function signedVolume(mesh: PartMesh): number {
  let vol = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = vertexAt(mesh, mesh.indices[i]);
    const b = vertexAt(mesh, mesh.indices[i + 1]);
    const c = vertexAt(mesh, mesh.indices[i + 2]);
    vol +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return vol;
}

const fixtures: Array<{ name: string; mesh: PartMesh; closed: boolean }> = [
  { name: 'wave', mesh: wave(), closed: false }, // open heightfield sheet by design
  { name: 'sphere', mesh: sphere(), closed: true },
  { name: 'hemisphereOnSlab', mesh: hemisphereOnSlab(), closed: true },
  { name: 'steps', mesh: steps(), closed: true },
  { name: 'pocketBox', mesh: pocketBox(), closed: true },
];

describe.each(fixtures)('fixture $name', ({ mesh, closed }) => {
  it('has finite positions (no NaN/Inf)', () => {
    for (let i = 0; i < mesh.positions.length; i++) {
      if (!Number.isFinite(mesh.positions[i])) {
        throw new Error(`non-finite position at ${i}: ${mesh.positions[i]}`);
      }
    }
    expect(mesh.positions.length % 3).toBe(0);
  });

  it('has valid indices', () => {
    const vertexCount = mesh.positions.length / 3;
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    for (let i = 0; i < mesh.indices.length; i++) {
      if (mesh.indices[i] >= vertexCount) {
        throw new Error(`index ${mesh.indices[i]} out of range at ${i} (n=${vertexCount})`);
      }
    }
  });

  it('has no zero-area triangles', () => {
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const area = triangleArea(
        vertexAt(mesh, mesh.indices[i]),
        vertexAt(mesh, mesh.indices[i + 1]),
        vertexAt(mesh, mesh.indices[i + 2]),
      );
      if (!(area > 1e-12)) {
        throw new Error(`degenerate triangle at ${i / 3}: area=${area}`);
      }
    }
  });

  it('bounds match actual vertex extents', () => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const v = mesh.positions[i + axis];
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
    }
    expect(mesh.bounds.min).toEqual(min);
    expect(mesh.bounds.max).toEqual(max);
  });

  it('winding sanity: signed volume positive for closed solids', () => {
    if (!closed) return;
    expect(signedVolume(mesh)).toBeGreaterThan(0);
  });
});

describe('analytic truth', () => {
  it('sphere (icosphere): every vertex lies at radius r within f32 quantization', () => {
    const r = 25;
    const cx = 50;
    const cy = 50;
    const cz = 25;
    const mesh = sphere(r, cx, cy, cz, 3);
    // Vertices are normalized in f64 (exactly r) then stored as Float32.
    // Per-component quantization error <= maxAbsCoord * 2^-24 with
    // maxAbsCoord = 75 (center + r), so distance error <= sqrt(3) * 75 *
    // 2^-24 ~ 7.8e-6 mm. Assert with a 2x safety factor.
    const tol = 2 * Math.sqrt(3) * 75 * 2 ** -24;
    const n = mesh.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(
        mesh.positions[i * 3] - cx,
        mesh.positions[i * 3 + 1] - cy,
        mesh.positions[i * 3 + 2] - cz,
      );
      if (Math.abs(d - r) > tol) {
        throw new Error(`vertex ${i} at distance ${d}, |d - r| = ${Math.abs(d - r)} > ${tol}`);
      }
    }
    // Sanity on counts: 20 * 4^3 faces after 3 subdivisions.
    expect(mesh.indices.length / 3).toBe(1280);
  });

  it('wave: spot-evaluated vertices match the benchmark formula exactly (f32)', () => {
    const size = 100;
    const n = 317;
    const mesh = wave(size, n);
    const spots: Array<[number, number]> = [
      [0, 0],
      [316, 316],
      [158, 158],
      [10, 200],
      [316, 0],
    ];
    for (const [i, j] of spots) {
      const v = j * n + i;
      const x = (size * i) / (n - 1);
      const y = (size * j) / (n - 1);
      const z = 10 + 5 * Math.sin(0.35 * x) * Math.cos(0.35 * y);
      expect(mesh.positions[v * 3]).toBe(Math.fround(x));
      expect(mesh.positions[v * 3 + 1]).toBe(Math.fround(y));
      expect(mesh.positions[v * 3 + 2]).toBe(Math.fround(z));
    }
    expect(mesh.indices.length / 3).toBe(2 * (n - 1) * (n - 1));
  });

  it('steps: signed volume equals the exact stack of square slabs', () => {
    const mesh = steps(3, 90, 10);
    const expected = 90 * 90 * 10 + 60 * 60 * 10 + 30 * 30 * 10; // 126000
    expect(signedVolume(mesh)).toBeCloseTo(expected, 4);
  });

  it('pocketBox: signed volume equals outer minus pocket volume', () => {
    const mesh = pocketBox({ x: 80, y: 60, z: 30 }, { x: 40, y: 30, depth: 15 });
    const expected = 80 * 60 * 30 - 40 * 30 * 15; // 126000
    expect(signedVolume(mesh)).toBeCloseTo(expected, 4);
  });

  it('hemisphereOnSlab: signed volume near slab + hemisphere (faceted, inscribed)', () => {
    const mesh = hemisphereOnSlab(20, { x: 100, y: 100, t: 10 });
    const analytic = 100 * 100 * 10 + (2 / 3) * Math.PI * 20 ** 3;
    const vol = signedVolume(mesh);
    // Faceted dome is inscribed -> volume strictly below analytic, but the
    // 64 x 16 tessellation keeps the deficit small.
    expect(vol).toBeGreaterThan(0.97 * analytic);
    expect(vol).toBeLessThan(analytic + 1e-6);
  });

  it('fixtures fail loud on invalid parameters', () => {
    expect(() => wave(100, 1)).toThrow();
    expect(() => sphere(-1)).toThrow();
    expect(() => hemisphereOnSlab(60)).toThrow(); // dome larger than slab top
    expect(() => steps(0)).toThrow();
    expect(() => pocketBox({ x: 80, y: 60, z: 30 }, { x: 90, y: 30, depth: 15 })).toThrow();
  });
});
