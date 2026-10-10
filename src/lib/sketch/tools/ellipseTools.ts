// Ellipse tool (Tier 2a): center -> major-axis endpoint -> minor distance.
//
// Same pure-machine contract as toolMachine.ts: clicks advance the chain or
// return a ToolCommit; the document is never touched here. Mirrors the
// circle/arc tool structure.
//
//   ellipse: click CENTER -> rubber-band the major axis to the cursor ->
//            click the MAJOR-AXIS endpoint (sets majorRadius + rotation) ->
//            live ellipse preview whose minor radius follows the cursor's
//            perpendicular distance from the major axis -> click commits
//
// The committed entity is SOLVER-INERT (types.ts): a fresh ellipse carries
// its drawn shape and only its center participates in later constraints, so
// nothing solver-specific happens at commit time.

import type { Vec2, SketchEntity, SketchEllipticalArcEntity } from '../types'
import type { ToolCommit } from './toolMachine'
import {
  tessellateEllipse, tessellateEllipticalArc, ellipseParamFromPoint,
  ellipsePointAt, type EllipseShape,
} from '../ellipse'

/** In-progress ellipse (chain payload). */
export interface EllipseChainState {
  kind: 'ellipse'
  /** Click 1: the center. */
  center: Vec2
  /** Click 2: the major-axis endpoint; null until placed. */
  major: Vec2 | null
}

export interface EllipseClickResult {
  chain: EllipseChainState | null
  commit: ToolCommit | null
}

/** Ellipse shape from a center, a major-axis endpoint, and a free point
 *  whose PERPENDICULAR distance from the major axis sets the minor radius. */
export function ellipseFromClicks(
  center: Vec2, major: Vec2, minorPoint: Vec2,
): EllipseShape {
  const dx = major.x - center.x
  const dy = major.y - center.y
  const majorRadius = Math.hypot(dx, dy)
  const rotation = Math.atan2(dy, dx)
  // Perpendicular distance of minorPoint from the major axis line.
  const len = majorRadius || 1
  const nx = -dy / len
  const ny = dx / len
  const minorRadius = Math.abs((minorPoint.x - center.x) * nx + (minorPoint.y - center.y) * ny)
  return { center: { ...center }, majorRadius, minorRadius, rotation }
}

function commitEllipse(
  shape: EllipseShape, construction: boolean, newId: () => string,
): ToolCommit {
  const entity: SketchEntity = {
    id: newId(),
    kind: 'ellipse',
    construction,
    center: { x: shape.center.x, y: shape.center.y },
    majorRadius: shape.majorRadius,
    minorRadius: shape.minorRadius,
    rotation: shape.rotation,
  }
  return { entities: [entity], constraints: [] }
}

/**
 * Click behavior for the ellipse tool. Guards mirror the circle tool's
 * zero-size guards: a major endpoint on the center, or a minor point on the
 * major axis (zero minor radius), is ignored.
 */
export function ellipseClick(
  chain: EllipseChainState | null,
  world: Vec2,
  closeTol: number,
  construction: boolean,
  newId: () => string,
): EllipseClickResult {
  // Click 1: anchor the center.
  if (!chain) {
    return { chain: { kind: 'ellipse', center: { x: world.x, y: world.y }, major: null }, commit: null }
  }

  // Click 2: the major-axis endpoint (rejects zero-length major).
  if (!chain.major) {
    if (Math.hypot(world.x - chain.center.x, world.y - chain.center.y) <= closeTol) {
      return { chain, commit: null }
    }
    return { chain: { ...chain, major: { x: world.x, y: world.y } }, commit: null }
  }

  // Click 3: the minor distance -> commit (rejects zero minor radius).
  const shape = ellipseFromClicks(chain.center, chain.major, world)
  if (shape.minorRadius <= closeTol) return { chain, commit: null }
  return { chain: null, commit: commitEllipse(shape, construction, newId) }
}

/** Preview polyline: the EXACT ellipse the next click would commit, with a
 *  straight major-axis rubber band while the major axis is being defined. */
export function ellipsePreview(chain: EllipseChainState, cursor: Vec2): Vec2[] | null {
  if (!chain.major) return [chain.center, { x: cursor.x, y: cursor.y }]
  const shape = ellipseFromClicks(chain.center, chain.major, cursor)
  if (shape.majorRadius <= 0 || shape.minorRadius <= 0) {
    return [chain.center, chain.major]
  }
  return tessellateEllipse(shape)
}

// ---------------------------------------------------------------------------
// Elliptical-arc tool (Tier 2b): the ellipse tool's first three clicks fix
// the underlying ellipse, then two MORE clicks pick the arc's START and END
// by eccentric angle. Same SOLVER-INERT contract as the full ellipse: the
// committed entity carries its drawn shape; only its center participates in
// later constraints.
//
//   ellipse-arc: click CENTER -> click MAJOR-AXIS endpoint (size + rotation)
//                -> click MINOR distance (fixes the ellipse) -> click START
//                (its eccentric param) -> live arc sweeping CCW to the cursor
//                -> click END (its param) commits the arc
//
// The START / END clicks pick a PARAMETER (the eccentric-angle direction
// from the center), so the click need not land exactly on the curve -- this
// mirrors the center-arc tool, which reads atan2 of the click relative to
// the center. The arc sweeps CCW from startParam to endParam (the ellipse.ts
// + types.ts winding convention).

/** In-progress elliptical arc (chain payload). The first three points fix
 *  the ellipse exactly as the full-ellipse tool does; `start` then fixes the
 *  sweep's startParam and the next click fixes endParam + commits. */
export interface EllipseArcChainState {
  kind: 'ellipse-arc'
  /** Click 1: the center. */
  center: Vec2
  /** Click 2: the major-axis endpoint; null until placed. */
  major: Vec2 | null
  /** Click 3: the minor-distance point (fixes the ellipse); null until placed. */
  minor: Vec2 | null
  /** Click 4: the arc start point (fixes startParam); null until placed. */
  start: Vec2 | null
}

export interface EllipseArcClickResult {
  chain: EllipseArcChainState | null
  commit: ToolCommit | null
  /** Rejection reason the store surfaces as a notice (degenerate-sweep
   *  guard, click 5). Never silent (ADR 0003 spirit). */
  notice?: string
}

/** Resolved elliptical-arc geometry from the full 5-click sequence: the
 *  ellipse shape plus the CCW sweep params the START / END points pick. */
export interface EllipticalArcShape extends EllipseShape {
  startParam: number
  endParam: number
}

/** Elliptical arc from the click sequence: center / major endpoint / minor
 *  point fix the ellipse (reusing ellipseFromClicks); startPoint / endPoint
 *  map to eccentric params, sweeping CCW from start to end. */
export function ellipticalArcFromClicks(
  center: Vec2, major: Vec2, minorPoint: Vec2,
  startPoint: Vec2, endPoint: Vec2,
): EllipticalArcShape {
  const shape = ellipseFromClicks(center, major, minorPoint)
  const startParam = ellipseParamFromPoint(shape, startPoint)
  const endParam = ellipseParamFromPoint(shape, endPoint)
  return { ...shape, startParam, endParam }
}

function commitEllipticalArc(
  shape: EllipticalArcShape, construction: boolean, newId: () => string,
): ToolCommit {
  const entity: SketchEllipticalArcEntity = {
    id: newId(),
    kind: 'elliptical-arc',
    construction,
    center: { x: shape.center.x, y: shape.center.y },
    majorRadius: shape.majorRadius,
    minorRadius: shape.minorRadius,
    rotation: shape.rotation,
    startParam: shape.startParam,
    endParam: shape.endParam,
  }
  return { entities: [entity], constraints: [] }
}

/**
 * Click behavior for the elliptical-arc tool. The first three clicks reuse
 * the full-ellipse guards (no zero-length major, no zero minor radius); the
 * fourth anchors the start param; the fifth commits, guarding a coincident
 * start/end click (a zero/degenerate sweep) fail-loud (no commit).
 */
export function ellipseArcClick(
  chain: EllipseArcChainState | null,
  world: Vec2,
  closeTol: number,
  construction: boolean,
  newId: () => string,
): EllipseArcClickResult {
  // Click 1: anchor the center.
  if (!chain) {
    return {
      chain: { kind: 'ellipse-arc', center: { x: world.x, y: world.y }, major: null, minor: null, start: null },
      commit: null,
    }
  }

  // Click 2: the major-axis endpoint (rejects zero-length major).
  if (!chain.major) {
    if (Math.hypot(world.x - chain.center.x, world.y - chain.center.y) <= closeTol) {
      return { chain, commit: null }
    }
    return { chain: { ...chain, major: { x: world.x, y: world.y } }, commit: null }
  }

  // Click 3: the minor distance (rejects zero minor radius); fixes the ellipse.
  if (!chain.minor) {
    const shape = ellipseFromClicks(chain.center, chain.major, world)
    if (shape.minorRadius <= closeTol) return { chain, commit: null }
    return { chain: { ...chain, minor: { x: world.x, y: world.y } }, commit: null }
  }

  // Click 4: the arc START point (fixes startParam).
  if (!chain.start) {
    return { chain: { ...chain, start: { x: world.x, y: world.y } }, commit: null }
  }

  // Click 5: the arc END point -> commit. Rejects a coincident start/end
  // ARC (BUG-494): validated on the MAPPED parameters' curve positions, not
  // the raw click positions -- two clicks at different distances along the
  // SAME RAY from the center are far apart in world/screen space (the old
  // guard measured exactly this and let them through) but map to the
  // identical eccentric parameter via ellipseParamFromPoint, which reads
  // DIRECTION from the center, not distance, so the resulting "arc" spans
  // zero distance on the curve itself. Measuring the curve-point distance
  // (not a fixed radian epsilon) keeps this guard scaled to closeTol exactly
  // like every other click guard here, so real pointer/pixel-quantization
  // noise on an intentional near-ray click cannot slip a razor-thin sliver
  // arc past it (ellipse.ts's ellipticalArcSweep intentionally remaps a
  // zero delta to a full turn for point-sampling only -- that remap must
  // never reach a creation-time validity decision).
  const shape = ellipseFromClicks(chain.center, chain.major, chain.minor)
  const startParam = ellipseParamFromPoint(shape, chain.start)
  const endParam = ellipseParamFromPoint(shape, world)
  const startPt = ellipsePointAt(shape, startParam)
  const endPt = ellipsePointAt(shape, endParam)
  if (Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) <= closeTol) {
    return {
      chain, commit: null,
      notice: 'Elliptical arc: start and end map to the same angle from the center (degenerate sweep) -- not drawn.',
    }
  }
  return { chain: null, commit: commitEllipticalArc({ ...shape, startParam, endParam }, construction, newId) }
}

/** Preview polyline for the in-progress elliptical arc at the cursor: a
 *  straight major rubber band, then the live full ellipse while the minor
 *  radius / start param are being chosen, then the EXACT arc the next click
 *  commits once the start param is fixed (preview == commit). `closeTol`
 *  (the same pick tolerance the click uses) keeps the degenerate-cursor
 *  check below in lockstep with the click-5 guard. */
export function ellipseArcPreview(
  chain: EllipseArcChainState, cursor: Vec2, closeTol = 0,
): Vec2[] | null {
  // Defining the major axis: straight rubber band from the center.
  if (!chain.major) return [chain.center, { x: cursor.x, y: cursor.y }]

  // Defining the minor radius: the live full ellipse (same as the ellipse tool).
  if (!chain.minor) {
    const shape = ellipseFromClicks(chain.center, chain.major, cursor)
    if (shape.majorRadius <= 0 || shape.minorRadius <= 0) return [chain.center, chain.major]
    return tessellateEllipse(shape)
  }

  const shape = ellipseFromClicks(chain.center, chain.major, chain.minor)
  // Picking the start: show the whole ellipse so the start point reads.
  if (!chain.start) return tessellateEllipse(shape)

  // Picking the end: the exact arc from startParam sweeping CCW to the cursor.
  const startParam = ellipseParamFromPoint(shape, chain.start)
  const endParam = ellipseParamFromPoint(shape, cursor)
  const startPt = ellipsePointAt(shape, startParam)
  const endPt = ellipsePointAt(shape, endParam)
  // Degenerate cursor (same mapped parameter as start -- e.g. anywhere along
  // the SAME RAY from the center, not just the exact start point): nothing
  // to sweep -> a dot at start, never the full ellipse. Same curve-point-
  // distance measure as the click-5 guard (preview == commit) -- the old
  // check here compared the full-turn-remapped sweep, which is never <= 0,
  // so this branch was dead and a same-ray cursor previewed a full ellipse
  // that then could not bake (BUG-494).
  if (Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) <= closeTol) {
    return [startPt, startPt]
  }
  return tessellateEllipticalArc(shape, startParam, endParam)
}
