// WO-1866: curvature (G2) and tangent (G1) continuity where a control-point
// spline meets a line or an arc.
//
// Every claim runs through the production solve entry point
// (solveSketchOnWrapper on a real planegcs wrapper) and is measured from the
// SOLVED geometry: the spline side's curvature comes from an independent
// closed form (the cubic Bernstein / Cox-de Boor derivatives written out
// below), never from the constant the constraint encodes; the arc side is
// 1/r toward its solved centre.

import { describe, it, expect, beforeAll } from 'vitest'
import type { GcsWrapper } from '@salusoft89/planegcs'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, SketchSplineEntity,
  SketchArcEntity, SketchLineEntity, Vec2,
} from '../../lib/sketch/types'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper, sketchToGcsPrimitives } from '../../lib/sketch/solver/gcsMapping'
import { controlSplineCurvatureAt } from '../../lib/sketch/spline'
import { planConstraintForSelection, describeConstraintSet } from '../../lib/sketch/constraintActions'
import { buildBrowserModel } from '../../lib/sketch/browserModel'
import { deleteFromSketch } from '../../lib/sketch/deleteSelection'
import { captureSketchClipboard, instantiateSketchClipboard } from '../../lib/sketch/clipboard'
import { linearPattern } from '../../lib/sketch/tools/patternTools'
import { SECTIONS } from '../../components/panels/sketch/SketchToolbox'
import { BADGE_TEXT, constraintBadgeAnchors, referencedEntityIds } from '../../lib/sketch/sketcher/sketchLayer'

let wrapper: GcsWrapper
beforeAll(async () => { wrapper = await createGcsWrapper() })

// ---- fixtures ---------------------------------------------------------------

const spline = (id: string, points: Vec2[]): SketchSplineEntity =>
  ({ id, kind: 'spline', construction: false, points, closed: false, form: 'control' })
const arc = (id: string, cx: number, cy: number, r: number, a0: number, a1: number): SketchArcEntity =>
  ({ id, kind: 'arc', construction: false, center: { x: cx, y: cy }, radius: r, startAngle: a0, endAngle: a1 })
const line = (id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity =>
  ({ id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } })

function sketchOf(entities: SketchEntity[], constraints: SketchConstraint[], dimensions: SketchDimension[] = []): Sketch {
  return { id: 'sk1866', layerId: 'L', entities, constraints, dimensions, solveStatus: null }
}

function solve(sk: Sketch) {
  const out = solveSketchOnWrapper(wrapper, sk)
  if (!out.ok) throw new Error(`solve failed: ${out.reason} ${out.message}`)
  return out
}

const byId = <K extends SketchEntity['kind']>(es: SketchEntity[], id: string, kind: K) => {
  const e = es.find((x) => x.id === id)
  if (!e || e.kind !== kind) throw new Error(`no ${kind} ${id}`)
  return e as Extract<SketchEntity, { kind: K }>
}

// ---- independent curvature references ---------------------------------------

/** Curvature VECTOR (normal x k, independent of traversal direction) of the
 *  spline at its start or end, from the end derivatives of the clamped uniform
 *  B-spline written out by hand: C'(0) = (p/u1)(P1-P0),
 *  C''(0) = p(p-1)/u1 [ (P2-P1)/u2 - (P1-P0)/u1 ] with u1, u2 the first two
 *  interior knot gaps (u1 = u2 = 1 for a Bezier span, u1 = 1, u2 = 2 for a
 *  longer clamped uniform spline). */
function splineEndCurvatureVector(s: SketchSplineEntity, site: 'start' | 'end'): Vec2 {
  const n = s.points.length
  const P = site === 'start' ? s.points : [...s.points].reverse()
  const p = Math.min(3, n - 1)
  const u1 = 1
  const u2 = n - 1 === p ? 1 : 2
  const d1 = { x: (p / u1) * (P[1].x - P[0].x), y: (p / u1) * (P[1].y - P[0].y) }
  const d2 = {
    x: (p * (p - 1) / u1) * ((P[2].x - P[1].x) / u2 - (P[1].x - P[0].x) / u1),
    y: (p * (p - 1) / u1) * ((P[2].y - P[1].y) / u2 - (P[1].y - P[0].y) / u1),
  }
  const sp2 = d1.x * d1.x + d1.y * d1.y
  const tx = d1.x / Math.sqrt(sp2), ty = d1.y / Math.sqrt(sp2)
  const along = d2.x * tx + d2.y * ty
  return { x: (d2.x - along * tx) / sp2, y: (d2.y - along * ty) / sp2 }
}

function arcCurvatureVector(a: SketchArcEntity, at: Vec2): Vec2 {
  return { x: (a.center.x - at.x) / (a.radius * a.radius), y: (a.center.y - at.y) / (a.radius * a.radius) }
}

const arcPoint = (a: SketchArcEntity, which: 'start' | 'end'): Vec2 => {
  const t = which === 'start' ? a.startAngle : a.endAngle
  return { x: a.center.x + a.radius * Math.cos(t), y: a.center.y + a.radius * Math.sin(t) }
}
const unit = (v: Vec2): Vec2 => { const l = Math.hypot(v.x, v.y); return { x: v.x / l, y: v.y / l } }
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)
const norm = (v: Vec2): number => Math.hypot(v.x, v.y)

type Level = 'continuity_g1' | 'continuity_g2'
type End = 'start' | 'end'
const joint = (kind: Level, sSite: End, nId: string, nSite: End, id: string = kind): SketchConstraint =>
  ({ id, kind, a: { entityId: 'sp', site: sSite }, b: { entityId: nId, site: nSite } })

/** Solved joint facts: position gap, direction agreement (1 = the spline
 *  leaves exactly the way the neighbour arrives), curvature-vector gap. */
function jointFacts(es: SketchEntity[], sSite: End, nId: string, nSite: End) {
  const s = byId(es, 'sp', 'spline')
  const n = s.points.length
  const P0 = sSite === 'start' ? s.points[0] : s.points[n - 1]
  const P1 = sSite === 'start' ? s.points[1] : s.points[n - 2]
  const leave = unit(sub(P1, P0))
  const ks = splineEndCurvatureVector(s, sSite)
  const nb = es.find((e) => e.id === nId)
  let Q: Vec2, arrive: Vec2, kn: Vec2
  if (nb?.kind === 'arc') {
    Q = arcPoint(nb, nSite)
    const radial = unit(sub(Q, nb.center))
    const ccw = { x: -radial.y, y: radial.x }
    // Travelling along the arc INTO the joint: CCW at its end, CW at its start.
    arrive = nSite === 'end' ? ccw : { x: -ccw.x, y: -ccw.y }
    kn = arcCurvatureVector(nb, Q)
  } else if (nb?.kind === 'line') {
    Q = nSite === 'start' ? nb.start : nb.end
    arrive = unit(sub(Q, nSite === 'start' ? nb.end : nb.start))
    kn = { x: 0, y: 0 }
  } else throw new Error(`neighbour ${nId}`)
  return {
    gap: dist(P0, Q),
    align: leave.x * arrive.x + leave.y * arrive.y,
    kGap: norm(sub(ks, kn)),
    ks, kn,
  }
}

// Arc: centre (0,0) r 10 from 0 to 90 deg. Its END is (0,10), arriving
// heading -x; its START is (10,0), arriving (walked backwards) heading -y.
const baseArc = () => arc('arc', 0, 0, 10, 0, Math.PI / 2)
/** A control spline of `n` points starting near the arc end and bending the
 *  WRONG way (away from the centre), so the solve has real work to do. */
function splineOffArcEnd(n: number): SketchSplineEntity {
  const pts: Vec2[] = []
  for (let i = 0; i < n; i++) pts.push({ x: 0.3 - 4 * i, y: 10.2 + 0.15 * i * i })
  return spline('sp', pts)
}

describe('WO-1866 the independent curvature reference agrees with the product evaluator', () => {
  it('controlSplineCurvatureAt at both ends equals the hand-written end-derivative formula (n = 3..6)', () => {
    for (const n of [3, 4, 5, 6]) {
      const s = spline('sp', Array.from({ length: n }, (_, i) => ({ x: 3 * i, y: Math.sin(i) * 4 + i * i * 0.3 })))
      for (const site of ['start', 'end'] as const) {
        const v = splineEndCurvatureVector(s, site)
        const q = site === 'start' ? 0 : n - 1
        expect(Math.abs(Math.abs(controlSplineCurvatureAt(s.points, q)) - norm(v))).toBeLessThan(1e-12)
      }
    }
  })
})

describe('WO-1866 G2: a control spline meeting an arc is curvature-continuous after the solve', () => {
  for (const n of [3, 4, 5, 6]) {
    for (const sSite of ['start', 'end'] as const) {
      for (const nSite of ['end', 'start'] as const) {
        it(`n = ${n}, spline ${sSite} to arc ${nSite}: joint closed, tangent, curvature within 1e-6 /mm`, () => {
          const base = splineOffArcEnd(n)
          const s = sSite === 'start' ? base : spline('sp', [...base.points].reverse())
          const out = solve(sketchOf([baseArc(), s], [joint('continuity_g2', sSite, 'arc', nSite)]))
          const f = jointFacts(out.entities, sSite, 'arc', nSite)
          expect(f.gap).toBeLessThan(1e-6)
          expect(f.align).toBeGreaterThan(1 - 1e-9)
          expect(f.kGap).toBeLessThan(1e-6)
          // A real curvature, not a trivially straight joint.
          expect(norm(f.ks)).toBeGreaterThan(0.05)
          expect(out.status.conflicting).toEqual([])
          expect(out.status.redundant).toEqual([])
        })
      }
    }
  }

  it('stays curvature-continuous after the arc radius is driven to a new value', () => {
    const g2 = joint('continuity_g2', 'start', 'arc', 'end')
    const radius = (value: number): SketchDimension => ({ id: 'r', kind: 'radius', entityId: 'arc', driving: true, value })
    let es = solve(sketchOf([baseArc(), splineOffArcEnd(5)], [g2], [radius(10)])).entities
    expect(jointFacts(es, 'start', 'arc', 'end').kGap).toBeLessThan(1e-6)
    for (const r of [14, 6.5]) {
      es = solve(sketchOf(es, [g2], [radius(r)])).entities
      expect(byId(es, 'arc', 'arc').radius).toBeCloseTo(r, 9)
      const f = jointFacts(es, 'start', 'arc', 'end')
      expect(f.gap).toBeLessThan(1e-6)
      expect(f.align).toBeGreaterThan(1 - 1e-9)
      expect(f.kGap).toBeLessThan(1e-6)
      expect(norm(f.kn)).toBeCloseTo(1 / r, 9)
    }
  })

  it('against a GROUNDED arc the spline alone does the fairing (the capture fixture)', () => {
    const a = arc('arc', 0, 0, 30, 0, Math.PI / 2)
    const s = spline('sp', [{ x: 1, y: 31 }, { x: -14, y: 36 }, { x: -30, y: 37 }, { x: -46, y: 26 }, { x: -56, y: 8 }])
    for (const kind of ['continuity_g1', 'continuity_g2'] as const) {
      const out = solve(sketchOf([a, s], [{ id: 'fx', kind: 'fix', entityId: 'arc' }, joint(kind, 'start', 'arc', 'end')]))
      expect(byId(out.entities, 'arc', 'arc')).toEqual(a)
      const f = jointFacts(out.entities, 'start', 'arc', 'end')
      expect(f.gap).toBeLessThan(1e-6)
      expect(f.align).toBeGreaterThan(1 - 1e-9)
      if (kind === 'continuity_g2') expect(f.kGap).toBeLessThan(1e-6)
    }
  })

  it('negative control: tangency alone passes the tangent assertion and FAILS the curvature one', () => {
    const out = solve(sketchOf([baseArc(), splineOffArcEnd(5)], [joint('continuity_g1', 'start', 'arc', 'end')]))
    const f = jointFacts(out.entities, 'start', 'arc', 'end')
    expect(f.gap).toBeLessThan(1e-6)
    expect(f.align).toBeGreaterThan(1 - 1e-9)
    expect(f.kGap).toBeGreaterThan(1e-3)
  })
})

describe('WO-1866 G1 / G2 with a line', () => {
  // Line (-20,0) -> (0,0): its END arrives heading +x.
  const ln = () => line('ln', -20, 0, 0, 0)
  const sp = () => spline('sp', [{ x: 0.4, y: 0.3 }, { x: 4, y: 1.5 }, { x: 8, y: 4 }, { x: 11, y: 9 }, { x: 12, y: 14 }])

  it('G1: the spline leaves along the line and tracks it through later edits', () => {
    const fix: SketchConstraint = { id: 'fx', kind: 'fix', point: { entityId: 'ln', site: 'start' } }
    const a = { entityId: 'ln', site: 'start' as const }, b = { entityId: 'ln', site: 'end' as const }
    const dims = (x: number, y: number): SketchDimension[] => [
      { id: 'dx', kind: 'distanceX', driving: true, value: x, a, b },
      { id: 'dy', kind: 'distanceY', driving: true, value: y, a, b },
    ]
    const g1 = joint('continuity_g1', 'start', 'ln', 'end')
    let es: SketchEntity[] = [ln(), sp()]
    for (const [x, y] of [[20, 0], [18, 6], [15, -9]]) {
      es = solve(sketchOf(es, [fix, g1], dims(x, y))).entities
      const l = byId(es, 'ln', 'line')
      expect(l.end.x - l.start.x).toBeCloseTo(x, 9)
      expect(l.end.y - l.start.y).toBeCloseTo(y, 9)
      const f = jointFacts(es, 'start', 'ln', 'end')
      expect(f.gap).toBeLessThan(1e-6)
      expect(f.align).toBeGreaterThan(1 - 1e-9)
    }
  })

  it('G2: the spline end curvature is zero, like the line', () => {
    const out = solve(sketchOf([ln(), sp()], [joint('continuity_g2', 'start', 'ln', 'end')]))
    const f = jointFacts(out.entities, 'start', 'ln', 'end')
    expect(f.gap).toBeLessThan(1e-6)
    expect(f.align).toBeGreaterThan(1 - 1e-9)
    expect(norm(f.ks)).toBeLessThan(1e-6)
  })

  it('negative control: G1 alone leaves the end curvature free', () => {
    const out = solve(sketchOf([ln(), sp()], [joint('continuity_g1', 'start', 'ln', 'end')]))
    expect(norm(jointFacts(out.entities, 'start', 'ln', 'end').ks)).toBeGreaterThan(1e-3)
  })
})

describe('WO-1866 degrees of freedom', () => {
  /** planegcs dof of the mapped sketch, with or without one constraint's own
   *  equations, at the SAME materialization (helper points kept). */
  function dofOf(sk: Sketch, dropOwner?: string): number {
    const prims = sketchToGcsPrimitives(sk).filter((p) => !dropOwner || p.type === 'point' ||
      !(p.id === dropOwner || p.id.startsWith(`${dropOwner}:`)))
    wrapper.clear_data()
    wrapper.push_primitives_and_params(prims)
    wrapper.solve()
    return wrapper.gcs.dof()
  }

  it('G1 removes 3 freedoms and G2 removes 4, to an arc and to a line', () => {
    for (const [nb, nSite] of [[baseArc(), 'end'], [line('ln', -20, 10, 0, 10), 'end']] as const) {
      for (const [kind, removed] of [['continuity_g1', 3], ['continuity_g2', 4]] as const) {
        const sk = sketchOf([nb, splineOffArcEnd(5)], [joint(kind, 'start', nb.id, nSite, 'c')])
        // Helper points on their own carry 2 each; strip them from the
        // "without" count so only the constraint's equations differ.
        const helpers = sketchToGcsPrimitives(sk).filter((p) => p.type === 'point' && p.id.startsWith('c:')).length
        expect(dofOf(sk, 'c') - 2 * helpers - dofOf(sk)).toBe(removed)
      }
    }
  })

  it('the solved sketch reports one freedom fewer for G2 than for G1', () => {
    const g1 = solve(sketchOf([baseArc(), splineOffArcEnd(5)], [joint('continuity_g1', 'start', 'arc', 'end')]))
    const g2 = solve(sketchOf([baseArc(), splineOffArcEnd(5)], [joint('continuity_g2', 'start', 'arc', 'end')]))
    expect(g1.status.dof - g2.status.dof).toBe(1)
  })
})

describe('WO-1866 an over-constrained pairing reports through the existing conflict path, by name', () => {
  it('G2 at both ends of a three-point spline to two fixed, non-collinear lines', () => {
    const sk = sketchOf([
      line('l1', -20, 0, 0, 0), line('l2', 20, 10, 30, 20),
      spline('sp', [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 20, y: 10 }]),
    ], [
      { id: 'f1', kind: 'fix', entityId: 'l1' },
      { id: 'f2', kind: 'fix', entityId: 'l2' },
      joint('continuity_g2', 'start', 'l1', 'end', 'gA'),
      joint('continuity_g2', 'end', 'l2', 'start', 'gB'),
    ])
    const out = solveSketchOnWrapper(wrapper, sk)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('conflicting')
    expect(out.status.conflicting.some((id) => id === 'gA' || id === 'gB')).toBe(true)
    expect(describeConstraintSet(sk, out.status.conflicting, new Set()))
      .toMatch(/Curvature continuity \(G2\)\((Spline 1, Line [12]|Line [12], Spline 1)\)/)
    // The viewport colours the curves of a conflicting continuity red, and its
    // G2 badge sits on the joint.
    const g = sk.constraints.find((c) => c.id === 'gB')!
    expect(referencedEntityIds(g)).toEqual(['sp', 'l2'])
    expect(BADGE_TEXT.continuity_g2).toBe('G2')
    expect(constraintBadgeAnchors(sk, g)).toEqual([{ x: 20, y: 10 }])
  })
})

describe('WO-1866 document life: planner, toolbox, browser, coincident, delete, save/reload, copies', () => {
  const sk0 = () => sketchOf([baseArc(), splineOffArcEnd(5)], [])
  const withG2 = (): Sketch => ({ ...sk0(), constraints: [joint('continuity_g2', 'start', 'arc', 'end', 'g')] })

  it('the planner picks the nearest ends and puts the spline first; the toolbox offers both levels', () => {
    for (const kind of ['continuity_g1', 'continuity_g2'] as const) {
      const plan = planConstraintForSelection(sk0(), ['arc', 'sp'], kind)
      expect(plan).toEqual({ ok: true, constraints: [{ id: expect.any(String), kind,
        a: { entityId: 'sp', site: 'start' }, b: { entityId: 'arc', site: 'end' } }] })
    }
    const ids = SECTIONS.find((s) => s.id === 'constraints')?.tools.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining(['continuity-g1', 'continuity-g2']))
  })

  it('the planner says what it needs, and plans both levels between two splines (WO-1943)', () => {
    const two = sketchOf([splineOffArcEnd(4), spline('sp2', [{ x: 0.3, y: 10.2 }, { x: 5, y: 12 }, { x: 9, y: 11 }])], [])
    for (const kind of ['continuity_g1', 'continuity_g2'] as const) {
      expect(planConstraintForSelection(two, ['sp', 'sp2'], kind)).toEqual({ ok: true, constraints: [{
        id: expect.any(String), kind, a: { entityId: 'sp', site: 'start' }, b: { entityId: 'sp2', site: 'start' } }] })
    }
    expect(planConstraintForSelection(sk0(), ['arc'], 'continuity_g2'))
      .toEqual({ ok: false, reason: expect.stringContaining('select a control spline') })
  })

  it('G1 between two control splines solves tangent', () => {
    const two = sketchOf([splineOffArcEnd(4), spline('sp2', [{ x: 0.8, y: 10.5 }, { x: 5, y: 13 }, { x: 9, y: 11 }])], [
      { id: 'g', kind: 'continuity_g1', a: { entityId: 'sp', site: 'start' }, b: { entityId: 'sp2', site: 'start' } },
    ])
    const es = solve(two).entities
    const s1 = byId(es, 'sp', 'spline'), s2 = byId(es, 'sp2', 'spline')
    expect(dist(s1.points[0], s2.points[0])).toBeLessThan(1e-6)
    const d1 = unit(sub(s1.points[1], s1.points[0])), d2 = unit(sub(s2.points[1], s2.points[0]))
    expect(d1.x * d2.x + d1.y * d2.y).toBeLessThan(-1 + 1e-9)
  })

  it('shows in the browser under its own name', () => {
    const group = buildBrowserModel(withG2(), null).groups.find((g) => g.kind === 'continuity_g2')
    expect(group?.title).toBe('Curvature continuity (G2)')
    expect(group?.rows.map((r) => r.id)).toEqual(['g'])
  })

  it('an existing coincident on the same joint is subsumed, not flagged redundant', () => {
    const co: SketchConstraint = { id: 'co', kind: 'coincident',
      a: { entityId: 'arc', site: 'end' }, b: { entityId: 'sp', site: 'start' } }
    const out = solve({ ...withG2(), constraints: [co, ...withG2().constraints] })
    expect(out.status.redundant).toEqual([])
    expect(jointFacts(out.entities, 'start', 'arc', 'end').kGap).toBeLessThan(1e-6)
  })

  it('deleting the arc takes the constraint with it; deleting the constraint frees the joint', () => {
    expect(deleteFromSketch(withG2(), ['arc'])?.constraints).toEqual([])
    const dropped = deleteFromSketch(withG2(), ['g'])
    expect(dropped?.constraints).toEqual([])
    // Nothing left holding it: the spline is carried exactly as drawn.
    const out = solve(sketchOf(dropped!.entities, []))
    expect(byId(out.entities, 'sp', 'spline').points).toEqual(splineOffArcEnd(5).points)
  })

  it('survives save/reload: the JSON round trip solves to the same faired joint', () => {
    const reloaded = JSON.parse(JSON.stringify(withG2())) as Sketch
    expect(reloaded.constraints).toEqual(withG2().constraints)
    const a = solve(withG2()), b = solve(reloaded)
    const pa = byId(a.entities, 'sp', 'spline').points
    byId(b.entities, 'sp', 'spline').points.forEach((p, i) => expect(dist(p, pa[i])).toBeLessThan(1e-6))
    expect(jointFacts(b.entities, 'start', 'arc', 'end').kGap).toBeLessThan(1e-6)
  })

  it('copy/paste and a linear pattern carry the constraint onto the copies, and the copies solve faired', () => {
    let k = 0
    const newId = () => `copy-${k++}`
    const payload = captureSketchClipboard(withG2(), ['arc', 'sp'])
    expect(payload).not.toBeNull()
    const paste = instantiateSketchClipboard(payload!, { x: 50, y: 0 }, newId, ['arc', 'sp', 'g'])
    const pc = paste.constraints.find((c) => c.kind === 'continuity_g2')
    const pasted = new Set(paste.entities.map((e) => e.id))
    expect(pc?.kind === 'continuity_g2' && pasted.has(pc.a.entityId) && pasted.has(pc.b.entityId)).toBe(true)

    const r = linearPattern(withG2().entities, withG2().constraints, ['arc', 'sp'], 2, { x: 0, y: 40 }, newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    const copies = r.constraints.filter((c) => c.kind === 'continuity_g2')
    expect(copies).toHaveLength(1)
    const all = solve(sketchOf([...withG2().entities, ...r.entities], [...withG2().constraints, ...r.constraints]))
    expect(all.status.conflicting).toEqual([])
  })
})

