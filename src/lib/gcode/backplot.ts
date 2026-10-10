// ============================================================
// G-code backplot — top-down XY plot to an SVG string (reusable)
// ============================================================
// Renders a parsed program as a plan-view SVG: feed segments solid, rapids
// dashed in a distinct colour, a start dot, a light grid + axis labels, and a
// title. SVG works in the browser and can be screenshotted headless, so it
// doubles as the visualiser for a future in-app sender.
//
// Z is not drawn in plan view, but feed segments are OPTIONALLY tinted by depth
// band (opts.colorByDepth) so plunges/finish passes read at a glance.

import type { GcodeProgram, GcodeSegment } from './parse'

export interface BackplotOptions {
  width?: number // px (default 800)
  height?: number // px (default 600)
  margin?: number // px around the fitted path (default 32)
  title?: string
  feedColor?: string // default '#1b9e77'
  feedStrokeWidth?: number // default 1.8
  rapidColor?: string // default '#d95f02'
  background?: string // default '#ffffff'
  /** Tint feed segments by Z depth band instead of a flat feedColor. */
  colorByDepth?: boolean
  /** Coordinate label only: the parser retains the posted coordinate units. */
  units?: 'mm' | 'inch'
  /** Setup-sheet pictures fit cuts; travel is clipped to the fitted frame. */
  fitToCuttingMoves?: boolean
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function computeBounds(segments: GcodeSegment[]): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const s of segments) {
    acc(s.from.x, s.from.y)
    acc(s.to.x, s.to.y)
  }
  if (!Number.isFinite(minX)) {
    // Empty program: a unit box so the SVG is still valid.
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  }
  return { minX, minY, maxX, maxY }
}

/** A simple blue->red depth ramp over [zMin,zMax] (deepest = warmest). */
function depthColor(z: number, zMin: number, zMax: number): string {
  if (zMax === zMin) return '#1b9e77'
  const t = (z - zMin) / (zMax - zMin) // 1 at top, 0 at deepest
  const deep = 1 - t // 1 at deepest
  const r = Math.round(40 + deep * 180)
  const g = Math.round(120 - deep * 60)
  const b = Math.round(180 - deep * 140)
  return `rgb(${r},${g},${b})`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Render the program to a standalone SVG string. */
export function backplotSvg(program: GcodeProgram, opts: BackplotOptions = {}): string {
  const W = opts.width ?? 800
  const H = opts.height ?? 600
  const margin = opts.margin ?? 32
  const feedColor = opts.feedColor ?? '#1b9e77'
  const feedStrokeWidth = opts.feedStrokeWidth ?? 1.8
  const rapidColor = opts.rapidColor ?? '#d95f02'
  const background = opts.background ?? '#ffffff'
  const title = opts.title ?? 'G-code backplot (plan view)'
  const units = opts.units === 'inch' ? 'in' : 'mm'

  const segs = program.segments
  const cuts = segs.filter(s => s.kind !== 'rapid')
  const fitted = opts.fitToCuttingMoves && cuts.length > 0 ? cuts : segs
  const b = computeBounds(fitted)
  const spanX = Math.max(b.maxX - b.minX, 1e-6)
  const spanY = Math.max(b.maxY - b.minY, 1e-6)

  // Fit path bounds into the drawable area (W-2m) x (H-2m), preserving aspect.
  const drawW = W - 2 * margin
  const drawH = H - 2 * margin
  const scale = Math.min(drawW / spanX, drawH / spanY)
  // Centre the fitted path in the drawable area.
  const offX = margin + (drawW - spanX * scale) / 2
  const offY = margin + (drawH - spanY * scale) / 2

  // World (x,y) -> SVG (px). Y is flipped (g-code +Y is up, SVG +Y is down).
  const sx = (x: number) => offX + (x - b.minX) * scale
  const sy = (y: number) => H - (offY + (y - b.minY) * scale)

  // Clip a rapid to the cutting bounds (Liang-Barsky). Travel from a previous
  // operation must not shrink the cut or escape into the surrounding rows.
  const rapidEndpoints = (s: GcodeSegment) => {
    if (!opts.fitToCuttingMoves || cuts.length === 0) return [s.from, s.to]
    let lo = 0, hi = 1
    const dx = s.to.x - s.from.x, dy = s.to.y - s.from.y
    for (const [p, q] of [[-dx, s.from.x - b.minX], [dx, b.maxX - s.from.x], [-dy, s.from.y - b.minY], [dy, b.maxY - s.from.y]]) {
      if (p === 0) { if (q < 0) return []; continue }
      const t = q / p
      if (p < 0) lo = Math.max(lo, t)
      else hi = Math.min(hi, t)
      if (lo > hi) return []
    }
    return [lo, hi].map(t => ({ x: s.from.x + t * dx, y: s.from.y + t * dy }))
  }

  // Z range for optional depth tinting.
  let zMin = Infinity
  let zMax = -Infinity
  for (const s of fitted) {
    zMin = Math.min(zMin, s.from.z, s.to.z)
    zMax = Math.max(zMax, s.from.z, s.to.z)
  }

  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace">`,
  )
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${background}"/>`)

  // --- light grid (nice round step over the larger span) ---
  const step = niceStep(Math.max(spanX, spanY))
  const gridStart = (v: number) => Math.ceil(v / step) * step
  parts.push(`<g stroke="#e6e6e6" stroke-width="1">`)
  for (let gx = gridStart(b.minX); gx <= b.maxX; gx += step) {
    const px = sx(gx)
    parts.push(`<line x1="${px.toFixed(1)}" y1="${margin}" x2="${px.toFixed(1)}" y2="${H - margin}"/>`)
  }
  for (let gy = gridStart(b.minY); gy <= b.maxY; gy += step) {
    const py = sy(gy)
    parts.push(`<line x1="${margin}" y1="${py.toFixed(1)}" x2="${W - margin}" y2="${py.toFixed(1)}"/>`)
  }
  parts.push(`</g>`)

  // --- axis frame + labels ---
  parts.push(
    `<rect x="${margin}" y="${margin}" width="${W - 2 * margin}" height="${H - 2 * margin}" fill="none" stroke="#bbbbbb" stroke-width="1"/>`,
  )
  parts.push(
    `<text x="${margin}" y="${H - margin + 16}" font-size="11" fill="#666">X ${b.minX.toFixed(1)} .. ${b.maxX.toFixed(1)} ${units}</text>`,
  )
  parts.push(
    `<text x="${margin}" y="${margin - 8}" font-size="11" fill="#666">Y ${b.minY.toFixed(1)} .. ${b.maxY.toFixed(1)} ${units}</text>`,
  )
  parts.push(`<text x="${margin}" y="18" font-size="14" fill="#222">${esc(title)}</text>`)

  // --- segments ---
  // Rapids first (under), then feeds (over) so cutting reads clearly.
  const rapidPath: string[] = []
  for (const s of segs) {
    if (s.kind !== 'rapid') continue
    const endpoints = rapidEndpoints(s)
    if (endpoints.length === 0) continue
    rapidPath.push(`M ${sx(endpoints[0].x).toFixed(2)} ${sy(endpoints[0].y).toFixed(2)} L ${sx(endpoints[1].x).toFixed(2)} ${sy(endpoints[1].y).toFixed(2)}`)
  }
  if (rapidPath.length > 0) {
    parts.push(
      `<path d="${rapidPath.join(' ')}" fill="none" stroke="${rapidColor}" stroke-width="1" stroke-dasharray="4 3"/>`,
    )
  }

  for (const s of segs) {
    if (s.kind === 'rapid') continue
    const color = opts.colorByDepth ? depthColor((s.from.z + s.to.z) / 2, zMin, zMax) : feedColor
    parts.push(
      `<line x1="${sx(s.from.x).toFixed(2)}" y1="${sy(s.from.y).toFixed(2)}" x2="${sx(s.to.x).toFixed(2)}" y2="${sy(s.to.y).toFixed(2)}" stroke="${color}" stroke-width="${feedStrokeWidth}" stroke-linecap="round"/>`,
    )
  }

  // --- start dot ---
  if (segs.length > 0) {
    const first = fitted[0].from
    parts.push(`<circle cx="${sx(first.x).toFixed(2)}" cy="${sy(first.y).toFixed(2)}" r="4" ${opts.fitToCuttingMoves ? 'fill="none" stroke="#111" stroke-width="1"' : 'fill="#111"'}/>`)
    parts.push(`<text x="${(sx(first.x) + 6).toFixed(2)}" y="${(sy(first.y) - 6).toFixed(2)}" font-size="10" fill="#111">start</text>`)
  }

  // --- legend ---
  const ly = H - 14
  if (opts.colorByDepth) {
    for (const [i, z] of [zMax, (zMin + zMax) / 2, zMin].entries()) {
      const x = W - 250 + i * 8
      parts.push(`<line x1="${x}" y1="${ly}" x2="${x + 8}" y2="${ly}" stroke="${depthColor(z, zMin, zMax)}" stroke-width="1.8"/>`)
    }
    parts.push(`<text x="${W - 220}" y="${ly + 4}" font-size="11" fill="#444">feed depth</text>`)
  } else {
    parts.push(`<line x1="${W - 220}" y1="${ly}" x2="${W - 200}" y2="${ly}" stroke="${feedColor}" stroke-width="1.8"/>`)
    parts.push(`<text x="${W - 196}" y="${ly + 4}" font-size="11" fill="#444">feed</text>`)
  }
  parts.push(`<line x1="${W - 150}" y1="${ly}" x2="${W - 130}" y2="${ly}" stroke="${rapidColor}" stroke-width="1" stroke-dasharray="4 3"/>`)
  parts.push(`<text x="${W - 126}" y="${ly + 4}" font-size="11" fill="#444">rapid</text>`)

  parts.push(`</svg>`)
  return parts.join('\n')
}

/** Pick a "nice" grid step (1/2/5 x 10^n) near span/8. */
function niceStep(span: number): number {
  const target = span / 8
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  const norm = target / pow
  const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10
  return step * pow
}
