import { beforeAll, describe, expect, it } from 'vitest';

import { ensureGeom2dReady, type Ring } from '../../cam3d/geom2d';
import type { AdaptivePass } from '../../cam3d/rough/engineEntry';
import {
  scheduleAdaptiveDepthBranches,
  type AdaptiveDepthComponentPlan,
} from '../../cam3d/rough/scheduleComponents';

function rect(x0: number, y0: number, x1: number, y1: number): Ring {
  return new Float64Array([x0, y0, x1, y0, x1, y1, x0, y1]);
}

function plan(
  levelIndex: number,
  originalIndex: number,
  z: number,
  boundary: Ring,
): AdaptiveDepthComponentPlan & { id: string } {
  const x = boundary[0] + 1;
  const y = boundary[1] + 1;
  const passes: AdaptivePass[] = [
    { type: 'entry', point: { x, y }, radius: 0, mode: 'plunge' },
    { type: 'cut', points: [{ x, y }, { x: x + 1, y }] },
  ];
  return {
    id: `${levelIndex}:${originalIndex}`,
    levelIndex,
    originalIndex,
    z,
    component: { boundary, holes: [] },
    passes,
  };
}

describe('Adaptive 3D depth-first component scheduling', () => {
  beforeAll(async () => ensureGeom2dReady());

  it('finishes one isolated split branch through depth before relocating', () => {
    const shared = plan(0, 0, 0, rect(0, 0, 40, 20));
    const left1 = plan(1, 0, -2, rect(0, 0, 18, 20));
    const right1 = plan(1, 1, -2, rect(22, 0, 40, 20));
    const left2 = plan(2, 0, -4, rect(0, 0, 18, 20));
    const right2 = plan(2, 1, -4, rect(22, 0, 40, 20));

    const scheduled = scheduleAdaptiveDepthBranches(
      [shared, left1, right1, left2, right2],
      { x: Number.NaN, y: Number.NaN },
    );

    expect(scheduled.map(item => item.id)).toEqual([
      '0:0', '1:0', '2:0', '1:1', '2:1',
    ]);
  });

  it('does not enter a merged lower region until every upper parent is complete', () => {
    const left = plan(0, 0, 0, rect(0, 0, 18, 20));
    const right = plan(0, 1, 0, rect(22, 0, 40, 20));
    const merged = plan(1, 0, -2, rect(0, 0, 40, 20));

    const scheduled = scheduleAdaptiveDepthBranches(
      [left, right, merged],
      { x: Number.NaN, y: Number.NaN },
    );

    expect(scheduled.map(item => item.id)).toEqual(['0:0', '0:1', '1:0']);
  });
});
