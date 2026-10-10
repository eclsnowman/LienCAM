// cam3d geom2d: offset / boolean / area wrapper tests.
//
// Areas are asserted against exact closed-form values (miter squares stay
// square; round joins replace each convex corner square with a quarter disk;
// clipper's 'square' join chamfers tangent to the |delta| circle). Coordinate
// resolution is 1e-6 mm (PRECISION 6), so exact-geometry assertions use a
// tight closeTo and only the arc approximation gets a loose band.

import { describe, it, expect, beforeAll } from 'vitest';

import {
  ensureGeom2dReady,
  offset,
  boolean,
  area,
  netArea,
  isOuter,
  isHole,
  type Ring,
} from '../../cam3d/geom2d';

beforeAll(async () => {
  await ensureGeom2dReady();
});

/** Axis-aligned rectangle ring. ccw=true -> outer (positive area), else hole. */
function rect(x0: number, y0: number, x1: number, y1: number, ccw = true): Ring {
  const pts = ccw
    ? [x0, y0, x1, y0, x1, y1, x0, y1] // CCW in the Y-up frame
    : [x0, y0, x0, y1, x1, y1, x1, y0]; // CW
  return Float64Array.from(pts);
}

const square10 = () => rect(0, 0, 10, 10);

describe('geom2d area helpers', () => {
  it('signed area and orientation of a CCW square', () => {
    expect(area(square10())).toBeCloseTo(100, 9);
    expect(isOuter(square10())).toBe(true);
    expect(isHole(square10())).toBe(false);
  });

  it('signed area of a CW ring is negative (hole)', () => {
    const hole = rect(2, 2, 5, 5, false);
    expect(area(hole)).toBeCloseTo(-9, 9);
    expect(isHole(hole)).toBe(true);
  });
});

describe('geom2d offset of a 10x10 square by 2', () => {
  it('outward, miter join: corners stay sharp, area exactly 14x14', () => {
    const out = offset([square10()], 2, { joinType: 'miter' });
    expect(out).toHaveLength(1);
    expect(area(out[0])).toBeCloseTo(196, 3);
  });

  it('outward, square join: corners chamfered tangent to the delta circle', () => {
    // Square join cuts each miter corner (2x2 = 4 mm^2) with a chamfer line
    // tangent to the radius-2 circle at the corner bisector. Cut triangle
    // legs: 4 - 2*sqrt(2); area kept per corner = 4 - (4 - 2*sqrt(2))^2 / 2.
    // Total = 100 + 4*(10*2) + 4*corner = 148 + 32*sqrt(2) ~= 193.2548.
    const exact = 148 + 32 * Math.SQRT2;
    const out = offset([square10()], 2, { joinType: 'square' });
    expect(out).toHaveLength(1);
    expect(area(out[0])).toBeCloseTo(exact, 3);
  });

  it('outward, round join: quarter-disk corners, area 196 - (4-pi)*4', () => {
    // Each corner replaces the 2x2 miter square with a quarter disk of
    // radius 2: total = 196 - 4 * (4 - pi) = 192.5664. The polygonal arc is
    // inscribed within arcTolerance, so measured area is slightly BELOW
    // exact; per-corner deficit is bounded by arcLen * arcTol.
    const exact = 196 - (4 - Math.PI) * 4;
    const arcTol = 0.02;
    const out = offset([square10()], 2, { joinType: 'round', arcTolerance: arcTol });
    expect(out).toHaveLength(1);
    const a = area(out[0]);
    expect(Math.abs(a - exact)).toBeLessThan(4 * (Math.PI * 2 / 2) * arcTol + 1e-6);
    expect(a).toBeLessThanOrEqual(exact + 1e-6);
  });

  it('inward by 2: 6x6 area', () => {
    const out = offset([square10()], -2, { joinType: 'miter' });
    expect(out).toHaveLength(1);
    expect(area(out[0])).toBeCloseTo(36, 3);
  });

  it('inward by 6: ring annihilates, empty result is valid (not a throw)', () => {
    const out = offset([square10()], -6, { joinType: 'miter' });
    expect(out).toEqual([]);
  });
});

describe('geom2d offset of a ring with a hole (region semantics)', () => {
  // Region: 20x20 outer with an 8x8 hole centred in it.
  const region = () => [rect(0, 0, 20, 20), rect(6, 6, 14, 14, false)];

  it('outward +1 grows outer to 22x22 and shrinks hole to 6x6', () => {
    const out = offset(region(), 1, { joinType: 'miter' });
    expect(out).toHaveLength(2);
    const outer = out.find(isOuter);
    const hole = out.find(isHole);
    expect(outer).toBeDefined();
    expect(hole).toBeDefined();
    expect(area(outer as Ring)).toBeCloseTo(484, 3); // 22^2
    expect(area(hole as Ring)).toBeCloseTo(-36, 3); // 6^2
    expect(netArea(out)).toBeCloseTo(448, 3);
  });

  it('inward -1 shrinks outer to 18x18 and grows hole to 10x10', () => {
    const out = offset(region(), -1, { joinType: 'miter' });
    expect(out).toHaveLength(2);
    const outer = out.find(isOuter);
    const hole = out.find(isHole);
    expect(area(outer as Ring)).toBeCloseTo(324, 3); // 18^2
    expect(area(hole as Ring)).toBeCloseTo(-100, 3); // 10^2
    expect(netArea(out)).toBeCloseTo(224, 3);
  });
});

describe('geom2d boolean of two overlapping 10x10 squares offset 5 in x', () => {
  const a = () => [rect(0, 0, 10, 10)];
  const b = () => [rect(5, 0, 15, 10)];

  it('union: single ring, exact area 150', () => {
    const out = boolean(a(), b(), 'union');
    expect(out).toHaveLength(1);
    expect(area(out[0])).toBeCloseTo(150, 6);
  });

  it('intersect: 5x10 = 50', () => {
    const out = boolean(a(), b(), 'intersect');
    expect(out).toHaveLength(1);
    expect(area(out[0])).toBeCloseTo(50, 6);
  });

  it('difference: a minus b = 50', () => {
    const out = boolean(a(), b(), 'difference');
    expect(out).toHaveLength(1);
    expect(area(out[0])).toBeCloseTo(50, 6);
  });

  it('xor: two disjoint 5x10 rects, net area 100', () => {
    const out = boolean(a(), b(), 'xor');
    expect(out).toHaveLength(2);
    for (const r of out) expect(isOuter(r)).toBe(true);
    expect(netArea(out)).toBeCloseTo(100, 6);
  });

  it('intersect of disjoint regions: empty result is valid', () => {
    const out = boolean([rect(0, 0, 1, 1)], [rect(5, 5, 6, 6)], 'intersect');
    expect(out).toEqual([]);
  });
});

describe('geom2d determinism', () => {
  it('repeated offset calls are byte-identical', () => {
    const run = () => offset([rect(0, 0, 20, 20), rect(6, 6, 14, 14, false)], -1.3, {
      joinType: 'round',
      arcTolerance: 0.02,
    });
    const r1 = run();
    const r2 = run();
    expect(r2).toHaveLength(r1.length);
    for (let i = 0; i < r1.length; i++) {
      expect(bytesOf(r2[i])).toEqual(bytesOf(r1[i]));
    }
  });

  it('repeated boolean calls are byte-identical', () => {
    const run = () => boolean([rect(0, 0, 10, 10)], [rect(5, 0, 15, 10)], 'xor');
    const r1 = run();
    const r2 = run();
    expect(r2).toHaveLength(r1.length);
    for (let i = 0; i < r1.length; i++) {
      expect(bytesOf(r2[i])).toEqual(bytesOf(r1[i]));
    }
  });

  function bytesOf(r: Ring): Uint8Array {
    return new Uint8Array(r.buffer, r.byteOffset, r.byteLength);
  }
});

describe('geom2d fail-loud input validation', () => {
  it('2-point ring throws', () => {
    const twoPt = Float64Array.from([0, 0, 10, 10]);
    expect(() => offset([twoPt], 1)).toThrow(/degenerate/);
    expect(() => boolean([twoPt], [square10()], 'union')).toThrow(/degenerate/);
  });

  it('empty ring list throws', () => {
    expect(() => offset([], 1)).toThrow(/empty ring list/);
    expect(() => boolean([square10()], [], 'difference')).toThrow(/empty ring list/);
  });

  it('odd-length ring throws', () => {
    expect(() => offset([Float64Array.from([0, 0, 10, 0, 10])], 1)).toThrow(/odd length/);
  });

  it('non-finite coordinate throws', () => {
    expect(() => offset([Float64Array.from([0, 0, 10, 0, 10, NaN])], 1)).toThrow(/non-finite/);
  });

  it('non-finite delta throws', () => {
    expect(() => offset([square10()], Number.NaN)).toThrow(/delta must be finite/);
  });
});
