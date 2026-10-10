// cam3d exact drop-cutter math tests: analytic ground truth + brute-force
// cross-checks for every contact family (vertex / facet / edge), both
// cutter kinds, and the degenerate-triangle contract.

import { describe, expect, it } from 'vitest';
import {
  NO_CONTACT,
  dropPointOverTriangles,
  dropTriangle,
  dropTriangleBall,
  dropTriangleBallCore,
  dropTriangleFlat,
  dropTriangleFlatCore,
} from '../../cam3d/kernel/dropCutter';
import { sphere } from '../../cam3d/fixtures';

const R = 3; // d6 cutter radius used throughout

/**
 * Radius of the largest center-centered sphere inscribed in the icosphere
 * mesh: the min distance from the center to any facet plane. Every surface
 * point of the mesh lies at distance >= rIn from the center, so the mesh
 * solid contains sphere(rIn) -- the exact tessellation deviation bound the
 * sphere-truth tests derive their tolerance from.
 */
function inscribedRadius(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  cx: number,
  cy: number,
  cz: number,
): number {
  let rIn = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = (indices[t] as number) * 3;
    const ib = (indices[t + 1] as number) * 3;
    const ic = (indices[t + 2] as number) * 3;
    const ax = positions[ia] as number, ay = positions[ia + 1] as number, az = positions[ia + 2] as number;
    const bx = positions[ib] as number, by = positions[ib + 1] as number, bz = positions[ib + 2] as number;
    const gx = positions[ic] as number, gy = positions[ic + 1] as number, gz = positions[ic + 2] as number;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = gx - ax, vy = gy - ay, vz = gz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen === 0) continue;
    const dist = Math.abs(nx * (ax - cx) + ny * (ay - cy) + nz * (az - cz)) / nlen;
    if (dist < rIn) rIn = dist;
  }
  return rIn;
}

/** Deterministic PRNG (project convention: seeded mulberry32, no Math.random). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('dropTriangle basics', () => {
  it('returns NO_CONTACT when the triangle xy AABB misses the footprint', () => {
    // Triangle entirely to the +x side of the disk.
    const z = dropTriangleFlat(R, 0, 0, 10, 0, 5, 12, 0, 5, 11, 2, 5);
    expect(z).toBe(NO_CONTACT);
    const zb = dropTriangleBall(R, 0, 0, 10, 0, 5, 12, 0, 5, 11, 2, 5);
    expect(zb).toBe(NO_CONTACT);
  });

  it('flat vertex contact: vertex inside the disk supports the tip at its z', () => {
    // One vertex at xy distance 2 < R; the triangle falls away steeply, so
    // the vertex is the highest supported point in the footprint.
    const z = dropTriangleFlat(R, 0, 0, 2, 0, 7, 20, 0, -40, 20, 2, -40);
    expect(z).toBe(7);
  });

  it('ball vertex contact matches the sphere-on-point formula', () => {
    const d = 1.25;
    const z = dropTriangleBall(R, 0, 0, d, 0, 7, 20, 0, -40, 20, 2, -40);
    expect(z).toBeCloseTo(7 + Math.sqrt(R * R - d * d) - R, 12);
  });

  it('facet contact on an inclined plane matches the closed forms', () => {
    // Large tilted triangle: z = 5 + gx*x + gy*y, footprint well inside so
    // the contact is facet-interior for both cutters.
    const gx = 0.4;
    const gy = -0.25;
    const plane = (px: number, py: number): number => 5 + gx * px + gy * py;
    const t: [number, number][] = [
      [-50, -50],
      [50, -45],
      [0, 55],
    ];
    const [a, b, c] = t;
    const zf = dropTriangleFlat(
      R, 1, 2,
      a[0], a[1], plane(a[0], a[1]),
      b[0], b[1], plane(b[0], b[1]),
      c[0], c[1], plane(c[0], c[1]),
    );
    const grad = Math.hypot(gx, gy);
    // Flat: uphill rim point rides the plane R*|grad| above the axis z.
    expect(zf).toBeCloseTo(plane(1, 2) + R * grad, 10);
    const zb = dropTriangleBall(
      R, 1, 2,
      a[0], a[1], plane(a[0], a[1]),
      b[0], b[1], plane(b[0], b[1]),
      c[0], c[1], plane(c[0], c[1]),
    );
    // Ball: sphere on a plane lifts the tip R*(sqrt(1+|grad|^2)-1).
    expect(zb).toBeCloseTo(plane(1, 2) + R * (Math.sqrt(1 + grad * grad) - 1), 10);
  });

  it('horizontal facet: tip z equals the plane z when (x, y) is inside', () => {
    const z = dropTriangleFlat(R, 0.5, 0.5, -5, -5, 4, 5, -5, 4, 0, 5, 4);
    expect(z).toBe(4);
    const zb = dropTriangleBall(R, 0.5, 0.5, -5, -5, 4, 5, -5, 4, 0, 5, 4);
    expect(zb).toBeCloseTo(4, 12);
  });

  it('Core variants match the public wrappers everywhere (AABB check is a pure fast path)', () => {
    const rnd = mulberry32(0xbadc0de);
    for (let trial = 0; trial < 200; trial++) {
      const args = [
        (rnd() - 0.5) * 6, (rnd() - 0.5) * 6, // x, y
        (rnd() - 0.5) * 12, (rnd() - 0.5) * 12, rnd() * 8,
        (rnd() - 0.5) * 12, (rnd() - 0.5) * 12, rnd() * 8,
        (rnd() - 0.5) * 12, (rnd() - 0.5) * 12, rnd() * 8,
      ] as const;
      const flat = dropTriangleFlat(R, ...args);
      const flatCore = dropTriangleFlatCore(R, ...args);
      const ball = dropTriangleBall(R, ...args);
      const ballCore = dropTriangleBallCore(R, ...args);
      expect(Object.is(flat, flatCore)).toBe(true);
      expect(Object.is(ball, ballCore)).toBe(true);
    }
  });

  it('dispatcher routes by kind', () => {
    const args = [R, 0, 0, 1, 0, 7, 20, 0, 40, 20, 2, 40] as const;
    expect(dropTriangle('flat', ...args)).toBe(dropTriangleFlat(...args));
    expect(dropTriangle('ball', ...args)).toBe(dropTriangleBall(...args));
  });
});

describe('edge formulas vs dense 1D sampling', () => {
  // Needle triangles (two coincident vertices) isolate the edge test: the
  // facet has zero area (skipped) and the degenerate edges add nothing new,
  // so the result must equal the supremum of the single-segment support
  // function, which we sample densely here.
  //   flat: f(s) = z(s) where dxy(s) <= R
  //   ball: f(s) = z(s) + sqrt(R^2 - dxy(s)^2) - R
  function sampleSegment(
    kind: 'flat' | 'ball',
    x: number, y: number,
    p: [number, number, number],
    q: [number, number, number],
    steps: number,
  ): number {
    let best = NO_CONTACT;
    for (let i = 0; i <= steps; i++) {
      const s = i / steps;
      const sx = p[0] + s * (q[0] - p[0]);
      const sy = p[1] + s * (q[1] - p[1]);
      const sz = p[2] + s * (q[2] - p[2]);
      const d2 = (sx - x) * (sx - x) + (sy - y) * (sy - y);
      if (d2 > R * R) continue;
      const z = kind === 'flat' ? sz : sz + Math.sqrt(R * R - d2) - R;
      if (z > best) best = z;
    }
    return best;
  }

  it('flat and ball edge contacts match the sampled supremum (60 random segments)', () => {
    const rnd = mulberry32(0xc0ffee);
    let maxErrFlat = 0;
    let maxErrBall = 0;
    let contacts = 0;
    for (let trial = 0; trial < 60; trial++) {
      const p: [number, number, number] = [
        (rnd() - 0.5) * 8,
        (rnd() - 0.5) * 8,
        rnd() * 6,
      ];
      const q: [number, number, number] = [
        p[0] + (rnd() - 0.5) * 10,
        p[1] + (rnd() - 0.5) * 10,
        p[2] + (rnd() - 0.5) * 8,
      ];
      const x = (rnd() - 0.5) * 4;
      const y = (rnd() - 0.5) * 4;
      for (const kind of ['flat', 'ball'] as const) {
        const exact = dropTriangle(kind, R, x, y, p[0], p[1], p[2], q[0], q[1], q[2], q[0], q[1], q[2]);
        const ref = sampleSegment(kind, x, y, p, q, 100_000);
        if (ref === NO_CONTACT) {
          // No sampled support constraint: exact may still find a grazing
          // contact the sampling stepped over, but never the reverse.
          expect(exact === NO_CONTACT || Number.isFinite(exact)).toBe(true);
          continue;
        }
        contacts++;
        // The exact result must dominate every sampled support constraint...
        expect(exact).toBeGreaterThanOrEqual(ref - 1e-9);
        // ...and sit within the sampling resolution of the supremum.
        const err = exact - ref;
        expect(err).toBeLessThanOrEqual(1e-4);
        if (kind === 'flat') maxErrFlat = Math.max(maxErrFlat, err);
        else maxErrBall = Math.max(maxErrBall, err);
      }
    }
    expect(contacts).toBeGreaterThan(60); // the fixture must actually exercise contacts
  });
});

describe('degenerate triangles', () => {
  it('zero-xy-area (vertical) triangle still yields edge/vertex contacts', () => {
    // A vertical quad edge-on to the cutter: all xy on the line x = 1.
    const z = dropTriangleFlat(R, 0, 0, 1, -2, 0, 1, 2, 0, 1, 0, 6);
    expect(z).toBe(6); // top vertex is inside the disk footprint
    const zb = dropTriangleBall(R, 0, 0, 1, -2, 0, 1, 2, 0, 1, 0, 6);
    expect(zb).toBeCloseTo(6 + Math.sqrt(R * R - 1) - R, 12);
  });

  it('fully collapsed triangle (single point) does not crash', () => {
    const z = dropTriangleFlat(R, 0, 0, 1, 1, 3, 1, 1, 3, 1, 1, 3);
    expect(z).toBe(3);
    const zb = dropTriangleBall(R, 0, 0, 1, 1, 3, 1, 1, 3, 1, 1, 3);
    expect(zb).toBeCloseTo(3 + Math.sqrt(R * R - 2) - R, 12);
  });
});

describe('analytic sphere ground truth (brute force over all triangles)', () => {
  // Icosphere vertices sit EXACTLY at radius r in f64, so the only error
  // sources are the facet sagitta and Float32 storage. The mesh solid
  // contains the inscribed sphere of radius rIn = min facet-plane distance
  // to the center (measured from the ACTUAL tessellation, which also folds
  // in the f32 quantization), and drop is monotone under geometry
  // inclusion, so
  //   analytic - (r - rIn) * amplification <= drop <= analytic + quant
  // where amplification is the |dz/dr| of the analytic formula at offset d.
  const r = 10;
  const cx = 30;
  const cy = 25;
  const cz = 40;
  const subdiv = 5;
  const mesh = sphere(r, cx, cy, cz, subdiv);
  const sagitta = r - inscribedRadius(mesh.positions, mesh.indices, cx, cy, cz);
  const quant = 2 ** -23 * (Math.max(cx, cy, cz) + r) * 4; // f32 ulps, generous
  const zSeed = 0;

  const azimuths = [0.13, 1.03, 2.17, 3.31, 4.57, 5.71];

  it('ball cutter matches z = cz + sqrt((r+R)^2 - d^2) - R within the sagitta bound', () => {
    let maxErr = 0;
    for (const frac of [0, 0.2, 0.5, 0.8, 0.95]) {
      const d = frac * (r + R);
      const analytic = cz + Math.sqrt((r + R) ** 2 - d * d) - R;
      const amp = (r + R) / Math.sqrt((r + R) ** 2 - d * d);
      const tol = sagitta * amp * 1.2 + 1e-6; // sagitta measured from the mesh

      for (const az of azimuths) {
        const x = cx + d * Math.cos(az);
        const y = cy + d * Math.sin(az);
        const z = dropPointOverTriangles('ball', R, x, y, zSeed, mesh.positions, mesh.indices);
        expect(z).toBeLessThanOrEqual(analytic + quant);
        expect(z).toBeGreaterThanOrEqual(analytic - tol);
        maxErr = Math.max(maxErr, Math.abs(z - analytic));
      }
    }
    // Report the observed ceiling so regressions are visible in CI logs.
    console.log(`sphere/ball brute max |err| = ${maxErr.toExponential(3)} (sagitta ${sagitta.toExponential(3)})`);
  });

  it('flat cutter matches the piecewise apex/rim formula within the sagitta bound', () => {
    let maxErr = 0;
    const chord = Math.sqrt(8 * r * sagitta); // sagitta ~ chord^2 / (8r)
    // Apex branch needs the pole cap inside the footprint: keep d <= R - chord.
    const ds = [0, 0.5 * R, R - chord - 0.05, R + 0.2, R + 0.5 * r, R + 0.9 * r];
    for (const d of ds) {
      const analytic = d <= R ? cz + r : cz + Math.sqrt(r * r - (d - R) ** 2);
      const amp = d <= R ? 1 : r / Math.sqrt(r * r - (d - R) ** 2);
      const tol = sagitta * amp * 1.2 + 1e-6;
      for (const az of azimuths) {
        const x = cx + d * Math.cos(az);
        const y = cy + d * Math.sin(az);
        const z = dropPointOverTriangles('flat', R, x, y, zSeed, mesh.positions, mesh.indices);
        expect(z).toBeLessThanOrEqual(analytic + quant);
        expect(z).toBeGreaterThanOrEqual(analytic - tol);
        maxErr = Math.max(maxErr, Math.abs(z - analytic));
      }
    }
    console.log(`sphere/flat brute max |err| = ${maxErr.toExponential(3)} (sagitta ${sagitta.toExponential(3)})`);
  });

  it('misses beyond d = r + R return exactly zSeed', () => {
    for (const d of [r + R + 0.3, r + R + 5]) {
      for (const az of azimuths) {
        const x = cx + d * Math.cos(az);
        const y = cy + d * Math.sin(az);
        expect(dropPointOverTriangles('flat', R, x, y, zSeed, mesh.positions, mesh.indices)).toBe(zSeed);
        expect(dropPointOverTriangles('ball', R, x, y, zSeed, mesh.positions, mesh.indices)).toBe(zSeed);
      }
    }
  });
});
