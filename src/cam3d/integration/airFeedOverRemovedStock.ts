// WO-1641: a finish never FEEDS through material the earlier operations in its
// setup already removed.
//
// Operator ruling 2026-09-17: "why would a user ever disable rest Machining? Why would we
// give them an option to have it waste that cutting time? We already know it's
// removed." And 2026-09-17: "Rest is not an operation type. Rest is a
// methodology. It avoids having to air machine where material was already
// removed."
//
// Rest as a methodology, applied to whatever strategy the operator chose: a fed
// move whose swept cutter cannot touch the material the earlier operations left
// removes nothing, so it runs at rapid instead of at cutting feed. The move's
// endpoints are untouched - the path the tool travels is the same path, byte for
// byte, only faster - so this cannot change the shape of the cut, gouge, or move
// the tool anywhere it was not already going. It replaces no strategy: a
// Parallel, Scallop, Pencil, Steep-shallow or Waterline finish stays itself.
//
// Companion to WO-1620's link lowering (finishLinksOverRemovedStock.ts), which
// owns the same question for the LINKS between passes. Together they are the one
// shared answer every 3D finish asks, with no opt-in anywhere.

import type { ToolpathMove, Tool } from '../../types';
import type { StockState } from '../../lib/cam/stockState';
import { highestMaterialOver } from '../../lib/cam/smartHeights/earlierMaterial';
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles';
import { toolToCutterSpec } from './cutterSpec';

export interface AirFeedOverRemovedStockInput {
  /** The finish's moves, in the same frame as `remaining`. */
  moves: readonly ToolpathMove[];
  tool: Tool;
  /** What the earlier operations left of the stock block, same frame as the moves. */
  remaining: StockState;
}

export interface AirFeedOverRemovedStockResult {
  moves: ToolpathMove[];
  /** Fed moves that could remove material somewhere along their length, plus the ones that could not. */
  candidates: number;
  /** Of those, the ones the remaining material proved empty end to end. */
  rapided: number;
}

/**
 * The cutter's lowest point at `z` stands clear of everything the remaining
 * material holds under its footprint. Deliberately conservative twice over: the
 * footprint is the cutter's bounding SQUARE, and the field samples column
 * centres, so a real corner can stand half a cell diagonal closer than it reads.
 */
function clearsMaterialAt(
  remaining: StockState,
  x: number,
  y: number,
  z: number,
  radius: number,
  marginMm: number,
): boolean {
  const top = highestMaterialOver(remaining, {
    minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius,
  });
  // Outside the block entirely: nothing of this stock is under the tool.
  if (top === undefined) return true;
  return z >= top + marginMm;
}

export function rapidAirFeedsOverRemovedStock(
  input: AirFeedOverRemovedStockInput,
): AirFeedOverRemovedStockResult {
  const { moves, tool, remaining } = input;
  const out: ToolpathMove[] = [...moves];
  const cutter = toolToCutterSpec(tool);
  // A V-bit's flank is not described by a bounding square around its tip.
  if (cutter.kind === 'vbit') return { moves: out, candidates: 0, rapided: 0 };
  const radius = cutter.diameter / 2;
  const margin = remaining.resolutionMm * Math.SQRT1_2;
  const step = Math.max(remaining.resolutionMm / 2, 1e-3);

  let candidates = 0;
  let rapided = 0;
  let previous: ToolpathMove | undefined;
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index];
    const start = previous;
    previous = move;
    // 'feed' only: an arc's swept path is not the straight line between its
    // endpoints, and a rapid is already as fast as it goes.
    if (move.type !== 'feed') continue;
    if (!isStockCuttingRole(effectiveMoveRole({ type: 'feed', role: move.role }))) continue;
    candidates++;
    if (!start) continue;
    const dx = move.x - start.x, dy = move.y - start.y, dz = move.z - start.z;
    const length = Math.hypot(dx, dy, dz);
    const samples = Math.max(1, Math.ceil(length / step));
    let clear = true;
    for (let sample = 0; sample <= samples && clear; sample++) {
      const t = sample / samples;
      clear = clearsMaterialAt(
        remaining, start.x + dx * t, start.y + dy * t, start.z + dz * t, radius, margin,
      );
    }
    if (!clear) continue;
    out[index] = { type: 'rapid', x: move.x, y: move.y, z: move.z, role: 'rapid' };
    rapided++;
  }
  return { moves: out, candidates, rapided };
}
