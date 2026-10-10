import { describe, expect, it } from 'vitest';
import type { AdaptivePass } from '../../cam3d/rough/engineEntry';
import {
  describeAdaptiveComponent,
  orderAdaptiveComponents,
  type AdaptiveComponentPlan,
} from '../../cam3d/rough/orderComponents';

function plan(originalIndex: number, approachX: number, terminalX: number): AdaptiveComponentPlan {
  return {
    originalIndex,
    passes: [
      { type: 'entry', point: { x: approachX, y: 0 }, radius: 0, mode: 'plunge' },
      { type: 'cut', points: [{ x: approachX, y: 0 }, { x: terminalX, y: 0 }] },
    ],
  };
}

describe('orderAdaptiveComponents', () => {
  it('chooses deterministic nearest-next groups with original-index tie breaks', () => {
    const input = [plan(2, -5, -5), plan(3, 50, 50), plan(1, 5, 5)];
    expect(orderAdaptiveComponents(input, { x: 0, y: 0 }).map((item) => item.originalIndex))
      .toEqual([1, 2, 3]);
  });

  it('preserves original first choice for a non-finite cursor, then routes nearest-next', () => {
    const input = [plan(2, 52, 52), plan(1, 100, 100), plan(0, 50, 50)];
    expect(orderAdaptiveComponents(input, { x: Number.NaN, y: 0 }).map((item) => item.originalIndex))
      .toEqual([0, 2, 1]);
  });

  it('finds the actual terminal point and fails loudly on unsafe pass blocks', () => {
    const passes: AdaptivePass[] = [
      { type: 'entry', point: { x: 10, y: 0 }, radius: 0, mode: 'plunge' },
      { type: 'finish', points: [{ x: 10, y: 0 }, { x: 15, y: 4 }] },
    ];
    expect(describeAdaptiveComponent({ originalIndex: 4, passes })).toEqual({
      approach: { x: 10, y: 0 },
      terminal: { x: 15, y: 4 },
    });
    expect(() => describeAdaptiveComponent({
      originalIndex: 0,
      passes: [{ type: 'cut', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
    })).toThrow(/does not begin with an entry-owned approach/);
  });
});
