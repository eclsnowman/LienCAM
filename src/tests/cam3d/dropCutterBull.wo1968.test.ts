// WO-1968: exact bull-nose (torus) drop-cutter in the production 3D kernel.
//
// 1. Pure math against analytic ground truth: flat facet, tilted facet,
//    vertex (core and corner), edge (horizontal offset, sloped through the
//    axis, sloped offset) -- each to 1e-6 mm.
// 2. Degenerate limits: cornerRadius 0 is the flat drop, cornerRadius R is
//    the ball drop.
// 3. Random mesh: the BvhKernel (culled) equals the uncull'd brute force
//    exactly, and an INDEPENDENT brute force -- maximize the support
//    function tip(q) = q.z + phi(d(q) - Rf) over every triangle by dense
//    seeding plus compass search, sharing no code with the kernel math --
//    shows no gouge and no more than 1e-6 mm of lift above the true max.
// 4. The production worker path (Cam3dClient -> Cam3dDispatcher -> the
//    BvhKernel the worker creates) computes a Parallel finish with a
//    bull-nose tool on a curved part.

import { describe, expect, it } from 'vitest';
import {
  dropPointOverTriangles,
  dropTriangleBall,
  dropTriangleFlat,
  NO_CONTACT,
} from '../../cam3d/kernel/dropCutter';
import { dropPointOverTrianglesBull, dropTriangleBull } from '../../cam3d/kernel/dropCutterBull';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh } from '../../cam3d/kernel/types';
import { computeBounds } from '../../cam3d/fixtures/meshBuilder';
import { wave } from '../../cam3d/fixtures';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { Ring } from '../../cam3d/geom2d';
import type { Tool } from '../../types';
import {
  acquirePartMesh,
  computeParallel3dMoves,
  type Parallel3dParams,
  type ResolvedParallel3dHeights,
} from '../../cam3d/integration/parallel3dOperation';

const TOL = 1e-6;
const R = 3;
const RC = 1;
const RF = R - RC;

type V3 = [number, number, number];

function drop(x: number, y: number, a: V3, b: V3, c: V3, radius = R, corner = RC): number {
  return dropTriangleBull(radius, corner, x, y, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

// ---------------------------------------------------------------------------
// Independent reference: support function + concave maximization.
// ---------------------------------------------------------------------------

/** Tip height a surface point supports, straight from the cutter profile. */
function supportTip(qx: number, qy: number, qz: number, x: number, y: number, radius: number, corner: number): number {
  const d = Math.hypot(qx - x, qy - y);
  if (d > radius) return -Infinity;
  const flatR = radius - corner;
  if (d <= flatR) return qz;
  const u = d - flatR;
  return qz - (corner - Math.sqrt(Math.max(0, corner * corner - u * u)));
}

/**
 * Max of supportTip over one triangle. tip(q) is concave over the triangle
 * clipped to the footprint disk, so compass search from the best dense seed,
 * with the three edge directions as the pattern (so it can slide along any
 * boundary edge), converges to the global max.
 */
function refTriangleMax(a: V3, b: V3, c: V3, x: number, y: number, radius: number, corner: number): number {
  const f = (u: number, v: number): number => {
    if (u < 0 || v < 0 || u + v > 1) return -Infinity;
    const qx = a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]);
    const qy = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
    const qz = a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]);
    return supportTip(qx, qy, qz, x, y, radius, corner);
  };
  const N = 60;
  let bu = 0, bv = 0, bf = -Infinity;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; i + j <= N; j++) {
      const val = f(i / N, j / N);
      if (val > bf) { bf = val; bu = i / N; bv = j / N; }
    }
  }
  if (bf === -Infinity) return -Infinity;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
  let h = 1 / N;
  for (let guard = 0; h > 1e-14 && guard < 100000; guard++) {
    let improved = false;
    let nu = bu, nv = bv, nf = bf;
    for (const [du, dv] of dirs) {
      const val = f(bu + h * du, bv + h * dv);
      if (val > nf) { nf = val; nu = bu + h * du; nv = bv + h * dv; improved = true; }
    }
    if (improved) { bu = nu; bv = nv; bf = nf; } else h /= 2;
  }
  return bf;
}

/** Max of F(s) = z(s) + phi(d(s) - Rf) along a segment, by golden section. */
function refSegmentMax(p: V3, q: V3, x: number, y: number, radius: number, corner: number): number {
  const F = (s: number): number => supportTip(
    p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1]), p[2] + s * (q[2] - p[2]), x, y, radius, corner,
  );
  // Feasible sub-interval: |w + s e|^2 <= R^2.
  const ex = q[0] - p[0], ey = q[1] - p[1], wx = p[0] - x, wy = p[1] - y;
  const e2 = ex * ex + ey * ey, g = wx * ex + wy * ey, w2 = wx * wx + wy * wy;
  const disc = g * g - e2 * (w2 - radius * radius);
  let lo = Math.max(0, (-g - Math.sqrt(disc)) / e2);
  let hi = Math.min(1, (-g + Math.sqrt(disc)) / e2);
  const phi = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 200; i++) {
    const m1 = hi - phi * (hi - lo), m2 = lo + phi * (hi - lo);
    if (F(m1) < F(m2)) lo = m1; else hi = m2;
  }
  return F(0.5 * (lo + hi));
}

// A seeded LCG so every "random" case is deterministic.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. Analytic ground truth
// ---------------------------------------------------------------------------

describe('WO-1968 bull drop: analytic ground truth', () => {
  const x0 = 0.7, y0 = -1.3;

  it('flat facet: the flat core rests on it, tip z = facet z', () => {
    const z = drop(x0, y0, [-50, -50, 4.25], [50, -50, 4.25], [0, 50, 4.25]);
    expect(Math.abs(z - 4.25)).toBeLessThan(TOL);
  });

  it('flat facet the axis misses but the flat core overlaps still supports at facet z', () => {
    // Triangle entirely at x >= x0 + 1.5 (inside Rf = 2 of the axis).
    const z = drop(x0, y0, [x0 + 1.5, y0 - 20, 2], [x0 + 40, y0, 2], [x0 + 1.5, y0 + 20, 2]);
    expect(Math.abs(z - 2)).toBeLessThan(TOL);
  });

  for (const [gx, gy] of [[0.4, 0], [0.3, -0.55], [-1.7, 0.9], [0.05, 0.02]] as const) {
    it(`tilted facet z = ${gx}x + ${gy}y + 3: torus-plane contact`, () => {
      const plane = (px: number, py: number): number => gx * px + gy * py + 3;
      const a: V3 = [-60, -60, plane(-60, -60)];
      const b: V3 = [60, -60, plane(60, -60)];
      const c: V3 = [0, 60, plane(0, 60)];
      const g = Math.hypot(gx, gy);
      // The flat core rests on the plane offset by rc: its uphill rim point
      // is Rf*g above the axis, and the offset adds rc*(sqrt(1+g^2) - 1).
      const expected = plane(x0, y0) + RF * g + RC * (Math.sqrt(1 + g * g) - 1);
      expect(Math.abs(drop(x0, y0, a, b, c) - expected)).toBeLessThan(TOL);
    });
  }

  for (const dv of [1.2, 2.5, 2.95]) {
    it(`vertex at axis distance ${dv}: tip = vz - corner height`, () => {
      const H = 7;
      const a: V3 = [x0 + dv, y0, H];
      const b: V3 = [x0 + 60, y0 + 5, H - 100];
      const c: V3 = [x0 + 60, y0 - 5, H - 100];
      const u = dv - RF;
      const expected = u <= 0 ? H : H + Math.sqrt(RC * RC - u * u) - RC;
      expect(Math.abs(drop(x0, y0, a, b, c) - expected)).toBeLessThan(TOL);
    });
  }

  it('vertex outside the footprint: no contact', () => {
    expect(drop(x0, y0, [x0 + 3.01, y0, 7], [x0 + 60, y0 + 5, -93], [x0 + 60, y0 - 5, -93])).toBe(NO_CONTACT);
  });

  for (const p of [1.0, 2.5]) {
    it(`horizontal edge at perpendicular distance ${p}`, () => {
      const H = 5;
      const a: V3 = [x0 + p, y0 - 20, H];
      const b: V3 = [x0 + p, y0 + 20, H];
      const c: V3 = [x0 + 40, y0, H - 100];
      const u = p - RF;
      const expected = u <= 0 ? H : H + Math.sqrt(RC * RC - u * u) - RC;
      expect(Math.abs(drop(x0, y0, a, b, c) - expected)).toBeLessThan(TOL);
    });
  }

  for (const m of [0.6, -1.4, 3.0]) {
    it(`sloped edge through the axis, slope ${m}: the profile's cross-section contact`, () => {
      const H = 5;
      const a: V3 = [x0 - 20, y0, H - 20 * m];
      const b: V3 = [x0 + 20, y0, H + 20 * m];
      const c: V3 = [x0, y0 - 40, H - 300];
      // In the vertical plane through the axis the cutter is the flat core
      // plus a quarter circle; a line of slope m meets the uphill arc.
      const am = Math.abs(m);
      const expected = H + am * RF + RC * (Math.sqrt(1 + m * m) - 1);
      expect(Math.abs(drop(x0, y0, a, b, c) - expected)).toBeLessThan(TOL);
    });
  }

  for (const [p, m] of [[2.4, 0.5], [1.0, 0.8], [2.9, -2.0], [0.3, 0.05]] as const) {
    it(`sloped edge offset ${p}, slope ${m}: matches a 1D golden-section max`, () => {
      const H = 5;
      const a: V3 = [x0 + p, y0 - 20, H - 20 * m];
      const b: V3 = [x0 + p, y0 + 20, H + 20 * m];
      const c: V3 = [x0 + 40, y0, H - 300];
      const expected = refSegmentMax(a, b, x0, y0, R, RC);
      expect(Math.abs(drop(x0, y0, a, b, c) - expected)).toBeLessThan(TOL);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Degenerate limits
// ---------------------------------------------------------------------------

describe('WO-1968 bull drop: degenerate limits', () => {
  const rnd = lcg(1968);
  const tris: [V3, V3, V3, number, number][] = [];
  for (let i = 0; i < 400; i++) {
    const v = (): V3 => [rnd() * 10 - 5, rnd() * 10 - 5, rnd() * 8 - 4];
    tris.push([v(), v(), v(), rnd() * 6 - 3, rnd() * 6 - 3]);
  }
  // Include axis-aligned horizontal and near-vertical cases.
  tris.push([[-5, -5, 1], [5, -5, 1], [0, 5, 1], 0.2, 0.1]);
  tris.push([[1, -5, -3], [1.0000001, 5, 4], [1, 0, 9], 0, 0]);

  it('cornerRadius = 0 matches the flat drop', () => {
    let contacts = 0;
    for (const [a, b, c, x, y] of tris) {
      const flat = dropTriangleFlat(R, x, y, ...a, ...b, ...c);
      const bull = drop(x, y, a, b, c, R, 0);
      if (flat === NO_CONTACT) { expect(bull).toBe(NO_CONTACT); continue; }
      contacts++;
      expect(Math.abs(bull - flat)).toBeLessThan(1e-9);
    }
    expect(contacts).toBeGreaterThan(200);
  });

  it('cornerRadius = radius matches the ball drop', () => {
    let contacts = 0;
    for (const [a, b, c, x, y] of tris) {
      const ball = dropTriangleBall(R, x, y, ...a, ...b, ...c);
      const bull = drop(x, y, a, b, c, R, R);
      if (ball === NO_CONTACT) { expect(bull).toBe(NO_CONTACT); continue; }
      contacts++;
      expect(Math.abs(bull - ball)).toBeLessThan(1e-9);
    }
    expect(contacts).toBeGreaterThan(200);
  });

  it('near the limits the drop converges to them (continuity)', () => {
    for (const [a, b, c, x, y] of tris.slice(0, 100)) {
      const flat = dropTriangleFlat(R, x, y, ...a, ...b, ...c);
      const ball = dropTriangleBall(R, x, y, ...a, ...b, ...c);
      if (flat === NO_CONTACT) continue;
      expect(Math.abs(drop(x, y, a, b, c, R, 1e-7) - flat)).toBeLessThan(1e-6);
      expect(Math.abs(drop(x, y, a, b, c, R, R - 1e-7) - ball)).toBeLessThan(1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Random mesh: kernel == brute force, no gouge, no lift
// ---------------------------------------------------------------------------

/** Jittered heightfield, steep random relief (slopes well past 45 deg). */
function randomTerrain(seed: number, n: number, size: number): PartMesh {
  const rnd = lcg(seed);
  const positions = new Float32Array(n * n * 3);
  const step = size / (n - 1);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      const jitter = i > 0 && i < n - 1 && j > 0 && j < n - 1 ? 0.35 : 0;
      positions[k] = i * step + (rnd() - 0.5) * jitter * step;
      positions[k + 1] = j * step + (rnd() - 0.5) * jitter * step;
      positions[k + 2] = rnd() * 6;
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let q = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = b + n, d = a + n;
      indices.set([a, b, c, a, c, d], q);
      q += 6;
    }
  }
  return { positions, indices, bounds: computeBounds(positions), source: 'fixture' };
}

function vertexOf(mesh: PartMesh, i: number): V3 {
  const p = mesh.positions;
  return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
}

describe('WO-1968 bull drop: random mesh through the BvhKernel', () => {
  for (const [radius, corner] of [[3, 1], [4, 0.5], [2, 2], [3, 0.05]] as const) {
    it(`R=${radius} rc=${corner}: kernel == brute force, never gouges, never lifts > 1e-6`, async () => {
      const mesh = randomTerrain(1968 + Math.round(radius * 10 + corner * 100), 9, 20);
      const kernel = new BvhKernel();
      const mh = kernel.uploadMesh(mesh);
      const ch = kernel.makeCutter({ kind: 'bull', diameter: 2 * radius, cornerRadius: corner });
      const rnd = lcg(7);
      const n = 40;
      const xy = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        xy[2 * i] = rnd() * 24 - 2;
        xy[2 * i + 1] = rnd() * 24 - 2;
      }
      const zSeed = -100;
      const got = await kernel.dropPoints(mh, ch, xy, zSeed);
      let contacts = 0;
      for (let i = 0; i < n; i++) {
        const x = xy[2 * i], y = xy[2 * i + 1];
        expect(got[i]).toBe(dropPointOverTrianglesBull(radius, corner, x, y, zSeed, mesh.positions, mesh.indices));
        let ref = zSeed;
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const tm = refTriangleMax(
            vertexOf(mesh, mesh.indices[t]), vertexOf(mesh, mesh.indices[t + 1]), vertexOf(mesh, mesh.indices[t + 2]),
            x, y, radius, corner,
          );
          if (tm > ref) ref = tm;
        }
        if (ref > zSeed) contacts++;
        // No gouge: no surface point supports the tip higher than the drop.
        expect(got[i]).toBeGreaterThanOrEqual(ref - 1e-9);
        // No lift: the drop is a real contact, not a conservative bound.
        expect(got[i]).toBeLessThanOrEqual(ref + TOL);
      }
      expect(contacts).toBeGreaterThan(30);
      kernel.releaseCutter(ch);
      kernel.releaseMesh(mh);
    });
  }

  // rc = 0 has its max ON the hard rim, where the compass reference above
  // can stall against the curved boundary; the validated flat drop is the
  // reference there instead.
  it('R=2.5 rc=0: kernel equals the flat drop on the same mesh', async () => {
    const mesh = randomTerrain(2519, 9, 20);
    const kernel = new BvhKernel();
    const mh = kernel.uploadMesh(mesh);
    const ch = kernel.makeCutter({ kind: 'bull', diameter: 5, cornerRadius: 0 });
    const rnd = lcg(11);
    const xy = new Float64Array(80);
    for (let i = 0; i < 80; i++) xy[i] = rnd() * 24 - 2;
    const got = await kernel.dropPoints(mh, ch, xy, -100);
    for (let i = 0; i < 40; i++) {
      const flat = dropPointOverTriangles('flat', 2.5, xy[2 * i], xy[2 * i + 1], -100, mesh.positions, mesh.indices);
      expect(Math.abs(got[i] - flat)).toBeLessThan(1e-9);
    }
    kernel.releaseCutter(ch);
    kernel.releaseMesh(mh);
  });
});

// ---------------------------------------------------------------------------
// 4. Production worker path: Parallel finish with a bull-nose tool
// ---------------------------------------------------------------------------

// client <-> dispatcher(real BvhKernel, the kernel createWorkerKernel returns)
function makeClient(): Cam3dClient {
  const kernel = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {
      /* in-process channel */
    },
  };
  const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  });
  return new Cam3dClient(fakeWorker);
}

function meshToBinaryStl(mesh: PartMesh): ArrayBuffer {
  const triCount = mesh.indices.length / 3;
  const ab = new ArrayBuffer(84 + 50 * triCount);
  const view = new DataView(ab);
  view.setUint32(80, triCount, true);
  const p = mesh.positions;
  for (let t = 0; t < triCount; t++) {
    const base = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const vi = mesh.indices[t * 3 + v];
      view.setFloat32(base + v * 12, p[vi * 3], true);
      view.setFloat32(base + v * 12 + 4, p[vi * 3 + 1], true);
      view.setFloat32(base + v * 12 + 8, p[vi * 3 + 2], true);
    }
  }
  return ab;
}

const WAVE_SIZE = 20;
const BULL_TOOL: Tool = {
  id: 'tool-bull',
  name: 'bull_nose d6 r1',
  type: 'bull_nose',
  diameter: 6,
  cornerRadius: 1,
  fluteLength: 20,
  shankDiameter: 6,
  overallLength: 50,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {},
};
const PARAMS: Parallel3dParams = { stepover: 2, angleDeg: 0, tolerance: 0.1, useStockBoundary: true };
const HEIGHTS: ResolvedParallel3dHeights = { clearanceZ: 25, retractZ: 16, feedZ: 16, topZ: 15, bottomZ: 0 };
const BOUNDARY: readonly Ring[] = [new Float64Array([0, 0, WAVE_SIZE, 0, WAVE_SIZE, WAVE_SIZE, 0, WAVE_SIZE])];

describe('WO-1968 Parallel finish with a bull-nose tool (production worker path)', () => {
  it('computes a toolpath on a curved part that never gouges it', { timeout: 60_000 }, async () => {
    const source = wave(WAVE_SIZE, 25);
    const client = makeClient();
    const partMesh = await acquirePartMesh({ format: 'stl', bytes: meshToBinaryStl(source) }, PARAMS.tolerance);
    const { moves } = await computeParallel3dMoves({
      partMesh,
      tool: BULL_TOOL,
      params: PARAMS,
      resolvedHeights: HEIGHTS,
      boundary: BOUNDARY,
      client,
    });
    await client.dispose();
    const cuts = moves.filter((m) => m.role === 'cut');
    expect(cuts.length).toBeGreaterThan(50);
    for (const m of moves) expect(Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z)).toBe(true);
    // Every cut point sits on the exact bull contact (<= tolerance of chord
    // refinement never matters at the points themselves): never below it.
    let onSurface = 0;
    for (const m of cuts) {
      const exact = dropPointOverTrianglesBull(3, 1, m.x, m.y, -100, source.positions, source.indices);
      expect(m.z).toBeGreaterThanOrEqual(exact - 1e-4);
      if (Math.abs(m.z - exact) < 1e-3) onSurface++;
    }
    // The path follows the bull surface, not a ball or flat one.
    expect(onSurface / cuts.length).toBeGreaterThan(0.9);
  });
});
