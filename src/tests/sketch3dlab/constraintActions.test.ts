import { describe, expect, it } from 'vitest'
import type { Sketch3dDocument, Sketch3dPointRef } from '../../sketch3d'
import { applyConstraintFromSelection, constraintNeedsValue, EMPTY_SELECTION, SKETCH3DLAB_CONSTRAINT_KINDS } from '../../components/sketch3dlab/constraintActions'

function doc(): Sketch3dDocument {
  return {
    id: 'd',
    entities: [
      { id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'l2', kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { id: 'c1', kind: 'circle', center: { x: 0, y: 10 }, radius: 3 },
      { id: 'a1', kind: 'arc', center: { x: 20, y: 20 }, radius: 4, startAngle: 0, endAngle: 1 },
    ],
    constraints: [],
  }
}

const l1Start: Sketch3dPointRef = { entityId: 'l1', site: 'start' }
const l1End: Sketch3dPointRef = { entityId: 'l1', site: 'end' }
const l2Start: Sketch3dPointRef = { entityId: 'l2', site: 'start' }
const c1Center: Sketch3dPointRef = { entityId: 'c1', site: 'center' }

describe('sketch3dlab constraintActions: every required kind applies from the right selection', () => {
  it('lists exactly the 13 required constraint kinds', () => {
    expect(SKETCH3DLAB_CONSTRAINT_KINDS.sort()).toEqual(
      [
        'coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'tangent', 'equal',
        'midpoint', 'distance', 'angle', 'radius', 'diameter', 'fixed',
      ].sort(),
    )
  })

  it('coincident: 2 points selected', () => {
    const out = applyConstraintFromSelection('coincident', doc(), { points: [l1End, l2Start], entities: [] }, 'c1', null)
    expect(out.error).toBeUndefined()
    const added = out.document!.constraints[0]
    expect(added).toMatchObject({ kind: 'coincident', a: l1End, b: l2Start })
  })

  it('horizontal: 1 line entity selected', () => {
    const out = applyConstraintFromSelection('horizontal', doc(), { points: [], entities: ['l1'] }, 'c1', null)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'horizontal', line: 'l1' })
  })

  it('horizontal: 2 points selected (line-free form)', () => {
    const out = applyConstraintFromSelection('horizontal', doc(), { points: [l1Start, l1End], entities: [] }, 'c1', null)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'horizontal', points: [l1Start, l1End] })
  })

  it('vertical: 1 line entity selected', () => {
    const out = applyConstraintFromSelection('vertical', doc(), { points: [], entities: ['l2'] }, 'c1', null)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'vertical', line: 'l2' })
  })

  for (const kind of ['parallel', 'perpendicular', 'tangent', 'equal'] as const) {
    it(`${kind}: 2 entities selected`, () => {
      const out = applyConstraintFromSelection(kind, doc(), { points: [], entities: ['l1', 'l2'] }, 'c1', null)
      expect(out.document!.constraints[0]).toMatchObject({ kind, a: 'l1', b: 'l2' })
    })
  }

  it('midpoint: 1 point + 1 line selected', () => {
    const out = applyConstraintFromSelection('midpoint', doc(), { points: [c1Center], entities: ['l1'] }, 'c1', null)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'midpoint', point: c1Center, line: 'l1' })
  })

  it('distance: point-point form with a numeric value', () => {
    const out = applyConstraintFromSelection('distance', doc(), { points: [l1Start, l1End], entities: [] }, 'c1', 10)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'distance', a: l1Start, b: l1End, value: 10 })
  })

  it('distance: point-line form with a numeric value', () => {
    const out = applyConstraintFromSelection('distance', doc(), { points: [c1Center], entities: ['l1'] }, 'c1', 5)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'distance', a: c1Center, line: 'l1', value: 5 })
  })

  it('angle: 2 lines + a numeric value', () => {
    const out = applyConstraintFromSelection('angle', doc(), { points: [], entities: ['l1', 'l2'] }, 'c1', 90)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'angle', a: 'l1', b: 'l2', value: 90 })
  })

  it('radius: 1 entity + a numeric value', () => {
    const out = applyConstraintFromSelection('radius', doc(), { points: [], entities: ['c1'] }, 'c1', 3)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'radius', entityId: 'c1', value: 3 })
  })

  it('diameter: 1 entity + a numeric value', () => {
    const out = applyConstraintFromSelection('diameter', doc(), { points: [], entities: ['a1'] }, 'c1', 8)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'diameter', entityId: 'a1', value: 8 })
  })

  it('fixed: 1 point selected', () => {
    const out = applyConstraintFromSelection('fixed', doc(), { points: [l1Start], entities: [] }, 'c1', null)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'fixed', point: l1Start })
  })

  it('fixed: 1 entity selected', () => {
    const out = applyConstraintFromSelection('fixed', doc(), { points: [], entities: ['l1'] }, 'c1', null)
    expect(out.document!.constraints[0]).toMatchObject({ kind: 'fixed', entityId: 'l1' })
  })
})

describe('sketch3dlab constraintActions: FAILS-IF wrong selection shape or missing value', () => {
  it('coincident with 1 point errors, does not mutate the document', () => {
    const base = doc()
    const out = applyConstraintFromSelection('coincident', base, { points: [l1Start], entities: [] }, 'c1', null)
    expect(out.error).toMatch(/coincident/i)
    expect(out.document).toBeUndefined()
  })

  it('distance without a value errors', () => {
    const out = applyConstraintFromSelection('distance', doc(), { points: [l1Start, l1End], entities: [] }, 'c1', null)
    expect(out.error).toMatch(/numeric value/i)
  })

  it('radius with a non-finite value errors', () => {
    const out = applyConstraintFromSelection('radius', doc(), { points: [], entities: ['c1'] }, 'c1', NaN)
    expect(out.error).toMatch(/numeric value/i)
  })

  it('parallel with only 1 entity errors', () => {
    const out = applyConstraintFromSelection('parallel', doc(), { points: [], entities: ['l1'] }, 'c1', null)
    expect(out.error).toMatch(/2 entities/i)
  })

  it('fixed with both a point and an entity selected errors', () => {
    const out = applyConstraintFromSelection('fixed', doc(), { points: [l1Start], entities: ['l1'] }, 'c1', null)
    expect(out.error).toMatch(/fixed/i)
  })

  it('duplicate constraint id surfaces the underlying constraintTools error', () => {
    const base: Sketch3dDocument = { ...doc(), constraints: [{ id: 'dup', kind: 'fixed', point: l1Start }] }
    const out = applyConstraintFromSelection('fixed', base, { points: [l1End], entities: [] }, 'dup', null)
    expect(out.error).toMatch(/duplicate constraint id/i)
  })

  it('constraintNeedsValue is true only for distance/angle/radius/diameter', () => {
    expect(constraintNeedsValue('distance')).toBe(true)
    expect(constraintNeedsValue('angle')).toBe(true)
    expect(constraintNeedsValue('radius')).toBe(true)
    expect(constraintNeedsValue('diameter')).toBe(true)
    expect(constraintNeedsValue('coincident')).toBe(false)
    expect(constraintNeedsValue('fixed')).toBe(false)
  })

  it('EMPTY_SELECTION has no points or entities', () => {
    expect(EMPTY_SELECTION).toEqual({ points: [], entities: [] })
  })
})
