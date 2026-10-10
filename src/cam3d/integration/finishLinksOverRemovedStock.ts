// WO-1620 (Smart Heights finding SH-6): a 3D finish after a rough keeps its
// links low over material the earlier operations already removed.
//
// Operator ruling 2026-09-16: "I certainly don't want to crash tooling, but I also don't
// want to waste cycle time avoiding stock which is no longer present. Retracts
// based on collision knowledge of the stock aware state is important to optimize
// cycletimes."
//
// A finish plans every link it cannot stay down on as lift to the traverse
// plane, across, and back down to Feed Height - it is never told what came
// before it. This module is told. Each such link is offered as one low rapid
// from the pass end straight to the point the next entry starts from, and the
// whole finish is then run through the SAME proof WO-096 roughing uses
// (enforceTraverseSafety) against the in-process stock the earlier operations
// left: a corridor the stock proves empty stays low (with the WO-1270 headroom),
// anything it cannot prove is routed back over the plane exactly as before. The
// finish's own cutting moves are replayed as it goes, so each link sees the
// material the finish itself has taken as well. A link runs beside the finished
// surface, so the proof widens the cutter by half a stock cell's diagonal: the
// field samples column centres and a real corner can stand that much closer.
//
// Nothing else changes: the Retract, Clearance and Feed heights, the entry ramp
// and the cutting moves are the finish's own. Without a remaining-stock state
// (no earlier operation cut anything) the moves come back untouched.
//
// WO-2210 (low re-entry). The builder now lifts a link only to the proven stock
// top + standoff when it knows that top, so a link is a lift to Clearance OR to
// that plane, with the descent optional (the builder drops it when the entry
// starts at the link's own height). And the rapid no longer stops at the top of
// the entry ramp: it goes to the LOWEST point of the entry the remaining stock
// proves has the standoff of air under the cutter - a vertex of the ramp (the
// ramp then goes on from there, so the pass is still cut from its first sample),
// or, for a straight plunge, the plunge line. What the stock cannot prove keeps
// the entry exactly as the builder made it.

import type { ToolpathMove, Tool } from '../../types';
import type { IrMove } from '../ir/types';
import type { StockState } from '../../lib/cam/stockState';
import { buildSolidColumns, type ClearanceMesh, type SolidColumns } from '../../lib/cam/holderClearance';
import { ZDexelField } from '../stock';
import { enforceTraverseSafety, LOW_TRAVEL_HEADROOM_MM } from '../rough/traverseSafety';
import { TRAVERSE_STANDOFF_MM } from '../pathbuild';
import { highestMaterialOver } from '../../lib/cam/smartHeights/earlierMaterial';
import { toolToCutterSpec } from './cutterSpec';

const EPS = 1e-6;
/**
 * WO-2210: how close a lift must come to the stock top + standoff to be the builder's low link plane, mm.
 * The builder floors it on the resolved stock top and this module reads the block's top; both are the same
 * proven block, so this only absorbs float noise between the two routes.
 */
const LOW_PLANE_TOLERANCE_MM = 1e-3;

export interface FinishLinksOverRemovedStockInput {
  /** The finish's moves, in the same frame as `remaining`. */
  moves: readonly ToolpathMove[];
  tool: Tool;
  /** What the earlier operations left of the stock block, same frame as the moves. */
  remaining: StockState;
  /**
   * The finish's resolved Clearance plane; a lift is a link candidate when it reaches it, or the
   * builder's low link plane over the stock top (WO-2210).
   */
  clearanceZ: number;
  /** Workholding in the moves' frame. Absent or empty = none. */
  workholding?: readonly ClearanceMesh[];
  /** Clearance kept from workholding, mm. */
  workholdingAllowanceMm?: number;
}

export interface FinishLinksOverRemovedStockResult {
  moves: ToolpathMove[];
  /** Links planned over the traverse plane that were offered low. */
  candidates: number;
  /** Of those, the ones the stock proved and kept below the plane. */
  lowered: number;
}

const isRapid = (m: ToolpathMove): boolean => m.type === 'rapid' || m.role === 'rapid';
const sameXY = (a: ToolpathMove, b: ToolpathMove): boolean => a.x === b.x && a.y === b.y;

export function lowerFinishLinksOverRemovedStock(
  input: FinishLinksOverRemovedStockInput,
): FinishLinksOverRemovedStockResult {
  const { moves, tool, remaining, clearanceZ } = input;
  const unchanged = { moves: [...moves], candidates: 0, lowered: 0 };
  if (moves.some(m => m.type === 'arc_cw' || m.type === 'arc_ccw')) return unchanged;
  if (!Number.isFinite(clearanceZ) || !(clearanceZ > remaining.bounds.maxZ)) return unchanged;
  const cutter = toolToCutterSpec(tool);
  // A V-bit's flank cannot be widened into a proof margin (see enforceTraverseSafety).
  if (cutter.kind === 'vbit') return unchanged;

  // WO-2210: the lowest tip z at (x, y) with the standoff of air over everything the
  // remaining stock holds under the cutter's bounding square, widened by the same
  // half-cell margin as the proof below (a column's material can stand anywhere in
  // its cell). -Infinity off the block.
  const radius = cutter.diameter / 2 + remaining.resolutionMm * Math.SQRT1_2;
  const provenClearZ = (x: number, y: number): number => {
    const top = highestMaterialOver(remaining, { minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius });
    return top === undefined ? Number.NEGATIVE_INFINITY : top + TRAVERSE_STANDOFF_MM;
  };
  // A link lifts to Clearance, or (WO-2210) to the builder's low plane over the stock top. Only
  // those: a lift to anything else (a Retract another strategy links at) is not this module's.
  const lowPlaneZ = remaining.bounds.maxZ + TRAVERSE_STANDOFF_MM;
  const liftsToPlane = (z: number): boolean => z >= clearanceZ - EPS;
  const liftsToLowPlane = (z: number): boolean => !liftsToPlane(z) && Math.abs(z - lowPlaneZ) <= LOW_PLANE_TOLERANCE_MM;

  // Find lift / across [/ descend] between two cutting moves. `skip` is how many
  // moves after the lift the low rapid replaces (the link's rapids, and the
  // ramp moves it now arrives below).
  const candidateAt = new Map<number, { low: ToolpathMove; skip: number; liftZ: number }>();
  for (let i = 1; i + 2 < moves.length; i++) {
    const before = moves[i - 1], up = moves[i], across = moves[i + 1];
    if (isRapid(before) || !isRapid(up) || !isRapid(across)) continue;
    if (!sameXY(before, up) || !(up.z > before.z + EPS)) continue;
    if (!liftsToPlane(up.z) && !liftsToLowPlane(up.z)) continue;
    if (Math.abs(across.z - up.z) > EPS || sameXY(up, across)) continue;
    let entry = i + 1;
    if (isRapid(moves[i + 2])) {
      const down = moves[i + 2];
      if (!sameXY(across, down) || !(down.z < across.z - EPS)) continue;
      entry = i + 2;
    }
    const after = moves[entry + 1];
    if (!after || isRapid(after)) continue;
    const top = moves[entry];
    let low: ToolpathMove = { type: 'rapid', x: top.x, y: top.y, z: top.z, role: 'rapid' };
    let last = entry;
    if (after.role === 'plunge' && sameXY(after, top) && after.z < top.z) {
      // A straight plunge entry starts from just above its own surface point, not
      // from Feed Height - and (WO-2210) never under the proven air there.
      low.z = Math.min(top.z, Math.max(after.z + LOW_TRAVEL_HEADROOM_MM, provenClearZ(top.x, top.y)));
    } else if (after.role === 'lead_in') {
      // A ramp: arrive on its lowest vertex that stands in proven air, and ramp on from there.
      for (let k = entry + 1; k < moves.length && !isRapid(moves[k]) && moves[k].role === 'lead_in'; k++) {
        const v = moves[k];
        if (v.z < top.z - EPS && v.z >= provenClearZ(v.x, v.y) - EPS) {
          low = { type: 'rapid', x: v.x, y: v.y, z: v.z, role: 'rapid' };
          last = k;
        }
      }
    }
    candidateAt.set(i, { low, skip: last - i, liftZ: up.z });
    i = last;
  }
  // What the proof cannot keep low is routed over the highest candidate lift. Links on the low plane
  // therefore never share a path with links at Clearance: one it could not prove would climb above
  // where the builder put it. Then the low-plane ones stay exactly as built.
  if ([...candidateAt.values()].some(c => liftsToPlane(c.liftZ))) {
    for (const [i, c] of [...candidateAt]) if (!liftsToPlane(c.liftZ)) candidateAt.delete(i);
  }
  if (candidateAt.size === 0) return unchanged;
  let traverseZ = Number.NEGATIVE_INFINITY;
  for (const c of candidateAt.values()) traverseZ = Math.max(traverseZ, c.liftZ);

  const workholding: SolidColumns[] = [];
  for (const mesh of input.workholding ?? []) {
    const columns = buildSolidColumns(mesh);
    // A fixture the columns cannot read cannot be proved clear of: keep the plane.
    if (!columns) return unchanged;
    workholding.push(columns);
  }

  // The candidate path, and a way back from each IR move to the move it stands for.
  const candidatePath: ToolpathMove[] = [];
  for (let i = 0; i < moves.length; i++) {
    const candidate = candidateAt.get(i);
    if (candidate) {
      candidatePath.push(candidate.low);
      i += candidate.skip;
    } else {
      candidatePath.push(moves[i]);
    }
  }
  const source = new Map<IrMove, ToolpathMove>();
  const ir: IrMove[] = candidatePath.map(m => {
    const irMove: IrMove = { t: m.type === 'rapid' ? 'rapid' : 'feed', x: m.x, y: m.y, z: m.z, ...(m.role ? { role: m.role as IrMove['role'] } : {}) };
    source.set(irMove, m);
    return irMove;
  });

  const stock = ZDexelField.fromColumnTops(
    { originX: remaining.bounds.minX, originY: remaining.bounds.minY, nx: remaining.nx, ny: remaining.ny, cell: remaining.resolutionMm },
    remaining.topZ,
    remaining.bottomZ,
  );
  const safe = enforceTraverseSafety(ir, {
    stock,
    cutter,
    clearanceZ: traverseZ,
    materialTopZ: remaining.bounds.maxZ,
    stockProven: true,
    initialTip: null,
    liftOverMaterial: true,
    // The field samples column centres; a finished corner can stand half a cell
    // diagonal closer than it shows, and a link passes right beside one.
    proofMarginMm: remaining.resolutionMm * Math.SQRT1_2,
    ...(workholding.length > 0
      ? { workholding, ...(input.workholdingAllowanceMm !== undefined ? { workholdingAllowanceMm: input.workholdingAllowanceMm } : {}) }
      : {}),
  });

  const out: ToolpathMove[] = [];
  for (let k = 0; k < safe.moves.length; k++) {
    const m = safe.moves[k];
    const original = source.get(m);
    if (original) {
      out.push(original);
      continue;
    }
    if (m.t === 'rapid') {
      out.push({ type: 'rapid', x: m.x, y: m.y, z: m.z, role: 'rapid' });
    } else {
      // A guarded descent that had to finish at feed: plunge at the rate of the next fed move.
      let feed: number | undefined;
      for (let j = k + 1; j < safe.moves.length && feed === undefined; j++) {
        const next = source.get(safe.moves[j]);
        if (next && !isRapid(next)) feed = next.feed;
      }
      out.push({ type: 'feed', x: m.x, y: m.y, z: m.z, role: 'plunge', ...(feed !== undefined ? { feed } : {}) });
    }
  }

  // Links that crossed below the plane: a lateral rapid with both ends under it.
  let lowered = 0;
  for (let k = 1; k < out.length; k++) {
    const a = out[k - 1], b = out[k];
    if (isRapid(b) && !sameXY(a, b) && Math.max(a.z, b.z) < traverseZ - EPS) lowered++;
  }
  return { moves: out, candidates: candidateAt.size, lowered };
}
