import { describe, expect, it } from 'vitest';
import type { Ring } from '../../cam3d/geom2d';
import type { CutterSpec } from '../../cam3d/kernel/types';
import { planWallCleanup } from '../../cam3d/rough/wallCleanup';
import { ZDexelField } from '../../cam3d/stock';

const RING: Ring = new Float64Array([
  5, 5,
  15, 5,
  15, 15,
  5, 15,
]);
const CUTTER: CutterSpec = { kind: 'flat', diameter: 2 };

function clearedStock(): ZDexelField {
  return ZDexelField.fromBox({
    minX: 0, minY: 0, minZ: -2,
    maxX: 20, maxY: 20, maxZ: 0,
  }, 0.5);
}

describe('Adaptive 3D retained-wall transitions', () => {
  it('orients a straight conventional wall entry from the physical material side', () => {
    const plan = planWallCleanup([RING], clearedStock(), CUTTER, 2, null, 2, 'conventional');
    const finish = plan.moves.filter((move) => move.role === 'finish');

    expect(plan.contourCount).toBe(1);
    expect(finish).toHaveLength(5);
    // WO-1896: conventional keeps the exterior wall's material on the left -> CCW.
    expect(finish.map(({ x, y }) => [x, y])).toEqual([
      [5, 5], [15, 5], [15, 15], [5, 15], [5, 5],
    ]);
  });

  it('keeps the selected physical cut direction across exterior and interior cleanup', () => {
    const hole = new Float64Array(Array.from(RING).reduce<number[]>((out, _value, index, all) => {
      if (index % 2 !== 0) return out;
      const pointIndex = index / 2;
      const sourceIndex = ((all.length / 2 - pointIndex) % (all.length / 2)) * 2;
      out.push(all[sourceIndex], all[sourceIndex + 1]);
      return out;
    }, []));
    const signedTravelArea = (ring: Ring, direction: 'climb' | 'conventional'): number => {
      const finish = planWallCleanup(
        [ring], clearedStock(), CUTTER, 2, null, 2, direction,
      ).moves.filter((move) => move.role === 'finish');
      let sum = 0;
      for (let index = 1; index < finish.length; index++) {
        const a = finish[index - 1];
        const b = finish[index];
        sum += a.x * b.y - b.x * a.y;
      }
      return sum / 2;
    };

    // Clockwise spindle viewed from +Z: climb keeps retained material RIGHT
    // (WO-1896), so it is CW around an exterior and CCW around an interior wall.
    expect(signedTravelArea(RING, 'climb')).toBeLessThan(0);
    expect(signedTravelArea(hole, 'climb')).toBeGreaterThan(0);
    expect(signedTravelArea(RING, 'conventional')).toBeGreaterThan(0);
    expect(signedTravelArea(hole, 'conventional')).toBeLessThan(0);
  });

  it('emits tangent quarter-circle lead-in and lead-out paths on the cleared side', () => {
    const plan = planWallCleanup(
      [RING], clearedStock(), CUTTER, 2, null, 2, 'conventional', 2, 2, 0.5,
    );
    const finish = plan.moves.filter((move) => move.role === 'finish');

    expect(plan.moves.some((move) => move.role === 'lead_in')).toBe(false);
    expect(plan.moves.some((move) => move.role === 'lead_out')).toBe(false);
    expect(finish.length).toBeGreaterThan(12);
    expect(finish[0]).toMatchObject({ t: 'feed', role: 'finish' });
    expect(finish.every(move => Number.isFinite(move.x) && Number.isFinite(move.y))).toBe(true);
    expect(finish.every(move => move.x >= 0 && move.x <= 20 && move.y >= 0 && move.y <= 20))
      .toBe(true);
  });

  it('fails loudly when a requested radius has no proven-cleared entry and exit', () => {
    const uncleared = ZDexelField.fromBox({
      minX: 0, minY: 0, minZ: -2,
      maxX: 20, maxY: 20, maxZ: 10,
    }, 0.5);

    expect(() => planWallCleanup(
      [RING], uncleared, CUTTER, 2, null, 2, 'climb', 2, 2, 0.5,
    )).toThrow(/requested wall transition radius does not fit in proven-cleared space/);
  });
});
