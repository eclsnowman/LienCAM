// Gate P2 (analytic half): stock model correctness against closed-form
// ground truth.
//
//  - VOLUME GATE: box stock minus one known flat-endmill pass must equal the
//    analytic capsule-footprint volume within a DERIVED discretization
//    bound. The column decision is a center-in/center-out test, so only
//    cells straddling the capsule boundary can err, each by at most
//    cell^2 * depth; the boundary crosses at most ~perimeter/cell * sqrt(2)
//    cells, giving |err| <= perimeter * cell * depth * sqrt(2). We assert
//    the conservative k = sqrt(2) bound and log the actual margin (center
//    sampling typically lands 1-2 orders of magnitude inside it).
//  - BALL ENVELOPE: sampled columns must match z + R - sqrt(R^2 - d^2) to
//    1e-6 (closed form; f32 storage adds at most half an ulp ~ 4.8e-7 for
//    values < 16 mm).
//  - remainingAbove STEP GATE: a 3-level step fixture queried between
//    levels must return rings enclosing exactly the higher bands -- area
//    exact at cell resolution (block tracing along cell boundaries) and
//    probe points classifying correctly (own even-odd test below; geom2d
//    exposes no point-in-poly).

import { describe, it, expect, beforeAll } from 'vitest';

import {
  ZDexelField,
  removeSweep,
  remainingAbove,
  type LinearMove,
} from '../../cam3d/stock';
import { ensureGeom2dReady, area, netArea, isOuter, isHole, type Ring } from '../../cam3d/geom2d';
import type { CutterSpec } from '../../cam3d/kernel/types';

const FLAT10: CutterSpec = { kind: 'flat', diameter: 10 };
const BALL10: CutterSpec = { kind: 'ball', diameter: 10 };

/** Even-odd point-in-ring (test-local; geom2d has no point query). */
function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i];
    const yi = ring[2 * i + 1];
    const xj = ring[2 * j];
    const yj = ring[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Even-odd across a ring set: inside the region iff inside an odd count. */
function pointInRegion(rings: readonly Ring[], x: number, y: number): boolean {
  let crossings = 0;
  for (const r of rings) if (pointInRing(r, x, y)) crossings++;
  return crossings % 2 === 1;
}

describe('Gate P2: volume of a known flat pass', () => {
  it('box minus one flat-d10 pass at depth 5 matches the analytic capsule volume', () => {
    const cell = 0.5;
    const depth = 5;
    const f = ZDexelField.fromBox(
      { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 60, maxZ: 20 },
      cell,
    );
    const pass: LinearMove = { x0: 20, y0: 30, z0: 15, x1: 80, y1: 30, z1: 15 };
    const res = removeSweep(f, pass, FLAT10);

    // Measured removal, recomputed independently from the arrays.
    let measured = 0;
    for (let c = 0; c < f.top.length; c++) measured += 20 - f.top[c];
    measured *= cell * cell;
    expect(Math.abs(measured - res.removedVolumeMm3)).toBeLessThan(1e-6);

    // Analytic: capsule footprint (rect L*D + full disc pi*R^2) times depth.
    const L = 60;
    const R = 5;
    const analytic = (L * 2 * R + Math.PI * R * R) * depth;
    // Derived bound (header): perimeter * cell * depth * sqrt(2).
    const perimeter = 2 * L + 2 * Math.PI * R;
    const bound = perimeter * cell * depth * Math.SQRT2;
    const err = Math.abs(measured - analytic);
    expect(err).toBeLessThanOrEqual(bound);
    console.log(
      `Gate P2 volume: analytic ${analytic.toFixed(3)} mm^3, measured ${measured.toFixed(3)} mm^3, ` +
        `err ${err.toFixed(3)} <= bound ${bound.toFixed(3)} (margin ${(bound / Math.max(err, 1e-12)).toFixed(1)}x)`,
    );
  });

  it('ball-d10 pass: sampled column tops equal z + R - sqrt(R^2 - d^2) to 1e-6', () => {
    const f = ZDexelField.fromBox(
      { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 60, maxZ: 20 },
      0.5,
    );
    const z = 10;
    const R = 5;
    removeSweep(f, { x0: 20, y0: 30, z0: z, x1: 80, y1: 30, z1: z }, BALL10);
    // Columns at x = 50.25 (segment interior, so d = |cy - 30| exactly),
    // |d| <= 2.75 keeps envelope < 16 mm where f32 half-ulp < 4.8e-7.
    const i = 100;
    expect(f.centerX(i)).toBeCloseTo(50.25, 12);
    let checked = 0;
    for (let j = 54; j <= 65; j++) {
      const d = Math.abs(f.centerY(j) - 30);
      expect(d).toBeLessThan(R);
      const expected = z + R - Math.sqrt(R * R - d * d);
      expect(Math.abs(f.top[f.colIndex(i, j)] - expected)).toBeLessThanOrEqual(1e-6);
      checked++;
    }
    expect(checked).toBe(12);
    // Outside the footprint: untouched.
    expect(f.top[f.colIndex(i, 40)]).toBe(20); // cy = 20.25, d = 9.75 > R
  });
});

describe('Gate P2: remainingAbove on a 3-level step fixture', () => {
  // 60 x 20 columns at 1 mm: x-band [0,20) at z=20, [20,40) at z=14,
  // [40,60) at z=8, bottom 0. Band edges align with cell boundaries so the
  // block-traced areas are EXACT rectangles.
  const frame = { originX: 0, originY: 0, nx: 60, ny: 20, cell: 1 };
  const buildStep = (): ZDexelField => {
    const tops = new Float32Array(60 * 20);
    for (let j = 0; j < 20; j++) {
      for (let i = 0; i < 60; i++) {
        tops[j * 60 + i] = i < 20 ? 20 : i < 40 ? 14 : 8;
      }
    }
    return ZDexelField.fromColumnTops(frame, tops, 0);
  };

  it('z between top and middle level: only the highest band remains', () => {
    const rings = remainingAbove(buildStep(), 17);
    expect(rings).toHaveLength(1);
    expect(isOuter(rings[0])).toBe(true);
    expect(rings[0]).toHaveLength(8); // rectangle: 4 points after collinear merge
    expect(area(rings[0])).toBeCloseTo(20 * 20, 9);
    expect(pointInRegion(rings, 10, 10)).toBe(true);
    expect(pointInRegion(rings, 30, 10)).toBe(false);
    expect(pointInRegion(rings, 50, 10)).toBe(false);
  });

  it('z between middle and low level: two higher bands remain as one region', () => {
    const rings = remainingAbove(buildStep(), 11);
    expect(rings).toHaveLength(1);
    expect(area(rings[0])).toBeCloseTo(40 * 20, 9);
    expect(pointInRegion(rings, 10, 10)).toBe(true);
    expect(pointInRegion(rings, 30, 10)).toBe(true);
    expect(pointInRegion(rings, 50, 10)).toBe(false);
  });

  it('z below all levels: full footprint; z above all: empty result', () => {
    const all = remainingAbove(buildStep(), 5);
    expect(all).toHaveLength(1);
    expect(area(all[0])).toBeCloseTo(60 * 20, 9);
    expect(remainingAbove(buildStep(), 25)).toHaveLength(0);
  });

  it('an interior pocket comes back as a CW hole ring (geom2d convention)', () => {
    const tops = new Float32Array(10 * 10).fill(20);
    for (let j = 3; j < 7; j++) {
      for (let i = 3; i < 7; i++) tops[j * 10 + i] = 5;
    }
    const f = ZDexelField.fromColumnTops({ originX: 0, originY: 0, nx: 10, ny: 10, cell: 1 }, tops, 0);
    const rings = remainingAbove(f, 10);
    expect(rings).toHaveLength(2);
    const outer = rings.filter(isOuter);
    const holes = rings.filter(isHole);
    expect(outer).toHaveLength(1);
    expect(holes).toHaveLength(1);
    expect(area(outer[0])).toBeCloseTo(100, 9);
    expect(area(holes[0])).toBeCloseTo(-16, 9);
    expect(netArea(rings)).toBeCloseTo(84, 9);
    expect(pointInRegion(rings, 5, 5)).toBe(false); // in the pocket
    expect(pointInRegion(rings, 1.5, 1.5)).toBe(true);
  });

  it('diagonally touching cells stay SEPARATE loops (deterministic saddle rule)', () => {
    const tops = Float32Array.from([20, 0, 0, 20]); // solid at (0,0) and (1,1)
    const f = ZDexelField.fromColumnTops({ originX: 0, originY: 0, nx: 2, ny: 2, cell: 1 }, tops, 0);
    const rings = remainingAbove(f, 10);
    expect(rings).toHaveLength(2);
    expect(area(rings[0])).toBeCloseTo(1, 9);
    expect(area(rings[1])).toBeCloseTo(1, 9);
    expect(netArea(rings)).toBeCloseTo(2, 9);
  });

  describe('with a region clip (geom2d intersect)', () => {
    beforeAll(async () => {
      await ensureGeom2dReady();
    });

    it('intersects the traced region with the caller rings', () => {
      const clip: Ring = Float64Array.from([0, 0, 10, 0, 10, 20, 0, 20]); // CCW 10x20
      const rings = remainingAbove(buildStep(), 17, [clip]);
      expect(rings.length).toBeGreaterThan(0);
      expect(netArea(rings)).toBeCloseTo(200, 5);
      expect(pointInRegion(rings, 5, 10)).toBe(true);
      expect(pointInRegion(rings, 15, 10)).toBe(false);
    });
  });
});
