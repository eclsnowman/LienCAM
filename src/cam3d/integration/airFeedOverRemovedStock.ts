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

import type { OperationType, ToolpathMove, Tool } from '../../types';
import type { StockState } from '../../lib/cam/stockState';
import { highestMaterialOver } from '../../lib/cam/smartHeights/earlierMaterial';
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles';
import { toolToCutterSpec } from './cutterSpec';
import { floorHopAlong, resolveFloorHopMm } from '../../lib/cam/moves';
import { TRAVERSE_STANDOFF_MM } from '../pathbuild';

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
    /** WO-3136: only an earlier bigger FINISH leaves runs a later finish skips. Absent: never one. */
    operationType?: OperationType;
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
 *
 * WO-3136: `reach` asks a different question with the same certificate - did
 * the earlier sweeps already take this move's material to within the
 * allowance? The cutter is raised by the allowance, and the replay band is
 * dropped: that band is a rapid's collision envelope, and an unproved move here
 * only keeps cutting. Absent, every decision is exactly as before.
 */
function physicalRemovalProof(
  input: AirFeedOverRemovedStockInput,
  reach?: { intrusionAllowanceMm: number },
): (a: ToolpathMove, b: ToolpathMove) => boolean {
  const bounds = input.remaining.bounds;
  const binMm = reach ? 1 : 8, cellMm = 0.5;
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
  // Reach asks of every cutting move, not only the few the sampled field let
  // through: lowest sweeps first, so the scan can stop where none can lower the bound.
  const highest = (s: Sweep): number => Math.max(s.a.z, s.b.z);
  if (reach) for (const list of bins.values()) list.sort((p, q) => highest(p) - highest(q));
  const topOver = (rect: Rect): number => {
    const k = `${rect.minX},${rect.minY},${rect.maxX},${rect.maxY}`;
    const cached = cache.get(k);
    if (cached !== undefined) return cached;
    let top = bounds.maxZ;
    // Any sweep covering this rectangle also covers its centre, hence is in
    // the centre's bin. Checking other bins cannot improve this certificate.
    const cx = (rect.minX + rect.maxX) / 2, cy = (rect.minY + rect.maxY) / 2;
    const list = bins.get(key(Math.floor(cx / binMm), Math.floor(cy / binMm))) ?? [];
    for (const s of list) {
      if (reach) {
        // Exact skips: a profile is never negative, and the farthest corner is
        // never nearer the segment than the centre is.
        if (highest(s) + ROUND_OFF_MM >= top) break;
        if (distanceToLine(cx, cy, s.a, s.b) + s.deviation > s.cutter.diameter / 2 + ROUND_OFF_MM) continue;
      }
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
  const band = reach ? 0 : input.remaining.resolutionMm * Math.SQRT1_2;
  const allowance = reach ? reach.intrusionAllowanceMm : 0;
  const clears = (a: ToolpathMove, b: ToolpathMove, shape: RadialCutter, offset: number): boolean => {
    const r = shape.diameter / 2 + band;
    const low = Math.min(a.z, b.z) + offset - band + allowance;
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

/** The fed move from `start` removes nothing: the sampled field lets it through and the physical proof certifies it. */
function airFeedProof(input: AirFeedOverRemovedStockInput, radius: number): (start: ToolpathMove, move: ToolpathMove) => boolean {
  const { remaining } = input;
  const margin = remaining.resolutionMm * Math.SQRT1_2;
  const step = Math.max(remaining.resolutionMm / 2, 1e-3);
  const physical = physicalRemovalProof(input);
  return (start, move) => {
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
    return clear && physical(start, move);
  };
}

export function rapidAirFeedsOverRemovedStock(
  input: AirFeedOverRemovedStockInput,
): AirFeedOverRemovedStockResult {
  const { moves, tool } = input;
  const out: ToolpathMove[] = [...moves];
  const cutter = toolToCutterSpec(tool);
  // A V-bit's flank is not described by a bounding square around its tip.
  if (cutter.kind === 'vbit') return { moves: out, candidates: 0, rapided: 0 };
  const air = airFeedProof(input, cutter.diameter / 2);

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
    if (!start || !air(start, move)) continue;
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

export interface ReachedFinishRunsInput extends AirFeedOverRemovedStockInput {
  /** The finish's own tolerance: material the earlier sweeps left thinner than this is finished. */
  toleranceMm: number;
  /** The finish's resolved Clearance plane. */
  clearanceZ: number;
  /** Feed of the plunge that re-enters a kept run. */
  plungeFeed: number;
}

export interface ReachedFinishRunsResult {
  moves: ToolpathMove[];
  /** Cutting moves checked. */
  candidates: number;
  /** Moves left out: cutting runs the earlier sweeps reached, with the entry that led only into one. */
  dropped: number;
}

const LIFT_EPS_MM = 1e-6;
const isCutting = (move: ToolpathMove): boolean => move.type === 'feed' && effectiveMoveRole(move) === 'cut';
const isEntry = (move: ToolpathMove): boolean => move.type === 'feed' && (move.role === 'plunge' || move.role === 'lead_in');
/** The 3D finishes the store routes through this seam; adaptive_3d is a rough. */
const FINISH_3D_TYPES: ReadonlySet<OperationType> = new Set<OperationType>(
  ['parallel_3d', 'scallop_3d', 'steep_shallow_3d', 'pencil_3d', 'waterline_3d']);

/**
 * WO-3136 (owner D5, 2026-10-28 "Build it as described"): a smaller 3D finish
 * skips surface a BIGGER finish already cut to tolerance, so it only cuts what
 * the big tool could not reach. After a rough that left stock-to-leave, it
 * still cuts everything: that allowance is real material. Only an earlier
 * enabled, generated 3D finish whose tool is strictly bigger counts; a rough
 * (even one cut to size) or a same-size or smaller finish never drops a run,
 * and still feeds the link lowering and air feeds exactly as before.
 *
 * Modelled on skipAirOnlyPasses (src/lib/cam/restAir2d.ts). A run of this
 * finish's cutting moves is dropped whole when every move in it is proven, by
 * physicalRemovalProof's continuous certificate over the earlier sweeps, to
 * meet no material thicker than the finish's tolerance, and the run is at
 * least one tool diameter long. A move that meets no material at all is not
 * this function's: it stays, and the air feed proof makes it a rapid.
 *
 * Between the kept runs the tool lifts straight up, crosses above the stock
 * and plunges back in, in the shape the finish's own links take, so
 * lowerFinishLinksOverRemovedStock then lowers them like any other. The kept
 * moves are the finish's own, byte for byte, in order.
 */
export function dropFinishRunsEarlierSweepsReached(input: ReachedFinishRunsInput): ReachedFinishRunsResult {
  const { moves, tool, remaining, toleranceMm, clearanceZ, plungeFeed } = input;
  const unchanged: ReachedFinishRunsResult = { moves: [...moves], candidates: 0, dropped: 0 };
  if (!(toleranceMm > 0) || !(plungeFeed > 0) || !Number.isFinite(clearanceZ)) return unchanged;
  const biggerFinishes = (input.preceding ?? []).filter(p => p.enabled && p.status === 'ready'
    && p.toolpathMoves?.length && p.operationType !== undefined && FINISH_3D_TYPES.has(p.operationType)
    && p.tool !== undefined && p.tool.diameter > tool.diameter + ROUND_OFF_MM);
  if (biggerFinishes.length === 0) return unchanged;
  const cutter = toolToCutterSpec(tool);
  if (cutter.kind === 'vbit') return unchanged;
  // The finish's own low link plane over the stock (WO-2210), else its Clearance:
  // the two planes lowerFinishLinksOverRemovedStock recognises.
  const lowPlaneZ = remaining.bounds.maxZ + TRAVERSE_STANDOFF_MM;
  const usesLowPlane = lowPlaneZ < clearanceZ
    && moves.some(m => m.type === 'rapid' && Math.abs(m.z - lowPlaneZ) <= 1e-3);
  const liftZ = usesLowPlane ? lowPlaneZ : clearanceZ;
  if (!(liftZ > remaining.bounds.maxZ)) return unchanged;

  const proof = physicalRemovalProof({ ...input, preceding: biggerFinishes }, { intrusionAllowanceMm: toleranceMm });
  // A move with nothing at all to cut stays: rapidAirFeedsOverRemovedStock runs it at rapid (WO-1641, WO-2835).
  const air = airFeedProof(input, cutter.diameter / 2);
  let candidates = 0;
  const reached = new Array<boolean>(moves.length).fill(false);
  for (let index = 1; index < moves.length; index++) {
    if (!isCutting(moves[index])) continue;
    candidates++;
    reached[index] = proof(moves[index - 1], moves[index]) && !air(moves[index - 1], moves[index]);
  }

  const dropEndAt = new Map<number, number>();
  let dropped = 0;
  for (let first = 1; first < moves.length; first++) {
    if (!reached[first]) continue;
    let last = first;
    let length = 0;
    for (;; last++) {
      const from = moves[last - 1], to = moves[last];
      length += Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
      if (last + 1 >= moves.length || !reached[last + 1]) break;
    }
    if (length >= cutter.diameter) {
      // The entry that leads only into this run goes with it, when it is proven too.
      let start = first;
      let entry = first - 1;
      while (entry > 0 && isEntry(moves[entry])) entry--;
      if (entry < first - 1 && moves[entry].type === 'rapid') {
        let proven = true;
        for (let at = entry + 1; at < first && proven; at++) proven = proof(moves[at - 1], moves[at]);
        if (proven) start = entry + 1;
      }
      dropEndAt.set(start, last);
      dropped += last - start + 1;
    }
    first = last;
  }
  if (dropEndAt.size === 0) return { ...unchanged, candidates };

  const out: ToolpathMove[] = [];
  const rapidTo = (x: number, y: number, z: number): ToolpathMove => ({ type: 'rapid', x, y, z, role: 'rapid' });
  for (let index = 0; index < moves.length; index++) {
    const end = dropEndAt.get(index);
    if (end === undefined) {
      out.push(moves[index]);
      continue;
    }
    const from = out[out.length - 1];
    const last = moves[end];
    const next = moves[end + 1];
    // Straight up from where the tool stands: the material under it is a height field.
    if (from.z < liftZ - LIFT_EPS_MM) out.push(rapidTo(from.x, from.y, liftZ));
    if (next === undefined || (next.type === 'rapid' && next.z >= liftZ - LIFT_EPS_MM)) {
      index = end;
      continue;
    }
    // A horizontal rapid that only crossed to the dropped entry is crossed again, to the run's end.
    const tail = out[out.length - 1], before = out[out.length - 2];
    if (tail.type === 'rapid' && tail.z >= liftZ - LIFT_EPS_MM && before !== undefined
      && before.z >= liftZ - LIFT_EPS_MM) out.pop();
    out.push(rapidTo(last.x, last.y, liftZ));
    // Over the run's last point, where the next kept move starts: a lower rapid
    // after it leaves from here, a fed move is reached by plunge.
    if (next.type !== 'rapid') out.push({ type: 'feed', x: last.x, y: last.y, z: last.z, feed: plungeFeed, role: 'plunge' });
    index = end;
  }
  return { moves: out, candidates, dropped };
}
