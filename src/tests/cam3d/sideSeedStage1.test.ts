// Stage 1 gate: the cam3d outside-in seed builder (buildSideEntrySeed) produces a
// clearedSeed the READ-ONLY 2D engine ACCEPTS -- it fires a lateral 'side' entry
// and clears the region. Also proves the seed's winding matches the engine
// convention (outer CCW +area, hole CW -area) and that the builder is deterministic.
//
// Frame note: buildSideEntrySeed takes geom2d Ring[] (flat Float64Array xy) and
// returns engine Loops ({x,y}[][]); feat.boundary/holes are engine Loops. The
// footprint and feat live in ONE absolute mm frame so the seed abuts feat's
// machinable region.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureEngineClipperReady,
  intersection,
  netArea,
  loopArea,
  type Loop,
  type Loops,
} from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine';
import { processFeature } from '../../lib/cam/adaptiveClearing2d/engine/processFeature';
import { buildSideEntrySeed } from '../../cam3d/rough/sideSeed';
import { ensureGeom2dReady, type Ring } from '../../cam3d/geom2d';

// Even-odd point-in-loop (independent of the builder's own copy).
function pip(loop: Loop, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// A point strictly inside a loop (longest-edge midpoint nudged inward).
function interior(loop: Loop): [number, number] {
  let bi = 0;
  let best = -1;
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    const d = (loop[j].x - loop[i].x) ** 2 + (loop[j].y - loop[i].y) ** 2;
    if (d > best) {
      best = d;
      bi = i;
    }
  }
  const j = (bi + 1) % loop.length;
  const mx = (loop[bi].x + loop[j].x) / 2;
  const my = (loop[bi].y + loop[j].y) / 2;
  const len = Math.hypot(loop[j].x - loop[bi].x, loop[j].y - loop[bi].y) || 1;
  const tx = (loop[j].x - loop[bi].x) / len;
  const ty = (loop[j].y - loop[bi].y) / len;
  const eps = 1e-4 * len;
  let nx = -ty;
  let ny = tx;
  if (!pip(loop, mx + eps * nx, my + eps * ny)) {
    nx = -nx;
    ny = -ny;
  }
  return [mx + eps * nx, my + eps * ny];
}

describe('cam3d side-entry seed (Stage 1)', () => {
  beforeAll(async () => {
    // Two SEPARATE wasm engines: geom2d (builder's boolean) and the 2D adaptive
    // engine's own clipper (processFeature).
    await ensureGeom2dReady();
    await ensureEngineClipperReady();
  });

  // The stock cross-section is the SOLID 60x60 block (CCW, +area). This mirrors the real
  // pipeline: remainingAbove(stock) is a SOLID section -- a part island is NOT a void in
  // the stock, it lives only in feat.holes below (the honest seed must not treat the
  // island region as pre-cleared, so the footprint passed to buildSideEntrySeed is solid).
  const footprint: Ring[] = [new Float64Array([-30, -30, 30, -30, 30, 30, -30, 30])];
  const toolRadius = 3;

  // feat in the SAME frame, engine Loop form: outer 60x60 with a centred 10x10 ISLAND
  // (material to keep -- the engine machines the annulus around it).
  const feat = {
    boundary: [
      { x: -30, y: -30 },
      { x: 30, y: -30 },
      { x: 30, y: 30 },
      { x: -30, y: 30 },
    ] as Loop,
    holes: [
      [
        { x: -5, y: -5 },
        { x: -5, y: 5 },
        { x: 5, y: 5 },
        { x: 5, y: -5 },
      ] as Loop,
    ],
  };
  const baseParams = {
    toolRadius,
    stepOver: 0.4,
    tolerance: 0.1,
    helixDiameter: 3,
    stockToLeave: 0,
    integralWallFollow: true,
    integralWallFollowLengthFactor: 2,
  };

  it('every returned loop has the correct winding (even depth CCW+, odd depth CW-)', () => {
    const seed = buildSideEntrySeed(footprint, toolRadius);
    expect(seed.length).toBeGreaterThan(0);
    const reps = seed.map((l) => interior(l));
    seed.forEach((loop, i) => {
      let depth = 0;
      seed.forEach((other, k) => {
        if (k !== i && pip(other, reps[i][0], reps[i][1])) depth++;
      });
      const a = loopArea(loop);
      if (depth % 2 === 0) {
        expect(a).toBeGreaterThan(0); // outer / island -> CCW +area
      } else {
        expect(a).toBeLessThan(0); // hole -> CW -area
      }
    });
  });

  it('fires a lateral side entry and clears >= 95% of the cut region', () => {
    const seed: Loops = buildSideEntrySeed(footprint, toolRadius);
    const res = processFeature(feat, { ...baseParams, clearedSeed: seed });
    expect(res.startPoint).not.toBeNull();
    expect(res.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.entries.every((entry) => entry.mode === 'side')).toBe(true);
    expect(res.entries[0].mode).toBe('side');
    expect(res.passes.some((pass) => pass.type === 'link' && pass.helixDescent !== undefined)).toBe(false);
    const covered = netArea(intersection(res.cleared, res.cutRegion));
    const total = Math.abs(netArea(res.cutRegion));
    expect(covered).toBeGreaterThanOrEqual(0.95 * total);
  }, 60_000);

  it('is deterministic (two builds deep-equal)', () => {
    const a = buildSideEntrySeed(footprint, toolRadius);
    const b = buildSideEntrySeed(footprint, toolRadius);
    expect(a).toEqual(b);
  });
});
