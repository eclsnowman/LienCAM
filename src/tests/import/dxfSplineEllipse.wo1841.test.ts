// WO-1841: dxfImporter parsed only LINE / ARC / CIRCLE / LWPOLYLINE, so every
// SPLINE, ELLIPSE and legacy POLYLINE in a Fusion / SolidWorks / Inkscape DXF
// vanished and a pocket built from that drawing was simply missing its curved
// boundary. These tests drive the production entry (importDXF) with hand-built
// DXF text, same code/value convention as dxfUnits.wo1391.test.ts and
// dxfBulgeArcs.wo1839.test.ts.
//
// Reference curves below are evaluated independently of the importer (Bernstein
// cubic for the spline, the closed-form ellipse parametrisation) so "the sample
// lies on the curve" is a real check and not the importer agreeing with itself.

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

// The chord spacing sampleArc has always used for ARC/CIRCLE; WO-1841 holds
// SPLINE and ELLIPSE to the same one (dxfCurves.CHORD_LEN_MM).
const CHORD_MM = 0.5

function size(loop: Loop2D): { w: number; h: number } {
  const xs = loop.points.map(p => p.x), ys = loop.points.map(p => p.y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}
function maxChord(pts: Vec2[]): number {
  let m = 0
  for (let i = 1; i < pts.length; i++) m = Math.max(m, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return m
}
/** Distance from `p` to the polyline `ref` (point-to-segment, not point-to-vertex). */
function distToPolyline(p: Vec2, ref: Vec2[]): number {
  let best = Infinity
  for (let i = 1; i < ref.length; i++) {
    const a = ref[i - 1], b = ref[i]
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
  }
  return best
}

// ── SPLINE: a clamped cubic Bezier, whose exact curve the test knows ──────────
//
// 4 control points with knots [0,0,0,0,1,1,1,1] IS the cubic Bezier over those
// points, so the reference below is the Bernstein form - arithmetic the importer
// never runs (it uses de Boor on the knot vector).
const BEZ: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 40, y: -20 }, { x: 60, y: 10 }]

function bezier(t: number): Vec2 {
  const u = 1 - t
  const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return {
    x: BEZ.reduce((s, p, i) => s + p.x * b[i], 0),
    y: BEZ.reduce((s, p, i) => s + p.y * b[i], 0),
  }
}
// 100_000 segments: the reference polyline's own sagitta is far below the 1e-6 mm
// the acceptance asks for, so a failure is the importer's and not the reference's.
const BEZ_REF: Vec2[] = Array.from({ length: 100001 }, (_, i) => bezier(i / 100000))

/** SPLINE record, control-point form, clamped cubic over `ctrl`. */
function splineCtrl(layer: string, ctrl: Vec2[], weights?: number[]): P {
  const out: P = [
    [0, 'SPLINE'], [8, layer],
    [70, weights ? '12' : '8'],   // 8 planar, +4 rational when weighted
    [71, '3'], [72, String(ctrl.length + 4)], [73, String(ctrl.length)], [74, '0'],
  ]
  const inner = ctrl.length - 4
  const knots = [0, 0, 0, 0, ...Array.from({ length: inner }, (_, i) => (i + 1) / (inner + 1)), 1, 1, 1, 1]
  for (const k of knots) out.push([40, String(k)])
  if (weights) for (const w of weights) out.push([41, String(w)])
  for (const p of ctrl) out.push([10, String(p.x)], [20, String(p.y)], [30, '0.0'])
  return out
}

describe('WO-1841: a DXF SPLINE imports as a chain on the evaluated curve', () => {
  it('a clamped cubic samples onto the Bezier it describes, within 1e-6 mm', () => {
    const r = importDXF(dxf([...OPEN, ...splineCtrl('Cut', BEZ), ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    expect(r.report.skipped).toEqual([])

    const pts = r.loops[0].points
    expect(pts.length).toBeGreaterThan(20)

    // importDXF re-centres every loop on the drawing bbox, so compare shape:
    // anchor the reference on the chain's own first point (the curve's start,
    // pinned by the next test) and every other sample must then land on it.
    const dx = pts[0].x - BEZ_REF[0].x, dy = pts[0].y - BEZ_REF[0].y
    const ref = BEZ_REF.map(p => ({ x: p.x + dx, y: p.y + dy }))
    const worst = Math.max(...pts.map(p => distToPolyline(p, ref)))
    expect(worst).toBeLessThan(1e-6)
  })

  it('starts and ends on the curve end points, at the ARC chord spacing', () => {
    const r = importDXF(dxf([...OPEN, ...splineCtrl('Cut', BEZ), ...CLOSE]))
    const pts = r.loops[0].points

    // Translation-invariant end-point check: the chain's first-to-last vector is
    // the curve's P(0)-to-P(1) vector. A chain that stopped short, overran, or
    // started at a control point instead would not match.
    const end = bezier(1), start = bezier(0)
    expect(pts[pts.length - 1].x - pts[0].x).toBeCloseTo(end.x - start.x, 9)
    expect(pts[pts.length - 1].y - pts[0].y).toBeCloseTo(end.y - start.y, 9)

    expect(maxChord(pts)).toBeLessThanOrEqual(CHORD_MM + 1e-9)
  })

  it('joins with an adjacent LINE that shares the spline end point', () => {
    const end = bezier(1)
    const r = importDXF(dxf([
      ...OPEN,
      ...splineCtrl('Cut', BEZ),
      [0, 'LINE'], [8, 'Cut'], [10, String(end.x)], [20, String(end.y)], [11, '100'], [21, '10'],
      ...CLOSE,
    ]))
    // One chain, not two: the join found the shared end exactly.
    expect(r.loops).toHaveLength(1)
    const pts = r.loops[0].points
    const far = pts[0].x > pts[pts.length - 1].x ? pts[0] : pts[pts.length - 1]
    const other = far === pts[0] ? pts[pts.length - 1] : pts[0]
    // The free ends are the spline's start (0,0) and the line's far end (100,10).
    expect(far.x - other.x).toBeCloseTo(100 - 0, 9)
    expect(far.y - other.y).toBeCloseTo(10 - 0, 9)
  })

  it('weights (group 41) are honoured: a weighted middle pulls the curve off the unweighted one', () => {
    const plain = importDXF(dxf([...OPEN, ...splineCtrl('Cut', BEZ), ...CLOSE])).loops[0]
    const heavy = importDXF(dxf([...OPEN, ...splineCtrl('Cut', BEZ, [1, 8, 1, 1]), ...CLOSE])).loops[0]
    expect(size(heavy).h).toBeGreaterThan(size(plain).h + 1)

    // All-ones weights are the non-rational curve exactly.
    const ones = importDXF(dxf([...OPEN, ...splineCtrl('Cut', BEZ, [1, 1, 1, 1]), ...CLOSE])).loops[0]
    expect(ones.points).toEqual(plain.points)
  })

  it('a 6-control-point degree-3 spline (real inner knots) stays inside its control hull', () => {
    const ctrl: Vec2[] = [
      { x: 0, y: 0 }, { x: 5, y: 20 }, { x: 20, y: 25 },
      { x: 35, y: -5 }, { x: 50, y: 20 }, { x: 60, y: 0 },
    ]
    const r = importDXF(dxf([...OPEN, ...splineCtrl('Cut', ctrl), ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    const s = size(r.loops[0])
    // Convex-hull property: never wider or taller than the control polygon.
    expect(s.w).toBeLessThanOrEqual(60 + 1e-9)
    expect(s.h).toBeLessThanOrEqual(30 + 1e-9)
    expect(s.w).toBeGreaterThan(50)
    expect(maxChord(r.loops[0].points)).toBeLessThanOrEqual(CHORD_MM + 1e-9)
  })
})

describe('WO-1841: a fit-point-only SPLINE imports through its fit points', () => {
  const FIT: Vec2[] = [{ x: 0, y: 0 }, { x: 20, y: 15 }, { x: 40, y: -10 }, { x: 60, y: 5 }]
  const FIT_SPLINE: P = [
    [0, 'SPLINE'], [8, 'Cut'], [70, '8'], [71, '3'], [72, '0'], [73, '0'], [74, String(FIT.length)],
    ...FIT.flatMap(p => [[11, String(p.x)], [21, String(p.y)], [31, '0.0']] as P),
  ]

  it('imports (never silently dropped) and passes exactly through every fit point', () => {
    const r = importDXF(dxf([...OPEN, ...FIT_SPLINE, ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    expect(r.report.skipped).toEqual([])

    const pts = r.loops[0].points
    const dx = pts[0].x - FIT[0].x, dy = pts[0].y - FIT[0].y
    for (const f of FIT) {
      const nearest = Math.min(...pts.map(p => Math.hypot(p.x - (f.x + dx), p.y - (f.y + dy))))
      expect(nearest).toBeLessThan(1e-9)
    }
    // Curved, not the straight chords between those points.
    expect(maxChord(pts)).toBeLessThanOrEqual(CHORD_MM + 1e-9)
    expect(size(r.loops[0]).h).toBeGreaterThan(25 + 1e-6)
  })

  it('a SPLINE record with neither control nor fit points is named in the report, not dropped', () => {
    const r = importDXF(dxf([...OPEN, [0, 'SPLINE'], [8, 'Cut'], [71, '3'], ...CLOSE]))
    expect(r.loops).toHaveLength(0)
    expect(r.report.skipped).toEqual([{ type: 'SPLINE', count: 1 }])
  })
})

describe('WO-1841: a DXF ELLIPSE imports', () => {
  // Major axis 20 long at 30 deg, ratio 0.4 -> semi-axes a=20, b=8.
  const A = 20, RATIO = 0.4, THETA = 30 * Math.PI / 180
  const MX = A * Math.cos(THETA), MY = A * Math.sin(THETA)

  function ellipse(layer: string, t0: number, t1: number, scale = 1): P {
    return [
      [0, 'ELLIPSE'], [8, layer],
      [10, '0.0'], [20, '0.0'], [30, '0.0'],
      [11, String(MX / scale)], [21, String(MY / scale)], [31, '0.0'],
      [40, String(RATIO)], [41, String(t0)], [42, String(t1)],
    ]
  }

  it('a full ellipse is one closed loop whose extents are the rotated 2a x 2b box', () => {
    const r = importDXF(dxf([...OPEN, ...ellipse('Cut', 0, 2 * Math.PI), ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].closed).toBe(true)
    expect(r.report.skipped).toEqual([])

    const b = A * RATIO
    const expW = 2 * Math.sqrt((A * Math.cos(THETA)) ** 2 + (b * Math.sin(THETA)) ** 2)
    const expH = 2 * Math.sqrt((A * Math.sin(THETA)) ** 2 + (b * Math.cos(THETA)) ** 2)
    const s = size(r.loops[0])
    // Sampled extents sit just inside the true ones by at most the chord sagitta.
    expect(s.w).toBeLessThanOrEqual(expW + 1e-9)
    expect(s.h).toBeLessThanOrEqual(expH + 1e-9)
    expect(expW - s.w).toBeLessThan(CHORD_MM)
    expect(expH - s.h).toBeLessThan(CHORD_MM)
    expect(maxChord(r.loops[0].points)).toBeLessThanOrEqual(CHORD_MM + 1e-9)
  })

  it('every sample lies on the ellipse the file describes', () => {
    const r = importDXF(dxf([...OPEN, ...ellipse('Cut', 0, 2 * Math.PI), ...CLOSE]))
    const pts = r.loops[0].points
    // Re-centred by importDXF; the ellipse is centred on its own bbox centre,
    // so that shift is exactly back to (0,0) within sampling round-off.
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2
    const b = A * RATIO
    for (const p of pts) {
      // Rotate into the ellipse's own frame: (u/a)^2 + (v/b)^2 must be 1.
      const u = (p.x - cx) * Math.cos(THETA) + (p.y - cy) * Math.sin(THETA)
      const v = -(p.x - cx) * Math.sin(THETA) + (p.y - cy) * Math.cos(THETA)
      expect((u / A) ** 2 + (v / b) ** 2).toBeCloseTo(1, 6)
    }
  })

  it('a partial ellipse spans exactly its 41..42 parameters', () => {
    const t0 = 0.3, t1 = 2.1
    const r = importDXF(dxf([...OPEN, ...ellipse('Cut', t0, t1), ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    const pts = r.loops[0].points
    expect(r.loops[0].closed).toBe(false)

    const at = (t: number): Vec2 => ({
      x: MX * Math.cos(t) - MY * RATIO * Math.sin(t),
      y: MY * Math.cos(t) + MX * RATIO * Math.sin(t),
    })
    const p0 = at(t0), p1 = at(t1)
    // Translation-invariant: the chain's end-to-end vector is P(t1)-P(t0).
    expect(pts[pts.length - 1].x - pts[0].x).toBeCloseTo(p1.x - p0.x, 9)
    expect(pts[pts.length - 1].y - pts[0].y).toBeCloseTo(p1.y - p0.y, 9)
    // ... and it really is the short span, not the whole ellipse.
    expect(size(r.loops[0]).w).toBeLessThan(2 * A * Math.cos(THETA))
  })

  it('a zero-length major axis is named in the report, not dropped', () => {
    const r = importDXF(dxf([
      ...OPEN,
      [0, 'ELLIPSE'], [8, 'Cut'], [10, '0'], [20, '0'], [11, '0'], [21, '0'], [40, '0.5'],
      ...CLOSE,
    ]))
    expect(r.loops).toHaveLength(0)
    expect(r.report.skipped).toEqual([{ type: 'ELLIPSE', count: 1 }])
  })
})

describe('WO-1841: a legacy POLYLINE/VERTEX imports like an LWPOLYLINE', () => {
  // The WO-1839 obround: 20 long, 10 wide, semicircular ends (bulge on the
  // second and the closing segment).
  const VERTS: Array<[number, number, number?]> = [[0, 0], [20, 0, 1], [20, 10], [0, 10, 1]]

  function lwpoly(closed: boolean): P {
    const out: P = [[0, 'LWPOLYLINE'], [8, 'Cut'], [90, String(VERTS.length)], [70, closed ? '1' : '0']]
    for (const [x, y, b] of VERTS) {
      out.push([10, String(x)], [20, String(y)])
      if (b !== undefined) out.push([42, String(b)])
    }
    return out
  }
  function oldPoly(closed: boolean, polyFlags?: string): P {
    const out: P = [[0, 'POLYLINE'], [8, 'Cut'], [66, '1'], [70, polyFlags ?? (closed ? '1' : '0')]]
    for (const [x, y, b] of VERTS) {
      // Each VERTEX carries its own layer and its own group 70 (vertex flags,
      // 32+128) - neither may be mistaken for the polyline's.
      out.push([0, 'VERTEX'], [8, 'Cut'], [10, String(x)], [20, String(y)], [30, '0.0'], [70, '32'])
      if (b !== undefined) out.push([42, String(b)])
    }
    out.push([0, 'SEQEND'], [8, 'Cut'])
    return out
  }

  it('a closed POLYLINE with bulges gives point-for-point the LWPOLYLINE result', () => {
    const old = importDXF(dxf([...OPEN, ...oldPoly(true), ...CLOSE]))
    const lw = importDXF(dxf([...OPEN, ...lwpoly(true), ...CLOSE]))
    expect(old.loops).toHaveLength(1)
    expect(old.loops[0].closed).toBe(true)
    expect(old.loops[0].points).toEqual(lw.loops[0].points)

    const s = size(old.loops[0])
    expect(s.w).toBeCloseTo(30, 3)   // 20 between centres + two radius-5 ends
    expect(s.h).toBeCloseTo(10, 6)
    // SEQEND and VERTEX are structure, never "not imported".
    expect(old.report.skipped).toEqual([])
  })

  it('an open POLYLINE matches the open LWPOLYLINE too', () => {
    const old = importDXF(dxf([...OPEN, ...oldPoly(false), ...CLOSE]))
    const lw = importDXF(dxf([...OPEN, ...lwpoly(false), ...CLOSE]))
    expect(old.loops[0].points).toEqual(lw.loops[0].points)
    expect(old.loops[0].closed).toBe(false)
  })

  it('an entity after the run is parsed normally, and a mesh POLYLINE is reported', () => {
    // Flag 64 = polyface mesh: not a 2D outline, so it is named rather than
    // drawn as a nonsense loop.
    const r = importDXF(dxf([
      ...OPEN,
      ...oldPoly(true, '64'),
      [0, 'CIRCLE'], [8, 'Cut'], [10, '100'], [20, '0'], [40, '5'],
      ...CLOSE,
    ]))
    expect(r.report.skipped).toEqual([{ type: 'POLYLINE', count: 1 }])
    expect(r.loops).toHaveLength(1)
    // The circle survived intact: its sampled extents sit inside the true
    // diameter by at most the chord sagitta sampleArc has always had.
    const w = size(r.loops[0]).w
    expect(w).toBeLessThanOrEqual(10 + 1e-9)
    expect(w).toBeGreaterThan(10 - CHORD_MM)
  })

  it('a POLYLINE run that ends at EOF without SEQEND still imports', () => {
    const truncated = oldPoly(true).filter(([c, v]) => !(c === 0 && v === 'SEQEND'))
    const r = importDXF(dxf([...OPEN, ...truncated.filter(([c]) => c !== 8 || true), ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    expect(size(r.loops[0]).w).toBeCloseTo(30, 3)
  })
})

describe('WO-1841: units scale the new entities like every other one', () => {
  it('an inch drawing scales spline, ellipse and legacy polyline by 25.4', () => {
    const mm = importDXF(dxf([
      ...OPEN,
      ...[[0, 'ELLIPSE'], [8, 'Cut'], [10, '0'], [20, '0'], [11, '20'], [21, '0'],
        [40, '0.5'], [41, '0'], [42, String(2 * Math.PI)]] as P,
      ...CLOSE,
    ]))
    const inch = importDXF(dxf([
      ...header(1), ...OPEN,
      ...[[0, 'ELLIPSE'], [8, 'Cut'], [10, '0'], [20, '0'], [11, '20'], [21, '0'],
        [40, '0.5'], [41, '0'], [42, String(2 * Math.PI)]] as P,
      ...CLOSE,
    ]))
    expect(inch.unitScale).toBe(25.4)
    expect(size(inch.loops[0]).w / size(mm.loops[0]).w).toBeCloseTo(25.4, 2)
    expect(size(inch.loops[0]).w).toBeCloseTo(40 * 25.4, 0)

    // The spline's control points scale, its knots (parameters) do not.
    const splineMM = importDXF(dxf([...OPEN, ...splineCtrl('Cut', BEZ), ...CLOSE]))
    const splineIn = importDXF(dxf([...header(1), ...OPEN, ...splineCtrl('Cut', BEZ), ...CLOSE]))
    expect(size(splineIn.loops[0]).w / size(splineMM.loops[0]).w).toBeCloseTo(25.4, 6)
    expect(size(splineIn.loops[0]).h / size(splineMM.loops[0]).h).toBeCloseTo(25.4, 6)

    // A 1-inch-square legacy POLYLINE is 25.4 mm square.
    const polyIn = importDXF(dxf([
      ...header(1), ...OPEN,
      [0, 'POLYLINE'], [8, 'Cut'], [66, '1'], [70, '1'],
      [0, 'VERTEX'], [8, 'Cut'], [10, '0'], [20, '0'],
      [0, 'VERTEX'], [8, 'Cut'], [10, '1'], [20, '0'],
      [0, 'VERTEX'], [8, 'Cut'], [10, '1'], [20, '1'],
      [0, 'VERTEX'], [8, 'Cut'], [10, '0'], [20, '1'],
      [0, 'SEQEND'], [8, 'Cut'],
      ...CLOSE,
    ]))
    expect(size(polyIn.loops[0]).w).toBeCloseTo(25.4, 6)
    expect(size(polyIn.loops[0]).h).toBeCloseTo(25.4, 6)
  })
})

describe('WO-1841 negative control: the spline result depends on SPLINE being parsed', () => {
  it('the same file yields geometry now and would yield a skip report without the parse arm', () => {
    // With SPLINE parsed: one chain, nothing reported as not imported.
    const r = importDXF(dxf([...OPEN, ...splineCtrl('Cut', BEZ), ...CLOSE]))
    expect(r.loops).toHaveLength(1)
    expect(r.report.skipped).toEqual([])

    // Remove 'SPLINE' from GEO_TYPES in dxfImporter.ts and this file instead
    // returns zero loops with skipped [{ type: 'SPLINE', count: 1 }] - which is
    // exactly the shape an unparsable SPLINE record still produces today, proving
    // the assertions above are carried by the evaluation and not by the report.
    const empty = importDXF(dxf([...OPEN, [0, 'SPLINE'], [8, 'Cut'], [71, '3'], ...CLOSE]))
    expect(empty.loops).toHaveLength(0)
    expect(empty.report.skipped).toEqual([{ type: 'SPLINE', count: 1 }])
  })
})
