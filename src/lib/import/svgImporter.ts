import type { Vec2, Layer2D, Loop2D, BoundingBox } from '../../types'
import { joinSegments, computeBBox2D, centerLoops } from '../geometry/path2d'

export interface Import2DResult {
  loops: Loop2D[]
  layers: Layer2D[]
  boundingBox: BoundingBox
}

// Default layer palette for files without explicit layers
const PALETTE = [
  '#4ac3ff', '#ff4c4c', '#4cff88', '#ffd740',
  '#ff80ab', '#b388ff', '#80d8ff', '#ccff90',
]

// ── Coordinate helpers ───────────────────────────────────────────────────────

function parseDimension(attr: string | null): { value: number; unit: string } | null {
  if (!attr) return null
  const m = attr.trim().match(/^([\d.eE+\-]+)\s*(mm|px|pt|cm|in|%)?$/)
  if (!m) return null
  return { value: parseFloat(m[1]), unit: m[2] ?? 'px' }
}

function toMM(value: number, unit: string): number {
  switch (unit) {
    case 'mm': return value
    case 'cm': return value * 10
    case 'in': return value * 25.4
    case 'pt': return value * 0.352778
    case 'px': return value * 0.264583   // 96 dpi
    default:   return value
  }
}

// ── viewBox → mm mapping (WO-1887) ───────────────────────────────────────────
//
// An SVG's root presents a viewport (width/height, converted to mm) and a
// viewBox: the user-coordinate rectangle the author drew in. A browser maps one
// onto the other by subtracting the viewBox origin (min-x, min-y), scaling x by
// viewportWidth / viewBox.width and y by viewportHeight / viewBox.height, then
// honouring preserveAspectRatio (default "xMidYMid meet") - a single uniform
// scale with the leftover viewport space distributed by the alignment. Reading
// only width/viewBox.width and ignoring the origin shifted cropped files (a
// viewBox not starting at 0,0) and mis-sized a viewBox whose aspect differs
// from its page.

export type PreserveAlign =
  | 'none'
  | 'xMinYMin' | 'xMidYMin' | 'xMaxYMin'
  | 'xMinYMid' | 'xMidYMid' | 'xMaxYMid'
  | 'xMinYMax' | 'xMidYMax' | 'xMaxYMax'

interface ViewBoxInfo { minX: number; minY: number; width: number; height: number }

function readViewBox(svg: SVGSVGElement): ViewBoxInfo | null {
  const attr = svg.getAttribute('viewBox')
  if (!attr) return null
  const n = (attr.match(NUMBER_RE_GLOBAL) ?? []).map(Number)
  if (n.length !== 4 || !(n[2] > 0) || !(n[3] > 0)) return null
  return { minX: n[0], minY: n[1], width: n[2], height: n[3] }
}

function parsePreserveAspectRatio(attr: string | null): { align: PreserveAlign; slice: boolean } {
  const parts = (attr ?? '').trim().split(/\s+/).filter(Boolean)
  let i = 0
  if (parts[i] === 'defer') i++
  const raw = parts[i] ?? 'xMidYMid'
  const align: PreserveAlign = /^(none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))$/.test(raw)
    ? (raw as PreserveAlign)
    : 'xMidYMid'
  return { align, slice: parts[i + 1] === 'slice' }
}

/**
 * The root mapping from SVG user units to millimetres (Y still SVG's down).
 * Exported so tests can assert the viewBox origin subtraction, height ratio and
 * preserveAspectRatio directly - the importer's own `centerLoops` normalises the
 * final translation away, which would otherwise hide the origin term.
 */
export function getSvgUserToMM(svg: SVGSVGElement): Matrix {
  const vb = readViewBox(svg)
  const w  = parseDimension(svg.getAttribute('width'))
  const h  = parseDimension(svg.getAttribute('height'))

  // No usable viewBox: one user unit maps to its own CSS unit (mm default).
  // A file with neither width nor height keeps 1 user unit = 1 mm.
  if (!vb) {
    const s = w ? toMM(1, w.unit) : 1
    return [s, 0, 0, s, 0, 0]
  }

  // Width-only (legacy files): today's uniform scale, no letterboxing.
  if (!w || !h) {
    const s = w ? toMM(w.value, w.unit) / vb.width : 1
    return [s, 0, 0, s, 0 - vb.minX * s, 0 - vb.minY * s]
  }

  const vpW = toMM(w.value, w.unit)
  const vpH = toMM(h.value, h.unit)
  const sx = vpW / vb.width
  const sy = vpH / vb.height
  const { align, slice } = parsePreserveAspectRatio(svg.getAttribute('preserveAspectRatio'))

  let ex = sx, ey = sy, tx = 0, ty = 0
  if (align !== 'none') {
    const s = slice ? Math.max(sx, sy) : Math.min(sx, sy)
    ex = s; ey = s
    const ax = align.startsWith('xMid') ? 0.5 : align.startsWith('xMax') ? 1 : 0
    const ay = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0
    tx = (vpW - vb.width * s) * ax
    ty = (vpH - vb.height * s) * ay
  }
  return [ex, 0, 0, ey, tx - vb.minX * ex, ty - vb.minY * ey]
}

// ── Layer extraction ─────────────────────────────────────────────────────────

function cssColor(el: Element): string {
  const stroke = el.getAttribute('stroke') ?? el.getAttribute('fill') ?? ''
  if (stroke && stroke !== 'none' && stroke.startsWith('#')) return stroke
  // Inline style
  const style = el.getAttribute('style') ?? ''
  const m = style.match(/stroke\s*:\s*(#[0-9a-fA-F]+)/)
  return m ? m[1] : '#4ac3ff'
}

function extractInkscapeLayers(svg: SVGSVGElement): Map<string, Layer2D> {
  const map = new Map<string, Layer2D>()
  // A CSS attribute selector cannot match a namespaced XML attribute:
  // `g[inkscape\:groupmode="layer"]` looks up a literal, no-namespace attribute
  // NAMED "inkscape:groupmode" and so finds nothing. Walk the groups and read
  // the namespaced attribute with getAttribute(), the same access pattern
  // findLayerId() uses.
  const groups = Array.from(svg.querySelectorAll('g'))
    .filter(g => g.getAttribute('inkscape:groupmode') === 'layer')
  let pi = 0
  groups.forEach(g => {
    const label = g.getAttribute('inkscape:label') ?? g.getAttribute('id') ?? `Layer ${map.size + 1}`
    const id = g.getAttribute('id') ?? crypto.randomUUID()
    // Try to pick the group's first child stroke color as the layer color
    const firstChild = g.firstElementChild
    const color = firstChild ? cssColor(firstChild) : PALETTE[pi++ % PALETTE.length]
    map.set(id, { id, name: label, color, visible: true })
  })
  return map
}

// ── Non-rendered element filtering (B5) ──────────────────────────────────────
//
// querySelectorAll descends into <defs>, <symbol>, <marker>, <pattern>,
// <clipPath> and <mask>. Content there is NOT rendered geometry (symbols only
// render via <use>, which this importer does not instantiate; markers/patterns
// are paint servers). Some DXF and SVG exports stuff title blocks,
// hatch patterns and dimension markers into <defs> at raw document coordinates
// far from the part — importing them created a phantom layer that inflated the
// geometry bounds (gizmo anchored "up in space"). display:none subtrees are
// also never rendered (Inkscape hides layers with style="display:none").
// Conservative: only skip subtrees the SVG spec says are not rendered.

const NON_RENDERED_CONTAINERS = new Set([
  'defs', 'symbol', 'marker', 'pattern', 'clippath', 'mask', 'metadata',
])

function isDisplayNone(el: Element): boolean {
  if ((el.getAttribute('display') ?? '').trim().toLowerCase() === 'none') return true
  const style = el.getAttribute('style') ?? ''
  return /(?:^|;)\s*display\s*:\s*none/i.test(style)
}

function isNonRendered(el: Element, root: Element): boolean {
  let cur: Element | null = el
  while (cur && cur !== root) {
    const tag = cur.tagName.toLowerCase().replace(/^svg:/, '')
    if (NON_RENDERED_CONTAINERS.has(tag)) return true
    if (isDisplayNone(cur)) return true
    cur = cur.parentElement
  }
  return false
}

function findLayerId(el: Element, inkLayers: Map<string, Layer2D>): string {
  let cur: Element | null = el
  while (cur) {
    const id = cur.getAttribute('id')
    if (id && inkLayers.has(id)) return id
    cur = cur.parentElement
  }
  return 'default'
}

// ── Shape → path d strings ────────────────────────────────────────────────────

function elementToD(el: Element): string | null {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '')
  switch (tag) {
    case 'path':
      return el.getAttribute('d')
    case 'line': {
      const x1 = el.getAttribute('x1') ?? '0', y1 = el.getAttribute('y1') ?? '0'
      const x2 = el.getAttribute('x2') ?? '0', y2 = el.getAttribute('y2') ?? '0'
      return `M ${x1} ${y1} L ${x2} ${y2}`
    }
    case 'polyline':
    case 'polygon': {
      // Comma and whitespace are interchangeable separators ("1,2 3,4" and
      // "1 2 3 4" are the same list), so read numbers, then pair them.
      const nums = (el.getAttribute('points') ?? '').match(NUMBER_RE_GLOBAL) ?? []
      if (nums.length < 4) return null
      let d = `M ${nums[0]} ${nums[1]}`
      for (let k = 2; k + 1 < nums.length; k += 2) d += ` L ${nums[k]} ${nums[k + 1]}`
      return tag === 'polygon' ? d + ' Z' : d
    }
    case 'rect': {
      const x = parseFloat(el.getAttribute('x') ?? '0')
      const y = parseFloat(el.getAttribute('y') ?? '0')
      const w = parseFloat(el.getAttribute('width') ?? '0')
      const h = parseFloat(el.getAttribute('height') ?? '0')
      // SVG rect radii: a missing one takes the other's value; both clamp to half the side.
      const rxAttr = el.getAttribute('rx'), ryAttr = el.getAttribute('ry')
      const rx = Math.min(parseFloat(rxAttr ?? ryAttr ?? '0') || 0, w / 2)
      const ry = Math.min(parseFloat(ryAttr ?? rxAttr ?? '0') || 0, h / 2)
      if (rx <= 0 || ry <= 0) {
        return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`
      }
      // Rounded rect: corner arcs are sampled by flattenPathD
      return `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
    }
    case 'circle': {
      const cx = el.getAttribute('cx') ?? '0'
      const cy = el.getAttribute('cy') ?? '0'
      const r  = el.getAttribute('r')  ?? '1'
      return `M ${parseFloat(cx) - parseFloat(r)} ${cy} A ${r} ${r} 0 1 0 ${parseFloat(cx) + parseFloat(r)} ${cy} A ${r} ${r} 0 1 0 ${parseFloat(cx) - parseFloat(r)} ${cy} Z`
    }
    case 'ellipse': {
      const cx = parseFloat(el.getAttribute('cx') ?? '0')
      const cy = parseFloat(el.getAttribute('cy') ?? '0')
      const rx = el.getAttribute('rx') ?? '1'
      const ry = el.getAttribute('ry') ?? '1'
      return `M ${cx - parseFloat(rx)} ${cy} A ${rx} ${ry} 0 1 0 ${cx + parseFloat(rx)} ${cy} A ${rx} ${ry} 0 1 0 ${cx - parseFloat(rx)} ${cy} Z`
    }
    default:
      return null
  }
}

// ── Transforms (WO-1450, BUG-443) ────────────────────────────────────────────
//
// An SVG affine matrix [a b c d e f] maps (x, y) to (a x + c y + e, b x + d y + f).
// A shape's user coordinates pass through its own `transform` attribute and then
// every ancestor's, innermost first, before the root viewBox mapping (getSVGScale).

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

const NUMBER_RE_GLOBAL = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

/** m x n: the matrix that applies n first, then m. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/** The SVG `transform` attribute's function list: matrix, translate, scale, rotate, skewX, skewY. */
function parseTransform(attr: string | null): Matrix {
  let m = IDENTITY
  if (!attr) return m
  const fnRe = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = fnRe.exec(attr)) !== null) {
    const a = (match[2].match(NUMBER_RE_GLOBAL) ?? []).map(Number)
    const rad = (deg: number) => (deg * Math.PI) / 180
    let f: Matrix | null = null
    switch (match[1]) {
      case 'matrix':
        if (a.length === 6) f = [a[0], a[1], a[2], a[3], a[4], a[5]]
        break
      case 'translate':
        if (a.length === 1 || a.length === 2) f = [1, 0, 0, 1, a[0], a[1] ?? 0]
        break
      case 'scale':
        if (a.length === 1 || a.length === 2) f = [a[0], 0, 0, a[1] ?? a[0], 0, 0]
        break
      case 'rotate':
        if (a.length === 1 || a.length === 3) {
          const cos = Math.cos(rad(a[0])), sin = Math.sin(rad(a[0]))
          f = [cos, sin, -sin, cos, 0, 0]
          if (a.length === 3) {
            f = multiply(multiply([1, 0, 0, 1, a[1], a[2]], f), [1, 0, 0, 1, -a[1], -a[2]])
          }
        }
        break
      case 'skewX':
        if (a.length === 1) f = [1, 0, Math.tan(rad(a[0])), 1, 0, 0]
        break
      case 'skewY':
        if (a.length === 1) f = [1, Math.tan(rad(a[0])), 0, 1, 0, 0]
        break
    }
    if (f) m = multiply(m, f)
  }
  return m
}

/** The element's own transform composed under every ancestor's, up to (not including) the root <svg>. */
function composedMatrix(el: Element, root: Element): Matrix {
  let m = IDENTITY
  for (let cur: Element | null = el; cur && cur !== root; cur = cur.parentElement) {
    m = multiply(parseTransform(cur.getAttribute('transform')), m)
  }
  return m
}

// ── Path flattening (WO-1450, BUG-532) ───────────────────────────────────────
//
// Walks the path commands themselves rather than sampling the total arc length
// in uniform steps: every command's endpoint is emitted exactly, so a corner is
// always an output vertex. Straight commands emit only their endpoint; curves
// (A/C/S/Q/T) are subdivided between their endpoints so no chord is longer than
// the sampling spacing, measured in output millimetres (after the transform).

const SAMPLE_SPACING_MM = 0.5
const MAX_SAMPLES_PER_CURVE = 2000

type ToWorld = (x: number, y: number) => Vec2

function flattenPathD(d: string, toWorld: ToWorld, spacingMM: number): Vec2[][] {
  const runs: Vec2[][] = []
  let run: Vec2[] = []
  let i = 0
  const numRe = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y
  const skipSeparators = () => { while (i < d.length && /[\s,]/.test(d[i])) i++ }
  const readNumber = (): number | null => {
    skipSeparators()
    numRe.lastIndex = i
    const m = numRe.exec(d)
    if (!m) return null
    i = numRe.lastIndex
    return parseFloat(m[0])
  }
  // Arc flags may be written without separators ("a5 5 0 0110 10").
  const readFlag = (): number | null => {
    skipSeparators()
    if (d[i] === '0' || d[i] === '1') return d[i++] === '1' ? 1 : 0
    return null
  }
  const readNumbers = (n: number): number[] | null => {
    const out: number[] = []
    for (let k = 0; k < n; k++) {
      const v = readNumber()
      if (v === null) return null
      out.push(v)
    }
    return out
  }

  let cx = 0, cy = 0          // current point (user units)
  let sx = 0, sy = 0          // current subpath start
  let ctrlX = 0, ctrlY = 0    // last control point, for S/T reflection
  let prevCmd = ''

  const endRun = () => { if (run.length >= 2) runs.push(run); run = [] }
  const ensureRun = () => { if (run.length === 0) run.push(toWorld(cx, cy)) }
  const lineTo = (x: number, y: number) => {
    ensureRun()
    run.push(toWorld(x, y))
    cx = x; cy = y
  }
  // Sample a parametric curve p(t), t in (0, 1]; p(1) is the exact endpoint.
  const curveTo = (p: (t: number) => [number, number], x: number, y: number) => {
    ensureRun()
    let len = 0
    let prev = toWorld(cx, cy)
    for (let k = 1; k <= 16; k++) {
      const [px, py] = p(k / 16)
      const w = toWorld(px, py)
      len += Math.hypot(w.x - prev.x, w.y - prev.y)
      prev = w
    }
    let n = Math.min(MAX_SAMPLES_PER_CURVE, Math.max(2, Math.ceil(len / spacingMM)))
    if (n % 2 === 1) n++   // an even count samples a half-ellipse arc's apex
    for (let k = 1; k < n; k++) {
      const [px, py] = p(k / n)
      run.push(toWorld(px, py))
    }
    run.push(toWorld(x, y))
    cx = x; cy = y
  }

  let cmd = ''
  while (true) {
    skipSeparators()
    if (i >= d.length) break
    if (/[A-Za-z]/.test(d[i])) {
      cmd = d[i++]
    } else if (cmd === '' || cmd === 'Z' || cmd === 'z') {
      break   // numbers with no command to repeat: malformed, keep what parsed
    } else if (cmd === 'M') {
      cmd = 'L'   // implicit lineto after the first moveto pair
    } else if (cmd === 'm') {
      cmd = 'l'
    }
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? cx : 0, oy = rel ? cy : 0
    const upper = cmd.toUpperCase()

    // A command after Z that is not a moveto starts a new subpath at the old start.
    if ((prevCmd === 'Z') && upper !== 'M') { endRun(); cx = sx; cy = sy }

    let ok = true
    switch (upper) {
      case 'M': {
        const a = readNumbers(2)
        if (!a) { ok = false; break }
        endRun()
        cx = sx = ox + a[0]; cy = sy = oy + a[1]
        break
      }
      case 'L': {
        const a = readNumbers(2)
        if (!a) { ok = false; break }
        lineTo(ox + a[0], oy + a[1])
        break
      }
      case 'H': {
        const v = readNumber()
        if (v === null) { ok = false; break }
        lineTo(ox + v, cy)
        break
      }
      case 'V': {
        const v = readNumber()
        if (v === null) { ok = false; break }
        lineTo(cx, oy + v)
        break
      }
      case 'Z': {
        if (run.length > 0 || cx !== sx || cy !== sy) lineTo(sx, sy)
        endRun()
        cx = sx; cy = sy
        break
      }
      case 'C': case 'S': {
        let x1: number, y1: number, rest: number[] | null
        if (upper === 'C') {
          const a = readNumbers(6)
          if (!a) { ok = false; break }
          x1 = ox + a[0]; y1 = oy + a[1]; rest = a.slice(2)
        } else {
          rest = readNumbers(4)
          if (!rest) { ok = false; break }
          const reflect = prevCmd === 'C' || prevCmd === 'S'
          x1 = reflect ? 2 * cx - ctrlX : cx; y1 = reflect ? 2 * cy - ctrlY : cy
        }
        const x2 = ox + rest[0], y2 = oy + rest[1], x = ox + rest[2], y = oy + rest[3]
        const x0 = cx, y0 = cy
        curveTo(t => {
          const u = 1 - t
          return [
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
          ]
        }, x, y)
        ctrlX = x2; ctrlY = y2
        break
      }
      case 'Q': case 'T': {
        let x1: number, y1: number, end: number[] | null
        if (upper === 'Q') {
          const a = readNumbers(4)
          if (!a) { ok = false; break }
          x1 = ox + a[0]; y1 = oy + a[1]; end = a.slice(2)
        } else {
          end = readNumbers(2)
          if (!end) { ok = false; break }
          const reflect = prevCmd === 'Q' || prevCmd === 'T'
          x1 = reflect ? 2 * cx - ctrlX : cx; y1 = reflect ? 2 * cy - ctrlY : cy
        }
        const x = ox + end[0], y = oy + end[1]
        const x0 = cx, y0 = cy
        curveTo(t => {
          const u = 1 - t
          return [u * u * x0 + 2 * u * t * x1 + t * t * x, u * u * y0 + 2 * u * t * y1 + t * t * y]
        }, x, y)
        ctrlX = x1; ctrlY = y1
        break
      }
      case 'A': {
        const r = readNumbers(3)
        const fa = r ? readFlag() : null
        const fs = fa !== null ? readFlag() : null
        const e = fs !== null ? readNumbers(2) : null
        if (!r || fa === null || fs === null || !e) { ok = false; break }
        const x = ox + e[0], y = oy + e[1]
        if (x === cx && y === cy) break   // zero-length arc is omitted
        const arc = arcParametric(cx, cy, r[0], r[1], r[2], fa, fs, x, y)
        if (arc) curveTo(arc, x, y)
        else lineTo(x, y)
        break
      }
      default:
        ok = false
    }
    if (!ok) break   // SVG renders a path up to its first error
    prevCmd = upper
  }
  endRun()
  return runs
}

// W3C SVG implementation notes B.2.4: endpoint to center arc parameterisation.
// Returns null when either radius is zero (the arc is a straight line).
function arcParametric(
  x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number,
  fa: number, fs: number, x2: number, y2: number,
): ((t: number) => [number, number]) | null {
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0) return null
  const phi = (phiDeg * Math.PI) / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const coef = (fa !== fs ? 1 : -1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const ccx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const ccy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)))))
    return ux * vy - uy * vx < 0 ? -a : a
  }
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry
  const theta1 = angle(1, 0, ux, uy)
  let dTheta = angle(ux, uy, vx, vy)
  if (!fs && dTheta > 0) dTheta -= 2 * Math.PI
  if (fs && dTheta < 0) dTheta += 2 * Math.PI
  return t => {
    const th = theta1 + dTheta * t
    const ex = rx * Math.cos(th), ey = ry * Math.sin(th)
    return [cosP * ex - sinP * ey + ccx, sinP * ex + cosP * ey + ccy]
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Thrown when `importSVG` is handed text the XML parser could not read.
 * Named so `importGeometryFile`'s outer catch surfaces it verbatim and a caller
 * can tell a malformed file apart from an empty-but-valid one (WO-1452).
 */
export class MalformedSvgError extends Error {
  constructor() {
    super('malformed SVG: the XML parser could not read this file')
    this.name = 'MalformedSvgError'
  }
}

export function importSVG(svgText: string): Import2DResult {
  const parser = new DOMParser()
  const doc    = parser.parseFromString(svgText, 'image/svg+xml')

  // DOMParser NEVER throws on malformed XML, so there is no exception to catch
  // here. Every engine instead reports the parse failure by embedding a
  // <parsererror> element in the returned document -- sometimes alongside the
  // content it recovered before the syntax error. Without this check a file
  // truncated inside a tag still had a findable <svg> element, and its
  // partially recovered shapes were returned as an ordinary successful import
  // that `importGeometryFile` reported to the operator as success (WO-1452).
  if (doc.querySelector('parsererror')) throw new MalformedSvgError()

  const svgEl  = doc.querySelector('svg') as SVGSVGElement | null

  if (!svgEl) return { loops: [], layers: [], boundingBox: emptyBBox() }

  const vbMatrix = getSvgUserToMM(svgEl)

  const inkLayers  = extractInkscapeLayers(svgEl)
  const hasInkLayers = inkLayers.size > 0

  // If no Inkscape layers, group by stroke color
  const colorLayerMap = new Map<string, Layer2D>()  // color → layer

  // Collect all shape elements
  const shapeSelectors = 'path,line,polyline,polygon,rect,circle,ellipse'
  const elements = Array.from(svgEl.querySelectorAll(shapeSelectors))

  interface RawSeg { points: Vec2[]; layerId: string; color: string }
  const rawSegs: RawSeg[] = []

  for (const el of elements) {
    // Skip defs/symbol/marker/pattern/mask content and display:none subtrees —
    // they are not rendered geometry (B5 phantom-layer fix).
    if (isNonRendered(el, svgEl)) continue

    const dAttr = elementToD(el)
    if (!dAttr) continue

    // Determine layer
    let layerId: string
    if (hasInkLayers) {
      layerId = findLayerId(el, inkLayers)
    } else {
      const color = cssColor(el)
      if (!colorLayerMap.has(color)) {
        const idx = colorLayerMap.size
        const id  = `color-${idx}`
        colorLayerMap.set(color, {
          id,
          name: `Layer ${idx + 1}`,
          color: color.startsWith('#') ? color : PALETTE[idx % PALETTE.length],
          visible: true,
        })
      }
      layerId = colorLayerMap.get(color)!.id
    }

    // User units -> composed element/ancestor transforms -> root viewBox mm
    // mapping (origin + ratio + preserveAspectRatio), then flip Y (SVG Y-down
    // -> world Y-up).
    const m = multiply(vbMatrix, composedMatrix(el, svgEl))
    const toWorld: ToWorld = (x, y) => ({
      x: m[0] * x + m[2] * y + m[4],
      y: -(m[1] * x + m[3] * y + m[5]),
    })
    for (const pts of flattenPathD(dAttr, toWorld, SAMPLE_SPACING_MM)) {
      rawSegs.push({ points: pts, layerId, color: cssColor(el) })
    }
  }

  // Build final layer list
  const layerMap = hasInkLayers ? inkLayers : colorLayerMap

  // Ensure "default" layer exists if any segment referenced it
  const needsDefault = rawSegs.some(s => s.layerId === 'default')
  if (needsDefault) {
    layerMap.set('default', { id: 'default', name: 'Default', color: PALETTE[0], visible: true })
  }

  const layers: Layer2D[] = Array.from(layerMap.values())

  // Group by layer and join segments within each layer
  const layerSegMap = new Map<string, Vec2[][]>()
  for (const seg of rawSegs) {
    const arr = layerSegMap.get(seg.layerId) ?? []
    arr.push(seg.points)
    layerSegMap.set(seg.layerId, arr)
  }

  let allLoops: Loop2D[] = []
  for (const [layerId, segs] of layerSegMap) {
    allLoops = allLoops.concat(joinSegments(segs, layerId))
  }

  allLoops = centerLoops(allLoops)

  // Drop layers that ended up owning no geometry (empty Inkscape layer groups,
  // or layers whose every element was filtered as non-rendered). A layer with
  // zero loops contributes nothing drawable but clutters the tree (B5).
  const usedLayerIds = new Set(allLoops.map(l => l.layerId))
  const layersWithGeometry = layers.filter(l => usedLayerIds.has(l.id))

  const bb2 = computeBBox2D(allLoops)
  const bbox: BoundingBox = {
    min: { x: bb2.min.x, y: bb2.min.y, z: 0 },
    max: { x: bb2.max.x, y: bb2.max.y, z: 0 },
    size: { x: bb2.size.x, y: bb2.size.y, z: 0 },
    center: { x: bb2.center.x, y: bb2.center.y, z: 0 },
  }

  return { loops: allLoops, layers: layersWithGeometry, boundingBox: bbox }
}

function emptyBBox(): BoundingBox {
  return {
    min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
    size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
  }
}
