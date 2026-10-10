// Dimension SELECT geometry (Stage 4 follow-up): a click on a dimension's
// leader / extension / tick lines must hit-test to that dimension (so the
// canvas can select it and Delete can remove it), and a dimension created
// without a placement click must default its label OUTSIDE the geometry.

import { describe, it, expect } from 'vitest'
import { dimensionHitDistance, dimensionDisplay } from '../../lib/sketch/sketcher/sketchLayer'
import type { Sketch, SketchEntity, SketchDimension } from '../../lib/sketch/types'

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function point(id: string, x: number, y: number): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x, y } }
}
function sketch(entities: SketchEntity[], dimensions: SketchDimension[]): Sketch {
  return { id: 's', layerId: 'l', entities, constraints: [], dimensions, solveStatus: null }
}

describe('dimensionHitDistance (leader/extension/tick hit-test)', () => {
  // Distance dim between p0(0,0) and p1(10,0), label dragged below to y=-5:
  // the dim line runs from (0,-5) to (10,-5) with extension lines down each end.
  const ents = [point('p0', 0, 0), point('p1', 10, 0)]
  const dim: SketchDimension = {
    id: 'd1', kind: 'distance', driving: true, value: 10,
    a: { entityId: 'p0', site: 'self' }, b: { entityId: 'p1', site: 'self' },
    labelAnchor: { x: 5, y: -5 },
  }
  const sk = sketch(ents, [dim])

  it('a point ON the dimension line is detected within tolerance', () => {
    const d = dimensionHitDistance(sk, dim, 5, -5, 1)
    expect(d).not.toBeNull()
    expect(d!).toBeLessThan(0.5)
  })

  it('a point ON an extension line is detected', () => {
    const d = dimensionHitDistance(sk, dim, 0, -2, 1)! // on the p0 extension
    expect(d).toBeLessThan(0.5)
  })

  it('a point far from the dimension is NOT within a small tolerance', () => {
    const d = dimensionHitDistance(sk, dim, 50, 50, 1)!
    expect(d).toBeGreaterThan(5)
  })
})

describe('default-outside placement (no user labelAnchor)', () => {
  it('distance default anchor lands on the outward side (below a bottom edge)', () => {
    // p0,p1 on the bottom; pc biases the centroid upward, so OUTWARD is down.
    const ents = [point('p0', 0, 0), point('p1', 10, 0), point('pc', 5, 10)]
    const dim: SketchDimension = {
      id: 'd', kind: 'distance', driving: true, value: 10,
      a: { entityId: 'p0', site: 'self' }, b: { entityId: 'p1', site: 'self' },
    }
    const disp = dimensionDisplay(sketch(ents, [dim]), dim)!
    expect(disp.anchor.y).toBeLessThan(0) // outside (below), not inside the bulk
  })

  it('distancePL default anchor lands outside, past the point away from the line', () => {
    // line on y=0; point above at y=10; pd biases the centroid below the
    // point-to-foot span so OUTWARD is up (past the point).
    const ents = [line('la', 0, 0, 10, 0), point('pa', 5, 10), point('pd', 5, -5)]
    const dim: SketchDimension = {
      id: 'd', kind: 'distancePL', driving: true, value: 10,
      point: { entityId: 'pa', site: 'self' }, line: 'la',
    }
    const disp = dimensionDisplay(sketch(ents, [dim]), dim)!
    expect(disp.anchor.y).toBeGreaterThan(10) // beyond the point, clear of the span
  })
})
