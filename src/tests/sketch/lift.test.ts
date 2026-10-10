// lift.ts — Loop2D -> sketch entities (Stage 5). Headless, pure-function
// tests.
//
// Pins the lift boundary contract (PLAN 3.1): lift is bake's inverse —
// line/arc segments map 1:1 to entities (arc center/radius/winding exact),
// bare polylines become line chains, chain joints get coincident
// constraints, NO fix constraints are added. Round-trips both ways:
// lift(bake(x)) == x and bake(lift(loops)) == loops, geometrically.

import { describe, it, expect } from 'vitest'
import { bakeSketch } from '../../lib/sketch/bake'
import { liftLoops } from '../../lib/sketch/lift'
import type { Loop2D, Vec2 } from '../../types'
import type {
  Sketch, SketchArcEntity, SketchCircleEntity, SketchEntity,
  SketchLineEntity,
} from '../../lib/sketch/types'

const LAYER = 'layer-under-test'

function sketchOf(entities: SketchEntity[]): Sketch {
  return {
    id: 'sk', layerId: LAYER, entities, constraints: [], dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

function line(id: string, start: Vec2, end: Vec2): SketchLineEntity {
  return { id, kind: 'line', construction: false, start, end }
}

/** Re-bake lifted entities (lift output is chained by exact coincidence,
 *  so constraints are redundant for bake — but pass them through anyway,
 *  matching how the store will build the document). */
function rebake(loops: Loop2D[]) {
  const { entities, constraints } = liftLoops(loops)
  const sk = sketchOf(entities)
  sk.constraints = constraints
  return bakeSketch(sk)
}

const lines = (es: SketchEntity[]) =>
  es.filter((e): e is SketchLineEntity => e.kind === 'line')
const arcs = (es: SketchEntity[]) =>
  es.filter((e): e is SketchArcEntity => e.kind === 'arc')
const circles = (es: SketchEntity[]) =>
  es.filter((e): e is SketchCircleEntity => e.kind === 'circle')

describe('liftLoops: loops with segments', () => {
  it('rectangle: 4 line entities + 4 coincident joints, geometry exact', () => {
    const baked = bakeSketch(sketchOf([
      line('b', { x: 0, y: 0 }, { x: 60, y: 0 }),
      line('r', { x: 60, y: 0 }, { x: 60, y: 40 }),
      line('t', { x: 60, y: 40 }, { x: 0, y: 40 }),
      line('l', { x: 0, y: 40 }, { x: 0, y: 0 }),
    ]))
    const r = liftLoops(baked.loops)

    expect(r.liftedLoops).toBe(1)
    expect(r.skippedLoops).toBe(0)
    expect(lines(r.entities)).toHaveLength(4)
    expect(arcs(r.entities)).toHaveLength(0)
    // Closed 4-link chain: 3 interior joints + 1 closing joint.
    expect(r.constraints).toHaveLength(4)
    expect(r.constraints.every((c) => c.kind === 'coincident')).toBe(true)

    // lift(bake(x)) == x geometrically: the 4 corner points all appear as
    // entity endpoints, each shared by exactly two lines.
    const corners = [
      { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 },
    ]
    for (const c of corners) {
      const hits = lines(r.entities).filter((l) =>
        (Math.hypot(l.start.x - c.x, l.start.y - c.y) < 1e-9) ||
        (Math.hypot(l.end.x - c.x, l.end.y - c.y) < 1e-9))
      expect(hits).toHaveLength(2)
    }
  })

  it('rectangle: bake(lift(loops)) == loops', () => {
    const baked = bakeSketch(sketchOf([
      line('b', { x: 0, y: 0 }, { x: 60, y: 0 }),
      line('r', { x: 60, y: 0 }, { x: 60, y: 40 }),
      line('t', { x: 60, y: 40 }, { x: 0, y: 40 }),
      line('l', { x: 0, y: 40 }, { x: 0, y: 0 }),
    ]))
    const round = rebake(baked.loops)
    expect(round.loops).toHaveLength(1)
    expect(round.loops[0].closed).toBe(true)
    expect(round.loops[0].type).toBe('contour')
    expect(round.loops[0].area).toBeCloseTo(2400, 9)
    expect(round.loops[0].segments).toHaveLength(4)
    expect(round.loops[0].segments!.every((s) => s.type === 'line')).toBe(true)
  })

  it('circle: single full-circle arc segment -> circle entity, exact round-trip', () => {
    const circle: SketchEntity = {
      id: 'c', kind: 'circle', construction: false,
      center: { x: 5, y: -3 }, radius: 7,
    }
    const baked = bakeSketch(sketchOf([circle]))
    expect(baked.loops).toHaveLength(1)

    const r = liftLoops(baked.loops)
    expect(r.entities).toHaveLength(1)
    expect(circles(r.entities)).toHaveLength(1)
    expect(circles(r.entities)[0].center).toEqual({ x: 5, y: -3 })
    expect(circles(r.entities)[0].radius).toBe(7)
    // A single closed entity has no joints — no constraints.
    expect(r.constraints).toHaveLength(0)

    const round = rebake(baked.loops)
    expect(round.loops).toHaveLength(1)
    expect(round.loops[0].closed).toBe(true)
    expect(round.loops[0].area).toBeCloseTo(baked.loops[0].area, 9)
    const seg = round.loops[0].segments![0]
    expect(seg.type).toBe('arc')
    if (seg.type === 'arc') {
      expect(seg.center).toEqual({ x: 5, y: -3 })
      expect(seg.radius).toBe(7)
    }
  })

  it('mixed line+arc loop (D-shape): arc center/radius/winding round-trip', () => {
    // Diameter line (-10,0)->(10,0) + CCW semicircle back over the top.
    const arc: SketchEntity = {
      id: 'a', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI,
    }
    const baked = bakeSketch(sketchOf([
      line('d', { x: -10, y: 0 }, { x: 10, y: 0 }),
      arc,
    ]))
    expect(baked.loops).toHaveLength(1)
    expect(baked.loops[0].closed).toBe(true)

    const r = liftLoops(baked.loops)
    expect(lines(r.entities)).toHaveLength(1)
    expect(arcs(r.entities)).toHaveLength(1)
    expect(r.constraints).toHaveLength(2)
    const a = arcs(r.entities)[0]
    expect(a.center.x).toBeCloseTo(0, 9)
    expect(a.center.y).toBeCloseTo(0, 9)
    expect(a.radius).toBeCloseTo(10, 9)
    // lift(bake(x)) == x: same CCW semicircle (start 0 -> end pi).
    expect(a.startAngle).toBeCloseTo(0, 9)
    expect(a.endAngle).toBeCloseTo(Math.PI, 9)

    const round = rebake(baked.loops)
    expect(round.loops).toHaveLength(1)
    expect(round.loops[0].closed).toBe(true)
    expect(round.loops[0].type).toBe('contour')
    expect(round.loops[0].area).toBeCloseTo(baked.loops[0].area, 9)
    const kinds = round.loops[0].segments!.map((s) => s.type).sort()
    expect(kinds).toEqual(['arc', 'line'])
  })

  it('clockwise arc in a HOLE chain: sites swap, nesting survives re-bake', () => {
    // Outer rectangle + inner D-shape; the inner loop bakes as a CW hole,
    // so its arc LoopSegment is clockwise — the lift must store it as a
    // CCW entity with swapped endpoint sites.
    const inner: SketchEntity[] = [
      line('d', { x: -10, y: 0 }, { x: 10, y: 0 }),
      {
        id: 'a', kind: 'arc', construction: false,
        center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI,
      },
    ]
    const outer = [
      line('b', { x: -30, y: -20 }, { x: 30, y: -20 }),
      line('r', { x: 30, y: -20 }, { x: 30, y: 30 }),
      line('t', { x: 30, y: 30 }, { x: -30, y: 30 }),
      line('l', { x: -30, y: 30 }, { x: -30, y: -20 }),
    ]
    const baked = bakeSketch(sketchOf([...outer, ...inner]))
    const hole = baked.loops.find((l) => l.type === 'hole')!
    expect(hole).toBeDefined()
    expect(hole.segments!.some((s) => s.type === 'arc' && s.clockwise)).toBe(true)

    const r = liftLoops([hole])
    const a = arcs(r.entities)[0]
    // Entity is canonical CCW: sweeping start->end CCW retraces the
    // SAME semicircle (0 -> pi about the origin).
    expect(a.startAngle).toBeCloseTo(0, 9)
    expect(a.endAngle).toBeCloseTo(Math.PI, 9)

    const round = rebake(baked.loops)
    expect(round.loops).toHaveLength(2)
    const holes = round.loops.filter((l) => l.type === 'hole')
    expect(holes).toHaveLength(1)
    expect(holes[0].area).toBeCloseTo(hole.area, 9)
  })
})

describe('liftLoops: bare polylines (no segments[])', () => {
  it('closed polyline -> closed line chain with closing joint', () => {
    const tri: Loop2D = {
      id: 't', layerId: LAYER, closed: true, type: 'contour', area: 50,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
    }
    const r = liftLoops([tri])
    expect(lines(r.entities)).toHaveLength(3)
    expect(r.constraints).toHaveLength(3)
    // Closing edge runs back to points[0].
    const closing = lines(r.entities)[2]
    expect(closing.start).toEqual({ x: 0, y: 10 })
    expect(closing.end).toEqual({ x: 0, y: 0 })

    const round = rebake([tri])
    expect(round.loops).toHaveLength(1)
    expect(round.loops[0].closed).toBe(true)
    expect(round.loops[0].area).toBeCloseTo(50, 9)
  })

  it('open polyline -> open chain, interior joints only, bakes open', () => {
    const poly: Loop2D = {
      id: 'p', layerId: LAYER, closed: false, type: 'open', area: 0,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 }],
    }
    const r = liftLoops([poly])
    expect(lines(r.entities)).toHaveLength(2)
    expect(r.constraints).toHaveLength(1)

    const round = rebake([poly])
    expect(round.loops).toHaveLength(1)
    expect(round.loops[0].closed).toBe(false)
    expect(round.loops[0].type).toBe('open')
  })

  it('zero-length polyline edges are skipped; degenerate loops counted', () => {
    const withDup: Loop2D = {
      id: 'd', layerId: LAYER, closed: false, type: 'open', area: 0,
      points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }],
    }
    const degenerate: Loop2D = {
      id: 'z', layerId: LAYER, closed: false, type: 'open', area: 0,
      points: [{ x: 3, y: 3 }, { x: 3, y: 3 }],
    }
    const r = liftLoops([withDup, degenerate])
    expect(lines(r.entities)).toHaveLength(1)
    expect(r.liftedLoops).toBe(1)
    expect(r.skippedLoops).toBe(1)
  })
})

describe('liftLoops: contract details', () => {
  it('adds NO fix constraints (under-defined blue is correct)', () => {
    const baked = bakeSketch(sketchOf([
      line('b', { x: 0, y: 0 }, { x: 60, y: 0 }),
      line('r', { x: 60, y: 0 }, { x: 60, y: 40 }),
      line('t', { x: 60, y: 40 }, { x: 0, y: 40 }),
      line('l', { x: 0, y: 40 }, { x: 0, y: 0 }),
    ]))
    const r = liftLoops(baked.loops)
    expect(r.constraints.every((c) => c.kind === 'coincident')).toBe(true)
  })

  it('coincident joints reference the geometrically matching sites', () => {
    const baked = bakeSketch(sketchOf([
      line('b', { x: 0, y: 0 }, { x: 10, y: 0 }),
      line('r', { x: 10, y: 0 }, { x: 10, y: 10 }),
      line('t', { x: 10, y: 10 }, { x: 0, y: 10 }),
      line('l', { x: 0, y: 10 }, { x: 0, y: 0 }),
    ]))
    const r = liftLoops(baked.loops)
    const byId = new Map(r.entities.map((e) => [e.id, e]))
    for (const c of r.constraints) {
      const ea = byId.get(c.a.entityId) as SketchLineEntity
      const eb = byId.get(c.b.entityId) as SketchLineEntity
      const pa = c.a.site === 'start' ? ea.start : ea.end
      const pb = c.b.site === 'start' ? eb.start : eb.end
      expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeLessThan(1e-9)
    }
  })

  it('deterministic with an injected id factory', () => {
    let n = 0
    const tri: Loop2D = {
      id: 't', layerId: LAYER, closed: true, type: 'contour', area: 50,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
    }
    const r = liftLoops([tri], { newId: () => `id-${n++}` })
    expect(r.entities.map((e) => e.id)).toEqual(['id-0', 'id-1', 'id-2'])
  })
})
