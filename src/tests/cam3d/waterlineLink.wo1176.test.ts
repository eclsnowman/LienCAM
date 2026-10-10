// WO-1176: the waterline linker -- stay-down between levels, profile ramps,
// retracts over the traverse plane, and the motion invariants.

import { describe, expect, it } from 'vitest';
import { linkWaterlinePasses } from '../../cam3d/strategies/waterline/link';
import type { WaterlinePass } from '../../cam3d/strategies/waterline/loops';
import { TRAVERSE_STANDOFF_MM } from '../../cam3d/pathbuild';

const heights = { clearanceZ: 30, retractZ: 20, feedZ: 12 };

/** A square loop of side `s` centred at (cx, cy), CCW, at height z. */
function square(cx: number, cy: number, s: number, z: number, level: number, region = 0): WaterlinePass {
  const h = s / 2;
  return {
    xy: new Float64Array([cx - h, cy - h, cx + h, cy - h, cx + h, cy + h, cx - h, cy + h]),
    z, closed: true, level, materialInside: true, region,
  };
}

function open(points: number[], z: number, level: number): WaterlinePass {
  return { xy: new Float64Array(points), z, closed: false, level, materialInside: false, region: 0 };
}

function cuts(moves: ReturnType<typeof linkWaterlinePasses>) {
  return moves.filter((m) => m.role === 'cut');
}

describe('linkWaterlinePasses', () => {
  it('starts with rapids at the traverse plane, enters through Feed, and ends up at the traverse plane', () => {
    const moves = linkWaterlinePasses([square(50, 50, 20, 10, 0)], heights, { stepdown: 2, cutterRadiusMm: 3 });
    expect(moves[0]).toMatchObject({ t: 'rapid', z: 30, role: 'rapid' });
    expect(moves[1]).toMatchObject({ t: 'rapid', z: 12, role: 'rapid' });
    expect(moves[moves.length - 1]).toMatchObject({ t: 'rapid', z: 30, role: 'rapid' });
    for (const m of moves) expect(m.z).toBeLessThanOrEqual(30);
  });

  it('descends along the loop itself at the ramp angle, never steeper, and then cuts the whole loop', () => {
    const pass = square(50, 50, 20, 10, 0);
    const moves = linkWaterlinePasses([pass], heights, { stepdown: 2, cutterRadiusMm: 3, rampAngleDeg: 10 });
    const leads = moves.filter((m) => m.role === 'lead_in');
    expect(leads.length).toBeGreaterThan(0);
    // Every lead_in vertex lies on the square's outline.
    for (const m of leads) {
      const onOutline = Math.abs(Math.abs(m.x - 50) - 10) < 1e-9 || Math.abs(Math.abs(m.y - 50) - 10) < 1e-9;
      expect(onOutline).toBe(true);
    }
    // The ramp slope between consecutive lead_in moves is the ramp angle (10 deg).
    let prev = moves[1]; // the rapid at Feed, start of the ramp
    for (const m of leads) {
      const run = Math.hypot(m.x - prev.x, m.y - prev.y);
      const drop = prev.z - m.z;
      if (run > 1e-9) expect(drop / run).toBeCloseTo(Math.tan((10 * Math.PI) / 180), 6);
      prev = m;
    }
    // The drop from Feed (12) to the level (10) is 2 mm: 11.3 mm of ramp, less than one lap (80 mm).
    expect(leads[leads.length - 1].z).toBe(10);
    // The cut then runs one full loop and closes on the touchdown point.
    const c = cuts(moves);
    expect(c.length).toBeGreaterThanOrEqual(4);
    expect(c[c.length - 1]).toMatchObject({ x: leads[leads.length - 1].x, y: leads[leads.length - 1].y, z: 10 });
    for (const m of c) expect(m.z).toBe(10);
  });

  it('plunges to one stepdown above a deep level, then ramps the last stepdown (laps only when the loop is small)', () => {
    // Feed at 12, level at 2: 10 mm drop. The ramp takes only the last
    // stepdown (2 mm = 11.3 mm of ramp); the first 8 mm are a plunge at the
    // loop's start. A 24 mm perimeter absorbs the ramp in half a lap.
    const pass = square(10, 10, 6, 2, 0);
    const moves = linkWaterlinePasses([pass], { ...heights, feedZ: 12 }, { stepdown: 2, cutterRadiusMm: 2 });
    const plunge = moves.find((m) => m.role === 'plunge');
    expect(plunge).toMatchObject({ x: 7, y: 7, z: 4 });
    const leads = moves.filter((m) => m.role === 'lead_in');
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.length).toBeLessThan(8);
    expect(leads[leads.length - 1].z).toBe(2);
    let walked = 0;
    let prev = plunge!;
    for (const m of leads) {
      walked += Math.hypot(m.x - prev.x, m.y - prev.y);
      prev = m;
    }
    expect(walked).toBeCloseTo(2 / Math.tan((10 * Math.PI) / 180), 6);
    // A loop smaller than the ramp still laps: 2 mm perimeter, 11.3 mm of ramp.
    const tiny = square(10, 10, 0.5, 2, 0);
    const lapped = linkWaterlinePasses([tiny], { ...heights, feedZ: 12 }, { stepdown: 2, cutterRadiusMm: 0.2 });
    expect(lapped.filter((m) => m.role === 'lead_in').length).toBeGreaterThan(16);
  });

  it('plunges instead of ramping on a loop smaller than the cutter', () => {
    const pass = square(10, 10, 1, 2, 0); // 4 mm perimeter, cutter radius 3
    const moves = linkWaterlinePasses([pass], heights, { stepdown: 2, cutterRadiusMm: 3 });
    expect(moves.some((m) => m.role === 'plunge')).toBe(true);
    expect(moves.some((m) => m.role === 'lead_in')).toBe(false);
  });

  it('stays down between two levels of the same wall and retracts between islands', () => {
    const wallTop = square(50, 50, 20, 10, 0, 0);
    const wallNext = square(50, 50, 20, 8, 1, 0); // same xy: reach 0
    const other = square(150, 50, 20, 9, 0, 1); // far away (its own z so the cut search below is unambiguous)
    const moves = linkWaterlinePasses([wallTop, wallNext, other], heights, { stepdown: 2, cutterRadiusMm: 3 });
    const rapidsUp = moves.filter((m) => m.t === 'rapid' && m.z === 30);
    // One entry (over), one hop to the other island (up, over), one final lift.
    expect(rapidsUp.length).toBe(4);
    // Between wallTop and wallNext there is no rapid at all.
    const firstCutOfNext = moves.findIndex((m) => m.role === 'cut' && m.z === 8);
    const lastCutOfTop = moves.map((m) => m.role === 'cut' && m.z === 10).lastIndexOf(true);
    const between = moves.slice(lastCutOfTop + 1, firstCutOfNext);
    expect(between.every((m) => m.t === 'feed')).toBe(true);
    expect(between.some((m) => m.role === 'lead_in')).toBe(true);
  });

  it('retracts when the next loop starts further away than min(stepdown, cutter radius)', () => {
    const top = square(50, 50, 20, 10, 0);
    const next = square(50, 50, 30, 8, 1); // 5 mm further out on every side
    const moves = linkWaterlinePasses([top, next], heights, { stepdown: 2, cutterRadiusMm: 3 });
    const idxNextCut = moves.findIndex((m) => m.role === 'cut' && m.z === 8);
    const before = moves.slice(0, idxNextCut);
    expect(before.filter((m) => m.t === 'rapid' && m.z === 30).length).toBeGreaterThanOrEqual(3);
  });

  it('never stays down onto a HIGHER level', () => {
    const low = square(50, 50, 20, 8, 1);
    const high = square(50, 50, 20, 10, 0);
    const moves = linkWaterlinePasses([low, high], heights, { stepdown: 2, cutterRadiusMm: 3 });
    const idxHighCut = moves.findIndex((m) => m.role === 'cut' && m.z === 10);
    const lastLowCut = moves.map((m) => m.role === 'cut' && m.z === 8).lastIndexOf(true);
    expect(moves.slice(lastLowCut + 1, idxHighCut).some((m) => m.t === 'rapid')).toBe(true);
  });

  it('floors the traverse plane on a proven material top', () => {
    const moves = linkWaterlinePasses([square(50, 50, 20, 10, 0)], { ...heights, materialTopZ: 40 }, {
      stepdown: 2, cutterRadiusMm: 3,
    });
    expect(moves[0].z).toBe(40 + TRAVERSE_STANDOFF_MM);
    expect(moves[moves.length - 1].z).toBe(40 + TRAVERSE_STANDOFF_MM);
  });

  it('plunges at the start of an OPEN pass and cuts every vertex from the first one (audit finding 1)', () => {
    const long = open([0, 0, 100, 0], 10, 0);
    const a = linkWaterlinePasses([long], heights, { stepdown: 2, cutterRadiusMm: 3 });
    expect(a.some((m) => m.role === 'lead_in')).toBe(false);
    expect(a.find((m) => m.role === 'plunge')).toMatchObject({ x: 0, y: 0, z: 10 });
    const c = cuts(a);
    expect(c[0]).toMatchObject({ x: 100, y: 0, z: 10 });
    // Nothing between the start and the end is skipped: the cut begins where the plunge landed.
    const plungeIndex = a.findIndex((m) => m.role === 'plunge');
    expect(a[plungeIndex + 1]).toMatchObject({ x: 100, y: 0, z: 10, role: 'cut' });
    const multi = open([0, 50, 10, 50, 20, 50, 30, 50], 10, 0);
    const b = linkWaterlinePasses([multi], heights, { stepdown: 2, cutterRadiusMm: 3 });
    expect(cuts(b).map((m) => m.x)).toEqual([10, 20, 30]);
  });

  it('refuses a pass above the Feed plane and inverted heights by name', () => {
    expect(() => linkWaterlinePasses([square(0, 0, 10, 13, 0)], heights, { stepdown: 2, cutterRadiusMm: 3 }))
      .toThrow(/above feedZ/);
    expect(() => linkWaterlinePasses([square(0, 0, 10, 5, 0)], { clearanceZ: 10, retractZ: 20, feedZ: 12 }, {
      stepdown: 2, cutterRadiusMm: 3,
    })).toThrow(/clearanceZ >= retractZ >= feedZ/);
  });

  it('is byte-identical across two runs of the same input', () => {
    const passes = [square(50, 50, 20, 10, 0), square(50, 50, 20, 8, 1), square(150, 50, 20, 10, 0, 1)];
    const a = JSON.stringify(linkWaterlinePasses(passes, heights, { stepdown: 2, cutterRadiusMm: 3 }));
    const b = JSON.stringify(linkWaterlinePasses(passes, heights, { stepdown: 2, cutterRadiusMm: 3 }));
    expect(a).toBe(b);
  });
});
