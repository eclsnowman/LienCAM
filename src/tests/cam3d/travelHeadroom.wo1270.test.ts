// WO-1270: travel below the clearance plane keeps a deliberate air gap over the
// stock model -- LOW_TRAVEL_HEADROOM_MM -- and the corridor is judged at the
// height it actually travels.
//
// Operator, 2026-09-08, on a rapid crossing a terrace of his stepped pyramid with
// 0.05 mm of air: "Looks like it technically clears, but we should add headroom."
//
// Every case is a hand-built z-dexel field with exact numbers. The gap asserted
// is MEASURED on the emitted moves with maxTraverseIntrusion (the same ruler the
// guard uses), never restated from the constant.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { ZDexelField, removeSweep, maxTraverseIntrusion, type Box3 } from '../../cam3d/stock';
import {
  DESCENT_STANDOFF_MM,
  LOW_TRAVEL_HEADROOM_MM,
  TRAVERSE_INTRUSION_TOLERANCE_MM,
  enforceTraverseSafety,
} from '../../cam3d/rough/traverseSafety';
import type { CutterSpec } from '../../cam3d/kernel/types';
import type { IrMove } from '../../cam3d/ir/types';

const CUTTER: CutterSpec = { kind: 'flat', diameter: 4 };
const BLOCK: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 40, maxY: 40, maxZ: 10 };
const CELL = 0.5;
const CLEARANCE_Z = 25;
const FLOOR = 4;

const block = (): ZDexelField => ZDexelField.fromBox(BLOCK, CELL);

/** Mill a corridor down to `z` along y = 20, so a link can be proven clear. */
function clearCorridor(field: ZDexelField, z: number): void {
  removeSweep(field, { x0: 2, y0: 20, z0: z, x1: 38, y1: 20, z1: z }, CUTTER);
}

/**
 * Smallest air gap any LATERAL traverse below the clearance plane has over the
 * field along its actual emitted corridor, judged against the field as it stood
 * (nothing here cuts, so the field is the same before and after).
 */
function measuredLowTravelGap(
  moves: readonly IrMove[],
  start: { x: number; y: number; z: number },
  field: ZDexelField,
): { gap: number; lateralLowCount: number; lowestZ: number } {
  let prev = start;
  let gap = Number.POSITIVE_INFINITY;
  let lateralLowCount = 0;
  let lowestZ = Number.POSITIVE_INFINITY;
  for (const m of moves) {
    const isTraverse = m.t === 'rapid' || m.role === 'rapid';
    const lateral = prev.x !== m.x || prev.y !== m.y;
    if (isTraverse && lateral && Math.min(prev.z, m.z) < CLEARANCE_Z - 1e-9) {
      lateralLowCount++;
      lowestZ = Math.min(lowestZ, prev.z, m.z);
      const hit = maxTraverseIntrusion(
        field, { x0: prev.x, y0: prev.y, z0: prev.z, x1: m.x, y1: m.y, z1: m.z }, CUTTER,
      );
      gap = Math.min(gap, -hit.intrusionMm);
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return { gap, lateralLowCount, lowestZ };
}

const quiet = (): void => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
};
afterEach(() => vi.restoreAllMocks());

describe('WO-1270 LOW_TRAVEL_HEADROOM_MM: the number itself', () => {
  it('is a deliberate positive gap, not the descent hand-off standoff', () => {
    expect(LOW_TRAVEL_HEADROOM_MM).toBeGreaterThan(0);
    expect(LOW_TRAVEL_HEADROOM_MM).not.toBe(DESCENT_STANDOFF_MM);
    // Big enough to be a real allowance over the model noise the tolerance absorbs...
    expect(LOW_TRAVEL_HEADROOM_MM).toBeGreaterThanOrEqual(100 * TRAVERSE_INTRUSION_TOLERANCE_MM);
    // ...and small enough that a 3 mm stepdown still travels below the previous level.
    expect(LOW_TRAVEL_HEADROOM_MM).toBeLessThan(3);
  });
});

describe('WO-1270 enforceTraverseSafety: low travel keeps the headroom', () => {
  it('lifts a link that "technically clears" to material + headroom and keeps it LOW', () => {
    quiet();
    const stock = block();
    clearCorridor(stock, FLOOR);
    const start = { x: 5, y: 20, z: FLOOR + 0.05 }; // the old height: fifty microns of air
    const thin: IrMove[] = [{ t: 'rapid', x: 35, y: 20, z: FLOOR + 0.05, role: 'rapid' }];
    const res = enforceTraverseSafety(thin, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: start,
    });
    const measured = measuredLowTravelGap(res.moves, start, stock);
    expect(measured.lateralLowCount).toBe(1); // still Stay Down: one low lateral leg
    expect(measured.gap).toBeCloseTo(LOW_TRAVEL_HEADROOM_MM, 6); // measured, at the travel height
    expect(res.moves.every((m) => m.z < CLEARANCE_Z)).toBe(true); // never promoted to clearance
    expect(res.report.rerouted).toBe(0);
    expect(res.report.liftedForHeadroom).toBe(1);
    expect(res.report.minLowTravelGapMm).toBeCloseTo(measured.gap, 9);
    // The endpoint the next move expects is still reached, via a guarded descent.
    expect(res.lastTip).toEqual({ x: 35, y: 20, z: FLOOR + 0.05 });
  });

  it('keeps a link authored with the headroom byte-identical (idempotent: a second pass changes nothing)', () => {
    const stock = block();
    clearCorridor(stock, FLOOR);
    const start = { x: 5, y: 20, z: FLOOR + LOW_TRAVEL_HEADROOM_MM };
    const authored: IrMove[] = [
      { t: 'rapid', x: 35, y: 20, z: FLOOR + LOW_TRAVEL_HEADROOM_MM, role: 'rapid' },
    ];
    const first = enforceTraverseSafety(authored, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: start,
    });
    expect(first.moves).toEqual(authored);
    expect(first.report.liftedForHeadroom).toBe(0);
    const second = enforceTraverseSafety(first.moves, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: start,
    });
    expect(second.moves).toEqual(authored);
    expect(second.report.minLowTravelGapMm).toBeCloseTo(LOW_TRAVEL_HEADROOM_MM, 6);
  });

  it('judges the corridor at the height it travels: a terrace under the link sets the lift', () => {
    quiet();
    // Corridor cut to z 4, but a terrace 0.5 mm proud of the floor stands under the
    // middle of it (a step of the part left standing, not chips). The old rule
    // called that "clear" (no intrusion) and travelled 0.05 above the FLOOR --
    // i.e. 0.45 mm INTO the terrace was the only thing stopping it, and the
    // sweep judged at the lowest tip caught that. Now the lift is set by the
    // terrace, and the re-judge at the travel height measures the headroom from it.
    const stock = block();
    clearCorridor(stock, FLOOR);
    // Rebuild the terrace by cutting the corridor deeper everywhere except x 18..22.
    // (removeSweep only removes, so cut two deeper legs and leave the middle at 4.5.)
    const deep = block();
    removeSweep(deep, { x0: 2, y0: 20, z0: 4.5, x1: 38, y1: 20, z1: 4.5 }, CUTTER);
    removeSweep(deep, { x0: 2, y0: 20, z0: FLOOR, x1: 16, y1: 20, z1: FLOOR }, CUTTER);
    removeSweep(deep, { x0: 24, y0: 20, z0: FLOOR, x1: 38, y1: 20, z1: FLOOR }, CUTTER);
    const start = { x: 5, y: 20, z: 4.6 }; // 0.1 mm over the terrace: "technically clears"
    const link: IrMove[] = [{ t: 'rapid', x: 35, y: 20, z: 4.6, role: 'rapid' }];
    const res = enforceTraverseSafety(link, {
      stock: deep, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: start,
    });
    const measured = measuredLowTravelGap(res.moves, start, deep);
    expect(res.report.liftedForHeadroom).toBe(1);
    expect(res.report.rerouted).toBe(0);
    expect(measured.lateralLowCount).toBe(1);
    expect(measured.gap).toBeCloseTo(LOW_TRAVEL_HEADROOM_MM, 6);
    // The lateral leg travels at terrace + headroom, not floor + headroom.
    const across = res.moves.find((m) => m.x === 35 && m.y === 20 && m.t === 'rapid')!;
    expect(across.z).toBeCloseTo(4.5 + LOW_TRAVEL_HEADROOM_MM, 6);
    expect(stock).toBeDefined();
  });

  it('a corridor with STANDING material is still routed over the clearance plane, exactly as before', () => {
    const stock = block(); // nothing cut: the block stands to z 10 under the whole corridor
    const link: IrMove[] = [{ t: 'rapid', x: 35, y: 20, z: FLOOR, role: 'rapid' }];
    const res = enforceTraverseSafety(link, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: FLOOR },
    });
    expect(res.moves).toEqual([
      { t: 'rapid', x: 5, y: 20, z: CLEARANCE_Z, role: 'rapid' },
      { t: 'rapid', x: 35, y: 20, z: CLEARANCE_Z, role: 'rapid' },
      { t: 'rapid', x: 35, y: 20, z: 10 + DESCENT_STANDOFF_MM, role: 'rapid' },
      { t: 'feed', x: 35, y: 20, z: FLOOR, role: 'plunge' },
    ]);
    expect(res.report.reroutedHitMaterial).toBe(1);
    expect(res.report.liftedForHeadroom).toBe(0);
  });

  it('honours a caller-supplied headroom, and refuses a nonsensical one', () => {
    quiet();
    const stock = block();
    clearCorridor(stock, FLOOR);
    const start = { x: 5, y: 20, z: FLOOR + 1.5 };
    const link: IrMove[] = [{ t: 'rapid', x: 35, y: 20, z: FLOOR + 1.5, role: 'rapid' }];
    const res = enforceTraverseSafety(link, {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: start, lowTravelHeadroomMm: 2,
    });
    expect(res.report.liftedForHeadroom).toBe(1);
    expect(measuredLowTravelGap(res.moves, start, stock).gap).toBeCloseTo(2, 6);
    expect(() =>
      enforceTraverseSafety(link, {
        stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
        initialTip: start, lowTravelHeadroomMm: -1,
      }),
    ).toThrow(/lowTravelHeadroomMm/);
  });

  it('caps the lift at the clearance plane when material stands within the headroom of it', () => {
    quiet();
    // Clearance only 0.4 mm above the material top: the lift cannot have 1 mm of
    // air below clearance, so it takes the operator's declared safe plane.
    const stock = block();
    const tightClearance = BLOCK.maxZ + 0.4;
    const start = { x: 5, y: 20, z: BLOCK.maxZ + 0.1 };
    const link: IrMove[] = [{ t: 'rapid', x: 35, y: 20, z: BLOCK.maxZ + 0.1, role: 'rapid' }];
    const res = enforceTraverseSafety(link, {
      stock, cutter: CUTTER, clearanceZ: tightClearance, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: start,
    });
    const across = res.moves.find((m) => m.x === 35 && m.y === 20 && m.t === 'rapid')!;
    expect(across.z).toBeCloseTo(tightClearance, 9);
    expect(res.moves.every((m) => m.z <= tightClearance + 1e-9)).toBe(true);
    expect(res.report.liftedForHeadroom).toBe(1);
    expect(res.lastTip).toEqual({ x: 35, y: 20, z: BLOCK.maxZ + 0.1 });
  });

  it('says what it did, in the console, with the measured air', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const stock = block();
    clearCorridor(stock, FLOOR);
    enforceTraverseSafety([{ t: 'rapid', x: 35, y: 20, z: FLOOR + 0.05, role: 'rapid' }], {
      stock, cutter: CUTTER, clearanceZ: CLEARANCE_Z, materialTopZ: BLOCK.maxZ, stockProven: true,
      initialTip: { x: 5, y: 20, z: FLOOR + 0.05 },
    });
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line).toContain('[travel-headroom]');
    expect(line).toMatch(new RegExp(`${LOW_TRAVEL_HEADROOM_MM.toFixed(3)} mm of air`));
    expect(line).toContain(`z=${(FLOOR + LOW_TRAVEL_HEADROOM_MM).toFixed(3)}`);
  });
});
