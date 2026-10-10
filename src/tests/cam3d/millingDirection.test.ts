import { describe, expect, it } from 'vitest';

import {
  directionForClockwisePlanner,
  materialSideForMilling,
} from '../../cam3d/rough/millingDirection';

describe('Adaptive 3D physical milling direction', () => {
  it('preserves the selection for clockwise spindle rotation', () => {
    expect(directionForClockwisePlanner('climb', 'cw')).toBe('climb');
    expect(directionForClockwisePlanner('conventional', 'cw')).toBe('conventional');
  });

  it('inverts the canonical XY sense when spindle rotation reverses', () => {
    expect(directionForClockwisePlanner('climb', 'ccw')).toBe('conventional');
    expect(directionForClockwisePlanner('conventional', 'ccw')).toBe('climb');
  });

  it('pins the complete spindle rotation and material-side matrix', () => {
    // WO-1896: climb keeps material on the cutter's RIGHT with a CW (M3) spindle.
    expect(materialSideForMilling('climb', 'cw')).toBe('right');
    expect(materialSideForMilling('conventional', 'cw')).toBe('left');
    expect(materialSideForMilling('climb', 'ccw')).toBe('left');
    expect(materialSideForMilling('conventional', 'ccw')).toBe('right');
  });
});
