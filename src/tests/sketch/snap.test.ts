// Snap engine — headless coverage (Stage 3 chunk 3).
//
// Pins each snap kind (endpoint / midpoint / center / intersection /
// grid / h-align / v-align), the priority ordering (entity beats
// alignment beats grid), the screen-space snap radius, and the flag
// gating (entity / grid / inference toggles).

import { describe, it, expect } from 'vitest'
import {
  findSnap,
  chainAlignRef,
  entityIntersections,
  DEFAULT_SNAP_FLAGS,
  SNAP_PX,
  type SnapQuery,
} from '../../lib/sketch/snap'
import type { SketchEntity, Vec2 } from '../../lib/sketch/types'

// worldPerPixel = 0.1 -> snap radius = SNAP_PX * 0.1 = 1 mm. All test
// geometry is built around that radius.
const WPP = 0.1
const TOL = SNAP_PX * WPP // 1 mm

function line(id: string, sx: number, sy: number, ex: number, ey: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: sx, y: sy }, end: { x: ex, y: ey } }
}

function circle(id: string, cx: number, cy: number, r: number): SketchEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}

function arc(
  id: string, cx: number, cy: number, r: number, a0: number, a1: number
): SketchEntity {
  return {
    id, kind: 'arc', construction: false,
    center: { x: cx, y: cy }, radius: r, startAngle: a0, endAngle: a1,
  }
}

function point(id: string, x: number, y: number): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x, y } }
}

function query(cursor: Vec2, entities: SketchEntity[], extra?: Partial<SnapQuery>): SnapQuery {
  return {
    cursor,
    entities,
    gridSpacing: 25,
    worldPerPixel: WPP,
    flags: { entity: true, grid: true, inference: true },
    ...extra,
  }
}

describe('endpoint snap', () => {
  it('snaps to a line endpoint within the radius, with a coincident inference', () => {
    const r = findSnap(query({ x: 10.4, y: 0.3 }, [line('l1', 0, 0, 10, 0)]))
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('endpoint')
    expect(r!.point).toEqual({ x: 10, y: 0 })
    expect(r!.sourceEntityIds).toEqual(['l1'])
    expect(r!.inferences).toEqual([
      { kind: 'coincident', to: { entityId: 'l1', site: 'end' } },
    ])
  })

  it('snaps to an arc endpoint (computed from angles)', () => {
    // CCW arc from 0 to pi/2 on radius 10: endpoints (10,0) and (0,10).
    const r = findSnap(query({ x: 0.2, y: 10.3 }, [arc('a1', 0, 0, 10, 0, Math.PI / 2)]))
    expect(r!.kind).toBe('endpoint')
    expect(r!.point.x).toBeCloseTo(0, 9)
    expect(r!.point.y).toBeCloseTo(10, 9)
    expect(r!.inferences).toEqual([
      { kind: 'coincident', to: { entityId: 'a1', site: 'end' } },
    ])
  })

  it('snaps onto a point entity (site self)', () => {
    const r = findSnap(query({ x: 5.2, y: 5.1 }, [point('p1', 5, 5)]))
    expect(r!.kind).toBe('endpoint')
    expect(r!.point).toEqual({ x: 5, y: 5 })
    expect(r!.inferences).toEqual([
      { kind: 'coincident', to: { entityId: 'p1', site: 'self' } },
    ])
  })

  it('does NOT snap outside the radius', () => {
    const r = findSnap(query({ x: 12, y: 2 }, [line('l1', 0, 0, 10, 0)]))
    expect(r).toBeNull()
  })
})

describe('midpoint snap', () => {
  it('snaps to a line midpoint with a midpoint inference', () => {
    const r = findSnap(query({ x: 5.3, y: 0.2 }, [line('l1', 0, 0, 10, 0)]))
    expect(r!.kind).toBe('midpoint')
    expect(r!.point).toEqual({ x: 5, y: 0 })
    expect(r!.inferences).toEqual([{ kind: 'midpoint', line: 'l1' }])
  })
})

describe('center snap', () => {
  it('snaps to a circle center with a coincident-to-center inference', () => {
    const r = findSnap(query({ x: 20.4, y: 20.2 }, [circle('c1', 20, 20, 8)]))
    expect(r!.kind).toBe('center')
    expect(r!.point).toEqual({ x: 20, y: 20 })
    expect(r!.inferences).toEqual([
      { kind: 'coincident', to: { entityId: 'c1', site: 'center' } },
    ])
  })

  it('snaps to an arc center', () => {
    const r = findSnap(query({ x: 0.3, y: -0.2 }, [arc('a1', 0, 0, 10, 0, Math.PI)]))
    expect(r!.kind).toBe('center')
    expect(r!.point).toEqual({ x: 0, y: 0 })
  })
})

describe('intersection snap', () => {
  it('line/line crossing', () => {
    // Midpoints sit away from the crossing so the intersection is the
    // only candidate in radius.
    const ents = [line('l1', -2, 0, 10, 0), line('l2', 0, -2, 0, 10)]
    const r = findSnap(query({ x: 0.4, y: 0.3 }, ents))
    expect(r!.kind).toBe('intersection')
    expect(r!.point.x).toBeCloseTo(0, 9)
    expect(r!.point.y).toBeCloseTo(0, 9)
    expect(new Set(r!.sourceEntityIds)).toEqual(new Set(['l1', 'l2']))
    expect(r!.inferences).toEqual([
      { kind: 'point_on_object', object: 'l1' },
      { kind: 'point_on_object', object: 'l2' },
    ])
  })

  it('line/circle', () => {
    // Horizontal line through circle (0,0) r=5: intersections (-5,0), (5,0).
    const ents = [line('l1', -10, 0, 10, 0), circle('c1', 0, 0, 5)]
    const r = findSnap(query({ x: 4.7, y: 0.4 }, ents))
    expect(r!.kind).toBe('intersection')
    expect(r!.point.x).toBeCloseTo(5, 9)
    expect(r!.point.y).toBeCloseTo(0, 9)
  })

  it('line/arc respects the arc sweep', () => {
    // Arc 0.3..pi-0.3 (upper band, r=5). The vertical line x=0 crosses the
    // FULL circle at (0,5) and (0,-5); only (0,5) lies on the sweep.
    const ents = [line('l1', 0, -10, 0, 10), arc('a1', 0, 0, 5, 0.3, Math.PI - 0.3)]
    const hit = findSnap(query({ x: 0.3, y: 4.8 }, ents))
    expect(hit!.kind).toBe('intersection')
    expect(hit!.point.x).toBeCloseTo(0, 9)
    expect(hit!.point.y).toBeCloseTo(5, 9)
    // The off-sweep crossing (0,-5) is outside the arc sweep, so no
    // intersection is found.  SKC-73 curve-body projection snaps to
    // the line body instead, with a point_on_object inference.
    const miss = findSnap(query({ x: 0.2, y: -4.8 }, ents, {
      flags: { entity: true, grid: false, inference: true },
    }))
    expect(miss!.kind).toBe('curve')
    expect(miss!.point.x).toBeCloseTo(0, 9)
    expect(miss!.point.y).toBeCloseTo(-4.8, 9)
    expect(miss!.inferences).toEqual([
      { kind: 'point_on_object', object: 'l1' },
    ])
  })

  it('circle/circle', () => {
    // Circles r=5 centered (0,0) and (8,0): intersections at x=4, y=+-3.
    const ents = [circle('c1', 0, 0, 5), circle('c2', 8, 0, 5)]
    const r = findSnap(query({ x: 4.2, y: 3.3 }, ents))
    expect(r!.kind).toBe('intersection')
    expect(r!.point.x).toBeCloseTo(4, 9)
    expect(r!.point.y).toBeCloseTo(3, 9)
  })

  it('entityIntersections: parallel lines and separated circles yield none', () => {
    expect(entityIntersections(line('a', 0, 0, 10, 0), line('b', 0, 1, 10, 1))).toEqual([])
    expect(entityIntersections(circle('a', 0, 0, 2), circle('b', 10, 0, 2))).toEqual([])
  })

  it('entityIntersections: ellipse crossed by a line returns the 2 crossings', () => {
    // Axis-aligned ellipse a=10 b=5 at origin; horizontal line y=0 through
    // the center crosses the major-axis vertices at x = +/-10.
    const ell: SketchEntity = {
      id: 'E', kind: 'ellipse', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
    }
    const xs = entityIntersections(ell, line('L', -20, 0, 20, 0))
      .map((p) => p.x).sort((a, b) => a - b)
    expect(xs).toHaveLength(2)
    expect(xs[0]).toBeCloseTo(-10, 4)
    expect(xs[1]).toBeCloseTo(10, 4)
    // Symmetric under argument order.
    expect(entityIntersections(line('L', -20, 0, 20, 0), ell)).toHaveLength(2)
  })

  it('entityIntersections: an elliptical-arc cutter filters to its own sweep', () => {
    // Full ellipse E and a HALF elliptical-arc (params 0..pi, the upper
    // half). A vertical line x=0 crosses the full ellipse at y = +/-5, but
    // only the +y crossing lies on the upper-half arc sweep.
    const arcE: SketchEntity = {
      id: 'A', kind: 'elliptical-arc', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
      startParam: 0, endParam: Math.PI,
    }
    const ys = entityIntersections(arcE, line('L', 0, -20, 0, 20)).map((p) => p.y)
    expect(ys).toHaveLength(1)
    expect(ys[0]).toBeCloseTo(5, 4)
  })
})

describe('alignment snap', () => {
  const ref = { x: 10, y: 5 }

  it('h-align: cursor nearly level with the chain previous point', () => {
    const r = findSnap(query({ x: 30, y: 5.4 }, [], { alignRef: ref }))
    expect(r!.kind).toBe('h-align')
    expect(r!.point).toEqual({ x: 30, y: 5 })
    expect(r!.alignFrom).toEqual(ref)
    expect(r!.inferences).toEqual([{ kind: 'horizontal' }])
  })

  it('v-align: cursor nearly plumb with the chain previous point', () => {
    const r = findSnap(query({ x: 10.4, y: 25 }, [], { alignRef: ref }))
    expect(r!.kind).toBe('v-align')
    expect(r!.point).toEqual({ x: 10, y: 25 })
    expect(r!.inferences).toEqual([{ kind: 'vertical' }])
  })

  it('no alignment without an alignRef', () => {
    const r = findSnap(query({ x: 30, y: 5.4 }, []))
    expect(r).toBeNull()
  })

  it('no alignment within the radius of the reference itself', () => {
    const r = findSnap(query({ x: 10.3, y: 5.2 }, [], { alignRef: ref }))
    expect(r).toBeNull()
  })
})

describe('grid snap', () => {
  it('snaps to the nearest grid multiple within the radius', () => {
    const r = findSnap(query({ x: 25.4, y: 49.7 }, []))
    expect(r!.kind).toBe('grid')
    expect(r!.point).toEqual({ x: 25, y: 50 })
    expect(r!.inferences).toEqual([{ kind: 'grid' }])
  })

  it('no grid snap when the nearest grid point is beyond the radius', () => {
    const r = findSnap(query({ x: 12, y: 12 }, []))
    expect(r).toBeNull()
  })

  it('grid snap skips inference when inference flag is off', () => {
    const r = findSnap(query({ x: 25.4, y: 49.7 }, [], { flags: { entity: true, grid: true, inference: false } }))
    expect(r!.kind).toBe('grid')
    expect(r!.point).toEqual({ x: 25, y: 50 })
    expect(r!.inferences).toEqual([])
  })
})

describe('priority ordering', () => {
  it('entity snap beats alignment', () => {
    // Endpoint at (10,5) and an h-align candidate at the same cursor.
    const r = findSnap(query({ x: 10.3, y: 5.3 }, [line('l1', 0, 5, 10, 5)], {
      alignRef: { x: -20, y: 5 },
    }))
    expect(r!.kind).toBe('endpoint')
  })

  it('entity snap beats grid', () => {
    // Endpoint at (25.5, 50) close to grid point (25, 50).
    const r = findSnap(query({ x: 25.4, y: 50.1 }, [line('l1', 25.5, 50, 60, 50)]))
    expect(r!.kind).toBe('endpoint')
    expect(r!.point).toEqual({ x: 25.5, y: 50 })
  })

  it('alignment beats grid', () => {
    // Cursor near grid point (50, 25) AND nearly level with ref y=25.2.
    const r = findSnap(query({ x: 50.2, y: 24.9 }, [], { alignRef: { x: 0, y: 25.2 } }))
    expect(r!.kind).toBe('h-align')
    expect(r!.point.y).toBeCloseTo(25.2, 9)
  })

  it('nearest entity candidate wins within the tier', () => {
    // Endpoint (10,0) at 0.3 mm vs midpoint (10.5,0) of l2 at 0.2 mm.
    const ents = [line('l1', 0, 0, 10, 0), line('l2', 10.3, 0, 10.7, 0)]
    const r = findSnap(query({ x: 10.3, y: 0 }, ents))
    expect(r!.kind).toBe('endpoint') // l2 start endpoint at 10.3 is dist 0
    expect(r!.point).toEqual({ x: 10.3, y: 0 })
  })
})

describe('flag gating', () => {
  const ents = [line('l1', 0, 0, 10, 0)]

  it('entity flag off: falls through to grid', () => {
    const r = findSnap(query({ x: 0.2, y: 0.3 }, ents, {
      flags: { entity: false, grid: true, inference: false },
    }))
    expect(r!.kind).toBe('grid')
    expect(r!.point).toEqual({ x: 0, y: 0 })
  })

  it('grid flag off: no grid snap', () => {
    const r = findSnap(query({ x: 25.2, y: 50.2 }, [], {
      flags: { entity: true, grid: false, inference: true },
    }))
    expect(r).toBeNull()
  })

  it('inference flag off: entity snaps still position but carry no inferences', () => {
    const r = findSnap(query({ x: 10.2, y: 0.2 }, ents, {
      flags: { entity: true, grid: false, inference: false },
    }))
    expect(r!.kind).toBe('endpoint')
    expect(r!.inferences).toEqual([])
  })

  it('inference flag off: alignment snaps are disabled entirely', () => {
    const r = findSnap(query({ x: 30, y: 5.2 }, [], {
      alignRef: { x: 0, y: 5 },
      flags: { entity: true, grid: false, inference: false },
    }))
    expect(r).toBeNull()
  })

  it('default flags: entity + inference on, grid off', () => {
    expect(DEFAULT_SNAP_FLAGS).toEqual({ entity: true, grid: false, inference: true })
  })
})

describe('snap radius is screen-space', () => {
  it('the same world offset snaps zoomed out and misses zoomed in', () => {
    const ents = [line('l1', 0, 0, 10, 0)]
    const cursor = { x: 10.6, y: 0 } // 0.6 mm from the endpoint
    const out = findSnap(query(cursor, ents, { worldPerPixel: 0.1 }))  // tol 1 mm
    const zoomed = findSnap(query(cursor, ents, { worldPerPixel: 0.01 })) // tol 0.1 mm
    expect(out!.kind).toBe('endpoint')
    expect(zoomed).toBeNull()
  })
})

describe('chainAlignRef', () => {
  it('line chain exposes its previous point', () => {
    expect(chainAlignRef({
      kind: 'line', start: { x: 0, y: 0 }, firstLineId: 'l1',
      prev: { x: 5, y: 7 }, prevLineId: 'l1',
    })).toEqual({ x: 5, y: 7 })
  })

  it('non-line chains and null have no alignment reference', () => {
    expect(chainAlignRef(null)).toBeNull()
    expect(chainAlignRef({ kind: 'rect', mode: 'corner', anchor: { x: 1, y: 2 } })).toBeNull()
  })
})

describe('curve-body snap (SKC-73)', () => {
  it('projects cursor onto a line body with point_on_object inference', () => {
    // Line from (0, 10) to (10, 10). Cursor at (3, 10.4) projects to (3, 10).
    const r = findSnap(query({ x: 3, y: 10.4 }, [line('l1', 0, 10, 10, 10)]))
    expect(r!.kind).toBe('curve')
    expect(r!.point).toEqual({ x: 3, y: 10 })
    expect(r!.sourceEntityIds).toEqual(['l1'])
    expect(r!.inferences).toEqual([
      { kind: 'point_on_object', object: 'l1' },
    ])
  })

  it('projects cursor onto a circle rim with point_on_object inference', () => {
    // Circle centered at (0, 0) r=5. Cursor at (2.5, 4.3) projects onto rim.
    const r = findSnap(query({ x: 2.5, y: 4.3 }, [circle('c1', 0, 0, 5)]))
    expect(r!.kind).toBe('curve')
    const rimDist = Math.hypot(r!.point.x, r!.point.y)
    expect(rimDist).toBeCloseTo(5, 4)
    expect(r!.inferences).toEqual([
      { kind: 'point_on_object', object: 'c1' },
    ])
  })

  it('projects cursor onto an arc body within sweep with point_on_object', () => {
    // Arc 0..pi (upper half). Cursor at (3, 3) projects onto rim.
    const r = findSnap(query({ x: 3, y: 3 }, [arc('a1', 0, 0, 5, 0, Math.PI)]))
    expect(r!.kind).toBe('curve')
    const rimDist = Math.hypot(r!.point.x, r!.point.y)
    expect(rimDist).toBeCloseTo(5, 4)
    expect(r!.inferences).toEqual([
      { kind: 'point_on_object', object: 'a1' },
    ])
  })

  it('does NOT snap outside the snap radius', () => {
    const r = findSnap(query({ x: 3, y: 15 }, [line('l1', 0, 10, 10, 10)]))
    expect(r).toBeNull()
  })

  it('point targets (endpoint) beat curve-body projection', () => {
    // Cursor near a line endpoint AND the line body.  The endpoint
    // should win because it has a lower KIND_RANK and similar distance.
    const r = findSnap(query({ x: 10.3, y: 10.2 }, [line('l1', 0, 10, 10, 10)]))
    expect(r!.kind).toBe('endpoint')
    expect(r!.point).toEqual({ x: 10, y: 10 })
  })

  it('midpoint snap beats curve-body projection', () => {
    // Cursor near the midpoint of a line.
    const r = findSnap(query({ x: 5.3, y: 10.2 }, [line('l1', 0, 10, 10, 10)]))
    expect(r!.kind).toBe('midpoint')
    expect(r!.point).toEqual({ x: 5, y: 10 })
  })

  it('composes with H/V alignment when the projected point aligns', () => {
    // Horizontal line from (0, 5) to (10, 5). Chain previous at (0, 0).
    // Cursor at (3, 5.3) projects to (3, 5) — the segment (0,0)-(3,5)
    // is NOT H/V, so only point_on_object should fire.
    const r = findSnap(query({ x: 3, y: 5.3 }, [line('l1', 0, 5, 10, 5)], {
      alignRef: { x: 0, y: 0 },
    }))
    expect(r!.kind).toBe('curve')
    expect(r!.point).toEqual({ x: 3, y: 5 })
    expect(r!.inferences).toEqual([
      { kind: 'point_on_object', object: 'l1' },
    ])
  })

  it('composes V alignment with point_on_object on a vertical gesture', () => {
    // Horizontal line y=5, chain previous at (3, 0), cursor at (3, 5.3).
    // The projected point (3, 5) aligns V with chain-prev (same X).
    const r = findSnap(query({ x: 3, y: 5.3 }, [line('l1', 0, 5, 10, 5)], {
      alignRef: { x: 3, y: 0 },
    }))
    expect(r!.kind).toBe('curve')
    expect(r!.point).toEqual({ x: 3, y: 5 })
    expect(r!.inferences).toHaveLength(2)
    expect(r!.inferences).toContainEqual({ kind: 'point_on_object', object: 'l1' })
    expect(r!.inferences).toContainEqual({ kind: 'vertical' })
    expect(r!.alignFrom).toEqual({ x: 3, y: 0 })
  })
})

// Sanity: the radius constant the viewport feel depends on.
describe('constants', () => {
  it('snap radius is wider than the 8 px pick tolerance', () => {
    expect(SNAP_PX).toBeGreaterThan(8)
    expect(TOL).toBeCloseTo(1, 9)
  })
})
