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
import { fitCircleEndpointLocked } from '../../lib/post/arcfit/circleFit';
import { douglasPeuckerIndexed } from '../../lib/post/arcfit/simplify';
import type { IrMove, IrMoveRole } from '../ir/types';

/**
 * WO-3040 switch (the operator 2026-10-21 18:05 UTC, Mission Control: "Paths must be
 * tangent to their leading and trailing moves"). OFF: constant-Z feed runs are
 * fitted by collapsePolyline, whose arcs meet the path within a POSITION
 * tolerance only, so every join between two fitted primitives carries a small
 * heading jog (WO-3036 measured 0.3-5 deg) where the machine slows. ON: the same
 * runs are fitted by fitTangentRuns below, which starts every arc and line on the
 * exact heading the previous one left on, inside the same position tolerance.
 * ON since WO-3050 (the operator approved the before/after 2026-10-21 4:51 PM CT);
 * turning it back off is this one line.
 */
export const ADAPTIVE_ARC_JOIN_POLICY: { tangentJoins: boolean } = {
  tangentJoins: true,
};

/**
 * WO-3040: a vertex of the dense planner path that turns the tool by more than
 * this, degrees, is a real corner of the path (a pass meeting a link, a wall
 * corner, a loop back) and keeps its corner. Below it the vertex is a sample of
 * a smooth curve and the fitted path passes it on one heading.
 */
export const TANGENT_CORNER_DEG = 30;

export interface SmoothAdaptiveResult {
  moves: IrMove[];
  removedPoints: number;
  arcCount: number;
}

export function smoothAdaptiveIr(
  moves: readonly IrMove[],
  authoredTolerance: number,
  tangentJoins: boolean = ADAPTIVE_ARC_JOIN_POLICY.tangentJoins,
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

  const collapseParams = {
    arcTolerance: fitTolerance,
    minArcRadius: 0.2,
    maxArcRadius: 100_000,
    minSweepDeg: 3,
  };
  const collapsed = tangentJoins
    ? fitTangentRuns(postMoves, collapseParams)
    : collapsePolyline(postMoves, collapseParams);

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

// ---------------------------------------------------------------------------
// WO-3040: tangent-continuous fit of the constant-Z feed runs.
//
// The moves fitted are the ones collapsePolyline fits (plain feed moves on one
// plane), and every fitted primitive is judged against the same dense planner
// polyline within the same tolerance, both ways: every planner point lies near
// the fit and every point of the fit near the planner's path. What changes is
// how primitives meet: each starts on the exact heading the one before it left
// on. Consecutive runs of different feed or role are fitted as one path (the
// change stays a vertex, where the planner put it), and the first and last
// primitives share the heading of a fixed neighbour (a source arc, a sloped
// move) where the path turns smoothly into it.
//
// The path is first simplified (Douglas-Peucker at half the tolerance, as
// collapsePolyline's breakpoints are). Each smooth vertex gets one heading, the
// blend of its two segments. Between vertices the fit is one arc leaving on the
// current heading, or the biarc that also arrives on the next vertex's heading.
// Where no such curve stays inside the tolerance (a polygon coarser than the
// tolerance), the segment stays the straight line it is and each vertex between
// two such lines gets a fillet arc tangent to both, inside the remaining half
// of the tolerance. These joins keep the corner the planner drew (the
// exceptions, which the switch does not touch):
//   - a vertex where the simplified path turns more than TANGENT_CORNER_DEG
//     (a loop back, a pass meeting a link, a wall corner);
//   - a join with a rapid, a plunge, a lift, a helix, or across a sloped move
//     whose heading turns sharply (no shared planar heading);
//   - a turn too tight for a fillet of minArcRadius within the tolerance (two
//     short lines meeting at 10-30 deg): the lines keep the planner's corner.

interface V2 { x: number; y: number }

/** A fitted line or arc of a run, from a to b, with its headings at both ends. */
interface Primitive {
  a: V2;
  b: V2;
  arc: boolean;
  cx: number;
  cy: number;
  r: number;
  ccw: boolean;
  /** Arc sweep, radians (0 for a line). */
  sweep: number;
  len: number;
  t0: V2;
  t1: V2;
}

interface TangentFitParams {
  arcTolerance: number;
  minArcRadius: number;
  maxArcRadius: number;
}

/** Equal within this, two headings are one heading (radians). */
const HEADING_EPS = 1e-6;

function unitOf(x: number, y: number): V2 | null {
  const l = Math.hypot(x, y);
  return l > 1e-12 ? { x: x / l, y: y / l } : null;
}

/** Signed turn from heading u to heading v, radians (+ = left). */
function turnOf(u: V2, v: V2): number {
  return Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y);
}

function rotate(t: V2, angle: number): V2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: t.x * c - t.y * s, y: t.x * s + t.y * c };
}

function linePrimitive(a: V2, b: V2): Primitive | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const t = unitOf(b.x - a.x, b.y - a.y);
  if (!t) return null;
  return { a, b, arc: false, cx: 0, cy: 0, r: Infinity, ccw: true, sweep: 0, len, t0: t, t1: t };
}

/**
 * The arc that leaves a on heading t and ends at b; a line when b lies straight
 * ahead (or the arc would be flatter than maxArcRadius). Null when b is not
 * ahead of a, or the arc is tighter than minArcRadius.
 */
function tangentPrimitive(a: V2, t: V2, b: V2, p: TangentFitParams): Primitive | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 <= 1e-18) return null;
  const along = dx * t.x + dy * t.y;
  if (along <= 0) return null;
  const side = t.x * dy - t.y * dx;
  if (Math.abs(side) <= 1e-12 * Math.sqrt(d2)) return linePrimitive(a, b);
  // Centre on the normal of t at a, equidistant from a and b.
  const signedR = d2 / (2 * side);
  const r = Math.abs(signedR);
  if (r > p.maxArcRadius) return linePrimitive(a, b);
  if (r < p.minArcRadius) return null;
  const sweep = 2 * Math.atan2(Math.abs(side), along);
  const ccw = side > 0;
  return {
    a,
    b,
    arc: true,
    cx: a.x - signedR * t.y,
    cy: a.y + signedR * t.x,
    r,
    ccw,
    sweep,
    len: r * sweep,
    t0: t,
    t1: rotate(t, ccw ? sweep : -sweep),
  };
}

/**
 * The biarc from (a, t0) to (b, t1): two arcs (or lines) meeting tangent at a
 * joint, the first leaving a on t0, the second arriving at b on t1. The joint is
 * the equal-parameter choice (both control legs of length alpha).
 */
function biarcPrimitives(a: V2, t0: V2, b: V2, t1: V2, p: TangentFitParams): Primitive[] | null {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const vv = vx * vx + vy * vy;
  if (vv <= 1e-18) return null;
  const tx = t0.x + t1.x;
  const ty = t0.y + t1.y;
  const vt = vx * tx + vy * ty;
  const denom = 2 * (1 - (t0.x * t1.x + t0.y * t1.y));
  let alpha: number;
  if (denom < 1e-12) {
    const vt1 = vx * t1.x + vy * t1.y;
    if (vt1 <= 0) return null;
    alpha = vv / (4 * vt1);
  } else {
    alpha = (-vt + Math.sqrt(vt * vt + denom * vv)) / denom;
  }
  if (!(alpha > 0) || !Number.isFinite(alpha)) return null;
  const joint = {
    x: (a.x + alpha * t0.x + b.x - alpha * t1.x) / 2,
    y: (a.y + alpha * t0.y + b.y - alpha * t1.y) / 2,
  };
  const first = tangentPrimitive(a, t0, joint, p);
  if (!first) return null;
  const second = tangentPrimitive(joint, first.t1, b, p);
  if (!second) return null;
  return [first, second];
}

function pointOn(prim: Primitive, u: number): V2 {
  if (!prim.arc) return { x: prim.a.x + prim.t0.x * u, y: prim.a.y + prim.t0.y * u };
  const start = Math.atan2(prim.a.y - prim.cy, prim.a.x - prim.cx);
  const angle = start + (prim.ccw ? u / prim.r : -u / prim.r);
  return { x: prim.cx + prim.r * Math.cos(angle), y: prim.cy + prim.r * Math.sin(angle) };
}

/** Distance from q to the primitive, and the arc length along it of the nearest point. */
function nearestOn(prim: Primitive, q: V2): { d: number; u: number } {
  if (!prim.arc) {
    const u = Math.max(0, Math.min(prim.len, (q.x - prim.a.x) * prim.t0.x + (q.y - prim.a.y) * prim.t0.y));
    return { d: Math.hypot(q.x - prim.a.x - prim.t0.x * u, q.y - prim.a.y - prim.t0.y * u), u };
  }
  const start = Math.atan2(prim.a.y - prim.cy, prim.a.x - prim.cx);
  const angle = Math.atan2(q.y - prim.cy, q.x - prim.cx);
  let rel = prim.ccw ? angle - start : start - angle;
  rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (rel <= prim.sweep) {
    return { d: Math.abs(Math.hypot(q.x - prim.cx, q.y - prim.cy) - prim.r), u: rel * prim.r };
  }
  const da = Math.hypot(q.x - prim.a.x, q.y - prim.a.y);
  const db = Math.hypot(q.x - prim.b.x, q.y - prim.b.y);
  return da <= db ? { d: da, u: 0 } : { d: db, u: prim.len };
}

function segmentDistance(q: V2, a: V2, b: V2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy);
}

/**
 * Is the chain within tol of the dense path pts[s..j], both ways? Every original
 * point must lie within tol of the chain; and the chain, sampled between the
 * places the original points project to (densely enough that an arc cannot bow
 * out between two samples by more than a twentieth of tol), must lie within tol
 * of the original segments around those points.
 */
function chainFits(chain: readonly Primitive[], pts: readonly V2[], s: number, j: number, tol: number): boolean {
  const starts: number[] = [];
  let total = 0;
  let minR = Infinity;
  for (const prim of chain) {
    starts.push(total);
    total += prim.len;
    if (prim.arc) minR = Math.min(minR, prim.r);
  }
  const at = (u: number): V2 => {
    let k = chain.length - 1;
    while (k > 0 && u < starts[k]) k--;
    return pointOn(chain[k], Math.min(chain[k].len, Math.max(0, u - starts[k])));
  };
  const us: number[] = [];
  for (let k = s; k <= j; k++) {
    let best = { d: Infinity, u: 0 };
    chain.forEach((prim, index) => {
      const near = nearestOn(prim, pts[k]);
      if (near.d < best.d) best = { d: near.d, u: starts[index] + near.u };
    });
    if (best.d > tol) return false;
    us.push(k === s ? 0 : k === j ? total : best.u);
  }
  // Between two samples the curve can bow past them by about step^2 / (8 r),
  // here 0.01 * tol, so the samples are held to 0.99 * tol.
  const step = Math.max(1e-3, Math.min(0.25, Number.isFinite(minR) ? Math.sqrt(0.08 * minR * tol) : 0.25));
  const sampleTol = 0.99 * tol;
  for (let k = s; k < j; k++) {
    const lo = Math.min(us[k - s], us[k - s + 1]);
    const hi = Math.max(us[k - s], us[k - s + 1]);
    const count = 3 + Math.ceil((hi - lo) / step);
    const qLo = Math.max(s, k - 1);
    const qHi = Math.min(j - 1, k + 1);
    for (let i = 1; i <= count; i++) {
      const q = at(lo + ((hi - lo) * i) / (count + 1));
      let d = Infinity;
      for (let seg = qLo; seg <= qHi; seg++) d = Math.min(d, segmentDistance(q, pts[seg], pts[seg + 1]));
      if (d > sampleTol) return false;
    }
  }
  return true;
}

/** The heading a planar move leaves its end point on, given where it started. */
function exitHeading(move: ToolpathMove, from: ToolpathMove | undefined): V2 | null {
  if ((move.type === 'arc_cw' || move.type === 'arc_ccw') && move.cx !== undefined && move.cy !== undefined) {
    const rx = move.x - move.cx;
    const ry = move.y - move.cy;
    return move.type === 'arc_ccw' ? unitOf(-ry, rx) : unitOf(ry, -rx);
  }
  if (move.type !== 'feed' || !from) return null;
  return unitOf(move.x - from.x, move.y - from.y);
}

/** The heading a planar move starts on, given where it starts. */
function entryHeading(move: ToolpathMove, from: V2): V2 | null {
  if ((move.type === 'arc_cw' || move.type === 'arc_ccw') && move.cx !== undefined && move.cy !== undefined) {
    const rx = from.x - move.cx;
    const ry = from.y - move.cy;
    return move.type === 'arc_ccw' ? unitOf(-ry, rx) : unitOf(ry, -rx);
  }
  if (move.type !== 'feed') return null;
  return unitOf(move.x - from.x, move.y - from.y);
}

/**
 * WO-3040: the feed runs collapsePolyline fits, fitted tangent-continuous (see
 * the block comment above). Every other move passes through unchanged, as there.
 */
export function fitTangentRuns(moves: readonly ToolpathMove[], params: TangentFitParams): ToolpathMove[] {
  const tol = params.arcTolerance;
  const cornerRad = (TANGENT_CORNER_DEG * Math.PI) / 180;
  const isRunMove = (m: ToolpathMove) => m.type === 'feed' && m.role !== 'helix';
  const out: ToolpathMove[] = [];
  const n = moves.length;
  let i = 0;
  while (i < n) {
    if (!isRunMove(moves[i])) {
      out.push({ ...moves[i] });
      i++;
      continue;
    }
    // Consecutive feed runs (whatever their feed and role) are fitted as one
    // path, so a run arrives on the heading the next one leaves on; a feed or
    // role change is a breakpoint no primitive spans.
    let groupEnd = i;
    while (groupEnd + 1 < n && isRunMove(moves[groupEnd + 1])) groupEnd++;
    let first = i;
    if (out.length === 0) {
      out.push({ ...moves[first] });
      first++;
    }
    // Runs within the tolerance of the Z the tool stands at are fitted as one
    // planar stretch (each run on its own last Z, as collapsePolyline puts it),
    // as are moves exactly on that Z; a move that changes Z (a ramp, a step
    // down) passes through unchanged and the fit resumes on its new plane.
    let q = first;
    while (q <= groupEnd) {
      const z0 = out[out.length - 1].z;
      let qEnd = q - 1;
      while (qEnd < groupEnd) {
        let rEnd = qEnd + 1;
        while (rEnd < groupEnd && sameRun(moves[rEnd + 1], moves[qEnd + 1])) rEnd++;
        if (!moves.slice(qEnd + 1, rEnd + 1).every(rm => Math.abs(rm.z - z0) <= tol)) break;
        qEnd = rEnd;
      }
      while (qEnd < groupEnd && Math.abs(moves[qEnd + 1].z - z0) <= 1e-9) qEnd++;
      if (qEnd < q) {
        out.push({ ...moves[q] });
        q++;
        continue;
      }
      fitPlanar(moves.slice(q, qEnd + 1), moves[qEnd + 1]);
      q = qEnd + 1;
    }
    i = groupEnd + 1;
  }
  return out;

  function sameRun(a: ToolpathMove, b: ToolpathMove): boolean {
    return a.feed === b.feed && a.role === b.role;
  }

  function fitPlanar(runMoves: ToolpathMove[], next: ToolpathMove | undefined): void {
    const anchor = out[out.length - 1];
    // Each run is put on its own last Z, as collapsePolyline puts it.
    const runZ = new Map<ToolpathMove, number>();
    for (let k = runMoves.length - 1; k >= 0; k--) {
      const later = k + 1 < runMoves.length && sameRun(runMoves[k + 1], runMoves[k]) ? runZ.get(runMoves[k + 1]) : undefined;
      runZ.set(runMoves[k], later ?? runMoves[k].z);
    }
    // The distinct points (a zero-length move has no heading), each with the
    // move that arrives at it, whose feed and role the fit keeps.
    const dense: V2[] = [{ x: anchor.x, y: anchor.y }];
    const owner: ToolpathMove[] = [runMoves[0]];
    for (const rm of runMoves) {
      const prev = dense[dense.length - 1];
      if (Math.hypot(rm.x - prev.x, rm.y - prev.y) > 1e-9) {
        dense.push({ x: rm.x, y: rm.y });
        owner.push(rm);
      }
    }
    if (dense.length < 2) {
      for (const rm of runMoves) out.push({ ...rm });
      return;
    }
    // The fit works on the Douglas-Peucker selection of the dense path at half
    // the tolerance (the planner's micro-steps and wobble are not corners),
    // simplified run by run so every feed or role change is a vertex; every
    // curve it fits is judged against the dense path itself. The other half of
    // the tolerance is the fillets' (see below).
    const simplifyEps = 0.5 * tol;
    const vIdx: number[] = [0];
    let from = 0;
    for (let k = 1; k < dense.length; k++) {
      if (k + 1 < dense.length && sameRun(owner[k + 1], owner[k])) continue;
      const kept = douglasPeuckerIndexed(dense.slice(from, k + 1), simplifyEps);
      for (const index of kept.slice(1)) vIdx.push(from + index);
      from = k;
    }
    const pts = vIdx.map(k => dense[k]);
    const last = pts.length - 1;
    // The move whose feed and role segment q keeps, and the run breaks.
    const segOwner = vIdx.slice(1).map(k => owner[k]);
    const runBreak: boolean[] = new Array(last + 1).fill(false);
    for (let k = 1; k < last; k++) runBreak[k] = !sameRun(segOwner[k - 1], segOwner[k]);

    // Each segment's heading. A smooth vertex passes on one heading, the
    // chord-length weighted blend of its two segments (the tangent of the
    // circle through it and its neighbours).
    const seg: V2[] = [];
    const segLen: number[] = [];
    for (let k = 0; k < last; k++) {
      seg.push(unitOf(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y)!);
      segLen.push(Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y));
    }
    const blend = (u: V2, lu: number, v: V2, lv: number): V2 =>
      unitOf(u.x * lv + v.x * lu, u.y * lv + v.y * lu) ?? v;
    // A vertex that turns more than TANGENT_CORNER_DEG is a corner the planner
    // drew; it keeps its corner, and no fitted primitive spans it.
    const hard: boolean[] = new Array(last + 1).fill(false);
    for (let k = 1; k < last; k++) hard[k] = Math.abs(turnOf(seg[k - 1], seg[k])) > cornerRad;
    hard[last] = true;
    // Start: on the heading the move before the stretch left on, when the path
    // turns smoothly there; else on the first segment (a corner, or no heading).
    const before = exitHeading(anchor, out[out.length - 2]);
    const beforeShared = before !== null && Math.abs(turnOf(before, seg[0])) <= cornerRad;
    let startHeading = beforeShared ? before : seg[0];
    let startShared = beforeShared;
    // End: arrive on the heading the move after the stretch starts on, when the
    // path turns smoothly there (a move this fit does not change).
    let endHeading = seg[last - 1];
    let endMatched = false;
    if (next !== undefined && next.role !== 'helix') {
      const nextHeading = entryHeading(next, pts[last]);
      if (nextHeading !== null && Math.abs(turnOf(seg[last - 1], nextHeading)) <= cornerRad) {
        endHeading = nextHeading;
        endMatched = true;
      }
    }
    // A closed ring with nothing to share at its start (it is entered from
    // above or across a corner) closes on one heading through its seam.
    const closed = last >= 3 && Math.hypot(pts[last].x - pts[0].x, pts[last].y - pts[0].y) <= 1e-9;
    if (closed && !beforeShared && !endMatched && Math.abs(turnOf(seg[last - 1], seg[0])) <= cornerRad) {
      startHeading = endHeading = blend(seg[last - 1], segLen[last - 1], seg[0], segLen[0]);
      endMatched = true;
      startShared = true;
    }

    // Where the dense path is a polygon coarser than the tolerance (its turn at
    // each vertex bows any arc through the vertices past the tolerance off its
    // chords), a segment is kept as the straight line it is and each vertex
    // between two such lines is rounded by a fillet arc tangent to both, inside
    // the corner and within the tolerance of it. straight[q]: segment q is such a
    // line. A vertex beside one straight segment takes that segment's heading,
    // so the fitted curve on its other side arrives on (or leaves along) the line.
    const straight: boolean[] = new Array(last).fill(false);
    const tinAt = (k: number): V2 => {
      if (k === last) return straight[last - 1] ? seg[last - 1] : endHeading;
      if (hard[k] || straight[k - 1]) return seg[k - 1];
      if (straight[k]) return seg[k];
      return blend(seg[k - 1], segLen[k - 1], seg[k], segLen[k]);
    };
    const toutAt = (k: number): V2 => {
      if (k === 0) return straight[0] ? seg[0] : startHeading;
      if (hard[k] || straight[k]) return seg[k];
      if (straight[k - 1]) return seg[k - 1];
      return blend(seg[k - 1], segLen[k - 1], seg[k], segLen[k]);
    };
    // A primitive ending at j arrives exactly on tinAt(j), except at a corner
    // or at a stretch end nothing follows on a shared heading. (Arriving on the
    // heading the next stretch was judged from keeps every later fit possible.)
    const freeAt = (j: number): boolean => (j === last ? !endMatched || straight[last - 1] : hard[j]);

    const inflects = (s: number, j: number): boolean => {
      let sign = 0;
      for (let k = Math.max(1, s); k <= Math.min(last - 1, j); k++) {
        const turn = turnOf(seg[k - 1], seg[k]);
        if (Math.abs(turn) <= 1e-9) continue;
        if (sign !== 0 && Math.sign(turn) !== sign) return true;
        sign = Math.sign(turn);
      }
      return false;
    };
    // roam: inside a smooth stretch one arc may also end on its own heading,
    // when the next segment can still be followed from there (so the walk
    // always has a next step) - fewer moves than a biarc to the path's heading.
    const fitTo = (s: number, start: V2, j: number, roam = false): Primitive[] | null => {
      const target = tinAt(j);
      const single = tangentPrimitive(pts[s], start, pts[j], params);
      if (single && chainFits([single], dense, vIdx[s], vIdx[j], tol)) {
        if (freeAt(j) || Math.abs(turnOf(single.t1, target)) <= HEADING_EPS) return [single];
        if (roam && j < last && !hard[j] && !straight[j] && fitTo(j, single.t1, j + 1)) return [single];
      }
      const pair = biarcPrimitives(pts[s], start, pts[j], target, params);
      // An S (two arcs turning opposite ways) only where the path itself turns
      // both ways; elsewhere it would add a wiggle the planner never drew.
      const wiggle = pair !== null && pair[0].arc && pair[1].arc && pair[0].ccw !== pair[1].ccw && !inflects(s, j);
      if (pair && !wiggle && chainFits(pair, dense, vIdx[s], vIdx[j], tol)) return pair;
      return null;
    };

    // Mark the segments no tangent curve can follow on its own. Making one
    // straight changes its neighbours' end headings, so they are judged again.
    const pending: number[] = [];
    for (let k = last - 1; k >= 0; k--) pending.push(k);
    while (pending.length > 0) {
      const k = pending.pop()!;
      if (straight[k] || fitTo(k, toutAt(k), k + 1)) continue;
      straight[k] = true;
      if (k > 0) pending.push(k - 1);
      if (k + 1 < last) pending.push(k + 1);
    }

    // The fillet at a vertex between two straight segments: tangent length d
    // along each, at most half of either segment, and set so the arc passes no
    // further inside the vertex (d * tan(turn / 4)) than the half of the
    // tolerance the simplification left: the line is within simplifyEps of the
    // dense path, the fillet within the rest of the line. A vertex where the
    // feed or role changes gets none: a fillet would move the change off the
    // vertex and carry one run's feed into the other, so it stays sharp.
    const filletD: number[] = new Array(last + 1).fill(0);
    for (let k = 1; k < last; k++) {
      if (hard[k] || runBreak[k] || !straight[k - 1] || !straight[k]) continue;
      const turn = Math.abs(turnOf(seg[k - 1], seg[k]));
      if (turn <= 1e-12) continue;
      const d = Math.min(segLen[k - 1] / 2, segLen[k] / 2, (tol - simplifyEps) / Math.tan(turn / 4));
      if (d / Math.tan(turn / 2) >= params.minArcRadius) filletD[k] = d;
    }

    const emit = (prim: Primitive, k: number) => {
      const { feed, role } = segOwner[k];
      const z = runZ.get(segOwner[k])!;
      out.push(prim.arc
        ? { type: prim.ccw ? 'arc_ccw' : 'arc_cw', x: prim.b.x, y: prim.b.y, z, cx: prim.cx, cy: prim.cy, feed, role }
        : { type: 'feed', x: prim.b.x, y: prim.b.y, z, feed, role });
    };

    let s = 0;
    let heading = toutAt(0);
    let at: V2 = pts[0];
    while (s < last) {
      if (straight[s]) {
        // The line, shortened by the fillets at its ends, then the fillet at its
        // end (kept with this segment's feed and role).
        const d = filletD[s + 1];
        const end = { x: pts[s + 1].x - seg[s].x * d, y: pts[s + 1].y - seg[s].y * d };
        const line = linePrimitive(at, end);
        if (line) emit(line, s);
        at = end;
        s++;
        heading = seg[s - 1];
        if (d > 0) {
          const arc = tangentPrimitive(at, seg[s - 1], { x: pts[s].x + seg[s].x * d, y: pts[s].y + seg[s].y * d }, params);
          if (arc) {
            emit(arc, s - 1);
            at = arc.b;
            heading = arc.t1;
          } else {
            emit(linePrimitive(at, pts[s])!, s - 1);
            at = pts[s];
            heading = seg[s];
          }
        } else if (s < last) {
          heading = toutAt(s);
        }
        continue;
      }
      // A smooth stretch runs to the next corner, run break, straight segment
      // or the end.
      let stop = s + 1;
      while (stop < last && !hard[stop] && !runBreak[stop] && !straight[stop]) stop++;
      // After a corner (or at a start nothing leads into) the heading is free:
      // besides the segment's own, try the chord's and the tangent of the
      // circle through the dense points, as collapsePolyline would fit them.
      const startFree = s === 0 ? !startShared : hard[s];
      const startsFor = (j: number): V2[] => {
        if (!startFree) return [heading];
        const options = [heading, seg[s]];
        const chord = unitOf(pts[j].x - pts[s].x, pts[j].y - pts[s].y);
        if (chord) options.push(chord);
        const circle = fitCircleEndpointLocked(dense.slice(vIdx[s], vIdx[j] + 1));
        if (circle) {
          const rx = pts[s].x - circle.cx;
          const ry = pts[s].y - circle.cy;
          const along = unitOf(-ry, rx);
          if (along) options.push(along.x * seg[s].x + along.y * seg[s].y >= 0 ? along : { x: -along.x, y: -along.y });
        }
        return options;
      };
      let best: { j: number; chain: Primitive[] } | null = null;
      let misses = 0;
      for (let j = s + 1; j <= stop; j++) {
        let chain: Primitive[] | null = null;
        for (const start of startsFor(j)) if (!chain) chain = fitTo(s, start, j, j < stop);
        if (chain) {
          best = { j, chain };
          misses = 0;
        } else if (++misses >= 2) break;
      }
      // Never reached (each segment was judged fittable from this heading
      // above); kept so a numerical surprise degrades to the path as drawn.
      if (!best) best = { j: s + 1, chain: [linePrimitive(pts[s], pts[s + 1])!] };
      for (const prim of best.chain) emit(prim, s);
      s = best.j;
      at = pts[s];
      heading = hard[s] && s < last ? seg[s] : best.chain[best.chain.length - 1].t1;
    }
  }
}
