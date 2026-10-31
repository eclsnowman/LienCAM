import type { ToolpathMove, Vec2 } from '../../../types'
import { fitCircleEndpointLocked, sweepAngle } from './circleFit'
import { douglasPeuckerIndexed, orderedSegmentDeviation } from './simplify'

/**
 * Tuning parameters for {@link collapsePolyline} (R3 sections 3.4 / 3.5).
 */
export interface CollapseParams {
  /** Max chordal / radial deviation a collapsed primitive may introduce (mm). */
  arcTolerance: number
  /** Arcs fitted tighter than this radius (mm) stay as lines. */
  minArcRadius: number
  /** Arcs fitted larger than this radius (mm) become lines (caller passes ~1e4). */
  maxArcRadius: number
  /** Arcs sweeping less than this (deg) become lines (caller passes ~2). */
  minSweepDeg: number
}

/**
 * Is this move a candidate member of a collapsible feed run?
 *
 * Per R3 3.4 a collapsible run is consecutive plain feed cuts: type 'feed',
 * not a helix (helix is XY+Z and is never flattened into an XY arc), with a
 * matching feed and role to its run-mates. Rapids and pre-existing arcs are
 * always boundaries.
 */
function isCollapsibleFeed(m: ToolpathMove): boolean {
  return m.type === 'feed' && m.role !== 'helix'
}

/** Do two feed moves belong to the same run (equal feed AND equal role)? */
function sameRun(a: ToolpathMove, b: ToolpathMove): boolean {
  return a.feed === b.feed && a.role === b.role
}

/**
 * Signed winding of a point run about a fitted center.
 *
 * Sums the z-component of the cross product of consecutive radius vectors
 * (point - center). Positive total => counter-clockwise, negative => clockwise.
 * This determines both the emitted move `type` (arc_ccw / arc_cw) and the dir
 * passed to sweepAngle (R3 3.4 arc construction).
 */
function windingSign(pts: Vec2[], cx: number, cy: number): number {
  let sum = 0
  for (let k = 0; k + 1 < pts.length; k++) {
    const ax = pts[k].x - cx
    const ay = pts[k].y - cy
    const bx = pts[k + 1].x - cx
    const by = pts[k + 1].y - cy
    sum += ax * by - ay * bx
  }
  return sum
}

/**
 * Worst distance of the original PATH sub[0..n-1] from a candidate arc on circle
 * (cx, cy, r), leaving sub[0] in `dir` and sweeping `sweep` radians (WO-3205).
 *
 * Two parts, together the exact worst distance for a run that turns one way:
 *  - each vertex against the ARC, walked in traversal order: its place on the
 *    arc is its own angle clamped into the sweep and never behind the previous
 *    vertex's place, so a vertex past either end, or one stepping back along
 *    the circle, measures the move that would replace it;
 *  - each straight segment between consecutive vertices bulges INWARD of the
 *    circle most where it passes nearest the centre (r - that distance). Its
 *    outward reach is largest at a vertex (distance from the centre is convex
 *    along a line), which the first part already covers.
 * The old measure took the minor-arc sagitta assuming the vertices lay ON the
 * circle, so a vertex inside the circle stacked its own deviation on the
 * sagitta and the posted arc left the path by more than arcTolerance.
 *
 * @returns the worst distance (>= 0); 0 for fewer than 2 points
 */
function arcPathDeviation(sub: Vec2[], cx: number, cy: number, r: number, dir: 'cw' | 'ccw', sweep: number): number {
  const a0 = Math.atan2(sub[0].y - cy, sub[0].x - cx)
  const turn = dir === 'ccw' ? 1 : -1
  let progress = 0
  let worst = 0
  for (let k = 1; k < sub.length; k++) {
    const p = sub[k]
    let phi = sweepAngle(sub[0], p, cx, cy, dir)
    // Outside the sweep: the nearer arc end (just past the end, or just behind the start).
    if (phi > sweep) phi = phi - sweep < 2 * Math.PI - phi ? sweep : 0
    progress = Math.max(progress, phi)
    const th = a0 + turn * progress
    const onArc = Math.hypot(p.x - (cx + r * Math.cos(th)), p.y - (cy + r * Math.sin(th)))
    if (onArc > worst) worst = onArc
    const q = sub[k - 1]
    const ex = p.x - q.x
    const ey = p.y - q.y
    const lenSq = ex * ex + ey * ey
    const u = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((cx - q.x) * ex + (cy - q.y) * ey) / lenSq))
    const inward = r - Math.hypot(q.x + u * ex - cx, q.y + u * ey - cy)
    if (inward > worst) worst = inward
  }
  return worst
}

/**
 * Collapse contiguous straight-feed runs of a toolpath into the minimal set of
 * line and circular-arc moves within a chordal tolerance (R3 sections 3.4 /3.5).
 *
 * The function is PURE: input moves are never mutated; a fresh array is built.
 *
 * Walk strategy:
 *  1. Group consecutive collapsible feed moves (type 'feed', non-helix role,
 *     matching feed + role) into runs. Every other move (rapid, existing arc,
 *     helix, or a feed whose feed/role differs) is a BOUNDARY: emitted as-is,
 *     and its endpoint anchors the next run.
 *  2. A run of K moves spans K+1 points: [anchor, ...run endpoints]. The anchor
 *     is the endpoint of the last emitted move. A run with no predecessor (run
 *     at index 0) has no anchor point carried in the move stream, so its first
 *     move is emitted as-is and becomes the anchor; the run begins after it.
 *  3. Z-plane guard: arcs are XY-only in v1. If z varies across the run by more
 *     than arcTolerance the run is emitted unchanged (declared policy per ADR
 *     0003 -- no silent geometry change).
 *  4. Runs spanning fewer than 3 points are emitted unchanged.
 *  5. Otherwise a DP pre-pass at 0.5*arcTolerance selects CANDIDATE breakpoint
 *     indices into the original points, then a greedy expanding-window walk
 *     emits the longest line or longest arc (<=180deg, radius in
 *     [minArcRadius, maxArcRadius], sweep >= minSweepDeg) from each position.
 *     CRITICAL (R3 3.5): line/arc acceptance is measured against EVERY original
 *     point the primitive spans (not just the DP-kept subset), so a point DP
 *     dropped (up to 0.5*tol off its chord) can never end up beyond arcTolerance
 *     of the emitted primitive. Whichever primitive reaches further wins; ties
 *     and any doubt favor the line (always safe).
 *
 * Invariants (WO-3205: measured to the fitted SEGMENT or ARC, in traversal
 * order, never to an infinite line or a whole circle): no emitted primitive
 * deviates more than arcTolerance from ANY original point it replaces, AND (for
 * arcs) no more than arcTolerance from the straight PATH between any pair of
 * consecutive original points it spans -- so a sparse run of long segments
 * meeting at a corner is never mis-fit as an arc (vertices-on-circle alone is
 * insufficient: any 3 points define a perfect circle); a reversal along a line
 * or a circle larger than arcTolerance is kept; no arc exceeds 180deg (a full
 * circle naturally splits into multiple <=180deg arcs); emitted endpoints are
 * exact original points (the DP-kept breakpoints).
 *
 * @param moves the source toolpath (not mutated)
 * @param params collapse tolerances
 * @returns a new toolpath with straight-feed runs collapsed
 */
export function collapsePolyline(moves: ToolpathMove[], params: CollapseParams): ToolpathMove[] {
  const { arcTolerance, minArcRadius, maxArcRadius, minSweepDeg } = params
  const minSweepRad = (minSweepDeg * Math.PI) / 180

  const out: ToolpathMove[] = []
  const n = moves.length
  let i = 0

  while (i < n) {
    const m = moves[i]

    // Non-collapsible move: emit unchanged, advance. It anchors the next run.
    if (!isCollapsibleFeed(m)) {
      out.push({ ...m })
      i++
      continue
    }

    // Start of a collapsible feed run: gather maximal matching span.
    const runStart = i
    let runEnd = i // inclusive index of last move in the run
    while (runEnd + 1 < n && isCollapsibleFeed(moves[runEnd + 1]) && sameRun(moves[runStart], moves[runEnd + 1])) {
      runEnd++
    }
    const run = moves.slice(runStart, runEnd + 1)
    const feed = run[0].feed
    const role = run[0].role

    // Determine the anchor point. The anchor is the endpoint of the last
    // emitted move. With no predecessor (run at index 0 with empty output),
    // there is no anchor in the move stream: emit the run's first move as-is,
    // let its endpoint become the anchor, and begin the run after it.
    let anchor: ToolpathMove
    let runMoves = run
    if (out.length > 0) {
      anchor = out[out.length - 1]
    } else {
      anchor = { ...run[0] }
      out.push({ ...run[0] })
      runMoves = run.slice(1)
    }

    // Z-plane guard (R3 3.4): XY-only arcs. Reject z-varying runs explicitly.
    let zVaries = false
    for (const rm of runMoves) {
      if (Math.abs(rm.z - anchor.z) > arcTolerance) {
        zVaries = true
        break
      }
    }

    // Build the candidate point set: [anchor, ...run endpoints].
    const pts: Vec2[] = [{ x: anchor.x, y: anchor.y }]
    for (const rm of runMoves) pts.push({ x: rm.x, y: rm.y })

    const emitOriginal = () => {
      for (const rm of runMoves) out.push({ ...rm })
    }

    if (zVaries || pts.length < 3) {
      emitOriginal()
      i = runEnd + 1
      continue
    }

    // The z plane is effectively constant across the run (within tolerance);
    // every collapsed move ends on the run's final z.
    const planeZ = runMoves[runMoves.length - 1].z

    // DP pre-pass at half the tolerance selects CANDIDATE breakpoint indices
    // into the ORIGINAL points. The simplified subset is only a breakpoint
    // selector; acceptance below is always measured against original points.
    const keptIdx = douglasPeuckerIndexed(pts, 0.5 * arcTolerance)

    if (keptIdx.length < 3) {
      // Nothing left to fit beyond a single straight chord; DP collapsed the
      // whole run to its endpoints. Validate that the chord from the first to
      // the last original point still covers every original point within
      // tolerance (DP at 0.5*tol guarantees this), then emit one line.
      out.push({
        type: 'feed',
        x: pts[keptIdx[keptIdx.length - 1]].x,
        y: pts[keptIdx[keptIdx.length - 1]].y,
        z: planeZ,
        feed,
        role,
      })
      i = runEnd + 1
      continue
    }

    // Greedy expanding-window collapse. s and j are POSITIONS in keptIdx; the
    // primitive endpoints are original points pts[keptIdx[s]]..pts[keptIdx[j]],
    // and acceptance is measured over the ORIGINAL span between those indices.
    let s = 0
    const sn = keptIdx.length
    while (s < sn - 1) {
      // Longest line from s: chord deviation over EVERY original point spanned.
      let jLine = s + 1
      for (let j = s + 2; j < sn; j++) {
        if (orderedSegmentDeviation(pts, keptIdx[s], keptIdx[j]).dist <= arcTolerance) {
          jLine = j
        } else {
          break
        }
      }

      // Longest arc from s: fit and validate over the ORIGINAL span.
      let jArc = -1
      let arcCx = 0
      let arcCy = 0
      let arcType: 'arc_cw' | 'arc_ccw' = 'arc_ccw'
      for (let j = s + 2; j < sn; j++) {
        // Original points spanned by candidate endpoints keptIdx[s..j]. The
        // centre is LOCKED onto the perpendicular bisector of the span's own
        // start/end (WO-1384): an unconstrained algebraic fit can pass every
        // point's individual radial-deviation check while the emitted start
        // and end radii still disagree with EACH OTHER by up to ~2x the
        // tolerance budget once the controller recomputes them from X/Y/I/J.
        // A centre on the bisector makes start radius == end radius exactly,
        // by construction, so that failure mode cannot occur.
        const sub = pts.slice(keptIdx[s], keptIdx[j] + 1)
        const fit = fitCircleEndpointLocked(sub)
        if (!fit) break
        if (fit.r < minArcRadius || fit.r > maxArcRadius) break
        const sign = windingSign(sub, fit.cx, fit.cy)
        const dir: 'cw' | 'ccw' = sign >= 0 ? 'ccw' : 'cw'
        const sweep = sweepAngle(pts[keptIdx[s]], pts[keptIdx[j]], fit.cx, fit.cy, dir)
        if (sweep > Math.PI + 1e-9) break // full-circle guard: cap at 180deg
        // Vertices lying on the circle is NOT enough: any 3 points define a
        // perfect circle, so a sharp corner of long straight edges would pass
        // a radial check and collapse into a hugely bulging arc. The arc must
        // track the straight PATH between consecutive points, in order, and a
        // vertex's own radial error counts on top of its chords' bulge (WO-3205).
        if (arcPathDeviation(sub, fit.cx, fit.cy, fit.r, dir, sweep) > arcTolerance) break
        if (sweep < minSweepRad) {
          // Too small to be worth an arc yet; keep growing in case a larger
          // window crosses the threshold while staying valid.
          continue
        }
        jArc = j
        arcCx = fit.cx
        arcCy = fit.cy
        arcType = dir === 'ccw' ? 'arc_ccw' : 'arc_cw'
      }

      if (jArc > jLine) {
        out.push({
          type: arcType,
          x: pts[keptIdx[jArc]].x,
          y: pts[keptIdx[jArc]].y,
          z: planeZ,
          cx: arcCx,
          cy: arcCy,
          feed,
          role,
        })
        s = jArc
      } else {
        out.push({
          type: 'feed',
          x: pts[keptIdx[jLine]].x,
          y: pts[keptIdx[jLine]].y,
          z: planeZ,
          feed,
          role,
        })
        s = jLine
      }
    }

    i = runEnd + 1
  }

  return out
}
