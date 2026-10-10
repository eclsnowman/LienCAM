// Pure single-line (engraving) text -> stroke polylines (sketch text, C3-A).
//
// PURE and headless-testable: no store, no three.js, no DOM, no planegcs.
// Turns a string + cap height into an array of OPEN stroke polylines using
// the bundled public-domain Hershey "futural" single-stroke font
// (fonts/hersheySimplex.ts). Each polyline is ONE pen-down stroke -- exactly
// what an ENGRAVE op traces with its tip, so the text bakes to open curves.
//
// LAYOUT: glyphs are laid left-to-right from a BASELINE-LEFT origin (the
// entity anchor sits on the baseline at the left edge of the first glyph).
// The font's raw units have the baseline at y=22 and the cap line at y=1
// (21 units tall, Y DOWN); this module flips Y (so +y is up, baseline = 0)
// and scales so the cap height equals the requested `height` (mm). Glyph
// advance follows the reference renderer (`o` * 1.68). Space advances only.
// Descenders (g, p, y, etc.) extend below y=0; that is correct and bakes.

import type { Vec2 } from '../../types'
import {
  hersheyGlyph,
  HERSHEY_BASELINE,
  HERSHEY_CAP_HEIGHT,
  HERSHEY_ADVANCE_SCALE,
  HERSHEY_SPACE_ADVANCE,
} from './fonts/hersheySimplex'

export interface TextLayoutOpts {
  /** LETTER SPACING (tracking): absolute mm added BETWEEN adjacent glyphs
   *  (negative tightens, positive widens the font's natural spacing). N glyphs
   *  get (N-1) gaps -- no trailing space after the last glyph. Default 0 (the
   *  font's natural spacing). Threaded through layout, advance AND bbox so
   *  every consumer inherits the SAME spaced layout (never a second path). */
  letterSpacingMm?: number
  /** MIRROR the glyphs (flip-TEXT, spec T5b): x-negate the LOCAL layout about
   *  the string's advance midpoint via mirrorLocalLayoutX, so the mirrored
   *  text occupies the SAME [0, advance] span, reading reversed. Default
   *  false. Applied HERE (the local layout) so every consumer -- world
   *  transform, on-path warp, bbox/pick metric, bake -- inherits the one
   *  transform and can never drift. */
  mirrored?: boolean
}

/**
 * THE ONE mirror transform (spec T5b, shared-resolver rule): x-negate LOCAL
 * baseline-left polylines/contours about the string's ADVANCE MIDPOINT
 * (x -> advanceMm - x; y untouched). Mirroring about the advance midpoint --
 * NOT about x = 0 -- keeps the mirrored layout inside the SAME [0, advance]
 * span as the unmirrored one (mirroring preserves the occupied span), so the anchor,
 * on-path alignment offsets (effectiveStartOffsetMm uses the same advance)
 * and the pick band all stay put; mirroring about x = 0 would instead throw
 * the text to the anchor's other side. Called ONLY by the two local layout
 * producers (textToPolylines here, outlineTextToContours in textOutline.ts);
 * consumers must pass `mirrored` through the layout opts, never re-negate.
 */
export function mirrorLocalLayoutX(
  polys: Vec2[][], advanceMm: number,
): Vec2[][] {
  return polys.map((poly) => poly.map((p) => ({ x: advanceMm - p.x, y: p.y })))
}

/** True when the text would produce no engraving (empty / whitespace-only
 *  string or non-positive height). Such text is excluded from render + bake. */
export function isDegenerateText(text: string, height: number): boolean {
  return !(height > 0) || text.trim().length === 0
}

/** Per-character RAW advance (Hershey units, `opts.letterSpacingMm` excluded). The
 *  ONE source for pen stepping, shared by textToPolylines (layout) and
 *  textAdvanceWidth (alignment measurement) so the two can never drift:
 *  space / tab (4 spaces) / unknown-code-point advances here ARE the
 *  layout's. */
function charRawAdvance(ch: string): number {
  const code = ch.codePointAt(0) ?? 32
  if (code === 32) return HERSHEY_SPACE_ADVANCE * HERSHEY_ADVANCE_SCALE
  if (ch === '\t') return 4 * HERSHEY_SPACE_ADVANCE * HERSHEY_ADVANCE_SCALE
  const glyph = hersheyGlyph(code)
  return (glyph ? glyph.advance : HERSHEY_SPACE_ADVANCE) * HERSHEY_ADVANCE_SCALE
}

/**
 * UNTRIMMED advance width (mm) of the laid-out string: the pen X position
 * after the LAST character, leading/trailing whitespace INCLUDED (spec T3 --
 * whitespace counts toward on-path alignment). This is NOT the layout bbox
 * X-extent: a trailing space advances the pen but adds no stroke geometry,
 * and the first glyph's side bearing keeps bbox.minX off 0. 0 for empty text
 * or height <= 0 (whitespace-only text still measures a real advance --
 * stricter degeneracy is the layout's concern, not the pen's).
 */
export function textAdvanceWidth(
  text: string, height: number, opts: TextLayoutOpts = {},
): number {
  if (!(height > 0) || text.length === 0) return 0
  const scale = height / HERSHEY_CAP_HEIGHT
  const spacingRaw = (opts.letterSpacingMm ?? 0) / scale // mm spacing -> raw units
  let penRawX = 0
  let first = true
  for (const ch of text) {
    // Letter spacing sits BETWEEN glyphs: add it before every glyph except the
    // first, so N glyphs get (N-1) gaps and no trailing space accrues.
    if (!first) penRawX += spacingRaw
    first = false
    penRawX += charRawAdvance(ch)
  }
  return penRawX * scale
}

/**
 * Tessellate `text` to OPEN stroke polylines in LOCAL coordinates, with a
 * baseline-left origin and the cap height scaled to `height`. Returns an
 * empty array for degenerate input (empty/whitespace text or height <= 0).
 * Each returned polyline is one continuous pen-down stroke; unknown code
 * points render the font's "tofu" box so nothing silently disappears.
 */
export function textToPolylines(
  text: string, height: number, opts: TextLayoutOpts = {},
): Vec2[][] {
  if (isDegenerateText(text, height)) return []
  const scale = height / HERSHEY_CAP_HEIGHT
  const spacingRaw = (opts.letterSpacingMm ?? 0) / scale // mm spacing -> raw units
  const out: Vec2[][] = []
  let penRawX = 0 // pen X in RAW Hershey units (advance accumulates here)
  let first = true
  for (const ch of text) {
    // Letter spacing (tracking) sits BETWEEN glyphs: add it before every glyph
    // except the first, so N glyphs get (N-1) gaps and the last glyph adds no
    // trailing space. Same accumulation as textAdvanceWidth (one pen source).
    if (!first) penRawX += spacingRaw
    first = false
    const code = ch.codePointAt(0) ?? 32
    // Space / tab / unknown code point emit no strokes; every character
    // advances the pen via the SHARED charRawAdvance (one pen source).
    const glyph = code === 32 || ch === '\t' ? null : hersheyGlyph(code)
    if (glyph) {
      for (const stroke of glyph.strokes) {
        const poly: Vec2[] = stroke.map((p) => ({
          x: (penRawX + p.x) * scale,
          // Flip Y: raw baseline (22) -> 0, cap line (1) -> +21*scale = height.
          y: (HERSHEY_BASELINE - p.y) * scale,
        }))
        if (poly.length >= 2) out.push(poly)
      }
    }
    // Spacing was already added BEFORE this glyph (above); only the glyph's own
    // advance accrues here, so penRawX matches textAdvanceWidth exactly.
    penRawX += charRawAdvance(ch)
  }
  // Mirror (T5b) as the LAST local-layout step, before any world/warp
  // transform. penRawX * scale is exactly textAdvanceWidth (same pen
  // accumulation), so the mirrored layout spans the same [0, advance].
  return opts.mirrored ? mirrorLocalLayoutX(out, penRawX * scale) : out
}

/** Rotate `p` by `rot` radians about the origin, then translate by `at`. */
function place(p: Vec2, at: Vec2, cos: number, sin: number): Vec2 {
  return {
    x: at.x + p.x * cos - p.y * sin,
    y: at.y + p.x * sin + p.y * cos,
  }
}

/**
 * THE ONE free-text local->world placement: rotate LOCAL baseline-left
 * polylines by `rotation` (radians, CCW) about the origin, then translate to
 * `at`. Extracted from textToWorldPolylines so the in-canvas CARET (M1b,
 * textCaretWorldSegment in textOnPath.ts) rides the EXACT transform the
 * glyphs use and can never disagree with where they emit.
 */
export function placeLocalPolylines(
  local: readonly (readonly Vec2[])[], at: Vec2, rotation = 0,
): Vec2[][] {
  if (rotation === 0) {
    return local.map((poly) => poly.map((p) => ({ x: at.x + p.x, y: at.y + p.y })))
  }
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return local.map((poly) => poly.map((p) => place(p, at, cos, sin)))
}

/**
 * WORLD-space stroke polylines for a text entity: the local layout
 * (textToPolylines) rotated by `rotation` (radians, CCW) about the anchor
 * and translated to `at` (the baseline-left origin). Used by render + bake.
 */
export function textToWorldPolylines(
  text: string, height: number, at: Vec2, rotation = 0, opts: TextLayoutOpts = {},
): Vec2[][] {
  return placeLocalPolylines(textToPolylines(text, height, opts), at, rotation)
}

/**
 * Shortest distance from `p` to any of the text's strokes (world space),
 * for SNAPPING (snap.ts on-curve candidates want the actual glyph strokes).
 * Infinity when the text is degenerate (no strokes). Not a closed-form solve
 * -- it projects onto the tessellated stroke chords, accurate well under a
 * glyph stroke (the text is solver-inert; this only drives snapping and
 * tool-target picks). The PICK/hover/double-click path uses the far wider
 * distanceToTextBBox instead -- clicking inside a letter counter or between
 * glyphs must select the text, not miss it.
 */
export function distanceToText(
  text: string, height: number, at: Vec2, rotation: number, p: Vec2,
  opts: TextLayoutOpts = {},
): number {
  const strokes = textToWorldPolylines(text, height, at, rotation, opts)
  let best = Infinity
  for (const poly of strokes) {
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i], b = poly[i + 1]
      const dx = b.x - a.x, dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
      t = Math.max(0, Math.min(1, t))
      const qx = a.x + t * dx, qy = a.y + t * dy
      const d = Math.hypot(qx - p.x, qy - p.y)
      if (d < best) best = d
    }
  }
  return best
}

// ---- Bounding-box pick metric (D-E) ----------------------------------------
//
// The PICK target for text is its full BOX, not the glyph strokes: with the
// stroke metric an 8px tolerance misses inside an 'O' counter and between
// glyphs, making the double-click-to-edit target impossibly narrow. The box
// is derived from the ACTUAL laid-out geometry (so it is exactly the visual
// extent: advance width wide, cap-to-descender tall, inter-glyph gaps
// included) rather than a padded heuristic -- a tight box never steals clicks
// meant for entities behind the text, and the pick tolerance already adds an
// 8px halo on top. SNAPPING keeps the stroke metric above.

/** Axis-aligned extent of a text's LOCAL layout (baseline-left frame, +y up;
 *  descenders push minY below 0). */
export interface TextBBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Union bbox of polyline/contour vertices, or null when there are none.
 *  Shared by the single-line and outline bbox metrics. */
export function polylinesBBox(polys: readonly (readonly Vec2[])[]): TextBBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const poly of polys) {
    for (const p of poly) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null
}

/** LOCAL-layout bbox of single-line text (from the actual stroke geometry),
 *  or null for degenerate input. */
export function textLocalBBox(
  text: string, height: number, opts: TextLayoutOpts = {},
): TextBBox | null {
  return polylinesBBox(textToPolylines(text, height, opts))
}

/**
 * Distance from world point `p` to a text's LOCAL bbox placed at `at` and
 * rotated by `rotation` (the box rotates WITH the text): 0 inside the box,
 * else the distance to its nearest edge. Shared by the single-line and
 * outline pick metrics (the box already contains every stroke, so its
 * distance is <= any stroke distance for outside points -- no min() needed).
 */
export function distanceToPlacedTextBBox(
  box: TextBBox, at: Vec2, rotation: number, p: Vec2,
): number {
  // Inverse-transform p into the local layout frame (translate, then -rot).
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const dxw = p.x - at.x
  const dyw = p.y - at.y
  const lx = dxw * cos + dyw * sin
  const ly = -dxw * sin + dyw * cos
  const dx = Math.max(box.minX - lx, 0, lx - box.maxX)
  const dy = Math.max(box.minY - ly, 0, ly - box.maxY)
  return Math.hypot(dx, dy)
}

/**
 * PICK distance from `p` to a FREE single-line text: 0 anywhere inside the
 * rotated layout bounding box (counters and inter-glyph gaps included), else
 * the distance to the box. Infinity when the text is degenerate. Used by the
 * sketch pick path (hover/select/double-click); snapping keeps distanceToText.
 */
export function distanceToTextBBox(
  text: string, height: number, at: Vec2, rotation: number, p: Vec2,
  opts: TextLayoutOpts = {},
): number {
  const box = textLocalBBox(text, height, opts)
  if (!box) return Infinity
  return distanceToPlacedTextBBox(box, at, rotation, p)
}
