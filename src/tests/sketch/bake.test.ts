// bake.ts — Sketch -> Loop2D (Stage 5). Headless, pure-function tests.
//
// Pins the bake boundary contract (PLAN 3.1): chaining via constraint graph
// AND geometric coincidence, closed/open detection, arc fidelity
// (center/radius/winding round-trip through LoopSegment), contour/hole
// typing by nesting, winding normalization (CCW = contour, CW = hole),
// construction/point exclusion, DXF-matching arc densification.

import { describe, it, expect } from 'vitest'
import { bakeSketch, chainContaining } from '../../lib/sketch/bake'
import { tessellateEllipticalArc, ellipsePointAt, type EllipseShape } from '../../lib/sketch/ellipse'
import { extractSketchProfile } from '../../components/model3d/workbench/sketchProfile'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import type {
  Sketch, SketchEntity, SketchConstraint,
} from '../../lib/sketch/types'
import type { Vec2 } from '../../types'

const LAYER = 'layer-under-test'

function sketchOf(entities: SketchEntity[], constraints: SketchConstraint[] = []): Sketch {
  return {
    id: 'sk', layerId: LAYER, entities, constraints, dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

function line(id: string, start: Vec2, end: Vec2, construction = false): SketchEntity {
  return { id, kind: 'line', construction, start, end }
}

function signedArea(pts: Vec2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return a / 2
}

const coincident = (
  id: string, aId: string, aSite: 'start' | 'end', bId: string, bSite: 'start' | 'end',
): SketchConstraint => ({
  id, kind: 'coincident',
  a: { entityId: aId, site: aSite }, b: { entityId: bId, site: bSite },
})

// Rectangle as four independent lines with coincident corners (the standard editor
// entity model the line/rect tools produce).
function rectangle(): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  const entities = [
    line('b', { x: 0, y: 0 }, { x: 60, y: 0 }),
    line('r', { x: 60, y: 0 }, { x: 60, y: 40 }),
    line('t', { x: 60, y: 40 }, { x: 0, y: 40 }),
    line('l', { x: 0, y: 40 }, { x: 0, y: 0 }),
  ]
  const constraints = [
    coincident('c1', 'b', 'end', 'r', 'start'),
    coincident('c2', 'r', 'end', 't', 'start'),
    coincident('c3', 't', 'end', 'l', 'start'),
    coincident('c4', 'l', 'end', 'b', 'start'),
  ]
  return { entities, constraints }
}

describe('bakeSketch: chaining and closure', () => {
  it('rectangle chain -> 1 closed contour with 4 line segments', () => {
    const { entities, constraints } = rectangle()
    const r = bakeSketch(sketchOf(entities, constraints))
    expect(r.loops).toHaveLength(1)
    const loop = r.loops[0]
    expect(loop.closed).toBe(true)
    expect(loop.type).toBe('contour')
    expect(loop.layerId).toBe(LAYER)
    expect(loop.area).toBeCloseTo(2400, 6)
    expect(loop.segments).toHaveLength(4)
    expect(loop.segments!.every((s) => s.type === 'line')).toBe(true)
    // Closed loops include the closing segment, back onto points[0].
    const last = loop.segments![loop.segments!.length - 1]
    expect(last.to).toEqual(loop.points[0])
    // Contour winding is CCW (repo convention, path2d).
    expect(signedArea(loop.points)).toBeGreaterThan(0)
    // No duplicate of the first point at the end (closed-loop convention).
    expect(loop.points[loop.points.length - 1]).not.toEqual(loop.points[0])
  })

  it('chains by geometric coincidence within epsilon when unconstrained', () => {
    // Same rectangle, endpoints nudged 0.02 mm (< 0.05 join tol), NO constraints.
    const entities = [
      line('b', { x: 0, y: 0 }, { x: 60, y: 0.02 }),
      line('r', { x: 60, y: 0 }, { x: 60.02, y: 40 }),
      line('t', { x: 60, y: 40 }, { x: 0, y: 40.02 }),
      line('l', { x: 0, y: 40 }, { x: 0.02, y: 0 }),
    ]
    const r = bakeSketch(sketchOf(entities))
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].closed).toBe(true)
    expect(r.loops[0].type).toBe('contour')
  })

  it('chains by the constraint graph even when geometry sits apart', () => {
    // Two lines whose join is 1 mm apart (way past epsilon) but bound by a
    // coincident constraint — connectivity follows the CONSTRAINT graph.
    const entities = [
      line('a', { x: 0, y: 0 }, { x: 10, y: 0 }),
      line('b', { x: 11, y: 0 }, { x: 20, y: 0 }),
    ]
    const r = bakeSketch(sketchOf(entities, [coincident('c', 'a', 'end', 'b', 'start')]))
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].type).toBe('open')
    expect(r.loops[0].segments).toHaveLength(2)
  })

  it('open chain -> type open, area 0, no closure', () => {
    const entities = [
      line('a', { x: 0, y: 0 }, { x: 10, y: 0 }),
      line('b', { x: 10, y: 0 }, { x: 10, y: 10 }),
    ]
    const r = bakeSketch(sketchOf(entities))
    expect(r.loops).toHaveLength(1)
    const loop = r.loops[0]
    expect(loop.closed).toBe(false)
    expect(loop.type).toBe('open')
    expect(loop.area).toBe(0)
    expect(loop.segments).toHaveLength(2)
    expect(loop.points[0]).toEqual({ x: 0, y: 0 })
    expect(loop.points[loop.points.length - 1]).toEqual({ x: 10, y: 10 })
  })

  it('two disjoint chains bake to two loops', () => {
    const entities = [
      line('a', { x: 0, y: 0 }, { x: 10, y: 0 }),
      line('b', { x: 50, y: 50 }, { x: 60, y: 50 }),
    ]
    const r = bakeSketch(sketchOf(entities))
    expect(r.loops).toHaveLength(2)
    expect(r.loops.every((l) => l.type === 'open')).toBe(true)
  })
})

describe('bakeSketch: circles and arcs', () => {
  it('standalone circle -> closed loop, single full-circle arc segment', () => {
    const r = bakeSketch(sketchOf([
      { id: 'c', kind: 'circle', construction: false, center: { x: 5, y: -3 }, radius: 10 },
    ]))
    expect(r.loops).toHaveLength(1)
    const loop = r.loops[0]
    expect(loop.closed).toBe(true)
    expect(loop.type).toBe('contour')
    expect(loop.area).toBeCloseTo(Math.PI * 100, 0)
    expect(loop.segments).toHaveLength(1)
    const seg = loop.segments![0]
    expect(seg.type).toBe('arc')
    if (seg.type === 'arc') {
      expect(seg.center).toEqual({ x: 5, y: -3 })
      expect(seg.radius).toBe(10)
      expect(seg.clockwise).toBe(false) // contour = CCW
      expect(seg.to).toEqual(loop.points[0])
    }
    // Densified like DXF import (0.5 mm steps): every point on the circle.
    for (const p of loop.points) {
      expect(Math.hypot(p.x - 5, p.y + 3)).toBeCloseTo(10, 6)
    }
    expect(loop.points.length).toBeGreaterThan(100)
  })

  it('arc fidelity: center/radius/winding round-trip through the chain', () => {
    // Half-disc: bottom line (0,0)->(10,0) plus CCW top arc (10,0)->(0,0)
    // (center (5,0), r 5, startAngle 0, endAngle pi).
    const entities: SketchEntity[] = [
      line('base', { x: 0, y: 0 }, { x: 10, y: 0 }),
      { id: 'arc', kind: 'arc', construction: false,
        center: { x: 5, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI },
    ]
    const r = bakeSketch(sketchOf(entities))
    expect(r.loops).toHaveLength(1)
    const loop = r.loops[0]
    expect(loop.closed).toBe(true)
    expect(loop.type).toBe('contour')
    // Polygonized at 0.5 mm chords — area is slightly under the analytic value.
    expect(loop.area).toBeCloseTo(Math.PI * 12.5, 0)
    expect(signedArea(loop.points)).toBeGreaterThan(0) // CCW
    const arcSeg = loop.segments!.find((s) => s.type === 'arc')
    expect(arcSeg).toBeDefined()
    if (arcSeg && arcSeg.type === 'arc') {
      expect(arcSeg.center.x).toBeCloseTo(5, 9)
      expect(arcSeg.center.y).toBeCloseTo(0, 9)
      expect(arcSeg.radius).toBe(5)
      // In CCW orientation the stored-CCW arc is traversed FORWARD.
      expect(arcSeg.clockwise).toBe(false)
    }
  })

  it('arc traversed backward gets clockwise=true (hole winding)', () => {
    // Same half-disc nested INSIDE a big rectangle -> typed hole -> CW
    // orientation -> the CCW-stored arc must come out clockwise.
    const { entities: rectE, constraints } = rectangle()
    const entities: SketchEntity[] = [
      ...rectE,
      line('base', { x: 10, y: 10 }, { x: 20, y: 10 }),
      { id: 'arc', kind: 'arc', construction: false,
        center: { x: 15, y: 10 }, radius: 5, startAngle: 0, endAngle: Math.PI },
    ]
    const r = bakeSketch(sketchOf(entities, constraints))
    expect(r.loops).toHaveLength(2)
    const inner = r.loops.find((l) => l.type === 'hole')!
    expect(inner).toBeDefined()
    expect(signedArea(inner.points)).toBeLessThan(0) // CW
    const arcSeg = inner.segments!.find((s) => s.type === 'arc')!
    expect(arcSeg.type).toBe('arc')
    if (arcSeg.type === 'arc') {
      expect(arcSeg.clockwise).toBe(true)
      expect(arcSeg.radius).toBe(5)
      expect(arcSeg.center.x).toBeCloseTo(15, 9)
      expect(arcSeg.center.y).toBeCloseTo(10, 9)
    }
  })
})

describe('bakeSketch: nesting and typing', () => {
  it('nested loops: inner circle becomes a hole, outer stays contour', () => {
    const { entities, constraints } = rectangle()
    const r = bakeSketch(sketchOf([
      ...entities,
      { id: 'c', kind: 'circle', construction: false, center: { x: 30, y: 20 }, radius: 8 },
    ], constraints))
    expect(r.loops).toHaveLength(2)
    const outer = r.loops.find((l) => l.area > 1000)!
    const inner = r.loops.find((l) => l.area < 1000)!
    expect(outer.type).toBe('contour')
    expect(inner.type).toBe('hole')
    expect(signedArea(outer.points)).toBeGreaterThan(0) // contour CCW
    expect(signedArea(inner.points)).toBeLessThan(0)    // hole CW
    if (inner.segments![0].type === 'arc') {
      expect(inner.segments![0].clockwise).toBe(true)
    }
  })

  it('island-in-hole (depth 2) types back to contour', () => {
    const r = bakeSketch(sketchOf([
      { id: 'o', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 30 },
      { id: 'm', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 20 },
      { id: 'i', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 10 },
    ]))
    const byArea = [...r.loops].sort((a, b) => b.area - a.area)
    expect(byArea.map((l) => l.type)).toEqual(['contour', 'hole', 'contour'])
  })
})

describe('bakeSketch: exclusions', () => {
  it('construction entities and bare points never bake', () => {
    const { entities, constraints } = rectangle()
    const r = bakeSketch(sketchOf([
      ...entities,
      line('cx', { x: -5, y: -5 }, { x: 70, y: 50 }, true), // construction
      { id: 'p', kind: 'point', construction: false, at: { x: 30, y: 20 } },
    ], constraints))
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].type).toBe('contour')
    expect(r.excludedEntities).toBe(2)
    expect(r.bakedEntities).toBe(4)
  })

  it('an all-construction sketch bakes zero loops', () => {
    const r = bakeSketch(sketchOf([
      line('a', { x: 0, y: 0 }, { x: 10, y: 0 }, true),
      line('b', { x: 10, y: 0 }, { x: 10, y: 10 }, true),
    ]))
    expect(r.loops).toHaveLength(0)
    expect(r.bakedEntities).toBe(0)
    expect(r.excludedEntities).toBe(2)
  })
})

// ── SKC-48: partial-ellipse chaining (Part-Studio parity) ─────────────────────
// extractChains now expands each elliptical arc into synthetic line Edges from the
// SHARED tessellateEllipticalArc sampler and threads them through the same UnionFind
// + walk chainer, so a partial ellipse chains with adjacent lines/arcs into ONE
// closed loop — exactly as the Part-Studio sketchProfile side already does. This is
// the chaining harness's FIRST ellipse coverage (it had zero before).
const EA = 20, EB = 10
function ellipsePt(t: number): Vec2 { return { x: EA * Math.cos(t), y: EB * Math.sin(t) } }
function ellipticalArc(
  id: string, startParam: number, endParam: number,
  center: Vec2 = { x: 0, y: 0 }, a = EA, b = EB, construction = false,
): SketchEntity {
  return { id, kind: 'elliptical-arc', construction, center, majorRadius: a, minorRadius: b, rotation: 0, startParam, endParam }
}

/** A real circular-arc entity whose start/end land EXACTLY on p0/p1 (center =
 *  their midpoint, radius = half their distance, so the CCW sweep between the
 *  two computed angles is always exactly pi — a genuine semicircle, not a
 *  synthetic tessellation). Used to close a chain with a real arc segment
 *  through two arbitrary, non-axis-aligned points. */
function semicircleArc(id: string, p0: Vec2, p1: Vec2): SketchEntity {
  const center = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
  const radius = Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2
  const startAngle = Math.atan2(p0.y - center.y, p0.x - center.x)
  const endAngle = Math.atan2(p1.y - center.y, p1.x - center.x)
  return { id, kind: 'arc', construction: false, center, radius, startAngle, endAngle }
}

/** True iff `run` equals `ref` point-for-point in EITHER direction (open runs
 *  start at an endpoint, so only traversal direction needs normalizing). */
function matchUpToDirection(run: Vec2[], ref: Vec2[], tol = 1e-6): boolean {
  if (run.length !== ref.length) return false
  const eq = (a: Vec2[], b: Vec2[]) => a.every((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) <= tol)
  return eq(run, ref) || eq([...run].reverse(), ref)
}

describe('bakeSketch: elliptical-arc chaining (SKC-48)', () => {
  it('D-shape (epsilon coincidence): arc + coincident chord -> ONE closed contour, CCW winding', () => {
    const start = ellipsePt(0)         // (20,0)
    const end = ellipsePt(Math.PI)     // (-20,0)
    const r = bakeSketch(sketchOf([
      ellipticalArc('ea', 0, Math.PI),
      line('chord', end, start),       // endpoints coincide with the arc's true endpoints
    ]))
    expect(r.loops).toHaveLength(1)
    const loop = r.loops[0]
    expect(loop.closed).toBe(true)
    expect(loop.type).toBe('contour')
    expect(signedArea(loop.points)).toBeGreaterThan(0)      // CCW = contour
    // Half-ellipse area ~ pi*a*b/2 (polygonal, slightly under the analytic value).
    expect(loop.area).toBeCloseTo((Math.PI * EA * EB) / 2, 0)
    // The arc counts as ONE baked entity, the chord as one — never its ~162 segments.
    expect(r.bakedEntities).toBe(2)
  })

  it('D-shape nested in a rectangle types to a HOLE -> CW winding (backward-arc case, mirrors the arc test)', () => {
    const { entities: rectE, constraints } = rectangle()   // 60x40 rectangle
    const c = { x: 30, y: 20 }
    const aa = 12, bb = 6
    const startP = { x: c.x + aa, y: c.y }    // (42,20)
    const endP = { x: c.x - aa, y: c.y }      // (18,20)
    const r = bakeSketch(sketchOf([
      ...rectE,
      ellipticalArc('ea', 0, Math.PI, c, aa, bb),
      line('chord', endP, startP),
    ], constraints))
    expect(r.loops).toHaveLength(2)
    const inner = r.loops.find((l) => l.type === 'hole')
    expect(inner).toBeDefined()
    expect(inner!.closed).toBe(true)
    expect(signedArea(inner!.points)).toBeLessThan(0)       // CW = hole (backward arc)
  })

  it('constraint-graph D-shape (chord > epsilon from the arc, joined ONLY by coincident constraints) ' +
     'closes; the same geometry WITHOUT the constraints stays open (non-vacuous)', () => {
    const arc = ellipticalArc('ea', 0, Math.PI)                  // endpoints (20,0),(-20,0)
    const chord = line('chord', { x: -20, y: 1 }, { x: 20, y: 1 }) // 1 mm gap (> epsilon 0.05)
    const cons = [
      coincident('k1', 'chord', 'start', 'ea', 'end'),   // (-20,1) <-> arc end (-20,0)
      coincident('k2', 'chord', 'end', 'ea', 'start'),   // (20,1)  <-> arc start (20,0)
    ]
    const closed = bakeSketch(sketchOf([arc, chord], cons))
    expect(closed.loops).toHaveLength(1)
    expect(closed.loops[0].closed).toBe(true)
    // Non-vacuity: strip the constraints and the 1 mm gap leaves it OPEN — only the constraint
    // graph (not epsilon geometry) could ever have bridged it.
    const open = bakeSketch(sketchOf([arc, chord]))
    expect(open.loops.every((l) => l.closed === false)).toBe(true)
  })

  it('a LONE elliptical arc still bakes OPEN (chaining fabricates no closure)', () => {
    const r = bakeSketch(sketchOf([ellipticalArc('ea', 0, Math.PI)]))
    expect(r.loops).toHaveLength(1)
    const loop = r.loops[0]
    expect(loop.closed).toBe(false)
    expect(loop.type).toBe('open')
    expect(loop.segments!.every((s) => s.type === 'line')).toBe(true)
    expect(loop.points.length).toBe(163)
    expect(r.bakedEntities).toBe(1)
  })

  it('an arc chained to a line that does NOT reach back stays OPEN (open polyline)', () => {
    const arc = ellipticalArc('ea', 0, Math.PI)                  // (20,0)..(-20,0)
    const tail = line('tail', { x: -20, y: 0 }, { x: -40, y: 0 }) // off the end, heads away
    const r = bakeSketch(sketchOf([arc, tail]))
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].closed).toBe(false)
    expect(r.loops[0].type).toBe('open')
  })

  it('mixed chain: elliptical arc + circular arc + lines close into ONE loop', () => {
    const arc = ellipticalArc('ea', 0, Math.PI)                  // top: (20,0)->(-20,0)
    const left = line('left', { x: -20, y: 0 }, { x: -20, y: -5 })
    const circ: SketchEntity = {
      id: 'carc', kind: 'arc', construction: false,
      center: { x: 0, y: -5 }, radius: 20, startAngle: Math.PI, endAngle: 2 * Math.PI,
    }                                                             // bottom: (-20,-5)->(20,-5), bulging down
    const right = line('right', { x: 20, y: -5 }, { x: 20, y: 0 })
    const r = bakeSketch(sketchOf([arc, left, circ, right]))
    expect(r.loops).toHaveLength(1)
    const loop = r.loops[0]
    expect(loop.closed).toBe(true)
    // BOTH an ellipse-derived line run AND a genuine circular-arc segment survive in one loop.
    expect(loop.segments!.some((s) => s.type === 'arc')).toBe(true)
    expect(loop.segments!.some((s) => s.type === 'line')).toBe(true)
    expect(r.bakedEntities).toBe(4)
  })

  it('two disjoint D-shapes bake to two independent closed loops', () => {
    const s1 = ellipsePt(0), e1 = ellipsePt(Math.PI)
    const c2 = { x: 100, y: 0 }
    const r = bakeSketch(sketchOf([
      ellipticalArc('ea1', 0, Math.PI),
      line('ch1', e1, s1),
      ellipticalArc('ea2', 0, Math.PI, c2),
      line('ch2', { x: c2.x - EA, y: 0 }, { x: c2.x + EA, y: 0 }),
    ]))
    expect(r.loops).toHaveLength(2)
    expect(r.loops.every((l) => l.closed && l.type === 'contour')).toBe(true)
    expect(r.bakedEntities).toBe(4)
  })

  it('NO mid-arc weld: a stray line within epsilon of an INTERIOR arc vertex does not weld into the chain', () => {
    const start = ellipsePt(0), end = ellipsePt(Math.PI)
    const arcPts = tessellateEllipticalArc({ center: { x: 0, y: 0 }, majorRadius: EA, minorRadius: EB, rotation: 0 }, 0, Math.PI)
    const mid = arcPts[Math.floor(arcPts.length / 2)]      // an INTERIOR tessellation vertex
    // Non-vacuity: the stray endpoint truly sits ON an interior vertex (well within epsilon 0.05)...
    expect(Math.hypot(mid.x - start.x, mid.y - start.y)).toBeGreaterThan(0.05)
    expect(Math.hypot(mid.x - end.x, mid.y - end.y)).toBeGreaterThan(0.05)
    const stray = line('stray', { x: mid.x, y: mid.y }, { x: mid.x, y: mid.y + 20 })
    const r = bakeSketch(sketchOf([
      ellipticalArc('ea', 0, Math.PI),
      line('chord', end, start),
      stray,
    ]))
    // ...yet it does NOT weld: the D-shape still closes, and the stray stays its own OPEN loop.
    const closed = r.loops.filter((l) => l.closed)
    const openLoops = r.loops.filter((l) => !l.closed)
    expect(closed).toHaveLength(1)
    expect(openLoops).toHaveLength(1)
    expect(openLoops[0].segments).toHaveLength(1)          // the lone stray line, unmerged
  })

  it('PARITY: the arc-derived vertex run matches the SHARED sampler on BOTH the CAM bake AND the ' +
     'Part-Studio profile (output-level, each vs one direct tessellateEllipticalArc call)', async () => {
    const shape = { center: { x: 0, y: 0 }, majorRadius: EA, minorRadius: EB, rotation: 0 }
    const T = tessellateEllipticalArc(shape, 0, Math.PI)   // the ONE reference run (163 points)

    // CAM-bake OUTPUT: a lone arc's open-loop points ARE purely the arc's emitted vertices.
    const bakeRun = bakeSketch(sketchOf([ellipticalArc('ea', 0, Math.PI)])).loops[0].points
    expect(matchUpToDirection(bakeRun, T)).toBe(true)

    // Part-Studio profile OUTPUT: the 'ea'-tagged segment endpoints of the D-shape ProfileRegion.
    const start = ellipsePt(0), end = ellipsePt(Math.PI)
    const res = await extractSketchProfile(
      sketchOf([ellipticalArc('ea', 0, Math.PI), line('chord', end, start)]),
      BASE_PLANE_FRAMES.xy, 'SKP',
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const eaSegs = res.profile.loops.flat().filter(
      (s): s is Extract<typeof s, { kind: 'line' }> => s.kind === 'line' && s.srcId === 'ea',
    )
    expect(eaSegs.length).toBe(T.length - 1)               // 162 segments <-> 163 vertices
    const profileRun = [eaSegs[0].a, ...eaSegs.map((s) => s.b)].map(([x, y]) => ({ x, y }))
    expect(matchUpToDirection(profileRun, T)).toBe(true)
  })
})

// ── SKC-48-R1: a lone arc must NEVER weld itself closed (audit BLOCKER fix) ──
// The epsilon-coincidence scan used to key its "same edge" exclusion off
// edgeIdx alone. A real line/arc contributes exactly one edgeIdx, so that
// was sufficient for them — but an expanded elliptical arc contributes MANY
// synthetic edgeIdx values sharing ONE source entity, and only its FIRST and
// LAST synthetic edge carry the arc's two TRUE endpoints (bake.ts's
// `eligible` filter). A short-sweep arc can bring those two true endpoints
// within epsilon of each other; the edgeIdx-only guard let them union and
// fabricated a closed region out of a single open entity. The fix keys the
// guard off the ORIGINAL SOURCE entity id instead.
describe('bakeSketch: a lone arc must never weld itself closed (SKC-48-R1)', () => {
  it('a lone elliptical arc with a SHORT sweep (true endpoints within epsilon of each other) ' +
     'still bakes OPEN — it must not weld its own start to its own end', () => {
    const start = ellipsePt(0)
    const end = ellipsePt(0.003)
    // Non-vacuity: the two TRUE endpoints of this single entity really do sit within the
    // 0.05 mm join tolerance...
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeLessThanOrEqual(0.05)
    const r = bakeSketch(sketchOf([ellipticalArc('ea', 0, 0.003)]))
    // ...yet a lone arc stays OPEN no matter how short its sweep brings its own ends together.
    expect(r.loops).toHaveLength(1)
    const loop = r.loops[0]
    expect(loop.closed).toBe(false)
    expect(loop.type).toBe('open')
    expect(r.bakedEntities).toBe(1)
  })

  it('equal-parameter elliptical arc (startParam === endParam) is rejected as DEGENERATE, matching ' +
     "sketchProfile's zero-sweep rule — never remapped to a full turn", () => {
    // ellipse.ts's ellipticalArcSweep deliberately maps a non-positive raw delta to a FULL 2*pi
    // turn (correct for its own point-sampling callers); bake.ts's own extraction must NOT reuse
    // that remap for a chain-eligibility check, or a zero-sweep arc would silently tessellate as a
    // full closed ellipse. Any equal param pair (not just 0,0) must be excluded.
    const r = bakeSketch(sketchOf([ellipticalArc('ea', 1.7, 1.7)]))
    expect(r.loops).toHaveLength(0)
    expect(r.excludedEntities).toBe(1)
    expect(r.bakedEntities).toBe(0)
  })

  it('rotated seam-wrapping mixed chain: elliptical arc (rotation != 0, param pair wraps the ' +
     '0/2*pi seam) + a real circular arc + lines close into ONE loop, nested as a HOLE so ' +
     'winding normalization runs', () => {
    const { entities: rectE, constraints } = rectangle() // 60x40 rectangle
    const shape: EllipseShape = { center: { x: 30, y: 20 }, majorRadius: 12, minorRadius: 6, rotation: Math.PI / 6 }
    const startParam = (3 * Math.PI) / 2 // 270 deg
    const endParam = Math.PI / 2         // 90 deg — CCW sweep wraps 270 -> 360/0 -> 90 (the seam), sweep = pi exactly
    const arcStart = ellipsePointAt(shape, startParam)
    const arcEnd = ellipsePointAt(shape, endParam)
    const d = 3
    const leftBottom = { x: arcEnd.x, y: arcEnd.y - d }
    const rightBottom = { x: arcStart.x, y: arcStart.y - d }
    const left = line('left', arcEnd, leftBottom)
    const right = line('right', rightBottom, arcStart)
    const circ = semicircleArc('carc', leftBottom, rightBottom)
    const arc: SketchEntity = {
      id: 'ea', kind: 'elliptical-arc', construction: false,
      center: shape.center, majorRadius: shape.majorRadius, minorRadius: shape.minorRadius,
      rotation: shape.rotation, startParam, endParam,
    }
    const r = bakeSketch(sketchOf([...rectE, arc, left, circ, right], constraints))
    expect(r.loops).toHaveLength(2)
    const inner = r.loops.find((l) => l.type === 'hole')
    expect(inner).toBeDefined()
    expect(inner!.closed).toBe(true)
    expect(signedArea(inner!.points)).toBeLessThan(0) // CW = hole -> winding normalization ran
    // The real circular-arc segment survives typing/reversal as an ARC LoopSegment (not
    // flattened to lines), alongside the ellipse-derived line run.
    const arcSeg = inner!.segments!.find((s) => s.type === 'arc')
    expect(arcSeg).toBeDefined()
    if (arcSeg && arcSeg.type === 'arc') {
      expect(arcSeg.radius).toBeCloseTo(
        Math.hypot(rightBottom.x - leftBottom.x, rightBottom.y - leftBottom.y) / 2, 9,
      )
      // Hole direction: the reversed traversal flips the real arc to clockwise.
      expect(arcSeg.clockwise).toBe(true)
    }
    expect(inner!.segments!.some((s) => s.type === 'line')).toBe(true)
    expect(r.bakedEntities).toBe(8) // rect(4) + ea(1) + left(1) + carc(1) + right(1)
  })

  // SKC-48-R1 audit major (merge-gate closure): the SAME rotated seam-wrapping mixed chain
  // must also prove the CONTOUR direction - standalone (no outer rectangle), winding
  // normalization yields CCW with the real circular arc counter-clockwise. Together with the
  // nested case above, both traversal directions of this geometry are pinned.
  it('rotated seam-wrapping mixed chain STANDALONE: closes as a CCW contour with the real ' +
     'circular arc counter-clockwise (direction pair to the nested hole case)', () => {
    const shape: EllipseShape = { center: { x: 30, y: 20 }, majorRadius: 12, minorRadius: 6, rotation: Math.PI / 6 }
    const startParam = (3 * Math.PI) / 2
    const endParam = Math.PI / 2 // CCW sweep wraps the 0/2*pi seam, sweep = pi exactly
    const arcStart = ellipsePointAt(shape, startParam)
    const arcEnd = ellipsePointAt(shape, endParam)
    const d = 3
    const leftBottom = { x: arcEnd.x, y: arcEnd.y - d }
    const rightBottom = { x: arcStart.x, y: arcStart.y - d }
    const left = line('left', arcEnd, leftBottom)
    const right = line('right', rightBottom, arcStart)
    const circ = semicircleArc('carc', leftBottom, rightBottom)
    const arc: SketchEntity = {
      id: 'ea', kind: 'elliptical-arc', construction: false,
      center: shape.center, majorRadius: shape.majorRadius, minorRadius: shape.minorRadius,
      rotation: shape.rotation, startParam, endParam,
    }
    const r = bakeSketch(sketchOf([arc, left, circ, right], []))
    expect(r.loops).toHaveLength(1)
    const outer = r.loops[0]
    expect(outer.type).toBe('contour')
    expect(outer.closed).toBe(true)
    expect(signedArea(outer.points)).toBeGreaterThan(0) // CCW = contour winding
    const arcSeg = outer.segments!.find((s) => s.type === 'arc')
    expect(arcSeg).toBeDefined()
    if (arcSeg && arcSeg.type === 'arc') {
      expect(arcSeg.radius).toBeCloseTo(
        Math.hypot(rightBottom.x - leftBottom.x, rightBottom.y - leftBottom.y) / 2, 9,
      )
      // Contour direction: the real arc rides counter-clockwise.
      expect(arcSeg.clockwise).toBe(false)
    }
    expect(outer.segments!.some((s) => s.type === 'line')).toBe(true)
    expect(r.bakedEntities).toBe(4) // ea(1) + left(1) + carc(1) + right(1)
  })
})

describe('bakeSketch: elliptical-arc chaining stays OUT of the offset tool (SKC-48 offset-tool position)', () => {
  it('chainContaining on the D-shape chord returns a 1-step open chain, and chainContaining("ea") returns null', () => {
    const start = ellipsePt(0), end = ellipsePt(Math.PI)
    const entities = [ellipticalArc('ea', 0, Math.PI), line('chord', end, start)]
    const chord = chainContaining(entities, [], 'chord')
    expect(chord).not.toBeNull()
    expect(chord!.closed).toBe(false)
    expect(chord!.steps).toHaveLength(1)                   // just the chord — the arc never enters
    expect(chord!.steps[0].entity.id).toBe('chord')
    // The elliptical arc stays out of the offset tool's chain (v1 behavior preserved): offset-tool
    // ellipse support is a separately-booked WO, not smuggled in here.
    expect(chainContaining(entities, [], 'ea')).toBeNull()
  })
})
