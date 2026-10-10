// WO-1839: an LWPOLYLINE's bulge (group 42) was thrown away, so every rounded
// segment of a slot / obround / rounded rectangle imported as a straight chord
// between its two vertices, with no warning. bulge = tan(sweep/4); the sign
// gives the direction. These tests drive the production entry (importDXF) with
// hand-built DXF text (same code/value convention as dxfUnits.wo1391.test.ts).

import { describe, it, expect } from 'vitest'
import { importDXF } from '../../lib/import/dxfImporter'
import type { Loop2D, Vec2 } from '../../types'

type P = Array<[number | string, string]>

function dxf(pairs: P): string {
  return pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}

function header(insUnits?: number): P {
  if (insUnits === undefined) return []
  return [[0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, String(insUnits)], [0, 'ENDSEC']]
}

const OPEN: P = [[0, 'SECTION'], [2, 'ENTITIES']]
const CLOSE: P = [[0, 'ENDSEC'], [0, 'EOF']]

/** LWPOLYLINE from [x, y, bulge?] vertices; bulge written after the vertex's 10/20 like CAD does. */
function lwpoly(layer: string, closed: boolean, verts: Array<[number, number, number?]>): P {
  const out: P = [[0, 'LWPOLYLINE'], [8, layer], [90, String(verts.length)], [70, closed ? '1' : '0']]
  for (const [x, y, b] of verts) {
    out.push([10, String(x)], [20, String(y)])
    if (b !== undefined) out.push([42, String(b)])
  }
  return out
}

// Obround 20 long (vertex to vertex), 10 wide: straight bottom and top, a
// semicircular end of radius 5 on each side. The left end's bulge sits on the
// LAST vertex, i.e. on the closing segment.
function obround(endBulge: number): P {
  return lwpoly('Cut', true, [[0, 0], [20, 0, endBulge], [20, 10], [0, 10, endBulge]])
}

// sampleArc's chord length for ARC entities (dxfImporter.ts).
const SEG_LEN_MM = 0.5

function size(loop: Loop2D): { w: number; h: number } {
  const xs = loop.points.map(p => p.x), ys = loop.points.map(p => p.y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

function maxChord(pts: Vec2[]): number {
  let m = 0
  for (let i = 1; i < pts.length; i++) m = Math.max(m, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return m
}

describe('WO-1839: DXF LWPOLYLINE bulges import as arcs', () => {
  it('a closed obround with +1 bulges imports as one loop with true semicircular ends', () => {
    const r = importDXF(dxf([...OPEN, ...obround(1), ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    const loop = r.loops[0]
    expect(loop.closed).toBe(true)

    // True extents: 20 + 2 x 5 long, 10 wide (chords would give 20 x 10).
    const { w, h } = size(loop)
    expect(Math.abs(w - 30)).toBeLessThan(1e-6)
    expect(Math.abs(h - 10)).toBeLessThan(1e-6)
    expect(Math.abs(r.boundingBox.size.x - 30)).toBeLessThan(1e-6)
    expect(Math.abs(r.boundingBox.size.y - 10)).toBeLessThan(1e-6)

    // importDXF centres the loops: the end circles are centred at (+-10, 0), radius 5.
    const right = loop.points.filter(p => p.x > 10 + 1e-9)
    const left = loop.points.filter(p => p.x < -10 - 1e-9)
    expect(right.length).toBeGreaterThan(4)
    expect(left.length).toBeGreaterThan(4)
    for (const p of right) expect(Math.abs(Math.hypot(p.x - 10, p.y) - 5)).toBeLessThan(1e-9)
    for (const p of left) expect(Math.abs(Math.hypot(p.x + 10, p.y) - 5)).toBeLessThan(1e-9)
    // Sampled no coarser than an ARC entity.
    expect(maxChord(right)).toBeLessThanOrEqual(SEG_LEN_MM + 1e-9)
    expect(maxChord(left)).toBeLessThanOrEqual(SEG_LEN_MM + 1e-9)
  })

  it('the bulge on the closing segment (last vertex back to first) is honoured', () => {
    // Only the closing segment is bulged: the loop reaches 5 past x = 0 on the left only.
    const r = importDXF(dxf([...OPEN, ...lwpoly('Cut', true, [[0, 0], [20, 0], [20, 10], [0, 10, 1]]), ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    const { w, h } = size(r.loops[0])
    expect(Math.abs(w - 25)).toBeLessThan(1e-6)
    expect(Math.abs(h - 10)).toBeLessThan(1e-6)
  })

  it('a negative bulge sweeps the other way', () => {
    // -1 ends curve inward: the loop never leaves x in [0, 20].
    const inward = importDXF(dxf([...OPEN, ...obround(-1), ...CLOSE]))
    expect(Math.abs(inward.boundingBox.size.x - 20)).toBeLessThan(1e-6)

    // One open half-circle segment (0,0)->(10,0) with a reference line at y = 10
    // on another layer. +1 (counter-clockwise) dips to y = -5; -1 rises to y = +5.
    const ref: P = [[0, 'LINE'], [8, 'Ref'], [10, '0'], [20, '10'], [11, '10'], [21, '10']]
    const down = importDXF(dxf([...OPEN, ...ref, ...lwpoly('Cut', false, [[0, 0, 1], [10, 0]]), ...CLOSE]))
    const up = importDXF(dxf([...OPEN, ...ref, ...lwpoly('Cut', false, [[0, 0, -1], [10, 0]]), ...CLOSE]))
    expect(Math.abs(down.boundingBox.size.y - 15)).toBeLessThan(1e-6)
    expect(Math.abs(up.boundingBox.size.y - 10)).toBeLessThan(1e-6)
    const arcUp = up.loops.find(l => l.layerId === 'Cut')!
    const arcDown = down.loops.find(l => l.layerId === 'Cut')!
    // Relative to the reference line, the -1 arc sits above where the +1 arc sits.
    const refUp = up.loops.find(l => l.layerId === 'Ref')!.points[0].y
    const refDown = down.loops.find(l => l.layerId === 'Ref')!.points[0].y
    expect(Math.min(...arcDown.points.map(p => p.y)) - refDown).toBeCloseTo(-15, 6)
    expect(Math.max(...arcUp.points.map(p => p.y)) - refUp).toBeCloseTo(-5, 6)
  })

  it('a quarter bulge (tan(22.5 deg)) is a 90-degree arc on the true circle', () => {
    const b = Math.tan(Math.PI / 8)
    const r = importDXF(dxf([...OPEN, ...lwpoly('Cut', false, [[10, 0, b], [0, 10]]), ...CLOSE]))
    const pts = r.loops[0].points
    // Counter-clockwise quarter of the circle centred at the origin, radius 10.
    // After centring: bbox is 10 x 10, centre moved to (5, 5).
    expect(Math.abs(r.boundingBox.size.x - 10)).toBeLessThan(1e-6)
    expect(Math.abs(r.boundingBox.size.y - 10)).toBeLessThan(1e-6)
    for (const p of pts) expect(Math.abs(Math.hypot(p.x + 5, p.y + 5) - 10)).toBeLessThan(1e-9)
    expect(maxChord(pts)).toBeLessThanOrEqual(SEG_LEN_MM + 1e-9)
  })

  it('unit scaling applies to bulged segments ($INSUNITS inches -> mm)', () => {
    const r = importDXF(dxf([...header(1), ...OPEN, ...obround(1), ...CLOSE]))
    expect(r.unitScale).toBe(25.4)
    expect(Math.abs(r.boundingBox.size.x - 30 * 25.4)).toBeLessThan(1e-6)
    expect(Math.abs(r.boundingBox.size.y - 10 * 25.4)).toBeLessThan(1e-6)
    const loop = r.loops[0]
    const right = loop.points.filter(p => p.x > 10 * 25.4 + 1e-9)
    for (const p of right) expect(Math.abs(Math.hypot(p.x - 10 * 25.4, p.y) - 5 * 25.4)).toBeLessThan(1e-7)
  })

  it('a polyline with no bulges is unchanged (straight segments, vertex points only)', () => {
    const r = importDXF(dxf([...OPEN, ...lwpoly('Cut', true, [[0, 0], [20, 0], [20, 10], [0, 10]]), ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    expect(Math.abs(r.boundingBox.size.x - 20)).toBeLessThan(1e-9)
    expect(r.loops[0].points.length).toBeLessThanOrEqual(5)
  })
})
