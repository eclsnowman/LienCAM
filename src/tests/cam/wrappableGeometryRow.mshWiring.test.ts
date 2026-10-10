// MSH-3 wiring / INT-IMPORT-EDIT stage 4: the shared "Edit as model" gate
// predicates. One predicate (isWrappableGeometryRow) all three nav paths gate
// their affordance on -- the shared-resolver discipline: STEP part OR STL mesh,
// never a nest seed, never any other format, never a model-origin row.

import { describe, it, expect } from 'vitest'
import {
  isWrappableStepRow,
  isWrappableMeshRow,
  isWrappableGeometryRow,
} from '../../lib/cam/modelOrigin'

describe('MSH-3 wiring: isWrappableMeshRow', () => {
  it('TRUE for a plain STL row', () => {
    expect(isWrappableMeshRow({ format: 'stl' })).toBe(true)
  })
  it('FALSE for a nest-seed STL copy', () => {
    expect(isWrappableMeshRow({ format: 'stl', ownerNestId: 'nest-1' })).toBe(false)
  })
  it('FALSE for a STEP row (that is isWrappableStepRow, not mesh)', () => {
    expect(isWrappableMeshRow({ format: 'step' })).toBe(false)
  })
  it('FALSE for null / undefined', () => {
    expect(isWrappableMeshRow(null)).toBe(false)
    expect(isWrappableMeshRow(undefined)).toBe(false)
  })
})

describe('MSH-3 wiring: isWrappableGeometryRow (STEP OR STL)', () => {
  it('TRUE for a plain STEP part and a plain STL mesh', () => {
    expect(isWrappableGeometryRow({ format: 'step' })).toBe(true)
    expect(isWrappableGeometryRow({ format: 'stl' })).toBe(true)
  })
  it('FALSE for a nest-seed copy of either', () => {
    expect(isWrappableGeometryRow({ format: 'step', ownerNestId: 'n' })).toBe(false)
    expect(isWrappableGeometryRow({ format: 'stl', ownerNestId: 'n' })).toBe(false)
  })
  it('FALSE for every other format (dxf, svg, obj, model)', () => {
    for (const format of ['dxf', 'svg', 'obj', 'model', 'iges']) {
      expect(isWrappableGeometryRow({ format })).toBe(false)
    }
  })
  it('agrees with the two branch predicates (union)', () => {
    for (const format of ['step', 'stl', 'dxf', 'model']) {
      const geo = { format }
      expect(isWrappableGeometryRow(geo)).toBe(isWrappableStepRow(geo) || isWrappableMeshRow(geo))
    }
  })
})
