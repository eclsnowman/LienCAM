// REPRO (Operator bug): line<->circle tangent after the fact does not enforce
// tangency. We add a 'tangent' constraint between a free line and a circle,
// solve, and MEASURE the perpendicular distance from the circle center to the
// line's infinite line. It should equal the radius.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchCircleEntity,
  SketchConstraint,
} from '../../lib/sketch/types'

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function circle(id: string, cx: number, cy: number, r: number): SketchCircleEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}
function sketch(entities: SketchEntity[], constraints: SketchConstraint[]): Sketch {
  return {
    id: 'sk', layerId: 'layer', entities, constraints, dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}
function asLine(entities: SketchEntity[], id: string): SketchLineEntity {
  const e = entities.find((x) => x.id === id)
  if (!e || e.kind !== 'line') throw new Error(`no line ${id}`)
  return e
}
function asCircle(entities: SketchEntity[], id: string): SketchCircleEntity {
  const e = entities.find((x) => x.id === id)
  if (!e || e.kind !== 'circle') throw new Error(`no circle ${id}`)
  return e
}
/** perpendicular distance from point p to the infinite line through l */
function distPointLine(l: SketchLineEntity, p: { x: number; y: number }): number {
  const dx = l.end.x - l.start.x, dy = l.end.y - l.start.y
  const len = Math.hypot(dx, dy)
  return Math.abs((p.x - l.start.x) * dy - (p.y - l.start.y) * dx) / len
}

describe('REPRO line-circle tangent', () => {
  it('a free line + fixed circle: after tangent solve, dist(center,line) == radius', async () => {
    const gcs = await createGcsWrapper()
    // Circle fixed at origin r=5. Line clearly NOT tangent (passes ~0 from
    // center -> a near-diameter chord; dist ~ 0, far from radius 5).
    const sk = sketch(
      [circle('C', 0, 0, 5), line('L', -10, 0.5, 10, 0.5)],
      [
        { id: 'fxC', kind: 'fix', entityId: 'C' },
        { id: 'tan', kind: 'tangent', a: 'L', b: 'C' },
      ],
    )
    const out = solveSketchOnWrapper(gcs, sk)
    console.log('[repro] solve ok?', out.ok, 'status', JSON.stringify(out.status))
    if (out.ok) {
      const l = asLine(out.entities, 'L')
      const c = asCircle(out.entities, 'C')
      const d = distPointLine(l, c.center)
      console.log(`[repro] dist(center,line)=${d.toFixed(6)} radius=${c.radius} delta=${(d - c.radius).toFixed(6)}`)
      expect(d).toBeCloseTo(c.radius, 4)
    } else {
      console.log('[repro] solve FAILED:', out.reason, out.message)
      expect(out.ok).toBe(true)
    }
    gcs.destroy_gcs_module()
  })

  it('BOTH FREE: free line + free circle, tangent solve', async () => {
    const gcs = await createGcsWrapper()
    const sk = sketch(
      [circle('C', 0, 0, 5), line('L', -10, 0.5, 10, 0.5)],
      [{ id: 'tan', kind: 'tangent', a: 'L', b: 'C' }],
    )
    const out = solveSketchOnWrapper(gcs, sk)
    console.log('[repro free] ok?', out.ok, 'status', JSON.stringify(out.status))
    if (out.ok) {
      const l = asLine(out.entities, 'L')
      const c = asCircle(out.entities, 'C')
      const d = distPointLine(l, c.center)
      console.log(`[repro free] dist=${d.toFixed(6)} radius=${c.radius} delta=${(d - c.radius).toFixed(6)}`)
      expect(d).toBeCloseTo(c.radius, 4)
      // BUG GUARD: the circle must NOT collapse to absorb the whole tangent
      // error. Pre-fix it shrank 5 -> 0.5 while the line never moved.
      expect(c.radius).toBeGreaterThan(3)
    } else {
      console.log('[repro free] FAILED', out.reason, out.message)
      expect(out.ok).toBe(true)
    }
    gcs.destroy_gcs_module()
  })

  it('LINE-ARC: free line + fixed arc, tangent solve', async () => {
    const gcs = await createGcsWrapper()
    const arc: SketchEntity = {
      id: 'A', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI,
    }
    const sk = sketch(
      [arc, line('L', -10, 0.5, 10, 0.5)],
      [
        { id: 'fxA', kind: 'fix', entityId: 'A' },
        { id: 'tan', kind: 'tangent', a: 'L', b: 'A' },
      ],
    )
    const out = solveSketchOnWrapper(gcs, sk)
    console.log('[repro arc] ok?', out.ok, 'status', JSON.stringify(out.status))
    if (out.ok) {
      const l = asLine(out.entities, 'L')
      const a = out.entities.find((x) => x.id === 'A')!
      const center = (a as { center: { x: number; y: number } }).center
      const radius = (a as { radius: number }).radius
      const d = distPointLine(l, center)
      console.log(`[repro arc] dist=${d.toFixed(6)} radius=${radius} delta=${(d - radius).toFixed(6)}`)
      expect(d).toBeCloseTo(radius, 4)
    } else {
      console.log('[repro arc] FAILED', out.reason, out.message)
      expect(out.ok).toBe(true)
    }
    gcs.destroy_gcs_module()
  })
})
