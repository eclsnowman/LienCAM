// WO-1971: exact V-bit (cone) drop-cutter in the production 3D kernel.
//
// 1. Pure math against analytic ground truth: flat facet, tilted facets
//    shallower and steeper than the flank, vertex, edges -- each to 1e-6 mm,
//    for a sharp bit and one with a tip flat.
// 2. Limits: a vanishing flank (k -> 0) and a tip flat as wide as the bit
//    are the flat drop.
// 3. Random mesh: the BvhKernel (culled) equals the uncull'd brute force
//    exactly; a dense sampling of every triangle shows no gouge; an
//    INDEPENDENT maximizer of tip(q) = q.z - k*max(0, d(q) - Rt) (nested
//    golden sections over each triangle, sharing no code with the kernel
//    math) shows the drop is the true max, never more than 1e-6 mm above.
// 4. The production worker path (Cam3dClient -> Cam3dDispatcher -> the
//    BvhKernel the worker creates) computes a Parallel finish with a V-bit
//    on a curved part.

import { describe, expect, it } from 'vitest';
import { dropTriangleFlat, NO_CONTACT } from '../../cam3d/kernel/dropCutter';
import {
  coneSlopeK,
  dropPointOverTrianglesCone,
  dropTriangleCone,
} from '../../cam3d/kernel/dropCutterCone';
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

type V3 = [number, number, number];

function drop(x: number, y: number, a: V3, b: V3, c: V3, k: number, tip: number, radius = R): number {
  return dropTriangleCone(radius, k, tip, x, y, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

// ---------------------------------------------------------------------------
// Independent reference: the support function straight from the profile.
// ---------------------------------------------------------------------------

/** Tip height a surface point supports: q.z minus the cone underside height at its axis distance. */
function supportTip(qx: number, qy: number, qz: number, x: number, y: number, radius: number, k: number, tip: number): number {
  const d = Math.hypot(qx - x, qy - y);
  // A rounding hair of slack so a rim point computed from a chord still counts.
  if (d > radius * (1 + 1e-12)) return -Infinity;
  return qz - (d > tip ? k * (d - tip) : 0);
}

const GOLD = (Math.sqrt(5) - 1) / 2;

/** Max of a unimodal (concave) function on [lo, hi] by golden section. */
function goldenMax(f: (t: number) => number, lo: number, hi: number, iters = 90): number {
  let a = lo, b = hi;
  for (let i = 0; i < iters; i++) {
    const m1 = b - GOLD * (b - a), m2 = a + GOLD * (b - a);
    if (f(m1) < f(m2)) a = m1; else b = m2;
  }
  return Math.max(f(0.5 * (a + b)), f(lo), f(hi));
}

/**
 * Max of supportTip over one triangle. tip(q) is concave over the triangle
 * clipped to the footprint disk, so g(u) = max over v of tip(a + u(b-a) +
 * v(c-a)) is concave in u and each inner line is concave in v: nested
 * golden sections over analytically clipped feasible intervals converge to
 * the global max, rim contacts included.
 */
function refTriangleMax(a: V3, b: V3, c: V3, x: number, y: number, radius: number, k: number, tip: number): number {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const vv = vx * vx + vy * vy;
  // Feasible v on the line u = const: 0 <= v <= 1 - u and |q_xy - axis| <= R.
  const vRange = (u: number): [number, number] | null => {
    const wx = a[0] + u * ux - x, wy = a[1] + u * uy - y;
    let lo = 0, hi = 1 - u;
    if (vv < 1e-18) {
      if (wx * wx + wy * wy > radius * radius) return null;
    } else {
      const g = wx * vx + wy * vy;
      const disc = g * g - vv * (wx * wx + wy * wy - radius * radius);
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      lo = Math.max(lo, (-g - sq) / vv);
      hi = Math.min(hi, (-g + sq) / vv);
    }
    return lo <= hi ? [lo, hi] : null;
  };
  const inner = (u: number): number => {
    const range = vRange(u);
    if (range === null) return -Infinity;
    const qx0 = a[0] + u * ux, qy0 = a[1] + u * uy, qz0 = a[2] + u * uz;
    return goldenMax((v) => supportTip(qx0 + v * vx, qy0 + v * vy, qz0 + v * vz, x, y, radius, k, tip), range[0], range[1]);
  };
  // Feasible u is an interval (the triangle clipped to a disk is convex):
  // find one feasible u densely, then bisect each end.
  const N = 400;
  let seed = -1;
  for (let i = 0; i <= N && seed < 0; i++) if (vRange(i / N) !== null) seed = i / N;
  if (seed < 0) return -Infinity;
  const edge = (from: number, to: number): number => {
    if (vRange(to) !== null) return to;
    let ok = from, bad = to;
    for (let i = 0; i < 80; i++) {
      const mid = 0.5 * (ok + bad);
      if (vRange(mid) !== null) ok = mid; else bad = mid;
    }
    return ok;
  };
  return goldenMax(inner, edge(seed, 0), edge(seed, 1));
}

/** Max of supportTip along a segment, by golden section on its feasible part. */
function refSegmentMax(p: V3, q: V3, x: number, y: number, radius: number, k: number, tip: number): number {
  const F = (s: number): number => supportTip(
    p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1]), p[2] + s * (q[2] - p[2]), x, y, radius, k, tip,
  );
  const ex = q[0] - p[0], ey = q[1] - p[1], wx = p[0] - x, wy = p[1] - y;
  const e2 = ex * ex + ey * ey, g = wx * ex + wy * ey, w2 = wx * wx + wy * wy;
  const disc = g * g - e2 * (w2 - radius * radius);
  return goldenMax(F, Math.max(0, (-g - Math.sqrt(disc)) / e2), Math.min(1, (-g + Math.sqrt(disc)) / e2), 200);
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

// [label, half-angle from axis, tip flat radius]
const PROFILES = [
  ['sharp 90 deg V (45 from axis)', 45, 0],
  ['sharp 60 deg V (30 from axis)', 30, 0],
  ['60 deg V with a 0.8 mm tip flat', 30, 0.4],
] as const;

for (const [label, angle, TIP] of PROFILES) {
  const K = coneSlopeK(angle);

  describe(`WO-1971 V-bit drop, ${label}: analytic ground truth`, () => {
    const x0 = 0.7, y0 = -1.3;

    it('flat facet: the tip rests on it, tip z = facet z', () => {
      const z = drop(x0, y0, [-50, -50, 4.25], [50, -50, 4.25], [0, 50, 4.25], K, TIP);
      expect(Math.abs(z - 4.25)).toBeLessThan(TOL);
    });

    it('flat facet the axis misses: the flank rests on its near edge', () => {
      // Triangle entirely at x >= x0 + 1.5: the nearest point is 1.5 mm out.
      const z = drop(x0, y0, [x0 + 1.5, y0 - 20, 2], [x0 + 40, y0, 2], [x0 + 1.5, y0 + 20, 2], K, TIP);
      expect(Math.abs(z - (2 - K * Math.max(0, 1.5 - TIP)))).toBeLessThan(TOL);
    });

    // Gradients shallower and steeper than the flank rise K.
    for (const f of [0.3, 0.85, 1.2, 2.5]) {
      const g = f * K;
      it(`tilted facet, slope ${f} x the flank's: ${f < 1 ? 'tip' : 'rim'} contact`, () => {
        const dir = [0.6, -0.8];
        const gx = g * dir[0], gy = g * dir[1];
        const plane = (px: number, py: number): number => gx * px + gy * py + 3;
        const a: V3 = [-60, -60, plane(-60, -60)];
        const b: V3 = [60, -60, plane(60, -60)];
        const c: V3 = [0, 60, plane(0, 60)];
        // Uphill from the axis the tip rises g per mm over the flat, g - K
        // over the flank: shallower -> the flat's rim, steeper -> the cone's rim.
        const expected = g < K ? plane(x0, y0) + g * TIP : plane(x0, y0) + g * R - K * (R - TIP);
        expect(Math.abs(drop(x0, y0, a, b, c, K, TIP) - expected)).toBeLessThan(TOL);
      });
    }

    for (const dv of [0.2, 1.2, 2.5, 2.95]) {
      it(`vertex at axis distance ${dv}: tip = vz - flank height`, () => {
        const H = 7;
        const a: V3 = [x0 + dv, y0, H];
        const b: V3 = [x0 + 60, y0 + 5, H - 100];
        const c: V3 = [x0 + 60, y0 - 5, H - 100];
        const expected = H - K * Math.max(0, dv - TIP);
        expect(Math.abs(drop(x0, y0, a, b, c, K, TIP) - expected)).toBeLessThan(TOL);
      });
    }

    it('vertex outside the footprint: no contact', () => {
      expect(drop(x0, y0, [x0 + 3.01, y0, 7], [x0 + 60, y0 + 5, -93], [x0 + 60, y0 - 5, -93], K, TIP)).toBe(NO_CONTACT);
    });

    for (const p of [0.25, 1.0, 2.5]) {
      it(`horizontal edge at perpendicular distance ${p}`, () => {
        const H = 5;
        const a: V3 = [x0 + p, y0 - 20, H];
        const b: V3 = [x0 + p, y0 + 20, H];
        const c: V3 = [x0 + 40, y0, H - 100];
        expect(Math.abs(drop(x0, y0, a, b, c, K, TIP) - (H - K * Math.max(0, p - TIP)))).toBeLessThan(TOL);
      });
    }

    for (const f of [0.6, -0.4, 1.5, -3.0]) {
      const m = f * K;
      it(`sloped edge through the axis, slope ${f} x the flank's: the V cross-section contact`, () => {
        const H = 5;
        const a: V3 = [x0 - 20, y0, H - 20 * m];
        const b: V3 = [x0 + 20, y0, H + 20 * m];
        const c: V3 = [x0, y0 - 40, H - 300];
        // In the vertical plane through the axis the bit is a V (with its
        // flat): a line shallower than the flank meets the flat's uphill
        // corner, a steeper one the V's uphill rim.
        const am = Math.abs(m);
        const expected = am < K ? H + am * TIP : H + am * R - K * (R - TIP);
        expect(Math.abs(drop(x0, y0, a, b, c, K, TIP) - expected)).toBeLessThan(TOL);
      });
    }

    for (const [p, f] of [[2.4, 0.5], [1.0, 0.8], [2.9, -2.0], [0.3, 0.05], [0.2, 0.97], [1.7, 1.01]] as const) {
      it(`sloped edge offset ${p}, slope ${f} x the flank's: matches a 1D golden-section max`, () => {
        const H = 5;
        const m = f * K;
        const a: V3 = [x0 + p, y0 - 20, H - 20 * m];
        const b: V3 = [x0 + p, y0 + 20, H + 20 * m];
        const c: V3 = [x0 + 40, y0, H - 300];
        const expected = refSegmentMax(a, b, x0, y0, R, K, TIP);
        expect(Math.abs(drop(x0, y0, a, b, c, K, TIP) - expected)).toBeLessThan(TOL);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Limits
// ---------------------------------------------------------------------------

describe('WO-1971 V-bit drop: limits are the flat drop', () => {
  const rnd = lcg(1971);
  const tris: [V3, V3, V3, number, number][] = [];
  for (let i = 0; i < 400; i++) {
    const v = (): V3 => [rnd() * 10 - 5, rnd() * 10 - 5, rnd() * 8 - 4];
    tris.push([v(), v(), v(), rnd() * 6 - 3, rnd() * 6 - 3]);
  }
  tris.push([[-5, -5, 1], [5, -5, 1], [0, 5, 1], 0.2, 0.1]);
  tris.push([[1, -5, -3], [1.0000001, 5, 4], [1, 0, 9], 0, 0]);

  it('a vanishing flank (k -> 0) converges to the flat drop', () => {
    let contacts = 0;
    for (const [a, b, c, x, y] of tris) {
      const flat = dropTriangleFlat(R, x, y, ...a, ...b, ...c);
      const cone = drop(x, y, a, b, c, 1e-9, 0);
      if (flat === NO_CONTACT) { expect(cone).toBe(NO_CONTACT); continue; }
      contacts++;
      expect(Math.abs(cone - flat)).toBeLessThan(1e-7);
    }
    expect(contacts).toBeGreaterThan(200);
  });

  it('a tip flat as wide as the bit is the flat drop, whatever the angle', () => {
    for (const [a, b, c, x, y] of tris) {
      const flat = dropTriangleFlat(R, x, y, ...a, ...b, ...c);
      const cone = drop(x, y, a, b, c, coneSlopeK(30), R);
      if (flat === NO_CONTACT) { expect(cone).toBe(NO_CONTACT); continue; }
      expect(Math.abs(cone - flat)).toBeLessThan(1e-9);
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

describe('WO-1971 V-bit drop: random mesh through the BvhKernel', () => {
  // [radius, half-angle from axis, tip flat diameter]
  for (const [radius, angle, tipD] of [[3, 45, 0], [3, 30, 0.8], [4, 60, 0], [2, 15, 0.2]] as const) {
    it(`R=${radius} ${angle} deg from axis, tip ${tipD}: kernel == brute force, never gouges, never lifts > 1e-6`, async () => {
      const k = coneSlopeK(angle);
      const tip = tipD / 2;
      const mesh = randomTerrain(1971 + radius * 10 + angle, 9, 20);
      const kernel = new BvhKernel();
      const mh = kernel.uploadMesh(mesh);
      const ch = kernel.makeCutter({ kind: 'vbit', diameter: 2 * radius, angleFromAxisDeg: angle, tipDiameter: tipD });
      const rnd = lcg(7 + angle);
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
        expect(got[i]).toBe(dropPointOverTrianglesCone(radius, k, tip, x, y, zSeed, mesh.positions, mesh.indices));
        let ref = zSeed;
        let sampled = zSeed;
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const a = vertexOf(mesh, mesh.indices[t]);
          const b = vertexOf(mesh, mesh.indices[t + 1]);
          const c = vertexOf(mesh, mesh.indices[t + 2]);
          const tm = refTriangleMax(a, b, c, x, y, radius, k, tip);
          if (tm > ref) ref = tm;
          if (tm === -Infinity) continue;
          // Brute force: every sampled surface point of the triangle must
          // sit at or below the cutter at the dropped height.
          const S = 30;
          for (let p = 0; p <= S; p++) {
            for (let q = 0; p + q <= S; q++) {
              const u = p / S, v = q / S;
              const st = supportTip(
                a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]),
                a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]),
                a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]),
                x, y, radius, k, tip,
              );
              if (st > sampled) sampled = st;
            }
          }
        }
        if (ref > zSeed) contacts++;
        // No gouge: no sampled surface point, and not the true max, supports the tip higher.
        expect(got[i]).toBeGreaterThanOrEqual(sampled - 1e-9);
        expect(got[i]).toBeGreaterThanOrEqual(ref - 1e-9);
        // No lift: the drop is a real contact, not a conservative bound.
        expect(got[i]).toBeLessThanOrEqual(ref + TOL);
      }
      expect(contacts).toBeGreaterThan(30);
      kernel.releaseCutter(ch);
      kernel.releaseMesh(mh);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Production worker path: Parallel finish with a V-bit
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
const VBIT_TOOL: Tool = {
  id: 'tool-vbit',
  name: 'V-bit d6 60 deg',
  type: 'v_bit',
  diameter: 6,
  angleFromAxisDeg: 30,
  fluteLength: 10,
  shankDiameter: 6,
  overallLength: 50,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {},
};
const PARAMS: Parallel3dParams = { stepover: 1, angleDeg: 0, tolerance: 0.1, useStockBoundary: true };
const HEIGHTS: ResolvedParallel3dHeights = { clearanceZ: 25, retractZ: 16, feedZ: 16, topZ: 15, bottomZ: 0 };
const BOUNDARY: readonly Ring[] = [new Float64Array([0, 0, WAVE_SIZE, 0, WAVE_SIZE, WAVE_SIZE, 0, WAVE_SIZE])];

describe('WO-1971 Parallel finish with a V-bit (production worker path)', () => {
  it('computes a toolpath on a curved part that never gouges it', { timeout: 60_000 }, async () => {
    const source = wave(WAVE_SIZE, 25);
    const client = makeClient();
    const partMesh = await acquirePartMesh({ format: 'stl', bytes: meshToBinaryStl(source) }, PARAMS.tolerance);
    const { moves } = await computeParallel3dMoves({
      partMesh,
      tool: VBIT_TOOL,
      params: PARAMS,
      resolvedHeights: HEIGHTS,
      boundary: BOUNDARY,
      client,
    });
    await client.dispose();
    const cuts = moves.filter((m) => m.role === 'cut');
    expect(cuts.length).toBeGreaterThan(50);
    for (const m of moves) expect(Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z)).toBe(true);
    const k = coneSlopeK(30);
    let onSurface = 0;
    for (const m of cuts) {
      const exact = dropPointOverTrianglesCone(3, k, 0, m.x, m.y, -100, source.positions, source.indices);
      expect(m.z).toBeGreaterThanOrEqual(exact - 1e-4);
      if (Math.abs(m.z - exact) < 1e-3) onSurface++;
    }
    // The path follows the V-bit's contact, not a flat or ball one.
    expect(onSurface / cuts.length).toBeGreaterThan(0.9);
  });
});
