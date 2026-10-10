// WO-1482: dimension/constraint rejection notices name operands with the
// same readable per-kind labels the design-tree browser panel shows
// ("Horizontal(Line 1)"), never truncated raw entity ids.
//
// Fails on main: describeOne truncated ids to 8 chars, so the notice read
// "Horizontal(11111111)" and a multi-operand dimension read as a string of
// opaque id fragments that overflows the footer.

import { describe, it, expect } from 'vitest'
import { describeConstraintSet } from '../../lib/sketch/constraintActions'
import { entityLabels } from '../../lib/sketch/browserModel'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension,
} from '../../lib/sketch/types'

// UUID-shaped ids so the main-branch `id.slice(0, 8)` is visibly opaque.
const ID_L1 = '11111111-aaaa-4aaa-8aaa-111111111111'
const ID_L2 = '22222222-bbbb-4bbb-8bbb-222222222222'
const ID_C1 = '33333333-cccc-4ccc-8ccc-333333333333'

function line(id: string): SketchEntity {
  return { id, kind: 'line', construction: false,
    start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }
}
function circle(id: string): SketchEntity {
  return { id, kind: 'circle', construction: false,
    center: { x: 0, y: 0 }, radius: 5 }
}

function sketchWith(dimensions: SketchDimension[]): Sketch {
  const entities = [line(ID_L1), line(ID_L2), circle(ID_C1)]
  const constraints: SketchConstraint[] = [
    { id: 'cn-h', kind: 'horizontal', line: ID_L1 },
    { id: 'cn-tan', kind: 'tangent', a: ID_L1, b: ID_C1 },
  ]
  return {
    id: 'sk', layerId: 'layer', entities,
    constraints, dimensions, solveStatus: null,
  }
}

describe('describeConstraintSet readable operand labels (WO-1482)', () => {
  it('names constraint operands by document-order kind labels, not id fragments', () => {
    const sk = sketchWith([])
    const notice = describeConstraintSet(sk, ['cn-h'], new Set())
    expect(notice).toBe('Horizontal(Line 1)')
    // The raw/truncated id never reaches the operator.
    expect(notice).not.toContain('11111111')
  })

  it('names multi-operand constraints the same way the browser panel does', () => {
    const sk = sketchWith([])
    const labels = entityLabels(sk.entities)
    expect(labels.get(ID_L1)).toBe('Line 1')
    expect(labels.get(ID_C1)).toBe('Circle 1')
    const notice = describeConstraintSet(sk, ['cn-tan'], new Set())
    expect(notice).toBe('Tangent(Line 1, Circle 1)')
  })

  it('names dimension operands readably and dedupes a self-referencing distance', () => {
    // A line-length distance references the SAME entity at start + end
    // sites; it must read as ONE operand ("Line 1"), matching the browser
    // panel's refsLabel convention.
    const dim: SketchDimension = {
      id: 'dm-w', kind: 'distance', driving: true, value: 100,
      a: { entityId: ID_L1, site: 'start' },
      b: { entityId: ID_L1, site: 'end' },
    }
    const notice = describeConstraintSet(sketchWith([dim]), ['dm-w'], new Set())
    expect(notice).toBe('Distance(Line 1 = 100)')
    expect(notice).not.toContain('11111111')
  })

  it('keeps a multi-operand conflict-set notice short enough to fit the footer', () => {
    const dim: SketchDimension = {
      id: 'dm-w', kind: 'distance', driving: true, value: 120,
      a: { entityId: ID_L1, site: 'start' },
      b: { entityId: ID_L2, site: 'end' },
    }
    const sk = sketchWith([dim])
    const notice = describeConstraintSet(sk, ['cn-h', 'cn-tan', 'dm-w'], new Set())
    expect(notice).toBe(
      'Horizontal(Line 1), Tangent(Line 1, Circle 1), Distance(Line 1, Line 2 = 120)',
    )
    // Readable labels are shorter than 8-char id fragments plus
    // punctuation for the same operand count.
    expect(notice).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
  })

  it('still excludes the just-rejected ids and drops unknown ids', () => {
    const sk = sketchWith([])
    const notice = describeConstraintSet(sk, ['cn-h', 'cn-tan', 'missing'], new Set(['cn-h']))
    expect(notice).toBe('Tangent(Line 1, Circle 1)')
  })
})