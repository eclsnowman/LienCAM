// Headless sketch solver suite (Stage 1 gate, PLAN.md).
//
// Tests call the PURE mapping layer (gcsMapping.ts) against a direct
// GcsWrapper instance in node — no worker involved. The worker is
// transport only; if these pass, the worker's behavior is the message
// envelope, which the store integration exercises later.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper, sketchToGcsPrimitives } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchCircleEntity,
  SketchConstraint, SketchDimension, PointRef,
} from '../../lib/sketch/types'

// ---- builders ------------------------------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function circle(id: string, cx: number, cy: number, r: number): SketchCircleEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}

function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}

function sketch(
  entities: SketchEntity[], constraints: SketchConstraint[], dimensions: SketchDimension[],
): Sketch {
  return {
    id: 'sk', layerId: 'layer',
    entities, constraints, dimensions,
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

// Rectangle: 4 independent lines chained by coincident corners, bottom/top
// horizontal, left/right vertical, driving width/height dims. Seeded with
// PERTURBED corners so the solver has real work to do — a sketch already
// at the solution proves nothing.
//
//   l4.end --- l3(top) --- l3.start
//     |                       |
//   l4(left)              l2(right)
//     |                       |
//   l1.start -- l1(bot) -- l1.end
function rectangleSketch(opts: { fixCorner?: boolean } = {}): Sketch {
  const entities: SketchEntity[] = [
    line('l1', 0.2, -0.3, 39.6, 0.4),    // bottom, ~(0,0)->(40,0)
    line('l2', 40.3, 0.2, 39.7, 29.6),   // right,  ~(40,0)->(40,30)
    line('l3', 40.4, 30.2, 0.3, 29.7),   // top,    ~(40,30)->(0,30)
    line('l4', -0.2, 30.3, 0.4, 0.3),    // left,   ~(0,30)->(0,0)
  ]
  const constraints: SketchConstraint[] = [
    { id: 'c12', kind: 'coincident', a: ref('l1', 'end'),   b: ref('l2', 'start') },
    { id: 'c23', kind: 'coincident', a: ref('l2', 'end'),   b: ref('l3', 'start') },
    { id: 'c34', kind: 'coincident', a: ref('l3', 'end'),   b: ref('l4', 'start') },
    { id: 'c41', kind: 'coincident', a: ref('l4', 'end'),   b: ref('l1', 'start') },
    { id: 'h1',  kind: 'horizontal', line: 'l1' },
    { id: 'h3',  kind: 'horizontal', line: 'l3' },
    { id: 'v2',  kind: 'vertical',   line: 'l2' },
    { id: 'v4',  kind: 'vertical',   line: 'l4' },
  ]
  if (opts.fixCorner) {
    // Ground the bottom-left corner at its seeded position. Grounding is
    // exact (params removed from the solve), so absolute coordinates
    // become assertable: the fixed corner stays at (0.2, -0.3)... no —
    // we seed the FIXED corner exactly at the origin so the expected
    // rectangle is (0,0)-(40,30).
    constraints.push({ id: 'fx', kind: 'fix', point: ref('l1', 'start') })
  }
  const dimensions: SketchDimension[] = [
    { id: 'dw', kind: 'distance', driving: true, value: 40,
      a: ref('l1', 'start'), b: ref('l1', 'end') },
    { id: 'dh', kind: 'distance', driving: true, value: 30,
      a: ref('l2', 'start'), b: ref('l2', 'end') },
  ]
  const sk = sketch(entities, constraints, dimensions)
  if (opts.fixCorner) {
    // Seed the grounded corner exactly at the origin (and its coincident
    // partner l4.end with it) so the fully-defined solution is the exact
    // rectangle (0,0)-(40,30).
    const l1 = sk.entities[0] as SketchLineEntity
    const l4 = sk.entities[3] as SketchLineEntity
    l1.start = { x: 0, y: 0 }
    l4.end   = { x: 0, y: 0 }
  }
  return sk
}

function solvedLine(entities: SketchEntity[], id: string): SketchLineEntity {
  const e = entities.find(x => x.id === id)
  if (!e || e.kind !== 'line') throw new Error(`no line ${id}`)
  return e
}

// ---- a. rectangle ----------------------------------------------------------

describe('rectangle solve', () => {
  it('solves the constrained rectangle and reports DoF', async () => {
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, rectangleSketch())

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const l1 = solvedLine(out.entities, 'l1')
    const l2 = solvedLine(out.entities, 'l2')
    const l3 = solvedLine(out.entities, 'l3')
    const l4 = solvedLine(out.entities, 'l4')

    // Coincident corners actually meet
    expect(l1.end.x).toBeCloseTo(l2.start.x, 6)
    expect(l1.end.y).toBeCloseTo(l2.start.y, 6)
    expect(l3.end.x).toBeCloseTo(l4.start.x, 6)
    expect(l3.end.y).toBeCloseTo(l4.start.y, 6)
    // H/V hold exactly
    expect(l1.start.y).toBeCloseTo(l1.end.y, 6)
    expect(l3.start.y).toBeCloseTo(l3.end.y, 6)
    expect(l2.start.x).toBeCloseTo(l2.end.x, 6)
    expect(l4.start.x).toBeCloseTo(l4.end.x, 6)
    // Driving dims hold: width 40, height 30
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(40, 6)
    expect(Math.hypot(l2.end.x - l2.start.x, l2.end.y - l2.start.y)).toBeCloseTo(30, 6)

    // 8 points (16 params) - 4 coincident (8) - 4 H/V (4) - 2 dims (2)
    // = 2 DoF: the free translation of the rectangle.
    expect(out.status.dof).toBe(2)
    expect(out.status.conflicting).toEqual([])

    gcs.destroy_gcs_module()
  })

  it('fix on one corner -> DoF 0, fully defined, exact positions', async () => {
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, rectangleSketch({ fixCorner: true }))

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.dof).toBe(0)
    expect(out.status.conflicting).toEqual([])
    expect(out.status.redundant).toEqual([])

    // Fully defined -> absolute corner positions are unique: (0,0)-(40,30)
    const l1 = solvedLine(out.entities, 'l1')
    const l3 = solvedLine(out.entities, 'l3')
    expect(l1.start.x).toBeCloseTo(0, 6)
    expect(l1.start.y).toBeCloseTo(0, 6)
    expect(l1.end.x).toBeCloseTo(40, 6)
    expect(l1.end.y).toBeCloseTo(0, 6)
    expect(l3.start.x).toBeCloseTo(40, 6)
    expect(l3.start.y).toBeCloseTo(30, 6)
    expect(l3.end.x).toBeCloseTo(0, 6)
    expect(l3.end.y).toBeCloseTo(30, 6)

    gcs.destroy_gcs_module()
  })
})

// ---- b. over-constrain -----------------------------------------------------

describe('over-constrained sketch', () => {
  it('reports the conflicting set by id and leaves geometry untouched', async () => {
    const gcs = await createGcsWrapper()

    // Last good solve: the fully defined rectangle.
    const sk = rectangleSketch({ fixCorner: true })
    const good = solveSketchOnWrapper(gcs, sk)
    expect(good.ok).toBe(true)
    if (!good.ok) return

    // Adopt the solved geometry (what the store does), then over-constrain:
    // a THIRD dimension contradicting the width (45 vs 40).
    const over: Sketch = {
      ...sk,
      entities: good.entities,
      dimensions: [
        ...sk.dimensions,
        { id: 'dconflict', kind: 'distanceX', driving: true, value: 45,
          a: ref('l1', 'start'), b: ref('l1', 'end') },
      ],
    }
    const entitiesBefore = JSON.parse(JSON.stringify(over.entities))

    const out = solveSketchOnWrapper(gcs, over)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('conflicting')
    expect(out.status.conflicting.length).toBeGreaterThan(0)
    expect(out.status.conflicting).toContain('dconflict')

    // FAIL LOUD, not fake success: no entities returned on failure, and
    // the input document was never mutated -> geometry is still the last
    // good solve.
    expect(over.entities).toEqual(entitiesBefore)

    gcs.destroy_gcs_module()
  })
})

// ---- c. drag ----------------------------------------------------------------

describe('drag solve', () => {
  it('moves a free corner to the target via temporary constraints', async () => {
    const gcs = await createGcsWrapper()

    // Under-defined rectangle (2 DoF translation): drag the bottom-left
    // corner; the whole rectangle must follow with all constraints intact.
    const sk = rectangleSketch()
    const target = { x: 12.5, y: -7.25 }
    const out = solveSketchOnWrapper(gcs, sk, {
      targets: [{ point: ref('l1', 'start'), to: target }],
    })

    expect(out.ok).toBe(true)
    if (!out.ok) return

    const l1 = solvedLine(out.entities, 'l1')
    const l2 = solvedLine(out.entities, 'l2')
    // Dragged point lands on the cursor
    expect(l1.start.x).toBeCloseTo(target.x, 6)
    expect(l1.start.y).toBeCloseTo(target.y, 6)
    // Constraints still satisfied after the drag
    expect(l1.start.y).toBeCloseTo(l1.end.y, 6)                                    // horizontal
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(40, 6) // width
    expect(Math.hypot(l2.end.x - l2.start.x, l2.end.y - l2.start.y)).toBeCloseTo(30, 6) // height
    expect(l1.end.x).toBeCloseTo(l2.start.x, 6)                                    // corner intact
    expect(l1.end.y).toBeCloseTo(l2.start.y, 6)

    // Temporary drag pins must NOT appear in any diagnosis set
    expect(out.status.conflicting).toEqual([])

    gcs.destroy_gcs_module()
  })

  it('drags a whole line rigidly via two simultaneous pins', async () => {
    const gcs = await createGcsWrapper()

    // Pin BOTH endpoints of the bottom edge at orig+delta (how the store
    // drags a line grabbed by its body): the segment must translate
    // rigidly and the rest of the rectangle must follow intact.
    // Settle the perturbed seed first so the two pins are mutually
    // consistent with the driving width (drags always start from a
    // solved document in the app).
    const seed = rectangleSketch()
    const settled = solveSketchOnWrapper(gcs, seed)
    expect(settled.ok).toBe(true)
    if (!settled.ok) return
    const sk: Sketch = { ...seed, entities: settled.entities }
    const l1Before = solvedLine(sk.entities, 'l1')
    const delta = { x: 6, y: -4 }
    const out = solveSketchOnWrapper(gcs, sk, {
      targets: [
        { point: ref('l1', 'start'),
          to: { x: l1Before.start.x + delta.x, y: l1Before.start.y + delta.y } },
        { point: ref('l1', 'end'),
          to: { x: l1Before.end.x + delta.x, y: l1Before.end.y + delta.y } },
      ],
    })

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const l1 = solvedLine(out.entities, 'l1')
    const l2 = solvedLine(out.entities, 'l2')
    expect(l1.start.x).toBeCloseTo(l1Before.start.x + delta.x, 4)
    expect(l1.start.y).toBeCloseTo(l1Before.start.y + delta.y, 4)
    // Constraints intact: width 40, corner still coincident
    expect(Math.hypot(l1.end.x - l1.start.x, l1.end.y - l1.start.y)).toBeCloseTo(40, 4)
    expect(l1.end.x).toBeCloseTo(l2.start.x, 6)
    expect(l1.end.y).toBeCloseTo(l2.start.y, 6)
    expect(out.status.conflicting).toEqual([])

    gcs.destroy_gcs_module()
  })
})

// ---- d. tangent + equal -------------------------------------------------------

describe('tangent and equal constraints', () => {
  it('line-circle tangency and equal-radius circles hold after solve', async () => {
    const gcs = await createGcsWrapper()

    // Grounded horizontal line y=0; c1 seeded NOT tangent (gap 0.5) and
    // c2 with a different radius — the solve must move them.
    const sk = sketch(
      [
        line('l', 0, 0, 50, 0),
        circle('c1', 10, 5.5, 5),
        circle('c2', 30, 9, 6.5),
      ],
      [
        { id: 'fxl', kind: 'fix', entityId: 'l' },
        { id: 'tan', kind: 'tangent', a: 'l', b: 'c1' },
        { id: 'eq',  kind: 'equal',   a: 'c1', b: 'c2' },
      ],
      [],
    )

    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) return

    const c1 = out.entities.find(e => e.id === 'c1') as SketchCircleEntity
    const c2 = out.entities.find(e => e.id === 'c2') as SketchCircleEntity
    // Tangent to the grounded line y=0: |center.y| == radius
    expect(Math.abs(c1.center.y)).toBeCloseTo(c1.radius, 6)
    // Equal radii
    expect(c1.radius).toBeCloseTo(c2.radius, 6)
    expect(out.status.conflicting).toEqual([])

    gcs.destroy_gcs_module()
  })
})

describe('WO-207 native curve solver participation', () => {
  it('materializes ellipse-arc and spline trim endpoints for coincident joints', () => {
    const sk = sketch([
      { id: 'ea', kind: 'elliptical-arc', construction: false, center: { x: 0, y: 0 },
        majorRadius: 8, minorRadius: 4, rotation: 0, startParam: 0, endParam: Math.PI },
      { id: 'sp', kind: 'spline', construction: false, closed: false,
        points: [{ x: 8, y: 0 }, { x: 10, y: 3 }, { x: 12, y: 5 }] },
    ], [
      { id: 'join', kind: 'coincident', a: ref('ea', 'start'), b: ref('sp', 'start') },
      { id: 'native-tangent', kind: 'tangent', a: 'ea', b: 'sp' },
    ], [])
    const prims = sketchToGcsPrimitives(sk)
    expect(prims.some((p) => p.id === 'ea:start' && p.type === 'point')).toBe(true)
    expect(prims.some((p) => p.id === 'ea:end' && p.type === 'point')).toBe(true)
    expect(prims.some((p) => p.id === 'sp:end' && p.type === 'point')).toBe(true)
    expect(prims.some((p) => p.id === 'join' && p.type === 'p2p_coincident')).toBe(true)
  })
})
