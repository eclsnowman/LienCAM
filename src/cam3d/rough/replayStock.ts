import type { CutterSpec } from '../kernel/types';
import type { IrMove } from '../ir/types';
import type { ToolpathMove } from '../../types';
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles';
import { removeSweep, type LinearMove, type ZDexelField } from '../stock';

export type ToolTipPosition = {
  x: number;
  y: number;
  z: number;
};

/**
 * Walk one IR move as the LINEAR sweeps a stock replay can consume. A line is
 * one sweep. An ARC move (i/j = centre offset from the start, cw) is walked
 * along the arc as chords whose sagitta stays <= maxSagitta: replaying an arc
 * as its single chord carves the field where the machine never goes (a
 * quarter-circle corner arc of radius R + finish stock passes up to
 * r(1 - cos 45 deg) = 0.29 r closer to the corner than the cutter does -
 * 0.41 mm on the C2 slab corner, WO-402c / WO-407).
 */
export function forEachLinearSweep(
  from: ToolTipPosition,
  move: IrMove,
  maxSagitta: number,
  visit: (sweep: LinearMove) => void,
): void {
  const isArc = move.t === 'arc' && move.i !== undefined && move.j !== undefined;
  if (!isArc) {
    visit({ x0: from.x, y0: from.y, z0: from.z, x1: move.x, y1: move.y, z1: move.z });
    return;
  }
  const cx = from.x + move.i!;
  const cy = from.y + move.j!;
  const r = Math.hypot(from.x - cx, from.y - cy);
  const a0 = Math.atan2(from.y - cy, from.x - cx);
  let sweepAngle = Math.atan2(move.y - cy, move.x - cx) - a0;
  if (move.cw) {
    while (sweepAngle >= 0) sweepAngle -= 2 * Math.PI;
  } else {
    while (sweepAngle <= 0) sweepAngle += 2 * Math.PI;
  }
  const sagitta = Math.max(maxSagitta, 1e-4);
  const chord = r > sagitta ? 2 * Math.sqrt(2 * r * sagitta - sagitta * sagitta) : Number.POSITIVE_INFINITY;
  const steps = Math.max(1, Math.ceil((Math.abs(sweepAngle) * r) / chord));
  let px = from.x;
  let py = from.y;
  let pz = from.z;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const x = k === steps ? move.x : cx + r * Math.cos(a0 + sweepAngle * t);
    const y = k === steps ? move.y : cy + r * Math.sin(a0 + sweepAngle * t);
    const z = from.z + (move.z - from.z) * t;
    visit({ x0: px, y0: py, z0: pz, x1: x, y1: y, z1: z });
    px = x;
    py = y;
    pz = z;
  }
}

/**
 * Walk the app's persisted toolpath representation as worker-ready linear
 * sweeps. Persisted arcs carry an absolute centre (cx/cy), whereas IR arcs
 * carry a centre offset (i/j); keeping this conversion beside the IR replay
 * prevents rest machining from degrading real predecessor arcs to chords.
 * Every move advances the cursor, but only stock-cutting roles are emitted.
 */
export function toolpathMovesToLinearSweeps(
  moves: readonly ToolpathMove[],
  maxSagitta: number,
): LinearMove[] {
  const sweeps: LinearMove[] = [];
  let tip: ToolTipPosition | undefined;
  for (const move of moves) {
    const role = effectiveMoveRole(move);
    if (tip !== undefined && isStockCuttingRole(role)) {
      const isArc = move.type === 'arc_cw' || move.type === 'arc_ccw';
      if (isArc) {
        if (move.cx === undefined || move.cy === undefined) {
          throw new Error('stock replay: arc move is missing its absolute cx/cy centre.');
        }
        forEachLinearSweep(tip, {
          t: 'arc', x: move.x, y: move.y, z: move.z,
          i: move.cx - tip.x, j: move.cy - tip.y,
          cw: move.type === 'arc_cw',
        }, maxSagitta, sweep => sweeps.push(sweep));
      } else {
        sweeps.push({
          x0: tip.x, y0: tip.y, z0: tip.z,
          x1: move.x, y1: move.y, z1: move.z,
        });
      }
    }
    tip = { x: move.x, y: move.y, z: move.z };
  }
  return sweeps;
}

/** Sagitta bound for arc replay into a field of this cell size: a quarter cell. */
export function replaySagittaFor(stock: ZDexelField): number {
  return stock.cell / 4;
}

/**
 * Replay emitted IR into the planning stock used by lower roughing levels.
 * Every move advances the cursor, but only real cutting roles remove stock.
 * Arcs are walked along the arc (forEachLinearSweep), never as one chord.
 */
export function replayMovesIntoStock(
  stock: ZDexelField,
  cutter: CutterSpec,
  moves: readonly IrMove[],
  initialTip: ToolTipPosition | null,
): ToolTipPosition | null {
  let lastTip = initialTip;
  const sagitta = replaySagittaFor(stock);

  for (const move of moves) {
    const role = effectiveMoveRole({
      type: move.t === 'rapid' ? 'rapid' : 'feed',
      role: move.role,
    });
    if (lastTip !== null && Number.isFinite(lastTip.x) && isStockCuttingRole(role)) {
      forEachLinearSweep(lastTip, move, sagitta, (sweep) => removeSweep(stock, sweep, cutter));
    }

    lastTip = { x: move.x, y: move.y, z: move.z };
  }

  return lastTip;
}
