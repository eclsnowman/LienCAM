import type { CutterSpec } from '../kernel/types';
import type { IrMove } from '../ir/types';
import type { ZDexelField } from '../stock';
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles';
import { replayMovesIntoStock, type ToolTipPosition } from './replayStock';

export interface TerraceRemovalMetrics {
  readonly changedColumns: number;
  readonly changedAreaMm2: number;
  readonly removedVolumeMm3: number;
  readonly finishTravelMm: number;
  readonly freshCrossSectionMm2: number;
}

export function measureTerraceRemoval(
  stock: ZDexelField,
  cutter: CutterSpec,
  moves: readonly IrMove[],
  initialTip: ToolTipPosition | null,
): TerraceRemovalMetrics {
  const after = stock.clone();
  replayMovesIntoStock(after, cutter, moves, initialTip);
  let changedColumns = 0;
  let removedVolumeMm3 = 0;
  for (let i = 0; i < stock.top.length; i++) {
    const removedHeight = Math.max(0, stock.top[i] - after.top[i]);
    if (removedHeight > 1e-9) changedColumns++;
    removedVolumeMm3 += removedHeight * stock.cell * stock.cell;
  }
  let finishTravelMm = 0;
  let prior = initialTip;
  for (const move of moves) {
    if (prior !== null) {
      const role = effectiveMoveRole({ type: move.t === 'rapid' ? 'rapid' : 'feed', role: move.role });
      if (isStockCuttingRole(role)) {
        finishTravelMm += Math.hypot(move.x - prior.x, move.y - prior.y, move.z - prior.z);
      }
    }
    prior = move;
  }
  return {
    changedColumns,
    changedAreaMm2: changedColumns * stock.cell * stock.cell,
    removedVolumeMm3,
    finishTravelMm,
    freshCrossSectionMm2: finishTravelMm > 1e-9 ? removedVolumeMm3 / finishTravelMm : 0,
  };
}

/**
 * A terrace is useful only when its fresh chip cross-section is wider than one
 * authored tolerance through the axial band it cleans. This is a physical mm2
 * criterion, not a column count or wall-angle guess, so refining the stock grid
 * does not silently change the cutoff.
 */
export function terraceRemovalIsProductive(
  metrics: TerraceRemovalMetrics,
  tolerance: number,
  axialBandMm: number,
): boolean {
  const minimumCrossSectionMm2 = Math.max(tolerance, 1e-4) * Math.max(axialBandMm, tolerance);
  return metrics.removedVolumeMm3 > 1e-9
    && metrics.finishTravelMm > 1e-9
    && metrics.freshCrossSectionMm2 + 1e-12 >= minimumCrossSectionMm2;
}
