// WO-200: stock proof is a completeness claim, not a distance tolerance.

import { describe, expect, it } from 'vitest';

import { stockBoxContainsPart } from '../../cam3d/integration/adaptive3dOperation';
import { buildPartHeightField } from '../../cam3d/rough';
import { mergeWorstIntrusion } from '../../cam3d/rough/traverseSafety';
import { fieldContradictsStockTop } from '../../cam3d/strategies/adaptiveRough';
import { ZDexelField, type Box3, type GridFrame } from '../../cam3d/stock';
import type {
  CutterHandle,
  GeometryKernel,
  MeshHandle,
  PartMesh,
} from '../../cam3d/kernel/types';

const FRAME = (nx: number): GridFrame => ({
  originX: 0,
  originY: 0,
  nx,
  ny: 1,
  cell: 1,
});

function partMeshWithBounds(
  min: [number, number, number],
  max: [number, number, number],
): PartMesh {
  return {
    positions: new Float32Array([...min, ...max, ...min]),
    indices: new Uint32Array([0, 1, 2]),
    bounds: { min, max },
    source: 'fixture',
  };
}

function box(minZ: number, maxZ: number): Box3 {
  return { minX: -20, minY: -20, minZ, maxX: 20, maxY: 20, maxZ };
}

function kernelReturning(tops: readonly number[]): GeometryKernel {
  return {
    makeCutter: () => 1 as unknown as CutterHandle,
    releaseCutter: () => {},
    dropGrid: async () => Float64Array.from(tops),
  } as unknown as GeometryKernel;
}

describe('WO-200 stock-box completeness fails closed', () => {
  it('refuses a box that misses any part material, even inside a distance tolerance', () => {
    const part = partMeshWithBounds([-10, -10, 0], [10, 10, 10.0000001]);
    expect(stockBoxContainsPart(box(0, 10), part)).toBe(false);

    const levelPart = partMeshWithBounds([-10, -10, 0], [10, 10, 5]);
    expect(stockBoxContainsPart({ ...box(0, 10), maxX: 10 - 1e-7 }, levelPart)).toBe(false);
  });

  it('keeps an exact block fixture and an oversize stock box proven', () => {
    const part = partMeshWithBounds([-10, -10, 0], [10, 10, 7.65]);
    expect(stockBoxContainsPart({
      minX: -10, minY: -10, minZ: 0, maxX: 10, maxY: 10, maxZ: 7.65,
    }, part)).toBe(true);
    expect(stockBoxContainsPart(box(-1, 12), part)).toBe(true);
  });
});

describe('WO-200 sampled-field completeness', () => {
  it('keeps the exact maximum drop sample as the field coverage witness', async () => {
    const field = await buildPartHeightField(
      kernelReturning([7.65, 10.0000001, 0.1, 1 / 3]),
      0 as unknown as MeshHandle,
      FRAME(4),
      { zSeed: -1 },
    );
    expect(field.coverageMaxTopZ).toBe(10.0000001);
    expect(field.coverageMaxTopZ).not.toBe(Math.fround(10.0000001));
  });

  it('refuses missing columns rather than treating partial coverage as empty', () => {
    expect(() => ZDexelField.fromColumnTops(FRAME(2), [5], -1))
      .toThrow(/tops has 1 entries, grid needs 2/);
  });

  it('lets any sampled part overhang contradict stock proof', () => {
    const overhang = ZDexelField.fromColumnTops(FRAME(2), [5, 10.0000001], -1);
    expect(fieldContradictsStockTop(overhang, 10)).toBe(true);

    const exact = ZDexelField.fromColumnTops(FRAME(2), [5, 7.65], -1);
    expect(fieldContradictsStockTop(exact, 7.65)).toBe(false);
  });
});

describe('WO-200 worst-intrusion proof witness', () => {
  it('keeps the witness paired with the maximum it describes', () => {
    let worst = mergeWorstIntrusion(
      { worstIntrusionMm: Number.NEGATIVE_INFINITY },
      { worstIntrusionMm: 6, worstWitness: 'six mm hit' },
    );
    worst = mergeWorstIntrusion(worst, { worstIntrusionMm: 1, worstWitness: 'one mm hit' });
    expect(worst).toEqual({ worstIntrusionMm: 6, worstWitness: 'six mm hit' });
  });

  it('clears an old witness when a newer maximum has no verified witness', () => {
    expect(mergeWorstIntrusion(
      { worstIntrusionMm: -5, worstWitness: 'stale' },
      { worstIntrusionMm: -1 },
    )).toEqual({ worstIntrusionMm: -1 });
  });
});
