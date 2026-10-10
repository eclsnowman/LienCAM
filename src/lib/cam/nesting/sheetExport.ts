/* WO-2415 (ADR-0057): one nest sheet -> DXF or SVG.
 *
 * PURE: no store / DOM imports. The sheet outline and every placed part (outer
 * loop plus its holes, rotated and positioned exactly as the nest stored it:
 * translate(x, y) . rotate(rotationDeg), the same transform instanceToolpath
 * uses) go on separate layers, each part with a text label. Coordinates are
 * written in sheet millimetres with the origin at the sheet's lower-left, so a
 * reader gets the stored placements back without any further transform.
 */

import type { ImportedGeometry, NestRecord, Vec2 } from '../../../types/index'
import { transformRing } from './placement'

export const SHEET_LAYER = 'SHEET'
export const PARTS_LAYER = 'PARTS'
export const HOLES_LAYER = 'HOLES'
export const LABELS_LAYER = 'LABELS'

export interface SheetExportPart {
  instanceId: string
  label: string
  x: number
  y: number
  rotationDeg: number
  /** Placed outer ring (sheet coords). */
  outer: Vec2[]
  /** Placed hole rings (sheet coords). */
  holes: Vec2[][]
}

export interface SheetExportModel {
  name: string
  width: number
  height: number
  parts: SheetExportPart[]
}

function ringOf(points: Vec2[]): Vec2[] {
  return points.map((p) => ({ x: p.x, y: p.y }))
}

/** Resolve a stored nest record into placed rings. A placement whose source
 *  geometry is gone is skipped (nothing to draw), never guessed. */
export function buildSheetExportModel(nest: NestRecord, geometry: readonly ImportedGeometry[]): SheetExportModel {
  const byId = new Map(geometry.map((g) => [g.id, g]))
  const parts: SheetExportPart[] = []
  for (const pl of nest.placements) {
    const geo = byId.get(pl.partId)
    if (!geo) continue
    const closed = (geo.loops ?? []).filter((l) => l.closed && l.points.length >= 3)
    if (closed.length === 0) continue
    // The outer is the largest closed loop; every other closed loop is a hole
    // (the same split nestPartGeometryFromLoops feeds the packer).
    let outerLoop = closed[0]
    for (const l of closed) if (Math.abs(l.area) > Math.abs(outerLoop.area)) outerLoop = l
    const holeLoops = closed.filter((l) => l !== outerLoop)
    parts.push({
      instanceId: pl.instanceId,
      label: geo.name,
      x: pl.x,
      y: pl.y,
      rotationDeg: pl.rotationDeg,
      outer: transformRing(ringOf(outerLoop.points), pl.rotationDeg, pl.x, pl.y),
      holes: holeLoops.map((l) => transformRing(ringOf(l.points), pl.rotationDeg, pl.x, pl.y)),
    })
  }
  return { name: nest.name, width: nest.sheet.width, height: nest.sheet.height, parts }
}

/** Plain fixed-point number, never exponent notation (DXF/SVG readers vary). */
function num(n: number): string {
  const s = n.toFixed(9)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

function centroid(ring: Vec2[]): Vec2 {
  let sx = 0
  let sy = 0
  for (const p of ring) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / ring.length, y: sy / ring.length }
}

function labelHeight(m: SheetExportModel): number {
  return Math.max(1, Math.min(m.width, m.height) / 60)
}

function sheetRing(m: SheetExportModel): Vec2[] {
  return [
    { x: 0, y: 0 },
    { x: m.width, y: 0 },
    { x: m.width, y: m.height },
    { x: 0, y: m.height },
  ]
}

function dxfText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}

export function sheetToDxf(m: SheetExportModel): string {
  const out: string[] = []
  const g = (code: number, value: string | number): void => {
    out.push(String(code), typeof value === 'number' ? num(value) : value)
  }
  g(0, 'SECTION'); g(2, 'HEADER')
  g(9, '$ACADVER'); g(1, 'AC1015')
  g(9, '$INSUNITS'); g(70, '4')
  g(0, 'ENDSEC')
  g(0, 'SECTION'); g(2, 'TABLES')
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, '4')
  const layers: [string, number][] = [[SHEET_LAYER, 7], [PARTS_LAYER, 3], [HOLES_LAYER, 5], [LABELS_LAYER, 2]]
  for (const [name, color] of layers) {
    g(0, 'LAYER'); g(2, name); g(70, '0'); g(62, String(color)); g(6, 'CONTINUOUS')
  }
  g(0, 'ENDTAB')
  g(0, 'ENDSEC')
  g(0, 'SECTION'); g(2, 'ENTITIES')
  const poly = (layer: string, ring: Vec2[]): void => {
    g(0, 'LWPOLYLINE'); g(100, 'AcDbEntity'); g(8, layer); g(100, 'AcDbPolyline')
    g(90, String(ring.length)); g(70, '1')
    for (const p of ring) { g(10, p.x); g(20, p.y) }
  }
  poly(SHEET_LAYER, sheetRing(m))
  const h = labelHeight(m)
  for (const part of m.parts) {
    poly(PARTS_LAYER, part.outer)
    for (const hole of part.holes) poly(HOLES_LAYER, hole)
    const c = centroid(part.outer)
    g(0, 'TEXT'); g(100, 'AcDbEntity'); g(8, LABELS_LAYER); g(100, 'AcDbText')
    g(10, c.x); g(20, c.y); g(30, '0'); g(40, h); g(1, dxfText(part.label))
  }
  g(0, 'ENDSEC')
  g(0, 'EOF')
  return out.join('\r\n') + '\r\n'
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** SVG has Y pointing down; the outlines sit in a group that flips Y back so
 *  the path data stays in raw sheet coordinates. Labels are outside the flip
 *  so the text reads upright. */
export function sheetToSvg(m: SheetExportModel): string {
  const d = (ring: Vec2[]): string =>
    ring.map((p, i) => `${i === 0 ? 'M' : 'L'}${num(p.x)} ${num(p.y)}`).join(' ') + ' Z'
  const h = labelHeight(m)
  const o: string[] = []
  o.push('<?xml version="1.0" encoding="UTF-8"?>')
  o.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(m.width)}mm" height="${num(m.height)}mm" viewBox="0 0 ${num(m.width)} ${num(m.height)}">`,
  )
  o.push(`<title>${xmlEsc(m.name)}</title>`)
  o.push(`<g transform="translate(0 ${num(m.height)}) scale(1 -1)" fill="none" stroke-width="0.25">`)
  o.push(`<g id="${SHEET_LAYER}" stroke="#000000"><path d="${d(sheetRing(m))}"/></g>`)
  o.push(`<g id="${PARTS_LAYER}" stroke="#008800">`)
  for (const p of m.parts) {
    o.push(
      `<path data-instance="${xmlEsc(p.instanceId)}" data-x="${num(p.x)}" data-y="${num(p.y)}" data-rotation="${num(p.rotationDeg)}" d="${d(p.outer)}"/>`,
    )
  }
  o.push('</g>')
  o.push(`<g id="${HOLES_LAYER}" stroke="#0000cc">`)
  for (const p of m.parts) for (const hole of p.holes) o.push(`<path data-instance="${xmlEsc(p.instanceId)}" d="${d(hole)}"/>`)
  o.push('</g>')
  o.push('</g>')
  o.push(`<g id="${LABELS_LAYER}" fill="#886600" font-family="sans-serif" font-size="${num(h)}" text-anchor="middle">`)
  for (const p of m.parts) {
    const c = centroid(p.outer)
    o.push(`<text x="${num(c.x)}" y="${num(m.height - c.y)}">${xmlEsc(p.label)}</text>`)
  }
  o.push('</g>')
  o.push('</svg>')
  return o.join('\n') + '\n'
}

export function sheetExportFilename(nestName: string, ext: 'dxf' | 'svg'): string {
  const base = nestName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'nest-sheet'
  return `${base}.${ext}`
}
