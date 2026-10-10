// Circle tools (Stage 3 chunk 2): center-point circle + 3-point circle.
//
// Same pure-machine contract as toolMachine.ts: clicks advance the chain
// or return a ToolCommit; the document is never touched here.
//
//   circle-center: click CENTER -> rubber-band radius preview ->
//                  click rim -> commit
//   circle-3pt:    click p1 -> click p2 -> live circumcircle preview ->
//                  click p3 -> commit circle through all three
//
// Both commit a single circle entity (3 DoF: center x/y + radius), so a
// fresh circle always solves under-defined — definition coloring follows
// from the store's post-commit solve with nothing special here.

import type { Vec2, SketchEntity } from '../types'
import type { ToolCommit } from './toolMachine'

/** In-progress circle (chain payload). */
export interface CircleChainState {
  kind: 'circle'
  mode: 'center' | '3pt'
  /** 'center' mode: the center. '3pt' mode: the first rim point. */
  p1: Vec2
  /** '3pt' mode only: second rim point; null until the second click. */
  p2: Vec2 | null
}

/** Circle through three points, or null when they are (near-)collinear:
 *  degenerate iff the third point sits within `tol` of the p1-p2 line —
 *  the same world tolerance the click guards use, so "too flat to mean a
 *  circle" matches "too close to mean a separate point". */
export function circumcircle(
  p1: Vec2, p2: Vec2, p3: Vec2, tol: number,
): { center: Vec2; radius: number } | null {
  const base = Math.hypot(p2.x - p1.x, p2.y - p1.y)
  if (base === 0) return null
  const area2 = Math.abs(
    (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x)
  ) // 2x triangle area = base x height
  if (area2 / base <= tol) return null

  const d = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y))
  const s1 = p1.x * p1.x + p1.y * p1.y
  const s2 = p2.x * p2.x + p2.y * p2.y
  const s3 = p3.x * p3.x + p3.y * p3.y
  const center = {
    x: (s1 * (p2.y - p3.y) + s2 * (p3.y - p1.y) + s3 * (p1.y - p2.y)) / d,
    y: (s1 * (p3.x - p2.x) + s2 * (p1.x - p3.x) + s3 * (p2.x - p1.x)) / d,
  }
  return { center, radius: Math.hypot(p1.x - center.x, p1.y - center.y) }
}

/** Closed tessellation of a full circle (preview rendering only — the
 *  committed entity stays analytic center+radius). */
export function tessellateCircle(center: Vec2, radius: number, segments = 64): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * 2 * Math.PI
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) })
  }
  return pts
}

export interface CircleClickResult {
  chain: CircleChainState | null
  commit: ToolCommit | null
  notice: string | null
}

function commitCircle(
  center: Vec2, radius: number, construction: boolean, newId: () => string,
): ToolCommit {
  const entity: SketchEntity = {
    id: newId(),
    kind: 'circle',
    construction,
    center: { x: center.x, y: center.y },
    radius,
  }
  return { entities: [entity], constraints: [] }
}

/**
 * Click behavior for both circle tools. Guards mirror the line tool's
 * zero-length guard: a rim click on the center (zero radius), a repeat
 * click on a previous point, or a collinear third point is ignored.
 */
export function circleClick(
  chain: CircleChainState | null,
  mode: 'center' | '3pt',
  world: Vec2,
  closeTol: number,
  construction: boolean,
  newId: () => string,
): CircleClickResult {
  if (!chain) {
    return {
      chain: { kind: 'circle', mode, p1: { x: world.x, y: world.y }, p2: null },
      commit: null,
      notice: null,
    }
  }

  if (chain.mode === 'center') {
    const radius = Math.hypot(world.x - chain.p1.x, world.y - chain.p1.y)
    if (radius <= closeTol) return { chain, commit: null, notice: null }
    return { chain: null, commit: commitCircle(chain.p1, radius, construction, newId), notice: null }
  }

  // 3pt mode.
  if (!chain.p2) {
    if (Math.hypot(world.x - chain.p1.x, world.y - chain.p1.y) <= closeTol) {
      return { chain, commit: null, notice: null }
    }
    return { chain: { ...chain, p2: { x: world.x, y: world.y } }, commit: null, notice: null }
  }
  const circle = circumcircle(chain.p1, chain.p2, world, closeTol)
  if (!circle) {
    return {
      chain, commit: null,
      notice: 'Circle: that third point is collinear with the first two - no circle there',
    }
  }
  return { chain: null, commit: commitCircle(circle.center, circle.radius, construction, newId), notice: null }
}

/** Preview polyline: the EXACT circle the next click would commit
 *  (same circumcircle/radius math), with straight-line fallbacks while
 *  the circle is not yet determined. */
export function circlePreview(chain: CircleChainState, cursor: Vec2): Vec2[] | null {
  if (chain.mode === 'center') {
    const radius = Math.hypot(cursor.x - chain.p1.x, cursor.y - chain.p1.y)
    if (radius <= 0) return null
    return tessellateCircle(chain.p1, radius)
  }
  if (!chain.p2) return [chain.p1, { x: cursor.x, y: cursor.y }]
  const circle = circumcircle(chain.p1, chain.p2, cursor, 0)
  if (!circle) return [chain.p1, chain.p2, { x: cursor.x, y: cursor.y }]
  return tessellateCircle(circle.center, circle.radius)
}
