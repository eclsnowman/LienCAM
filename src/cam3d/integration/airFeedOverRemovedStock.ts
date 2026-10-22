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
import { floorHopAlong, resolveFloorHopMm } from '../../lib/cam/moves';

export interface AirFeedOverRemovedStockInput {
  /** The finish's moves, in the same frame as `remaining`. */
  moves: readonly ToolpathMove[];
  tool: Tool;
  /** What the earlier operations left of the stock block, same frame as the moves. */
  remaining: StockState;
  /** Already-built histories in exactly the moves/stock frame. Sampled topZ
   * alone loses intra-cell stock (WO-2835 round 8); it is never a certificate. */
  preceding?: readonly {
    enabled: boolean;
    status: string;
    tool: Tool | undefined;
    toolpathMoves: readonly ToolpathMove[] | undefined;
  }[];
  /** WO-2835: the floor-hop height over a level run of air feeds made rapid. Absent: the
   *  0.3 mm default (the 3D store call carries no linking yet); 0: the rapids stay level. */
  floorHopMm?: number;
}

export interface AirFeedOverRemovedStockResult {
  moves: ToolpathMove[];
  /** Fed moves that could remove material somewhere along their length, plus the ones that could not. */
  candidates: number;
  /** Of those, the ones the remaining material proved empty end to end. */
  rapided: number;
}

/**
 * Cheap sampled-field rejection only. A square footprint and a Z allowance
 * cannot restore stock lost between column centres; physicalRemovalProof must
 * independently certify the continuous cutter/shank before any conversion.
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

type RadialCutter = Exclude<ReturnType<typeof toolToCutterSpec>, { kind: 'vbit' }>;
type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type Sweep = { a: ToolpathMove; b: ToolpathMove; cutter: RadialCutter; deviation: number };
const ROUND_OFF_MM = 1e-9; // Shrinks certified removal; never forgives intersection.

function profile(cutter: RadialCutter, distance: number): number {
  const r = cutter.diameter / 2;
  if (distance > r) return Infinity;
  if (cutter.kind === 'flat') return 0;
  const corner = cutter.kind === 'ball' ? r : cutter.cornerRadius;
  const d = Math.max(0, distance - (r - corner));
  return corner - Math.sqrt(Math.max(0, corner * corner - d * d));
}

function distanceToLine(x: number, y: number, a: ToolpathMove, b: ToolpathMove): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0;
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
}

/**
 * WO-2835: a continuous proof, independent of the centre-sampled stock replay.
 * For each XY rectangle, bound remaining stock ABOVE by removal that covers
 * its ENTIRE area, and bound the query underside BELOW on its ENTIRE segment.
 * A prior swept disc/capsule is convex: its farthest rectangle point is a
 * corner. Max endpoint Z bounds a sloping cutter's underside from above.
 * Arc chords use the arc sagitta as an inward removal allowance, not removal
 * on the chord itself. Finite flutes must span the original stock top; other
 * sweeps contribute nothing. No current/future finish move is replayed.
 *
 * Bins and memoized rectangle bounds are shared by every candidate of this
 * operation. Subdivision improves completeness only: at the finite limit an
 * unproved region retains feed. No grid centre is treated as a solid cell.
 */
function physicalRemovalProof(input: AirFeedOverRemovedStockInput): (a: ToolpathMove, b: ToolpathMove) => boolean {
  const bounds = input.remaining.bounds;
  const binMm = 8, cellMm = 0.5;
  const bins = new Map<string, Sweep[]>();
  const cache = new Map<string, number>();
  const key = (i: number, j: number): string => `${i},${j}`;
  const add = (sweep: Sweep): void => {
    const r = sweep.cutter.diameter / 2;
    const x0 = Math.max(bounds.minX, Math.min(sweep.a.x, sweep.b.x) - r);
    const x1 = Math.min(bounds.maxX, Math.max(sweep.a.x, sweep.b.x) + r);
    const y0 = Math.max(bounds.minY, Math.min(sweep.a.y, sweep.b.y) - r);
    const y1 = Math.min(bounds.maxY, Math.max(sweep.a.y, sweep.b.y) + r);
    for (let j = Math.floor(y0 / binMm); j <= Math.floor(y1 / binMm); j++) {
      for (let i = Math.floor(x0 / binMm); i <= Math.floor(x1 / binMm); i++) {
        const k = key(i, j);
        const bucket = bins.get(k);
        if (bucket) bucket.push(sweep);
        else bins.set(k, [sweep]);
      }
    }
  };
  for (const operation of input.preceding ?? []) {
    if (!operation.enabled || operation.status !== 'ready' || !operation.tool || !operation.toolpathMoves) continue;
    const tool = operation.tool;
    let cutter;
    try { cutter = toolToCutterSpec(tool); } catch { continue; }
    if (cutter.kind === 'vbit' || !Number.isFinite(tool.fluteLength) || tool.fluteLength <= 0) continue;
    const moves = operation.toolpathMoves;
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], b = moves[i];
      if (![a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite)) continue;
      // Only intentional physical cutting sweeps contribute. Omitting an
      // earlier rapid/unsupported sweep leaves extra stock, never less stock.
      if (b.type === 'rapid') continue;
      if (Math.min(a.z, b.z) + tool.fluteLength < bounds.maxZ + ROUND_OFF_MM) continue;
      if (b.type === 'feed') { add({ a, b, cutter, deviation: ROUND_OFF_MM }); continue; }
      if (!Number.isFinite(b.cx) || !Number.isFinite(b.cy)) continue;
      const cx = b.cx!, cy = b.cy!, r = Math.hypot(a.x - cx, a.y - cy);
      // Non-circular/inconsistent arcs have no certified interpretation here.
      if (!(r > 0) || Math.abs(r - Math.hypot(b.x - cx, b.y - cy)) > ROUND_OFF_MM) continue;
      const sign = b.type === 'arc_ccw' ? 1 : -1;
      const angle = Math.atan2(a.y - cy, a.x - cx);
      let sweep = sign * (Math.atan2(b.y - cy, b.x - cx) - angle);
      while (sweep <= 0) sweep += 2 * Math.PI;
      const count = Math.max(1, Math.ceil(sweep / (Math.PI / 16)), Math.ceil(r * sweep / cellMm));
      if (count > 4096) continue;
      const deviation = r * (1 - Math.cos(sweep / count / 2)) + 2 * ROUND_OFF_MM;
      let from = a;
      for (let n = 1; n <= count; n++) {
        const t = n / count, theta = angle + sign * sweep * t;
        const to = n === count ? b : { ...b, x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta), z: a.z + (b.z - a.z) * t };
        add({ a: from, b: to, cutter, deviation });
        from = to;
      }
    }
  }
  const topOver = (rect: Rect): number => {
    const k = `${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`;
    const cached = cache.get(k);
    if (cached !== undefined) return cached;
    let top = bounds.maxZ;
    // Any sweep covering this rectangle also covers its centre, hence is in
    // the centre's bin. Checking other bins cannot improve this certificate.
    const list = bins.get(key(Math.floor((rect.minX + rect.maxX) / 2 / binMm), Math.floor((rect.minY + rect.maxY) / 2 / binMm))) ?? [];
    for (const s of list) {
      const d = Math.max(
        distanceToLine(rect.minX, rect.minY, s.a, s.b), distanceToLine(rect.maxX, rect.minY, s.a, s.b),
        distanceToLine(rect.minX, rect.maxY, s.a, s.b), distanceToLine(rect.maxX, rect.maxY, s.a, s.b),
      ) + s.deviation;
      top = Math.min(top, Math.max(s.a.z, s.b.z) + profile(s.cutter, d) + ROUND_OFF_MM);
    }
    top = Math.max(bounds.minZ, top);
    cache.set(k, top);
    return top;
  };
  const cutter = toolToCutterSpec(input.tool);
  if (cutter.kind === 'vbit' || !Number.isFinite(input.tool.fluteLength) || input.tool.fluteLength <= 0
    || !Number.isFinite(input.tool.shankDiameter) || input.tool.shankDiameter <= 0) return () => false;
  // Preserve the old uncertainty magnitude, now as a geometric envelope in
  // both XY and Z. It encloses the existing 0.1 mm desk corner model at 0.2 mm
  // replay resolution; this is no claim about a board's actual trajectory.
  const band = input.remaining.resolutionMm * Math.SQRT1_2;
  const clears = (a: ToolpathMove, b: ToolpathMove, shape: RadialCutter, offset: number): boolean => {
    const r = shape.diameter / 2 + band;
    const low = Math.min(a.z, b.z) + offset - band;
    if (low > bounds.maxZ + ROUND_OFF_MM) return true;
    const visit = (rect: Rect, depth: number): boolean => {
      const x = (rect.minX + rect.maxX) / 2, y = (rect.minY + rect.maxY) / 2;
      const half = Math.hypot(rect.maxX - rect.minX, rect.maxY - rect.minY) / 2;
      const near = Math.max(0, distanceToLine(x, y, a, b) - half - band - ROUND_OFF_MM);
      if (near > shape.diameter / 2) return true;
      const top = topOver(rect);
      if (top <= bounds.minZ || low + profile(shape, near) > top + ROUND_OFF_MM) return true;
      if (depth === 4) return false;
      return visit({ ...rect, maxX: x, maxY: y }, depth + 1)
        && visit({ ...rect, minX: x, maxY: y }, depth + 1)
        && visit({ ...rect, maxX: x, minY: y }, depth + 1)
        && visit({ ...rect, minX: x, minY: y }, depth + 1);
    };
    const minX = Math.max(bounds.minX, Math.min(a.x, b.x) - r);
    const maxX = Math.min(bounds.maxX, Math.max(a.x, b.x) + r);
    const minY = Math.max(bounds.minY, Math.min(a.y, b.y) - r);
    const maxY = Math.min(bounds.maxY, Math.max(a.y, b.y) + r);
    for (let y = Math.floor(minY / cellMm) * cellMm; y < maxY; y += cellMm) {
      for (let x = Math.floor(minX / cellMm) * cellMm; x < maxX; x += cellMm) {
        // Fixed stock-clipped cells keep bounds reusable across candidates.
        // Extending a boundary cell past the query only makes proof stricter.
        if (!visit({ minX: Math.max(x, bounds.minX), minY: Math.max(y, bounds.minY),
          maxX: Math.min(x + cellMm, bounds.maxX), maxY: Math.min(y + cellMm, bounds.maxY) }, 0)) return false;
      }
    }
    return true;
  };
  return (a, b) => clears(a, b, cutter, 0) && clears(a, b,
    { kind: 'flat', diameter: input.tool.shankDiameter }, input.tool.fluteLength);
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
  const physical = physicalRemovalProof(input);

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
    if (!clear || !physical(start, move)) continue;
    out[index] = { type: 'rapid', x: move.x, y: move.y, z: move.z, role: 'rapid' };
    rapided++;
  }
  const hop = resolveFloorHopMm({ floorHopMm: input.floorHopMm });
  return { moves: hop > 0 && rapided > 0 ? hopLevelAirRuns(moves, out, hop) : out, candidates, rapided };
}

/**
 * WO-2835 (the operator 10-15: rapids over cleared floors hop, "3d move zup x/y move zdown"): a run of
 * consecutive air feeds made rapid at one depth no longer rides the floor the earlier
 * operations left. It hops along its own path with the shared blended hop (rise while moving,
 * hold, descend while moving) and lands where the run ended, where the next move starts.
 * Every point of the run was proven clear at the run's depth, and the remaining material is a
 * height field, so everything above it is clear too. The hop never rises above the highest
 * point the program already reaches (its clearance plane).
 */
function hopLevelAirRuns(source: readonly ToolpathMove[], rapidedMoves: ToolpathMove[], hop: number): ToolpathMove[] {
  let ceiling = -Infinity;
  for (const move of source) ceiling = Math.max(ceiling, move.z);
  const out: ToolpathMove[] = [];
  let index = 0;
  while (index < rapidedMoves.length) {
    const start = out[out.length - 1];
    const level = (at: number): boolean => rapidedMoves[at].type === 'rapid' && source[at].type === 'feed'
      && start !== undefined && Math.abs(rapidedMoves[at].z - start.z) <= 1e-9;
    if (!level(index)) {
      out.push(rapidedMoves[index++]);
      continue;
    }
    let end = index;
    while (end + 1 < rapidedMoves.length && level(end + 1)) end++;
    const height = Math.min(hop, Math.max(0, ceiling - start.z));
    const path = [start, ...rapidedMoves.slice(index, end + 1)];
    if (height > 0) floorHopAlong(out, path, start.z, height, true);
    else out.push(...rapidedMoves.slice(index, end + 1));
    index = end + 1;
  }
  return out;
}
