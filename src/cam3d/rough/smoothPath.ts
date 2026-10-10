// cam3d rough: tolerance-bounded line/arc compression for the final Adaptive IR.
//
// Planning and stock replay intentionally retain the original dense polyline:
// that is the conservative material-accounting representation. This pass runs
// once after all levels are planned, replacing only constant-Z feed runs with
// lines/arcs that remain inside a fraction of the authored tolerance. The
// strategy's exact retained-model gate validates the resulting primitives
// continuously before they can be published.

import type { ToolpathMove } from '../../types';
import { collapsePolyline } from '../../lib/post/arcfit';
import type { IrMove, IrMoveRole } from '../ir/types';

export interface SmoothAdaptiveResult {
  moves: IrMove[];
  removedPoints: number;
  arcCount: number;
}

export function smoothAdaptiveIr(
  moves: readonly IrMove[],
  authoredTolerance: number,
): SmoothAdaptiveResult {
  if (moves.length < 3) return { moves: [...moves], removedPoints: 0, arcCount: 0 };
  const fitTolerance = Math.max(0.002, authoredTolerance * 0.25);

  const postMoves: ToolpathMove[] = [];
  let previous: IrMove | undefined;
  for (const move of moves) {
    if (move.t === 'arc') {
      if (!previous || move.i === undefined || move.j === undefined) {
        throw new Error('smoothAdaptiveIr: malformed source arc has no start or center offset.');
      }
      postMoves.push({
        type: move.cw ? 'arc_cw' : 'arc_ccw',
        x: move.x,
        y: move.y,
        z: move.z,
        cx: previous.x + move.i,
        cy: previous.y + move.j,
        feed: move.f,
        role: move.role,
      });
    } else {
      postMoves.push({
        type: move.t,
        x: move.x,
        y: move.y,
        z: move.z,
        feed: move.f,
        role: move.role,
      });
    }
    previous = move;
  }

  const collapsed = collapsePolyline(postMoves, {
    arcTolerance: fitTolerance,
    minArcRadius: 0.2,
    maxArcRadius: 100_000,
    minSweepDeg: 3,
  });

  const out: IrMove[] = [];
  let prior: IrMove | undefined;
  let arcCount = 0;
  for (const move of collapsed) {
    if (move.type === 'arc_cw' || move.type === 'arc_ccw') {
      if (!prior || move.cx === undefined || move.cy === undefined) {
        throw new Error('smoothAdaptiveIr: fitted arc has no start or absolute center.');
      }
      out.push({
        t: 'arc',
        x: move.x,
        y: move.y,
        z: move.z,
        i: move.cx - prior.x,
        j: move.cy - prior.y,
        cw: move.type === 'arc_cw',
        ...(move.feed !== undefined ? { f: move.feed } : {}),
        ...(move.role !== undefined ? { role: move.role as IrMoveRole } : {}),
      });
      arcCount++;
    } else {
      out.push({
        t: move.type,
        x: move.x,
        y: move.y,
        z: move.z,
        ...(move.feed !== undefined ? { f: move.feed } : {}),
        ...(move.role !== undefined ? { role: move.role as IrMoveRole } : {}),
      });
    }
    prior = out[out.length - 1];
  }

  return {
    moves: out,
    removedPoints: moves.length - out.length,
    arcCount,
  };
}
