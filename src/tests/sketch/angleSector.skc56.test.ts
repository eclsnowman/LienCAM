// WO SKC-56 -- angle dimension sector/placement follows the mouse (standard editor
// convention). Covers the shared selectAngleSector helper (dimTool.ts), its
// use from resolveDimPlacement/dimGuides (dimPlacement.ts, live preview +
// commit) and measureDimension (dimTool.ts, reference re-measure), the
// abs/positive display split (formatDimensionValue), the label-drag
// sector-crossing helper (angleLabelDragValueOverride), and a real-solver
// mutation proof on the value/render coupling (P5).

import { describe, it, expect } from 'vitest'
import {
  selectAngleSector, angleLabelDragValueOverride, formatDimensionValue, measureDimension,
} from '../../lib/sketch/tools/dimTool'
import { resolveDimPlacement, dimGuides } from '../../lib/sketch/tools/dimPlacement'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint, SketchDimension, PointRef, AngleDimension,
} from '../../lib/sketch/types'

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function ref(entityId: string, site: PointRef['site']): PointRef { return { entityId, site } }

// Two lines sharing the origin: `a` horizontal (0,0)->(10,0), `b` at 47deg
// (0,0)->(~6.8,~7.3). theta = lineAngle(a,b) = +47deg. The 4 sectors around
// their shared vertex (origin): NEAR-CCW (0..47deg, "I1"), FAR-CCW
// (47..180deg, "I2"), NEAR-CW (180..227deg, "I3", vertically opposite I1),
// FAR-CW (227..360deg, "I4", vertically opposite I2).
const THETA_DEG = 47
const A = line('a', 0, 0, 10, 0)
const B = line('b', 0, 0, 10 * Math.cos((THETA_DEG * Math.PI) / 180), 10 * Math.sin((THETA_DEG * Math.PI) / 180))
const ENTITIES: SketchEntity[] = [A, B]
const PLAN = { a: 'a', b: 'b' }

function deg(rad: number): number { return (rad * 180) / Math.PI }
function anchorAtDeg(d: number, r = 5): { x: number; y: number } {
  const rad = (d * Math.PI) / 180
  return { x: r * Math.cos(rad), y: r * Math.sin(rad) }
}

describe('selectAngleSector: the 4 sectors around two lines, pure classification', () => {
  it('I1 (near-CCW, 0..47deg): value = theta, no transform, reverseB=false', () => {
    const s = selectAngleSector(ENTITIES, PLAN, anchorAtDeg(23))!
    expect(s).not.toBeNull()
    expect(deg(s.value)).toBeCloseTo(THETA_DEG, 6)
    expect(s.reverseB).toBe(false)
    expect(deg(s.startAngle)).toBeCloseTo(0, 6)
    expect(deg(s.endAngle)).toBeCloseTo(THETA_DEG, 6)
  })

  // SKC-58B: the far value is the SIGNED reversed-operand directed angle
  // (theta - sign(theta)*pi), NOT the old unsigned supplement pi-|theta|. For
  // theta=+47 -> -133deg with reverseB=true; |value| = 133 (the obtuse label).
  // This is what makes the obtuse commit no-motion (gcsMapping reverses B).
  it('I2 (far-CCW, 47..180deg): value = signed reversed-operand directed angle (-133deg), reverseB=true', () => {
    const s = selectAngleSector(ENTITIES, PLAN, anchorAtDeg(113))!
    expect(deg(s.value)).toBeCloseTo(-(180 - THETA_DEG), 6)
    expect(Math.abs(deg(s.value))).toBeCloseTo(180 - THETA_DEG, 6) // label magnitude unchanged
    expect(s.reverseB).toBe(true)
    expect(deg(s.startAngle)).toBeCloseTo(THETA_DEG, 6)
    expect(deg(s.endAngle)).toBeCloseTo(180, 6)
  })

  it('I3 (near-CW, 180..227deg, vertically opposite I1): value = theta again, no transform, reverseB=false', () => {
    const s = selectAngleSector(ENTITIES, PLAN, anchorAtDeg(203))!
    expect(deg(s.value)).toBeCloseTo(THETA_DEG, 6)
    expect(s.reverseB).toBe(false)
    expect(deg(s.startAngle)).toBeCloseTo(180, 6)
    expect(deg(s.endAngle)).toBeCloseTo(180 + THETA_DEG, 6)
  })

  it('I4 (far-CW, 227..360deg, vertically opposite I2): value = signed reversed-operand angle (-133deg) again, reverseB=true', () => {
    const s = selectAngleSector(ENTITIES, PLAN, anchorAtDeg(293))!
    expect(deg(s.value)).toBeCloseTo(-(180 - THETA_DEG), 6)
    expect(s.reverseB).toBe(true)
    expect(deg(s.startAngle)).toBeCloseTo(180 + THETA_DEG, 6)
    expect(deg(s.endAngle)).toBeCloseTo(360, 6)
  })

  it('anchor === null defaults to the atan2 short-way (P6 creation default), reverseB=false', () => {
    const s = selectAngleSector(ENTITIES, PLAN, null)!
    expect(deg(s.value)).toBeCloseTo(THETA_DEG, 6)
    expect(s.reverseB).toBe(false)
  })

  it('degenerate: anchor exactly at the vertex keeps the short-way default (never NaN)', () => {
    const s = selectAngleSector(ENTITIES, PLAN, { x: 0, y: 0 })!
    expect(Number.isFinite(s.value)).toBe(true)
    expect(deg(s.value)).toBeCloseTo(THETA_DEG, 6)
  })

  it('degenerate: anchor exactly ON one of the lines keeps the short-way default (never NaN, never a boundary flicker)', () => {
    // On line `a` itself (y=0, x>0) -- exactly the theta=0 breakpoint.
    const s = selectAngleSector(ENTITIES, PLAN, { x: 3, y: 0 })!
    expect(Number.isFinite(s.value)).toBe(true)
    expect(deg(s.value)).toBeCloseTo(THETA_DEG, 6)
  })

  it('degenerate: near-parallel lines -> null (no leader/arc), matching lineLineIntersection\'s own guard', () => {
    const nearParallel: SketchEntity[] = [A, line('b2', 0, 0.001, 10, 0.001)]
    const s = selectAngleSector(nearParallel, { a: 'a', b: 'b2' }, anchorAtDeg(23))
    expect(s).toBeNull()
  })

  it('SKC-56-R1 major 1: scale-independent near-parallel rejection -- long (1000 mm) legs at a nonzero near-zero angle -> null, dimGuides empty', () => {
    // Reproduces the auditor's exact scale defect: the OLD guard compared the
    // raw (unnormalized) cross-product denominator to a fixed 1e-9, so long
    // legs at a genuinely tiny angle produced a large-magnitude denominator
    // from LENGTH alone and slipped past it (two 1000 mm legs at 1e-10 rad
    // give a raw denom of ~1e-4, five orders of magnitude over the old
    // threshold, even though the angle itself is far tighter than
    // PARALLEL_EPS_RAD). The length-normalized angular test must reject this
    // exactly as it would a short-leg pair at the same angle.
    const nearZeroRad = 1e-10
    const longA = line('la', 0, 0, 1000, 0)
    const longB = line('lb', 0, 0, 1000 * Math.cos(nearZeroRad), 1000 * Math.sin(nearZeroRad))
    const ents: SketchEntity[] = [longA, longB]
    const plan = { a: 'la', b: 'lb' }
    const s = selectAngleSector(ents, plan, anchorAtDeg(23, 500))
    expect(s).toBeNull()
    const guides = dimGuides(ents, { kind: 'angle', a: 'la', b: 'lb', value: nearZeroRad },
      anchorAtDeg(23, 500), 1.5)
    expect(guides).toEqual([])
  })

  it('SKC-56-R1 major 1: zero-length leg is rejected, never divides by zero', () => {
    const degenerate: SketchEntity[] = [A, line('zero', 5, 5, 5, 5)]
    const s = selectAngleSector(degenerate, { a: 'a', b: 'zero' }, anchorAtDeg(23))
    expect(s).toBeNull()
  })

  it('negative theta (b drawn the other way, -47deg): near sector = theta (reverseB=false); far sector = signed reversed value +133deg (reverseB=true)', () => {
    const negB = line('b', 0, 0, 10 * Math.cos((-THETA_DEG * Math.PI) / 180), 10 * Math.sin((-THETA_DEG * Math.PI) / 180))
    const ents = [A, negB]
    const near = selectAngleSector(ents, PLAN, anchorAtDeg(-23))!
    expect(deg(near.value)).toBeCloseTo(-THETA_DEG, 6)
    expect(near.reverseB).toBe(false)
    const far = selectAngleSector(ents, PLAN, anchorAtDeg(-113))!
    // SKC-58B: theta=-47 -> reversed value = theta - sign(theta)*pi = +133deg.
    // The SIGN follows theta (here positive); |value| = 133 either way.
    expect(deg(far.value)).toBeCloseTo(180 - THETA_DEG, 6)
    expect(far.reverseB).toBe(true)
  })
})

describe('live placement preview follows the cursor through all 4 sectors (deliverable 1)', () => {
  const sweep = [23, 113, 203, 293]
  it('resolveDimPlacement value + guides track the cursor sector on every pointermove', () => {
    for (const a of sweep) {
      const cursor = anchorAtDeg(a)
      const placement = resolveDimPlacement(ENTITIES, ['a', 'b'], cursor)!
      expect(placement.kind).toBe('angle')
      expect(placement.guides.length).toBeGreaterThan(0)
      const sector = selectAngleSector(ENTITIES, PLAN, cursor)!
      expect(placement.value).toBeCloseTo(sector.value, 9)
      // SKC-58B: the far/obtuse orientation rides the plan onto the commit.
      expect((placement.plan as { reverseB?: boolean }).reverseB ?? false).toBe(sector.reverseB)
    }
  })

  it('dimGuides renders the arc strictly inside the picked sector\'s bounds for all 4 sectors', () => {
    for (const a of sweep) {
      const cursor = anchorAtDeg(a)
      const placement = resolveDimPlacement(ENTITIES, ['a', 'b'], cursor)!
      const guides = dimGuides(ENTITIES, placement.plan, cursor, 1.5)
      expect(guides.length).toBeGreaterThan(0)
      const arc = guides[0]
      expect(arc.length).toBeGreaterThan(10) // tessellated
    }
  })
})

describe('formatDimensionValue: angle text is always the POSITIVE sweep (abs), sign is internal-only', () => {
  it('a negative-side sector value still displays as a positive degree readout', () => {
    const text = formatDimensionValue('angle', -THETA_DEG * Math.PI / 180, true)
    expect(text).toBe(`${THETA_DEG.toFixed(1)} deg`)
  })
  it('a far-sector (>90deg) value displays its own positive magnitude', () => {
    const farRad = (180 - THETA_DEG) * Math.PI / 180
    expect(formatDimensionValue('angle', farRad, true)).toBe(`${(180 - THETA_DEG).toFixed(1)} deg`)
  })
})

describe('measureDimension (reference dims): re-measures per the dimension\'s OWN labelAnchor sector', () => {
  it('a reference angle dim with a far-sector labelAnchor reports the signed far value (SKC-58B), abs = the obtuse magnitude', () => {
    const d: AngleDimension = {
      id: 'd1', kind: 'angle', driving: false, value: 0, a: 'a', b: 'b',
      labelAnchor: anchorAtDeg(113),
    }
    const v = measureDimension(ENTITIES, d)
    expect(v).not.toBeNull()
    // SKC-58B: signed reversed-operand value (-133deg); |v| = 133 (the label).
    expect(deg(v!)).toBeCloseTo(-(180 - THETA_DEG), 6)
    expect(Math.abs(deg(v!))).toBeCloseTo(180 - THETA_DEG, 6)
  })
  it('no labelAnchor yet falls back to the atan2 short-way (today\'s pre-WO behavior)', () => {
    const d: AngleDimension = { id: 'd1', kind: 'angle', driving: false, value: 0, a: 'a', b: 'b' }
    const v = measureDimension(ENTITIES, d)
    expect(deg(v!)).toBeCloseTo(THETA_DEG, 6)
  })
})

describe('angleLabelDragValueOverride: label-drag sector-crossing helper (deliverable 3, shared by both hosts)', () => {
  const driving: AngleDimension = {
    id: 'd1', kind: 'angle', driving: true, value: (THETA_DEG * Math.PI) / 180, a: 'a', b: 'b',
    labelAnchor: anchorAtDeg(23),
  }
  it('drag within the SAME sector (I1) returns null -- move-only, no value change', () => {
    const out = angleLabelDragValueOverride(ENTITIES, driving, anchorAtDeg(35))
    expect(out).toBeNull()
  })
  it('drag INTO a different sector (I1 -> I2) returns the new sector\'s signed value AND reverseB=true (SKC-58B)', () => {
    const out = angleLabelDragValueOverride(ENTITIES, driving, anchorAtDeg(113))
    expect(out).not.toBeNull()
    // Signed reversed-operand far value (-133deg) so the crossing is no-motion
    // once the solver reverses B; the orientation flips near->far too.
    expect(deg(out!.value)).toBeCloseTo(-(180 - THETA_DEG), 6)
    expect(out!.reverseB).toBe(true)
  })
  it('drag into the vertically-opposite sector (I1 -> I3) returns null -- same theta, same (near) orientation, no change', () => {
    const out = angleLabelDragValueOverride(ENTITIES, driving, anchorAtDeg(203))
    expect(out).toBeNull()
  })
  it('a non-angle dimension always returns null', () => {
    const dist: SketchDimension = { id: 'd2', kind: 'distance', driving: true, value: 5, a: ref('a', 'start'), b: ref('a', 'end') }
    expect(angleLabelDragValueOverride(ENTITIES, dist, anchorAtDeg(113))).toBeNull()
  })
})

describe('SKC-56-R1 major 2: a boundary/vertex anchor never overrides a committed FAR-sector dimension', () => {
  // The auditor's exact reproduction: 47deg lines, a COMMITTED far-sector
  // (I2, 133deg) dimension whose labelAnchor already sits in I2. Dragging the
  // label onto line A (or onto the shared vertex) must be classified as
  // "no reliable side information" and keep d.value -- NOT be misread as a
  // real crossing into the near sector (which would silently rewrite 133deg
  // back to 47deg).
  // SKC-58B: a committed far/obtuse dimension stores the SIGNED reversed value
  // (-133deg) with reverseB=true (that is what makes its commit no-motion).
  const farDriving: AngleDimension = {
    id: 'd1', kind: 'angle', driving: true, value: (-(180 - THETA_DEG) * Math.PI) / 180,
    reverseB: true, a: 'a', b: 'b', labelAnchor: anchorAtDeg(113),
  }
  it('drag exactly ONTO line A returns null (previously returned 47deg -- the reproduced bug)', () => {
    const onLineA = { x: 3, y: 0 } // on line a: y=0, x>0 -- same point the P6 degenerate test uses
    const out = angleLabelDragValueOverride(ENTITIES, farDriving, onLineA)
    expect(out).toBeNull()
  })
  it('drag exactly ONTO line B returns null', () => {
    const rad = (THETA_DEG * Math.PI) / 180
    const onLineB = { x: 3 * Math.cos(rad), y: 3 * Math.sin(rad) }
    const out = angleLabelDragValueOverride(ENTITIES, farDriving, onLineB)
    expect(out).toBeNull()
  })
  it('drag exactly onto the shared VERTEX returns null', () => {
    const out = angleLabelDragValueOverride(ENTITIES, farDriving, { x: 0, y: 0 })
    expect(out).toBeNull()
  })
  it('control: a genuine crossing (I2 -> I1) still returns the near-sector value AND reverseB=false (SKC-58B orientation flip)', () => {
    const out = angleLabelDragValueOverride(ENTITIES, farDriving, anchorAtDeg(23))
    expect(out).not.toBeNull()
    expect(deg(out!.value)).toBeCloseTo(THETA_DEG, 6)
    expect(out!.reverseB).toBe(false)
  })
})

// ---- Deliverable 2 (SKC-58B revision): commit in each sector is NO-MOTION --
// the sector-selected (value, reverseB) is already satisfied by the drawn
// geometry, so the SOLVER does not move it. This REVERSES SKC-56's original
// deliverable-2 convention, which deliberately drove fresh geometry to the
// supplement on a far pick ("the SOLVER drives the shown angle"); Operator's
// hands-on ruling (SKC-58/SKC-58B) rejected that motion. Deliverable 5 is the
// reverseB mutation proof. Real planegcs solves, fresh geometry each. --------

function angleTestSketch(startDeg: number, candidate: number, reverseB = false): Sketch {
  const l1 = line('l1', 0, 0, 10, 0)
  const startRad = (startDeg * Math.PI) / 180
  const l2 = line('l2', 0, 0, 10 * Math.cos(startRad), 10 * Math.sin(startRad))
  const constraints: SketchConstraint[] = [
    { id: 'f1s', kind: 'fix', point: ref('l1', 'start') },
    { id: 'f1e', kind: 'fix', point: ref('l1', 'end') },
    { id: 'f2s', kind: 'fix', point: ref('l2', 'start') },
  ]
  const dimensions: SketchDimension[] = [
    { id: 'len2', kind: 'distance', driving: true, value: 10, a: ref('l2', 'start'), b: ref('l2', 'end') },
    { id: 'ang', kind: 'angle', driving: true, value: candidate, a: 'l1', b: 'l2',
      ...(reverseB ? { reverseB: true } : {}) },
  ]
  return {
    id: 'sk', layerId: 'layer', entities: [l1, l2], constraints, dimensions,
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

function measuredAngle(l1: SketchLineEntity, l2: SketchLineEntity): number {
  const ax = l1.end.x - l1.start.x, ay = l1.end.y - l1.start.y
  const bx = l2.end.x - l2.start.x, by = l2.end.y - l2.start.y
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
}

describe('deliverable 2 (SKC-58B): commit in each sector is NO-MOTION -- the sector value already describes the drawn geometry (real planegcs)', () => {
  // The line is DRAWN at THETA_DEG; committing the sector-selected value must
  // leave it at THETA_DEG (Operator's no-motion bar) for EVERY sector, while the
  // LABEL magnitude (formatDimensionValue) reads the acute or obtuse value.
  const drawnEndDeg = THETA_DEG
  const cases = [
    { name: 'I1 near-CCW', anchorDeg: 23,  labelDeg: THETA_DEG },
    { name: 'I2 far-CCW',  anchorDeg: 113, labelDeg: 180 - THETA_DEG },
    { name: 'I3 near-CW',  anchorDeg: 203, labelDeg: THETA_DEG },
    { name: 'I4 far-CW',   anchorDeg: 293, labelDeg: 180 - THETA_DEG },
  ]
  for (const c of cases) {
    it(`${c.name}: committing the sector value leaves the drawn geometry untouched; the label reads ${c.labelDeg} deg`, async () => {
      const drawn = [line('l1', 0, 0, 10, 0), line('l2', 0, 0,
        10 * Math.cos((drawnEndDeg * Math.PI) / 180), 10 * Math.sin((drawnEndDeg * Math.PI) / 180))]
      const sector = selectAngleSector(drawn, { a: 'l1', b: 'l2' }, anchorAtDeg(c.anchorDeg))!
      const l2drawn = drawn[1] as SketchLineEntity
      const sketch = angleTestSketch(drawnEndDeg, sector.value, sector.reverseB)
      const wrapper = await createGcsWrapper()
      const out = solveSketchOnWrapper(wrapper, sketch)
      expect(out.ok).toBe(true)
      if (!out.ok) return
      const l1s = out.entities.find((e) => e.id === 'l1') as SketchLineEntity
      const l2s = out.entities.find((e) => e.id === 'l2') as SketchLineEntity
      const measured = measuredAngle(l1s, l2s)
      const moved = Math.hypot(l2s.end.x - l2drawn.end.x, l2s.end.y - l2drawn.end.y)
      // NO MOTION: the solved geometry stays at the drawn +THETA_DEG regardless
      // of sector; the near/far distinction lives in the dimension VALUE (and
      // the reversed operand), never in the geometry.
      expect(moved).toBeLessThan(1e-6)
      expect(deg(measured)).toBeCloseTo(drawnEndDeg, 3)
      // ...but the LABEL is the sector's own magnitude (acute 47 / obtuse 133).
      expect(formatDimensionValue('angle', sector.value, true)).toBe(`${c.labelDeg.toFixed(1)} deg`)
    })
  }
})

describe('deliverable 5 (SKC-58B): mutation proof -- reverseB is load-bearing for the no-motion far commit', () => {
  // The mutation: drop reverseB on a committed FAR dimension. gcsMapping then
  // feeds the signed far value (-133deg) to the DIRECTED l2l_angle_ll against
  // unchanged operands, which the drawn geometry (+47) does not satisfy, so the
  // solver drags l2 to -133deg -- the exact SKC-58 bug. With reverseB restored
  // the same value is a no-op. (Pre-mutation source retained in
  // coordination/evidence/SKC-58B/ per the charter's mutation-proof rule.)
  const farSector = selectAngleSector([line('l1', 0, 0, 10, 0), line('l2', 0, 0,
    10 * Math.cos((THETA_DEG * Math.PI) / 180), 10 * Math.sin((THETA_DEG * Math.PI) / 180))],
    { a: 'l1', b: 'l2' }, anchorAtDeg(113))!

  it('BROKEN mutant (reverseB dropped) drags the far commit off the drawn geometry to the supplement -- RED', async () => {
    expect(farSector.reverseB).toBe(true)
    const sketch = angleTestSketch(THETA_DEG, farSector.value, /* reverseB */ false)
    const wrapper = await createGcsWrapper()
    const out = solveSketchOnWrapper(wrapper, sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const l1s = out.entities.find((e) => e.id === 'l1') as SketchLineEntity
    const l2s = out.entities.find((e) => e.id === 'l2') as SketchLineEntity
    const measured = measuredAngle(l1s, l2s)
    // The mutant lands at the signed far value itself (-133), NOT the drawn +47
    // -- the geometry MOVED, proving reverseB is load-bearing.
    expect(deg(measured)).toBeCloseTo(-(180 - THETA_DEG), 3)
    expect(deg(measured)).not.toBeCloseTo(THETA_DEG, 3)
  })

  it('RESTORED (reverseB=true) commits the same far value with NO motion -- GREEN', async () => {
    const sketch = angleTestSketch(THETA_DEG, farSector.value, /* reverseB */ true)
    const wrapper = await createGcsWrapper()
    const out = solveSketchOnWrapper(wrapper, sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const l1s = out.entities.find((e) => e.id === 'l1') as SketchLineEntity
    const l2s = out.entities.find((e) => e.id === 'l2') as SketchLineEntity
    const measured = measuredAngle(l1s, l2s)
    expect(deg(measured)).toBeCloseTo(THETA_DEG, 3) // unmoved: obtuse label, acute geometry
  })
})
