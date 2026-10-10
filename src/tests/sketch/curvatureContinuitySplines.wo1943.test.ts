// WO-1943: curvature (G2) continuity where two control-point splines meet --
// pairing 5 of WO-1866's approved composition.
//
// Every claim runs through the production solve entry point
// (solveSketchOnWrapper on a real planegcs wrapper) and is measured from the
// SOLVED geometry: each side's curvature comes from the hand-written clamped
// B-spline end derivatives below, never from the constant the constraint
// encodes.

import { describe, it, expect, beforeAll } from 'vitest'
import type { GcsWrapper } from '@salusoft89/planegcs'
import type { Sketch, SketchEntity, SketchConstraint, SketchSplineEntity, Vec2 } from '../../lib/sketch/types'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper, sketchToGcsPrimitives } from '../../lib/sketch/solver/gcsMapping'
import { controlSplineCurvatureAt } from '../../lib/sketch/spline'
import { planConstraintForSelection } from '../../lib/sketch/constraintActions'

let wrapper: GcsWrapper
beforeAll(async () => { wrapper = await createGcsWrapper() })

// ---- fixtures ---------------------------------------------------------------

const spline = (id: string, points: Vec2[]): SketchSplineEntity =>
  ({ id, kind: 'spline', construction: false, points, closed: false, form: 'control' })

function sketchOf(entities: SketchEntity[], constraints: SketchConstraint[]): Sketch {
  return { id: 'sk1943', layerId: 'L', entities, constraints, dimensions: [], solveStatus: null }
}

function solve(sk: Sketch) {
  const out = solveSketchOnWrapper(wrapper, sk)
  if (!out.ok) throw new Error(`solve failed: ${out.reason} ${out.message}`)
  return out
}

const byId = (es: SketchEntity[], id: string): SketchSplineEntity => {
  const e = es.find((x) => x.id === id)
  if (!e || e.kind !== 'spline') throw new Error(`no spline ${id}`)
  return e
}

type End = 'start' | 'end'
type Level = 'continuity_g1' | 'continuity_g2'
const joint = (kind: Level, aSite: End, bSite: End, id: string = kind): SketchConstraint =>
  ({ id, kind, a: { entityId: 'A', site: aSite }, b: { entityId: 'B', site: bSite } })

/** `n` control points leaving (x0, y0) heading `dir` (+1 / -1 in x), bending
 *  by `bend` (positive = toward +y). Stored from the joint unless `site` is
 *  'end', then reversed so the joint is the last point. */
function arm(id: string, n: number, dir: number, x0: number, y0: number, bend: number, site: End): SketchSplineEntity {
  const pts: Vec2[] = []
  for (let i = 0; i < n; i++) pts.push({ x: x0 + dir * 4 * i, y: y0 + bend * i * i + 0.05 * i })
  return spline(id, site === 'start' ? pts : pts.reverse())
}

// ---- independent curvature reference ------------------------------------------

/** Curvature VECTOR (independent of traversal direction) of a clamped uniform
 *  control spline at its start or end, from the hand-written end derivatives:
 *  C'(0) = p (P1 - P0), C''(0) = p (p-1) [ (P2 - P1)/u2 - (P1 - P0) ] with
 *  u2 = 1 for a single Bezier span, 2 for a longer clamped uniform spline. */
function endCurvatureVector(s: SketchSplineEntity, site: End): Vec2 {
  const n = s.points.length
  const P = site === 'start' ? s.points : [...s.points].reverse()
  const p = Math.min(3, n - 1)
  if (p < 2) return { x: 0, y: 0 }
  const u2 = n - 1 === p ? 1 : 2
  const d1 = { x: p * (P[1].x - P[0].x), y: p * (P[1].y - P[0].y) }
  const d2 = {
    x: p * (p - 1) * ((P[2].x - P[1].x) / u2 - (P[1].x - P[0].x)),
    y: p * (p - 1) * ((P[2].y - P[1].y) / u2 - (P[1].y - P[0].y)),
  }
  const sp2 = d1.x * d1.x + d1.y * d1.y
  const tx = d1.x / Math.sqrt(sp2), ty = d1.y / Math.sqrt(sp2)
  const along = d2.x * tx + d2.y * ty
  return { x: (d2.x - along * tx) / sp2, y: (d2.y - along * ty) / sp2 }
}

const unit = (v: Vec2): Vec2 => { const l = Math.hypot(v.x, v.y); return { x: v.x / l, y: v.y / l } }
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y)
const norm = (v: Vec2): number => Math.hypot(v.x, v.y)

/** Solved joint facts: gap, direction agreement (-1 = the two splines leave
 *  the joint in exactly opposite directions: one tangent line, no cusp) and
 *  the curvature-vector gap -- where the two curvature combs meet. */
function jointFacts(es: SketchEntity[], aSite: End, bSite: End) {
  const A = byId(es, 'A'), B = byId(es, 'B')
  const end = (s: SketchSplineEntity, site: End) => {
    const n = s.points.length
    return site === 'start' ? [s.points[0], s.points[1]] : [s.points[n - 1], s.points[n - 2]]
  }
  const [a0, a1] = end(A, aSite), [b0, b1] = end(B, bSite)
  const da = unit(sub(a1, a0)), db = unit(sub(b1, b0))
  const ka = endCurvatureVector(A, aSite), kb = endCurvatureVector(B, bSite)
  return { gap: dist(a0, b0), align: da.x * db.x + da.y * db.y, kGap: norm(sub(ka, kb)), ka, kb }
}

describe('WO-1943 the independent curvature reference agrees with the product evaluator', () => {
  it('endCurvatureVector equals |controlSplineCurvatureAt| at both ends (n = 3..6)', () => {
    for (const n of [3, 4, 5, 6]) {
      const s = spline('s', Array.from({ length: n }, (_, i) => ({ x: 3 * i, y: Math.sin(i) * 4 + i * i * 0.3 })))
      for (const site of ['start', 'end'] as const) {
        const q = site === 'start' ? 0 : n - 1
        expect(Math.abs(Math.abs(controlSplineCurvatureAt(s.points, q)) - norm(endCurvatureVector(s, site)))).toBeLessThan(1e-12)
      }
    }
  })
})

describe('WO-1943 G2: two control splines meet with equal curvature and a shared tangent', () => {
  for (const [n, m] of [[3, 3], [3, 5], [4, 4], [4, 6], [5, 3], [5, 5], [6, 4]] as const) {
    for (const aSite of ['start', 'end'] as const) {
      for (const bSite of ['start', 'end'] as const) {
        it(`A n = ${n} (${aSite}) to B n = ${m} (${bSite}): combs meet within 1e-9 /mm`, () => {
          // Both bend up, by different amounts, and the ends start apart: the
          // solve has real work to do and the shared curvature is not zero.
          const A = arm('A', n, -1, -0.3, 0.2, 0.35, aSite)
          const B = arm('B', m, 1, 0.4, -0.1, 0.08, bSite)
          const out = solve(sketchOf([A, B], [joint('continuity_g2', aSite, bSite)]))
          const f = jointFacts(out.entities, aSite, bSite)
          expect(f.gap).toBeLessThan(1e-9)
          expect(f.align).toBeLessThan(-1 + 1e-12)
          expect(f.kGap).toBeLessThan(1e-9)
          expect(norm(f.ka)).toBeGreaterThan(0.005)
          expect(out.status.conflicting).toEqual([])
          expect(out.status.redundant).toEqual([])
        })
      }
    }
  }

  it('an S-joint (the two ends bent opposite ways) solves to one bend: combs on the same side', () => {
    const A = arm('A', 5, -1, 0, 0, 0.4, 'start')
    const B = arm('B', 5, 1, 0.2, 0.1, -0.4, 'start')
    const f = jointFacts(solve(sketchOf([A, B], [joint('continuity_g2', 'start', 'start')])).entities, 'start', 'start')
    expect(f.gap).toBeLessThan(1e-9)
    expect(f.align).toBeLessThan(-1 + 1e-12)
    expect(f.kGap).toBeLessThan(1e-9)
  })

  it('a straight (zero-curvature) joint is an ordinary solution, not a degenerate one', () => {
    // Both splines straight on one line with their ends apart: the solve
    // closes the gap and the curvature it holds equal there is zero. A
    // radius-based composition would divide by zero here; this one reports
    // no redundancy and no conflict.
    const straight = (id: string, n: number, dir: number, x0: number) =>
      spline(id, Array.from({ length: n }, (_, i) => ({ x: x0 + dir * 4 * i, y: 0 })))
    for (const [n, m] of [[4, 5], [3, 6], [5, 3]] as const) {
      const out = solve(sketchOf([straight('A', n, -1, -0.4), straight('B', m, 1, 0.5)],
        [joint('continuity_g2', 'start', 'start')]))
      const f = jointFacts(out.entities, 'start', 'start')
      expect(f.gap).toBeLessThan(1e-9)
      expect(f.align).toBeLessThan(-1 + 1e-12)
      expect(f.kGap).toBeLessThan(1e-9)
      expect(norm(f.ka)).toBeLessThan(1e-9)
      expect(out.status.conflicting).toEqual([])
      expect(out.status.redundant).toEqual([])
    }
    // Drawn slightly bent the opposite ways around a straight line, the
    // solve lands on a small shared curvature through the same equations.
    const bent = solve(sketchOf([arm('A', 5, -1, -0.4, 0.3, 0.01, 'start'), arm('B', 4, 1, 0.5, -0.2, -0.01, 'start')],
      [joint('continuity_g2', 'start', 'start')]))
    const f = jointFacts(bent.entities, 'start', 'start')
    expect(f.kGap).toBeLessThan(1e-9)
    expect(bent.status.redundant).toEqual([])
  })

  it('a two-point (straight) spline on one side: the other end goes straight too', () => {
    const A = spline('A', [{ x: 0, y: 0 }, { x: -10, y: 0.5 }])
    const B = arm('B', 5, 1, 0.3, 0.2, 0.3, 'start')
    const f = jointFacts(solve(sketchOf([A, B], [joint('continuity_g2', 'start', 'start')])).entities, 'start', 'start')
    expect(f.gap).toBeLessThan(1e-9)
    expect(f.align).toBeLessThan(-1 + 1e-12)
    expect(norm(f.kb)).toBeLessThan(1e-9)
  })

  it('negative control: tangency alone passes the tangent assertion and FAILS the curvature one', () => {
    const A = arm('A', 5, -1, -0.3, 0.2, 0.35, 'start')
    const B = arm('B', 5, 1, 0.4, -0.1, 0.08, 'start')
    const f = jointFacts(solve(sketchOf([A, B], [joint('continuity_g1', 'start', 'start')])).entities, 'start', 'start')
    expect(f.gap).toBeLessThan(1e-9)
    expect(f.align).toBeLessThan(-1 + 1e-12)
    expect(f.kGap).toBeGreaterThan(1e-3)
  })

  it('survives save/reload: the JSON round trip solves to the same faired joint', () => {
    const sk = sketchOf([arm('A', 4, -1, -0.3, 0.2, 0.35, 'start'), arm('B', 6, 1, 0.4, -0.1, 0.08, 'end')],
      [joint('continuity_g2', 'start', 'end')])
    const reloaded = JSON.parse(JSON.stringify(sk)) as Sketch
    const a = solve(sk), b = solve(reloaded)
    for (const id of ['A', 'B']) {
      const pa = byId(a.entities, id).points
      byId(b.entities, id).points.forEach((p, i) => expect(dist(p, pa[i])).toBeLessThan(1e-9))
    }
    expect(jointFacts(b.entities, 'start', 'end').kGap).toBeLessThan(1e-9)
  })
})

describe('WO-1943 degrees of freedom and the planner', () => {
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

  it('G1 removes 3 freedoms and G2 removes 4 between two splines', () => {
    for (const [kind, removed] of [['continuity_g1', 3], ['continuity_g2', 4]] as const) {
      const sk = sketchOf([arm('A', 5, -1, -0.3, 0.2, 0.35, 'start'), arm('B', 4, 1, 0.4, -0.1, 0.08, 'start')],
        [joint(kind, 'start', 'start', 'c')])
      const helpers = sketchToGcsPrimitives(sk).filter((p) => p.type === 'point' && p.id.startsWith('c:')).length
      expect(dofOf(sk, 'c') - 2 * helpers - dofOf(sk)).toBe(removed)
    }
  })

  it('the solved sketch reports one freedom fewer for G2 than for G1', () => {
    const sk = (kind: Level) => sketchOf([arm('A', 5, -1, -0.3, 0.2, 0.35, 'start'), arm('B', 4, 1, 0.4, -0.1, 0.08, 'start')],
      [joint(kind, 'start', 'start')])
    expect(solve(sk('continuity_g1')).status.dof - solve(sk('continuity_g2')).status.dof).toBe(1)
  })

  it('the planner offers G2 between two control splines, joining the nearest ends', () => {
    const sk = sketchOf([arm('A', 5, -1, -0.3, 0.2, 0.35, 'end'), arm('B', 4, 1, 0.4, -0.1, 0.08, 'start')], [])
    expect(planConstraintForSelection(sk, ['A', 'B'], 'continuity_g2')).toEqual({ ok: true, constraints: [{
      id: expect.any(String), kind: 'continuity_g2',
      a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' } }] })
  })
})
