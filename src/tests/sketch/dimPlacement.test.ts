// Smart-dimension PLACEMENT resolver (Tier 1a, live drag-to-place):
// orientation auto-pick from the drag vector + the SINGLE source of truth
// for both the live witness preview and the commit (preview === commit).

import { describe, it, expect } from 'vitest'
import {
  resolveDimPlacement, pickDimOrientation, arrowHead, dimGuides,
  initialDimPlacementOffsetLimit,
} from '../../lib/sketch/tools/dimPlacement'
import {
  dimToolClick, measureDimension, planDimension,
} from '../../lib/sketch/tools/dimTool'
import { toolClick } from '../../lib/sketch/tools/toolMachine'
import type { SketchEntity, Vec2 } from '../../lib/sketch/types'
import {
  injectSketchAnchors,
  SKETCH_AXIS_Y_ENTITY_ID,
} from '../../lib/sketch/sketchAnchors'

// ---- fixtures ---------------------------------------------------------------

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function circle(id: string, cx: number, cy: number, r: number): SketchEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}
function arc(id: string, cx: number, cy: number, r: number): SketchEntity {
  return { id, kind: 'arc', construction: false, center: { x: cx, y: cy },
    radius: r, startAngle: 0.2, endAngle: 2.0 }
}
function point(id: string, x: number, y: number): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x, y } }
}
function ellipse(
  id: string, cx: number, cy: number, major: number, minor: number, rot = 0,
): SketchEntity {
  return { id, kind: 'ellipse', construction: false,
    center: { x: cx, y: cy }, majorRadius: major, minorRadius: minor, rotation: rot }
}

// la horizontal len 10; lc vertical (90 deg to la); diag 3-4-5 point pair;
// pa + la for point-to-line; circle/arc for radius/diameter.
const ENTITIES: SketchEntity[] = [
  line('la', 0, 0, 10, 0),
  line('lc', 20, 0, 20, 8),
  line('diag', 0, 0, 4, 3), // length 5, dx 4, dy 3
  circle('ca', 40, 0, 4),
  arc('ar', 60, 0, 6),
  point('pa', 0, 20),
  point('p0', 0, 0), point('p1', 4, 3), // diagonal pair (3-4-5)
  ellipse('el', 80, 0, 10, 5),           // axis-aligned: major +X, minor +Y
  ellipse('elr', 200, 0, 10, 5, Math.PI / 2), // rotated 90 deg: major +Y (kept clear)
]

const newIds = () => {
  let n = 0
  return () => `id${n++}`
}

// ---- orientation auto-pick (the headline rule) -------------------------------

describe('pickDimOrientation', () => {
  // NEW SEMANTICS (the flip): orientation follows the DRAG DIRECTION, not a
  // drag ALONG the segment. Aligned is the natural perpendicular SIDE pull on
  // a diagonal feature; a vertical offset (label above/below) measures the
  // horizontal extent (distanceX = 'x'); a horizontal offset (label
  // left/right) measures the vertical extent (distanceY = 'y'). The OLD rule
  // returned 'aligned' only for a drag ALONG the segment, which the natural
  // perpendicular pull never satisfied -- so aligned was unreachable.
  const pa: Vec2 = { x: 0, y: 0 }
  const pb: Vec2 = { x: 10, y: 10 } // 45-deg diagonal, midpoint (5,5)

  it('perpendicular SIDE pull -> aligned (the natural aligned gesture)', () => {
    // Normal to a 45-deg line is the (-1,1)/(1,-1) axis; pull to either side.
    expect(pickDimOrientation(pa, pb, { x: 1, y: 9 })).toBe('aligned')
    expect(pickDimOrientation(pa, pb, { x: 9, y: 1 })).toBe('aligned')
  })

  it('vertical offset (label above/below a diagonal) -> distanceX', () => {
    expect(pickDimOrientation(pa, pb, { x: 5, y: 12 })).toBe('x')
    expect(pickDimOrientation(pa, pb, { x: 5, y: -2 })).toBe('x')
  })

  it('horizontal offset (label left/right of a diagonal) -> distanceY', () => {
    expect(pickDimOrientation(pa, pb, { x: 12, y: 5 })).toBe('y')
    expect(pickDimOrientation(pa, pb, { x: -2, y: 5 })).toBe('y')
  })

  it('WIDER aligned cone: a MODERATE pull toward the normal still -> aligned', () => {
    // 45-deg diagonal, normal at 135 deg. Cursor (2,13) -> offset (-3,8) from
    // the midpoint (5,5), i.e. drag direction ~110.6 deg. That is CLOSER to the
    // world-Y axis (delta ~20.6 deg) than to the feature normal (delta ~24.4
    // deg), so the OLD nearest-axis rule resolved this to 'x'. The ALIGN_BIAS
    // now hands it to 'aligned' (24.4 <= 20.6 + 18), proving the aligned
    // capture region is wider than an even three-way split.
    expect(pickDimOrientation(pa, pb, { x: 2, y: 13 })).toBe('aligned')
  })

  it('dominantly VERTICAL drag off a HORIZONTAL segment -> distanceX', () => {
    // Horizontal segment: aligned is dropped (redundant); up/down -> distanceX.
    const a: Vec2 = { x: 0, y: 0 }, b: Vec2 = { x: 10, y: 0 }
    expect(pickDimOrientation(a, b, { x: 5, y: 9 })).toBe('x')
    expect(pickDimOrientation(a, b, { x: 5, y: -9 })).toBe('x')
  })

  it('dominantly HORIZONTAL drag off a VERTICAL segment -> distanceY', () => {
    expect(pickDimOrientation({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 9, y: 5 })).toBe('y')
  })

  // SKC-74 (Operator, from the road, chrome_LUmf8eAbg4.png): a cursor positioned
  // near ONE END of a TALL/WIDE near-axis segment (not near its mid-
  // height/width) used to need a sideways drag proportional to its distance
  // from the segment's geometric MIDPOINT before the H/V pick would flip --
  // "I have to drag too far off the line to have it switch... comically
  // far". Real-app repro (coordination/evidence/SKC-DIM-BUGS/): a 120mm
  // vertical edge, cursor at 55mm above the segment's OWN midpoint (near its
  // top end) -- pre-fix this stayed 'x' (Horizontal, value 0.00) until the
  // rightward drag exceeded ~55mm; post-fix a small sideways drag flips it
  // immediately, because the offset is now measured from the cursor's own
  // foot on the segment (any height beside a TALL line is a pure side
  // pull), not the fixed midpoint.
  it('SKC-74: near-axis flip is INDEPENDENT of how far from mid-height/width the cursor sits', () => {
    const a: Vec2 = { x: 60, y: 0 }, b: Vec2 = { x: 60, y: 120 } // tall vertical edge, mid y=60
    // Cursor near the TOP end (y=115, 55mm above mid) with only a SMALL
    // rightward drag: must resolve 'y' (Vertical/distanceY) immediately --
    // the old midpoint-referenced formula stayed 'x' (Horizontal) here all
    // the way out past dx=55.
    expect(pickDimOrientation(a, b, { x: 65, y: 115 })).toBe('y')
    expect(pickDimOrientation(a, b, { x: 62, y: 118 })).toBe('y')
    // Symmetric near the BOTTOM end.
    expect(pickDimOrientation(a, b, { x: 65, y: 5 })).toBe('y')
    // A cursor genuinely PAST an end (beyond the segment's own span, an
    // along-the-line drag) still resolves 'x' (Horizontal) -- the
    // deliberate "drag off the end" gesture is unchanged by this fix.
    expect(pickDimOrientation(a, b, { x: 61, y: 200 })).toBe('x')
  })

  it('near-axis segment DROPS aligned: even a near-parallel drag is not aligned', () => {
    // Horizontal segment, drag ALONG it (the OLD aligned gesture): now the
    // aligned candidate is dropped, so the nearest world axis (X) -> 'y'.
    const a: Vec2 = { x: 0, y: 0 }, b: Vec2 = { x: 10, y: 0 }
    expect(pickDimOrientation(a, b, { x: 15, y: 0 })).not.toBe('aligned')
  })

  it('cursor on the midpoint of a DIAGONAL (no drag) defaults to aligned', () => {
    expect(pickDimOrientation(pa, pb, { x: 5, y: 5 })).toBe('aligned')
  })

  it('cursor on the midpoint of a HORIZONTAL segment defaults to distanceX', () => {
    // No drag + near-axis: default to the dimension that measures the feature
    // (a horizontal line's length -> distanceX), never the meaningless aligned.
    expect(pickDimOrientation({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 })).toBe('x')
  })
})

describe('SKC-72 initial dimension-placement clamp', () => {
  it('uses the shared geometry-relative sane band for tiny, normal, and huge spans', () => {
    expect(initialDimPlacementOffsetLimit(0.1)).toBe(0.5)
    expect(initialDimPlacementOffsetLimit(10)).toBeCloseTo(3.5, 9)
    expect(initialDimPlacementOffsetLimit(1000)).toBe(25)
  })

  it('keeps a nearby first drop unchanged but clamps a stray far click', () => {
    const near = resolveDimPlacement(
      [line('normal', 0, 0, 10, 0)], ['normal'], { x: 5, y: 2 }, { clampInitial: true },
    )!
    expect(near.labelAnchor).toEqual({ x: 5, y: 2 })

    const farCursor = { x: 5, y: 100 }
    const far = resolveDimPlacement(
      [line('normal', 0, 0, 10, 0)], ['normal'], farCursor, { clampInitial: true },
    )!
    expect(far.labelAnchor.x).toBeCloseTo(5, 9)
    expect(far.labelAnchor.y).toBeCloseTo(3.5, 9)
    expect(far.labelAnchor).not.toEqual(farCursor)
    expect(far.guides.flat().some((point) => point.y === farCursor.y)).toBe(false)
  })

  it('commits the same clamped anchor returned by the shared preview resolver', () => {
    const entities = [line('host-shared', 0, 0, 50, 0)]
    const cursor = { x: 25, y: -170 }
    const placement = resolveDimPlacement(
      entities, ['host-shared'], cursor, { clampInitial: true },
    )!
    const committed = dimToolClick(
      { kind: 'dim', operandIds: ['host-shared'] },
      cursor,
      0.5,
      entities,
      newIds(),
    ).dimension!
    const throughSharedHostController = toolClick(
      {
        tool: 'smart-dimension',
        chain: { kind: 'dim', operandIds: ['host-shared'] },
      },
      cursor,
      0.5,
      newIds(),
      { entities },
    ).commit?.dimensions?.[0]

    // CAM and Model both enter through toolController -> toolClick ->
    // dimToolClick, so this shared seam is the host-parity contract.
    expect(committed.labelAnchor).toEqual(placement.labelAnchor)
    expect(committed.labelAnchor).toEqual({ x: 25, y: -17.5 })
    expect(throughSharedHostController?.labelAnchor).toEqual(placement.labelAnchor)
  })
})

// ---- resolveDimPlacement: every operand combination --------------------------

describe('resolveDimPlacement', () => {
  it('two points, perpendicular-ish vertical drag -> distanceX, value = |dx|', () => {
    const r = resolveDimPlacement(ENTITIES, ['p0', 'p1'], { x: 2, y: 20 })!
    expect(r.kind).toBe('distanceX')
    expect(r.value).toBeCloseTo(4, 9) // |4 - 0|
    expect(r.value).toBeGreaterThan(0) // normalized positive
    expect(r.labelAnchor).toEqual({ x: 2, y: 20 })
    expect(r.guides.length).toBeGreaterThanOrEqual(3)
  })

  it('two points, dominantly horizontal drag -> distanceY, value = |dy|', () => {
    const r = resolveDimPlacement(ENTITIES, ['p0', 'p1'], { x: 14, y: 1.5 })!
    expect(r.kind).toBe('distanceY')
    expect(r.value).toBeCloseTo(3, 9) // |3 - 0|
  })

  it('two points, PERPENDICULAR side pull -> aligned distance (true length)', () => {
    // Pull the label to the side of the 3-4-5 diagonal (along its normal
    // (-3,4) from the midpoint (2,1.5)) -> aligned true length. (Was a drag
    // ALONG the segment under the old inverted rule.)
    const r = resolveDimPlacement(ENTITIES, ['p0', 'p1'], { x: -1, y: 5.5 })!
    expect(r.kind).toBe('distance')
    expect(r.value).toBeCloseTo(5, 9)
  })

  it('distanceX/Y reorder operands so the stored value stays positive', () => {
    // Click p1 first then p0 (reversed): value must still be positive.
    const r = resolveDimPlacement(ENTITIES, ['p1', 'p0'], { x: 2, y: 20 })!
    expect(r.kind).toBe('distanceX')
    expect(r.value).toBeCloseTo(4, 9)
    expect(r.value).toBeGreaterThan(0)
  })

  it('single HORIZONTAL line -> distanceX on an above/below drag (aligned dropped)', () => {
    // Above the horizontal line: vertical offset -> distanceX (its length).
    // A horizontal feature never yields 'aligned' -- that would be redundant.
    const x = resolveDimPlacement(ENTITIES, ['la'], { x: 5, y: 9 })!
    expect(x.kind).toBe('distanceX')
    expect(x.value).toBeCloseTo(10, 9)
  })

  it('single DIAGONAL line -> aligned length on a perpendicular side pull', () => {
    // diag 0,0->4,3 (len 5). Pull to the side (along its normal) -> aligned.
    const a = resolveDimPlacement(ENTITIES, ['diag'], { x: -1, y: 5.5 })!
    expect(a.kind).toBe('distance')
    expect(a.value).toBeCloseTo(5, 9)
  })

  it('point + line -> distancePL (no orientation pick), value = perp distance', () => {
    const r = resolveDimPlacement(ENTITIES, ['pa', 'la'], { x: 5, y: 10 })!
    expect(r.kind).toBe('distancePL')
    expect(r.value).toBeCloseTo(20, 9)
    expect(r.guides.length).toBeGreaterThanOrEqual(2)
  })

  it('two lines -> angle (radians), arc + two extension guides', () => {
    // WO SKC-56 / SKC-58B: la/lc meet at 90deg -- the one magnitude where the
    // near and far sectors share the same |angle| (near +pi/2; far, under
    // SKC-58B's signed reversed-operand convention, -pi/2). This fixture alone
    // therefore cannot pin the sector's SIGN, only its magnitude; the signed
    // far branch is proven in angleSector.skc56.test.ts (a non-90deg pair) and
    // the no-motion commit in skc58AngleDimNoMotion.test.ts. Assert |value|.
    const r = resolveDimPlacement(ENTITIES, ['la', 'lc'], { x: 15, y: 5 })!
    expect(r.kind).toBe('angle')
    expect(Math.abs(r.value)).toBeCloseTo(Math.PI / 2, 9)
    expect(r.guides).toHaveLength(3) // [arc, extA, extB]
    expect(r.guides[0].length).toBeGreaterThan(10) // tessellated arc
  })

  it('circle -> diameter; arc -> radius (no orientation pick)', () => {
    const d = resolveDimPlacement(ENTITIES, ['ca'], { x: 44, y: 4 })!
    expect(d.kind).toBe('diameter')
    expect(d.value).toBeCloseTo(8, 9)
    const rr = resolveDimPlacement(ENTITIES, ['ar'], { x: 66, y: 6 })!
    expect(rr.kind).toBe('radius')
    expect(rr.value).toBeCloseTo(6, 9)
  })

  it('incomplete / invalid operand sets return null (no witness preview)', () => {
    expect(resolveDimPlacement(ENTITIES, [], { x: 0, y: 0 })).toBeNull()
    expect(resolveDimPlacement(ENTITIES, ['pa'], { x: 0, y: 0 })).toBeNull() // lone point
    expect(resolveDimPlacement(ENTITIES, ['ca', 'pa'], { x: 0, y: 0 })).toBeNull() // bad combo
  })
})

// ---- point-to-line / parallel-line MOVABLE bar (T6/T7) -----------------------
//
// The reported bug: dimensioning point+line or two parallel lines clamped a
// FIXED perpendicular witness you could not carry outside the features. The
// fix makes distancePL draw the SAME movable offset bar as a two-point
// distance: measured pair = (point, its perpendicular foot on the line), the
// label anchor slides the bar along the line. placeLinearDim emits 5
// polylines: [witness@a, witness@b, bar, tick, tick]; guides[2] is the bar.

describe('resolveDimPlacement: distancePL movable offset bar', () => {
  it('point + line: witness feet + a movable bar carried outside the features', () => {
    // pa(0,20), la is y=0 -> foot (0,0); bar slides horizontally with anchor.x.
    const r1 = resolveDimPlacement(ENTITIES, ['pa', 'la'], { x: 5, y: 10 })!
    expect(r1.kind).toBe('distancePL')
    expect(r1.value).toBeCloseTo(20, 9)
    expect(r1.guides).toHaveLength(5)
    // Witness extension lines start AT the measured features (point + foot).
    expect(r1.guides[0][0]).toEqual({ x: 0, y: 20 }) // the point
    expect(r1.guides[1][0]).toEqual({ x: 0, y: 0 })  // the perpendicular foot
    // The bar (guides[2]) sits at the offset and equals the true perp distance.
    const bar1 = r1.guides[2]
    expect(bar1[0].x).toBeCloseTo(5, 9)
    expect(bar1[1].x).toBeCloseTo(5, 9)
    expect(Math.hypot(bar1[1].x - bar1[0].x, bar1[1].y - bar1[0].y)).toBeCloseTo(20, 9)
    // Dragging the anchor carries the bar OUTSIDE (offset follows the cursor).
    const r2 = resolveDimPlacement(ENTITIES, ['pa', 'la'], { x: 14, y: 10 })!
    expect(r2.guides[2][0].x).toBeCloseTo(14, 9)
    expect(r2.guides[2][0].x).not.toBeCloseTo(bar1[0].x, 1)
  })

  it('two parallel lines: same movable bar, length = the perpendicular gap', () => {
    const ents = [line('la', 0, 0, 10, 0), line('lb', 0, 5, 10, 5)]
    const r = resolveDimPlacement(ents, ['la', 'lb'], { x: 3, y: 10 })!
    expect(r.kind).toBe('distancePL')
    expect(r.value).toBeCloseTo(5, 9)
    expect(r.guides).toHaveLength(5)
    const bar = r.guides[2]
    expect(Math.hypot(bar[1].x - bar[0].x, bar[1].y - bar[0].y)).toBeCloseTo(5, 9)
    expect(bar[0].x).toBeCloseTo(3, 9) // slid along the line by anchor.x
  })

  it('angled line + point: the bar runs PERPENDICULAR to the line (auto)', () => {
    const ents = [line('diag', 0, 0, 4, 3), point('pa', 0, 20)]
    const r = resolveDimPlacement(ents, ['pa', 'diag'], { x: 5, y: 5 })!
    expect(r.kind).toBe('distancePL')
    const bar = r.guides[2]
    const bd = { x: bar[1].x - bar[0].x, y: bar[1].y - bar[0].y }
    expect(bd.x * 4 + bd.y * 3).toBeCloseTo(0, 6) // perpendicular to dir (4,3)
  })

  it('axis + parallel line is order-independent and never draws from the 100 m axis endpoint', () => {
    const userLine = line('left-side', -50, 25, -50, -25)
    const sketch = injectSketchAnchors({
      id: 'axis-distance-repro',
      layerId: 'plane:xy',
      entities: [userLine],
      constraints: [],
      dimensions: [],
      solveStatus: null,
    }, { x: 0, y: 0 })

    for (const ops of [
      [SKETCH_AXIS_Y_ENTITY_ID, userLine.id],
      [userLine.id, SKETCH_AXIS_Y_ENTITY_ID],
    ]) {
      const planned = planDimension(sketch.entities, ops)
      expect(planned.ok).toBe(true)
      if (!planned.ok || planned.plan.kind !== 'distancePL') {
        throw new Error('expected axis-to-line distancePL')
      }
      expect(planned.plan.point).toEqual({ entityId: userLine.id, site: 'start' })
      expect(planned.plan.line).toBe(SKETCH_AXIS_Y_ENTITY_ID)
      expect(planned.plan.value).toBeCloseTo(50, 9)
    }

    // Exact operand shape and label anchor from Operator's debug export. This is
    // the pre-normalization persisted form that produced the two giant rays.
    const legacy = {
      kind: 'distancePL' as const,
      point: { entityId: SKETCH_AXIS_Y_ENTITY_ID, site: 'start' as const },
      line: userLine.id,
      value: 50,
    }
    const guides = dimGuides(
      sketch.entities,
      legacy,
      { x: -38.6638419297593, y: 33.239777374162216 },
      1,
    )
    expect(guides).toHaveLength(5)
    expect(Math.max(...guides.flat().map((guidePoint) => Math.abs(guidePoint.y))))
      .toBeLessThan(40)
    const bar = guides[2]
    expect(Math.hypot(
      bar[1].x - bar[0].x,
      bar[1].y - bar[0].y,
    )).toBeCloseTo(50, 9)
  })
})

// ---- forced orientation (Tab override of the auto-snap) ----------------------

describe('resolveDimPlacement: forced orientation', () => {
  it('forceOrientation OVERRIDES the drag-vector auto-snap (distance family)', () => {
    // Cursor where auto-snap picks distanceX (dominantly vertical drag).
    expect(resolveDimPlacement(ENTITIES, ['p0', 'p1'], { x: 2, y: 20 })!.kind)
      .toBe('distanceX')
    // Force aligned -> true length; force y -> distanceY; force x stays X.
    const al = resolveDimPlacement(ENTITIES, ['p0', 'p1'], { x: 2, y: 20 },
      { forceOrientation: 'aligned' })!
    expect(al.kind).toBe('distance')
    expect(al.value).toBeCloseTo(5, 9)
    const fy = resolveDimPlacement(ENTITIES, ['p0', 'p1'], { x: 2, y: 20 },
      { forceOrientation: 'y' })!
    expect(fy.kind).toBe('distanceY')
    expect(fy.value).toBeCloseTo(3, 9)
  })

  it('Tab override forces aligned/x/y regardless of the drag direction', () => {
    // Same cursor (a perpendicular side pull that auto-picks aligned); each
    // forced mode must WIN over the auto-pick.
    const c: Vec2 = { x: -1, y: 5.5 }
    expect(resolveDimPlacement(ENTITIES, ['p0', 'p1'], c)!.kind).toBe('distance')
    expect(resolveDimPlacement(ENTITIES, ['p0', 'p1'], c,
      { forceOrientation: 'aligned' })!.kind).toBe('distance')
    expect(resolveDimPlacement(ENTITIES, ['p0', 'p1'], c,
      { forceOrientation: 'x' })!.kind).toBe('distanceX')
    expect(resolveDimPlacement(ENTITIES, ['p0', 'p1'], c,
      { forceOrientation: 'y' })!.kind).toBe('distanceY')
  })

  it('null forceOrientation falls back to auto-snap (regression: unchanged)', () => {
    const a = resolveDimPlacement(ENTITIES, ['p0', 'p1'], { x: -1, y: 5.5 },
      { forceOrientation: null })!
    expect(a.kind).toBe('distance') // aligned via the perpendicular side pull
    expect(a.value).toBeCloseTo(5, 9)
  })
})

// ---- preview === commit ------------------------------------------------------

describe('placement: preview equals commit', () => {
  const TOL = 0.5

  const cases: Array<{ ops: string[]; cursor: Vec2; note: string }> = [
    { ops: ['p0', 'p1'], cursor: { x: 2, y: 20 }, note: 'two points -> distanceX' },
    { ops: ['p0', 'p1'], cursor: { x: 14, y: 1.5 }, note: 'two points -> distanceY' },
    { ops: ['p0', 'p1'], cursor: { x: -1, y: 5.5 }, note: 'two points -> aligned' },
    { ops: ['la'], cursor: { x: 5, y: 9 }, note: 'single line -> distanceX' },
    { ops: ['pa', 'la'], cursor: { x: 5, y: 10 }, note: 'point+line -> distancePL' },
    { ops: ['la', 'lc'], cursor: { x: 15, y: 5 }, note: 'two lines -> angle' },
    { ops: ['ca'], cursor: { x: 44, y: 4 }, note: 'circle -> diameter' },
    { ops: ['ar'], cursor: { x: 66, y: 6 }, note: 'arc -> radius' },
    { ops: ['el'], cursor: { x: 95, y: 0 }, note: 'ellipse pulled along major axis -> majorRadius' },
    { ops: ['el'], cursor: { x: 80, y: 12 }, note: 'ellipse pulled along minor axis -> minorRadius' },
  ]

  for (const c of cases) {
    it(`commit matches the resolver (${c.note})`, () => {
      const placement = resolveDimPlacement(
        ENTITIES, c.ops, c.cursor, { clampInitial: true },
      )!
      const chain = { kind: 'dim' as const, operandIds: c.ops }
      const out = dimToolClick(chain, c.cursor, TOL, ENTITIES, newIds())
      const d = out.dimension!
      expect(d.kind).toBe(placement.kind)
      expect(d.value).toBeCloseTo(placement.value, 9)
      expect(d.labelAnchor).toEqual(placement.labelAnchor)
      // The committed dimension, re-measured against the geometry, equals
      // the value the resolver reported (signed measure matches the
      // normalized-positive stored value because operands were ordered).
      const m = measureDimension(ENTITIES, d)!
      expect(m).toBeCloseTo(placement.value, 9)
    })
  }
})

// ---- ellipse major-vs-minor axis pick (mirrors distance -> distanceX/Y) ------

describe('resolveDimPlacement: ellipse major vs minor axis pick', () => {
  it('label pulled toward the major axis -> majorRadius', () => {
    const p = resolveDimPlacement(ENTITIES, ['el'], { x: 95, y: 0 })!
    expect(p.kind).toBe('majorRadius')
    expect(p.value).toBeCloseTo(10, 9)
  })
  it('label pulled toward the minor axis -> minorRadius', () => {
    const p = resolveDimPlacement(ENTITIES, ['el'], { x: 80, y: 12 })!
    expect(p.kind).toBe('minorRadius')
    expect(p.value).toBeCloseTo(5, 9)
  })
  it('decides in the ellipse rotation frame (90 deg: +Y is the MAJOR axis)', () => {
    // 'elr' is rotated 90 deg, so its major axis points +Y. A +Y pull picks
    // major; a +X pull picks minor -- proving the decision is frame-relative.
    expect(resolveDimPlacement(ENTITIES, ['elr'], { x: 200, y: 15 })!.kind).toBe('majorRadius')
    expect(resolveDimPlacement(ENTITIES, ['elr'], { x: 215, y: 0 })!.kind).toBe('minorRadius')
  })
})

// ---- ellipse major/minor radius: CLEAN ON-AXIS leader (odd-angle fix) --------
//
// The reported problem: the major/minor radius leader ran from the ellipse
// center to wherever the label was dropped -- an arbitrary OFF-AXIS angle that
// gave no cue which axis it measured. The leader now lies ALONG the real axis
// (respecting the ellipse rotation): center -> on-axis label, plus a witness
// tick at the axis VERTEX (center + radius * axisDir). Proven under a NON-ZERO
// rotation so the axis-alignment cannot be an artifact of an axis-aligned case.

describe('resolveDimPlacement: ellipse radius leader lies ON the axis', () => {
  const ROT = 0.6
  const c = Math.cos(ROT), s = Math.sin(ROT)
  const er: SketchEntity = ellipse('er', 0, 0, 10, 5, ROT) // major 10, minor 5

  it('major-radius leader runs along the MAJOR axis; vertex at center + major*[cos,sin]', () => {
    // Pull the label out along the +major axis, past the vertex.
    const cursor: Vec2 = { x: 15 * c, y: 15 * s }
    const r = resolveDimPlacement([er], ['er'], cursor)!
    expect(r.kind).toBe('majorRadius')
    // guides[0] = leader (center -> on-axis label); guides[1] = vertex tick.
    const leader = r.guides[0]
    expect(leader[0].x).toBeCloseTo(0, 9)
    expect(leader[0].y).toBeCloseTo(0, 9)
    // Label sits ON the major axis at the drop distance (15) -- collinear with
    // the axis direction (cross product zero), NOT an odd angle to the drop.
    expect(leader[1].x).toBeCloseTo(15 * c, 9)
    expect(leader[1].y).toBeCloseTo(15 * s, 9)
    expect(leader[1].x * s - leader[1].y * c).toBeCloseTo(0, 9)
    // Vertex ARROWHEAD [barb, tip, barb]: the chevron TIP (guides[1][1]) sits
    // exactly at center + majorRadius*[cos(rot),sin(rot)].
    const vtx = r.guides[1][1]
    expect(vtx.x).toBeCloseTo(10 * c, 9)
    expect(vtx.y).toBeCloseTo(10 * s, 9)
  })

  it('minor-radius leader runs along the MINOR axis; vertex at center + minor*[perp]', () => {
    // Minor axis direction = major rotated +90 deg = [-sin, cos].
    const mc = -s, ms = c
    const cursor: Vec2 = { x: 8 * mc, y: 8 * ms }
    const r = resolveDimPlacement([er], ['er'], cursor)!
    expect(r.kind).toBe('minorRadius')
    const leader = r.guides[0]
    expect(leader[1].x).toBeCloseTo(8 * mc, 9)
    expect(leader[1].y).toBeCloseTo(8 * ms, 9)
    expect(leader[1].x * ms - leader[1].y * mc).toBeCloseTo(0, 9)
    const vtx = r.guides[1][1] // arrowhead chevron tip = the axis vertex
    expect(vtx.x).toBeCloseTo(5 * mc, 9)
    expect(vtx.y).toBeCloseTo(5 * ms, 9)
  })

  it('a label dropped INSIDE the vertex still clears the outline (clamped past vertex)', () => {
    // Drop close to the center along +major: the label clamps to just past the
    // vertex so the value text never overlaps the ellipse outline.
    const r = resolveDimPlacement([er], ['er'], { x: 1 * c, y: 1 * s })!
    expect(r.kind).toBe('majorRadius')
    const label = r.guides[0][1]
    expect(Math.hypot(label.x, label.y)).toBeGreaterThan(10) // beyond major vertex r=10
  })
})

// ---- arrowhead builder -------------------------------------------------------
//
// Mainstream-CAD dimension terminators: every dimension LINE ends in a chevron
// arrowhead. arrowHead returns ONE 3-point polyline [barb, tip, barb]; the tip
// (index 1) is the point touched, and the two barbs splay symmetrically BACK
// along the shaft (opposite the travel direction).

describe('arrowHead builder', () => {
  it('is a 3-point chevron with the tip at index 1', () => {
    const ah = arrowHead({ x: 5, y: 0 }, { x: 1, y: 0 }, 1)
    expect(ah).toHaveLength(3)
    expect(ah[1]).toEqual({ x: 5, y: 0 }) // tip
  })
  it('barbs splay BACK from the tip, symmetric about the shaft', () => {
    // Pointing +X: both barbs sit behind the tip (x < tip.x), y symmetric.
    const ah = arrowHead({ x: 0, y: 0 }, { x: 1, y: 0 }, 1)
    expect(ah[0].x).toBeLessThan(0)
    expect(ah[2].x).toBeLessThan(0)
    expect(ah[0].y).toBeCloseTo(-ah[2].y, 9)
    expect(ah[0].x).toBeCloseTo(ah[2].x, 9)
  })
  it('scales the barb length by `len` and normalizes the direction', () => {
    const a1 = arrowHead({ x: 0, y: 0 }, { x: 3, y: 0 }, 2) // non-unit dir
    // Barb offset magnitude equals len (2), regardless of dir magnitude.
    expect(Math.hypot(a1[0].x, a1[0].y)).toBeCloseTo(2, 9)
  })
})

// ---- radius / diameter leaders read like standard editor ------------------------------
//
// The REJECTED construction (e932700) drew one collinear center -> label
// segment: the label ended up far from the arc on a long diagonal and the text
// floated off the line end. The standard editor target these tests encode instead: a
// SHORT leader from the label to the ARC, arrowhead AT the arc end pointing at
// the arc, no line from the center, no line crossing the shape, and the
// leader running the FULL span INTO the label anchor -- the opaque label chip
// hides the overlap, so the line reads as running into the box. (A stop-short
// tick-scaled gap was rejected by Operator: "Leader still does not point at
// dimension. Leader line should run into the dimension box." The old "leader
// runs from the CENTER to the label" / "line passes THROUGH the center out to
// the label" tests below were rewritten deliberately -- they asserted the
// rejected behavior.)

// dimGuides polylines by shape: 2-point = leader/line segments, 3-point =
// arrowhead chevrons (the flattener contract).
const segsOf = (g: Vec2[][]) => g.filter((p) => p.length === 2)
const arrowsOf = (g: Vec2[][]) => g.filter((p) => p.length === 3)
const allPts = (g: Vec2[][]) => g.flat()

describe('radius leader: short arc->label segment, arrow at the arc (standard editor)', () => {
  // arc 'ar' center (60,0) r=6. Label off-axis at (66,8): 10mm from the
  // center -> 4mm off the arc. arcPt = center + (0.6,0.8)*6 = (63.6, 4.8).
  const center: Vec2 = { x: 60, y: 0 }
  const cursor: Vec2 = { x: 66, y: 8 }
  const r = resolveDimPlacement(ENTITIES, ['ar'], cursor)!
  const leader = segsOf(r.guides)[0]
  const arrow = arrowsOf(r.guides)[0]

  it('starts ON the arc (|p - center| == radius)', () => {
    expect(r.kind).toBe('radius')
    expect(segsOf(r.guides)).toHaveLength(1)
    expect(Math.hypot(leader[0].x - center.x, leader[0].y - center.y))
      .toBeCloseTo(6, 6)
  })
  it('is collinear with (label - arcPt): the line AIMS at the text', () => {
    const vx = cursor.x - leader[0].x, vy = cursor.y - leader[0].y
    const ex = leader[1].x - leader[0].x, ey = leader[1].y - leader[0].y
    expect(vx * ey - vy * ex).toBeCloseTo(0, 9) // cross = 0 -> collinear
    expect(vx * ex + vy * ey).toBeGreaterThan(0) // and pointing AT the label
  })
  it('runs INTO the label: far endpoint EQUALS the anchor (chip hides overlap)', () => {
    expect(leader[1].x).toBeCloseTo(cursor.x, 9)
    expect(leader[1].y).toBeCloseTo(cursor.y, 9)
    const drawn = Math.hypot(leader[1].x - leader[0].x, leader[1].y - leader[0].y)
    expect(drawn).toBeGreaterThan(0)
  })
  it('never touches the center: NO center->arc portion anywhere', () => {
    for (const p of allPts(r.guides)) {
      expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeGreaterThan(3) // r/2
    }
  })
  it('arrowhead tip at arcPt pointing INTO the arc (barbs on the label side)', () => {
    expect(arrowsOf(r.guides)).toHaveLength(1)
    expect(arrow[1].x).toBeCloseTo(leader[0].x, 9)
    expect(arrow[1].y).toBeCloseTo(leader[0].y, 9)
    // Barbs sweep back toward the label: (barb - tip) . (label - arcPt) > 0.
    const lx = cursor.x - arrow[1].x, ly = cursor.y - arrow[1].y
    for (const b of [arrow[0], arrow[2]]) {
      expect((b.x - arrow[1].x) * lx + (b.y - arrow[1].y) * ly).toBeGreaterThan(0)
    }
  })
})

describe('radius leader: default placement + degenerate anchors (no NaN)', () => {
  const center: Vec2 = { x: 60, y: 0 }

  it('default-style anchor (radius + offset along a ray) spans arc to anchor', () => {
    // Mirror sketchLayer's default: center + (r + DIM_OFFSET_MM) on a ray.
    const ang = 1.1 // arc 'ar' mid-sweep
    const anchor = { x: 60 + 13 * Math.cos(ang), y: 13 * Math.sin(ang) }
    const r = resolveDimPlacement(ENTITIES, ['ar'], anchor)!
    const leader = segsOf(r.guides)[0]
    const drawn = Math.hypot(leader[1].x - leader[0].x, leader[1].y - leader[0].y)
    expect(drawn).toBeCloseTo(7, 9) // full 7mm span, ends AT the anchor
    expect(leader[1].x).toBeCloseTo(anchor.x, 9)
    expect(leader[1].y).toBeCloseTo(anchor.y, 9)
  })
  it('anchor exactly at the CENTER falls back to the 45-deg ray, all finite', () => {
    const r = resolveDimPlacement(ENTITIES, ['ar'], { x: 60, y: 0 })!
    for (const p of allPts(r.guides)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    }
    const arrow = arrowsOf(r.guides)[0]
    // Tip on the arc at 45 deg from the center.
    expect(arrow[1].x).toBeCloseTo(60 + 6 * Math.SQRT1_2, 9)
    expect(arrow[1].y).toBeCloseTo(6 * Math.SQRT1_2, 9)
  })
  it('anchor INSIDE the radius: attachment stays ON the arc, arrow aims at the arc from the label side', () => {
    const anchor: Vec2 = { x: 63, y: 4 } // 5mm from center, inside r=6
    const r = resolveDimPlacement(ENTITIES, ['ar'], anchor)!
    const arrow = arrowsOf(r.guides)[0]
    expect(Math.hypot(arrow[1].x - center.x, arrow[1].y - center.y))
      .toBeCloseTo(6, 6) // tip on the arc
    // Arrow points OUTWARD here (from the inside label toward the arc):
    // barbs fall between the arc and the label, i.e. on the label's side.
    const lx = anchor.x - arrow[1].x, ly = anchor.y - arrow[1].y
    for (const b of [arrow[0], arrow[2]]) {
      expect((b.x - arrow[1].x) * lx + (b.y - arrow[1].y) * ly).toBeGreaterThan(0)
    }
    // Full-span leader even inside: arc -> anchor, endpoint AT the anchor
    // (the label chip hides the overlap -- "looks detached on inside" fix).
    const segs = segsOf(r.guides)
    expect(segs).toHaveLength(1)
    expect(segs[0][1].x).toBeCloseTo(anchor.x, 9)
    expect(segs[0][1].y).toBeCloseTo(anchor.y, 9)
  })
})

describe('diameter leader: label-near, no line across the shape (standard editor)', () => {
  // circle 'ca' center (40,0) r=4; label OUTSIDE on the +X axis at (48,0).
  const r = resolveDimPlacement(ENTITIES, ['ca'], { x: 48, y: 0 })!
  it('draws a leader from the NEAR rim running INTO the label anchor', () => {
    expect(r.kind).toBe('diameter')
    const [leader] = segsOf(r.guides)
    expect(segsOf(r.guides)).toHaveLength(1)
    expect(leader[0]).toEqual({ x: 44, y: 0 })      // near rim (label side)
    expect(leader[1].x).toBeCloseTo(48, 9)          // far endpoint AT the anchor
    expect(leader[1].y).toBeCloseTo(0, 9)
  })
  it('ONE arrowhead at the near rim pointing INTO the circle', () => {
    const arrows = arrowsOf(r.guides)
    expect(arrows).toHaveLength(1)
    expect(arrows[0][1]).toEqual({ x: 44, y: 0 })
    // Barbs sweep back toward the label (outside): x > rim x.
    expect(arrows[0][0].x).toBeGreaterThan(44)
    expect(arrows[0][2].x).toBeGreaterThan(44)
  })
  it('nothing crosses the shape: no guide point past the near rim', () => {
    for (const p of allPts(r.guides)) {
      expect(p.x).toBeGreaterThanOrEqual(44 - 1e-9)
    }
  })
})

describe('diameter leader: label INSIDE keeps the rim-to-rim through-line', () => {
  // circle 'ca' center (40,0) r=4; label inside at (40.5, 0) -> the line runs
  // rim-to-rim UNBROKEN through the label anchor (the near-opaque label chip
  // sits on top; the old split-around-the-label read detached).
  const r = resolveDimPlacement(ENTITIES, ['ca'], { x: 40.5, y: 0 })!
  it('draws ONE unbroken rim-to-rim diameter line through the label', () => {
    const segs = segsOf(r.guides)
    expect(segs).toHaveLength(1)
    expect(segs[0][0]).toEqual({ x: 36, y: 0 })   // near rim
    expect(segs[0][1].x).toBeCloseTo(44, 9)       // far rim
    expect(segs[0][1].y).toBeCloseTo(0, 9)
  })
  it('arrowheads at BOTH rims pointing outward', () => {
    const arrows = arrowsOf(r.guides)
    expect(arrows).toHaveLength(2)
    expect(arrows[0][1]).toEqual({ x: 36, y: 0 })
    expect(arrows[1][1]).toEqual({ x: 44, y: 0 })
    // Outward = barbs fall back INSIDE the circle from each tip.
    expect(arrows[0][0].x).toBeGreaterThan(36)
    expect(arrows[1][0].x).toBeLessThan(44)
  })
  it('anchor exactly at the CENTER stays finite (45-deg fallback ray)', () => {
    const rc = resolveDimPlacement(ENTITIES, ['ca'], { x: 40, y: 0 })!
    for (const p of allPts(rc.guides)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    }
    const arrows = arrowsOf(rc.guides)
    expect(arrows).toHaveLength(2)
    // Rim tips still ON the circle.
    for (const a of arrows) {
      expect(Math.hypot(a[1].x - 40, a[1].y)).toBeCloseTo(4, 6)
    }
  })
})

// ---- linear dims: extension lines + a dimension line with two arrowheads -----

describe('linear dim draws witness lines + a bar with arrowheads at both ends', () => {
  it('aligned distance: [witness, witness, bar, arrow, arrow]', () => {
    // 3-4-5 diagonal p0(0,0)-p1(4,3), perpendicular side pull -> aligned.
    const r = resolveDimPlacement(ENTITIES, ['p0', 'p1'], { x: -1, y: 5.5 })!
    expect(r.kind).toBe('distance')
    expect(r.guides).toHaveLength(5)
    const bar = r.guides[2]
    expect(Math.hypot(bar[1].x - bar[0].x, bar[1].y - bar[0].y)).toBeCloseTo(5, 9)
    // Two arrowheads, one at each bar end (chevron tip == bar endpoint).
    const arrowA = r.guides[3], arrowB = r.guides[4]
    expect(arrowA).toHaveLength(3)
    expect(arrowB).toHaveLength(3)
    expect(arrowA[1].x).toBeCloseTo(bar[0].x, 9)
    expect(arrowA[1].y).toBeCloseTo(bar[0].y, 9)
    expect(arrowB[1].x).toBeCloseTo(bar[1].x, 9)
    expect(arrowB[1].y).toBeCloseTo(bar[1].y, 9)
    // Witness lines START at the measured points (no gap -> the dim stays
    // clickable near the feature).
    expect(r.guides[0][0]).toEqual({ x: 0, y: 0 })
    expect(r.guides[1][0]).toEqual({ x: 4, y: 3 })
  })

  it('distanceX: horizontal bar at the label height with arrowheads at each end', () => {
    const r = resolveDimPlacement(ENTITIES, ['p0', 'p1'], { x: 2, y: 20 })!
    expect(r.kind).toBe('distanceX')
    // [witnessA, witnessB, bar, arrowA, arrowB]
    expect(r.guides).toHaveLength(5)
    const bar = r.guides[2]
    expect(bar[0].y).toBeCloseTo(20, 9)
    expect(bar[1].y).toBeCloseTo(20, 9)
    expect(Math.abs(bar[1].x - bar[0].x)).toBeCloseTo(4, 9)
    expect(r.guides[3]).toHaveLength(3)
    expect(r.guides[4]).toHaveLength(3)
    expect(r.guides[3][1].y).toBeCloseTo(20, 9) // arrow tip on the bar
  })
})
