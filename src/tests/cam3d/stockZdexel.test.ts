// cam3d stock: ZDexelField unit tests -- construction, budget coarsening,
// canonical empty encoding, clone independence, determinism (D-006),
// sweep idempotence, plunge degeneration, engagement basics, and the
// perf smoke (CPU time, never wall-clock -- see bvhKernel.test.ts for why).

import { describe, it, expect } from 'vitest';

import {
  ZDexelField,
  DEFAULT_CELL_BUDGET,
  removeSweep,
  engagementAt,
  sweepProfile,
  profileHeight,
  type Box3,
  type LinearMove,
} from '../../cam3d/stock';
import type { CutterSpec } from '../../cam3d/kernel/types';

const BOX: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 60, maxZ: 20 };
const FLAT10: CutterSpec = { kind: 'flat', diameter: 10 };
const BALL10: CutterSpec = { kind: 'ball', diameter: 10 };

function bytesEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let k = 0; k < ua.length; k++) {
    if (ua[k] !== ub[k]) return false;
  }
  return true;
}

describe('ZDexelField.fromBox', () => {
  it('builds the requested grid when it fits the budget', () => {
    const f = ZDexelField.fromBox(BOX, 0.5);
    expect(f.nx).toBe(200);
    expect(f.ny).toBe(120);
    expect(f.cell).toBe(0.5);
    expect(f.effectiveCellSize).toBe(0.5);
    expect(f.requestedCellSize).toBe(0.5);
    expect(f.warnings).toHaveLength(0);
    expect(f.top).toHaveLength(200 * 120);
    // Every column solid from minZ to maxZ.
    for (const v of f.top) expect(v).toBe(20);
    for (const v of f.bottom) expect(v).toBe(0);
    // Cell centers per the grid convention.
    expect(f.centerX(0)).toBeCloseTo(0.25, 12);
    expect(f.centerY(119)).toBeCloseTo(59.75, 12);
    expect(f.colIndex(3, 2)).toBe(2 * 200 + 3);
  });

  it('coarsens LOUDLY when the requested cell size busts the budget', () => {
    // 0.1mm over 100x60 = 600k columns; budget 10k forces coarsening.
    const f = ZDexelField.fromBox(BOX, 0.1, 10_000);
    expect(f.nx * f.ny).toBeLessThanOrEqual(10_000);
    expect(f.effectiveCellSize).toBeGreaterThan(0.1);
    expect(f.requestedCellSize).toBe(0.1);
    expect(f.warnings.length).toBeGreaterThan(0);
    expect(f.warnings[0]).toMatch(/budget.*forced coarsening/i);
  });

  it('default budget admits a 2000x2000-class field (D-016 sizing)', () => {
    expect(DEFAULT_CELL_BUDGET).toBe(4_000_000);
    const f = ZDexelField.fromBox({ ...BOX, maxX: 100, maxY: 100 }, 0.05); // 2000 x 2000
    expect(f.nx).toBe(2000);
    expect(f.ny).toBe(2000);
    expect(f.warnings).toHaveLength(0);
  });

  it('rejects garbage inputs loudly', () => {
    expect(() => ZDexelField.fromBox({ ...BOX, maxX: 0 }, 0.5)).toThrow(/positive XY extent/);
    expect(() => ZDexelField.fromBox(BOX, 0)).toThrow(/requestedCellSize/);
    expect(() => ZDexelField.fromBox(BOX, Number.NaN)).toThrow(/requestedCellSize/);
    expect(() => ZDexelField.fromBox({ ...BOX, maxZ: -1 }, 0.5)).toThrow(/maxZ/);
  });
});

describe('ZDexelField.fromColumnTops (test/fixture support)', () => {
  it('copies tops and canonicalizes empty columns to top === bottom', () => {
    const tops = Float32Array.from([10, 5, 5, -3]); // 5 = bottom, -3 below it
    const f = ZDexelField.fromColumnTops({ originX: 0, originY: 0, nx: 2, ny: 2, cell: 1 }, tops, 5);
    expect(f.top[0]).toBe(10);
    expect(f.top[1]).toBe(5); // top === bottom: canonical empty
    expect(f.top[2]).toBe(5);
    expect(f.top[3]).toBe(5); // below-bottom input clamped to canonical empty
    expect(f.bottom[3]).toBe(5);
    tops[0] = 99; // caller's array is not aliased
    expect(f.top[0]).toBe(10);
  });

  it('rejects a length mismatch', () => {
    expect(() =>
      ZDexelField.fromColumnTops(
        { originX: 0, originY: 0, nx: 3, ny: 2, cell: 1 },
        new Float32Array(5),
        0,
      ),
    ).toThrow(/5 entries.*needs 6/);
  });
});

describe('removeSweep basics', () => {
  const PASS: LinearMove = { x0: 20, y0: 30, z0: 15, x1: 80, y1: 30, z1: 15 };

  it('is idempotent: repeating the identical sweep changes nothing', () => {
    const f = ZDexelField.fromBox(BOX, 0.5);
    removeSweep(f, PASS, FLAT10);
    const snapshot = f.top.slice();
    const again = removeSweep(f, PASS, FLAT10);
    expect(again.removedVolumeMm3).toBe(0);
    expect(bytesEqual(f.top, snapshot)).toBe(true);
  });

  it('is deterministic: same construction + sweeps give byte-identical arrays (D-006)', () => {
    const build = (): ZDexelField => {
      const f = ZDexelField.fromBox(BOX, 0.5);
      removeSweep(f, PASS, FLAT10);
      removeSweep(f, { x0: 30, y0: 10, z0: 18, x1: 70, y1: 50, z1: 12 }, BALL10); // ramp
      removeSweep(f, { x0: 50, y0: 30, z0: 20, x1: 50, y1: 30, z1: 8 }, FLAT10); // plunge
      return f;
    };
    const a = build();
    const b = build();
    expect(bytesEqual(a.top, b.top)).toBe(true);
    expect(bytesEqual(a.bottom, b.bottom)).toBe(true);
  });

  it('clone is independent: mutating the clone leaves the original untouched', () => {
    const f = ZDexelField.fromBox(BOX, 0.5);
    const before = f.top.slice();
    const c = f.clone();
    removeSweep(c, PASS, FLAT10);
    expect(bytesEqual(f.top, before)).toBe(true);
    expect(bytesEqual(c.top, before)).toBe(false);
  });

  it('vertical plunge degenerates to a single circular imprint at min(z0, z1)', () => {
    const f = ZDexelField.fromBox(BOX, 0.5);
    removeSweep(f, { x0: 50, y0: 30, z0: 20, x1: 50, y1: 30, z1: 12 }, FLAT10);
    const R = 5;
    for (let j = 0; j < f.ny; j++) {
      for (let i = 0; i < f.nx; i++) {
        const dx = f.centerX(i) - 50;
        const dy = f.centerY(j) - 30;
        const inside = dx * dx + dy * dy <= R * R;
        expect(f.top[f.colIndex(i, j)]).toBe(inside ? 12 : 20);
      }
    }
  });

  it('ball plunge imprint matches the closed-form profile per column', () => {
    const f = ZDexelField.fromBox(BOX, 0.5);
    removeSweep(f, { x0: 50, y0: 30, z0: 20, x1: 50, y1: 30, z1: 10 }, BALL10);
    const R = 5;
    for (let j = 55; j <= 64; j++) {
      const dy = f.centerY(j) - 30;
      const i = 99; // centerX = 49.75, dx = -0.25
      const dx = f.centerX(i) - 50;
      const d = Math.sqrt(dx * dx + dy * dy);
      const expected = d <= R ? 10 + profileHeight('ball', R, d) : 20;
      expect(Math.abs(f.top[f.colIndex(i, j)] - expected)).toBeLessThanOrEqual(1e-6);
    }
  });

  it('cutting below the stock bottom leaves canonical empty columns (top === bottom)', () => {
    const f = ZDexelField.fromBox(BOX, 0.5);
    removeSweep(f, { x0: 50, y0: 30, z0: 20, x1: 50, y1: 30, z1: -4 }, FLAT10);
    const c = f.colIndex(100, 60); // center (50.25, 30.25), well inside R=5
    expect(f.top[c]).toBe(f.bottom[c]);
    expect(f.top[c]).toBe(0);
  });

  it('fails loud on unsupported cutter kinds and bad moves', () => {
    const f = ZDexelField.fromBox(BOX, 0.5);
    expect(() =>
      removeSweep(f, PASS, { kind: 'bull', diameter: 10, cornerRadius: 2 }),
    ).toThrow(/not supported/);
    expect(() =>
      removeSweep(f, { ...PASS, x1: Number.NaN }, FLAT10),
    ).toThrow(/must be finite/);
    expect(() => sweepProfile({ kind: 'vbit', diameter: 10, angleFromAxisDeg: 30 })).toThrow(
      /not supported/,
    );
  });
});

describe('engagementAt', () => {
  it('is zero when the tool is fully above stock, grows with depth, and never mutates', () => {
    const f = ZDexelField.fromBox(BOX, 0.5);
    const before = f.top.slice();
    const at = (z: number): number =>
      engagementAt(f, { x0: 20, y0: 30, z0: z, x1: 80, y1: 30, z1: z }, FLAT10);
    expect(at(25)).toBe(0); // tip above the 20mm stock top
    expect(at(20)).toBe(0); // tip exactly at the top: nothing below it removed
    const e2 = at(18);
    const e5 = at(15);
    const e10 = at(10);
    expect(e2).toBeGreaterThan(0);
    expect(e5).toBeGreaterThan(e2);
    expect(e10).toBeGreaterThan(e5);
    // Long slot sanity: average area approaches D * depth (plus disc ends).
    expect(e5).toBeGreaterThan(10 * 5);
    expect(e5).toBeLessThan(10 * 5 * 1.2);
    expect(bytesEqual(f.top, before)).toBe(true);
  });

  it('returns 0 for a zero-length move', () => {
    const f = ZDexelField.fromBox(BOX, 0.5);
    expect(engagementAt(f, { x0: 50, y0: 30, z0: 10, x1: 50, y1: 30, z1: 10 }, FLAT10)).toBe(0);
  });
});

describe('perf smoke (CPU time, not wall-clock)', () => {
  it('200 short horizontal ball passes on a 1000x600 field stay under 2000 ms CPU', () => {
    // 100 x 60 mm at 0.1 mm = 1000 x 600 = 600k columns (well under budget).
    const f = ZDexelField.fromBox(BOX, 0.1);
    expect(f.nx).toBe(1000);
    expect(f.ny).toBe(600);
    const cpu0 = process.cpuUsage();
    let removed = 0;
    for (let k = 0; k < 200; k++) {
      // Deterministic pass layout: 54 distinct y lines, cycled ~4x (repeat
      // passes remove nothing but still traverse their capsule footprint).
      const y = 3 + (k % 54);
      removed += removeSweep(
        f,
        { x0: 20, y0: y, z0: 18, x1: 40, y1: y, z1: 18 },
        BALL10,
      ).removedVolumeMm3;
    }
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    expect(removed).toBeGreaterThan(0);
    // Generous budget: measured well under 500 ms on the dev machine; the
    // assert exists to catch order-of-magnitude regressions, not jitter.
    expect(cpuMs).toBeLessThan(2000);
    console.log(`stock perf smoke: 200 ball passes on 600k columns = ${cpuMs.toFixed(1)} ms CPU`);
  });
});
