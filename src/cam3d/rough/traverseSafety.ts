// cam3d rough: the no-rapid-through-material rule, enforced on emitted moves.
//
// WO-096. Operator's rule, verbatim:
//
//   "It is ok to travel below the travel height providing the code generator
//    knows the stock is cleared. This is how we leverage Stay Down which speeds
//    up machine time. But it can only do so if it knows that is cleared
//    territory. And it needs to be stock aware to do so. Just because it is
//    above the part does not mean it is above uncleared stock."
//
// So this is NOT a blanket retract. Low travel stays low wherever the in-process
// stock model PROVES the corridor is empty; only the links it cannot prove are
// lifted over the clearance plane.
//
// HOW THE PROOF WORKS. The rougher already carries an in-process stock model
// (ZDexelField + removeSweep), and replayMovesIntoStock already replays each
// level's cutting moves into it -- but only AFTER the whole level was emitted,
// so nothing ever consulted it. This module interleaves the two: walk the level's
// moves in order, and before each traverse ask the field, in the state it is in
// AT THAT POINT IN THE PROGRAM, whether the swept corridor is clear
// (maxTraverseIntrusion). Cutting moves are replayed as we pass them, exactly as
// replayMovesIntoStock did, so "already cut this level" is visible to the very
// next link.
//
// WHAT IS CHECKED: EVERY traverse segment, lateral or vertical. A traverse is
// t === 'rapid', or any move whose role is 'rapid' (the engine's loopback
// fast-traverse is emitted as a feed-typed move with the 'rapid' role). Cutting
// moves are meant to be in material and are never rerouted.
//
//  - LATERAL segments (with or without a z change) are swept against the field.
//    maxTraverseIntrusion judges the whole corridor at the segment's LOWEST tip
//    z, so the destination column is inside the answer. A corridor the field
//    proves clear is kept low -- but only with LOW_TRAVEL_HEADROOM_MM of air
//    under the tool (WO-1270, below). A clear corridor with less air than that is
//    LIFTED to the highest material under it plus the headroom, judged again at
//    that height, and travelled there: still Stay Down, just off the deck.
//  - VERTICAL DESCENTS are guarded by descendSafely (below): the tool rapids only
//    as far down as the field PROVES clear, and any remaining descent is emitted
//    as a FEED 'plunge' -- the same move emit.ts already uses to enter material.
//    So no rapid segment anywhere ever occupies material, and the tool still
//    arrives exactly where the next move expects it.
//  - VERTICAL LIFTS are passed through, and that is a proof, not an exemption:
//    with the tip at (x, y, z) the tool body occupies everything from z + h(r)
//    UPWARD in each column, so raising the tip to z' > z occupies a strict SUBSET
//    of the pose it already holds. A lift can meet nothing new.
//
// WO-096 FIX ROUND. The first attempt checked lateral segments only, and then its
// own reroute ended with an unchecked rapid straight back down to the original
// low endpoint -- which merely moved the collision from the lateral leg to the
// descent. Every descent this module emits now goes through descendSafely, as
// does every descent it is handed.
//
// THE NAMED LIMITATION (`stockProven`). The field can only prove what it was
// built from. When the caller could not establish that the stock box actually
// stands above the part -- the box top is the PART's own top -- the field may be
// missing real material, and "the field says clear" means nothing. In that case
// every below-clearance traverse is UNPROVABLE by construction and is routed over
// the clearance plane. WO-124 adds the independent prerequisite that this plane
// itself is strictly above a proven materialTopZ. Without that proof the operation
// fails before any move can be accepted or rerouted.

import type { CutterSpec } from '../kernel/types';
import type { IrMove } from '../ir/types';
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles';
import { workholdingClearTipZ, type SolidColumns } from '../../lib/cam/holderClearance';
import { DEFAULT_CLEARANCE_ALLOWANCE_MM } from '../../lib/cam/holderClearanceGate';
import { maxTraverseIntrusion, removeSweep, type LinearMove, type ZDexelField } from '../stock';
import { forEachLinearSweep, replaySagittaFor } from './replayStock';
import type { ToolTipPosition } from './replayStock';

/**
 * Material may rise this far into the swept corridor before a traverse counts as
 * a hit, mm. It absorbs the z-dexel's own storage noise (f32 tops) and the
 * cell-quantized staircase left by removeSweep on a wall the tool just cut --
 * NOT a safety allowance. Anything larger than this is real standing material.
 */
export const TRAVERSE_INTRUSION_TOLERANCE_MM = 1e-3;

/** Positive air gap where a guarded rapid descent hands off to feed, mm. */
export const DESCENT_STANDOFF_MM = 0.05;

/**
 * WO-1270. The air a below-clearance LATERAL traverse keeps between the tool and
 * the highest material the stock model shows under its corridor, mm.
 *
 * This is the one number that decides how far off the deck Stay Down travel
 * runs. Operator (2026-09-08, on his stepped pyramid, a rapid crossing a terrace
 * 0.05 mm up at 8 m/min): "Looks like it technically clears, but we should add
 * headroom." Until then the height was inherited from a feed hand-off standoff
 * that means something else (DESCENT_STANDOFF_MM), and the corridor proof was
 * exact to a micron -- correct about the model, silent about the metal.
 *
 * Why 1 mm: the proof is about a model, and the machine differs from the model
 * in ways that add up -- Z backlash and following error at rapid (tens of
 * microns), tool-length and stock-Z setting error (up to ~0.1 mm), chips and
 * stringers standing on a roughed floor (chip thickness here ~0.03 mm, stringers
 * far taller), and a floor that in the field is a cell-quantized staircase, not
 * a plane. One millimetre clears all of those with room to spare, is a number a
 * person can read off a simulation, and costs nothing that matters: on Operator's
 * file it moves each low traverse up by 0.95 mm and adds well under a second to
 * a five-minute cycle. Larger begins to eat the point of Stay Down (a 3 mm
 * stepdown means a 3 mm headroom would already be at the previous level).
 *
 * Chosen, written down, and enforced in ONE place: enforceTraverseSafety lifts
 * any clear corridor that has less than this under it. emit.ts and wallCleanup.ts
 * import it so what they author already meets it and nothing needs lifting.
 */
export const LOW_TRAVEL_HEADROOM_MM = 1.0;

const EPS = 1e-9;

/** XY pitch the workholding columns are sampled at along a traverse corridor, mm. */
const FIXTURE_SAMPLE_STEP_MM = 0.25;

export interface TraverseSafetyInput {
  /** In-process stock, MUTATED in place by the replay (as replayMovesIntoStock did). */
  stock: ZDexelField;
  cutter: CutterSpec;
  /** The operation's declared safe plane: where unprovable links are routed. */
  clearanceZ: number;
  /** Highest material the operation can meet, proven by its resolved real stock. */
  materialTopZ: number;
  /**
   * Does `stock` provably contain ALL the material the tool can meet? False when
   * the stock box was derived from the part itself, so material may stand above
   * the part unmodelled -- see the module header.
   */
  stockProven: boolean;
  /** Tool tip carried across level calls; null before the first move. */
  initialTip: ToolTipPosition | null;
  intrusionToleranceMm?: number;
  /** Air a low lateral traverse must keep over the field, mm (default LOW_TRAVEL_HEADROOM_MM). */
  lowTravelHeadroomMm?: number;
  /**
   * WO-1577. Vises, jaws and clamps as column spans, in the moves' frame - the
   * SAME obstacle columns the toolpath trim uses (`buildSolidColumns`), never a
   * second model. The in-process stock field knows nothing about them: it is
   * built from the stock box, so a jaw standing beside the part is air to it and
   * every link the field proved clear would drive straight through one. Absent
   * or empty = no workholding, and this module behaves exactly as it did.
   */
  workholding?: readonly SolidColumns[];
  /** Clearance kept from workholding, mm. Default: the operation's own default. */
  workholdingAllowanceMm?: number;
  /**
   * WO-1620. A corridor that meets material goes over THAT material (its highest
   * point under the corridor plus the headroom, proved again at that height)
   * instead of straight to the clearance plane, when that height is below the
   * plane. Off by default: roughing reroutes exactly as it always has. A 3D
   * finish after a rough turns it on, so a link crossing the next row's last
   * half millimetre does not climb to Clearance for it.
   */
  liftOverMaterial?: boolean;
  /**
   * WO-1620. Radial margin, mm, added to the cutter for every clearance QUESTION
   * (never for the replay, which removes only what the real tool removes). The
   * field samples each column at its centre, so a corner of real material can
   * stand up to half a cell diagonal closer than the field shows; a caller
   * travelling past a finished surface passes that distance here. Default 0.
   * A V-bit is not widened by a margin (its flank would not cover the real one);
   * a caller asking for one with a V-bit gets a thrown error, not a weaker proof.
   */
  proofMarginMm?: number;
}

export interface TraverseSafetyReport {
  /** Traverse segments with lateral motion that were examined. */
  checked: number;
  /** Of those, how many were rerouted over the clearance plane. */
  rerouted: number;
  /** Rerouted because the field showed standing material in the corridor. */
  reroutedHitMaterial: number;
  /** Rerouted because the stock model could not prove anything (stockProven false). */
  reroutedUnprovable: number;
  /**
   * WO-1270: lateral traverses the field proved clear but with less than the
   * headroom under them, so they were LIFTED to material + headroom (still below
   * the clearance plane where that fits) rather than kept or rerouted.
   */
  liftedForHeadroom: number;
  /**
   * WO-1270: the smallest air gap, mm, that any lateral traverse travelling below
   * the clearance plane actually has over the field after this pass -- measured on
   * the emitted moves, not restated from the constant. +Infinity when no such
   * traverse met material at all (or none was kept low).
   */
  minLowTravelGapMm: number;
  /**
   * Vertical traverse DESCENTS examined -- the ones already in the move stream
   * plus one for every reroute tail this module emits.
   */
  descentsChecked: number;
  /**
   * Of those, how many could not rapid the whole way down and finished at FEED
   * ('plunge'). Non-zero is the machine-time price of an unprovable field.
   */
  descentsFedDown: number;
  /**
   * WO-1577: lateral traverses raised so they pass OVER the workholding. A link
   * the stock field proved clear can still be inside a jaw, so this count is
   * independent of the reroute counts above and is added to `rerouted` as well:
   * the route taken is the over-the-top route, just at a height the clearance
   * plane did not reach.
   */
  raisedOverWorkholding: number;
  /** Worst intrusion measured before rerouting, mm (-Infinity: nothing measured). */
  worstIntrusionMm: number;
  /** Human-readable witness for the worst intrusion, or undefined. */
  worstWitness?: string;
}

export interface WorstIntrusion {
  worstIntrusionMm: number;
  worstWitness?: string;
}

/** Keep the maximum and the witness describing that same measurement paired. */
export function mergeWorstIntrusion(
  acc: WorstIntrusion,
  report: WorstIntrusion,
): WorstIntrusion {
  if (report.worstIntrusionMm <= acc.worstIntrusionMm) return acc;
  return report.worstWitness !== undefined
    ? { worstIntrusionMm: report.worstIntrusionMm, worstWitness: report.worstWitness }
    : { worstIntrusionMm: report.worstIntrusionMm };
}

export interface TraverseSafetyResult {
  moves: IrMove[];
  lastTip: ToolTipPosition | null;
  report: TraverseSafetyReport;
}

/**
 * The cutter grown radially by `marginMm` with its tip where it was: every point
 * of the real cutter's profile is inside the grown one, so a corridor clear of
 * the grown cutter is clear of the real one by the margin.
 */
function widenedCutter(cutter: CutterSpec, marginMm: number): CutterSpec {
  if (!(marginMm >= 0) || !Number.isFinite(marginMm)) {
    throw new Error(`enforceTraverseSafety: proofMarginMm must be a finite number >= 0, got ${marginMm}.`);
  }
  if (marginMm === 0) return cutter;
  switch (cutter.kind) {
    case 'flat':
    case 'ball':
    case 'bull':
      return { ...cutter, diameter: cutter.diameter + 2 * marginMm };
    default:
      throw new Error('enforceTraverseSafety: a proof margin cannot widen a V-bit profile.');
  }
}

/** A move that repositions rather than cuts (rapid, or the loopback traverse). */
function isTraverseMove(move: IrMove): boolean {
  return move.t === 'rapid' || move.role === 'rapid';
}

/**
 * Rewrite one level's emitted moves so no traverse crosses standing material,
 * replaying cutting moves into `stock` as it goes (this REPLACES the caller's
 * separate replayMovesIntoStock call -- doing both would double-cut).
 *
 * Deterministic (D-006): fixed order, no RNG. With `stockProven` true and a clear
 * field the output is the input, move for move.
 */
export function enforceTraverseSafety(
  moves: readonly IrMove[],
  input: TraverseSafetyInput,
): TraverseSafetyResult {
  const { stock, cutter, clearanceZ, materialTopZ, stockProven } = input;
  if (!Number.isFinite(clearanceZ)) {
    throw new Error(`enforceTraverseSafety: clearanceZ must be finite, got ${clearanceZ}.`);
  }
  if (!Number.isFinite(materialTopZ)) {
    throw new Error('enforceTraverseSafety: materialTopZ must be proven and finite.');
  }
  if (!(clearanceZ > materialTopZ)) {
    throw new Error(
      `enforceTraverseSafety: clearanceZ ${clearanceZ} must be strictly above proven material top ${materialTopZ}.`,
    );
  }
  const tol = input.intrusionToleranceMm ?? TRAVERSE_INTRUSION_TOLERANCE_MM;
  const proofCutter = widenedCutter(cutter, input.proofMarginMm ?? 0);

  const out: IrMove[] = [];
  let tip = input.initialTip;
  const report: TraverseSafetyReport = {
    checked: 0,
    rerouted: 0,
    reroutedHitMaterial: 0,
    reroutedUnprovable: 0,
    liftedForHeadroom: 0,
    raisedOverWorkholding: 0,
    minLowTravelGapMm: Number.POSITIVE_INFINITY,
    descentsChecked: 0,
    descentsFedDown: 0,
    worstIntrusionMm: Number.NEGATIVE_INFINITY,
  };
  const headroom = input.lowTravelHeadroomMm ?? LOW_TRAVEL_HEADROOM_MM;
  if (!(headroom >= 0) || !Number.isFinite(headroom)) {
    throw new Error(`enforceTraverseSafety: lowTravelHeadroomMm must be a finite number >= 0, got ${headroom}.`);
  }
  // WO-1577. Where the workholding stands, and how high the tip must be to pass
  // over it. The stock field cannot answer this - it is built from the stock box
  // and a jaw is simply not in it - so the jaws are asked separately, from the
  // same obstacle columns the toolpath trim uses.
  const fixtures = input.workholding ?? [];
  const fixtureAllowance = Math.max(0, input.workholdingAllowanceMm ?? DEFAULT_CLEARANCE_ALLOWANCE_MM);
  const cutterRadius = cutter.diameter / 2;
  /** Lowest tip z that clears every jaw under an XY corridor; -Infinity if none. */
  const fixtureFloorAlong = (x0: number, y0: number, x1: number, y1: number): number => {
    if (fixtures.length === 0) return Number.NEGATIVE_INFINITY;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / FIXTURE_SAMPLE_STEP_MM));
    let need = Number.NEGATIVE_INFINITY;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const clear = workholdingClearTipZ(
        fixtures, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, cutterRadius, fixtureAllowance);
      if (clear > need) need = clear;
    }
    return need;
  };

  // A kept low traverse must have at least this much air under it; the
  // intrusion tolerance is granted on the same side it is granted to a hit, so a
  // move authored at exactly material + headroom is kept, float noise and all.
  const keepIfIntrusionAtMost = tol - headroom;
  const noteLowTravelGap = (hit: ReturnType<typeof maxTraverseIntrusion>): void => {
    const gap = -hit.intrusionMm;
    if (gap < report.minLowTravelGapMm) report.minLowTravelGapMm = gap;
  };

  // Guard decisions must start from the path actually emitted. A reroute may
  // have a different shape from the requested move, so requested coordinates
  // are not proof of where the cutter ended.
  const tipFromEmitted = (): ToolTipPosition | null => {
    const last = out[out.length - 1];
    return last === undefined ? tip : { x: last.x, y: last.y, z: last.z };
  };

  const noteIntrusion = (what: string, hit: ReturnType<typeof maxTraverseIntrusion>, text: string): void => {
    if (hit.intrusionMm <= report.worstIntrusionMm) return;
    report.worstIntrusionMm = hit.intrusionMm;
    if (hit.intrusionMm > tol) {
      report.worstWitness =
        `${what} ${text} meets material topping out at z=${hit.materialTopZ.toFixed(3)} near ` +
        `(${hit.x.toFixed(3)}, ${hit.y.toFixed(3)}) -- ${hit.intrusionMm.toFixed(3)} mm into the cutter`;
    }
  };

  /**
   * Descend straight down to (x, y, targetZ) from `fromZ` WITHOUT ever rapiding
   * through material, appending the moves to `out`.
   *
   * The tool rapids only as deep as the field proves clear; the remainder (if
   * any) is a FEED 'plunge', which is exactly the move emit.ts already uses to
   * enter a region -- so this never invents a motion type, never leaves the tool
   * short of the point the next move expects, and never sends a rapid into
   * material. When `stockProven` is false nothing below the start is provable, so
   * the whole descent is fed.
   *
   * The fed portion removes stock, so it is replayed into the field like any
   * other plunge.
   */
  const descendSafely = (x: number, y: number, fromZ: number, targetZ: number): void => {
    if (targetZ >= clearanceZ - EPS) {
      // Never leaves the declared safe plane; that plane IS the fallback target,
      // so there is nothing to prove (same rule as the lateral check).
      out.push({ t: 'rapid', x, y, z: targetZ, role: 'rapid' });
      return;
    }
    report.descentsChecked++;
    let rapidFloorZ = fromZ; // proves nothing below where the tool already is
    if (stockProven) {
      // Probe the destination column at the tip z the descent ends on. The
      // cutter occupies z + h(r) upward, so `targetZ + intrusionMm` is the tip z
      // at which the tool just touches the highest material under its footprint;
      // everything above that is air, and everything below is a collision.
      const probe: LinearMove = { x0: x, y0: y, z0: targetZ, x1: x, y1: y, z1: targetZ };
      const hit = maxTraverseIntrusion(stock, probe, proofCutter);
      noteIntrusion(
        'descent',
        hit,
        `(${x.toFixed(3)}, ${y.toFixed(3)}, ${fromZ.toFixed(3)}) -> (${x.toFixed(3)}, ` +
          `${y.toFixed(3)}, ${targetZ.toFixed(3)})`,
      );
      // contactTipZ is contact, not clearance. Hand the last 0.05 mm to feed so
      // the rapid endpoint is physically above standing material. Air descents
      // with at least this gap remain byte-identical rapids.
      rapidFloorZ =
        hit.intrusionMm > -DESCENT_STANDOFF_MM
          ? Math.min(fromZ, hit.contactTipZ + DESCENT_STANDOFF_MM)
          : targetZ;
    }

    if (rapidFloorZ <= targetZ + EPS) {
      if (targetZ < fromZ - EPS) out.push({ t: 'rapid', x, y, z: targetZ, role: 'rapid' });
      return;
    }
    report.descentsFedDown++;
    if (rapidFloorZ < fromZ - EPS) out.push({ t: 'rapid', x, y, z: rapidFloorZ, role: 'rapid' });
    const feedFromZ = Math.min(rapidFloorZ, fromZ);
    out.push({ t: 'feed', x, y, z: targetZ, role: 'plunge' });
    removeSweep(stock, { x0: x, y0: y, z0: feedFromZ, x1: x, y1: y, z1: targetZ }, cutter);
  };

  for (const move of moves) {
    const hasOrigin = tip !== null && Number.isFinite(tip.x) && Number.isFinite(tip.y);
    const lateral = hasOrigin && (tip!.x !== move.x || tip!.y !== move.y);
    const descending = hasOrigin && Number.isFinite(tip!.z) && move.z < tip!.z - EPS;

    // A traverse that only goes UP (or nowhere) can meet nothing new -- see the
    // module header for why that is a proof and not an exemption.
    if (isTraverseMove(move) && hasOrigin && !lateral && descending) {
      descendSafely(move.x, move.y, tip!.z, move.z);
      tip = tipFromEmitted();
      continue;
    }

    if (isTraverseMove(move) && lateral) {
      report.checked++;
      const from = tip!;
      const atOrAboveClearance = Math.min(from.z, move.z) >= clearanceZ - EPS;
      // WO-1577. The tip height this corridor must reach to pass over the
      // workholding. It is judged against whatever height the link ends up
      // travelling at - kept, lifted for headroom, or over the clearance plane -
      // because a jaw can stand taller than that plane, and then even the
      // "route it over the top" answer goes straight through the jaw.
      const fixtureFloorZ = fixtureFloorAlong(from.x, from.y, move.x, move.y);
      let reroute = false;
      let unprovable = false;
      // WO-1270: a clear corridor with too little air under it travels here instead.
      let liftToZ: number | undefined;

      if (Number.isFinite(fixtureFloorZ) && Math.min(from.z, move.z) < fixtureFloorZ) {
        // Inside a jaw at the height it would travel: over the top is the only
        // route, and `routeZ` below lifts the clearance plane to clear it.
        reroute = true;
      } else if (atOrAboveClearance) {
        // WO-124: module entry proved clearanceZ strictly above materialTopZ.
      } else if (!stockProven) {
        reroute = true;
        unprovable = true;
      } else {
        const sweep: LinearMove = {
          x0: from.x, y0: from.y, z0: from.z,
          x1: move.x, y1: move.y, z1: move.z,
        };
        const hit = maxTraverseIntrusion(stock, sweep, proofCutter);
        noteIntrusion(
          'traverse',
          hit,
          `(${from.x.toFixed(3)}, ${from.y.toFixed(3)}, ${from.z.toFixed(3)}) -> ` +
            `(${move.x.toFixed(3)}, ${move.y.toFixed(3)}, ${move.z.toFixed(3)})`,
        );
        if (hit.intrusionMm > tol) {
          if (input.liftOverMaterial === true && Number.isFinite(hit.contactTipZ) &&
              hit.contactTipZ + headroom < clearanceZ - EPS) {
            // WO-1620: over the material, not over the plane; re-judged below.
            liftToZ = hit.contactTipZ + headroom;
          } else {
            reroute = true;
          }
        } else if (hit.intrusionMm > keepIfIntrusionAtMost && Number.isFinite(hit.contactTipZ)) {
          // Clear, but by less than the headroom. Travel at the highest material
          // under the corridor plus the headroom -- capped at the clearance
          // plane, which is the operator's own declared safe height.
          liftToZ = Math.min(clearanceZ, hit.contactTipZ + headroom);
        } else {
          noteLowTravelGap(hit);
        }
      }

      if (liftToZ !== undefined) {
        // Re-judge the corridor AT THE HEIGHT IT WILL ACTUALLY TRAVEL. Raising a
        // lateral leg is a lift (meets nothing new) followed by a corridor at the
        // new height, and only a proof at that height earns it the low route.
        const acrossZ = Math.max(liftToZ, move.z);
        const lifted: LinearMove = {
          x0: from.x, y0: from.y, z0: Math.max(from.z, liftToZ),
          x1: move.x, y1: move.y, z1: acrossZ,
        };
        const rehit = maxTraverseIntrusion(stock, lifted, proofCutter);
        if (rehit.intrusionMm > keepIfIntrusionAtMost && liftToZ < clearanceZ - EPS) {
          // The field disagreed with its own contact reading; do not argue with
          // it -- take the declared safe plane like any other unproven link.
          reroute = true;
        } else {
          report.liftedForHeadroom++;
          if (liftToZ < clearanceZ - EPS) noteLowTravelGap(rehit);
          // eslint-disable-next-line no-console
          console.info(
            `[travel-headroom] low travel (${from.x.toFixed(2)}, ${from.y.toFixed(2)}) -> ` +
              `(${move.x.toFixed(2)}, ${move.y.toFixed(2)}) lifted from z=${Math.min(from.z, move.z).toFixed(3)} ` +
              `to z=${liftToZ.toFixed(3)}: ${(-rehit.intrusionMm).toFixed(3)} mm of air over the stock model ` +
              `(rule ${headroom.toFixed(2)} mm, WO-1270)`,
          );
          if (from.z < liftToZ - EPS) {
            out.push({ t: 'rapid', x: from.x, y: from.y, z: liftToZ, role: 'rapid' });
          }
          out.push({ t: 'rapid', x: move.x, y: move.y, z: acrossZ, role: 'rapid' });
          if (move.z < acrossZ - EPS) descendSafely(move.x, move.y, acrossZ, move.z);
          tip = tipFromEmitted();
          continue;
        }
      }

      if (reroute) {
        report.rerouted++;
        if (unprovable) report.reroutedUnprovable++;
        else report.reroutedHitMaterial++;
        // WO-1577: the clearance plane is the operator's safe height over the
        // STOCK. A jaw can be taller, so the route goes over whichever is higher
        // - the plane is a floor for this link, never a ceiling. Nothing is
        // refused: the link is made, just higher up.
        const routeZ = Number.isFinite(fixtureFloorZ) ? Math.max(clearanceZ, fixtureFloorZ) : clearanceZ;
        if (routeZ > clearanceZ + EPS) {
          report.raisedOverWorkholding++;
          // eslint-disable-next-line no-console
          console.info(
            `[workholding-clearance] link (${from.x.toFixed(2)}, ${from.y.toFixed(2)}) -> ` +
              `(${move.x.toFixed(2)}, ${move.y.toFixed(2)}) raised from z=${clearanceZ.toFixed(3)} ` +
              `to z=${routeZ.toFixed(3)} to pass over the workholding ` +
              `(allowance ${fixtureAllowance} mm, WO-1577)`,
          );
        }
        // Over the clearance plane: straight up (a lift meets nothing new),
        // across at clearance, then back down to the endpoint the original
        // traverse was heading for -- and that descent is GUARDED, because the
        // endpoint may be exactly the material the lateral leg was rerouted for.
        if (from.z < routeZ - EPS) {
          out.push({ t: 'rapid', x: from.x, y: from.y, z: routeZ, role: 'rapid' });
        }
        out.push({ t: 'rapid', x: move.x, y: move.y, z: routeZ, role: 'rapid' });
        if (move.z < routeZ - EPS) {
          descendSafely(move.x, move.y, routeZ, move.z);
        } else if (move.z > routeZ) {
          // A rising reroute still owes the requested endpoint. The final lift
          // occupies a subset of the already-clear cutter pose.
          out.push({ t: 'rapid', x: move.x, y: move.y, z: move.z, role: 'rapid' });
        }
        tip = tipFromEmitted();
        continue;
      }
      // Kept as authored, with at least the headroom under it. maxTraverseIntrusion
      // judged the whole corridor at the segment's LOWEST tip z, so any descent
      // inside this segment is already inside that answer -- nothing left to guard.
    }

    // Unchanged move: replay its removal exactly as replayMovesIntoStock does
    // (arcs walked along the arc, WO-407).
    const role = effectiveMoveRole({ type: move.t === 'rapid' ? 'rapid' : 'feed', role: move.role });
    if (hasOrigin && isStockCuttingRole(role)) {
      forEachLinearSweep(tip!, move, replaySagittaFor(stock), (sweep) => removeSweep(stock, sweep, cutter));
    }
    out.push(move);
    tip = { x: move.x, y: move.y, z: move.z };
  }

  return { moves: out, lastTip: tip, report };
}
