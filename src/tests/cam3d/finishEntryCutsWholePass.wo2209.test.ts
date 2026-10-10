// WO-2209: a 3D finish pass that is entered from Feed Height is cut from its
// first sample to its last.
//
// WO-2206 measured the defect (src/tests/evidence/WO-2206/REPORT.md, FINDING):
// the entry ramp started over the pass start and descended FORWARD along the
// pass, riding above the samples it passed over, and cutting began after
// touchdown -- 4289.9 of 8015.1 mm of the portrait relief's passes were never
// cut. Every lead-in now ends ON the pass's first sample, and the pass is cut
// from there.
//
// These drive buildLinkedPath directly with synthetic surfaces (the engine
// test the order names); the production-path proof is
// src/tests/cam3d/finishLinkCensus.wo2206.test.ts.
//
//   npx vitest run src/tests/cam3d/finishEntryCutsWholePass.wo2209.test.ts

import { describe, expect, it } from 'vitest';
import {
  buildLinkedPath,
  type ConnectorSampler,
  type LinkPolicy,
  type PathBuildHeights,
} from '../../cam3d/pathbuild';
import type { IrMove } from '../../cam3d/ir/types';

const TAN10 = Math.tan((10 * Math.PI) / 180);
const HEIGHTS: PathBuildHeights = { clearanceZ: 10, retractZ: 3, feedZ: 1 };
const POLICY: LinkPolicy = { stepover: 2, cutterContactRadiusMm: 3 };
const flatSampler: ConnectorSampler = (xy) => Promise.resolve(new Float64Array(xy.length / 2));

function pass(points: Array<[number, number, number]>): Float64Array {
  return Float64Array.from(points.flat());
}

/** Pass along +X at y with z = f(x), integer-mm points 0..len. */
function xPass(y: number, len: number, f: (x: number) => number = () => 0): Float64Array {
  const pts: Array<[number, number, number]> = [];
  for (let x = 0; x <= len; x++) pts.push([x, y, f(x)]);
  return pass(pts);
}

function reversed(p: Float64Array): Float64Array {
  const n = p.length / 3;
  const out = new Float64Array(p.length);
  for (let j = 0; j < n; j++) for (let c = 0; c < 3; c++) out[j * 3 + c] = p[(n - 1 - j) * 3 + c];
  return out;
}

const at = (p: Float64Array, j: number): [number, number, number] => [p[j * 3], p[j * 3 + 1], p[j * 3 + 2]];
const sameXYZ = (m: IrMove, q: [number, number, number]): boolean => m.x === q[0] && m.y === q[1] && m.z === q[2];

/**
 * Walks the program pass by pass (in builder order) and proves each one is cut
 * end to end: the tool stands exactly ON sample 0 when the pass's cut begins,
 * and the 'cut' moves that follow are samples 1..n-1, in order, bit for bit.
 * Returns the xy length cut per pass.
 */
function expectEveryPassCutEndToEnd(passes: readonly Float64Array[], moves: IrMove[], zigzag = true): number[] {
  const cutLengths: number[] = [];
  let k = 0;
  for (let i = 0; i < passes.length; i++) {
    const p = zigzag && i % 2 === 1 ? reversed(passes[i]) : passes[i];
    const n = p.length / 3;
    // Advance to the move that stands on sample 0 and is followed by a cut of sample 1.
    while (k < moves.length && !(sameXYZ(moves[k], at(p, 0)) && moves[k + 1]?.role === 'cut' && sameXYZ(moves[k + 1], at(p, 1)))) {
      expect(moves[k].role, `pass ${i}: a cut before the tool reached the pass start (move ${k})`).not.toBe('cut');
      k++;
    }
    expect(k, `pass ${i}: the tool never stood on the pass start before cutting it`).toBeLessThan(moves.length);
    let len = 0;
    for (let j = 1; j < n; j++) {
      const m = moves[k + j];
      expect(m.role, `pass ${i} sample ${j}`).toBe('cut');
      expect(sameXYZ(m, at(p, j)), `pass ${i} sample ${j} cut exactly`).toBe(true);
      len += Math.hypot(p[j * 3] - p[(j - 1) * 3], p[j * 3 + 1] - p[(j - 1) * 3 + 1]);
    }
    cutLengths.push(len);
    k += n;
  }
  return cutLengths;
}

/** Pass z along its polyline at xy arc length d (the chord between samples). */
function chordZAt(p: Float64Array, d: number): number {
  const n = p.length / 3;
  let acc = 0;
  for (let j = 1; j < n; j++) {
    const seg = Math.hypot(p[j * 3] - p[(j - 1) * 3], p[j * 3 + 1] - p[(j - 1) * 3 + 1]);
    if (d <= acc + seg || j === n - 1) {
      const t = seg > 0 ? Math.min(1, Math.max(0, (d - acc) / seg)) : 1;
      return p[(j - 1) * 3 + 2] + (p[j * 3 + 2] - p[(j - 1) * 3 + 2]) * t;
    }
    acc += seg;
  }
  return p[2];
}

/** Every lead-in segment of an entry into straight +X pass `p` stays at or above the pass chord. */
function expectLeadInNeverBelowSurface(p: Float64Array, moves: IrMove[]): number {
  const x0 = p[0];
  let checked = 0;
  for (let i = 1; i < moves.length; i++) {
    const b = moves[i];
    if (b.role !== 'lead_in' && b.role !== 'plunge') continue;
    const a = moves[i - 1];
    for (let s = 0; s <= 50; s++) {
      const t = s / 50;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      expect(z, `lead-in segment ${i} at x=${x}`).toBeGreaterThanOrEqual(chordZAt(p, x - x0) - 1e-12);
      checked++;
    }
  }
  return checked;
}

describe('WO-2209: every pass entered from Feed Height is cut from its first sample to its last', () => {
  it('reverse ramp on a flat pass: lands over the ramp top, ramps back onto the start, cuts all 10 mm', async () => {
    const p = xPass(0, 10);
    const moves = await buildLinkedPath([p], HEIGHTS, POLICY, flatSampler);
    // Ramp run = (feedZ - z0) / tan(10deg) = 1 / 0.17633 = 5.6713 mm.
    const run = 1 / TAN10;
    expect(run).toBeCloseTo(5.6713, 4);
    expect(moves.map((m) => m.role)).toEqual([
      'rapid', 'rapid', 'lead_in', 'lead_in', 'lead_in', 'lead_in', 'lead_in', 'lead_in',
      'cut', 'cut', 'cut', 'cut', 'cut', 'cut', 'cut', 'cut', 'cut', 'cut', 'rapid',
    ]);
    expect(moves[1].x).toBeCloseTo(run, 12);
    expect(moves[1]).toMatchObject({ t: 'rapid', y: 0, z: 1 });
    const leadZ = moves.slice(2, 8).map((m) => [m.x, Number(m.z.toFixed(6))]);
    expect(leadZ).toEqual([[5, 0.881635], [4, 0.705308], [3, 0.528981], [2, 0.352654], [1, 0.176327], [0, 0]]);
    expect(expectEveryPassCutEndToEnd([p], moves)).toEqual([10]);
    expect(expectLeadInNeverBelowSurface(p, moves)).toBeGreaterThan(0);
  });

  it('the lead-in rides ON the surface wherever the surface stands above the ramp line', async () => {
    // Surface climbs faster than 10 deg near the start: 0, 0.5, then 0.9 flat.
    const p = xPass(0, 10, (x) => (x === 0 ? 0 : x === 1 ? 0.5 : 0.9));
    const moves = await buildLinkedPath([p], HEIGHTS, POLICY, flatSampler);
    const lead = moves.filter((m) => m.role === 'lead_in').map((m) => [m.x, Number(m.z.toFixed(6))]);
    // Ramp line at x = 5..1: 0.8816, 0.7053, 0.5290, 0.3527, 0.1763 -- the
    // surface (0.9, 0.9, 0.9, 0.9, 0.5) is above every one of them.
    expect(lead).toEqual([[5, 0.9], [4, 0.9], [3, 0.9], [2, 0.9], [1, 0.5], [0, 0]]);
    expect(expectEveryPassCutEndToEnd([p], moves)).toEqual([10]);
    expect(expectLeadInNeverBelowSurface(p, moves)).toBeGreaterThan(0);
  });

  it('ramp and return: a pass too short for the reverse ramp ramps forward, then comes back to its start', async () => {
    // 4 mm of pass < 5.671 mm of ramp, but the surface rises to meet the
    // forward ramp line at x = 3 (1 - 3 tan10 = 0.4710 <= 0.8).
    const zs = [0, 0.2, 0.5, 0.8, 0.9];
    const p = xPass(0, 4, (x) => zs[x]);
    const moves = await buildLinkedPath([p], HEIGHTS, POLICY, flatSampler);
    expect(moves.map((m) => m.role)).toEqual([
      'rapid', 'rapid', 'lead_in', 'lead_in', 'lead_in', 'lead_in', 'lead_in', 'lead_in',
      'cut', 'cut', 'cut', 'cut', 'rapid',
    ]);
    expect(moves[1]).toMatchObject({ t: 'rapid', x: 0, y: 0, z: 1 });
    const lead = moves.slice(2, 8).map((m) => [m.x, Number(m.z.toFixed(6))]);
    expect(lead).toEqual([[1, 0.823673], [2, 0.647346], [3, 0.8], [2, 0.5], [1, 0.2], [0, 0]]);
    expect(moves.filter((m) => m.role === 'plunge')).toHaveLength(0);
    expect(expectEveryPassCutEndToEnd([p], moves)).toEqual([4]);
    expect(expectLeadInNeverBelowSurface(p, moves)).toBeGreaterThan(0);
  });

  it('a pass too short for any ramp still plunges at its start, as before', async () => {
    const p = xPass(0, 3);
    const moves = await buildLinkedPath([p], HEIGHTS, POLICY, flatSampler);
    expect(moves.map((m) => m.role)).toEqual(['rapid', 'rapid', 'plunge', 'cut', 'cut', 'cut', 'rapid']);
    expect(expectEveryPassCutEndToEnd([p], moves)).toEqual([3]);
  });

  it('every retract-entered pass of a raster is cut whole: cut length = pass length', async () => {
    // 6 mm apart > 2 x stepover: every link retracts, every pass is re-entered.
    const passes = [0, 6, 12, 18].map((y) => xPass(y, 20, (x) => 0.3 * Math.sin(x / 3)));
    const heights: PathBuildHeights = { clearanceZ: 10, retractZ: 3, feedZ: 2 };
    const moves = await buildLinkedPath(passes, heights, POLICY, flatSampler);
    const entries = moves.filter((m, i) => i > 0 && m.t === 'rapid' && m.z === heights.feedZ);
    expect(entries).toHaveLength(4);
    const lengths = expectEveryPassCutEndToEnd(passes, moves);
    expect(lengths).toEqual([20, 20, 20, 20]);
    let cutLen = 0;
    moves.forEach((m, i) => { if (i > 0 && m.role === 'cut') cutLen += Math.hypot(m.x - moves[i - 1].x, m.y - moves[i - 1].y); });
    expect(cutLen).toBeCloseTo(80, 9);
    // No lead-in or entry point ever sits above Feed Height.
    for (const m of moves) if (m.role === 'lead_in') expect(m.z).toBeLessThanOrEqual(heights.feedZ + 1e-12);
  });

  it('never gouges: lead-ins stay on or above a wavy pass at several Feed Heights', async () => {
    const wave = (x: number): number => 0.8 * Math.sin(x / 1.7) + 0.4 * Math.sin(x * 1.3);
    let checked = 0;
    for (const feedZ of [1.3, 2, 3.5, 6]) {
      const p = xPass(0, 40, wave);
      const heights: PathBuildHeights = { clearanceZ: 10, retractZ: feedZ, feedZ };
      const moves = await buildLinkedPath([p], heights, { ...POLICY, zigzag: false }, flatSampler);
      checked += expectLeadInNeverBelowSurface(p, moves);
      expect(expectEveryPassCutEndToEnd([p], moves, false)).toEqual([40]);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('stay-down links are unchanged: the same feed moves across the same ground', async () => {
    const passes = [0, 2, 4, 6].map((y) => xPass(y, 10));
    const moves = await buildLinkedPath(passes, HEIGHTS, POLICY, flatSampler);
    const links = moves.filter((m) => m.role === 'stepover').map((m) => [m.t, m.x, m.y, m.z]);
    expect(links).toEqual([
      ['feed', 10, 1, 0], ['feed', 10, 2, 0],
      ['feed', 0, 3, 0], ['feed', 0, 4, 0],
      ['feed', 10, 5, 0], ['feed', 10, 6, 0],
    ]);
    // Only the first pass is entered from Feed Height; all four are cut whole.
    expect(moves.filter((m) => m.t === 'rapid')).toHaveLength(3);
    expect(expectEveryPassCutEndToEnd(passes, moves)).toEqual([10, 10, 10, 10]);
  });
});
