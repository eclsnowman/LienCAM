// WO-3012 (WO-2750 Slice F part 1): the one sheet scene PDF and DXF share.
//
// docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md section 5: "one drawing
// projection/annotation scene shared by the editor, PDF and DXF ... visible /
// hidden / center line classes, text outlines and raster placements".
//
// buildSheetScene turns a saved DrawingDocument (document.ts) plus the
// projection of each view (project.ts) into plain, sheet-space data:
//  - millimetres, origin top-left, Y down (plan section 6); a 100 mm source
//    edge at 1:2 is 50 mm here, and the writers add no further scaling;
//  - polylines (already tessellated by the projector, with the worst chord
//    error carried along), exact circles and arcs, glyph outlines, rasters;
//  - what a reader needs to be told: stale/missing/approximate labels with the
//    last-known value, and an issue list the writers print as an export note.
// Nothing here knows PDF or DXF syntax. Pure functions, no I/O, no clock: the
// same document gives the same scene every time.

import { unzlibSync } from 'fflate'
import { outlineFont, outlineTextAdvanceWidth, outlineTextToContours } from '../sketch/textOutline'
import type { DrawingAnnotation, DrawingAsset, DrawingDimension, DrawingDocument, DrawingSheet, DrawingView } from './document'
import { detailCircle, detailCircleOnParent, formatDimensionText } from './annotations'
import { toSheet } from './project'
import { effectiveTemplate, generalToleranceValue, titleBlockRect, titleBlockValues, toleranceBlockRect } from './template'
import type { ProjectionScene, ReferenceReason, ReferenceState, SourceRevision } from './types'

export type SceneLayer = 'FRAME' | 'VISIBLE' | 'HIDDEN' | 'CENTER' | 'DIMENSION' | 'TEXT'

export const SCENE_LAYERS: readonly SceneLayer[] = ['FRAME', 'VISIBLE', 'HIDDEN', 'CENTER', 'DIMENSION', 'TEXT']

export type Pt = [number, number]

export interface ScenePolyline {
  kind: 'polyline'
  layer: SceneLayer
  points: Pt[]
  closed: boolean
}

export interface SceneCircle {
  kind: 'circle'
  layer: SceneLayer
  center: Pt
  radiusMm: number
}

/** Angles are counter-clockwise as seen on the paper (the Y-up convention), degrees. */
export interface SceneArc {
  kind: 'arc'
  layer: SceneLayer
  center: Pt
  radiusMm: number
  startDeg: number
  endDeg: number
}

/**
 * Outlined text. `rings` are closed glyph outlines to fill with the even-odd
 * rule; `strokes` are open polylines (the symbols the font lacks: diameter,
 * degree, plus-minus, and a box standing in for a glyph no font has). `text`
 * is the logical string, kept so a reader of the PDF/DXF can still find it.
 */
export interface SceneText {
  kind: 'text'
  layer: SceneLayer
  text: string
  ownerId?: string
  heightMm: number
  rings: Pt[][]
  strokes: Pt[][]
}

export type SceneItem = ScenePolyline | SceneCircle | SceneArc | SceneText

export interface SceneImage {
  id: string
  name: string
  contentType: string
  kind: 'png' | 'jpeg'
  widthPx: number
  heightPx: number
  bytes: Uint8Array
  /** x, y (top-left), width, height on the sheet, mm */
  rectMm: [number, number, number, number]
}

export type SceneIssueKind =
  | 'reference-state'
  | 'unresolved'
  | 'approximate'
  | 'missing-glyph'
  | 'missing-projection'
  | 'projection-limit'
  | 'unplaced-annotation'
  | 'branding-unsupported'
  | 'branding-missing'

export interface SceneIssue {
  kind: SceneIssueKind
  ownerId?: string
  /** one plain sentence, printed in the export notes */
  message: string
}

export interface SheetScene {
  documentId: string
  documentName: string
  /** `<document id>@<geometry fingerprint the drawing last saw>`; the same string is written into the PDF and the DXF */
  revision: string
  sheetId: string
  sizeMm: [number, number]
  marginsMm: number
  unit: 'mm' | 'inch'
  precision: number
  items: SceneItem[]
  images: SceneImage[]
  issues: SceneIssue[]
  /** worst declared chord error of any tessellated projection line, in SHEET mm */
  maxChordErrorMm: number
  exportTimestamp?: string
}

// ---------------------------------------------------------------------------
// Inputs the document does not hold: what the resolver proved about each
// annotation, and where its geometry sits on this sheet.
// ---------------------------------------------------------------------------

export type AnnotationRender = {
  /** what resolve.ts said; anything but 'current' is printed on the sheet */
  state: ReferenceState
  reason?: ReferenceReason
  /** the proven value in mm (degrees for an angle); used only when state is 'current' */
  valueMm?: number
  /** mesh fit deviation: an approximate value says so beside it */
  approximate?: { maxDeviationMm: number }
  /** sheet-space anchors; with none, only the label is drawn at labelSheetMm */
  linear?: { from: Pt; to: Pt; offsetMm?: number }
  radial?: { center: Pt; radiusMm: number; angleDeg: number }
  angular?: { vertex: Pt; fromDeg: number; toDeg: number; radiusMm: number }
  /**
   * The lines and arrows the editor itself draws for this dimension (annotations.ts dimensionGraphic), in
   * sheet mm. Wins over linear/radial/angular, so the file shows what the operator sees. An arrow's `dir`
   * is the direction of travel toward its tip, the way the editor draws it. `label` is where the editor puts the text.
   */
  graphic?: { lines: Array<[Pt, Pt]>; arrows: Array<{ tip: Pt; dir: Pt }>; label: Pt }
}

export interface SceneInputs {
  /** projection of each view, by view id (a detail view may reuse its parent's) */
  projections: Record<string, ProjectionScene | undefined>
  /** by annotation id */
  annotations?: Record<string, AnnotationRender | undefined>
  /** the part's display name for the title block (the editor passes the Model tree name); default: the drawing's name */
  partName?: string
  /** default: the first sheet */
  sheetId?: string
  /** written only when asked for, so default exports are byte-stable */
  exportTimestamp?: string
  fontFamily?: string
}

// ---------------------------------------------------------------------------
// Text: outlines, with the symbols the bundled fonts lack drawn as strokes.
// ---------------------------------------------------------------------------

export interface TextLayout {
  rings: Pt[][]
  strokes: Pt[][]
  widthMm: number
  /** characters no font and no symbol covers, in order */
  missing: string[]
}

const SYMBOL_WIDTH = 0.7 // em of cap height
/** Glyph rings are thinned to this chord distance: far inside the 0.05 mm sheet-space budget. */
const GLYPH_THIN_MM = 0.01

function symbolStrokes(ch: string, h: number): { strokes: Pt[][]; advance: number } | null {
  const w = SYMBOL_WIDTH * h
  const circle = (cx: number, cy: number, r: number): Pt[] => Array.from({ length: 25 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt
  })
  switch (ch) {
    case '⌀': // diameter sign
    case 'Ø':
      return { advance: w + 0.2 * h, strokes: [circle(w / 2, h / 2, w / 2 * 0.95), [[0, -0.1 * h], [w, 1.1 * h]]] }
    case '°': // degree
      return { advance: 0.4 * h, strokes: [circle(0.15 * h, 0.82 * h, 0.15 * h)] }
    case '±': // plus-minus
      return {
        advance: w + 0.2 * h,
        strokes: [[[w / 2, 0.35 * h], [w / 2, 0.95 * h]], [[w / 2 - 0.3 * h, 0.65 * h], [w / 2 + 0.3 * h, 0.65 * h]], [[w / 2 - 0.3 * h, 0.1 * h], [w / 2 + 0.3 * h, 0.1 * h]]],
      }
    default:
      return null
  }
}

/** Drop vertices that sit within `tol` of the chord between their kept neighbours (glyph curves are over-sampled). */
function thin(ring: Pt[], tol: number): Pt[] {
  if (ring.length < 4) return ring
  const out: Pt[] = [ring[0]]
  for (let i = 1; i < ring.length - 1; i++) {
    const a = out[out.length - 1], p = ring[i], b = ring[i + 1]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const l = Math.hypot(dx, dy)
    const dist = l === 0 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / l
    if (dist >= tol) out.push(p)
  }
  out.push(ring[ring.length - 1])
  return out.length >= 3 ? out : ring
}

function boxStroke(h: number): { strokes: Pt[][]; advance: number } {
  const w = 0.6 * h
  return { advance: w + 0.2 * h, strokes: [[[0, 0], [w, 0], [w, h], [0, h], [0, 0]]] }
}

/**
 * Lay out one line of text at its baseline-left origin (0, 0), +Y up, cap
 * height `heightMm`. Callers place and flip it with placeText.
 */
export function layoutText(text: string, heightMm: number, fontFamily?: string): TextLayout {
  const rings: Pt[][] = []
  const strokes: Pt[][] = []
  const missing: string[] = []
  let x = 0
  let run = ''
  const glyphs = outlineFont(fontFamily).font.data.glyphs
  const flush = () => {
    if (!run) return
    for (const c of outlineTextToContours(run, heightMm, { fontFamily, divisions: 3 })) rings.push(thin(c.points.map(p => [p.x + x, p.y] as Pt), GLYPH_THIN_MM))
    x += outlineTextAdvanceWidth(run, heightMm, { fontFamily })
    run = ''
  }
  for (const ch of text) {
    const sym = symbolStrokes(ch, heightMm)
    if (sym || !glyphs[ch]) {
      flush()
      const drawn = sym ?? boxStroke(heightMm)
      if (!sym) missing.push(ch)
      for (const s of drawn.strokes) strokes.push(s.map(p => [p[0] + x, p[1]] as Pt))
      x += drawn.advance
    } else {
      run += ch
    }
  }
  flush()
  return { rings, strokes, widthMm: x, missing }
}

function placeAt(points: Pt[], at: Pt): Pt[] {
  return points.map(p => [at[0] + p[0], at[1] - p[1]] as Pt)
}

// ---------------------------------------------------------------------------
// Raster branding
// ---------------------------------------------------------------------------

export type RasterInfo =
  | { ok: true; kind: 'png' | 'jpeg'; widthPx: number; heightPx: number; bytes: Uint8Array }
  | { ok: false; reason: string }

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The PNG/JPEG shapes the PDF writer can embed unchanged or after a lossless repack. */
export function inspectRaster(asset: DrawingAsset): RasterInfo {
  let bytes: Uint8Array
  try { bytes = decodeBase64(asset.dataBase64) } catch { return { ok: false, reason: 'its data is not valid base64' } }
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const widthPx = dv.getUint32(16)
    const heightPx = dv.getUint32(20)
    const bitDepth = bytes[24]
    const colorType = bytes[25]
    const interlace = bytes[28]
    if (interlace !== 0) return { ok: false, reason: 'interlaced PNG files are not supported' }
    const supported = (colorType === 0 || colorType === 2 || colorType === 3 || colorType === 4 || colorType === 6) && bitDepth <= 8 && (bitDepth === 8 || colorType === 0 || colorType === 3)
    if (!supported) return { ok: false, reason: `a ${bitDepth}-bit PNG of colour type ${colorType} is not supported (use 8-bit)` }
    if (widthPx < 1 || heightPx < 1 || widthPx * heightPx > 64_000_000) return { ok: false, reason: 'the PNG has no pixels or is larger than 64 megapixels' }
    // walk the chunks: the data must inflate, a palette image needs its palette, colour-key transparency is not applied
    const idat: Uint8Array[] = []
    let hasPlte = false
    let hasTrns = false
    let at = 8
    const dv2 = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    while (at + 8 <= bytes.length) {
      const clen = dv2.getUint32(at)
      const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
      if (at + 12 + clen > bytes.length) return { ok: false, reason: 'the PNG is cut short' }
      if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + clen))
      if (type === 'PLTE') hasPlte = true
      if (type === 'tRNS') hasTrns = true
      at += 12 + clen
    }
    if (idat.length === 0) return { ok: false, reason: 'the PNG has no image data' }
    if (colorType === 3 && !hasPlte) return { ok: false, reason: 'the PNG has no palette' }
    if (hasTrns) return { ok: false, reason: 'PNG transparency colour keys (tRNS) are not supported; use an alpha channel' }
    try {
      const total = idat.reduce((n, c) => n + c.length, 0)
      const joined = new Uint8Array(total)
      let o = 0
      for (const c of idat) { joined.set(c, o); o += c.length }
      unzlibSync(joined)
    } catch { return { ok: false, reason: 'the PNG image data is damaged' } }
    return { ok: true, kind: 'png', widthPx, heightPx, bytes }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue }
      const marker = bytes[i + 1]
      if (marker === 0xff) { i++; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const heightPx = (bytes[i + 5] << 8) | bytes[i + 6]
        const widthPx = (bytes[i + 7] << 8) | bytes[i + 8]
        const components = bytes[i + 9]
        if (components !== 1 && components !== 3) return { ok: false, reason: `a JPEG with ${components} colour components is not supported` }
        if (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) return { ok: false, reason: 'this JPEG variant is not supported' }
        return { ok: true, kind: 'jpeg', widthPx, heightPx, bytes }
      }
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3])
    }
    return { ok: false, reason: 'the JPEG has no frame header' }
  }
  return { ok: false, reason: `its format (${asset.contentType || 'unknown'}) is not PNG or JPEG` }
}

// ---------------------------------------------------------------------------
// Dimension text
// ---------------------------------------------------------------------------

const MM_PER_INCH = 25.4

function stateWord(state: ReferenceState): string {
  return state.toUpperCase()
}

function reasonWords(reason: ReferenceReason | undefined): string {
  return reason ? reason.replace(/-/g, ' ').toUpperCase() : ''
}

function shortRevision(rev: SourceRevision | undefined): string {
  return rev ? rev.geometryFingerprint.slice(0, 8) : 'none'
}

function fixed(value: number, precision: number): string {
  const s = value.toFixed(Math.max(0, Math.min(8, precision)))
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s
}

export interface DimensionLabel {
  main: string
  /** stacked tolerance text, upper then lower */
  tolerance: string[]
  /** small lines under the value: state, reason, last-known revision, fit deviation */
  notes: string[]
  lastKnown: boolean
}

/**
 * The words a dimension shows. The value and tolerance text come from the
 * editor's own formatDimensionText (annotations.ts), so the sheet and the
 * export cannot say different things: a general dimension prints its pinned
 * +/- when that differs from the table (`table` is what the table gives now),
 * and stored limits are only ever displayed in the sheet's unit. A value that
 * is not proved current on this export is the last-known value, flagged; it is
 * never printed as if fresh (plan section 4.2 step 7).
 */
export function dimensionLabel(dim: DrawingDimension, sheet: Pick<DrawingSheet, 'unit' | 'precision'>, render: AnnotationRender | undefined, table?: number): DimensionLabel {
  const precision = dim.precision ?? sheet.precision
  const isAngle = dim.measurement === 'angle'
  const toUnit = (mm: number) => (!isAngle && sheet.unit === 'inch' ? mm / MM_PER_INCH : mm)
  const notes: string[] = []
  let value: number | undefined
  let lastKnown = false
  if (!render) {
    value = dim.lastGood?.value
    lastKnown = true
    notes.push('UNRESOLVED')
  } else if (render.state === 'current' && render.valueMm !== undefined) {
    value = render.valueMm
  } else if (render.state === 'current') {
    value = dim.lastGood?.value
    lastKnown = value !== undefined
    notes.push('UNRESOLVED')
  } else {
    value = dim.lastGood?.value
    lastKnown = true
    notes.push(stateWord(render.state) + (render.reason ? ` - ${reasonWords(render.reason)}` : ''))
  }
  if (lastKnown) notes.push(`LAST KNOWN${value === undefined ? ': NONE' : ` REV ${shortRevision(dim.lastGood?.measuredAt)}`}`)
  if (render?.approximate) notes.push(`APPROX +/-${fixed(toUnit(render.approximate.maxDeviationMm), Math.max(precision, 2))} FIT`)
  const text = formatDimensionText(dim.measurement, value ?? 0, sheet.unit, precision, dim.tolerance, dim.prefix ?? '', dim.suffix ?? '', table)
  let main = text.main
  if (value === undefined) {
    // no number to print: say so, but keep any +/- the tolerance itself carries
    const at = main.indexOf(' \u00b1')
    main = `${dim.prefix ?? ''}NO VALUE${at >= 0 ? main.slice(at) : ''}${dim.suffix ?? ''}`
  }
  const tolerance = text.upper !== undefined && text.lower !== undefined ? [text.upper, text.lower] : []
  return { main, tolerance, notes, lastKnown }
}

// ---------------------------------------------------------------------------
// Scene building
// ---------------------------------------------------------------------------

/** Design section 5: worst tessellation error allowed in sheet space. */
export const CHORD_BUDGET_MM = 0.05
const TITLE_CAPTIONS: Record<string, string> = { title: 'TITLE', partNumber: 'PART NUMBER', revision: 'REVISION', branding: 'SHOP NAME', drawnBy: 'DRAWN BY', created: 'CREATED', drawingEdited: 'DRAWING EDITED', modelEdited: 'MODEL EDITED', scale: 'SCALE' }
const TEXT_MM = 3.5
const SMALL_MM = 2.2
const ARROW_LEN = 3
const ARROW_HALF = 0.9

function polyline(layer: SceneLayer, points: Pt[], closed = false): ScenePolyline {
  return { kind: 'polyline', layer, points, closed }
}

function clipToDisc(points: Pt[], c: Pt, r: number): Pt[][] {
  const out: Pt[][] = []
  let cur: Pt[] = []
  const inside = (p: Pt) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= r + 1e-9
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const flush = () => { if (cur.length > 1) out.push(cur); cur = [] }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const dx = b[0] - a[0], dy = b[1] - a[1], fx = a[0] - c[0], fy = a[1] - c[1]
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r
    const cuts = [0]
    const disc = B * B - 4 * A * C
    if (A > 0 && disc > 0) {
      const s = Math.sqrt(disc)
      for (const t of [(-B - s) / (2 * A), (-B + s) / (2 * A)]) if (t > 0 && t < 1) cuts.push(t)
    }
    cuts.push(1)
    for (let j = 1; j < cuts.length; j++) {
      const p0 = lerp(a, b, cuts[j - 1]), p1 = lerp(a, b, cuts[j])
      if (!inside(lerp(p0, p1, 0.5))) { flush(); continue }
      const last = cur[cur.length - 1]
      if (!last || Math.hypot(last[0] - p0[0], last[1] - p0[1]) > 1e-9) { flush(); cur = [p0] }
      cur.push(p1)
    }
  }
  flush()
  return out
}

export function textItem(layer: SceneLayer, text: string, at: Pt, heightMm: number, opts: { fontFamily?: string; ownerId?: string; align?: 'left' | 'center' | 'right'; issues?: SceneIssue[] }): SceneText {
  text = Array.from(text, ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('')
  const laid = layoutText(text, heightMm, opts.fontFamily)
  const shift = opts.align === 'center' ? -laid.widthMm / 2 : opts.align === 'right' ? -laid.widthMm : 0
  const origin: Pt = [at[0] + shift, at[1]]
  if (laid.missing.length > 0) {
    opts.issues?.push({
      kind: 'missing-glyph',
      ownerId: opts.ownerId,
      message: `No font has ${laid.missing.map(c => `"${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`).join(', ')}, so it is drawn as an empty box in "${text}".`,
    })
  }
  return {
    kind: 'text', layer, text, ownerId: opts.ownerId, heightMm,
    rings: laid.rings.map(r => placeAt(r, origin)),
    strokes: laid.strokes.map(s => placeAt(s, origin)),
  }
}

function arrow(tip: Pt, dirX: number, dirY: number): ScenePolyline {
  // dir points from the tip back along the line
  const bx = tip[0] + dirX * ARROW_LEN, by = tip[1] + dirY * ARROW_LEN
  return polyline('DIMENSION', [tip, [bx - dirY * ARROW_HALF, by + dirX * ARROW_HALF], [bx + dirY * ARROW_HALF, by - dirX * ARROW_HALF]], true)
}

function viewBounds(lines: Pt[][]): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const l of lines) for (const p of l) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null
}

function ratio(s: { numerator: number; denominator: number }): string {
  return `${s.numerator}:${s.denominator}`
}

function dimensionItems(dim: DrawingDimension, sheet: DrawingSheet, table: number | undefined, render: AnnotationRender | undefined, fontFamily: string | undefined, issues: SceneIssue[], unplaced: string[]): SceneItem[] {
  const items: SceneItem[] = []
  const label = dimensionLabel(dim, sheet, render, table)
  let labelAt: Pt | undefined = dim.labelSheetMm
  const g = render
  if (g?.graphic) {
    for (const [a, b] of g.graphic.lines) items.push(polyline('DIMENSION', [a, b]))
    // the scene's arrow() takes the direction from the tip back along the line, the editor's `dir` points the other way
    for (const ar of g.graphic.arrows) items.push(arrow(ar.tip, -ar.dir[0], -ar.dir[1]))
    labelAt ??= g.graphic.label
  } else if (g?.linear) {
    const { from, to } = g.linear
    const dx = to[0] - from[0], dy = to[1] - from[1]
    const len = Math.hypot(dx, dy) || 1
    const ux = dx / len, uy = dy / len
    const nx = -uy, ny = ux
    const off = g.linear.offsetMm ?? 8
    const a: Pt = [from[0] + nx * off, from[1] + ny * off]
    const b: Pt = [to[0] + nx * off, to[1] + ny * off]
    const over = Math.sign(off || 1) * 2
    items.push(polyline('DIMENSION', [[from[0] + nx * 1, from[1] + ny * 1], [a[0] + nx * over, a[1] + ny * over]]))
    items.push(polyline('DIMENSION', [[to[0] + nx * 1, to[1] + ny * 1], [b[0] + nx * over, b[1] + ny * over]]))
    items.push(polyline('DIMENSION', [a, b]))
    items.push(arrow(a, ux, uy), arrow(b, -ux, -uy))
    labelAt ??= [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 1.5]
  } else if (g?.radial) {
    const { center, radiusMm, angleDeg } = g.radial
    const rad = (angleDeg * Math.PI) / 180
    const cx = Math.cos(rad), cy = -Math.sin(rad)
    const tip: Pt = [center[0] + cx * radiusMm, center[1] + cy * radiusMm]
    if (dim.measurement === 'diameter') {
      const far: Pt = [center[0] - cx * radiusMm, center[1] - cy * radiusMm]
      items.push(polyline('DIMENSION', [far, tip]), arrow(tip, -cx, -cy), arrow(far, cx, cy))
    } else {
      items.push(polyline('DIMENSION', [center, tip]), arrow(tip, -cx, -cy))
    }
    labelAt ??= [tip[0] + cx * 4, tip[1] + cy * 4]
  } else if (g?.angular) {
    const { vertex, fromDeg, toDeg, radiusMm } = g.angular
    items.push({ kind: 'arc', layer: 'DIMENSION', center: vertex, radiusMm, startDeg: fromDeg, endDeg: toDeg })
    const at = (deg: number): Pt => [vertex[0] + radiusMm * Math.cos((deg * Math.PI) / 180), vertex[1] - radiusMm * Math.sin((deg * Math.PI) / 180)]
    // each arrow's body runs back along the arc, into its interior
    const f = (fromDeg * Math.PI) / 180, t = (toDeg * Math.PI) / 180
    items.push(arrow(at(fromDeg), -Math.sin(f), -Math.cos(f)), arrow(at(toDeg), Math.sin(t), Math.cos(t)))
    const mid = fromDeg + ((((toDeg - fromDeg) % 360) + 360) % 360) / 2
    labelAt ??= [vertex[0] + (radiusMm + 4) * Math.cos((mid * Math.PI) / 180), vertex[1] - (radiusMm + 4) * Math.sin((mid * Math.PI) / 180)]
  }
  if (!labelAt) {
    unplaced.push(`${dim.id}: ${label.main}${label.tolerance.length ? ` ${label.tolerance.join(' ')}` : ''}${label.notes.length ? ` (${label.notes.join('; ')})` : ''}`)
    issues.push({ kind: 'unplaced-annotation', ownerId: dim.id, message: `Dimension ${dim.id} has no position on this sheet, so it is listed in the export notes instead.` })
  } else {
    const mainText = textItem('DIMENSION', label.main, labelAt, TEXT_MM, { fontFamily, ownerId: dim.id, align: 'center', issues })
    items.push(mainText)
    const width = layoutText(label.main, TEXT_MM, fontFamily).widthMm
    if (label.tolerance.length === 2) {
      const x = labelAt[0] + width / 2 + 1
      items.push(textItem('DIMENSION', label.tolerance[0], [x, labelAt[1] - 1.6], SMALL_MM, { fontFamily, ownerId: dim.id, issues }))
      items.push(textItem('DIMENSION', label.tolerance[1], [x, labelAt[1] + 0.6], SMALL_MM, { fontFamily, ownerId: dim.id, issues }))
    }
    label.notes.forEach((n, i) => items.push(textItem('DIMENSION', n, [labelAt![0], labelAt![1] + 3.2 + i * 2.8], SMALL_MM, { fontFamily, ownerId: dim.id, align: 'center', issues })))
  }
  if (render && render.state !== 'current') {
    issues.push({
      kind: 'reference-state', ownerId: dim.id,
      message: `Dimension ${dim.id} is ${render.state}${render.reason ? ` (${reasonWords(render.reason).toLowerCase()})` : ''}; the sheet shows its last-known value${dim.lastGood ? '' : ', and there is none'}.`,
    })
  } else if (!render) {
    issues.push({ kind: 'unresolved', ownerId: dim.id, message: `Dimension ${dim.id} was not checked against the model for this export, so its value is the last-known one.` })
  }
  if (render?.approximate) {
    issues.push({ kind: 'approximate', ownerId: dim.id, message: `Dimension ${dim.id} is measured on a mesh fit that deviates up to ${render.approximate.maxDeviationMm} mm; that is not a tolerance.` })
  }
  return items
}

function annotationItems(a: Exclude<DrawingAnnotation, DrawingDimension>, render: AnnotationRender | undefined, fontFamily: string | undefined, issues: SceneIssue[]): SceneItem[] {
  const items: SceneItem[] = []
  if (a.kind === 'balloon') {
    // the saved label position, exactly where the editor draws it (DrawingEditor: labelSheetMm, else anchor + [10, -10])
    const c: Pt = a.labelSheetMm ?? [a.anchorSheetMm[0] + 10, a.anchorSheetMm[1] - 10]
    const r = 3.5
    const dx = a.anchorSheetMm[0] - c[0], dy = a.anchorSheetMm[1] - c[1]
    const len = Math.hypot(dx, dy) || 1
    items.push({ kind: 'circle', layer: 'DIMENSION', center: c, radiusMm: r })
    if (len > r) items.push(polyline('DIMENSION', [[c[0] + (dx / len) * r, c[1] + (dy / len) * r], a.anchorSheetMm]))
    items.push({ kind: 'circle', layer: 'DIMENSION', center: a.anchorSheetMm, radiusMm: 0.5 })
    items.push(textItem('DIMENSION', String(a.number), [c[0], c[1] + TEXT_MM / 2 - 0.4], 3, { fontFamily, ownerId: a.id, align: 'center', issues }))
    if (a.text) items.push(textItem('TEXT', a.text, [c[0] + r + 1.5, c[1] + TEXT_MM / 2], SMALL_MM + 0.8, { fontFamily, ownerId: a.id, issues }))
  } else {
    const lines = a.text.split('\n')
    lines.forEach((l, i) => items.push(textItem('TEXT', l, [a.anchorSheetMm[0], a.anchorSheetMm[1] + i * TEXT_MM * 1.5], TEXT_MM, { fontFamily, ownerId: a.id, issues })))
  }
  if (render && render.state !== 'current') {
    items.push(textItem('TEXT', `${stateWord(render.state)}${render.reason ? ` - ${reasonWords(render.reason)}` : ''}`, [a.anchorSheetMm[0], a.anchorSheetMm[1] + 6], SMALL_MM, { fontFamily, ownerId: a.id, issues }))
    issues.push({ kind: 'reference-state', ownerId: a.id, message: `${a.kind === 'balloon' ? 'Balloon' : 'Note'} ${a.id} points at geometry that is ${render.state}${render.reason ? ` (${reasonWords(render.reason).toLowerCase()})` : ''}.` })
  }
  return items
}

function itemBox(it: SceneItem): [number, number, number, number] | null {
  const pts: Pt[] = it.kind === 'polyline' ? it.points
    : it.kind === 'text' ? [...it.rings.flat(), ...it.strokes.flat()]
      : [[it.center[0] - it.radiusMm, it.center[1] - it.radiusMm], [it.center[0] + it.radiusMm, it.center[1] + it.radiusMm]]
  if (pts.length === 0) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]) }
  return [x0, y0, x1, y1]
}

/** Build the one sheet scene PDF and DXF both write. */
export function buildSheetScene(doc: DrawingDocument, inputs: SceneInputs): SheetScene {
  const sheet = inputs.sheetId ? doc.sheets.find(s => s.id === inputs.sheetId) : doc.sheets[0]
  if (!sheet) throw new Error(inputs.sheetId ? `This drawing has no sheet "${inputs.sheetId}" to export.` : 'This drawing has no sheet to export.')
  const fontFamily = inputs.fontFamily
  const [W, H] = sheet.sizeMm
  const m = sheet.marginsMm
  if (!(Number.isFinite(W) && Number.isFinite(H) && W >= 20 && H >= 20)) throw new Error(`Sheet ${sheet.id} is smaller than 20 mm or has no size, so it cannot be exported.`)
  if (!(Number.isFinite(m) && m >= 0 && 2 * m < Math.min(W, H) - 10)) throw new Error(`Sheet ${sheet.id} has margins that leave no room to draw, so it cannot be exported.`)
  const items: SceneItem[] = []
  const issues: SceneIssue[] = []
  const unplaced: string[] = []
  let maxChord = 0

  items.push(polyline('FRAME', [[0, 0], [W, 0], [W, H], [0, H]], true))
  items.push(polyline('FRAME', [[m, m], [W - m, m], [W - m, H - m], [m, H - m]], true))

  const detailLetters = new Map<string, string>()
  // the saved letter, as the editor shows it; only a view saved without one falls back to its place in the list
  sheet.views.filter(v => v.detail).forEach((v, i) => detailLetters.set(v.id, v.label ?? String.fromCharCode(65 + (i % 26))))
  const viewById = new Map<string, DrawingView>(sheet.views.map(v => [v.id, v]))

  for (const view of sheet.views) {
    const detail = view.detail
    const projection = inputs.projections[view.id] ?? (detail ? inputs.projections[detail.parentViewId] : undefined)
    const k = view.scale.numerator / view.scale.denominator
    if (!(Number.isFinite(k) && k > 0)) {
      issues.push({ kind: 'missing-projection', ownerId: view.id, message: `View ${view.id} has a scale of ${view.scale.numerator}:${view.scale.denominator}, which is not a positive ratio, so it is left off the sheet.` })
      continue
    }
    if (!projection) {
      issues.push({ kind: 'missing-projection', ownerId: view.id, message: `View ${view.id} has no projection, so its lines are missing from the sheet.` })
      items.push(textItem('TEXT', `NO PROJECTION: ${view.id}`, view.sheetOriginMm, SMALL_MM + 0.8, { fontFamily, ownerId: view.id, issues }))
      continue
    }
    maxChord = Math.max(maxChord, projection.chordToleranceMm * k)
    const placed = toSheet(projection, view.scale, view.sheetOriginMm)
    let lines = placed.filter(l => l.points.every(q => Number.isFinite(q[0]) && Number.isFinite(q[1])))
    const dropped = placed.length - lines.length
    const visibleOnly = (l: { visibility: string }) => view.showHidden || l.visibility === 'visible'
    const paths: Array<{ layer: SceneLayer; points: Pt[] }> = []
    let detailRing: { c: Pt; r: number } | undefined
    if (detail) {
      const own = detailCircle(view)!
      const c = own.center, r = own.radius
      detailRing = { c, r }
      for (const l of lines.filter(visibleOnly)) for (const piece of clipToDisc(l.points, c, r)) paths.push({ layer: l.visibility === 'hidden' ? 'HIDDEN' : 'VISIBLE', points: piece })
    } else {
      lines = lines.filter(visibleOnly)
      for (const l of lines) paths.push({ layer: l.visibility === 'hidden' ? 'HIDDEN' : 'VISIBLE', points: l.points })
    }
    for (const p of paths) items.push(polyline(p.layer, p.points))
    if (dropped > 0) issues.push({ kind: 'missing-projection', ownerId: view.id, message: `View ${view.id} has ${dropped} line${dropped === 1 ? '' : 's'} with a position that is not a number, so ${dropped === 1 ? 'it is' : 'they are'} left off the sheet.` })
    for (const lim of projection.limits) issues.push({ kind: 'projection-limit', ownerId: view.id, message: `View ${view.id}: ${lim}` })

    const bounds = detailRing ? [detailRing.c[0] - detailRing.r, detailRing.c[1] - detailRing.r, detailRing.c[0] + detailRing.r, detailRing.c[1] + detailRing.r] as const : viewBounds(paths.map(p => p.points))
    const letter = detailLetters.get(view.id)
    const name = letter ? `DETAIL ${letter}` : (view.frame.name ?? view.id).toUpperCase()
    if (bounds) items.push(textItem('TEXT', `${name} (${ratio(view.scale)})`, [(bounds[0] + bounds[2]) / 2, bounds[3] + 6], TEXT_MM, { fontFamily, ownerId: view.id, align: 'center', issues }))
    if (detailRing) {
      items.push({ kind: 'circle', layer: 'VISIBLE', center: detailRing.c, radiusMm: detailRing.r })
      items.push(polyline('CENTER', [[detailRing.c[0] - 3, detailRing.c[1]], [detailRing.c[0] + 3, detailRing.c[1]]]))
      items.push(polyline('CENTER', [[detailRing.c[0], detailRing.c[1] - 3], [detailRing.c[0], detailRing.c[1] + 3]]))
      // the matching ring and letter on the parent view, where the editor draws them
      const parent = detail && viewById.get(detail.parentViewId)
      if (detail && !parent) issues.push({ kind: 'missing-projection', ownerId: view.id, message: `Detail view ${view.id} points at view ${detail.parentViewId}, which is not on this sheet, so the ring on its parent is not drawn.` })
      if (detail && !(detail.radiusMm > 0)) issues.push({ kind: 'missing-projection', ownerId: view.id, message: `Detail view ${view.id} has no crop radius, so nothing of it is drawn.` })
      const onParent = parent ? detailCircleOnParent(view, parent) : undefined
      if (onParent) {
        items.push({ kind: 'circle', layer: 'CENTER', center: onParent.center, radiusMm: onParent.radius })
        if (letter) items.push(textItem('TEXT', letter, [onParent.center[0] + onParent.radius * 0.72 + 1, onParent.center[1] - onParent.radius * 0.72 - 1], TEXT_MM, { fontFamily, ownerId: view.id, issues }))
      }
    }
  }

  for (const a of doc.annotations) {
    const render = inputs.annotations?.[a.id]
    if (a.kind === 'dimension') {
      const table = a.tolerance.kind === 'general' ? generalToleranceValue(effectiveTemplate(doc.template).generalTolerances, a.measurement, a.precision ?? sheet.precision) : undefined
      items.push(...dimensionItems(a, sheet, table, render, fontFamily, issues, unplaced))
    } else items.push(...annotationItems(a, render, fontFamily, issues))
  }

  // title block and general tolerance block: the same rectangles, fields and resolved values the editor draws
  // (template.ts titleBlockRect / titleBlockValues / toleranceBlockRect), so an override, a bound date or a
  // saved general tolerance table reads the same on paper as on screen
  const revision = `${doc.id}@${doc.source.observedRevision.geometryFingerprint}`
  const [tbX, tbY, tbW, tbH] = titleBlockRect(sheet.sizeMm, m)
  items.push(polyline('FRAME', [[tbX, tbY], [tbX + tbW, tbY], [tbX + tbW, tbY + tbH], [tbX, tbY + tbH]], true))
  // template.ts binds the scale cell to the FIRST sheet's first full view; a later sheet prints its own
  const sheetScale = sheet.views.find(v => !v.detail)?.scale
  for (const f of titleBlockValues(doc, inputs.partName ?? doc.name)) {
    if (f.key === 'scale' && !f.overridden) f.text = sheetScale === undefined ? '' : ratio(sheetScale)
    const [fx, fy, fw, fh] = f.rectMm
    items.push(polyline('FRAME', [[tbX + fx, tbY + fy], [tbX + fx + fw, tbY + fy], [tbX + fx + fw, tbY + fy + fh], [tbX + fx, tbY + fy + fh]], true))
    // caption small at the top of the cell, value under it; the value shrinks to fit a short cell (the scale cell is 4 mm)
    items.push(textItem('TEXT', `${TITLE_CAPTIONS[f.key]}${f.overridden ? ' *' : ''}`, [tbX + fx + 0.6, tbY + fy + 1.6], 1.2, { fontFamily, ownerId: 'title-block', issues }))
    items.push(textItem('TEXT', f.text, [tbX + fx + 0.8, tbY + fy + fh - 0.7], Math.min(f.key === 'title' ? 3 : 2.4, fh - 2.8), { fontFamily, ownerId: `title-${f.key}`, issues }))
  }
  items.push(textItem('TEXT', `${sheet.projection === 'first-angle' ? '1ST' : '3RD'} ANGLE PROJECTION${sheet.unit === 'inch' ? ' (SHOWN IN INCHES)' : ''}`, [tbX + 56, tbY + 33.2], 1.8, { fontFamily, ownerId: 'title-block', issues }))
  items.push(textItem('TEXT', `DWG REV ${shortRevision(doc.source.observedRevision)}   ${doc.id}${inputs.exportTimestamp ? `   ${inputs.exportTimestamp}` : ''}`, [tbX + 1, tbY - 1.5], 2, { fontFamily, ownerId: 'title-block', issues }))

  const [tX, tY, tW, tH] = toleranceBlockRect(sheet.sizeMm, m)
  const gt = effectiveTemplate(doc.template).generalTolerances
  const tolFmt = (v: number): string => (sheet.unit === 'inch' ? (v / MM_PER_INCH).toFixed(4) : String(v))
  const rows = Object.entries(gt.linearByDecimalPlaces).sort((x, y) => Number(x[0]) - Number(y[0]))
  items.push(polyline('FRAME', [[tX, tY], [tX + tW, tY], [tX + tW, tY + tH], [tX, tY + tH]], true))
  items.push(textItem('TEXT', `UNLESS OTHERWISE SPECIFIED (${sheet.unit === 'inch' ? 'INCH' : 'MM'}; DEGREES)`, [tX + 2, tY + 5], 2.4, { fontFamily, ownerId: 'tolerance-block', issues }))
  rows.forEach(([places, v], i) => {
    const example = places === '0' ? 'X' : `X.${'X'.repeat(Number(places))}`
    items.push(textItem('TEXT', `${example}  +/- ${tolFmt(v)}`, [tX + 2 + (i % 2) * 68, tY + 11 + Math.floor(i / 2) * 6], 2.4, { fontFamily, ownerId: 'tolerance-block', issues }))
  })
  items.push(textItem('TEXT', `Angles  +/- ${gt.angularDegrees} degrees`, [tX + 2, tY + 11 + Math.ceil(rows.length / 2) * 6], 2.4, { fontFamily, ownerId: 'tolerance-block', issues }))

  // branding: template assets drawn in a cell left of the title block
  if (maxChord > CHORD_BUDGET_MM) issues.push({ kind: 'projection-limit', message: `Curves are drawn as straight pieces up to ${maxChord.toFixed(3)} mm from the true curve on paper, above the ${CHORD_BUDGET_MM} mm budget.` })
  const images: SceneImage[] = []
  for (const id of doc.template.assetIds) {
    const asset = doc.assets.find(a => a.id === id)
    const cell: [number, number, number, number] = [tbX + tbW - 34, tbY - 29, 32, 26]
    if (!asset) {
      issues.push({ kind: 'branding-missing', ownerId: id, message: `The template names branding "${id}" but the drawing does not carry it.` })
      continue
    }
    const info = inspectRaster(asset)
    if (!info.ok) {
      issues.push({ kind: 'branding-unsupported', ownerId: id, message: `Branding "${asset.name}" cannot be drawn: ${info.reason}.` })
      items.push(polyline('FRAME', [[cell[0], cell[1]], [cell[0] + cell[2], cell[1]], [cell[0] + cell[2], cell[1] + cell[3]], [cell[0], cell[1] + cell[3]]], true))
      items.push(textItem('TEXT', 'LOGO NOT DRAWN', [cell[0] + 2, cell[1] + cell[3] / 2], SMALL_MM, { fontFamily, ownerId: id, issues }))
      continue
    }
    const fit = Math.min(cell[2] / info.widthPx, cell[3] / info.heightPx)
    const w = info.widthPx * fit, h = info.heightPx * fit
    images.push({ id, name: asset.name, contentType: asset.contentType, kind: info.kind, widthPx: info.widthPx, heightPx: info.heightPx, bytes: info.bytes, rectMm: [cell[0] + (cell[2] - w) / 2, cell[1] + (cell[3] - h) / 2, w, h] })
  }

  // the export notes: everything an invalid or approximate reference or a limit must tell the reader
  // wrapped to the room left of the logo cell, so the notes never run under the title block
  const noteRoom = Math.max(30, tbX - 6 - (m + 2))
  const wrap = (text: string, heightMm: number, room: number): string[] => {
    const out: string[] = []
    let line = ''
    for (const word of text.split(' ')) {
      const tryLine = line ? `${line} ${word}` : word
      if (line && layoutText(tryLine, heightMm, fontFamily).widthMm > room) { out.push(line); line = word } else line = tryLine
    }
    if (line) out.push(line)
    return out
  }
  // more than one column of notes continues in the next column (up to three) rather than dropping lines
  const NOTE_LINES_PER_COLUMN = 22
  const MAX_NOTE_COLUMNS = 3
  // the same projection limit on several views is one note naming the views, not one note per view
  const limitViews = new Map<string, string[]>()
  const noteTexts: string[] = []
  for (const i of issues) {
    const limit = i.kind === 'projection-limit' && i.ownerId ? /^View (\S+): ([\s\S]*)$/.exec(i.message) : null
    if (!limit) { noteTexts.push(i.message); continue }
    if (!limitViews.has(limit[2])) { limitViews.set(limit[2], []); noteTexts.push(`\u0000${limit[2]}`) }
    limitViews.get(limit[2])!.push(limit[1])
  }
  for (const u of unplaced) noteTexts.push(`UNPLACED ${u}`)
  noteTexts.forEach((t, i) => {
    if (!t.startsWith('\u0000')) return
    const ids = limitViews.get(t.slice(1))!
    noteTexts[i] = `${ids.length > 1 ? 'Views' : 'View'} ${ids.join(', ')}: ${t.slice(1)}`
  })
  let noteLines: Array<{ text: string; heightMm: number }> = []
  let columns = 1
  if (noteTexts.length > 0) {
    for (columns = 1; columns <= MAX_NOTE_COLUMNS; columns++) {
      const room = (noteRoom - (columns - 1) * 3) / columns
      noteLines = noteTexts.flatMap(t => wrap(t, SMALL_MM, room).map(l => ({ text: l, heightMm: SMALL_MM })))
      if (noteLines.length <= NOTE_LINES_PER_COLUMN * columns - 1) break
    }
    columns = Math.min(columns, MAX_NOTE_COLUMNS)
    const capacity = NOTE_LINES_PER_COLUMN * columns - 1
    if (noteLines.length > capacity) noteLines = [...noteLines.slice(0, capacity - 1), { text: `+${noteLines.length - (capacity - 1)} MORE NOTE LINES NOT SHOWN`, heightMm: SMALL_MM }]
  }
  const colWidth = (noteRoom - (columns - 1) * 3) / columns
  const header = noteLines.length > 0 ? [{ text: 'EXPORT NOTES', heightMm: SMALL_MM + 0.4 }] : []
  const noteRows = (col: number): number => Math.min(NOTE_LINES_PER_COLUMN, header.length + noteLines.length - col * NOTE_LINES_PER_COLUMN)
  const noteBlockHeight = noteRows(0) * 3.1 + 2
  // the notes sit above the tolerance block; where that would cover a view or a dimension they go to the top of the sheet instead
  const bottomRect: [number, number, number, number] = [m + 2, tY - 2.5 - (noteRows(0) - 1) * 3.1 - 2.6, m + 2 + noteRoom, tY]
  const topRect: [number, number, number, number] = [m + 2, m + 1, m + 2 + noteRoom, m + 1 + noteBlockHeight + 2]
  const covered = (r: [number, number, number, number]): boolean => items.some(it => {
    if (it.layer === 'FRAME') return false
    const box = itemBox(it)
    return box !== null && box[0] < r[2] && box[2] > r[0] && box[1] < r[3] && box[3] > r[1]
  })
  const atTop = noteLines.length > 0 && covered(bottomRect) && !covered(topRect)
  ;[...header, ...noteLines].forEach((n, i) => {
    const col = Math.floor(i / NOTE_LINES_PER_COLUMN), row = i % NOTE_LINES_PER_COLUMN
    const y = atTop ? m + 4.5 + row * 3.1 : tY - 2.5 - (noteRows(col) - 1 - row) * 3.1
    items.push(textItem('TEXT', n.text, [m + 2 + col * (colWidth + 3), y], n.heightMm, { fontFamily, ownerId: 'export-notes' }))
  })

  return {
    documentId: doc.id, documentName: doc.name, revision, sheetId: sheet.id, sizeMm: [W, H], marginsMm: m,
    unit: sheet.unit, precision: sheet.precision, items, images, issues, maxChordErrorMm: maxChord,
    ...(inputs.exportTimestamp ? { exportTimestamp: inputs.exportTimestamp } : {}),
  }
}
