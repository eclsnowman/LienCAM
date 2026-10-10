// WO-1176: what happens to one level's loops -- material side, climb /
// conventional orientation, steep-only split, boundary clip, regions.
// Real BvhKernel drops on fixture meshes; the loops are hand-built where the
// slicer would put them (the slicer itself is proved in waterlineOclAdapter).

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { bossInOpenStock, pocketBox } from '../../cam3d/fixtures';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import { area } from '../../cam3d/geom2d/rings';
import type { Ring } from '../../cam3d/geom2d';
import {
  classifyLevel, clipPassToRegion, pointInRegion, pointInRing, regionise,
  type WaterlinePass,
} from '../../cam3d/strategies/waterline/loops';

/** Rectangle ring with `per` intermediate vertices on every side. */
function rect(x0: number, y0: number, x1: number, y1: number, per = 1, ccw = true): Ring {
  const pts: number[] = [];
  const side = (ax: number, ay: number, bx: number, by: number) => {
    for (let k = 0; k < per; k++) {
      const t = k / per;
      pts.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  };
  side(x0, y0, x1, y0);
  side(x1, y0, x1, y1);
  side(x1, y1, x0, y1);
  side(x0, y1, x0, y0);
  const ring = new Float64Array(pts);
  if (ccw) return ring;
  const n = ring.length / 2;
  const out = new Float64Array(ring.length);
  for (let i = 0; i < n; i++) {
    out[2 * i] = ring[2 * (n - 1 - i)];
    out[2 * i + 1] = ring[2 * (n - 1 - i) + 1];
  }
  return out;
}

const flat6 = { kind: 'flat' as const, diameter: 6 };

async function classify(
  mesh: ReturnType<typeof bossInOpenStock>,
  loops: Ring[],
  z: number,
  over: Partial<Parameters<typeof classifyLevel>[0]> = {},
) {
  const kernel = new BvhKernel();
  const m = kernel.uploadMesh(mesh);
  const c = kernel.makeCutter(flat6);
  try {
    return await classifyLevel({
      loops, z, level: 0, kernel, mesh: m, cutter: c, probeMm: 0.5, zSeed: -5,
      direction: 'climb', spindle: 'cw', minSlopeDeg: 0, minRunMm: 6, ...over,
    });
  } finally {
    kernel.releaseCutter(c);
    kernel.releaseMesh(m);
  }
}

describe('classifyLevel: material side and direction', () => {
  // bossInOpenStock: an 80 x 80 x 14 boss from (10,10) to (90,90). A 6 mm
  // flat cutter's loop at z = 7 is the boss outline pushed out by 3 mm.
  const boss = bossInOpenStock({ x: 100, y: 100 }, { x: 80, y: 80, z: 14 });
  const bossLoop = () => rect(7, 7, 93, 93, 4);

  it('sees material INSIDE a boss loop and runs CLIMB clockwise around it (cw spindle)', async () => {
    const [pass] = await classify(boss, [bossLoop()], 7);
    expect(pass.materialInside).toBe(true);
    expect(pass.closed).toBe(true);
    expect(area(pass.xy)).toBeLessThan(0); // clockwise
  });

  it('runs CONVENTIONAL counter-clockwise around the boss, and swaps again for a ccw spindle', async () => {
    const [conv] = await classify(boss, [bossLoop()], 7, { direction: 'conventional' });
    expect(area(conv.xy)).toBeGreaterThan(0);
    const [ccwSpindle] = await classify(boss, [bossLoop()], 7, { spindle: 'ccw' });
    expect(area(ccwSpindle.xy)).toBeGreaterThan(0);
  });

  // pocketBox: 80 x 60 x 30 block, 40 x 30 pocket 15 deep centred: walls at
  // x 20..60, y 15..45, floor z = 15. The cutter's loop at z = 20 is the
  // pocket outline pulled in by 3 mm.
  const pocket = pocketBox({ x: 80, y: 60, z: 30 }, { x: 40, y: 30, depth: 15 });
  const pocketLoop = (ccw: boolean) => rect(23, 18, 57, 42, 4, ccw);

  it('sees material OUTSIDE a pocket loop and runs CLIMB counter-clockwise inside it', async () => {
    const [pass] = await classify(pocket, [pocketLoop(false)], 20);
    expect(pass.materialInside).toBe(false);
    expect(area(pass.xy)).toBeGreaterThan(0); // reversed to counter-clockwise
  });

  it('classifies the pocket floor level itself (loop at the floor/wall corner) as a pocket', async () => {
    const [pass] = await classify(pocket, [pocketLoop(true)], 15);
    expect(pass.materialInside).toBe(false);
  });

  it('classifies a boss at its own top-face level as a boss', async () => {
    const [pass] = await classify(boss, [bossLoop()], 14);
    expect(pass.materialInside).toBe(true);
  });
});

/**
 * A prism extruded along y (0..40) whose xz section has a vertical west wall
 * at x = 10 (z 0..10), a flat top from x 10..20 at z = 10, and a 20 degree
 * slope from (20, 10) down to (20 + 10 / tan 20, 0).
 */
function wedge(): ReturnType<typeof bossInOpenStock> {
  const xToe = 20 + 10 / Math.tan((20 * Math.PI) / 180);
  const b = new MeshBuilder();
  const v = (x: number, y: number, z: number) => b.vertex(x, y, z);
  const y0 = 0;
  const y1 = 40;
  // section vertices: a (10,0) b (10,10) c (20,10) d (toe,0)
  const a0 = v(10, y0, 0), b0 = v(10, y0, 10), c0 = v(20, y0, 10), d0 = v(xToe, y0, 0);
  const a1 = v(10, y1, 0), b1 = v(10, y1, 10), c1 = v(20, y1, 10), d1 = v(xToe, y1, 0);
  b.quad(a0, d0, d1, a1); // bottom (-Z): a->d->d1->a1 seen from below is CCW
  b.quad(b0, c0, c1, b1); // top
  b.quad(a0, a1, b1, b0); // west wall (-X)
  b.quad(c0, d0, d1, c1); // slope (+X, up)
  b.quad(a0, b0, c0, d0); // south cap (-Y)
  b.quad(a1, d1, c1, b1); // north cap (+Y)
  return b.build();
}

describe('classifyLevel: steep areas only', () => {
  it('keeps the vertical wall and drops the 20 degree slope at a 40 degree threshold', async () => {
    const mesh = wedge();
    // Flat 6 mm cutter at z = 5: west side at x = 7; on the slope the cutter's
    // west edge touches the slope where its height is 5.
    const xSlope = 20 + 5 / Math.tan((20 * Math.PI) / 180) + 3;
    const loop = rect(7, -3, xSlope, 43, 6);
    const all = await classify(mesh, [loop], 5);
    expect(all).toHaveLength(1);
    expect(all[0].closed).toBe(true);
    const steep = await classify(mesh, [loop], 5, { minSlopeDeg: 40 });
    expect(steep.length).toBeGreaterThan(0);
    for (const pass of steep) {
      expect(pass.closed).toBe(false);
      for (let i = 0; i < pass.xy.length; i += 2) {
        const onSlopeSide = Math.abs(pass.xy[i] - xSlope) < 1e-6 && pass.xy[i + 1] > 0 && pass.xy[i + 1] < 40;
        expect(onSlopeSide).toBe(false);
      }
    }
    // The west wall survives.
    expect(steep.some((p) => Array.from(p.xy).some((v, i) => i % 2 === 0 && Math.abs(v - 7) < 1e-6))).toBe(true);
  });

  it('drops confetti: runs shorter than the cutter diameter vanish', async () => {
    const mesh = wedge();
    const xSlope = 20 + 5 / Math.tan((20 * Math.PI) / 180) + 3;
    const loop = rect(7, -3, xSlope, 43, 1); // corners only: any steep run is one edge
    const steep = await classify(mesh, [loop], 5, { minSlopeDeg: 40, minRunMm: 1000 });
    expect(steep).toHaveLength(0);
  });
});

describe('clipPassToRegion', () => {
  const region = [new Float64Array([-5, -5, 5, -5, 5, 15, -5, 15])]; // x in [-5, 5]
  const square: WaterlinePass = {
    xy: new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]), z: 1, closed: true, level: 0,
    materialInside: true, region: -1,
  };

  it('keeps the inside pieces as one open pass joined across the seam', () => {
    const pieces = clipPassToRegion(square, region);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].closed).toBe(false);
    for (let i = 0; i < pieces[0].xy.length; i += 2) expect(pieces[0].xy[i]).toBeLessThanOrEqual(5 + 1e-9);
    // Kept length: half the bottom (5) + the left side (10) + half the top (5).
    let len = 0;
    const xy = pieces[0].xy;
    for (let i = 2; i < xy.length; i += 2) len += Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]);
    expect(len).toBeCloseTo(20, 9);
  });

  it('joins the seam exactly even with non-integer coordinates (audit finding 2)', () => {
    const offGrid: WaterlinePass = {
      xy: new Float64Array([0.1, 0.1, 8, 0.1, 8, 8, 0.3, 8]), z: 1, closed: true, level: 0,
      materialInside: true, region: -1,
    };
    const belowFive = [new Float64Array([-1, -1, 10, -1, 10, 5, -1, 5])];
    const pieces = clipPassToRegion(offGrid, belowFive);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].closed).toBe(false);
    // One open run: from the left-edge crossing at y = 5, through the seam vertex (0.1, 0.1), to the right-edge crossing.
    expect(pieces[0].xy[0]).toBeCloseTo(0.2240, 3);
    expect(pieces[0].xy[1]).toBe(5);
    expect(Array.from(pieces[0].xy.slice(2, 6))).toEqual([0.1, 0.1, 8, 0.1]);
  });

  it('returns the pass unchanged when it is entirely inside', () => {
    const wide = [new Float64Array([-5, -5, 50, -5, 50, 50, -5, 50])];
    expect(clipPassToRegion(square, wide)).toEqual([square]);
  });

  it('returns nothing when the pass is entirely outside', () => {
    const away = [new Float64Array([100, 100, 110, 100, 110, 110, 100, 110])];
    expect(clipPassToRegion(square, away)).toEqual([]);
  });
});

describe('regionise', () => {
  const sq = (cx: number, s: number, z: number, level: number): WaterlinePass => ({
    xy: new Float64Array([cx - s, -s, cx + s, -s, cx + s, s, cx - s, s]),
    z, closed: true, level, materialInside: true, region: -1,
  });

  it('chains levels of one wall into one region and keeps a far island separate', () => {
    const passes = [sq(0, 10, 10, 0), sq(0, 11, 8, 1), sq(0, 12, 6, 2), sq(100, 10, 10, 0), sq(100, 10, 8, 1)];
    regionise(passes, 5);
    expect(passes.map((p) => p.region)).toEqual([0, 0, 0, 1, 1]);
  });

  it('joins a wall only by proximity and side: a loop that jumped inward is another feature', () => {
    // A drafted wall: the next level is 1 mm further in on every side.
    const drafted = [sq(0, 10, 10, 0), sq(0, 9, 8, 1)];
    regionise(drafted, 3);
    expect(drafted[1].region).toBe(drafted[0].region);
    // Seven millimetres inward is not the same wall at a 3 mm reach.
    const jumped = [sq(0, 10, 10, 0), sq(0, 3, 8, 1)];
    regionise(jumped, 3);
    expect(jumped[1].region).not.toBe(jumped[0].region);
  });

  it('keeps a bore inside a boss out of the boss region (containment is not continuation)', () => {
    const boss = sq(0, 40, 10, 0);
    const bore = { ...sq(0, 5, 10, 0), materialInside: false };
    const boreBelow = { ...sq(0, 5, 8, 1), materialInside: false };
    const bossBelow = sq(0, 40, 8, 1);
    const passes = [boss, bore, bossBelow, boreBelow];
    regionise(passes, 3);
    expect(bossBelow.region).toBe(boss.region);
    expect(boreBelow.region).toBe(bore.region);
    expect(bore.region).not.toBe(boss.region);
  });
});

describe('point tests', () => {
  it('pointInRing and pointInRegion agree on a simple square', () => {
    const r = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(pointInRing(r, 5, 5)).toBe(true);
    expect(pointInRing(r, 15, 5)).toBe(false);
    expect(pointInRegion([r], 5, 5)).toBe(true);
    expect(pointInRegion([r], -1, 5)).toBe(false);
  });
});
