// Spline tool (basic interpolating Catmull-Rom, item C4): a MULTI-CLICK tool
// that accumulates through-points and FINISHES on Enter / double-click.
//
// Same pure-machine contract as toolMachine.ts: clicks advance the chain (no
// document mutation here); the finish gesture builds the ToolCommit. Modeled
// on the line/polyline chain (point accumulation) but, unlike the line tool,
// it commits ONE entity at the end rather than a segment per click -- so the
// commit happens through splineFinish (the store's sketchToolEnd), not a
// click.
//
// The committed entity is SOLVER-INERT (types.ts): a fresh spline carries its
// drawn through-points and only its first point participates in later
// constraints, so nothing solver-specific happens at finish time.
//
// CONTROL-POINT SPLINE (WO-1861, tool 'spline-control'): the SAME chain and
// gestures, with `form: 'control'` carried on the chain -- the clicks place
// control points, the preview and the committed entity read them as a B-spline
// control polygon (spline.ts). Close-on-start, Enter / double-click and the
// "Close loop" toggle behave exactly as for the through-point tool.
//
// BEZIER (WO-1862, tool 'bezier'): the pen-tool gesture every illustration
// program uses. PRESS places an anchor, DRAG pulls out its handle, RELEASE
// sets it: the out-handle is where the pointer let go and the in-handle is
// its mirror through the anchor, so the joint is smooth. A press released on
// the spot places a corner anchor with zero-length handles (a straight run --
// drawn, never refused). The viewport records the press on the chain
// (`press`) and the release arrives as an ordinary click, so the release
// point IS the handle. Chain layout: anchor, out-handle, in-handle, anchor,
// out-handle, ... -- it always ends on the last anchor's out-handle, which
// the open commit drops. Close-on-start, Enter / double-click and the "Close
// loop" toggle behave as for the other spline tools.
//
// CONIC ARC (WO-1863, tool 'conic'): three clicks -- start, end, then the
// apex where the two end tangents meet -- commit one spline of form 'conic'
// drawn at the toolbox rho (spline.ts stores it as start, apex, shoulder,
// end). Its own chain kind, so Enter never finishes a half-placed conic as a
// spline.

import type { Vec2, SketchSplineEntity } from '../types'
import type { ToolCommit } from './toolMachine'
import {
  tessellateSpline, SPLINE_TESS_STEP_MM, splineHandleLegs, conicClampRho, conicPoints,
} from '../spline'

/** In-progress spline (chain payload). */
export interface SplineChainState {
  kind: 'spline'
  /** Through-points placed so far (>= 1 once the chain has started). The
   *  curve interpolates each; points[0] is the constrainable anchor. For a
   *  control-point chain these are the control points; for a bezier chain the
   *  anchors and handles in order, ending on the last anchor's out-handle
   *  (empty while the very first press is still held). */
  points: Vec2[]
  /** 'control' = the control-point spline tool (WO-1861); 'bezier' = the
   *  bezier tool (WO-1862); absent = the through-point tool. */
  form?: 'control' | 'bezier'
  /** Bezier only: smooth flag per placed anchor (a dragged anchor is smooth,
   *  a stationary click a corner). */
  smooth?: boolean[]
  /** Bezier only: where the held press placed the next anchor; the release
   *  click reads its own point as that anchor's handle. */
  press?: Vec2
}

export interface SplineClickResult {
  chain: SplineChainState | null
  commit: ToolCommit | null
}

/** Minimum through-points a spline needs to commit (a 2-point spline is a
 *  single straight Catmull-Rom segment). */
export const SPLINE_MIN_POINTS = 2

/**
 * Click behavior: the first click anchors the chain; each further click
 * appends a through-point. A click within `closeTol` of the LAST placed point
 * is ignored (zero-length guard -- also absorbs the second click of the
 * finishing double-click, mirroring the line tool).
 *
 * CLOSE-ON-START (discoverable open/closed, mirrors the line/polyline tool's
 * close-on-start): once the chain has >= 3 through-points, a click within
 * `closeTol` of the START point (points[0]) FINISHES the spline as CLOSED --
 * forcing closed=true regardless of the toolbox "Close loop" toggle -- and
 * clears the chain. Building the commit needs the construction flag + an id
 * factory; when `newId` is omitted (legacy callers / accumulation-only unit
 * tests) the start-click simply appends like any other point, so the
 * open-draw path stays byte-identical. Any other click NEVER commits; the
 * spline otherwise finishes on Enter / double-click via splineFinish.
 */
export function splineClick(
  chain: SplineChainState | null,
  world: Vec2,
  closeTol: number,
  construction = false,
  newId?: () => string,
  form?: 'control',
): SplineClickResult {
  if (!chain) {
    return {
      chain: { kind: 'spline', points: [{ x: world.x, y: world.y }], ...(form ? { form } : {}) },
      commit: null,
    }
  }
  const last = chain.points[chain.points.length - 1]
  if (Math.hypot(world.x - last.x, world.y - last.y) <= closeTol) {
    return { chain, commit: null }
  }
  // Close-on-start: >= 3 points and a click on the anchor closes the loop.
  if (newId && chain.points.length >= 3) {
    const start = chain.points[0]
    if (Math.hypot(world.x - start.x, world.y - start.y) <= closeTol) {
      // >= 3 points >= SPLINE_MIN_POINTS, so this always commits.
      const commit = splineFinish(chain, construction, newId, true)
      return { chain: null, commit }
    }
  }
  return {
    chain: { ...chain, points: [...chain.points, { x: world.x, y: world.y }] },
    commit: null,
  }
}

/**
 * True when a click at `cursor` would CLOSE the in-progress spline on the
 * start point (>= 3 placed points and within `closeTol` of points[0]). Pure
 * predicate shared by the live preview (close feedback) and callers that want
 * to hint the gesture; the actual close happens in splineClick.
 */
export function splineWouldCloseOnStart(
  chain: SplineChainState, cursor: Vec2, closeTol: number,
): boolean {
  if (closeTol <= 0 || chain.points.length < 3) return false
  const start = chain.points[0]
  return Math.hypot(cursor.x - start.x, cursor.y - start.y) <= closeTol
}

/**
 * Finish the chain (Enter / double-click): commit the accumulated through-
 * points as ONE solver-inert spline, or null when fewer than
 * SPLINE_MIN_POINTS were placed (the chain is then discarded). `closed`
 * (toolbox "Close loop" toggle) makes the curve wrap back to points[0];
 * default OPEN so existing behavior is unchanged unless the user opts in.
 */
export function splineFinish(
  chain: SplineChainState, construction: boolean, newId: () => string,
  closed = false,
): ToolCommit | null {
  if (chain.form === 'bezier') return bezierFinish(chain, construction, newId, closed)
  if (chain.points.length < SPLINE_MIN_POINTS) return null
  const entity: SketchSplineEntity = {
    id: newId(),
    kind: 'spline',
    construction,
    points: chain.points.map((p) => ({ x: p.x, y: p.y })),
    closed,
    ...(chain.form === 'control' ? { form: 'control' as const } : {}),
  }
  return { entities: [entity], constraints: [] }
}

/**
 * Preview polyline: the EXACT spline through the placed points plus the live
 * cursor as a provisional last through-point (preview == what the next click
 * would extend). A single placed point rubber-bands a straight line to the
 * cursor. `closed` mirrors the toolbox "Close loop" toggle so the preview
 * wraps back to points[0] exactly as the commit will.
 *
 * CLOSE-ON-START FEEDBACK: when `closeTol` > 0 and hovering the start point
 * would close the loop (splineWouldCloseOnStart), the preview instead shows
 * the CLOSED curve through the PLACED points (no provisional cursor point),
 * so the rubber band visibly snaps shut -- the user SEES that clicking here
 * closes the spline. This mirrors what the close-on-start click will commit.
 */
export function splinePreview(
  chain: SplineChainState, cursor: Vec2, closed = false, closeTol = 0,
): Vec2[] | null {
  if (splineWouldCloseOnStart(chain, cursor, closeTol)) {
    return tessellateSpline(chain.points, true, SPLINE_TESS_STEP_MM, chain.form)
  }
  const pts = [...chain.points, { x: cursor.x, y: cursor.y }]
  if (pts.length < 2) return null
  return tessellateSpline(pts, closed, SPLINE_TESS_STEP_MM, chain.form)
}

/**
 * Control polygon of an in-progress CONTROL-POINT chain with the live cursor
 * as its provisional last point (or snapped shut when the click would close
 * on the start point), so the operator sees what each control point pulls
 * on while placing them. Null for a through-point chain.
 */
export function splineControlPolygonPreview(
  chain: SplineChainState, cursor: Vec2, closed = false, closeTol = 0,
): Vec2[] | null {
  if (chain.form !== 'control') return null
  if (splineWouldCloseOnStart(chain, cursor, closeTol)) {
    return [...chain.points.map((p) => ({ x: p.x, y: p.y })), { ...chain.points[0] }]
  }
  const pts = [...chain.points.map((p) => ({ x: p.x, y: p.y })), { x: cursor.x, y: cursor.y }]
  if (closed && pts.length > 2) pts.push({ ...pts[0] })
  return pts
}

// ---- Bezier tool (WO-1862) ----------------------------------------------------

const copy = (p: Vec2): Vec2 => ({ x: p.x, y: p.y })
const mirror = (a: Vec2, h: Vec2): Vec2 => ({ x: 2 * a.x - h.x, y: 2 * a.y - h.y })
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Anchors placed so far on a bezier chain (points = 3k - 1 for k anchors). */
export function bezierChainAnchorCount(chain: SplineChainState): number {
  return chain.points.length === 0 ? 0 : (chain.points.length + 1) / 3
}

/** The chain's last placed anchor (null before the first release). */
function lastAnchor(chain: SplineChainState): Vec2 | null {
  return chain.points.length >= 2 ? chain.points[chain.points.length - 2] : null
}

/** The press is held: remember where it placed the next anchor. Starts the
 *  chain when this is the tool's first press. */
export function bezierPress(chain: SplineChainState | null, at: Vec2): SplineChainState {
  if (!chain) return { kind: 'spline', form: 'bezier', points: [], smooth: [], press: copy(at) }
  return { ...chain, press: copy(at) }
}

/** points[0]'s in-handle when the chain closes: the mirror of its out-handle
 *  at a smooth start, the anchor itself at a corner start. */
function closingInHandle(chain: SplineChainState): Vec2 {
  const a0 = chain.points[0]
  return chain.smooth?.[0] ? mirror(a0, chain.points[1]) : copy(a0)
}

/** The committed bezier entity for a chain (open drops the trailing
 *  out-handle; closed appends points[0]'s in-handle so the last segment runs
 *  home). */
function bezierEntity(
  points: Vec2[], smooth: boolean[], closed: boolean, construction: boolean, newId: () => string,
): SketchSplineEntity {
  return {
    id: newId(), kind: 'spline', construction, closed, form: 'bezier',
    points: points.map(copy), smooth: [...smooth],
  }
}

/**
 * Release of a bezier press (the store's click). `at` is the release point;
 * with a press recorded it is the HANDLE of the anchor the press placed,
 * without one (a caller that never pressed) the click is a corner anchor at
 * `at`. A release within `closeTol` of the press is a stationary click: a
 * corner anchor, zero-length handles.
 *
 * - A stationary click on the last anchor is ignored (it absorbs the second
 *   click of the finishing double-click); a DRAG from the last anchor
 *   re-pulls that anchor's handle.
 * - Once two anchors are down, a press on the START anchor closes the chain
 *   and commits it (a drag there re-pulls the start's handles, smooth).
 * - Otherwise the anchor is appended: in-handle (the mirror of the drag), the
 *   anchor, and its out-handle.
 */
export function bezierClick(
  chain: SplineChainState | null,
  at: Vec2,
  closeTol: number,
  construction = false,
  newId?: () => string,
): SplineClickResult {
  const anchor = chain?.press ? copy(chain.press) : copy(at)
  const dragged = dist(at, anchor) > closeTol
  const out = dragged ? copy(at) : copy(anchor)
  const base: SplineChainState = chain
    ? { ...chain, smooth: [...(chain.smooth ?? [])] }
    : { kind: 'spline', form: 'bezier', points: [], smooth: [] }
  delete base.press
  if (base.points.length === 0) {
    return { chain: { ...base, points: [anchor, out], smooth: [dragged] }, commit: null }
  }
  const last = lastAnchor(base)!
  const n = base.points.length
  if (dist(anchor, last) <= closeTol) {
    if (!dragged) return { chain: base, commit: null }
    // Re-pull the last anchor's handle; its in-handle (if any) mirrors it.
    const points = base.points.map(copy)
    points[n - 1] = out
    if (n >= 5) points[n - 3] = mirror(last, out)
    const smooth = [...base.smooth!]
    smooth[smooth.length - 1] = true
    return { chain: { ...base, points, smooth }, commit: null }
  }
  if (newId && bezierChainAnchorCount(base) >= 2 && dist(anchor, base.points[0]) <= closeTol) {
    const points = base.points.map(copy)
    const smooth = [...base.smooth!]
    let closingIn = closingInHandle(base)
    if (dragged) {
      points[1] = out
      closingIn = mirror(points[0], out)
      smooth[0] = true
    }
    const entity = bezierEntity([...points, closingIn], smooth, true, construction, newId)
    return { chain: null, commit: { entities: [entity], constraints: [] } }
  }
  return {
    chain: {
      ...base,
      points: [...base.points, dragged ? mirror(anchor, out) : copy(anchor), anchor, out],
      smooth: [...base.smooth!, dragged],
    },
    commit: null,
  }
}

/**
 * Finish a bezier chain (Enter / double-click): one entity once two anchors
 * are down (one segment), else null (the chain is discarded). `closed` (the
 * "Close loop" toggle) runs a last segment back to the start anchor.
 */
export function bezierFinish(
  chain: SplineChainState, construction: boolean, newId: () => string, closed = false,
): ToolCommit | null {
  if (bezierChainAnchorCount(chain) < 2) return null
  const smooth = [...(chain.smooth ?? [])]
  const points = closed
    ? [...chain.points.map(copy), closingInHandle(chain)]
    : chain.points.slice(0, -1).map(copy)
  return { entities: [bezierEntity(points, smooth, closed, construction, newId)], constraints: [] }
}

/** The chain as drawn so far plus the provisional anchor under the cursor
 *  (held press: the press anchor with the cursor as its handle; hover: a
 *  corner anchor at the cursor), in entity layout, and whether it is shown
 *  closed. Null while nothing is placed yet. */
function bezierProvisional(
  chain: SplineChainState, cursor: Vec2, closed: boolean, closeTol: number,
): { points: Vec2[]; closed: boolean } | null {
  const pts = chain.points.map(copy)
  if (pts.length === 0) return null
  const press = chain.press
  const anchor = press ? copy(press) : copy(cursor)
  const handle = press && dist(cursor, press) > closeTol ? copy(cursor) : copy(anchor)
  if (bezierChainAnchorCount(chain) >= 2 && closeTol > 0 && dist(anchor, pts[0]) <= closeTol) {
    // Close-on-start feedback: the loop snaps shut exactly as the click commits.
    if (dist(handle, anchor) > 0) {
      pts[1] = handle
      return { points: [...pts, mirror(pts[0], handle)], closed: true }
    }
    return { points: [...pts, closingInHandle(chain)], closed: true }
  }
  const tail = [dist(handle, anchor) > 0 ? mirror(anchor, handle) : copy(anchor), anchor]
  if (closed) {
    return { points: [...pts, ...tail, handle, closingInHandle(chain)], closed: true }
  }
  return { points: [...pts, ...tail], closed: false }
}

/** Rubber band of the bezier tool: the exact curve the next release would
 *  leave, including the handle being dragged. Null before the first anchor. */
export function bezierPreview(
  chain: SplineChainState, cursor: Vec2, closed = false, closeTol = 0,
): Vec2[] | null {
  const p = bezierProvisional(chain, cursor, closed, closeTol)
  if (!p) return null
  return tessellateSpline(p.points, p.closed, SPLINE_TESS_STEP_MM, 'bezier')
}

/** Handle legs and handle/anchor markers the bezier tool shows while placing:
 *  every placed anchor's handles plus the one being dragged (the first
 *  press's handle shows even before any curve exists). */
export function bezierHandlePreview(
  chain: SplineChainState, cursor: Vec2, closed = false, closeTol = 0,
): { legs: Vec2[][]; markers: Vec2[] } {
  const p = bezierProvisional(chain, cursor, closed, closeTol)
  const press = chain.press
  if (p) {
    const legs = splineHandleLegs(p.points, p.closed, 'bezier')
    const markers = p.points
    // An open provisional chain ends on the pressed anchor; the out-handle
    // being dragged belongs on that anchor's leg too.
    if (!p.closed && press && dist(cursor, press) > closeTol && legs.length > 0) {
      legs[legs.length - 1] = [...legs[legs.length - 1], copy(cursor)]
      markers.push(copy(cursor))
    }
    return { legs, markers }
  }
  if (!press) return { legs: [], markers: [] }
  if (dist(cursor, press) <= closeTol) return { legs: [], markers: [copy(press)] }
  const leg = [mirror(press, cursor), copy(press), copy(cursor)]
  return { legs: [leg], markers: leg }
}

// ---- Conic arc tool (WO-1863) -------------------------------------------------

/** In-progress conic arc: the start, then the end, then the apex click
 *  commits. `rho` is the fullness the arc is drawn at (the toolbox value when
 *  the chain started, updated live when the operator edits it mid-draw). */
export interface ConicChainState {
  kind: 'conic'
  start: Vec2
  /** Null until the second click places the end. */
  end: Vec2 | null
  rho: number
}

export interface ConicClickResult {
  chain: ConicChainState | null
  commit: ToolCommit | null
}

/**
 * Click behavior: start, end, then the APEX -- where the arc's two end
 * tangents meet -- which commits one conic arc at the chain's rho. A click
 * within `closeTol` of the point placed just before it is ignored (the
 * zero-length guard every chain tool has; it also absorbs a double-click).
 * Everything else draws: an apex on the chord gives the straight chord, and
 * rho = 0 gives the chord too (rule 11).
 */
export function conicClick(
  chain: ConicChainState | null,
  world: Vec2,
  closeTol: number,
  construction: boolean,
  newId: () => string,
  rho = 0.5,
): ConicClickResult {
  const at = copy(world)
  if (!chain) return { chain: { kind: 'conic', start: at, end: null, rho: conicClampRho(rho) }, commit: null }
  if (!chain.end) {
    if (dist(at, chain.start) <= closeTol) return { chain, commit: null }
    return { chain: { ...chain, end: at }, commit: null }
  }
  if (dist(at, chain.end) <= closeTol) return { chain, commit: null }
  const entity: SketchSplineEntity = {
    id: newId(), kind: 'spline', construction, closed: false, form: 'conic',
    points: conicPoints(chain.start, at, chain.end, chain.rho),
  }
  return { chain: null, commit: { entities: [entity], constraints: [] } }
}

/** Rubber band of the conic tool: a straight line to the cursor while the end
 *  is being placed, then the exact arc the apex click would commit with the
 *  cursor as the apex. */
export function conicPreview(chain: ConicChainState, cursor: Vec2): Vec2[] | null {
  if (!chain.end) return [copy(chain.start), copy(cursor)]
  return tessellateSpline(
    conicPoints(chain.start, cursor, chain.end, chain.rho), false, SPLINE_TESS_STEP_MM, 'conic')
}

/** Construction the conic tool shows while the apex is being placed: the two
 *  apex legs and the median the shoulder sits on (ghosts), and the start, end
 *  and live shoulder (markers). Null before the end is placed. */
export function conicConstructionPreview(
  chain: ConicChainState, cursor: Vec2,
): { legs: Vec2[][]; markers: Vec2[] } | null {
  if (!chain.end) return null
  const pts = conicPoints(chain.start, cursor, chain.end, chain.rho)
  return {
    legs: splineHandleLegs(pts, false, 'conic'),
    markers: [copy(chain.start), copy(pts[2]), copy(chain.end)],
  }
}
