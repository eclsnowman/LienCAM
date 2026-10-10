// Test-only polyfill for the SVG geometry API that jsdom does not implement.
//
// importSVG runs the real browser pipeline: DOMParser -> querySelectorAll ->
// a hidden live <svg> host -> SVGPathElement.getTotalLength/getPointAtLength
// for sampling. jsdom provides everything EXCEPT the last primitive (its SVG
// elements have no geometry API). This module evaluates the path `d` grammar
// the importer emits (M/L/H/V/A/Z and their relative forms — elementToD never
// produces curves beyond elliptical arcs) so the production importSVG code
// runs headless END-TO-END with only that one browser primitive shimmed.
// Unknown commands throw — fail loud rather than mis-measure.

export interface Pt { x: number; y: number }

interface Seg { ax: number; ay: number; bx: number; by: number; len: number; start: number }

export interface MeasuredPath {
  total: number
  /** Contiguous polyline runs (moveto starts a new run; jumps carry no length) */
  runs: Pt[][]
  segs: Seg[]
}

// W3C SVG 1.1 F.6.5 endpoint -> center arc conversion, flattened to a polyline.
function arcToPolyline(
  x1: number, y1: number,
  rx: number, ry: number, phiDeg: number, fa: number, fs: number,
  x2: number, y2: number,
): Pt[] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ x: x2, y: y2 }]
  rx = Math.abs(rx); ry = Math.abs(ry)
  const phi = (phiDeg * Math.PI) / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s }
  const sign = fa !== fs ? 1 : -1
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const coef = sign * Math.sqrt(Math.max(0, num / den))
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy
    const norm = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let a = Math.acos(Math.min(1, Math.max(-1, dot / norm)))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry
  const t1 = ang(1, 0, ux, uy)
  let dt = ang(ux, uy, vx, vy)
  if (!fs && dt > 0) dt -= 2 * Math.PI
  if (fs && dt < 0) dt += 2 * Math.PI
  const n = Math.max(8, Math.ceil(Math.abs(dt) * 64))   // ~1 deg per chord
  const out: Pt[] = []
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t)
    out.push({ x: cosP * ex - sinP * ey + cx, y: sinP * ex + cosP * ey + cy })
  }
  out[out.length - 1] = { x: x2, y: y2 }   // exact endpoint
  return out
}

/** Flatten a path `d` into contiguous polyline runs (one per subpath). */
export function flattenPathD(d: string): Pt[][] {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []
  const runs: Pt[][] = []
  let run: Pt[] = []
  let cmd = ''
  let cx = 0, cy = 0, sx = 0, sy = 0
  let i = 0
  const num = (): number => {
    const v = parseFloat(tokens[i++] ?? '')
    if (Number.isNaN(v)) throw new Error(`svgPathGeometryPolyfill: bad number at token ${i - 1} in "${d}"`)
    return v
  }
  const endRun = () => { if (run.length > 1) runs.push(run); run = [] }
  const moveTo = (x: number, y: number) => { endRun(); cx = x; cy = y; sx = x; sy = y; run = [{ x, y }] }
  const lineTo = (x: number, y: number) => { run.push({ x, y }); cx = x; cy = y }

  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[A-Za-z]$/.test(t)) { cmd = t; i++ }
    else if (cmd === 'M') cmd = 'L'   // implicit lineto after moveto
    else if (cmd === 'm') cmd = 'l'

    switch (cmd) {
      case 'M': moveTo(num(), num()); break
      case 'm': moveTo(cx + num(), cy + num()); break
      case 'L': lineTo(num(), num()); break
      case 'l': lineTo(cx + num(), cy + num()); break
      case 'H': lineTo(num(), cy); break
      case 'h': lineTo(cx + num(), cy); break
      case 'V': lineTo(cx, num()); break
      case 'v': lineTo(cx, cy + num()); break
      case 'A': case 'a': {
        const rel = cmd === 'a'
        const rx = num(), ry = num(), rot = num(), laf = num(), sf = num()
        const x = (rel ? cx : 0) + num()
        const y = (rel ? cy : 0) + num()
        for (const p of arcToPolyline(cx, cy, rx, ry, rot, laf, sf, x, y)) run.push(p)
        cx = x; cy = y
        break
      }
      case 'Z': case 'z': lineTo(sx, sy); break
      default:
        throw new Error(`svgPathGeometryPolyfill: unsupported path command "${cmd}" in "${d}"`)
    }
  }
  endRun()
  return runs
}

export function measurePath(d: string): MeasuredPath {
  const runs = flattenPathD(d)
  const segs: Seg[] = []
  let total = 0
  for (const run of runs) {
    for (let k = 1; k < run.length; k++) {
      const a = run[k - 1], b = run[k]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, len, start: total })
      total += len
    }
  }
  return { total, runs, segs }
}

export function pointAtLength(m: MeasuredPath, t: number): Pt {
  if (m.segs.length === 0) return { x: 0, y: 0 }
  const tt = Math.min(Math.max(t, 0), m.total)
  // segs are start-ordered: binary search the containing segment
  let lo = 0, hi = m.segs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (m.segs[mid].start <= tt) lo = mid; else hi = mid - 1
  }
  const s = m.segs[lo]
  const f = s.len > 0 ? (tt - s.start) / s.len : 0
  return { x: s.ax + (s.bx - s.ax) * f, y: s.ay + (s.by - s.ay) * f }
}

/** Install getTotalLength/getPointAtLength on the window's SVGElement proto. */
export function installSvgPathGeometry(win: { SVGElement: { prototype: object } }): void {
  const cache = new Map<string, MeasuredPath>()
  const measured = (el: Element): MeasuredPath => {
    const d = el.getAttribute('d') ?? ''
    let m = cache.get(d)
    if (!m) { m = measurePath(d); cache.set(d, m) }
    return m
  }
  const proto = win.SVGElement.prototype as {
    getTotalLength?: (this: Element) => number
    getPointAtLength?: (this: Element, t: number) => Pt
  }
  proto.getTotalLength = function (this: Element) { return measured(this).total }
  proto.getPointAtLength = function (this: Element, t: number) { return pointAtLength(measured(this), t) }
}
