// Heads-up "type a value mid-draw" (Tier 1b).
//
// PURE module (toolMachine doctrine): no store, no three.js, no DOM. While
// a draw tool is rubber-banding (anchor placed, cursor moving), the UI
// shows a small numeric box pre-filled with the live PRIMARY SCALAR:
//   line          -> LENGTH (along the current cursor direction from the
//                    chain's previous point)
//   circle-center -> RADIUS (from the center)
//   arc-center    -> RADIUS (from the center; PURE-ONLY commit, see below)
//
// Typing a value + Enter commits the entity at EXACTLY that scalar AND
// creates a DRIVING dimension locking it. This module is the SINGLE source
// for that commit so "the value shown is the value baked" holds:
//   - the committed entity geometry is built at the typed scalar, and
//   - the driving dimension's value equals the typed scalar (set exactly,
//     no float drift; the measured value would round-trip anyway).
//
// REUSE: line entities + their auto coincident constraint + chain
// advancement come from the existing toolClick path (we feed it the exact
// world endpoint the typed length implies); circles come from circleClick;
// the line's distance dimension refs come from planDimension. Only the arc
// radius override is built here -- arcClick derives its radius from the
// start click and cannot honor a typed radius.
//
// Tools/states WITHOUT a single committable scalar return null: circle-3pt,
// arc-3pt, arc-tangent, rect, polygon, slot, point, the smart-dim / MODIFY
// pick tools, and any chain that has not anchored yet.

import type { Vec2, SketchEntity, SketchArcEntity, SketchDimension } from '../types'
import {
  toolClick, type ToolState, type ToolChainState, type ToolCommit,
} from './toolMachine'
import { circleClick } from './circleTools'
import { planDimension } from './dimTool'

const TWO_PI = Math.PI * 2

// ---- Live scalar (what the floating box shows) ----------------------------

export interface DrawValueScalar {
  /** 'length' for the line tool, 'radius' for circle/arc. */
  kind: 'length' | 'radius'
  /** Live measured value (mm) at the current cursor. */
  value: number
  /** The point the scalar is measured FROM (line prev point / circle
   *  center). Only the measurement origin -- the box positions itself near
   *  the cursor, not here. */
  anchor: Vec2
}

/** Optional scalars the box needs that do NOT live in the tool chain.
 *  Fillet/chamfer sizes are package-store SCALARS, not part of their click
 *  state, so the caller passes them in. */
export interface DrawValueContext {
  /** Current fillet radius (mm). Surfaced by the box while the fillet tool
   *  is armed so the radius can be set NEAR THE CURSOR instead of the
   *  bottom toolbox field. */
  filletRadius?: number
  /** Current equal-distance chamfer setback (mm), surfaced through the
   *  same near-cursor input and live-update path as fillet radius. */
  chamferSetback?: number
}

/**
 * The primary scalar the value box shows for the in-progress draw state,
 * or null when the state has no single committable scalar (the box is
 * hidden). `cursor` is the current cursor (already ortho-locked upstream
 * when Shift is held), so the shown value matches what Enter would bake.
 *
 * FILLET is special: it is an accumulate-then-confirm MODIFY tool, not a
 * rubber-band draw. Its radius is a persistent store scalar, not a cursor
 * measurement, so the box shows the CURRENT sketchFilletRadius (passed via
 * ctx) whenever the tool is armed -- even before a corner is staged. Typing
 * there sets the radius live (the ghost arc restyles) rather than committing
 * geometry; the overlay Apply still commits the batch. anchor = cursor since
 * there is no single measurement origin.
 *
 * arc-center is intentionally NOT surfaced here: its radius is fixed by the
 * start click and does not track the cursor at the commit step, so a live
 * radius box there would be static and misleading (see the fork in the
 * build report). The arc radius commit still exists in commitDrawValue for
 * completeness + headless test coverage.
 */
export function drawValueScalar(
  state: ToolState, cursor: Vec2, ctx: DrawValueContext = {},
): DrawValueScalar | null {
  // Fillet/chamfer: armed is enough (chain may still be null before the
  // first corner). The value is a store scalar, not a cursor measurement.
  if (state.tool === 'fillet') {
    const r = ctx.filletRadius
    if (r === undefined || !Number.isFinite(r) || !(r > 0)) return null
    return { kind: 'radius', value: r, anchor: cursor }
  }
  if (state.tool === 'chamfer') {
    const setback = ctx.chamferSetback
    if (setback === undefined || !Number.isFinite(setback) || !(setback > 0)) return null
    return { kind: 'length', value: setback, anchor: cursor }
  }
  const chain = state.chain
  if (!chain) return null
  if (state.tool === 'line' && chain.kind === 'line') {
    return { kind: 'length', value: dist(chain.prev, cursor), anchor: chain.prev }
  }
  if (
    state.tool === 'circle-center' &&
    chain.kind === 'circle' && chain.mode === 'center'
  ) {
    return { kind: 'radius', value: dist(chain.p1, cursor), anchor: chain.p1 }
  }
  return null
}

// ---- Commit ----------------------------------------------------------------

export interface DrawValueResult {
  /** Entities + auto constraints + the driving dimension to apply as ONE
   *  undo step (same shape the store applies for a normal tool commit). */
  commit: ToolCommit
  /** Chain state AFTER the commit: the line tool continues (next anchor =
   *  the typed endpoint), circle / arc end (null). */
  nextChain: ToolChainState | null
}

/**
 * Commit the in-progress draw at EXACTLY `value` (mm) along the current
 * cursor direction, plus the driving dimension that locks it. Returns null
 * when the state has no single committable scalar, or when `value` is not a
 * finite positive number, or when the cursor gives no usable direction.
 */
export function commitDrawValue(
  state: ToolState,
  cursor: Vec2,
  value: number,
  newId: () => string,
  construction = false,
): DrawValueResult | null {
  if (!Number.isFinite(value) || value <= 0) return null
  const chain = state.chain
  if (!chain) return null

  // ---- LINE: length along the current cursor direction --------------------
  if (state.tool === 'line' && chain.kind === 'line') {
    const dir = unit(chain.prev, cursor)
    if (!dir) return null // cursor on the anchor: no direction to place along
    const endpoint: Vec2 = {
      x: chain.prev.x + dir.x * value,
      y: chain.prev.y + dir.y * value,
    }
    // Reuse the real line commit (segment entity + auto coincident
    // constraint + chain advancement) by feeding it the exact endpoint.
    // Tol 0: a typed length never trips the close / zero-length guard
    // unless the endpoint lands exactly on the chain start.
    const r = toolClick(state, endpoint, 0, newId, { entities: [], construction })
    if (!r.commit || r.commit.entities.length === 0) return null
    const lineId = r.commit.entities[0].id
    const dim = lineDistanceDim(r.commit.entities, lineId, value, newId)
    return {
      commit: {
        entities: r.commit.entities,
        constraints: r.commit.constraints,
        dimensions: dim ? [dim] : [],
      },
      nextChain: r.state.chain,
    }
  }

  // ---- CIRCLE (center mode): radius from the center -----------------------
  if (
    state.tool === 'circle-center' &&
    chain.kind === 'circle' && chain.mode === 'center'
  ) {
    // Radius is rotation-invariant; any ray from the center yields the same
    // circle. Use the cursor direction when it exists for a stable rim point.
    const dir = unit(chain.p1, cursor) ?? { x: 1, y: 0 }
    const rim: Vec2 = { x: chain.p1.x + dir.x * value, y: chain.p1.y + dir.y * value }
    const r = circleClick(chain, 'center', rim, 0, construction, newId)
    if (!r.commit || r.commit.entities.length === 0) return null
    const circleId = r.commit.entities[0].id
    // Box shows RADIUS -> bake a RADIUS dim so the shown value IS the baked
    // value (planDimension would pick diameter for a circle; that would
    // show R but lock 2R, breaking preview === commit).
    const dim: SketchDimension = {
      kind: 'radius', entityId: circleId, id: newId(), driving: true,
      value, labelAnchor: { x: chain.p1.x, y: chain.p1.y + value },
    }
    return {
      commit: {
        entities: r.commit.entities,
        constraints: r.commit.constraints,
        dimensions: [dim],
      },
      nextChain: null,
    }
  }

  // ---- ARC (center mode, radius override) -- PURE-ONLY (see header) -------
  if (
    state.tool === 'arc-center' &&
    chain.kind === 'arc' && chain.mode === 'center' && chain.start
  ) {
    const startAngle = Math.atan2(chain.start.y - chain.center.y, chain.start.x - chain.center.x)
    const endAngle = Math.atan2(cursor.y - chain.center.y, cursor.x - chain.center.x)
    // Document arcs wind CCW; reject a zero (or full) sweep.
    if (norm(endAngle - startAngle) <= 1e-9) return null
    const arc: SketchArcEntity = {
      id: newId(), kind: 'arc', construction,
      center: { x: chain.center.x, y: chain.center.y },
      radius: value, startAngle, endAngle,
    }
    const dim: SketchDimension = {
      kind: 'radius', entityId: arc.id, id: newId(), driving: true,
      value, labelAnchor: { x: chain.center.x, y: chain.center.y + value },
    }
    return { commit: { entities: [arc], constraints: [], dimensions: [dim] }, nextChain: null }
  }

  return null
}

// ---- Helpers ---------------------------------------------------------------

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Unit direction from->to, or null when the points coincide. */
function unit(from: Vec2, to: Vec2): Vec2 | null {
  const dx = to.x - from.x, dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  return { x: dx / len, y: dy / len }
}

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

/** Reuse planDimension for the line's own length (distance) refs, then set
 *  the EXACT typed value (driving) and a label offset beside the line. */
function lineDistanceDim(
  entities: readonly SketchEntity[], lineId: string, value: number, newId: () => string,
): SketchDimension | null {
  const out = planDimension(entities, [lineId])
  if (!out.ok || out.plan.kind !== 'distance') return null
  const line = entities.find((e) => e.id === lineId)
  if (!line || line.kind !== 'line') return null
  const mid = { x: (line.start.x + line.end.x) / 2, y: (line.start.y + line.end.y) / 2 }
  const dx = line.end.x - line.start.x, dy = line.end.y - line.start.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len, ny = dx / len // left normal: place the label beside the line
  const off = Math.max(2, value * 0.15)
  return {
    ...out.plan, id: newId(), driving: true, value,
    labelAnchor: { x: mid.x + nx * off, y: mid.y + ny * off },
  }
}
