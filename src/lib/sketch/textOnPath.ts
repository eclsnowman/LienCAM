// Text-on-path warp (sketch text: "text on curve").
//
// PURE geometry (the LUT + warp + entity sampling are headless-testable; the
// two convenience wrappers reuse the local text layout from text.ts /
// textOutline.ts and so ride whatever those already import). A text entity
// with a resolvable `pathId` warps its HORIZONTAL local glyph layout onto an
// arc-length parameterization of the path curve:
//
//     worldPoint = pathPoint(startOffset + x) + y * pathNormal(startOffset + x)
//
// where pathPoint(s)/pathTangent(s) come from an arc-length LUT of the path's
// dense tessellation and pathNormal = rotate(tangent, +90deg). Every LOCAL
// vertex maps INDEPENDENTLY, so the exact same warp serves single-line strokes
// AND outline contours (no per-glyph grouping), and because the layout is
// recomputed from LIVE path geometry at render/bake time the text follows the
// path when it is edited or solved (no solver change needed).
//
// Unbound text (no pathId) never touches this module -- it keeps the byte-
// identical free layout of text.ts / textOutline.ts.

import type { Vec2 } from '../../types'
import type { SketchEntity, SketchTextEntity } from './types'
import { sampleArc } from '../geometry/loopOptimizer'
import {
  tessellateEllipse, tessellateEllipticalArc,
  nearestPointOnEllipse, distanceToEllipticalArc,
} from './ellipse'
import { tessellateSpline, nearestPointOnSpline, SPLINE_TESS_STEP_MM } from './spline'
import {
  textToPolylines, textLocalBBox, textAdvanceWidth, placeLocalPolylines,
  distanceToTextBBox,
  type TextBBox,
} from './text'
import {
  outlineTextToContours, outlineTextLocalBBox, outlineTextAdvanceWidth,
  distanceToOutlineTextBBox,
  type OutlineContour,
} from './textOutline'

const TWO_PI = Math.PI * 2
// Dense tessellation step (mm) for path sampling -- matches the ellipse/spline
// chord budget so the warped baseline is smooth.
const PATH_STEP_MM = 0.3

// ---- Arc-length LUT --------------------------------------------------------

export interface ArcLengthLUT {
  /** Total traversed length (includes the closing segment for closed paths). */
  totalLength: number
  /** Point at arc-length `s`. CLOSED paths wrap s modulo totalLength; OPEN
   *  paths EXTRAPOLATE past either end along the terminal tangent:
   *  s < 0 -> pointAt(0) + s * tangentAt(0);
   *  s > total -> pointAt(total) + (s - total) * tangentAt(total). */
  pointAt(s: number): Vec2
  /** Unit tangent at arc-length `s` (same wrap/extrapolation policy as
   *  pointAt; beyond an OPEN end it is CONSTANT -- the terminal tangent).
   *  Points in the direction of increasing s. */
  tangentAt(s: number): Vec2
}

/**
 * Build an arc-length lookup over a dense polyline. `closed` appends the
 * implicit closing segment (last -> first) to the length and makes lookups
 * WRAP; open paths EXTRAPOLATE past either end along the terminal tangent,
 * so glyphs that run past an end KEEP THEIR SHAPE and continue straight in
 * the last direction instead of collapsing onto the
 * endpoint as a smeared bar. Degenerate input (< 2 distinct points / zero
 * length) yields a constant point and a +X tangent so callers never divide
 * by zero.
 */
export function buildArcLengthLUT(points: readonly Vec2[], closed: boolean): ArcLengthLUT {
  const verts: Vec2[] = points.map((p) => ({ x: p.x, y: p.y }))
  if (closed && verts.length >= 2) verts.push({ x: verts[0].x, y: verts[0].y })
  const n = verts.length
  // Cumulative arc-length at each vertex.
  const cum: number[] = new Array(n)
  cum[0] = 0
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(verts[i].x - verts[i - 1].x, verts[i].y - verts[i - 1].y)
  }
  const total = n > 0 ? cum[n - 1] : 0

  const fallback = verts[0] ?? { x: 0, y: 0 }
  if (!(total > 0)) {
    return {
      totalLength: 0,
      pointAt: () => ({ x: fallback.x, y: fallback.y }),
      tangentAt: () => ({ x: 1, y: 0 }),
    }
  }

  // Map arbitrary s onto [0,total] (wrap when closed; clamp when open --
  // pointAt/tangentAt handle open-path EXTRAPOLATION before calling this,
  // so the clamp only ever absorbs float noise at the ends).
  const bring = (s: number): number => {
    if (closed) return ((s % total) + total) % total
    return Math.max(0, Math.min(total, s))
  }

  // Segment index i such that cum[i] <= s <= cum[i+1] (binary search).
  const locate = (s: number): number => {
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cum[mid + 1] < s) lo = mid + 1
      else hi = mid
    }
    return Math.min(lo, n - 2)
  }

  // Point / unit tangent at an in-range arc-length q (q in [0, total]).
  const pointIn = (q: number): Vec2 => {
    const i = locate(q)
    const segLen = cum[i + 1] - cum[i]
    const t = segLen > 1e-12 ? (q - cum[i]) / segLen : 0
    const a = verts[i]
    const b = verts[i + 1]
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  }
  const tangentIn = (q: number): Vec2 => {
    const i = locate(q)
    const a = verts[i]
    const b = verts[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    return len > 1e-12 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 }
  }

  return {
    totalLength: total,
    pointAt(s) {
      // OPEN path, s outside [0,total]: extrapolate straight along the
      // terminal tangent so overhanging glyphs keep their shape (see the
      // builder doc above). CLOSED paths wrap via bring().
      if (!closed && (s < 0 || s > total)) {
        const endS = s < 0 ? 0 : total
        const base = pointIn(endS)
        const tan = tangentIn(endS)
        return { x: base.x + (s - endS) * tan.x, y: base.y + (s - endS) * tan.y }
      }
      return pointIn(bring(s))
    },
    tangentAt(s) {
      // Beyond an OPEN end the tangent is CONSTANT: the terminal tangent.
      if (!closed && (s < 0 || s > total)) return tangentIn(s < 0 ? 0 : total)
      return tangentIn(bring(s))
    },
  }
}

// ---- Warp ------------------------------------------------------------------

/**
 * Warp LOCAL baseline-left polylines onto the path LUT. For each local vertex
 * (x, y):  world = pointAt(s) + y * normal(s),  where s advances with x along
 * the path (or backward when `flip`) and normal = rotate(tangent, +90deg).
 *
 * `flip` reverses the traversal direction: the text jumps to the OTHER side of
 * the curve and reads the other way (glyphs stay upright, NOT mirror-imaged) --
 * the standard parametric CAD "flip" behavior -- by negating the effective tangent
 * (and hence the normal) and walking s backward from the start offset.
 */
export function warpLocalToPath(
  localPolylines: readonly (readonly Vec2[])[],
  lut: ArcLengthLUT,
  startOffsetMm: number,
  flip: boolean,
): Vec2[][] {
  const dir = flip ? -1 : 1
  return localPolylines.map((poly) =>
    poly.map((p) => {
      const s = startOffsetMm + dir * p.x
      const base = lut.pointAt(s)
      const tan = lut.tangentAt(s)
      // Effective (possibly reversed) tangent, then normal = rotate(+90deg).
      const tx = tan.x * dir
      const ty = tan.y * dir
      const nx = -ty
      const ny = tx
      return { x: base.x + p.y * nx, y: base.y + p.y * ny }
    }),
  )
}

// ---- Entity -> dense polyline ----------------------------------------------

export interface SampledPath {
  points: Vec2[]
  closed: boolean
}

/** True for entity kinds a text can attach to as a path (curves; not point/
 *  text, and not a degenerate one). */
export function isSampleablePath(e: SketchEntity): boolean {
  return sampleEntityToPolyline(e) !== null
}

/**
 * Dense polyline (+ closed flag) for a curve entity, reusing the SAME
 * tessellators the bake uses. Returns null for kinds that cannot be a path
 * (point, text) or degenerate geometry (zero-length line, <2-point spline).
 * Closed kinds (circle, full ellipse, closed spline) return their ring WITHOUT
 * a duplicate closing vertex (the LUT adds the closing segment itself).
 */
export function sampleEntityToPolyline(e: SketchEntity): SampledPath | null {
  switch (e.kind) {
    case 'line': {
      const len = Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y)
      if (len <= 1e-9) return null
      // Densify so the LUT is uniform with the curved kinds (collinear points
      // leave the geometry exact).
      const n = Math.max(1, Math.ceil(len / PATH_STEP_MM))
      const pts: Vec2[] = []
      for (let i = 0; i <= n; i++) {
        const t = i / n
        pts.push({ x: e.start.x + (e.end.x - e.start.x) * t, y: e.start.y + (e.end.y - e.start.y) * t })
      }
      return { points: pts, closed: false }
    }
    case 'arc': {
      let sweep = e.endAngle - e.startAngle
      while (sweep <= 0) sweep += TWO_PI
      const start = { x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle) }
      const pts = [start, ...sampleArc(e.center.x, e.center.y, e.radius, e.startAngle, sweep, PATH_STEP_MM)]
      return { points: pts, closed: false }
    }
    case 'circle': {
      if (!(e.radius > 1e-9)) return null
      const start = { x: e.center.x + e.radius, y: e.center.y }
      const pts = [start, ...sampleArc(e.center.x, e.center.y, e.radius, 0, TWO_PI, PATH_STEP_MM)]
      pts.pop() // drop the duplicate closing vertex; LUT adds the closing seg
      return { points: pts, closed: true }
    }
    case 'ellipse': {
      if (!(e.majorRadius > 1e-9 && e.minorRadius > 1e-9)) return null
      const pts = tessellateEllipse(e)
      pts.pop()
      return { points: pts, closed: true }
    }
    case 'elliptical-arc': {
      if (!(e.majorRadius > 1e-9 && e.minorRadius > 1e-9)) return null
      return { points: tessellateEllipticalArc(e, e.startParam, e.endParam), closed: false }
    }
    case 'spline': {
      if (e.points.length < 2) return null
      const pts = tessellateSpline(e.points, e.closed, SPLINE_TESS_STEP_MM, e.form)
      if (e.closed) {
        pts.pop()
        return { points: pts, closed: true }
      }
      return { points: pts, closed: false }
    }
    case 'point':
    case 'text':
    case 'block':
      return null
  }
}

/** Build the LUT for a path entity, or null when it cannot be sampled. */
export function pathLUT(e: SketchEntity): ArcLengthLUT | null {
  const sampled = sampleEntityToPolyline(e)
  if (!sampled) return null
  return buildArcLengthLUT(sampled.points, sampled.closed)
}

/**
 * Arc-length offset (mm) along the path where `p` projects (the nearest point
 * on the entity's dense polyline). Used to START on-path text where the user
 * clicked along the curve. The parameterization matches buildArcLengthLUT
 * exactly (same dense points, same appended closing segment for closed paths),
 * so the returned offset feeds straight into `pathOffsetMm`. Returns null for
 * non-sampleable entities and 0 for a degenerate one-point path.
 */
export function projectPointToPathOffset(e: SketchEntity, p: Vec2): number | null {
  const sampled = sampleEntityToPolyline(e)
  if (!sampled) return null
  const verts: Vec2[] = sampled.points.map((q) => ({ x: q.x, y: q.y }))
  if (sampled.closed && verts.length >= 2) verts.push({ x: verts[0].x, y: verts[0].y })
  const n = verts.length
  if (n < 2) return 0
  let cum = 0
  let bestDist = Infinity
  let bestS = 0
  for (let i = 0; i < n - 1; i++) {
    const a = verts[i]
    const b = verts[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const segLen = Math.hypot(dx, dy)
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const px = a.x + t * dx
    const py = a.y + t * dy
    const d = Math.hypot(p.x - px, p.y - py)
    if (d < bestDist) {
      bestDist = d
      bestS = cum + t * segLen
    }
    cum += segLen
  }
  return bestS
}

// ---- Path resolution + missing-path reporting ------------------------------
//
// A text entity carrying a `pathId` that resolves to a real, sampleable curve
// renders/bakes warped; a pathId that points at a missing or unsampleable
// entity falls back to the FREE layout plus a named, logged notice (never a
// silent swap -- ADR-0003, same doctrine as the missing-font fallback).

let _missingPathReporter: ((textId: string, pathId: string) => void) | null = null
const _warnedMissingPath = new Set<string>()

/** Wire a UI-notice sink for missing/unsampleable path fallbacks (the store
 *  bridges it to the status-bar sketch notice). Pass null to detach. */
export function setMissingPathReporter(fn: ((textId: string, pathId: string) => void) | null): void {
  _missingPathReporter = fn
}

/**
 * Resolve a text entity's bound path entity from the sketch entities. Returns
 * null when the text is FREE (`pathId` unset -- the normal, quiet case) OR
 * when the pathId is set but does not resolve to a sampleable curve, in which
 * case it warns once (deduped) and pings the reporter so the caller falls back
 * to the free layout loudly.
 */
export function resolveTextPath(
  e: SketchTextEntity, entities: readonly SketchEntity[],
): SketchEntity | null {
  if (!e.pathId) return null // free text -- not a warning
  const path = entities.find((x) => x.id === e.pathId)
  if (path && path.id !== e.id && isSampleablePath(path)) return path
  const key = `${e.id}:${e.pathId}`
  if (!_warnedMissingPath.has(key)) {
    _warnedMissingPath.add(key)
    console.warn(
      `[sketch text] text "${e.id}" is bound to path "${e.pathId}" ` +
      `which is missing or not a usable curve; rendering with the free layout`,
    )
    _missingPathReporter?.(e.id, e.pathId)
  }
  return null
}

// ---- Alignment (pathAlign) start-offset resolution ---------------------------

/**
 * UNTRIMMED advance width (mm) of the entity's laid-out string -- the pen
 * position after the LAST character, leading/trailing whitespace INCLUDED
 * (spec T3: whitespace counts toward alignment). Dispatches on the entity's
 * font style to the matching layout's pen measurement. NOT the bbox X-extent
 * (a trailing space advances the pen but adds no geometry).
 */
export function textEntityAdvanceMm(e: SketchTextEntity): number {
  return e.fontStyle === 'outline'
    ? outlineTextAdvanceWidth(e.text, e.height, {
        fontFamily: e.fontFamily, letterSpacingMm: e.letterSpacingMm,
      })
    : textAdvanceWidth(e.text, e.height, { letterSpacingMm: e.letterSpacingMm })
}

/**
 * THE ONE SOURCE for the on-path start offset (mm arc-length) that render,
 * bake AND pick feed into warpLocalToPath (shared-resolver rule: consumers
 * must never compute this themselves or they drift). Maps `pathAlign` to a
 * start offset:
 *  - 'left'      : text begins at the curve START
 *  - 'center'    : text centered on the curve MIDDLE
 *  - 'right'     : text ends at the curve END
 *  - 'free'/ABSENT: `pathOffsetMm ?? 0` verbatim (legacy behavior, so
 *    projects saved before `pathAlign` existed resolve byte-identically)
 * `pathFlip` walks s BACKWARD from the start offset, so the aligned modes
 * mirror their formulas to keep the text on the SAME arc region either way
 * ('free' stays raw -- a stored offset is a stored offset). OPEN paths
 * EXTRAPOLATE via the LUT (text longer than the path overhangs straight
 * past the ends on the terminal tangents, glyph shapes intact); CLOSED
 * paths WRAP (center/right are computed on the unwrapped arc length here
 * and the LUT wraps each sample, as today).
 */
export function effectiveStartOffsetMm(
  e: SketchTextEntity, lut: ArcLengthLUT, advanceMm: number,
): number {
  const align = e.pathAlign
  if (!align || align === 'free') return e.pathOffsetMm ?? 0
  const total = lut.totalLength
  const flip = e.pathFlip ?? false
  switch (align) {
    case 'left': return flip ? advanceMm : 0
    case 'center': return total / 2 + (flip ? advanceMm : -advanceMm) / 2
    case 'right': return flip ? total : total - advanceMm
  }
}

/** Resolved start offset for an entity on `lut` (align + advance in one step).
 *  Internal so every wrapper below goes through the SAME resolution. */
function resolvedStartOffsetMm(e: SketchTextEntity, lut: ArcLengthLUT): number {
  return effectiveStartOffsetMm(e, lut, textEntityAdvanceMm(e))
}

/**
 * WORLD position of a text entity's ATTACHMENT-POINT marker (the small ring
 * the sketch layer shows while the text is selected or being edited). FREE
 * text (no pathId) -> the anchor `at` verbatim. ON-PATH text -> the align
 * REFERENCE point on the live curve:
 *  - 'left'   -> curve START (s = 0)
 *  - 'center' -> curve MIDDLE (s = total/2)
 *  - 'right'  -> curve END (s = total)
 *    All three are flip-INVARIANT: `pathFlip` mirrors the offset formulas so
 *    the text occupies the SAME arc span either way (left = [0, advance],
 *    center = centered span, right = [total - advance, total]), so the
 *    reference point itself never moves under a flip.
 *  - 'free' / ABSENT (legacy pathOffsetMm-only entities) -> the LEADING edge
 *    the user placed, via the shared resolvedStartOffsetMm resolution.
 * A pathId that does not resolve returns null: resolveTextPath has already
 * reported the orphan loudly (ADR-0003) and the text renders with the free
 * layout, so the marker stays hidden rather than pointing at a curve that
 * is not there. Purely visual -- no pick/snap behavior rides on this.
 */
export function textAttachMarkerWorld(
  e: SketchTextEntity, entities: readonly SketchEntity[],
): Vec2 | null {
  if (!e.pathId) return { x: e.at.x, y: e.at.y }
  const path = resolveTextPath(e, entities)
  if (!path) return null
  const lut = pathLUT(path)
  if (!lut) return null
  const align = e.pathAlign
  if (!align || align === 'free') {
    const p = lut.pointAt(resolvedStartOffsetMm(e, lut))
    return { x: p.x, y: p.y }
  }
  switch (align) {
    case 'left': {
      const p = lut.pointAt(0)
      return { x: p.x, y: p.y }
    }
    case 'center': {
      const p = lut.pointAt(lut.totalLength / 2)
      return { x: p.x, y: p.y }
    }
    case 'right': {
      const p = lut.pointAt(lut.totalLength)
      return { x: p.x, y: p.y }
    }
  }
}

// ---- In-canvas caret (M1b) --------------------------------------------------

// Caret extents as fractions of the entity height: a slight descender dip
// below the baseline so the caret stays visible sitting ON the baseline, up
// to the cap line.
const CARET_DESCENT_FRAC = 0.18

/**
 * WORLD-space caret segment for the in-canvas text editor (M1b: the WYSIWYG
 * input is invisible, so the sketch layer draws THIS as the insertion caret).
 * `caretIndex` is the string insertion index (input.selectionStart), clamped
 * to [0, text.length]. The caret's LOCAL x is the advance of
 * text.slice(0, caretIndex) under the entity's own style/family/height --
 * the SAME pen measurement the glyph layout uses -- reflected about the
 * advance midpoint when the entity is mirrored (x' = advance - x, matching
 * mirrorLocalLayoutX). The local vertical segment spans
 * (x, -0.18*height) -> (x, height) and is transformed through the EXACT
 * pipelines the glyphs ride:
 *  - ON-PATH: warpLocalToPath with the shared resolvedStartOffsetMm +
 *    pathFlip, so the caret sits ON the curve, perpendicular to the warped
 *    baseline at the insertion point, and tracks pathAlign/flip/mirror live.
 *  - FREE: placeLocalPolylines (the textToWorldPolylines transform) at the
 *    anchor + rotation.
 * EMPTY text yields the caret at the layout origin (the user must see where
 * text will emit before typing). Returns null for a non-positive height or
 * an unresolvable bound path (resolveTextPath already reported the orphan
 * loudly -- ADR-0003).
 */
export function textCaretWorldSegment(
  e: SketchTextEntity, entities: readonly SketchEntity[], caretIndex: number,
): [Vec2, Vec2] | null {
  const h = e.height
  if (!(h > 0)) return null
  const i = Math.max(0, Math.min(Math.floor(caretIndex), e.text.length))
  const sub = e.text.slice(0, i)
  let x = e.fontStyle === 'outline'
    ? outlineTextAdvanceWidth(sub, h, {
        fontFamily: e.fontFamily, letterSpacingMm: e.letterSpacingMm,
      })
    : textAdvanceWidth(sub, h, { letterSpacingMm: e.letterSpacingMm })
  // Mirror (T5b): reflect about the advance midpoint exactly like
  // mirrorLocalLayoutX, so the caret lands between the same two glyphs the
  // string indices name in the mirrored rendering.
  if (e.mirrored) x = textEntityAdvanceMm(e) - x
  const local: Vec2[] = [
    { x, y: -CARET_DESCENT_FRAC * h },
    { x, y: h },
  ]
  if (!e.pathId) {
    const seg = placeLocalPolylines([local], e.at, e.rotation ?? 0)[0]
    return [seg[0], seg[1]]
  }
  const path = resolveTextPath(e, entities)
  if (!path) return null
  const lut = pathLUT(path)
  if (!lut) return null
  const seg = warpLocalToPath(
    [local], lut, resolvedStartOffsetMm(e, lut), e.pathFlip ?? false,
  )[0]
  return [seg[0], seg[1]]
}

// ---- Convenience wrappers (local layout -> warped world geometry) ----------

/**
 * WORLD-space single-line stroke polylines for an ON-PATH text: the LOCAL
 * baseline-left Hershey layout warped onto `path`. Mirrors
 * textToWorldPolylines but the path (not the entity anchor/rotation) sets
 * position + orientation. The start offset is resolved INSIDE via
 * effectiveStartOffsetMm (pathAlign, falling back to `pathOffsetMm`) so
 * callers cannot bypass alignment; `pathFlip` swaps the side/reading
 * direction.
 */
export function textOnPathToWorldPolylines(
  e: SketchTextEntity, path: SketchEntity,
): Vec2[][] {
  const lut = pathLUT(path)
  if (!lut) return []
  // `mirrored` (T5b) rides the LOCAL layout (the one shared transform in
  // text.ts), so the warp itself is mirror-agnostic.
  const local = textToPolylines(e.text, e.height, {
    mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm,
  })
  return warpLocalToPath(local, lut, resolvedStartOffsetMm(e, lut), e.pathFlip ?? false)
}

/**
 * WORLD-space closed OUTLINE contours for an ON-PATH text: the LOCAL outline
 * contours warped onto `path` (each contour warped independently; hole flags
 * preserved). Mirrors outlineTextToWorldContours; the start offset is
 * resolved INSIDE via effectiveStartOffsetMm, same as the single-line wrapper.
 */
export function outlineTextOnPathToWorldContours(
  e: SketchTextEntity, path: SketchEntity,
): OutlineContour[] {
  const lut = pathLUT(path)
  if (!lut) return []
  const local = outlineTextToContours(
    e.text, e.height, {
      fontFamily: e.fontFamily, mirrored: e.mirrored,
      letterSpacingMm: e.letterSpacingMm,
    },
  )
  const offset = resolvedStartOffsetMm(e, lut)
  const flip = e.pathFlip ?? false
  return local.map((c) => ({
    isHole: c.isHole,
    points: warpLocalToPath([c.points], lut, offset, flip)[0],
  }))
}

// ---- On-path PICK metric (D-E: warped bounding band) ------------------------

/** Densified perimeter of a local bbox rectangle (CCW, no duplicate closing
 *  vertex). Each edge is subdivided at ~`step` so the warp can bend it along
 *  the path's curvature. */
function densifiedBBoxPerimeter(box: TextBBox, step: number): Vec2[] {
  const corners: Vec2[] = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ]
  const out: Vec2[] = []
  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.ceil(len / step))
    for (let j = 0; j < n; j++) { // omit t=1: the next edge starts there
      const t = j / n
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return out
}

/** Nonzero winding number of closed polygon `poly` around `p` (handles the
 *  self-overlapping band a long text wraps around a small closed path). */
function windingNumber(poly: readonly Vec2[], p: Vec2): number {
  let wn = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (a.y <= p.y) {
      if (b.y > p.y && cross > 0) wn++
    } else if (b.y <= p.y && cross < 0) {
      wn--
    }
  }
  return wn
}

/**
 * PICK distance from `p` to an ON-PATH text: the distance to the text's
 * warped bounding BAND along the path. The LOCAL layout bbox rectangle's
 * perimeter is densified at the path tessellation step and warped through the
 * SAME warpLocalToPath the renderer uses, giving a closed world-space band
 * polygon: inside (nonzero winding) -> 0, outside -> distance to the
 * perimeter. HONEST APPROXIMATION: each perimeter vertex warps independently,
 * so on tight curvature the band edges are chordal between samples (error
 * well under the sample step), and on OPEN paths overhanging box ends
 * extrapolate straight along the terminal tangent exactly like the glyphs
 * themselves. Infinity for degenerate text or an unsampleable path. Used by
 * the sketch pick path only; snapping keeps the stroke/contour metrics.
 */
export function textOnPathPickDistance(
  e: SketchTextEntity, path: SketchEntity, p: Vec2,
): number {
  // `mirrored` shifts the local bbox (side bearings swap under the advance-
  // midpoint reflection), so the band must be built from the MIRRORED layout.
  const box = e.fontStyle === 'outline'
    ? outlineTextLocalBBox(
        e.text, e.height, {
          fontFamily: e.fontFamily, mirrored: e.mirrored,
          letterSpacingMm: e.letterSpacingMm,
        },
      )
    : textLocalBBox(e.text, e.height, {
        mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm,
      })
  if (!box) return Infinity
  const lut = pathLUT(path)
  if (!lut) return Infinity
  const perimeter = densifiedBBoxPerimeter(box, PATH_STEP_MM)
  // SAME start-offset resolution as render/bake: the pick band must sit
  // where the text actually draws for EVERY pathAlign mode.
  const band = warpLocalToPath(
    [perimeter], lut, resolvedStartOffsetMm(e, lut), e.pathFlip ?? false,
  )[0]
  if (band.length < 3) return Infinity
  if (windingNumber(band, p) !== 0) return 0
  let best = Infinity
  const n = band.length
  for (let i = 0; i < n; i++) {
    const a = band[i]
    const b = band[(i + 1) % n] // closed loop: wrap last->first
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    if (d < best) best = d
  }
  return best
}

// ---- Point-in-text hit test (M1c drag-while-typing) -------------------------

/**
 * True when `p` lands ON a text entity within `tol` (world mm). SAME metric
 * dispatch as the sketch pick (sketchLayer entityDistance, text case) so
 * "on the text" means the same thing for hover, select, double-click AND the
 * M1c click-on-edited-text guard: the warped bounding BAND for on-path text,
 * the rotated bbox (outline or single-line) for free text. Inside the box
 * scores 0 (always a hit); a near-miss within `tol` counts too, matching the
 * pick tolerance. A non-text entity is never hit (callers pass whatever the
 * open-edit id resolved to). PURE: usable from the store guard and the
 * viewport without touching the render layer. Degenerate (empty/whitespace)
 * text has no box -> never hit, exactly like the pick metrics.
 */
export function pointHitsTextEntity(
  e: SketchEntity, entities: readonly SketchEntity[], p: Vec2, tol: number,
): boolean {
  if (e.kind !== 'text') return false
  // resolveTextPath is quiet for free text and warns once (deduped) for a
  // dangling pathId -- the free-bbox fallback below then matches rendering.
  const path = resolveTextPath(e, entities)
  const d = path
    ? textOnPathPickDistance(e, path, p)
    : e.fontStyle === 'outline'
      ? distanceToOutlineTextBBox(
          e.text, e.height, e.at, e.rotation ?? 0, p,
          e.fontFamily, e.mirrored, e.letterSpacingMm,
        )
      : distanceToTextBBox(
          e.text, e.height, e.at, e.rotation ?? 0, p,
          { mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm },
        )
  return d <= tol
}

// ---- Path picking (curve hit-test for the attach-to-path gesture) ----------

/** Shortest distance from `p` to a candidate path curve, or null for kinds
 *  that cannot be a path (point, text). Reuses the same nearest-point helpers
 *  as snapping so picks agree with hover. */
export function pathDistance(e: SketchEntity, p: Vec2): number | null {
  switch (e.kind) {
    case 'line': {
      const dx = e.end.x - e.start.x
      const dy = e.end.y - e.start.y
      const len2 = dx * dx + dy * dy
      let t = len2 > 0 ? ((p.x - e.start.x) * dx + (p.y - e.start.y) * dy) / len2 : 0
      t = Math.max(0, Math.min(1, t))
      return Math.hypot(p.x - (e.start.x + t * dx), p.y - (e.start.y + t * dy))
    }
    case 'circle':
      return Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius)
    case 'arc': {
      let sweep = e.endAngle - e.startAngle
      while (sweep <= 0) sweep += TWO_PI
      let rel = Math.atan2(p.y - e.center.y, p.x - e.center.x) - e.startAngle
      rel = ((rel % TWO_PI) + TWO_PI) % TWO_PI
      if (rel <= sweep + 1e-9) return Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius)
      const s = { x: e.center.x + e.radius * Math.cos(e.startAngle), y: e.center.y + e.radius * Math.sin(e.startAngle) }
      const en = { x: e.center.x + e.radius * Math.cos(e.endAngle), y: e.center.y + e.radius * Math.sin(e.endAngle) }
      return Math.min(Math.hypot(p.x - s.x, p.y - s.y), Math.hypot(p.x - en.x, p.y - en.y))
    }
    case 'ellipse':
      return nearestPointOnEllipse(e, p).dist
    case 'elliptical-arc':
      return distanceToEllipticalArc(e, e.startParam, e.endParam, p)
    case 'spline':
      return nearestPointOnSpline(e.points, e.closed, p, e.form).dist
    case 'point':
    case 'text':
    case 'block':
      return null
  }
}

/** Nearest sampleable path curve within `tol` of `world`, excluding `excludeId`
 *  (the text itself), or null. */
export function pickPathEntity(
  entities: readonly SketchEntity[], world: Vec2, tol: number, excludeId?: string,
): SketchEntity | null {
  // Construction curves ARE valid paths (a common use: a construction
  // baseline the text rides but that never bakes) -- do not exclude them.
  let best: { e: SketchEntity; d: number } | null = null
  for (const e of entities) {
    if (e.id === excludeId) continue
    if (!isSampleablePath(e)) continue
    const d = pathDistance(e, world)
    if (d !== null && d <= tol && (!best || d < best.d)) best = { e, d }
  }
  return best?.e ?? null
}

/**
 * THE ONE owner of the text attach-pick tolerance. The text tool's birth
 * click, the select-mode "Attach to path" click AND their hover highlights
 * all pick curves through this helper, which doubles the standard pick
 * tolerance ("near a curve" is deliberately generous for attaching). Callers
 * pass the STANDARD tolWorld; the doubling lives here and nowhere else, so
 * hover and click can never disagree about what would attach.
 */
export function pickTextAttachTarget(
  entities: readonly SketchEntity[], world: Vec2, tolWorld: number, excludeId?: string,
): SketchEntity | null {
  return pickPathEntity(entities, world, tolWorld * 2, excludeId)
}
