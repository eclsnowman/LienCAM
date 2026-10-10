// WO-1176: the waterline Z ladder and flat-area detection.

import { describe, expect, it } from 'vitest';
import { bossInOpenStock, pocketBox, hemisphereOnSlab } from '../../cam3d/fixtures';
import {
  flatFaceHeights,
  planWaterlineLevels,
  LEVEL_MERGE_EPS,
} from '../../cam3d/strategies/waterline/levels';

describe('planWaterlineLevels', () => {
  it('steps down from one stepdown below the top and always ends on the bottom', () => {
    expect(planWaterlineLevels({ topZ: 10, bottomZ: 0, stepdown: 3 })).toEqual([7, 4, 1, 0]);
  });

  it('does not cut the top itself and keeps a short final step', () => {
    const levels = planWaterlineLevels({ topZ: 5, bottomZ: 0.5, stepdown: 2 });
    expect(levels).toEqual([3, 1, 0.5]);
    expect(levels).not.toContain(5);
    expect(levels[levels.length - 1]).toBe(0.5);
  });

  it('merges a ladder level that lands on the bottom instead of duplicating it', () => {
    expect(planWaterlineLevels({ topZ: 6, bottomZ: 0, stepdown: 2 })).toEqual([4, 2, 0]);
  });

  it('inserts flat-face heights inside the band, never at the top or the bottom', () => {
    const levels = planWaterlineLevels({
      topZ: 10, bottomZ: 0, stepdown: 4, flatHeights: [10, 7.5, 0, 12, -1],
    });
    expect(levels).toEqual([7.5, 6, 2, 0]);
  });

  it('treats a flat height within LEVEL_MERGE_EPS of a ladder level as that level', () => {
    const levels = planWaterlineLevels({
      topZ: 10, bottomZ: 0, stepdown: 4, flatHeights: [6 + LEVEL_MERGE_EPS / 2],
    });
    expect(levels).toHaveLength(3);
  });

  it('lifts a level that lands on an upward flat face by the lift, ladder or inserted alike', () => {
    // Ladder 27, 24, 21, 18, 15, ... with a floor at 15: 15 is lifted to 15.02.
    const levels = planWaterlineLevels({
      topZ: 30, bottomZ: 0, stepdown: 3, liftOffFlats: [30, 15], flatLiftMm: 0.02,
    });
    expect(levels).toContain(15.02);
    expect(levels).not.toContain(15);
    // An inserted flat height is lifted the same way; the top itself never becomes a level.
    const inserted = planWaterlineLevels({
      topZ: 10, bottomZ: 0, stepdown: 4, flatHeights: [10, 7.5], liftOffFlats: [10, 7.5], flatLiftMm: 0.02,
    });
    expect(inserted).toEqual([7.52, 6, 2, 0]);
    // The bottom of the band on a floor is lifted too (still inside the band).
    expect(planWaterlineLevels({ topZ: 10, bottomZ: 5, stepdown: 4, liftOffFlats: [5], flatLiftMm: 0.02 }))
      .toEqual([6, 5.02]);
  });

  it('refuses a stepdown that would ask for more than MAX_LEVELS levels', () => {
    expect(() => planWaterlineLevels({ topZ: 10, bottomZ: 0, stepdown: 1e-6 })).toThrow(/limit is 5000/);
  });

  it('refuses an empty band and a non-positive stepdown by name', () => {
    expect(() => planWaterlineLevels({ topZ: 0, bottomZ: 0, stepdown: 1 })).toThrow(/finishing band is empty/);
    expect(() => planWaterlineLevels({ topZ: 2, bottomZ: 5, stepdown: 1 })).toThrow(/finishing band is empty/);
    expect(() => planWaterlineLevels({ topZ: 5, bottomZ: 0, stepdown: 0 })).toThrow(/stepdown must be/);
  });
});

describe('flatFaceHeights', () => {
  it('finds the top of a box and the floor of a pocket, not the bottom face', () => {
    const heights = flatFaceHeights(pocketBox({ x: 80, y: 60, z: 30 }, { x: 40, y: 30, depth: 15 }));
    expect(heights).toEqual([30, 15]);
  });

  it('finds a boss top; the slab-less boss has only its top', () => {
    expect(flatFaceHeights(bossInOpenStock({ x: 100, y: 100 }, { x: 80, y: 80, z: 14 }))).toEqual([14]);
  });

  it('ignores a dome (no horizontal facets beyond the slab top)', () => {
    const heights = flatFaceHeights(hemisphereOnSlab(20, { x: 100, y: 100, t: 10 }));
    expect(heights).toEqual([10]);
  });
});
