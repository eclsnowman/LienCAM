import { describe, expect, it } from 'vitest';
import { measureMesh } from '../../mesh/analysis';
import { sphereApprox, unitCube } from './fixtures';

describe('mesh measures', () => {
  it('measures a unit cube analytically', () => {
    const measures = measureMesh(unitCube());
    expect(measures.volume).toBeCloseTo(1, 6);
    expect(measures.surfaceArea).toBeCloseTo(6, 6);
    expect(measures.bbox).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(measures.genus).toBe(0);
  });

  it('measures a sphere approximation within tessellation tolerance', () => {
    const measures = measureMesh(sphereApprox(1, 64, 32));
    expect(measures.volume).toBeCloseTo((4 / 3) * Math.PI, 1);
    expect(measures.surfaceArea).toBeCloseTo(4 * Math.PI, 1);
    expect(measures.genus).toBe(0);
  });
});
