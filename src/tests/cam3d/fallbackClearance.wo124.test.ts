import { describe, expect, it, vi } from 'vitest';

import {
  computeAdaptive3dMoves,
  DEFAULT_ADAPTIVE3D_PARAMS,
  resolveAdaptive3dTraversePlanes,
} from '../../cam3d/integration/adaptive3dOperation';
import type { PartMesh } from '../../cam3d/kernel/types';
import { LOW_TRAVEL_HEADROOM_MM, enforceTraverseSafety } from '../../cam3d/rough/traverseSafety';
import { removeSweep, ZDexelField, type Box3 } from '../../cam3d/stock';
import type { Cam3dClient } from '../../cam3d/worker/client';
import type { CutterSpec } from '../../cam3d/kernel/types';
import { makeTool } from '../post/helpers';

const CUTTER: CutterSpec = { kind: 'flat', diameter: 4 };
const FALLBACK_BOX: Box3 = {
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 40,
  maxY: 40,
  maxZ: 14,
};
const TRUE_STOCK: Box3 = { ...FALLBACK_BOX, maxZ: 15 };
const PART_MESH: PartMesh = {
  positions: new Float32Array([0, 0, 0, 40, 0, 0, 0, 40, 14]),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: [0, 0, 0], max: [40, 40, 14] },
  source: 'fixture',
};

function roleOnlyClient(generateAdaptiveRough: ReturnType<typeof vi.fn>): Cam3dClient {
  return { generateAdaptiveRough } as unknown as Cam3dClient;
}

describe('WO-124 fallback clearance requires a proven material top', () => {
  it('fails loud instead of rapid-traversing at z=14.5 under real stock at z=15', () => {
    expect(() =>
      resolveAdaptive3dTraversePlanes({
        resolvedHeights: {
          clearanceZ: 12,
          retractZ: 10,
          feedZ: 10,
        },
        stockTopZ: FALLBACK_BOX.maxZ,
        partTopZ: 14,
        materialTopZ: undefined,
      }),
    ).toThrow(
      /can't tell which block of stock the part is cutting in/,
    );
  });

  it('rejects an unproven fallback box at the production adapter boundary', async () => {
    const generateAdaptiveRough = vi.fn(async () => ({
      ir: {
        moves: [{ t: 'rapid' as const, x: 35, y: 20, z: 14.5, role: 'rapid' as const }],
        meta: {
          strategyId: 'adaptive_rough',
          cutterId: 'wo124-tool',
          params: { floorZ: 0 },
        },
      },
    }));

    await expect(
      computeAdaptive3dMoves({
        partMesh: PART_MESH,
        tool: makeTool({ diameter: CUTTER.diameter }),
        params: { ...DEFAULT_ADAPTIVE3D_PARAMS, cellSize: 1 },
        stockBounds: FALLBACK_BOX,
        resolvedHeights: {
          clearanceZ: 12,
          retractZ: 10,
          feedZ: 10,
          topZ: 14,
          bottomZ: 0,
        },
        client: roleOnlyClient(generateAdaptiveRough),
      }),
    ).rejects.toThrow(
      /can't tell which block of stock the part is cutting in/,
    );
    expect(generateAdaptiveRough).not.toHaveBeenCalled();
  });

  it('does not infer real-stock provenance from an unproven taller box', async () => {
    const generateAdaptiveRough = vi.fn();

    await expect(
      computeAdaptive3dMoves({
        partMesh: PART_MESH,
        tool: makeTool({ diameter: CUTTER.diameter }),
        params: { ...DEFAULT_ADAPTIVE3D_PARAMS, cellSize: 1 },
        stockBounds: TRUE_STOCK,
        resolvedHeights: {
          clearanceZ: 16,
          retractZ: 15.5,
          feedZ: 15.5,
          topZ: 14,
          bottomZ: 0,
        },
        client: roleOnlyClient(generateAdaptiveRough),
      }),
    ).rejects.toThrow(
      /can't tell which block of stock the part is cutting in/,
    );
    expect(generateAdaptiveRough).not.toHaveBeenCalled();
  });

  it('preserves a low Stay Down link when real stock proves the material top and corridor', () => {
    const planes = resolveAdaptive3dTraversePlanes({
      resolvedHeights: {
        clearanceZ: 20,
        retractZ: 18,
        feedZ: 16,
      },
      stockTopZ: TRUE_STOCK.maxZ,
      partTopZ: 14,
      materialTopZ: TRUE_STOCK.maxZ,
    });
    expect(planes.materialTopZ).toBe(15);
    expect(planes.clearanceZ).toBe(20);

    const stock = ZDexelField.fromBox(TRUE_STOCK, 0.5);
    removeSweep(
      stock,
      { x0: 2, y0: 20, z0: 4, x1: 38, y1: 20, z1: 4 },
      CUTTER,
    );
    // WO-1270: the link travels the corridor with LOW_TRAVEL_HEADROOM_MM of air over
    // the floor it cut (was: at the floor itself). Still far below clearance (20).
    const travelZ = 4 + LOW_TRAVEL_HEADROOM_MM;
    const lowLink = [{ t: 'rapid', x: 35, y: 20, z: travelZ, role: 'rapid' }] as const;
    const guarded = enforceTraverseSafety(lowLink, {
      stock,
      cutter: CUTTER,
      clearanceZ: planes.clearanceZ,
      materialTopZ: planes.materialTopZ,
      stockProven: true,
      initialTip: { x: 5, y: 20, z: travelZ },
    });

    expect(guarded.moves).toEqual(lowLink);
    expect(guarded.moves.every((move) => move.z < planes.clearanceZ)).toBe(true);
    expect(guarded.report.checked).toBe(1);
    expect(guarded.report.rerouted).toBe(0);
    expect(guarded.report.liftedForHeadroom).toBe(0);
  });

  it('rejects a fallback plane that is not strictly above the proven top', () => {
    expect(() =>
      enforceTraverseSafety([], {
        stock: ZDexelField.fromBox(TRUE_STOCK, 0.5),
        cutter: CUTTER,
        clearanceZ: 15,
        materialTopZ: 15,
        stockProven: true,
        initialTip: null,
      }),
    ).toThrow(/clearanceZ 15 must be strictly above proven material top 15/);
  });
});
