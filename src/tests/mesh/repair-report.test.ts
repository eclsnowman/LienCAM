import { describe, expect, it } from 'vitest';
import { analyzeMesh, repairMesh } from '../../mesh/analysis';
import { cubeWithMissingTop, selfIntersectingTriangles, unitCube } from './fixtures';

describe('mesh repair report', () => {
  it('classifies a clean watertight cube', () => {
    const report = analyzeMesh(unitCube());
    expect(report.watertight).toBe(true);
    expect(report.holeCount).toBe(0);
    expect(report.degenerateTriangleCount).toBe(0);
    expect(report.selfIntersections).toBe(false);
  });

  it('classifies a mesh with a hole and repairs it to watertight output', () => {
    const open = analyzeMesh(cubeWithMissingTop());
    expect(open.watertight).toBe(false);
    expect(open.holeCount).toBe(1);
    expect(open.boundaryEdgeCount).toBe(4);

    const repaired = repairMesh(cubeWithMissingTop());
    expect(repaired.filledHoleCount).toBe(1);
    expect(repaired.report.watertight).toBe(true);
    expect(repaired.report.holeCount).toBe(0);
  });

  it('classifies self-intersecting triangles', () => {
    const report = analyzeMesh(selfIntersectingTriangles());
    expect(report.selfIntersections).toBe(true);
    expect(report.warnings.some((warning) => /self-intersections/.test(warning))).toBe(true);
  });
});
