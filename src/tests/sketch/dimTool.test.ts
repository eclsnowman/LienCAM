// Smart dimension tool (Stage 4): type inference follows the selection,
// placement click stores the label offset (PLAN.md 3.4 doctrine).

import { describe, it, expect } from 'vitest'
import {
  planDimension, dimToolClick, dimPreview, formatDimensionValue,
  measureDimension, pickDimOperand, cycleDimForceMode,
  dimModeLabel, isLinearDimKind,
} from '../../lib/sketch/tools/dimTool'
import { resolveDimPlacement } from '../../lib/sketch/tools/dimPlacement'
import {
  armTool, toolClick, escapeTool, IDLE_TOOL_STATE,
} from '../../lib/sketch/tools/toolMachine'
import type { SketchEntity, SketchDimension, Vec2 } from '../../lib/sketch/types'

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

// la/lb parallel horizontals 5 apart; lc vertical (90 deg to la);
// pa/pb a 3-4-5 point pair; ph/ph2 H-aligned points 7 apart.
const ENTITIES: SketchEntity[] = [
  line('la', 0, 0, 10, 0),
  line('lb', 0, 5, 10, 5),
  line('lc', 20, 0, 20, 8),
  circle('ca', 40, 0, 4),
  arc('ar', 60, 0, 6),
  point('pa', 0, 20), point('pb', 3, 24),
  point('ph', 0, 30), point('ph2', 7, 30),
]

const newIds = () => {
  let n = 0
  return () => `id${n++}`
}

// ---- type inference (table-driven, doctrine 3.4) ------------------------------

describe('planDimension: selection -> dimension type', () => {
  const cases: Array<{
    ops: string[]
    expect: { kind: SketchDimension['kind']; value: number } | { reason: true; incomplete: boolean }
    note: string
  }> = [
    { ops: ['la'], expect: { kind: 'distance', value: 10 }, note: 'line -> length' },
    { ops: ['la', 'lb'], expect: { kind: 'distancePL', value: 5 }, note: 'parallel lines -> distance' },
    { ops: ['la', 'lc'], expect: { kind: 'angle', value: Math.PI / 2 }, note: 'two lines -> angle' },
    { ops: ['ca'], expect: { kind: 'diameter', value: 8 }, note: 'circle -> diameter' },
    { ops: ['ar'], expect: { kind: 'radius', value: 6 }, note: 'arc -> radius' },
    { ops: ['pa', 'pb'], expect: { kind: 'distance', value: 5 }, note: 'two points -> distance' },
    { ops: ['pa', 'la'], expect: { kind: 'distancePL', value: 20 }, note: 'point + line -> distance' },
    { ops: ['la', 'pa'], expect: { kind: 'distancePL', value: 20 }, note: 'line + point (order-free)' },
    // H-aligned points: PLAIN distance (X/Y axis lock = future modifier).
    { ops: ['ph', 'ph2'], expect: { kind: 'distance', value: 7 }, note: 'H-aligned points -> plain distance' },
    { ops: ['pa'], expect: { reason: true, incomplete: true }, note: 'lone point waits for a partner' },
    { ops: ['ca', 'pa'], expect: { reason: true, incomplete: false }, note: 'circle + point rejected' },
    { ops: ['ca', 'ar'], expect: { reason: true, incomplete: false }, note: 'circle + arc rejected' },
  ]

  for (const c of cases) {
    it(`[${c.ops.join(' + ')}] -> ${'kind' in c.expect ? c.expect.kind : 'invalid'} (${c.note})`, () => {
      const out = planDimension(ENTITIES, c.ops)
      if ('kind' in c.expect) {
        expect(out.ok).toBe(true)
        if (out.ok) {
          expect(out.plan.kind).toBe(c.expect.kind)
          expect(out.plan.value).toBeCloseTo(c.expect.value, 9)
        }
      } else {
        expect(out.ok).toBe(false)
        if (!out.ok) {
          expect(out.reason.length).toBeGreaterThan(0)
          expect(out.incomplete).toBe(c.expect.incomplete)
        }
      }
    })
  }

  it('line length references the line OWN endpoints', () => {
    const out = planDimension(ENTITIES, ['la'])
    expect(out.ok).toBe(true)
    if (out.ok && out.plan.kind === 'distance') {
      expect(out.plan.a).toEqual({ entityId: 'la', site: 'start' })
      expect(out.plan.b).toEqual({ entityId: 'la', site: 'end' })
    }
  })

  it('angle value is the oriented atan2(cross, dot) of the directions', () => {
    // lc reversed relative to la would flip the sign; this pins it.
    // WO SKC-56 (deliberate re-confirmation, not a silent survivor): planDimension is
    // orientation-BLIND (no anchor) by design -- it always returns the plain atan2 short-way
    // value, exactly as before. The anchor-driven sector transform (selectAngleSector,
    // dimTool.ts) lives ONE LAYER UP, in resolveDimPlacement/dimGuides/measureDimension, so
    // this pin is untouched by the WO on purpose (see angleSector.skc56.test.ts for the new
    // sector-selection convention).
    const out = planDimension(ENTITIES, ['lc', 'la'])
    expect(out.ok).toBe(true)
    if (out.ok && out.plan.kind === 'angle') {
      expect(out.plan.value).toBeCloseTo(-Math.PI / 2, 9)
    }
  })
})

// ---- EXPLICIT point picks (corner / vertex / spline) --------------------------
//
// The reported bug: picking a CORNER (a line endpoint) + another line made an
// ANGLE (the corner resolved to its owning line body -> line+line -> angle).
// An explicitly snapped endpoint/vertex/spline-point must instead act as a
// POINT so corner + line -> point-to-line distance. Operands carry the site.

describe('planDimension: explicit point picks change the inference', () => {
  const sp: SketchEntity = {
    id: 'sp', kind: 'spline', construction: false,
    points: [{ x: 0, y: 40 }, { x: 5, y: 45 }, { x: 10, y: 40 }], closed: false,
  }
  const ENTS: SketchEntity[] = [...ENTITIES, sp]
  const P = (entityId: string, site: 'start' | 'end' | 'center' | 'self') =>
    ({ entityId, site })

  it('(a) endpoint of line A + line B -> distancePL (perp distance), NOT angle', () => {
    // la END (10,0) + lc (vertical x=20) -> perpendicular distance 10.
    const out = planDimension(ENTS, [P('la', 'end'), 'lc'])
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.plan.kind).toBe('distancePL')
      if (out.plan.kind === 'distancePL') {
        expect(out.plan.point).toEqual({ entityId: 'la', site: 'end' })
        expect(out.plan.line).toBe('lc')
        expect(out.plan.value).toBeCloseTo(10, 9)
      }
    }
  })

  it('(a2) order-free: line B + endpoint of line A -> distancePL', () => {
    const out = planDimension(ENTS, ['lc', P('la', 'end')])
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.plan.kind).toBe('distancePL')
  })

  it('(b) two endpoints -> distance between the two points', () => {
    // la start (0,0) + lc start (20,0) -> 20.
    const out = planDimension(ENTS, [P('la', 'start'), P('lc', 'start')])
    expect(out.ok).toBe(true)
    if (out.ok && out.plan.kind === 'distance') {
      expect(out.plan.a).toEqual({ entityId: 'la', site: 'start' })
      expect(out.plan.b).toEqual({ entityId: 'lc', site: 'start' })
      expect(out.plan.value).toBeCloseTo(20, 9)
    } else {
      expect.fail('expected a distance plan')
    }
  })

  it('(c) endpoint of a line + that SAME line -> guarded (rejected, no crash)', () => {
    const out = planDimension(ENTS, [P('la', 'start'), 'la'])
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.incomplete).toBe(false)
      expect(out.reason).toMatch(/lies on the line/)
    }
  })

  it('(d) two FULL line bodies still -> angle (unchanged)', () => {
    const out = planDimension(ENTS, ['la', 'lc'])
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.plan.kind).toBe('angle')
  })

  it('(e) spline START point + line -> distancePL', () => {
    // sp points[0] = (0,40); la is y=0 -> perpendicular distance 40.
    const out = planDimension(ENTS, [P('sp', 'start'), 'la'])
    expect(out.ok).toBe(true)
    if (out.ok && out.plan.kind === 'distancePL') {
      expect(out.plan.point).toEqual({ entityId: 'sp', site: 'start' })
      expect(out.plan.line).toBe('la')
      expect(out.plan.value).toBeCloseTo(40, 9)
    } else {
      expect.fail('expected a distancePL plan')
    }
  })

  it('an explicit CENTER + line also measures point-to-line (center is a point)', () => {
    // ca center (40,0) + lc (x=20) -> 20.
    const out = planDimension(ENTS, [P('ca', 'center'), 'lc'])
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.plan.kind).toBe('distancePL')
  })

  it('a lone explicit endpoint waits for a partner (incomplete, like a point)', () => {
    const out = planDimension(ENTS, [P('la', 'start')])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.incomplete).toBe(true)
  })
})

// ---- picking ------------------------------------------------------------------

describe('pickDimOperand', () => {
  it('picks the entity under the cursor, points before curves', () => {
    expect(pickDimOperand(ENTITIES, { x: 5, y: 0.2 }, 0.5)).toBe('la')
    expect(pickDimOperand(ENTITIES, { x: 44, y: 0 }, 0.5)).toBe('ca') // on the rim
    expect(pickDimOperand(ENTITIES, { x: 0.2, y: 20 }, 0.5)).toBe('pa')
    expect(pickDimOperand(ENTITIES, { x: 5, y: 50 }, 0.5)).toBeNull() // empty space
  })

  it('a point sitting on a curve wins within tolerance', () => {
    const ents = [...ENTITIES, point('ponla', 5, 0)]
    expect(pickDimOperand(ents, { x: 5.1, y: 0.1 }, 0.5)).toBe('ponla')
  })
})

// ---- click accumulation + placement -------------------------------------------

describe('dimToolClick', () => {
  const TOL = 0.5

  it('entity clicks accumulate operands; empty click places the dimension', () => {
    const newId = newIds()
    // Click the line.
    const r1 = dimToolClick(null, { x: 5, y: 0 }, TOL, ENTITIES, newId)
    expect(r1.chain).toEqual({ kind: 'dim', operandIds: ['la'] })
    expect(r1.dimension).toBeNull()
    expect(r1.notice).toBeNull()
    // Place in empty space ABOVE the horizontal line: the drag is dominantly
    // vertical, so the orientation auto-pick drops a HORIZONTAL-measuring
    // dimension (distanceX). The click point IS the stored label offset.
    const place: Vec2 = { x: 5, y: 9 }
    const r2 = dimToolClick(r1.chain, place, TOL, ENTITIES, newId)
    expect(r2.chain).toBeNull() // operand set consumed; tool stays armed
    expect(r2.dimension).not.toBeNull()
    const d = r2.dimension!
    expect(d.kind).toBe('distanceX')
    expect(d.driving).toBe(true)
    expect(d.value).toBeCloseTo(10, 9)
    expect(d.labelAnchor).toEqual({ x: 5, y: 3.5 })
  })

  it('re-clicking an operand keeps the set and gives feedback; invalid additions are rejected with a reason', () => {
    const newId = newIds()
    const chain = { kind: 'dim' as const, operandIds: ['ca'] }
    // Same entity again: operand set unchanged, but the user is told why
    // (no silent swallow, ADR-0003).
    const again = dimToolClick(chain, { x: 44, y: 0 }, TOL, ENTITIES, newId)
    expect(again.chain).toEqual(chain)
    expect(again.dimension).toBeNull()
    expect(again.notice).toContain('already picked')
    // circle + point can never dimension: rejected, operands kept, named.
    const bad = dimToolClick(chain, { x: 0, y: 20 }, TOL, ENTITIES, newId)
    expect(bad.chain).toEqual(chain)
    expect(bad.dimension).toBeNull()
    expect(bad.notice).toContain('cannot dimension')
  })

  it('placing an incomplete set explains instead of committing', () => {
    const newId = newIds()
    const chain = { kind: 'dim' as const, operandIds: ['pa'] }
    const r = dimToolClick(chain, { x: 5, y: 50 }, TOL, ENTITIES, newId)
    expect(r.dimension).toBeNull()
    expect(r.chain).toEqual(chain) // operands kept for the next click
    expect(r.notice).toContain('second point or a line')
  })

  // The reported bug: after one operand, a near-miss of a thin second line
  // slipped into the placement branch and silently committed a one-operand
  // dim. The decision rule must be: HIT an unpicked operand -> add it; click
  // GENUINELY empty space -> commit; near-miss of an UNPICKED entity -> stay
  // armed (hint), never commit.
  describe('operand-vs-placement decision (no accidental 1-operand commit)', () => {
    // A near-miss sits just OUTSIDE the (enlarged) operand hit radius but
    // INSIDE the placement margin of an unpicked entity.
    it('two lines: near-miss of the 2nd line does NOT commit (stays armed)', () => {
      const newId = newIds()
      const chain = { kind: 'dim' as const, operandIds: ['la'] }
      // ~1.0 from lb (y=5): outside 0.75 hit, inside 1.25 margin.
      const r = dimToolClick(chain, { x: 5, y: 6 }, TOL, ENTITIES, newId)
      expect(r.dimension).toBeNull()
      expect(r.chain).toEqual(chain)
      expect(r.notice).toContain('second entity')
    })

    it('two lines: a HIT on the 2nd line adds it (no commit)', () => {
      const newId = newIds()
      const chain = { kind: 'dim' as const, operandIds: ['la'] }
      const r = dimToolClick(chain, { x: 5, y: 5 }, TOL, ENTITIES, newId) // on lb
      expect(r.dimension).toBeNull()
      expect(r.chain).toEqual({ kind: 'dim', operandIds: ['la', 'lb'] })
    })

    it('two lines: clear empty space COMMITS the parallel-distance dim', () => {
      const newId = newIds()
      const chain = { kind: 'dim' as const, operandIds: ['la', 'lb'] }
      const r = dimToolClick(chain, { x: 5, y: 12 }, TOL, ENTITIES, newId)
      expect(r.dimension?.kind).toBe('distancePL')
      expect(r.chain).toBeNull()
    })

    it('single line: near-miss does not commit; clear space commits', () => {
      const newId = newIds()
      const chain = { kind: 'dim' as const, operandIds: ['la'] }
      // ~1.0 above la (y=0): inside margin of the line we are dimensioning?
      // la IS already picked, so a click near it is allowed to place. Use lc
      // (unpicked, x=20) for the near-miss instead.
      const miss = dimToolClick(chain, { x: 20.9, y: 4 }, TOL, ENTITIES, newId) // ~0.9 from lc
      expect(miss.dimension).toBeNull()
      expect(miss.notice).toContain('second entity')
      const ok = dimToolClick(chain, { x: 5, y: 9 }, TOL, ENTITIES, newId)
      expect(ok.dimension?.kind).toBe('distanceX')
      expect(ok.dimension?.value).toBeCloseTo(10, 9)
    })

    it('two points: near-miss does not commit; clear space commits', () => {
      const newId = newIds()
      const chain = { kind: 'dim' as const, operandIds: ['pa'] } // pa (0,20)
      // ~1.0 from pb (3,24): outside 0.75 hit, inside 1.25 margin.
      const miss = dimToolClick(chain, { x: 3, y: 25 }, TOL, ENTITIES, newId)
      expect(miss.dimension).toBeNull()
      expect(miss.notice).toContain('second entity')
      // HIT pb -> add it, then place in open space -> commit a distance.
      const add = dimToolClick(chain, { x: 3, y: 24 }, TOL, ENTITIES, newId)
      expect(add.chain).toEqual({ kind: 'dim', operandIds: ['pa', 'pb'] })
      const place = dimToolClick(add.chain, { x: 12, y: 22 }, TOL, ENTITIES, newId)
      expect(place.dimension).not.toBeNull()
      expect(place.chain).toBeNull()
    })

    it('point + line: near-miss does not commit; clear space commits distancePL', () => {
      const newId = newIds()
      const chain = { kind: 'dim' as const, operandIds: ['pa'] } // pa (0,20)
      // ~0.9 from lc (x=20): near-miss of an unpicked line.
      const miss = dimToolClick(chain, { x: 19.1, y: 4 }, TOL, ENTITIES, newId)
      expect(miss.dimension).toBeNull()
      const add = dimToolClick(chain, { x: 5, y: 0 }, TOL, ENTITIES, newId) // on la
      expect(add.chain).toEqual({ kind: 'dim', operandIds: ['pa', 'la'] })
      const place = dimToolClick(add.chain, { x: 5, y: 12 }, TOL, ENTITIES, newId)
      expect(place.dimension?.kind).toBe('distancePL')
    })

    it('circle: clear space commits a diameter (single-operand placement still works)', () => {
      const newId = newIds()
      const chain = { kind: 'dim' as const, operandIds: ['ca'] } // ca (40,0) r4
      const r = dimToolClick(chain, { x: 50, y: 10 }, TOL, ENTITIES, newId)
      expect(r.dimension?.kind).toBe('diameter')
      expect(r.dimension?.value).toBeCloseTo(8, 9)
      expect(r.chain).toBeNull()
    })
  })

  it('parallel line pair places a point-to-line distance', () => {
    const newId = newIds()
    const r1 = dimToolClick(null, { x: 5, y: 0 }, TOL, ENTITIES, newId)
    const r2 = dimToolClick(r1.chain, { x: 5, y: 5 }, TOL, ENTITIES, newId)
    expect(r2.chain).toEqual({ kind: 'dim', operandIds: ['la', 'lb'] })
    const r3 = dimToolClick(r2.chain, { x: 15, y: 2.5 }, TOL, ENTITIES, newId)
    const d = r3.dimension!
    expect(d.kind).toBe('distancePL')
    expect(d.value).toBeCloseTo(5, 9)
  })
})

// ---- explicit snapped-point threading (the corner+line fix, end to end) --------

describe('dimToolClick: explicit snapped point -> POINT operand', () => {
  const TOL = 0.5
  const snapAt = (entityId: string, site: 'start' | 'end' | 'center' | 'self',
    x: number, y: number) => ({ point: { x, y }, ref: { entityId, site } })

  it('snapped corner of line A + line B commits distancePL, not angle', () => {
    const newId = newIds()
    // 1) Snap la END (10,0) -> recorded as the explicit point { la, end }.
    const r1 = dimToolClick(null, { x: 10, y: 0 }, TOL, ENTITIES, newId,
      snapAt('la', 'end', 10, 0))
    expect(r1.chain).toEqual({ kind: 'dim', operandIds: [{ entityId: 'la', site: 'end' }] })
    // 2) Click the vertical line lc BODY (no snap).
    const r2 = dimToolClick(r1.chain, { x: 20, y: 4 }, TOL, ENTITIES, newId)
    expect(r2.chain).toEqual({
      kind: 'dim', operandIds: [{ entityId: 'la', site: 'end' }, 'lc'],
    })
    // 3) Place -> distancePL (perp distance 10), NOT an angle.
    const r3 = dimToolClick(r2.chain, { x: 15, y: -8 }, TOL, ENTITIES, newId)
    expect(r3.dimension?.kind).toBe('distancePL')
    expect(r3.dimension?.value).toBeCloseTo(10, 9)
  })

  it('corner + its OWN line (either order) is guarded: no crash, feedback', () => {
    const newId = newIds()
    // Line body first, then snap its own endpoint -> caught by the id dedup.
    const body = dimToolClick(null, { x: 5, y: 0 }, TOL, ENTITIES, newId) // la body
    const own = dimToolClick(body.chain, { x: 0, y: 0 }, TOL, ENTITIES, newId,
      snapAt('la', 'start', 0, 0))
    expect(own.dimension).toBeNull()
    expect(own.notice).toContain('already picked')
    // Endpoint first, then its own line body -> also caught by the dedup.
    const ep = dimToolClick(null, { x: 0, y: 0 }, TOL, ENTITIES, newId,
      snapAt('la', 'start', 0, 0))
    expect(ep.chain).toEqual({ kind: 'dim', operandIds: [{ entityId: 'la', site: 'start' }] })
    const own2 = dimToolClick(ep.chain, { x: 5, y: 0 }, TOL, ENTITIES, newId)
    expect(own2.notice).toContain('already picked')
  })

  it('explicit is ignored when the snap is far from the click (falls back to entity pick)', () => {
    const newId = newIds()
    // Click on la body at (5,0) but the snap point (0,0) is 5 away (> operand
    // tol) -> the explicit point is dropped and the whole LINE is picked.
    const r = dimToolClick(null, { x: 5, y: 0 }, TOL, ENTITIES, newId,
      snapAt('la', 'start', 0, 0))
    expect(r.chain).toEqual({ kind: 'dim', operandIds: ['la'] })
  })

  it('(f) preview matches commit for an explicit endpoint pick', () => {
    const chain = {
      kind: 'dim' as const,
      operandIds: [{ entityId: 'la', site: 'end' as const }, 'lc'],
    }
    const cursor: Vec2 = { x: 15, y: -8 }
    const preview = dimPreview(ENTITIES, chain, 'mm', cursor)!
    const placement = resolveDimPlacement(ENTITIES, chain.operandIds, cursor)!
    const out = dimToolClick(chain, cursor, TOL, ENTITIES, newIds())
    expect(preview.mode).toBe('Perpendicular')
    expect(out.dimension?.kind).toBe('distancePL')
    expect(out.dimension?.kind).toBe(placement.kind)
    expect(out.dimension?.value).toBeCloseTo(placement.value, 9)
    // The previewed TEXT is exactly the formatted committed value.
    expect(preview.text).toBe(
      formatDimensionValue(out.dimension!.kind, out.dimension!.value, true))
  })
})

describe('toolClick: ctx.dimExplicitPoint threads to a POINT operand', () => {
  it('a snapped endpoint in ctx becomes an explicit-point operand', () => {
    const state = { tool: 'smart-dimension' as const, chain: null }
    const r = toolClick(state, { x: 10, y: 0 }, 0.5, newIds(), {
      entities: ENTITIES,
      dimExplicitPoint: { point: { x: 10, y: 0 }, ref: { entityId: 'la', site: 'end' } },
    })
    expect(r.state.chain).toEqual({
      kind: 'dim', operandIds: [{ entityId: 'la', site: 'end' }],
    })
  })
})

// ---- orientation force (Tab hotkey) ---------------------------------------------

describe('smart-dimension orientation force (Tab)', () => {
  const TOL = 0.5

  it('cycleDimForceMode cycles auto -> aligned -> H(x) -> V(y) -> auto', () => {
    expect(cycleDimForceMode(null)).toBe('aligned')
    expect(cycleDimForceMode(undefined)).toBe('aligned')
    expect(cycleDimForceMode('aligned')).toBe('x')
    expect(cycleDimForceMode('x')).toBe('y')
    expect(cycleDimForceMode('y')).toBeNull()
  })

  it('forced orientation OVERRIDES the drag-vector auto-snap at commit', () => {
    const newId = newIds()
    // ph,ph2: H-aligned 7 apart; placing BELOW is a vertical drag -> auto
    // picks distanceX.
    const auto = dimToolClick(
      { kind: 'dim', operandIds: ['ph', 'ph2'] }, { x: 3.5, y: 9 }, TOL, ENTITIES, newId)
    expect(auto.dimension?.kind).toBe('distanceX')
    // Same placement, but Tab forced 'aligned' -> plain distance (true length).
    const forced = dimToolClick(
      { kind: 'dim', operandIds: ['ph', 'ph2'], forceMode: 'aligned' },
      { x: 3.5, y: 9 }, TOL, ENTITIES, newId)
    expect(forced.dimension?.kind).toBe('distance')
    expect(forced.dimension?.value).toBeCloseTo(7, 9)
  })

  it('forceMode is carried forward as a second operand is added', () => {
    const newId = newIds()
    const r = dimToolClick(
      { kind: 'dim', operandIds: ['ph'], forceMode: 'y' },
      { x: 7, y: 30 }, TOL, ENTITIES, newId) // hit ph2 (7,30)
    expect(r.chain).toEqual({ kind: 'dim', operandIds: ['ph', 'ph2'], forceMode: 'y' })
  })
})

// ---- tool machine integration ---------------------------------------------------

describe('smart-dimension in the tool machine', () => {
  const ctx = { entities: ENTITIES }

  it('arms, accumulates, commits a dimension, stays armed; Esc clears operands', () => {
    let state = armTool(IDLE_TOOL_STATE, 'smart-dimension')
    expect(state).toEqual({ tool: 'smart-dimension', chain: null })

    const newId = newIds()
    // Click the arc -> operand chain.
    let r = toolClick(state, { x: 60, y: 6.2 }, 0.5, newId, ctx)
    expect(r.state.chain).toEqual({ kind: 'dim', operandIds: ['ar'] })
    expect(r.commit).toBeNull()

    // Empty click -> commit carries ONE dimension, no entities.
    r = toolClick(r.state, { x: 70, y: 20 }, 0.5, newId, ctx)
    expect(r.commit).not.toBeNull()
    expect(r.commit!.entities).toHaveLength(0)
    expect(r.commit!.dimensions).toHaveLength(1)
    expect(r.commit!.dimensions![0].kind).toBe('radius')
    expect(r.state.tool).toBe('smart-dimension') // stays armed

    // Rejection surfaces as a notice on the click result.
    r = toolClick(r.state, { x: 44, y: 0 }, 0.5, newId, ctx) // circle
    r = toolClick(r.state, { x: 0, y: 20 }, 0.5, newId, ctx) // + point = invalid
    expect(r.notice).toContain('cannot dimension')

    // Esc: first clears the operand set (stays armed), second disarms.
    const esc1 = escapeTool(r.state)
    expect(esc1.consumed).toBe(true)
    expect(esc1.state).toEqual({ tool: 'smart-dimension', chain: null })
    const esc2 = escapeTool(esc1.state)
    expect(esc2.state.tool).toBe('select')
  })
})

// ---- preview + formatting -------------------------------------------------------

describe('dimPreview / formatDimensionValue', () => {
  it('previews the inferred value for a valid set, a hint otherwise', () => {
    expect(dimPreview(ENTITIES, { kind: 'dim', operandIds: ['ca'] }))
      .toEqual({ text: 'D8.00', hint: false, mode: 'Diameter', showTabHint: false })
    expect(dimPreview(ENTITIES, { kind: 'dim', operandIds: ['la', 'lc'] }))
      .toEqual({ text: '90.0 deg', hint: false, mode: 'Angle', showTabHint: false })
    const hint = dimPreview(ENTITIES, { kind: 'dim', operandIds: ['pa'] })
    expect(hint?.hint).toBe(true)
    expect(hint?.mode).toBeNull()
    expect(hint?.showTabHint).toBe(false)
    expect(dimPreview(ENTITIES, null)).toBeNull()
    expect(dimPreview(ENTITIES, { kind: 'dim', operandIds: [] })).toBeNull()
  })

  it('reference dims parenthesize per CAD convention', () => {
    expect(formatDimensionValue('distance', 12.5, true)).toBe('12.50')
    expect(formatDimensionValue('distance', 12.5, false)).toBe('(12.50)')
    expect(formatDimensionValue('radius', 3, false)).toBe('(R3.00)')
  })
})

// ---- MODE label + Tab affordance (live cursor readout) ------------------------
//
// The cursor preview must NAME the resolved orientation (no blind interactive
// op) and the value must match that orientation. dimModeLabel/isLinearDimKind
// are the pure mapping; dimPreview(cursor,forceMode) drives value + mode from
// the SAME resolver the witness lines + commit use (preview === commit).

describe('dimModeLabel / isLinearDimKind (pure mapping)', () => {
  it('maps every kind to its human label', () => {
    expect(dimModeLabel('distance')).toBe('Aligned')
    expect(dimModeLabel('distanceX')).toBe('Horizontal')
    expect(dimModeLabel('distanceY')).toBe('Vertical')
    expect(dimModeLabel('distancePL')).toBe('Perpendicular')
    expect(dimModeLabel('radius')).toBe('Radius')
    expect(dimModeLabel('diameter')).toBe('Diameter')
    expect(dimModeLabel('angle')).toBe('Angle')
  })
  it('only the Tab-cyclable linear family flags the affordance', () => {
    expect(isLinearDimKind('distance')).toBe(true)
    expect(isLinearDimKind('distanceX')).toBe(true)
    expect(isLinearDimKind('distanceY')).toBe(true)
    expect(isLinearDimKind('distancePL')).toBe(false)
    expect(isLinearDimKind('radius')).toBe(false)
    expect(isLinearDimKind('diameter')).toBe(false)
    expect(isLinearDimKind('angle')).toBe(false)
  })
})

describe('dimPreview: value + MODE track the resolved orientation', () => {
  const chain = (ops: string[]) => ({ kind: 'dim' as const, operandIds: ops })

  it("forced 'x' -> Horizontal label + horizontal value (|dx|)", () => {
    // pa(0,20)->pb(3,24): dx=3, dy=4. Forcing x measures the horizontal gap.
    const p = dimPreview(ENTITIES, chain(['pa', 'pb']), 'mm', { x: 1.5, y: 30 }, 'x')!
    expect(p.hint).toBe(false)
    expect(p.mode).toBe('Horizontal')
    expect(p.text).toBe('3.00')
    expect(p.showTabHint).toBe(true)
  })

  it('aligned SIDE pull (perpendicular to the segment) -> Aligned label + true length', () => {
    // NEW SEMANTICS: the aligned label is reached by pulling PERPENDICULAR to
    // the feature (its natural side gesture), NOT by dragging along it. pa(0,20)
    // -> pb(3,24) is the 3-4-5 diagonal (midpoint (1.5,22)); pull along its
    // normal (-4,3) to (-2.5,25) -> auto-snap aligned.
    const p = dimPreview(ENTITIES, chain(['pa', 'pb']), 'mm', { x: -2.5, y: 25 })!
    expect(p.mode).toBe('Aligned')
    expect(p.text).toBe('5.00') // true point-to-point length
    expect(p.showTabHint).toBe(true)
  })

  it("forced 'y' -> Vertical label + vertical value (|dy|)", () => {
    const p = dimPreview(ENTITIES, chain(['pa', 'pb']), 'mm', { x: 20, y: 22 }, 'y')!
    expect(p.mode).toBe('Vertical')
    expect(p.text).toBe('4.00')
  })

  it('arc radius pick -> Radius label and the Radius / Arc length Tab hint', () => {
    const p = dimPreview(ENTITIES, chain(['ar']), 'mm', { x: 66, y: 6 })!
    expect(p.mode).toBe('Radius')
    expect(p.text).toBe('R6.00')
    expect(p.showTabHint).toBe(true)
  })

  it('point+line -> Perpendicular, no Tab hint (Tab does not affect it)', () => {
    const p = dimPreview(ENTITIES, chain(['pa', 'la']), 'mm', { x: 5, y: 10 })!
    expect(p.mode).toBe('Perpendicular')
    expect(p.showTabHint).toBe(false)
  })

  it('without a cursor, falls back to the orientation-blind plan (still labeled)', () => {
    const p = dimPreview(ENTITIES, chain(['pa', 'pb']))!
    expect(p.mode).toBe('Aligned') // plan default is the aligned distance
    expect(p.showTabHint).toBe(true)
  })
})

// ---- measurement ---------------------------------------------------------------

describe('measureDimension', () => {
  it('measures every dimension kind against current geometry', () => {
    const m = (d: SketchDimension) => measureDimension(ENTITIES, d)
    expect(m({ id: 'd1', kind: 'distance', driving: true, value: 0,
      a: { entityId: 'pa', site: 'self' }, b: { entityId: 'pb', site: 'self' } }))
      .toBeCloseTo(5, 9)
    expect(m({ id: 'd2', kind: 'distanceX', driving: true, value: 0,
      a: { entityId: 'pa', site: 'self' }, b: { entityId: 'pb', site: 'self' } }))
      .toBeCloseTo(3, 9) // signed b-a, mirrors the 'difference' mapping
    expect(m({ id: 'd3', kind: 'distanceY', driving: true, value: 0,
      a: { entityId: 'pb', site: 'self' }, b: { entityId: 'pa', site: 'self' } }))
      .toBeCloseTo(-4, 9)
    expect(m({ id: 'd4', kind: 'distancePL', driving: true, value: 0,
      point: { entityId: 'pa', site: 'self' }, line: 'la' }))
      .toBeCloseTo(20, 9)
    expect(m({ id: 'd5', kind: 'angle', driving: true, value: 0, a: 'la', b: 'lc' }))
      .toBeCloseTo(Math.PI / 2, 9)
    expect(m({ id: 'd6', kind: 'radius', driving: true, value: 0, entityId: 'ar' }))
      .toBeCloseTo(6, 9)
    expect(m({ id: 'd7', kind: 'diameter', driving: true, value: 0, entityId: 'ca' }))
      .toBeCloseTo(8, 9)
    expect(m({ id: 'd8', kind: 'radius', driving: true, value: 0, entityId: 'missing' }))
      .toBeNull()
  })
})

// ---- ellipse major/minor radius dimensions (inert direct-edit) ---------------

function ellipse(
  id: string, cx: number, cy: number, major: number, minor: number, rot = 0,
): SketchEntity {
  return { id, kind: 'ellipse', construction: false,
    center: { x: cx, y: cy }, majorRadius: major, minorRadius: minor, rotation: rot }
}

describe('ellipse dimensioning', () => {
  const el = ellipse('el', 0, 0, 10, 5) // major +X vertex (10,0); minor +Y (0,5)
  const ents: SketchEntity[] = [el]

  it('a single ellipse IS pickable as a dim operand (outline hit)', () => {
    // Click near the +major vertex (10,0), on the outline.
    expect(pickDimOperand(ents, { x: 10.2, y: 0 }, 0.5)).toBe('el')
    // Click far from the outline (near the center, well inside) -> no hit.
    expect(pickDimOperand(ents, { x: 0, y: 0 }, 0.5)).toBeNull()
  })

  it('an elliptical arc is pickable as a dim operand', () => {
    const arcEl: SketchEntity = { id: 'ea', kind: 'elliptical-arc', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
      startParam: 0, endParam: Math.PI / 2 }
    // On the arc near the +major vertex.
    expect(pickDimOperand([arcEl], { x: 10.2, y: 0 }, 0.5)).toBe('ea')
  })

  it('single ellipse -> majorRadius plan (orientation-blind default)', () => {
    const out = planDimension(ents, ['el'])
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.plan.kind).toBe('majorRadius')
      expect(out.plan).toMatchObject({ entityId: 'el', value: 10 })
    }
  })

  it('measureDimension reports majorRadius and minorRadius', () => {
    expect(measureDimension(ents,
      { id: 'm1', kind: 'majorRadius', driving: true, value: 0, entityId: 'el' }))
      .toBeCloseTo(10, 9)
    expect(measureDimension(ents,
      { id: 'm2', kind: 'minorRadius', driving: true, value: 0, entityId: 'el' }))
      .toBeCloseTo(5, 9)
    // Wrong-kind / missing target -> null (never a wrong number).
    expect(measureDimension(ENTITIES,
      { id: 'm3', kind: 'majorRadius', driving: true, value: 0, entityId: 'ca' }))
      .toBeNull()
  })

  it('label text distinguishes major vs minor radius at a glance', () => {
    const maj = formatDimensionValue('majorRadius', 10, true)
    const min = formatDimensionValue('minorRadius', 5, true)
    expect(maj).toContain('maj')
    expect(min).toContain('min')
    expect(maj).not.toBe(min)
    // Reference (driven) dims still parenthesize per CAD convention.
    expect(formatDimensionValue('majorRadius', 10, false)).toBe(`(${maj})`)
  })
})

// ---- focus-to-focus (2c) dimension -----------------------------------------

describe('ellipse focus-to-focus dimension', () => {
  // a=5 on +X, b=3 on +Y -> c=4, foci at (+-4, 0), 2c=8.
  const e2 = ellipse('e2', 0, 0, 5, 3)
  const e3 = ellipse('e3', 30, 0, 5, 3) // a second, distinct ellipse
  const ents: SketchEntity[] = [e2, e3]
  // Focus operand (explicit point site).
  const F = (entityId: string, site: 'focus1' | 'focus2') => ({ entityId, site })

  it('two foci of the SAME ellipse -> focusDistance plan (value = 2c)', () => {
    const out = planDimension(ents, [F('e2', 'focus1'), F('e2', 'focus2')])
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.plan.kind).toBe('focusDistance')
      expect(out.plan).toMatchObject({ entityId: 'e2' })
      expect((out.plan as { value: number }).value).toBeCloseTo(8, 9)
    }
  })

  it('two foci of DIFFERENT ellipses -> plain distance (NOT focusDistance)', () => {
    const out = planDimension(ents, [F('e2', 'focus1'), F('e3', 'focus1')])
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.plan.kind).toBe('distance')
  })

  it('a focus + a non-focus point -> plain distance (NOT focusDistance)', () => {
    const pt: SketchEntity = { id: 'p1', kind: 'point', construction: false, at: { x: 9, y: 9 } }
    const out = planDimension([...ents, pt], [F('e2', 'focus1'), { entityId: 'p1', site: 'self' }])
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.plan.kind).toBe('distance')
  })

  it('measureDimension on focusDistance = inter-focal distance 2c', () => {
    expect(measureDimension(ents,
      { id: 'mF', kind: 'focusDistance', driving: true, value: 0, entityId: 'e2' }))
      .toBeCloseTo(8, 9)
    // Wrong-kind target -> null.
    expect(measureDimension(ENTITIES,
      { id: 'mF2', kind: 'focusDistance', driving: true, value: 0, entityId: 'ca' }))
      .toBeNull()
  })

  it('label text carries the 2c value', () => {
    const t = formatDimensionValue('focusDistance', 8, true)
    expect(t).toContain('2c')
    expect(formatDimensionValue('focusDistance', 8, false)).toBe(`(${t})`)
  })

  it('dimToolClick: snapping BOTH foci of one ellipse commits a focusDistance dim', () => {
    const newId = newIds()
    const TOL = 0.5
    // 1) Snap focus1 at (4,0).
    const r1 = dimToolClick(null, { x: 4, y: 0 }, TOL, ents, newId,
      { point: { x: 4, y: 0 }, ref: { entityId: 'e2', site: 'focus1' } })
    expect(r1.chain).toEqual({ kind: 'dim', operandIds: [{ entityId: 'e2', site: 'focus1' }] })
    // 2) Snap focus2 at (-4,0) -- SAME ellipse, DIFFERENT site: the same-entity
    // guard makes an exception, so it is accepted (not "already picked").
    const r2 = dimToolClick(r1.chain, { x: -4, y: 0 }, TOL, ents, newId,
      { point: { x: -4, y: 0 }, ref: { entityId: 'e2', site: 'focus2' } })
    expect(r2.notice).toBeNull()
    expect(r2.chain).toEqual({ kind: 'dim',
      operandIds: [{ entityId: 'e2', site: 'focus1' }, { entityId: 'e2', site: 'focus2' }] })
    // 3) Place in open space -> commit the focusDistance dim (value = 2c = 8).
    const r3 = dimToolClick(r2.chain, { x: 0, y: 12 }, TOL, ents, newId)
    expect(r3.dimension?.kind).toBe('focusDistance')
    expect(r3.dimension?.value).toBeCloseTo(8, 9)
  })
})
