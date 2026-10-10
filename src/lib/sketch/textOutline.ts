// Outline (filled-glyph / TTF-style) text -> CLOSED contour + hole polylines
// (sketch text, item C3 part B). The companion to text.ts: where the Hershey
// single-line path engraves OPEN centerline strokes, this produces the FILLED
// glyph boundary -- an outer contour plus interior holes (the counter in
// 'O'/'A'/'e') -- so the text can be pocketed / contoured like any other
// closed region.
//
// FONT: "Rounded Mplus 1c" (M PLUS Rounded 1c) Regular -- SIL OPEN FONT
// LICENSE 1.1, Copyright 2016 The Rounded M+ Project Authors. Bundled here as
// an ASCII-subset typeface.json (fonts/mplusRounded1cAscii.typeface.json,
// printable ASCII 0x20..0x7e, ~44 KB; the full OFL text is alongside it in
// fonts/MPLUSRounded1c-OFL.txt). It is the SAME OFL font three.js ships in
// examples/fonts/MPLUSRounded1c, subset to keep the bundle small.
//
// NO NEW NPM DEPENDENCY: the font is parsed with three.js's own FontLoader
// (three is already a project dependency). The IMPURE font parse + glyph
// tessellation is isolated in `rawGlyphShapes` / `outlineFont` so the
// layout + scaling math (shapesToContours) stays pure and headless-testable.

import { FontLoader, type Font } from 'three/examples/jsm/loaders/FontLoader.js'
import type { Vec2 } from '../../types'
import {
  isDegenerateText, polylinesBBox, distanceToPlacedTextBBox, mirrorLocalLayoutX,
  type TextBBox,
} from './text'
import fontData from './fonts/mplusRounded1cAscii.typeface.json'
// Additional BUILT-IN faces: the typeface.json files three.js already ships in
// examples/fonts: the MgOpen faces (MgOpen licence, Copyright (c) 2004 MAGENTA
// Ltd.; see THIRD_PARTY_LICENSES.md). Imported directly (Vite reads JSON) so there
// is NO new npm dependency. Regular weights only in this pass.
import helvetikerData from 'three/examples/fonts/helvetiker_regular.typeface.json'
import gentilisData from 'three/examples/fonts/gentilis_regular.typeface.json'
import optimerData from 'three/examples/fonts/optimer_regular.typeface.json'
// Bold weights, also shipped by three.js examples (same MgOpen licence,
// no new npm dependency), to give the picker a fuller built-in list.
import helvetikerBoldData from 'three/examples/fonts/helvetiker_bold.typeface.json'
import gentilisBoldData from 'three/examples/fonts/gentilis_bold.typeface.json'
import optimerBoldData from 'three/examples/fonts/optimer_bold.typeface.json'

/** One closed glyph ring: an outer glyph contour or an interior counter
 *  (hole). `points` carries NO duplicate closing vertex (Loop2D convention);
 *  the loop is implicitly closed (last -> first). */
export interface OutlineContour {
  points: Vec2[]
  /** True for an interior counter (e.g. the hole in 'O'/'A'); false for an
   *  outer glyph boundary. The bake RE-DERIVES contour/hole by containment
   *  nesting; this flag is exposed for render + pick. */
  isHole: boolean
}

export interface OutlineTextOpts {
  /** Bezier subdivisions per glyph curve (three Shape.extractPoints arg).
   *  Higher = smoother boundary, more vertices. Default 8. */
  divisions?: number
  /** Font family name (registry key). Unset -> the default M+ face (the
   *  default text path stays byte-identical). An unknown family falls back to
   *  the default with a named, logged notice (never a silent swap). */
  fontFamily?: string
  /** MIRROR the glyphs (flip-TEXT, spec T5b): x-negate the LOCAL contours
   *  about the string's advance midpoint via text.ts mirrorLocalLayoutX (THE
   *  one shared transform), so the mirrored text occupies the SAME
   *  [0, advance] span, reading reversed. Default false. Contour winding
   *  reverses under the reflection; the bake re-derives contour/hole by
   *  containment nesting and then NORMALIZES winding to type, so hole
   *  classification is unaffected (proved by test). */
  mirrored?: boolean
  /** LETTER SPACING (tracking): absolute mm added BETWEEN adjacent glyphs
   *  (negative tightens, positive widens). N glyphs get (N-1) gaps -- no
   *  trailing space after the last glyph; the pen resets per line ('\n'), like
   *  three's own layout. Default 0 (the font's natural spacing). Threaded
   *  through layout, advance AND bbox so every consumer inherits the SAME
   *  spaced layout (never a second path). */
  letterSpacingMm?: number
}

/** Raw glyph outline from three (font em units, baseline y=0, +y up, laid
 *  left-to-right): one outer ring + its interior hole rings. */
export interface RawGlyphShape {
  shape: Vec2[]
  holes: Vec2[][]
}

// ---- Font REGISTRY (isolated, impure parse per family) --------------------
//
// The single hardcoded face was replaced by a registry keyed by family name:
// several BUILT-IN faces plus ADD-YOUR-OWN imported faces (registerFont). Each
// face is parsed + cap-measured LAZILY, once, on first use. The DEFAULT family
// resolves to the original bundled M+ face with the SAME resolution + cap-height
// math, so default text is byte-identical to before.

/** Family name of the built-in default face (the bundled OFL M+ Rounded 1c
 *  ASCII subset). A text entity with `fontFamily` unset resolves to THIS. */
export const DEFAULT_FONT_FAMILY = 'Rounded Mplus 1c'

interface RegisteredFont { font: Font; capHeightEm: number; resolution: number }

// family name -> raw typeface JSON (parsed lazily). Built-ins seeded at module
// load; imported faces added via registerFont (also restored from persistence).
const _fontJson = new Map<string, unknown>([
  [DEFAULT_FONT_FAMILY, fontData],
  ['Helvetiker', helvetikerData],
  ['Helvetiker Bold', helvetikerBoldData],
  ['Gentilis', gentilisData],
  ['Gentilis Bold', gentilisBoldData],
  ['Optimer', optimerData],
  ['Optimer Bold', optimerBoldData],
])
const BUILTIN_FAMILIES: readonly string[] = [
  DEFAULT_FONT_FAMILY,
  'Helvetiker', 'Helvetiker Bold',
  'Gentilis', 'Gentilis Bold',
  'Optimer', 'Optimer Bold',
]
// Imported (non-built-in) family names in registration order, for the picker.
const _importedFamilies: string[] = []
// Parsed + cap-measured faces, cached per family (the impure parse runs once).
const _parsed = new Map<string, RegisteredFont>()

// Missing-family reporting: named + logged, never silent (ADR-0003). Deduped so
// one unknown family warns once; the store wires a UI notice via the reporter.
const _warnedMissing = new Set<string>()
let _missingReporter: ((family: string) => void) | null = null
/** Wire a UI-notice sink for missing-font fallbacks (store bridges to the
 *  status-bar sketch notice). Pass null to detach. */
export function setMissingFontReporter(fn: ((family: string) => void) | null): void {
  _missingReporter = fn
}

/** Measure cap height (top of a flat 'H') in font em units for `font` rendered
 *  at `resolution`, so a layout can scale cap-height -> requested mm height. */
function measureCapHeight(font: Font, resolution: number): number {
  const shapes = font.generateShapes('H', resolution)
  let maxY = 0
  for (const s of shapes) for (const p of s.extractPoints(2).shape) {
    if (p.y > maxY) maxY = p.y
  }
  return maxY > 0 ? maxY : resolution
}

/** Resolve a family name to its parsed face (parse-once). Unknown family ->
 *  the default face + a named, logged notice (never a silent swap). Exported
 *  for tests + the registry's own consumers. */
export function outlineFont(family?: string): RegisteredFont {
  let key = family ?? DEFAULT_FONT_FAMILY
  if (!_fontJson.has(key)) {
    if (family && !_warnedMissing.has(family)) {
      _warnedMissing.add(family)
      console.warn(
        `[sketch text] font family "${family}" is not registered; ` +
        `rendering with "${DEFAULT_FONT_FAMILY}"`,
      )
      _missingReporter?.(family)
    }
    key = DEFAULT_FONT_FAMILY
  }
  let reg = _parsed.get(key)
  if (!reg) {
    const json = _fontJson.get(key)!
    const resolution = (json as { resolution: number }).resolution
    const font = new FontLoader().parse(
      json as unknown as Parameters<FontLoader['parse']>[0],
    )
    reg = { font, capHeightEm: measureCapHeight(font, resolution), resolution }
    _parsed.set(key, reg)
  }
  return reg
}

// ---- Imported faces are CONTENT-ADDRESSED (WO-1456) -----------------------
//
// An imported face registers under `<family>#sha256:<digest of the font file>`,
// never under its bare family name. Text binds to that key, so a byte-different
// file sharing the family name is a different key and can never change text
// authored against the earlier file, in this project or any other. The project
// carries the typeface under the same digest (Project.fonts), so the key alone
// is enough to resolve it again on open.
const CONTENT_KEY_MARK = '#sha256:'

/** Registry key for an imported face: family + the digest of its file bytes. */
export function importedFontKey(family: string, contentId: string): string {
  return `${family}${CONTENT_KEY_MARK}${contentId}`
}

/** The content digest a registry key is bound to, or null for a plain key. */
export function importedFontContentId(key: string | undefined): string | null {
  if (!key) return null
  const at = key.lastIndexOf(CONTENT_KEY_MARK)
  if (at < 0) return null
  const id = key.slice(at + CONTENT_KEY_MARK.length)
  return /^[a-f0-9]{64}$/.test(id) ? id : null
}

/** Human family name for a registry key (strips the content digest). */
export function fontDisplayName(key: string): string {
  return importedFontContentId(key) === null ? key : key.slice(0, key.lastIndexOf(CONTENT_KEY_MARK))
}

/** The registered typeface JSON for `key`, without three's render caches
 *  (`_cachedOutline` is written onto glyphs in place the first time a glyph is
 *  drawn), so it can be embedded as a clean project asset. */
export function registeredFontTypeface(key: string): unknown | undefined {
  if (!_fontJson.has(key)) return undefined
  return JSON.parse(JSON.stringify(_fontJson.get(key), (k, v) => (k === '_cachedOutline' ? undefined : v)))
}

/** Register an imported typeface JSON under `family` (a re-register replaces).
 *  Used by the toolbox import button AND by persisted-font restore on load.
 *  A content-addressed key is immutable: registering it again is a no-op. */
export function registerFont(family: string, typefaceJson: unknown): void {
  if (importedFontContentId(family) !== null && _fontJson.has(family)) return
  _fontJson.set(family, typefaceJson)
  _parsed.delete(family)       // force a re-parse on next use
  _warnedMissing.delete(family)
  if (!BUILTIN_FAMILIES.includes(family) && !_importedFamilies.includes(family)) {
    _importedFamilies.push(family)
  }
}

/** True when `family` is currently registered (built-in or imported). */
export function isFontRegistered(family: string): boolean {
  return _fontJson.has(family)
}

/** Picker list: built-ins first, then imported families in registration order. */
export function listFontFamilies(): string[] {
  return [...BUILTIN_FAMILIES, ..._importedFamilies]
}

// ---- UNIFIED font picker (single-line + all outline faces in one control) --
//
// The toolbox no longer hides the font choice behind an "outline" toggle. A
// single always-visible dropdown lists the Hershey single-line/engrave face
// FIRST, then every outline family. A pick maps to (style, family) in one
// action (store.setSketchTextFont): the sentinel below selects single-line;
// any other value selects outline + that family.

/** Reserved picker value for the single-line (Hershey stroke) face. Not a real
 *  registry key (never collides with a font family name). */
export const SINGLE_LINE_FONT_VALUE = '__single_line_hershey__'
/** Human label for the single-line entry in the unified picker. */
export const SINGLE_LINE_FONT_LABEL = 'Hershey (single-line / engrave)'

export interface FontPickerOption {
  /** Picker <option> value: the sentinel for single-line, else a family key. */
  value: string
  /** Human-readable label. */
  label: string
  /** True for the single-line Hershey entry (style 'single-line'). */
  isSingleLine: boolean
}

/** Options for the unified Font dropdown: the single-line/engrave face first,
 *  then every outline family (built-ins then imported). */
export function fontPickerOptions(): FontPickerOption[] {
  const families = listFontFamilies()
  const names = families.map(fontDisplayName)
  return [
    { value: SINGLE_LINE_FONT_VALUE, label: SINGLE_LINE_FONT_LABEL, isSingleLine: true },
    ...families.map((f, i) => {
      // Two imported files sharing a family name stay distinguishable.
      const id = importedFontContentId(f)
      const shared = id !== null && names.indexOf(names[i]) !== names.lastIndexOf(names[i])
      return { value: f, label: shared ? `${names[i]} (${id.slice(0, 8)})` : names[i], isSingleLine: false }
    }),
  ]
}

/** IMPURE: tessellate `text` to raw glyph outlines in font em units
 *  (baseline-left origin, +y up), using `family`'s face (default when unset).
 *  Empty for degenerate input. Isolated from the pure layout so tests can
 *  either drive it for real or mock its output.
 *
 *  `spacingEm` (default 0) is the LETTER-SPACING gap in EM units (the caller
 *  converts mm -> em with the same cap-height scale the contours use). At 0
 *  the whole-string layout is used verbatim, so default text stays
 *  byte-identical. Nonzero spacing shifts each glyph's shapes rightward by the
 *  cumulative inter-glyph gap: glyph<->shape correlation reuses three's own
 *  layout (generateShapes emits shapes in character order, contiguously per
 *  glyph; generateShapes(char) reports how many shapes a glyph yields, since
 *  'i'/'=' etc. produce several), so three's kerning-free advance AND its
 *  per-line ('\n') offsetY are preserved and only a horizontal gap is added.
 *  The gap sits BETWEEN glyphs (N glyphs -> (N-1) gaps) and resets each line. */
export function rawGlyphShapes(
  text: string, divisions: number, family?: string, spacingEm = 0,
): RawGlyphShape[] {
  if (text.length === 0) return []
  const { font, resolution } = outlineFont(family)
  const shapes = font.generateShapes(text, resolution)
  if (spacingEm === 0) {
    return shapes.map((s) => {
      const p = s.extractPoints(divisions)
      return {
        shape: p.shape.map((v) => ({ x: v.x, y: v.y })),
        holes: p.holes.map((h) => h.map((v) => ({ x: v.x, y: v.y }))),
      }
    })
  }
  const out: RawGlyphShape[] = []
  const chars = [...text]
  let idx = 0 // index into the whole-string `shapes`, consumed glyph by glyph
  let gapX = 0 // cumulative horizontal gap (em) applied to the current glyph
  let firstOnLine = true
  for (const ch of chars) {
    if (ch === '\n') { gapX = 0; firstOnLine = true; continue } // pen resets
    // The gap sits BEFORE every glyph except the first on its line.
    if (!firstOnLine) gapX += spacingEm
    firstOnLine = false
    const count = font.generateShapes(ch, resolution).length
    for (let k = 0; k < count; k++) {
      const p = shapes[idx++].extractPoints(divisions)
      out.push({
        shape: p.shape.map((v) => ({ x: v.x + gapX, y: v.y })),
        holes: p.holes.map((h) => h.map((v) => ({ x: v.x + gapX, y: v.y }))),
      })
    }
  }
  return out
}

// ---- Pure layout / scaling (testable with mock RawGlyphShape data) --------

/** Drop a ring's duplicate closing vertex (extractPoints repeats the first
 *  point) and scale every vertex uniformly. Returns null for a degenerate
 *  ring (< 3 distinct vertices, which cannot bound an area). */
function ringToScaled(ring: Vec2[], scale: number): Vec2[] | null {
  let pts = ring
  const n = pts.length
  if (n >= 2) {
    const a = pts[0], b = pts[n - 1]
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) pts = pts.slice(0, n - 1)
  }
  if (pts.length < 3) return null
  return pts.map((p) => ({ x: p.x * scale, y: p.y * scale }))
}

/** PURE: scaled closed contours from raw glyph shapes. Outer rings -> contour
 *  (isHole false), interior rings -> hole (isHole true). Scaling is uniform so
 *  the font's cap height maps onto the requested mm height. */
export function shapesToContours(shapes: RawGlyphShape[], scale: number): OutlineContour[] {
  const out: OutlineContour[] = []
  for (const s of shapes) {
    const outer = ringToScaled(s.shape, scale)
    if (outer) out.push({ points: outer, isHole: false })
    for (const h of s.holes) {
      const hole = ringToScaled(h, scale)
      if (hole) out.push({ points: hole, isHole: true })
    }
  }
  return out
}

/**
 * Tessellate `text` to scaled, closed OUTLINE contours in LOCAL coordinates
 * (baseline-left origin, +y up, cap height == `height`). Outer glyph
 * boundaries and interior counters (holes) are returned as separate closed
 * rings. Empty array for degenerate input (empty/whitespace text or height<=0).
 */
export function outlineTextToContours(
  text: string, height: number, opts: OutlineTextOpts = {},
): OutlineContour[] {
  if (isDegenerateText(text, height)) return []
  const { capHeightEm } = outlineFont(opts.fontFamily)
  const scale = height / capHeightEm
  // Letter spacing is authored in mm; the raw glyph layout is in EM units
  // (scaled by `scale` below), so convert mm -> em with the SAME cap-height
  // scale. After shapesToContours multiplies by `scale`, the gap is exactly
  // letterSpacingMm again -- the one conversion, no drift from the advance.
  const spacingMm = opts.letterSpacingMm ?? 0
  const spacingEm = spacingMm === 0 ? 0 : spacingMm / scale
  const shapes = rawGlyphShapes(text, opts.divisions ?? 8, opts.fontFamily, spacingEm)
  const contours = shapesToContours(shapes, scale)
  if (!opts.mirrored) return contours
  // Mirror (T5b) as the LAST local-layout step, before any world/warp
  // transform -- the SAME shared transform the single-line layout uses
  // (text.ts mirrorLocalLayoutX), about the same untrimmed advance, so the
  // two font styles mirror identically in place. isHole flags carry over
  // (the reflection swaps winding, not the outer/counter structure).
  const advance = outlineTextAdvanceWidth(text, height, opts)
  return contours.map((c) => ({
    isHole: c.isHole,
    points: mirrorLocalLayoutX([c.points], advance)[0],
  }))
}

/** Rotate `p` by (cos,sin) about the origin, then translate by `at`. */
function place(p: Vec2, at: Vec2, cos: number, sin: number): Vec2 {
  return {
    x: at.x + p.x * cos - p.y * sin,
    y: at.y + p.x * sin + p.y * cos,
  }
}

/**
 * WORLD-space closed outline contours for a text entity: the local layout
 * rotated by `rotation` (radians, CCW) about the anchor and translated to
 * `at` (the baseline-left origin). Used by render + bake + pick.
 */
export function outlineTextToWorldContours(
  text: string, height: number, at: Vec2, rotation = 0, opts: OutlineTextOpts = {},
): OutlineContour[] {
  const local = outlineTextToContours(text, height, opts)
  if (rotation === 0) {
    return local.map((c) => ({
      isHole: c.isHole,
      points: c.points.map((p) => ({ x: at.x + p.x, y: at.y + p.y })),
    }))
  }
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return local.map((c) => ({
    isHole: c.isHole,
    points: c.points.map((p) => place(p, at, cos, sin)),
  }))
}

/**
 * Shortest distance from `p` to any outline contour edge (world space), for
 * SNAPPING and tool-target picks that want the actual glyph boundary. Each
 * contour is treated as a CLOSED loop (the closing edge is included).
 * Infinity when the text is degenerate (no contours). The PICK/hover/
 * double-click path uses the far wider distanceToOutlineTextBBox instead.
 */
export function distanceToOutlineText(
  text: string, height: number, at: Vec2, rotation: number, p: Vec2,
  fontFamily?: string, mirrored?: boolean, letterSpacingMm?: number,
): number {
  const contours = outlineTextToWorldContours(
    text, height, at, rotation, { fontFamily, mirrored, letterSpacingMm },
  )
  let best = Infinity
  for (const c of contours) {
    const poly = c.points
    const m = poly.length
    for (let i = 0; i < m; i++) {
      const a = poly[i], b = poly[(i + 1) % m] // closed loop: wrap last->first
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

/**
 * UNTRIMMED advance width (mm) of the laid-out outline string: the pen X
 * position after the LAST character, leading/trailing whitespace INCLUDED
 * (spec T3 -- whitespace counts toward on-path alignment). This is NOT the
 * layout bbox X-extent: a trailing space advances the pen but adds no contour
 * geometry, and glyph side bearings keep the bbox edges off the pen
 * positions. Mirrors three's FontLoader pen stepping exactly (glyph `ha`
 * advances, a missing glyph substitutes the face's '?', '\n' resets the pen)
 * so the measured advance matches rawGlyphShapes' layout. 0 for empty text
 * or height <= 0.
 */
export function outlineTextAdvanceWidth(
  text: string, height: number, opts: OutlineTextOpts = {},
): number {
  if (!(height > 0) || text.length === 0) return 0
  const { font, capHeightEm } = outlineFont(opts.fontFamily)
  const glyphs = font.data.glyphs
  // Letter spacing (em units, same conversion as the layout) sits BETWEEN
  // glyphs -- added before every glyph except the first on its line -- so the
  // measured advance matches rawGlyphShapes' spaced layout exactly.
  const spacingMm = opts.letterSpacingMm ?? 0
  const spacingEm = spacingMm === 0 ? 0 : spacingMm * capHeightEm / height
  let advEm = 0 // pen X in font em units (rawGlyphShapes' frame)
  let firstOnLine = true
  for (const ch of text) {
    if (ch === '\n') { advEm = 0; firstOnLine = true; continue } // pen resets
    if (!firstOnLine) advEm += spacingEm
    firstOnLine = false
    const glyph = glyphs[ch] ?? glyphs['?']
    if (glyph) advEm += glyph.ha
  }
  return advEm * (height / capHeightEm)
}

/** LOCAL-layout bbox of outline text (from the actual contour geometry, so
 *  descenders/overshoot are included exactly), or null for degenerate input. */
export function outlineTextLocalBBox(
  text: string, height: number, opts: OutlineTextOpts = {},
): TextBBox | null {
  return polylinesBBox(outlineTextToContours(text, height, opts).map((c) => c.points))
}

/**
 * PICK distance from `p` to a FREE outline text: 0 anywhere inside the
 * rotated layout bounding box (letter counters and inter-glyph gaps
 * included), else the distance to the box. Infinity when the text is
 * degenerate. Used by the sketch pick path (hover/select/double-click);
 * snapping keeps the contour-edge distanceToOutlineText.
 */
export function distanceToOutlineTextBBox(
  text: string, height: number, at: Vec2, rotation: number, p: Vec2,
  fontFamily?: string, mirrored?: boolean, letterSpacingMm?: number,
): number {
  const box = outlineTextLocalBBox(text, height, { fontFamily, mirrored, letterSpacingMm })
  if (!box) return Infinity
  return distanceToPlacedTextBBox(box, at, rotation, p)
}
