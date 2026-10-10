// cam3d rough: immutable retained-wall cleanup after the adaptive bulk pass.
//
// The adaptive bulk path is allowed to reason from mutable remaining stock,
// but its final wall is not. These contours come from a cutter-contact field
// built directly from the selected model. They therefore reset the wall target
// at every level instead of inheriting a scallop from the level above.
//
// RIM LOAD (WO-1253, the 3D twin of the 2D engine's WO-410 CONTOUR RIM contract).
// A cleanup contour is only a legal FINISHING pass where the material standing in
// front of it is a RIM the cutter can skim. Where the bulk pass could not reach --
// a slot narrower than the cutter plus its cap, a corner corridor that never
// admitted a bounded bite -- the contour meets VIRGIN material and, with no guard,
// ploughs it at full width. The coarse engagementPocket rough did exactly that:
// the contour staircased into the 6 mm neck and ran one straight 10.2 mm move down
// its centreline with a 4 mm cutter, 101.7% of a full slot, and WO-100's rule is
// that no move an adaptive strategy emits may exceed its engagement limit.
//
// So when `engagementGuard` is supplied this planner MEASURES each contour on the
// live stock with the same ruler the strategy's own gate uses
// (measurePathEngagement: 2 mm sustained window, the caller's cap), drops the spans
// that would sustain more than the cap, and reports them. It BITES WHAT IT CAN TAKE
// and leaves the rest standing for a finishing operation with a tool that fits --
// out loud, never as a quiet slot and never as a silent drop.
//
// Two deliberate limits on the drop, both so the common case cannot move:
//   - a ring that measures clean is emitted BYTE-IDENTICALLY to the unguarded path,
//     leads and all. Only a ring that would plough is rebuilt.
//   - a rebuilt ring re-enters each retained span with the plain clear-side
//     approach. Radiused lead transitions are a finish-quality nicety, and a ring
//     carrying material the cutter cannot legally contour is not a clean finish
//     ring; keeping the arcs would mean inventing a seam per fragment.

import type { CutterSpec } from '../kernel/types';
import type { IrMove } from '../ir/types';
import type { Ring } from '../geom2d';
import { maxTraverseIntrusion, type Box3, type ZDexelField } from '../stock';
import { replayMovesIntoStock, type ToolTipPosition } from './replayStock';
import { measurePathEngagement } from './pathEngagement';
import { LOW_TRAVEL_HEADROOM_MM } from './traverseSafety';
import type { AdaptiveMillingDirection } from '../../lib/cam/types';
import { materialSideForClockwisePlanner } from './millingDirection';

const EPS = 1e-9;

/**
 * Rounds of measure-and-drop per ring. Dropping a span moves the re-entry of the
 * span after it, so the next round measures a different path; three rounds settled
 * every fixture measured for WO-1253 (the engagementPocket neck settles in one).
 * The strategy's own published-path gate is the backstop if a ring never settles.
 */
const MAX_RIM_LOAD_ROUNDS = 4;

function ringPoint(ring: Ring, index: number): { x: number; y: number } {
  const count = ring.length / 2;
  const i = ((index % count) + count) % count;
  return { x: ring[i * 2], y: ring[i * 2 + 1] };
}

function clearSidePoint(
  ring: Ring,
  index: number,
  distance: number,
): { x: number; y: number } | undefined {
  const prior = ringPoint(ring, index - 1);
  const next = ringPoint(ring, index + 1);
  const current = ringPoint(ring, index);
  const dx = next.x - prior.x;
  const dy = next.y - prior.y;
  const length = Math.hypot(dx, dy);
  if (length <= EPS) return undefined;
  // Geom2d convention puts material on the left of both CCW outers and CW
  // holes. The right normal therefore points into machinable/cleared space.
  return {
    x: current.x + (dy / length) * distance,
    y: current.y - (dx / length) * distance,
  };
}

function cutterPoseIsClear(
  stock: ZDexelField,
  cutter: CutterSpec,
  point: { x: number; y: number },
  z: number,
): boolean {
  const hit = maxTraverseIntrusion(stock, {
    x0: point.x, y0: point.y, z0: z,
    x1: point.x, y1: point.y, z1: z,
  }, cutter);
  return hit.intrusionMm <= 1e-3;
}

/**
 * Ask the planner to bound each contour's sustained engagement (WO-1253). Omit it
 * and the planner behaves exactly as it did before: every ring is contoured whole.
 */
export interface WallCleanupEngagementGuard {
  /** The stock box the contour runs on -- the replay frame for the measurement. */
  stockBounds: Box3;
  /** The operation's field cell. The replay refines it to resolve the cutter. */
  cellSize: number;
  /** Sustained engagement cap, as a fraction of a full slot at the same depth. */
  capFraction: number;
}

/** A contour span left standing because contouring it would have cut over the cap. */
export interface WallRimOverload {
  z: number;
  /** Midpoint of the dropped span. */
  x: number;
  y: number;
  /** Contour length not cut, mm. */
  lengthMm: number;
  /** Worst sustained fraction of a full slot measured over the dropped span. */
  peakFraction: number;
}

export interface WallCleanupPlan {
  moves: IrMove[];
  contourCount: number;
  /**
   * Spans left standing by the engagement guard, deepest-first in emission order.
   * Empty whenever no guard was supplied or every ring measured clean.
   */
  rimOverloads: WallRimOverload[];
}

/**
 * Build low-link candidates plus lateral leads into immutable wall contours.
 * Traverse safety validates/reroutes the rapid candidates afterward; only the
 * lead and contour are cutting moves.
 */
export function planWallCleanup(
  rings: readonly Ring[],
  stock: ZDexelField,
  cutter: CutterSpec,
  z: number,
  initialTip: ToolTipPosition | null,
  leadDistance: number,
  millingDirection: AdaptiveMillingDirection,
  leadInRadius = 0,
  leadOutRadius = 0,
  maxArcChord = 0.05,
  engagementGuard?: WallCleanupEngagementGuard,
): WallCleanupPlan {
  const moves: IrMove[] = [];
  let cursor = initialTip;
  let contourCount = 0;
  const rimOverloads: WallRimOverload[] = [];
  // The guard measures each ring against the material actually standing when THAT
  // ring is cut, so accepted rings are carved into this working copy as they go.
  // The caller's field is never touched.
  const guardStock = engagementGuard ? stock.clone() : undefined;

  const push = (move: IrMove): void => {
    if (cursor && cursor.x === move.x && cursor.y === move.y && cursor.z === move.z) return;
    moves.push(move);
    cursor = { x: move.x, y: move.y, z: move.z };
  };

  /**
   * A move sink with its own cursor, so a candidate contour can be BUILT and
   * MEASURED before anything is committed. `steps` records, per emitted move, the
   * contour segment it belongs to (0 for a reposition that cuts nothing), which is
   * how an over-cap window is traced back to the segment the guard must drop.
   */
  const sequencer = (from: ToolTipPosition | null) => {
    const out: IrMove[] = [];
    const steps: number[] = [];
    let cur = from;
    return {
      out,
      steps,
      push(move: IrMove, step: number): void {
        if (cur && cur.x === move.x && cur.y === move.y && cur.z === move.z) return;
        out.push(move);
        steps.push(step);
        cur = { x: move.x, y: move.y, z: move.z };
      },
      get cursor(): ToolTipPosition | null {
        return cur;
      },
    };
  };

  for (const ring of rings) {
    const count = ring.length / 2;
    if (count < 3) continue;
    // Geom2d retained-material rings put material on the left in their
    // canonical winding (CCW exterior, CW pocket wall). The engine has already
    // transformed physical spindle rotation into its CW-planner convention, so
    // conventional (material left) follows the canonical winding and climb
    // (material right, WO-1896) reverses it.
    const materialSide = materialSideForClockwisePlanner(millingDirection);
    const travelStep = materialSide === 'left' ? 1 : -1;
    const useRadiusedTransitions = leadInRadius > EPS || leadOutRadius > EPS;
    let selected:
      | { index: number; wall: { x: number; y: number }; clear: { x: number; y: number }; score: number }
      | undefined;
    let radiused:
      | {
          index: number;
          seam: { x: number; y: number };
          tangent: { x: number; y: number };
          normal: { x: number; y: number };
          entry: { x: number; y: number };
          exit: { x: number; y: number };
          score: number;
        }
      | undefined;

    if (useRadiusedTransitions) {
      for (let index = 0; index < count; index++) {
        const start = ringPoint(ring, index);
        const end = ringPoint(ring, index + travelStep);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        if (length <= EPS) continue;
        const tangent = { x: dx / length, y: dy / length };
        const normal = travelStep === 1
          ? { x: tangent.y, y: -tangent.x }
          : { x: -tangent.y, y: tangent.x };
        const seam = { x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5 };
        const entry = leadInRadius > EPS
          ? {
              x: seam.x - leadInRadius * tangent.x + leadInRadius * normal.x,
              y: seam.y - leadInRadius * tangent.y + leadInRadius * normal.y,
            }
          : {
              x: seam.x + leadDistance * normal.x,
              y: seam.y + leadDistance * normal.y,
            };
        const exit = leadOutRadius > EPS
          ? {
              x: seam.x + leadOutRadius * tangent.x + leadOutRadius * normal.x,
              y: seam.y + leadOutRadius * tangent.y + leadOutRadius * normal.y,
            }
          : seam;
        if (!cutterPoseIsClear(stock, cutter, entry, z)) continue;
        if (leadOutRadius > EPS && !cutterPoseIsClear(stock, cutter, exit, z)) continue;
        const score = cursor ? Math.hypot(entry.x - cursor.x, entry.y - cursor.y) : index;
        if (!radiused || score < radiused.score) {
          radiused = { index, seam, tangent, normal, entry, exit, score };
        }
      }
      if (!radiused) {
        throw new Error(
          `planWallCleanup: requested wall transition radius does not fit in proven-cleared space at z=${z.toFixed(3)}.`,
        );
      }
    }

    // A zero-radius operation deliberately uses the legacy vertex entry path.
    // This keeps existing projects byte-identical until a user opts into arcs.
    if (!useRadiusedTransitions) {
      for (let index = 0; index < count; index++) {
        const wall = ringPoint(ring, index);
        for (const scale of [1, 1.5, 2]) {
          const clear = clearSidePoint(ring, index, leadDistance * scale);
          if (!clear || !cutterPoseIsClear(stock, cutter, clear, z)) continue;
          const score = cursor ? Math.hypot(clear.x - cursor.x, clear.y - cursor.y) : index;
          if (!selected || score < selected.score) selected = { index, wall, clear, score };
          break;
        }
      }
      if (!selected) {
        // A retained-model silhouette can coincide with the untouched stock
        // perimeter. That is not a machinable wall in this operation: there
        // is no material-side access and therefore no legal cutter-centre
        // contour to emit. Skip only this inaccessible ring; reachable model
        // walls (including an exterior base with stock around it) still own a
        // complete cleanup contour.
        continue;
      }
    }

    // WO-1270: a reposition between spans is a rapid over the floor this level
    // just cut; it keeps the same headroom every low traverse keeps.
    const linkZ = z + LOW_TRAVEL_HEADROOM_MM;
    const baseIndex = radiused ? radiused.index : selected!.index;
    // Contour points in travel order: pt(0) is the seam vertex, pt(k) the vertex
    // reached by segment k, and pt(count) closes the ring back onto pt(0).
    const pt = (k: number): { x: number; y: number } => ringPoint(ring, baseIndex + travelStep * k);
    const segmentLength = (k: number): number => {
      const a = pt(k - 1);
      const b = pt(k);
      return Math.hypot(b.x - a.x, b.y - a.y);
    };

    const emitQuarterArc = (
      q: ReturnType<typeof sequencer>,
      radius: number,
      kind: 'in' | 'out',
      step: number,
    ): void => {
      if (radius <= EPS) {
        q.push({ t: 'feed', x: radiused!.seam.x, y: radiused!.seam.y, z, role: 'finish' }, step);
        return;
      }
      const center = {
        x: radiused!.seam.x + radius * radiused!.normal.x,
        y: radiused!.seam.y + radius * radiused!.normal.y,
      };
      const steps = Math.max(4, Math.ceil((Math.PI * radius * 0.5) / Math.max(maxArcChord, 0.005)));
      for (let arcStep = 1; arcStep <= steps; arcStep++) {
        const angle = (Math.PI * 0.5 * arcStep) / steps;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const x = kind === 'in'
          ? center.x - radius * (radiused!.tangent.x * cos + radiused!.normal.x * sin)
          : center.x + radius * (radiused!.tangent.x * sin - radiused!.normal.x * cos);
        const y = kind === 'in'
          ? center.y - radius * (radiused!.tangent.y * cos + radiused!.normal.y * sin)
          : center.y + radius * (radiused!.tangent.y * sin - radiused!.normal.y * cos);
        q.push({ t: 'feed', x, y, z, role: 'finish' }, step);
      }
    };

    /** The whole ring, exactly as this planner has always emitted it. */
    const buildWholeRing = (from: ToolTipPosition | null): ReturnType<typeof sequencer> => {
      const q = sequencer(from);
      if (q.cursor && q.cursor.z < linkZ - EPS) {
        q.push({ t: 'rapid', x: q.cursor.x, y: q.cursor.y, z: linkZ, role: 'rapid' }, 0);
      }
      const entry = radiused?.entry ?? selected!.clear;
      q.push({ t: 'rapid', x: entry.x, y: entry.y, z: linkZ, role: 'rapid' }, 0);
      q.push({ t: 'rapid', x: entry.x, y: entry.y, z, role: 'rapid' }, 0);
      // This is part of the wall-finishing pass, not the operation's stock-edge
      // entry. Keeping the roles distinct lets the entry safety gate measure the
      // actual outside-in lead and nothing else.
      if (!radiused) {
        q.push({ t: 'feed', x: selected!.wall.x, y: selected!.wall.y, z, role: 'finish' }, 1);
      } else {
        emitQuarterArc(q, leadInRadius, 'in', 1);
      }
      for (let step = 1; step <= count; step++) {
        const point = pt(step);
        q.push({ t: 'feed', x: point.x, y: point.y, z, role: 'finish' }, step);
      }
      if (radiused) {
        q.push({ t: 'feed', x: radiused.seam.x, y: radiused.seam.y, z, role: 'finish' }, count);
        if (leadOutRadius > EPS) emitQuarterArc(q, leadOutRadius, 'out', count);
      }
      return q;
    };

    /** A clear-side pose the cutter can descend at to pick the contour up at pt(k). */
    const approachFor = (k: number): { x: number; y: number } | undefined => {
      const index = baseIndex + travelStep * k;
      for (const scale of [1, 1.5, 2]) {
        const clear = clearSidePoint(ring, index, leadDistance * scale);
        if (clear && cutterPoseIsClear(stock, cutter, clear, z)) return clear;
      }
      return undefined;
    };

    /**
     * Only the retained spans, each re-entered on its own clear-side approach.
     * `keep[k]` is whether segment k (pt(k-1) -> pt(k)) may be cut; a span whose
     * head has no reachable approach is surrendered too rather than plunged into.
     */
    const buildRetainedSpans = (
      from: ToolTipPosition | null,
      keep: boolean[],
    ): { q: ReturnType<typeof sequencer>; spans: number; surrendered: boolean[] } => {
      const q = sequencer(from);
      const surrendered = keep.map((kept) => !kept);
      let spans = 0;
      let k = 1;
      while (k <= count) {
        if (!keep[k]) {
          k++;
          continue;
        }
        let last = k;
        while (last + 1 <= count && keep[last + 1]) last++;
        // Walk the head forward to the first vertex the cutter can actually be
        // set down beside. Surrendering the WHOLE span because its first vertex
        // sits in the unreachable stretch (a neck mouth, say) throws away the
        // reachable wall behind it -- 139.5 mm of the engagementPocket's 199 mm
        // ring for the sake of a 12 mm neck, measured.
        let approach: { x: number; y: number } | undefined;
        while (k <= last) {
          approach = approachFor(k - 1);
          if (approach !== undefined) break;
          surrendered[k] = true;
          k++;
        }
        if (approach === undefined) {
          k = last + 1;
          continue;
        }
        const head = pt(k - 1);
        if (q.cursor && q.cursor.z < linkZ - EPS) {
          q.push({ t: 'rapid', x: q.cursor.x, y: q.cursor.y, z: linkZ, role: 'rapid' }, 0);
        }
        q.push({ t: 'rapid', x: approach.x, y: approach.y, z: linkZ, role: 'rapid' }, 0);
        q.push({ t: 'rapid', x: approach.x, y: approach.y, z, role: 'rapid' }, 0);
        q.push({ t: 'feed', x: head.x, y: head.y, z, role: 'finish' }, k);
        for (let i = k; i <= last; i++) {
          const point = pt(i);
          q.push({ t: 'feed', x: point.x, y: point.y, z, role: 'finish' }, i);
        }
        spans++;
        k = last + 1;
      }
      return { q, spans, surrendered };
    };

    /**
     * The move list to MEASURE for a candidate plan.
     *
     * A reposition between spans is emitted just above the floor (`linkZ`) and the
     * traverse-safety pass downstream owns the verdict on it -- it reroutes a link
     * that would hit material over Clearance Height. The engagement replay has no
     * such pass: it carves EVERY sweep it is given, so a raw linkZ hop straight
     * across the pocket would carve a swath the machine never cuts and hand the
     * next span an empty field. That is exactly how the neck hid: the hop over the
     * dropped upper wall cleared the neck in the replay and the lower wall then
     * measured 37.5% where the published path measured 95%.
     *
     * So measurement lifts the repositions to the top of the stock. The descent at
     * the span head stays where it is -- `cutterPoseIsClear` already proved that
     * pose -- and every cutting move is untouched.
     */
    const measurementViewOf = (candidate: ReturnType<typeof sequencer>): IrMove[] =>
      candidate.out.map((move, i) => (
        candidate.steps[i] === 0 && move.t === 'rapid' && move.z > z + EPS
          ? { ...move, z: engagementGuard!.stockBounds.maxZ }
          : move
      ));

    // ---- rim load: measure, drop what would plough, keep the rest -----------
    let plan = buildWholeRing(cursor);
    let planSpans = 1;
    let dropped: boolean[] = new Array<boolean>(count + 1).fill(false);
    const worstFraction = new Array<number>(count + 1).fill(0);
    if (engagementGuard !== undefined && guardStock !== undefined) {
      const keep = new Array<boolean>(count + 1).fill(true);
      for (let round = 0; round < MAX_RIM_LOAD_ROUNDS; round++) {
        const hot = new Set<number>();
        measurePathEngagement(
          measurementViewOf(plan),
          engagementGuard.stockBounds,
          engagementGuard.cellSize,
          cutter,
          {
            capFraction: engagementGuard.capFraction,
            startingStock: guardStock,
            onOverCap: (hit) => {
              const step = plan.steps[hit.moveIndex];
              if (step > 0) {
                hot.add(step);
                if (hit.fraction > worstFraction[step]) worstFraction[step] = hit.fraction;
              }
            },
          },
        );
        if (hot.size === 0) break;
        for (const step of hot) keep[step] = false;
        const retained = buildRetainedSpans(cursor, keep);
        for (let i = 1; i <= count; i++) if (retained.surrendered[i]) keep[i] = false;
        plan = retained.q;
        planSpans = retained.spans;
        dropped = keep.map((kept) => !kept);
      }
    }

    if (plan.out.length === 0) {
      // Every segment of this ring would have ploughed. Say so and leave the wall
      // standing; a finishing operation with a tool that fits owns it now.
      let total = 0;
      let peak = 0;
      for (let k = 1; k <= count; k++) {
        total += segmentLength(k);
        if (worstFraction[k] > peak) peak = worstFraction[k];
      }
      const mid = pt(Math.floor(count / 2));
      rimOverloads.push({ z, x: mid.x, y: mid.y, lengthMm: total, peakFraction: peak });
      continue;
    }

    for (const move of plan.out) push(move);
    contourCount += planSpans;
    if (guardStock !== undefined) replayMovesIntoStock(guardStock, cutter, plan.out, null);

    // Group the surrendered segments into contiguous stretches so the report names
    // WHERE the wall was left standing, not just how much of it.
    let runStart = -1;
    for (let k = 1; k <= count + 1; k++) {
      const isDropped = k <= count && dropped[k];
      if (isDropped && runStart < 0) runStart = k;
      if (!isDropped && runStart >= 0) {
        let lengthMm = 0;
        let peak = 0;
        for (let i = runStart; i < k; i++) {
          lengthMm += segmentLength(i);
          if (worstFraction[i] > peak) peak = worstFraction[i];
        }
        const mid = pt(Math.floor((runStart + k - 2) / 2));
        rimOverloads.push({ z, x: mid.x, y: mid.y, lengthMm, peakFraction: peak });
        runStart = -1;
      }
    }
  }

  return { moves, contourCount, rimOverloads };
}
