import { describe, expect, it } from 'vitest';
import type { CutterSpec } from '../../cam3d/kernel/types';
import type { IrMove, IrMoveRole } from '../../cam3d/ir/types';
import { replayMovesIntoStock } from '../../cam3d/rough/replayStock';
import { removeSweep, ZDexelField, type Box3 } from '../../cam3d/stock';

const BOUNDS: Box3 = {
  minX: 0,
  minY: 0,
  minZ: 0,
  maxX: 12,
  maxY: 6,
  maxZ: 10,
};
const CUTTER: CutterSpec = { kind: 'flat', diameter: 2 };
const START = { x: 1, y: 3, z: 2 };

function freshStock(): ZDexelField {
  return ZDexelField.fromBox(BOUNDS, 0.5);
}

function changedColumns(stock: ZDexelField): number {
  return [...stock.top].filter((top) => top < BOUNDS.maxZ).length;
}

function move(role: IrMoveRole, x = 11): IrMove {
  return { t: role === 'rapid' ? 'rapid' : 'feed', x, y: 3, z: 2, role };
}

describe('Adaptive 3D planning-stock replay', () => {
  it.each(['rapid'] as const)(
    'does not remove stock for a %s crossing untouched material',
    (role) => {
      const legacyStock = freshStock();
      removeSweep(
        legacyStock,
        { x0: START.x, y0: START.y, z0: START.z, x1: 11, y1: 3, z1: 2 },
        CUTTER,
      );
      expect(changedColumns(legacyStock)).toBeGreaterThan(0);

      const replayStock = freshStock();
      const lastTip = replayMovesIntoStock(replayStock, CUTTER, [move(role)], START);
      expect(changedColumns(replayStock)).toBe(0);
      expect(lastTip).toEqual({ x: 11, y: 3, z: 2 });
    },
  );

  it.each(['cut', 'plunge', 'ramp', 'lead_in', 'lead_out', 'stepover', 'finish'] as const)(
    'removes stock for a %s destination role',
    (role) => {
      const stock = freshStock();
      replayMovesIntoStock(stock, CUTTER, [move(role)], START);
      expect(changedColumns(stock)).toBeGreaterThan(0);
    },
  );

  it('advances across a non-cut move before replaying the next cut', () => {
    const stock = freshStock();
    replayMovesIntoStock(stock, CUTTER, [move('rapid', 9), move('cut', 11)], START);
    expect(stock.top[6 * stock.nx + 10]).toBe(BOUNDS.maxZ);
    expect(stock.top[6 * stock.nx + 20]).toBeLessThan(BOUNDS.maxZ);
  });
});
